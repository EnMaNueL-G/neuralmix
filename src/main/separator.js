// StemSplit AI - wrapper del motor de separacion (sidecar Python/Demucs).
// Lanza python/separate.py, parsea los eventos JSON por linea y los reenvia.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Raiz del proyecto (sube desde src/main/ -> raiz). En empaquetado, resources/app.
const ROOT = path.join(__dirname, '..', '..');

function venvPython() {
  // Python del entorno virtual incluido/instalado.
  const win = path.join(ROOT, 'python', 'venv', 'Scripts', 'python.exe');
  if (fs.existsSync(win)) return win;
  const nix = path.join(ROOT, 'python', 'venv', 'bin', 'python');
  if (fs.existsSync(nix)) return nix;
  return null;
}

function sidecarPath() {
  return path.join(ROOT, 'python', 'separate.py');
}

function ffmpegPath() {
  // ffmpeg-static expone la ruta al binario; en empaquetado puede venir en unpacked.
  try {
    let p = require('ffmpeg-static');
    if (p && p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* no instalado */ }
  // fallback: PATH del sistema
  return 'ffmpeg';
}

// Comprueba si el motor (venv + script) esta listo.
function engineReady() {
  return !!venvPython() && fs.existsSync(sidecarPath());
}

/**
 * Separa un archivo de audio.
 * opts: { input, outdir, model, stems, format, mp3Bitrate, device, name }
 * cb:   { onStatus(msg), onProgress(value,stage), onDone(result), onError(code,msg) }
 * Devuelve el ChildProcess (para poder cancelar con .kill()).
 */
function separate(opts, cb) {
  cb = cb || {};
  const py = venvPython();
  if (!py) {
    cb.onError && cb.onError('NO_ENGINE', 'El motor de IA no esta instalado (falta el entorno Python).');
    return null;
  }
  const args = [
    sidecarPath(),
    '--input', opts.input,
    '--outdir', opts.outdir,
    '--model', opts.model || 'htdemucs',
    '--stems', String(opts.stems || '4'),
    '--format', opts.format || 'wav',
    '--device', opts.device || 'cpu',
  ];
  if (opts.mp3Bitrate) args.push('--mp3-bitrate', String(opts.mp3Bitrate));
  if (opts.name) args.push('--name', opts.name);
  args.push('--ffmpeg', ffmpegPath());

  const child = spawn(py, args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }),
  });

  let buf = '';
  let errBuf = '';
  let finished = false;

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf-8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (_) { continue; }
      handleEvent(ev);
    }
  });

  child.stderr.on('data', (chunk) => { errBuf += chunk.toString('utf-8'); });

  function handleEvent(ev) {
    switch (ev.type) {
      case 'status': cb.onStatus && cb.onStatus(ev.msg); break;
      case 'progress': cb.onProgress && cb.onProgress(ev.value, ev.stage); break;
      case 'done':
        finished = true;
        cb.onDone && cb.onDone(ev);
        break;
      case 'error':
        finished = true;
        cb.onError && cb.onError(ev.code, ev.msg);
        break;
    }
  }

  child.on('error', (e) => {
    if (finished) return;
    finished = true;
    cb.onError && cb.onError('SPAWN', 'No se pudo iniciar el motor: ' + e.message);
  });

  child.on('close', (code) => {
    if (finished) return;
    finished = true;
    if (code === 0) {
      cb.onError && cb.onError('NO_OUTPUT', 'El motor termino sin producir stems.');
    } else {
      const tail = errBuf.split('\n').filter(Boolean).slice(-3).join(' | ');
      cb.onError && cb.onError('EXIT', 'El motor fallo (codigo ' + code + '). ' + tail);
    }
  });

  return child;
}

module.exports = { separate, engineReady, venvPython, sidecarPath, ffmpegPath };
