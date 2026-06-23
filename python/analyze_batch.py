#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Analiza varias canciones y verifica la busqueda por similitud de audio."""
import sys
import json
import numpy as np
import analyze

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ffmpeg = sys.argv[1]
files = sys.argv[2:]

results = []
for f in files:
    try:
        d = analyze.analyze_file(f, ffmpeg, 22050)
        results.append(d)
        print("OK  %-26s BPM %-5s  %-7s %-3s  E%.0f" % (
            d["file"][:26], d["bpm"], d["key"], d["camelot"], d["energy_mean"]))
    except Exception as e:
        print("ERR", f, repr(e)[:80])

# cachea el analisis para iterar el scorer sin re-analizar
import os
cache_path = os.path.join("test-clips", "analysis.json")
with open(cache_path, "w", encoding="utf-8") as fh:
    json.dump(results, fh, ensure_ascii=False)
print("\n[cache guardado en %s]" % cache_path)

if len(results) < 2:
    sys.exit(0)

# matriz de embeddings -> z-score por dimension -> coseno
E = np.array([r["embedding"] for r in results], dtype=float)
mu = E.mean(axis=0); sd = E.std(axis=0) + 1e-9
Z = (E - mu) / sd
norm = np.linalg.norm(Z, axis=1, keepdims=True) + 1e-9
Zn = Z / norm
sim = Zn @ Zn.T

print("\n=== SIMILITUD: tracks mas parecidos (por audio, no metadata) ===")
for i, r in enumerate(results):
    order = np.argsort(-sim[i])
    tops = [j for j in order if j != i][:2]
    print("\n[%s]  (%s, %s, E%.0f)" % (r["file"][:30], r["bpm"], r["camelot"], r["energy_mean"]))
    for j in tops:
        print("   %5.1f%%  ->  %s  (%s, %s, E%.0f)" % (
            sim[i][j] * 100, results[j]["file"][:30], results[j]["bpm"],
            results[j]["camelot"], results[j]["energy_mean"]))
