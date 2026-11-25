// App state, undo/redo, sample bank, pattern editing operations and persistence.

import { buildSample } from "./brr.js";
import { decodeBrrStream } from "./dsp.js";
import { aramUsage, normalizeProject, CHANNELS, newId } from "./project.js";

export const state = {
  project: null,
  bank: new Map(), // sampleId -> { brr, loop, loopBlock, rate, pcm?, decoded?, snr?, source?, hash }
  ui: {
    tab: "song", patternId: null, view: "roll", channel: 0, instId: null, sampleId: null, sfxId: null,
    octave: 4, editStep: 1, noteLen: 4, editMode: false, selRow: 0, selCh: 0, playOrder: 0, follow: true, zoom: 1,
  },
  meters: null,
};

const listeners = new Set();
export const subscribe = fn => (listeners.add(fn), () => listeners.delete(fn));
export function emit(kind, detail) { for (const fn of listeners) fn(kind, detail); }

// ---------- Undo ----------
let undoStack = [], redoStack = [], lastCoalesce = null, lastCoalesceAt = 0;
const snapshot = () => JSON.stringify(state.project);

export function commit(mutate, { undo = true, coalesce = null, silent = false } = {}) {
  if (undo) {
    const now = performance.now();
    if (!(coalesce && coalesce === lastCoalesce && now - lastCoalesceAt < 1500)) {
      undoStack.push(snapshot());
      if (undoStack.length > 200) undoStack.shift();
      redoStack = [];
    }
    lastCoalesce = coalesce; lastCoalesceAt = now;
  }
  mutate(state.project);
  scheduleSave();
  emit(silent ? "project-silent" : "project");
}

function restore(json) {
  state.project = JSON.parse(json);
  for (const s of state.project.samples) encodeSample(s.id);
  fixUiRefs();
  scheduleSave();
  emit("project");
  emit("ui");
}
export function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); lastCoalesce = null; }
export function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); lastCoalesce = null; }
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export function setUi(patch) {
  Object.assign(state.ui, patch);
  emit("ui");
}

// Keep UI selections pointing at things that exist.
export function fixUiRefs() {
  const p = state.project, ui = state.ui;
  if (!p.patterns.some(x => x.id === ui.patternId)) ui.patternId = p.arrangement[0] || p.patterns[0]?.id || null;
  if (!p.instruments.some(x => x.id === ui.instId)) ui.instId = p.instruments[0]?.id || null;
  if (!p.samples.some(x => x.id === ui.sampleId)) ui.sampleId = p.samples[0]?.id || null;
  if (!p.sfxBank.some(x => x.id === ui.sfxId)) ui.sfxId = p.sfxBank[0]?.id || null;
  ui.playOrder = Math.min(ui.playOrder, Math.max(0, p.arrangement.length - 1));
}

export function loadProject(project, sources = {}, encoded = {}) {
  state.project = normalizeProject(project);
  state.bank = new Map();
  for (const s of state.project.samples) {
    const src = sources[s.id] || null;
    const enc = encoded[s.id] || null;
    state.bank.set(s.id, { source: src, ...(enc || {}) });
    s.hasSource = !!src;
    encodeSample(s.id);
  }
  undoStack = []; redoStack = [];
  fixUiRefs();
  scheduleSave();
  emit("project");
  emit("ui");
  emit("bank");
}

// ---------- Lookups ----------
export const pattern = id => state.project.patterns.find(p => p.id === id);
export const currentPattern = () => pattern(state.ui.patternId);
export const instrument = id => state.project.instruments.find(i => i.id === id);
export const sampleMeta = id => state.project.samples.find(s => s.id === id);
export const instIndex = id => state.project.instruments.findIndex(i => i.id === id);
export const sampleBytes = id => state.bank.get(id)?.brr?.length || 0;
export const aram = () => aramUsage(state.project, sampleBytes);

// ---------- Samples ----------
const paramsHash = (s, b) => JSON.stringify(s.params) + `|${b.source.rate}|${b.source.data.length}`;

// (Re)encode a sample if its source or settings changed. Returns true if it changed.
export function encodeSample(id) {
  const s = sampleMeta(id), b = state.bank.get(id);
  if (!s || !b) return false;
  if (!b.source) {
    if (b.brr) {
      s.byteLength = b.brr.length;
      b.rate = s.sampleRate || 32000;
    }
    return false;
  }
  const hash = paramsHash(s, b);
  if (b.hash === hash && b.brr) {
    s.byteLength = b.brr.length;
    return false;
  }
  const built = buildSample(b.source, s.params);
  Object.assign(b, built, { hash });
  s.sampleRate = built.rate;
  s.loopEnabled = built.loop;
  s.loopStartBlock = built.loopBlock;
  s.byteLength = built.brr.length;
  emit("bank", id);
  return true;
}

// Decoded preview + stats for the BRR Studio (computed lazily).
export function samplePreview(id) {
  const b = state.bank.get(id), s = sampleMeta(id);
  if (!b || !b.brr) return null;
  if (!b.decoded) {
    if (b.source) { Object.assign(b, buildSample(b.source, s.params)); }
    else b.decoded = decodeBrrStream(b.brr);
  }
  return b;
}

export function engineSample(id) {
  const s = sampleMeta(id), b = state.bank.get(id);
  if (!s || !b || !b.brr) return null;
  return { brr: b.brr, loop: !!b.loop, loopBlock: b.loopBlock | 0, rate: s.sampleRate || b.rate || 32000, baseNote: s.baseNote ?? 60, fineTune: s.fineTune || 0 };
}

export function addSample({ name, source = null, params = null, brr = null, loop = false, loopBlock = 0, rate = 32000, baseNote = 60, fineTune = 0 }) {
  const id = newId("smp");
  const meta = { id, name, loopEnabled: loop, loopStartBlock: loopBlock, baseNote, fineTune, sampleRate: rate, params, byteLength: 0, hasSource: !!source };
  state.bank.set(id, source ? { source } : { source: null, brr, loop, loopBlock, rate });
  commit(p => { p.samples.push(meta); });
  encodeSample(id);
  dirtySources.add(id);
  scheduleSave();
  return id;
}

// ---------- Pattern editing ----------
export const ops = {
  events: (pat, ch) => pat.channels[ch],
  at: (pat, ch, row) => pat.channels[ch].find(e => e.row === row),

  put(pat, ch, ev) {
    const list = pat.channels[ch];
    const i = list.findIndex(e => e.row >= ev.row);
    if (i < 0) list.push(ev);
    else if (list[i].row === ev.row) list[i] = ev;
    else list.splice(i, 0, ev);
    return ev;
  },

  remove(pat, ch, row) {
    const list = pat.channels[ch];
    const i = list.findIndex(e => e.row === row);
    if (i >= 0) list.splice(i, 1);
  },

  // Drop an event that no longer carries anything.
  tidy(pat, ch, row) {
    const e = ops.at(pat, ch, row);
    if (e && e.note == null && !e.instId && e.volL == null && e.volR == null && !e.fx) ops.remove(pat, ch, row);
  },

  // Note spans for drawing/editing: a note lasts until the next note or OFF.
  spans(pat, ch) {
    const out = [];
    let open = null;
    for (const ev of pat.channels[ch]) {
      if (ev.row >= pat.lengthRows) break;
      if (typeof ev.note === "number") {
        const glide = ev.fx === "TONE_PORTA" && !!open;
        if (open) open.end = ev.row;
        open = { row: ev.row, end: pat.lengthRows, note: ev.note, ev, off: null, cut: !!open && !glide, glide };
        out.push(open);
      } else if (ev.note === "OFF") {
        if (open) { open.end = ev.row; open.off = ev; open = null; }
      }
    }
    return out;
  },

  nextBoundary(pat, ch, row) {
    return pat.channels[ch].find(e => e.row > row && (typeof e.note === "number" || e.note === "OFF"));
  },

  setNote(pat, ch, row, note, len, instId, extra = {}) {
    const endRow = row + Math.max(1, len);
    // OFFs inside the new note would cut it short
    for (const e of pat.channels[ch].slice()) {
      if (e.row > row && e.row < endRow && e.note === "OFF") { e.note = null; ops.tidy(pat, ch, e.row); }
    }
    let ev = ops.at(pat, ch, row);
    if (ev) { ev.note = note; if (instId) ev.instId = instId; Object.assign(ev, extra); }
    else ev = ops.put(pat, ch, { row, note, instId, ...extra });
    const next = ops.nextBoundary(pat, ch, row);
    if ((!next || next.row > endRow) && endRow < pat.lengthRows) {
      const at = ops.at(pat, ch, endRow);
      if (at) { if (at.note == null) at.note = "OFF"; }
      else ops.put(pat, ch, { row: endRow, note: "OFF" });
    }
    return ev;
  },

  isPureOff: e => e && e.note === "OFF" && !e.fx && e.volL == null && !e.instId,

  deleteSpan(pat, ch, span) {
    const ownOff = ops.isPureOff(span.off) ? span.off : null;
    if (span.cut) {
      // Keep the previous note ending where it did
      span.ev.note = "OFF";
      delete span.ev.instId;
    } else {
      // Remove the note with its instrument/volume; keep an effect if one was set
      span.ev.note = null;
      delete span.ev.instId; delete span.ev.volL; delete span.ev.volR;
      ops.tidy(pat, ch, span.row);
    }
    if (ownOff) ops.remove(pat, ch, ownOff.row);
  },

  moveSpan(pat, ch, span, row, note) {
    const len = span.end - span.row;
    const { instId, volL, volR, fx, fxVal } = span.ev;
    ops.deleteSpan(pat, ch, span);
    row = Math.max(0, Math.min(pat.lengthRows - 1, row));
    const extra = {};
    if (volL != null) { extra.volL = volL; extra.volR = volR; }
    if (fx) { extra.fx = fx; extra.fxVal = fxVal; }
    return ops.setNote(pat, ch, row, note, Math.min(len, pat.lengthRows - row), instId, extra);
  },

  resizeSpan(pat, ch, span, len) {
    if (ops.isPureOff(span.off)) ops.remove(pat, ch, span.off.row);
    else if (span.off) { span.off.note = null; ops.tidy(pat, ch, span.off.row); }
    const endRow = span.row + Math.max(1, len);
    const next = ops.nextBoundary(pat, ch, span.row);
    if ((!next || next.row > endRow) && endRow < pat.lengthRows) {
      const at = ops.at(pat, ch, endRow);
      if (at) { if (at.note == null) at.note = "OFF"; }
      else ops.put(pat, ch, { row: endRow, note: "OFF" });
    }
  },

  // Tracker field edits
  edit(pat, ch, row, fields) {
    let ev = ops.at(pat, ch, row);
    if (!ev) ev = ops.put(pat, ch, { row, note: null });
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) delete ev[k];
      else ev[k] = v;
    }
    if (ev.note === undefined) ev.note = null;
    ops.tidy(pat, ch, row);
  },

  clearChannel(pat, ch) { pat.channels[ch] = []; },
};

export function newPattern(kind = "music", name) {
  const n = state.project.patterns.filter(p => (p.kind || "music") === kind).length + 1;
  return { id: newId("pat"), name: name || (kind === "sfx" ? `SFX ${n}` : `Pattern ${n}`), kind, lengthRows: kind === "sfx" ? 16 : 64, channels: Array.from({ length: CHANNELS }, () => []) };
}

// ---------- Persistence (IndexedDB) ----------
// Storage name kept from the first release so existing saved projects still load.
const DB_NAME = "snes-studio", STORE = "kv";
let dbPromise = null;
const dirtySources = new Set();
export const markSourceDirty = id => dirtySources.add(id);

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const result = fn(s);
    t.oncomplete = () => resolve(result && "result" in result ? result.result : result);
    t.onerror = () => reject(t.error);
  }));
}

let saveTimer = null;
export const saveStatus = { saving: false, lastSaved: 0, error: null };
export function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}

export async function saveNow() {
  if (!state.project || typeof indexedDB === "undefined") return;
  try {
    const p = state.project;
    await tx("readwrite", s => {
      s.put(p, "project");
      for (const sm of p.samples) {
        const b = state.bank.get(sm.id);
        if (!b) continue;
        if (b.source && dirtySources.has(sm.id)) s.put(b.source, "src:" + sm.id);
        if (b.brr) s.put({ brr: b.brr, loop: b.loop, loopBlock: b.loopBlock, rate: b.rate, hash: b.hash || "raw" }, "enc:" + sm.id);
      }
    });
    dirtySources.clear();
    saveStatus.lastSaved = Date.now();
    saveStatus.error = null;
    // Let HiROM Map (another tab) know, so its music links pick up the new version.
    try {
      const ch = new BroadcastChannel("hirom-studio");
      ch.postMessage({ app: "sound", type: "saved" });
      ch.close();
    } catch {
      // BroadcastChannel unavailable: Map refreshes when its tab is focused instead.
    }
  } catch (e) {
    saveStatus.error = String(e.message || e);
  }
  emit("saved");
}

export async function loadSaved() {
  if (typeof indexedDB === "undefined") return null;
  try {
    const all = await tx("readonly", s => {
      const out = {};
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) { out[c.key] = c.value; c.continue(); }
      };
      return out;
    });
    if (!all.project) return null;
    const sources = {}, encoded = {};
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith("src:")) sources[k.slice(4)] = v;
      if (k.startsWith("enc:")) encoded[k.slice(4)] = v;
    }
    // Remove data for samples that were deleted
    const keep = new Set(all.project.samples.map(s => s.id));
    const stale = Object.keys(all).filter(k => (k.startsWith("src:") || k.startsWith("enc:")) && !keep.has(k.slice(4)));
    if (stale.length) tx("readwrite", s => stale.forEach(k => s.delete(k)));
    return { project: all.project, sources, encoded };
  } catch {
    return null;
  }
}

export async function clearSaved() {
  await tx("readwrite", s => s.clear());
}

// Mark every source as needing to be written (after loading a project file)
export function markAllSourcesDirty() {
  for (const s of state.project.samples) if (state.bank.get(s.id)?.source) dirtySources.add(s.id);
}
