/** Integer rasterization primitives. No anti-aliasing anywhere. */
export type Plot = (x: number, y: number) => void;

/** Bresenham line, endpoints inclusive. */
export function line(x0: number, y0: number, x1: number, y1: number, plot: Plot): void {
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

export function rect(x0: number, y0: number, x1: number, y1: number, filled: boolean, plot: Plot): void {
  const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
  if (filled) {
    for (let y = t; y <= b; y++) for (let x = l; x <= r; x++) plot(x, y);
    return;
  }
  for (let x = l; x <= r; x++) {
    plot(x, t);
    if (b !== t) plot(x, b);
  }
  for (let y = t + 1; y < b; y++) {
    plot(l, y);
    if (r !== l) plot(r, y);
  }
}

/** Zingl's ellipse-in-rectangle algorithm; handles even and odd diameters. */
function ellipsePoints(x0: number, y0: number, x1: number, y1: number, set: Plot): void {
  let a = Math.abs(x1 - x0);
  const b = Math.abs(y1 - y0);
  let b1 = b & 1;
  let dx = 4 * (1 - a) * b * b;
  let dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;
  if (x0 > x1) {
    x0 = x1;
    x1 += a;
  }
  if (y0 > y1) y0 = y1;
  y0 += (b + 1) >> 1;
  y1 = y0 - b1;
  a *= 8 * a;
  b1 = 8 * b * b;
  do {
    set(x1, y0);
    set(x0, y0);
    set(x0, y1);
    set(x1, y1);
    const e2 = 2 * err;
    if (e2 <= dy) {
      y0++;
      y1--;
      dy += a;
      err += dy;
    }
    if (e2 >= dx || 2 * err > dy) {
      x0++;
      x1--;
      dx += b1;
      err += dx;
    }
  } while (x0 <= x1);
  while (y0 - y1 <= b) {
    set(x0 - 1, y0);
    set(x1 + 1, y0++);
    set(x0 - 1, y1);
    set(x1 + 1, y1--);
  }
}

export function ellipse(x0: number, y0: number, x1: number, y1: number, filled: boolean, plot: Plot): void {
  const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
  if (l === r || t === b) {
    rect(l, t, r, b, true, plot);
    return;
  }
  const rows = new Map<number, [number, number]>();
  const seen = new Set<number>();
  const pts: number[] = [];
  const width = r - l + 1;
  ellipsePoints(l, t, r, b, (x, y) => {
    if (x < l || x > r || y < t || y > b) return;
    const key = (y - t) * width + (x - l);
    if (seen.has(key)) return;
    seen.add(key);
    pts.push(x, y);
    const row = rows.get(y);
    if (!row) rows.set(y, [x, x]);
    else {
      if (x < row[0]) row[0] = x;
      if (x > row[1]) row[1] = x;
    }
  });
  if (filled) {
    rows.forEach(([a, c], y) => {
      for (let x = a; x <= c; x++) plot(x, y);
    });
  } else {
    for (let i = 0; i < pts.length; i += 2) plot(pts[i], pts[i + 1]);
  }
}

/** 4-connected region of identical indices containing (sx, sy). Optionally wraps at the edges. */
export function floodRegion(
  width: number,
  height: number,
  pixels: ArrayLike<number>,
  sx: number,
  sy: number,
  wrap = false,
): Uint32Array {
  const start = sy * width + sx;
  const target = pixels[start];
  const seen = new Uint8Array(width * height);
  const out: number[] = [];
  const stack = [start];
  seen[start] = 1;
  const visit = (nx: number, ny: number) => {
    if (wrap) {
      nx = (nx + width) % width;
      ny = (ny + height) % height;
    } else if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
    const j = ny * width + nx;
    if (!seen[j] && pixels[j] === target) {
      seen[j] = 1;
      stack.push(j);
    }
  };
  while (stack.length) {
    const i = stack.pop()!;
    out.push(i);
    const x = i % width;
    const y = (i - x) / width;
    visit(x + 1, y);
    visit(x - 1, y);
    visit(x, y + 1);
    visit(x, y - 1);
  }
  return Uint32Array.from(out);
}

export type DitherPattern = 'checker' | 'bayer2' | 'bayer4';

const BAYER2 = [0, 2, 3, 1];
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const wrapN = (v: number, n: number) => ((v % n) + n) % n;

/** Whether the ordered-dither pattern is "on" at an absolute pixel for a 0..1 density. */
export function ditherOn(pattern: DitherPattern, x: number, y: number, density: number): boolean {
  switch (pattern) {
    case 'checker':
      return ((wrapN(x, 2) + wrapN(y, 2)) & 1) === 0;
    case 'bayer2':
      return (BAYER2[wrapN(y, 2) * 2 + wrapN(x, 2)] + 0.5) / 4 < density;
    case 'bayer4':
      return (BAYER4[wrapN(y, 4) * 4 + wrapN(x, 4)] + 0.5) / 16 < density;
  }
}
