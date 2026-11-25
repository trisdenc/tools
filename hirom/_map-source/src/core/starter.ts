import { fromRgb8 } from '@pixel/core/color';
import { createImage, type IndexedImage } from '@pixel/core/image';
import type { Project as PixelProject, SpriteAsset, Tileset } from '@pixel/core/project';
import { SHEET_COLS, createDefaultProject, makeCell } from '@pixel/core/project';
import { imageToTiles, sheetFromTiles } from '@pixel/core/tiles';
import { BLOB47, N } from './autotile';
import type { Level, Metatile, MetatileSet, Terrain, Workspace } from './level';
import {
  SHAPE,
  STARTER_PIXEL_ID,
  createLevel,
  createWorkspace,
  levelTiles,
  makeCollision,
  pixelRef,
  soundRef,
  LIVE_SOUND_ID,
  uid,
} from './level';

/**
 * The built-in starter kit: a small, procedurally drawn 16-bit platformer set (as a HiROM Pixel
 * project) and a demo level, so HiROM Map is usable before any art exists. Everything is
 * generated deterministically, so ids are stable and nothing needs to be stored.
 */

const hex = (h: string) => fromRgb8(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16));

function starterCgram(): Uint16Array {
  const c = new Uint16Array(256);
  const set = (base: number, colors: (string | null)[]) => colors.forEach((h, i) => h && (c[base + i] = hex(h)));
  // BG 0: ground. Slot 0 is the backdrop (sky).
  set(0, ['#6898f8', '#20183a', '#6b3a1e', '#9a5a2c', '#c8834a', '#1f7a3a', '#3fae4a', '#8ee05a', '#7a2e2e', '#b84a3a', '#e0c8a8', '#4a4a6a', '#7a7aa0', '#b8b8d8', '#7a4a1a', '#d8a050']);
  // BG 1: water, spikes, ice, gold. Entries 8–11 double as BG3 2bpp palette 6 (clouds).
  set(16, [null, '#182040', '#1e4ab0', '#3a7ae0', '#8ac0f8', '#f0f8ff', '#5a5a70', '#d8d8e8', '#000000', '#b8c8f0', '#e0e8ff', '#ffffff', '#6ab8e0', '#c8f0ff', '#f8c830', '#b07818']);
  // BG 2: hills.
  set(32, [null, '#16402a', '#9ad8b0', '#78c098', '#4aa860', '#2e8048', '#78d070', '#1e6030']);
  // OBJ 8: hero, 9: slime, 10: coin.
  set(128, [null, '#1a1020', '#d83838', '#902020', '#f8c8a0', '#3858d8', '#203890', '#ffffff', '#6a3a20', '#101010']);
  set(144, [null, '#0e3a1a', '#2a8a3a', '#4ac85a', '#a0f0a0', '#ffffff', '#101010']);
  set(160, [null, '#5a3a08', '#c08820', '#f8d040', '#fff8c0']);
  return c;
}

const hash = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 997;

type Painter = (x: number, y: number) => number;

/** One 16×16 block per entry, laid out 8 blocks per row in a 16-tile-wide sheet. */
function blockSheet(painters: Painter[], bpp: 4): IndexedImage {
  const blockRows = Math.ceil(painters.length / 8);
  const img = createImage(SHEET_COLS * 8, Math.max(8, blockRows * 2) * 8, bpp);
  painters.forEach((paint, b) => {
    const ox = (b % 8) * 16, oy = Math.floor(b / 8) * 16;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) img.pixels[(oy + y) * img.width + ox + x] = paint(x, y) & 15;
  });
  return img;
}

const dirt: Painter = (x, y) => {
  const h = hash(x, y) % 11;
  return h === 0 ? 4 : h === 5 ? 2 : 3;
};

const BLOCKS: { name: string; pal: number; shape: number; material?: number; paint: Painter }[] = [
  { name: 'Empty', pal: 0, shape: SHAPE.NONE, paint: () => 0 },
  {
    name: 'Grass top', pal: 0, shape: SHAPE.SOLID,
    paint: (x, y) => (y === 0 ? (x % 5 === 1 ? 7 : 6) : y < 3 ? (hash(x, y) % 4 ? 6 : 7) : y === 3 ? 5 : y === 4 ? (x % 3 ? 5 : dirt(x, y)) : dirt(x, y)),
  },
  { name: 'Dirt', pal: 0, shape: SHAPE.SOLID, paint: dirt },
  {
    name: 'Brick', pal: 0, shape: SHAPE.SOLID,
    paint: (x, y) => {
      const row = y >> 3, yy = y & 7;
      if (yy === 7 || x === (row & 1 ? 4 : 12)) return 10;
      return yy === 0 ? 10 - 1 : yy === 6 ? 8 : 9;
    },
  },
  { name: 'Stone', pal: 0, shape: SHAPE.SOLID, paint: (x, y) => (x === 0 || y === 0 ? 13 : x === 15 || y === 15 ? 11 : hash(x, y) % 17 === 0 ? 11 : 12) },
  {
    name: 'Plank (one-way)', pal: 0, shape: SHAPE.ONE_WAY,
    paint: (x, y) => (y === 0 ? 15 : y < 5 ? (x % 8 === 0 ? 14 : y === 2 && x % 8 === 3 ? 1 : 15) : y === 5 ? 14 : y < 9 && (x === 2 || x === 13) ? 14 : 0),
  },
  {
    name: 'Ladder', pal: 0, shape: SHAPE.LADDER,
    paint: (x, y) => (x === 2 || x === 12 ? 14 : x === 3 || x === 13 ? 15 : x > 3 && x < 12 ? (y % 4 === 1 ? 15 : y % 4 === 2 ? 14 : 0) : 0),
  },
  {
    name: 'Water surface', pal: 1, shape: SHAPE.WATER,
    paint: (x, y) => (y < 5 ? 0 : y === 5 ? ((x + 1) % 6 < 3 ? 5 : 0) : y === 6 ? ((x + 4) % 6 < 3 ? 5 : 4) : (x + y) % 7 === 0 ? 4 : 3),
  },
  { name: 'Water', pal: 1, shape: SHAPE.WATER, paint: (x, y) => ((x * 3 + y * 5) % 13 === 0 ? 4 : y % 8 < 4 ? 3 : 2) },
  {
    name: 'Spikes', pal: 1, shape: SHAPE.HAZARD,
    paint: (x, y) => {
      if (y >= 14) return 6;
      const cx = x < 8 ? 3.5 : 11.5;
      const half = Math.max(0, (y - 3) * 0.34);
      if (y < 3 || Math.abs(x - cx) > half) return 0;
      return x < cx ? 7 : 6;
    },
  },
  {
    name: 'Slope ◢', pal: 0, shape: SHAPE.SLOPE_UP,
    paint: (x, y) => {
      const s = 15 - x;
      return y < s - 1 ? 0 : y <= s + 1 ? (hash(x, y) % 3 ? 6 : 7) : y <= s + 3 ? 5 : dirt(x, y);
    },
  },
  {
    name: 'Slope ◣', pal: 0, shape: SHAPE.SLOPE_DOWN,
    paint: (x, y) => {
      const s = x;
      return y < s - 1 ? 0 : y <= s + 1 ? (hash(x, y) % 3 ? 6 : 7) : y <= s + 3 ? 5 : dirt(x, y);
    },
  },
  { name: 'Ice', pal: 1, shape: SHAPE.SOLID, material: 1, paint: (x, y) => (x === 0 || y === 0 || x === 15 || y === 15 ? 12 : (x - y + 16) % 7 === 0 ? 11 : 13) },
  {
    name: 'Gold block', pal: 1, shape: SHAPE.SOLID,
    paint: (x, y) => {
      if (x === 0 || y === 0 || x === 15 || y === 15) return 15;
      const q = (x >= 6 && x <= 9 && (y === 4 || y === 5)) || (x === 9 && y >= 5 && y <= 8) || (x >= 7 && x <= 8 && y === 8) || (x >= 7 && x <= 8 && y === 11);
      return q ? 11 : 14;
    },
  },
  {
    name: 'Bush', pal: 0, shape: SHAPE.NONE,
    paint: (x, y) => {
      const d = ((x - 7.5) / 7.5) ** 2 + ((y - 10) / 6) ** 2;
      if (d > 1) return 0;
      if (d > 0.82) return 1;
      return y < 8 && x < 9 ? 7 : y > 12 ? 5 : 6;
    },
  },
  {
    name: 'Flower', pal: 0, shape: SHAPE.NONE,
    paint: (x, y) => {
      if (y >= 8 && (x === 7 || x === 8)) return 5;
      if (y >= 12 && ((x === 5 && y === 12) || (x === 10 && y === 13))) return 6;
      const d = (x - 7.5) ** 2 + (y - 5) ** 2;
      return d < 2.5 ? 15 : d < 9 ? 10 : 0;
    },
  },
];

function hillsImage(): IndexedImage {
  const W = 512, H = 224;
  const img = createImage(W, H, 4);
  const T = (2 * Math.PI) / W;
  for (let x = 0; x < W; x++) {
    const far = 112 + 18 * Math.sin(x * T * 2) + 9 * Math.sin(x * T * 3 + 1);
    const near = 158 + 14 * Math.sin(x * T + 0.5) + 7 * Math.sin(x * T * 4);
    for (let y = 0; y < H; y++) {
      let v = 0;
      if (y >= near) v = y < near + 2 ? 6 : y > near + 34 && (x + y) % 2 ? 5 : 4;
      else if (y >= far) v = y < far + 2 ? 2 : y > far + 24 && (x + y) % 2 ? 3 : 2;
      img.pixels[y * W + x] = v;
    }
  }
  return img;
}

function cloudsImage(): IndexedImage {
  const W = 256, H = 224;
  const img = createImage(W, H, 2);
  const clouds = [
    [30, 34, 22, 9], [52, 30, 18, 12], [72, 36, 16, 8],
    [150, 62, 20, 8], [170, 56, 16, 11], [188, 62, 14, 7],
    [228, 24, 14, 7], [244, 22, 12, 9],
  ];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let inside = 0;
      for (const [cx, cy, rx, ry] of clouds) {
        for (const dx of [-W, 0, W]) {
          const d = ((x - cx - dx) / rx) ** 2 + ((y - cy) / ry) ** 2;
          if (d <= 1) inside = Math.max(inside, y > cy + ry * 0.35 ? 1 : d < 0.35 && y < cy ? 3 : 2);
        }
      }
      img.pixels[y * W + x] = inside;
    }
  }
  return img;
}

const art = (rows: string[], map: Record<string, number>, w: number, h: number): IndexedImage => {
  const img = createImage(w, h, 4);
  const top = h - rows.length;
  rows.forEach((row, y) => [...row.padEnd(w, '.').slice(0, w)].forEach((ch, x) => (img.pixels[(top + y) * w + x] = map[ch] ?? 0)));
  return img;
};

function sprite(id: string, name: string, w: number, h: number, pal: number, frames: string[][], map: Record<string, number>, duration: number): SpriteAsset {
  return {
    id,
    name,
    width: w,
    height: h,
    paletteId: pal,
    originX: Math.floor(w / 2),
    originY: h - 1,
    frames: frames.map((rows) => ({ image: art(rows, map, w, h), duration, hitboxes: [], hurtboxes: [] })),
  };
}

const HERO_MAP = { o: 1, r: 2, R: 3, s: 4, b: 5, B: 6, w: 7, n: 8, e: 9 };
const HERO_TOP = [
  '.....oooooo.....', '....orrrrrro....', '...orrrrrrrro...', '...oRRRRRRRRRo..', '....ossssso.....',
  '....osesseo.....', '....ossssso.....', '.....oosso......', '....obbbbbbo....', '...obbbwwbbbo...',
  '..osobbbbbbosoo.', '..osobbbbbbos...', '...oobbbbbboo...', '....oBBBBBBo....',
];
const HERO_A = [...HERO_TOP, '....oBBooBBo....', '....oBBooBBo....', '....oBBooBBo....', '....onnoonno....', '...onnnoonnno...', '...oooo..oooo...'];
const HERO_B = [...HERO_TOP, '...oBBo..oBBo...', '..oBBo....oBBo..', '..oBo......oBo..', '..onno....onno..', '.onnno....onnno.', '.oooo......oooo.'];
const SLIME_MAP = { o: 1, d: 2, g: 3, l: 4, w: 5, k: 6 };
const SLIME_A = [
  '......oooo......', '....oollggoo....', '...ollggggggo...', '..olgggggggggo..', '..oggwkgggwkgo..',
  '.oggggggggggggo.', '.odggggggggggdo.', '.oddddggggddddo.', '..oooooooooooo..',
];
const SLIME_B = [
  '.....oooooo.....', '...oollggggoo...', '..olgwkgggwkggo.', '.oggggggggggggo.', '.odggggggggggddo',
  'oddddddggdddddo.', '.ooooooooooooo..',
];
const COIN_MAP = { o: 1, Y: 2, y: 3, s: 4 };
const COIN = [
  ['..oooo..', '.oyyyYo.', 'oysyyyYo', 'oysyyyYo', 'oyyyyyYo', 'oyyyyyYo', '.oyyyYo.', '..oooo..'],
  ['...oo...', '..oyyo..', '..osyo..', '..osyo..', '..oyYo..', '..oyYo..', '..oyyo..', '...oo...'],
  ['...oo...', '...oo...', '...so...', '...yo...', '...yo...', '...Yo...', '...oo...', '...oo...'],
  ['...oo...', '..oyyo..', '..oyso..', '..oyso..', '..oYyo..', '..oYyo..', '..oyyo..', '...oo...'],
];

export const STARTER_IDS = {
  ground: 'ts_starter_ground',
  hills: 'ts_starter_hills',
  clouds: 'ts_starter_clouds',
  hero: 'spr_starter_hero',
  slime: 'spr_starter_slime',
  coin: 'spr_starter_coin',
} as const;

interface StarterAssets {
  project: PixelProject;
  hillsCells: { cells: Uint16Array; w: number; h: number };
  cloudsCells: { cells: Uint16Array; w: number; h: number };
}

let cached: StarterAssets | null = null;

export function starterAssets(): StarterAssets {
  if (cached) return cached;
  const p = createDefaultProject();
  p.title = 'HiROM Map starter kit';
  p.cgram = starterCgram();
  p.cycles = [{ id: 'cyc_water', paletteId: 1, start: 2, end: 4, framesPerStep: 10, reverse: false, enabled: true }];
  const ground: Tileset = { id: STARTER_IDS.ground, name: 'Starter ground', bpp: 4, sheet: blockSheet(BLOCKS.map((b) => b.paint), 4), paletteId: 0 };
  const hills = imageToTiles(hillsImage(), { flips: true, palette: 2 });
  const clouds = imageToTiles(cloudsImage(), { flips: true, palette: 6 });
  const hillsTs: Tileset = { id: STARTER_IDS.hills, name: 'Starter hills', bpp: 4, sheet: sheetFromTiles(hills.tiles, 4), paletteId: 2 };
  const cloudsTs: Tileset = { id: STARTER_IDS.clouds, name: 'Starter clouds', bpp: 2, sheet: sheetFromTiles(clouds.tiles, 2), paletteId: 6 };
  p.tilesets = [ground, hillsTs, cloudsTs];
  p.tilemaps = [];
  p.canvases = [];
  p.sprites = [
    sprite(STARTER_IDS.hero, 'Hero', 16, 24, 8, [HERO_A, HERO_B], HERO_MAP, 8),
    sprite(STARTER_IDS.slime, 'Slime', 16, 16, 9, [SLIME_A, SLIME_B], SLIME_MAP, 16),
    sprite(STARTER_IDS.coin, 'Coin', 8, 8, 10, COIN, COIN_MAP, 6),
  ];
  p.scene.layers.forEach((l) => (l.tilemapId = ''));
  cached = {
    project: p,
    hillsCells: { cells: hills.cells, w: hills.widthTiles, h: hills.heightTiles },
    cloudsCells: { cells: clouds.cells, w: clouds.widthTiles, h: clouds.heightTiles },
  };
  return cached;
}

/** Metatile set matching the ground blocks (block b uses tiles at its 2×2 spot in the sheet). */
export function starterMetatiles(): MetatileSet {
  const metatiles: Metatile[] = BLOCKS.map((b, id) => {
    const bx = id % 8, by = Math.floor(id / 8);
    const t0 = by * 2 * SHEET_COLS + bx * 2;
    const words = [t0, t0 + 1, t0 + SHEET_COLS, t0 + SHEET_COLS + 1].map((t) => (id === 0 ? 0 : makeCell(t, b.pal)));
    return { id, name: b.name, words, collision: makeCollision(b.shape, b.material ?? 0) };
  });
  return { id: 'mts_starter', name: 'Starter ground', tilesetRef: pixelRef(STARTER_IDS.ground), size: 16, metatiles };
}

export const STARTER_META = Object.fromEntries(BLOCKS.map((b, i) => [b.name, i])) as Record<string, number>;

export function starterTerrain(): Terrain {
  const slots: Record<number, number> = {};
  for (const m of BLOB47) slots[m] = m & N ? STARTER_META['Dirt'] : STARTER_META['Grass top'];
  return { id: 'ter_starter_grass', name: 'Grassy ground', setId: 'mts_starter', kind: 'blob47', slots };
}

/** Copy a (wrapping) source tilemap across a layer. */
function tileAcross(dst: Uint16Array, dw: number, dh: number, src: { cells: Uint16Array; w: number; h: number }): void {
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) dst[y * dw + x] = src.cells[(y % src.h) * src.w + (x % src.w)];
}

export function starterLevel(set: MetatileSet): Level {
  const { hillsCells, cloudsCells } = starterAssets();
  const level = createLevel({
    title: 'Starter Hills - Act 1',
    widthMetatiles: 112,
    heightMetatiles: 14,
    pixelSourceId: STARTER_PIXEL_ID,
    tilesets: { BG1: pixelRef(STARTER_IDS.ground), BG2: pixelRef(STARTER_IDS.hills), BG3: pixelRef(STARTER_IDS.clouds) },
  });
  level.meta.bgmTrackId = soundRef(LIVE_SOUND_ID);
  const { w: tw, h: th } = levelTiles(level);
  tileAcross(level.layers[1].cells, tw, th, hillsCells);
  tileAcross(level.layers[2].cells, tw, th, cloudsCells);
  level.layers[2].hdmaBands = [
    { startY: 0, endY: 47, scrollX: 0.1 },
    { startY: 48, endY: 223, scrollX: 0.25 },
  ];

  const W = level.meta.widthMetatiles, H = level.meta.heightMetatiles;
  const bg1 = level.layers[0];
  const byName = (n: string) => set.metatiles[STARTER_META[n]];
  const put = (mx: number, my: number, name: string, terrain = 0) => {
    if (mx < 0 || my < 0 || mx >= W || my >= H) return;
    const m = byName(name);
    m.words.forEach((w, i) => (bg1.cells[(my * 2 + (i >> 1)) * tw + mx * 2 + (i & 1)] = w));
    level.collision[my * W + mx] = m.collision;
    bg1.terrain[my * W + mx] = terrain;
  };

  // Ground height (top row) per column; Infinity = pit.
  const top: number[] = [];
  for (let x = 0; x < W; x++) {
    let t = 11;
    if (x >= 22 && x <= 29) t = 10;
    if (x >= 26 && x <= 28) t = 9;
    if ((x >= 16 && x <= 18) || (x >= 80 && x <= 82)) t = Infinity;
    top.push(t);
  }
  for (let x = 0; x < W; x++) {
    const t = top[x];
    if (!Number.isFinite(t)) continue;
    const ice = x >= 64 && x <= 75;
    const brick = x >= 96;
    for (let y = t; y < H; y++) {
      if (ice) put(x, y, y === t ? 'Ice' : 'Dirt');
      else if (brick) put(x, y, 'Brick');
      else put(x, y, y === t ? 'Grass top' : 'Dirt', 1);
    }
    // Slopes where the ground steps up or down by one
    if (x > 0 && Number.isFinite(top[x - 1]) && top[x - 1] === t + 1 && !ice && !brick) put(x, t, 'Slope ◢');
    if (x < W - 1 && Number.isFinite(top[x + 1]) && top[x + 1] === t + 1 && !ice && !brick) put(x, t, 'Slope ◣');
  }
  // Water in the first pit, a one-way bridge over the second
  for (let x = 16; x <= 18; x++) {
    put(x, 12, 'Water surface');
    put(x, 13, 'Water');
  }
  for (let x = 79; x <= 83; x++) put(x, 11, 'Plank (one-way)');
  // Structures
  for (let y = 9; y <= 10; y++) for (let x = 33; x <= 34; x++) put(x, y, 'Brick');
  for (let x = 36; x <= 40; x++) put(x, 7, 'Plank (one-way)');
  for (let y = 6; y <= 10; y++) {
    put(49, y, 'Ladder');
    for (let x = 50; x <= 52; x++) put(x, y, 'Stone');
  }
  for (let x = 58; x <= 60; x++) put(x, 10, 'Spikes');
  for (const x of [68, 69, 70]) put(x, 7, 'Gold block');
  for (let x = 88; x <= 91; x++) put(x, 8, 'Plank (one-way)');
  for (const [x, n] of [[6, 'Bush'], [12, 'Flower'], [31, 'Bush'], [44, 'Flower'], [54, 'Bush'], [86, 'Flower']] as [number, string][]) put(x, top[x] - 1, n);

  // Instances inherit their template's sprite (set in starterWorkspace).
  const ent = (templateId: string, x: number, y: number, properties = {}) =>
    level.entities.push({
      id: uid('ent'),
      templateId,
      type: null,
      spriteRef: null,
      x,
      y,
      hFlip: false,
      priority: 2,
      properties,
      path: [],
    });
  // Entity positions are anchors: bottom-centre, like a sprite's origin.
  ent('tpl_player', 40, 175);
  for (const x of [420, 960, 1240]) ent('tpl_enemy', x, 175);
  for (const x of [264, 280, 296]) ent('tpl_pickup', x, 140);
  for (const x of [584, 600, 616, 1424, 1440, 1456]) ent('tpl_pickup', x, x > 1400 ? 120 : 103);
  ent('tpl_door', 1744, 175, { targetMapId: '' });

  level.zones.push(
    { id: uid('zone'), name: 'Checkpoint', type: 'TRIGGER', x: 800, y: 0, width: 32, height: 224, onEnterBgm: null, event: 'checkpoint', properties: {} },
    { id: uid('zone'), name: 'Boss room', type: 'CAMERA_LOCK', x: 1536, y: 0, width: 256, height: 224, onEnterBgm: null, event: '', properties: {} },
  );
  return level;
}

export function starterWorkspace(): Workspace {
  const ws = createWorkspace();
  ws.title = 'Starter World';
  const set = starterMetatiles();
  ws.metatileSets = [set];
  ws.terrains = [starterTerrain()];
  ws.templates.find((t) => t.id === 'tpl_player')!.spriteRef = pixelRef(STARTER_IDS.hero);
  ws.templates.find((t) => t.id === 'tpl_enemy')!.spriteRef = pixelRef(STARTER_IDS.slime);
  ws.templates.find((t) => t.id === 'tpl_pickup')!.spriteRef = pixelRef(STARTER_IDS.coin);
  ws.levels = [starterLevel(set)];
  return ws;
}
