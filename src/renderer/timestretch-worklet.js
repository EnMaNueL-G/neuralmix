// NeuralMix Pro - Time-stretch (Key Lock / Master Tempo) por WSOLA.
// Cambia el tempo SIN alterar el tono. WSOLA = overlap-add con búsqueda de
// similitud de forma de onda (alinea la fase entre granos -> preserva el tono).

class TimeStretchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'tempo', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.ch = o.channels || [];
    this.numCh = this.ch.length;
    this.len = this.numCh ? this.ch[0].length : 0;
    this.readPos = o.startSample || 0;
    this.playing = o.playing !== false;
    this.N = 1024; this.Hs = 256; this.L = this.N - this.Hs;
    this.SEARCH = 300;                 // radio de búsqueda WSOLA (muestras)
    this.W = 256;                      // ventana de correlación
    this.NORM = 1.5;
    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.N - 1));
    this.prevUsed = Math.floor(this.readPos);
    this.tail = []; this.fifo = []; this.fcap = 16384;
    for (let c = 0; c < this.numCh; c++) { this.tail.push(new Float32Array(this.L)); this.fifo.push(new Float32Array(this.fcap)); }
    this.fhead = 0; this.favail = 0; this.ended = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'play') this.playing = true;
      else if (d.type === 'stop') this.playing = false;
      else if (d.type === 'seek') { this.readPos = d.sample; this.prevUsed = Math.floor(d.sample); this._reset(); }
    };
  }
  _reset() { for (let c = 0; c < this.numCh; c++) this.tail[c].fill(0); this.fhead = 0; this.favail = 0; this.ended = false; }

  // busca el desplazamiento (cerca de target) que mejor continúa la onda desde `natural`
  _bestOffset(target, natural) {
    if (target === natural) return 0;             // tempo=1: contiguo
    const c0 = this.ch[0]; let best = -Infinity, bestD = 0;
    const W = this.W, S = this.SEARCH;
    for (let d = -S; d <= S; d += 2) {
      const ts = target + d; if (ts < 0 || ts + W >= this.len || natural + W >= this.len) continue;
      let acc = 0; for (let i = 0; i < W; i += 2) acc += c0[ts + i] * c0[natural + i];
      if (acc > best) { best = acc; bestD = d; }
    }
    return bestD;
  }
  _step(tempo) {
    const target = Math.floor(this.readPos);
    if (target >= this.len) { this.ended = true; }
    const natural = this.prevUsed + this.Hs;
    const d = this.ended ? 0 : this._bestOffset(target, natural);
    const start = target + d;
    for (let c = 0; c < this.numCh; c++) {
      const src = this.ch[c], tail = this.tail[c], fifo = this.fifo[c];
      for (let i = 0; i < this.Hs; i++) {
        const s = start + i; const g = (s >= 0 && s < this.len) ? src[s] * this.win[i] : 0;
        fifo[(this.fhead + this.favail + i) % this.fcap] = (tail[i] + g) / this.NORM;
      }
      const nt = new Float32Array(this.L);
      for (let j = 0; j < this.L; j++) {
        const prev = (j + this.Hs < this.L) ? tail[j + this.Hs] : 0;
        const s = start + this.Hs + j; const g = (s >= 0 && s < this.len) ? src[s] * this.win[this.Hs + j] : 0;
        nt[j] = prev + g;
      }
      this.tail[c] = nt;
    }
    this.prevUsed = start;
    this.favail += this.Hs;
    this.readPos += this.Hs * tempo;
  }
  process(_in, outputs, params) {
    const out = outputs[0];
    if (!this.numCh || !this.playing) { for (const o of out) o.fill(0); return true; }
    const tempo = params.tempo.length ? params.tempo[0] : 1;
    const frames = out[0].length;
    while (this.favail < frames && !this.ended) this._step(tempo);
    for (let c = 0; c < out.length; c++) {
      const fifo = this.fifo[Math.min(c, this.numCh - 1)], o = out[c];
      for (let i = 0; i < frames; i++) o[i] = (i < this.favail) ? fifo[(this.fhead + i) % this.fcap] : 0;
    }
    this.fhead = (this.fhead + frames) % this.fcap;
    this.favail = Math.max(0, this.favail - frames);
    return true;
  }
}
registerProcessor('timestretch', TimeStretchProcessor);
