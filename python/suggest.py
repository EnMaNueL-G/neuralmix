#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""NeuralMix Co-Pilot: sugiere el siguiente track (armonia + BPM + energia + audio)."""
import sys
import json
import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

cache = sys.argv[1] if len(sys.argv) > 1 else "test-clips/analysis.json"
with open(cache, encoding="utf-8") as fh:
    tracks = json.load(fh)


def parse_camelot(c):
    try:
        return int(c[:-1]), c[-1].upper()
    except Exception:
        return 0, "A"


def harmonic(c1, c2):
    n1, l1 = parse_camelot(c1)
    n2, l2 = parse_camelot(c2)
    if c1 == c2:
        return 1.0                                   # misma tonalidad
    if n1 == n2 and l1 != l2:
        return 0.9                                   # relativo mayor/menor
    d = min((n1 - n2) % 12, (n2 - n1) % 12)
    if l1 == l2 and d == 1:
        return 0.85                                  # adyacente en la rueda
    if l1 == l2 and d == 2:
        return 0.6                                   # +2 (energy boost)
    return 0.25


def bpm_compat(b1, b2):
    if b1 <= 0 or b2 <= 0:
        return 0.5
    best = 0.0
    for m in (0.5, 1.0, 2.0):                        # tolera medio/doble tempo
        x = b2 * m
        r = min(b1, x) / max(b1, x)
        best = max(best, r)
    if best >= 0.94:
        return 1.0
    if best >= 0.90:
        return 0.7
    return max(0.2, 0.3 * best)


def energy_compat(e1, e2):
    de = e2 - e1                                     # subir = ok, bajar mucho = malo
    if de >= 0:
        return 1.0 - min(0.4, de / 100.0)            # subir demasiado, leve penalizacion
    return max(0.1, 1.0 + de / 40.0)                 # caer 40+ pts = corte de energia


def transition(cur, nxt, hscore):
    de = nxt["energy_mean"] - cur["energy_mean"]
    if hscore >= 0.9:
        return "Blend armónico (mezcla larga)"
    if de >= 12:
        return "Build → corte en el drop"
    if de <= -12:
        return "Echo out / filtro"
    return "Fade en 16-32 beats"


# similitud de audio (z-score + coseno)
E = np.array([t["embedding"] for t in tracks], dtype=float)
mu, sd = E.mean(0), E.std(0) + 1e-9
Z = (E - mu) / sd
Zn = Z / (np.linalg.norm(Z, axis=1, keepdims=True) + 1e-9)
audio_sim = Zn @ Zn.T

W = {"harm": 0.35, "bpm": 0.30, "audio": 0.20, "energy": 0.15}

print("🤖 NeuralMix Co-Pilot — sugerencias de siguiente track\n" + "=" * 60)
for i, cur in enumerate(tracks):
    rows = []
    for j, nxt in enumerate(tracks):
        if i == j:
            continue
        h = harmonic(cur["camelot"], nxt["camelot"])
        b = bpm_compat(cur["bpm"], nxt["bpm"])
        a = (audio_sim[i][j] + 1) / 2
        e = energy_compat(cur["energy_mean"], nxt["energy_mean"])
        score = W["harm"] * h + W["bpm"] * b + W["audio"] * a + W["energy"] * e
        rows.append((score, j, h, b, a, e))
    rows.sort(reverse=True)
    print("\n▶ AHORA: %s  [%s · %sBPM · E%.0f]" % (
        cur["file"][:28], cur["camelot"], cur["bpm"], cur["energy_mean"]))
    for score, j, h, b, a, e in rows[:3]:
        nxt = tracks[j]
        print("   %3.0f%%  %-26s [%s · %sBPM · E%.0f]" % (
            score * 100, nxt["file"][:26], nxt["camelot"], nxt["bpm"], nxt["energy_mean"]))
        print("         armonía %.0f · bpm %.0f · audio %.0f · energía %.0f  → %s" % (
            h * 100, b * 100, a * 100, e * 100, transition(cur, nxt, h)))
