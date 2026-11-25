// Mixer & Echo tab: 8 channel strips with VU meters, master volume, echo + FIR.

import { state, commit, aram } from "../store.js";
import { h, fill, slider, toggle, select, fitCanvas, theme, CHANNEL_COLORS, fmtBytes, toast } from "./util.js";
import { FIR_PRESETS, NOISE_RATES_HZ } from "../project.js";

const dbOf = peak => (peak <= 0 ? -Infinity : 20 * Math.log10(peak / 32768));
const meterFrac = peak => Math.max(0, Math.min(1, (dbOf(peak) + 48) / 48));

export function createMixerView() {
  const el = h("div");
  let vus = [], masterVu = null, clipEl = null, firGraph = null, firWarn = null, lastClips = 0, clipUntil = 0;
  const levels = Array.from({ length: 9 }, () => ({ l: 0, r: 0 }));

  function tweak(key, fn) {
    commit(fn, { coalesce: "mix-" + key, silent: true });
  }

  function strip(c) {
    const m = state.project.mixer.channels[c];
    const vu = h("canvas", { class: "vu", "aria-hidden": "true" });
    vus[c] = vu;
    const vol = slider({ label: "Vol", min: 0, max: 127, value: m.vol ?? 127, vertical: true, onInput: v => tweak(`vol${c}`, p => { p.mixer.channels[c].vol = v; }) });
    vol.input.dataset.reset = 127;
    const panIn = h("input", { type: "range", min: -64, max: 63, value: m.pan | 0, "aria-label": `Voice ${c + 1} pan` });
    const panOut = h("output", null, panLabel(m.pan | 0));
    panIn.addEventListener("input", () => { panOut.textContent = panLabel(+panIn.value); tweak(`pan${c}`, p => { p.mixer.channels[c].pan = +panIn.value; }); });
    panIn.addEventListener("dblclick", () => { panIn.value = 0; panIn.dispatchEvent(new Event("input")); });
    const set = (k, v) => commit(p => { p.mixer.channels[c][k] = v; });
    return h("div", { class: "strip" },
      h("div", { class: "chname" }, h("span", { class: "dot", style: { background: CHANNEL_COLORS[c] } }), `Voice ${c + 1}`),
      h("div", { class: "meterrow" }, vu, vol),
      h("label", { class: "pan" }, panIn, panOut),
      h("div", { class: "btns" },
        toggle("M", m.mute, v => set("mute", v), { class: "mute", title: "Mute" }),
        toggle("S", m.solo, v => set("solo", v), { class: "solo", title: "Solo" }),
        toggle("ØL", m.invL, v => set("invL", v), { title: "Invert left phase (negative volume, for the SNES 'surround' trick)" }),
        toggle("ØR", m.invR, v => set("invR", v), { title: "Invert right phase" }),
        toggle("Echo", m.echo !== false, v => set("echo", v), { title: "Allow this voice into the echo (instruments can still opt out)" }),
        toggle("PMod", !!m.pmod, v => set("pmod", v), { title: "Force pitch modulation from the voice to the left" }),
        toggle("Noise", !!m.noise, v => set("noise", v), { title: "Force this voice to play noise" })));
  }

  const panLabel = v => (v === 0 ? "C" : v < 0 ? `L${-v}` : `R${v}`);

  function render() {
    const g = state.project.globalDsp, e = g.echo;
    vus = [];
    masterVu = h("canvas", { class: "vu", "aria-hidden": "true", style: { width: "34px" } });
    clipEl = h("span", { class: "clip" }, "CLIP");
    const master = h("div", { class: "strip" },
      h("div", { class: "chname" }, "Master"),
      h("div", { class: "meterrow" },
        masterVu,
        (() => { const s = slider({ label: "L", min: -128, max: 127, value: g.masterVolL, vertical: true, onInput: v => tweak("mvl", p => { p.globalDsp.masterVolL = v; }) }); s.input.dataset.reset = 80; return s; })(),
        (() => { const s = slider({ label: "R", min: -128, max: 127, value: g.masterVolR, vertical: true, onInput: v => tweak("mvr", p => { p.globalDsp.masterVolR = v; }) }); s.input.dataset.reset = 80; return s; })()),
      clipEl,
      h("p", { class: "muted small", style: { margin: 0, textAlign: "center" } }, "All mixing is 16-bit with hardware clamping."));

    firGraph = h("canvas", { class: "firgraph", "aria-label": "FIR filter frequency response" });
    firWarn = h("p", { class: "warnbox" });
    const firSliders = h("div", { class: "fir" }, e.fir.map((cv, i) => {
      const s = slider({ label: `C${i}`, min: -128, max: 127, value: cv, vertical: true, onInput: v => { tweak(`fir${i}`, p => { p.globalDsp.echo.fir[i] = v; }); drawFir(); } });
      s.input.dataset.reset = i === 0 ? 127 : 0;
      return s;
    }));
    const presetSel = select([["", "Presets…"], ...FIR_PRESETS.map((pr, i) => [i, pr.name])], "", v => {
      if (v === "") return;
      commit(p => { p.globalDsp.echo.fir = FIR_PRESETS[+v].fir.slice(); });
    }, { class: "inp" });

    const echoBytes = (e.delaySteps | 0) * 2048;
    fill(el, 
      h("div", { class: "mixer" }, Array.from({ length: 8 }, (_, c) => strip(c)), master),
      h("div", { class: "echo-grid" },
        h("div", { class: "card" },
          h("h2", null, "Echo"),
          h("div", { class: "sliders" },
            slider({ label: "Delay (EDL)", min: 0, max: 15, value: e.delaySteps, format: v => `${v * 16} ms`, onInput: v => {
              const before = state.project.globalDsp.echo.delaySteps;
              tweak("edl", p => { p.globalDsp.echo.delaySteps = v; });
              if (v > before) checkStrict(p => { p.globalDsp.echo.delaySteps = before; });
              ramNote.textContent = ramText(v);
            } }),
            slider({ label: "Feedback (EFB)", min: -128, max: 127, value: e.feedback, onInput: v => tweak("efb", p => { p.globalDsp.echo.feedback = v; }) }),
            slider({ label: "Echo volume L", min: -128, max: 127, value: e.volL, onInput: v => tweak("evl", p => { p.globalDsp.echo.volL = v; }) }),
            slider({ label: "Echo volume R", min: -128, max: 127, value: e.volR, onInput: v => tweak("evr", p => { p.globalDsp.echo.volR = v; }) })),
          (ramNote = h("p", { class: "muted small" }, ramText(e.delaySteps))),
          h("h2", { style: { marginTop: "14px" } }, "Noise generator"),
          h("label", { class: "inline" }, "Default noise clock",
            select(NOISE_RATES_HZ.map((hz, i) => [i, `${i} · ${hz >= 1000 ? hz / 1000 + " kHz" : hz + " Hz"}`]), g.noiseClock,
              v => commit(p => { p.globalDsp.noiseClock = +v; }), { class: "inp" })),
          h("p", { class: "muted small" }, "One 15-bit noise generator is shared by every voice. Noise instruments and the N effect change its clock while the song plays.")),
        h("div", { class: "card" },
          h("div", { class: "row", style: { marginBottom: "8px" } }, h("h2", { style: { margin: 0 } }, "8-tap FIR filter"), h("span", { class: "grow" }), presetSel),
          firSliders,
          firGraph,
          firWarn,
          h("p", { class: "muted small", style: { margin: "6px 0 0" } }, "The filter runs on the echo signal before feedback, so it shapes every repeat. C0 applies to the oldest sample, C7 to the newest. Double-click a slider to reset it."))),
    );
    drawFir();
  }

  let ramNote = null;
  const ramText = steps => `Echo buffer uses ${fmtBytes(steps * 2048)} of ARAM${steps ? "" : " (4 bytes when off)"}.`;

  function checkStrict(undoFn) {
    if (state.project.meta.strictAramLimit && aram().over) {
      commit(undoFn, { undo: false });
      toast("Not enough ARAM for a longer echo in Strict 64 KB mode.", "error");
      render();
    }
  }

  function drawFir() {
    if (!firGraph) return;
    requestAnimationFrame(() => {
      const { ctx, w, h: hh } = fitCanvas(firGraph);
      const t = theme();
      const fir = state.project.globalDsp.echo.fir;
      ctx.clearRect(0, 0, w, hh);
      const pad = 26, gw = w - pad - 8, gh = hh - 26;
      const dbTop = 12, dbBot = -36;
      const yOf = db => 6 + ((dbTop - Math.max(dbBot, Math.min(dbTop, db))) / (dbTop - dbBot)) * gh;
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillStyle = t.muted;
      for (const db of [12, 0, -12, -24, -36]) {
        const y = yOf(db);
        ctx.fillStyle = db === 0 ? t.gridStrong : t.grid;
        ctx.fillRect(pad, y, gw, 1);
        ctx.fillStyle = t.muted;
        ctx.fillText(`${db}`, 2, y + 3);
      }
      for (const khz of [2, 4, 8, 12, 16]) {
        const x = pad + (khz / 16) * gw;
        ctx.fillStyle = t.grid; ctx.fillRect(x, 6, 1, gh);
        ctx.fillStyle = t.muted; ctx.fillText(`${khz}k`, x - 8, hh - 6);
      }
      ctx.strokeStyle = t.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let px = 0; px <= gw; px++) {
        const om = (px / gw) * Math.PI;
        let re = 0, im = 0;
        for (let n = 0; n < 8; n++) { re += (fir[n] / 128) * Math.cos(om * n); im -= (fir[n] / 128) * Math.sin(om * n); }
        const db = 20 * Math.log10(Math.max(1e-6, Math.hypot(re, im)));
        const y = yOf(db);
        px ? ctx.lineTo(pad + px, y) : ctx.moveTo(pad + px, y);
      }
      ctx.stroke();
      const sumAbs = fir.reduce((a, c) => a + Math.abs(c), 0);
      firWarn.textContent = sumAbs > 128
        ? `Σ|C| = ${sumAbs} is above 128, so loud echoes can clip inside the filter (the hardware wraps and clamps).`
        : "";
    });
  }

  function drawMeters() {
    vus.forEach((c, i) => drawVu(c, levels[i]));
    if (masterVu) drawVu(masterVu, levels[8]);
    if (clipEl) clipEl.classList.toggle("on", performance.now() < clipUntil);
  }

  function drawVu(canvas, lv) {
    if (!canvas || !canvas.isConnected) return;
    const { ctx, w, h: hh } = fitCanvas(canvas);
    const t = theme();
    ctx.clearRect(0, 0, w, hh);
    const bw = (w - 3) / 2;
    [lv.l, lv.r].forEach((v, k) => {
      const f = meterFrac(v);
      const x = 1 + k * (bw + 1);
      const grad = ctx.createLinearGradient(0, hh, 0, 0);
      grad.addColorStop(0, t.good); grad.addColorStop(0.75, t.good); grad.addColorStop(0.9, t.warn); grad.addColorStop(1, t.playhead);
      ctx.fillStyle = grad;
      ctx.fillRect(x, hh - f * hh, bw, f * hh);
    });
  }

  return {
    el,
    show() { render(); },
    update(kind) { if (kind === "project" || kind === "ui") render(); else if (kind === "project-silent") drawFir(); },
    meters(m) {
      // Smooth: fast attack, slow release
      m.voices.forEach((v, i) => {
        levels[i].l = Math.max(v.l, levels[i].l * 0.82);
        levels[i].r = Math.max(v.r, levels[i].r * 0.82);
      });
      levels[8].l = Math.max(m.master.l, levels[8].l * 0.82);
      levels[8].r = Math.max(m.master.r, levels[8].r * 0.82);
      if (m.clips > lastClips) clipUntil = performance.now() + 1500;
      lastClips = m.clips;
      drawMeters();
    },
  };
}
