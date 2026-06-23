#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
NeuralMix Pro - motor de analisis musical (Co-Pilot IA).

Analiza un archivo de audio y emite un JSON con:
  bpm, key, camelot, mode, duration, energy[] (0-100 por ~0.5s),
  sections[] (boundaries + nivel de energia), embedding[] (similitud).

Uso: analyze.py --input <archivo> [--ffmpeg <ruta>] [--sr 22050]
Salida: un unico objeto JSON por stdout.
"""
import sys
import os
import json
import argparse
import tempfile
import subprocess
import traceback


def fail(code, msg):
    sys.stdout.write(json.dumps({"error": code, "msg": msg}) + "\n")
    sys.stdout.flush()
    sys.exit(1)


# Perfiles Krumhansl-Schmuckler para estimacion de tonalidad
KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
# Camelot wheel por clase de altura (indice 0..11 = C..B)
CAMELOT_MAJOR = {0: "8B", 1: "3B", 2: "10B", 3: "5B", 4: "12B", 5: "7B",
                 6: "2B", 7: "9B", 8: "4B", 9: "11B", 10: "6B", 11: "1B"}
CAMELOT_MINOR = {0: "5A", 1: "12A", 2: "7A", 3: "2A", 4: "9A", 5: "4A",
                 6: "11A", 7: "6A", 8: "1A", 9: "8A", 10: "3A", 11: "10A"}


def estimate_key(chroma_mean):
    import numpy as np

    def corr(a, b):
        a = np.asarray(a, dtype=float); b = np.asarray(b, dtype=float)
        a = a - a.mean(); b = b - b.mean()
        d = (np.sqrt((a * a).sum()) * np.sqrt((b * b).sum())) or 1e-9
        return float((a * b).sum() / d)

    best = (-2.0, 0, "major")
    for i in range(12):
        rot = np.roll(chroma_mean, -i)
        cmaj = corr(rot, KS_MAJOR)
        cmin = corr(rot, KS_MINOR)
        if cmaj > best[0]:
            best = (cmaj, i, "major")
        if cmin > best[0]:
            best = (cmin, i, "minor")
    _, pc, mode = best
    name = NOTE_NAMES[pc] + (" maj" if mode == "major" else " min")
    camelot = CAMELOT_MAJOR[pc] if mode == "major" else CAMELOT_MINOR[pc]
    return {"key": name, "camelot": camelot, "mode": mode, "pitch_class": pc}


def decode_mono(input_path, ffmpeg, sr):
    """Decodifica cualquier formato a WAV mono con ffmpeg y devuelve el array."""
    import numpy as np
    import soundfile as sf
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        cmd = [ffmpeg, "-y", "-loglevel", "error", "-i", input_path,
               "-ac", "1", "-ar", str(sr), "-f", "wav", tmp]
        p = subprocess.run(cmd, capture_output=True)
        if p.returncode != 0 or not os.path.getsize(tmp):
            raise RuntimeError("ffmpeg: " + (p.stderr or b"").decode("utf-8", "ignore")[-200:])
        y, _ = sf.read(tmp, dtype="float32")
        if y.ndim > 1:
            y = y.mean(axis=1)
        return y
    finally:
        if tmp and os.path.isfile(tmp):
            try: os.remove(tmp)
            except Exception: pass


def analyze_file(input_path, ffmpeg, sr):
    """Analiza un archivo y devuelve el dict de resultados."""
    import numpy as np
    import librosa

    y = decode_mono(input_path, ffmpeg, sr)

    duration = float(len(y) / sr)

    # --- BPM + beats (con correccion de octava a rango de baile) ---
    def fold_bpm(b, lo=88.0, hi=176.0):
        if b <= 0:
            return 0.0
        while b < lo:
            b *= 2.0
        while b >= hi:
            b /= 2.0
        return b

    try:
        tempo, beats = librosa.beat.beat_track(y=y, sr=sr, start_bpm=120.0)
        bpm = fold_bpm(float(np.atleast_1d(tempo)[0]))
    except Exception:
        bpm = 0.0
        beats = np.array([])

    # --- Tonalidad (Camelot) via chroma ---
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = chroma.mean(axis=1)
    keyinfo = estimate_key(chroma_mean)

    # --- Curva de energia (RMS por ~0.5s, 0..100) ---
    hop = 512
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    frames_per_half = max(1, int((sr * 0.5) / hop))
    energy = []
    for i in range(0, len(rms), frames_per_half):
        energy.append(float(np.sqrt(np.mean(rms[i:i + frames_per_half] ** 2)) + 1e-9))
    energy = np.array(energy)
    e_db = 20 * np.log10(energy / (energy.max() + 1e-9) + 1e-9)
    energy_pct = np.clip((e_db + 60) / 60 * 100, 0, 100)
    energy_curve = [round(float(v), 1) for v in energy_pct]

    # --- Secciones (boundaries por novedad espectral + nivel de energia) ---
    sections = []
    try:
        S = np.abs(librosa.stft(y, hop_length=hop))
        mfcc = librosa.feature.mfcc(S=librosa.power_to_db(S ** 2), n_mfcc=13)
        bounds = librosa.segment.agglomerative(mfcc, 8)  # ~8 segmentos
        bt = librosa.frames_to_time(bounds, sr=sr, hop_length=hop)
        bt = sorted(set([0.0] + [float(t) for t in bt] + [duration]))
        for i in range(len(bt) - 1):
            a, b = bt[i], bt[i + 1]
            ia = int(a / 0.5); ib = max(ia + 1, int(b / 0.5))
            lvl = float(np.mean(energy_pct[ia:ib])) if ib <= len(energy_pct) else 0.0
            sections.append({"start": round(a, 2), "end": round(b, 2),
                             "energy": round(lvl, 1)})
    except Exception:
        pass

    # --- Embedding de similitud (timbre + armonia + ritmo) ---
    mfcc20 = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=20)
    cent = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    bw = librosa.feature.spectral_bandwidth(y=y, sr=sr)[0]
    emb = np.concatenate([
        mfcc20.mean(axis=1), mfcc20.std(axis=1),
        chroma_mean,
        [float(cent.mean()), float(bw.mean()), float(bpm), float(energy_pct.mean())],
    ]).astype(float)
    embedding = [round(float(v), 4) for v in emb]

    out = {
        "file": os.path.basename(input_path),
        "duration": round(duration, 2),
        "bpm": round(bpm, 1),
        "key": keyinfo["key"],
        "camelot": keyinfo["camelot"],
        "mode": keyinfo["mode"],
        "energy_mean": round(float(energy_pct.mean()), 1),
        "energy_curve": energy_curve,
        "sections": sections,
        "embedding": embedding,
    }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--sr", default="22050")
    args = ap.parse_args()
    if not os.path.isfile(args.input):
        fail("NO_INPUT", "No existe: " + args.input)
    try:
        out = analyze_file(args.input, args.ffmpeg, int(args.sr))
    except FileNotFoundError:
        fail("NO_FFMPEG", "ffmpeg no encontrado")
        return
    except Exception as e:
        fail("ANALYZE", repr(e))
        return
    sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        fail("FATAL", traceback.format_exc())
