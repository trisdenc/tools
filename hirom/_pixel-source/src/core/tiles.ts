import { IndexedImage, createImage } from './image';
import {
  MAX_TILES,
  Project,
  SHEET_COLS,
  SHEET_WIDTH,
  SpriteAsset,
  Tilemap,
  Tileset,
  VRAM_LIMIT,
  cellFlip,
  cellTile,
  makeCell,
} from './project';

export const TILE_PX = 64;

/** Read an 8×8 tile from any indexed image (pixels outside the image read as 0). */
export function readBlock(img: IndexedImage, tx: number, ty: number, out = new Uint8Array(TILE_PX)): Uint8Array {
  for (let y = 0; y < 8; y++) {
    const sy = ty * 8 + y;
    for (let x = 0; x < 8; x++) {
      const sx = tx * 8 + x;
      out[y * 8 + x] = sx < img.width && sy < img.height ? img.pixels[sy * img.width + sx] : 0;
    }
  }
  return out;
}

export function writeBlock(img: IndexedImage, tx: number, ty: number, tile: Uint8Array): void {
  for (let y = 0; y < 8; y++) {
    const sy = ty * 8 + y;
    if (sy >= img.height) break;
    for (let x = 0; x < 8; x++) {
      const sx = tx * 8 + x;
      if (sx < img.width) img.pixels[sy * img.width + sx] = tile[y * 8 + x];
    }
  }
}

export const tileCount = (ts: Tileset): number => (ts.sheet.height / 8) * SHEET_COLS;
export const getTile = (sheet: IndexedImage, id: number, out?: Uint8Array) =>
  readBlock(sheet, id % SHEET_COLS, Math.floor(id / SHEET_COLS), out);

export function flipTile(t: Uint8Array, flip: number): Uint8Array {
  if (!flip) return t;
  const out = new Uint8Array(TILE_PX);
  for (let y = 0; y < 8; y++) {
    const sy = flip & 2 ? 7 - y : y;
    for (let x = 0; x < 8; x++) out[y * 8 + x] = t[sy * 8 + (flip & 1 ? 7 - x : x)];
  }
  return out;
}

export const tileKey = (t: Uint8Array): string => String.fromCharCode(...t);
export const isBlank = (t: Uint8Array): boolean => t.every((v) => v === 0);

/**
 * Canonical form of a tile under H/V flips: the lexicographically smallest of the four variants.
 * `flip` is what to apply to the canonical tile to get `t` back.
 */
export function canonical(t: Uint8Array, allowFlips = true): { key: string; flip: number; tile: Uint8Array } {
  let best = { key: tileKey(t), flip: 0, tile: t };
  if (!allowFlips) return best;
  for (let f = 1; f < 4; f++) {
    const v = flipTile(t, f);
    const k = tileKey(v);
    if (k < best.key) best = { key: k, flip: f, tile: v };
  }
  return best;
}

/** Build a sheet image (16 tiles wide) from a list of tiles. */
export function sheetFromTiles(tiles: Uint8Array[], bpp: IndexedImage['bpp'], minTiles = SHEET_COLS): IndexedImage {
  const rows = Math.max(1, Math.ceil(Math.max(tiles.length, minTiles) / SHEET_COLS));
  const sheet = createImage(SHEET_WIDTH, rows * 8, bpp);
  tiles.forEach((t, i) => writeBlock(sheet, i % SHEET_COLS, Math.floor(i / SHEET_COLS), t));
  return sheet;
}

export interface ConvertResult {
  tiles: Uint8Array[];
  cells: Uint16Array;
  widthTiles: number;
  heightTiles: number;
  /** Tile count before deduplication (every 8×8 block). */
  blocks: number;
}

/**
 * Cut an image into 8×8 tiles, deduplicating identical tiles (and H/V/HV-flipped variants when
 * `flips` is set). Tile 0 is always the blank tile. Map size is rounded up to `mapMultiple` tiles.
 */
export function imageToTiles(img: IndexedImage, opts: { flips: boolean; palette: number; mapMultiple?: number }): ConvertResult {
  const bw = Math.ceil(img.width / 8);
  const bh = Math.ceil(img.height / 8);
  const m = opts.mapMultiple ?? 1;
  const widthTiles = Math.ceil(bw / m) * m;
  const heightTiles = Math.ceil(bh / m) * m;
  const blank = new Uint8Array(TILE_PX);
  const tiles: Uint8Array[] = [blank];
  const index = new Map<string, number>([[tileKey(blank), 0]]);
  const cells = new Uint16Array(widthTiles * heightTiles);
  for (let ty = 0; ty < bh; ty++) {
    for (let tx = 0; tx < bw; tx++) {
      const c = canonical(readBlock(img, tx, ty), opts.flips);
      let id = index.get(c.key);
      if (id === undefined) {
        id = tiles.length;
        if (id >= MAX_TILES) throw new Error(`Image needs more than ${MAX_TILES} unique tiles.`);
        tiles.push(c.tile);
        index.set(c.key, id);
      }
      cells[ty * widthTiles + tx] = makeCell(id, id === 0 ? 0 : opts.palette, 0, c.flip);
    }
  }
  return { tiles, cells, widthTiles, heightTiles, blocks: bw * bh };
}

export interface OptimizeResult {
  tiles: Uint8Array[];
  /** New cell arrays, parallel to the input maps. */
  cells: Uint16Array[];
  before: number;
  after: number;
}

/**
 * Merge duplicate tiles (optionally including flips) across a tileset, optionally dropping
 * tiles no map references, and rewrite every map's cells to match. Tile 0 stays at index 0.
 */
export function optimizeTileset(
  ts: Tileset,
  maps: Tilemap[],
  opts: { flips: boolean; removeUnused: boolean },
): OptimizeResult {
  const n = tileCount(ts);
  const used = new Uint8Array(n);
  used[0] = 1;
  for (const m of maps) for (const w of m.cells) if (cellTile(w) < n) used[cellTile(w)] = 1;

  // Trailing blank tiles are just empty sheet space; don't count them as content.
  let last = 0;
  for (let i = 0; i < n; i++) if (!isBlank(getTile(ts.sheet, i)) || used[i]) last = i;

  const tiles: Uint8Array[] = [];
  const index = new Map<string, number>();
  const remap = new Int32Array(n).fill(-1);
  const remapFlip = new Uint8Array(n);
  for (let i = 0; i <= last; i++) {
    if (opts.removeUnused && !used[i] && i !== 0) continue;
    const c = canonical(getTile(ts.sheet, i), opts.flips && i !== 0);
    let id = i === 0 ? undefined : index.get(c.key);
    if (id === undefined) {
      id = tiles.length;
      tiles.push(c.tile);
      if (!index.has(c.key)) index.set(c.key, id);
    }
    remap[i] = id;
    remapFlip[i] = c.flip;
  }
  const cells = maps.map((m) => {
    const out = new Uint16Array(m.cells.length);
    for (let i = 0; i < m.cells.length; i++) {
      const w = m.cells[i];
      const t = cellTile(w);
      const nid = t < n && remap[t] >= 0 ? remap[t] : 0;
      const flip = cellFlip(w) ^ (t < n ? remapFlip[t] : 0);
      out[i] = (w & 0x3c00) | nid | (flip << 14);
    }
    return out;
  });
  return { tiles, cells, before: last + 1, after: tiles.length };
}

export function tileUsage(ts: Tileset, maps: Tilemap[]): Uint32Array {
  const counts = new Uint32Array(tileCount(ts));
  for (const m of maps) {
    if (m.tilesetId !== ts.id) continue;
    for (const w of m.cells) {
      const t = cellTile(w);
      if (t < counts.length) counts[t]++;
    }
  }
  return counts;
}

/** Tiles that would actually be uploaded: up to the last non-blank or referenced tile. */
export function loadedTiles(ts: Tileset, maps: Tilemap[]): number {
  const usage = tileUsage(ts, maps);
  const n = tileCount(ts);
  for (let i = n - 1; i >= 0; i--) {
    if ((i > 0 && usage[i]) || !isBlank(getTile(ts.sheet, i))) return i + 1;
  }
  return 1;
}

/** Unique non-empty 8×8 tiles across all frames of a sprite (H/V flips merged, like OAM flip bits). */
export function spriteUniqueTiles(sprite: SpriteAsset): number {
  const seen = new Set<string>();
  for (const f of sprite.frames) {
    const bw = Math.ceil(f.image.width / 8), bh = Math.ceil(f.image.height / 8);
    for (let ty = 0; ty < bh; ty++)
      for (let tx = 0; tx < bw; tx++) {
        const t = readBlock(f.image, tx, ty);
        if (!isBlank(t)) seen.add(canonical(t).key);
      }
  }
  return seen.size;
}

export interface VramItem {
  label: string;
  bytes: number;
  detail: string;
  kind: 'tiles' | 'map' | 'obj';
}

export interface VramReport {
  items: VramItem[];
  total: number;
  limit: number;
}

/** Total VRAM = Σ(unique tiles × bytes per tile) + Σ(tilemap sizes), for the scene's layers and sprites. */
export function vramReport(p: Project): VramReport {
  const items: VramItem[] = [];
  const layerMaps = p.scene.layers
    .map((l) => p.tilemaps.find((m) => m.id === l.tilemapId))
    .filter((m): m is Tilemap => !!m);
  const tsIds = [...new Set(layerMaps.map((m) => m.tilesetId))];
  for (const id of tsIds) {
    const ts = p.tilesets.find((t) => t.id === id);
    if (!ts) continue;
    const n = loadedTiles(ts, layerMaps);
    const bpt = ts.bpp * 8;
    items.push({ label: ts.name, bytes: n * bpt, detail: `${n} tiles × ${bpt} B (${ts.bpp}bpp)`, kind: 'tiles' });
  }
  for (const m of layerMaps) {
    items.push({ label: m.name, bytes: m.width * m.height * 2, detail: `${m.width}×${m.height} map × 2 B`, kind: 'map' });
  }
  for (const s of p.sprites) {
    const n = spriteUniqueTiles(s);
    if (n) items.push({ label: s.name, bytes: n * 32, detail: `${n} OBJ tiles × 32 B, all frames`, kind: 'obj' });
  }
  return { items, total: items.reduce((a, i) => a + i.bytes, 0), limit: VRAM_LIMIT };
}
