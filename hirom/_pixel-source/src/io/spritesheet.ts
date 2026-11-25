import { toRgb8 } from '../core/color';
import { Project, SpriteAsset } from '../core/project';
import { RgbaImage, fileSafe } from './tiled';

/** Horizontal strip of all frames plus engine-friendly metadata (durations, boxes, anchor). */
export function buildSpritesheet(p: Project, s: SpriteAsset): { image: RgbaImage; indices: Uint8Array; meta: unknown } {
  const n = s.frames.length;
  const W = s.width * n, H = s.height;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const indices = new Uint8Array(W * H);
  const base = s.paletteId * 16;
  s.frames.forEach((f, k) => {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < s.width; x++) {
        const v = f.image.pixels[y * f.image.width + x];
        const i = y * W + k * s.width + x;
        indices[i] = v;
        if (!v) continue;
        const [r, g, b] = toRgb8(p.cgram[base + v]);
        rgba.set([r, g, b, 255], i * 4);
      }
  });
  const meta = {
    name: s.name,
    image: `${fileSafe(s.name)}.png`,
    frameWidth: s.width,
    frameHeight: s.height,
    origin: { x: s.originX, y: s.originY },
    snesPalette: s.paletteId,
    frames: s.frames.map((f, k) => ({
      x: k * s.width,
      y: 0,
      w: s.width,
      h: s.height,
      durationTicks: f.duration,
      durationMs: Math.round((f.duration * 1000) / 60),
      hitboxes: f.hitboxes,
      hurtboxes: f.hurtboxes,
    })),
  };
  return { image: { name: `${fileSafe(s.name)}.png`, width: W, height: H, rgba }, indices, meta };
}
