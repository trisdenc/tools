import { fileSafe } from '@pixel/io/tiled';
import { lzssCompress, rleCompress } from '../core/compress';
import type { Level, Workspace } from '../core/level';
import { SHAPE_NAMES, levelTiles, tilesPerMeta } from '../core/level';
import { findMetatile, readMeta } from '../core/metatiles';

/**
 * Hardware-ready binaries for 65c816 / PVSnesLib projects.
 *  - <level>_bgN.map: nametables in 32×32-tile screens (the size of one SNES tilemap page),
 *    screens ordered left→right, top→bottom; each screen is 1024 little-endian words
 *    (vhopppcc cccccccc), row-major. Areas past the level edge are word 0.
 *  - <level>_metatiles.bin: the collision layer's metatile set, one entry per id from 0 to the
 *    highest id: k×k words, row-major (TL, TR, BL, BR for 16×16). Missing ids are zero-filled.
 *  - <level>_metatile_collision.bin: one collision byte per metatile id.
 *  - <level>_bgN_metamap.bin: a u16 metatile id per metatile cell, row-major, when every cell of
 *    that layer matches a metatile (otherwise this file is skipped and the README says why).
 *  - <level>_collision.bin: one collision byte per metatile cell, row-major.
 * Every file also comes as .rle and .lzss (formats documented in compress.ts and the README).
 */
export interface BinFile {
  name: string;
  data: Uint8Array;
}

const words = (arr: ArrayLike<number>): Uint8Array => {
  const out = new Uint8Array(arr.length * 2);
  for (let i = 0; i < arr.length; i++) {
    out[i * 2] = arr[i] & 255;
    out[i * 2 + 1] = (arr[i] >> 8) & 255;
  }
  return out;
};

export function screenChunks(cells: Uint16Array, tw: number, th: number): { data: Uint8Array; cols: number; rows: number } {
  const cols = Math.ceil(tw / 32), rows = Math.ceil(th / 32);
  const out = new Uint16Array(cols * rows * 1024);
  for (let sy = 0; sy < rows; sy++)
    for (let sx = 0; sx < cols; sx++) {
      const base = (sy * cols + sx) * 1024;
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) {
          const gx = sx * 32 + x, gy = sy * 32 + y;
          if (gx < tw && gy < th) out[base + y * 32 + x] = cells[gy * tw + gx];
        }
    }
  return { data: words(out), cols, rows };
}

export function buildSnesExport(level: Level, ws: Workspace): BinFile[] {
  const base = fileSafe(level.meta.title).toLowerCase();
  const { w: tw, h: th } = levelTiles(level);
  const k = tilesPerMeta(level.meta.metatileSize);
  const W = level.meta.widthMetatiles, H = level.meta.heightMetatiles;
  const files: BinFile[] = [];
  const notes: string[] = [];

  level.layers.forEach((layer) => {
    const slot = layer.hwSlot.toLowerCase();
    const ch = screenChunks(layer.cells, tw, th);
    files.push({ name: `${base}_${slot}.map`, data: ch.data });
    notes.push(`${base}_${slot}.map: ${layer.hwSlot} "${layer.name}", ${ch.cols}×${ch.rows} screens of 32×32 tiles (${ch.data.length} bytes).`);
    const set = ws.metatileSets.find((s) => s.tilesetRef === layer.tilesetRef && s.size === level.meta.metatileSize);
    if (!set) return;
    const ids = new Uint16Array(W * H);
    let missing = 0;
    for (let my = 0; my < H; my++)
      for (let mx = 0; mx < W; mx++) {
        const m = findMetatile(set, readMeta(layer, tw, mx, my, k));
        if (m) ids[my * W + mx] = m.id;
        else missing++;
      }
    if (missing) notes.push(`${base}_${slot}_metamap.bin skipped: ${missing} cell(s) on ${layer.hwSlot} don't match a metatile in "${set.name}".`);
    else {
      files.push({ name: `${base}_${slot}_metamap.bin`, data: words(ids) });
      notes.push(`${base}_${slot}_metamap.bin: ${W}×${H} u16 metatile ids from "${set.name}".`);
    }
  });

  const colLayer = level.layers[level.collisionLayer];
  const set = ws.metatileSets.find((s) => s.tilesetRef === colLayer?.tilesetRef && s.size === level.meta.metatileSize);
  if (set) {
    const maxId = set.metatiles.reduce((m, t) => Math.max(m, t.id), 0);
    const table = new Uint16Array((maxId + 1) * k * k);
    const coll = new Uint8Array(maxId + 1);
    for (const m of set.metatiles) {
      table.set(m.words.slice(0, k * k), m.id * k * k);
      coll[m.id] = m.collision;
    }
    files.push({ name: `${base}_metatiles.bin`, data: words(table) }, { name: `${base}_metatile_collision.bin`, data: coll });
    notes.push(`${base}_metatiles.bin: ${maxId + 1} metatiles × ${k * k} words from "${set.name}".`);
  }
  files.push({ name: `${base}_collision.bin`, data: level.collision.slice() });
  notes.push(`${base}_collision.bin: ${W}×${H} bytes, one per ${level.meta.metatileSize}×${level.meta.metatileSize} cell.`);

  const compressed = files.flatMap((f) => [
    { name: f.name + '.rle', data: rleCompress(f.data) },
    { name: f.name + '.lzss', data: lzssCompress(f.data) },
  ]);

  const readme = [
    `HiROM Map SNES export — ${level.meta.title}`,
    ``,
    `Level: ${W}×${H} metatiles of ${level.meta.metatileSize}×${level.meta.metatileSize} px (${tw}×${th} tiles, Mode 1).`,
    ``,
    ...notes,
    ``,
    `Tilemap words: vhopppcc cccccccc (V flip, H flip, priority, 3-bit palette, 10-bit tile).`,
    `Collision byte: low nibble = shape (${SHAPE_NAMES.map((n, i) => `${i} ${n}`).join(', ')}),`,
    `high nibble = material id (${ws.materials.map((m) => `${m.id} ${m.name}`).join(', ') || 'none'}).`,
    ``,
    `Compressed copies (.rle, .lzss) start with the uncompressed length as a little-endian u16`,
    `(0xFFFF followed by a u32 if it doesn't fit).`,
    `RLE: control byte c < 0x80 = copy c+1 literal bytes; c >= 0x80 = repeat the next byte c-0x7E times.`,
    `LZSS: a flag byte then 8 items, LSB first. 1 = literal byte. 0 = two bytes b0, b1:`,
    `      distance = ((b1 >> 4) << 8 | b0) + 1 bytes back in the output, length = (b1 & 15) + 3.`,
    ``,
    `Tile graphics and palettes come from HiROM Pixel (export the tileset and its .pal there).`,
  ].join('\n');
  return [...files, ...compressed, { name: `${base}_README.txt`, data: new TextEncoder().encode(readme) }];
}
