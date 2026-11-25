// Samples tab (BRR Studio): import, trim, loop points, rate, encode, A/B audition.

import { state, commit, setUi, sampleMeta, encodeSample, samplePreview, addSample, aram, sampleBytes, emit, markSourceDirty, scheduleSave } from "../store.js";
import { h, fill, select, toggle, fitCanvas, theme, fmtBytes, toast, CHANNEL_COLORS } from "./util.js";
import { parseBrrFile, detectPitch, DEFAULT_PARAMS } from "../brr.js";
import { notePretty, newId, ARAM_LIMIT } from "../project.js";

const RATES = [32000, 24000, 22050, 16000, 12000, 11025, 8000];
const AUDIO_EXT = /\.(wav|wave|flac|mp3|ogg|oga|opus|m4a|aac|aif|aiff|webm)$/i;

export function createSamplesView({ audio }) {
  const listCard = h("div", { class: "card" });
  const main = h("div");
  const el = h("div", { class: "split" }, h("aside", null, listCard), main);
  const fileInput = h("input", { type: "file", multiple: true, accept: "audio/*,.brr,.wav,.flac,.mp3,.ogg", hidden: true });
  fileInput.addEventListener("change", () => { importFiles(fileInput.files); fileInput.value = ""; });
  let wave = null, drag = null, view = null, snapZero = true, overlay = true;

  // ---------- Import ----------
  async function decodeAudioFile(file) {
    const buf = await file.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 48000);
    const ab = await ctx.decodeAudioData(buf);
    const n = ab.length, out = new Float32Array(n);
    for (let c = 0; c < ab.numberOfChannels; c++) {
      const d = ab.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i] / ab.numberOfChannels;
    }
    return { rate: ab.sampleRate, data: out };
  }

  // Pick a rate and length that fit the remaining ARAM in strict mode.
  function fitParams(source) {
    const strict = state.project.meta.strictAramLimit;
    const free = ARAM_LIMIT - aram().total - 512;
    const dur = source.data.length / source.rate;
    const bytesFor = (rate, sec) => Math.ceil((sec * rate) / 16) * 9 + 18;
    let rate = 16000, len = Math.min(dur, 30), note = null;
    if (strict) {
      const fit = [16000, 11025, 8000].find(r => bytesFor(r, dur) <= free);
      if (fit) rate = fit;
      else {
        rate = 8000;
        len = Math.max(0, ((free - 18) / 9) * 16 / rate);
        note = len < 0.05 ? "no room" : `trimmed to ${len.toFixed(2)} s`;
      }
    } else if (dur > 30) note = "trimmed to 30 s";
    return { rate, trimEnd: Math.round(Math.min(dur, len) * source.rate), note };
  }

  async function importFiles(files) {
    for (const file of files) {
      const name = file.name.replace(/\.[^.]+$/, "");
      try {
        if (/\.brr$/i.test(file.name)) {
          const parsed = parseBrrFile(new Uint8Array(await file.arrayBuffer()));
          if (state.project.meta.strictAramLimit && aram().total + parsed.brr.length > ARAM_LIMIT) {
            toast(`${file.name} doesn't fit in the remaining 64 KB of ARAM.`, "error");
            continue;
          }
          const id = addSample({ name, brr: parsed.brr, loop: parsed.loop, loopBlock: parsed.loopBlock, rate: 32000, baseNote: 60 });
          setUi({ sampleId: id });
          toast(`Imported ${file.name} (raw BRR, ${parsed.brr.length} bytes)`);
          continue;
        }
        if (!AUDIO_EXT.test(file.name) && !file.type.startsWith("audio/")) { toast(`${file.name} isn't an audio file.`, "error"); continue; }
        const source = await decodeAudioFile(file);
        const fit = fitParams(source);
        if (fit.note === "no room") { toast(`There's no ARAM left for ${file.name}. Turn off Strict 64 KB or free some space.`, "error"); continue; }
        const pitch = detectPitch(source.data, source.rate);
        const baseNote = pitch ? Math.round(pitch) : 60;
        const fineTune = pitch ? -Math.round((pitch - baseNote) * 100) : 0;
        const id = addSample({
          name, source, baseNote, fineTune,
          params: { ...DEFAULT_PARAMS, trimStart: 0, trimEnd: fit.trimEnd, targetRate: fit.rate, loopStart: 0, loopEnd: fit.trimEnd },
        });
        setUi({ sampleId: id });
        toast(`Imported ${file.name} at ${fit.rate / 1000} kHz${fit.note ? `, ${fit.note} to fit ARAM` : ""}${pitch ? `, root ${notePretty(baseNote)}` : ""}`);
      } catch (e) {
        toast(`Couldn't import ${file.name}: ${e.message || e}`, "error");
      }
    }
  }

  // ---------- List ----------
  function renderList() {
    const p = state.project, ui = state.ui;
    const drop = h("div", { class: "drop", role: "button", tabindex: "0", onclick: () => fileInput.click() },
      h("strong", null, "Import samples"), h("br"), "Drop WAV, FLAC, MP3, OGG or raw .brr files here, or click to choose");
    drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
    fill(listCard, 
      h("h2", null, "Samples"),
      drop, fileInput,
      h("div", { class: "list" }, p.samples.map(s => h("button", {
        class: "item", "aria-current": s.id === ui.sampleId ? "true" : null, onclick: () => setUi({ sampleId: s.id }),
      },
        h("span", { class: "name" }, s.name),
        s.loopEnabled ? h("span", { class: "tag loop" }, "loop") : null,
        h("span", { class: "meta" }, fmtBytes(sampleBytes(s.id)))))));
  }

  // ---------- Editor ----------
  function update(s, fn, key) {
    commit(() => fn(s), { coalesce: key ? `smp-${s.id}-${key}` : null, silent: true });
    const t0 = performance.now();
    const changed = encodeSample(s.id);
    if (changed && state.project.meta.strictAramLimit && aram().over) toast("This sample now goes over the 64 KB ARAM limit. Lower the rate or trim it.", "error");
    if (performance.now() - t0 > 400) toast("Encoded");
    renderEditor();
    renderList();
    emit("project-silent");
  }

  function renderEditor() {
    const s = sampleMeta(state.ui.sampleId);
    if (!s) { fill(main, h("div", { class: "card" }, h("p", { class: "muted" }, "Import a sample to get started. Everything is encoded to BRR, the SNES's 4-bit ADPCM format, so you hear exactly what the hardware would play."))); wave = null; return; }
    const b = samplePreview(s.id) || {};
    const src = b.source;
    const p = s.params || {};
    const name = h("input", { class: "inp", value: s.name, "aria-label": "Sample name", style: { fontWeight: 600, width: "220px" } });
    name.addEventListener("change", () => commit(() => { s.name = name.value.trim() || s.name; }));

    const noteOpts = [];
    for (let n = 108; n >= 12; n--) noteOpts.push([n, notePretty(n)]);
    const fine = h("input", { type: "number", class: "inp", value: s.fineTune || 0, min: -100, max: 100, style: { width: "70px" }, "aria-label": "Fine tune (cents)" });
    fine.addEventListener("change", () => update(s, x => { x.fineTune = Math.max(-100, Math.min(100, Math.round(+fine.value || 0))); }));

    const used = state.project.instruments.filter(i => i.sampleId === s.id);
    const bytes = sampleBytes(s.id);
    const durSec = b.pcm ? b.pcm.length / (s.sampleRate || 32000) : (b.decoded?.length || 0) / (s.sampleRate || 32000);
    const loopLen = b.pcm && b.loop ? b.pcm.length - b.loopBlock * 16 : null;

    wave = h("canvas", { class: "wave", "aria-label": "Waveform with trim and loop handles" });
    wave.addEventListener("pointerdown", waveDown);
    wave.addEventListener("pointermove", waveMove);
    wave.addEventListener("pointerup", waveUp);
    wave.addEventListener("pointercancel", waveUp);
    wave.addEventListener("wheel", waveWheel, { passive: false });
    if (!view || view.id !== s.id) view = { id: s.id, start: 0, end: src ? src.data.length : (b.decoded?.length || 1) };

    fill(main, 
      h("div", { class: "card" },
        h("div", { class: "row" },
          name,
          h("span", { class: "grow" }),
          h("button", { class: "tbtn small", onclick: () => makeInstrument(s) }, "+ Instrument from sample"),
          h("button", { class: "tbtn small", onclick: () => deleteSample(s) }, "Delete")),
        used.length ? h("p", { class: "muted small", style: { margin: "6px 0 0" } }, `Used by: ${used.map(i => i.name).join(", ")}`) : null),

      h("div", { class: "card" },
        h("div", { class: "row", style: { marginBottom: "8px" } },
          h("div", { class: "ab", role: "group", "aria-label": "A/B audition" },
            h("button", { class: "tbtn small", disabled: !src, title: "Original recording, no BRR", onclick: () => playOriginal(s, b) }, "▶ A: Original"),
            h("button", { class: "tbtn small primary", title: "Encoded BRR through the S-DSP (Gaussian interpolation included)", onclick: () => playBrr(s) }, "▶ B: BRR on S-DSP"),
            h("button", { class: "tbtn small", onclick: stopAll }, "■")),
          h("span", { class: "grow" }),
          src ? h("label", { class: "check small" }, h("input", { type: "checkbox", checked: overlay, onchange: e => { overlay = e.target.checked; drawWave(); } }), "Show BRR result") : null,
          src ? h("label", { class: "check small" }, h("input", { type: "checkbox", checked: snapZero, onchange: e => { snapZero = e.target.checked; } }), "Snap loop to zero crossings") : null,
          h("button", { class: "tbtn small", onclick: () => { view = { id: s.id, start: 0, end: src ? src.data.length : b.decoded.length }; drawWave(); } }, "Fit"),
          src && p.loop ? h("button", { class: "tbtn small", onclick: () => zoomTo(p.loopStart, p.loopEnd ?? p.trimEnd) }, "Zoom to loop") : null),
        wave,
        h("p", { class: "muted small", style: { margin: "6px 0 0" } }, src
          ? "Drag the white handles to trim and the blue ones to set the loop. Scroll to zoom. Loops are automatically fitted to the 16-sample BRR block size by a tiny resample, and the pitch is corrected to match."
          : "This is a raw BRR file, so it can't be re-encoded. You can still set its root note and tuning.")),

      h("div", { class: "card" },
        h("div", { class: "row" },
          h("label", { class: "inline" }, "Root note", select(noteOpts, s.baseNote ?? 60, v => update(s, x => { x.baseNote = +v; }), { class: "inp" })),
          h("label", { class: "inline" }, "Fine tune (cents)", fine),
          src ? h("button", { class: "tbtn small", onclick: () => {
            const pitch = detectPitch(src.data.subarray(p.trimStart || 0, p.trimEnd ?? src.data.length), src.rate);
            if (!pitch) { toast("Couldn't find a clear pitch in this sample."); return; }
            const n = Math.round(pitch);
            update(s, x => { x.baseNote = n; x.fineTune = -Math.round((pitch - n) * 100); });
            toast(`Detected ${notePretty(n)} ${pitch - n >= 0 ? "+" : ""}${Math.round((pitch - n) * 100)} cents`);
          } }, "Detect pitch") : null),
        src ? h("div", { class: "row", style: { marginTop: "10px" } },
          h("label", { class: "inline" }, "Sample rate", select(RATES.map(r => [r, `${r.toLocaleString()} Hz`]), p.targetRate, v => update(s, x => { x.params.targetRate = +v; }), { class: "inp" })),
          toggle("Loop", !!p.loop, v => update(s, x => {
            x.params.loop = v;
            if (v && x.params.loopEnd == null) x.params.loopEnd = x.params.trimEnd ?? src.data.length;
          })),
          toggle("Normalize", p.normalize !== false, v => update(s, x => { x.params.normalize = v; })),
          h("label", { class: "inline" }, "Gain (dB)", (() => {
            const i = h("input", { type: "number", class: "inp", value: p.gainDb || 0, min: -24, max: 24, step: 0.5, style: { width: "70px" } });
            i.addEventListener("change", () => update(s, x => { x.params.gainDb = Math.max(-24, Math.min(24, +i.value || 0)); }));
            return i;
          })())) : null),

      h("div", { class: "card" },
        h("h2", null, "Encoded result"),
        h("div", { class: "stats" },
          stat(fmtBytes(bytes), `${((bytes / ARAM_LIMIT) * 100).toFixed(1)}% of 64 KB ARAM`),
          stat(`${(bytes / 9) | 0}`, "BRR blocks (16 samples each)"),
          stat(`${Math.round(s.sampleRate || 0).toLocaleString()} Hz`, "Playback rate"),
          stat(`${durSec.toFixed(durSec < 1 ? 3 : 2)} s`, "Length"),
          loopLen != null ? stat(`${loopLen}`, "Loop length (samples)") : null,
          b.snr != null && isFinite(b.snr) ? stat(`${b.snr.toFixed(1)} dB`, "BRR signal-to-noise") : null)),
    );
    requestAnimationFrame(drawWave);
  }

  const stat = (v, label) => h("div", { class: "stat" }, h("b", null, v), h("span", null, label));

  function makeInstrument(s) {
    const id = newId("inst");
    commit(p => p.instruments.push({
      id, name: s.name, sampleId: s.id, envMode: "ADSR",
      adsr: { attack: 15, decay: 7, sustainLevel: 7, sustainRate: 0 }, gain: { mode: "DIRECT", value: 127 },
      pitchMod: false, noise: false, echo: true, volume: 127, releaseRate: s.loopEnabled ? 16 : 0, noiseClock: null,
    }));
    setUi({ instId: id, tab: "instruments" });
  }

  function deleteSample(s) {
    const used = state.project.instruments.filter(i => i.sampleId === s.id);
    if (used.length && !confirm(`"${s.name}" is used by ${used.map(i => i.name).join(", ")}. Delete it anyway? Those instruments will be silent until you pick another sample.`)) return;
    commit(p => {
      p.samples = p.samples.filter(x => x.id !== s.id);
      for (const i of p.instruments) if (i.sampleId === s.id) i.sampleId = null;
    });
    setUi({ sampleId: state.project.samples[0]?.id || null });
  }

  // ---------- Audition ----------
  function playOriginal(s, b) {
    const src = b.source, p = s.params;
    if (!src) return;
    audio.start().then(() => {
      stopAll();
      const ts = p.trimStart || 0, te = p.trimEnd ?? src.data.length;
      if (p.loop) {
        const ls = p.loopStart ?? ts, le = p.loopEnd ?? te;
        audio.playRaw(src.data.subarray(ts, le), src.rate, { loopStart: ls - ts, loopEnd: le - ts });
      } else audio.playRaw(src.data.subarray(ts, te), src.rate);
    });
  }

  function playBrr(s) {
    audio.start().then(() => {
      stopAll();
      const inst = { id: "__sample", sampleId: s.id, envMode: "GAIN", gain: { mode: "DIRECT", value: 127 }, echo: false, volume: 127 };
      audio.noteOn("__sample", inst, s.baseNote ?? 60);
    });
  }

  function stopAll() { audio.stopRaw(); audio.noteOff("__sample"); }

  // ---------- Waveform ----------
  function toX(i, w) { return ((i - view.start) / (view.end - view.start)) * w; }
  function toI(x, w) { return view.start + (x / w) * (view.end - view.start); }

  function zoomTo(a, b) {
    const pad = (b - a) * 0.1 + 32;
    view.start = Math.max(0, a - pad); view.end = b + pad;
    drawWave();
  }

  function handles(s) {
    const p = s.params, src = state.bank.get(s.id)?.source;
    const len = src ? src.data.length : 0;
    const hs = [
      { key: "trimStart", pos: p.trimStart || 0, color: "text" },
      { key: "trimEnd", pos: p.trimEnd ?? len, color: "text" },
    ];
    if (p.loop) {
      hs.push({ key: "loopStart", pos: p.loopStart ?? p.trimStart ?? 0, color: "accent" });
      hs.push({ key: "loopEnd", pos: p.loopEnd ?? p.trimEnd ?? len, color: "accent" });
    }
    return hs;
  }

  function localX(e) { const r = wave.getBoundingClientRect(); return { x: e.clientX - r.left, w: r.width }; }

  function waveDown(e) {
    const s = sampleMeta(state.ui.sampleId);
    if (!s || !state.bank.get(s.id)?.source) return;
    const { x, w } = localX(e);
    let best = null, bestD = 9;
    for (const hd of handles(s)) {
      const d = Math.abs(toX(hd.pos, w) - x);
      if (d < bestD) { best = hd; bestD = d; }
    }
    if (best) {
      wave.setPointerCapture(e.pointerId);
      drag = { key: best.key, pos: best.pos };
    } else {
      drag = { key: "pan", x, start: view.start, end: view.end };
      wave.setPointerCapture(e.pointerId);
    }
  }

  function zeroCross(data, i) {
    for (let d = 0; d < 2000; d++) {
      for (const k of [i + d, i - d]) if (k > 0 && k < data.length && data[k - 1] <= 0 && data[k] > 0) return k;
    }
    return i;
  }

  function waveMove(e) {
    const s = sampleMeta(state.ui.sampleId);
    if (!s) return;
    const { x, w } = localX(e);
    if (!drag) {
      const near = state.bank.get(s.id)?.source && handles(s).some(hd => Math.abs(toX(hd.pos, w) - x) < 9);
      wave.style.cursor = near ? "ew-resize" : "grab";
      return;
    }
    if (drag.key === "pan") {
      const span = drag.end - drag.start, dx = ((drag.x - x) / w) * span;
      const len = state.bank.get(s.id).source.data.length;
      view.start = Math.max(0, Math.min(len - span, drag.start + dx));
      view.end = view.start + span;
      drawWave();
      return;
    }
    const src = state.bank.get(s.id).source;
    let pos = Math.round(Math.max(0, Math.min(src.data.length, toI(x, w))));
    if (snapZero && drag.key.startsWith("loop")) pos = zeroCross(src.data, pos);
    drag.pos = pos;
    drawWave();
  }

  function waveUp() {
    const d = drag;
    drag = null;
    if (!d || d.key === "pan") return;
    const s = sampleMeta(state.ui.sampleId);
    const len = state.bank.get(s.id).source.data.length;
    update(s, x => {
      const p = x.params;
      const ts = p.trimStart || 0, te = p.trimEnd ?? len;
      if (d.key === "trimStart") p.trimStart = Math.min(d.pos, te - 16);
      if (d.key === "trimEnd") p.trimEnd = Math.max(d.pos, ts + 16);
      if (d.key === "loopStart") p.loopStart = Math.max(p.trimStart || 0, Math.min(d.pos, (p.loopEnd ?? te) - 16));
      if (d.key === "loopEnd") p.loopEnd = Math.min(p.trimEnd ?? len, Math.max(d.pos, (p.loopStart ?? ts) + 16));
      if (p.loop) {
        p.loopStart = Math.max(p.trimStart || 0, p.loopStart ?? 0);
        p.loopEnd = Math.min(p.trimEnd ?? len, p.loopEnd ?? len);
      }
    });
  }

  function waveWheel(e) {
    e.preventDefault();
    const s = sampleMeta(state.ui.sampleId);
    const b = state.bank.get(s?.id);
    if (!b) return;
    const len = b.source ? b.source.data.length : b.decoded?.length || 1;
    const { x, w } = localX(e);
    const at = toI(x, w);
    const k = e.deltaY < 0 ? 0.8 : 1.25;
    const span = Math.max(64, Math.min(len, (view.end - view.start) * k));
    view.start = Math.max(0, at - (x / w) * span);
    view.end = Math.min(len, view.start + span);
    view.start = Math.max(0, view.end - span);
    drawWave();
  }

  function drawWave() {
    if (!wave || !wave.isConnected) return;
    const s = sampleMeta(state.ui.sampleId);
    if (!s) return;
    const b = state.bank.get(s.id) || {};
    const { ctx, w, h: hh } = fitCanvas(wave);
    const t = theme();
    ctx.clearRect(0, 0, w, hh);
    const mid = hh / 2;
    ctx.fillStyle = t.grid;
    ctx.fillRect(0, mid, w, 1);
    const src = b.source;
    const data = src ? src.data : b.decoded ? Float32Array.from(b.decoded, v => v / 32768) : null;
    if (!data) return;
    const p = s.params || {};

    // Source waveform (min/max per pixel)
    const drawSeries = (get, start, end, color, alpha, scale = 1) => {
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      for (let px = 0; px < w; px++) {
        const a = Math.floor(toI(px, w)), z = Math.max(a + 1, Math.floor(toI(px + 1, w)));
        if (z < start || a > end) continue;
        let mn = 1, mx = -1;
        for (let i = Math.max(a, start); i < Math.min(z, end); i += Math.max(1, ((z - a) / 64) | 0)) {
          const v = get(i);
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        if (mx < mn) continue;
        ctx.fillRect(px, mid - mx * scale * (mid - 4), 1, Math.max(1, (mx - mn) * scale * (mid - 4)));
      }
      ctx.globalAlpha = 1;
    };
    drawSeries(i => data[i], 0, data.length, t.muted, 0.9);

    if (src) {
      const ts = p.trimStart || 0, te = p.trimEnd ?? data.length;
      // BRR overlay, mapped back onto the source timeline
      if (overlay && b.decoded && b.pcm) {
        const step = src.rate / (s.sampleRate || src.rate);
        const origin = b.loop ? (p.loopStart ?? ts) - b.loopBlock * 16 * step : ts;
        let srcPeak = 0, decPeak = 0;
        for (let i = ts; i < te; i += 7) srcPeak = Math.max(srcPeak, Math.abs(data[i]));
        for (let i = 0; i < b.decoded.length; i += 3) decPeak = Math.max(decPeak, Math.abs(b.decoded[i]));
        const scale = decPeak ? srcPeak / (decPeak / 32768) : 1;
        drawSeries(i => {
          const k = Math.round((i - origin) / step);
          return k >= 0 && k < b.decoded.length ? b.decoded[k] / 32768 : 0;
        }, Math.max(0, Math.floor(origin)), Math.ceil(origin + b.decoded.length * step), CHANNEL_COLORS[5], 0.55, scale);
      }
      // Outside trim
      ctx.fillStyle = t.bg;
      ctx.globalAlpha = 0.65;
      const xs = toX(ts, w), xe = toX(te, w);
      if (xs > 0) ctx.fillRect(0, 0, xs, hh);
      if (xe < w) ctx.fillRect(xe, 0, w - xe, hh);
      ctx.globalAlpha = 1;
      // Loop region
      if (p.loop) {
        const ls = toX(p.loopStart ?? ts, w), le = toX(p.loopEnd ?? te, w);
        ctx.fillStyle = t.accent;
        ctx.globalAlpha = 0.1;
        ctx.fillRect(ls, 0, le - ls, hh);
        ctx.globalAlpha = 1;
      }
      // Handles (show drag position live)
      for (const hd of handles(s)) {
        const pos = drag && drag.key === hd.key ? drag.pos : hd.pos;
        const x = Math.round(toX(pos, w));
        if (x < -5 || x > w + 5) continue;
        ctx.fillStyle = hd.color === "accent" ? t.accent : t.text;
        ctx.fillRect(x - 1, 0, 2, hh);
        ctx.fillRect(x - 6, hd.key.startsWith("loop") ? hh - 14 : 0, 12, 14);
        ctx.fillStyle = hd.color === "accent" ? t.card : t.card;
        ctx.font = "bold 10px system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        const label = { trimStart: "S", trimEnd: "E", loopStart: "L", loopEnd: "L" }[hd.key];
        ctx.fillText(label, x, hd.key.startsWith("loop") ? hh - 7 : 7);
        ctx.textAlign = "left";
      }
    }
    // Time label
    ctx.fillStyle = t.muted;
    ctx.font = "11px system-ui, sans-serif";
    const rate = src ? src.rate : s.sampleRate || 32000;
    ctx.fillText(`${(view.start / rate).toFixed(3)} s`, 4, hh - 6);
    const endLabel = `${(view.end / rate).toFixed(3)} s`;
    ctx.fillText(endLabel, w - ctx.measureText(endLabel).width - 4, hh - 6);
  }

  // Drag files anywhere on this tab
  const onDragOver = e => { if (state.ui.tab === "samples" && [...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); document.body.classList.add("dragging"); } };
  const onDragLeave = e => { if (!e.relatedTarget) document.body.classList.remove("dragging"); };
  const onDrop = e => {
    if (state.ui.tab !== "samples" || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    document.body.classList.remove("dragging");
    importFiles(e.dataTransfer.files);
  };
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("dragleave", onDragLeave);
  document.addEventListener("drop", onDrop);
  window.addEventListener("resize", () => { if (state.ui.tab === "samples") drawWave(); });

  return {
    el,
    show() { renderList(); renderEditor(); },
    update(kind) { if (kind === "project" || kind === "ui") { renderList(); renderEditor(); } },
    meters() {},
    importFiles,
  };
}
