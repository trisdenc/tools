// App shell: top bar, tabs, transport, keyboard/MIDI input, file menu, exports.

import {
  state, subscribe, commit, setUi, undo, redo, canUndo, canRedo, loadProject, loadSaved, aram,
  engineSample, saveNow, markAllSourcesDirty, sampleMeta,
} from "../store.js";
import { Audio, renderSong, renderSfx, toWav } from "../audio.js";
import { demoProject, blankProject, exportProjectJson, floatToWav, wavToFloat, fromBase64, ARAM_LIMIT, CHANNELS, APP } from "../project.js";
import { h, $, toast, download, NOTE_KEYS, isTyping, fmtBytes } from "./util.js";
import { createSongView } from "./song.js";
import { createInstrumentsView } from "./instruments.js";
import { createSamplesView } from "./samples.js";
import { createMixerView } from "./mixer.js";
import { createSfxView } from "./sfx.js";

const audio = new Audio();
let audioOn = false;

function ensureAudio() {
  if (audioOn) { audio.resume(); return Promise.resolve(); }
  return audio.start().then(() => {
    audioOn = true;
    $("#audioHint").classList.add("hidden");
  }).catch(err => {
    toast(`Couldn't start audio: ${err.message || err}`, "error");
    throw err;
  });
}
const firstGesture = () => { ensureAudio().catch(() => {}); };
document.addEventListener("pointerdown", firstGesture, { once: true, capture: true });
document.addEventListener("keydown", firstGesture, { once: true, capture: true });

// ---------- Audition ----------
function audition(note, on, key = "k" + note) {
  if (on) {
    ensureAudio().then(() => { if (state.ui.instId) audio.noteOn(key, state.ui.instId, note); }).catch(() => {});
  } else audio.noteOff(key);
}

// ---------- Views ----------
const views = {
  song: createSongView({ audition }),
  instruments: createInstrumentsView({ audition }),
  samples: createSamplesView({ audio }),
  mixer: createMixerView(),
  sfx: createSfxView({ audio, playSfx, exportPack: exportSfxPack }),
};
let mountedTab = null;

function mount() {
  const tab = state.ui.tab;
  const v = views[tab];
  if (mountedTab !== tab) {
    $("#view").replaceChildren(v.el);
    mountedTab = tab;
    document.querySelectorAll(".tabs [data-tab]").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false"));
  }
  v.show();
}

document.querySelectorAll(".tabs [data-tab]").forEach(b => b.addEventListener("click", () => setUi({ tab: b.dataset.tab })));

// ---------- Engine sync ----------
const sentSamples = new Map();
function syncEngine() {
  const p = state.project;
  audio.setSong(p);
  const live = new Set();
  for (const s of p.samples) {
    live.add(s.id);
    const es = engineSample(s.id);
    if (!es) continue;
    const prev = sentSamples.get(s.id);
    if (!prev || prev.brr !== es.brr || prev.baseNote !== es.baseNote || prev.fineTune !== es.fineTune || prev.rate !== es.rate || prev.loop !== es.loop || prev.loopBlock !== es.loopBlock) {
      audio.setSample(s.id, es);
      sentSamples.set(s.id, es);
    }
  }
  for (const id of [...sentSamples.keys()]) if (!live.has(id)) { audio.removeSample(id); sentSamples.delete(id); }
}

// ---------- Top bar ----------
const title = $("#title"), bpm = $("#bpm"), tpr = $("#tpr");
title.addEventListener("change", () => commit(p => { p.meta.title = title.value.trim() || "Untitled"; }));
bpm.addEventListener("change", () => commit(p => { p.meta.bpm = Math.max(32, Math.min(400, Math.round(+bpm.value) || 120)); }));
tpr.addEventListener("change", () => commit(p => { p.meta.ticksPerRow = Math.max(1, Math.min(31, Math.round(+tpr.value) || 6)); }));
$("#strict").addEventListener("change", e => commit(p => { p.meta.strictAramLimit = e.target.checked; }));
$("#octDown").addEventListener("click", () => setUi({ octave: Math.max(0, state.ui.octave - 1) }));
$("#octUp").addEventListener("click", () => setUi({ octave: Math.min(8, state.ui.octave + 1) }));
$("#editMode").addEventListener("click", () => setUi({ editMode: !state.ui.editMode }));
$("#undo").addEventListener("click", undo);
$("#redo").addEventListener("click", redo);
$("#playSong").addEventListener("click", playSong);
$("#playPattern").addEventListener("click", playPattern);
$("#stop").addEventListener("click", () => audio.stop());

function renderTop() {
  const p = state.project, ui = state.ui;
  if (document.activeElement !== title) title.value = p.meta.title;
  if (document.activeElement !== bpm) bpm.value = p.meta.bpm;
  if (document.activeElement !== tpr) tpr.value = p.meta.ticksPerRow;
  $("#strict").checked = !!p.meta.strictAramLimit;
  $("#octave").textContent = `Oct ${ui.octave}`;
  $("#editMode").setAttribute("aria-pressed", ui.editMode ? "true" : "false");
  $("#undo").disabled = !canUndo();
  $("#redo").disabled = !canRedo();
  const u = aram();
  const scale = Math.max(ARAM_LIMIT, u.total);
  const seg = (bytes, color, label) => h("span", { style: { width: `${(bytes / scale) * 100}%`, background: color }, title: `${label}: ${fmtBytes(bytes)}` });
  $("#aramBar").replaceChildren(
    seg(u.driver, "#8a8a93", "Driver"),
    seg(u.sequence, "#8e4ec6", "Sequence data"),
    seg(u.samples, "#0090ff", "Samples (BRR)"),
    seg(u.echo, "#12a594", "Echo buffer"));
  $("#aramText").textContent = `${(u.total / 1024).toFixed(1)} / 64 KB${u.over ? " · over!" : ""}`;
  $("#aram").title = `ARAM: driver ${fmtBytes(u.driver)} · sequence ${fmtBytes(u.sequence)} · samples ${fmtBytes(u.samples)} · echo ${fmtBytes(u.echo)}`;
  $("#aram").classList.toggle("over", u.over && !!p.meta.strictAramLimit);
}

function renderPos(m) {
  const pos = $("#pos");
  if (!m || (!m.playing && !m.sfxId)) { pos.textContent = "Stopped"; return; }
  const parts = [];
  if (m.playing) parts.push(`Order ${String(m.order).padStart(2, "0")} · Row ${String(m.row).padStart(2, "0")}`);
  if (m.sfxId) parts.push("SFX");
  pos.textContent = parts.join(" · ");
}

audio.onMeters = m => {
  state.meters = m;
  renderPos(m);
  views[state.ui.tab]?.meters(m);
};

// ---------- Transport ----------
function playSong() {
  ensureAudio().then(() => audio.play({ mode: "song", order: state.ui.playOrder || 0, row: 0, loop: true })).catch(() => {});
}
function playPattern() {
  if (!state.ui.patternId) return;
  ensureAudio().then(() => audio.play({ mode: "pattern", patternId: state.ui.patternId, row: 0 })).catch(() => {});
}
function playSfx(id, overMusic) {
  ensureAudio().then(() => {
    if (overMusic && !state.meters?.playing) audio.play({ mode: "song", order: state.ui.playOrder || 0, row: 0, loop: true });
    if (overMusic) setTimeout(() => audio.sfx(id), state.meters?.playing ? 0 : 900);
    else audio.sfx(id);
  }).catch(() => {});
}

// ---------- Keyboard ----------
const heldKeys = new Map();
document.addEventListener("keydown", e => {
  if (isTyping(e)) return;
  if (document.querySelector("dialog[open]")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.code === "KeyZ") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.code === "KeyY") { e.preventDefault(); redo(); return; }
  if (mod && e.code === "KeyS") { e.preventDefault(); saveProjectFile(); return; }
  if (mod || e.altKey) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (state.meters?.playing) audio.stop();
    else if (e.shiftKey) playPattern();
    else playSong();
    return;
  }
  if (e.code === "Escape") { setUi({ editMode: !state.ui.editMode }); return; }
  if (e.code === "BracketLeft") { setUi({ octave: Math.max(0, state.ui.octave - 1) }); return; }
  if (e.code === "BracketRight") { setUi({ octave: Math.min(8, state.ui.octave + 1) }); return; }
  if (e.code in NOTE_KEYS && !e.repeat && !heldKeys.has(e.code)) {
    const note = Math.max(0, Math.min(127, (state.ui.octave + 1) * 12 + NOTE_KEYS[e.code]));
    heldKeys.set(e.code, note);
    audition(note, true, "kb" + e.code);
    e.preventDefault();
  }
});
document.addEventListener("keyup", e => {
  if (heldKeys.has(e.code)) { audition(heldKeys.get(e.code), false, "kb" + e.code); heldKeys.delete(e.code); }
});
window.addEventListener("blur", () => {
  for (const code of heldKeys.keys()) audio.noteOff("kb" + code);
  heldKeys.clear();
});

// ---------- MIDI ----------
async function connectMidi() {
  if (!navigator.requestMIDIAccess) { toast("This browser doesn't support Web MIDI. Try Chrome or Edge.", "error"); return; }
  try {
    const access = await navigator.requestMIDIAccess();
    const attach = () => {
      let n = 0;
      for (const input of access.inputs.values()) { input.onmidimessage = onMidi; n++; }
      return n;
    };
    const n = attach();
    access.onstatechange = attach;
    toast(n ? `MIDI connected (${n} input${n === 1 ? "" : "s"})` : "MIDI is on, but no keyboard is plugged in yet.");
  } catch {
    toast("MIDI access was blocked.", "error");
  }
}
function onMidi(e) {
  const [st, note, vel] = e.data;
  const type = st & 0xF0;
  if (type === 0x90 && vel > 0) {
    audition(note, true, "midi" + note);
    const song = views.song;
    if (state.ui.editMode && state.ui.tab === "song" && state.ui.view === "tracker" && song.editor?.edit) {
      const fields = { note };
      if (state.ui.instId) fields.instId = state.ui.instId;
      song.editor.edit(fields);
    }
  } else if (type === 0x80 || (type === 0x90 && vel === 0)) {
    audition(note, false, "midi" + note);
  }
}

// ---------- File menu ----------
const menu = $("#fileMenu");
menu.addEventListener("click", e => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  menu.open = false;
  ({
    new: () => { if (confirm("Start a new empty project? Your current project will be replaced (save it first if you want to keep it).")) startProject(blankProject()); },
    demo: () => { if (confirm("Load the demo song? Your current project will be replaced (save it first if you want to keep it).")) startProject(demoProject()); },
    open: () => $("#openFile").click(),
    save: saveProjectFile,
    json: exportJson,
    wav: () => $("#wavDialog").showModal(),
    stems: exportStems,
    sfxpack: exportSfxPack,
    midi: connectMidi,
    help: () => $("#helpDialog").showModal(),
    about: () => { $("#aboutVersion").textContent = APP.version; $("#aboutDialog").showModal(); },
  })[act]?.();
});
document.addEventListener("click", e => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
$("#openFile").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) openFile(f); });
$("#wavDialog").addEventListener("close", () => {
  if ($("#wavDialog").returnValue === "ok") exportWav(+$("#wavRate").value, $("#wavLoop").checked);
});

function startProject({ project, sources }) {
  audio.panic();
  loadProject(project, sources);
  markAllSourcesDirty();
  saveNow();
  setUi({ tab: "song" });
}

const safeName = () => (state.project.meta.title || "Untitled").replace(/[\\/:*?"<>|]+/g, "_");

let jszip = null;
function loadJsZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (!jszip) {
    jszip = new Promise((resolve, reject) => {
      const s = h("script", { src: "vendor/jszip.min.js" });
      s.onload = () => resolve(window.JSZip);
      s.onerror = () => reject(new Error("Couldn't load the zip library"));
      document.head.append(s);
    });
  }
  return jszip;
}

async function projectZipBlob() {
  const JSZip = await loadJsZip();
  const zip = new JSZip();
  const json = exportProjectJson(state.project, id => state.bank.get(id)?.brr, { embedBrr: false });
  zip.file("project.json", JSON.stringify(json, null, 2));
  for (const s of state.project.samples) {
    const b = state.bank.get(s.id);
    if (b?.brr) zip.file(`samples/${s.id}.brr`, b.brr);
    if (b?.source) zip.file(`sources/${s.id}.wav`, floatToWav(b.source.data, b.source.rate));
  }
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}

async function saveProjectFile() {
  try {
    download(await projectZipBlob(), `${safeName()}.snesproj`);
    toast("Project saved");
  } catch (e) { toast(`Save failed: ${e.message || e}`, "error"); }
}

function exportJson() {
  const json = exportProjectJson(state.project, id => state.bank.get(id)?.brr, { embedBrr: true });
  download(new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }), `${safeName()}.json`);
}

async function openFile(file) {
  try {
    let json, sources = {}, encoded = {};
    if (/\.json$/i.test(file.name)) {
      json = JSON.parse(await file.text());
    } else {
      const JSZip = await loadJsZip();
      const zip = await JSZip.loadAsync(file);
      const pj = zip.file("project.json");
      if (!pj) throw new Error("No project.json inside");
      json = JSON.parse(await pj.async("string"));
      for (const s of json.samples || []) {
        const src = zip.file(`sources/${s.id}.wav`);
        if (src) { const f = wavToFloat(await src.async("uint8array")); if (f) sources[s.id] = f; }
        const bf = zip.file(s.brrFile || `samples/${s.id}.brr`);
        if (bf) s._brr = await bf.async("uint8array");
      }
    }
    for (const s of json.samples || []) {
      const brr = s._brr || (s.brrBase64 ? fromBase64(s.brrBase64) : null);
      delete s._brr; delete s.brrBase64; delete s.brrFile;
      if (brr && !sources[s.id]) encoded[s.id] = { brr, loop: !!s.loopEnabled, loopBlock: s.loopStartBlock | 0, rate: s.sampleRate || 32000, hash: "raw" };
    }
    audio.panic();
    loadProject(json, sources, encoded);
    markAllSourcesDirty();
    saveNow();
    setUi({ tab: "song" });
    toast(`Opened ${file.name}`);
  } catch (e) {
    toast(`Couldn't open ${file.name}: ${e.message || e}`, "error");
  }
}

function busy(text) {
  const box = h("div", { class: "busy", role: "alert" }, h("div", null, text));
  document.body.append(box);
  return { set: t => { box.firstChild.textContent = t; }, done: () => box.remove() };
}

function engineSamples() {
  const m = new Map();
  for (const s of state.project.samples) { const es = engineSample(s.id); if (es) m.set(s.id, es); }
  return m;
}

function strictBlocked() {
  if (state.project.meta.strictAramLimit && aram().over) {
    toast("The project is over the 64 KB ARAM limit. Free some space or turn off Strict 64 KB to export.", "error");
    return true;
  }
  return false;
}

async function exportWav(rate, loop) {
  if (strictBlocked()) return;
  const b = busy("Rendering…");
  try {
    const res = await renderSong(state.project, engineSamples(), { loop, onProgress: s => b.set(`Rendering… ${s.toFixed(0)} s`) });
    download(toWav(res, rate), `${safeName()}.wav`);
    toast(loop ? `Exported with loop points (loop starts at ${(res.loopStart / 32000).toFixed(2)} s)` : "Exported");
  } catch (e) { toast(`Export failed: ${e.message || e}`, "error"); }
  b.done();
}

async function exportStems() {
  if (strictBlocked()) return;
  const b = busy("Rendering stems…");
  try {
    const JSZip = await loadJsZip();
    const zip = new JSZip();
    const used = Array.from({ length: CHANNELS }, (_, c) => state.project.arrangement.some(id => state.project.patterns.find(p => p.id === id)?.channels[c]?.length));
    for (let c = 0; c < CHANNELS; c++) {
      if (!used[c]) continue;
      b.set(`Rendering voice ${c + 1} of 8…`);
      const res = await renderSong(state.project, engineSamples(), { loop: true, soloChannel: c });
      zip.file(`${safeName()} - voice ${c + 1}.wav`, toWav(res));
    }
    download(await zip.generateAsync({ type: "blob" }), `${safeName()} - stems.zip`);
    toast("Stems exported (each voice with its own echo, same loop points)");
  } catch (e) { toast(`Export failed: ${e.message || e}`, "error"); }
  b.done();
}

async function exportSfxPack() {
  if (!state.project.sfxBank.length) { toast("There are no sound effects to export."); return; }
  if (strictBlocked()) return;
  const b = busy("Rendering sound effects…");
  try {
    const JSZip = await loadJsZip();
    const zip = new JSZip();
    const names = new Set();
    for (const sfx of state.project.sfxBank) {
      b.set(`Rendering ${sfx.name}…`);
      const res = await renderSfx(state.project, engineSamples(), sfx.id);
      let n = sfx.name.replace(/[\\/:*?"<>|]+/g, "_") || sfx.id, k = 1;
      while (names.has(n.toLowerCase())) n = `${sfx.name} ${++k}`;
      names.add(n.toLowerCase());
      zip.file(`${n}.wav`, toWav(res));
    }
    download(await zip.generateAsync({ type: "blob" }), `${safeName()} - SFX.zip`);
    toast(`Exported ${state.project.sfxBank.length} sound effects`);
  } catch (e) { toast(`Export failed: ${e.message || e}`, "error"); }
  b.done();
}

// ---------- Store wiring ----------
subscribe(kind => {
  if (kind === "project" || kind === "project-silent" || kind === "bank") {
    syncEngine();
    renderTop();
  }
  if (kind === "project" || kind === "project-silent") views[state.ui.tab]?.update(kind);
  if (kind === "ui") {
    renderTop();
    if (mountedTab !== state.ui.tab) mount();
    else views[state.ui.tab]?.update("ui");
  }
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveNow(); });

// ---------- Start ----------
(async () => {
  const saved = await loadSaved();
  if (saved) {
    try { loadProject(saved.project, saved.sources, saved.encoded); }
    catch (e) { console.error(e); startProject(demoProject()); toast("Your saved project couldn't be loaded, so the demo song was opened instead.", "error"); }
  } else {
    const d = demoProject();
    loadProject(d.project, d.sources);
    markAllSourcesDirty();
  }
  mount();
  renderTop();
})();

// Debug/test hook
window.hiromSound = { app: APP, state, audio, views, sampleMeta, openFile, projectZipBlob };
