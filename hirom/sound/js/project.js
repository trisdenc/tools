// Project data model: defaults, starter library, demo song, ARAM budget, import/export.
// Pure module (no DOM) so the tests can use it.

import { DEFAULT_PARAMS } from "./brr.js";

export const APP = { name: "HiROM Sound", suite: "HiROM Studio", version: "1.0.0" };
export const SCHEMA_VERSION = "1.0.0";
export const ARAM_LIMIT = 65536;
export const DRIVER_BYTES = 4096;
export const CHANNELS = 8;

export const FX_TYPES = [
  { id: "PORTA_UP", code: "1", name: "Pitch slide up", help: "Value = speed. 16 = 1 semitone per tick." },
  { id: "PORTA_DOWN", code: "2", name: "Pitch slide down", help: "Value = speed. 16 = 1 semitone per tick." },
  { id: "TONE_PORTA", code: "3", name: "Portamento to note", help: "Glides to this row's note without retriggering. Value = speed (16 = 1 semitone per tick)." },
  { id: "VIBRATO", code: "4", name: "Vibrato", help: "Value 0xSD: S = speed (1–F), D = depth in 1/8 semitones (1–F)." },
  { id: "PAN", code: "8", name: "Panning", help: "0 = left, 64 = center, 127 = right." },
  { id: "ECHO", code: "E", name: "Echo on/off", help: "1 = send this channel to echo, 0 = dry." },
  { id: "PMOD", code: "M", name: "Pitch mod on/off", help: "1 = previous channel's output modulates this channel's pitch." },
  { id: "NOISE_FREQ", code: "N", name: "Noise frequency", help: "Sets the global noise clock, 0–31 (0 = off, 31 = 32 kHz)." },
];
export const FX_BY_ID = Object.fromEntries(FX_TYPES.map(f => [f.id, f]));
export const FX_BY_CODE = Object.fromEntries(FX_TYPES.map(f => [f.code, f]));

export const NOISE_RATES_HZ = [0, 16, 21, 25, 31, 42, 50, 63, 83, 100, 125, 167, 200, 250, 333, 400,
  500, 667, 800, 1000, 1300, 1600, 2000, 2700, 3200, 4000, 5300, 6400, 8000, 10700, 16000, 32000];

export const FIR_PRESETS = [
  { name: "Flat", fir: [127, 0, 0, 0, 0, 0, 0, 0] },
  { name: "Soft low-pass (classic)", fir: [12, 33, 43, 43, 19, -2, -13, -7] },
  { name: "Low-pass cavern", fir: [24, 24, 20, 16, 16, 12, 8, 8] },
  { name: "High-pass metallic", fir: [-9, -9, -9, -9, -9, -9, -9, 63] },
  { name: "Band-pass", fir: [-12, -12, 12, 24, 24, 12, -12, -12] },
];

const NOTE_NAMES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
export const noteName = n => (typeof n === "number" ? NOTE_NAMES[n % 12] + Math.floor(n / 12 - 1) : n === "OFF" ? "===" : "---");
export const notePretty = n => (typeof n === "number" ? NOTE_NAMES[n % 12].replace("-", "") + Math.floor(n / 12 - 1) : n === "OFF" ? "Off" : "—");

let idCounter = 0;
export const newId = prefix => `${prefix}_${Date.now().toString(36)}${(idCounter++).toString(36)}`;

// ---------- Starter sound library (generated, royalty free) ----------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 * 2 - 1;
  };
}

// Additive synthesis of a perfectly periodic loop: `cycles` periods in `len` samples.
function additive(len, cycles, amp, maxHarm) {
  const out = new Float32Array(len);
  for (let h = 1; h <= maxHarm; h++) {
    const a = amp(h);
    if (!a) continue;
    const w = (2 * Math.PI * cycles * h) / len;
    for (let i = 0; i < len; i++) out[i] += a * Math.sin(w * i);
  }
  return out;
}

function tuneFromFreq(freq) {
  const exact = 69 + 12 * Math.log2(freq / 440);
  const baseNote = Math.round(exact);
  return { baseNote, fineTune: -Math.round((exact - baseNote) * 100) };
}

const loopWhole = (data, rate, extra = {}) => ({
  source: { rate, data },
  params: { ...DEFAULT_PARAMS, loop: true, loopStart: 0, loopEnd: data.length, targetRate: rate, ...extra },
});
const oneShot = (data, rate) => ({
  source: { rate, data },
  params: { ...DEFAULT_PARAMS, loop: false, targetRate: rate },
});

export function starterSamples() {
  const list = [];
  const add = (id, name, def, tune) => list.push({ id, name, ...def, ...tune });

  // Single-cycle waves at 32 kHz (32 samples = 1000 Hz, 64 samples = 500 Hz)
  add("smp_square", "Square", loopWhole(additive(32, 1, h => (h % 2 ? 1 / h : 0), 15), 32000), tuneFromFreq(1000));
  add("smp_pulse", "Pulse 25%", loopWhole(additive(32, 1, h => Math.sin((Math.PI * h) / 4) / h, 15), 32000), tuneFromFreq(1000));
  add("smp_saw", "Saw", loopWhole(additive(64, 1, h => 1 / h, 24), 32000), tuneFromFreq(500));
  add("smp_tri", "Triangle", loopWhole(additive(32, 1, h => (h % 2 ? ((h - 1) / 2 % 2 ? -1 : 1) / (h * h) : 0), 15), 32000), tuneFromFreq(1000));
  add("smp_sine", "Sine", loopWhole(additive(32, 1, h => (h === 1 ? 1 : 0), 1), 32000), tuneFromFreq(1000));
  add("smp_ep", "EP Bell", loopWhole((() => {
    const n = 64, out = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = (2 * Math.PI * i) / n; out[i] = Math.sin(t + 1.4 * Math.sin(t) + 0.35 * Math.sin(3 * t)); }
    return out;
  })(), 32000), tuneFromFreq(500));

  // Strings: three detuned band-limited saws, 4096-sample seamless loop at 16 kHz
  add("smp_strings", "Strings", loopWhole((() => {
    const len = 4096, out = new Float32Array(len);
    for (const k of [66, 67, 68]) {
      const f0 = (k * 16000) / len;
      const part = additive(len, k, h => (h * f0 < 6500 ? (1 / h) / (1 + Math.pow((h * f0) / 2200, 2)) : 0), 40);
      for (let i = 0; i < len; i++) out[i] += part[i];
    }
    return out;
  })(), 16000), tuneFromFreq((67 * 16000) / 4096));

  // Brass: bright saw with a formant bump, 17 cycles in 1024 samples at 16 kHz
  add("smp_brass", "Brass", loopWhole(additive(1024, 17, h => {
    const f = h * 265.625;
    return f < 7000 ? (1 / h) * (1 + 1.5 * Math.exp(-Math.pow((f - 1300) / 700, 2))) : 0;
  }, 26), 16000), tuneFromFreq(265.625));

  // Slap bass: Karplus–Strong pluck at 16 kHz, period 128 (125 Hz), then a one-period loop
  add("smp_bass", "Slap Bass", (() => {
    const rate = 16000, P = 128, pre = 3072, r = rng(7);
    const buf = new Float32Array(P);
    for (let i = 0; i < P; i++) buf[i] = r() * (i < P / 2 ? 1 : 0.6);
    const out = new Float32Array(pre + P);
    let idx = 0;
    for (let i = 0; i < pre + P; i++) {
      const next = (idx + 1) % P;
      if (i < pre) buf[idx] = 0.5 * (buf[idx] + buf[next]) * 0.998;
      out[i] = buf[idx] + (i < 40 ? r() * 0.5 * (1 - i / 40) : 0);
      idx = next;
    }
    // Loop region must repeat exactly: copy the final period over itself unchanged
    for (let i = 0; i < P; i++) out[pre + i] = out[pre - P + i];
    return { source: { rate, data: out }, params: { ...DEFAULT_PARAMS, loop: true, loopStart: pre, loopEnd: pre + P, targetRate: rate } };
  })(), tuneFromFreq(125));

  // Drums: one-shots
  add("smp_kick", "Kick", oneShot((() => {
    const rate = 12000, n = Math.round(rate * 0.25), out = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const f = 45 + 110 * Math.exp(-t * 28);
      ph += (2 * Math.PI * f) / rate;
      out[i] = Math.sin(ph) * Math.exp(-t * 11) * (i < 24 ? i / 24 : 1);
    }
    return out;
  })(), 12000), { baseNote: 60, fineTune: 0 });

  add("smp_snare", "Snare", oneShot((() => {
    const rate = 16000, n = Math.round(rate * 0.2), out = new Float32Array(n), r = rng(3);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      lp += 0.55 * (r() - lp);
      const noise = (r() - lp) * Math.exp(-t * 18);
      const tone = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 30);
      out[i] = 0.75 * noise + 0.6 * tone;
    }
    return out;
  })(), 16000), { baseNote: 60, fineTune: 0 });

  add("smp_orch", "Orchestra Hit", oneShot((() => {
    const rate = 12000, n = Math.round(rate * 0.38), out = new Float32Array(n), r = rng(11);
    const freqs = [130.81, 196.0, 261.63, 329.63, 392.0, 523.25];
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      let s = 0;
      for (const f of freqs) {
        for (let h = 1; h * f < 5000; h++) s += Math.sin(2 * Math.PI * f * h * t * (1 + 0.002 * h)) / h;
      }
      const env = Math.exp(-t * 7) * (i < 30 ? i / 30 : 1);
      out[i] = (s / 6) * env + r() * 0.35 * Math.exp(-t * 40);
    }
    return out;
  })(), 12000), tuneFromFreq(261.63));

  return list;
}

function inst(id, name, sampleId, adsr, extra = {}) {
  return {
    id, name, sampleId,
    envMode: adsr ? "ADSR" : "GAIN",
    adsr: adsr ? { attack: adsr[0], decay: adsr[1], sustainLevel: adsr[2], sustainRate: adsr[3] } : { attack: 15, decay: 7, sustainLevel: 7, sustainRate: 0 },
    gain: { mode: "DIRECT", value: 127 },
    pitchMod: false, noise: false, echo: true, volume: 127, releaseRate: 0, noiseClock: null,
    ...extra,
  };
}

export function starterInstruments() {
  return [
    inst("inst_lead", "Saw Lead", "smp_saw", [14, 4, 5, 8], { releaseRate: 20 }),
    inst("inst_arp", "Arp Pulse", "smp_pulse", [15, 3, 3, 14], { volume: 96 }),
    inst("inst_bass", "Slap Bass", "smp_bass", [15, 4, 4, 13], { echo: false }),
    inst("inst_strings", "Strings", "smp_strings", [9, 1, 6, 6], { releaseRate: 18, volume: 110 }),
    inst("inst_brass", "Brass", "smp_brass", [12, 3, 5, 8], { releaseRate: 20 }),
    inst("inst_square", "Square", "smp_square", [15, 5, 5, 10]),
    inst("inst_tri", "Triangle Bass", "smp_tri", [15, 2, 6, 4], { echo: false }),
    inst("inst_ep", "EP Bell", "smp_ep", [15, 5, 3, 15]),
    inst("inst_kick", "Kick", "smp_kick", null, { echo: false }),
    inst("inst_snare", "Snare", "smp_snare", null, { volume: 110 }),
    inst("inst_hat", "Hi-Hat (noise)", "smp_sine", [15, 7, 0, 23], { noise: true, noiseClock: 29, volume: 70 }),
    inst("inst_orch", "Orchestra Hit", "smp_orch", null),
    inst("inst_boom", "Explosion (noise)", "smp_sine", [15, 2, 2, 12], { noise: true, noiseClock: 24 }),
    inst("inst_pmc", "PM Carrier", "smp_sine", [15, 4, 4, 12], { pitchMod: true, echo: false }),
  ];
}

// ---------- Demo song ----------

function emptyChannels() { return Array.from({ length: CHANNELS }, () => []); }

function demoPatterns() {
  const chords = [
    { root: 45, strings: [60, 64], arp: [69, 72, 76, 81] },   // Am
    { root: 41, strings: [57, 60], arp: [65, 69, 72, 77] },   // F
    { root: 48, strings: [64, 67], arp: [72, 76, 79, 84] },   // C
    { root: 43, strings: [59, 62], arp: [67, 71, 74, 79] },   // G
  ];
  const build = (id, name, withLead) => {
    const ch = emptyChannels();
    chords.forEach((c, bar) => {
      const r0 = bar * 16;
      // Strings
      ch[3].push({ row: r0, note: c.strings[0], instId: "inst_strings", volL: 70, volR: 70 });
      ch[4].push({ row: r0, note: c.strings[1], instId: "inst_strings", volL: 70, volR: 70 });
      // Bass
      [[0, 0], [3, 0], [6, 12], [8, 0], [11, 0], [14, 7]].forEach(([r, o]) =>
        ch[2].push({ row: r0 + r, note: c.root + o, instId: "inst_bass", volL: 100, volR: 100 }));
      // Arpeggio, one note per row
      for (let r = 0; r < 16; r++) {
        ch[1].push({ row: r0 + r, note: c.arp[r % 4], instId: "inst_arp", volL: withLead ? 38 : 55, volR: withLead ? 38 : 55 });
      }
      // Drums
      ch[5].push({ row: r0, note: 60, instId: "inst_kick", volL: 120, volR: 120 });
      ch[5].push({ row: r0 + 8, note: 60, instId: "inst_kick", volL: 120, volR: 120 });
      if (bar % 2) ch[5].push({ row: r0 + 10, note: 60, instId: "inst_kick", volL: 100, volR: 100 });
      ch[6].push({ row: r0 + 4, note: 60, instId: "inst_snare", volL: 100, volR: 100 });
      ch[6].push({ row: r0 + 12, note: 60, instId: "inst_snare", volL: 100, volR: 100 });
      for (let r = 0; r < 16; r += 2) {
        ch[7].push({ row: r0 + r, note: r % 4 ? 60 : 64, instId: "inst_hat", volL: r % 4 ? 55 : 80, volR: r % 4 ? 55 : 80 });
      }
    });
    if (withLead) {
      const mel = [
        [0, 76, 4], [4, 74, 2], [6, 72, 2], [8, 74, 4], [12, 76, 4],
        [16, 77, 6], [22, 76, 2], [24, 74, 4], [28, 72, 4],
        [32, 76, 4], [36, 79, 4], [40, 84, 6], [46, 83, 2],
        [48, 79, 8], [56, 74, 4], [60, 71, 3],
      ];
      for (const [row, note, len] of mel) {
        ch[0].push({ row, note, instId: "inst_lead", volL: 92, volR: 92 });
        if (len >= 6) for (let r = row + 2; r < row + len; r++) ch[0].push({ row: r, note: null, fx: "VIBRATO", fxVal: 0x43 });
      }
      ch[0].push({ row: 63, note: "OFF" });
    }
    ch.forEach(list => list.sort((a, b) => a.row - b.row));
    return { id, name, kind: "music", lengthRows: 64, channels: ch };
  };
  return [build("pat_intro", "Intro", false), build("pat_theme", "Theme", true)];
}

function sfxPattern(id, name, rows, ch0 = [], ch1 = []) {
  const channels = emptyChannels();
  channels[0] = ch0; channels[1] = ch1;
  return { id, name, kind: "sfx", lengthRows: rows, channels };
}

function demoSfx() {
  const patterns = [
    sfxPattern("pat_sfx_jump", "SFX: Jump", 8, [
      { row: 0, note: 72, instId: "inst_square", volL: 100, volR: 100, fx: "PORTA_UP", fxVal: 20 },
      { row: 1, note: null, fx: "PORTA_UP", fxVal: 20 },
      { row: 2, note: null, fx: "PORTA_UP", fxVal: 20 },
      { row: 3, note: "OFF" },
    ]),
    sfxPattern("pat_sfx_coin", "SFX: Coin", 8, [
      { row: 0, note: 83, instId: "inst_square", volL: 90, volR: 90 },
      { row: 1, note: 88, instId: "inst_square", volL: 90, volR: 90 },
      { row: 6, note: "OFF" },
    ]),
    sfxPattern("pat_sfx_laser", "SFX: Laser", 8, [
      { row: 0, note: 96, instId: "inst_lead", volL: 90, volR: 90, fx: "PORTA_DOWN", fxVal: 48 },
      { row: 1, note: null, fx: "PORTA_DOWN", fxVal: 48 },
      { row: 2, note: null, fx: "PORTA_DOWN", fxVal: 48 },
      { row: 3, note: null, fx: "PORTA_DOWN", fxVal: 48 },
      { row: 4, note: "OFF" },
    ]),
    sfxPattern("pat_sfx_boom", "SFX: Explosion", 16, [
      { row: 0, note: 60, instId: "inst_boom", volL: 120, volR: 120, fx: "NOISE_FREQ", fxVal: 26 },
      { row: 2, note: null, fx: "NOISE_FREQ", fxVal: 23 },
      { row: 4, note: null, fx: "NOISE_FREQ", fxVal: 20 },
      { row: 6, note: null, fx: "NOISE_FREQ", fxVal: 17 },
      { row: 9, note: null, fx: "NOISE_FREQ", fxVal: 14 },
      { row: 13, note: "OFF" },
    ]),
    sfxPattern("pat_sfx_power", "SFX: Power-Up (pitch mod)", 16, [
      { row: 0, note: 72, instId: "inst_pmc", volL: 90, volR: 90, fx: "PORTA_UP", fxVal: 6 },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(row => ({ row, note: null, fx: "PORTA_UP", fxVal: 6 })),
      { row: 12, note: "OFF" },
    ], [
      { row: 0, note: 55, instId: "inst_tri", volL: 0, volR: 0 },
      { row: 12, note: "OFF" },
    ]),
  ];
  const bank = [
    { id: "sfx_jump", name: "Jump", channelsUsed: 1, patternId: "pat_sfx_jump" },
    { id: "sfx_coin", name: "Coin", channelsUsed: 1, patternId: "pat_sfx_coin" },
    { id: "sfx_laser", name: "Laser", channelsUsed: 1, patternId: "pat_sfx_laser" },
    { id: "sfx_boom", name: "Explosion", channelsUsed: 1, patternId: "pat_sfx_boom" },
    { id: "sfx_power", name: "Power-Up", channelsUsed: 2, patternId: "pat_sfx_power" },
  ];
  return { patterns, bank };
}

export function defaultMixer() {
  const pans = [0, -20, 0, -30, 30, 0, 10, 24];
  return {
    channels: pans.map(pan => ({ vol: 127, pan, invL: false, invR: false, mute: false, solo: false, echo: true, pmod: false, noise: false })),
  };
}

export function demoProject() {
  const sfx = demoSfx();
  const samples = starterSamples().map(s => ({
    id: s.id, name: s.name, loopEnabled: s.params.loop, loopStartBlock: 0,
    baseNote: s.baseNote, fineTune: s.fineTune, sampleRate: s.source.rate,
    params: s.params, byteLength: 0, hasSource: true,
  }));
  return {
    project: {
      schemaVersion: SCHEMA_VERSION,
      meta: { title: "Boss Theme", bpm: 140, ticksPerRow: 6, strictAramLimit: true, loopOrder: 1 },
      globalDsp: {
        masterVolL: 80, masterVolR: 80, noiseClock: 15,
        echo: { delaySteps: 4, feedback: 70, volL: 40, volR: 40, fir: [12, 33, 43, 43, 19, -2, -13, -7] },
      },
      samples,
      instruments: starterInstruments(),
      patterns: [...demoPatterns(), ...sfx.patterns],
      arrangement: ["pat_intro", "pat_theme", "pat_theme"],
      sfxBank: sfx.bank,
      mixer: defaultMixer(),
    },
    sources: Object.fromEntries(starterSamples().map(s => [s.id, s.source])),
  };
}

export function blankProject() {
  const { project, sources } = demoProject();
  project.meta.title = "Untitled";
  project.patterns = [{ id: "pat_01", name: "Pattern 1", kind: "music", lengthRows: 64, channels: emptyChannels() }];
  project.arrangement = ["pat_01"];
  project.meta.loopOrder = 0;
  project.sfxBank = [];
  return { project, sources };
}

// Fill in anything an older or hand-written project is missing.
export function normalizeProject(p) {
  p.schemaVersion ||= SCHEMA_VERSION;
  p.meta = { title: "Untitled", bpm: 120, ticksPerRow: 6, strictAramLimit: true, loopOrder: 0, ...(p.meta || {}) };
  p.globalDsp = { masterVolL: 127, masterVolR: 127, noiseClock: 15, ...(p.globalDsp || {}) };
  p.globalDsp.echo = { delaySteps: 0, feedback: 0, volL: 0, volR: 0, fir: [127, 0, 0, 0, 0, 0, 0, 0], ...(p.globalDsp.echo || {}) };
  p.samples ||= [];
  p.instruments = (p.instruments || []).map(i => ({ ...inst(i.id, i.name, i.sampleId, null), ...i }));
  p.patterns = (p.patterns || []).map(pt => {
    const channels = Array.from({ length: CHANNELS }, (_, c) => ((pt.channels || [])[c] || []).slice().sort((a, b) => a.row - b.row));
    return { name: pt.id, kind: "music", lengthRows: 64, ...pt, channels };
  });
  p.arrangement = (p.arrangement || []).filter(id => p.patterns.some(pt => pt.id === id));
  p.sfxBank ||= [];
  p.mixer ||= defaultMixer();
  while (p.mixer.channels.length < CHANNELS) p.mixer.channels.push(defaultMixer().channels[0]);
  return p;
}

// ---------- ARAM budget ----------

export function sequenceBytes(project) {
  let bytes = 0;
  for (const pat of project.patterns) {
    bytes += 16;
    for (const events of pat.channels) {
      let lastInst = null, lastVol = null;
      for (const ev of events) {
        bytes += 1; // duration / delay
        if (ev.note != null) bytes += 1;
        if (ev.instId && ev.instId !== lastInst) { bytes += 2; lastInst = ev.instId; }
        const vol = ev.volL != null ? `${ev.volL},${ev.volR}` : null;
        if (vol && vol !== lastVol) { bytes += 2; lastVol = vol; }
        if (ev.fx) bytes += 2;
      }
      bytes += 1; // end of track
    }
  }
  bytes += project.arrangement.length * 2 + 4;
  bytes += project.instruments.length * 6; // instrument table
  bytes += project.samples.length * 4;     // sample directory
  bytes += project.sfxBank.length * 4;
  return bytes;
}

export function aramUsage(project, sampleBytes) {
  const samples = project.samples.reduce((a, s) => a + (sampleBytes(s.id) || 0), 0);
  const echo = (project.globalDsp.echo.delaySteps | 0) * 2048;
  const sequence = sequenceBytes(project);
  const total = DRIVER_BYTES + sequence + samples + echo;
  return { driver: DRIVER_BYTES, sequence, samples, echo, total, limit: ARAM_LIMIT, over: total > ARAM_LIMIT };
}

// ---------- Export / import ----------

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Project JSON in the shared schema. `brrFor(id)` returns the sample's BRR bytes.
export function exportProjectJson(project, brrFor, { embedBrr = true } = {}) {
  const out = { schemaVersion: SCHEMA_VERSION, generator: `${APP.name} ${APP.version}`, ...JSON.parse(JSON.stringify(project)) };
  out.schemaVersion = SCHEMA_VERSION;
  out.generator = `${APP.name} ${APP.version}`;
  out.samples = out.samples.map(s => {
    const b = brrFor(s.id);
    const entry = { ...s, byteLength: b ? b.length : 0 };
    delete entry.hasSource;
    if (embedBrr && b) entry.brrBase64 = toBase64(b);
    else entry.brrFile = `samples/${s.id}.brr`;
    return entry;
  });
  return out;
}

// 16-bit mono WAV (used to store source recordings inside .hiromsound project files)
export function floatToWav(data, rate) {
  const n = data.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767))), true);
  return new Uint8Array(buf);
}

export function wavToFloat(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 12, rate = 32000, ch = 1, bits = 16, data = null;
  while (p + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    const size = v.getUint32(p + 4, true);
    if (id === "fmt ") { ch = v.getUint16(p + 10, true); rate = v.getUint32(p + 12, true); bits = v.getUint16(p + 22, true); }
    if (id === "data") {
      const frames = Math.floor(size / (ch * bits / 8));
      data = new Float32Array(frames);
      for (let i = 0; i < frames; i++) data[i] = v.getInt16(p + 8 + i * ch * 2, true) / 32768;
    }
    p += 8 + size + (size & 1);
  }
  return data ? { rate, data } : null;
}
