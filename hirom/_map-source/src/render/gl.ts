/**
 * WebGL2 context for HiROM Map. Same settings as HiROM Pixel's, except `desynchronized`: a
 * low-latency (overlay-plane) canvas doesn't composite correctly under HiROM Map's 2D overlay
 * canvas in Chrome, so Map uses normal compositing.
 */
export function createMapContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null;
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  return gl;
}
