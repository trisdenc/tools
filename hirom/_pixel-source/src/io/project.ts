import { Bpp, CGRAM_SIZE, paletteType } from '../core/cgram';
import { IndexedImage, MAX_DIMENSION } from '../core/image';
import {
  BG_LAYERS,
  Box,
  MAX_TILES,
  Project,
  SHEET_COLS,
  SpriteAsset,
  Tilemap,
  Tileset,
  cellFlip,
  cellPal,
  cellPrio,
  cellTile,
  createDefaultProject,
  makeCell,
} from '../core/project';
import { getTile, sheetFromTiles, tileCount } from '../core/tiles';

/**
 * Project file following the spec's schema (§3). Extensions over the spec: `canvases` (free-form
 * art), `scene` (Mode 1 layer setup and placed sprite objects), per-frame pixel data and boxes on
 * sprites. Tileset pixels are tile-major: 64 index bytes per 8×8 tile.
 */
export const SCHEMA_VERSION = '1.1.0';
export const APP_NAME = 'HiROM Pixel';

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function serializeProject(p: Project) {
  const sc = p.scene;
  const layerNames = (pred: (l: (typeof sc.layers)[number]) => boolean) => sc.layers.filter(pred).map((l) => l.id as string);
  return {
    schemaVersion: SCHEMA_VERSION,
    app: APP_NAME,
    meta: {
      title: p.title,
      resolution: { ...sc.resolution },
      bgMode: 1,
      strictVramLimit: p.strict,
    },
    cgram: {
      palettes: Array.from({ length: 16 }, (_, id) => ({
        id,
        name: `${paletteType(id)}_${id}`,
        type: paletteType(id),
        colorsBgr555: Array.from(p.cgram.subarray(id * 16, id * 16 + 16)),
      })),
      cycles: p.cycles.map((c) => ({
        id: c.id,
        paletteId: c.paletteId,
        startIndex: c.start,
        endIndex: c.end,
        framesPerStep: c.framesPerStep,
        reverse: c.reverse,
        enabled: c.enabled,
      })),
    },
    canvases: p.canvases.map((c) => ({
      id: c.id,
      name: c.name,
      width: c.image.width,
      height: c.image.height,
      bpp: c.image.bpp,
      paletteId: c.paletteId,
      indexedPixelsBase64: bytesToBase64(c.image.pixels),
    })),
    tilesets: p.tilesets.map((t) => {
      const n = tileCount(t);
      const bytes = new Uint8Array(n * 64);
      for (let i = 0; i < n; i++) bytes.set(getTile(t.sheet, i), i * 64);
      return { id: t.id, name: t.name, bpp: t.bpp, tileCount: n, previewPaletteId: t.paletteId, indexedPixelsBase64: bytesToBase64(bytes) };
    }),
    tilemaps: p.tilemaps.map((m) => ({
      id: m.id,
      name: m.name,
      tilesetId: m.tilesetId,
      widthTiles: m.width,
      heightTiles: m.height,
      cells: Array.from(m.cells, (w) => ({
        tileId: cellTile(w),
        paletteId: cellPal(w),
        hFlip: (cellFlip(w) & 1) === 1,
        vFlip: (cellFlip(w) & 2) === 2,
        priority: cellPrio(w),
      })),
    })),
    sprites: p.sprites.map((s) => ({
      id: s.id,
      name: s.name,
      bpp: 4,
      width: s.width,
      height: s.height,
      defaultPaletteId: s.paletteId,
      origin: { x: s.originX, y: s.originY },
      frames: s.frames.map((f) => ({
        durationFrames: f.duration,
        indexedPixelsBase64: bytesToBase64(f.image.pixels),
        hitboxes: f.hitboxes,
        hurtboxes: f.hurtboxes,
      })),
    })),
    scene: {
      layers: sc.layers.map((l) => ({
        layer: l.id,
        tilemapId: l.tilemapId,
        visible: l.visible,
        mainScreen: l.main,
        subScreen: l.sub,
        colorMath: l.math,
        scrollFactor: l.scrollFactor,
      })),
      bg3Priority: sc.bg3Priority,
      obj: { visible: sc.obj.visible, mainScreen: sc.obj.main, subScreen: sc.obj.sub },
      objects: sc.objects.map((o) => ({ ...o })),
      scroll: { ...sc.scroll },
    },
    fx: {
      colorMath: {
        mode: sc.colorMath.mode === 'add' ? 'ADD' : 'SUB',
        half: sc.colorMath.half,
        source: sc.colorMath.source,
        fixedColorBgr555: sc.colorMath.fixedColor,
        backdrop: sc.colorMath.backdropMath,
        mainLayers: [...layerNames((l) => l.main), ...(sc.obj.main ? ['OBJ'] : [])],
        subLayers: [...layerNames((l) => l.sub), ...(sc.obj.sub ? ['OBJ'] : [])],
        mathLayers: layerNames((l) => l.math),
      },
      hdmaBackdrop: [],
    },
  };
}

export type ProjectJson = ReturnType<typeof serializeProject>;

function fail(msg: string): never {
  throw new Error(`Invalid project file: ${msg}`);
}

function readImage(b64: string, width: number, height: number, bpp: Bpp, what: string): IndexedImage {
  if (!(width >= 1 && height >= 1 && width <= MAX_DIMENSION && height <= MAX_DIMENSION)) fail(`${what}: bad size ${width}×${height}`);
  const pixels = base64ToBytes(b64);
  if (pixels.length !== width * height) fail(`${what}: pixel data does not match its size`);
  const max = 1 << bpp;
  for (let i = 0; i < pixels.length; i++) if (pixels[i] >= max) fail(`${what}: pixel index ${pixels[i]} exceeds ${bpp}bpp`);
  return { width, height, bpp, pixels };
}

const asBpp = (v: unknown, what: string): Bpp => {
  if (v !== 2 && v !== 4 && v !== 8) fail(`${what}: bad bpp ${String(v)}`);
  return v;
};
const boxes = (v: unknown): Box[] =>
  Array.isArray(v) ? v.filter((b) => b && [b.x, b.y, b.w, b.h].every(Number.isFinite)).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })) : [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export function parseProject(data: unknown): Project {
  const j = data as Json;
  if (!j || typeof j !== 'object') fail('not an object');
  if (typeof j.schemaVersion !== 'string' || !j.schemaVersion.startsWith('1.')) fail(`unsupported schemaVersion ${String(j.schemaVersion)}`);
  const p = createDefaultProject();
  p.title = j.meta?.title ?? 'Untitled Project';
  p.strict = j.meta?.strictVramLimit !== false;

  const cgram = new Uint16Array(CGRAM_SIZE);
  for (const pal of j.cgram?.palettes ?? []) {
    if (!Number.isInteger(pal.id) || pal.id < 0 || pal.id > 15) fail(`bad palette id ${pal.id}`);
    (pal.colorsBgr555 ?? []).slice(0, 16).forEach((c: number, i: number) => (cgram[pal.id * 16 + i] = c & 0x7fff));
  }
  p.cgram = cgram;
  p.cycles = (j.cgram?.cycles ?? []).map((c: Json) => ({
    id: String(c.id),
    paletteId: Math.max(0, Math.min(15, c.paletteId | 0)),
    start: Math.max(0, Math.min(15, c.startIndex | 0)),
    end: Math.max(0, Math.min(15, c.endIndex | 0)),
    framesPerStep: Math.max(1, c.framesPerStep | 0),
    reverse: !!c.reverse,
    enabled: c.enabled !== false,
  }));

  p.canvases = (j.canvases ?? []).map((c: Json, i: number) => {
    const bpp = asBpp(c.bpp, `canvas ${i}`);
    return {
      id: String(c.id ?? `cv_${i}`),
      name: String(c.name ?? 'Canvas'),
      image: readImage(c.indexedPixelsBase64, c.width, c.height, bpp, `canvas ${i}`),
      paletteId: c.paletteId | 0,
    };
  });

  const isPhase1 = !Array.isArray(j.tilesets) || (!j.tilesets.length && !j.scene);
  if (isPhase1) {
    // Phase 1 files only had a canvas: keep the default scene alongside it.
    if (!p.canvases.length) fail('no canvas');
    return p;
  }

  p.tilesets = j.tilesets.map((t: Json, i: number): Tileset => {
    const bpp = asBpp(t.bpp, `tileset ${i}`);
    const n = t.tileCount | 0;
    if (n < 1 || n > MAX_TILES) fail(`tileset ${i}: bad tileCount ${n}`);
    const bytes = base64ToBytes(t.indexedPixelsBase64 ?? '');
    if (bytes.length !== n * 64) fail(`tileset ${i}: pixel data does not match tileCount`);
    const max = 1 << bpp;
    const tiles: Uint8Array[] = [];
    for (let k = 0; k < n; k++) {
      const tile = bytes.subarray(k * 64, k * 64 + 64);
      if (tile.some((v) => v >= max)) fail(`tileset ${i}: index exceeds ${bpp}bpp`);
      tiles.push(tile);
    }
    return {
      id: String(t.id),
      name: String(t.name ?? 'Tileset'),
      bpp,
      sheet: sheetFromTiles(tiles, bpp, Math.ceil(n / SHEET_COLS) * SHEET_COLS),
      paletteId: Math.max(0, Math.min(7, t.previewPaletteId | 0)),
    };
  });

  p.tilemaps = (j.tilemaps ?? []).map((m: Json, i: number): Tilemap => {
    const w = m.widthTiles | 0, h = m.heightTiles | 0;
    if (w < 1 || h < 1 || w > 256 || h > 256) fail(`tilemap ${i}: bad size`);
    if (!p.tilesets.some((t) => t.id === m.tilesetId)) fail(`tilemap ${i}: unknown tileset ${m.tilesetId}`);
    const cells = new Uint16Array(w * h);
    (m.cells ?? []).slice(0, w * h).forEach((c: Json, k: number) => {
      cells[k] = makeCell(c.tileId | 0, c.paletteId | 0, c.priority ? 1 : 0, (c.hFlip ? 1 : 0) | (c.vFlip ? 2 : 0));
    });
    return { id: String(m.id), name: String(m.name ?? `Map ${i}`), tilesetId: m.tilesetId, width: w, height: h, cells };
  });

  p.sprites = (j.sprites ?? []).map((s: Json, i: number): SpriteAsset => {
    const w = s.width | 0, h = s.height | 0;
    const frames = (s.frames ?? []).map((f: Json, k: number) => ({
      image: readImage(f.indexedPixelsBase64, w, h, 4, `sprite ${i} frame ${k}`),
      duration: Math.max(1, f.durationFrames | 0),
      hitboxes: boxes(f.hitboxes),
      hurtboxes: boxes(f.hurtboxes),
    }));
    if (!frames.length) fail(`sprite ${i} has no frames`);
    return {
      id: String(s.id),
      name: String(s.name ?? 'Sprite'),
      width: w,
      height: h,
      paletteId: Math.max(8, Math.min(15, s.defaultPaletteId | 0)),
      originX: s.origin?.x ?? Math.floor(w / 2),
      originY: s.origin?.y ?? h - 1,
      frames,
    };
  });

  const sc = j.scene ?? {};
  const fx = j.fx?.colorMath ?? {};
  p.scene.layers = BG_LAYERS.map((id, i) => {
    const l = (sc.layers ?? []).find((x: Json) => x.layer === id) ?? {};
    const fallback = p.scene.layers[i];
    const mapId = p.tilemaps.some((m) => m.id === l.tilemapId) ? l.tilemapId : p.tilemaps[i]?.id ?? fallback.tilemapId;
    return {
      id,
      tilemapId: mapId,
      visible: l.visible !== false,
      main: l.mainScreen ?? (fx.mainLayers ? fx.mainLayers.includes(id) : true),
      sub: l.subScreen ?? (fx.subLayers ? fx.subLayers.includes(id) : false),
      math: l.colorMath ?? (fx.mathLayers ? fx.mathLayers.includes(id) : false),
      scrollFactor: Number.isFinite(l.scrollFactor) ? l.scrollFactor : fallback.scrollFactor,
    };
  });
  if (p.scene.layers.some((l) => !p.tilemaps.some((m) => m.id === l.tilemapId))) fail('scene layer without a tilemap');
  p.scene.bg3Priority = !!sc.bg3Priority;
  p.scene.obj = {
    visible: sc.obj?.visible !== false,
    main: sc.obj?.mainScreen !== false,
    sub: !!sc.obj?.subScreen,
  };
  p.scene.objects = (sc.objects ?? [])
    .filter((o: Json) => p.sprites.some((s) => s.id === o.spriteId))
    .map((o: Json) => ({
      id: String(o.id),
      spriteId: o.spriteId,
      x: o.x | 0,
      y: o.y | 0,
      priority: Math.max(0, Math.min(3, o.priority | 0)) as 0 | 1 | 2 | 3,
      hFlip: !!o.hFlip,
      colorMath: !!o.colorMath,
    }));
  if (sc.scroll) p.scene.scroll = { speedX: +sc.scroll.speedX || 0, speedY: +sc.scroll.speedY || 0 };
  if (j.meta?.resolution) p.scene.resolution = { width: j.meta.resolution.width | 0 || 256, height: j.meta.resolution.height | 0 || 224 };
  p.scene.colorMath = {
    mode: fx.mode === 'SUB' ? 'sub' : 'add',
    half: fx.half !== false,
    source: fx.source === 'fixed' ? 'fixed' : 'subscreen',
    fixedColor: (fx.fixedColorBgr555 | 0) & 0x7fff,
    backdropMath: !!fx.backdrop,
  };
  return p;
}
