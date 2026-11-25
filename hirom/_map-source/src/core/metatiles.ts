import type { Tileset } from '@pixel/core/project';
import { SHEET_COLS } from '@pixel/core/project';
import { getTile, isBlank, tileCount } from '@pixel/core/tiles';
import type { Level, MapLayer, Metatile, MetatileSet, MetatileSize } from './level';
import { levelTiles, tilesPerMeta, uid } from './level';

/** Words of the metatile cell at (mx, my), row-major. */
export function readMeta(layer: MapLayer, tilesW: number, mx: number, my: number, k: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) out.push(layer.cells[(my * k + y) * tilesW + mx * k + x]);
  return out;
}

/** Cell indices covered by metatile cell (mx, my). */
export function metaCellIndices(tilesW: number, mx: number, my: number, k: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) out.push((my * k + y) * tilesW + mx * k + x);
  return out;
}

export const wordsKey = (words: readonly number[]): string => words.join(',');

export function findMetatile(set: MetatileSet | undefined, words: readonly number[]): Metatile | undefined {
  if (!set) return undefined;
  const key = wordsKey(words);
  return set.metatiles.find((m) => wordsKey(m.words) === key);
}

/** The empty metatile every set starts with (tile 0 is transparent in practice). */
export function emptyMetatile(size: MetatileSize): Metatile {
  const k = tilesPerMeta(size);
  return { id: 0, name: 'Empty', words: new Array(k * k).fill(0), collision: 0 };
}

export function nextMetatileId(set: MetatileSet): number {
  return set.metatiles.reduce((m, t) => Math.max(m, t.id), -1) + 1;
}

export function createMetatileSet(name: string, tilesetRef: string, size: MetatileSize): MetatileSet {
  return { id: uid('mts'), name, tilesetRef, size, metatiles: [emptyMetatile(size)] };
}

/**
 * Build metatiles from a tileset sheet laid out in k×k blocks (the usual way 16×16 art is drawn
 * in a 16-tile-wide sheet). Fully blank blocks are skipped.
 */
export function metatilesFromSheet(ts: Tileset, size: MetatileSize, palette: number): Metatile[] {
  const k = tilesPerMeta(size);
  const n = tileCount(ts);
  const blocksX = SHEET_COLS / k;
  const rows = Math.ceil(n / SHEET_COLS);
  const blocksY = Math.floor(rows / k);
  const out: Metatile[] = [];
  let id = 1;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const words: number[] = [];
      let blank = true;
      for (let y = 0; y < k; y++) {
        for (let x = 0; x < k; x++) {
          const t = (by * k + y) * SHEET_COLS + bx * k + x;
          if (t < n && !isBlank(getTile(ts.sheet, t))) blank = false;
          words.push(((palette & 7) << 10) | (t & 0x3ff));
        }
      }
      if (blank) continue;
      out.push({ id: id++, name: `Block ${bx},${by}`, words, collision: 0 });
    }
  }
  return out;
}

/** Unique k×k blocks used by a tilemap (e.g. a HiROM Pixel scene layer), as metatiles. */
export function metatilesFromCells(cells: Uint16Array, tilesW: number, tilesH: number, size: MetatileSize, firstId = 1): Metatile[] {
  const k = tilesPerMeta(size);
  const seen = new Set<string>();
  const out: Metatile[] = [];
  for (let my = 0; my + k <= tilesH; my += k) {
    for (let mx = 0; mx + k <= tilesW; mx += k) {
      const words: number[] = [];
      for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) words.push(cells[(my + y) * tilesW + mx + x]);
      if (words.every((w) => w === 0)) continue;
      const key = wordsKey(words);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: firstId + out.length, name: `Block ${out.length + 1}`, words, collision: 0 });
    }
  }
  return out;
}

/** 4-way flood fill over metatile cells whose words match the start cell. Returns cell coordinates. */
export function floodMeta(level: Level, layerIndex: number, mx0: number, my0: number, limit = 262144): [number, number][] {
  const layer = level.layers[layerIndex];
  const { w: tilesW } = levelTiles(level);
  const k = tilesPerMeta(level.meta.metatileSize);
  const W = level.meta.widthMetatiles, H = level.meta.heightMetatiles;
  if (mx0 < 0 || my0 < 0 || mx0 >= W || my0 >= H) return [];
  const target = wordsKey(readMeta(layer, tilesW, mx0, my0, k));
  const seen = new Uint8Array(W * H);
  const out: [number, number][] = [];
  const stack: number[] = [my0 * W + mx0];
  seen[my0 * W + mx0] = 1;
  while (stack.length && out.length < limit) {
    const i = stack.pop()!;
    const x = i % W, y = (i / W) | 0;
    out.push([x, y]);
    const tryCell = (nx: number, ny: number) => {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
      const j = ny * W + nx;
      if (seen[j]) return;
      seen[j] = 1;
      if (wordsKey(readMeta(layer, tilesW, nx, ny, k)) === target) stack.push(j);
    };
    tryCell(x + 1, y);
    tryCell(x - 1, y);
    tryCell(x, y + 1);
    tryCell(x, y - 1);
  }
  return out;
}

/** Flip a metatile's words horizontally / vertically (rearranges the sub-tiles and toggles their flip bits). */
export function flipMetaWords(words: readonly number[], k: number, h: boolean, v: boolean): number[] {
  const out = new Array<number>(k * k);
  for (let y = 0; y < k; y++) {
    for (let x = 0; x < k; x++) {
      const sx = h ? k - 1 - x : x, sy = v ? k - 1 - y : y;
      let w = words[sy * k + sx];
      if (h) w ^= 0x4000;
      if (v) w ^= 0x8000;
      out[y * k + x] = w;
    }
  }
  return out;
}
