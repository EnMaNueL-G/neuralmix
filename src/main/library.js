// NeuralMix Pro - librería persistente (analisis cacheado en userData).
const path = require('path');
const fs = require('fs');

let FILE = null;
let data = { tracks: [] };

function init(userDataDir) {
  FILE = path.join(userDataDir, 'library.json');
  try {
    if (fs.existsSync(FILE)) data = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    if (!data || !Array.isArray(data.tracks)) data = { tracks: [] };
  } catch (_) { data = { tracks: [] }; }
}

let lastBak = 0;
function save() {
  if (!FILE) return;
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE);
    // respaldo automático (máx. 1/min) ante fallos
    if (Date.now() - lastBak > 60000) { try { fs.copyFileSync(FILE, FILE + '.bak'); lastBak = Date.now(); } catch (_) {} }
  } catch (_) { /* */ }
}

function has(filePath) { return data.tracks.some((t) => t.path === filePath); }

function upsert(track) {
  const i = data.tracks.findIndex((t) => t.path === track.path);
  if (i >= 0) data.tracks[i] = track; else data.tracks.push(track);
  save();
}

function remove(filePath) {
  data.tracks = data.tracks.filter((t) => t.path !== filePath);
  save();
}

// Lista sin el embedding pesado (para enviar a la UI). El embedding se usa solo en suggest.
function list() {
  return data.tracks.map((t) => {
    const { embedding, ...rest } = t;
    return rest;
  });
}

function all() { return data.tracks; }

module.exports = { init, upsert, remove, list, all, has, save };
