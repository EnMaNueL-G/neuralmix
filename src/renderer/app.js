// NeuralMix Pro - renderer (mezclador DJ profesional: 2 decks, waveform color, jog, FX, Co-Pilot).
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  ready: false, tracks: [], analyzing: false, pending: 0, stemsJob: null,
  deck: { A: null, B: null }, focusPath: null, autoMix: false, recording: false, _err: null, _an: null, _autoState: null,
  searchQ: '', sortKey: null, sortDir: 1, lastDeck: 'A', sourceFilter: null,
};

async function init() {
  const st = await window.nm.engineStatus();
  state.ready = !!st.ready;
  $('#statusPill').className = 'pill ' + (state.ready ? 'ok' : '');
  $('#statusText').textContent = state.ready ? 'Listo · CPU' : 'Motor no instalado';
  state.tracks = await window.nm.libList();
  wireEvents(); renderLibrary(); renderSources(); renderCopilot(); renderSampler();
  if (NM.sampler.ready) NM.sampler.ready.then(renderSampler).catch(() => {});   // re-render al terminar la síntesis
  requestAnimationFrame(loop); updateFooter(); initSettings();
}

// helpers
function fmtDur(s) { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function eng(side) { return side === 'A' ? NM.deckA : side === 'B' ? NM.deckB : side === 'C' ? NM.deckC : NM.deckD; }
function field(side, f) { return document.querySelector(`[data-deck="${side}"] [data-f="${f}"]`); }
function panel(side) { return document.querySelector(`.deckpanel[data-deck="${side}"]`); }

// ---------- band peaks (waveform color por frecuencia) ----------
async function computeBandPeaks(buf) {
  const n = Math.min(8000, Math.max(400, Math.floor(buf.duration * 22)));
  const off = new OfflineAudioContext(3, buf.length, buf.sampleRate);
  const src = off.createBufferSource(); src.buffer = buf;
  const lp = off.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
  const bp = off.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.6;
  const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4500;
  const mg = off.createChannelMerger(3);
  src.connect(lp); lp.connect(mg, 0, 0); src.connect(bp); bp.connect(mg, 0, 1); src.connect(hp); hp.connect(mg, 0, 2);
  mg.connect(off.destination); src.start();
  const r = await off.startRendering();
  const ch = [r.getChannelData(0), r.getChannelData(1), r.getChannelData(2)];
  const block = Math.floor(ch[0].length / n) || 1;
  const out = { low: [], mid: [], high: [], n };
  const keys = ['low', 'mid', 'high'];
  for (let i = 0; i < n; i++) { const s = i * block; for (let b = 0; b < 3; b++) { let m = 0; for (let j = 0; j < block; j += 16) { const v = Math.abs(ch[b][s + j] || 0); if (v > m) m = v; } out[keys[b]].push(m); } }
  return out;
}

// ---------- cargar a deck ----------
async function readAB(p) { const u8 = await window.nm.readAudio(p); if (!u8) throw new Error('No se pudo leer ' + p); return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); }
async function loadToDeck(side, path) {
  const t = state.tracks.find((x) => x.path === path); if (!t) return;
  const meta = { bpm: t.bpm, camelot: t.camelot, name: t.file };
  field(side, 'name').textContent = 'Cargando…';
  let stems = null;
  try {
    stems = await window.nm.stemsFind(path);
    if (stems) { const abs = {}; for (const s of NM.STEMS) abs[s] = await readAB(stems[s]); await eng(side).loadStems(abs, meta); }
    else await eng(side).loadBuffer(await readAB(path), meta);
  } catch (e) { state._err = 'Deck ' + side + ': ' + e.message; updateFooter(); field(side, 'name').textContent = 'Error'; return; }
  const buf = eng(side).buffers.main || eng(side).buffers.drums || Object.values(eng(side).buffers)[0];
  const bands = await computeBandPeaks(buf);
  state.deck[side] = { path, file: t.file, bpm: t.bpm, camelot: t.camelot, isStems: !!stems, bands };
  state.focusPath = path;
  field(side, 'name').textContent = t.file;
  field(side, 'cam').textContent = t.camelot || '—';
  field(side, 'stemstate').textContent = stems ? '' : '✂ separa para stems';
  $$('.pad.stem', panel(side)).forEach((p) => { p.classList.add('on'); p.style.opacity = stems ? '1' : '.4'; });
  resetDeckControls(side); renderCopilot(); updateFooter();
}
function resetDeckControls(side) {
  field(side, 'tempo').textContent = '0.0%';
  $(`.deckpanel[data-deck="${side}"] [data-act="tempo"]`).value = 0;
  $(`.deckpanel[data-deck="${side}"] [data-act="sync"]`).classList.remove('on');
  $$('.pad[data-cue]', panel(side)).forEach((p) => p.classList.remove('set'));
  $$('.pad.loop', panel(side)).forEach((p) => p.classList.remove('on'));
  setPlayBtn(side, false);
}

// ---------- waveform scrolling (desplazamiento de la onda) ----------
function drawWave(side) {
  const cv = document.querySelector(`canvas.wave[data-deck="${side}"]`); if (!cv || cv.offsetParent === null) return;
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 600, h = cv.clientHeight || 90;
  if (cv.width !== Math.round(w * dpr)) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const d = state.deck[side]; if (!d || !d.bands) return;
  const e = eng(side), dur = e.duration || 1, pos = e.position, bands = d.bands, n = bands.n;
  const windowSec = 8, pxPerSec = w / windowSec, mid = h / 2, center = w * 0.5;
  if (e.baseBpm) { // líneas de beat
    ctx.strokeStyle = '#ffffff12'; const beat = 60 / (e.baseBpm * e.tempo);
    for (let t = Math.floor((pos - windowSec / 2) / beat) * beat; t < pos + windowSec / 2; t += beat) { const x = center + (t - pos) * pxPerSec; if (x >= 0 && x <= w) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); } }
  }
  const bucketSec = dur / n, i0 = Math.max(0, Math.floor((pos - windowSec / 2) / bucketSec)), i1 = Math.min(n - 1, Math.ceil((pos + windowSec / 2) / bucketSec));
  const bw = Math.max(1, pxPerSec * bucketSec);
  for (let i = i0; i <= i1; i++) {
    const x = center + (i * bucketSec - pos) * pxPerSec;
    const lo = bands.low[i] || 0, md = bands.mid[i] || 0, hi = bands.high[i] || 0;
    const amp = Math.min(1, Math.max(lo, md, hi) * 1.5), bh = Math.max(1, amp * h * 0.9);
    ctx.fillStyle = `rgb(${Math.min(255, lo * 430) | 0},${Math.min(255, md * 430) | 0},${Math.min(255, 45 + hi * 470) | 0})`;
    ctx.fillRect(x, mid - bh / 2, bw, bh);
  }
  ctx.fillStyle = '#fff'; ctx.fillRect(center - 1, 0, 2, h);                  // playhead central
}

// ---------- jog wheel ----------
function drawJog(side) {
  const cv = document.querySelector(`canvas.jog[data-deck="${side}"]`); if (!cv || cv.offsetParent === null) return;
  const dpr = window.devicePixelRatio || 1, s = cv.clientWidth || 78;
  if (cv.width !== Math.round(s * dpr)) { cv.width = s * dpr; cv.height = s * dpr; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, s, s);
  const cx = s / 2, cy = s / 2, R = s / 2 - 3, e = eng(side), col = side === 'A' ? '#d946ef' : '#22d3ee';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, R); g.addColorStop(0, '#262638'); g.addColorStop(1, '#101019');
  ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = state.deck[side] ? col : '#333'; ctx.stroke();
  // marca giratoria en el borde (deja el centro libre para el BPM)
  const ang = (e.position * 3.4) % (Math.PI * 2);
  ctx.strokeStyle = e.playing ? '#fff' : '#666'; ctx.lineWidth = 3; ctx.beginPath();
  ctx.moveTo(cx + Math.cos(ang) * R * 0.58, cy + Math.sin(ang) * R * 0.58);
  ctx.lineTo(cx + Math.cos(ang) * R * 0.86, cy + Math.sin(ang) * R * 0.86); ctx.stroke();
  // BPM + pitch en el centro del jog
  if (state.deck[side]) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff'; ctx.font = 'bold 14px Segoe UI';
    ctx.fillText(e.baseBpm ? (e.baseBpm * e.tempo).toFixed(1) : '--', cx, cy - 4);
    const pct = (e.tempo - 1) * 100;
    ctx.fillStyle = col; ctx.font = '9px Segoe UI';
    ctx.fillText((pct >= 0 ? '+' : '') + pct.toFixed(1) + '%', cx, cy + 10);
  } else { ctx.fillStyle = '#555'; ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill(); }
}

// ---------- controles de deck ----------
function setPlayBtn(side, playing) { const b = $(`.deckpanel[data-deck="${side}"] [data-act="play"]`); b.textContent = playing ? '⏸ PAUSA' : '▶ PLAY'; }
function deckPlay(side) { const e = eng(side); if (!e.buffers) return; state.lastDeck = side; if (e.playing) { e.pause(); setPlayBtn(side, false); } else { e.play(); setPlayBtn(side, true); state.focusPath = state.deck[side].path; renderCopilot(); } }
function deckCue(side) { const e = eng(side); if (!e.buffers) return; e.seek(0); if (!e.playing) drawWave(side); }
function setTempo(side, pct) { const e = eng(side); e.setTempo(1 + pct / 100); field(side, 'tempo').textContent = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%'; field(side, 'bpm').textContent = e.baseBpm ? (e.baseBpm * (1 + pct / 100)).toFixed(1) + ' BPM' : '—'; }
function doSync(side) {
  const e = eng(side), o = eng(side === 'A' ? 'B' : 'A'); if (!e.baseBpm || !o.bpm) return;
  e.syncTo(o.bpm); const pct = (e.tempo - 1) * 100;
  $(`.deckpanel[data-deck="${side}"] [data-act="tempo"]`).value = Math.max(-8, Math.min(8, pct));
  field(side, 'tempo').textContent = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
  field(side, 'bpm').textContent = (e.baseBpm * e.tempo).toFixed(1) + ' BPM';
  $(`.deckpanel[data-deck="${side}"] [data-act="sync"]`).classList.add('on');
}

// ---------- librería ----------
function camHtml(c) { return `<span class="cam2">${c || '—'}</span>`; }
function renderLibrary() {
  const body = $('#libBody');
  let list = state.tracks.slice();
  const q = state.searchQ;
  if (state.sourceFilter) list = list.filter((t) => t.source === state.sourceFilter);
  if (q) list = list.filter((t) => (t.file || '').toLowerCase().includes(q) || String(t.bpm || '').includes(q) || (t.camelot || '').toLowerCase().includes(q));
  if (state.sortKey) list.sort((a, b) => { let x = a[state.sortKey], y = b[state.sortKey]; if (typeof x === 'string') { x = (x || '').toLowerCase(); y = (y || '').toLowerCase(); } return (x > y ? 1 : x < y ? -1 : 0) * state.sortDir; });
  $('#libCount').textContent = list.length + (q ? '/' + state.tracks.length : '') + ' tracks';
  if (!list.length) { body.innerHTML = `<tr><td colspan="4" class="empty">${state.tracks.length ? 'Sin resultados.' : 'Sin música. Arrastra canciones.'}</td></tr>`; return; }
  body.innerHTML = '';
  for (const t of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><div class="tname" title="${esc(t.file)}">${esc(t.file)}</div></td><td>${t.bpm || '—'}</td><td>${camHtml(t.camelot)}</td>
      <td><button class="ldbtn" data-ld="A">▶A</button> <button class="ldbtn b" data-ld="B">▶B</button> <button class="ldbtn" data-ld="C">▶C</button> <button class="ldbtn b" data-ld="D">▶D</button> <button class="miniact stems" title="Separar stems">✂</button> <button class="miniact del" title="Quitar">✕</button></td>`;
    $('[data-ld="A"]', tr).onclick = () => loadToDeck('A', t.path);
    $('[data-ld="B"]', tr).onclick = () => loadToDeck('B', t.path);
    $('[data-ld="C"]', tr).onclick = () => { if ($('#deck4').style.display === 'none') toggleDeck4(); loadToDeck('C', t.path); };
    $('[data-ld="D"]', tr).onclick = () => { if ($('#deck4').style.display === 'none') toggleDeck4(); loadToDeck('D', t.path); };
    $('.stems', tr).onclick = () => startStems(t.path);
    $('.del', tr).onclick = () => removeTrack(t.path);
    body.appendChild(tr);
  }
}
async function pickAndAdd() { const f = await window.nm.pickFiles(); if (f && f.length) addFiles(f); }
async function openFolder() {
  const dir = await window.nm.pickFolder(); if (!dir) return;
  const r = await window.nm.dirScan(dir);
  if (!r || !r.files || !r.files.length) { state._err = 'No se encontró audio en esa carpeta.'; updateFooter(); return; }
  const res = await window.nm.libAdd(r.files, r.folder);
  if (res && res.queued > 0) state.analyzing = true;
  state._err = `📁 ${r.folder}: ${res.queued} pistas nuevas (analizando…)`; updateFooter();
}
function renderSources() {
  const el = $('#sources'); if (!el) return;
  const srcs = [...new Set(state.tracks.map((t) => t.source).filter(Boolean))];
  if (!srcs.length) { el.innerHTML = ''; return; }
  let html = `<button class="src-chip ${!state.sourceFilter ? 'on' : ''}" data-src="">Todas (${state.tracks.length})</button>`;
  for (const s of srcs) { const c = state.tracks.filter((t) => t.source === s).length; html += `<button class="src-chip ${state.sourceFilter === s ? 'on' : ''}" data-src="${esc(s)}">📁 ${esc(s)} (${c})</button>`; }
  el.innerHTML = html;
  $$('.src-chip', el).forEach((b) => b.onclick = () => { state.sourceFilter = b.dataset.src || null; renderSources(); renderLibrary(); });
}
async function addFiles(paths) { const r = await window.nm.libAdd(paths); if (r && r.queued > 0) state.analyzing = true; updateFooter(); }
function onLibEvent(ch, data) {
  if (ch === 'lib:progress') { state.analyzing = true; state.pending = data.pending; state._an = data.name; }
  else if (ch === 'lib:done') { const i = state.tracks.findIndex((t) => t.path === data.track.path); if (i >= 0) state.tracks[i] = data.track; else state.tracks.push(data.track); state.pending = data.pending; renderLibrary(); renderSources(); if (state.focusPath) renderCopilot(); }
  else if (ch === 'lib:error') state._err = data.name + ': ' + data.msg;
  else if (ch === 'lib:idle') { state.analyzing = false; state._an = null; renderSources(); }
  updateFooter();
}
async function removeTrack(p) { state.tracks = await window.nm.libRemove(p); renderLibrary(); renderSources(); updateFooter(); }

// ---------- sampler ----------
function renderSampler() {
  const wrap = $('#spads'); if (!wrap) return; wrap.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const name = NM.sampler.name(i), b = document.createElement('button');
    b.className = 'spad ' + (name ? 'full' : 'empty');
    b.textContent = name || '＋ Cargar';
    b.title = name ? (name + ' · clic dispara · clic derecho reemplaza/quita') : 'Clic para cargar tu propio sample (cornetas, voces, etc.)';
    b.onclick = () => { if (name) { if (NM.sampler.trigger(i)) { b.classList.add('hit'); setTimeout(() => b.classList.remove('hit'), 170); } } else loadSampleInto(i); };
    b.oncontextmenu = (e) => { e.preventDefault(); loadSampleInto(i); };
    wrap.appendChild(b);
  }
}
async function loadSampleInto(i) {
  const f = await window.nm.pickFiles(); if (!f || !f[0]) return;
  try { await NM.sampler.loadFile(i, await readAB(f[0]), f[0].split(/[\\/]/).pop().replace(/\.[^.]+$/, '')); renderSampler(); state._err = '✓ Sample cargado en el pad ' + (i + 1); updateFooter(); } catch (e) { state._err = 'No se pudo cargar el sample: ' + e.message; updateFooter(); }
}

// ---------- stems (separar) ----------
function startStems(p) {
  state.stemsQueue = state.stemsQueue || [];
  if (state.stemsJob) {
    if (state.stemsJob.path !== p && !state.stemsQueue.includes(p)) {
      state.stemsQueue.push(p);
      state._err = '✂ ' + p.split(/[\\/]/).pop() + ' en cola (' + state.stemsQueue.length + ' esperando)';
      updateFooter();
    }
    return;
  }
  _runStems(p);
}
function _runStems(p) {
  const id = 'st_' + Date.now();
  state.stemsJob = { id, path: p, name: p.split(/[\\/]/).pop(), status: 'Iniciando…' };
  updateFooter(); window.nm.stemsSeparate(id, { input: p, mode: '4' });
}
function _nextStems() { if (state.stemsQueue && state.stemsQueue.length) _runStems(state.stemsQueue.shift()); }
function onStemsEvent(jobId, ev) {
  if (!state.stemsJob || state.stemsJob.id !== jobId) return;
  if (ev.type === 'status') state.stemsJob.status = ev.msg;
  else if (ev.type === 'progress') state.stemsJob.status = 'Separando stems… ' + ev.value + '%';
  else if (ev.type === 'done') { state.stemsJob = null; window.nm.openPath(ev.outdir); _nextStems(); }
  else if (ev.type === 'error') { state.stemsJob = null; state._err = 'Stems: ' + ev.msg; _nextStems(); }
  updateFooter();
}

// ---------- Co-Pilot ----------
function sparkline(curve) { if (!curve || !curve.length) return ''; const N = 42, step = curve.length / N, bars = []; for (let i = 0; i < N; i++) bars.push(`<i style="height:${Math.max(2, Math.round(curve[Math.floor(i * step)] || 0))}%"></i>`); return `<div class="spark">${bars.join('')}</div>`; }
async function renderCopilot() {
  const body = $('#cpBody');
  if (!state.focusPath) { body.innerHTML = '<div class="cpempty">Carga un track a un deck y el Co-Pilot sugerirá el siguiente para mezclar.</div>'; return; }
  const cur = state.tracks.find((t) => t.path === state.focusPath); if (!cur) { body.innerHTML = ''; return; }
  const sgs = await window.nm.suggest(state.focusPath);
  const idle = (state.deck.A && state.deck.A.path === state.focusPath) ? 'B' : (state.deck.B && state.deck.B.path === state.focusPath) ? 'A' : 'B';
  let html = `<div class="nowcard"><div class="lab">🎚️ Mezclando ahora</div><div class="nm" title="${esc(cur.file)}">${esc(cur.file)}</div><div class="nowmeta">${camHtml(cur.camelot)} <span>${cur.bpm} BPM</span> <span>E${Math.round(cur.energy_mean || 0)}</span></div>${sparkline(cur.energy_curve)}</div>`;
  if (!sgs.length) html += '<div class="cpempty">Añade más tracks para recibir sugerencias.</div>';
  else { html += '<div class="lab" style="font-size:9.5px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin:0 0 6px 2px">Siguiente para mezclar</div>'; for (const s of sgs) html += `<div class="sg"><div class="top"><div class="sc">${s.score}%</div><div class="nm" title="${esc(s.file)}">${esc(s.file)}</div></div><div class="meta">${camHtml(s.camelot)} · ${s.bpm} BPM · E${Math.round(s.energy_mean || 0)}</div><div class="factors"><span class="fac">arm <b>${s.harm}</b></span><span class="fac">bpm <b>${s.bpmc}</b></span><span class="fac">vibe <b>${s.audio}</b></span><span class="fac">en <b>${s.energyc}</b></span></div><div class="tr">🎧 ${esc(s.transition)}</div><button class="ldbtn" data-load="${esc(s.path)}" data-side="${idle}">Cargar a Deck ${idle}</button></div>`; }
  body.innerHTML = html;
  $$('[data-load]', body).forEach((b) => b.onclick = () => loadToDeck(b.dataset.side, b.dataset.load));
}

// ---------- AutoMix ----------
function toggleAuto() { state.autoMix = !state.autoMix; $('#autoBtn').classList.toggle('on', state.autoMix); state._autoState = null; }
function autoMixTick() {
  if (!state.autoMix) return;
  const playing = NM.deckA.playing ? 'A' : NM.deckB.playing ? 'B' : null; if (!playing) return;
  const e = eng(playing), idle = playing === 'A' ? 'B' : 'A', ie = eng(idle), remain = e.duration - e.position;
  if (remain < 16 && remain > 0) {
    if (!state._autoState) {
      state._autoState = 'mixing';
      if (!ie.buffers || (state.deck[idle] && state.deck[playing] && state.deck[idle].path === state.deck[playing].path)) {
        window.nm.suggest(state.deck[playing].path).then((sgs) => { if (sgs && sgs[0]) loadToDeck(idle, sgs[0].path).then(() => { ie.play(); setPlayBtn(idle, true); doSync(idle); }); });
      } else { ie.play(); setPlayBtn(idle, true); doSync(idle); }
    }
    const t = Math.max(0, Math.min(1, (16 - remain) / 14)), x = idle === 'B' ? t : 1 - t;
    NM.setCrossfader(x); $('#xfader').value = x;
  } else if (remain >= 16) state._autoState = null;
}

// ---------- wiring ----------
function jogAngle(cv, ev) { const r = cv.getBoundingClientRect(); return Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2)); }
function wireEvents() {
  const dz = $('#drop');
  dz.onclick = pickAndAdd;
  $('#folderBtn').onclick = openFolder;
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('drag'); };
  dz.ondragleave = () => dz.classList.remove('drag');
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('drag'); const ps = []; for (const f of e.dataTransfer.files) { const p = window.nm.pathForFile(f); if (p) ps.push(p); } if (ps.length) addFiles(ps); };

  // waveform click-seek (relativo al centro)
  $$('canvas.wave').forEach((cv) => { const side = cv.dataset.deck; cv.onclick = (e) => { const en = eng(side); if (!en.buffers) return; const r = cv.getBoundingClientRect(); const off = ((e.clientX - r.left) / r.width - 0.5) * 8; en.seek(en.position + off); drawWave(side); }; });

  // deck panels
  $$('.deckpanel').forEach((dk) => {
    const side = dk.dataset.deck;
    $('[data-act="play"]', dk).onclick = () => deckPlay(side);
    $('[data-act="cue"]', dk).onclick = () => deckCue(side);
    $('[data-act="sync"]', dk).onclick = () => doSync(side);
    $('[data-act="keylock"]', dk).onclick = (e) => { const en = eng(side); en.setKeyLock(!en.keylock); e.currentTarget.classList.toggle('on', en.keylock); };
    $('[data-act="tempo"]', dk).oninput = (e) => setTempo(side, parseFloat(e.target.value));
    // FX selector + cantidad
    const fxT = $('[data-fx="type"]', dk), fxA = $('[data-fx="amt"]', dk);
    const applyFx = () => eng(side).setFx(fxT.value, parseFloat(fxA.value));
    fxT.onchange = applyFx; fxA.oninput = applyFx;
    // performance: beat jump, brake, pitch bend
    $('[data-act="bj-4"]', dk).onclick = () => eng(side).beatJump(-4);
    $('[data-act="bj4"]', dk).onclick = () => eng(side).beatJump(4);
    $('[data-act="brake"]', dk).onclick = () => { eng(side).brake(); setTimeout(() => setPlayBtn(side, false), 700); };
    const bendBtn = (sel, factor) => { const b = $(sel, dk); b.onmousedown = () => eng(side).pitchBend(factor); b.onmouseup = b.onmouseleave = () => eng(side).pitchBend(1); };
    bendBtn('[data-act="bend-"]', 0.96); bendBtn('[data-act="bend+"]', 1.04);
    $$('.pad[data-cue]', dk).forEach((p) => { const i = +p.dataset.cue; p.onclick = () => { const en = eng(side); if (!en.buffers) return; if (en.cues[i] == null) { en.setCue(i); p.classList.add('set'); } else en.jumpCue(i); }; p.oncontextmenu = (ev) => { ev.preventDefault(); eng(side).clearCue(i); p.classList.remove('set'); }; });
    $$('.pad.loop', dk).forEach((p) => { const beats = +p.dataset.loop; p.onclick = () => { const en = eng(side); if (!en.buffers) return; if (p.classList.contains('on')) { en.clearLoop(); p.classList.remove('on'); } else { $$('.pad.loop', dk).forEach((x) => x.classList.remove('on')); en.setLoop(beats); p.classList.add('on'); } }; });
    $$('.pad.stem', dk).forEach((p) => { p.onclick = () => { if (!state.deck[side] || !state.deck[side].isStems) { state._err = 'Deck ' + side + ': separa primero los stems de este track (botón ✂ en la librería)'; updateFooter(); return; } const on = !p.classList.contains('on'); p.classList.toggle('on', on); eng(side).setStem(p.dataset.stem, on); }; });
    // jog scratch
    const jog = $('canvas.jog', dk); let dragging = false, last = 0;
    jog.onmousedown = (ev) => { dragging = true; last = jogAngle(jog, ev); };
    window.addEventListener('mousemove', (ev) => { if (!dragging) return; const a = jogAngle(jog, ev); let dA = a - last; if (dA > Math.PI) dA -= 2 * Math.PI; if (dA < -Math.PI) dA += 2 * Math.PI; last = a; const en = eng(side); if (!en.buffers) return; const rev = en.baseBpm ? 60 / en.baseBpm * 4 : 2; en.nudge(dA / (2 * Math.PI) * rev); });
    window.addEventListener('mouseup', () => { dragging = false; });
  });

  // mixer (sliders planos + trim)
  $$('[data-strip]').forEach((inp) => { const side = inp.dataset.strip, ch = inp.dataset.ch; inp.oninput = (e) => { const v = parseFloat(e.target.value), en = eng(side); if (ch === 'vol') en.setVolume(v); else if (ch === 'trim') en.setTrim(v); else if (ch === 'filter') en.setFilter(v); else en.setEq(ch, v); }; });
  // kill EQ (clic en la etiqueta Hi/Mid/Lo)
  $$('.mix .ch').forEach((chEl) => { const inp = $('input', chEl), kl = $('.kl', chEl); if (inp && ['high', 'mid', 'low'].includes(inp.dataset.ch)) kl.onclick = () => { const killed = eng(inp.dataset.strip).killEq(inp.dataset.ch); kl.classList.toggle('killed', !!killed); }; });
  $('#xfader').oninput = (e) => NM.setCrossfader(parseFloat(e.target.value));
  $('#masterVol').oninput = (e) => NM.setMaster(parseFloat(e.target.value));
  $('#recBtn').onclick = toggleRec;
  $('#autoBtn').onclick = toggleAuto;
  $('#deck4Btn').onclick = toggleDeck4;
  $('#micBtn').onclick = toggleMic;
  $('#vizBtn').onclick = toggleViz;
  $('#safeBtn').onclick = toggleSafe;
  $('#vizClose').onclick = toggleViz;
  $('#vizStyle').onclick = cycleVizStyle;
  $('#vizCamBtn').onclick = toggleVizCam;
  $('#vizFull').onclick = toggleVizFull;
  $('#vizOverlay').addEventListener('mousemove', vizMouseMove);
  // estabilidad: un error no debe romper la sesión, se muestra en el footer
  window.addEventListener('error', (e) => { state._err = '⚠ ' + (e.message || 'error'); try { updateFooter(); } catch (_) {} });
  window.addEventListener('unhandledrejection', (e) => { state._err = '⚠ ' + ((e.reason && e.reason.message) || 'error'); try { updateFooter(); } catch (_) {} });

  // búsqueda + orden de librería
  $('#libSearch').oninput = (e) => { state.searchQ = e.target.value.toLowerCase(); renderLibrary(); };
  $$('thead th').forEach((th, i) => { const keys = ['file', 'bpm', 'camelot', null]; if (keys[i]) th.onclick = () => { if (state.sortKey === keys[i]) state.sortDir *= -1; else { state.sortKey = keys[i]; state.sortDir = 1; } renderLibrary(); }; });

  wireKeys();
  window.nm.onLib(onLibEvent); window.nm.onStems(onStemsEvent); wireModals();
}

// atajos de teclado (no interfieren al escribir)
function wireKeys() {
  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test((e.target.tagName || ''))) return;
    const k = e.key.toLowerCase();
    const map = { q: () => deckPlay('A'), p: () => deckPlay('B'), a: () => deckCue('A'), l: () => deckCue('B'), g: () => doSync('A'), h: () => doSync('B'), z: () => eng('A').beatJump(-4), x: () => eng('A').beatJump(4), n: () => eng('B').beatJump(-4), m: () => eng('B').beatJump(4) };
    if (map[k]) { e.preventDefault(); map[k](); return; }
    if (/^[1-8]$/.test(e.key)) { const b = $$('#spads .spad')[+e.key - 1]; if (b) { e.preventDefault(); b.click(); } return; }
    if (e.key === 'ArrowLeft') { const x = Math.max(0, parseFloat($('#xfader').value) - 0.05); $('#xfader').value = x; NM.setCrossfader(x); }
    if (e.key === 'ArrowRight') { const x = Math.min(1, parseFloat($('#xfader').value) + 0.05); $('#xfader').value = x; NM.setCrossfader(x); }
    if (e.code === 'Space') { e.preventDefault(); deckPlay(state.lastDeck || 'A'); }
  });
}

async function toggleRec() {
  if (!state.recording) { NM.recStart(); state.recording = true; $('#recBtn').classList.add('on'); $('#recBtn').textContent = '■ STOP'; }
  else { state.recording = false; $('#recBtn').classList.remove('on'); $('#recBtn').textContent = '● REC'; const blob = await NM.recStop(); if (blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'NeuralMix-set-' + Date.now() + '.webm'; a.click(); state._err = '✓ Set guardado (Descargas).'; updateFooter(); } }
}

function loop() {
  for (const side of ['A', 'B', 'C', 'D']) {
    const e = eng(side), d = state.deck[side];
    if (d) { field(side, 'time').textContent = fmtDur(e.position) + '/' + fmtDur(e.duration); if (field(side, 'bpm').textContent === '—' && e.baseBpm) field(side, 'bpm').textContent = (e.baseBpm * e.tempo).toFixed(1) + ' BPM'; drawWave(side); }
    drawJog(side);
  }
  $('#vu').style.width = Math.min(100, NM.masterRMS() * 180) + '%';
  drawMiniViz();
  autoMixTick(); requestAnimationFrame(loop);
}
// mini-visualizador central (espectro espejo; con animación de reposo)
function drawMiniViz() {
  const cv = $('#miniViz'); if (!cv || cv.offsetParent === null) return;   // oculto -> no dibuja
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 800, h = cv.clientHeight || 30;
  if (cv.width !== Math.round(w * dpr)) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const f = NM.freq(), mid = h / 2; let mx = 0; for (let i = 0; i < f.length; i++) if (f[i] > mx) mx = f[i];
  if (mx < 6) {                                                            // reposo: onda suave en movimiento
    const t = performance.now() / 700;
    ctx.strokeStyle = 'hsla(285,80%,62%,0.55)'; ctx.lineWidth = 2; ctx.beginPath();
    for (let x = 0; x <= w; x += 4) { const y = mid + Math.sin(x * 0.045 + t) * (0.5 + 0.5 * Math.sin(t * 0.6)) * (h * 0.24); x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke(); return;
  }
  const n = Math.min(160, Math.floor(w / 4)), step = Math.max(1, Math.floor(f.length * 0.72 / n)), bw = w / n;
  for (let i = 0; i < n; i++) { const v = (f[i * step] || 0) / 255, bh = Math.max(0.5, v * h * 0.5); ctx.fillStyle = `hsl(${300 - v * 170},85%,${48 + v * 28}%)`; ctx.fillRect(i * bw, mid - bh, Math.max(1, bw - 1), bh * 2); }
}

function updateFooter() {
  let info;
  if (!state.ready) info = '⚠ Motor de análisis no instalado.';
  else if (state.stemsJob) info = `✂ ${state.stemsJob.status} — ${state.stemsJob.name}` + (state.stemsQueue && state.stemsQueue.length ? ` (+${state.stemsQueue.length} en cola)` : '');
  else if (state.analyzing) info = `🔬 Analizando ${state._an || ''}… (${state.pending} en cola)`;
  else if (state._err) { info = (state._err.startsWith('✓') ? '' : '⚠ ') + state._err; state._err = null; }
  else if (state.tracks.length) info = `${state.tracks.length} tracks · carga a Deck A/B y mezcla 🎧`;
  else info = 'Añade música para empezar.';
  $('#footInfo').textContent = info;
}

// ---------- visualizador (animaciones reactivas) ----------
let vizOn = false, vizRaf = 0, vizStyle = 0, vizCamOn = false, vizCamStream = null, vizPhase = 0, vizTextValue = '', vizFull = false, _vizCtrlT = 0;
function toggleVizFull() {
  vizFull = !vizFull;
  $('#vizOverlay').classList.toggle('clean', vizFull);
  $('#vizFull').classList.toggle('on', vizFull);
  if (window.nm.setFullscreen) window.nm.setFullscreen(vizFull);
}
function vizMouseMove() {
  if (!vizFull) return;
  const o = $('#vizOverlay'); o.classList.add('showctrls');
  clearTimeout(_vizCtrlT); _vizCtrlT = setTimeout(() => o.classList.remove('showctrls'), 2500);
}
const VIZ_STYLES = 3;
function drawViz() {
  if (!vizOn) return;
  const cv = $('#vizCanvas'), ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 1280, h = cv.clientHeight || 720;
  if (cv.width !== Math.round(w * dpr)) { cv.width = w * dpr; cv.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // fondo: webcam o estela
  if (vizCamOn) { const v = $('#vizCam'); if (v.videoWidth) { ctx.globalAlpha = 1; ctx.drawImage(v, 0, 0, w, h); ctx.fillStyle = 'rgba(0,0,0,0.42)'; ctx.fillRect(0, 0, w, h); } else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); } }
  else { ctx.fillStyle = 'rgba(0,0,0,0.20)'; ctx.fillRect(0, 0, w, h); }
  const f = NM.freq(), rms = NM.masterRMS(); vizPhase += 0.01 + rms * 0.05;
  if (vizStyle === 0) vizRadial(ctx, w, h, f, rms);
  else if (vizStyle === 1) vizBars(ctx, w, h, f);
  else vizTunnel(ctx, w, h, f, rms);
  if (vizTextValue) { ctx.save(); ctx.textAlign = 'center'; ctx.font = 'bold ' + Math.round(h * 0.045) + 'px Segoe UI'; ctx.fillStyle = '#fff'; ctx.shadowColor = '#000'; ctx.shadowBlur = 14; ctx.fillText(vizTextValue, w / 2, h * 0.9); ctx.restore(); }
  vizRaf = requestAnimationFrame(drawViz);
}
function vizRadial(ctx, w, h, f, rms) {
  const n = 100, step = Math.max(1, Math.floor(f.length * 0.62 / n)), cx = w / 2, cy = h / 2, R = Math.min(w, h);
  for (let i = 0; i < n; i++) { const v = (f[i * step] || 0) / 255, ang = (i / n) * Math.PI * 2 - Math.PI / 2 + vizPhase * 0.3, r0 = R * 0.12, r1 = r0 + v * R * 0.34; ctx.strokeStyle = `hsl(${290 - v * 150},90%,${42 + v * 38}%)`; ctx.lineWidth = (2 * Math.PI * r0 / n) * 0.7; ctx.beginPath(); ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0); ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1); ctx.stroke(); }
  ctx.fillStyle = `rgba(217,70,239,${0.12 + rms * 0.8})`; ctx.beginPath(); ctx.arc(cx, cy, R * 0.09 * (1 + rms * 1.5), 0, Math.PI * 2); ctx.fill();
  const bw = w / n; for (let i = 0; i < n; i++) { const v = (f[i * step] || 0) / 255, bh = v * h * 0.26; const g = ctx.createLinearGradient(0, h, 0, h - bh); g.addColorStop(0, '#d946ef'); g.addColorStop(1, '#22d3ee'); ctx.fillStyle = g; ctx.fillRect(i * bw, h - bh, bw - 1, bh); }
}
function vizBars(ctx, w, h, f) {                                    // espectro espejo (centro)
  const n = 120, step = Math.max(1, Math.floor(f.length * 0.7 / n)), bw = w / n, cy = h / 2;
  for (let i = 0; i < n; i++) { const v = (f[i * step] || 0) / 255, bh = v * h * 0.45; ctx.fillStyle = `hsl(${300 - v * 170},90%,${45 + v * 35}%)`; ctx.fillRect(i * bw, cy - bh, bw - 2, bh); ctx.fillRect(i * bw, cy, bw - 2, bh); }
}
function vizTunnel(ctx, w, h, f, rms) {                             // anillos pulsantes
  const cx = w / 2, cy = h / 2, R = Math.min(w, h), rings = 9;
  for (let r = rings; r >= 1; r--) { const idx = Math.floor((r / rings) * f.length * 0.5), v = (f[idx] || 0) / 255; const rad = (r / rings) * R * 0.46 * (1 + v * 0.25); ctx.strokeStyle = `hsla(${200 + r * 16 + v * 80},90%,${40 + v * 40}%,${0.5 + v * 0.5})`; ctx.lineWidth = 2 + v * 10; ctx.beginPath(); ctx.arc(cx, cy, rad, vizPhase + r, vizPhase + r + Math.PI * 1.6); ctx.stroke(); }
  ctx.fillStyle = `rgba(34,211,238,${0.15 + rms})`; ctx.beginPath(); ctx.arc(cx, cy, R * 0.05 * (1 + rms * 2), 0, Math.PI * 2); ctx.fill();
}
function cycleVizStyle() { vizStyle = (vizStyle + 1) % VIZ_STYLES; }
async function toggleVizCam() {
  if (!vizCamOn) { try { vizCamStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280 } }); $('#vizCam').srcObject = vizCamStream; vizCamOn = true; $('#vizCamBtn').classList.add('on'); } catch (e) { state._err = 'No se pudo abrir la webcam: ' + e.message; updateFooter(); } }
  else { vizCamOn = false; $('#vizCamBtn').classList.remove('on'); if (vizCamStream) { vizCamStream.getTracks().forEach((t) => t.stop()); vizCamStream = null; } $('#vizCam').srcObject = null; }
}
function toggleViz() {
  vizOn = !vizOn; $('#vizOverlay').classList.toggle('show', vizOn); $('#vizBtn').classList.toggle('on', vizOn);
  if (vizOn) drawViz();
  else { cancelAnimationFrame(vizRaf); if (vizCamOn) toggleVizCam(); if (vizFull) toggleVizFull(); }
}

// ---------- micrófono ----------
let micOn = false;
async function toggleMic() {
  if (!micOn) { try { await NM.enableMic(); micOn = true; $('#micBtn').classList.add('on'); state._err = '✓ 🎤 Micrófono activo (entra en la mezcla y grabación)'; } catch (e) { state._err = 'No se pudo activar el micrófono: ' + e.message; } }
  else { NM.disableMic(); micOn = false; $('#micBtn').classList.remove('on'); }
  updateFooter();
}

// ---------- 4 decks (mostrar/ocultar C y D) ----------
function toggleDeck4() {
  const d4 = $('#deck4'), on = d4.style.display === 'none';
  d4.style.display = on ? '' : 'none';
  $('#deck4Btn').classList.toggle('on', on);
  $('.left').classList.toggle('has4', on);
}

// ---------- modo seguro ----------
let safeOn = false;
function toggleSafe() { safeOn = !safeOn; $('#safeBtn').classList.toggle('on', safeOn); window.nm.setSafe(safeOn); state._err = safeOn ? '✓ 🛡️ Modo seguro ON: pedirá confirmación al cerrar' : 'Modo seguro OFF'; updateFooter(); }

// ---------- idioma (i18n) + ajustes ----------
const I18N = {
  es: { tagline: 'Mezclador DJ con IA · 2-4 decks · stems · FX', library: 'Librería', openFolder: '📁 Carpeta', searchPh: '🔍 Buscar título / BPM / tono…', drop: '🎵 Arrastra música aquí o haz clic para añadir y analizar', support: '❤ Apoyar', cpEmpty: 'Carga un track a un deck y el Co-Pilot sugerirá el siguiente para mezclar.', settings: '⚙ Ajustes', settingsSub: 'Idioma, tema y preferencias. Se guardan en este equipo.', language: 'Idioma', theme: 'Tema (color de acento)', miniviz: 'Mini-visualizador en la ventana', show: 'Mostrar', hide: 'Ocultar', close: 'Cerrar' },
  en: { tagline: 'AI DJ mixer · 2-4 decks · stems · FX', library: 'Library', openFolder: '📁 Folder', searchPh: '🔍 Search title / BPM / key…', drop: '🎵 Drop music here or click to add & analyze', support: '❤ Support', cpEmpty: 'Load a track to a deck and the Co-Pilot will suggest the next to mix.', settings: '⚙ Settings', settingsSub: 'Language, theme and preferences. Saved on this device.', language: 'Language', theme: 'Theme (accent color)', miniviz: 'Mini-visualizer in window', show: 'Show', hide: 'Hide', close: 'Close' },
};
function applyLang(l) {
  localStorage.setItem('nm_lang', l); const d = I18N[l] || I18N.es;
  $$('[data-i18n]').forEach((e) => { const k = e.dataset.i18n; if (d[k] != null) e.textContent = d[k]; });
  $$('[data-i18n-ph]').forEach((e) => { const k = e.dataset.i18nPh; if (d[k] != null) e.placeholder = d[k]; });
  $$('#langSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === l));
}
function applyTheme(a, b) {
  document.documentElement.style.setProperty('--acc', a); document.documentElement.style.setProperty('--acc2', b);
  localStorage.setItem('nm_theme', a + '|' + b); $$('#themeRow .tdot').forEach((t) => t.classList.toggle('on', t.dataset.a === a));
}
function applyMini(on) {
  const el = $('.miniviz'); if (el) el.style.display = on ? '' : 'none';
  localStorage.setItem('nm_mini', on ? '1' : '0');
  $$('#miniSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === (on ? 'on' : 'off')));
}
function initSettings() {
  applyLang(localStorage.getItem('nm_lang') || 'es');
  const th = (localStorage.getItem('nm_theme') || '#d946ef|#22d3ee').split('|'); applyTheme(th[0], th[1]);
  applyMini(localStorage.getItem('nm_mini') !== '0');
}

function wireModals() {
  $('#settingsBtn').onclick = () => $('#mSettings').classList.add('show');
  $$('#langSeg button').forEach((b) => b.onclick = () => applyLang(b.dataset.v));
  $$('#miniSeg button').forEach((b) => b.onclick = () => applyMini(b.dataset.v === 'on'));
  $$('#themeRow .tdot').forEach((t) => t.onclick = () => applyTheme(t.dataset.a, t.dataset.b));
  $('#supportBtn').onclick = () => $('#mSupport').classList.add('show');
  $('#aboutBtn').onclick = () => $('#mAbout').classList.add('show');
  $$('.overlay').forEach((ov) => ov.onclick = (e) => { if (e.target === ov) ov.classList.remove('show'); });
  $$('[data-close]').forEach((b) => b.onclick = () => b.closest('.overlay').classList.remove('show'));
  $$('.modal .ext').forEach((a) => a.onclick = (e) => { e.preventDefault(); window.nm.openUrl(a.dataset.url); });
  $$('.modal .copy').forEach((b) => b.onclick = async () => { try { await navigator.clipboard.writeText($('#' + b.dataset.copy).textContent); } catch (_) {} const o = b.textContent; b.textContent = '✓'; b.classList.add('done'); setTimeout(() => { b.textContent = o; b.classList.remove('done'); }, 1200); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $$('.overlay.show').forEach((o) => o.classList.remove('show')); if (vizOn) toggleViz(); } });
}

init();
