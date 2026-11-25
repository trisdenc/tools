import { Bgr555, fromHsv, generateRamp, pack } from './color';

export type Bpp = 2 | 4 | 8;

export const CGRAM_SIZE = 256;

/** Colors per sub-palette for a bit depth: 4, 16, or 256. */
export const blockSize = (bpp: Bpp): number => 1 << bpp;

/** How many sub-palettes a bit depth can address (2bpp: 8 × 4 colors, 4bpp: 16 × 16, 8bpp: 1 × 256). */
export const paletteCount = (bpp: Bpp): number => (bpp === 2 ? 8 : bpp === 4 ? 16 : 1);

/** First CGRAM slot of sub-palette `id` at a bit depth. */
export const paletteBase = (bpp: Bpp, id: number): number => (bpp === 8 ? 0 : id * blockSize(bpp));

/** Map a CGRAM slot to (sub-palette, local index) for a bit depth, or null if unreachable. */
export function slotToPalette(bpp: Bpp, slot: number): { paletteId: number; local: number } | null {
  const bs = blockSize(bpp);
  const paletteId = Math.floor(slot / bs);
  if (paletteId >= paletteCount(bpp)) return null;
  return { paletteId, local: slot % bs };
}

/** Index 0 of every sub-palette is transparent, except CGRAM slot 0 which is the backdrop. */
export const isTransparentSlot = (bpp: Bpp, slot: number): boolean => slot !== 0 && slot % blockSize(bpp) === 0;

export const paletteType = (id: number): 'BG' | 'OBJ' => (id < 8 ? 'BG' : 'OBJ');

type Hsv = [number, number, number];

// Two 7-color ramps per sub-palette (base colors in HSV). Palettes 0–7 lean towards
// background materials, 8–15 towards characters and FX.
const DEFAULT_SPECS: [Hsv, Hsv][] = [
  [[0, 0, 0.55], [30, 0.55, 0.55]], // 0 stone / wood
  [[110, 0.6, 0.6], [165, 0.5, 0.55]], // 1 forest
  [[215, 0.65, 0.65], [190, 0.55, 0.75]], // 2 water
  [[220, 0.18, 0.55], [42, 0.45, 0.8]], // 3 brick / sand
  [[2, 0.75, 0.75], [24, 0.85, 0.9]], // 4 lava
  [[275, 0.5, 0.6], [320, 0.45, 0.75]], // 5 crystal
  [[50, 0.7, 0.85], [78, 0.55, 0.55]], // 6 grass / gold
  [[205, 0.45, 0.85], [230, 0.08, 0.9]], // 7 sky / cloud
  [[22, 0.42, 0.85], [220, 0.65, 0.65]], // 8 hero skin / tunic
  [[355, 0.7, 0.7], [44, 0.75, 0.85]], // 9 red / gold
  [[120, 0.55, 0.6], [28, 0.6, 0.5]], // 10 goblin
  [[270, 0.45, 0.55], [0, 0, 0.6]], // 11 ghost / armor
  [[18, 0.9, 0.9], [52, 0.85, 0.95]], // 12 fire FX
  [[195, 0.45, 0.85], [210, 0.12, 0.92]], // 13 ice FX
  [[250, 0.6, 0.45], [300, 0.65, 0.7]], // 14 shadow / magic
  [[0, 0, 0.5], [350, 0.8, 0.65]], // 15 UI
];

export function createDefaultCgram(): Uint16Array {
  const c = new Uint16Array(CGRAM_SIZE);
  DEFAULT_SPECS.forEach(([a, b], p) => {
    const base = p * 16;
    c[base] = 0;
    c[base + 1] = fromHsv(a[0], Math.min(1, a[1] + 0.3), 0.13); // tinted outline
    generateRamp(fromHsv(...a), 7).forEach((col, i) => (c[base + 2 + i] = col));
    generateRamp(fromHsv(...b), 7).forEach((col, i) => (c[base + 9 + i] = col));
  });
  c[0] = pack(3, 4, 8); // backdrop: deep navy
  return c;
}

export function cloneCgram(c: Uint16Array): Uint16Array {
  return new Uint16Array(c);
}

export type { Bgr555 };
