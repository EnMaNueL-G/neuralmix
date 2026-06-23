// NeuralMix Pro - motor de audio (Web Audio): 2 decks, EQ, crossfader, stems, FX, grabación.
// Expone window.NM con deckA, deckB y el bus master. Posición por contador propio (DJ-grade).

const NM = (() => {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const master = ac.createGain(); master.gain.value = 0.9;
  const analyser = ac.createAnalyser(); analyser.fftSize = 1024;
  const recDest = ac.createMediaStreamDestination();
  master.connect(analyser); analyser.connect(ac.destination); master.connect(recDest);

  const STEMS = ['vocals', 'drums', 'bass', 'other'];
  let wkReady = false;
  ac.audioWorklet.addModule('timestretch-worklet.js').then(() => { wkReady = true; }).catch((e) => { try { console.warn('keylock worklet:', e.message); } catch (_) {} });

  function biquad(type, freq) { const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; return f; }
  function makeImpulse(seconds = 1.8, decay = 3.2) {
    const len = Math.floor(ac.sampleRate * seconds), buf = ac.createBuffer(2, len, ac.sampleRate);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return buf;
  }
  const reverbIR = makeImpulse();

  class Deck {
    constructor(side) {
      this.side = side;
      this.buffers = null;        // { main: AudioBuffer } o { vocals,drums,bass,other }
      this.isStems = false;
      this.duration = 0;
      this.bpm = 0; this.baseBpm = 0; this.camelot = '';
      this.name = '';
      this.tempo = 1;             // playbackRate
      this.keylock = false;       // Key Lock (Master Tempo): tempo sin alterar tono
      this.playing = false;
      this._startCtx = 0;         // ac.currentTime al arrancar
      this._startPos = 0;         // posición (s) al arrancar
      this.sources = [];
      this.cues = [null, null, null, null];
      this.loop = null;           // {start,end} en s
      // grafo: stemGain[x] -> sum -> eqLow -> eqMid -> eqHigh -> filter -> vol -> xfade -> master
      this.sum = ac.createGain();
      this.eqLow = biquad('lowshelf', 120);
      this.eqMid = biquad('peaking', 1000); this.eqMid.Q.value = 0.8;
      this.eqHigh = biquad('highshelf', 3500);
      this.filter = biquad('lowpass', 22050); this.filter.Q.value = 1;
      this.trim = ac.createGain();                 // gain/trim de entrada
      this.eqKill = { low: 0, mid: 0, high: 0 };    // estado kill EQ
      this.vol = ac.createGain();
      this.xfade = ac.createGain();
      // FX (paralelo, sumado al crossfade): dry + echo + reverb + flanger + phaser
      this.fxDry = ac.createGain();
      this.delay = ac.createDelay(2.0); this.delayFb = ac.createGain(); this.echoWet = ac.createGain();
      this.reverb = ac.createConvolver(); this.reverb.buffer = reverbIR; this.revWet = ac.createGain();
      this.flDelay = ac.createDelay(0.05); this.flFb = ac.createGain(); this.flWet = ac.createGain();
      this.flLfo = ac.createOscillator(); this.flLfoG = ac.createGain();
      this.ph = [biquad('allpass', 800), biquad('allpass', 800), biquad('allpass', 800), biquad('allpass', 800)];
      this.phWet = ac.createGain(); this.phLfo = ac.createOscillator(); this.phLfoG = ac.createGain();
      this.delayFb.gain.value = 0; this.echoWet.gain.value = 0; this.revWet.gain.value = 0;
      this.flWet.gain.value = 0; this.phWet.gain.value = 0; this.flFb.gain.value = 0.3;
      this.sum.connect(this.trim); this.trim.connect(this.eqLow);
      this.eqLow.connect(this.eqMid); this.eqMid.connect(this.eqHigh);
      this.eqHigh.connect(this.filter); this.filter.connect(this.vol);
      this.vol.connect(this.fxDry); this.fxDry.connect(this.xfade);
      this.vol.connect(this.delay); this.delay.connect(this.echoWet); this.echoWet.connect(this.xfade);
      this.delay.connect(this.delayFb); this.delayFb.connect(this.delay);
      this.vol.connect(this.reverb); this.reverb.connect(this.revWet); this.revWet.connect(this.xfade);
      // flanger
      this.flDelay.delayTime.value = 0.005; this.flLfo.frequency.value = 0.25; this.flLfoG.gain.value = 0.003;
      this.flLfo.connect(this.flLfoG); this.flLfoG.connect(this.flDelay.delayTime);
      this.vol.connect(this.flDelay); this.flDelay.connect(this.flWet); this.flWet.connect(this.xfade);
      this.flDelay.connect(this.flFb); this.flFb.connect(this.flDelay); this.flLfo.start();
      // phaser
      this.phLfo.frequency.value = 0.5; this.phLfoG.gain.value = 700;
      let pn = this.vol; this.ph.forEach((ap) => { pn.connect(ap); this.phLfoG.connect(ap.frequency); pn = ap; });
      pn.connect(this.phWet); this.phWet.connect(this.xfade);
      this.phLfo.connect(this.phLfoG); this.phLfo.start();
      this.xfade.connect(master);
      this.stemGain = {}; STEMS.forEach((s) => { const g = ac.createGain(); g.connect(this.sum); this.stemGain[s] = g; });
      this.mainGain = ac.createGain(); this.mainGain.connect(this.sum);
    }

    async loadBuffer(arrayBuf, meta) {
      const buf = await ac.decodeAudioData(arrayBuf.slice(0));
      this.buffers = { main: buf }; this.isStems = false;
      this._applyMeta(buf, meta);
    }
    async loadStems(arrayBufs, meta) { // arrayBufs: {vocals:ArrayBuffer,...}
      const out = {};
      for (const s of STEMS) if (arrayBufs[s]) out[s] = await ac.decodeAudioData(arrayBufs[s].slice(0));
      this.buffers = out; this.isStems = true;
      const any = Object.values(out)[0];
      this._applyMeta(any, meta);
    }
    _applyMeta(buf, meta) {
      this.stop();
      this.duration = buf.duration;
      this.bpm = (meta && meta.bpm) || 0; this.baseBpm = this.bpm;
      this.camelot = (meta && meta.camelot) || ''; this.name = (meta && meta.name) || '';
      this._startPos = 0; this.tempo = 1; this.loop = null; this.cues = [null, null, null, null];
    }

    get position() {
      if (!this.buffers) return 0;
      let p = this._startPos;
      if (this.playing) p += (ac.currentTime - this._startCtx) * this.tempo;
      if (this.loop && p >= this.loop.end) {
        // loop: reposiciona
        const len = this.loop.end - this.loop.start;
        p = this.loop.start + ((p - this.loop.start) % len);
        this._startPos = p; this._startCtx = ac.currentTime;
        this._restart();
      }
      return Math.max(0, Math.min(this.duration, p));
    }

    _killSources() {
      this.sources.forEach((s) => { try { if (s._wk) { s.port.postMessage({ type: 'stop' }); s.disconnect(); } else { s.stop(); } } catch (_) {} });
      this.sources = [];
    }
    _spawn(offset) {
      this._killSources();
      const useWk = this.keylock && wkReady;
      const mk = (buf, gain) => {
        if (useWk) {
          const chs = []; for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c).slice());
          const node = new AudioWorkletNode(ac, 'timestretch', { numberOfInputs: 0, numberOfOutputs: 1,
            outputChannelCount: [buf.numberOfChannels],
            processorOptions: { channels: chs, startSample: Math.floor(Math.max(0, offset) * buf.sampleRate), playing: true } });
          node.parameters.get('tempo').value = this.tempo; node._wk = true; node.connect(gain); this.sources.push(node);
        } else {
          const src = ac.createBufferSource(); src.buffer = buf; src.playbackRate.value = this.tempo;
          src.connect(gain); src.start(0, Math.max(0, offset)); this.sources.push(src);
        }
      };
      if (this.isStems) STEMS.forEach((s) => { if (this.buffers[s]) mk(this.buffers[s], this.stemGain[s]); });
      else if (this.buffers.main) mk(this.buffers.main, this.mainGain);
    }
    _restart() {
      if (!this.playing) return;
      if (this.sources.length && this.sources[0]._wk) {
        const sr = (this.buffers.main || Object.values(this.buffers)[0]).sampleRate;
        const smp = Math.floor(this._startPos * sr);
        this.sources.forEach((s) => s.port.postMessage({ type: 'seek', sample: smp }));
      } else this._spawn(this._startPos);
    }

    play() {
      if (!this.buffers || this.playing) return;
      if (ac.state === 'suspended') ac.resume();
      this._startCtx = ac.currentTime; this.playing = true;
      this._spawn(this._startPos);
    }
    pause() { if (!this.playing) return; this._startPos = this.position; this.playing = false; this._killSources(); }
    stop() { this._killSources(); this.playing = false; this._startPos = 0; }
    seek(t) { const wasPlaying = this.playing; if (wasPlaying) this.pause(); this._startPos = Math.max(0, Math.min(this.duration, t)); if (wasPlaying) this.play(); }

    _rateParam(s) { return s._wk ? s.parameters.get('tempo') : s.playbackRate; }
    setTempo(rate) {
      const pos = this.position; this.tempo = rate;
      this._startPos = pos; this._startCtx = ac.currentTime;
      this.sources.forEach((s) => { this._rateParam(s).value = rate; });
    }
    setKeyLock(on) { this.keylock = on; if (this.playing) { const p = this.position; this._startPos = p; this._killSources(); this._startCtx = ac.currentTime; this._spawn(p); } }
    setVolume(v) { this.vol.gain.value = v; }
    setXfade(v) { this.xfade.gain.value = v; }
    setEq(band, db) { if (!this._eqUser) this._eqUser = { low: 0, mid: 0, high: 0 }; this._eqUser[band] = db; if (!this.eqKill[band]) this.setEqRaw(band, db); }
    setFilter(v) { // v: -1..1 (0 = off). <0 lowpass, >0 highpass
      if (Math.abs(v) < 0.02) { this.filter.type = 'lowpass'; this.filter.frequency.value = 22050; return; }
      if (v < 0) { this.filter.type = 'lowpass'; this.filter.frequency.value = 22050 * Math.pow(2, v * 9); }
      else { this.filter.type = 'highpass'; this.filter.frequency.value = 30 * Math.pow(2, v * 9); }
    }
    setStem(stem, on) { if (this.stemGain[stem]) this.stemGain[stem].gain.value = on ? 1 : 0; }
    setEcho(amt) { const beat = this.bpm ? 60 / this.bpm / 2 : 0.3; this.delay.delayTime.value = amt > 0 ? beat : 0; this.delayFb.gain.value = amt * 0.55; this.echoWet.gain.value = amt * 0.6; }
    setReverb(amt) { this.revWet.gain.value = amt * 0.75; }
    // FX unificado: echo|reverb|flanger|phaser (los demás a 0)
    setFx(type, amt) {
      this.setEcho(type === 'echo' ? amt : 0);
      this.revWet.gain.value = type === 'reverb' ? amt * 0.75 : 0;
      this.flWet.gain.value = type === 'flanger' ? amt : 0;
      this.flFb.gain.value = type === 'flanger' ? 0.45 : 0;
      this.phWet.gain.value = type === 'phaser' ? amt : 0;
    }
    setTrim(v) { this.trim.gain.value = v; }            // gain/trim (0..1.5)
    setEqRaw(band, db) { const n = band === 'low' ? this.eqLow : band === 'mid' ? this.eqMid : this.eqHigh; n.gain.value = db; }
    killEq(band) { this.eqKill[band] = this.eqKill[band] ? 0 : 1; this.setEqRaw(band, this.eqKill[band] ? -40 : (this._eqUser ? this._eqUser[band] : 0)); return this.eqKill[band]; }
    beatJump(beats) { if (!this.bpm) return; this.seek(this.position + beats * 60 / this.bpm); }
    pitchBend(factor) { this.sources.forEach((s) => { this._rateParam(s).value = this.tempo * factor; }); }  // momentáneo
    brake() {
      if (!this.playing) return; const t = ac.currentTime;
      this.sources.forEach((s) => { const p = this._rateParam(s); p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.linearRampToValueAtTime(0.001, t + 0.6); });
      this._startPos = this.position; setTimeout(() => { this.pause(); }, 640);
    }
    loopRoll(beats) { this.setLoop(beats); }
    endRoll() { this.clearLoop(); }
    nudge(sec) { this.seek(this.position + sec); }      // jog: empujar/rebobinar
    setCue(i) { this.cues[i] = this.position; }
    jumpCue(i) { if (this.cues[i] != null) this.seek(this.cues[i]); }
    clearCue(i) { this.cues[i] = null; }
    setLoop(beats) {
      if (!this.bpm) return;
      const start = this.position; const len = (60 / this.bpm) * beats;
      this.loop = { start, end: start + len };
    }
    clearLoop() { this.loop = null; }
    syncTo(otherBpm) { if (otherBpm && this.baseBpm) this.setTempo(otherBpm / this.baseBpm); }
  }

  const deckA = new Deck('A'), deckB = new Deck('B');
  const deckC = new Deck('C'), deckD = new Deck('D');   // decks extra: suenan a su volumen (fuera del crossfader A/B)

  // crossfader: t 0..1 (0=A, 1=B), curva equal-power
  function setCrossfader(t) {
    const a = Math.cos(t * Math.PI / 2), b = Math.cos((1 - t) * Math.PI / 2);
    deckA.setXfade(a); deckB.setXfade(b);
  }
  setCrossfader(0.5);

  function setMaster(v) { master.gain.value = v; }

  // medidor RMS (para verificación real de señal)
  const _buf = new Uint8Array(analyser.fftSize);
  function masterRMS() {
    analyser.getByteTimeDomainData(_buf);
    let s = 0; for (let i = 0; i < _buf.length; i++) { const v = (_buf[i] - 128) / 128; s += v * v; }
    return Math.sqrt(s / _buf.length);
  }
  // espectro (para el visualizador)
  const _fbuf = new Uint8Array(analyser.frequencyBinCount);
  function freq() { analyser.getByteFrequencyData(_fbuf); return _fbuf; }

  // micrófono (entrada en vivo -> master, entra en la grabación)
  let micStream = null, micNode = null, micGain = null;
  async function enableMic() {
    if (micNode) return true;
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    micNode = ac.createMediaStreamSource(micStream); micGain = ac.createGain(); micGain.gain.value = 1.0;
    micNode.connect(micGain); micGain.connect(master); if (ac.state === 'suspended') ac.resume(); return true;
  }
  function disableMic() {
    try { micNode && micNode.disconnect(); micGain && micGain.disconnect(); } catch (_) {}
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    micStream = micNode = micGain = null;
  }
  function micLevel(v) { if (micGain) micGain.gain.value = v; }

  // grabación
  let recorder = null, recChunks = [];
  function recStart() {
    recChunks = []; recorder = new MediaRecorder(recDest.stream);
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.start(); return true;
  }
  function recStop() {
    return new Promise((res) => {
      if (!recorder) return res(null);
      recorder.onstop = () => res(new Blob(recChunks, { type: 'audio/webm' }));
      recorder.stop(); recorder = null;
    });
  }

  // ----------------------------- SAMPLER / Sound FX -----------------------------
  const samplerGain = ac.createGain(); samplerGain.gain.value = 0.9; samplerGain.connect(master);

  async function synth(builder, dur) {
    const oac = new OfflineAudioContext(2, Math.ceil(ac.sampleRate * dur), ac.sampleRate);
    builder(oac, dur); return oac.startRendering();
  }
  const SAMP_DEFS = [
    ['Air Horn', (o, d) => { [0, 0.012, -0.012].forEach((det) => { const osc = o.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 196 * (1 + det); const g = o.createGain(); g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.22, 0.05); g.gain.setValueAtTime(0.22, d - 0.12); g.gain.linearRampToValueAtTime(0, d); osc.connect(g); g.connect(o.destination); osc.start(); osc.stop(d); }); }, 1.3],
    ['Sirena', (o, d) => { const osc = o.createOscillator(); osc.type = 'sawtooth'; const f = osc.frequency; f.setValueAtTime(600, 0); for (let t = 0; t < d; t += 0.4) { f.linearRampToValueAtTime(1200, t + 0.2); f.linearRampToValueAtTime(600, t + 0.4); } const g = o.createGain(); g.gain.value = 0.16; osc.connect(g); g.connect(o.destination); osc.start(); osc.stop(d); }, 1.6],
    ['Stab', (o, d) => { const osc = o.createOscillator(); osc.type = 'square'; osc.frequency.value = 880; const g = o.createGain(); g.gain.setValueAtTime(0.3, 0); g.gain.exponentialRampToValueAtTime(0.001, d); osc.connect(g); g.connect(o.destination); osc.start(); osc.stop(d); }, 0.28],
    ['Laser', (o, d) => { const osc = o.createOscillator(); osc.type = 'sawtooth'; osc.frequency.setValueAtTime(2200, 0); osc.frequency.exponentialRampToValueAtTime(120, d); const g = o.createGain(); g.gain.setValueAtTime(0.22, 0); g.gain.linearRampToValueAtTime(0, d); osc.connect(g); g.connect(o.destination); osc.start(); osc.stop(d); }, 0.5],
    ['Riser', (o, d) => { const n = o.createBufferSource(); const b = o.createBuffer(1, o.sampleRate * d, o.sampleRate); const dt = b.getChannelData(0); for (let i = 0; i < dt.length; i++) dt[i] = Math.random() * 2 - 1; n.buffer = b; const f = o.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 6; f.frequency.setValueAtTime(300, 0); f.frequency.exponentialRampToValueAtTime(6000, d); const g = o.createGain(); g.gain.setValueAtTime(0.05, 0); g.gain.linearRampToValueAtTime(0.3, d); n.connect(f); f.connect(g); g.connect(o.destination); n.start(); n.stop(d); }, 1.2],
    ['Clap', (o, d) => { const n = o.createBufferSource(); const b = o.createBuffer(1, o.sampleRate * d, o.sampleRate); const dt = b.getChannelData(0); for (let i = 0; i < dt.length; i++) dt[i] = Math.random() * 2 - 1; n.buffer = b; const f = o.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1500; const g = o.createGain(); g.gain.setValueAtTime(0.4, 0); g.gain.exponentialRampToValueAtTime(0.001, d); n.connect(f); f.connect(g); g.connect(o.destination); n.start(); n.stop(d); }, 0.18],
  ];
  const sampler = {
    slots: new Array(8).fill(null),
    activeSrc: new Array(8).fill(null),
    async init() { for (let i = 0; i < SAMP_DEFS.length; i++) { try { const buf = await synth(SAMP_DEFS[i][1], SAMP_DEFS[i][2]); this.slots[i] = { buffer: buf, name: SAMP_DEFS[i][0] }; } catch (_) {} } },
    async loadFile(i, arrayBuf, name) { const b = await ac.decodeAudioData(arrayBuf.slice(0)); this.slots[i] = { buffer: b, name: name || ('Pad ' + (i + 1)) }; },
    trigger(i) { const s = this.slots[i]; if (!s) return false; if (ac.state === 'suspended') ac.resume(); try { this.activeSrc[i] && this.activeSrc[i].stop(); } catch (_) {} const src = ac.createBufferSource(); src.buffer = s.buffer; src.connect(samplerGain); src.start(); this.activeSrc[i] = src; return true; },
    stop(i) { try { this.activeSrc[i] && this.activeSrc[i].stop(); } catch (_) {} },
    name(i) { return this.slots[i] ? this.slots[i].name : ''; },
  };
  sampler.ready = sampler.init();

  return { ac, deckA, deckB, deckC, deckD, setCrossfader, setMaster, masterRMS, freq, recStart, recStop, STEMS, sampler,
    enableMic, disableMic, micLevel, resume: () => ac.resume() };
})();
