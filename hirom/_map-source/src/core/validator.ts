import type { Project as PixelProject } from '@pixel/core/project';
import { cellTile } from '@pixel/core/project';
import { spriteUniqueTiles } from '@pixel/core/tiles';
import type { EntityTemplate, Level } from './level';
import { SCREEN_H, SCREEN_W, levelPixels, levelTiles, refId, resolveEntity } from './level';

/**
 * Screen-budget validator (spec §2.5). Slides a 256×224 window over the level and estimates what
 * the PPU would need loaded for that view:
 *  - VRAM: unique BG tiles per layer at that layer's bit depth, a 64×32 tilemap per BG layer (two
 *    screens, so horizontal scrolling can stream), and the unique tiles of every sprite on screen;
 *  - OAM: hardware objects on screen (sprites split into 16×16 objects) and the most on any scanline.
 */
export const VRAM_BYTES = 65536;
export const OAM_LIMIT = 128;
export const OAM_LINE_LIMIT = 32;
const TILEMAP_BYTES = 64 * 32 * 2;
const OBJ = 16;

export interface ScreenWindow {
  x: number;
  y: number;
  vram: number;
  bgTiles: number[];
  oam: number;
  maxPerLine: number;
  problems: string[];
}

export interface ValidationReport {
  windows: number;
  issues: ScreenWindow[];
  worst: { vram: number; oam: number; line: number };
  strict: boolean;
}

export function objectsFor(w: number, h: number): { total: number; perRow: number } {
  const cols = Math.max(1, Math.ceil(w / OBJ)), rows = Math.max(1, Math.ceil(h / OBJ));
  return { total: cols * rows, perRow: cols };
}

export function validateLevel(
  level: Level,
  source: PixelProject | null,
  templates: EntityTemplate[],
  opts: { stepX?: number; stepY?: number } = {},
): ValidationReport {
  const strict = level.meta.strictHardwareLimits;
  const { w: mapW, h: mapH } = levelPixels(level);
  const { w: tilesW, h: tilesH } = levelTiles(level);
  const stepX = opts.stepX ?? 64, stepY = opts.stepY ?? 56;
  const xs: number[] = [], ys: number[] = [];
  for (let x = 0; ; x += stepX) {
    xs.push(Math.min(x, Math.max(0, mapW - SCREEN_W)));
    if (x + SCREEN_W >= mapW) break;
  }
  for (let y = 0; ; y += stepY) {
    ys.push(Math.min(y, Math.max(0, mapH - SCREEN_H)));
    if (y + SCREEN_H >= mapH) break;
  }

  const tilesets = level.layers.map((l) => source?.tilesets.find((t) => t.id === refId(l.tilesetRef)) ?? null);
  const sprites = new Map((source?.sprites ?? []).map((s) => [s.id, s]));
  const ents = level.entities.map((e) => {
    const r = resolveEntity(e, templates);
    const spr = r.spriteRef ? sprites.get(refId(r.spriteRef)!) : undefined;
    const w = spr?.width ?? r.width, h = spr?.height ?? r.height;
    const x = spr ? e.x - spr.originX : e.x, y = spr ? e.y - spr.originY : e.y;
    return { x, y, w, h, spr, vram: spr ? spriteUniqueTiles(spr) * 32 : Math.ceil((w * h) / 2) };
  });

  const issues: ScreenWindow[] = [];
  const worst = { vram: 0, oam: 0, line: 0 };
  const seen = new Uint8Array(1024);
  let windows = 0;
  for (const y of ys) {
    for (const x of xs) {
      windows++;
      let vram = 0;
      const bgTiles: number[] = [];
      level.layers.forEach((layer, i) => {
        const ts = tilesets[i];
        if (!layer.visible || !ts) {
          bgTiles.push(0);
          return;
        }
        seen.fill(0);
        let unique = 0;
        const tx0 = Math.floor(x / 8), ty0 = Math.floor(y / 8);
        const tx1 = Math.min(tilesW, Math.ceil((x + SCREEN_W) / 8)), ty1 = Math.min(tilesH, Math.ceil((y + SCREEN_H) / 8));
        for (let ty = ty0; ty < ty1; ty++) {
          for (let tx = tx0; tx < tx1; tx++) {
            const t = cellTile(layer.cells[ty * tilesW + tx]);
            if (!seen[t]) {
              seen[t] = 1;
              unique++;
            }
          }
        }
        bgTiles.push(unique);
        vram += unique * ts.bpp * 8 + TILEMAP_BYTES;
      });

      let oam = 0;
      const lines = new Uint16Array(SCREEN_H);
      const spritesOn = new Set<unknown>();
      for (const e of ents) {
        if (e.x + e.w <= x || e.y + e.h <= y || e.x >= x + SCREEN_W || e.y >= y + SCREEN_H) continue;
        const o = objectsFor(e.w, e.h);
        oam += o.total;
        const key = e.spr ?? e;
        if (!spritesOn.has(key)) {
          spritesOn.add(key);
          vram += e.vram;
        }
        const top = Math.max(0, e.y - y), bottom = Math.min(SCREEN_H, e.y + e.h - y);
        for (let r = top; r < bottom; r++) lines[r] += o.perRow;
      }
      let maxPerLine = 0;
      for (let r = 0; r < SCREEN_H; r++) maxPerLine = Math.max(maxPerLine, lines[r]);

      worst.vram = Math.max(worst.vram, vram);
      worst.oam = Math.max(worst.oam, oam);
      worst.line = Math.max(worst.line, maxPerLine);
      const problems: string[] = [];
      if (vram > VRAM_BYTES) problems.push(`VRAM ${(vram / 1024).toFixed(1)} KB > 64 KB`);
      if (oam > OAM_LIMIT) problems.push(`${oam} sprites on screen > ${OAM_LIMIT}`);
      if (maxPerLine > OAM_LINE_LIMIT) problems.push(`${maxPerLine} sprites on one line > ${OAM_LINE_LIMIT}`);
      if (problems.length && strict) issues.push({ x, y, vram, bgTiles, oam, maxPerLine, problems });
    }
  }
  return { windows, issues, worst, strict };
}
