import { toRgb8 } from '../core/color';
import { blockSize } from '../core/cgram';
import { Editor } from '../core/editor';
import { IndexedImage } from '../core/image';
import { encodeIndexedPng, encodeRgbaPng } from './png';
import { encodePal } from './palfile';
import { serializeProject } from './project';
import { buildSpritesheet } from './spritesheet';
import { buildTiled, fileSafe } from './tiled';
import { makeZip } from './zip';

/** Resolve local indices to RGBA through a sub-palette. */
export function toRgba(
  img: IndexedImage,
  cgram: Uint16Array,
  base: number,
  showBackdrop: boolean,
  out = new Uint8ClampedArray(img.width * img.height * 4),
): Uint8ClampedArray {
  const n = blockSize(img.bpp);
  const lut = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = toRgb8(i === 0 ? cgram[0] : cgram[base + i]);
    lut.set([r, g, b, i === 0 && !showBackdrop ? 0 : 255], i * 4);
  }
  const p = img.pixels;
  for (let i = 0; i < p.length; i++) {
    const o = p[i] * 4;
    out[i * 4] = lut[o];
    out[i * 4 + 1] = lut[o + 1];
    out[i * 4 + 2] = lut[o + 2];
    out[i * 4 + 3] = lut[o + 3];
  }
  return out;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const download = (bytes: Uint8Array, name: string, type: string) => downloadBlob(new Blob([bytes], { type }), name);

/** Name of the asset being edited, for file names. */
function assetName(ed: Editor): string {
  return ed.canvasAsset?.name ?? ed.tilesetAsset?.name ?? ed.spriteAsset?.name ?? ed.project.title;
}

/** Nearest-neighbour upscale (with optional 8:7 horizontal stretch) of RGBA rows. */
function scaleRgba(src: Uint8ClampedArray, w: number, h: number, scale: number, par: boolean) {
  const W = Math.round(w * scale * (par ? 8 / 7 : 1)), H = h * scale;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / W));
      out.set(src.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * W + x) * 4);
    }
  }
  return { rgba: out, w: W, h: H };
}

/** RGBA PNG of the open image at an integer scale, optionally stretched to 8:7. */
export async function exportRgbaPng(ed: Editor, scale: number, par: boolean): Promise<void> {
  const img = ed.image;
  const s = scaleRgba(toRgba(img, ed.cgram, ed.base, false), img.width, img.height, scale, par);
  const suffix = `${scale > 1 ? `@${scale}x` : ''}${par ? '_8x7' : ''}`;
  download(await encodeRgbaPng(s.w, s.h, s.rgba), `${fileSafe(assetName(ed))}${suffix}.png`, 'image/png');
}

/** Indexed PNG: pixel values are local palette indices; PLTE is the active sub-palette. */
export async function exportIndexedPng(ed: Editor): Promise<void> {
  const img = ed.image;
  const n = blockSize(img.bpp);
  const palette = Array.from({ length: n }, (_, i) => toRgb8(ed.cgram[i === 0 ? 0 : ed.base + i]));
  const bytes = await encodeIndexedPng({ width: img.width, height: img.height, indices: img.pixels, palette, transparentZero: true });
  download(bytes, `${fileSafe(assetName(ed))}_pal${ed.paletteId}_indexed.png`, 'image/png');
}

export function exportPal(ed: Editor): void {
  download(encodePal(ed.cgram), `${fileSafe(ed.project.title)}.pal`, 'application/octet-stream');
}

export function exportProject(ed: Editor): void {
  const json = JSON.stringify(serializeProject(ed.project));
  // HiROM Pixel project file (JSON inside). octet-stream so browsers don't add ".json".
  downloadBlob(new Blob([json], { type: 'application/octet-stream' }), `${fileSafe(ed.project.title)}.hirompixel`);
}

// The live SceneRenderer belongs to the canvas view; it registers a capture function here.
type SceneCapture = (mode: 'screen' | 'map') => { rgba: Uint8ClampedArray; w: number; h: number } | null;
let sceneCapture: SceneCapture | null = null;
export const registerSceneCapture = (fn: SceneCapture | null) => (sceneCapture = fn);

export async function exportScenePng(ed: Editor, mode: 'screen' | 'map', scale = 1, par = false): Promise<void> {
  const shot = sceneCapture?.(mode);
  if (!shot) throw new Error('The scene renderer is not ready.');
  const s = scaleRgba(shot.rgba, shot.w, shot.h, scale, par);
  const suffix = `${mode === 'screen' ? '_screen' : '_map'}${scale > 1 ? `@${scale}x` : ''}${par ? '_8x7' : ''}`;
  download(await encodeRgbaPng(s.w, s.h, s.rgba), `${fileSafe(ed.project.title)}${suffix}.png`, 'image/png');
}

/** Tiled .tmx + .tmj with palette-expanded tileset PNGs, in one zip. */
export async function exportTiled(ed: Editor): Promise<void> {
  const t = buildTiled(ed.project);
  const base = fileSafe(ed.project.title);
  const enc = new TextEncoder();
  const files = [
    { name: `${base}.tmx`, data: enc.encode(t.tmx) },
    { name: `${base}.tmj`, data: enc.encode(JSON.stringify(t.tmj, null, 1)) },
  ];
  for (const im of t.images) files.push({ name: im.name, data: await encodeRgbaPng(im.width, im.height, im.rgba) });
  download(makeZip(files), `${base}_tiled.zip`, 'application/zip');
}

/** Spritesheet strip (RGBA + indexed PNG) and frame metadata JSON, in one zip. */
export async function exportSpritesheet(ed: Editor): Promise<void> {
  const s = ed.spriteAsset;
  if (!s) throw new Error('Open a sprite to export its sheet.');
  const { image, indices, meta } = buildSpritesheet(ed.project, s);
  const palette = Array.from({ length: 16 }, (_, i) => toRgb8(ed.cgram[i === 0 ? 0 : s.paletteId * 16 + i]));
  const base = fileSafe(s.name);
  const files = [
    { name: image.name, data: await encodeRgbaPng(image.width, image.height, image.rgba) },
    {
      name: `${base}_indexed.png`,
      data: await encodeIndexedPng({ width: image.width, height: image.height, indices, palette, transparentZero: true }),
    },
    { name: `${base}.json`, data: new TextEncoder().encode(JSON.stringify(meta, null, 2)) },
  ];
  download(makeZip(files), `${base}_sheet.zip`, 'application/zip');
}
