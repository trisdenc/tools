// Song tab: arrangement, pattern list, piano roll / tracker editor and row inspector.

import { state, commit, setUi, ops, currentPattern, pattern, newPattern, instIndex } from "../store.js";
import { h, fill, select, CHANNEL_COLORS, hex2 } from "./util.js";
import { PianoRoll } from "./pianoroll.js";
import { Tracker } from "./tracker.js";
import { FX_TYPES, FX_BY_ID, notePretty, newId } from "../project.js";

const ROW_CHOICES = [8, 16, 24, 32, 48, 64, 96, 128];

export function createSongView({ audition }) {
  const side = h("aside", { class: "side" });
  const toolbar = h("div", { class: "toolbar" });
  const canvasWrap = h("div", { class: "canvas-wrap" });
  const inspector = h("div", { class: "card inspector" });
  const help = h("p", { class: "muted small", style: { margin: 0 } });
  const editor = h("section", { class: "editor" }, toolbar, canvasWrap, inspector, help);
  const el = h("div", { class: "split" }, side, editor);
  let comp = null, compKind = null;

  const aud = (note, on, key) => audition(note, on, key || "ed" + note);

  function ensureEditor() {
    if (compKind === state.ui.view && comp) return;
    comp?.destroy();
    canvasWrap.className = "canvas-wrap" + (state.ui.view === "tracker" ? " tracker" : "");
    comp = state.ui.view === "tracker" ? new Tracker(canvasWrap, { audition: aud }) : new PianoRoll(canvasWrap, { audition: aud });
    compKind = state.ui.view;
    if (compKind === "roll") requestAnimationFrame(() => comp.focusNotes());
  }

  // ---------- Sidebar ----------
  function renderSide() {
    const p = state.project, ui = state.ui;
    const patOptions = p.patterns.map(pt => [pt.id, pt.name + (pt.kind === "sfx" ? " (SFX)" : "")]);
    const orders = h("div", { class: "list" }, p.arrangement.map((id, i) => {
      const isLoop = (p.meta.loopOrder | 0) === i;
      return h("div", { class: "order-row", "data-order": i, "aria-current": ui.playOrder === i ? "true" : null },
        h("span", { class: "idx", title: "Edit this pattern and play from here", onclick: () => setUi({ playOrder: i, patternId: id }) }, String(i).padStart(2, "0")),
        select(patOptions, id, v => commit(pr => { pr.arrangement[i] = v; }), { "aria-label": `Order ${i}` }),
        h("button", { class: "iconbtn loopmark" + (isLoop ? " on" : ""), title: isLoop ? "The song loops back to here" : "Loop back to here at the end of the song", onclick: () => commit(pr => { pr.meta.loopOrder = i; }) }, "⟲"),
        h("button", { class: "iconbtn", title: "Move up", disabled: i === 0, onclick: () => commit(pr => { const a = pr.arrangement; [a[i - 1], a[i]] = [a[i], a[i - 1]]; }) }, "↑"),
        h("button", { class: "iconbtn", title: "Move down", disabled: i === p.arrangement.length - 1, onclick: () => commit(pr => { const a = pr.arrangement; [a[i + 1], a[i]] = [a[i], a[i + 1]]; }) }, "↓"),
        h("button", { class: "iconbtn", title: "Remove from song", onclick: () => commit(pr => {
          pr.arrangement.splice(i, 1);
          if (pr.meta.loopOrder >= pr.arrangement.length) pr.meta.loopOrder = Math.max(0, pr.arrangement.length - 1);
        }) }, "✕"));
    }));
    const pats = h("div", { class: "list" }, p.patterns.map(pt => {
      const used = p.arrangement.filter(id => id === pt.id).length;
      return h("button", { class: "item", "aria-current": pt.id === ui.patternId ? "true" : null, onclick: () => setUi({ patternId: pt.id }) },
        h("span", { class: "name" }, pt.name),
        pt.kind === "sfx" ? h("span", { class: "tag" }, "SFX") : used ? h("span", { class: "meta" }, `×${used}`) : null,
        h("span", { class: "meta" }, `${pt.lengthRows} rows`));
    }));
    fill(side, 
      h("div", { class: "card" },
        h("h2", null, "Song order"),
        p.arrangement.length ? orders : h("p", { class: "muted small" }, "The song is empty. Add a pattern below."),
        h("div", { class: "row", style: { marginTop: "8px" } },
          h("button", { class: "tbtn small", onclick: () => commit(pr => { pr.arrangement.push(ui.patternId); }), disabled: !ui.patternId }, "+ Add current pattern"))),
      h("div", { class: "card" },
        h("h2", null, "Patterns"),
        pats,
        h("div", { class: "row tight", style: { marginTop: "8px" } },
          h("button", { class: "tbtn small", onclick: () => { const np = newPattern("music"); commit(pr => { pr.patterns.push(np); }); setUi({ patternId: np.id }); } }, "+ New"),
          h("button", { class: "tbtn small", onclick: duplicatePattern, disabled: !ui.patternId }, "Duplicate"),
          h("button", { class: "tbtn small", onclick: deletePattern, disabled: !ui.patternId }, "Delete"))));
  }

  function duplicatePattern() {
    const src = currentPattern();
    if (!src) return;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = newId("pat");
    copy.name = src.name + " copy";
    commit(p => { p.patterns.splice(p.patterns.indexOf(src) + 1, 0, copy); });
    setUi({ patternId: copy.id });
  }

  function deletePattern() {
    const pt = currentPattern();
    if (!pt) return;
    const p = state.project;
    const uses = p.arrangement.filter(id => id === pt.id).length + p.sfxBank.filter(s => s.patternId === pt.id).length;
    if (uses && !confirm(`"${pt.name}" is used ${uses} time(s) in the song or SFX bank. Delete it and remove those uses?`)) return;
    commit(pr => {
      pr.patterns = pr.patterns.filter(x => x.id !== pt.id);
      pr.arrangement = pr.arrangement.filter(id => id !== pt.id);
      pr.sfxBank = pr.sfxBank.filter(s => s.patternId !== pt.id);
      pr.meta.loopOrder = Math.min(pr.meta.loopOrder | 0, Math.max(0, pr.arrangement.length - 1));
    });
    setUi({ patternId: p.patterns[0]?.id || null });
  }

  // ---------- Toolbar ----------
  function renderToolbar() {
    const pat = currentPattern(), ui = state.ui, p = state.project;
    if (!pat) { fill(toolbar, h("p", { class: "muted" }, "No pattern selected.")); return; }
    const instOptions = p.instruments.map((i, n) => [i.id, `${hex2(n + 1)} ${i.name}`]);
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Editor view" },
      h("button", { "aria-pressed": ui.view === "roll" ? "true" : "false", onclick: () => setUi({ view: "roll" }) }, "Piano roll"),
      h("button", { "aria-pressed": ui.view === "tracker" ? "true" : "false", onclick: () => setUi({ view: "tracker" }) }, "Tracker"));
    const chans = h("div", { class: "chans", role: "group", "aria-label": "Voice" }, CHANNEL_COLORS.map((c, i) => {
      const on = ui.channel === i;
      return h("button", {
        "aria-pressed": on ? "true" : "false", title: `Voice ${i + 1}`,
        style: { background: on ? c : null, borderColor: c },
        onclick: () => { setUi({ channel: i, selCh: i }); comp?.focusNotes?.(); },
      }, String(i + 1));
    }));
    const nameInput = h("input", { class: "inp", value: pat.name, "aria-label": "Pattern name", style: { width: "150px" } });
    nameInput.addEventListener("change", () => commit(() => { pat.name = nameInput.value.trim() || pat.name; }));
    fill(toolbar, 
      nameInput,
      h("label", { class: "inline" }, "Rows", select(ROW_CHOICES.map(n => [n, n]), pat.lengthRows, v => commit(() => { pat.lengthRows = +v; }), { class: "inp" })),
      seg,
      h("label", { class: "inline" }, "Instrument", select(instOptions, ui.instId, v => setUi({ instId: v }), { class: "inp" })),
      ui.view === "roll" ? chans : null,
      ui.view === "roll"
        ? h("label", { class: "inline", title: "Length of new notes (rows)" }, "Length", select([1, 2, 3, 4, 6, 8, 12, 16, 32].map(n => [n, n]), ui.noteLen, v => { state.ui.noteLen = +v; }, { class: "inp" }))
        : h("label", { class: "inline", title: "Rows to move down after typing a note" }, "Step", select([0, 1, 2, 3, 4, 8].map(n => [n, n]), ui.editStep, v => { state.ui.editStep = +v; }, { class: "inp" })),
      h("label", { class: "check small" }, h("input", { type: "checkbox", checked: ui.follow, onchange: e => { state.ui.follow = e.target.checked; } }), "Follow playback"),
      ui.view === "roll" ? h("label", { class: "check small" }, h("input", { type: "checkbox", checked: ui.showAll !== false, onchange: e => { state.ui.showAll = e.target.checked; comp?.draw(); } }), "Show other voices") : null,
    );
    help.textContent = ui.view === "roll"
      ? "Click to add a note, drag to move it, drag its right edge to change length, right-click to delete. The orange notch marks a note that cuts off the previous note on the same voice (each voice can play one note at a time)."
      : "Click the grid, then turn on Edit mode (Esc) to type notes with your keyboard. Columns: note, instrument, volume (00–7F), effect + value. Effect codes: 1 slide up, 2 slide down, 3 portamento, 4 vibrato, 8 pan, E echo, M pitch mod, N noise frequency.";
  }

  // ---------- Inspector ----------
  function renderInspector() {
    const pat = currentPattern(), ui = state.ui, p = state.project;
    if (!pat) { fill(inspector, ); return; }
    const ch = ui.selCh, row = ui.selRow;
    const ev = ops.at(pat, ch, row);
    const set = fields => commit(() => ops.edit(pat, ch, row, fields));
    const noteOpts = [["", "—"], ["OFF", "Off"]];
    for (let n = 108; n >= 24; n--) noteOpts.push([n, notePretty(n)]);
    const noteVal = ev?.note == null ? "" : ev.note;
    const fx = ev?.fx ? FX_BY_ID[ev.fx] : null;
    const num = (label, value, onChange, props = {}) => {
      const i = h("input", { type: "number", value: value ?? "", placeholder: "—", ...props });
      i.addEventListener("change", () => onChange(i.value === "" ? null : Math.max(+props.min || 0, Math.min(+props.max || 255, Math.round(+i.value)))));
      return h("label", { class: "field" }, label, i);
    };
    fill(inspector, 
      h("div", { class: "field", style: { minWidth: "120px" } },
        h("span", null, "Selected cell"),
        h("strong", { style: { color: CHANNEL_COLORS[ch] } }, `Voice ${ch + 1} · Row ${row}`)),
      h("label", { class: "field" }, "Note", select(noteOpts, noteVal, v => set({ note: v === "" ? null : v === "OFF" ? "OFF" : +v }))),
      h("label", { class: "field" }, "Instrument", select([["", "—"], ...p.instruments.map((i, n) => [i.id, `${hex2(n + 1)} ${i.name}`])], ev?.instId || "", v => set({ instId: v || null }))),
      num("Volume L", ev?.volL, v => set({ volL: v, volR: ev?.volR ?? v }), { min: 0, max: 127 }),
      num("Volume R", ev?.volR, v => set({ volR: v, volL: ev?.volL ?? v }), { min: 0, max: 127 }),
      h("label", { class: "field" }, "Effect", select([["", "None"], ...FX_TYPES.map(f => [f.id, `${f.code} · ${f.name}`])], ev?.fx || "", v => set({ fx: v || null, fxVal: v ? (ev?.fxVal ?? defaultFxVal(v)) : null }))),
      fx ? num(`Value (0x${hex2(ev.fxVal)})`, ev.fxVal, v => set({ fxVal: v ?? 0 }), { min: 0, max: 255 }) : null,
      h("button", { class: "tbtn small", onclick: () => commit(() => ops.remove(pat, ch, row)), disabled: !ev }, "Clear cell"),
      fx ? h("p", { class: "fxhelp" }, fx.help) : null,
    );
  }

  function defaultFxVal(id) {
    return { PORTA_UP: 16, PORTA_DOWN: 16, TONE_PORTA: 16, VIBRATO: 0x44, PAN: 64, ECHO: 1, PMOD: 1, NOISE_FREQ: 20 }[id] ?? 0;
  }

  let lastPatternId = null;
  function renderAll() {
    if (state.ui.patternId !== lastPatternId) {
      // New pattern: start at the top-left with the cursor on row 0
      if (lastPatternId !== null) { state.ui.selRow = 0; }
      lastPatternId = state.ui.patternId;
      if (comp) { comp.scrollRow = 0; comp.scrollX = 0; if (comp.cur) comp.cur.row = state.ui.selRow; }
    }
    renderSide();
    renderToolbar();
    ensureEditor();
    renderInspector();
    if (comp instanceof Tracker) comp.syncFromUi();
    comp?.draw();
  }

  let lastOrder = -1;
  return {
    el,
    show() { renderAll(); },
    update(kind) {
      if (kind === "project" || kind === "ui") renderAll();
      else if (kind === "project-silent") comp?.draw();
    },
    meters(m) {
      const ui = state.ui;
      let row = -1;
      if (m.playing && m.patternId === ui.patternId) row = m.row;
      else if (m.sfxId) {
        const sfx = state.project.sfxBank.find(s => s.id === m.sfxId);
        if (sfx && sfx.patternId === ui.patternId) row = m.sfxRow;
      }
      comp?.setPlayRow(row);
      const ord = m.playing ? m.order : -1;
      if (ord !== lastOrder) {
        lastOrder = ord;
        side.querySelectorAll(".order-row").forEach(r => r.classList.toggle("playing", +r.dataset.order === ord));
      }
      if (m.playing && ui.follow && m.patternId && m.patternId !== ui.patternId && pattern(m.patternId)) {
        setUi({ patternId: m.patternId, playOrder: m.order });
      }
    },
    focusEditor() { comp?.canvas.focus(); },
    get editor() { return comp; },
  };
}
