import { toRgb8 } from '../core/color';
import { paletteBase } from '../core/cgram';
import { Project, Tilemap, Tileset, cellFlip, cellPal, cellTile, frameAt } from '../core/project';
import { objectBounds } from '../core/scene';
import { getTile, isBlank, tileCount } from '../core/tiles';

/**
 * Tiled export. Tiled has no palettes, so each tileset image is "palette-expanded": one copy of the
 * sheet per sub-palette the maps actually use, stacked vertically. A cell with tile t on palette p
 * becomes gid = firstgid + slot(p) * tileCount + t, with Tiled's H/V flip flags.
 */
export interface RgbaImage {
  name: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface TiledExport {
  tmx: string;
  tmj: unknown;
  images: RgbaImage[];
}

const FLIP_H = 0x80000000;
const FLIP_V = 0x40000000;

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
export const fileSafe = (s: string) => s.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_') || 'untitled';

interface TsEntry {
  ts: Tileset;
  palettes: number[];
  firstgid: number;
  tiles: number;
  blank: Uint8Array;
  image: RgbaImage;
}

function expandTileset(p: Project, ts: Tileset, palettes: number[], name: string): RgbaImage {
  const sheet = ts.sheet;
  const w = sheet.width, h = sheet.height;
  const rgba = new Uint8ClampedArray(w * h * palettes.length * 4);
  palettes.forEach((pal, k) => {
    const base = paletteBase(ts.bpp, pal);
    for (let i = 0; i < w * h; i++) {
      const v = sheet.pixels[i];
      if (!v) continue;
      const [r, g, b] = toRgb8(p.cgram[base + v]);
      const o = (k * w * h + i) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    }
  });
  return { name, width: w, height: h * palettes.length, rgba };
}

export function buildTiled(p: Project): TiledExport {
  const layers = p.scene.layers
    .map((l) => ({ l, map: p.tilemaps.find((m) => m.id === l.tilemapId) }))
    .filter((x): x is { l: (typeof p.scene.layers)[number]; map: Tilemap } => !!x.map);
  const mapW = Math.max(1, ...layers.map((x) => x.map.width));
  const mapH = Math.max(1, ...layers.map((x) => x.map.height));

  // One Tiled tileset per SNES tileset in use, expanded over the palettes its maps reference.
  const entries = new Map<string, TsEntry>();
  let nextGid = 1;
  for (const { map } of layers) {
    if (entries.has(map.tilesetId)) continue;
    const ts = p.tilesets.find((t) => t.id === map.tilesetId);
    if (!ts) continue;
    const n = tileCount(ts);
    const blank = new Uint8Array(n);
    for (let i = 0; i < n; i++) blank[i] = isBlank(getTile(ts.sheet, i)) ? 1 : 0;
    const pals = new Set<number>();
    for (const m of layers.filter((x) => x.map.tilesetId === ts.id))
      for (const w of m.map.cells) if (cellTile(w) < n && !blank[cellTile(w)]) pals.add(cellPal(w));
    const palettes = pals.size ? [...pals].sort((a, b) => a - b) : [ts.paletteId];
    const image = expandTileset(p, ts, palettes, `${fileSafe(ts.name)}.png`);
    entries.set(ts.id, { ts, palettes, firstgid: nextGid, tiles: n, blank, image });
    nextGid += n * palettes.length;
  }

  const gidsFor = (map: Tilemap): number[] => {
    const e = entries.get(map.tilesetId);
    const out: number[] = [];
    for (let y = 0; y < mapH; y++)
      for (let x = 0; x < mapW; x++) {
        // SNES maps wrap, so smaller layers repeat to fill the Tiled map.
        const w = map.cells[(y % map.height) * map.width + (x % map.width)];
        const t = cellTile(w);
        if (!e || t >= e.tiles || e.blank[t]) {
          out.push(0);
          continue;
        }
        const slot = Math.max(0, e.palettes.indexOf(cellPal(w)));
        let gid = e.firstgid + slot * e.tiles + t;
        const f = cellFlip(w);
        if (f & 1) gid = (gid | FLIP_H) >>> 0;
        if (f & 2) gid = (gid | FLIP_V) >>> 0;
        out.push(gid);
      }
    return out;
  };

  const sprites = new Map(p.sprites.map((s) => [s.id, s]));
  const objects = p.scene.objects
    .map((o, i) => {
      const s = sprites.get(o.spriteId);
      if (!s) return null;
      const b = objectBounds(o, s);
      return { id: i + 1, name: s.name, x: b.x, y: b.y, width: b.w, height: b.h, priority: o.priority, hFlip: o.hFlip, firstFrame: frameAt(s, 0) };
    })
    .filter((o): o is NonNullable<typeof o> => !!o);

  const tsList = [...entries.values()];
  const layerData = layers.map(({ l, map }, i) => ({ id: i + 1, name: l.id, l, gids: gidsFor(map) }));

  // ---- TMX ----
  const xml: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<map version="1.10" tiledversion="1.10.2" orientation="orthogonal" renderorder="right-down" width="${mapW}" height="${mapH}" tilewidth="8" tileheight="8" infinite="0" nextlayerid="${layerData.length + 2}" nextobjectid="${objects.length + 1}">`,
    ' <properties>',
    `  <property name="snesBgMode" type="int" value="1"/>`,
    `  <property name="screenWidth" type="int" value="${p.scene.resolution.width}"/>`,
    `  <property name="screenHeight" type="int" value="${p.scene.resolution.height}"/>`,
    ' </properties>',
  ];
  for (const e of tsList) {
    xml.push(
      ` <tileset firstgid="${e.firstgid}" name="${esc(e.ts.name)}" tilewidth="8" tileheight="8" tilecount="${e.tiles * e.palettes.length}" columns="16">`,
      `  <properties><property name="snesBpp" type="int" value="${e.ts.bpp}"/><property name="palettes" value="${e.palettes.join(',')}"/></properties>`,
      `  <image source="${esc(e.image.name)}" width="${e.image.width}" height="${e.image.height}"/>`,
      ' </tileset>',
    );
  }
  // Tiled draws later layers on top, so emit BG3 → BG1 (back to front, ignoring per-tile priority).
  for (const d of [...layerData].reverse()) {
    const rows: string[] = [];
    for (let y = 0; y < mapH; y++) rows.push(d.gids.slice(y * mapW, y * mapW + mapW).join(','));
    xml.push(
      ` <layer id="${d.id}" name="${d.name}" width="${mapW}" height="${mapH}"${d.l.visible ? '' : ' visible="0"'} parallaxx="${d.l.scrollFactor}" parallaxy="${d.l.scrollFactor}">`,
      `  <properties><property name="colorMath" type="bool" value="${d.l.math}"/><property name="subScreen" type="bool" value="${d.l.sub}"/></properties>`,
      '  <data encoding="csv">',
      rows.join(',\n'),
      '  </data>',
      ' </layer>',
    );
  }
  xml.push(` <objectgroup id="${layerData.length + 1}" name="OBJ">`);
  for (const o of objects) {
    xml.push(
      `  <object id="${o.id}" name="${esc(o.name)}" x="${o.x}" y="${o.y}" width="${o.width}" height="${o.height}">`,
      `   <properties><property name="priority" type="int" value="${o.priority}"/><property name="hFlip" type="bool" value="${o.hFlip}"/></properties>`,
      '  </object>',
    );
  }
  xml.push(' </objectgroup>', '</map>', '');

  // ---- TMJ ----
  const tmj = {
    type: 'map',
    version: '1.10',
    tiledversion: '1.10.2',
    orientation: 'orthogonal',
    renderorder: 'right-down',
    width: mapW,
    height: mapH,
    tilewidth: 8,
    tileheight: 8,
    infinite: false,
    nextlayerid: layerData.length + 2,
    nextobjectid: objects.length + 1,
    properties: [{ name: 'snesBgMode', type: 'int', value: 1 }],
    tilesets: tsList.map((e) => ({
      firstgid: e.firstgid,
      name: e.ts.name,
      tilewidth: 8,
      tileheight: 8,
      tilecount: e.tiles * e.palettes.length,
      columns: 16,
      image: e.image.name,
      imagewidth: e.image.width,
      imageheight: e.image.height,
      margin: 0,
      spacing: 0,
    })),
    layers: [
      ...[...layerData].reverse().map((d) => ({
        id: d.id,
        name: d.name,
        type: 'tilelayer',
        width: mapW,
        height: mapH,
        x: 0,
        y: 0,
        opacity: 1,
        visible: d.l.visible,
        parallaxx: d.l.scrollFactor,
        parallaxy: d.l.scrollFactor,
        data: d.gids,
      })),
      {
        id: layerData.length + 1,
        name: 'OBJ',
        type: 'objectgroup',
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        draworder: 'topdown',
        objects: objects.map((o) => ({
          id: o.id,
          name: o.name,
          x: o.x,
          y: o.y,
          width: o.width,
          height: o.height,
          rotation: 0,
          visible: true,
          properties: [
            { name: 'priority', type: 'int', value: o.priority },
            { name: 'hFlip', type: 'bool', value: o.hFlip },
          ],
        })),
      },
    ],
  };

  return { tmx: xml.join('\n'), tmj, images: tsList.map((e) => e.image) };
}
