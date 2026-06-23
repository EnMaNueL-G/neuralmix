// NeuralMix Pro - wrapper del motor de analisis (sidecar Python/librosa).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');

function venvPython() {
  const win = path.join(ROOT, 'python', 'venv', 'Scripts', 'python.exe');
  if (fs.existsSync(win)) return win;
  const nix = path.join(ROOT, 'python', 'venv', 'bin', 'python');
  if (fs.existsSync(nix)) return nix;
  return null;
}

function scriptPath() { return path.join(ROOT, 'python', 'analyze.py'); }

function ffmpegPath() {
  try {
    let p = require('ffmpeg-static');
    if (p && p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* */ }
  return 'ffmpeg';
}

function engineReady() { return !!venvPython() && fs.existsSync(scriptPath()); }

/**
 * Analiza un archivo. Devuelve una Promise<dict> con el analisis (o lanza error).
 */
function analyze(filePath) {
  return new Promise((resolve, reject) => {
    const py = venvPython();
    if (!py) return reject(new Error('Motor de análisis no instalado (falta Python/librosa).'));
    const child = spawn(py, [scriptPath(), '--input', filePath, '--ffmpeg', ffmpegPath()], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf-8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf-8'); });
    child.on('error', (e) => reject(e));
    child.on('close', () => {
      const line = out.split('\n').map((s) => s.trim()).filter(Boolean).pop();
      if (!line) return reject(new Error('Sin salida del analizador. ' + err.slice(-200)));
      let obj;
      try { obj = JSON.parse(line); } catch (_) { return reject(new Error('Salida no válida: ' + line.slice(0, 200))); }
      if (obj.error) return reject(new Error(obj.msg || obj.error));
      resolve(obj);
    });
    return child;
  });
}

module.exports = { analyze, engineReady, venvPython, ffmpegPath, scriptPath };
