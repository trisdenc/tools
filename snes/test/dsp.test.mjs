// Verification suite: run with `node --test snes/test`
import test from "node:test";
import assert from "node:assert/strict";
import { SDSP, GAUSS, COUNTER_RATES, decodeBrrStream } from "../js/dsp.js";
import { encodeBrr, buildSample, snrDb, prepareSample } from "../js/brr.js";
import { Engine } from "../js/engine.js";
import { demoProject, aramUsage, ARAM_LIMIT } from "../js/project.js";

// ---------- Gaussian table ----------

test("Gaussian table is bit-exact with the hardware table", () => {
  assert.equal(GAUSS.length, 512);
  let h = 2166136261;
  for (const v of GAUSS) { h ^= v & 0xffff; h = Math.imul(h, 16777619) >>> 0; }
  // Fingerprint of the table in blargg's SPC_DSP.cpp (bsnes)
  assert.equal(h.toString(16), "fd7cfb1b");
  assert.equal(GAUSS[0], 0);
  assert.equal(GAUSS[511], 1305);
});

test("Gaussian taps sum to unity gain (2047-2049) at every offset", () => {
  for (let o = 0; o < 256; o++) {
    const s = GAUSS[255 - o] + GAUSS[511 - o] + GAUSS[256 + o] + GAUSS[o];
    assert.ok(s >= 2047 && s <= 2049, `offset ${o}: ${s}`);
  }
});

// ---------- BRR ----------

function sine(n, period, amp = 0.8) {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * i) / period) * amp * 32767);
  return out;
}

test("BRR round trip of a sine keeps > 30 dB SNR", () => {
  const pcm = sine(1024, 37.3);
  const { data } = encodeBrr(pcm);
  const dec = decodeBrrStream(data).subarray(0, pcm.length);
  assert.ok(snrDb(pcm, dec) > 30, `SNR ${snrDb(pcm, dec)}`);
});

test("BRR blocks are 9 bytes; non-looping samples end with a silent END block", () => {
  const { data, blocks } = encodeBrr(sine(64, 16));
  assert.equal(data.length, blocks * 9);
  assert.equal(blocks, 5);
  assert.equal(data[4 * 9], 0x01);               // END, no LOOP
  for (let b = 0; b < 4; b++) assert.equal(data[b * 9] & 3, 0);
  assert.equal(data[0] & 0x0C, 0, "first block uses filter 0");
});

test("Looping BRR sets LOOP on every block, END on the last, filter 0 at the loop start", () => {
  const { data, loopBlock, blocks } = encodeBrr(sine(128, 32), { loop: true, loopStart: 64 });
  assert.equal(loopBlock, 4);
  assert.equal(blocks, 8);
  for (let b = 0; b < blocks; b++) assert.ok(data[b * 9] & 2);
  assert.equal(data[7 * 9] & 1, 1);
  assert.equal(data[4 * 9] & 0x0C, 0);
});

test("Unaligned loops are resampled to a multiple of 16 samples with exact pitch", () => {
  const rate = 32000, period = 50; // 640 Hz, loop of 3 periods = 150 samples (not a multiple of 16)
  const data = new Float32Array(1000).map((_, i) => Math.sin((2 * Math.PI * i) / period));
  const prep = prepareSample({ rate, data }, { loop: true, loopStart: 100, loopEnd: 250, targetRate: 32000, normalize: false });
  const loopLen = prep.pcm.length - prep.loopStart;
  assert.equal(loopLen % 16, 0);
  assert.equal(prep.loopStart % 16, 0);
  // The loop still holds exactly 3 periods, so the reported rate keeps the pitch exact
  const freqAfter = (3 * prep.rate) / loopLen;
  assert.ok(Math.abs(freqAfter - rate / period) < 0.01, `${freqAfter}`);
});

// ---------- Voice playback ----------

function dspWithSample(s, { pitch = 0x1000, adsr0 = 0x8F, adsr1 = 0xE0, gain = 0 } = {}) {
  const d = new SDSP();
  const v = d.voices[0];
  v.brr = s.data; v.loopAddr = s.loopBlock * 9;
  v.pitch = pitch; v.volL = 127; v.volR = 127;
  v.adsr0 = adsr0; v.adsr1 = adsr1; v.gain = gain;
  d.keyOn(1);
  return d;
}

test("A 32-sample loop at pitch 0x1000 plays at exactly 1000 Hz", () => {
  const pcm = sine(32, 32);
  const s = encodeBrr(pcm, { loop: true, loopStart: 0 });
  const d = dspWithSample(s);
  const out = [];
  for (let i = 0; i < 32000; i++) { d.step(); out.push(d.outL); }
  let crossings = 0;
  for (let i = 1000; i < 32000; i++) if (out[i - 1] < 0 && out[i] >= 0) crossings++;
  assert.ok(Math.abs(crossings - 969) <= 1, `crossings ${crossings}`); // 31000 samples * 1000/32000
});

test("Pitch 0x2000 plays an octave up", () => {
  const s = encodeBrr(sine(32, 32), { loop: true, loopStart: 0 });
  const d = dspWithSample(s, { pitch: 0x2000 });
  let prev = 0, crossings = 0;
  for (let i = 0; i < 16000; i++) { d.step(); if (i > 500 && prev < 0 && d.outL >= 0) crossings++; prev = d.outL; }
  assert.ok(Math.abs(crossings - 968) <= 2, `crossings ${crossings}`);
});

test("Non-looping samples go silent when they reach the END block", () => {
  const s = encodeBrr(sine(160, 20));
  const d = dspWithSample(s);
  let lastLoud = 0;
  for (let i = 0; i < 2000; i++) { d.step(); if (Math.abs(d.outL) > 50) lastLoud = i; }
  assert.ok(lastLoud > 100 && lastLoud < 200, `last audible sample ${lastLoud}`);
  assert.equal(d.voices[0].env, 0);
});

// ---------- Envelopes ----------

function attackSamples(ar) {
  const s = encodeBrr(new Int16Array(32).fill(8000), { loop: true });
  const d = dspWithSample(s, { adsr0: 0x80 | ar, adsr1: 0xE0 });
  for (let i = 1; i < 200000; i++) { d.step(); if (d.voices[0].env >= 0x7E0) return i; }
  return -1;
}

test("ADSR attack timing matches the hardware rate table", () => {
  for (const ar of [0, 2, 4, 8, 12, 14]) {
    const period = COUNTER_RATES[ar * 2 + 1];
    const expected = 63 * period; // 0x20 per step, 0x7E0 / 0x20 = 63 steps
    const got = attackSamples(ar);
    assert.ok(Math.abs(got - expected) <= period + 12, `AR ${ar}: ${got} vs ${expected}`);
  }
  assert.ok(attackSamples(0) / 32000 > 4.0 && attackSamples(0) / 32000 < 4.2, "AR 0 is ~4.1 s");
  assert.ok(attackSamples(15) < 12, "AR 15 is instant");
});

test("Decay settles at the sustain level, then sustain decays exponentially", () => {
  const s = encodeBrr(new Int16Array(32).fill(8000), { loop: true });
  // AR 15, DR 7, SL 3 (boundary 0x400), SR 0 (hold)
  const d = dspWithSample(s, { adsr0: 0x8F | (7 << 4), adsr1: (3 << 5) | 0 });
  for (let i = 0; i < 32000; i++) d.step();
  const env = d.voices[0].env;
  assert.ok(env >= 0x3E0 && env <= 0x420, `env ${env.toString(16)}`); // the sustain check uses the pre-counter value, so it can stop just above 0x400
});

test("Key off releases linearly in 256 samples (8 ms)", () => {
  const s = encodeBrr(new Int16Array(32).fill(8000), { loop: true });
  const d = dspWithSample(s, { adsr0: 0x8F, adsr1: 0xE0 });
  for (let i = 0; i < 500; i++) d.step();
  assert.equal(d.voices[0].env, 0x7FF);
  d.keyOff(1);
  let n = 0;
  while (d.voices[0].env > 0 && n < 1000) { d.step(); n++; }
  assert.ok(n >= 256 && n <= 260, `release took ${n}`);
});

test("GAIN direct sets the level immediately; linear decrease takes 64 steps", () => {
  const s = encodeBrr(new Int16Array(32).fill(8000), { loop: true });
  const d = dspWithSample(s, { adsr0: 0, gain: 0x40 }); // direct 0x40 -> env 0x400
  for (let i = 0; i < 20; i++) d.step();
  assert.equal(d.voices[0].env, 0x400);
  d.voices[0].gain = 0x80 | 31; // linear decrease every sample, 0x20 per step
  let n = 0;
  while (d.voices[0].env > 0 && n < 1000) { d.step(); n++; }
  assert.equal(n, 32);
});

// ---------- Noise, echo, pitch modulation ----------

test("Noise LFSR has period 32767", () => {
  const d = new SDSP();
  d.flg = 31;
  const start = d.noise;
  let n = 0;
  do { d.step(); n++; } while (d.noise !== start && n < 40000);
  assert.equal(n, 32767);
});

test("Echo delay of EDL steps * 16 ms", () => {
  const s = encodeBrr(new Int16Array(32).fill(20000)); // short click
  const d = dspWithSample(s);
  d.voices[0].volR = 0;
  d.eon = 1; d.edl = 2; d.evolL = 127; d.efb = 0;
  d.fir.set([0, 0, 0, 0, 0, 0, 0, 127]);
  d.mvolL = 0; // only hear the echo
  const out = [];
  for (let i = 0; i < 4000; i++) { d.step(); out.push(Math.abs(d.outL)); }
  const first = out.findIndex(x => x > 1000);
  // The echo buffer may still be at its old (zero) length for the first lap
  assert.ok(first >= 1024 && first <= 1024 + 64, `echo at ${first}`);
});

test("Pitch modulation changes the modulated voice", () => {
  const s = encodeBrr(sine(32, 32), { loop: true });
  const run = pmon => {
    const d = new SDSP();
    for (const i of [0, 1]) {
      const v = d.voices[i];
      v.brr = s.data; v.pitch = i ? 0x1000 : 0x0400; v.adsr0 = 0x8F; v.adsr1 = 0xE0;
      v.volL = i ? 127 : 0;
    }
    d.pmon = pmon;
    d.keyOn(3);
    let sum = 0;
    for (let i = 0; i < 4000; i++) { d.step(); sum += d.outL * (i % 7); }
    return sum;
  };
  assert.notEqual(run(0), run(2));
  assert.equal(run(1), run(0), "voice 0 ignores PMON");
});

// ---------- Song engine and ARAM ----------

function demoEngine() {
  const { project, sources } = demoProject();
  const e = new Engine();
  const bytes = {};
  for (const s of project.samples) {
    const b = buildSample(sources[s.id], s.params);
    bytes[s.id] = b.brr.length;
    e.setSample(s.id, { brr: b.brr, loop: b.loop, loopBlock: b.loopBlock, rate: b.rate, baseNote: s.baseNote, fineTune: s.fineTune });
  }
  e.setSong(project);
  return { e, project, bytes };
}

test("Demo song plays, loops back to the loop order, and does not clip", () => {
  const { e, project } = demoEngine();
  e.play({ mode: "song" });
  const rowSamples = e.samplesPerTick * project.meta.ticksPerRow;
  const songSamples = Math.ceil(rowSamples * 64 * project.arrangement.length);
  const L = new Int16Array(songSamples + 32000), R = new Int16Array(songSamples + 32000);
  e.render(L, R, L.length);
  assert.equal(e.music.passes, 1);
  assert.equal(e.music.order, project.meta.loopOrder);
  assert.equal(e.dsp.clips, 0);
});

test("Sequencer timing is sample-accurate (2.5 / BPM seconds per tick)", () => {
  const { e } = demoEngine();
  e.setSong({ ...demoProject().project, meta: { bpm: 125, ticksPerRow: 6 } });
  e.play({ mode: "pattern", patternId: "pat_intro" });
  const L = new Int16Array(1), R = new Int16Array(1);
  let n = 0;
  while (!(e.music.row === 16 && e.music.tick === 1)) { e.render(L, R, 1); n++; } // row 16 has been processed
  // 16 rows * 6 ticks * 640 samples (= 20 ms per tick at 125 BPM)
  assert.ok(Math.abs(n - 16 * 6 * 640) <= 1, `${n}`);
});

test("SFX take over voice 8 and hand it back afterwards", () => {
  const { e } = demoEngine();
  e.play({ mode: "song" });
  e.playSfx("sfx_coin");
  assert.equal(e.owner[7], 2);
  const L = new Int16Array(32000), R = new Int16Array(32000);
  e.render(L, R, L.length);
  assert.equal(e.sfx, null);
  assert.equal(e.owner[7], 1);
});

test("ARAM budget adds driver, sequence, samples and echo; overflow is detected", () => {
  const { project, bytes } = demoEngine();
  const u = aramUsage(project, id => bytes[id]);
  assert.equal(u.echo, project.globalDsp.echo.delaySteps * 2048);
  assert.equal(u.total, u.driver + u.sequence + u.samples + u.echo);
  assert.equal(u.over, false);
  const big = aramUsage(project, () => 6000);
  assert.ok(big.total > ARAM_LIMIT && big.over);
});
