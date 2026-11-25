// Canvas piano roll for one channel at a time (other channels shown as ghosts).

import { state, commit, ops, currentPattern, setUi } from "../store.js";
import { theme, fitCanvas, CHANNEL_COLORS } from "./util.js";
import { notePretty } from "../project.js";

const LOW = 24, HIGH = 108; // C1..C8
const isBlack = n => [1, 3, 6, 8, 10].includes(n % 12);

export class PianoRoll {
  constructor(wrap, { audition }) {
    this.wrap = wrap;
    this.audition = audition;
    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("aria-label", "Piano roll");
    wrap.append(this.canvas);
    this.keyW = 48; this.rulerH = 22; this.noteH = 12;
    this.scrollX = 0;
    this.scrollY = (HIGH - 80) * this.noteH;
    this.drag = null;
    this.hover = null;
    this.playRow = -1;
    const c = this.canvas;
    c.addEventListener("pointerdown", e => this.down(e));
    c.addEventListener("pointermove", e => this.move(e));
    c.addEventListener("pointerup", e => this.up(e));
    c.addEventListener("pointercancel", e => this.up(e));
    c.addEventListener("contextmenu", e => { e.preventDefault(); this.contextDelete(e); });
    c.addEventListener("wheel", e => this.wheel(e), { passive: false });
    c.addEventListener("pointerleave", () => { this.hover = null; this.draw(); });
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(wrap);
  }

  destroy() { this.ro.disconnect(); this.canvas.remove(); }

  get rowW() { return 16 * state.ui.zoom; }
  get ch() { return state.ui.channel; }

  rowAt(x) { return Math.floor((x - this.keyW + this.scrollX) / this.rowW); }
  noteAt(y) { return HIGH - Math.floor((y - this.rulerH + this.scrollY) / this.noteH); }
  xOf(row) { return this.keyW + row * this.rowW - this.scrollX; }
  yOf(note) { return this.rulerH + (HIGH - note) * this.noteH - this.scrollY; }

  clampScroll(w, h) {
    const pat = currentPattern();
    const maxX = Math.max(0, (pat ? pat.lengthRows : 64) * this.rowW - (w - this.keyW) + 40);
    const maxY = Math.max(0, (HIGH - LOW + 1) * this.noteH - (h - this.rulerH));
    this.scrollX = Math.max(0, Math.min(maxX, this.scrollX));
    this.scrollY = Math.max(0, Math.min(maxY, this.scrollY));
  }

  // Scroll so the active channel's notes are in view.
  focusNotes() {
    const pat = currentPattern();
    if (!pat) return;
    const spans = ops.spans(pat, this.ch);
    if (!spans.length) return;
    const avg = spans.reduce((a, s) => a + s.note, 0) / spans.length;
    const h = this.canvas.getBoundingClientRect().height || 400;
    this.scrollY = (HIGH - avg) * this.noteH - (h - this.rulerH) / 2;
    this.draw();
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  spanAt(pat, row, note) {
    return ops.spans(pat, this.ch).find(s => s.note === note && row >= s.row && row < s.end);
  }

  down(e) {
    const pat = currentPattern();
    if (!pat) return;
    this.canvas.focus();
    const { x, y } = this.local(e);
    if (e.button === 2) return;
    this.canvas.setPointerCapture(e.pointerId);
    if (x < this.keyW && y > this.rulerH) {
      const note = this.noteAt(y);
      this.drag = { mode: "key", note };
      this.audition(note, true);
      return;
    }
    if (y < this.rulerH) {
      const row = Math.max(0, Math.min(pat.lengthRows - 1, this.rowAt(x)));
      setUi({ selRow: row, selCh: this.ch });
      return;
    }
    const row = this.rowAt(x), note = this.noteAt(y);
    if (row < 0 || row >= pat.lengthRows || note < LOW || note > HIGH) return;
    const span = this.spanAt(pat, row, note);
    if (span) {
      const endX = this.xOf(span.end);
      const mode = x > endX - Math.min(8, this.rowW / 2) ? "resize" : "move";
      this.drag = { mode, span, offset: row - span.row, row: span.row, note: span.note, len: span.end - span.row, moved: false };
      setUi({ selRow: span.row, selCh: this.ch });
      this.audition(span.note, true);
    } else {
      const len = Math.min(state.ui.noteLen, pat.lengthRows - row);
      const key = "pr-create-" + performance.now();
      commit(p => ops.setNote(pat, this.ch, row, note, len, state.ui.instId), { coalesce: key });
      const created = this.spanAt(pat, row, note);
      this.drag = { mode: "resize", span: created, offset: 0, row, note, len, moved: false, created: true, key };
      setUi({ selRow: row, selCh: this.ch });
      this.audition(note, true);
    }
    this.draw();
  }

  move(e) {
    const { x, y } = this.local(e);
    const pat = currentPattern();
    if (!this.drag) {
      if (!pat) return;
      const row = this.rowAt(x), note = this.noteAt(y);
      const span = y > this.rulerH && x > this.keyW ? this.spanAt(pat, row, note) : null;
      const edge = span && x > this.xOf(span.end) - Math.min(8, this.rowW / 2);
      this.canvas.style.cursor = x < this.keyW ? "pointer" : span ? (edge ? "ew-resize" : "grab") : "crosshair";
      return;
    }
    const d = this.drag;
    if (d.mode === "key") {
      const note = this.noteAt(y);
      if (note !== d.note) { this.audition(d.note, false); d.note = note; this.audition(note, true); }
      return;
    }
    if (!pat || !d.span) return;
    const row = this.rowAt(x);
    if (d.mode === "move") {
      const nr = Math.max(0, Math.min(pat.lengthRows - 1, row - d.offset));
      const nn = Math.max(LOW, Math.min(HIGH, this.noteAt(y)));
      if (nn !== d.note) { this.audition(d.note, false); this.audition(nn, true); }
      if (nr !== d.row || nn !== d.note) { d.row = nr; d.note = nn; d.moved = true; }
    } else {
      const len = Math.max(1, Math.min(pat.lengthRows - d.span.row, row - d.span.row + 1));
      if (len !== d.len) { d.len = len; d.moved = true; }
    }
    this.draw();
  }

  up() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.mode === "key") { this.audition(d.note, false); return; }
    if (d.note != null) this.audition(d.span?.note ?? d.note, false);
    this.audition(d.note, false);
    const pat = currentPattern();
    if (pat && d.span && d.moved) {
      if (d.mode === "move") {
        commit(() => ops.moveSpan(pat, this.ch, d.span, d.row, d.note));
        setUi({ selRow: d.row, selCh: this.ch });
      } else {
        commit(() => ops.resizeSpan(pat, this.ch, d.span, d.len), { coalesce: d.key || null });
        if (d.created) state.ui.noteLen = d.len;
      }
    }
    this.draw();
  }

  contextDelete(e) {
    const pat = currentPattern();
    if (!pat) return;
    const { x, y } = this.local(e);
    const span = this.spanAt(pat, this.rowAt(x), this.noteAt(y));
    if (span) commit(() => ops.deleteSpan(pat, this.ch, span));
  }

  wheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const z = Math.max(0.4, Math.min(4, state.ui.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const { x } = this.local(e);
      const rowUnder = (x - this.keyW + this.scrollX) / this.rowW;
      state.ui.zoom = z;
      this.scrollX = rowUnder * this.rowW - (x - this.keyW);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.scrollX += e.shiftKey ? e.deltaY : e.deltaX;
    } else {
      this.scrollY += e.deltaY;
    }
    this.draw();
  }

  setPlayRow(row) {
    if (row === this.playRow) return;
    this.playRow = row;
    if (row >= 0 && state.ui.follow) {
      const w = this.canvas.getBoundingClientRect().width;
      const x = this.xOf(row);
      if (x > w - 60 || x < this.keyW) this.scrollX = Math.max(0, row * this.rowW - (w - this.keyW) * 0.2);
    }
    this.draw();
  }

  draw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
  }

  paint() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    this.clampScroll(w, h);
    const t = theme();
    const pat = currentPattern();
    const rowW = this.rowW, nh = this.noteH, kw = this.keyW, rh = this.rulerH;
    ctx.fillStyle = t.card;
    ctx.fillRect(0, 0, w, h);
    if (!pat) return;
    const len = pat.lengthRows;

    // Note lanes
    ctx.save();
    ctx.beginPath(); ctx.rect(kw, rh, w - kw, h - rh); ctx.clip();
    for (let n = HIGH; n >= LOW; n--) {
      const y = this.yOf(n);
      if (y > h || y + nh < rh) continue;
      if (isBlack(n)) { ctx.fillStyle = t.panel; ctx.fillRect(kw, y, w - kw, nh); }
      if (n % 12 === 0) { ctx.fillStyle = t.gridStrong; ctx.fillRect(kw, y + nh - 1, w - kw, 1); }
    }
    // Row grid
    const first = Math.max(0, Math.floor(this.scrollX / rowW));
    for (let r = first; r <= len; r++) {
      const x = this.xOf(r);
      if (x > w) break;
      ctx.fillStyle = r % 16 === 0 ? t.muted : r % 4 === 0 ? t.gridStrong : t.grid;
      ctx.globalAlpha = r % 16 === 0 ? 0.45 : 1;
      ctx.fillRect(Math.round(x), rh, 1, h - rh);
      ctx.globalAlpha = 1;
    }
    const endX = this.xOf(len);
    if (endX < w) { ctx.fillStyle = t.bg; ctx.globalAlpha = 0.7; ctx.fillRect(endX, rh, w - endX, h - rh); ctx.globalAlpha = 1; }

    // Ghost notes from other channels
    if (state.ui.showAll !== false) {
      for (let c = 0; c < 8; c++) {
        if (c === this.ch) continue;
        ctx.fillStyle = CHANNEL_COLORS[c];
        ctx.globalAlpha = 0.22;
        for (const s of ops.spans(pat, c)) {
          const x = this.xOf(s.row), y = this.yOf(s.note);
          ctx.fillRect(x + 1, y + 2, (s.end - s.row) * rowW - 2, nh - 4);
        }
      }
      ctx.globalAlpha = 1;
    }

    // Active channel notes
    const color = CHANNEL_COLORS[this.ch];
    const d = this.drag;
    ctx.font = `600 ${Math.min(10, nh - 2)}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    for (const s of ops.spans(pat, this.ch)) {
      const dragging = d && d.span && d.span.ev === s.ev && d.moved;
      const x = this.xOf(s.row), y = this.yOf(s.note), wd = (s.end - s.row) * rowW;
      if (x > w || x + wd < kw) continue;
      ctx.globalAlpha = dragging ? 0.3 : 1;
      ctx.fillStyle = color;
      roundRect(ctx, x + 1, y + 1, wd - 2, nh - 2, 3); ctx.fill();
      const sel = state.ui.selCh === this.ch && state.ui.selRow === s.row;
      if (sel) { ctx.strokeStyle = t.text; ctx.lineWidth = 2; roundRect(ctx, x + 1, y + 1, wd - 2, nh - 2, 3); ctx.stroke(); }
      if (wd > 30) { ctx.fillStyle = "#fff"; ctx.fillText(notePretty(s.note), x + 5, y + nh / 2 + 0.5); }
      if (s.ev.fx) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(x + wd - 6, y + nh / 2, 2, 0, 7); ctx.fill(); }
      if (s.cut) {
        // Voice steal: this note cuts off the previous note's tail
        ctx.fillStyle = t.warn;
        ctx.beginPath(); ctx.moveTo(x, y - 2); ctx.lineTo(x + 6, y - 2); ctx.lineTo(x, y + 5); ctx.fill();
      }
      if (s.glide) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 2, y + nh - 3); ctx.lineTo(x + 8, y + 3); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    // Effect-only rows on this channel
    for (const ev of pat.channels[this.ch]) {
      if (ev.note == null && ev.fx) {
        const x = this.xOf(ev.row) + rowW / 2;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.7;
        ctx.beginPath(); ctx.moveTo(x, h - 12); ctx.lineTo(x + 4, h - 7); ctx.lineTo(x, h - 2); ctx.lineTo(x - 4, h - 7); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    // Drag preview
    if (d && d.span && d.moved) {
      const row = d.mode === "move" ? d.row : d.span.row;
      const note = d.mode === "move" ? d.note : d.span.note;
      const ln = d.mode === "move" ? d.span.end - d.span.row : d.len;
      ctx.fillStyle = color;
      ctx.strokeStyle = t.text;
      ctx.lineWidth = 1.5;
      roundRect(ctx, this.xOf(row) + 1, this.yOf(note) + 1, Math.min(ln, len - row) * rowW - 2, nh - 2, 3);
      ctx.fill(); ctx.stroke();
    }
    // Playhead
    if (this.playRow >= 0) {
      const x = this.xOf(this.playRow);
      ctx.fillStyle = t.playhead;
      ctx.fillRect(x, rh, 2, h - rh);
    }
    ctx.restore();

    // Ruler
    ctx.fillStyle = t.panel;
    ctx.fillRect(kw, 0, w - kw, rh);
    ctx.fillStyle = t.border;
    ctx.fillRect(0, rh - 1, w, 1);
    ctx.font = "11px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    for (let r = first; r < len; r++) {
      const x = this.xOf(r);
      if (x > w) break;
      if (r % 4 === 0 && x >= kw - 1) {
        ctx.fillStyle = r % 16 === 0 ? t.text : t.muted;
        if (rowW * 4 > 26 || r % 16 === 0) ctx.fillText(String(r), x + 3, rh / 2);
      }
    }
    if (state.ui.selCh === this.ch) {
      const x = this.xOf(state.ui.selRow);
      if (x >= kw) { ctx.fillStyle = t.accent; ctx.globalAlpha = 0.35; ctx.fillRect(x, 0, rowW, rh - 1); ctx.globalAlpha = 1; }
    }
    if (this.playRow >= 0) {
      const x = this.xOf(this.playRow);
      if (x >= kw) { ctx.fillStyle = t.playhead; ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 7, 0); ctx.lineTo(x + 1, 8); ctx.fill(); }
    }

    // Keyboard
    ctx.save();
    ctx.beginPath(); ctx.rect(0, rh, kw, h - rh); ctx.clip();
    for (let n = HIGH; n >= LOW; n--) {
      const y = this.yOf(n);
      if (y > h || y + nh < rh) continue;
      ctx.fillStyle = isBlack(n) ? t.keyBlack : t.keyWhite;
      ctx.fillRect(0, y, kw - 1, nh);
      ctx.fillStyle = t.grid;
      ctx.fillRect(0, y + nh - 1, kw - 1, 1);
      if (n % 12 === 0) {
        ctx.fillStyle = "#777";
        ctx.font = "9px system-ui, sans-serif";
        ctx.fillText(notePretty(n), 4, y + nh / 2);
      }
    }
    ctx.fillStyle = t.border;
    ctx.fillRect(kw - 1, rh, 1, h - rh);
    ctx.restore();
    ctx.fillStyle = t.panel;
    ctx.fillRect(0, 0, kw, rh);
    ctx.fillStyle = color;
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.fillText(`Ch ${this.ch + 1}`, 6, rh / 2);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
