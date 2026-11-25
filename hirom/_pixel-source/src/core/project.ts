import { Bgr555 } from './color';
import { Bpp, createDefaultCgram } from './cgram';
import { IndexedImage, createImage } from './image';

/** Tileset sheets are always 16 tiles (128 px) wide, YY-CHR style; tile n sits at column n%16, row n/16. */
export const SHEET_COLS = 16;
export const SHEET_WIDTH = SHEET_COLS * 8;
/** Tilemap words address 10-bit tile numbers. */
export const MAX_TILES = 1024;
export const VRAM_LIMIT = 65536;

export type BgLayerId = 'BG1' | 'BG2' | 'BG3';
export const BG_LAYERS: BgLayerId[] = ['BG1', 'BG2', 'BG3'];
/** Mode 1 bit depth per background layer. */
export const MODE1_BPP: Record<BgLayerId, Bpp> = { BG1: 4, BG2: 4, BG3: 2 };

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasAsset {
  id: string;
  name: string;
  image: IndexedImage;
  paletteId: number;
}

export interface Tileset {
  id: string;
  name: string;
  bpp: Bpp;
  sheet: IndexedImage;
  /** Palette used when viewing / editing the sheet (tiles themselves have no palette). */
  paletteId: number;
}

export interface Tilemap {
  id: string;
  name: string;
  tilesetId: string;
  width: number;
  height: number;
  /** SNES tilemap words: vhopppcc cccccccc. */
  cells: Uint16Array;
}

export interface SpriteFrame {
  image: IndexedImage;
  /** Duration in 60 Hz ticks. */
  duration: number;
  hitboxes: Box[];
  hurtboxes: Box[];
}

export interface SpriteAsset {
  id: string;
  name: string;
  width: number;
  height: number;
  /** CGRAM sub-palette, 8–15 (OBJ). */
  paletteId: number;
  /** Anchor point, in frame pixels; scene objects are positioned by it. */
  originX: number;
  originY: number;
  frames: SpriteFrame[];
}

export interface PaletteCycle {
  id: string;
  /** CGRAM sub-palette 0–15. */
  paletteId: number;
  /** Inclusive local index range within the sub-palette. */
  start: number;
  end: number;
  framesPerStep: number;
  reverse: boolean;
  enabled: boolean;
}

export interface SceneLayer {
  id: BgLayerId;
  tilemapId: string;
  visible: boolean;
  main: boolean;
  sub: boolean;
  /** Participates in color math when it is the main-screen pixel. */
  math: boolean;
  scrollFactor: number;
}

export interface SceneObject {
  id: string;
  spriteId: string;
  x: number;
  y: number;
  priority: 0 | 1 | 2 | 3;
  hFlip: boolean;
  /** Request color math; on hardware only OBJ palettes 12–15 honour it (enforced in strict mode). */
  colorMath: boolean;
}

export interface ColorMathSettings {
  mode: 'add' | 'sub';
  half: boolean;
  /** Blend against the sub screen, or against the fixed color (COLDATA). */
  source: 'subscreen' | 'fixed';
  fixedColor: Bgr555;
  backdropMath: boolean;
}

export interface Scene {
  resolution: { width: number; height: number };
  layers: SceneLayer[];
  /** $2105 bit 3: BG3 high-priority tiles go in front of everything. */
  bg3Priority: boolean;
  obj: { visible: boolean; main: boolean; sub: boolean };
  objects: SceneObject[];
  colorMath: ColorMathSettings;
  /** Auto-scroll speed in pixels per frame while playing. */
  scroll: { speedX: number; speedY: number };
}

export interface Project {
  title: string;
  /** Strict SNES limits (64 KB VRAM, OBJ color-math palette rule) vs. Modern 16-bit mode. */
  strict: boolean;
  cgram: Uint16Array;
  cycles: PaletteCycle[];
  canvases: CanvasAsset[];
  tilesets: Tileset[];
  tilemaps: Tilemap[];
  sprites: SpriteAsset[];
  scene: Scene;
}

export const uid = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

export function createTileset(name: string, bpp: Bpp, tiles = 256): Tileset {
  const rows = Math.max(1, Math.ceil(tiles / SHEET_COLS));
  return { id: uid('ts'), name, bpp, sheet: createImage(SHEET_WIDTH, rows * 8, bpp), paletteId: 0 };
}

export function createTilemap(name: string, tilesetId: string, width = 64, height = 32): Tilemap {
  return { id: uid('map'), name, tilesetId, width, height, cells: new Uint16Array(width * height) };
}

export function createFrame(w: number, h: number, duration = 8): SpriteFrame {
  return { image: createImage(w, h, 4), duration, hitboxes: [], hurtboxes: [] };
}

export function createSprite(name: string, width: number, height: number): SpriteAsset {
  return {
    id: uid('spr'),
    name,
    width,
    height,
    paletteId: 8,
    originX: Math.floor(width / 2),
    originY: height - 1,
    frames: [createFrame(width, height)],
  };
}

export function createCanvas(name: string, width: number, height: number, bpp: Bpp): CanvasAsset {
  return { id: uid('cv'), name, image: createImage(width, height, bpp), paletteId: bpp === 4 ? 8 : 0 };
}

export function createDefaultProject(): Project {
  const tsMain = createTileset('BG tiles', 4, 256);
  const tsHud = createTileset('BG3 tiles', 2, 128);
  const maps = [
    createTilemap('BG1 map', tsMain.id),
    createTilemap('BG2 map', tsMain.id),
    createTilemap('BG3 map', tsHud.id),
  ];
  const factors = [1, 0.5, 0.25];
  return {
    title: 'Untitled Project',
    strict: true,
    cgram: createDefaultCgram(),
    cycles: [],
    canvases: [createCanvas('Sketch', 32, 32, 4)],
    tilesets: [tsMain, tsHud],
    tilemaps: maps,
    sprites: [createSprite('Hero', 32, 32)],
    scene: {
      resolution: { width: 256, height: 224 },
      layers: BG_LAYERS.map((id, i) => ({
        id,
        tilemapId: maps[i].id,
        visible: true,
        main: true,
        sub: false,
        math: false,
        scrollFactor: factors[i],
      })),
      bg3Priority: false,
      obj: { visible: true, main: true, sub: false },
      objects: [],
      colorMath: { mode: 'add', half: true, source: 'subscreen', fixedColor: 0, backdropMath: false },
      scroll: { speedX: 1, speedY: 0 },
    },
  };
}

// ---- tilemap words ------------------------------------------------------------------------------

export const cellTile = (w: number): number => w & 0x3ff;
export const cellPal = (w: number): number => (w >> 10) & 7;
export const cellPrio = (w: number): number => (w >> 13) & 1;
export const cellH = (w: number): boolean => (w & 0x4000) !== 0;
export const cellV = (w: number): boolean => (w & 0x8000) !== 0;
/** Flip bits as a 2-bit number: 1 = H, 2 = V. */
export const cellFlip = (w: number): number => (w >> 14) & 3;

export function makeCell(tile: number, pal = 0, prio = 0, flip = 0): number {
  return (tile & 0x3ff) | ((pal & 7) << 10) | ((prio & 1) << 13) | ((flip & 3) << 14);
}

/** Frame index of an animation at a tick (loops). */
export function frameAt(sprite: SpriteAsset, tick: number): number {
  const total = sprite.frames.reduce((n, f) => n + Math.max(1, f.duration), 0);
  let t = ((tick % total) + total) % total;
  for (let i = 0; i < sprite.frames.length; i++) {
    t -= Math.max(1, sprite.frames[i].duration);
    if (t < 0) return i;
  }
  return 0;
}

/** CGRAM with palette cycles applied for a tick. */
export function cycledCgram(cgram: Uint16Array, cycles: PaletteCycle[], tick: number, out = new Uint16Array(256)): Uint16Array {
  out.set(cgram);
  for (const c of cycles) {
    if (!c.enabled) continue;
    const lo = Math.min(c.start, c.end), hi = Math.max(c.start, c.end);
    const len = hi - lo + 1;
    if (len < 2) continue;
    const step = Math.floor(tick / Math.max(1, c.framesPerStep)) % len;
    const shift = c.reverse ? len - step : step;
    const base = c.paletteId * 16 + lo;
    for (let i = 0; i < len; i++) out[base + ((i + shift) % len)] = cgram[base + i];
  }
  return out;
}
