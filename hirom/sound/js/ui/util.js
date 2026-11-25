// Small DOM helpers shared by the views.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else if (k === "html") el.innerHTML = v;
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
  }
  append(el, kids);
  return el;
}

// Replace an element's children, skipping null/false like h() does.
export function fill(el, ...kids) {
  el.replaceChildren();
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function option(value, label, selected) {
  return h("option", { value, selected: selected ? "selected" : null }, label);
}

export function select(options, value, onChange, props = {}) {
  const s = h("select", props, options.map(([v, l]) => option(v, l, String(v) === String(value))));
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

// Labeled range slider with a live value readout. onInput(value) fires while dragging.
export function slider({ label, min, max, step = 1, value, format = v => v, onInput, title, vertical = false }) {
  const out = h("output", null, format(value));
  const input = h("input", { type: "range", min, max, step, value, title, class: vertical ? "vertical" : null });
  input.addEventListener("input", () => { out.textContent = format(+input.value); onInput(+input.value); });
  input.addEventListener("dblclick", () => { if (input.dataset.reset != null) { input.value = input.dataset.reset; input.dispatchEvent(new Event("input")); } });
  const wrap = h("label", { class: "slider" + (vertical ? " v" : "") }, h("span", { class: "slabel" }, label), input, out);
  wrap.input = input;
  wrap.set = v => { input.value = v; out.textContent = format(v); };
  return wrap;
}

export function toggle(label, on, onChange, props = {}) {
  const b = h("button", { type: "button", class: "toggle" + (props.class ? " " + props.class : ""), "aria-pressed": on ? "true" : "false", title: props.title }, label);
  b.addEventListener("click", () => {
    const now = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", now);
    onChange(now);
  });
  return b;
}

export const hex2 = n => (n == null ? ".." : (n & 0xFF).toString(16).toUpperCase().padStart(2, "0"));
export const fmtBytes = n => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
export const fmtMs = s => (s === Infinity ? "∞" : s >= 1 ? `${s.toFixed(s >= 10 ? 0 : 1)} s` : `${Math.round(s * 1000)} ms`);

export const CHANNEL_COLORS = ["#e5484d", "#f76b15", "#e2a300", "#46a758", "#12a594", "#0090ff", "#8e4ec6", "#d6409f"];

// Theme colours for canvases, read from CSS custom properties.
let themeCache = null;
export function theme() {
  if (themeCache) return themeCache;
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  themeCache = {
    bg: g("--bg"), card: g("--card"), panel: g("--panel"), text: g("--text"), muted: g("--muted"),
    border: g("--border"), accent: g("--accent"), grid: g("--grid"), gridStrong: g("--grid-strong"),
    keyWhite: g("--key-white"), keyBlack: g("--key-black"), warn: g("--warn"), good: g("--good"),
    cursor: g("--cursor"), playhead: g("--playhead"),
  };
  return themeCache;
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { themeCache = null; });

// Size a canvas to its CSS box at device pixel ratio; returns the 2D context (in CSS px).
export function fitCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), hgt = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

// Computer keyboard -> semitone offset (two-row tracker layout, by physical key).
export const NOTE_KEYS = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11,
  Comma: 12, KeyL: 13, Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21,
  Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25, KeyO: 26, Digit0: 27, KeyP: 28,
};

let toastTimer;
export function toast(msg, kind = "") {
  let t = document.getElementById("toast");
  if (!t) { t = h("div", { id: "toast", role: "status" }); document.body.append(t); }
  t.textContent = msg;
  t.className = "show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ""; }, kind === "error" ? 5000 : 2600);
}

export function download(blob, name) {
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export const isTyping = e => {
  const t = e.target;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && t.type !== "range" && t.type !== "checkbox";
};
