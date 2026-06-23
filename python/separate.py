#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
StemSplit AI - sidecar de separacion de audio (Demucs 4.x).

Protocolo: emite eventos JSON (uno por linea) a stdout:
  {"type":"status","msg":"..."}
  {"type":"progress","value":0-100,"stage":"separating"}
  {"type":"done","stems":{"vocals":"ruta.wav",...},"meta":{...}}
  {"type":"error","code":"...","msg":"..."}

API usada: demucs.pretrained.get_model + demucs.apply.apply_model +
demucs.audio.AudioFile/save_audio (compatible con demucs 4.0.1).
El progreso se obtiene parseando la barra tqdm que apply_model escribe en stderr.
"""
import sys
import os
import re
import json
import argparse
import tempfile
import subprocess
import traceback


def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def fail(code, msg):
    emit({"type": "error", "code": code, "msg": msg})
    sys.exit(1)


STEM_LABELS = {
    "vocals": "Voz", "drums": "Bateria", "bass": "Bajo", "other": "Otros",
    "guitar": "Guitarra", "piano": "Piano",
    "accompaniment": "Acompanamiento", "no_vocals": "Instrumental",
}


class ProgressTee:
    """Envuelve stderr: deja pasar el texto y extrae el % de tqdm -> evento JSON."""
    _re = re.compile(r"(\d{1,3})%")

    def __init__(self, real):
        self.real = real
        self.last = -1

    def write(self, s):
        try:
            self.real.write(s)
        except Exception:
            pass
        for m in self._re.finditer(s):
            pct = int(m.group(1))
            if 0 <= pct <= 100 and pct != self.last:
                self.last = pct
                emit({"type": "progress", "value": pct, "stage": "separating"})

    def flush(self):
        try:
            self.real.flush()
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--model", default="htdemucs")
    ap.add_argument("--stems", default="4")
    ap.add_argument("--format", default="wav")
    ap.add_argument("--mp3-bitrate", default="320")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--name", default=None)
    ap.add_argument("--ffmpeg", default="ffmpeg", help="ruta a ffmpeg.exe")
    ap.add_argument("--shifts", default="1", help="promediado por shifts (reduce artefactos)")
    ap.add_argument("--overlap", default="0.25", help="solape entre segmentos (suaviza cortes)")
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        fail("NO_INPUT", "El archivo de entrada no existe: " + args.input)
    os.makedirs(args.outdir, exist_ok=True)
    base = args.name or os.path.splitext(os.path.basename(args.input))[0]

    emit({"type": "status", "msg": "Cargando motor de IA..."})
    try:
        import torch
        from demucs.pretrained import get_model
        from demucs.apply import apply_model
    except Exception as e:
        fail("NO_ENGINE",
             "No se pudo cargar Demucs/torch. Instala el motor. Detalle: " + repr(e))
        return

    device = args.device
    try:
        if device == "cuda" and not torch.cuda.is_available():
            device = "cpu"
            emit({"type": "status", "msg": "GPU CUDA no disponible, usando CPU."})
    except Exception:
        device = "cpu"

    emit({"type": "status", "msg": "Cargando modelo " + args.model + "..."})
    try:
        model = get_model(args.model)
        model.to(device)
        model.eval()
    except Exception as e:
        fail("MODEL_LOAD", "No se pudo cargar el modelo '" + args.model +
             "'. ¿Conexion para descargarlo la 1a vez? Detalle: " + repr(e))
        return

    sources_names = list(model.sources)        # p.ej. ['drums','bass','other','vocals']
    sr = model.samplerate
    ch = model.audio_channels

    emit({"type": "status", "msg": "Leyendo audio..."})
    tmp_wav = None
    try:
        import soundfile as sf
        # Decodifica CUALQUIER formato a WAV stereo (samplerate del modelo) con ffmpeg.
        fd, tmp_wav = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        cmd = [args.ffmpeg, "-y", "-loglevel", "error", "-i", args.input,
               "-ac", str(ch), "-ar", str(sr), "-f", "wav", tmp_wav]
        proc = subprocess.run(cmd, capture_output=True)
        if proc.returncode != 0 or not os.path.getsize(tmp_wav):
            err = (proc.stderr or b"").decode("utf-8", "ignore")[-300:]
            fail("READ", "ffmpeg no pudo decodificar el audio (¿formato no soportado o "
                         "corrupto?). " + err)
            return
        data, _ = sf.read(tmp_wav, dtype="float32", always_2d=True)   # [samples, channels]
        wav = torch.from_numpy(data.T).contiguous()                   # [channels, samples]
    except FileNotFoundError:
        fail("NO_FFMPEG", "No se encontro ffmpeg. Reinstala la aplicacion.")
        return
    except Exception as e:
        fail("READ", "No se pudo leer el audio: " + repr(e))
        return
    finally:
        if tmp_wav and os.path.isfile(tmp_wav):
            try:
                os.remove(tmp_wav)
            except Exception:
                pass

    # Normalizacion recomendada por demucs
    ref = wav.mean(0)
    std = ref.std()
    if float(std) == 0.0:
        std = ref.new_tensor(1.0)
    wav = (wav - ref.mean()) / std

    emit({"type": "status", "msg": "Separando pistas (" + device + ")..."})
    emit({"type": "progress", "value": 1, "stage": "separating"})

    old_err = sys.stderr
    sys.stderr = ProgressTee(old_err)
    try:
        with torch.no_grad():
            out = apply_model(model, wav[None], device=device, progress=True,
                              shifts=int(args.shifts), split=True,
                              overlap=float(args.overlap))[0]
    except RuntimeError as e:
        sys.stderr = old_err
        m = str(e).lower()
        if "out of memory" in m or "alloc" in m or "cannot allocate" in m:
            fail("OOM", "Memoria insuficiente. Prueba un modelo mas ligero o cierra apps.")
        else:
            fail("SEPARATE", "Fallo al separar: " + repr(e))
        return
    except Exception as e:
        sys.stderr = old_err
        fail("SEPARATE", "No se pudo procesar el audio: " + repr(e))
        return
    finally:
        sys.stderr = old_err

    out = out * std + ref.mean()                # [stems, ch, samples]
    separated = {name: out[i] for i, name in enumerate(sources_names)}

    # --- Modo karaoke (2 stems): voz + instrumental ---
    if str(args.stems).strip() == "2" and "vocals" in separated:
        vocals = separated["vocals"]
        acc = None
        for k, v in separated.items():
            if k == "vocals":
                continue
            acc = v if acc is None else (acc + v)
        separated = {"vocals": vocals}
        if acc is not None:
            separated["no_vocals"] = acc

    ext = args.format.lower()
    if ext not in ("wav", "flac", "mp3"):
        ext = "wav"

    emit({"type": "status", "msg": "Guardando archivos..."})
    import soundfile as sf
    import numpy as np

    def write_stem(tensor, out_path):
        arr = tensor.detach().cpu().numpy().astype("float32").T   # [samples, channels]
        # rescale suave si excede [-1,1] (evita recorte duro)
        peak = float(np.max(np.abs(arr))) if arr.size else 0.0
        if peak > 1.0:
            arr = arr / peak
        if ext == "mp3":
            # WAV temporal -> ffmpeg -> mp3 (libmp3lame)
            fd, tmp = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            try:
                sf.write(tmp, arr, sr, subtype="PCM_16")
                cmd = [args.ffmpeg, "-y", "-loglevel", "error", "-i", tmp,
                       "-b:a", str(args.mp3_bitrate) + "k", out_path]
                p = subprocess.run(cmd, capture_output=True)
                if p.returncode != 0:
                    raise RuntimeError((p.stderr or b"").decode("utf-8", "ignore")[-200:])
            finally:
                try:
                    os.remove(tmp)
                except Exception:
                    pass
        elif ext == "flac":
            sf.write(out_path, arr, sr)                            # FLAC lossless
        else:
            sf.write(out_path, arr, sr, subtype="PCM_16")          # WAV 16-bit

    stems_out = {}
    try:
        for name, tensor in separated.items():
            out_path = os.path.join(args.outdir, base + " - " + name + "." + ext)
            write_stem(tensor, out_path)
            stems_out[name] = out_path
    except Exception as e:
        fail("SAVE", "No se pudieron guardar los stems: " + repr(e))
        return

    emit({"type": "progress", "value": 100, "stage": "done"})
    emit({"type": "done", "stems": stems_out, "meta": {
        "model": args.model, "device": device, "samplerate": sr,
        "labels": {k: STEM_LABELS.get(k, k) for k in stems_out},
    }})


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        fail("FATAL", "Error inesperado: " + traceback.format_exc())
