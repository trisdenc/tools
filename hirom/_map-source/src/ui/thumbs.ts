import type { Tileset } from '@pixel/core/project';
import { renderSheet, renderWords } from '../core/preview';

/** Memoized canvases for metatile / stamp / tileset previews. Cleared when sources reload. */
const cache = new Map<string, HTMLCanvasElement>();
let generation = -1;

export function syncThumbs(pixelVersion: number): void {
  if (pixelVersion !== generation) {
    cache.clear();
    generation = pixelVersion;
  }
}

function toCanvas(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

export function wordsCanvas(ts: Tileset | undefined, words: readonly number[], cols: number, cgram: Uint16Array, scale = 1): HTMLCanvasElement {
  const key = `w:${ts?.id}:${cols}:${scale}:${words.join(',')}`;
  let c = cache.get(key);
  if (!c) {
    c = toCanvas(renderWords(ts, words, cols, cgram, scale));
    cache.set(key, c);
  }
  return c;
}

export function sheetCanvas(ts: Tileset, palette: number, cgram: Uint16Array, scale = 1): HTMLCanvasElement {
  const key = `s:${ts.id}:${palette}:${scale}`;
  let c = cache.get(key);
  if (!c) {
    c = toCanvas(renderSheet(ts, palette, cgram, scale));
    cache.set(key, c);
  }
  return c;
}
