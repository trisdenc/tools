import type { Project as PixelProject } from '@pixel/core/project';
import { cycledCgram } from '@pixel/core/project';
import type { SceneObject } from '@pixel/core/project';
import { buildObjBuffer } from '@pixel/core/scene';
import type { SceneLayerInput, SceneParams, SceneRenderer } from '@pixel/render/sceneRenderer';
import type { EntityTemplate, Level } from '../core/level';
import { SCREEN_H, SCREEN_W, levelPixels, levelTiles, refId, resolveEntity } from '../core/level';

/**
 * Builds frames for HiROM Pixel's Mode 1 scene shader. The editor view is drawn in chunks of at
 * most CHUNK×CHUNK world pixels (each with its own OBJ buffer and scissor), so huge levels never
 * need a giant sprite buffer. The playtest screen splits into scanline strips wherever an HDMA band
 * changes a layer's horizontal scroll, and draws each strip with that band's scroll.
 */
const CHUNK = 1024;
const NONE: [number, number, number, number] = [0, 0, 0, 0];
const WORKSPACE = [0.09, 0.094, 0.11];

export interface FrameInput {
  level: Level;
  project: PixelProject;
  templates: EntityTemplate[];
  tick: number;
  animate: boolean;
  pixelVersion: number;
  cellsVersion: number;
}

export function layerInputs(f: FrameInput, scroll: (i: number) => [number, number]): (SceneLayerInput | null)[] {
  const { w, h } = levelTiles(f.level);
  return f.level.layers.map((l, i) => {
    const ts = f.project.tilesets.find((t) => t.id === refId(l.tilesetRef));
    if (!ts || !l.visible) return null;
    const [sx, sy] = scroll(i);
    return { tiles: ts.sheet, tilesVersion: f.pixelVersion, cells: l.cells, mapW: w, mapH: h, cellsVersion: f.cellsVersion, bpp: ts.bpp, scrollX: sx, scrollY: sy };
  });
}

export function screenMasks(level: Level): { mainMask: number; subMask: number; mathMask: number } {
  let mainMask = 0, subMask = 0, mathMask = 16;
  level.layers.forEach((l, i) => {
    if (!l.visible) return;
    if (l.main) mainMask |= 1 << i;
    if (l.sub) subMask |= 1 << i;
    if (l.math) mathMask |= 1 << i;
  });
  if (level.obj.main) mainMask |= 16;
  if (level.obj.sub) subMask |= 16;
  if (level.colorMath.backdropMath) mathMask |= 32;
  return { mainMask, subMask, mathMask };
}

/** Level entities as OBJ scene objects (entities without a sprite are drawn as boxes elsewhere). */
export function entityObjects(level: Level, templates: EntityTemplate[], project: PixelProject, skip?: (type: string) => boolean): SceneObject[] {
  const out: SceneObject[] = [];
  for (const e of level.entities) {
    const r = resolveEntity(e, templates);
    if (skip?.(r.type)) continue;
    const id = refId(r.spriteRef);
    if (!id || !project.sprites.some((s) => s.id === id)) continue;
    out.push({ id: e.id, spriteId: id, x: e.x, y: e.y, priority: e.priority, hFlip: e.hFlip, colorMath: false });
  }
  return out;
}

export function objBuffer(f: FrameInput, objects: SceneObject[], region: { x: number; y: number; w: number; h: number }, out?: Uint16Array): Uint16Array {
  const p = { ...f.project, strict: f.level.meta.strictHardwareLimits, scene: { ...f.project.scene, objects } } as PixelProject;
  return buildObjBuffer(p, region, f.tick, f.animate, out);
}

function baseParams(f: FrameInput): Omit<SceneParams, 'originX' | 'originY' | 'scaleX' | 'scaleY' | 'regionW' | 'regionH' | 'layers' | 'overlays'> {
  const c = f.level.colorMath;
  return {
    ...screenMasks(f.level),
    bg3Priority: f.level.bg3Priority,
    subtract: c.mode === 'sub',
    half: c.half,
    useFixed: c.source === 'fixed',
    fixedColor: c.fixedColor,
  };
}

let chunkBuf = new Uint16Array(0);

/** Draw the editor view: the level at (panX, panY) and `zoom`, in device pixels. */
export function renderEditor(
  r: SceneRenderer,
  gl: WebGL2RenderingContext,
  f: FrameInput,
  view: { zoom: number; panX: number; panY: number },
  canvasW: number,
  canvasH: number,
  opts: { activeLayer: number; grid: boolean; priority: boolean; entities: boolean },
): void {
  r.uploadCgram(f.animate ? cycledCgram(f.project.cgram, f.project.cycles, f.tick) : f.project.cgram);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvasW, canvasH);
  gl.clearColor(WORKSPACE[0], WORKSPACE[1], WORKSPACE[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const { w: mapW, h: mapH } = levelPixels(f.level);
  const z = view.zoom;
  const x0 = Math.max(0, Math.floor(-view.panX / z)), y0 = Math.max(0, Math.floor(-view.panY / z));
  const x1 = Math.min(mapW, Math.ceil((canvasW - view.panX) / z)), y1 = Math.min(mapH, Math.ceil((canvasH - view.panY) / z));
  if (x1 <= x0 || y1 <= y0) return;
  const objects = opts.entities ? entityObjects(f.level, f.templates, f.project) : [];
  const base = baseParams(f);
  gl.enable(gl.SCISSOR_TEST);
  for (let cy = y0; cy < y1; cy += CHUNK) {
    for (let cx = x0; cx < x1; cx += CHUNK) {
      const region = { x: cx, y: cy, w: Math.min(CHUNK, x1 - cx), h: Math.min(CHUNK, y1 - cy) };
      if (chunkBuf.length < region.w * region.h) chunkBuf = new Uint16Array(region.w * region.h);
      const buf = chunkBuf.subarray(0, region.w * region.h);
      if (objects.length) objBuffer(f, objects, region, buf);
      else buf.fill(0);
      r.uploadObj(buf, region.w, region.h);
      const sx = view.panX + region.x * z, sy = view.panY + region.y * z;
      const sw = region.w * z, sh = region.h * z;
      const left = Math.max(0, Math.floor(sx)), top = Math.max(0, Math.floor(sy));
      const right = Math.min(canvasW, Math.ceil(sx + sw)), bottom = Math.min(canvasH, Math.ceil(sy + sh));
      if (right <= left || bottom <= top) continue;
      gl.scissor(left, canvasH - bottom, right - left, bottom - top);
      r.render(
        {
          ...base,
          originX: sx,
          originY: sy,
          scaleX: z,
          scaleY: z,
          regionW: region.w,
          regionH: region.h,
          layers: layerInputs(f, () => [region.x, region.y]),
          overlays: { active: opts.activeLayer, grid: opts.grid, priority: opts.priority, screen: NONE, cursor: NONE, selection: NONE, pick: NONE },
        },
        canvasW,
        canvasH,
      );
    }
  }
  gl.disable(gl.SCISSOR_TEST);
}

/** Horizontal scroll of each layer on scanline y, after HDMA bands. */
export function lineScrollX(level: Level, camX: number, y: number): number[] {
  return level.layers.map((l) => {
    const band = l.hdmaBands.find((b) => y >= b.startY && y <= b.endY);
    return Math.round(camX * (band ? band.scrollX : l.parallax.x));
  });
}

/** Scanline ranges over which every layer's horizontal scroll is constant. */
export function hdmaStrips(level: Level): [number, number][] {
  const cuts = new Set<number>([0, SCREEN_H]);
  for (const l of level.layers)
    for (const b of l.hdmaBands) {
      cuts.add(Math.max(0, Math.min(SCREEN_H, b.startY)));
      cuts.add(Math.max(0, Math.min(SCREEN_H, b.endY + 1)));
    }
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < sorted.length; i++) if (sorted[i + 1] > sorted[i]) out.push([sorted[i], sorted[i + 1]]);
  return out;
}

let screenBuf = new Uint16Array(SCREEN_W * SCREEN_H);

/** Draw one 256×224 screen at camera (camX, camY), fitted into the canvas at an integer scale. */
export function renderScreen(
  r: SceneRenderer,
  gl: WebGL2RenderingContext,
  f: FrameInput,
  cam: { x: number; y: number },
  objects: SceneObject[],
  canvasW: number,
  canvasH: number,
  par: boolean,
): { scale: number; ox: number; oy: number; sx: number } {
  r.uploadCgram(cycledCgram(f.project.cgram, f.project.cycles, f.tick));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvasW, canvasH);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const aspect = par ? 8 / 7 : 1;
  const scale = Math.max(1, Math.floor(Math.min(canvasW / (SCREEN_W * aspect), canvasH / SCREEN_H)));
  const sx = scale * aspect;
  const ox = Math.round((canvasW - SCREEN_W * sx) / 2), oy = Math.round((canvasH - SCREEN_H * scale) / 2);
  const cx = Math.round(cam.x), cy = Math.round(cam.y);
  if (screenBuf.length < SCREEN_W * SCREEN_H) screenBuf = new Uint16Array(SCREEN_W * SCREEN_H);
  objBuffer({ ...f, animate: true }, objects, { x: cx, y: cy, w: SCREEN_W, h: SCREEN_H }, screenBuf);
  r.uploadObj(screenBuf, SCREEN_W, SCREEN_H);
  const base = baseParams(f);
  gl.enable(gl.SCISSOR_TEST);
  for (const [top, bottom] of hdmaStrips(f.level)) {
    const xs = lineScrollX(f.level, cam.x, top);
    const y0 = oy + top * scale, y1 = oy + bottom * scale;
    gl.scissor(ox, canvasH - y1, Math.round(SCREEN_W * sx), y1 - y0);
    r.render(
      {
        ...base,
        originX: ox,
        originY: oy,
        scaleX: sx,
        scaleY: scale,
        regionW: SCREEN_W,
        regionH: SCREEN_H,
        layers: layerInputs(f, (i) => [xs[i], Math.round(cam.y * f.level.layers[i].parallax.y)]),
        overlays: null,
      },
      canvasW,
      canvasH,
    );
  }
  gl.disable(gl.SCISSOR_TEST);
  return { scale, ox, oy, sx };
}

/** Render the whole level at 1:1 into RGBA (in strips, to stay within texture limits). */
export function captureLevel(r: SceneRenderer, f: FrameInput): { w: number; h: number; rgba: Uint8ClampedArray } {
  const { w, h } = levelPixels(f.level);
  const out = new Uint8ClampedArray(w * h * 4);
  const objects = entityObjects(f.level, f.templates, f.project);
  const base = baseParams(f);
  r.uploadCgram(f.project.cgram);
  for (let y = 0; y < h; y += CHUNK) {
    for (let x = 0; x < w; x += CHUNK) {
      const region = { x, y, w: Math.min(CHUNK, w - x), h: Math.min(CHUNK, h - y) };
      r.uploadObj(objBuffer(f, objects, region), region.w, region.h);
      const rgba = r.capture({
        ...base,
        originX: 0,
        originY: 0,
        scaleX: 1,
        scaleY: 1,
        regionW: region.w,
        regionH: region.h,
        layers: layerInputs(f, () => [region.x, region.y]),
        overlays: null,
      });
      for (let row = 0; row < region.h; row++) out.set(rgba.subarray(row * region.w * 4, (row + 1) * region.w * 4), ((y + row) * w + x) * 4);
    }
  }
  return { w, h, rgba: out };
}
