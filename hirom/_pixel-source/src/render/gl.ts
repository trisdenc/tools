/** Shared WebGL2 plumbing. */

export function createContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    desynchronized: true,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null;
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  return gl;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Shader compile failed: ' + log);
  }
  return s;
}

/** Fullscreen triangle generated from gl_VertexID; no vertex buffers needed. */
export const FULLSCREEN_VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export function createProgram<U extends string>(
  gl: WebGL2RenderingContext,
  frag: string,
  uniforms: readonly U[],
): { prog: WebGLProgram; u: Record<U, WebGLUniformLocation | null> } {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Shader link failed: ' + gl.getProgramInfoLog(prog));
  const u = Object.fromEntries(uniforms.map((n) => [n, gl.getUniformLocation(prog, n)])) as Record<U, WebGLUniformLocation | null>;
  return { prog, u };
}

export function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** Upload an 8-bit index buffer as an R8UI texture. */
export function uploadR8(gl: WebGL2RenderingContext, tex: WebGLTexture, w: number, h: number, data: Uint8Array): void {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, data);
}

/** Upload 16-bit words (tilemaps, OBJ buffer, raw CGRAM) as an R16UI texture. */
export function uploadR16(gl: WebGL2RenderingContext, tex: WebGLTexture, w: number, h: number, data: Uint16Array): void {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, w, h, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, data);
}

/** GLSL helpers shared by both shaders. */
export const GLSL_COMMON = `
const vec3 WORKSPACE = vec3(0.090, 0.094, 0.110);
vec3 checker(vec2 frag) {
  ivec2 c = ivec2(floor(frag / 8.0));
  return ((c.x + c.y) & 1) == 0 ? vec3(0.235) : vec3(0.310);
}
// True within ~1.5 device px inside the border of rect r (x, y, w, h in region px).
bool onRect(vec2 p, vec4 r, vec2 scale) {
  if (r.z <= 0.0) return false;
  vec2 a = (p - r.xy) * scale;
  vec2 b = (r.xy + r.zw - p) * scale;
  return all(greaterThanEqual(a, vec2(0.0))) && all(greaterThanEqual(b, vec2(0.0)))
      && min(min(a.x, a.y), min(b.x, b.y)) < 1.5;
}
vec3 contrastOn(vec3 col) {
  return dot(col, vec3(0.299, 0.587, 0.114)) > 0.5 ? vec3(0.0) : vec3(1.0);
}
`;
