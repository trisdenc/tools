// BRR (Bit Rate Reduction) encoder and sample preparation.
// Pure functions, no DOM: used by the UI and the tests.

import { decodeBrrStream, DSP_RATE } from "./dsp.js";

const clamp16 = x => (x > 32767 ? 32767 : x < -32768 ? -32768 : x);

// Exact decoder prediction for one sample (the additive part from the IIR filter).
function predict(filter, p1, p2raw) {
  const p2 = p2raw >> 1;
  switch (filter) {
    case 1: return (p1 >> 1) + ((-p1) >> 5);
    case 2: return p1 - p2 + (p2 >> 4) + ((p1 * -3) >> 6);
    case 3: return p1 - p2 + ((p1 * -13) >> 7) + ((p2 * 3) >> 4);
    default: return 0;
  }
}

const decodeOne = (nib, shift, pred) => {
  let s = ((nib << shift) >> 1) + pred;
  s = clamp16(s);
  return ((s * 2) << 16) >> 16;
};

/**
 * Encode 16-bit PCM into BRR. pcm.length must be a multiple of 16.
 * Tries every filter/shift pair per block against the exact hardware decoder and
 * keeps the one with the least squared error. The first block and the loop-start
 * block always use filter 0 so playback starts cleanly and loops seamlessly.
 * Non-looping samples get a trailing silent END block (the S-DSP silences a voice
 * as soon as it reaches a block with END set and LOOP clear).
 */
export function encodeBrr(pcm, { loop = false, loopStart = 0 } = {}) {
  if (pcm.length % 16) throw new Error("BRR input length must be a multiple of 16");
  const blocks = Math.max(1, pcm.length / 16);
  const loopBlock = loop ? Math.min(blocks - 1, Math.floor(loopStart / 16)) : 0;
  const total = blocks + (loop ? 0 : 1);
  const out = new Uint8Array(total * 9);
  const nibs = new Int8Array(16), bestNibs = new Int8Array(16);
  let p1 = 0, p2 = 0;

  for (let b = 0; b < blocks; b++) {
    const base = b * 16;
    const forceRaw = b === 0 || (loop && b === loopBlock);
    let bestErr = Infinity, bestShift = 0, bestFilter = 0, bestP1 = 0, bestP2 = 0;

    for (let filter = 0; filter < (forceRaw ? 1 : 4); filter++) {
      for (let shift = 0; shift <= 12; shift++) {
        let a = p1, c = p2, err = 0;
        for (let k = 0; k < 16 && err < bestErr; k++) {
          const x = pcm[base + k] || 0;
          const pred = predict(filter, a, c);
          let n = Math.round(((x / 2 - pred) * 2) / (1 << shift));
          n = n > 7 ? 7 : n < -8 ? -8 : n;
          let best = n, bestD = decodeOne(n, shift, pred), bestE = Math.abs(bestD - x);
          for (const m of [n - 1, n + 1]) {
            if (m < -8 || m > 7) continue;
            const d = decodeOne(m, shift, pred), e = Math.abs(d - x);
            if (e < bestE) { best = m; bestD = d; bestE = e; }
          }
          nibs[k] = best;
          err += bestE * bestE;
          c = a; a = bestD;
        }
        if (err < bestErr) {
          bestErr = err; bestShift = shift; bestFilter = filter; bestP1 = a; bestP2 = c;
          bestNibs.set(nibs);
        }
      }
    }

    const isLast = b === blocks - 1;
    let header = (bestShift << 4) | (bestFilter << 2);
    if (loop) header |= 2;
    if (loop && isLast) header |= 1;
    const o = b * 9;
    out[o] = header;
    for (let k = 0; k < 8; k++) out[o + 1 + k] = ((bestNibs[k * 2] & 0xF) << 4) | (bestNibs[k * 2 + 1] & 0xF);
    p1 = bestP1; p2 = bestP2;
  }
  if (!loop) out[blocks * 9] = 0x01; // silent END block
  return { data: out, loopBlock, blocks: total };
}

export function snrDb(reference, decoded) {
  let sig = 0, noise = 0;
  const n = Math.min(reference.length, decoded.length);
  for (let i = 0; i < n; i++) {
    sig += reference[i] * reference[i];
    const d = reference[i] - decoded[i];
    noise += d * d;
  }
  if (noise === 0) return Infinity;
  return 10 * Math.log10(sig / noise);
}

// ---------- Resampling ----------

// Windowed-sinc resampler. get(i) returns the source sample at integer index i.
// Output k is taken at source position t0 + k * step. Anti-aliased when downsampling.
export function sincResample(get, t0, step, count) {
  const cutoff = Math.min(1, 1 / step) * 0.97;
  const half = Math.ceil(12 / cutoff);
  const out = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const t = t0 + k * step;
    const c = Math.floor(t);
    let acc = 0, wsum = 0;
    for (let j = c - half + 1; j <= c + half; j++) {
      const x = t - j;
      const u = x / half;
      if (u <= -1 || u >= 1) continue;
      const win = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u); // Blackman
      const a = Math.PI * cutoff * x;
      const sinc = x === 0 ? 1 : Math.sin(a) / a;
      const w = cutoff * sinc * win;
      acc += get(j) * w;
      wsum += w;
    }
    out[k] = wsum ? acc / wsum : 0;
  }
  return out;
}

// ---------- Sample preparation ----------

export const DEFAULT_PARAMS = {
  trimStart: 0, trimEnd: null, loop: false, loopStart: 0, loopEnd: null,
  targetRate: 16000, normalize: true, gainDb: 0,
};

/**
 * Turn a source recording into BRR-ready PCM.
 * source: { rate, data: Float32Array (mono, -1..1) }
 * Returns { pcm: Int16Array, loop, loopStart, rate } where rate is the exact playback
 * rate of the result. If a loop is set, the whole sample is resampled by a tiny
 * extra amount so the loop length lands on a multiple of 16 samples, and silence is
 * added at the start so the loop begins on a block boundary. The pitch error this
 * would cause is cancelled by reporting the adjusted rate.
 */
export function prepareSample(source, params) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const src = source.data, len = src.length;
  const ts = Math.max(0, Math.min(len - 1, Math.round(p.trimStart || 0)));
  const te = Math.max(ts + 1, Math.min(len, Math.round(p.trimEnd ?? len)));
  const target = Math.max(1000, Math.min(DSP_RATE, p.targetRate || DSP_RATE));
  const step0 = source.rate / target;

  let get, t0, step, count, loopStart = 0, loop = false;
  if (p.loop) {
    const ls = Math.max(ts, Math.min(te - 1, Math.round(p.loopStart ?? ts)));
    const le = Math.max(ls + 1, Math.min(te, Math.round(p.loopEnd ?? te)));
    const loopLen = le - ls;
    const l16 = Math.max(16, Math.round(loopLen / step0 / 16) * 16);
    step = loopLen / l16;
    const pre = Math.ceil((ls - ts) / step / 16) * 16;
    t0 = ls - pre * step;
    count = pre + l16;
    loopStart = pre;
    loop = true;
    get = i => (i < ts ? 0 : i >= le ? src[ls + ((i - ls) % loopLen)] : src[i]);
  } else {
    step = step0;
    count = Math.max(16, Math.ceil((te - ts) / step / 16) * 16);
    t0 = ts;
    get = i => (i >= ts && i < te ? src[i] : 0);
  }

  const f = sincResample(get, t0, step, count);
  let gain = Math.pow(10, (p.gainDb || 0) / 20);
  if (p.normalize) {
    let peak = 0;
    for (let i = 0; i < f.length; i++) peak = Math.max(peak, Math.abs(f[i]));
    if (peak > 0) gain *= 0.95 / peak;
  }
  const pcm = new Int16Array(count);
  for (let i = 0; i < count; i++) pcm[i] = clamp16(Math.round(f[i] * gain * 32767));
  return { pcm, loop, loopStart, rate: source.rate / step };
}

// Full pipeline: source + params -> encoded sample data.
export function buildSample(source, params) {
  const prep = prepareSample(source, params);
  const enc = encodeBrr(prep.pcm, { loop: prep.loop, loopStart: prep.loopStart });
  const decoded = decodeBrrStream(enc.data).subarray(0, prep.pcm.length);
  return {
    brr: enc.data,
    loop: prep.loop,
    loopBlock: enc.loopBlock,
    rate: prep.rate,
    pcm: prep.pcm,
    decoded,
    snr: snrDb(prep.pcm, decoded),
  };
}

// Raw .brr file: either plain blocks, or blocks preceded by a 2-byte loop offset.
export function parseBrrFile(bytes) {
  let data = bytes, loopBlock = 0;
  if (bytes.length % 9 === 2) {
    const off = bytes[0] | (bytes[1] << 8);
    data = bytes.slice(2);
    loopBlock = Math.floor(off / 9);
  } else if (bytes.length % 9 !== 0) {
    throw new Error("This doesn't look like a BRR file (size isn't a multiple of 9 bytes).");
  } else {
    data = bytes.slice();
  }
  const blocks = data.length / 9;
  if (!blocks) throw new Error("This BRR file is empty.");
  const lastHeader = data[(blocks - 1) * 9];
  const loop = (lastHeader & 2) !== 0;
  if (!(lastHeader & 1)) data[(blocks - 1) * 9] |= 1; // make sure it ends
  if (loopBlock >= blocks) loopBlock = 0;
  return { brr: data, loop, loopBlock };
}

// Pitch register value to play `note` on a sample recorded at `rate` with root `baseNote`.
export function pitchFor(note, sample) {
  const semis = note - sample.baseNote + (sample.fineTune || 0) / 100;
  const p = Math.round(4096 * (sample.rate / DSP_RATE) * Math.pow(2, semis / 12));
  return p < 0 ? 0 : p > 0x3FFF ? 0x3FFF : p;
}

// Simple autocorrelation pitch detection. Returns MIDI note (float) or null.
export function detectPitch(data, rate) {
  const n = Math.min(data.length, Math.round(rate * 0.25));
  const start = Math.min(Math.round(rate * 0.05), Math.max(0, data.length - n));
  const minLag = Math.floor(rate / 2000), maxLag = Math.floor(rate / 40);
  let bestLag = 0, best = 0;
  let e0 = 0;
  for (let i = 0; i < n - maxLag; i++) e0 += data[start + i] * data[start + i];
  if (e0 < 1e-6) return null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < n - maxLag; i++) s += data[start + i] * data[start + i + lag];
    const r = s / e0;
    if (r > best) { best = r; bestLag = lag; }
  }
  if (best < 0.6 || !bestLag) return null;
  return 69 + 12 * Math.log2(rate / bestLag / 440);
}
