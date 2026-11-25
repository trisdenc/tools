// Sound Effects tab: SFX bank, macro tools that write patterns for you, and
// preview over the music (SFX take over voices 8 and 7 like real SNES games).

import { state, commit, setUi, newPattern, pattern } from "../store.js";
import { h, fill, select, toast, hex2 } from "./util.js";
import { newId, notePretty, NOISE_RATES_HZ } from "../project.js";

const NAMES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function parseNote(str) {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(str.trim());
  if (!m) return null;
  let n = NAMES[m[1].toUpperCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return Math.max(0, Math.min(127, n + (+m[3] + 1) * 12));
}

export function createSfxView({ audio, playSfx, exportPack }) {
  const listCard = h("div", { class: "card" });
  const macros = h("div", { class: "card" });
  const el = h("div", { class: "sfx-grid" }, listCard, macros);
  let playingId = null;

  function renderList() {
    const p = state.project, ui = state.ui;
    const patOpts = p.patterns.map(pt => [pt.id, pt.name]);
    fill(listCard, 
      h("div", { class: "row", style: { marginBottom: "10px" } },
        h("h2", { style: { margin: 0 } }, "SFX bank"),
        h("span", { class: "grow" }),
        h("button", { class: "tbtn small", onclick: exportPack, disabled: !p.sfxBank.length }, "Export SFX pack (.zip)")),
      h("p", { class: "muted small", style: { marginTop: 0 } },
        "Sound effects play on voice 8 (and voice 7 for two-voice effects). While one plays, those music voices go quiet and pick up again at their next note, just like in real SNES games. Use ", h("strong", null, "▶ Over music"), " to hear it."),
      p.sfxBank.length ? null : h("p", { class: "muted" }, "No sound effects yet. Make one with the tools on the right."),
      p.sfxBank.map(sfx => {
        const nameIn = h("input", { class: "inp", value: sfx.name, "aria-label": "SFX name", style: { fontWeight: 600, width: "100%" } });
        nameIn.addEventListener("change", () => commit(() => { sfx.name = nameIn.value.trim() || sfx.name; }));
        return h("div", { class: "sfx-item" + (playingId === sfx.id ? " playing" : ""), "aria-current": ui.sfxId === sfx.id ? "true" : null, "data-sfx": sfx.id, onclick: () => { if (ui.sfxId !== sfx.id) setUi({ sfxId: sfx.id }); } },
          h("div", { class: "row tight" },
            nameIn,
            h("label", { class: "inline" }, "Voices", select([[1, "1 (voice 8)"], [2, "2 (voices 8+7)"]], sfx.channelsUsed, v => commit(() => { sfx.channelsUsed = +v; }), { class: "inp" })),
            h("label", { class: "inline" }, "Pattern", select(patOpts, sfx.patternId, v => commit(() => { sfx.patternId = v; }), { class: "inp" }))),
          h("div", { class: "row tight", style: { justifyContent: "flex-end" } },
            h("button", { class: "tbtn small primary", title: "Play this effect", onclick: e => { e.stopPropagation(); playSfx(sfx.id, false); } }, "▶"),
            h("button", { class: "tbtn small", title: "Start the song and fire this effect over it", onclick: e => { e.stopPropagation(); playSfx(sfx.id, true); } }, "▶ Over music"),
            h("button", { class: "tbtn small", title: "Edit the notes in the Song tab", onclick: e => { e.stopPropagation(); setUi({ tab: "song", patternId: sfx.patternId, view: "tracker" }); } }, "Edit"),
            h("button", { class: "iconbtn", title: "Delete", onclick: e => {
              e.stopPropagation();
              if (!confirm(`Delete "${sfx.name}"? Its pattern stays in the pattern list.`)) return;
              commit(pr => { pr.sfxBank = pr.sfxBank.filter(x => x.id !== sfx.id); });
            } }, "✕")));
      }));
  }

  // ---------- Macro tools ----------
  function instSelect(filter, preferred) {
    const list = state.project.instruments.filter(filter);
    const all = list.length ? list : state.project.instruments;
    const val = all.find(i => i.id === preferred)?.id || all[0]?.id || "";
    return select(all.map(i => [i.id, `${hex2(state.project.instruments.indexOf(i) + 1)} ${i.name}`]), val, () => {}, { class: "inp" });
  }
  const numIn = (value, min, max, width = "64px") => h("input", { type: "number", class: "inp", value, min, max, style: { width } });
  const noteIn = value => h("input", { class: "inp", value, style: { width: "64px" }, placeholder: "C5" });
  const field = (label, input) => h("label", { class: "field" }, label, input);
  const clampInt = (v, a, b) => Math.max(a, Math.min(b, Math.round(+v || 0)));

  function create(name, channelsUsed, rows, build) {
    const pat = newPattern("sfx", `SFX: ${name}`);
    pat.lengthRows = Math.min(128, Math.max(8, Math.ceil((rows + 2) / 4) * 4));
    build(pat.channels);
    pat.channels.forEach(list => list.sort((a, b) => a.row - b.row));
    const id = newId("sfx");
    commit(p => {
      p.patterns.push(pat);
      p.sfxBank.push({ id, name, channelsUsed, patternId: pat.id });
    });
    setUi({ sfxId: id });
    playSfx(id, false);
    toast(`Created "${name}". Edit its notes any time with Edit.`);
  }

  function sweepEvents(list, startNote, endNote, rows, instId, vol) {
    const tpr = state.project.meta.ticksPerRow || 6;
    const delta = endNote - startNote;
    const fx = delta >= 0 ? "PORTA_UP" : "PORTA_DOWN";
    const ticks = Math.max(1, rows * Math.max(1, tpr - 1));
    const speed = Math.max(1, Math.min(255, Math.round((Math.abs(delta) * 16) / ticks)));
    for (let r = 0; r < rows; r++) {
      const ev = { row: r, note: r === 0 ? startNote : null };
      if (r === 0) { ev.instId = instId; ev.volL = vol; ev.volR = vol; }
      if (delta) { ev.fx = fx; ev.fxVal = speed; }
      list.push(ev);
    }
    list.push({ row: rows, note: "OFF" });
  }

  function renderMacros() {
    const p = state.project;
    // Pitch sweep
    const swName = h("input", { class: "inp", value: "Laser" });
    const swInst = instSelect(i => !i.noise, "inst_lead");
    const swFrom = noteIn("C7"), swTo = noteIn("C4"), swRows = numIn(4, 1, 64);
    // Noise burst
    const nbName = h("input", { class: "inp", value: "Explosion" });
    const nbInst = instSelect(i => i.noise, "inst_boom");
    const freqOpts = NOISE_RATES_HZ.map((hz, i) => [i, `${i} · ${hz >= 1000 ? hz / 1000 + "k" : hz}`]);
    const nbFrom = select(freqOpts, 27, () => {}, { class: "inp" }), nbTo = select(freqOpts, 12, () => {}, { class: "inp" });
    const nbRows = numIn(12, 1, 64);
    // Pitch-mod pair
    const pmName = h("input", { class: "inp", value: "Warp" });
    const pmCar = instSelect(i => i.pitchMod, "inst_pmc");
    const pmMod = instSelect(i => !i.noise, "inst_tri");
    const pmCarNote = noteIn("C5"), pmModNote = noteIn("G3"), pmSweep = numIn(12, -48, 48), pmRows = numIn(12, 1, 64);
    const pmSilent = h("input", { type: "checkbox", checked: true });
    // Chime
    const chName = h("input", { class: "inp", value: "Menu Chime" });
    const chInst = instSelect(i => !i.noise, "inst_ep");
    const chNotes = h("input", { class: "inp", value: "C6 E6 G6 C7" });
    const chStep = numIn(1, 1, 8);

    fill(macros, 
      h("h2", null, "Make a sound effect"),
      h("p", { class: "muted small", style: { marginTop: 0 } }, "Each tool writes an ordinary pattern for you, so you can open it afterwards and fine-tune every row."),
      h("div", { class: "macros" },
        h("div", { class: "macro" },
          h("h4", null, "Pitch sweep"),
          h("p", null, "Lasers, jumps, falling whistles. Slides from one note to another over a number of rows."),
          field("Name", swName), field("Instrument", swInst),
          h("div", { class: "cols" }, field("From note", swFrom), field("To note", swTo)),
          field("Length (rows)", swRows),
          h("button", { class: "tbtn primary", onclick: () => {
            const a = parseNote(swFrom.value), b = parseNote(swTo.value);
            if (a == null || b == null) return toast("Write notes like C5 or F#3.", "error");
            const rows = clampInt(swRows.value, 1, 64);
            create(swName.value.trim() || "Sweep", 1, rows, ch => sweepEvents(ch[0], a, b, rows, swInst.value, 100));
          } }, "Create")),

        h("div", { class: "macro" },
          h("h4", null, "Noise burst"),
          h("p", null, "Explosions, hits, wind. Plays the noise generator and steps its clock from one rate to another."),
          field("Name", nbName), field("Noise instrument", nbInst),
          h("div", { class: "cols" }, field("Start clock", nbFrom), field("End clock", nbTo)),
          field("Length (rows)", nbRows),
          h("button", { class: "tbtn primary", onclick: () => {
            const rows = clampInt(nbRows.value, 1, 64), a = +nbFrom.value, b = +nbTo.value;
            create(nbName.value.trim() || "Noise", 1, rows, ch => {
              for (let r = 0; r < rows; r++) {
                const f = Math.round(a + ((b - a) * r) / Math.max(1, rows - 1));
                const ev = { row: r, note: r === 0 ? 60 : null, fx: "NOISE_FREQ", fxVal: f };
                if (r === 0) { ev.instId = nbInst.value; ev.volL = 120; ev.volR = 120; }
                ch[0].push(ev);
              }
              ch[0].push({ row: rows, note: "OFF" });
            });
          } }, "Create")),

        h("div", { class: "macro" },
          h("h4", null, "Pitch-mod pair"),
          h("p", null, "Metallic, sci-fi and FM-style tones. Voice 7 plays the modulator and bends the pitch of voice 8 (the carrier)."),
          field("Name", pmName),
          h("div", { class: "cols" }, field("Carrier (needs Pitch mod)", pmCar), field("Modulator", pmMod)),
          h("div", { class: "cols" }, field("Carrier note", pmCarNote), field("Modulator note", pmModNote)),
          h("div", { class: "cols" }, field("Carrier sweep (semitones)", pmSweep), field("Length (rows)", pmRows)),
          h("label", { class: "check small" }, pmSilent, "Silent modulator (only bend the pitch)"),
          h("button", { class: "tbtn primary", onclick: () => {
            const cn = parseNote(pmCarNote.value), mn = parseNote(pmModNote.value);
            if (cn == null || mn == null) return toast("Write notes like C5 or F#3.", "error");
            const rows = clampInt(pmRows.value, 1, 64), sweep = clampInt(pmSweep.value, -48, 48);
            const car = state.project.instruments.find(i => i.id === pmCar.value);
            create(pmName.value.trim() || "Pitch mod", 2, rows, ch => {
              sweepEvents(ch[0], cn, cn + sweep, rows, pmCar.value, 100);
              if (car && !car.pitchMod) { ch[0][0].fx = "PMOD"; ch[0][0].fxVal = 1; }
              const v = pmSilent.checked ? 0 : 70;
              ch[1].push({ row: 0, note: mn, instId: pmMod.value, volL: v, volR: v });
              ch[1].push({ row: rows, note: "OFF" });
            });
          } }, "Create")),

        h("div", { class: "macro" },
          h("h4", null, "Chime / jingle"),
          h("p", null, "Menu blips, coins, power-ups. Plays a list of notes one after another."),
          field("Name", chName), field("Instrument", chInst),
          field("Notes (space separated)", chNotes),
          field("Rows per note", chStep),
          h("button", { class: "tbtn primary", onclick: () => {
            const notes = chNotes.value.split(/[\s,]+/).filter(Boolean).map(parseNote);
            if (!notes.length || notes.some(n => n == null)) return toast("Write notes like C6 E6 G6.", "error");
            const step = clampInt(chStep.value, 1, 8);
            const rows = notes.length * step + 4;
            create(chName.value.trim() || "Chime", 1, rows, ch => {
              notes.forEach((n, i) => ch[0].push({ row: i * step, note: n, instId: chInst.value, volL: 96, volR: 96 }));
              ch[0].push({ row: rows - 1, note: "OFF" });
            });
          } }, "Create")),
      ));
  }

  return {
    el,
    show() { renderList(); renderMacros(); },
    update(kind) { if (kind === "project") { renderList(); } else if (kind === "ui") renderList(); },
    meters(m) {
      if (m.sfxId !== playingId) {
        playingId = m.sfxId;
        listCard.querySelectorAll(".sfx-item").forEach(x => x.classList.toggle("playing", x.dataset.sfx === playingId));
      }
    },
  };
}
