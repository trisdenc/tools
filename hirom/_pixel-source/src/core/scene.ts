import { Bgr555, pack, unpack } from './color';
import { Project, SceneObject, SpriteAsset, Tilemap, Tileset, frameAt } from './project';

/** A world-space window onto the scene, in pixels. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * OBJ layer, rasterized on the CPU into one 16-bit word per screen pixel:
 * bits 0–7 CGRAM index, 8–9 priority, 10 color-math eligible, 11 opaque.
 */
export const OBJ_OPAQUE = 1 << 11;
export const OBJ_MATH = 1 << 10;

export function objectBounds(o: SceneObject, s: SpriteAsset): Region {
  return { x: o.x - s.originX, y: o.y - s.originY, w: s.width, h: s.height };
}

export function buildObjBuffer(
  p: Project,
  region: Region,
  tick: number,
  animate: boolean,
  out = new Uint16Array(region.w * region.h),
): Uint16Array {
  out.fill(0);
  const { objects } = p.scene;
  const sprites = new Map(p.sprites.map((s) => [s.id, s]));
  // Earlier objects have higher OAM priority (drawn in front), so paint back to front.
  for (let k = objects.length - 1; k >= 0; k--) {
    const o = objects[k];
    const s = sprites.get(o.spriteId);
    if (!s || !s.frames.length) continue;
    const frame = s.frames[animate ? frameAt(s, tick) : 0].image;
    const base = s.paletteId * 16;
    // OBJ palettes 0–3 (CGRAM 128–191) never take part in color math on hardware.
    const mathOk = o.colorMath && (!p.strict || s.paletteId >= 12);
    const word = OBJ_OPAQUE | (o.priority << 8) | (mathOk ? OBJ_MATH : 0);
    const b = objectBounds(o, s);
    for (let y = 0; y < s.height; y++) {
      const ry = b.y + y - region.y;
      if (ry < 0 || ry >= region.h) continue;
      for (let x = 0; x < s.width; x++) {
        const rx = b.x + x - region.x;
        if (rx < 0 || rx >= region.w) continue;
        const v = frame.pixels[y * frame.width + (o.hFlip ? s.width - 1 - x : x)];
        if (v) out[ry * region.w + rx] = word | (base + v);
      }
    }
  }
  return out;
}

/** Topmost object whose bounding box contains a world point. */
export function hitObject(p: Project, x: number, y: number): SceneObject | null {
  for (const o of p.scene.objects) {
    const s = p.sprites.find((sp) => sp.id === o.spriteId);
    if (!s) continue;
    const b = objectBounds(o, s);
    if (x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h) return o;
  }
  return null;
}

/** Visible-region size when editing: big enough for the largest layer map. */
export function sceneMapSize(p: Project): { w: number; h: number } {
  let w = p.scene.resolution.width, h = p.scene.resolution.height;
  for (const l of p.scene.layers) {
    const m = p.tilemaps.find((t) => t.id === l.tilemapId);
    if (m) {
      w = Math.max(w, m.width * 8);
      h = Math.max(h, m.height * 8);
    }
  }
  return { w, h };
}

export function layerTilemap(p: Project, i: number): Tilemap | undefined {
  return p.tilemaps.find((m) => m.id === p.scene.layers[i]?.tilemapId);
}

export function layerTileset(p: Project, i: number): Tileset | undefined {
  const m = layerTilemap(p, i);
  return m && p.tilesets.find((t) => t.id === m.tilesetId);
}

/**
 * SNES color math on 5-bit channels, mirrored exactly by the scene shader.
 * `halfAllowed` is false when blending against a transparent sub screen (the hardware skips /2).
 */
export function colorMath(main: Bgr555, sub: Bgr555, mode: 'add' | 'sub', half: boolean, halfAllowed = true): Bgr555 {
  const m = unpack(main), s = unpack(sub);
  const r = m.map((c, i) => {
    let v = mode === 'add' ? c + s[i] : Math.max(0, c - s[i]);
    if (half && halfAllowed) v >>= 1;
    return Math.min(31, v);
  });
  return pack(r[0], r[1], r[2]);
}
