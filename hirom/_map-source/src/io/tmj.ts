import type { Project as PixelProject } from '@pixel/core/project';
import { buildTiled, fileSafe, type RgbaImage } from '@pixel/io/tiled';
import type { Level, PropValue, Workspace } from '../core/level';
import { SHAPE_COLORS, SHAPE_NAMES, levelTiles, materialOf, refId, resolveEntity, shapeOf, tilesPerMeta } from '../core/level';

/**
 * Tiled (.tmj) export. Tile layers come from HiROM Pixel's exporter (one palette-expanded tileset
 * image per SNES tileset); HiROM Map adds a collision tile layer (with a small legend tileset whose
 * tiles carry `collision` / `material` properties), entity and zone object layers, per-layer
 * parallax and HDMA bands, and level properties.
 */
type TiledProp = { name: string; type: 'int' | 'float' | 'bool' | 'string'; value: PropValue };

const prop = (name: string, value: PropValue): TiledProp => ({
  name,
  type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : 'string',
  value,
});

const hexRgb = (h: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h);
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [n >> 16, (n >> 8) & 255, n & 255];
};

export interface TmjExport {
  tmj: Record<string, unknown>;
  images: RgbaImage[];
}

export function buildLevelTmj(level: Level, ws: Workspace, source: PixelProject): TmjExport {
  const { w: tw, h: th } = levelTiles(level);
  const k = tilesPerMeta(level.meta.metatileSize);
  const fake: PixelProject = {
    ...source,
    tilemaps: level.layers.map((l) => ({ id: l.id, name: l.name, tilesetId: refId(l.tilesetRef) ?? '', width: tw, height: th, cells: l.cells })),
    scene: {
      ...source.scene,
      layers: level.layers.map((l) => ({ id: l.hwSlot, tilemapId: l.id, visible: l.visible, main: l.main, sub: l.sub, math: l.math, scrollFactor: l.parallax.x })),
      objects: [],
    },
  };
  const base = buildTiled(fake);
  const tmj = base.tmj as Record<string, unknown> & { layers: Record<string, unknown>[]; tilesets: Record<string, unknown>[] };
  const images = [...base.images];

  // Tile layers: our names, parallax y, HDMA bands
  const tileLayers = tmj.layers.filter((l) => l.type === 'tilelayer');
  for (const tl of tileLayers) {
    const layer = level.layers.find((l) => l.hwSlot === tl.name);
    if (!layer) continue;
    tl.name = `${layer.hwSlot} ${layer.name}`;
    tl.parallaxx = layer.parallax.x;
    tl.parallaxy = layer.parallax.y;
    tl.properties = [
      prop('hwSlot', layer.hwSlot),
      prop('colorMath', layer.math),
      prop('subScreen', layer.sub),
      ...(layer.hdmaBands.length ? [prop('hdmaBands', JSON.stringify(layer.hdmaBands))] : []),
    ];
  }

  // Collision legend tileset: one 8×8 tile per collision byte in use
  const used = [...new Set(level.collision)].filter((c) => c !== 0).sort((a, b) => a - b);
  const maxGid = Math.max(0, ...tmj.tilesets.map((t) => (t.firstgid as number) + (t.tilecount as number) - 1));
  const colFirst = maxGid + 1;
  const legendW = Math.max(1, used.length) * 8;
  const legend = new Uint8ClampedArray(legendW * 8 * 4);
  used.forEach((c, i) => {
    const shape = shapeOf(c);
    const mat = ws.materials.find((m) => m.id === materialOf(c));
    const [r, g, b] = hexRgb(mat?.color ?? SHAPE_COLORS[shape] ?? '#ffffff');
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const o = (y * legendW + i * 8 + x) * 4;
        const edge = x === 0 || y === 0 || x === 7 || y === 7;
        legend[o] = edge ? r >> 1 : r;
        legend[o + 1] = edge ? g >> 1 : g;
        legend[o + 2] = edge ? b >> 1 : b;
        legend[o + 3] = 160;
      }
  });
  const legendName = 'collision_legend.png';
  images.push({ name: legendName, width: legendW, height: 8, rgba: legend });
  tmj.tilesets.push({
    firstgid: colFirst,
    name: 'collision',
    tilewidth: 8,
    tileheight: 8,
    tilecount: Math.max(1, used.length),
    columns: Math.max(1, used.length),
    image: legendName,
    imagewidth: legendW,
    imageheight: 8,
    margin: 0,
    spacing: 0,
    tiles: used.map((c, i) => ({
      id: i,
      properties: [
        prop('collision', SHAPE_NAMES[shapeOf(c)]),
        prop('material', ws.materials.find((m) => m.id === materialOf(c))?.name ?? ''),
        prop('value', c),
      ],
    })),
  });
  const colData: number[] = [];
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const c = level.collision[Math.floor(y / k) * level.meta.widthMetatiles + Math.floor(x / k)];
      colData.push(c ? colFirst + used.indexOf(c) : 0);
    }

  let nextLayer = Math.max(...tmj.layers.map((l) => l.id as number)) + 1;
  let nextObject = 1;
  const templates = ws.templates;
  const sprites = new Map(source.sprites.map((s) => [s.id, s]));
  const entities = level.entities.map((e) => {
    const r = resolveEntity(e, templates);
    const spr = r.spriteRef ? sprites.get(refId(r.spriteRef)!) : undefined;
    const w = spr?.width ?? r.width, h = spr?.height ?? r.height;
    const ox = spr ? spr.originX : Math.floor(w / 2), oy = spr ? spr.originY : h - 1;
    return {
      id: nextObject++,
      name: r.name,
      type: r.type,
      x: e.x - ox,
      y: e.y - oy,
      width: w,
      height: h,
      rotation: 0,
      visible: true,
      properties: [
        prop('entityId', e.id),
        prop('anchorX', e.x),
        prop('anchorY', e.y),
        prop('spriteRef', r.spriteRef ?? ''),
        prop('priority', e.priority),
        prop('hFlip', e.hFlip),
        ...(e.path.length ? [prop('path', JSON.stringify(e.path))] : []),
        ...Object.entries(r.properties).map(([k2, v]) => prop(k2, v)),
      ],
    };
  });
  const zones = level.zones.map((z) => ({
    id: nextObject++,
    name: z.name,
    type: z.type,
    x: z.x,
    y: z.y,
    width: z.width,
    height: z.height,
    rotation: 0,
    visible: true,
    properties: [
      prop('zoneId', z.id),
      ...(z.onEnterBgm ? [prop('onEnterBgm', z.onEnterBgm)] : []),
      ...(z.event ? [prop('event', z.event)] : []),
      ...Object.entries(z.properties).map(([k2, v]) => prop(k2, v)),
    ],
  }));

  const group = (name: string, objects: unknown[]) => ({
    id: nextLayer++,
    name,
    type: 'objectgroup',
    x: 0,
    y: 0,
    opacity: 1,
    visible: true,
    draworder: 'topdown',
    objects,
  });
  tmj.layers = [
    ...tileLayers,
    { id: nextLayer++, name: 'Collision', type: 'tilelayer', width: tw, height: th, x: 0, y: 0, opacity: 0.6, visible: false, data: colData, properties: [prop('cellSize', level.meta.metatileSize)] },
    group('Entities', entities),
    group('Zones', zones),
  ];
  tmj.nextlayerid = nextLayer;
  tmj.nextobjectid = nextObject;
  tmj.class = 'hirom_level';
  tmj.properties = [
    prop('snesBgMode', 1),
    prop('levelId', level.meta.id),
    prop('title', level.meta.title),
    prop('metatileSize', level.meta.metatileSize),
    prop('bgmTrackId', level.meta.bgmTrackId ?? ''),
    prop('bg3Priority', level.bg3Priority),
    prop('strictHardwareLimits', level.meta.strictHardwareLimits),
  ];
  return { tmj, images };
}

export const levelFileBase = (level: Level): string => fileSafe(level.meta.title);
