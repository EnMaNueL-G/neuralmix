// NeuralMix Pro - Co-Pilot: puntuacion de "siguiente track" (JS, instantaneo).
// Combina armonia (Camelot) + BPM (octava-consciente) + energia + similitud de audio.

function parseCamelot(c) {
  const m = /^(\d{1,2})([AB])$/.exec(String(c || '').toUpperCase());
  if (!m) return { n: 0, l: 'A' };
  return { n: parseInt(m[1], 10), l: m[2] };
}

function harmonic(c1, c2) {
  const a = parseCamelot(c1), b = parseCamelot(c2);
  if (c1 === c2) return 1.0;
  if (a.n === b.n && a.l !== b.l) return 0.9;          // relativo mayor/menor
  const d = Math.min((a.n - b.n + 12) % 12, (b.n - a.n + 12) % 12);
  if (a.l === b.l && d === 1) return 0.85;             // adyacente en la rueda
  if (a.l === b.l && d === 2) return 0.6;              // +2 (energy boost)
  return 0.25;
}

function bpmCompat(b1, b2) {
  if (!b1 || !b2) return 0.5;
  let best = 0;
  for (const m of [0.5, 1, 2]) {
    const x = b2 * m;
    best = Math.max(best, Math.min(b1, x) / Math.max(b1, x));
  }
  if (best >= 0.94) return 1.0;
  if (best >= 0.90) return 0.7;
  return Math.max(0.2, 0.3 * best);
}

function energyCompat(e1, e2) {
  const de = e2 - e1;
  if (de >= 0) return 1.0 - Math.min(0.4, de / 100);
  return Math.max(0.1, 1.0 + de / 40);
}

function transition(cur, nxt, h) {
  const de = (nxt.energy_mean || 0) - (cur.energy_mean || 0);
  if (h >= 0.9) return 'Blend armónico (mezcla larga)';
  if (de >= 12) return 'Build → corte en el drop';
  if (de <= -12) return 'Echo out / filtro';
  return 'Fade en 16-32 beats';
}

// z-score por dimension sobre el set, luego coseno
function audioSimMatrix(tracks) {
  const n = tracks.length;
  const embs = tracks.map((t) => t.embedding || []);
  const dim = embs.reduce((m, e) => Math.max(m, e.length), 0);
  if (!dim || n < 2) return null;
  const mu = new Array(dim).fill(0), sd = new Array(dim).fill(0);
  for (let d = 0; d < dim; d++) {
    let s = 0; for (let i = 0; i < n; i++) s += embs[i][d] || 0;
    mu[d] = s / n;
  }
  for (let d = 0; d < dim; d++) {
    let s = 0; for (let i = 0; i < n; i++) { const v = (embs[i][d] || 0) - mu[d]; s += v * v; }
    sd[d] = Math.sqrt(s / n) + 1e-9;
  }
  const Z = embs.map((e) => {
    const z = new Array(dim);
    let nrm = 0;
    for (let d = 0; d < dim; d++) { z[d] = ((e[d] || 0) - mu[d]) / sd[d]; nrm += z[d] * z[d]; }
    nrm = Math.sqrt(nrm) + 1e-9;
    for (let d = 0; d < dim; d++) z[d] /= nrm;
    return z;
  });
  const sim = [];
  for (let i = 0; i < n; i++) {
    sim[i] = [];
    for (let j = 0; j < n; j++) {
      let s = 0; for (let d = 0; d < dim; d++) s += Z[i][d] * Z[j][d];
      sim[i][j] = s;
    }
  }
  return sim;
}

const W = { harm: 0.35, bpm: 0.30, audio: 0.20, energy: 0.15 };

// tracks: array con {path,file,bpm,camelot,energy_mean,embedding}
// curIndex: indice del track "AHORA". Devuelve sugerencias ordenadas.
function suggest(tracks, curIndex, topN = 5) {
  const sim = audioSimMatrix(tracks);
  const cur = tracks[curIndex];
  const out = [];
  for (let j = 0; j < tracks.length; j++) {
    if (j === curIndex) continue;
    const nxt = tracks[j];
    const h = harmonic(cur.camelot, nxt.camelot);
    const b = bpmCompat(cur.bpm, nxt.bpm);
    const a = sim ? (sim[curIndex][j] + 1) / 2 : 0.5;
    const e = energyCompat(cur.energy_mean, nxt.energy_mean);
    const score = W.harm * h + W.bpm * b + W.audio * a + W.energy * e;
    out.push({
      path: nxt.path, file: nxt.file, bpm: nxt.bpm, camelot: nxt.camelot,
      energy_mean: nxt.energy_mean,
      score: Math.round(score * 100),
      harm: Math.round(h * 100), bpmc: Math.round(b * 100),
      audio: Math.round(a * 100), energyc: Math.round(e * 100),
      transition: transition(cur, nxt, h),
    });
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, topN);
}

module.exports = { suggest, harmonic, bpmCompat };
