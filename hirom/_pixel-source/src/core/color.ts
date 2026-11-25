/**
 * SNES 15-bit color helpers.
 * A Bgr555 value is laid out as 0bbbbbgggggrrrrr (little-endian word in CGRAM).
 */
export type Bgr555 = number;

/** Scale a 5-bit channel to 8 bits so that 31 maps to 255: (c << 3) | (c >> 2). */
export const expand5 = (c: number): number => ((c & 31) << 3) | ((c & 31) >> 2);

const EXPANDED = Array.from({ length: 32 }, (_, i) => expand5(i));

/** Nearest 5-bit channel for an 8-bit channel, measured against the expanded output values. */
export function quantize8(c: number): number {
  const v = Math.max(0, Math.min(255, Math.round(c)));
  const guess = Math.round((v * 31) / 255);
  let best = guess;
  let bestD = Infinity;
  for (let k = guess - 1; k <= guess + 1; k++) {
    if (k < 0 || k > 31) continue;
    const d = Math.abs(EXPANDED[k] - v);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

export const pack = (r: number, g: number, b: number): Bgr555 =>
  ((b & 31) << 10) | ((g & 31) << 5) | (r & 31);

export const unpack = (c: Bgr555): [number, number, number] => [c & 31, (c >> 5) & 31, (c >> 10) & 31];

export function toRgb8(c: Bgr555): [number, number, number] {
  const [r, g, b] = unpack(c);
  return [expand5(r), expand5(g), expand5(b)];
}

export const fromRgb8 = (r: number, g: number, b: number): Bgr555 =>
  pack(quantize8(r), quantize8(g), quantize8(b));

export const toHex = (c: Bgr555): string =>
  '#' + toRgb8(c).map((v) => v.toString(16).padStart(2, '0')).join('');

export function fromHex(hex: string): Bgr555 | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  const n = parseInt(h, 16);
  return fromRgb8((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/** Display a color the way SNES tooling does, e.g. `$7FFF`. */
export const toSnesHex = (c: Bgr555): string => '$' + (c & 0x7fff).toString(16).toUpperCase().padStart(4, '0');

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** r,g,b in 0..1 → [h 0..360, s 0..1, v 0..1] */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

export function toHsv(c: Bgr555): [number, number, number] {
  const [r, g, b] = toRgb8(c);
  return rgbToHsv(r / 255, g / 255, b / 255);
}

/** HSV → nearest valid BGR555 color. */
export function fromHsv(h: number, s: number, v: number): Bgr555 {
  const [r, g, b] = hsvToRgb(h, clamp01(s), clamp01(v));
  return fromRgb8(r * 255, g * 255, b * 255);
}

export interface RampOptions {
  /** Max degrees of hue rotation at the ends (shadows → blue, highlights → yellow). */
  hueShift: number;
  /** Fractional saturation change at the ends (shadows richer, highlights paler). */
  saturationShift: number;
  /** 0..1, how far the ends travel toward black / white. */
  contrast: number;
}

export const DEFAULT_RAMP: RampOptions = { hueShift: 24, saturationShift: 0.25, contrast: 0.85 };

function rotateToward(h: number, target: number, amount: number): number {
  const diff = ((target - h + 540) % 360) - 180;
  const step = Math.sign(diff) * Math.min(Math.abs(diff), amount);
  return (h + step + 360) % 360;
}

/**
 * Hue-shifted ramp from shadow to highlight with `base` at the middle,
 * every entry snapped to 15-bit color.
 */
export function generateRamp(base: Bgr555, count: number, opts: RampOptions = DEFAULT_RAMP): Bgr555[] {
  if (count <= 0) return [];
  if (count === 1) return [base];
  const [h, s, v] = toHsv(base);
  const mid = (count - 1) / 2;
  const out: Bgr555[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i - mid) / mid; // -1 = deepest shadow, +1 = brightest highlight
    const vv = t < 0 ? v * (1 + t * opts.contrast) : v + (1 - v) * t * opts.contrast;
    const hh = s < 0.02 ? h : rotateToward(h, t < 0 ? 240 : 55, Math.abs(t) * opts.hueShift);
    const ss = clamp01(s * (1 - t * opts.saturationShift));
    out.push(fromHsv(hh, ss, clamp01(vv)));
  }
  return out;
}
