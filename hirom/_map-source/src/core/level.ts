import type { BgLayerId, ColorMathSettings } from '@pixel/core/project';

/**
 * HiROM Map data model. A workspace holds levels plus the shared building blocks they use
 * (metatile sets, terrains, stamps, entity templates) and links to asset sources in the suite:
 * HiROM Pixel projects (tiles, CGRAM, sprites) and HiROM Sound projects (music).
 *
 * Tilemap cells are real SNES words (vhopppcc cccccccc) at 8×8 resolution, so what you paint is
 * exactly what the hardware would display. Collision and terrain live on the metatile grid.
 */

export type HwSlot = BgLayerId;
export const HW_SLOTS: HwSlot[] = ['BG1', 'BG2', 'BG3'];

// ---- collision -----------------------------------------------------------------------------------

/** Collision byte: low nibble = shape, high nibble = material (0 = none, 1–15 = workspace material). */
export const SHAPE = {
  NONE: 0,
  SOLID: 1,
  ONE_WAY: 2,
  LADDER: 3,
  WATER: 4,
  HAZARD: 5,
  SLOPE_UP: 6, // floor rising to the right: ◢
  SLOPE_DOWN: 7, // floor falling to the right: ◣
} as const;
export type Shape = (typeof SHAPE)[keyof typeof SHAPE];
export const SHAPE_NAMES = ['NONE', 'SOLID', 'ONE_WAY', 'LADDER', 'WATER', 'HAZARD', 'SLOPE_45_UP', 'SLOPE_45_DOWN'] as const;
export const SHAPE_LABELS = ['None', 'Solid', 'One-way platform', 'Ladder', 'Water', 'Spike / hazard', 'Slope 45° ◢', 'Slope 45° ◣'];
export const SHAPE_COLORS = ['transparent', '#ff5d6c', '#ffb547', '#b3a9ef', '#4fc3ff', '#ff3dbb', '#7ee787', '#7ee787'];

export const shapeOf = (c: number): number => c & 15;
export const materialOf = (c: number): number => (c >> 4) & 15;
export const makeCollision = (shape: number, material = 0): number => (shape & 15) | ((material & 15) << 4);

export interface Material {
  /** 1–15, stored in the collision byte's high nibble. */
  id: number;
  name: string;
  color: string;
}

// ---- metatiles, terrains, stamps -------------------------------------------------------------------

export type MetatileSize = 16 | 32;

export interface Metatile {
  id: number;
  name: string;
  /** Tilemap words, row-major: 2×2 for 16×16, 4×4 for 32×32. */
  words: number[];
  /** Default collision byte written when this metatile is painted on the collision layer. */
  collision: number;
}

export interface MetatileSet {
  id: string;
  name: string;
  /** Pixel tileset this set's tile numbers refer to. */
  tilesetRef: string;
  size: MetatileSize;
  metatiles: Metatile[];
}

export type TerrainKind = 'blob47' | 'wang16';

export interface Terrain {
  id: string;
  name: string;
  setId: string;
  kind: TerrainKind;
  /** Reduced neighbour mask → metatile id. */
  slots: Record<number, number>;
}

export interface Stamp {
  id: string;
  name: string;
  tilesetRef: string;
  /** Size in tiles. */
  w: number;
  h: number;
  words: number[];
  /** Collision per metatile cell (w·8/size × h·8/size), or empty. */
  collision: number[];
}

// ---- entities & zones ------------------------------------------------------------------------------

export type PropValue = number | string | boolean;
export type Props = Record<string, PropValue>;

export interface EntityTemplate {
  id: string;
  name: string;
  type: string;
  spriteRef: string | null;
  /** Box drawn when there's no sprite. */
  width: number;
  height: number;
  color: string;
  properties: Props;
}

export interface Point {
  x: number;
  y: number;
}

export interface Entity {
  id: string;
  templateId: string | null;
  /** Overrides; null means "use the template's". */
  type: string | null;
  spriteRef: string | null;
  x: number;
  y: number;
  hFlip: boolean;
  priority: 0 | 1 | 2 | 3;
  /** Instance overrides merged over the template's properties. */
  properties: Props;
  path: Point[];
}

export type ZoneType = 'CAMERA_LOCK' | 'MUSIC' | 'TRIGGER' | 'HAZARD';
export const ZONE_TYPES: ZoneType[] = ['CAMERA_LOCK', 'MUSIC', 'TRIGGER', 'HAZARD'];
export const ZONE_COLORS: Record<ZoneType, string> = {
  CAMERA_LOCK: '#ffd23f',
  MUSIC: '#4fc3ff',
  TRIGGER: '#7ee787',
  HAZARD: '#ff5d6c',
};

export interface Zone {
  id: string;
  name: string;
  type: ZoneType;
  x: number;
  y: number;
  width: number;
  height: number;
  onEnterBgm: string | null;
  event: string;
  properties: Props;
}

// ---- layers & levels -------------------------------------------------------------------------------

export interface HdmaBand {
  startY: number;
  endY: number;
  scrollX: number;
}

export interface MapLayer {
  id: string;
  name: string;
  hwSlot: HwSlot;
  tilesetRef: string | null;
  parallax: { x: number; y: number };
  /** Per-scanline horizontal scroll bands (HDMA). Rows not covered use parallax.x. */
  hdmaBands: HdmaBand[];
  visible: boolean;
  main: boolean;
  sub: boolean;
  math: boolean;
  /** SNES tilemap words, (width·tilesPerMeta) × (height·tilesPerMeta). */
  cells: Uint16Array;
  /** Terrain index + 1 per metatile cell (0 = none), for the autotile brush. */
  terrain: Uint8Array;
}

export type PlaytestMode = 'platformer' | 'topdown' | 'camera';

export interface LevelMeta {
  id: string;
  title: string;
  bgMode: 1;
  tileSize: 8;
  metatileSize: MetatileSize;
  widthMetatiles: number;
  heightMetatiles: number;
  bgmTrackId: string | null;
  strictHardwareLimits: boolean;
}

export interface Level {
  meta: LevelMeta;
  pixelSourceId: string;
  layers: MapLayer[];
  /** Collision byte per metatile cell. */
  collision: Uint8Array;
  /** Layer whose metatiles write their default collision when painted. */
  collisionLayer: number;
  entities: Entity[];
  zones: Zone[];
  bg3Priority: boolean;
  obj: { main: boolean; sub: boolean };
  colorMath: ColorMathSettings;
  playtest: { mode: PlaytestMode };
}

// ---- sources & workspace ---------------------------------------------------------------------------

/** Where a level's tiles, CGRAM and sprites come from. */
export interface PixelSource {
  id: string;
  name: string;
  /** live = HiROM Pixel's current project; file = an imported .hirompixel; builtin = starter kit. */
  kind: 'live' | 'file' | 'builtin';
  /** Serialized HiROM Pixel project, for file sources. */
  json?: unknown;
}

export interface SoundSource {
  id: string;
  name: string;
  /** live = HiROM Sound's current project; file = an imported .hiromsound (bytes kept in storage). */
  kind: 'live' | 'file';
}

export interface Workspace {
  schemaVersion: string;
  title: string;
  levels: Level[];
  activeLevel: number;
  metatileSets: MetatileSet[];
  terrains: Terrain[];
  stamps: Stamp[];
  templates: EntityTemplate[];
  materials: Material[];
  pixelSources: PixelSource[];
  soundSources: SoundSource[];
}

export const SCHEMA_VERSION = '1.0.0';
export const MAX_METATILES_PER_SIDE = 512;
export const SCREEN_W = 256;
export const SCREEN_H = 224;

export const uid = (prefix: string): string => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

export const LIVE_PIXEL_ID = 'pixel_live';
export const LIVE_SOUND_ID = 'sound_live';
export const STARTER_PIXEL_ID = 'pixel_starter';

/** Suite asset references. */
export const pixelRef = (id: string): string => `hirom_pixel:${id}`;
export const soundRef = (sourceId: string): string => `hirom_sound:${sourceId}`;
export const refId = (ref: string | null | undefined): string | null => (ref ? ref.slice(ref.indexOf(':') + 1) : null);

export const tilesPerMeta = (size: MetatileSize): number => size / 8;

export function levelTiles(l: Level): { w: number; h: number } {
  const k = tilesPerMeta(l.meta.metatileSize);
  return { w: l.meta.widthMetatiles * k, h: l.meta.heightMetatiles * k };
}

export function levelPixels(l: Level): { w: number; h: number } {
  return { w: l.meta.widthMetatiles * l.meta.metatileSize, h: l.meta.heightMetatiles * l.meta.metatileSize };
}

export function createLayer(slot: HwSlot, tilesW: number, tilesH: number, metaW: number, metaH: number, tilesetRef: string | null): MapLayer {
  const parallax = slot === 'BG1' ? 1 : slot === 'BG2' ? 0.5 : 0.25;
  return {
    id: uid('layer'),
    name: slot === 'BG1' ? 'Main' : slot === 'BG2' ? 'Background' : 'Far / HUD',
    hwSlot: slot,
    tilesetRef,
    parallax: { x: parallax, y: slot === 'BG1' ? 1 : parallax },
    hdmaBands: [],
    visible: true,
    main: true,
    sub: false,
    math: false,
    cells: new Uint16Array(tilesW * tilesH),
    terrain: new Uint8Array(metaW * metaH),
  };
}

export function createLevel(opts: {
  title: string;
  widthMetatiles: number;
  heightMetatiles: number;
  metatileSize?: MetatileSize;
  pixelSourceId: string;
  tilesets?: Partial<Record<HwSlot, string | null>>;
}): Level {
  const size = opts.metatileSize ?? 16;
  const w = Math.max(1, Math.min(MAX_METATILES_PER_SIDE, opts.widthMetatiles | 0));
  const h = Math.max(1, Math.min(MAX_METATILES_PER_SIDE, opts.heightMetatiles | 0));
  const k = tilesPerMeta(size);
  return {
    meta: {
      id: uid('lvl'),
      title: opts.title,
      bgMode: 1,
      tileSize: 8,
      metatileSize: size,
      widthMetatiles: w,
      heightMetatiles: h,
      bgmTrackId: null,
      strictHardwareLimits: true,
    },
    pixelSourceId: opts.pixelSourceId,
    layers: HW_SLOTS.map((s) => createLayer(s, w * k, h * k, w, h, opts.tilesets?.[s] ?? null)),
    collision: new Uint8Array(w * h),
    collisionLayer: 0,
    entities: [],
    zones: [],
    bg3Priority: false,
    obj: { main: true, sub: false },
    colorMath: { mode: 'add', half: true, source: 'subscreen', fixedColor: 0, backdropMath: false },
    playtest: { mode: 'platformer' },
  };
}

export const DEFAULT_MATERIALS: Material[] = [
  { id: 1, name: 'ice', color: '#a5f3fc' },
  { id: 2, name: 'mud', color: '#a16207' },
  { id: 3, name: 'conveyor_left', color: '#f59e0b' },
  { id: 4, name: 'conveyor_right', color: '#f97316' },
];

export function defaultTemplates(): EntityTemplate[] {
  return [
    { id: 'tpl_player', name: 'Player spawn', type: 'player_spawn', spriteRef: null, width: 16, height: 24, color: '#7ee787', properties: {} },
    { id: 'tpl_enemy', name: 'Enemy', type: 'enemy', spriteRef: null, width: 16, height: 16, color: '#ff5d6c', properties: { hp: 3, patrolWidth: 64 } },
    { id: 'tpl_pickup', name: 'Pickup', type: 'pickup', spriteRef: null, width: 8, height: 8, color: '#ffd23f', properties: { item: 'coin', value: 1 } },
    { id: 'tpl_door', name: 'Door / warp', type: 'door', spriteRef: null, width: 16, height: 32, color: '#b3a9ef', properties: { targetMapId: '', targetX: 0, targetY: 0 } },
    { id: 'tpl_npc', name: 'NPC', type: 'npc', spriteRef: null, width: 16, height: 24, color: '#4fc3ff', properties: { dialog: '' } },
  ];
}

export function createWorkspace(): Workspace {
  return {
    schemaVersion: SCHEMA_VERSION,
    title: 'Untitled World',
    levels: [],
    activeLevel: 0,
    metatileSets: [],
    terrains: [],
    stamps: [],
    templates: defaultTemplates(),
    materials: DEFAULT_MATERIALS.map((m) => ({ ...m })),
    pixelSources: [
      { id: LIVE_PIXEL_ID, name: 'HiROM Pixel (current project)', kind: 'live' },
      { id: STARTER_PIXEL_ID, name: 'HiROM Map starter kit', kind: 'builtin' },
    ],
    soundSources: [{ id: LIVE_SOUND_ID, name: 'HiROM Sound (current project)', kind: 'live' }],
  };
}

/** Effective values of an entity, after applying its template. */
export function resolveEntity(e: Entity, templates: EntityTemplate[]): {
  type: string;
  spriteRef: string | null;
  width: number;
  height: number;
  color: string;
  name: string;
  properties: Props;
} {
  const t = e.templateId ? templates.find((x) => x.id === e.templateId) : undefined;
  return {
    type: e.type ?? t?.type ?? 'entity',
    spriteRef: e.spriteRef ?? t?.spriteRef ?? null,
    width: t?.width ?? 16,
    height: t?.height ?? 16,
    color: t?.color ?? '#ffffff',
    name: t?.name ?? e.type ?? 'Entity',
    properties: { ...(t?.properties ?? {}), ...e.properties },
  };
}

/** Resize a level, keeping content anchored at the top-left. */
export function resizeLevel(l: Level, widthMetatiles: number, heightMetatiles: number): void {
  const k = tilesPerMeta(l.meta.metatileSize);
  const ow = l.meta.widthMetatiles, oh = l.meta.heightMetatiles;
  const nw = Math.max(1, Math.min(MAX_METATILES_PER_SIDE, widthMetatiles | 0));
  const nh = Math.max(1, Math.min(MAX_METATILES_PER_SIDE, heightMetatiles | 0));
  const copy2d = <A extends Uint8Array | Uint16Array>(src: A, sw: number, sh: number, dw: number, dh: number, make: (n: number) => A): A => {
    const out = make(dw * dh);
    for (let y = 0; y < Math.min(sh, dh); y++) out.set(src.subarray(y * sw, y * sw + Math.min(sw, dw)), y * dw);
    return out;
  };
  for (const layer of l.layers) {
    layer.cells = copy2d(layer.cells, ow * k, oh * k, nw * k, nh * k, (n) => new Uint16Array(n));
    layer.terrain = copy2d(layer.terrain, ow, oh, nw, nh, (n) => new Uint8Array(n));
  }
  l.collision = copy2d(l.collision, ow, oh, nw, nh, (n) => new Uint8Array(n));
  l.meta.widthMetatiles = nw;
  l.meta.heightMetatiles = nh;
}
