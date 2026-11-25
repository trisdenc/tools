import { toRgb8 } from '../core/color';
import { IndexedImage } from '../core/image';
import { GLSL_COMMON, createProgram, createTexture, uploadR8 } from './gl';

/**
 * Indexed-color renderer for a single image (canvas, tileset sheet or sprite frame). Artwork is an
 * R8UI texture of *local* indices; the shader resolves each through a 256×1 CGRAM texture offset by
 * the active sub-palette base, so palette edits and swaps never touch pixel data.
 */
export interface RenderParams {
  /** Device-pixel position of the image's top-left corner. */
  originX: number;
  originY: number;
  /** Device pixels per image pixel. */
  scaleX: number;
  scaleY: number;
  /** CGRAM slot that local index 0 maps to. */
  base: number;
  pixelGrid: boolean;
  tileGrid: number;
  showBackdrop: boolean;
  /** Brush outline in image pixels: [x, y, w, h], or null. */
  cursor: [number, number, number, number] | null;
  mirrorH: boolean;
  mirrorV: boolean;
  /** Draw dimmed repeats of the image around it (tile-wrap mode). */
  wrap: boolean;
  /** Onion skin: previous / next animation frames (same size as the image), tinted where the current frame is empty. */
  onionPrev: IndexedImage | null;
  onionNext: IndexedImage | null;
}

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uIndex;
uniform usampler2D uPrev;
uniform usampler2D uNext;
uniform sampler2D uPalette;
uniform vec2 uOrigin;
uniform vec2 uScale;
uniform ivec2 uSize;
uniform int uBase;
uniform float uCanvasH;
uniform int uPixelGrid;
uniform int uTileGrid;
uniform int uBackdrop;
uniform vec4 uCursor;
uniform ivec2 uMirror;
uniform int uWrap;
uniform int uOnion;
out vec4 outColor;
${GLSL_COMMON}
vec3 pal(uint idx) { return texelFetch(uPalette, ivec2(uBase + int(idx), 0), 0).rgb; }

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uCanvasH - gl_FragCoord.y);
  vec2 p = (frag - uOrigin) / uScale;
  vec2 size = vec2(uSize);
  bool inside = all(greaterThanEqual(p, vec2(0.0))) && all(lessThan(p, size));
  if (!inside && uWrap == 0) { outColor = vec4(WORKSPACE, 1.0); return; }

  vec2 q = inside ? p : mod(p, size);
  ivec2 ip = clamp(ivec2(floor(q)), ivec2(0), uSize - 1);
  uint idx = texelFetch(uIndex, ip, 0).r;
  vec3 col;
  if (idx == 0u) {
    col = uBackdrop == 1 ? texelFetch(uPalette, ivec2(0, 0), 0).rgb : checker(frag);
    if ((uOnion & 1) != 0) {
      uint pi = texelFetch(uPrev, ip, 0).r;
      if (pi != 0u) col = mix(col, pal(pi) * vec3(1.0, 0.45, 0.45), 0.38);
    }
    if ((uOnion & 2) != 0) {
      uint ni = texelFetch(uNext, ip, 0).r;
      if (ni != 0u) col = mix(col, pal(ni) * vec3(0.45, 0.75, 1.0), 0.38);
    }
  } else col = pal(idx);

  vec2 f = fract(q);
  if (uPixelGrid == 1 && min(uScale.x, uScale.y) >= 6.0) {
    vec2 e = f * uScale;
    if (e.x < 1.0 || e.y < 1.0) col = mix(col, vec3(0.5), 0.3);
  }
  if (uTileGrid > 0 && min(uScale.x, uScale.y) * float(uTileGrid) >= 12.0) {
    vec2 e = mod(q, float(uTileGrid)) * uScale;
    if (e.x < 1.0 || e.y < 1.0) col = mix(col, vec3(0.35, 0.70, 1.0), 0.55);
  }
  if (!inside) { outColor = vec4(mix(col, WORKSPACE, 0.55), 1.0); return; }

  if (uMirror.x == 1 && abs(p.x - size.x * 0.5) * uScale.x < 1.0) col = vec3(1.0, 0.3, 0.8);
  if (uMirror.y == 1 && abs(p.y - size.y * 0.5) * uScale.y < 1.0) col = vec3(1.0, 0.3, 0.8);
  if (onRect(p, uCursor, uScale)) col = contrastOn(col);
  outColor = vec4(col, 1.0);
}`;

const UNIFORMS = [
  'uIndex', 'uPrev', 'uNext', 'uPalette', 'uOrigin', 'uScale', 'uSize', 'uBase', 'uCanvasH', 'uPixelGrid',
  'uTileGrid', 'uBackdrop', 'uCursor', 'uMirror', 'uWrap', 'uOnion',
] as const;

export class Renderer {
  private prog: WebGLProgram;
  private u: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  private vao: WebGLVertexArrayObject;
  private indexTex: WebGLTexture;
  private prevTex: WebGLTexture;
  private nextTex: WebGLTexture;
  private paletteTex: WebGLTexture;
  private size: [number, number] = [0, 0];
  private paletteBuf = new Uint8Array(256 * 4);

  constructor(private gl: WebGL2RenderingContext) {
    ({ prog: this.prog, u: this.u } = createProgram(gl, FRAG, UNIFORMS));
    this.vao = gl.createVertexArray()!;
    this.indexTex = createTexture(gl);
    this.prevTex = createTexture(gl);
    this.nextTex = createTexture(gl);
    uploadR8(gl, this.prevTex, 1, 1, new Uint8Array(1));
    uploadR8(gl, this.nextTex, 1, 1, new Uint8Array(1));
    this.paletteTex = createTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.paletteBuf);
  }

  uploadPixels(img: IndexedImage): void {
    uploadR8(this.gl, this.indexTex, img.width, img.height, img.pixels);
    this.size = [img.width, img.height];
  }

  uploadPalette(cgram: Uint16Array): void {
    const buf = this.paletteBuf;
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = toRgb8(cgram[i]);
      buf[i * 4] = r;
      buf[i * 4 + 1] = g;
      buf[i * 4 + 2] = b;
      buf[i * 4 + 3] = 255;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  }

  render(p: RenderParams, canvasW: number, canvasH: number): void {
    const gl = this.gl;
    const { u } = this;
    let onion = 0;
    const sameSize = (im: IndexedImage | null) => im && im.width === this.size[0] && im.height === this.size[1];
    if (sameSize(p.onionPrev)) {
      uploadR8(gl, this.prevTex, p.onionPrev!.width, p.onionPrev!.height, p.onionPrev!.pixels);
      onion |= 1;
    }
    if (sameSize(p.onionNext)) {
      uploadR8(gl, this.nextTex, p.onionNext!.width, p.onionNext!.height, p.onionNext!.pixels);
      onion |= 2;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    const bind = (unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, unit);
    };
    bind(0, this.indexTex, u.uIndex);
    bind(1, this.paletteTex, u.uPalette);
    bind(2, this.prevTex, u.uPrev);
    bind(3, this.nextTex, u.uNext);
    gl.uniform2f(u.uOrigin, p.originX, p.originY);
    gl.uniform2f(u.uScale, p.scaleX, p.scaleY);
    gl.uniform2i(u.uSize, this.size[0], this.size[1]);
    gl.uniform1i(u.uBase, p.base);
    gl.uniform1f(u.uCanvasH, canvasH);
    gl.uniform1i(u.uPixelGrid, p.pixelGrid ? 1 : 0);
    gl.uniform1i(u.uTileGrid, p.tileGrid);
    gl.uniform1i(u.uBackdrop, p.showBackdrop ? 1 : 0);
    const c = p.cursor ?? [0, 0, 0, 0];
    gl.uniform4f(u.uCursor, c[0], c[1], c[2], c[3]);
    gl.uniform2i(u.uMirror, p.mirrorH ? 1 : 0, p.mirrorV ? 1 : 0);
    gl.uniform1i(u.uWrap, p.wrap ? 1 : 0);
    gl.uniform1i(u.uOnion, onion);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
