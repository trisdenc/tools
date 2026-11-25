// Canvas tracker view: 8 channels × rows, keyboard driven. Same data as the piano roll.

import { state, commit, ops, currentPattern, setUi, instIndex } from "../store.js";
import { theme, fitCanvas, CHANNEL_COLORS, NOTE_KEYS, hex2 } from "./util.js";
import { noteName, FX_BY_ID, FX_BY_CODE } from "../project.js";

// Character columns inside a channel cell: "C-4 01 64 4A3"
const SUBS = [
  { x: 0, w: 3 },  // 0 note
  { x: 4, w: 1 },  // 1 inst hi
  { x: 5, w: 1 },  // 2 inst lo
  { x: 7, w: 1 },  // 3 vol hi
  { x: 8, w: 1 },  // 4 vol lo
  { x: 10, w: 1 }, // 5 fx
  { x: 11, w: 1 }, // 6 val hi
  { x: 12, w: 1 }, // 7 val lo
];
const CELL_CHARS = 14;
const HEX = "0123456789ABCDEF";

export class Tracker {
  constructor(wrap, { audition }) {
    this.wrap = wrap;
    this.audition = audition;
    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("aria-label", "Tracker grid. Use arrow keys to move, type to enter notes when edit mode is on.");
    wrap.append(this.canvas);
    this.rowH = 18; this.headH = 24;
    this.scrollRow = 0;
    this.cur = { row: state.ui.selRow || 0, ch: state.ui.selCh || 0, sub: 0 };
    this.playRow = -1;
    this.held = new Map();
    const c = this.canvas;
    c.addEventListener("pointerdown", e => this.click(e));
    c.addEventListener("wheel", e => { e.preventDefault(); this.scrollRow += Math.sign(e.deltaY) * 3; this.draw(); }, { passive: false });
    c.addEventListener("keydown", e => this.key(e));
    c.addEventListener("keyup", e => this.keyUp(e));
    c.addEventListener("focus", () => this.draw());
    c.addEventListener("blur", () => this.draw());
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(wrap);
  }

  destroy() { this.ro.disconnect(); this.canvas.remove(); }

  measure(ctx) {
    ctx.font = "13px " + getComputedStyle(document.body).getPropertyValue("--mono");
    this.charW = ctx.measureText("0").width;
    this.rowNumW = this.charW * 3 + 14;
    this.cellW = this.charW * CELL_CHARS;
  }

  syncFromUi() {
    if (state.ui.selRow !== this.cur.row || state.ui.selCh !== this.cur.ch) {
      this.cur.row = state.ui.selRow; this.cur.ch = state.ui.selCh;
    }
  }

  setCursor(row, ch, sub = this.cur.sub) {
    const pat = currentPattern();
    if (!pat) return;
    const len = pat.lengthRows;
    row = ((row % len) + len) % len;
    ch = Math.max(0, Math.min(7, ch));
    this.cur = { row, ch, sub: Math.max(0, Math.min(7, sub)) };
    this.ensureVisible();
    setUi({ selRow: row, selCh: ch });
    this.draw();
  }

  visibleRows() { return Math.max(1, Math.floor((this.canvas.getBoundingClientRect().height - this.headH) / this.rowH)); }

  ensureVisible() {
    const vis = this.visibleRows();
    if (this.cur.row < this.scrollRow + 2) this.scrollRow = this.cur.row - 2;
    if (this.cur.row > this.scrollRow + vis - 3) this.scrollRow = this.cur.row - vis + 3;
  }

  click(e) {
    const pat = currentPattern();
    if (!pat || !this.charW) return;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (y < this.headH) return;
    const row = this.scrollRow + Math.floor((y - this.headH) / this.rowH);
    const ch = Math.floor((x - this.rowNumW) / this.cellW);
    if (row < 0 || row >= pat.lengthRows || ch < 0 || ch > 7) return;
    const cx = (x - this.rowNumW - ch * this.cellW) / this.charW;
    let sub = 0;
    SUBS.forEach((s, i) => { if (cx >= s.x - 0.5) sub = i; });
    this.setCursor(row, ch, sub);
    setTimeout(() => this.canvas.focus(), 0);
  }

  setPlayRow(row) {
    if (row === this.playRow) return;
    this.playRow = row;
    if (row >= 0 && state.ui.follow) {
      const vis = this.visibleRows();
      this.scrollRow = row - Math.floor(vis / 2);
    }
    this.draw();
  }

  // ---------- Editing ----------
  edit(fields, advance = true) {
    const pat = currentPattern();
    const { row, ch } = this.cur;
    commit(() => ops.edit(pat, ch, row, fields));
    if (advance && state.ui.editStep) this.setCursor(row + state.ui.editStep, ch);
    else this.draw();
  }

  nibble(cur, digit, hi, max) {
    const v = cur == null ? 0 : cur;
    const n = hi ? ((digit << 4) | (v & 0x0F)) : ((v & 0xF0) | digit);
    return Math.min(max, n);
  }

  key(e) {
    const pat = currentPattern();
    if (!pat || e.ctrlKey || e.metaKey || e.altKey) return;
    const { row, ch, sub } = this.cur;
    const nav = {
      ArrowUp: () => this.setCursor(row - 1, ch),
      ArrowDown: () => this.setCursor(row + 1, ch),
      ArrowLeft: () => (sub > 0 ? this.setCursor(row, ch, sub - 1) : this.setCursor(row, ch - 1, 7)),
      ArrowRight: () => (sub < 7 ? this.setCursor(row, ch, sub + 1) : this.setCursor(row, ch + 1, 0)),
      Tab: () => this.setCursor(row, e.shiftKey ? ch - 1 : ch + 1, 0),
      PageUp: () => this.setCursor(Math.max(0, row - 16), ch),
      PageDown: () => this.setCursor(Math.min(pat.lengthRows - 1, row + 16), ch),
      Home: () => this.setCursor(0, ch),
      End: () => this.setCursor(pat.lengthRows - 1, ch),
    };
    if (nav[e.key]) { e.preventDefault(); e.stopPropagation(); nav[e.key](); return; }
    if (!state.ui.editMode) return; // let the global handler audition notes

    const ev = ops.at(pat, ch, row);
    const k = e.key.toUpperCase();
    const handled = () => { e.preventDefault(); e.stopPropagation(); };

    if (e.key === "Backspace") { handled(); commit(() => ops.remove(pat, ch, row)); this.setCursor(row - (state.ui.editStep ? 1 : 0), ch); return; }
    if (e.key === "Delete") {
      handled();
      const clear = [{ note: null }, { instId: null }, { instId: null }, { volL: null, volR: null }, { volL: null, volR: null },
        { fx: null, fxVal: null }, { fxVal: null }, { fxVal: null }][sub];
      this.edit(clear);
      return;
    }

    if (sub === 0) {
      if (e.code === "Digit1" || e.code === "Backquote") { handled(); this.edit({ note: "OFF" }); return; }
      if (e.code in NOTE_KEYS && !e.repeat) {
        handled();
        const note = Math.max(0, Math.min(127, (state.ui.octave + 1) * 12 + NOTE_KEYS[e.code]));
        const fields = { note };
        if (state.ui.instId) fields.instId = state.ui.instId;
        this.edit(fields);
        this.audition(note, true, "trk" + e.code);
        this.held.set(e.code, note);
        return;
      }
      return;
    }
    if (sub === 5) {
      const fx = FX_BY_CODE[k];
      if (fx) { handled(); this.edit({ fx: fx.id, fxVal: ev?.fxVal ?? 0 }, false); this.setCursor(row, ch, 6); return; }
      if (k === ".") { handled(); this.edit({ fx: null, fxVal: null }); }
      return;
    }
    const d = HEX.indexOf(k);
    if (d < 0 || k.length !== 1) return;
    handled();
    const hi = sub === 1 || sub === 3 || sub === 6;
    if (sub === 1 || sub === 2) {
      const curNum = ev?.instId ? instIndex(ev.instId) + 1 : 0;
      const num = this.nibble(curNum, d, hi, 0xFF);
      const inst = state.project.instruments[num - 1];
      this.edit({ instId: inst ? inst.id : null }, !hi);
    } else if (sub === 3 || sub === 4) {
      const v = this.nibble(ev?.volL, d, hi, 0x7F);
      this.edit({ volL: v, volR: v }, !hi);
    } else if (sub === 6 || sub === 7) {
      if (!ev?.fx) return; // pick an effect first (column to the left)
      const v = this.nibble(ev.fxVal, d, hi, 0xFF);
      this.edit({ fxVal: v }, !hi);
    }
    this.setCursor(this.cur.row, ch, hi ? sub + 1 : sub - 1);
  }

  keyUp(e) {
    if (this.held.has(e.code)) {
      this.audition(this.held.get(e.code), false, "trk" + e.code);
      this.held.delete(e.code);
    }
  }

  // ---------- Drawing ----------
  draw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
  }

  paint() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    this.measure(ctx);
    const t = theme();
    const pat = currentPattern();
    ctx.fillStyle = t.card;
    ctx.fillRect(0, 0, w, h);
    if (!pat) return;
    const len = pat.lengthRows, rh = this.rowH, cw = this.charW, x0 = this.rowNumW;
    const vis = this.visibleRows();
    this.scrollRow = Math.max(0, Math.min(Math.max(0, len - vis), this.scrollRow));
    const focused = document.activeElement === this.canvas;
    const anySolo = state.project.mixer.channels.some(c => c.solo);

    // Header
    ctx.fillStyle = t.panel;
    ctx.fillRect(0, 0, w, this.headH);
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (let c = 0; c < 8; c++) {
      const x = x0 + c * this.cellW;
      const m = state.project.mixer.channels[c];
      const silent = m.mute || (anySolo && !m.solo);
      ctx.fillStyle = CHANNEL_COLORS[c];
      ctx.globalAlpha = silent ? 0.35 : 1;
      ctx.fillRect(x, this.headH - 3, this.cellW - cw, 3);
      ctx.fillText(`Voice ${c + 1}${silent ? " (muted)" : ""}`, x, this.headH / 2 - 1);
      ctx.globalAlpha = 1;
    }

    ctx.font = "13px " + getComputedStyle(document.body).getPropertyValue("--mono");
    const fxColor = t.accent;
    for (let i = 0; i < vis + 1; i++) {
      const row = this.scrollRow + i;
      if (row >= len) break;
      const y = this.headH + i * rh;
      if (row % 16 === 0) { ctx.fillStyle = t.gridStrong; ctx.fillRect(0, y, w, rh); }
      else if (row % 4 === 0) { ctx.fillStyle = t.grid; ctx.fillRect(0, y, w, rh); }
      if (row === this.playRow) { ctx.fillStyle = t.playhead; ctx.globalAlpha = 0.22; ctx.fillRect(0, y, w, rh); ctx.globalAlpha = 1; }
      if (row === this.cur.row) { ctx.fillStyle = t.cursor; ctx.fillRect(0, y, w, rh); }
      ctx.fillStyle = row % 4 === 0 ? t.text : t.muted;
      ctx.fillText(String(row).padStart(2, "0"), 6, y + rh / 2 + 1);

      for (let c = 0; c < 8; c++) {
        const x = x0 + c * this.cellW;
        const ev = pat.channels[c].find(e => e.row === row);
        const note = ev ? noteName(ev.note) : "---";
        const inst = ev?.instId ? hex2(instIndex(ev.instId) + 1) : "..";
        const vol = ev?.volL != null ? hex2(ev.volL) : "..";
        const fx = ev?.fx ? (FX_BY_ID[ev.fx]?.code || "?") + hex2(ev.fxVal) : "...";
        const ty = y + rh / 2 + 1;
        ctx.fillStyle = ev && ev.note != null ? (ev.note === "OFF" ? t.warn : t.text) : t.muted;
        ctx.globalAlpha = ev && ev.note != null ? 1 : 0.45;
        ctx.fillText(note, x, ty);
        ctx.globalAlpha = ev?.instId ? 1 : 0.45;
        ctx.fillStyle = ev?.instId ? CHANNEL_COLORS[c] : t.muted;
        ctx.fillText(inst, x + 4 * cw, ty);
        ctx.globalAlpha = ev?.volL != null ? 1 : 0.45;
        ctx.fillStyle = ev?.volL != null ? t.good : t.muted;
        ctx.fillText(vol, x + 7 * cw, ty);
        ctx.globalAlpha = ev?.fx ? 1 : 0.45;
        ctx.fillStyle = ev?.fx ? fxColor : t.muted;
        ctx.fillText(fx, x + 10 * cw, ty);
        ctx.globalAlpha = 1;
      }
    }
    // Channel separators
    ctx.fillStyle = t.border;
    for (let c = 0; c <= 8; c++) ctx.fillRect(Math.round(x0 + c * this.cellW - cw * 0.6), 0, 1, h);

    // Cursor field
    const ci = this.cur.row - this.scrollRow;
    if (ci >= 0 && ci <= vis) {
      const s = SUBS[this.cur.sub];
      const x = x0 + this.cur.ch * this.cellW + s.x * cw - 1;
      const y = this.headH + ci * rh;
      ctx.strokeStyle = state.ui.editMode ? t.playhead : t.accent;
      ctx.lineWidth = focused ? 2 : 1;
      ctx.globalAlpha = focused ? 1 : 0.5;
      ctx.strokeRect(x, y + 1, s.w * cw + 2, rh - 2);
      ctx.globalAlpha = 1;
    }
    if (!focused) {
      ctx.fillStyle = t.muted;
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText("Click the grid to type", w - 10, this.headH / 2);
      ctx.textAlign = "left";
    }
  }
}
