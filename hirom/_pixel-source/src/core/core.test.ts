import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { expand5, fromHex, fromRgb8, generateRamp, pack, quantize8, toHsv, toRgb8, unpack } from './color';
import { createDefaultCgram, isTransparentSlot, paletteBase, slotToPalette } from './cgram';
import { Editor } from './editor';
import { ditherOn, ellipse, floodRegion, line, rect } from './raster';
import { crc32, encodeIndexedPng, zlibStored } from '../io/png';
import { decodePal, encodePal } from '../io/palfile';

const collect = (fn: (p: (x: number, y: number) => void) => void) => {
  const pts: string[] = [];
  fn((x, y) => pts.push(`${x},${y}`));
  return pts;
};

describe('BGR555 color', () => {
  it('expands 5-bit channels to the full 8-bit range', () => {
    expect(expand5(0)).toBe(0);
    expect(expand5(31)).toBe(255);
    expect(expand5(16)).toBe(132);
  });
  it('quantize8 inverts expand5 exactly for every channel value', () => {
    for (let c = 0; c < 32; c++) expect(quantize8(expand5(c))).toBe(c);
  });
  it('packs as 0bbbbbgggggrrrrr', () => {
    expect(pack(31, 0, 0)).toBe(0x001f);
    expect(pack(0, 31, 0)).toBe(0x03e0);
    expect(pack(0, 0, 31)).toBe(0x7c00);
    expect(unpack(0x7fff)).toEqual([31, 31, 31]);
  });
  it('snaps arbitrary RGB to the nearest 15-bit color', () => {
    expect(fromRgb8(255, 255, 255)).toBe(0x7fff);
    expect(toRgb8(fromRgb8(250, 3, 129))).toEqual([247, 0, 132]);
    expect(fromHex('#fff')).toBe(0x7fff);
    expect(fromHex('nope')).toBeNull();
  });
  it('ramps go from dark to light around the base color', () => {
    const ramp = generateRamp(pack(10, 20, 12), 7);
    expect(ramp).toHaveLength(7);
    const vs = ramp.map((c) => toHsv(c)[2]);
    for (let i = 1; i < vs.length; i++) expect(vs[i]).toBeGreaterThanOrEqual(vs[i - 1]);
  });
});

describe('CGRAM layout', () => {
  it('maps slots to sub-palettes per bit depth', () => {
    expect(paletteBase(4, 8)).toBe(128);
    expect(paletteBase(2, 3)).toBe(12);
    expect(slotToPalette(4, 130)).toEqual({ paletteId: 8, local: 2 });
    expect(slotToPalette(2, 40)).toBeNull(); // 2bpp only reaches CGRAM 0–31
    expect(isTransparentSlot(4, 16)).toBe(true);
    expect(isTransparentSlot(4, 0)).toBe(false); // backdrop
  });
  it('default palettes are valid 15-bit colors', () => {
    const c = createDefaultCgram();
    expect(c.every((v) => v <= 0x7fff)).toBe(true);
  });
});

describe('raster', () => {
  it('Bresenham lines include both endpoints with no gaps', () => {
    const pts = collect((p) => line(0, 0, 7, 3, p));
    expect(pts[0]).toBe('0,0');
    expect(pts[pts.length - 1]).toBe('7,3');
    expect(pts).toHaveLength(8);
  });
  it('rect outline has no duplicate pixels', () => {
    const pts = collect((p) => rect(0, 0, 3, 2, false, p));
    expect(new Set(pts).size).toBe(pts.length);
    expect(pts).toHaveLength(10);
  });
  it.each([
    [0, 0, 2, 2],
    [0, 0, 3, 3],
    [0, 0, 7, 4],
    [2, 1, 12, 9],
    [0, 0, 15, 15],
    [0, 0, 1, 5],
  ])('ellipse %i,%i–%i,%i touches every edge of its box and is symmetric', (x0, y0, x1, y1) => {
    const pts = collect((p) => ellipse(x0, y0, x1, y1, false, p)).map((s) => s.split(',').map(Number));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    expect(Math.min(...xs)).toBe(x0);
    expect(Math.max(...xs)).toBe(x1);
    expect(Math.min(...ys)).toBe(y0);
    expect(Math.max(...ys)).toBe(y1);
    const set = new Set(pts.map((p) => `${p[0]},${p[1]}`));
    for (const [x, y] of pts) {
      expect(set.has(`${x0 + x1 - x},${y}`)).toBe(true);
      expect(set.has(`${x},${y0 + y1 - y}`)).toBe(true);
    }
  });
  it('flood fill is 4-connected and can wrap', () => {
    // 4×3, column 2 is a wall
    const px = Uint8Array.from([0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(floodRegion(4, 3, px, 0, 0).length).toBe(6);
    expect(floodRegion(4, 3, px, 0, 0, true).length).toBe(9);
  });
  it('bayer density controls coverage', () => {
    let on = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) on += +ditherOn('bayer4', x, y, 0.25);
    expect(on).toBe(4);
  });
});

function canvasEditor(w = 8, h = 8): Editor {
  const ed = new Editor();
  ed.addCanvas('test', w, h, 4);
  ed.history.clear();
  ed.primary = 1;
  return ed;
}

describe('Editor', () => {
  const fresh = () => canvasEditor();

  it('pixel-perfect pencil removes L-shaped corners', () => {
    const ed = fresh();
    ed.primary = 3;
    ed.pointerDown(0, 0, 0);
    ed.pointerMove(1, 0);
    ed.pointerMove(1, 1);
    ed.pointerUp();
    const p = ed.image.pixels;
    expect(p[0]).toBe(3);
    expect(p[1]).toBe(0); // the corner pixel was cleaned up
    expect(p[9]).toBe(3);
  });

  it('interpolates between distant pointer samples', () => {
    const ed = fresh();
    ed.pointerDown(0, 0, 0);
    ed.pointerMove(7, 0);
    ed.pointerUp();
    expect(Array.from(ed.image.pixels.subarray(0, 8))).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('undo/redo restores exact pixels with sparse deltas', () => {
    const ed = fresh();
    ed.setTool('rect');
    ed.setSetting('filled', true);
    ed.pointerDown(1, 1, 0);
    ed.pointerMove(6, 6);
    ed.pointerMove(3, 3); // preview shrinks; earlier preview must be reverted
    ed.pointerUp();
    const painted = ed.image.pixels.reduce((n, v) => n + (v ? 1 : 0), 0);
    expect(painted).toBe(9);
    const e = ed.history.peekUndo();
    expect(e?.kind === 'pixels' && e.idx.length).toBe(9);
    ed.undo();
    expect(ed.image.pixels.every((v) => v === 0)).toBe(true);
    ed.redo();
    expect(ed.image.pixels.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe(9);
  });

  it('mirror drawing paints symmetric pixels', () => {
    const ed = fresh();
    ed.setSetting('mirrorH', true);
    ed.pointerDown(1, 2, 0);
    ed.pointerUp();
    expect(ed.image.pixels[2 * 8 + 1]).toBe(1);
    expect(ed.image.pixels[2 * 8 + 6]).toBe(1);
  });

  it('right button draws with the secondary color; eraser writes index 0', () => {
    const ed = fresh();
    ed.secondary = 5;
    ed.pointerDown(0, 0, 2);
    ed.pointerUp();
    expect(ed.image.pixels[0]).toBe(5);
    ed.setTool('eraser');
    ed.pointerDown(0, 0, 0);
    ed.pointerUp();
    expect(ed.image.pixels[0]).toBe(0);
  });

  it('palette swaps change colors without touching pixels', () => {
    const ed = fresh();
    ed.pointerDown(0, 0, 0);
    ed.pointerUp();
    ed.setPaletteId(8);
    const before = ed.colorOf(1);
    ed.setPaletteId(9);
    expect(ed.image.pixels[0]).toBe(1);
    expect(ed.colorOf(1)).toBe(ed.cgram[9 * 16 + 1]);
    expect(ed.colorOf(1)).not.toBe(before);
  });

  it('rapid edits to one color coalesce into one undo step', () => {
    const ed = fresh();
    const orig = ed.cgram[130];
    ed.setColor(130, 1);
    ed.setColor(130, 2);
    ed.setColor(130, 3);
    expect(ed.history.undoCount).toBe(1);
    ed.undo();
    expect(ed.cgram[130]).toBe(orig);
  });

  it('keeps 250 undo steps of strokes in very little memory', () => {
    const ed = canvasEditor(512, 512);
    for (let i = 0; i < 250; i++) {
      ed.pointerDown(0, i, 0);
      ed.pointerMove(511, i);
      ed.pointerUp();
    }
    expect(ed.history.undoCount).toBe(250);
    expect(ed.history.bytes()).toBeLessThan(5 * 1024 * 1024);
  });
});

describe('file formats', () => {
  it('stored zlib stream inflates back to the input', () => {
    const data = Uint8Array.from({ length: 70000 }, (_, i) => i * 7);
    expect(Buffer.from(inflateSync(zlibStored(data)))).toEqual(Buffer.from(data));
  });

  it('writes a valid indexed PNG', async () => {
    const png = await encodeIndexedPng({
      width: 3,
      height: 2,
      indices: Uint8Array.from([0, 1, 2, 2, 1, 0]),
      palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0]],
      transparentZero: true,
    });
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks: Record<string, Uint8Array> = {};
    const dv = new DataView(png.buffer);
    for (let o = 8; o < png.length; ) {
      const len = dv.getUint32(o);
      const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
      expect(dv.getUint32(o + 8 + len)).toBe(crc32(png.subarray(o + 4, o + 8 + len)));
      chunks[type] = png.subarray(o + 8, o + 8 + len);
      o += 12 + len;
    }
    expect(Object.keys(chunks)).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
    expect(chunks.IHDR[9]).toBe(3); // indexed color type
    expect(Array.from(inflateSync(chunks.IDAT))).toEqual([0, 0, 1, 2, 0, 2, 1, 0]);
  });

  it('.pal round-trips as 512 bytes of little-endian BGR555', () => {
    const c = createDefaultCgram();
    const bytes = encodePal(c);
    expect(bytes.length).toBe(512);
    expect(bytes[2 * 130] | (bytes[2 * 130 + 1] << 8)).toBe(c[130]);
    expect(decodePal(bytes)).toEqual(c);
  });
});
