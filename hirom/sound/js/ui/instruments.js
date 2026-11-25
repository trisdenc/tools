// Instruments tab: envelope (ADSR / GAIN) editor with a hardware-accurate curve,
// sample/flags setup and an on-screen keyboard.

import { state, commit, setUi, instrument, sampleMeta, instIndex } from "../store.js";
import { h, fill, select, slider, toggle, fitCanvas, theme, hex2, fmtMs } from "./util.js";
import { SDSP, COUNTER_RATES, DSP_RATE } from "../dsp.js";
import { envelopeRegisters } from "../engine.js";
import { newId, NOISE_RATES_HZ, notePretty } from "../project.js";

const GAIN_MODES = [
  ["DIRECT", "Direct level"], ["LINEAR_DEC", "Linear decrease"], ["EXP_DEC", "Exponential decrease"],
  ["LINEAR_INC", "Linear increase"], ["BENT_INC", "Bent-line increase"],
];

// ---------- Envelope timing (from the hardware rate table) ----------
const sec = (steps, rate) => (rate === 0 ? Infinity : (steps * COUNTER_RATES[rate]) / DSP_RATE);
function expSteps(from, until) {
  let env = from, n = 0;
  while (!until(env) && n < 100000) { env--; env -= env >> 8; n++; }
  return n;
}
export const attackTime = ar => (ar === 15 ? 2 / DSP_RATE : sec(63, ar * 2 + 1));
export const decayTime = (dr, sl) => sec(expSteps(0x7FF, e => e >> 8 <= sl), dr * 2 + 16);
export const sustainTime = (sr, sl) => sec(expSteps(((sl + 1) << 8) - 1, e => e < 0x10), sr);
export const fadeTime = rate => sec(expSteps(0x7FF, e => e < 0x10), rate);

// Simulate the envelope through the real S-DSP envelope code.
const SILENT_LOOP = new Uint8Array([0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
export function simulateEnvelope(inst, holdSec, maxSec = 6) {
  const d = new SDSP();
  const v = d.voices[0];
  const regs = envelopeRegisters(inst);
  v.brr = SILENT_LOOP; v.adsr0 = regs.adsr0; v.adsr1 = regs.adsr1; v.gain = regs.gain;
  d.keyOn(1);
  const step = 32, hold = Math.round(holdSec * DSP_RATE), max = Math.round(maxSec * DSP_RATE);
  const pts = [];
  let released = false, releasedAt = -1;
  for (let i = 0; i < max; i++) {
    if (!released && i >= hold) {
      released = true; releasedAt = i;
      if (inst.releaseRate > 0) { v.adsr0 &= 0x7F; v.gain = 0xA0 | (inst.releaseRate & 31); }
      else d.keyOff(1);
    }
    d.step();
    if (i % step === 0) pts.push(v.env);
    if (released && v.env === 0 && i > releasedAt + 64) break;
  }
  return { pts, step, releasedAt };
}

export function createInstrumentsView({ audition }) {
  const listCard = h("div", { class: "card" });
  const main = h("div");
  const el = h("div", { class: "split" }, h("aside", null, listCard), main);
  let holdSec = 0.6;
  let graph = null, regsEl = null;

  function renderList() {
    const p = state.project, ui = state.ui;
    fill(listCard, 
      h("h2", null, "Instruments"),
      h("div", { class: "list" }, p.instruments.map((ins, n) => h("button", {
        class: "item", "aria-current": ins.id === ui.instId ? "true" : null, onclick: () => setUi({ instId: ins.id }),
      },
        h("span", { class: "idx" }, hex2(n + 1)),
        h("span", { class: "name" }, ins.name),
        ins.noise ? h("span", { class: "tag" }, "noise") : null,
        ins.pitchMod ? h("span", { class: "tag" }, "pmod") : null))),
      h("div", { class: "row tight", style: { marginTop: "8px" } },
        h("button", { class: "tbtn small", onclick: addInstrument }, "+ New"),
        h("button", { class: "tbtn small", onclick: duplicate, disabled: !ui.instId }, "Duplicate"),
        h("button", { class: "tbtn small", onclick: remove, disabled: !ui.instId }, "Delete")));
  }

  function addInstrument() {
    const id = newId("inst");
    const sampleId = state.ui.sampleId || state.project.samples[0]?.id || null;
    commit(p => p.instruments.push({
      id, name: `Instrument ${p.instruments.length + 1}`, sampleId, envMode: "ADSR",
      adsr: { attack: 15, decay: 4, sustainLevel: 5, sustainRate: 10 }, gain: { mode: "DIRECT", value: 127 },
      pitchMod: false, noise: false, echo: true, volume: 127, releaseRate: 0, noiseClock: null,
    }));
    setUi({ instId: id });
  }

  function duplicate() {
    const src = instrument(state.ui.instId);
    if (!src) return;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = newId("inst");
    copy.name = src.name + " copy";
    commit(p => p.instruments.splice(p.instruments.indexOf(src) + 1, 0, copy));
    setUi({ instId: copy.id });
  }

  function remove() {
    const ins = instrument(state.ui.instId);
    if (!ins) return;
    let uses = 0;
    for (const pt of state.project.patterns) for (const ch of pt.channels) for (const e of ch) if (e.instId === ins.id) uses++;
    if (uses && !confirm(`"${ins.name}" is used by ${uses} note(s). Delete it anyway? Those notes will keep playing whatever instrument came before them.`)) return;
    commit(p => {
      p.instruments = p.instruments.filter(i => i.id !== ins.id);
      for (const pt of p.patterns) for (const ch of pt.channels) for (const e of ch) if (e.instId === ins.id) delete e.instId;
    });
    setUi({ instId: state.project.instruments[0]?.id || null });
  }

  // Edit without rebuilding the page (keeps sliders under the pointer)
  function tweak(ins, key, fn) {
    commit(() => fn(ins), { coalesce: `inst-${ins.id}-${key}`, silent: true });
    drawGraph();
    updateRegs();
  }

  function updateRegs() {
    const ins = instrument(state.ui.instId);
    if (!ins || !regsEl) return;
    const r = envelopeRegisters(ins);
    regsEl.textContent = ins.envMode === "ADSR"
      ? `ADSR1 $${hex2(r.adsr0)}  ADSR2 $${hex2(r.adsr1)}`
      : `ADSR1 $${hex2(r.adsr0)}  GAIN $${hex2(r.gain)}`;
    if (ins.releaseRate > 0) regsEl.textContent += `  · release GAIN $${hex2(0xA0 | ins.releaseRate)}`;
  }

  function drawGraph() {
    if (!graph) return;
    const ins = instrument(state.ui.instId);
    if (!ins) return;
    requestAnimationFrame(() => {
      const { ctx, w, h: hh } = fitCanvas(graph);
      const t = theme();
      const sim = simulateEnvelope(ins, holdSec);
      const total = sim.pts.length * sim.step;
      const pad = 8, gw = w - pad * 2, gh = hh - 28;
      ctx.clearRect(0, 0, w, hh);
      // grid
      ctx.fillStyle = t.grid;
      for (let k = 1; k < 8; k++) ctx.fillRect(pad, pad + gh - (gh * k) / 8, gw, 1);
      // key-off marker
      if (sim.releasedAt >= 0) {
        const x = pad + (sim.releasedAt / total) * gw;
        ctx.fillStyle = t.warn;
        ctx.fillRect(x, pad, 1, gh);
        ctx.font = "11px system-ui, sans-serif";
        ctx.fillText("key off", Math.min(x + 4, w - 46), pad + 10);
      }
      // curve
      ctx.strokeStyle = t.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      sim.pts.forEach((e, i) => {
        const x = pad + (i * sim.step / total) * gw, y = pad + gh - (e / 0x7FF) * gh;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
      ctx.lineTo(pad + gw, pad + gh); ctx.lineTo(pad, pad + gh); ctx.closePath();
      ctx.fillStyle = t.accent; ctx.globalAlpha = 0.12; ctx.fill(); ctx.globalAlpha = 1;
      // time axis
      ctx.fillStyle = t.muted;
      ctx.font = "11px system-ui, sans-serif";
      const secs = total / DSP_RATE;
      const tick = secs > 4 ? 1 : secs > 1.5 ? 0.5 : secs > 0.6 ? 0.2 : 0.1;
      for (let s = 0; s <= secs; s += tick) {
        const x = pad + (s / secs) * gw;
        ctx.fillRect(x, pad + gh, 1, 4);
        ctx.fillText(s >= 1 || s === 0 ? `${+s.toFixed(1)}s` : `${Math.round(s * 1000)}`, x + 2, hh - 6);
      }
    });
  }

  function piano(ins) {
    const base = (state.ui.octave + 1) * 12;
    const wrap = h("div", { class: "piano", role: "group", "aria-label": "Play the instrument" });
    const whites = [0, 2, 4, 5, 7, 9, 11];
    const keys = [];
    for (let o = 0; o < 2; o++) for (const s of whites) keys.push(base + o * 12 + s);
    keys.push(base + 24);
    const wkW = 100 / keys.length;
    const press = (el, note) => {
      el.addEventListener("pointerdown", e => { e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add("down"); audition(note, true, "pn" + note); });
      const upFn = () => { el.classList.remove("down"); audition(note, false, "pn" + note); };
      el.addEventListener("pointerup", upFn);
      el.addEventListener("pointercancel", upFn);
    };
    keys.forEach(n => {
      const k = h("div", { class: "wk", title: notePretty(n) }, n % 12 === 0 ? h("span", { class: "lbl" }, notePretty(n)) : null);
      press(k, n);
      wrap.append(k);
    });
    keys.forEach((n, i) => {
      if (i === keys.length - 1 || [4, 11].includes(n % 12)) return;
      const b = h("div", { class: "bk", style: { left: `calc(${(i + 1) * wkW}% - ${wkW * 0.3}%)`, width: `${wkW * 0.6}%` }, title: notePretty(n + 1) });
      press(b, n + 1);
      wrap.append(b);
    });
    return wrap;
  }

  function renderEditor() {
    const ins = instrument(state.ui.instId);
    if (!ins) { fill(main, h("div", { class: "card" }, h("p", { class: "muted" }, "No instrument selected."))); graph = null; return; }
    const p = state.project;
    const a = ins.adsr;
    const name = h("input", { class: "inp", value: ins.name, "aria-label": "Instrument name", style: { fontWeight: 600, width: "220px" } });
    name.addEventListener("change", () => commit(() => { ins.name = name.value.trim() || ins.name; }));
    const smp = sampleMeta(ins.sampleId);

    const adsrSliders = h("div", { class: "sliders" },
      slider({ label: "Attack", min: 0, max: 15, value: a.attack, format: v => `${v} · ${fmtMs(attackTime(v))}`, onInput: v => tweak(ins, "ar", i => { i.adsr.attack = v; }) }),
      slider({ label: "Decay", min: 0, max: 7, value: a.decay, format: v => `${v} · ${fmtMs(decayTime(v, ins.adsr.sustainLevel))}`, onInput: v => tweak(ins, "dr", i => { i.adsr.decay = v; }) }),
      slider({ label: "Sustain level", min: 0, max: 7, value: a.sustainLevel, format: v => `${v} · ${Math.round(((v + 1) / 8) * 100)}%`, onInput: v => tweak(ins, "sl", i => { i.adsr.sustainLevel = v; }) }),
      slider({ label: "Sustain rate", min: 0, max: 31, value: a.sustainRate, format: v => `${v} · ${v ? fmtMs(sustainTime(v, ins.adsr.sustainLevel)) : "hold"}`, onInput: v => tweak(ins, "sr", i => { i.adsr.sustainRate = v; }) }),
    );
    // Slider columns are wider when showing times
    adsrSliders.querySelectorAll(".slider").forEach(s => { s.style.gridTemplateColumns = "110px 1fr 96px"; });

    const g = ins.gain;
    const gainIsDirect = g.mode === "DIRECT";
    const gainSliders = h("div", { class: "sliders" },
      h("label", { class: "inline" }, "Mode", select(GAIN_MODES, g.mode, v => commit(() => {
        ins.gain.mode = v;
        if (v === "DIRECT") ins.gain.value = Math.min(127, ins.gain.value * 4 || 127);
        else ins.gain.value = Math.min(31, ins.gain.value);
      }), { class: "inp" })),
      slider({
        label: gainIsDirect ? "Level" : "Rate", min: 0, max: gainIsDirect ? 127 : 31, value: g.value,
        format: v => gainIsDirect ? `${v} · ${Math.round((v / 127) * 100)}%`
          : `${v} · ${g.mode === "EXP_DEC" ? fmtMs(fadeTime(v)) : g.mode === "BENT_INC" ? fmtMs(sec(112, v)) : fmtMs(sec(64, v))}`,
        onInput: v => tweak(ins, "gv", i => { i.gain.value = v; }),
      }),
    );
    gainSliders.querySelectorAll(".slider").forEach(s => { s.style.gridTemplateColumns = "110px 1fr 96px"; });

    graph = h("canvas", { class: "envgraph", "aria-label": "Envelope curve" });
    regsEl = h("div", { class: "regs" });

    const noiseSel = ins.noise ? h("label", { class: "inline" }, "Noise clock",
      select(NOISE_RATES_HZ.map((hz, i) => [i, `${i} · ${hz >= 1000 ? hz / 1000 + " kHz" : hz + " Hz"}`]), ins.noiseClock ?? p.globalDsp.noiseClock,
        v => commit(() => { ins.noiseClock = +v; }), { class: "inp" })) : null;

    fill(main, 
      h("div", { class: "card" },
        h("div", { class: "row" },
          name,
          h("label", { class: "inline" }, "Sample", select([["", "— none —"], ...p.samples.map(s => [s.id, s.name])], ins.sampleId || "", v => commit(() => { ins.sampleId = v || null; }), { class: "inp" })),
          smp ? h("button", { class: "tbtn small", onclick: () => setUi({ tab: "samples", sampleId: smp.id }) }, "Edit sample") : null,
          h("span", { class: "grow" }),
          h("span", { class: "muted small" }, `Instrument ${hex2(instIndex(ins.id) + 1)}`)),
        h("div", { style: { marginTop: "10px" } },
          slider({ label: "Volume", min: 0, max: 127, value: ins.volume ?? 127, onInput: v => tweak(ins, "vol", i => { i.volume = v; }) })),
        h("div", { class: "row", style: { marginTop: "10px" } },
          toggle("Echo", ins.echo, v => commit(() => { ins.echo = v; }), { title: "Send this instrument to the echo unit (EON)" }),
          toggle("Pitch mod", ins.pitchMod, v => commit(() => { ins.pitchMod = v; }), { title: "The previous voice's output bends this voice's pitch (PMON). Doesn't work on voice 1." }),
          toggle("Noise", ins.noise, v => commit(() => { ins.noise = v; ins.noiseClock ??= 20; }), { title: "Play the white-noise generator instead of the sample (NON)" }),
          noiseSel),
        ins.pitchMod ? h("p", { class: "muted small", style: { margin: "8px 0 0" } }, "Pitch modulation uses the voice one to the left as the modulator, so put this instrument on voice 2–8 and the modulator on the voice just before it.") : null,
        ins.noise ? h("p", { class: "muted small", style: { margin: "8px 0 0" } }, "The S-DSP has one noise generator shared by all voices, so every noise voice plays at the same noise clock. Higher notes raise the clock in steps.") : null),

      h("div", { class: "inst-grid", style: { marginTop: "12px" } },
        h("div", { class: "card" },
          h("div", { class: "row", style: { marginBottom: "10px" } },
            h("h2", { style: { margin: 0 } }, "Envelope"),
            h("div", { class: "seg" },
              h("button", { "aria-pressed": ins.envMode === "ADSR" ? "true" : "false", onclick: () => commit(() => { ins.envMode = "ADSR"; }) }, "ADSR"),
              h("button", { "aria-pressed": ins.envMode === "GAIN" ? "true" : "false", onclick: () => commit(() => { ins.envMode = "GAIN"; }) }, "GAIN"))),
          ins.envMode === "ADSR" ? adsrSliders : gainSliders,
          h("div", { style: { marginTop: "14px" } },
            (() => {
              const s = slider({
                label: "Release", min: 0, max: 31, value: ins.releaseRate | 0,
                format: v => (v ? `${v} · ${fmtMs(fadeTime(v))}` : "key-off · 8 ms"),
                onInput: v => tweak(ins, "rel", i => { i.releaseRate = v; }),
              });
              s.style.gridTemplateColumns = "110px 1fr 96px";
              return s;
            })(),
            h("p", { class: "muted small", style: { margin: "6px 0 0" } }, "The hardware key-off always fades out in 8 ms. Like many SNES sound drivers, a release above 0 instead switches to GAIN exponential decrease when the note ends, for longer tails.")),
        ),
        h("div", { class: "card" },
          h("div", { class: "row", style: { marginBottom: "8px" } }, h("h2", { style: { margin: 0 } }, "Envelope curve"), h("span", { class: "grow" }), regsEl),
          graph,
          h("div", { style: { marginTop: "8px" } },
            (() => {
              const s = slider({ label: "Hold note for", min: 0.05, max: 3, step: 0.05, value: holdSec, format: v => fmtMs(v), onInput: v => { holdSec = v; drawGraph(); } });
              return s;
            })()),
          h("p", { class: "muted small", style: { margin: "6px 0 0" } }, "Drawn by running the real S-DSP envelope logic, register value for register value. Play it with your computer keyboard or the keys below."),
          piano(ins))),
    );
    updateRegs();
    drawGraph();
  }

  return {
    el,
    show() { renderList(); renderEditor(); },
    update(kind) {
      if (kind === "project" || kind === "ui") { renderList(); renderEditor(); }
    },
    meters() {},
  };
}
