// Song engine: drives the S-DSP from the project data.
// Runs inside the AudioWorklet for live playback and on the main thread for
// offline export, so timing is sample-accurate in both.

import { SDSP, DSP_RATE } from "./dsp.js";

const MUSIC = 1, SFX = 2, AUDITION = 3;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function pitchReg(note, s) {
  const semis = note - s.baseNote + (s.fineTune || 0) / 100;
  const p = Math.round(4096 * (s.rate / DSP_RATE) * Math.pow(2, semis / 12));
  return p < 0 ? 0 : p > 0x3FFF ? 0x3FFF : p;
}

export function gainRegister(gain) {
  const v = gain?.value | 0;
  switch (gain?.mode) {
    case "LINEAR_DEC": return 0x80 | (v & 31);
    case "EXP_DEC": return 0xA0 | (v & 31);
    case "LINEAR_INC": return 0xC0 | (v & 31);
    case "BENT_INC": return 0xE0 | (v & 31);
    default: return v & 0x7F; // DIRECT
  }
}

export function envelopeRegisters(inst) {
  const a = inst.adsr || {};
  if (inst.envMode === "GAIN") {
    return { adsr0: 0, adsr1: 0, gain: gainRegister(inst.gain) };
  }
  return {
    adsr0: 0x80 | ((a.decay & 7) << 4) | (a.attack & 15),
    adsr1: ((a.sustainLevel & 7) << 5) | (a.sustainRate & 31),
    gain: 0,
  };
}

function newChannel() {
  return {
    inst: null, note: 60, semis: 60, target: 60, keyed: false,
    volL: 100, volR: 100, panFx: null, echoFx: null, pmodFx: null,
    fx: null, fxVal: 0, portaSpeed: 16, vibSpeed: 4, vibDepth: 4, vibPhase: 0, vibOffset: 0,
  };
}

class Player {
  constructor(engine, owner, voiceMap) {
    this.e = engine;
    this.owner = owner;
    this.voiceMap = voiceMap;
    this.channels = voiceMap.map(newChannel);
    this.playing = false;
    this.orders = [];
    this.order = 0; this.row = 0; this.tick = 0;
    this.countdown = 0;
    this.loop = true;
    this.loopOrder = 0;
    this.passes = 0;
    this.useMixer = owner === MUSIC;
  }

  start(orders, { order = 0, row = 0, loop = true, loopOrder = 0 } = {}) {
    this.orders = orders.filter(id => this.e.patterns.has(id));
    if (!this.orders.length) { this.playing = false; return; }
    this.channels = this.voiceMap.map(newChannel);
    this.order = clamp(order, 0, this.orders.length - 1);
    const pat = this.e.patterns.get(this.orders[this.order]);
    this.row = clamp(row, 0, pat.length - 1);
    this.tick = 0;
    this.countdown = 0;
    this.loop = loop;
    this.loopOrder = clamp(loopOrder, 0, this.orders.length - 1);
    this.passes = 0;
    this.playing = true;
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    this.channels.forEach((cs, c) => { if (cs.keyed) this.keyOff(c); });
  }

  get patternId() { return this.orders[this.order]; }

  clock() {
    if (!this.playing) return;
    if (--this.countdown > 0) return;
    this.countdown += this.e.samplesPerTick;
    const pat = this.e.patterns.get(this.orders[this.order]);
    if (!pat) { this.finish(); return; }
    if (this.tick === 0) this.processRow(pat, this.row);
    else this.processTick();
    if (++this.tick >= this.e.ticksPerRow) {
      this.tick = 0;
      if (++this.row >= pat.length) {
        this.row = 0;
        if (++this.order >= this.orders.length) {
          if (this.loop) { this.order = this.loopOrder; this.passes++; }
          else this.finish();
        }
      }
    }
  }

  finish() {
    this.stop();
    this.e.onPlayerFinished(this);
  }

  voiceFor(c) {
    const v = this.voiceMap[c];
    return this.e.owner[v] === this.owner ? v : -1;
  }

  processRow(pat, row) {
    for (let c = 0; c < this.channels.length; c++) {
      const cs = this.channels[c];
      const hadVib = cs.vibOffset !== 0;
      cs.fx = null;
      cs.vibOffset = 0;
      const ev = pat.index[c] && pat.index[c][row];
      if (!ev) { if (hadVib) this.updatePitch(c); continue; }

      if (ev.instId) {
        const inst = this.e.instruments.get(ev.instId);
        if (inst) cs.inst = inst;
      }
      if (ev.volL != null) cs.volL = clamp(ev.volL | 0, 0, 127);
      if (ev.volR != null) cs.volR = clamp(ev.volR | 0, 0, 127);

      const fx = ev.fx || null, val = ev.fxVal | 0;
      if (fx === "PAN") cs.panFx = clamp(val, 0, 127) - 64;
      else if (fx === "ECHO") cs.echoFx = val > 0;
      else if (fx === "PMOD") cs.pmodFx = val > 0;
      else if (fx === "NOISE_FREQ") this.e.setNoiseClock(val & 31);
      else if (fx === "TONE_PORTA") { if (val) cs.portaSpeed = val; }
      else if (fx === "VIBRATO") {
        if (val >> 4) cs.vibSpeed = val >> 4;
        if (val & 15) cs.vibDepth = val & 15;
      }
      cs.fx = fx;
      cs.fxVal = val;

      if (typeof ev.note === "number") {
        if (fx === "TONE_PORTA" && cs.keyed) cs.target = ev.note;
        else {
          cs.note = cs.semis = cs.target = ev.note;
          cs.vibPhase = 0;
          this.keyOn(c, fx === "NOISE_FREQ");
          continue;
        }
      } else if (ev.note === "OFF") {
        this.keyOff(c);
      }
      this.updateVolume(c);
      this.updateFlags(c);
      this.updatePitch(c);
    }
  }

  processTick() {
    for (let c = 0; c < this.channels.length; c++) {
      const cs = this.channels[c];
      switch (cs.fx) {
        case "PORTA_UP": cs.semis += cs.fxVal / 16; break;
        case "PORTA_DOWN": cs.semis -= cs.fxVal / 16; break;
        case "TONE_PORTA": {
          const d = cs.target - cs.semis, s = cs.portaSpeed / 16;
          cs.semis = Math.abs(d) <= s ? cs.target : cs.semis + Math.sign(d) * s;
          break;
        }
        case "VIBRATO":
          cs.vibPhase = (cs.vibPhase + cs.vibSpeed) & 63;
          cs.vibOffset = Math.sin((cs.vibPhase / 64) * 2 * Math.PI) * cs.vibDepth / 8;
          break;
        default: continue;
      }
      cs.semis = clamp(cs.semis, 0, 127);
      this.updatePitch(c);
    }
  }

  keyOn(c, keepNoise) {
    const cs = this.channels[c];
    const inst = cs.inst;
    const vi = this.voiceFor(c);
    cs.keyed = true;
    if (vi < 0 || !inst) return;
    const sample = this.e.samples.get(inst.sampleId);
    if (!sample) return;
    const v = this.e.dsp.voices[vi];
    v.brr = sample.brr;
    v.loopAddr = sample.loop ? sample.loopBlock * 9 : 0;
    const env = envelopeRegisters(inst);
    v.adsr0 = env.adsr0; v.adsr1 = env.adsr1; v.gain = env.gain;
    if (inst.noise && !keepNoise && inst.noiseClock != null) {
      this.e.setNoiseClock(clamp((inst.noiseClock | 0) + Math.round((cs.note - 60) / 4), 0, 31));
    }
    this.updatePitch(c);
    this.updateVolume(c);
    this.updateFlags(c);
    this.e.dsp.keyOn(v.bit);
  }

  keyOff(c) {
    const cs = this.channels[c];
    cs.keyed = false;
    const vi = this.voiceFor(c);
    if (vi < 0) return;
    const v = this.e.dsp.voices[vi];
    const rel = cs.inst?.releaseRate | 0;
    if (rel > 0) { v.adsr0 &= 0x7F; v.gain = 0xA0 | (rel & 31); }
    else this.e.dsp.keyOff(v.bit);
  }

  updatePitch(c) {
    const vi = this.voiceFor(c);
    const cs = this.channels[c];
    if (vi < 0 || !cs.inst) return;
    const s = this.e.samples.get(cs.inst.sampleId);
    if (s) this.e.dsp.voices[vi].pitch = pitchReg(cs.semis + cs.vibOffset, s);
  }

  updateVolume(c) {
    const vi = this.voiceFor(c);
    if (vi < 0) return;
    const cs = this.channels[c];
    const iv = cs.inst?.volume ?? 127;
    let pan = cs.panFx ?? 0, scale = iv / 127, invL = false, invR = false;
    if (this.useMixer) {
      const m = this.e.mixer[this.voiceMap[c]];
      if (m) {
        if (cs.panFx == null) pan = m.pan | 0;
        scale *= (m.vol ?? 127) / 127;
        invL = !!m.invL; invR = !!m.invR;
        if (!this.e.audible(this.voiceMap[c])) scale = 0;
      }
    }
    const gL = pan > 0 ? (64 - pan) / 64 : 1;
    const gR = pan < 0 ? (64 + pan) / 64 : 1;
    const v = this.e.dsp.voices[vi];
    v.volL = clamp(Math.round(cs.volL * scale * gL) * (invL ? -1 : 1), -128, 127);
    v.volR = clamp(Math.round(cs.volR * scale * gR) * (invR ? -1 : 1), -128, 127);
  }

  updateFlags(c) {
    const vi = this.voiceFor(c);
    if (vi < 0) return;
    const cs = this.channels[c], inst = cs.inst || {};
    const m = this.useMixer ? this.e.mixer[this.voiceMap[c]] || {} : {};
    const echo = (cs.echoFx ?? !!inst.echo) && (this.useMixer ? m.echo !== false : true);
    const pmod = (cs.pmodFx ?? !!inst.pitchMod) || !!m.pmod;
    const noise = !!inst.noise || !!m.noise;
    const d = this.e.dsp, bit = 1 << vi;
    d.eon = echo ? d.eon | bit : d.eon & ~bit;
    d.pmon = pmod ? d.pmon | bit : d.pmon & ~bit;
    d.non = noise ? d.non | bit : d.non & ~bit;
  }

  refreshAll() {
    for (let c = 0; c < this.channels.length; c++) { this.updateVolume(c); this.updateFlags(c); }
  }
}

export class Engine {
  constructor() {
    this.dsp = new SDSP();
    this.samples = new Map();
    this.instruments = new Map();
    this.patterns = new Map();
    this.sfxBank = new Map();
    this.arrangement = [];
    this.mixer = [];
    this.loopOrder = 0;
    this.samplesPerTick = 80000 / 120;
    this.ticksPerRow = 6;
    this.owner = new Uint8Array(8).fill(MUSIC);
    this.music = new Player(this, MUSIC, [0, 1, 2, 3, 4, 5, 6, 7]);
    this.sfx = null;
    this.sfxId = null;
    this.audition = new Map(); // key -> { voice, inst }
    this.auditionReleased = new Set();
    this.nextAudVoice = 0;
    this.sampleClock = 0;
    this.noiseBase = 0;
  }

  // ---------- Project data ----------
  setSong(song) {
    const m = song.meta || {};
    this.samplesPerTick = (DSP_RATE * 2.5) / clamp(m.bpm || 120, 20, 999);
    this.ticksPerRow = clamp(m.ticksPerRow || 6, 1, 32);
    this.loopOrder = m.loopOrder | 0;
    this.instruments = new Map((song.instruments || []).map(i => [i.id, i]));
    this.patterns = new Map((song.patterns || []).map(p => [p.id, indexPattern(p)]));
    this.sfxBank = new Map((song.sfxBank || []).map(s => [s.id, s]));
    this.arrangement = song.arrangement || [];
    this.mixer = song.mixer?.channels || [];
    this.applyGlobal(song.globalDsp || {});
    // Re-resolve instruments held by players so edits apply to playing notes.
    for (const p of [this.music, this.sfx]) {
      if (!p) continue;
      p.channels.forEach(cs => { if (cs.inst) cs.inst = this.instruments.get(cs.inst.id) || cs.inst; });
      p.refreshAll();
      if (this.music.playing && p === this.music) this.music.loopOrder = clamp(this.loopOrder, 0, Math.max(0, this.music.orders.length - 1));
    }
  }

  applyGlobal(g) {
    const d = this.dsp, e = g.echo || {};
    d.mvolL = clamp(g.masterVolL ?? 127, -128, 127);
    d.mvolR = clamp(g.masterVolR ?? 127, -128, 127);
    d.evolL = clamp(e.volL | 0, -128, 127);
    d.evolR = clamp(e.volR | 0, -128, 127);
    d.efb = clamp(e.feedback | 0, -128, 127);
    d.edl = clamp(e.delaySteps | 0, 0, 15);
    const fir = e.fir || [127, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 8; i++) d.fir[i] = clamp(fir[i] | 0, -128, 127);
    this.noiseBase = clamp(g.noiseClock ?? 15, 0, 31);
    d.flg = (d.flg & ~0x1F) | this.noiseBase;
    d.flg &= ~0xE0; // not reset, not muted, echo writes on
  }

  setNoiseClock(n) { this.dsp.flg = (this.dsp.flg & ~0x1F) | (n & 31); }

  setSample(id, s) { this.samples.set(id, s); }
  removeSample(id) { this.samples.delete(id); }

  audible(voice) {
    const anySolo = this.mixer.some(c => c && c.solo);
    const m = this.mixer[voice];
    if (!m) return true;
    return !m.mute && (!anySolo || m.solo);
  }

  // ---------- Transport ----------
  play({ mode = "song", order = 0, row = 0, patternId = null, loop = true } = {}) {
    this.stopAll(false);
    this.dsp.clearEcho();
    this.applyNoiseBase();
    if (mode === "pattern") this.music.start([patternId], { row, loop: true });
    else this.music.start(this.arrangement, { order, row, loop, loopOrder: this.loopOrder });
  }

  applyNoiseBase() { this.setNoiseClock(this.noiseBase); }

  stopAll(includeSfx = true) {
    this.music.stop();
    if (includeSfx && this.sfx) this.stopSfx();
  }

  panic() {
    this.music.stop();
    if (this.sfx) this.stopSfx();
    this.audition.clear();
    this.dsp.keyOff(0xFF);
    this.owner.fill(MUSIC);
  }

  playSfx(id) {
    const sfx = this.sfxBank.get(id);
    if (!sfx || !this.patterns.has(sfx.patternId)) return;
    if (this.sfx) this.stopSfx(true);
    const voices = (sfx.channelsUsed | 0) >= 2 ? [7, 6] : [7];
    for (const v of voices) {
      if (this.owner[v] === MUSIC) this.dsp.keyOff(1 << v);
      this.owner[v] = SFX;
    }
    this.sfx = new Player(this, SFX, voices);
    this.sfxId = id;
    this.sfx.start([sfx.patternId], { loop: false });
  }

  stopSfx(immediate) {
    const p = this.sfx;
    if (!p) return;
    p.stop();
    this.releaseSfxVoices(p, immediate);
  }

  releaseSfxVoices(p, immediate) {
    this.sfx = null;
    this.sfxId = null;
    for (const v of p.voiceMap) {
      if (this.owner[v] !== SFX) continue;
      if (immediate) this.owner[v] = MUSIC;
      else this.auditionReleased.add(v); // returned to music once silent
    }
  }

  onPlayerFinished(p) {
    if (p === this.sfx) this.releaseSfxVoices(p, false);
  }

  // ---------- Live audition ----------
  // instId may also be a full instrument object (used to audition bare samples)
  noteOn(key, instId, note) {
    const inst = instId && typeof instId === "object" ? instId : this.instruments.get(instId);
    if (!inst) return;
    const sample = this.samples.get(inst.sampleId);
    if (!sample) return;
    if (this.audition.has(key)) this.noteOff(key);
    let vi;
    if (this.music.playing || this.sfx) vi = this.sfx ? 6 : 7;
    else {
      // Round-robin, preferring voices that aren't held down
      const held = new Set([...this.audition.values()].map(a => a.voice));
      for (let k = 0; k < 8; k++) {
        const cand = (this.nextAudVoice + k) & 7;
        if (!held.has(cand)) { vi = cand; break; }
      }
      if (vi === undefined) vi = this.nextAudVoice;
      this.nextAudVoice = (vi + 1) & 7;
    }
    if (this.owner[vi] === SFX) return;
    this.owner[vi] = AUDITION;
    this.auditionReleased.delete(vi);
    const v = this.dsp.voices[vi];
    v.brr = sample.brr;
    v.loopAddr = sample.loop ? sample.loopBlock * 9 : 0;
    const env = envelopeRegisters(inst);
    v.adsr0 = env.adsr0; v.adsr1 = env.adsr1; v.gain = env.gain;
    v.pitch = pitchReg(note, sample);
    const vol = Math.round(100 * (inst.volume ?? 127) / 127);
    v.volL = vol; v.volR = vol;
    const bit = 1 << vi, d = this.dsp;
    d.eon = inst.echo ? d.eon | bit : d.eon & ~bit;
    d.pmon = inst.pitchMod ? d.pmon | bit : d.pmon & ~bit;
    d.non = inst.noise ? d.non | bit : d.non & ~bit;
    if (inst.noise && inst.noiseClock != null) this.setNoiseClock(clamp((inst.noiseClock | 0) + Math.round((note - 60) / 4), 0, 31));
    d.keyOn(bit);
    this.audition.set(key, { voice: vi, inst });
  }

  noteOff(key) {
    const a = this.audition.get(key);
    if (!a) return;
    this.audition.delete(key);
    const v = this.dsp.voices[a.voice];
    const rel = a.inst.releaseRate | 0;
    if (rel > 0) { v.adsr0 &= 0x7F; v.gain = 0xA0 | (rel & 31); }
    else this.dsp.keyOff(1 << a.voice);
    this.auditionReleased.add(a.voice);
  }

  // Return voices to the music player once their sound has died away.
  reclaimVoices() {
    for (const vi of this.auditionReleased) {
      const v = this.dsp.voices[vi];
      const stillHeld = [...this.audition.values()].some(a => a.voice === vi);
      if (stillHeld) { this.auditionReleased.delete(vi); continue; }
      if (v.env === 0 || this.sampleClock - (v._relAt ??= this.sampleClock) > DSP_RATE * 2) {
        if (this.owner[vi] !== MUSIC) {
          this.dsp.keyOff(1 << vi);
          this.owner[vi] = MUSIC;
        }
        v._relAt = undefined;
        this.auditionReleased.delete(vi);
      }
    }
  }

  // ---------- Rendering ----------
  step() {
    this.music.clock();
    if (this.sfx) this.sfx.clock();
    if ((++this.sampleClock & 255) === 0 && this.auditionReleased.size) this.reclaimVoices();
    this.dsp.step();
  }

  render(outL, outR, count, offset = 0) {
    const d = this.dsp;
    for (let i = 0; i < count; i++) {
      this.step();
      outL[offset + i] = d.outL;
      outR[offset + i] = d.outR;
    }
  }

  // ---------- Messages from the UI ----------
  handle(msg) {
    switch (msg.type) {
      case "song": this.setSong(msg.song); break;
      case "sample": this.setSample(msg.id, msg.sample); break;
      case "removeSample": this.removeSample(msg.id); break;
      case "play": this.play(msg); break;
      case "stop": this.stopAll(true); break;
      case "panic": this.panic(); break;
      case "noteOn": this.noteOn(msg.key, msg.instId, msg.note); break;
      case "noteOff": this.noteOff(msg.key); break;
      case "sfx": this.playSfx(msg.id); break;
      case "stopSfx": this.stopSfx(true); break;
    }
  }

  meters() {
    const d = this.dsp;
    const voices = d.voices.map(v => {
      const r = { l: v.peakL, r: v.peakR, env: v.env, owner: this.owner[v.index] };
      v.peakL = 0; v.peakR = 0;
      return r;
    });
    const out = {
      type: "meters",
      voices,
      master: { l: d.peakL, r: d.peakR },
      clips: d.clips,
      playing: this.music.playing,
      order: this.music.order,
      row: this.music.row,
      patternId: this.music.playing ? this.music.patternId : null,
      sfxId: this.sfxId,
      sfxRow: this.sfx ? this.sfx.row : -1,
    };
    d.peakL = 0; d.peakR = 0;
    return out;
  }
}

// Build a row lookup for each channel: index[ch][row] -> event
export function indexPattern(p) {
  const length = clamp(p.lengthRows | 0 || 64, 1, 256);
  const index = (p.channels || []).map(events => {
    const rows = new Array(length);
    for (const ev of events || []) if (ev.row >= 0 && ev.row < length) rows[ev.row] = ev;
    return rows;
  });
  return { id: p.id, length, index };
}

export { MUSIC, SFX, AUDITION };
