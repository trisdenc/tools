import { toRgb8 } from '@pixel/core/color';
import type { Tileset } from '@pixel/core/project';
import { cellFlip, cellPal, cellTile } from '@pixel/core/project';
import { getTile, tileCount } from '@pixel/core/tiles';

/**
 * CPU drawing of tiles and metatiles into RGBA buffers, for docks and thumbnails. Index 0 is left
 * untouched (transparent), so callers can pre-fill a checkerboard or backdrop.
 */
const TILE = new Uint8Array(64);

export const paletteBaseFor = (bpp: number, pal: number): number => (bpp === 8 ? 0 : pal * (1 << bpp));

export function drawWord(
  rgba: Uint8ClampedArray,
  stride: number,
  dx: number,
  dy: number,
  ts: Tileset | undefined,
  word: number,
  cgram: Uint16Array,
  scale = 1,
): void {
  if (!ts) return;
  const t = cellTile(word);
  if (t >= tileCount(ts)) return;
  getTile(ts.sheet, t, TILE);
  const flip = cellFlip(word);
  const base = paletteBaseFor(ts.bpp, cellPal(word));
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const v = TILE[(flip & 2 ? 7 - y : y) * 8 + (flip & 1 ? 7 - x : x)];
      if (!v) continue;
      const [r, g, b] = toRgb8(cgram[base + v]);
      for (let sy = 0; sy < scale; sy++) {
        let o = ((dy + y * scale + sy) * stride + dx + x * scale) * 4;
        for (let sx = 0; sx < scale; sx++, o += 4) {
          rgba[o] = r;
          rgba[o + 1] = g;
          rgba[o + 2] = b;
          rgba[o + 3] = 255;
        }
      }
    }
  }
}

export function checker(rgba: Uint8ClampedArray, w: number, h: number, cell = 4, a = 46, b = 58): void {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = ((x / cell) | 0) + ((y / cell) | 0) & 1 ? a : b;
      const o = (y * w + x) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
      rgba[o + 3] = 255;
    }
}

/** Render k×k words (a metatile or stamp) to an ImageData at an integer scale. */
export function renderWords(ts: Tileset | undefined, words: readonly number[], cols: number, cgram: Uint16Array, scale = 1, backdrop?: number): ImageData {
  const rows = Math.ceil(words.length / cols);
  const w = cols * 8 * scale, h = rows * 8 * scale;
  const img = new ImageData(w, h);
  if (backdrop === undefined) checker(img.data, w, h, 4 * scale);
  else {
    const [r, g, b] = toRgb8(backdrop);
    for (let i = 0; i < w * h; i++) img.data.set([r, g, b, 255], i * 4);
  }
  words.forEach((word, i) => drawWord(img.data, w, (i % cols) * 8 * scale, Math.floor(i / cols) * 8 * scale, ts, word, cgram, scale));
  return img;
}

/** A tileset sheet drawn with one palette (for the tile picker). */
export function renderSheet(ts: Tileset, palette: number, cgram: Uint16Array, scale = 1): ImageData {
  const n = tileCount(ts);
  const words = Array.from({ length: n }, (_, t) => ((palette & 7) << 10) | t);
  return renderWords(ts, words, 16, cgram, scale);
}
