import type { Terrain } from './level';

/**
 * Autotiling. A cell's neighbour mask has one bit per direction where the neighbour has the same
 * terrain. For the 47-tile "blob" set, a corner only counts when both edges next to it do
 * (otherwise it can't be seen), which collapses 256 masks to 47. The 16-tile Wang set uses edges only.
 */
export const N = 1, NE = 2, E = 4, SE = 8, S = 16, SW = 32, W = 64, NW = 128;

export function rawMask(same: (dx: number, dy: number) => boolean): number {
  let m = 0;
  if (same(0, -1)) m |= N;
  if (same(1, -1)) m |= NE;
  if (same(1, 0)) m |= E;
  if (same(1, 1)) m |= SE;
  if (same(0, 1)) m |= S;
  if (same(-1, 1)) m |= SW;
  if (same(-1, 0)) m |= W;
  if (same(-1, -1)) m |= NW;
  return m;
}

export function reduceBlob(m: number): number {
  let r = m;
  if (!(m & N) || !(m & E)) r &= ~NE;
  if (!(m & S) || !(m & E)) r &= ~SE;
  if (!(m & S) || !(m & W)) r &= ~SW;
  if (!(m & N) || !(m & W)) r &= ~NW;
  return r;
}

/** The 47 reduced blob masks in ascending order — the order used when auto-filling a terrain. */
export const BLOB47: number[] = (() => {
  const s = new Set<number>();
  for (let m = 0; m < 256; m++) s.add(reduceBlob(m));
  return [...s].sort((a, b) => a - b);
})();

/** Edge-only mask as a 0–15 Wang index: N = 1, E = 2, S = 4, W = 8. */
export function wangIndex(m: number): number {
  return (m & N ? 1 : 0) | (m & E ? 2 : 0) | (m & S ? 4 : 0) | (m & W ? 8 : 0);
}

export const WANG16: number[] = Array.from({ length: 16 }, (_, i) => i);

export const slotsFor = (t: Terrain): number[] => (t.kind === 'blob47' ? BLOB47 : WANG16);
export const slotKey = (t: Terrain, raw: number): number => (t.kind === 'blob47' ? reduceBlob(raw) : wangIndex(raw));

/** Pick the metatile for a raw neighbour mask, falling back gracefully when a slot is unassigned. */
export function pickMetatile(t: Terrain, raw: number): number | undefined {
  const key = slotKey(t, raw);
  if (t.slots[key] !== undefined) return t.slots[key];
  if (t.kind === 'blob47') {
    // Drop corners, then try the matching edge-only shape, then the fully surrounded centre.
    const edges = raw & (N | E | S | W);
    if (t.slots[edges] !== undefined) return t.slots[edges];
    if (t.slots[255] !== undefined) return t.slots[255];
  } else if (t.slots[15] !== undefined) {
    return t.slots[15];
  }
  const any = Object.values(t.slots);
  return any.length ? any[0] : undefined;
}

/** Fill slots in canonical order from consecutive metatile ids (for sheets drawn in that order). */
export function fillSlotsSequential(t: Terrain, firstMetatileId: number): void {
  const order = slotsFor(t);
  t.slots = {};
  order.forEach((mask, i) => (t.slots[mask] = firstMetatileId + i));
}

/** 3×3 picture of a mask for the slot editor: which of the 9 cells are "inside". */
export function maskPicture(mask: number, kind: Terrain['kind']): boolean[] {
  const m = kind === 'blob47' ? mask : (mask & 1 ? N : 0) | (mask & 2 ? E : 0) | (mask & 4 ? S : 0) | (mask & 8 ? W : 0);
  return [!!(m & NW), !!(m & N), !!(m & NE), !!(m & W), true, !!(m & E), !!(m & SW), !!(m & S), !!(m & SE)];
}
