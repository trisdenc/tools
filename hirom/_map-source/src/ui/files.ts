import { encodeRgbaPng } from '@pixel/io/png';
import { makeZip } from '@pixel/io/zip';
import type { MapEditor } from '../core/editor';
import { SCREEN_H, SCREEN_W, levelPixels, materialOf } from '../core/level';
import { starterWorkspace } from '../core/starter';
import { createWorkspace, createLevel, LIVE_PIXEL_ID } from '../core/level';
import { buildSnesExport } from '../io/snes';
import { buildLevelTmj, levelFileBase } from '../io/tmj';
import { FILE_EXT, levelFromSpecJson, levelToSpecJson, parseWorkspace, serializeWorkspace } from '../io/workspace';
import { captureLevel } from '../render/frame';
import { drawCollisionCell } from '../render/overlay';
import { rendererRef } from './CanvasView';
import { download, pickFile } from './common';

const run = async (ed: MapEditor, fn: () => Promise<void> | void) => {
  try {
    await fn();
  } catch (e) {
    ed.toast(e instanceof Error ? e.message : String(e), true);
  }
};

export const newStarterWorld = (ed: MapEditor) => {
  if (!confirm('Replace this workspace with the starter world? Save it first if you want to keep it.')) return;
  ed.loadWorkspace(starterWorkspace(), new Map());
};

export const newEmptyWorld = (ed: MapEditor) => {
  if (!confirm('Start a new, empty workspace? Save the current one first if you want to keep it.')) return;
  const ws = createWorkspace();
  ws.levels = [createLevel({ title: 'Level 1', widthMetatiles: 64, heightMetatiles: 28, pixelSourceId: LIVE_PIXEL_ID })];
  ed.loadWorkspace(ws, new Map());
};

export const saveWorkspace = (ed: MapEditor) =>
  run(ed, () => {
    const json = serializeWorkspace(ed.ws, ed.soundFiles);
    download(new Blob([JSON.stringify(json)], { type: 'application/octet-stream' }), `${levelFileBase({ meta: { title: ed.ws.title } } as never)}.${FILE_EXT}`);
  });

export const openWorkspace = (ed: MapEditor) =>
  run(ed, async () => {
    const f = await pickFile(`.${FILE_EXT},.json`);
    if (!f) return;
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.levels) && data.meta && Array.isArray(data.layers)) {
      // A single level file: add it to the current workspace instead.
      const level = levelFromSpecJson(data, ed.ws);
      ed.ws.levels.push(level);
      ed.setActiveLevel(ed.ws.levels.length - 1);
      ed.toast(`Added level "${level.meta.title}".`);
      return;
    }
    const { ws, soundFiles } = parseWorkspace(data);
    ed.loadWorkspace(ws, soundFiles);
    ed.toast(`Opened ${f.name}.`);
  });

export const exportLevelJson = (ed: MapEditor) =>
  run(ed, () => download(JSON.stringify(levelToSpecJson(ed.level, ed.ws), null, 2), `${levelFileBase(ed.level)}.level.json`, 'application/json'));

export const importLevelJson = (ed: MapEditor) =>
  run(ed, async () => {
    const f = await pickFile('.json');
    if (!f) return;
    const level = levelFromSpecJson(JSON.parse(await f.text()), ed.ws);
    ed.ws.levels.push(level);
    ed.setActiveLevel(ed.ws.levels.length - 1);
    ed.toast(`Imported "${level.meta.title}".`);
  });

const needSource = (ed: MapEditor) => {
  const src = ed.source;
  if (!src) throw new Error('This level has no tiles loaded yet (see the Assets tab).');
  return src;
};

export const exportTiled = (ed: MapEditor) =>
  run(ed, async () => {
    const src = needSource(ed);
    const { tmj, images } = buildLevelTmj(ed.level, ed.ws, src);
    const base = levelFileBase(ed.level);
    const files = [{ name: `${base}.tmj`, data: new TextEncoder().encode(JSON.stringify(tmj, null, 1)) }];
    for (const img of images) files.push({ name: img.name, data: await encodeRgbaPng(img.width, img.height, img.rgba) });
    download(makeZip(files), `${base}_tiled.zip`, 'application/zip');
    ed.toast('Exported Tiled map (.tmj + tileset PNGs).');
  });

export const exportSnes = (ed: MapEditor) =>
  run(ed, () => {
    const files = buildSnesExport(ed.level, ed.ws);
    download(makeZip(files), `${levelFileBase(ed.level)}_snes.zip`, 'application/zip');
    ed.toast('Exported SNES nametables, metatiles and collision.');
  });

export const exportPng = (ed: MapEditor, overlays: boolean) =>
  run(ed, async () => {
    const src = needSource(ed);
    const h = rendererRef.current;
    if (!h) throw new Error('The renderer isn’t ready.');
    const { w, h: hh } = levelPixels(ed.level);
    if (w * hh > 64e6) throw new Error('This level is too large for a single PNG (over 64 megapixels).');
    const img = captureLevel(h.r, { level: ed.level, project: src, templates: ed.ws.templates, tick: 0, animate: false, pixelVersion: ed.pixelVersion, cellsVersion: ed.cellsVersion });
    let rgba = img.rgba;
    if (overlays) {
      const c = new OffscreenCanvas(w, hh);
      const ctx = c.getContext('2d')!;
      ctx.putImageData(new ImageData(rgba, w, hh), 0, 0);
      const ms = ed.level.meta.metatileSize, W = ed.level.meta.widthMetatiles;
      for (let i = 0; i < ed.level.collision.length; i++) {
        const cval = ed.level.collision[i];
        if (cval)
          drawCollisionCell(ctx as unknown as CanvasRenderingContext2D, (i % W) * ms, Math.floor(i / W) * ms, ms, cval, ed.ws.materials.find((m) => m.id === materialOf(cval))?.color);
      }
      ctx.font = '10px sans-serif';
      for (const e of ed.level.entities) {
        const b = ed.entityBox(e);
        ctx.strokeStyle = b.color;
        ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
        ctx.fillStyle = b.color;
        ctx.fillText(b.name, b.x, b.y - 2);
      }
      for (const z of ed.level.zones) {
        ctx.strokeStyle = '#ffd23f';
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(z.x + 0.5, z.y + 0.5, z.width - 1, z.height - 1);
        ctx.setLineDash([]);
        ctx.fillStyle = '#ffd23f';
        ctx.fillText(`${z.name} (${z.type})`, z.x + 3, z.y + 11);
      }
      ctx.strokeStyle = '#ffffff40';
      for (let x = SCREEN_W; x < w; x += SCREEN_W) ctx.strokeRect(x + 0.5, 0, 0, hh);
      for (let y = SCREEN_H; y < hh; y += SCREEN_H) ctx.strokeRect(0, y + 0.5, w, 0);
      rgba = ctx.getImageData(0, 0, w, hh).data;
    }
    download(await encodeRgbaPng(w, hh, rgba), `${levelFileBase(ed.level)}${overlays ? '_annotated' : ''}.png`, 'image/png');
    ed.toast(`Exported a ${w}×${hh} PNG of the whole level.`);
  });
