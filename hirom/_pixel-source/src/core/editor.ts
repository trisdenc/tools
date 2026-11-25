import { Bgr555 } from './color';
import { Bpp, blockSize, paletteBase, paletteCount } from './cgram';
import { CellTransaction, History, HistoryEntry, PixelTransaction } from './history';
import { IndexedImage, createImage } from './image';
import {
  Box,
  CanvasAsset,
  MAX_TILES,
  PaletteCycle,
  Project,
  SHEET_COLS,
  SceneObject,
  SpriteAsset,
  SpriteFrame,
  Tilemap,
  Tileset,
  cellPal,
  cellPrio,
  createCanvas,
  createDefaultProject,
  createFrame,
  createSprite,
  createTilemap,
  createTileset,
  cycledCgram,
  uid,
} from './project';
import { DitherPattern, ditherOn, ellipse, floodRegion, line, rect } from './raster';
import { Region, hitObject, layerTilemap, layerTileset, sceneMapSize } from './scene';
import { imageToTiles, optimizeTileset, sheetFromTiles, tileCount } from './tiles';

export type PixelToolId = 'pencil' | 'eraser' | 'fill' | 'line' | 'rect' | 'ellipse' | 'dither' | 'replace' | 'picker' | 'box';
export type SceneToolId = 'stamp' | 'tileErase' | 'tileFill' | 'tileRect' | 'tilePick' | 'priority' | 'object';
export type ToolId = PixelToolId | SceneToolId;

export interface ToolDef<T extends ToolId = ToolId> {
  id: T;
  label: string;
  key: string;
}

export const PIXEL_TOOLS: ToolDef<PixelToolId>[] = [
  { id: 'pencil', label: 'Pencil', key: 'B' },
  { id: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'fill', label: 'Flood Fill', key: 'G' },
  { id: 'line', label: 'Line', key: 'L' },
  { id: 'rect', label: 'Rectangle', key: 'U' },
  { id: 'ellipse', label: 'Ellipse', key: 'O' },
  { id: 'dither', label: 'Dither Brush', key: 'D' },
  { id: 'replace', label: 'Color-Index Replace', key: 'R' },
  { id: 'picker', label: 'Eyedropper', key: 'I' },
  { id: 'box', label: 'Hit / Hurt Box', key: 'J' },
];

export const SCENE_TOOLS: ToolDef<SceneToolId>[] = [
  { id: 'stamp', label: 'Tile Brush', key: 'B' },
  { id: 'tileErase', label: 'Tile Eraser', key: 'E' },
  { id: 'tileFill', label: 'Tile Fill', key: 'G' },
  { id: 'tileRect', label: 'Tile Rectangle', key: 'U' },
  { id: 'tilePick', label: 'Tile Picker (drag for a stamp)', key: 'I' },
  { id: 'priority', label: 'Priority Brush (left: high, right: low)', key: 'P' },
  { id: 'object', label: 'Sprite Objects', key: 'M' },
];

/** Tools that draw with the square brush footprint (and show it as the cursor). */
export const BRUSH_TOOLS: ReadonlySet<ToolId> = new Set(['pencil', 'eraser', 'dither', 'line', 'rect', 'ellipse']);

export type Target =
  | { kind: 'canvas'; id: string }
  | { kind: 'tileset'; id: string }
  | { kind: 'sprite'; id: string; frame: number }
  | { kind: 'scene' };

export interface ToolSettings {
  brushSize: number;
  pixelPerfect: boolean;
  filled: boolean;
  mirrorH: boolean;
  mirrorV: boolean;
  wrap: boolean;
  ditherPattern: DitherPattern;
  ditherDensity: number;
  /** Dither paints the secondary color on "off" cells instead of leaving them untouched. */
  ditherBothColors: boolean;
}

export interface ViewSettings {
  zoom: number;
  /** CSS-pixel offset of the region's top-left corner inside the viewport. */
  panX: number;
  panY: number;
  pixelGrid: boolean;
  tileGrid: 0 | 8 | 16;
  /** Show 8:7 NTSC pixel aspect ratio instead of square pixels. */
  par: boolean;
  /** Show index 0 as the CGRAM backdrop color instead of a transparency checkerboard. */
  showBackdrop: boolean;
}

export interface Mods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** A tilemap brush: tile numbers + flip bits (palette and priority come from the paint settings). */
export interface Stamp {
  w: number;
  h: number;
  cells: Uint16Array;
}

export const ZOOMS = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64];
export const PAR_NTSC = 8 / 7;
const NO_MODS: Mods = { shift: false, alt: false, ctrl: false };
const TICK_MS = 1000 / 60;

interface Session {
  move(x: number, y: number, mods: Mods): void;
  end?(): void;
}
type ValueFn = (x: number, y: number) => number | null;

const wrapN = (a: number, n: number) => ((a % n) + n) % n;

export class Editor {
  project: Project = createDefaultProject();
  target: Target = { kind: 'scene' };
  /** The image the pixel tools edit (in scene mode: the active layer's tileset sheet). */
  image: IndexedImage = createImage(8, 8, 4);
  primary = 4;
  secondary = 0;
  /** CGRAM slot open in the color editor. */
  selectedSlot = 8 * 16 + 4;
  pixelTool: PixelToolId = 'pencil';
  sceneTool: SceneToolId = 'stamp';
  settings: ToolSettings = {
    brushSize: 1,
    pixelPerfect: true,
    filled: false,
    mirrorH: false,
    mirrorV: false,
    wrap: false,
    ditherPattern: 'checker',
    ditherDensity: 0.5,
    ditherBothColors: false,
  };
  view: ViewSettings = { zoom: 12, panX: 0, panY: 0, pixelGrid: true, tileGrid: 8, par: false, showBackdrop: false };
  hover: { x: number; y: number } | null = null;
  readonly history = new History(1000);
  viewport = { w: 0, h: 0 };

  // ---- scene editing state ----
  activeLayer = 0;
  scenePalette = 0;
  stamp: Stamp = { w: 1, h: 1, cells: Uint16Array.of(1) };
  paintPriority = false;
  showPriority = true;
  selectedObjectId: string | null = null;
  objectSpriteId: string | null = null;
  /** Live selection rectangle of the tile picker, in cells of the active layer. */
  pickRect: { x: number; y: number; w: number; h: number } | null = null;
  /** 'edit' shows the whole map; 'screen' shows the 256×224 camera window with parallax. */
  sceneView: 'edit' | 'screen' = 'edit';
  camera = { x: 0, y: 0 };

  // ---- sprite editing state ----
  onionSkin = true;
  boxKind: 'hit' | 'hurt' = 'hit';
  draftBox: (Box & { kind: 'hit' | 'hurt' }) | null = null;

  // ---- playback ----
  playing = false;
  tick = 0;
  private tickAccum = 0;
  private cycleBuf = new Uint16Array(256);

  // Consumers (renderers, previews) compare these to decide what to re-upload / redraw.
  imageVersion = 0;
  pixelVersion = 0;
  paletteVersion = 0;
  cellsVersion = 0;
  structureVersion = 0;
  renderVersion = 0;

  private version = 0;
  private fastVersion = 0;
  private listeners = new Set<() => void>();
  private fastListeners = new Set<() => void>();
  private session: Session | null = null;
  private tx: PixelTransaction | CellTransaction | null = null;
  private sessionLabel = '';
  private fitPending = true;

  constructor() {
    this.objectSpriteId = this.project.sprites[0]?.id ?? null;
    this.resolveImage();
  }

  // ---- subscriptions -------------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = (): number => this.version;

  /** High-frequency channel: hover, pan, playback ticks. */
  subscribeFast = (fn: () => void): (() => void) => {
    this.fastListeners.add(fn);
    return () => this.fastListeners.delete(fn);
  };
  getFastVersion = (): number => this.fastVersion;

  /** Notify the UI (structural change: stroke committed, setting changed, etc.). */
  emit(): void {
    this.version++;
    this.renderVersion++;
    this.listeners.forEach((f) => f());
    this.emitFast();
  }

  private emitFast(): void {
    this.fastVersion++;
    this.fastListeners.forEach((f) => f());
  }

  private markPixels(): void {
    this.pixelVersion++;
    this.renderVersion++;
  }
  private markCells(): void {
    this.cellsVersion++;
    this.renderVersion++;
  }
  private markPalette(): void {
    this.paletteVersion++;
    this.renderVersion++;
  }
  private markStructure(): void {
    this.structureVersion++;
    this.pixelVersion++;
    this.cellsVersion++;
    this.renderVersion++;
  }

  // ---- derived -------------------------------------------------------------------------------

  get cgram(): Uint16Array {
    return this.project.cgram;
  }
  get mode(): 'pixel' | 'scene' {
    return this.target.kind === 'scene' ? 'scene' : 'pixel';
  }
  get tool(): ToolId {
    return this.mode === 'scene' ? this.sceneTool : this.pixelTool;
  }
  get canvasAsset(): CanvasAsset | undefined {
    const t = this.target;
    return t.kind === 'canvas' ? this.project.canvases.find((c) => c.id === t.id) : undefined;
  }
  get tilesetAsset(): Tileset | undefined {
    const t = this.target;
    return t.kind === 'tileset' ? this.project.tilesets.find((c) => c.id === t.id) : undefined;
  }
  get spriteAsset(): SpriteAsset | undefined {
    const t = this.target;
    return t.kind === 'sprite' ? this.project.sprites.find((c) => c.id === t.id) : undefined;
  }
  get frameIndex(): number {
    return this.target.kind === 'sprite' ? this.target.frame : 0;
  }
  get spriteFrame(): SpriteFrame | undefined {
    return this.spriteAsset?.frames[this.frameIndex];
  }
  get layerMap(): Tilemap | undefined {
    return layerTilemap(this.project, this.activeLayer);
  }
  get layerTileset(): Tileset | undefined {
    return layerTileset(this.project, this.activeLayer);
  }
  get bpp(): Bpp {
    return this.mode === 'scene' ? (this.layerTileset?.bpp ?? 4) : this.image.bpp;
  }

  get paletteId(): number {
    switch (this.target.kind) {
      case 'canvas':
        return this.canvasAsset?.paletteId ?? 0;
      case 'tileset':
        return this.tilesetAsset?.paletteId ?? 0;
      case 'sprite':
        return this.spriteAsset?.paletteId ?? 8;
      case 'scene':
        return this.scenePalette;
    }
  }
  private set paletteId(v: number) {
    switch (this.target.kind) {
      case 'canvas':
        if (this.canvasAsset) this.canvasAsset.paletteId = v;
        break;
      case 'tileset':
        if (this.tilesetAsset) this.tilesetAsset.paletteId = v;
        break;
      case 'sprite':
        if (this.spriteAsset) this.spriteAsset.paletteId = v;
        break;
      case 'scene':
        this.scenePalette = v;
        break;
    }
  }

  /** Sub-palettes the current target may use: sprites use OBJ palettes, tilemaps BG palettes 0–7. */
  paletteRange(): [number, number] {
    const bpp = this.bpp;
    if (bpp === 8) return [0, 0];
    if (this.target.kind === 'sprite') return [8, 15];
    if (this.target.kind === 'canvas') return [0, paletteCount(bpp) - 1];
    return [0, 7];
  }

  get base(): number {
    return paletteBase(this.bpp, this.paletteId);
  }
  /** BGR555 color a local index resolves to in the active sub-palette. */
  colorOf(local: number): Bgr555 {
    return this.cgram[this.base + local];
  }
  /** CGRAM as currently displayed (palette cycles applied while playing). */
  displayCgram(): Uint16Array {
    if (!this.playing || !this.project.cycles.some((c) => c.enabled)) return this.cgram;
    return cycledCgram(this.cgram, this.project.cycles, this.tick, this.cycleBuf);
  }

  pixelAt(x: number, y: number): number | null {
    const { width: w, height: h } = this.image;
    if (this.settings.wrap) {
      x = wrapN(x, w);
      y = wrapN(y, h);
    } else if (x < 0 || y < 0 || x >= w || y >= h) return null;
    return this.image.pixels[y * w + x];
  }

  /** Size of the area the canvas shows, in pixels. */
  regionSize(): { w: number; h: number } {
    if (this.mode === 'pixel') return { w: this.image.width, h: this.image.height };
    if (this.sceneView === 'screen') return { w: this.project.scene.resolution.width, h: this.project.scene.resolution.height };
    return sceneMapSize(this.project);
  }

  /** World-space region shown (the camera window in screen view). */
  sceneRegion(): Region {
    const { w, h } = this.regionSize();
    return this.sceneView === 'screen' ? { x: Math.round(this.camera.x), y: Math.round(this.camera.y), w, h } : { x: 0, y: 0, w, h };
  }

  /** Per-layer scroll offset for the current view. */
  layerScroll(i: number): { x: number; y: number } {
    if (this.sceneView !== 'screen') return { x: 0, y: 0 };
    const f = this.project.scene.layers[i]?.scrollFactor ?? 1;
    return { x: Math.round(this.camera.x * f), y: Math.round(this.camera.y * f) };
  }

  /** Map a region pixel to a cell of a layer's tilemap (wrapping like hardware). */
  cellAt(layer: number, x: number, y: number): { cx: number; cy: number; idx: number; map: Tilemap } | null {
    const map = layerTilemap(this.project, layer);
    if (!map) return null;
    const s = this.layerScroll(layer);
    const cx = wrapN(Math.floor((x + s.x) / 8), map.width);
    const cy = wrapN(Math.floor((y + s.y) / 8), map.height);
    return { cx, cy, idx: cy * map.width + cx, map };
  }

  // ---- simple setters ------------------------------------------------------------------------

  setTool(t: ToolId): void {
    if (SCENE_TOOLS.some((d) => d.id === t)) this.sceneTool = t as SceneToolId;
    else this.pixelTool = t as PixelToolId;
    this.emit();
  }

  setSetting<K extends keyof ToolSettings>(key: K, value: ToolSettings[K]): void {
    this.settings = { ...this.settings, [key]: value };
    this.emit();
  }

  setView(partial: Partial<ViewSettings>, silent = false): void {
    this.view = { ...this.view, ...partial };
    if (silent) {
      this.renderVersion++;
      this.emitFast();
    } else this.emit();
  }

  /** Generic setter for plain editor fields, e.g. ed.set({ showPriority: false }). */
  set(partial: Partial<Pick<Editor, 'onionSkin' | 'boxKind' | 'showPriority' | 'paintPriority' | 'objectSpriteId'>>): void {
    Object.assign(this, partial);
    this.emit();
  }

  setPaletteId(id: number): void {
    const [lo, hi] = this.paletteRange();
    const n = Math.max(lo, Math.min(hi, id));
    if (n === this.paletteId) return;
    // Keep the color editor on the same local index so swaps can be tuned side by side.
    const bs = blockSize(this.bpp);
    const oldBase = this.base;
    if (this.selectedSlot >= oldBase && this.selectedSlot < oldBase + bs) {
      this.selectedSlot = paletteBase(this.bpp, n) + (this.selectedSlot - oldBase);
    }
    this.paletteId = n;
    this.markPixels();
    this.emit();
  }

  cyclePalette(dir: 1 | -1): void {
    const [lo, hi] = this.paletteRange();
    this.setPaletteId(lo + wrapN(this.paletteId - lo + dir, hi - lo + 1));
  }

  setPrimary(local: number): void {
    this.primary = local;
    this.selectedSlot = this.base + local;
    this.emit();
  }

  setSecondary(local: number): void {
    this.secondary = local;
    this.emit();
  }

  swapColors(): void {
    [this.primary, this.secondary] = [this.secondary, this.primary];
    this.emit();
  }

  selectSlot(slot: number): void {
    this.selectedSlot = slot;
    this.emit();
  }

  setTitle(t: string): void {
    this.project.title = t;
    this.emit();
  }

  setHover(p: { x: number; y: number } | null): void {
    const h = this.hover;
    if (h === p || (h && p && h.x === p.x && h.y === p.y)) return;
    this.hover = p;
    this.renderVersion++;
    this.emitFast();
  }

  // ---- targets -------------------------------------------------------------------------------

  private resolveImage(): void {
    let img: IndexedImage | undefined;
    switch (this.target.kind) {
      case 'canvas':
        img = this.canvasAsset?.image;
        break;
      case 'tileset':
        img = this.tilesetAsset?.sheet;
        break;
      case 'sprite':
        img = this.spriteFrame?.image;
        break;
      case 'scene':
        img = this.layerTileset?.sheet;
        break;
    }
    if (!img) {
      if (this.target.kind !== 'scene') {
        this.target = { kind: 'scene' };
        return this.resolveImage();
      }
      img = createImage(8, 8, 4);
    }
    if (img !== this.image) {
      this.image = img;
      this.imageVersion++;
      this.markPixels();
    }
    const bs = blockSize(this.bpp);
    if (this.primary >= bs) this.primary = Math.min(1, bs - 1);
    if (this.secondary >= bs) this.secondary = 0;
    const [lo, hi] = this.paletteRange();
    if (this.paletteId < lo || this.paletteId > hi) this.paletteId = lo;
  }

  /** Re-check the target after structural undo/redo (frames or assets may have vanished). */
  private validateTarget(): void {
    const t = this.target;
    if (t.kind === 'sprite') {
      const s = this.spriteAsset;
      if (s) t.frame = Math.max(0, Math.min(s.frames.length - 1, t.frame));
    }
    if (this.activeLayer >= this.project.scene.layers.length) this.activeLayer = 0;
    if (this.selectedObjectId && !this.project.scene.objects.some((o) => o.id === this.selectedObjectId)) {
      this.selectedObjectId = null;
    }
    this.resolveImage();
  }

  setTarget(t: Target): void {
    if (this.session) this.cancelStroke();
    const sameAsset = this.target.kind === t.kind && 'id' in t && 'id' in this.target && t.id === this.target.id;
    this.target = t;
    this.resolveImage();
    if (!sameAsset) this.fitView();
    this.emit();
  }

  setFrame(i: number): void {
    const s = this.spriteAsset;
    if (!s || this.target.kind !== 'sprite') return;
    this.setTarget({ kind: 'sprite', id: s.id, frame: Math.max(0, Math.min(s.frames.length - 1, i)) });
  }

  setActiveLayer(i: number): void {
    this.activeLayer = i;
    this.resolveImage();
    this.emit();
  }

  setSceneView(v: 'edit' | 'screen'): void {
    this.sceneView = v;
    this.fitView();
  }

  // ---- view ----------------------------------------------------------------------------------

  setViewport(w: number, h: number): void {
    this.viewport = { w, h };
    if (this.fitPending && w > 0 && h > 0) {
      this.fitPending = false;
      this.fitView();
    } else this.renderVersion++;
  }

  scaleX(zoom = this.view.zoom): number {
    return zoom * (this.view.par ? PAR_NTSC : 1);
  }

  fitView(): void {
    const { w, h } = this.viewport;
    if (!w || !h) {
      this.fitPending = true;
      return;
    }
    const r = this.regionSize();
    const par = this.view.par ? PAR_NTSC : 1;
    let zoom = 1;
    for (const z of ZOOMS) if (r.w * z * par <= w * 0.9 && r.h * z <= h * 0.9) zoom = z;
    this.view = {
      ...this.view,
      zoom,
      panX: Math.round((w - r.w * zoom * par) / 2),
      panY: Math.round((h - r.h * zoom) / 2),
    };
    this.emit();
  }

  /** Step through ZOOMS keeping the point under (cx, cy) fixed. */
  zoomAt(cx: number, cy: number, dir: 1 | -1): void {
    const z = this.view.zoom;
    const i = ZOOMS.indexOf(z);
    const next =
      i >= 0
        ? ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))]
        : dir > 0
          ? (ZOOMS.find((v) => v > z) ?? z)
          : ([...ZOOMS].reverse().find((v) => v < z) ?? z);
    if (next === z) return;
    const kx = this.scaleX(next) / this.scaleX(z);
    const ky = next / z;
    this.setView({ zoom: next, panX: cx - (cx - this.view.panX) * kx, panY: cy - (cy - this.view.panY) * ky });
  }

  zoomStep(dir: 1 | -1): void {
    this.zoomAt(this.viewport.w / 2, this.viewport.h / 2, dir);
  }

  togglePar(): void {
    const cx = this.viewport.w / 2;
    const before = this.scaleX();
    this.view = { ...this.view, par: !this.view.par };
    this.view.panX = cx - (cx - this.view.panX) * (this.scaleX() / before);
    this.emit();
  }

  // ---- playback ------------------------------------------------------------------------------

  setPlaying(on: boolean): void {
    this.playing = on;
    this.tickAccum = 0;
    this.markPalette();
    this.emit();
  }

  /** Advance the 60 Hz clock by elapsed wall time. Returns true if at least one tick passed. */
  advance(ms: number): boolean {
    if (!this.playing) return false;
    this.tickAccum += Math.min(ms, 250);
    const n = Math.floor(this.tickAccum / TICK_MS);
    if (!n) return false;
    this.tickAccum -= n * TICK_MS;
    this.tick += n;
    if (this.mode === 'scene' && this.sceneView === 'screen') {
      this.camera.x += this.project.scene.scroll.speedX * n;
      this.camera.y += this.project.scene.scroll.speedY * n;
    }
    this.markPalette();
    this.emitFast();
    return true;
  }

  moveCamera(dx: number, dy: number): void {
    this.camera.x += dx;
    this.camera.y += dy;
    this.renderVersion++;
    this.emitFast();
  }

  resetCamera(): void {
    this.camera = { x: 0, y: 0 };
    this.renderVersion++;
    this.emit();
  }

  // ---- painting primitives -------------------------------------------------------------------

  /** Visit every pixel a brush stamp at (x, y) covers, including mirrors and wrap-around. */
  private footprint(x: number, y: number, size: number, fn: (idx: number, px: number, py: number) => void): void {
    const { width: w, height: h } = this.image;
    const { mirrorH, mirrorV, wrap } = this.settings;
    const off = Math.floor((size - 1) / 2);
    const one = (px: number, py: number) => {
      if (wrap) {
        px = wrapN(px, w);
        py = wrapN(py, h);
      } else if (px < 0 || py < 0 || px >= w || py >= h) return;
      fn(py * w + px, px, py);
    };
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const px = x - off + dx;
        const py = y - off + dy;
        one(px, py);
        if (mirrorH) one(w - 1 - px, py);
        if (mirrorV) one(px, h - 1 - py);
        if (mirrorH && mirrorV) one(w - 1 - px, h - 1 - py);
      }
    }
  }

  private stampPx(tx: PixelTransaction, x: number, y: number, value: ValueFn, size: number): void {
    this.footprint(x, y, size, (idx, px, py) => {
      const v = value(px, py);
      if (v !== null) tx.set(idx, v);
    });
  }

  private unstampPx(tx: PixelTransaction, x: number, y: number, size: number): void {
    this.footprint(x, y, size, (idx) => tx.restore(idx));
  }

  private ditherValue(on: number, off: number): ValueFn {
    const { ditherPattern, ditherDensity, ditherBothColors } = this.settings;
    return (x, y) => (ditherOn(ditherPattern, x, y, ditherDensity) ? on : ditherBothColors ? off : null);
  }

  // ---- pointer-driven sessions ---------------------------------------------------------------

  get isDrawing(): boolean {
    return this.session !== null;
  }

  pointerDown(x: number, y: number, button: 0 | 2, mods: Mods = NO_MODS): void {
    if (this.session) return;
    if (this.mode === 'scene') return this.scenePointerDown(x, y, button, mods);
    const drawColor = button === 2 ? this.secondary : this.primary;
    const otherColor = button === 2 ? this.primary : this.secondary;

    if (mods.alt || this.pixelTool === 'picker') {
      const pick = (px: number, py: number) => this.pick(px, py, button);
      pick(x, y);
      this.session = { move: pick };
      return;
    }
    if (this.pixelTool === 'box') {
      this.session = this.boxSession(x, y);
      return;
    }

    const tx = new PixelTransaction(this.image);
    this.tx = tx;
    const size = this.settings.brushSize;
    const flat = (v: number): ValueFn => () => v;

    switch (this.pixelTool) {
      case 'pencil':
        this.sessionLabel = 'Pencil';
        this.session = this.freehand(tx, x, y, flat(drawColor), size, this.settings.pixelPerfect);
        break;
      case 'eraser':
        this.sessionLabel = 'Erase';
        this.session = this.freehand(tx, x, y, flat(0), size, this.settings.pixelPerfect);
        break;
      case 'dither':
        this.sessionLabel = 'Dither';
        this.session = this.freehand(tx, x, y, this.ditherValue(drawColor, otherColor), size, false);
        break;
      case 'line':
      case 'rect':
      case 'ellipse':
        this.sessionLabel = this.pixelTool === 'line' ? 'Line' : this.pixelTool === 'rect' ? 'Rectangle' : 'Ellipse';
        this.session = this.shape(tx, x, y, this.pixelTool, drawColor, size);
        break;
      case 'fill': {
        this.sessionLabel = 'Fill';
        const v = this.pixelAt(x, y);
        if (v !== null && v !== drawColor) {
          const { width: w, height: h } = this.image;
          const region = floodRegion(w, h, this.image.pixels, wrapN(x, w), wrapN(y, h), this.settings.wrap);
          for (let i = 0; i < region.length; i++) tx.set(region[i], drawColor);
          this.markPixels();
        }
        this.session = { move: () => {} };
        break;
      }
      case 'replace': {
        this.sessionLabel = 'Replace color';
        const v = this.pixelAt(x, y);
        if (v !== null && v !== drawColor) {
          const p = this.image.pixels;
          for (let i = 0; i < p.length; i++) if (p[i] === v) tx.set(i, drawColor);
          this.markPixels();
        }
        this.session = { move: () => {} };
        break;
      }
    }
  }

  pointerMove(x: number, y: number, mods: Mods = NO_MODS): void {
    this.session?.move(x, y, mods);
  }

  pointerUp(): void {
    if (!this.session) return;
    const s = this.session;
    this.session = null;
    s.end?.();
    const tx = this.tx;
    this.tx = null;
    const entry = tx?.toEntry(this.sessionLabel);
    if (entry) this.history.push(entry);
    this.emit();
  }

  /** Abort the current stroke and restore the image. */
  cancelStroke(): void {
    if (!this.session) return;
    this.tx?.revertAll();
    this.session = null;
    this.tx = null;
    this.draftBox = null;
    this.pickRect = null;
    this.markPixels();
    this.markCells();
    this.emit();
  }

  private pick(x: number, y: number, button: 0 | 2): void {
    const v = this.pixelAt(x, y);
    if (v === null) return;
    if (button === 2) this.setSecondary(v);
    else this.setPrimary(v);
  }

  /**
   * Freehand stroke with Bresenham interpolation between pointer samples (no gaps on fast
   * motion) and optional pixel-perfect L-corner cleanup for 1px lines.
   */
  private freehand(tx: PixelTransaction, x0: number, y0: number, value: ValueFn, size: number, pixelPerfect: boolean): Session {
    const pp = pixelPerfect && size === 1;
    const pts: [number, number][] = [];
    let last: [number, number] | null = null;

    const addPoint = (x: number, y: number) => {
      const l = pts[pts.length - 1];
      if (l && l[0] === x && l[1] === y) return;
      pts.push([x, y]);
      this.stampPx(tx, x, y, value, size);
      if (pp && pts.length >= 3) {
        const a = pts[pts.length - 3];
        const b = pts[pts.length - 2];
        const c = pts[pts.length - 1];
        const diagonal = Math.abs(a[0] - c[0]) === 1 && Math.abs(a[1] - c[1]) === 1;
        const corner = (b[0] === a[0] || b[1] === a[1]) && (b[0] === c[0] || b[1] === c[1]);
        if (diagonal && corner) {
          this.unstampPx(tx, b[0], b[1], size);
          pts.splice(pts.length - 2, 1);
        }
      }
      if (pts.length > 16) pts.splice(0, pts.length - 16);
    };

    const moveTo = (x: number, y: number) => {
      if (!last) addPoint(x, y);
      else if (last[0] !== x || last[1] !== y) line(last[0], last[1], x, y, addPoint);
      last = [x, y];
      this.markPixels();
    };

    moveTo(x0, y0);
    return { move: moveTo };
  }

  private constrain(x0: number, y0: number, x1: number, y1: number, kind: 'line' | 'box', mods: Mods): [number, number] {
    if (!mods.shift) return [x1, y1];
    const dx = x1 - x0, dy = y1 - y0;
    if (kind === 'line') {
      if (Math.abs(dx) > 2 * Math.abs(dy)) return [x1, y0];
      if (Math.abs(dy) > 2 * Math.abs(dx)) return [x0, y1];
    }
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return [x0 + Math.sign(dx || 1) * d, y0 + Math.sign(dy || 1) * d];
  }

  private shape(tx: PixelTransaction, x0: number, y0: number, kind: 'line' | 'rect' | 'ellipse', color: number, size: number): Session {
    const value: ValueFn = () => color;
    const draw = (x1: number, y1: number, mods: Mods) => {
      tx.revertAll();
      const [ex, ey] = this.constrain(x0, y0, x1, y1, kind === 'line' ? 'line' : 'box', mods);
      const filled = kind !== 'line' && this.settings.filled;
      const s = filled ? 1 : size;
      const plot = (x: number, y: number) => this.stampPx(tx, x, y, value, s);
      if (kind === 'line') line(x0, y0, ex, ey, plot);
      else if (kind === 'rect') rect(x0, y0, ex, ey, filled, plot);
      else ellipse(x0, y0, ex, ey, filled, plot);
      this.markPixels();
    };
    draw(x0, y0, NO_MODS);
    return { move: draw };
  }

  private boxSession(x0: number, y0: number): Session {
    const frame = this.spriteFrame;
    if (!frame) return { move: () => {} };
    const kind = this.boxKind;
    const clampX = (v: number) => Math.max(0, Math.min(frame.image.width - 1, v));
    const clampY = (v: number) => Math.max(0, Math.min(frame.image.height - 1, v));
    const update = (x1: number, y1: number) => {
      const ax = clampX(Math.min(x0, x1)), bx = clampX(Math.max(x0, x1));
      const ay = clampY(Math.min(y0, y1)), by = clampY(Math.max(y0, y1));
      this.draftBox = { x: ax, y: ay, w: bx - ax + 1, h: by - ay + 1, kind };
      this.renderVersion++;
      this.emitFast();
    };
    update(x0, y0);
    return {
      move: update,
      end: () => {
        const b = this.draftBox;
        this.draftBox = null;
        if (!b || (b.w < 2 && b.h < 2)) return;
        const list = kind === 'hit' ? frame.hitboxes : frame.hurtboxes;
        const box: Box = { x: b.x, y: b.y, w: b.w, h: b.h };
        this.commitCustom(`Add ${kind}box`, () => list.push(box), () => list.splice(list.indexOf(box), 1));
      },
    };
  }

  // ---- scene sessions ------------------------------------------------------------------------

  private paintWord(stampCell: number): number {
    return (stampCell & 0xc3ff) | ((this.scenePalette & 7) << 10) | ((this.paintPriority ? 1 : 0) << 13);
  }

  /** Write the stamp with its top-left at cell (cx, cy) of `map`. */
  private placeStamp(tx: CellTransaction, map: Tilemap, cx: number, cy: number): void {
    const s = this.stamp;
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) {
        const mx = wrapN(cx + x, map.width), my = wrapN(cy + y, map.height);
        tx.set(my * map.width + mx, this.paintWord(s.cells[y * s.w + x]));
      }
  }

  private scenePointerDown(x: number, y: number, button: 0 | 2, mods: Mods): void {
    if (this.sceneTool === 'object') {
      this.session = this.objectSession(x, y, button);
      return;
    }
    const start = this.cellAt(this.activeLayer, x, y);
    if (!start) return;
    const { map } = start;
    const pickMode = this.sceneTool === 'tilePick' || mods.alt;
    if (pickMode) {
      this.session = this.pickSession(start.cx, start.cy, map);
      return;
    }
    const tx = new CellTransaction(map.cells);
    this.tx = tx;
    let last = { cx: start.cx, cy: start.cy };

    // Interpolate cell positions along fast drags, like the pixel pencil.
    const drag = (fn: (cx: number, cy: number) => void) => (px: number, py: number) => {
      const c = this.cellAt(this.activeLayer, px, py);
      if (!c) return;
      line(last.cx, last.cy, c.cx, c.cy, fn);
      last = { cx: c.cx, cy: c.cy };
      this.markCells();
    };

    switch (this.sceneTool) {
      case 'stamp': {
        this.sessionLabel = 'Paint tiles';
        const { w, h } = this.stamp;
        const ox = start.cx, oy = start.cy;
        const put = (cx: number, cy: number) => {
          // Place stamps on a grid anchored at the first cell so multi-tile stamps tile cleanly.
          if (wrapN(cx - ox, w) === 0 && wrapN(cy - oy, h) === 0) this.placeStamp(tx, map, cx, cy);
        };
        put(start.cx, start.cy);
        this.markCells();
        this.session = { move: drag(put) };
        break;
      }
      case 'tileErase': {
        this.sessionLabel = 'Erase tiles';
        const put = (cx: number, cy: number) => tx.set(cy * map.width + cx, 0);
        put(start.cx, start.cy);
        this.markCells();
        this.session = { move: drag(put) };
        break;
      }
      case 'priority': {
        this.sessionLabel = 'Set priority';
        const put = (cx: number, cy: number) => {
          const i = cy * map.width + cx;
          tx.set(i, button === 2 ? map.cells[i] & ~0x2000 : map.cells[i] | 0x2000);
        };
        put(start.cx, start.cy);
        this.markCells();
        this.session = { move: drag(put) };
        break;
      }
      case 'tileFill': {
        this.sessionLabel = 'Fill tiles';
        const word = this.paintWord(this.stamp.cells[0]);
        const region = floodRegion(map.width, map.height, map.cells, start.cx, start.cy, true);
        if (map.cells[start.idx] !== word) for (const i of region) tx.set(i, word);
        this.markCells();
        this.session = { move: () => {} };
        break;
      }
      case 'tileRect': {
        this.sessionLabel = 'Tile rectangle';
        const draw = (px: number, py: number) => {
          const c = this.cellAt(this.activeLayer, px, py);
          if (!c) return;
          tx.revertAll();
          const x0 = Math.min(start.cx, c.cx), x1 = Math.max(start.cx, c.cx);
          const y0 = Math.min(start.cy, c.cy), y1 = Math.max(start.cy, c.cy);
          const s = this.stamp;
          for (let cy = y0; cy <= y1; cy++)
            for (let cx = x0; cx <= x1; cx++) {
              const sc = s.cells[wrapN(cy - y0, s.h) * s.w + wrapN(cx - x0, s.w)];
              tx.set(cy * map.width + cx, this.paintWord(sc));
            }
          this.markCells();
        };
        draw(x, y);
        this.session = { move: draw };
        break;
      }
    }
  }

  private pickSession(cx0: number, cy0: number, map: Tilemap): Session {
    const update = (cx1: number, cy1: number) => {
      this.pickRect = {
        x: Math.min(cx0, cx1),
        y: Math.min(cy0, cy1),
        w: Math.abs(cx1 - cx0) + 1,
        h: Math.abs(cy1 - cy0) + 1,
      };
      this.renderVersion++;
      this.emitFast();
    };
    update(cx0, cy0);
    return {
      move: (px, py) => {
        const c = this.cellAt(this.activeLayer, px, py);
        // Don't let a wrapped coordinate flip the selection to the far side.
        if (c && c.map === map) update(c.cx, c.cy);
      },
      end: () => {
        const r = this.pickRect;
        this.pickRect = null;
        if (!r) return;
        const cells = new Uint16Array(r.w * r.h);
        for (let y = 0; y < r.h; y++)
          for (let x = 0; x < r.w; x++) cells[y * r.w + x] = map.cells[(r.y + y) * map.width + r.x + x] & 0xc3ff;
        this.stamp = { w: r.w, h: r.h, cells };
        const first = map.cells[r.y * map.width + r.x];
        this.scenePalette = cellPal(first);
        this.paintPriority = cellPrio(first) === 1;
        if (this.sceneTool === 'tilePick') this.sceneTool = 'stamp';
      },
    };
  }

  private objectSession(x: number, y: number, button: 0 | 2): Session {
    const region = this.sceneRegion();
    const wx = x + region.x, wy = y + region.y;
    const p = this.project;
    const hit = hitObject(p, wx, wy);
    if (button === 2) {
      if (hit) this.deleteObject(hit.id);
      return { move: () => {} };
    }
    if (hit) {
      this.selectedObjectId = hit.id;
      const ox = hit.x, oy = hit.y;
      return {
        move: (px, py) => {
          hit.x = ox + px + region.x - wx;
          hit.y = oy + py + region.y - wy;
          this.renderVersion++;
          this.emitFast();
        },
        end: () => {
          const nx = hit.x, ny = hit.y;
          if (nx === ox && ny === oy) return;
          this.commitCustom(
            'Move object',
            () => Object.assign(hit, { x: nx, y: ny }),
            () => Object.assign(hit, { x: ox, y: oy }),
          );
        },
      };
    }
    const sprite = p.sprites.find((s) => s.id === this.objectSpriteId) ?? p.sprites[0];
    if (!sprite) return { move: () => {} };
    const obj: SceneObject = { id: uid('obj'), spriteId: sprite.id, x: wx, y: wy, priority: 2, hFlip: false, colorMath: false };
    this.commitCustom(
      'Place object',
      () => p.scene.objects.unshift(obj),
      () => p.scene.objects.splice(p.scene.objects.indexOf(obj), 1),
    );
    this.selectedObjectId = obj.id;
    return { move: () => {} };
  }

  get selectedObject(): SceneObject | undefined {
    return this.project.scene.objects.find((o) => o.id === this.selectedObjectId);
  }

  deleteObject(id: string): void {
    const list = this.project.scene.objects;
    const i = list.findIndex((o) => o.id === id);
    if (i < 0) return;
    const obj = list[i];
    this.commitCustom('Delete object', () => list.splice(list.indexOf(obj), 1), () => list.splice(i, 0, obj));
  }

  updateObject(id: string, patch: Partial<SceneObject>): void {
    const o = this.project.scene.objects.find((ob) => ob.id === id);
    if (!o) return;
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, o[k as keyof SceneObject]]));
    this.commitCustom('Edit object', () => Object.assign(o, patch), () => Object.assign(o, before));
  }

  /** Select a rectangle of tiles from a tileset sheet as the stamp. */
  setStampFromTiles(first: number, w: number, h: number): void {
    const cells = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells[y * w + x] = first + y * SHEET_COLS + x;
    this.stamp = { w, h, cells };
    if (this.sceneTool !== 'tileRect' && this.sceneTool !== 'tileFill') this.sceneTool = 'stamp';
    this.emit();
  }

  /** Flip the whole stamp (tile order and each tile's flip bit). */
  flipStamp(axis: 'h' | 'v'): void {
    const s = this.stamp;
    const out = new Uint16Array(s.cells.length);
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) {
        const sx = axis === 'h' ? s.w - 1 - x : x;
        const sy = axis === 'v' ? s.h - 1 - y : y;
        out[y * s.w + x] = s.cells[sy * s.w + sx] ^ (axis === 'h' ? 0x4000 : 0x8000);
      }
    this.stamp = { ...s, cells: out };
    this.emit();
  }

  // ---- history -------------------------------------------------------------------------------

  private apply(e: HistoryEntry, dir: 'undo' | 'redo'): void {
    switch (e.kind) {
      case 'pixels': {
        const src = dir === 'undo' ? e.before : e.after;
        const p = e.img.pixels;
        for (let i = 0; i < e.idx.length; i++) p[e.idx[i]] = src[i];
        this.markPixels();
        break;
      }
      case 'cells': {
        const src = dir === 'undo' ? e.before : e.after;
        for (let i = 0; i < e.idx.length; i++) e.cells[e.idx[i]] = src[i];
        this.markCells();
        break;
      }
      case 'cgram': {
        const src = dir === 'undo' ? e.before : e.after;
        for (let i = 0; i < e.slots.length; i++) this.cgram[e.slots[i]] = src[i];
        this.markPalette();
        break;
      }
      case 'custom':
        (dir === 'undo' ? e.undo : e.redo)();
        this.markStructure();
        this.validateTarget();
        break;
    }
  }

  undo(): void {
    if (this.session) this.cancelStroke();
    const e = this.history.undo();
    if (!e) return;
    this.apply(e, 'undo');
    this.emit();
  }

  redo(): void {
    if (this.session) return;
    const e = this.history.redo();
    if (!e) return;
    this.apply(e, 'redo');
    this.emit();
  }

  /** Run a structural edit now and record it as one undoable step. */
  commitCustom(label: string, redo: () => void, undo: () => void, bytes?: number): void {
    redo();
    this.history.push({ kind: 'custom', label, redo, undo, bytes });
    this.markStructure();
    this.validateTarget();
    this.emit();
  }

  // ---- palette -------------------------------------------------------------------------------

  /** Edit one CGRAM slot. Rapid edits to the same slot (slider drags) merge into one undo step. */
  setColor(slot: number, value: Bgr555): void {
    const old = this.cgram[slot];
    if (old === value) return;
    this.cgram[slot] = value;
    this.markPalette();
    const now = performance.now();
    const last = this.history.peekUndo();
    if (last && last.kind === 'cgram' && last.slots.length === 1 && last.slots[0] === slot && now - last.time < 1000 && !this.history.canRedo) {
      last.after[0] = value;
      last.time = now;
    } else {
      this.history.push({
        kind: 'cgram',
        label: 'Edit color',
        slots: Uint16Array.of(slot),
        before: Uint16Array.of(old),
        after: Uint16Array.of(value),
        time: now,
      });
    }
    this.emit();
  }

  /** Edit several CGRAM slots as one undo step (ramps, pasted palettes). */
  setColors(slots: number[], values: Bgr555[], label: string): void {
    const s: number[] = [], b: number[] = [], a: number[] = [];
    slots.forEach((slot, i) => {
      if (this.cgram[slot] === values[i]) return;
      s.push(slot);
      b.push(this.cgram[slot]);
      a.push(values[i]);
      this.cgram[slot] = values[i];
    });
    if (!s.length) return;
    this.history.push({ kind: 'cgram', label, slots: Uint16Array.from(s), before: Uint16Array.from(b), after: Uint16Array.from(a), time: 0 });
    this.markPalette();
    this.emit();
  }

  replaceCgram(values: Uint16Array, label: string): void {
    this.setColors(Array.from({ length: values.length }, (_, i) => i), Array.from(values), label);
  }

  addCycle(c: Omit<PaletteCycle, 'id'>): void {
    const cycle = { ...c, id: uid('cyc') };
    const list = this.project.cycles;
    this.commitCustom('Add palette cycle', () => list.push(cycle), () => list.splice(list.indexOf(cycle), 1));
  }

  updateCycle(id: string, patch: Partial<PaletteCycle>): void {
    const c = this.project.cycles.find((cy) => cy.id === id);
    if (!c) return;
    Object.assign(c, patch);
    this.markPalette();
    this.emit();
  }

  removeCycle(id: string): void {
    const list = this.project.cycles;
    const i = list.findIndex((c) => c.id === id);
    if (i < 0) return;
    const c = list[i];
    this.commitCustom('Remove palette cycle', () => list.splice(list.indexOf(c), 1), () => list.splice(i, 0, c));
  }

  // ---- scene settings (not undoable, like view settings) ------------------------------------

  updateScene(fn: (s: Project['scene']) => void): void {
    fn(this.project.scene);
    this.renderVersion++;
    this.markStructure();
    this.emit();
  }

  setStrict(strict: boolean): void {
    this.project.strict = strict;
    this.markStructure();
    this.emit();
  }

  // ---- assets --------------------------------------------------------------------------------

  private addAsset<K extends 'canvases' | 'tilesets' | 'sprites'>(key: K, asset: Project[K][number], target: Target, label: string): void {
    const list = this.project[key] as Project[K][number][];
    this.commitCustom(label, () => list.push(asset), () => list.splice(list.indexOf(asset), 1));
    this.setTarget(target);
  }

  addCanvas(name: string, w: number, h: number, bpp: Bpp): void {
    const c = createCanvas(name, w, h, bpp);
    this.addAsset('canvases', c, { kind: 'canvas', id: c.id }, 'New canvas');
  }

  addTileset(name: string, bpp: Bpp, tiles: number): void {
    const t = createTileset(name, bpp, tiles);
    this.addAsset('tilesets', t, { kind: 'tileset', id: t.id }, 'New tileset');
  }

  addSprite(name: string, w: number, h: number): void {
    const s = createSprite(name, w, h);
    this.addAsset('sprites', s, { kind: 'sprite', id: s.id, frame: 0 }, 'New sprite');
    if (!this.objectSpriteId) this.objectSpriteId = s.id;
  }

  renameAsset(kind: 'canvas' | 'tileset' | 'sprite', id: string, name: string): void {
    const list = kind === 'canvas' ? this.project.canvases : kind === 'tileset' ? this.project.tilesets : this.project.sprites;
    const a = list.find((x) => x.id === id);
    if (a) a.name = name;
    this.emit();
  }

  /** Returns an error message if the asset can't be deleted. */
  deleteAsset(kind: 'canvas' | 'tileset' | 'sprite', id: string): string | null {
    const p = this.project;
    if (kind === 'tileset' && p.tilemaps.some((m) => m.tilesetId === id)) {
      return 'This tileset is used by a background layer. Assign that layer another tileset first.';
    }
    if (kind === 'sprite' && p.scene.objects.some((o) => o.spriteId === id)) {
      return 'This sprite is placed in the scene. Delete its objects first.';
    }
    const list = (kind === 'canvas' ? p.canvases : kind === 'tileset' ? p.tilesets : p.sprites) as { id: string }[];
    const i = list.findIndex((a) => a.id === id);
    if (i < 0) return null;
    const a = list[i];
    this.commitCustom('Delete asset', () => list.splice(list.indexOf(a), 1), () => list.splice(i, 0, a));
    if (this.objectSpriteId === id) this.objectSpriteId = p.sprites[0]?.id ?? null;
    return null;
  }

  /** Grow a tileset by whole rows of 16 tiles. */
  addTileRows(tsId: string, rows: number): void {
    const ts = this.project.tilesets.find((t) => t.id === tsId);
    if (!ts) return;
    const newRows = Math.min(MAX_TILES / SHEET_COLS, ts.sheet.height / 8 + rows);
    const old = ts.sheet;
    const next = createImage(old.width, newRows * 8, old.bpp);
    next.pixels.set(old.pixels.subarray(0, Math.min(old.pixels.length, next.pixels.length)));
    this.commitCustom('Resize tileset', () => (ts.sheet = next), () => (ts.sheet = old));
  }

  /** Deduplicate (with optional flip matching) and compact a tileset, rewriting every map that uses it. */
  optimizeTileset(tsId: string, opts: { flips: boolean; removeUnused: boolean }): { before: number; after: number } | null {
    const p = this.project;
    const ts = p.tilesets.find((t) => t.id === tsId);
    if (!ts) return null;
    const maps = p.tilemaps.filter((m) => m.tilesetId === tsId);
    const r = optimizeTileset(ts, maps, opts);
    const oldSheet = ts.sheet;
    const newSheet = sheetFromTiles(r.tiles, ts.bpp, Math.min(tileCount(ts), 256));
    const oldCells = maps.map((m) => m.cells);
    this.commitCustom(
      'Optimize tileset',
      () => {
        ts.sheet = newSheet;
        maps.forEach((m, i) => (m.cells = r.cells[i]));
      },
      () => {
        ts.sheet = oldSheet;
        maps.forEach((m, i) => (m.cells = oldCells[i]));
      },
      oldSheet.pixels.length + oldCells.reduce((n, c) => n + c.byteLength, 0),
    );
    return { before: r.before, after: r.after };
  }

  /**
   * Cut a canvas into deduplicated tiles: a new tileset plus a tilemap assigned to a BG layer.
   * Returns stats for the UI.
   */
  canvasToLayer(canvasId: string, layer: number, flips: boolean): { blocks: number; tiles: number; palette: number; copiedFrom: number } {
    const p = this.project;
    const cv = p.canvases.find((c) => c.id === canvasId);
    if (!cv) throw new Error('Canvas not found');
    const L = p.scene.layers[layer];
    const wantBpp = layer === 2 ? 2 : 4;
    if (cv.image.bpp !== wantBpp) throw new Error(`${L.id} is ${wantBpp}bpp in Mode 1, but this canvas is ${cv.image.bpp}bpp.`);
    // BG tiles can only address palettes 0–7. A canvas drawn with an OBJ palette (8–15) gets its
    // colors copied into the matching BG palette so the converted layer looks identical.
    const copyFrom = cv.image.bpp === 4 && cv.paletteId > 7 ? cv.paletteId : -1;
    const pal = copyFrom >= 0 ? copyFrom - 8 : Math.min(7, cv.paletteId);
    const cg = this.cgram;
    const oldColors = cg.slice(pal * 16, pal * 16 + 16);
    const newColors = copyFrom >= 0 ? cg.slice(copyFrom * 16, copyFrom * 16 + 16) : oldColors;
    const r = imageToTiles(cv.image, { flips, palette: pal, mapMultiple: 32 });
    const ts: Tileset = { id: uid('ts'), name: `${cv.name} tiles`, bpp: cv.image.bpp, sheet: sheetFromTiles(r.tiles, cv.image.bpp), paletteId: pal };
    const map: Tilemap = { ...createTilemap(`${L.id} map`, ts.id, r.widthTiles, r.heightTiles), cells: r.cells };
    const oldMapId = L.tilemapId;
    this.commitCustom(
      `Convert canvas to ${L.id}`,
      () => {
        p.tilesets.push(ts);
        p.tilemaps.push(map);
        L.tilemapId = map.id;
        cg.set(newColors, pal * 16);
        this.markPalette();
      },
      () => {
        cg.set(oldColors, pal * 16);
        this.markPalette();
        L.tilemapId = oldMapId;
        p.tilemaps.splice(p.tilemaps.indexOf(map), 1);
        p.tilesets.splice(p.tilesets.indexOf(ts), 1);
      },
    );
    return { blocks: r.blocks, tiles: r.tiles.length, palette: pal, copiedFrom: copyFrom };
  }

  /** Point a BG layer at a different tileset (re-using its map cells). */
  setLayerTileset(layer: number, tsId: string): void {
    const p = this.project;
    const map = layerTilemap(p, layer);
    const ts = p.tilesets.find((t) => t.id === tsId);
    if (!map || !ts) return;
    const old = map.tilesetId;
    this.commitCustom('Change layer tileset', () => (map.tilesetId = tsId), () => (map.tilesetId = old));
  }

  resizeLayerMap(layer: number, width: number, height: number): void {
    const map = layerTilemap(this.project, layer);
    if (!map) return;
    const old = { w: map.width, h: map.height, cells: map.cells };
    const cells = new Uint16Array(width * height);
    for (let y = 0; y < Math.min(height, old.h); y++)
      for (let x = 0; x < Math.min(width, old.w); x++) cells[y * width + x] = old.cells[y * old.w + x];
    this.commitCustom(
      'Resize tilemap',
      () => Object.assign(map, { width, height, cells }),
      () => Object.assign(map, { width: old.w, height: old.h, cells: old.cells }),
    );
    this.fitView();
  }

  // ---- sprite frames -------------------------------------------------------------------------

  addFrame(duplicate: boolean): void {
    const s = this.spriteAsset;
    if (!s) return;
    const at = this.frameIndex + 1;
    const src = s.frames[this.frameIndex];
    const f: SpriteFrame = duplicate && src
      ? {
          image: { ...src.image, pixels: new Uint8Array(src.image.pixels) },
          duration: src.duration,
          hitboxes: src.hitboxes.map((b) => ({ ...b })),
          hurtboxes: src.hurtboxes.map((b) => ({ ...b })),
        }
      : createFrame(s.width, s.height, src?.duration ?? 8);
    this.commitCustom(duplicate ? 'Duplicate frame' : 'Add frame', () => s.frames.splice(at, 0, f), () => s.frames.splice(s.frames.indexOf(f), 1));
    this.setFrame(at);
  }

  deleteFrame(): void {
    const s = this.spriteAsset;
    if (!s || s.frames.length < 2) return;
    const i = this.frameIndex;
    const f = s.frames[i];
    this.commitCustom('Delete frame', () => s.frames.splice(s.frames.indexOf(f), 1), () => s.frames.splice(i, 0, f));
  }

  moveFrame(dir: -1 | 1): void {
    const s = this.spriteAsset;
    if (!s) return;
    const i = this.frameIndex, j = i + dir;
    if (j < 0 || j >= s.frames.length) return;
    const swap = () => ([s.frames[i], s.frames[j]] = [s.frames[j], s.frames[i]]);
    this.commitCustom('Move frame', swap, swap);
    this.setFrame(j);
  }

  setFrameDuration(i: number, ticks: number): void {
    const f = this.spriteAsset?.frames[i];
    if (!f) return;
    f.duration = Math.max(1, Math.min(999, Math.round(ticks)));
    this.emit();
  }

  deleteBox(kind: 'hit' | 'hurt', index: number): void {
    const f = this.spriteFrame;
    if (!f) return;
    const list = kind === 'hit' ? f.hitboxes : f.hurtboxes;
    const b = list[index];
    if (!b) return;
    this.commitCustom(`Delete ${kind}box`, () => list.splice(list.indexOf(b), 1), () => list.splice(index, 0, b));
  }

  setOrigin(x: number, y: number): void {
    const s = this.spriteAsset;
    if (!s) return;
    s.originX = x;
    s.originY = y;
    this.markStructure();
    this.emit();
  }

  // ---- documents -----------------------------------------------------------------------------

  load(p: Project, target?: Target): void {
    if (this.session) this.cancelStroke();
    this.project = p;
    this.history.clear();
    this.camera = { x: 0, y: 0 };
    this.tick = 0;
    this.activeLayer = 0;
    this.selectedObjectId = null;
    this.objectSpriteId = p.sprites[0]?.id ?? null;
    this.target = target ?? { kind: 'scene' };
    this.image = createImage(1, 1, 4); // force resolveImage to treat the target as new
    this.resolveImage();
    this.markStructure();
    this.markPalette();
    this.imageVersion++;
    this.fitView();
    this.emit();
  }

  newProject(): void {
    this.load(createDefaultProject());
  }
}
