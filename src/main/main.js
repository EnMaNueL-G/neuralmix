// NeuralMix Pro - proceso principal.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const analyzer = require('./analyzer');
const library = require('./library');
const copilot = require('./suggest');
const separator = require('./separator');

const AUDIO_EXT = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'wma', 'aiff', 'aif'];
let mainWindow = null;
let analyzing = false;
let safeMode = false, forceClose = false;
const queue = [];
const srcMap = {};                 // path -> carpeta de origen
const stemsJobs = new Map();

// --------------------------- analisis en cola ---------------------------
async function pump(sender) {
  if (analyzing) return;
  analyzing = true;
  while (queue.length) {
    const fp = queue.shift();
    const name = path.basename(fp);
    sender && sender.send('lib:progress', { path: fp, name, pending: queue.length, state: 'analyzing' });
    try {
      const res = await analyzer.analyze(fp);
      const track = Object.assign({ path: fp, addedAt: Date.now(), source: srcMap[fp] || null }, res);
      library.upsert(track);
      const { embedding, ...light } = track;
      sender && sender.send('lib:done', { track: light, pending: queue.length });
    } catch (e) {
      sender && sender.send('lib:error', { path: fp, name, msg: String(e.message || e) });
    }
  }
  analyzing = false;
  sender && sender.send('lib:idle', {});
}

// --------------------------- selftest ---------------------------
async function runSelftest() {
  const out = (m) => process.stdout.write(m + '\n');
  let ok = true;
  if (analyzer.engineReady()) out('OK: venv + analyze.py');
  else { out('FAIL: motor no listo'); ok = false; }
  const ff = analyzer.ffmpegPath();
  if (ff !== 'ffmpeg' && fs.existsSync(ff)) out('OK: ffmpeg'); else { out('FAIL: ffmpeg'); ok = false; }
  const py = analyzer.venvPython();
  if (py) {
    const r = await new Promise((res) => {
      const c = spawn(py, ['-c', 'import librosa,soundfile,numpy; print(librosa.__version__)']);
      let s = ''; c.stdout.on('data', (d) => s += d); c.stderr.on('data', (d) => s += d);
      c.on('close', (code) => res({ code, s: s.trim() })); c.on('error', () => res({ code: 1, s: 'err' }));
    });
    if (r.code === 0) out('OK: librosa ' + r.s); else { out('FAIL: imports ' + r.s); ok = false; }
  }
  out(ok ? 'SELFTEST_OK' : 'SELFTEST_FAIL');
  app.exit(ok ? 0 : 1);
}

// --------------------------- ventana ---------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1340, height: 820, minWidth: 1120, minHeight: 680,
    backgroundColor: '#0a0a14', title: 'NeuralMix Pro',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Modo seguro: confirma antes de cerrar durante una sesión
  mainWindow.on('close', (e) => {
    if (!safeMode || forceClose) return;
    e.preventDefault();
    dialog.showMessageBox(mainWindow, { type: 'warning', buttons: ['Cancelar', 'Cerrar'], defaultId: 0, cancelId: 0,
      title: 'NeuralMix Pro', message: '¿Cerrar NeuralMix Pro?', detail: 'El modo seguro está activo (sesión en curso).' })
      .then((r) => { if (r.response === 1) { forceClose = true; mainWindow.close(); } });
  });
}

// --------------------------- IPC ---------------------------
function registerIpc() {
  ipcMain.handle('engine:status', () => ({ ready: analyzer.engineReady() }));
  ipcMain.handle('lib:list', () => library.list());
  ipcMain.handle('lib:remove', (_e, p) => { library.remove(p); return library.list(); });
  ipcMain.handle('lib:suggest', (_e, p) => {
    const tracks = library.all();
    const idx = tracks.findIndex((t) => t.path === p);
    if (idx < 0) return [];
    return copilot.suggest(tracks, idx, 5);
  });
  ipcMain.handle('pick:files', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Añadir música', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: AUDIO_EXT }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('lib:add', (e, paths, source) => {
    let added = 0;
    for (const p of paths) {
      if (!p || library.has(p) || queue.includes(p)) continue;
      if (source) srcMap[p] = source;
      queue.push(p); added++;
    }
    if (added) pump(e.sender);
    return { queued: added, pending: queue.length };
  });
  ipcMain.handle('dir:scan', (_e, dir) => {
    const out = [];
    const walk = (d, depth) => {
      if (depth > 4 || out.length >= 3000) return;
      let items; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const it of items) {
        if (out.length >= 3000) break;
        const p = path.join(d, it.name);
        if (it.isDirectory()) walk(p, depth + 1);
        else if (AUDIO_EXT.includes(path.extname(it.name).slice(1).toLowerCase())) out.push(p);
      }
    };
    walk(dir, 0);
    return { folder: path.basename(dir) || dir, files: out };
  });
  ipcMain.handle('audio:read', (_e, p) => {
    try { return fs.readFileSync(p); } catch (_) { return null; }
  });

  // --- separación de stems (Demucs) ---
  ipcMain.handle('stems:separate', (e, jobId, opts) => {
    const wc = e.sender;
    const outdir = path.join(app.getPath('music'), 'NeuralMix Stems', path.parse(opts.input).name);
    const child = separator.separate({
      input: opts.input, outdir, model: 'htdemucs', stems: opts.mode || '4',
      format: 'wav', device: 'cpu', name: path.parse(opts.input).name,
    }, {
      onStatus: (msg) => wc.send('stems:event', jobId, { type: 'status', msg }),
      onProgress: (value) => wc.send('stems:event', jobId, { type: 'progress', value }),
      onDone: (ev) => { stemsJobs.delete(jobId); wc.send('stems:event', jobId, { type: 'done', stems: ev.stems, outdir }); },
      onError: (code, msg) => { stemsJobs.delete(jobId); wc.send('stems:event', jobId, { type: 'error', code, msg }); },
    });
    if (child) stemsJobs.set(jobId, child);
    return !!child;
  });
  ipcMain.handle('stems:find', (_e, input) => {
    const base = path.parse(input).name;
    const dir = path.join(app.getPath('music'), 'NeuralMix Stems', base);
    const out = {}; let all = true;
    for (const s of ['vocals', 'drums', 'bass', 'other']) {
      const p = path.join(dir, base + ' - ' + s + '.wav');
      if (fs.existsSync(p)) out[s] = p; else all = false;
    }
    return all ? out : null;
  });
  ipcMain.handle('stems:cancel', (_e, jobId) => {
    const c = stemsJobs.get(jobId);
    if (c) { try { c.kill(); } catch (_) {} stemsJobs.delete(jobId); return true; }
    return false;
  });
  ipcMain.handle('open:path', (_e, p) => { if (p) shell.openPath(path.normalize(p)); });
  ipcMain.handle('open:folder', (_e, p) => { if (p) shell.showItemInFolder(path.normalize(p)); });
  ipcMain.handle('open:url', (_e, u) => { if (u && /^https?:\/\//.test(u)) shell.openExternal(u); });
  ipcMain.handle('app:safe', (_e, on) => { safeMode = !!on; });
  ipcMain.handle('win:fullscreen', (_e, on) => { if (mainWindow) mainWindow.setFullScreen(!!on); });
}

// --------------------------- shot ---------------------------
async function runShot() {
  registerIpc();
  const win = new BrowserWindow({ width: 1340, height: 820, show: process.argv.some((a) => a.startsWith('--shot=')), backgroundColor: '#0a0a14',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' } });
  mainWindow = win;
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 900));
  const target = (process.argv.find((a) => a.startsWith('--shot=')) || '').split('=')[1];
  if (target) {
    await win.webContents.executeJavaScript(
      `(function(){var m=document.getElementById('m'+${JSON.stringify(target)}.charAt(0).toUpperCase()+${JSON.stringify(target)}.slice(1));if(m)m.classList.add('show');})()`).catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
  }
  const img = await win.webContents.capturePage();
  const outDir = path.join(require('os').homedir(), 'Salidas-Logs');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
  const out = path.join(outDir, 'neuralmix-shot' + (target ? '-' + target : '') + '.png');
  fs.writeFileSync(out, img.toPNG());
  process.stdout.write('SHOT_OK ' + out + '\n');
  app.exit(0);
}

// --------------------------- e2e ---------------------------
async function runE2E() {
  registerIpc();
  const win = new BrowserWindow({ width: 1280, height: 820, show: false, backgroundColor: '#0a0a14',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' } });
  mainWindow = win;
  win.webContents.on('console-message', (_e, _l, m) => process.stdout.write('[r] ' + m + '\n'));
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1300)); // init + carga de librería cacheada
  const r = await win.webContents.executeJavaScript(`(async()=>{ try{
    if(typeof NM==='undefined') return JSON.stringify({err:'NM undefined (engine no cargó)'});
    if(state.tracks.length<2) return JSON.stringify({err:'faltan 2 tracks', n:state.tracks.length});
    await loadToDeck('A', state.tracks[0].path); deckPlay('A');
    await new Promise(r=>setTimeout(r,1600));
    const Apos=NM.deckA.position, rmsA=NM.masterRMS();
    await loadToDeck('B', state.tracks[1].path); deckPlay('B');
    NM.setCrossfader(0.5); document.getElementById('xfader').value=0.5;
    await new Promise(r=>setTimeout(r,1200));
    const rmsMid=NM.masterRMS();
    doSync('B');
    NM.setCrossfader(1.0); document.getElementById('xfader').value=1;
    await new Promise(r=>setTimeout(r,400));
    const rmsB=NM.masterRMS();
    document.querySelector('[data-strip=A][data-ch=low]').value=-26;
    NM.deckA.setEq('low',-26);
    // FX
    NM.deckA.setEcho(0.8); NM.deckA.setReverb(0.8);
    const echoWet=Math.round(NM.deckA.echoWet.gain.value*100)/100, revWet=Math.round(NM.deckA.revWet.gain.value*100)/100;
    const bandsN=(state.deck.A&&state.deck.A.bands)?state.deck.A.bands.n:0;
    NM.deckA.setFx('flanger',0.7); const flWet=Math.round(NM.deckA.flWet.gain.value*100)/100;
    NM.deckA.setFx('phaser',0.7); const phWet=Math.round(NM.deckA.phWet.gain.value*100)/100;
    NM.deckA.setTrim(1.3); const trimV=Math.round(NM.deckA.trim.gain.value*100)/100;
    const killed=NM.deckA.killEq('low'); const killGain=Math.round(NM.deckA.eqLow.gain.value);
    NM.deckA.pause(); NM.deckA.seek(40); const bjBefore=Math.round(NM.deckA.position); NM.deckA.beatJump(4); const bjAfter=Math.round(NM.deckA.position*10)/10;
    // hot cue: fija en 30s, salta a 60, vuelve al cue
    NM.deckA.pause(); NM.deckA.seek(30); NM.deckA.setCue(0); NM.deckA.seek(60); NM.deckA.jumpCue(0);
    const cuePos=Math.round(NM.deckA.position);
    // loop
    NM.deckA.setLoop(4); const loopSet=!!NM.deckA.loop; NM.deckA.clearLoop();
    // filtro
    NM.deckA.setFilter(-1); const filtType=NM.deckA.filter.type, filtFreq=Math.round(NM.deckA.filter.frequency.value); NM.deckA.setFilter(0);
    // grabación
    NM.recStart(); await new Promise(r=>setTimeout(r,700)); const blob=await NM.recStop(); const recSize=blob?blob.size:0;
    // Key Lock (worklet WSOLA)
    NM.deckA.pause(); NM.deckA.seek(20); NM.deckA.setKeyLock(true); NM.deckA.setTempo(1.08); NM.deckA.play();
    NM.setCrossfader(0); document.getElementById('xfader').value=0;
    await new Promise(r=>setTimeout(r,1600));
    const klWk=!!(NM.deckA.sources[0]&&NM.deckA.sources[0]._wk), klPos=Math.round(NM.deckA.position*10)/10, klRms=Math.round(NM.masterRMS()*1000)/1000;
    return JSON.stringify({n:state.tracks.length, Aplaying:NM.deckA.playing, Bplaying:NM.deckB.playing, klWk, klPos, klRms,
      cuePos, loopSet, filtType, filtFreq, recSize, echoWet, revWet, bandsN, flWet, phWet, trimV, killed, killGain, bjBefore, bjAfter,
      Apos:Math.round(Apos*100)/100, rmsA:Math.round(rmsA*1000)/1000, rmsMid:Math.round(rmsMid*1000)/1000, rmsB:Math.round(rmsB*1000)/1000,
      Abpm:NM.deckA.bpm, Bbase:NM.deckB.baseBpm, Btempo:Math.round(NM.deckB.tempo*1000)/1000, Bsynced:Math.round(NM.deckB.baseBpm*NM.deckB.tempo*10)/10,
      Adur:Math.round(NM.deckA.duration*10)/10, acState:NM.ac.state, nsg:document.querySelectorAll('.sg').length});
  }catch(e){ return JSON.stringify({err:String(e&&e.message||e), stack:String(e&&e.stack||'').slice(0,300)}); } })()`);
  process.stdout.write('RESULT: ' + r + '\n');
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage();
  const outDir = path.join(require('os').homedir(), 'Salidas-Logs');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'neuralmix-e2e.png'), img.toPNG());
  process.stdout.write('E2E_SHOT ' + path.join(outDir, 'neuralmix-e2e.png') + '\n');
  app.exit(0);
}

async function runStemE2E() {
  registerIpc();
  const win = new BrowserWindow({ width: 1280, height: 820, show: false, backgroundColor: '#0a0a14',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' } });
  mainWindow = win;
  win.webContents.on('console-message', (_e, _l, m) => process.stdout.write('[r] ' + m + '\n'));
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1300));
  const r = await win.webContents.executeJavaScript(`(async()=>{try{
    const t=state.tracks.find(x=>/TU Y YO/i.test(x.file))||state.tracks[0];
    await loadToDeck('A', t.path);
    const isStems=NM.deckA.isStems;
    deckPlay('A'); await new Promise(r=>setTimeout(r,1800));
    const rmsAll=NM.masterRMS();
    NM.STEMS.forEach(s=>NM.deckA.setStem(s,false)); await new Promise(r=>setTimeout(r,700));
    const rmsMuted=NM.masterRMS();
    NM.deckA.setStem('vocals',true); await new Promise(r=>setTimeout(r,700));
    const rmsVoc=NM.masterRMS();
    return JSON.stringify({file:t.file.slice(0,30), isStems, rmsAll:Math.round(rmsAll*1000)/1000, rmsMuted:Math.round(rmsMuted*1000)/1000, rmsVoc:Math.round(rmsVoc*1000)/1000});
  }catch(e){return JSON.stringify({err:String(e&&e.message||e)})}})()`);
  process.stdout.write('STEMRESULT: ' + r + '\n');
  app.exit(0);
}

async function runWkTest() {
  registerIpc();
  const win = new BrowserWindow({ width: 600, height: 400, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' } });
  mainWindow = win;
  win.webContents.on('console-message', (_e, _l, m) => process.stdout.write('[r] ' + m + '\n'));
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 800));
  const r = await win.webContents.executeJavaScript(`(async()=>{ try{
    const sr=44100;
    function freqOf(buf){ // cruces por cero en 0.1..0.4s
      const ch=buf.getChannelData(0); let cr=0; const a=Math.floor(sr*0.1), b=Math.floor(sr*0.4);
      for(let i=a+1;i<b;i++){ if((ch[i-1]<0&&ch[i]>=0)||(ch[i-1]>=0&&ch[i]<0)) cr++; }
      let rms=0; for(let i=a;i<b;i++) rms+=ch[i]*ch[i]; rms=Math.sqrt(rms/(b-a));
      return {freq:Math.round(cr/2/0.3), rms:Math.round(rms*1000)/1000};
    }
    async function render(tempo){
      const oac=new OfflineAudioContext(2, sr*2, sr);
      await oac.audioWorklet.addModule('timestretch-worklet.js');
      const sine=new Float32Array(sr*1); for(let i=0;i<sine.length;i++) sine[i]=Math.sin(2*Math.PI*440*i/sr)*0.8;
      const node=new AudioWorkletNode(oac,'timestretch',{outputChannelCount:[2],numberOfOutputs:1,processorOptions:{channels:[sine,sine.slice()],startSample:0,playing:true}});
      node.parameters.get('tempo').value=tempo; node.connect(oac.destination);
      const rb=await oac.startRendering(); return freqOf(rb);
    }
    const t10=await render(1.0), t108=await render(1.08), t092=await render(0.92), t12=await render(1.2);
    return JSON.stringify({inputFreq:440, tempo1_0:t10, tempo1_08:t108, tempo0_92:t092, tempo1_2:t12});
  }catch(e){ return JSON.stringify({err:String(e&&e.message||e)}); } })()`);
  process.stdout.write('WKRESULT: ' + r + '\n');
  app.exit(0);
}

async function runSampTest() {
  registerIpc();
  const win = new BrowserWindow({ width: 1340, height: 820, show: false, backgroundColor: '#0a0a14',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' } });
  mainWindow = win;
  win.webContents.on('console-message', (_e, _l, m) => process.stdout.write('[r] ' + m + '\n'));
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1300));   // espera síntesis del sampler
  const r = await win.webContents.executeJavaScript(`(async()=>{ try{
    const names=[]; for(let i=0;i<8;i++){ const n=NM.sampler.name(i); if(n) names.push(n); }
    const ok=NM.sampler.trigger(0);
    let peak=0; for(let k=0;k<8;k++){ await new Promise(r=>setTimeout(r,40)); peak=Math.max(peak,NM.masterRMS()); }
    return JSON.stringify({names, triggered:ok, peakRms:Math.round(peak*1000)/1000, pads:document.querySelectorAll('#spads .spad').length});
  }catch(e){ return JSON.stringify({err:String(e&&e.message||e)}); } })()`);
  process.stdout.write('SAMPRESULT: ' + r + '\n');
  const img = await win.webContents.capturePage();
  const outDir = path.join(require('os').homedir(), 'Salidas-Logs');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'neuralmix-shot.png'), img.toPNG());
  process.stdout.write('SHOT_OK\n');
  app.exit(0);
}

async function runDeck4Test() {
  registerIpc();
  const win = new BrowserWindow({ width: 1340, height: 900, show: false, backgroundColor: '#0a0a14',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' } });
  mainWindow = win;
  win.webContents.on('console-message', (_e, _l, m) => process.stdout.write('[r] ' + m + '\n'));
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1300));
  const r = await win.webContents.executeJavaScript(`(async()=>{ try{
    const t=state.tracks; if(t.length<1) return JSON.stringify({err:'sin tracks'});
    toggleDeck4();
    await loadToDeck('A', t[0].path); await loadToDeck('B', t[1%t.length].path); await loadToDeck('C', t[2%t.length].path); await loadToDeck('D', t[3%t.length].path);
    deckPlay('A'); deckPlay('B'); deckPlay('C'); deckPlay('D');
    NM.setCrossfader(0.5);
    await new Promise(r=>setTimeout(r,1600));
    const rmsAll=NM.masterRMS();
    NM.deckC.setVolume(0); NM.deckD.setVolume(0);
    await new Promise(r=>setTimeout(r,500));
    const rmsAB=NM.masterRMS();
    return JSON.stringify({n:t.length, deck4Shown:document.getElementById('deck4').style.display!=='none',
      Aplaying:NM.deckA.playing,Bplaying:NM.deckB.playing,Cplaying:NM.deckC.playing,Dplaying:NM.deckD.playing,
      Cpos:Math.round(NM.deckC.position*10)/10, rmsAll:Math.round(rmsAll*1000)/1000, rmsAB:Math.round(rmsAB*1000)/1000});
  }catch(e){ return JSON.stringify({err:String(e&&e.message||e)}); } })()`);
  process.stdout.write('DECK4RESULT: ' + r + '\n');
  const img = await win.webContents.capturePage();
  const outDir = path.join(require('os').homedir(), 'Salidas-Logs');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'neuralmix-deck4.png'), img.toPNG());
  process.stdout.write('DECK4_SHOT\n'); app.exit(0);
}

async function runFolderTest() {
  registerIpc();
  const win = new BrowserWindow({ width: 1100, height: 700, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow = win;
  win.webContents.on('console-message', (_e, _l, m) => process.stdout.write('[r] ' + m + '\n'));
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1000));
  const dir = path.join(require('os').homedir(), 'Desktop', 'TestCarpeta');
  const sc = await win.webContents.executeJavaScript(`(async()=>{ try{ const r=await window.nm.dirScan(${JSON.stringify(dir)}); await window.nm.libAdd(r.files, r.folder); return JSON.stringify({scanned:r.files.length, folder:r.folder}); }catch(e){ return JSON.stringify({err:String(e&&e.message||e)}); } })()`);
  process.stdout.write('SCAN: ' + sc + '\n');
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const s = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({n:state.tracks.length, withSrc:state.tracks.filter(t=>t.source==='TestCarpeta').length, chips:document.querySelectorAll('#sources .src-chip').length})`));
    process.stdout.write('POLL ' + i + ': ' + JSON.stringify(s) + '\n');
    if (s.withSrc > 0) break;
  }
  const filt = await win.webContents.executeJavaScript(`(function(){ state.sourceFilter='TestCarpeta'; renderLibrary(); return JSON.stringify({filteredRows:document.querySelectorAll('#libBody tr').length, chips:document.querySelectorAll('#sources .src-chip').length}); })()`);
  process.stdout.write('FOLDERTEST_DONE: ' + filt + '\n');
  app.exit(0);
}

async function runStemsQTest() {
  registerIpc();
  const win = new BrowserWindow({ width: 1100, height: 700, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow = win;
  win.webContents.on('console-message', (_e, _l, m) => process.stdout.write('[r] ' + m + '\n'));
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1000));
  const f1 = path.join(require('os').homedir(), 'Desktop', 'qtest1.mp3');
  const f2 = path.join(require('os').homedir(), 'Desktop', 'qtest2.mp3');
  await win.webContents.executeJavaScript(`startStems(${JSON.stringify(f1)}); startStems(${JSON.stringify(f2)}); 'ok'`);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({job:(state.stemsJob&&state.stemsJob.name)||null, q:(state.stemsQueue||[]).length})`));
    process.stdout.write('POLL ' + i + ': ' + JSON.stringify(s) + '\n');
    if (!s.job && !s.q) break;
  }
  const base = path.join(app.getPath('music'), 'NeuralMix Stems');
  const ok1 = fs.existsSync(path.join(base, 'qtest1', 'qtest1 - vocals.wav'));
  const ok2 = fs.existsSync(path.join(base, 'qtest2', 'qtest2 - vocals.wav'));
  process.stdout.write('STEMSQ_RESULT: ' + JSON.stringify({ song1Stems: ok1, song2Stems: ok2 }) + '\n');
  app.exit(0);
}

function pngToIco(png) {
  const h = Buffer.alloc(6); h.writeUInt16LE(0, 0); h.writeUInt16LE(1, 2); h.writeUInt16LE(1, 4);
  const d = Buffer.alloc(16); d.writeUInt8(0, 0); d.writeUInt8(0, 1); d.writeUInt8(0, 2); d.writeUInt8(0, 3);
  d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6); d.writeUInt32LE(png.length, 8); d.writeUInt32LE(22, 12);
  return Buffer.concat([h, d, png]);
}
async function runMakeIcon() {
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { offscreen: false } });
  const bars = Array.from({ length: 12 }, (_, i) => `<line x1="12" y1="6.6" x2="12" y2="${[3.0, 4.6][i % 2]}" transform="rotate(${i * 30} 12 12)"/>`).join('');
  const svg = `<svg width="150" height="150" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="2.7" fill="#fff"/><g stroke="#fff" stroke-width="1.6" stroke-linecap="round">${bars}</g></svg>`;
  const html = `<html><body style="margin:0;background:transparent"><div style="width:256px;height:256px;border-radius:58px;background:linear-gradient(135deg,#d946ef,#22d3ee);display:flex;align-items:center;justify-content:center;box-shadow:inset 0 0 40px #ffffff22">${svg}</div></body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 450));
  const png = (await win.webContents.capturePage()).toPNG();
  const assetsDir = path.join(__dirname, '..', '..', 'assets'); fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'icon-256.png'), png);
  fs.writeFileSync(path.join(assetsDir, 'icon.ico'), pngToIco(png));
  process.stdout.write('ICON_OK ' + path.join(assetsDir, 'icon.ico') + '\n'); app.exit(0);
}

async function runCfgTest() {
  registerIpc();
  const win = new BrowserWindow({ width: 1100, height: 700, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow = win;
  win.webContents.on('console-message', (_e, _l, m) => process.stdout.write('[r] ' + m + '\n'));
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 900));
  const r = await win.webContents.executeJavaScript(`(async function(){ try{
    document.getElementById('settingsBtn').click();
    const opened=document.getElementById('mSettings').classList.contains('show');
    applyLang('en'); const libEn=document.querySelector('[data-i18n=library]').textContent;
    applyLang('es');
    applyTheme('#10b981','#22d3ee'); const acc=getComputedStyle(document.documentElement).getPropertyValue('--acc').trim();
    applyTheme('#d946ef','#22d3ee');
    let scanCount=0, scanFolder=''; try{ const sc=await window.nm.dirScan('C:/Users/usuario/Downloads/OptiGrab'); scanCount=(sc&&sc.files)?sc.files.length:0; scanFolder=sc?sc.folder:''; }catch(_){}
    const hasMini=!!document.getElementById('miniViz'), hasFolderBtn=!!document.getElementById('folderBtn'), hasSources=!!document.getElementById('sources');
    return JSON.stringify({opened, libEn, acc, scanCount, scanFolder, hasMini, hasFolderBtn, hasSources});
  }catch(e){ return JSON.stringify({err:String(e&&e.message||e)}); } })()`);
  process.stdout.write('CFGRESULT: ' + r + '\n');
  app.exit(0);
}

async function runVizTest() {
  registerIpc();
  const win = new BrowserWindow({ width: 1340, height: 820, show: false, backgroundColor: '#0a0a14',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required' } });
  mainWindow = win;
  win.webContents.on('console-message', (_e, _l, m) => process.stdout.write('[r] ' + m + '\n'));
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1300));
  const r = await win.webContents.executeJavaScript(`(async()=>{ try{
    if(state.tracks.length){ await loadToDeck('A', state.tracks[0].path); deckPlay('A'); NM.setCrossfader(0); document.getElementById('xfader').value=0; }
    vizTextValue='♫ Fiesta NeuralMix 2026 ♫';
    toggleViz(); cycleVizStyle(); cycleVizStyle();
    const camOk = (typeof toggleVizCam==='function');
    await new Promise(r=>setTimeout(r,1000));
    const f=NM.freq(); let mx=0; for(let i=0;i<f.length;i++) mx=Math.max(mx,f[i]);
    const vizShown=document.getElementById('vizOverlay').classList.contains('show');
    toggleVizFull(); const cleanCls=document.getElementById('vizOverlay').classList.contains('clean'); toggleVizFull();
    const closeWired=typeof document.getElementById('vizClose').onclick==='function';
    const fullWired=typeof document.getElementById('vizFull').onclick==='function';
    let micErr='ok'; try{ await NM.enableMic(); }catch(e){ micErr=(e.name||e.message||'err'); }
    return JSON.stringify({vizShown, freqMax:mx, vizStyle, camOk, cleanCls, closeWired, fullWired, micErr:String(micErr).slice(0,30)});
  }catch(e){ return JSON.stringify({err:String(e&&e.message||e)}); } })()`);
  process.stdout.write('VIZRESULT: ' + r + '\n');
  const img = await win.webContents.capturePage();
  const outDir = path.join(require('os').homedir(), 'Salidas-Logs');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'neuralmix-viz.png'), img.toPNG());
  process.stdout.write('VIZSHOT_OK\n');
  app.exit(0);
}

// --------------------------- arranque ---------------------------
const isDeck4Test = process.argv.includes('--deck4test');
const isFolderTest = process.argv.includes('--foldertest');
const isStemsQTest = process.argv.includes('--stemsqtest');
const isMakeIcon = process.argv.includes('--makeicon');
const isCfgTest = process.argv.includes('--cfgtest');
const isVizTest = process.argv.includes('--viztest');
const isSampTest = process.argv.includes('--samptest');
const isWkTest = process.argv.includes('--wktest');
const isStemE2E = process.argv.includes('--e2estem');
const isSelftest = process.argv.includes('--selftest');
const isShot = process.argv.some((a) => a === '--shot' || a.startsWith('--shot='));
const isE2E = process.argv.some((a) => a === '--e2e' || a.startsWith('--e2efiles='));

if (isDeck4Test) {
  app.whenReady().then(() => { library.init(app.getPath('userData')); runDeck4Test(); });
} else if (isFolderTest) {
  app.whenReady().then(() => { library.init(app.getPath('userData')); runFolderTest(); });
} else if (isStemsQTest) {
  app.whenReady().then(() => { library.init(app.getPath('userData')); runStemsQTest(); });
} else if (isMakeIcon) {
  app.whenReady().then(runMakeIcon);
} else if (isCfgTest) {
  app.whenReady().then(() => { library.init(app.getPath('userData')); runCfgTest(); });
} else if (isVizTest) {
  app.whenReady().then(() => { library.init(app.getPath('userData')); runVizTest(); });
} else if (isSampTest) {
  app.whenReady().then(() => { library.init(app.getPath('userData')); runSampTest(); });
} else if (isWkTest) {
  app.whenReady().then(() => { library.init(app.getPath('userData')); runWkTest(); });
} else if (isStemE2E) {
  app.whenReady().then(() => { library.init(app.getPath('userData')); runStemE2E(); });
} else if (isSelftest) {
  app.whenReady().then(() => { library.init(app.getPath('userData')); runSelftest(); });
} else if (isShot) {
  app.whenReady().then(() => { library.init(app.getPath('userData')); runShot(); });
} else if (isE2E) {
  app.whenReady().then(() => { library.init(app.getPath('userData')); runE2E(); });
} else {
  const lock = app.requestSingleInstanceLock();
  if (!lock) { app.quit(); } else {
    app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
    app.whenReady().then(() => { library.init(app.getPath('userData')); registerIpc(); createWindow(); });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
