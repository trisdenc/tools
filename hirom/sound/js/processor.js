// AudioWorklet processor. At load time the page joins dsp.js + engine.js + this
// file into one script (so it works in browsers without module imports in worklets).
/* global Engine, sampleRate, registerProcessor, AudioWorkletProcessor */

class SnesProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new Engine();
    this.ratio = 32000 / sampleRate; // DSP samples per output sample
    this.frac = 0;
    // Last four DSP samples per side for Hermite interpolation
    this.l = new Float32Array(4);
    this.r = new Float32Array(4);
    this.meterEvery = Math.round(sampleRate / 30);
    this.meterCount = 0;
    this.port.onmessage = e => this.engine.handle(e.data);
  }

  pull() {
    const e = this.engine, d = e.dsp;
    e.step();
    const l = this.l, r = this.r;
    l[0] = l[1]; l[1] = l[2]; l[2] = l[3]; l[3] = d.outL / 32768;
    r[0] = r[1]; r[1] = r[2]; r[2] = r[3]; r[3] = d.outR / 32768;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const l = this.l, r = this.r;
    for (let i = 0; i < L.length; i++) {
      while (this.frac >= 1) { this.frac -= 1; this.pull(); }
      const t = this.frac;
      L[i] = hermite(l[0], l[1], l[2], l[3], t);
      R[i] = hermite(r[0], r[1], r[2], r[3], t);
      this.frac += this.ratio;
    }
    if ((this.meterCount += L.length) >= this.meterEvery) {
      this.meterCount = 0;
      this.port.postMessage(this.engine.meters());
    }
    return true;
  }
}

function hermite(xm1, x0, x1, x2, t) {
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + x0;
}

registerProcessor("hirom-sound-dsp", SnesProcessor);
