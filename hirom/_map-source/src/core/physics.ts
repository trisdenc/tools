import type { Level, Material } from './level';
import { SHAPE, materialOf, shapeOf } from './level';

/**
 * Playtest character controller on the collision grid, stepped at 60 Hz. Platformer mode
 * understands every collision shape (solid, one-way, ladder, water, hazard, 45° slopes) and the
 * built-in materials (ice, mud, conveyors); top-down mode treats solid and water as walls.
 */
export interface Body {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  onGround: boolean;
  climbing: boolean;
  inWater: boolean;
  facing: 1 | -1;
  dead: number;
}

export interface Input {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  jumpPressed: boolean;
  run: boolean;
}

export interface World {
  cell: number;
  cols: number;
  rows: number;
  at(cx: number, cy: number): number;
  materialName(id: number): string;
}

export function worldOf(level: Level, materials: Material[]): World {
  const cols = level.meta.widthMetatiles, rows = level.meta.heightMetatiles;
  const names = new Map(materials.map((m) => [m.id, m.name.toLowerCase()]));
  return {
    cell: level.meta.metatileSize,
    cols,
    rows,
    at: (cx, cy) => (cx < 0 || cy < 0 || cx >= cols || cy >= rows ? (cy >= rows ? 0 : SHAPE.SOLID) : level.collision[cy * cols + cx]),
    materialName: (id) => names.get(id) ?? '',
  };
}

export function createBody(x: number, y: number, w = 12, h = 22): Body {
  return { x, y, w, h, vx: 0, vy: 0, onGround: false, climbing: false, inWater: false, facing: 1, dead: 0 };
}

const isSolid = (c: number) => shapeOf(c) === SHAPE.SOLID;
const isSlope = (c: number) => shapeOf(c) === SHAPE.SLOPE_UP || shapeOf(c) === SHAPE.SLOPE_DOWN;

/** Height of a slope's floor at world x inside cell (cx, cy). */
function slopeSurface(c: number, cx: number, cy: number, x: number, size: number): number {
  const local = Math.max(0, Math.min(size, x - cx * size));
  return shapeOf(c) === SHAPE.SLOPE_UP ? cy * size + size - local : cy * size + local;
}

function overlapping(b: Body, w: World, fn: (c: number, cx: number, cy: number) => void): void {
  const s = w.cell;
  const x0 = Math.floor(b.x / s), x1 = Math.floor((b.x + b.w - 0.001) / s);
  const y0 = Math.floor(b.y / s), y1 = Math.floor((b.y + b.h - 0.001) / s);
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) fn(w.at(cx, cy), cx, cy);
}

function hits(b: Body, w: World, wall: (c: number) => boolean): boolean {
  let hit = false;
  overlapping(b, w, (c) => {
    if (wall(c)) hit = true;
  });
  return hit;
}

/** Move horizontally; `stepUp` lets a grounded body climb small ledges (like the top of a slope). */
function moveX(b: Body, w: World, dx: number, wall: (c: number) => boolean, stepUp = 0): void {
  b.x += dx;
  if (!dx || !hits(b, w, wall)) return;
  if (stepUp > 0) {
    const oy = b.y;
    for (let k = 1; k <= stepUp; k++) {
      b.y = oy - k;
      if (!hits(b, w, wall)) return;
    }
    b.y = oy;
  }
  const s = w.cell;
  overlapping(b, w, (c, cx) => {
    if (!wall(c)) return;
    if (dx > 0) b.x = Math.min(b.x, cx * s - b.w);
    else if (dx < 0) b.x = Math.max(b.x, (cx + 1) * s);
  });
}

export function stepPlatformer(b: Body, input: Input, w: World): 'ok' | 'hazard' | 'fell' {
  const s = w.cell;
  // What the body is touching
  let ladder = false, water = false, hazard = false;
  const cxMid = Math.floor((b.x + b.w / 2) / s);
  overlapping(b, w, (c, cx) => {
    const sh = shapeOf(c);
    if (sh === SHAPE.LADDER && cx === cxMid) ladder = true;
    if (sh === SHAPE.WATER) water = true;
    if (sh === SHAPE.HAZARD) hazard = true;
  });
  if (hazard) return 'hazard';
  b.inWater = water;

  // Ground material under the feet
  const under = w.at(Math.floor((b.x + b.w / 2) / s), Math.floor((b.y + b.h + 1) / s));
  const mat = b.onGround ? w.materialName(materialOf(under)) : '';

  // Horizontal control
  const max = (input.run ? 2.6 : 1.6) * (water ? 0.6 : 1) * (mat === 'mud' ? 0.5 : 1);
  const accel = mat === 'ice' ? 0.05 : b.onGround ? 0.35 : 0.2;
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (dir) {
    b.facing = dir as 1 | -1;
    b.vx += dir * accel;
    if (Math.abs(b.vx) > max) b.vx = Math.sign(b.vx) * max;
  } else {
    const friction = mat === 'ice' ? 0.02 : 0.3;
    b.vx = Math.abs(b.vx) <= friction ? 0 : b.vx - Math.sign(b.vx) * friction;
  }
  let push = 0;
  if (mat === 'conveyor_left') push = -0.8;
  if (mat === 'conveyor_right') push = 0.8;

  // Ladders
  if (ladder && (input.up || input.down) && !b.climbing) b.climbing = true;
  if (!ladder) b.climbing = false;
  if (b.climbing) {
    b.vy = input.up ? -1.2 : input.down ? 1.2 : 0;
    b.vx *= 0.5;
    if (input.jumpPressed) {
      b.climbing = false;
      b.vy = -3.5;
    }
  } else {
    b.vy += water ? 0.08 : 0.25;
    const fall = water ? 1.4 : 6;
    if (b.vy > fall) b.vy = fall;
    if (input.jumpPressed && (b.onGround || water)) b.vy = water ? -2.6 : -5.2;
    if (!input.jump && b.vy < -2 && !water) b.vy = -2;
  }

  // Move horizontally: solids are walls; slopes are handled by the vertical pass.
  moveX(b, w, b.vx + push, isSolid, b.onGround ? 8 : 0);

  // Move vertically
  const wasGrounded = b.onGround;
  const prevBottom = b.y + b.h;
  b.y += b.vy;
  b.onGround = false;
  overlapping(b, w, (c, _cx, cy) => {
    const sh = shapeOf(c);
    if (sh === SHAPE.SOLID) {
      if (b.vy > 0) {
        b.y = Math.min(b.y, cy * s - b.h);
        b.onGround = true;
      } else if (b.vy < 0) b.y = Math.max(b.y, (cy + 1) * s);
    } else if (sh === SHAPE.ONE_WAY && b.vy >= 0 && !b.climbing && !input.down) {
      if (prevBottom <= cy * s + 0.01) {
        b.y = cy * s - b.h;
        b.onGround = true;
      }
    }
  });
  if (b.onGround) b.vy = 0;
  // Slopes: stand on the surface under the body's centre; stick to it when walking downhill.
  const midX = b.x + b.w / 2;
  const cx = Math.floor(midX / s);
  for (const cy of [Math.floor((b.y + b.h - 1) / s), Math.floor((b.y + b.h + 4) / s)]) {
    const c = w.at(cx, cy);
    if (!isSlope(c) || b.vy < 0 || b.climbing) continue;
    const surf = slopeSurface(c, cx, cy, midX, s);
    const bottom = b.y + b.h;
    if (bottom >= surf - (wasGrounded ? 6 : 0) && bottom <= surf + Math.max(4, b.vy + 1)) {
      b.y = surf - b.h;
      b.vy = 0;
      b.onGround = true;
      break;
    }
  }
  if (b.climbing) b.onGround = false;
  if (b.y > w.rows * s + 64) return 'fell';
  b.x = Math.max(0, Math.min(w.cols * s - b.w, b.x));
  return 'ok';
}

export function stepTopDown(b: Body, input: Input, w: World): 'ok' | 'hazard' {
  let hazard = false;
  overlapping(b, w, (c) => {
    if (shapeOf(c) === SHAPE.HAZARD) hazard = true;
  });
  if (hazard) return 'hazard';
  const speed = input.run ? 2.2 : 1.4;
  const dx = ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * speed;
  const dy = ((input.down ? 1 : 0) - (input.up ? 1 : 0)) * speed;
  if (dx) b.facing = dx > 0 ? 1 : -1;
  const wall = (c: number) => shapeOf(c) === SHAPE.SOLID || shapeOf(c) === SHAPE.WATER;
  moveX(b, w, dx, wall);
  b.y += dy;
  const s = w.cell;
  overlapping(b, w, (c, _cx, cy) => {
    if (!wall(c)) return;
    if (dy > 0) b.y = Math.min(b.y, cy * s - b.h);
    else if (dy < 0) b.y = Math.max(b.y, (cy + 1) * s);
  });
  b.x = Math.max(0, Math.min(w.cols * s - b.w, b.x));
  b.y = Math.max(0, Math.min(w.rows * s - b.h, b.y));
  return 'ok';
}

/** Camera that follows a point, clamped to the level and to an optional lock rectangle. */
export function followCamera(
  cam: { x: number; y: number },
  target: { x: number; y: number },
  bounds: { w: number; h: number },
  lock: { x: number; y: number; width: number; height: number } | null,
  screen = { w: 256, h: 224 },
  smooth = 0.2,
): void {
  let tx = target.x - screen.w / 2, ty = target.y - screen.h / 2;
  let minX = 0, minY = 0, maxX = Math.max(0, bounds.w - screen.w), maxY = Math.max(0, bounds.h - screen.h);
  if (lock) {
    minX = Math.max(minX, lock.x);
    minY = Math.max(minY, lock.y);
    maxX = Math.min(maxX, Math.max(minX, lock.x + lock.width - screen.w));
    maxY = Math.min(maxY, Math.max(minY, lock.y + lock.height - screen.h));
  }
  tx = Math.max(minX, Math.min(maxX, tx));
  ty = Math.max(minY, Math.min(maxY, ty));
  cam.x += (tx - cam.x) * smooth;
  cam.y += (ty - cam.y) * smooth;
  if (Math.abs(tx - cam.x) < 0.25) cam.x = tx;
  if (Math.abs(ty - cam.y) < 0.25) cam.y = ty;
}
