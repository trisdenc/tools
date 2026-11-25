import { History, type HistoryEntry } from '@pixel/core/history';
import type { Project as PixelProject, SpriteAsset, Tileset } from '@pixel/core/project';
import { tileCount } from '@pixel/core/tiles';
import { pickMetatile, rawMask } from './autotile';
import type {
  Entity,
  EntityTemplate,
  HdmaBand,
  Level,
  MapLayer,
  Metatile,
  MetatileSet,
  MetatileSize,
  PixelSource,
  Stamp,
  Terrain,
  Workspace,
  Zone,
} from './level';
import {
  LIVE_PIXEL_ID,
  LIVE_SOUND_ID,
  SHAPE,
  STARTER_PIXEL_ID,
  createLevel,
  levelPixels,
  levelTiles,
  makeCollision,
  materialOf,
  pixelRef,
  refId,
  resizeLevel,
  resolveEntity,
  shapeOf,
  tilesPerMeta,
  uid,
} from './level';
import {
  createMetatileSet,
  emptyMetatile,
  findMetatile,
  flipMetaWords,
  floodMeta,
  metatilesFromCells,
  metatilesFromSheet,
  nextMetatileId,
  readMeta,
} from './metatiles';
import { starterWorkspace } from './starter';
import { validateLevel, type ValidationReport } from './validator';
import { loadPixelSource } from '../io/sources';
import { MAP_DB, kvGet, kvKeys, kvSet, onSuiteSaved } from '../io/storage';
import { parseWorkspace, serializeWorkspace } from '../io/workspace';

export type ToolId = 'brush' | 'autotile' | 'fill' | 'rect' | 'select' | 'picker' | 'eraser' | 'collision' | 'entity' | 'zone' | 'path';
export type BrushSource = 'metatile' | 'tile' | 'stamp';
export type DockTab = 'metatiles' | 'tiles' | 'terrain' | 'stamps' | 'entities' | 'zones' | 'assets' | 'validate';

export const TOOLS: { id: ToolId; name: string; key: string }[] = [
  { id: 'brush', name: 'Brush', key: 'B' },
  { id: 'autotile', name: 'Terrain brush (autotile)', key: 'A' },
  { id: 'fill', name: 'Fill', key: 'G' },
  { id: 'rect', name: 'Rectangle', key: 'U' },
  { id: 'select', name: 'Select / copy as stamp', key: 'S' },
  { id: 'picker', name: 'Eyedropper (or Alt-click)', key: 'I' },
  { id: 'eraser', name: 'Eraser', key: 'E' },
  { id: 'collision', name: 'Collision brush', key: 'C' },
  { id: 'entity', name: 'Entities', key: 'O' },
  { id: 'zone', name: 'Zones', key: 'Z' },
  { id: 'path', name: 'Patrol path (selected entity)', key: 'W' },
];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PixelCacheEntry {
  project: PixelProject | null;
  status: 'loading' | 'ok' | 'missing' | 'error';
  error?: string;
}

/** Records the first value of every element a gesture touches; becomes one undo step. */
class Stroke {
  private touched = new Map<Uint8Array | Uint16Array, Map<number, number>>();

  set(a: Uint8Array | Uint16Array, i: number, v: number): void {
    if (a[i] === v) return;
    let m = this.touched.get(a);
    if (!m) this.touched.set(a, (m = new Map()));
    if (!m.has(i)) m.set(i, a[i]);
    a[i] = v;
  }

  revert(): void {
    this.touched.forEach((m, a) => m.forEach((b, i) => (a[i] = b)));
    this.touched.clear();
  }

  entry(label: string, changed: () => void): HistoryEntry | null {
    const items: { a: Uint8Array | Uint16Array; idx: Uint32Array; before: number[]; after: number[] }[] = [];
    let bytes = 0;
    this.touched.forEach((m, a) => {
      const idx: number[] = [], before: number[] = [], after: number[] = [];
      m.forEach((b, i) => {
        if (a[i] !== b) {
          idx.push(i);
          before.push(b);
          after.push(a[i]);
        }
      });
      if (idx.length) {
        items.push({ a, idx: Uint32Array.from(idx), before, after });
        bytes += idx.length * 12;
      }
    });
    if (!items.length) return null;
    const apply = (useBefore: boolean) => {
      for (const it of items) for (let k = 0; k < it.idx.length; k++) it.a[it.idx[k]] = useBefore ? it.before[k] : it.after[k];
      changed();
    };
    return { kind: 'custom', label, undo: () => apply(true), redo: () => apply(false), bytes };
  }
}

interface Drag {
  tool: ToolId;
  erase: boolean;
  stroke: Stroke;
  startX: number;
  startY: number;
  lastCell: [number, number] | null;
  /** entity / zone / path dragging */
  target?: { kind: 'entity' | 'zone' | 'waypoint' | 'resize'; id: string; index?: number; corner?: number; ox: number; oy: number; ow?: number; oh?: number };
  snapshot?: string;
}

export class MapEditor {
  ws: Workspace;
  soundFiles = new Map<string, Uint8Array>();
  history = new History(500);

  // versions for React / the renderer
  version = 0;
  fastVersion = 0;
  cellsVersion = 0;
  pixelVersion = 0;
  private listeners = new Set<() => void>();
  private fastListeners = new Set<() => void>();

  // sources
  private pixelCache = new Map<string, PixelCacheEntry>();

  // view
  view = { zoom: 2, panX: 0, panY: 0, width: 800, height: 600 };
  overlays = { grid: true, screens: true, priority: false, collision: false, entities: true, zones: true, validator: true, metaGrid: false, animate: true };
  par = false;
  tick = 0;
  hover: { x: number; y: number } | null = null;

  // tools
  tool: ToolId = 'brush';
  brushSource: BrushSource = 'metatile';
  activeLayer = 0;
  dock: DockTab = 'metatiles';
  selectedMeta = new Map<string, number>();
  tileWord = 1;
  tilePalette = 0;
  flipH = false;
  flipV = false;
  forcePrio = false;
  autoCollision = true;
  collisionBrush = makeCollision(SHAPE.SOLID);
  terrainIndex = 0;
  stampId: string | null = null;
  clipboard: Stamp | null = null;
  templateId = 'tpl_enemy';
  selection: { kind: 'entity' | 'zone'; id: string } | null = null;
  selRect: Rect | null = null; // metatile units
  dragRect: Rect | null = null; // world px, while dragging rect/select/zone
  validation: ValidationReport | null = null;
  playing = false;
  message: { text: string; error: boolean } | null = null;
  ready = false;

  private drag: Drag | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSaved = '';

  constructor(ws?: Workspace) {
    this.ws = ws ?? starterWorkspace();
  }

  // ---- subscriptions ----------------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  subscribeFast = (fn: () => void): (() => void) => {
    this.fastListeners.add(fn);
    return () => this.fastListeners.delete(fn);
  };
  getVersion = (): number => this.version;
  getFastVersion = (): number => this.fastVersion;

  /** Structural / UI change. */
  bump(save = true): void {
    this.version++;
    this.fastVersion++;
    this.listeners.forEach((f) => f());
    this.fastListeners.forEach((f) => f());
    if (save) this.scheduleSave();
  }
  /** Hover, pan, animation tick. */
  bumpFast(): void {
    this.fastVersion++;
    this.fastListeners.forEach((f) => f());
  }
  private cellsChanged = (): void => {
    this.cellsVersion++;
    this.validation = null;
    this.bump();
  };

  toast(text: string, error = false): void {
    this.message = { text, error };
    this.bump(false);
  }

  // ---- lookups ----------------------------------------------------------------------------------

  get level(): Level {
    return this.ws.levels[this.ws.activeLevel] ?? this.ws.levels[0];
  }
  get layer(): MapLayer {
    return this.level.layers[this.activeLayer];
  }
  get k(): number {
    return tilesPerMeta(this.level.meta.metatileSize);
  }

  pixelSourceInfo(id = this.level?.pixelSourceId): PixelCacheEntry {
    return this.pixelCache.get(id) ?? { project: null, status: 'loading' };
  }
  get source(): PixelProject | null {
    return this.pixelSourceInfo().project;
  }
  pixelSource(id: string): PixelSource | undefined {
    return this.ws.pixelSources.find((s) => s.id === id);
  }

  tilesetFor(layer: MapLayer | undefined = this.layer): Tileset | undefined {
    const id = refId(layer?.tilesetRef);
    return id ? this.source?.tilesets.find((t) => t.id === id) : undefined;
  }
  sprite(ref: string | null): SpriteAsset | undefined {
    const id = refId(ref);
    return id ? this.source?.sprites.find((s) => s.id === id) : undefined;
  }

  /** Metatile set for a layer's tileset at the level's metatile size. */
  setFor(layer: MapLayer = this.layer): MetatileSet | undefined {
    return this.ws.metatileSets.find((s) => s.tilesetRef === layer.tilesetRef && s.size === this.level.meta.metatileSize);
  }
  selectedMetatile(set = this.setFor()): Metatile | undefined {
    if (!set) return undefined;
    const id = this.selectedMeta.get(set.id) ?? set.metatiles.find((m) => m.id !== 0)?.id ?? 0;
    return set.metatiles.find((m) => m.id === id);
  }
  get terrain(): Terrain | undefined {
    return this.ws.terrains[this.terrainIndex];
  }
  get stamp(): Stamp | null {
    if (this.stampId === '__clipboard') return this.clipboard;
    return this.ws.stamps.find((s) => s.id === this.stampId) ?? null;
  }
  get template(): EntityTemplate | undefined {
    return this.ws.templates.find((t) => t.id === this.templateId);
  }

  entityBox(e: Entity): Rect & { sprite?: SpriteAsset; color: string; name: string } {
    const r = resolveEntity(e, this.ws.templates);
    const spr = this.sprite(r.spriteRef);
    const w = spr?.width ?? r.width, h = spr?.height ?? r.height;
    const ox = spr ? spr.originX : Math.floor(w / 2), oy = spr ? spr.originY : h - 1;
    return { x: e.x - ox, y: e.y - oy, w, h, sprite: spr, color: r.color, name: r.name };
  }

  // ---- startup, sources, persistence ------------------------------------------------------------

  async init(): Promise<void> {
    try {
      const saved = await kvGet<unknown>(MAP_DB, 'workspace');
      if (saved) {
        const keys = await kvKeys(MAP_DB);
        const files = new Map<string, Uint8Array>();
        for (const k of keys ?? []) {
          if (typeof k === 'string' && k.startsWith('snd:')) {
            const b = await kvGet<Uint8Array>(MAP_DB, k);
            if (b) files.set(k.slice(4), b);
          }
        }
        const { ws } = parseWorkspace(saved);
        if (ws.levels.length) {
          this.ws = ws;
          this.soundFiles = files;
        }
      }
    } catch (e) {
      console.warn('Could not restore the HiROM Map autosave', e);
    }
    this.lastSaved = JSON.stringify(serializeWorkspace(this.ws));
    this.ready = true;
    this.bump(false);
    await this.loadLevelSource();
    this.fitView();
    onSuiteSaved((app) => {
      if (app === 'pixel' || app === 'focus') {
        if (this.ws.levels.some((l) => l.pixelSourceId === LIVE_PIXEL_ID)) void this.refreshPixel(LIVE_PIXEL_ID, true);
      }
      if (app === 'sound' || app === 'focus') this.soundChanged?.();
    });
    window.addEventListener('pagehide', () => this.saveNow());
  }

  /** Set by the playtest to drop cached music when HiROM Sound saves. */
  soundChanged: (() => void) | null = null;

  async refreshPixel(id: string, quiet = false): Promise<void> {
    const src = this.pixelSource(id);
    if (!src) return;
    const prev = this.pixelCache.get(id);
    if (!prev) this.pixelCache.set(id, { project: null, status: 'loading' });
    try {
      const project = await loadPixelSource(src);
      this.pixelCache.set(id, { project, status: project ? 'ok' : 'missing' });
      if (project && !quiet) this.autoAssignTilesets();
    } catch (e) {
      this.pixelCache.set(id, { project: prev?.project ?? null, status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
    this.pixelVersion++;
    this.cellsVersion++;
    this.bump(false);
  }

  async loadLevelSource(): Promise<void> {
    await this.refreshPixel(this.level.pixelSourceId);
  }

  /** Give empty layer slots a sensible tileset: 4bpp for BG1/BG2, 2bpp for BG3. */
  autoAssignTilesets(): void {
    const src = this.source;
    if (!src) return;
    for (const l of this.level.layers) {
      if (l.tilesetRef && src.tilesets.some((t) => t.id === refId(l.tilesetRef))) continue;
      const want = l.hwSlot === 'BG3' ? 2 : 4;
      const ts = src.tilesets.find((t) => t.bpp === want);
      if (ts) l.tilesetRef = pixelRef(ts.id);
    }
  }

  scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 1200);
  }

  saveNow(): void {
    if (!this.ready) return;
    const json = serializeWorkspace(this.ws);
    const s = JSON.stringify(json);
    if (s === this.lastSaved) return;
    this.lastSaved = s;
    kvSet(MAP_DB, 'workspace', json).catch((e) => console.warn('Autosave failed', e));
  }

  loadWorkspace(ws: Workspace, soundFiles: Map<string, Uint8Array>): void {
    this.ws = ws;
    this.soundFiles = soundFiles;
    for (const [id, b] of soundFiles) void kvSet(MAP_DB, 'snd:' + id, b);
    this.history.clear();
    this.selection = null;
    this.selRect = null;
    this.validation = null;
    this.activeLayer = 0;
    this.pixelCache.clear();
    this.cellsVersion++;
    this.bump();
    void this.loadLevelSource().then(() => this.fitView());
  }

  // ---- view ---------------------------------------------------------------------------------------

  setViewport(w: number, h: number): void {
    if (w === this.view.width && h === this.view.height) return;
    const first = this.view.width === 800 && this.view.height === 600;
    this.view.width = w;
    this.view.height = h;
    if (first) this.fitView();
    this.bumpFast();
  }

  fitView(): void {
    const { w, h } = levelPixels(this.level);
    const z = Math.min(this.view.width / w, (this.view.height - 20) / h);
    const zooms = [0.125, 0.25, 0.5, 1, 2, 3, 4, 6, 8];
    let best = zooms[0];
    for (const c of zooms) if (c <= Math.max(z, 0.125)) best = c;
    this.view.zoom = best;
    this.view.panX = Math.round((this.view.width - w * best) / 2);
    this.view.panY = Math.round(Math.max(10, (this.view.height - h * best) / 2));
    this.bumpFast();
  }

  zoomAt(factor: number, sx: number, sy: number): void {
    const zooms = [0.125, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16];
    const cur = this.view.zoom;
    let i = zooms.findIndex((z) => z >= cur - 1e-6);
    if (i < 0) i = zooms.length - 1;
    const next = zooms[Math.max(0, Math.min(zooms.length - 1, i + (factor > 1 ? 1 : -1)))];
    const wx = (sx - this.view.panX) / cur, wy = (sy - this.view.panY) / cur;
    this.view.zoom = next;
    this.view.panX = Math.round(sx - wx * next);
    this.view.panY = Math.round(sy - wy * next);
    this.bumpFast();
  }

  panBy(dx: number, dy: number): void {
    this.view.panX += dx;
    this.view.panY += dy;
    this.bumpFast();
  }

  centerOn(x: number, y: number): void {
    this.view.panX = Math.round(this.view.width / 2 - x * this.view.zoom);
    this.view.panY = Math.round(this.view.height / 2 - y * this.view.zoom);
    this.bumpFast();
  }

  setHover(p: { x: number; y: number } | null): void {
    this.hover = p;
    this.bumpFast();
  }

  // ---- settings ---------------------------------------------------------------------------------

  setTool(t: ToolId): void {
    this.tool = t;
    if (t === 'autotile') this.dock = 'terrain';
    else if (t === 'entity' || t === 'path') this.dock = 'entities';
    else if (t === 'zone') this.dock = 'zones';
    if (t === 'collision') this.overlays.collision = true;
    this.bump(false);
  }
  setDock(d: DockTab): void {
    this.dock = d;
    if (d === 'tiles') this.brushSource = 'tile';
    if (d === 'metatiles') this.brushSource = 'metatile';
    this.bump(false);
  }
  setActiveLayer(i: number): void {
    this.activeLayer = Math.max(0, Math.min(2, i));
    this.bump(false);
  }
  selectMetatile(set: MetatileSet, id: number): void {
    this.selectedMeta.set(set.id, id);
    this.brushSource = 'metatile';
    if (!['brush', 'fill', 'rect'].includes(this.tool)) this.tool = 'brush';
    this.bump(false);
  }
  selectTile(tile: number, palette = this.tilePalette): void {
    this.tilePalette = palette & 7;
    this.tileWord = (tile & 0x3ff) | (this.tilePalette << 10);
    this.brushSource = 'tile';
    if (!['brush', 'fill', 'rect'].includes(this.tool)) this.tool = 'brush';
    this.bump(false);
  }
  selectStamp(id: string): void {
    this.stampId = id;
    this.brushSource = 'stamp';
    this.tool = 'brush';
    this.bump(false);
  }
  toggleOverlay(k: keyof MapEditor['overlays']): void {
    this.overlays[k] = !this.overlays[k];
    this.bump(false);
  }

  // ---- undo ---------------------------------------------------------------------------------------

  undo(): void {
    const e = this.history.undo();
    if (e?.kind === 'custom') e.undo();
    this.cellsChanged();
  }
  redo(): void {
    const e = this.history.redo();
    if (e?.kind === 'custom') e.redo();
    this.cellsChanged();
  }
  private push(e: HistoryEntry | null): void {
    if (e) this.history.push(e);
  }

  /** Snapshot-based undo for small structured data (entity lists, sets, templates…). */
  change<T>(label: string, get: () => T, set: (v: T) => void, mutate: () => void): void {
    const before = structuredClone(get());
    mutate();
    const after = structuredClone(get());
    if (JSON.stringify(before) === JSON.stringify(after)) {
      this.bump();
      return;
    }
    const apply = (v: T) => {
      set(structuredClone(v));
      this.cellsChanged();
    };
    this.history.push({ kind: 'custom', label, undo: () => apply(before), redo: () => apply(after), bytes: JSON.stringify(after).length * 2 });
    this.cellsChanged();
  }
  changeLevelList(label: string, key: 'entities' | 'zones', mutate: () => void): void {
    const level = this.level;
    this.change(label, () => level[key], (v) => ((level as unknown as Record<string, unknown>)[key] = v), mutate);
  }
  changeWs<K extends 'metatileSets' | 'terrains' | 'stamps' | 'templates' | 'materials'>(label: string, key: K, mutate: () => void): void {
    this.change(label, () => this.ws[key], (v) => (this.ws[key] = v), mutate);
  }
  /** Level settings (everything except the big arrays). */
  changeLevel(label: string, mutate: () => void): void {
    const level = this.level;
    const pick = () => ({
      meta: level.meta,
      pixelSourceId: level.pixelSourceId,
      collisionLayer: level.collisionLayer,
      bg3Priority: level.bg3Priority,
      obj: level.obj,
      colorMath: level.colorMath,
      playtest: level.playtest,
      layers: level.layers.map((l) => ({ id: l.id, name: l.name, tilesetRef: l.tilesetRef, parallax: l.parallax, hdmaBands: l.hdmaBands, visible: l.visible, main: l.main, sub: l.sub, math: l.math })),
    });
    const prevSource = level.pixelSourceId;
    this.change(
      label,
      pick,
      (v) => {
        Object.assign(level, { meta: v.meta, pixelSourceId: v.pixelSourceId, collisionLayer: v.collisionLayer, bg3Priority: v.bg3Priority, obj: v.obj, colorMath: v.colorMath, playtest: v.playtest });
        v.layers.forEach((s, i) => Object.assign(level.layers[i], s));
      },
      mutate,
    );
    if (level.pixelSourceId !== prevSource) void this.loadLevelSource();
  }

  // ---- painting helpers ------------------------------------------------------------------------

  /** Words of the brush metatile with flips / priority applied. */
  brushMetaWords(m: Metatile): number[] {
    let w = flipMetaWords(m.words, this.k, this.flipH, this.flipV);
    if (this.forcePrio) w = w.map((x) => x | 0x2000);
    return w;
  }
  brushCollision(m: Metatile): number {
    let shape = shapeOf(m.collision);
    if (this.flipH && (shape === SHAPE.SLOPE_UP || shape === SHAPE.SLOPE_DOWN)) shape = shape === SHAPE.SLOPE_UP ? SHAPE.SLOPE_DOWN : SHAPE.SLOPE_UP;
    return makeCollision(shape, materialOf(m.collision));
  }
  brushTileWord(): number {
    let w = this.tileWord;
    if (this.flipH) w ^= 0x4000;
    if (this.flipV) w ^= 0x8000;
    if (this.forcePrio) w |= 0x2000;
    return w;
  }

  private writeMeta(s: Stroke, mx: number, my: number, words: readonly number[], collision: number | null, terrain: number | null): void {
    const level = this.level;
    const W = level.meta.widthMetatiles, H = level.meta.heightMetatiles;
    if (mx < 0 || my < 0 || mx >= W || my >= H) return;
    const layer = this.layer;
    const k = this.k;
    const { w: tw } = levelTiles(level);
    for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) s.set(layer.cells, (my * k + y) * tw + mx * k + x, words[y * k + x] ?? 0);
    if (collision !== null && this.autoCollision && this.activeLayer === level.collisionLayer) s.set(level.collision, my * W + mx, collision);
    if (terrain !== null) s.set(layer.terrain, my * W + mx, terrain);
  }

  private writeTile(s: Stroke, tx: number, ty: number, word: number): void {
    const { w: tw, h: th } = levelTiles(this.level);
    if (tx < 0 || ty < 0 || tx >= tw || ty >= th) return;
    s.set(this.layer.cells, ty * tw + tx, word);
  }

  private writeStamp(s: Stroke, tx: number, ty: number, st: Stamp): void {
    for (let y = 0; y < st.h; y++) for (let x = 0; x < st.w; x++) this.writeTile(s, tx + x, ty + y, st.words[y * st.w + x]);
    const k = this.k;
    const mw = Math.floor(st.w / k), mh = Math.floor(st.h / k);
    if (st.collision.length === mw * mh && this.autoCollision && this.activeLayer === this.level.collisionLayer && tx % k === 0 && ty % k === 0) {
      const W = this.level.meta.widthMetatiles, H = this.level.meta.heightMetatiles;
      for (let y = 0; y < mh; y++)
        for (let x = 0; x < mw; x++) {
          const mx = tx / k + x, my = ty / k + y;
          if (mx < W && my < H) s.set(this.level.collision, my * W + mx, st.collision[y * mw + x]);
        }
    }
  }

  /** Place the current brush at world pixel (x, y). */
  private stampBrush(s: Stroke, x: number, y: number, erase: boolean): void {
    const ms = this.level.meta.metatileSize;
    const mx = Math.floor(x / ms), my = Math.floor(y / ms);
    if (this.brushSource === 'tile') {
      this.writeTile(s, Math.floor(x / 8), Math.floor(y / 8), erase ? 0 : this.brushTileWord());
      return;
    }
    if (this.brushSource === 'stamp' && !erase) {
      const st = this.stamp;
      if (st) this.writeStamp(s, mx * this.k, my * this.k, st);
      return;
    }
    if (erase) {
      this.writeMeta(s, mx, my, emptyMetatile(ms).words, 0, 0);
      return;
    }
    const m = this.selectedMetatile();
    if (!m) return;
    this.writeMeta(s, mx, my, this.brushMetaWords(m), this.brushCollision(m), 0);
  }

  private paintCollision(s: Stroke, x: number, y: number, erase: boolean): void {
    const ms = this.level.meta.metatileSize;
    const mx = Math.floor(x / ms), my = Math.floor(y / ms);
    const W = this.level.meta.widthMetatiles, H = this.level.meta.heightMetatiles;
    if (mx < 0 || my < 0 || mx >= W || my >= H) return;
    s.set(this.level.collision, my * W + mx, erase ? 0 : this.collisionBrush);
  }

  /** Terrain brush: mark cells, then re-resolve them and their neighbours. */
  private paintTerrain(s: Stroke, cells: [number, number][], erase: boolean): void {
    const level = this.level, layer = this.layer;
    const W = level.meta.widthMetatiles, H = level.meta.heightMetatiles;
    const t = this.terrain;
    if (!t && !erase) return;
    const value = erase ? 0 : this.terrainIndex + 1;
    for (const [mx, my] of cells) {
      if (mx < 0 || my < 0 || mx >= W || my >= H) continue;
      s.set(layer.terrain, my * W + mx, value);
      if (erase) this.writeMeta(s, mx, my, emptyMetatile(level.meta.metatileSize).words, 0, null);
    }
    const todo = new Set<number>();
    for (const [mx, my] of cells)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = mx + dx, y = my + dy;
          if (x >= 0 && y >= 0 && x < W && y < H) todo.add(y * W + x);
        }
    for (const i of todo) {
      const v = layer.terrain[i];
      if (!v) continue;
      const ter = this.ws.terrains[v - 1];
      const set = ter && this.ws.metatileSets.find((m) => m.id === ter.setId);
      if (!ter || !set) continue;
      const x = i % W, y = (i / W) | 0;
      const mask = rawMask((dx, dy) => {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) return true;
        return layer.terrain[ny * W + nx] === v;
      });
      const id = pickMetatile(ter, mask);
      const m = set.metatiles.find((q) => q.id === id);
      if (m) this.writeMeta(s, x, y, m.words, m.collision, null);
    }
  }

  private cellsBetween(a: [number, number] | null, b: [number, number]): [number, number][] {
    if (!a) return [b];
    const out: [number, number][] = [];
    let [x0, y0] = a;
    const [x1, y1] = b;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      out.push([x0, y0]);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
    return out;
  }

  private gridCell(x: number, y: number): [number, number] {
    const unit = this.brushSource === 'tile' && ['brush', 'eraser', 'fill', 'rect'].includes(this.tool) ? 8 : this.level.meta.metatileSize;
    return [Math.floor(x / unit), Math.floor(y / unit)];
  }

  // ---- hit testing ------------------------------------------------------------------------------

  hitEntity(x: number, y: number): Entity | null {
    const ents = this.level.entities;
    for (let i = ents.length - 1; i >= 0; i--) {
      const b = this.entityBox(ents[i]);
      if (x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h) return ents[i];
    }
    return null;
  }

  hitZone(x: number, y: number): Zone | null {
    const zs = this.level.zones;
    for (let i = zs.length - 1; i >= 0; i--) {
      const z = zs[i];
      if (x >= z.x && y >= z.y && x < z.x + z.width && y < z.y + z.height) return z;
    }
    return null;
  }

  /** Corner handle (0 TL, 1 TR, 2 BR, 3 BL) of the selected zone under the pointer. */
  hitZoneCorner(x: number, y: number): number {
    const z = this.selectedZone;
    if (!z) return -1;
    const tol = 6 / this.view.zoom;
    const pts = [[z.x, z.y], [z.x + z.width, z.y], [z.x + z.width, z.y + z.height], [z.x, z.y + z.height]];
    return pts.findIndex(([px, py]) => Math.abs(px - x) <= tol && Math.abs(py - y) <= tol);
  }

  get selectedEntity(): Entity | undefined {
    return this.selection?.kind === 'entity' ? this.level.entities.find((e) => e.id === this.selection!.id) : undefined;
  }
  get selectedZone(): Zone | undefined {
    return this.selection?.kind === 'zone' ? this.level.zones.find((z) => z.id === this.selection!.id) : undefined;
  }

  select(sel: MapEditor['selection']): void {
    this.selection = sel;
    if (sel?.kind === 'entity') this.dock = 'entities';
    if (sel?.kind === 'zone') this.dock = 'zones';
    this.bump(false);
  }

  // ---- pointer gestures ------------------------------------------------------------------------

  pointerDown(x: number, y: number, button: number, mods: { alt: boolean; shift: boolean }): void {
    const erase = button === 2;
    const tool = mods.alt && ['brush', 'rect', 'fill', 'eraser', 'collision', 'autotile'].includes(this.tool) ? 'picker' : this.tool;
    const d: Drag = { tool, erase, stroke: new Stroke(), startX: x, startY: y, lastCell: null };
    this.drag = d;
    const snap = (v: number) => (mods.shift ? Math.round(v) : Math.round(v / 8) * 8);

    switch (tool) {
      case 'picker':
        this.pick(x, y);
        this.drag = null;
        return;
      case 'brush':
      case 'eraser': {
        const cell = this.gridCell(x, y);
        this.stampBrush(d.stroke, x, y, erase || tool === 'eraser');
        d.lastCell = cell;
        this.cellsVersion++;
        break;
      }
      case 'collision':
        this.paintCollision(d.stroke, x, y, erase);
        d.lastCell = this.gridCell(x, y);
        break;
      case 'autotile': {
        const ms = this.level.meta.metatileSize;
        const c: [number, number] = [Math.floor(x / ms), Math.floor(y / ms)];
        this.paintTerrain(d.stroke, [c], erase);
        d.lastCell = c;
        this.cellsVersion++;
        break;
      }
      case 'fill':
        this.fill(d.stroke, x, y, erase);
        this.finishStroke('Fill');
        return;
      case 'rect':
      case 'select':
        this.dragRect = { x, y, w: 0, h: 0 };
        break;
      case 'entity': {
        const hit = this.hitEntity(x, y);
        if (hit) {
          this.selection = { kind: 'entity', id: hit.id };
          d.target = { kind: 'entity', id: hit.id, ox: hit.x, oy: hit.y };
          d.snapshot = JSON.stringify(this.level.entities);
        } else if (!erase && this.template) {
          const e: Entity = {
            id: uid('ent'), templateId: this.template.id, type: null, spriteRef: null,
            x: snap(x), y: mods.shift ? Math.round(y) : Math.floor(y / 8) * 8 + 7,
            hFlip: false, priority: 2, properties: {}, path: [],
          };
          this.changeLevelList('Add entity', 'entities', () => this.level.entities.push(e));
          this.selection = { kind: 'entity', id: e.id };
          this.drag = null;
        } else {
          this.selection = null;
          this.drag = null;
        }
        this.dock = 'entities';
        break;
      }
      case 'zone': {
        const corner = this.hitZoneCorner(x, y);
        const z = this.selectedZone;
        if (corner >= 0 && z) {
          d.target = { kind: 'resize', id: z.id, corner, ox: z.x, oy: z.y, ow: z.width, oh: z.height };
          d.snapshot = JSON.stringify(this.level.zones);
          break;
        }
        const hit = this.hitZone(x, y);
        if (hit) {
          this.selection = { kind: 'zone', id: hit.id };
          d.target = { kind: 'zone', id: hit.id, ox: hit.x, oy: hit.y };
          d.snapshot = JSON.stringify(this.level.zones);
        } else {
          this.selection = null;
          this.dragRect = { x: snap(x), y: snap(y), w: 0, h: 0 };
        }
        this.dock = 'zones';
        break;
      }
      case 'path': {
        const e = this.selectedEntity;
        if (!e) {
          this.toast('Select an entity first (Entities tool), then draw its patrol path.');
          this.drag = null;
          return;
        }
        const tol = 6 / this.view.zoom;
        const i = e.path.findIndex((p) => Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol);
        if (erase) {
          if (i >= 0) this.changeLevelList('Delete waypoint', 'entities', () => e.path.splice(i, 1));
          this.drag = null;
          return;
        }
        if (i >= 0) {
          d.target = { kind: 'waypoint', id: e.id, index: i, ox: e.path[i].x, oy: e.path[i].y };
          d.snapshot = JSON.stringify(this.level.entities);
        } else {
          this.changeLevelList('Add waypoint', 'entities', () => e.path.push({ x: snap(x), y: snap(y) }));
          this.drag = null;
        }
        break;
      }
    }
    this.bump(false);
  }

  pointerMove(x: number, y: number, mods: { shift: boolean }): void {
    this.hover = { x, y };
    const d = this.drag;
    if (!d) {
      this.bumpFast();
      return;
    }
    const snapD = (v: number) => (mods.shift ? Math.round(v) : Math.round(v / 8) * 8);
    switch (d.tool) {
      case 'brush':
      case 'eraser':
      case 'collision':
      case 'autotile': {
        const ms = this.level.meta.metatileSize;
        const cell: [number, number] = d.tool === 'brush' || d.tool === 'eraser' ? this.gridCell(x, y) : [Math.floor(x / ms), Math.floor(y / ms)];
        if (d.lastCell && cell[0] === d.lastCell[0] && cell[1] === d.lastCell[1]) break;
        const cells = this.cellsBetween(d.lastCell, cell);
        const unit = d.tool === 'brush' || d.tool === 'eraser' ? (this.brushSource === 'tile' ? 8 : ms) : ms;
        if (d.tool === 'autotile') this.paintTerrain(d.stroke, cells, d.erase);
        else
          for (const [cx, cy] of cells) {
            const px = cx * unit + unit / 2, py = cy * unit + unit / 2;
            if (d.tool === 'collision') this.paintCollision(d.stroke, px, py, d.erase);
            else this.stampBrush(d.stroke, px, py, d.erase || d.tool === 'eraser');
          }
        d.lastCell = cell;
        this.cellsVersion++;
        break;
      }
      case 'rect':
      case 'select': {
        this.dragRect = { x: d.startX, y: d.startY, w: x - d.startX, h: y - d.startY };
        if (d.tool === 'rect') {
          d.stroke.revert();
          this.fillRect(d.stroke, this.metaRect(this.dragRect), d.erase);
          this.cellsVersion++;
        }
        break;
      }
      case 'entity': {
        const e = d.target && this.level.entities.find((q) => q.id === d.target!.id);
        if (e && d.target) {
          e.x = d.target.ox + snapD(x - d.startX);
          e.y = d.target.oy + snapD(y - d.startY);
        }
        break;
      }
      case 'zone': {
        const t = d.target;
        const z = t && this.level.zones.find((q) => q.id === t.id);
        if (z && t?.kind === 'zone') {
          z.x = t.ox + snapD(x - d.startX);
          z.y = t.oy + snapD(y - d.startY);
        } else if (z && t?.kind === 'resize') {
          const dx = snapD(x - d.startX), dy = snapD(y - d.startY);
          let x0 = t.ox, y0 = t.oy, x1 = t.ox + t.ow!, y1 = t.oy + t.oh!;
          if (t.corner === 0 || t.corner === 3) x0 += dx;
          else x1 += dx;
          if (t.corner === 0 || t.corner === 1) y0 += dy;
          else y1 += dy;
          z.x = Math.min(x0, x1 - 8);
          z.y = Math.min(y0, y1 - 8);
          z.width = Math.max(8, x1 - z.x);
          z.height = Math.max(8, y1 - z.y);
        } else if (this.dragRect) {
          this.dragRect = { ...this.dragRect, w: snapD(x) - this.dragRect.x, h: snapD(y) - this.dragRect.y };
        }
        break;
      }
      case 'path': {
        const t = d.target;
        const e = t && this.level.entities.find((q) => q.id === t.id);
        if (e && t && t.index !== undefined) e.path[t.index] = { x: t.ox + snapD(x - d.startX), y: t.oy + snapD(y - d.startY) };
        break;
      }
    }
    this.bump(false);
  }

  pointerUp(): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    switch (d.tool) {
      case 'brush':
        this.finishStroke(d.erase ? 'Erase' : 'Paint', d.stroke);
        break;
      case 'eraser':
        this.finishStroke('Erase', d.stroke);
        break;
      case 'collision':
        this.finishStroke('Paint collision', d.stroke);
        break;
      case 'autotile':
        this.finishStroke(d.erase ? 'Erase terrain' : 'Paint terrain', d.stroke);
        break;
      case 'rect':
        this.dragRect = null;
        this.finishStroke('Rectangle', d.stroke);
        break;
      case 'select': {
        const r = this.dragRect && this.metaRect(this.dragRect);
        this.dragRect = null;
        this.selRect = r && r.w > 0 && r.h > 0 ? r : null;
        this.bump(false);
        break;
      }
      case 'entity':
      case 'path':
        this.commitSnapshot(d, 'entities', d.tool === 'path' ? 'Move waypoint' : 'Move entity');
        break;
      case 'zone': {
        if (d.target) {
          this.commitSnapshot(d, 'zones', d.target.kind === 'resize' ? 'Resize zone' : 'Move zone');
        } else if (this.dragRect) {
          const r = this.dragRect;
          this.dragRect = null;
          const x = Math.min(r.x, r.x + r.w), y = Math.min(r.y, r.y + r.h), w = Math.abs(r.w), h = Math.abs(r.h);
          if (w >= 8 && h >= 8) {
            const z: Zone = { id: uid('zone'), name: `Zone ${this.level.zones.length + 1}`, type: 'CAMERA_LOCK', x, y, width: w, height: h, onEnterBgm: null, event: '', properties: {} };
            this.changeLevelList('Add zone', 'zones', () => this.level.zones.push(z));
            this.selection = { kind: 'zone', id: z.id };
          }
          this.bump(false);
        }
        break;
      }
    }
  }

  private commitSnapshot(d: Drag, key: 'entities' | 'zones', label: string): void {
    if (!d.snapshot) return;
    const level = this.level;
    const before = JSON.parse(d.snapshot);
    const after = structuredClone(level[key]);
    if (JSON.stringify(after) === d.snapshot) return;
    const apply = (v: unknown) => {
      (level as unknown as Record<string, unknown>)[key] = structuredClone(v);
      this.cellsChanged();
    };
    this.history.push({ kind: 'custom', label, undo: () => apply(before), redo: () => apply(after), bytes: d.snapshot.length * 2 });
    this.cellsChanged();
  }

  cancelDrag(): void {
    if (this.drag) {
      this.drag.stroke.revert();
      this.drag = null;
      this.dragRect = null;
      this.cellsChanged();
    }
  }

  private finishStroke(label: string, s?: Stroke): void {
    const stroke = s ?? this.drag?.stroke;
    if (!stroke) return;
    this.push(stroke.entry(label, this.cellsChanged));
    this.cellsChanged();
  }

  /** World-pixel rect → metatile-cell rect (inclusive of both corners). */
  metaRect(r: Rect): Rect {
    const ms = this.level.meta.metatileSize;
    const x0 = Math.floor(Math.min(r.x, r.x + r.w) / ms), y0 = Math.floor(Math.min(r.y, r.y + r.h) / ms);
    const x1 = Math.floor(Math.max(r.x, r.x + r.w) / ms), y1 = Math.floor(Math.max(r.y, r.y + r.h) / ms);
    const W = this.level.meta.widthMetatiles, H = this.level.meta.heightMetatiles;
    const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0);
    return { x: cx0, y: cy0, w: Math.min(W - 1, x1) - cx0 + 1, h: Math.min(H - 1, y1) - cy0 + 1 };
  }

  private fillRect(s: Stroke, r: Rect, erase: boolean): void {
    const ms = this.level.meta.metatileSize;
    if (this.brushSource === 'tile') {
      const word = erase ? 0 : this.brushTileWord();
      const k = this.k;
      for (let ty = r.y * k; ty < (r.y + r.h) * k; ty++) for (let tx = r.x * k; tx < (r.x + r.w) * k; tx++) this.writeTile(s, tx, ty, word);
      return;
    }
    for (let my = r.y; my < r.y + r.h; my++) for (let mx = r.x; mx < r.x + r.w; mx++) this.stampBrush(s, mx * ms + 1, my * ms + 1, erase);
  }

  private fill(s: Stroke, x: number, y: number, erase: boolean): void {
    const ms = this.level.meta.metatileSize;
    if (this.brushSource === 'tile') {
      const { w: tw, h: th } = levelTiles(this.level);
      const tx0 = Math.floor(x / 8), ty0 = Math.floor(y / 8);
      if (tx0 < 0 || ty0 < 0 || tx0 >= tw || ty0 >= th) return;
      const cells = this.layer.cells, target = cells[ty0 * tw + tx0], word = erase ? 0 : this.brushTileWord();
      if (target === word) return;
      const stack = [ty0 * tw + tx0];
      const seen = new Uint8Array(tw * th);
      seen[stack[0]] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        s.set(cells, i, word);
        const tx = i % tw, ty = (i / tw) | 0;
        for (const [nx, ny] of [[tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]]) {
          if (nx < 0 || ny < 0 || nx >= tw || ny >= th) continue;
          const j = ny * tw + nx;
          if (!seen[j] && cells[j] === target) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      return;
    }
    const cells = floodMeta(this.level, this.activeLayer, Math.floor(x / ms), Math.floor(y / ms));
    for (const [mx, my] of cells) this.stampBrush(s, mx * ms + 1, my * ms + 1, erase);
  }

  pick(x: number, y: number): void {
    const level = this.level;
    const ms = level.meta.metatileSize;
    const mx = Math.floor(x / ms), my = Math.floor(y / ms);
    const W = level.meta.widthMetatiles, H = level.meta.heightMetatiles;
    if (mx < 0 || my < 0 || mx >= W || my >= H) return;
    if (this.tool === 'collision') {
      this.collisionBrush = level.collision[my * W + mx];
      this.bump(false);
      return;
    }
    const { w: tw } = levelTiles(level);
    const set = this.setFor();
    const m = findMetatile(set, readMeta(this.layer, tw, mx, my, this.k));
    if (m && set) {
      this.selectedMeta.set(set.id, m.id);
      this.brushSource = 'metatile';
      this.dock = 'metatiles';
      this.flipH = this.flipV = this.forcePrio = false;
    } else {
      const w = this.layer.cells[Math.floor(y / 8) * tw + Math.floor(x / 8)];
      this.tileWord = w & ~0xe000;
      this.tilePalette = (w >> 10) & 7;
      this.flipH = !!(w & 0x4000);
      this.flipV = !!(w & 0x8000);
      this.forcePrio = !!(w & 0x2000);
      this.tileWord = w & 0x1fff;
      this.brushSource = 'tile';
      this.dock = 'tiles';
    }
    if (this.tool === 'picker') this.tool = 'brush';
    this.bump(false);
  }

  // ---- selection region ------------------------------------------------------------------------

  /** Copy the selected region of the active layer into a stamp. */
  copySelection(): Stamp | null {
    const r = this.selRect;
    if (!r) return null;
    const level = this.level, k = this.k;
    const { w: tw } = levelTiles(level);
    const W = level.meta.widthMetatiles;
    const words: number[] = [];
    for (let ty = r.y * k; ty < (r.y + r.h) * k; ty++) for (let tx = r.x * k; tx < (r.x + r.w) * k; tx++) words.push(this.layer.cells[ty * tw + tx]);
    const collision: number[] = [];
    for (let my = r.y; my < r.y + r.h; my++) for (let mx = r.x; mx < r.x + r.w; mx++) collision.push(level.collision[my * W + mx]);
    const st: Stamp = { id: '__clipboard', name: 'Clipboard', tilesetRef: this.layer.tilesetRef ?? '', w: r.w * k, h: r.h * k, words, collision };
    this.clipboard = st;
    this.stampId = '__clipboard';
    this.brushSource = 'stamp';
    this.tool = 'brush';
    this.bump(false);
    return st;
  }

  clearSelection(): void {
    const r = this.selRect;
    if (!r) return;
    const s = new Stroke();
    const save = this.brushSource;
    this.brushSource = 'metatile';
    this.fillRect(s, r, true);
    this.brushSource = save;
    this.push(s.entry('Clear selection', this.cellsChanged));
    this.cellsChanged();
  }

  saveClipboardAsStamp(name: string): void {
    const c = this.clipboard;
    if (!c) return;
    const st: Stamp = { ...structuredClone(c), id: uid('stamp'), name };
    this.changeWs('Save stamp', 'stamps', () => this.ws.stamps.push(st));
    this.stampId = st.id;
  }

  deleteSelected(): void {
    const sel = this.selection;
    if (sel?.kind === 'entity') this.changeLevelList('Delete entity', 'entities', () => (this.level.entities = this.level.entities.filter((e) => e.id !== sel.id)));
    else if (sel?.kind === 'zone') this.changeLevelList('Delete zone', 'zones', () => (this.level.zones = this.level.zones.filter((z) => z.id !== sel.id)));
    else if (this.selRect) this.clearSelection();
    this.selection = null;
    this.bump();
  }

  // ---- levels ----------------------------------------------------------------------------------

  setActiveLevel(i: number): void {
    this.ws.activeLevel = Math.max(0, Math.min(this.ws.levels.length - 1, i));
    this.selection = null;
    this.selRect = null;
    this.validation = null;
    this.activeLayer = 0;
    this.cellsVersion++;
    this.bump();
    void this.loadLevelSource().then(() => this.fitView());
  }

  addLevel(opts: { title: string; widthMetatiles: number; heightMetatiles: number; metatileSize: MetatileSize; pixelSourceId: string }): void {
    const l = createLevel(opts);
    const snapshot = this.ws.levels.slice();
    this.ws.levels.push(l);
    const idx = this.ws.levels.length - 1;
    this.history.push({
      kind: 'custom',
      label: 'Add level',
      undo: () => {
        this.ws.levels = snapshot.slice();
        this.ws.activeLevel = Math.min(this.ws.activeLevel, this.ws.levels.length - 1);
        this.cellsChanged();
      },
      redo: () => {
        this.ws.levels.splice(idx, 0, l);
        this.cellsChanged();
      },
    });
    this.setActiveLevel(idx);
  }

  duplicateLevel(): void {
    const src = this.level;
    const copy = structuredClone(src);
    copy.meta.id = uid('lvl');
    copy.meta.title = src.meta.title + ' copy';
    this.ws.levels.splice(this.ws.activeLevel + 1, 0, copy);
    this.setActiveLevel(this.ws.activeLevel + 1);
  }

  deleteLevel(): void {
    if (this.ws.levels.length <= 1) {
      this.toast('A workspace needs at least one level.', true);
      return;
    }
    const removed = this.level, at = this.ws.activeLevel;
    this.ws.levels.splice(at, 1);
    this.history.push({
      kind: 'custom',
      label: 'Delete level',
      undo: () => {
        this.ws.levels.splice(at, 0, removed);
        this.ws.activeLevel = at;
        this.cellsChanged();
      },
      redo: () => {
        this.ws.levels.splice(at, 1);
        this.ws.activeLevel = Math.min(at, this.ws.levels.length - 1);
        this.cellsChanged();
      },
    });
    this.setActiveLevel(Math.min(at, this.ws.levels.length - 1));
  }

  resizeLevel(w: number, h: number): void {
    const level = this.level;
    const before = { w: level.meta.widthMetatiles, h: level.meta.heightMetatiles, cells: level.layers.map((l) => l.cells), terrain: level.layers.map((l) => l.terrain), collision: level.collision };
    resizeLevel(level, w, h);
    const after = { w: level.meta.widthMetatiles, h: level.meta.heightMetatiles, cells: level.layers.map((l) => l.cells), terrain: level.layers.map((l) => l.terrain), collision: level.collision };
    const apply = (v: typeof before) => {
      level.meta.widthMetatiles = v.w;
      level.meta.heightMetatiles = v.h;
      level.layers.forEach((l, i) => {
        l.cells = v.cells[i];
        l.terrain = v.terrain[i];
      });
      level.collision = v.collision;
      this.cellsChanged();
    };
    this.history.push({ kind: 'custom', label: 'Resize level', undo: () => apply(before), redo: () => apply(after) });
    this.cellsChanged();
  }

  // ---- layers ----------------------------------------------------------------------------------

  setLayerTileset(i: number, tilesetId: string): void {
    this.changeLevel('Change tileset', () => (this.level.layers[i].tilesetRef = tilesetId ? pixelRef(tilesetId) : null));
  }
  addBand(i: number): void {
    this.changeLevel('Add HDMA band', () => {
      const bands = this.level.layers[i].hdmaBands;
      const start = bands.length ? Math.min(223, bands[bands.length - 1].endY + 1) : 0;
      bands.push({ startY: start, endY: Math.min(223, start + 63), scrollX: this.level.layers[i].parallax.x });
    });
  }
  updateBand(i: number, b: number, patch: Partial<HdmaBand>): void {
    this.changeLevel('Edit HDMA band', () => Object.assign(this.level.layers[i].hdmaBands[b], patch));
  }
  removeBand(i: number, b: number): void {
    this.changeLevel('Remove HDMA band', () => this.level.layers[i].hdmaBands.splice(b, 1));
  }

  // ---- metatile sets ---------------------------------------------------------------------------

  createSetFromSheet(layer: MapLayer = this.layer, palette = 0): void {
    const ts = this.tilesetFor(layer);
    if (!ts || !layer.tilesetRef) return;
    const size = this.level.meta.metatileSize;
    const set = createMetatileSet(`${ts.name} ${size}×${size}`, layer.tilesetRef, size);
    set.metatiles.push(...metatilesFromSheet(ts, size, palette));
    this.changeWs('Create metatiles', 'metatileSets', () => this.ws.metatileSets.push(set));
    this.toast(`Made ${set.metatiles.length - 1} metatiles from the ${size}×${size} blocks of "${ts.name}".`);
  }

  createSetFromLevel(layer: MapLayer = this.layer): void {
    if (!layer.tilesetRef) return;
    const level = this.level;
    const size = level.meta.metatileSize;
    const { w, h } = levelTiles(level);
    const set = this.setFor(layer) ?? createMetatileSet(`${this.tilesetFor(layer)?.name ?? 'Tiles'} ${size}×${size}`, layer.tilesetRef, size);
    const existing = new Set(set.metatiles.map((m) => m.words.join(',')));
    const found = metatilesFromCells(layer.cells, w, h, size, nextMetatileId(set)).filter((m) => !existing.has(m.words.join(',')));
    found.forEach((m, i) => (m.id = nextMetatileId(set) + i));
    this.changeWs('Collect metatiles', 'metatileSets', () => {
      if (!this.ws.metatileSets.includes(set)) this.ws.metatileSets.push(set);
      set.metatiles.push(...found);
    });
    this.toast(found.length ? `Added ${found.length} metatiles found in this layer.` : 'Every block in this layer is already a metatile.');
  }

  /** Import the unique blocks of a HiROM Pixel tilemap (e.g. a scene layer) as metatiles. */
  createSetFromPixelMap(mapId: string): void {
    const src = this.source;
    const map = src?.tilemaps.find((m) => m.id === mapId);
    if (!map) return;
    const size = this.level.meta.metatileSize;
    const ref = pixelRef(map.tilesetId);
    let set = this.ws.metatileSets.find((s) => s.tilesetRef === ref && s.size === size);
    const isNew = !set;
    if (!set) set = createMetatileSet(`${map.name} ${size}×${size}`, ref, size);
    const target = set;
    const existing = new Set(target.metatiles.map((m) => m.words.join(',')));
    const found = metatilesFromCells(map.cells, map.width, map.height, size).filter((m) => !existing.has(m.words.join(',')));
    const first = nextMetatileId(target);
    found.forEach((m, i) => (m.id = first + i));
    this.changeWs('Import metatiles', 'metatileSets', () => {
      if (isNew) this.ws.metatileSets.push(target);
      target.metatiles.push(...found);
    });
    this.toast(`Imported ${found.length} metatiles from "${map.name}".`);
  }

  createEmptySet(layer: MapLayer = this.layer): void {
    if (!layer.tilesetRef) return;
    const size = this.level.meta.metatileSize;
    const set = createMetatileSet(`${this.tilesetFor(layer)?.name ?? 'Tiles'} ${size}×${size}`, layer.tilesetRef, size);
    this.changeWs('Create metatile set', 'metatileSets', () => this.ws.metatileSets.push(set));
  }

  addMetatile(set: MetatileSet): number {
    const id = nextMetatileId(set);
    this.changeWs('Add metatile', 'metatileSets', () => {
      const s = this.ws.metatileSets.find((x) => x.id === set.id)!;
      s.metatiles.push({ id, name: `Metatile ${id}`, words: new Array(this.k * this.k).fill(this.tileWord & 0x1fff), collision: 0 });
    });
    this.selectedMeta.set(set.id, id);
    return id;
  }

  updateMetatile(setId: string, id: number, patch: Partial<Metatile>): void {
    this.changeWs('Edit metatile', 'metatileSets', () => {
      const m = this.ws.metatileSets.find((s) => s.id === setId)?.metatiles.find((x) => x.id === id);
      if (m) Object.assign(m, patch);
    });
  }

  deleteMetatile(setId: string, id: number): void {
    if (id === 0) return;
    this.changeWs('Delete metatile', 'metatileSets', () => {
      const s = this.ws.metatileSets.find((x) => x.id === setId);
      if (s) s.metatiles = s.metatiles.filter((m) => m.id !== id);
    });
  }

  deleteSet(setId: string): void {
    this.changeWs('Delete metatile set', 'metatileSets', () => (this.ws.metatileSets = this.ws.metatileSets.filter((s) => s.id !== setId)));
  }

  // ---- terrains --------------------------------------------------------------------------------

  createTerrain(kind: Terrain['kind']): void {
    const set = this.setFor();
    if (!set) {
      this.toast('Make a metatile set for this layer first.', true);
      return;
    }
    const t: Terrain = { id: uid('ter'), name: `Terrain ${this.ws.terrains.length + 1}`, setId: set.id, kind, slots: {} };
    this.changeWs('Create terrain', 'terrains', () => this.ws.terrains.push(t));
    this.terrainIndex = this.ws.terrains.length - 1;
    this.bump(false);
  }

  updateTerrain(index: number, mutate: (t: Terrain) => void): void {
    this.changeWs('Edit terrain', 'terrains', () => mutate(this.ws.terrains[index]));
  }

  deleteTerrain(index: number): void {
    const v = index + 1;
    // Renumber terrain marks in every level (stored as index + 1).
    for (const l of this.ws.levels)
      for (const layer of l.layers)
        for (let i = 0; i < layer.terrain.length; i++) {
          if (layer.terrain[i] === v) layer.terrain[i] = 0;
          else if (layer.terrain[i] > v) layer.terrain[i]--;
        }
    this.ws.terrains.splice(index, 1);
    this.history.clear();
    this.terrainIndex = Math.max(0, Math.min(this.terrainIndex, this.ws.terrains.length - 1));
    this.toast('Terrain deleted. (Undo history was cleared, since terrain marks in every level were renumbered.)');
    this.cellsChanged();
  }

  // ---- entities, templates, zones ---------------------------------------------------------------

  updateEntity(id: string, mutate: (e: Entity) => void): void {
    this.changeLevelList('Edit entity', 'entities', () => {
      const e = this.level.entities.find((x) => x.id === id);
      if (e) mutate(e);
    });
  }

  updateZone(id: string, mutate: (z: Zone) => void): void {
    this.changeLevelList('Edit zone', 'zones', () => {
      const z = this.level.zones.find((x) => x.id === id);
      if (z) mutate(z);
    });
  }

  addTemplate(): void {
    const t: EntityTemplate = { id: uid('tpl'), name: 'New template', type: 'entity', spriteRef: null, width: 16, height: 16, color: '#b3a9ef', properties: {} };
    this.changeWs('Add template', 'templates', () => this.ws.templates.push(t));
    this.templateId = t.id;
    this.bump(false);
  }

  updateTemplate(id: string, mutate: (t: EntityTemplate) => void): void {
    this.changeWs('Edit template', 'templates', () => {
      const t = this.ws.templates.find((x) => x.id === id);
      if (t) mutate(t);
    });
  }

  deleteTemplate(id: string): void {
    const used = this.ws.levels.some((l) => l.entities.some((e) => e.templateId === id));
    if (used) {
      this.toast('That template is used by entities. Delete or change them first.', true);
      return;
    }
    this.changeWs('Delete template', 'templates', () => (this.ws.templates = this.ws.templates.filter((t) => t.id !== id)));
    this.templateId = this.ws.templates[0]?.id ?? '';
  }

  // ---- sources ---------------------------------------------------------------------------------

  addPixelFile(name: string, json: unknown): string {
    const id = uid('pxs');
    this.ws.pixelSources.push({ id, name, kind: 'file', json });
    this.bump();
    return id;
  }

  async addSoundFile(name: string, bytes: Uint8Array): Promise<string> {
    const id = uid('snd');
    this.soundFiles.set(id, bytes);
    await kvSet(MAP_DB, 'snd:' + id, bytes);
    this.ws.soundSources.push({ id, name, kind: 'file' });
    this.bump();
    return id;
  }

  removeSource(kind: 'pixel' | 'sound', id: string): void {
    if (id === LIVE_PIXEL_ID || id === STARTER_PIXEL_ID || id === LIVE_SOUND_ID) return;
    if (kind === 'pixel') {
      if (this.ws.levels.some((l) => l.pixelSourceId === id)) {
        this.toast('A level still uses that HiROM Pixel project.', true);
        return;
      }
      this.ws.pixelSources = this.ws.pixelSources.filter((s) => s.id !== id);
    } else {
      this.ws.soundSources = this.ws.soundSources.filter((s) => s.id !== id);
      this.soundFiles.delete(id);
    }
    this.bump();
  }

  setLevelSource(id: string): void {
    this.changeLevel('Change asset source', () => (this.level.pixelSourceId = id));
  }

  // ---- validation ------------------------------------------------------------------------------

  validate(): ValidationReport {
    this.validation = validateLevel(this.level, this.source, this.ws.templates);
    this.overlays.validator = true;
    this.bump(false);
    return this.validation;
  }

  /** Tile index range check for a layer (tiles past the end of the tileset show as blank). */
  missingTiles(layer: MapLayer): number {
    const ts = this.tilesetFor(layer);
    if (!ts) return 0;
    const n = tileCount(ts);
    let bad = 0;
    for (const w of layer.cells) if ((w & 0x3ff) >= n) bad++;
    return bad;
  }
}
