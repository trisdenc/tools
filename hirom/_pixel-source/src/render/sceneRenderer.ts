import { IndexedImage } from '../core/image';
import { GLSL_COMMON, createProgram, createTexture, uploadR16, uploadR8 } from './gl';

/**
 * Mode 1 scene compositor. Everything SNES-specific happens per pixel in the fragment shader:
 * tilemap words (vhopppcc cccccccc) are decoded, tiles fetched with flips, the Mode 1 priority
 * order resolved separately for the main and sub screens, and color math applied on 5-bit
 * integer channels from raw BGR555 CGRAM — so results match hardware bit for bit.
 */
export interface SceneLayerInput {
  tiles: IndexedImage;
  tilesVersion: number;
  cells: Uint16Array;
  mapW: number;
  mapH: number;
  cellsVersion: number;
  bpp: number;
  scrollX: number;
  scrollY: number;
}

export interface SceneOverlays {
  active: number;
  grid: boolean;
  priority: boolean;
  /** Rectangles in region pixels: x, y, w, h (w = 0 for none). */
  screen: [number, number, number, number];
  cursor: [number, number, number, number];
  selection: [number, number, number, number];
  pick: [number, number, number, number];
}

export interface SceneParams {
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
  regionW: number;
  regionH: number;
  layers: (SceneLayerInput | null)[];
  /** Layer bits: BG1 = 1, BG2 = 2, BG3 = 4, OBJ = 16, backdrop = 32. */
  mainMask: number;
  subMask: number;
  mathMask: number;
  bg3Priority: boolean;
  subtract: boolean;
  half: boolean;
  useFixed: boolean;
  fixedColor: number;
  overlays: SceneOverlays | null;
}

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uTiles0;
uniform usampler2D uTiles1;
uniform usampler2D uTiles2;
uniform usampler2D uMap0;
uniform usampler2D uMap1;
uniform usampler2D uMap2;
uniform usampler2D uObj;
uniform usampler2D uCgram;
uniform ivec2 uMapSize[3];
uniform int uBpp[3];
uniform ivec2 uScroll[3];
uniform int uHasLayer;
uniform int uMainMask;
uniform int uSubMask;
uniform int uMathMask;
uniform int uBg3Prio;
uniform int uSubtract;
uniform int uHalf;
uniform int uUseFixed;
uniform int uFixed;
uniform vec2 uOrigin;
uniform vec2 uScale;
uniform ivec2 uRegion;
uniform float uCanvasH;
uniform int uOverlays;
uniform int uActive;
uniform int uGrid;
uniform int uPrioOverlay;
uniform vec4 uScreenRect;
uniform vec4 uCursor;
uniform vec4 uSel;
uniform vec4 uPick;
out vec4 outColor;
${GLSL_COMMON}

ivec2 imod(ivec2 a, ivec2 b) { return a - b * ivec2(floor(vec2(a) / vec2(b))); }

uint mapWord(usampler2D map, ivec2 mapSize, ivec2 pos) {
  ivec2 mp = imod(pos, mapSize * 8);
  return texelFetch(map, mp >> 3, 0).r;
}

// Returns (CGRAM index or -1 if transparent, priority bit).
ivec2 sampleBg(usampler2D tiles, usampler2D map, ivec2 mapSize, int bpp, ivec2 pos) {
  ivec2 mp = imod(pos, mapSize * 8);
  uint w = texelFetch(map, mp >> 3, 0).r;
  ivec2 t = mp & 7;
  if ((w & 0x4000u) != 0u) t.x = 7 - t.x;
  if ((w & 0x8000u) != 0u) t.y = 7 - t.y;
  int tile = int(w & 1023u);
  int prio = int((w >> 13) & 1u);
  ivec2 sp = ivec2((tile & 15) * 8 + t.x, (tile >> 4) * 8 + t.y);
  if (sp.y >= textureSize(tiles, 0).y) return ivec2(-1, prio);
  int local = int(texelFetch(tiles, sp, 0).r);
  if (local == 0) return ivec2(-1, prio);
  int pal = int((w >> 10) & 7u);
  int base = bpp == 2 ? pal * 4 : (bpp == 4 ? pal * 16 : 0);
  return ivec2(base + local, prio);
}

// Mode 1 priority, front to back. Returns (CGRAM index, layer id); layer ids: 0 BG1, 1 BG2, 2 BG3, 4 OBJ, 5 backdrop.
ivec2 composite(int mask, ivec2 b1, ivec2 b2, ivec2 b3, ivec3 ob) {
  bool e1 = (mask & 1) != 0 && b1.x >= 0;
  bool e2 = (mask & 2) != 0 && b2.x >= 0;
  bool e3 = (mask & 4) != 0 && b3.x >= 0;
  bool eo = (mask & 16) != 0 && ob.x >= 0;
  if (uBg3Prio == 1 && e3 && b3.y == 1) return ivec2(b3.x, 2);
  if (eo && ob.y == 3) return ivec2(ob.x, 4);
  if (e1 && b1.y == 1) return ivec2(b1.x, 0);
  if (e2 && b2.y == 1) return ivec2(b2.x, 1);
  if (eo && ob.y == 2) return ivec2(ob.x, 4);
  if (e1) return ivec2(b1.x, 0);
  if (e2) return ivec2(b2.x, 1);
  if (eo && ob.y == 1) return ivec2(ob.x, 4);
  if (e3 && b3.y == 1) return ivec2(b3.x, 2);
  if (eo) return ivec2(ob.x, 4);
  if (e3) return ivec2(b3.x, 2);
  return ivec2(0, 5);
}

ivec3 bgr(int c) { return ivec3(c & 31, (c >> 5) & 31, (c >> 10) & 31); }
ivec3 cg(int i) { return bgr(int(texelFetch(uCgram, ivec2(i, 0), 0).r)); }

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uCanvasH - gl_FragCoord.y);
  vec2 p = (frag - uOrigin) / uScale;
  if (any(lessThan(p, vec2(0.0))) || any(greaterThanEqual(p, vec2(uRegion)))) {
    outColor = vec4(WORKSPACE, 1.0);
    return;
  }
  ivec2 sp = ivec2(floor(p));
  ivec2 none = ivec2(-1, 0);
  ivec2 b1 = (uHasLayer & 1) != 0 ? sampleBg(uTiles0, uMap0, uMapSize[0], uBpp[0], sp + uScroll[0]) : none;
  ivec2 b2 = (uHasLayer & 2) != 0 ? sampleBg(uTiles1, uMap1, uMapSize[1], uBpp[1], sp + uScroll[1]) : none;
  ivec2 b3 = (uHasLayer & 4) != 0 ? sampleBg(uTiles2, uMap2, uMapSize[2], uBpp[2], sp + uScroll[2]) : none;
  uint ow = texelFetch(uObj, sp, 0).r;
  ivec3 ob = (ow & 0x800u) != 0u ? ivec3(int(ow & 255u), int((ow >> 8) & 3u), int((ow >> 10) & 1u)) : ivec3(-1, 0, 0);

  ivec2 m = composite(uMainMask, b1, b2, b3, ob);
  ivec3 c = cg(m.x);
  bool doMath = (uMathMask & (1 << m.y)) != 0 && (m.y != 4 || ob.z == 1);
  if (doMath) {
    ivec2 s = composite(uSubMask, b1, b2, b3, ob);
    bool subBackdrop = s.y == 5;
    ivec3 sc = (uUseFixed == 1 || subBackdrop) ? bgr(uFixed) : cg(s.x);
    ivec3 r = uSubtract == 1 ? max(c - sc, ivec3(0)) : c + sc;
    // Halving is skipped when blending against a transparent sub screen.
    if (uHalf == 1 && !(uUseFixed == 0 && subBackdrop)) r >>= 1;
    c = min(r, ivec3(31));
  }
  vec3 col = vec3((c << 3) | (c >> 2)) / 255.0;

  if (uOverlays == 1) {
    if (uActive >= 0) {
      ivec2 sc = uActive == 0 ? uScroll[0] : (uActive == 1 ? uScroll[1] : uScroll[2]);
      vec2 lp = p + vec2(sc);
      if (uPrioOverlay == 1) {
        uint w = uActive == 0 ? mapWord(uMap0, uMapSize[0], sp + sc)
               : (uActive == 1 ? mapWord(uMap1, uMapSize[1], sp + sc) : mapWord(uMap2, uMapSize[2], sp + sc));
        if ((w & 0x2000u) != 0u) col = mix(col, vec3(0.2, 0.45, 1.0), 0.38);
      }
      if (uGrid == 1 && min(uScale.x, uScale.y) >= 3.0) {
        vec2 e = mod(lp, 8.0) * uScale;
        if (e.x < 1.0 || e.y < 1.0) col = mix(col, vec3(0.35, 0.70, 1.0), 0.35);
      }
    }
    if (onRect(p, uScreenRect, uScale)) {
      float dash = mod(floor((frag.x + frag.y) / 6.0), 2.0);
      col = dash == 0.0 ? vec3(1.0, 0.85, 0.2) : vec3(0.1);
    }
    if (onRect(p, uPick, uScale)) col = vec3(1.0, 0.3, 0.8);
    if (onRect(p, uSel, uScale)) col = vec3(0.3, 0.9, 1.0);
    if (onRect(p, uCursor, uScale)) col = contrastOn(col);
  }
  outColor = vec4(col, 1.0);
}`;

const UNIFORMS = [
  'uTiles0', 'uTiles1', 'uTiles2', 'uMap0', 'uMap1', 'uMap2', 'uObj', 'uCgram', 'uMapSize', 'uBpp', 'uScroll',
  'uHasLayer', 'uMainMask', 'uSubMask', 'uMathMask', 'uBg3Prio', 'uSubtract', 'uHalf', 'uUseFixed', 'uFixed',
  'uOrigin', 'uScale', 'uRegion', 'uCanvasH', 'uOverlays', 'uActive', 'uGrid', 'uPrioOverlay', 'uScreenRect',
  'uCursor', 'uSel', 'uPick',
] as const;

interface Slot {
  key: unknown;
  version: number;
}

export class SceneRenderer {
  private prog: WebGLProgram;
  private u: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  private vao: WebGLVertexArrayObject;
  private tiles: WebGLTexture[];
  private maps: WebGLTexture[];
  private obj: WebGLTexture;
  private cgram: WebGLTexture;
  private tileSlots: Slot[] = [0, 1, 2].map(() => ({ key: null, version: -1 }));
  private mapSlots: Slot[] = [0, 1, 2].map(() => ({ key: null, version: -1 }));

  constructor(private gl: WebGL2RenderingContext) {
    ({ prog: this.prog, u: this.u } = createProgram(gl, FRAG, UNIFORMS));
    this.vao = gl.createVertexArray()!;
    this.tiles = [0, 1, 2].map(() => createTexture(gl));
    this.maps = [0, 1, 2].map(() => createTexture(gl));
    this.obj = createTexture(gl);
    this.cgram = createTexture(gl);
    for (let i = 0; i < 3; i++) {
      uploadR8(gl, this.tiles[i], 1, 1, new Uint8Array(1));
      uploadR16(gl, this.maps[i], 1, 1, new Uint16Array(1));
    }
    uploadR16(gl, this.obj, 1, 1, new Uint16Array(1));
    uploadR16(gl, this.cgram, 256, 1, new Uint16Array(256));
  }

  uploadCgram(cgram: Uint16Array): void {
    uploadR16(this.gl, this.cgram, 256, 1, cgram);
  }

  uploadObj(buf: Uint16Array, w: number, h: number): void {
    uploadR16(this.gl, this.obj, w, h, buf);
  }

  /** Upload layer textures that changed since the last call. */
  private syncLayers(layers: (SceneLayerInput | null)[]): void {
    layers.forEach((l, i) => {
      if (!l) return;
      const ts = this.tileSlots[i];
      if (ts.key !== l.tiles || ts.version !== l.tilesVersion) {
        uploadR8(this.gl, this.tiles[i], l.tiles.width, l.tiles.height, l.tiles.pixels);
        ts.key = l.tiles;
        ts.version = l.tilesVersion;
      }
      const ms = this.mapSlots[i];
      if (ms.key !== l.cells || ms.version !== l.cellsVersion) {
        uploadR16(this.gl, this.maps[i], l.mapW, l.mapH, l.cells);
        ms.key = l.cells;
        ms.version = l.cellsVersion;
      }
    });
  }

  render(p: SceneParams, targetW: number, targetH: number, fbo: WebGLFramebuffer | null = null): void {
    const gl = this.gl;
    const { u } = this;
    this.syncLayers(p.layers);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, targetW, targetH);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    const bind = (unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, unit);
    };
    bind(0, this.tiles[0], u.uTiles0);
    bind(1, this.tiles[1], u.uTiles1);
    bind(2, this.tiles[2], u.uTiles2);
    bind(3, this.maps[0], u.uMap0);
    bind(4, this.maps[1], u.uMap1);
    bind(5, this.maps[2], u.uMap2);
    bind(6, this.obj, u.uObj);
    bind(7, this.cgram, u.uCgram);

    let has = 0;
    const sizes = new Int32Array(6), bpps = new Int32Array(3), scrolls = new Int32Array(6);
    p.layers.forEach((l, i) => {
      if (!l) {
        sizes[i * 2] = sizes[i * 2 + 1] = 1;
        return;
      }
      has |= 1 << i;
      sizes[i * 2] = l.mapW;
      sizes[i * 2 + 1] = l.mapH;
      bpps[i] = l.bpp;
      scrolls[i * 2] = l.scrollX;
      scrolls[i * 2 + 1] = l.scrollY;
    });
    gl.uniform2iv(u.uMapSize, sizes);
    gl.uniform1iv(u.uBpp, bpps);
    gl.uniform2iv(u.uScroll, scrolls);
    gl.uniform1i(u.uHasLayer, has);
    gl.uniform1i(u.uMainMask, p.mainMask);
    gl.uniform1i(u.uSubMask, p.subMask);
    gl.uniform1i(u.uMathMask, p.mathMask);
    gl.uniform1i(u.uBg3Prio, p.bg3Priority ? 1 : 0);
    gl.uniform1i(u.uSubtract, p.subtract ? 1 : 0);
    gl.uniform1i(u.uHalf, p.half ? 1 : 0);
    gl.uniform1i(u.uUseFixed, p.useFixed ? 1 : 0);
    gl.uniform1i(u.uFixed, p.fixedColor);
    gl.uniform2f(u.uOrigin, p.originX, p.originY);
    gl.uniform2f(u.uScale, p.scaleX, p.scaleY);
    gl.uniform2i(u.uRegion, p.regionW, p.regionH);
    gl.uniform1f(u.uCanvasH, targetH);
    const o = p.overlays;
    gl.uniform1i(u.uOverlays, o ? 1 : 0);
    if (o) {
      gl.uniform1i(u.uActive, o.active);
      gl.uniform1i(u.uGrid, o.grid ? 1 : 0);
      gl.uniform1i(u.uPrioOverlay, o.priority ? 1 : 0);
      gl.uniform4f(u.uScreenRect, ...o.screen);
      gl.uniform4f(u.uCursor, ...o.cursor);
      gl.uniform4f(u.uSel, ...o.selection);
      gl.uniform4f(u.uPick, ...o.pick);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Render at 1:1 into an offscreen framebuffer and read back RGBA rows top-down. */
  capture(p: SceneParams): Uint8ClampedArray {
    const gl = this.gl;
    const w = p.regionW, h = p.regionH;
    const tex = createTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this.render({ ...p, originX: 0, originY: 0, scaleX: 1, scaleY: 1, overlays: null }, w, h, fbo);
    const raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    // gl_FragCoord.y counts from the bottom, and uCanvasH flips it, so row 0 of `raw` is the
    // bottom of the image: flip back to top-down.
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return out;
  }
}
