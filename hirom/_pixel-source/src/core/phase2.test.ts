import { describe, expect, it } from 'vitest';
import { pack } from './color';
import { Editor } from './editor';
import { createImage } from './image';
import { cellFlip, cellPal, cellPrio, cellTile, createSprite, cycledCgram, frameAt, makeCell } from './project';
import { OBJ_MATH, OBJ_OPAQUE, buildObjBuffer, colorMath } from './scene';
import { canonical, flipTile, getTile, imageToTiles, optimizeTileset, sheetFromTiles, vramReport } from './tiles';
import { parseProject, serializeProject } from '../io/project';
import { buildTiled } from '../io/tiled';
import { makeZip } from '../io/zip';

const tile = (fn: (x: number, y: number) => number) => Uint8Array.from({ length: 64 }, (_, i) => fn(i % 8, i >> 3));
/** An asymmetric tile, so all four flips differ. */
const ASYM = tile((x, y) => (x === 0 || (y === 0 && x < 3) ? 3 : 0));

describe('tilemap words', () => {
  it('pack as vhopppcc cccccccc', () => {
    const w = makeCell(0x2ab, 5, 1, 3);
    expect(w).toBe(0x8000 | 0x4000 | 0x2000 | (5 << 10) | 0x2ab);
    expect([cellTile(w), cellPal(w), cellPrio(w), cellFlip(w)]).toEqual([0x2ab, 5, 1, 3]);
  });
});

describe('tile deduplication', () => {
  it('flip variants share one canonical form', () => {
    const keys = [0, 1, 2, 3].map((f) => canonical(flipTile(ASYM, f)).key);
    expect(new Set(keys).size).toBe(1);
    for (let f = 0; f < 4; f++) {
      const c = canonical(flipTile(ASYM, f));
      expect(flipTile(c.tile, c.flip)).toEqual(flipTile(ASYM, f));
    }
  });

  it('cuts an image into unique tiles, reusing flipped copies', () => {
    // 4 blocks: ASYM, H-flipped ASYM, blank, ASYM again.
    const img = createImage(16, 16, 4);
    const put = (bx: number, by: number, t: Uint8Array) => {
      for (let i = 0; i < 64; i++) img.pixels[(by * 8 + (i >> 3)) * 16 + bx * 8 + (i & 7)] = t[i];
    };
    put(0, 0, ASYM);
    put(1, 0, flipTile(ASYM, 1));
    put(1, 1, ASYM);
    const withFlips = imageToTiles(img, { flips: true, palette: 2 });
    expect(withFlips.tiles).toHaveLength(2); // blank + one shape
    expect(cellTile(withFlips.cells[0])).toBe(cellTile(withFlips.cells[1]));
    expect(cellFlip(withFlips.cells[0]) ^ cellFlip(withFlips.cells[1])).toBe(1);
    expect(cellTile(withFlips.cells[2])).toBe(0);
    expect(cellPal(withFlips.cells[3])).toBe(2);
    expect(imageToTiles(img, { flips: false, palette: 0 }).tiles).toHaveLength(3);
  });

  it('optimizing a tileset preserves the rendered map', () => {
    const tiles = [new Uint8Array(64), ASYM, flipTile(ASYM, 2), tile(() => 1), ASYM];
    const ts = { id: 'ts', name: 't', bpp: 4 as const, sheet: sheetFromTiles(tiles, 4), paletteId: 0 };
    const cells = Uint16Array.from([makeCell(1, 3), makeCell(2, 0, 1, 1), makeCell(4), makeCell(3, 7)]);
    const map = { id: 'm', name: 'm', tilesetId: 'ts', width: 4, height: 1, cells };
    const render = (sheet: typeof ts.sheet, c: Uint16Array) => [...c].map((w) => [...flipTile(getTile(sheet, cellTile(w)), cellFlip(w))].join(''));
    const before = render(ts.sheet, cells);
    const r = optimizeTileset(ts, [map], { flips: true, removeUnused: true });
    expect(r.after).toBe(3); // blank, ASYM, solid
    const after = render(sheetFromTiles(r.tiles, 4), r.cells[0]);
    expect(after).toEqual(before);
    // Palette and priority bits survive the rewrite.
    expect(cellPal(r.cells[0][0])).toBe(3);
    expect(cellPrio(r.cells[0][1])).toBe(1);
  });

  it('editor optimize is undoable', () => {
    const ed = new Editor();
    const ts = ed.project.tilesets[0];
    ts.sheet = sheetFromTiles([new Uint8Array(64), ASYM, ASYM], 4, 256);
    const map = ed.project.tilemaps[0];
    map.cells[0] = makeCell(2);
    const oldSheet = ts.sheet;
    ed.optimizeTileset(ts.id, { flips: true, removeUnused: false });
    expect(cellTile(map.cells[0])).toBe(1);
    ed.undo();
    expect(ts.sheet).toBe(oldSheet);
    expect(cellTile(map.cells[0])).toBe(2);
  });
});

describe('VRAM budget', () => {
  it('counts tiles by bpp, maps at 2 bytes per cell, and sprite tiles', () => {
    const ed = new Editor();
    const p = ed.project;
    p.tilesets[0].sheet = sheetFromTiles([new Uint8Array(64), ASYM, tile(() => 1)], 4, 256);
    const r = vramReport(p);
    const chr = r.items.find((i) => i.label === p.tilesets[0].name)!;
    expect(chr.bytes).toBe(3 * 32);
    expect(r.items.filter((i) => i.kind === 'map').map((i) => i.bytes)).toEqual([4096, 4096, 4096]);
    p.sprites[0].frames[0].image.pixels[0] = 1;
    expect(vramReport(p).items.find((i) => i.kind === 'obj')!.bytes).toBe(32);
  });
});

describe('animation & palette cycling', () => {
  it('frameAt follows per-frame durations and loops', () => {
    const s = createSprite('s', 8, 8);
    s.frames.push({ ...s.frames[0], duration: 2 });
    s.frames[0].duration = 3;
    expect([0, 1, 2, 3, 4, 5].map((t) => frameAt(s, t))).toEqual([0, 0, 0, 1, 1, 0]);
  });

  it('cycles rotate a contiguous range', () => {
    const cg = new Uint16Array(256).map((_, i) => i);
    const out = cycledCgram(cg, [{ id: 'c', paletteId: 1, start: 2, end: 4, framesPerStep: 2, reverse: false, enabled: true }], 2);
    expect([out[18], out[19], out[20]]).toEqual([20, 18, 19]);
    expect(out[17]).toBe(17);
  });
});

describe('scene compositing', () => {
  it('color math matches SNES 5-bit rules', () => {
    expect(colorMath(pack(20, 10, 0), pack(20, 5, 3), 'add', false)).toBe(pack(31, 15, 3));
    expect(colorMath(pack(20, 10, 0), pack(20, 5, 3), 'add', true)).toBe(pack(20, 7, 1));
    expect(colorMath(pack(5, 10, 0), pack(20, 5, 3), 'sub', false)).toBe(pack(0, 5, 0));
    expect(colorMath(pack(20, 10, 0), pack(4, 4, 4), 'add', true, false)).toBe(pack(24, 14, 4));
  });

  it('rasterizes OBJ priority, palette and the palette 12–15 math rule', () => {
    const ed = new Editor();
    const p = ed.project;
    const s = p.sprites[0];
    s.originX = 0;
    s.originY = 0;
    s.frames[0].image.pixels[0] = 5;
    p.scene.objects.push({ id: 'o', spriteId: s.id, x: 2, y: 1, priority: 3, hFlip: false, colorMath: true });
    const region = { x: 0, y: 0, w: 4, h: 4 };
    let buf = buildObjBuffer(p, region, 0, false);
    expect(buf[1 * 4 + 2]).toBe(OBJ_OPAQUE | (3 << 8) | (8 * 16 + 5)); // palette 8: no math in strict mode
    s.paletteId = 12;
    buf = buildObjBuffer(p, region, 0, false);
    expect(buf[1 * 4 + 2] & OBJ_MATH).toBe(OBJ_MATH);
  });
});

describe('scene editing', () => {
  it('paints stamps with palette and priority, and undoes them', () => {
    const ed = new Editor();
    ed.setTarget({ kind: 'scene' });
    ed.stamp = { w: 2, h: 1, cells: Uint16Array.of(5, 6 | 0x4000) };
    ed.scenePalette = 3;
    ed.paintPriority = true;
    ed.pointerDown(17, 9, 0); // cell (2,1)
    ed.pointerUp();
    const map = ed.layerMap!;
    expect(map.cells[map.width + 2]).toBe(makeCell(5, 3, 1));
    expect(map.cells[map.width + 3]).toBe(makeCell(6, 3, 1, 1));
    ed.undo();
    expect(map.cells[map.width + 2]).toBe(0);
  });

  it('places, moves and deletes objects with undo', () => {
    const ed = new Editor();
    ed.setTarget({ kind: 'scene' });
    ed.setTool('object');
    ed.pointerDown(40, 40, 0);
    ed.pointerUp();
    expect(ed.project.scene.objects).toHaveLength(1);
    ed.pointerDown(40, 35, 0); // inside the 32×32 sprite (origin bottom-centre)
    ed.pointerMove(50, 35);
    ed.pointerUp();
    expect(ed.project.scene.objects[0].x).toBe(50);
    ed.undo();
    expect(ed.project.scene.objects[0].x).toBe(40);
    ed.undo();
    expect(ed.project.scene.objects).toHaveLength(0);
  });

  it('converts a canvas to a deduplicated BG layer', () => {
    const ed = new Editor();
    const cv = ed.project.canvases[0];
    cv.image.pixels.fill(2);
    const r = ed.canvasToLayer(cv.id, 0, true);
    expect(r).toMatchObject({ blocks: 16, tiles: 2, palette: 0, copiedFrom: 8 });
    expect(ed.cgram.slice(0, 16)).toEqual(ed.cgram.slice(128, 144));
    expect(ed.layerMap!.width).toBe(32);
    ed.undo();
    expect(ed.project.tilesets).toHaveLength(2);
  });

  it('frames can be added, duplicated and removed', () => {
    const ed = new Editor();
    const s = ed.project.sprites[0];
    ed.setTarget({ kind: 'sprite', id: s.id, frame: 0 });
    ed.image.pixels[0] = 4;
    ed.addFrame(true);
    expect(s.frames).toHaveLength(2);
    expect(ed.frameIndex).toBe(1);
    expect(ed.image.pixels[0]).toBe(4);
    expect(ed.image).not.toBe(s.frames[0].image);
    ed.deleteFrame();
    expect(s.frames).toHaveLength(1);
    ed.undo();
    expect(s.frames).toHaveLength(2);
  });
});

describe('project files', () => {
  it('round-trips everything', () => {
    const ed = new Editor();
    const p = ed.project;
    p.tilesets[0].sheet = sheetFromTiles([new Uint8Array(64), ASYM], 4, 256);
    p.tilemaps[0].cells[5] = makeCell(1, 2, 1, 3);
    p.sprites[0].frames[0].hitboxes.push({ x: 1, y: 2, w: 3, h: 4 });
    p.cycles.push({ id: 'c', paletteId: 2, start: 1, end: 4, framesPerStep: 5, reverse: true, enabled: true });
    p.scene.objects.push({ id: 'o', spriteId: p.sprites[0].id, x: 9, y: 8, priority: 1, hFlip: true, colorMath: false });
    p.scene.layers[2].math = true;
    p.scene.layers[1].sub = true;
    const back = parseProject(JSON.parse(JSON.stringify(serializeProject(p))));
    expect(back.tilesets[0].sheet.pixels).toEqual(p.tilesets[0].sheet.pixels);
    expect(back.tilemaps[0].cells).toEqual(p.tilemaps[0].cells);
    expect(back.sprites[0].frames[0].hitboxes).toEqual([{ x: 1, y: 2, w: 3, h: 4 }]);
    expect(back.cycles).toEqual(p.cycles);
    expect(back.scene.objects).toEqual(p.scene.objects);
    expect(back.scene.layers.map((l) => [l.math, l.sub])).toEqual(p.scene.layers.map((l) => [l.math, l.sub]));
    expect(back.cgram).toEqual(p.cgram);
  });

  it('opens Phase 1 (canvas-only) files', () => {
    const phase1 = {
      schemaVersion: '1.0.0',
      meta: { title: 'Old', resolution: { width: 2, height: 1 }, bgMode: 1, strictVramLimit: true },
      cgram: { palettes: [], cycles: [] },
      canvases: [{ id: 'cv_main', name: 'Old', width: 2, height: 1, bpp: 4, paletteId: 8, indexedPixelsBase64: btoa('\x01\x02') }],
      tilesets: [],
      tilemaps: [],
      sprites: [],
    };
    const p = parseProject(phase1);
    expect(p.canvases[0].image.pixels).toEqual(Uint8Array.of(1, 2));
    expect(p.scene.layers).toHaveLength(3);
  });
});

describe('Tiled export', () => {
  it('encodes palettes as tileset slots and flips as gid flags', () => {
    const ed = new Editor();
    const p = ed.project;
    p.tilesets[0].sheet = sheetFromTiles([new Uint8Array(64), ASYM], 4, 256);
    const map = p.tilemaps[0];
    map.cells[0] = makeCell(1, 2, 0, 1);
    map.cells[1] = makeCell(1, 5);
    const t = buildTiled(p);
    const tmj = t.tmj as { layers: { name: string; data?: number[] }[]; tilesets: { firstgid: number; tilecount: number }[] };
    const bg1 = tmj.layers.find((l) => l.name === 'BG1')!.data!;
    const n = 256;
    expect(bg1[0]).toBe((0x80000000 | (1 + 0 * n + 1)) >>> 0); // palette 2 → slot 0, H flip
    expect(bg1[1]).toBe(1 + 1 * n + 1); // palette 5 → slot 1
    expect(bg1[2]).toBe(0); // blank tile → empty
    expect(tmj.tilesets[0].tilecount).toBe(2 * n);
    expect(t.images[0].height).toBe(p.tilesets[0].sheet.height * 2);
    expect(t.tmx).toContain('parallaxx="0.5"');
  });

  it('zip has valid local and central headers', () => {
    const z = makeZip([{ name: 'a.txt', data: new TextEncoder().encode('hi') }]);
    const dv = new DataView(z.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint32(z.length - 22, true)).toBe(0x06054b50);
    const cdOffset = dv.getUint32(z.length - 6, true);
    expect(dv.getUint32(cdOffset, true)).toBe(0x02014b50);
  });
});
