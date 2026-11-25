// Main-thread side of the audio engine: AudioWorklet setup, messaging,
// offline rendering for export, and WAV writing.

import { Engine } from "./engine.js";
import { DSP_RATE } from "./dsp.js";

async function buildWorkletUrl() {
  const parts = await Promise.all(["dsp.js", "engine.js", "processor.js"].map(f =>
    fetch(new URL(f, import.meta.url)).then(r => { if (!r.ok) throw new Error(`Couldn't load ${f}`); return r.text(); })));
  const code = parts
    .map(src => src
      .replace(/^import .*?;\s*$/gm, "")
      .replace(/^export \{[^}]*\};?\s*$/gm, "")
      .replace(/^export (default )?/gm, ""))
    .join("\n;\n");
  return URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
}

export class Audio {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.ready = false;
    this.starting = null;
    this.queue = [];
    this.onMeters = null;
    this.rawSource = null;
    this.lastSong = null;
    this.samples = new Map(); // latest engine-sample objects, re-sent on start
  }

  start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: "interactive" });
      if (this.ctx.state === "suspended") await this.ctx.resume();
      const url = await buildWorkletUrl();
      await this.ctx.audioWorklet.addModule(url);
      this.node = new AudioWorkletNode(this.ctx, "snes-dsp", { numberOfInputs: 0, outputChannelCount: [2] });
      this.node.connect(this.ctx.destination);
      this.node.port.onmessage = e => { if (e.data.type === "meters" && this.onMeters) this.onMeters(e.data); };
      this.ready = true;
      for (const [id, s] of this.samples) this.node.port.postMessage({ type: "sample", id, sample: s });
      if (this.lastSong) this.node.port.postMessage({ type: "song", song: this.lastSong });
      for (const m of this.queue) this.node.port.postMessage(m);
      this.queue = [];
    })();
    this.starting.catch(() => { this.starting = null; });
    return this.starting;
  }

  resume() { if (this.ctx && this.ctx.state !== "running") this.ctx.resume(); }

  get latencyMs() {
    if (!this.ctx) return null;
    return Math.round(((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000);
  }

  post(msg) {
    if (this.ready) this.node.port.postMessage(msg);
    else if (msg.type !== "noteOn" && msg.type !== "noteOff") this.queue.push(msg);
  }

  setSong(song) {
    this.lastSong = song;
    if (this.ready) this.node.port.postMessage({ type: "song", song });
  }

  setSample(id, sample) {
    if (!sample) return this.removeSample(id);
    this.samples.set(id, sample);
    if (this.ready) this.node.port.postMessage({ type: "sample", id, sample });
  }

  removeSample(id) {
    this.samples.delete(id);
    if (this.ready) this.node.port.postMessage({ type: "removeSample", id });
  }

  play(opts) { this.stopRaw(); this.post({ type: "play", ...opts }); }
  stop() { this.post({ type: "stop" }); }
  panic() { this.stopRaw(); this.post({ type: "panic" }); }
  noteOn(key, instId, note) { this.post({ type: "noteOn", key, instId, note }); }
  noteOff(key) { this.post({ type: "noteOff", key }); }
  sfx(id) { this.post({ type: "sfx", id }); }

  // Play raw PCM (the "A" side of A/B audition), bypassing the S-DSP.
  playRaw(data, rate, { loopStart = null, loopEnd = null } = {}) {
    if (!this.ctx) return;
    this.stopRaw();
    const buf = this.ctx.createBuffer(1, data.length, rate);
    buf.copyToChannel(data instanceof Float32Array ? data : Float32Array.from(data), 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    if (loopStart != null) {
      src.loop = true;
      src.loopStart = loopStart / rate;
      src.loopEnd = (loopEnd ?? data.length) / rate;
    }
    const g = this.ctx.createGain();
    g.gain.value = 0.8;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    this.rawSource = src;
    src.onended = () => { if (this.rawSource === src) this.rawSource = null; };
  }

  stopRaw() {
    if (this.rawSource) { try { this.rawSource.stop(); } catch {} this.rawSource = null; }
  }
}

// ---------- Offline rendering ----------

function makeEngine(song, samples, { soloChannel = null } = {}) {
  const e = new Engine();
  for (const [id, s] of samples) e.setSample(id, s);
  if (soloChannel != null) {
    song = { ...song, mixer: { channels: song.mixer.channels.map((c, i) => ({ ...c, solo: i === soloChannel, mute: false })) } };
  }
  e.setSong(song);
  return e;
}

const yieldToUi = () => new Promise(r => setTimeout(r, 0));

function grow(arr, need) {
  if (need <= arr.length) return arr;
  const n = new Int16Array(Math.max(need, arr.length * 2));
  n.set(arr);
  return n;
}

// Render until `done(engine)` is true, then keep going until silent (tail).
async function renderUntil(e, done, { maxSeconds = 600, tail = true, onProgress } = {}) {
  const CH = 4096;
  let L = new Int16Array(DSP_RATE * 10), R = new Int16Array(DSP_RATE * 10), n = 0;
  let marks = {};
  const maxN = DSP_RATE * maxSeconds;
  while (n < maxN) {
    L = grow(L, n + CH); R = grow(R, n + CH);
    for (let i = 0; i < CH; i++) {
      e.render(L, R, 1, n);
      n++;
      const d = done(e, n, marks);
      if (d) { marks.end = n; break; }
    }
    if (marks.end) break;
    if ((n & 0x3FFFF) < CH) { onProgress?.(n / DSP_RATE); await yieldToUi(); }
  }
  if (tail) {
    e.stopAll(true);
    let quiet = 0, extra = 0;
    while (quiet < DSP_RATE / 4 && extra < DSP_RATE * 8) {
      L = grow(L, n + 1); R = grow(R, n + 1);
      e.render(L, R, 1, n);
      // The echo's floor rounding leaves a tiny DC offset (as on real hardware), so
      // treat anything below about -60 dBFS as silence.
      quiet = Math.abs(L[n]) < 32 && Math.abs(R[n]) < 32 ? quiet + 1 : 0;
      n++; extra++;
    }
    n -= Math.max(0, quiet - 32);
  }
  return { L: L.subarray(0, n), R: R.subarray(0, n), marks, length: n };
}

/**
 * Render the song for export.
 * loop: true -> intro + one loop pass taken from the second time through (so echo
 *               and release tails wrap around seamlessly); loop points in samples.
 * loop: false -> one pass plus the decay tail.
 */
export async function renderSong(song, samples, { loop = true, soloChannel = null, onProgress } = {}) {
  const e = makeEngine(song, samples, { soloChannel });
  e.play({ mode: "song", loop: true });
  if (!e.music.playing) throw new Error("The arrangement is empty.");
  const loopOrder = e.music.loopOrder;
  let introEnd = loopOrder === 0 ? 0 : null;
  const res = await renderUntil(e, (eng, n, marks) => {
    if (introEnd === null && eng.music.order === loopOrder && eng.music.passes === 0) introEnd = n - 1;
    if (eng.music.passes === 1 && marks.wrap1 == null) marks.wrap1 = n - 1;
    if (!loop) return eng.music.passes >= 1;
    return eng.music.passes >= 2;
  }, { tail: !loop, onProgress });
  if (!loop) {
    return { L: res.L, R: res.R, loopStart: null, loopEnd: null };
  }
  const intro = introEnd || 0, w1 = res.marks.wrap1, w2 = res.marks.end - 1;
  const bodyLen = w2 - w1;
  const total = intro + bodyLen;
  const L = new Int16Array(total), R = new Int16Array(total);
  L.set(res.L.subarray(0, intro)); R.set(res.R.subarray(0, intro));
  L.set(res.L.subarray(w1, w2), intro); R.set(res.R.subarray(w1, w2), intro);
  return { L, R, loopStart: intro, loopEnd: total - 1 };
}

export async function renderPattern(song, samples, patternId) {
  const e = makeEngine(song, samples);
  e.music.start([patternId], { loop: false });
  return renderUntil(e, eng => !eng.music.playing);
}

export async function renderSfx(song, samples, sfxId) {
  const e = makeEngine(song, samples);
  e.playSfx(sfxId);
  if (!e.sfx) throw new Error("This SFX has no pattern.");
  return renderUntil(e, eng => !eng.sfx);
}

// ---------- WAV ----------

export function resampleInt16(src, fromRate, toRate) {
  if (fromRate === toRate) return src;
  const ratio = fromRate / toRate;
  const n = Math.floor(src.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * ratio, k = Math.floor(t), f = t - k;
    const xm1 = src[k - 1] || 0, x0 = src[k] || 0, x1 = src[k + 1] || 0, x2 = src[k + 2] || 0;
    const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    const y = ((c3 * f + c2) * f + c1) * f + x0;
    out[i] = y > 32767 ? 32767 : y < -32768 ? -32768 : Math.round(y);
  }
  return out;
}

// 16-bit stereo WAV with an optional `smpl` loop chunk (read by Unity, Godot, FMOD, Wwise…).
export function wavBlob(L, R, rate, loop = null) {
  const frames = L.length, dataBytes = frames * 4;
  const smplBytes = loop ? 8 + 36 + 24 : 0;
  const buf = new ArrayBuffer(44 + dataBytes + smplBytes);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + dataBytes + smplBytes, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < frames; i++, o += 4) { v.setInt16(o, L[i], true); v.setInt16(o + 2, R[i], true); }
  if (loop) {
    w(o, "smpl"); v.setUint32(o + 4, 36 + 24, true);
    const b = o + 8;
    v.setUint32(b + 0, 0, true);                         // manufacturer
    v.setUint32(b + 4, 0, true);                         // product
    v.setUint32(b + 8, Math.round(1e9 / rate), true);    // sample period (ns)
    v.setUint32(b + 12, 60, true);                       // MIDI unity note
    v.setUint32(b + 16, 0, true);                        // pitch fraction
    v.setUint32(b + 20, 0, true); v.setUint32(b + 24, 0, true); // SMPTE
    v.setUint32(b + 28, 1, true);                        // loop count
    v.setUint32(b + 32, 0, true);                        // sampler data
    v.setUint32(b + 36, 0, true);                        // cue point id
    v.setUint32(b + 40, 0, true);                        // type: forward
    v.setUint32(b + 44, loop.start, true);
    v.setUint32(b + 48, loop.end, true);
    v.setUint32(b + 52, 0, true);                        // fraction
    v.setUint32(b + 56, 0, true);                        // play count: infinite
  }
  return new Blob([buf], { type: "audio/wav" });
}

// Convert a rendered result to a WAV at the chosen output rate.
export function toWav(res, rate = DSP_RATE) {
  let { L, R } = res;
  let loop = res.loopStart != null ? { start: res.loopStart, end: res.loopEnd } : null;
  if (rate !== DSP_RATE) {
    L = resampleInt16(L, DSP_RATE, rate);
    R = resampleInt16(R, DSP_RATE, rate);
    if (loop) {
      loop = { start: Math.round(loop.start * rate / DSP_RATE), end: L.length - 1 };
    }
  }
  return wavBlob(L, R, rate, loop);
}
