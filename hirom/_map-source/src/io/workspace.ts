import { base64ToBytes, bytesToBase64 } from '@pixel/io/project';
import { cellFlip, cellPal, cellPrio, cellTile } from '@pixel/core/project';
import type {
  Entity,
  EntityTemplate,
  HdmaBand,
  Level,
  MapLayer,
  MetatileSet,
  Props,
  Stamp,
  Terrain,
  Workspace,
  Zone,
} from './../core/level';
import {
  HW_SLOTS,
  SCHEMA_VERSION,
  SHAPE,
  SHAPE_NAMES,
  ZONE_TYPES,
  createLayer,
  createWorkspace,
  defaultTemplates,
  levelTiles,
  makeCollision,
  materialOf,
  pixelRef,
  refId,
  shapeOf,
  tilesPerMeta,
  uid,
} from './../core/level';

export const APP_NAME = 'HiROM Map';
export const FILE_EXT = 'hirommap';

// ---- typed arrays ------------------------------------------------------------------------------

export function u16ToBase64(a: Uint16Array): string {
  const b = new Uint8Array(a.length * 2);
  for (let i = 0; i < a.length; i++) {
    b[i * 2] = a[i] & 255;
    b[i * 2 + 1] = a[i] >> 8;
  }
  return bytesToBase64(b);
}

export function base64ToU16(s: string, n: number): Uint16Array {
  const b = base64ToBytes(s);
  const out = new Uint16Array(n);
  for (let i = 0; i < Math.min(n, b.length >> 1); i++) out[i] = b[i * 2] | (b[i * 2 + 1] << 8);
  return out;
}

const u8 = (s: string | undefined, n: number): Uint8Array => {
  const out = new Uint8Array(n);
  if (s) out.set(base64ToBytes(s).subarray(0, n));
  return out;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Number(v))) : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const props = (v: unknown): Props => {
  const out: Props = {};
  if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) if (['number', 'string', 'boolean'].includes(typeof x)) out[k] = x as never;
  return out;
};

// ---- workspace (.hirommap) ---------------------------------------------------------------------

function levelToJson(l: Level) {
  return {
    meta: { ...l.meta },
    pixelSourceId: l.pixelSourceId,
    layers: l.layers.map((y) => ({
      id: y.id,
      name: y.name,
      hwSlot: y.hwSlot,
      tilesetRef: y.tilesetRef,
      parallax: { ...y.parallax },
      hdmaBands: y.hdmaBands.map((b) => ({ ...b })),
      visible: y.visible,
      main: y.main,
      sub: y.sub,
      math: y.math,
      cells: u16ToBase64(y.cells),
      terrain: bytesToBase64(y.terrain),
    })),
    collision: bytesToBase64(l.collision),
    collisionLayer: l.collisionLayer,
    entities: l.entities,
    zones: l.zones,
    bg3Priority: l.bg3Priority,
    obj: { ...l.obj },
    colorMath: { ...l.colorMath },
    playtest: { ...l.playtest },
  };
}

function levelFromJson(j: Json): Level {
  const size = j.meta?.metatileSize === 32 ? 32 : 16;
  const W = num(j.meta?.widthMetatiles, 16, 1, 512) | 0, H = num(j.meta?.heightMetatiles, 14, 1, 512) | 0;
  const k = tilesPerMeta(size);
  const layers: MapLayer[] = HW_SLOTS.map((slot, i) => {
    const s = (j.layers ?? [])[i] ?? {};
    const base = createLayer(slot, W * k, H * k, W, H, s.tilesetRef ?? null);
    return {
      ...base,
      id: str(s.id, base.id),
      name: str(s.name, base.name),
      parallax: { x: num(s.parallax?.x, base.parallax.x, -4, 4), y: num(s.parallax?.y, base.parallax.y, -4, 4) },
      hdmaBands: readBands(s.hdmaBands),
      visible: s.visible !== false,
      main: s.main !== false,
      sub: !!s.sub,
      math: !!s.math,
      cells: s.cells ? base64ToU16(s.cells, W * k * H * k) : base.cells,
      terrain: u8(s.terrain, W * H),
    };
  });
  return {
    meta: {
      id: str(j.meta?.id, uid('lvl')),
      title: str(j.meta?.title, 'Untitled Level'),
      bgMode: 1,
      tileSize: 8,
      metatileSize: size,
      widthMetatiles: W,
      heightMetatiles: H,
      bgmTrackId: j.meta?.bgmTrackId ?? null,
      strictHardwareLimits: j.meta?.strictHardwareLimits !== false,
    },
    pixelSourceId: str(j.pixelSourceId, 'pixel_live'),
    layers,
    collision: u8(j.collision, W * H),
    collisionLayer: num(j.collisionLayer, 0, 0, 2) | 0,
    entities: (j.entities ?? []).map(readEntity),
    zones: (j.zones ?? []).map(readZone),
    bg3Priority: !!j.bg3Priority,
    obj: { main: j.obj?.main !== false, sub: !!j.obj?.sub },
    colorMath: {
      mode: j.colorMath?.mode === 'sub' ? 'sub' : 'add',
      half: j.colorMath?.half !== false,
      source: j.colorMath?.source === 'fixed' ? 'fixed' : 'subscreen',
      fixedColor: num(j.colorMath?.fixedColor, 0, 0, 0x7fff) | 0,
      backdropMath: !!j.colorMath?.backdropMath,
    },
    playtest: { mode: ['platformer', 'topdown', 'camera'].includes(j.playtest?.mode) ? j.playtest.mode : 'platformer' },
  };
}

const readBands = (v: unknown): HdmaBand[] =>
  Array.isArray(v)
    ? v
        .filter((b) => b && Number.isFinite(b.startY) && Number.isFinite(b.endY))
        .map((b) => ({ startY: num(b.startY, 0, 0, 223) | 0, endY: num(b.endY, 223, 0, 223) | 0, scrollX: num(b.scrollX, 1, -8, 8) }))
    : [];

function readEntity(e: Json): Entity {
  return {
    id: str(e.id, uid('ent')),
    templateId: e.templateId ?? null,
    type: e.type ?? null,
    spriteRef: e.spriteRef ?? null,
    x: num(e.x, 0) | 0,
    y: num(e.y, 0) | 0,
    hFlip: !!e.hFlip,
    priority: (num(e.priority, 2, 0, 3) | 0) as Entity['priority'],
    properties: props(e.properties),
    path: Array.isArray(e.path) ? e.path.filter((p: Json) => Number.isFinite(p?.x) && Number.isFinite(p?.y)).map((p: Json) => ({ x: p.x | 0, y: p.y | 0 })) : [],
  };
}

function readZone(z: Json): Zone {
  return {
    id: str(z.id, uid('zone')),
    name: str(z.name, 'Zone'),
    type: ZONE_TYPES.includes(z.type) ? z.type : 'TRIGGER',
    x: num(z.x, 0) | 0,
    y: num(z.y, 0) | 0,
    width: Math.max(8, num(z.width, 256) | 0),
    height: Math.max(8, num(z.height, 224) | 0),
    onEnterBgm: z.onEnterBgm ?? null,
    event: str(z.event),
    properties: props(z.properties),
  };
}

export interface WorkspaceFile {
  ws: Workspace;
  soundFiles: Map<string, Uint8Array>;
}

export function serializeWorkspace(ws: Workspace, soundFiles?: Map<string, Uint8Array>) {
  return {
    schemaVersion: SCHEMA_VERSION,
    app: APP_NAME,
    title: ws.title,
    activeLevel: ws.activeLevel,
    levels: ws.levels.map(levelToJson),
    metatileSets: ws.metatileSets,
    terrains: ws.terrains,
    stamps: ws.stamps,
    templates: ws.templates,
    materials: ws.materials,
    pixelSources: ws.pixelSources,
    soundSources: ws.soundSources.map((s) => ({
      ...s,
      ...(s.kind === 'file' && soundFiles?.get(s.id) ? { fileBase64: bytesToBase64(soundFiles.get(s.id)!) } : {}),
    })),
  };
}

export function parseWorkspace(data: unknown): WorkspaceFile {
  const j = data as Json;
  if (!j || typeof j !== 'object') throw new Error('Not a HiROM Map workspace.');
  if (typeof j.schemaVersion !== 'string' || !j.schemaVersion.startsWith('1.')) throw new Error(`Unsupported workspace version ${String(j.schemaVersion)}.`);
  if (!Array.isArray(j.levels)) throw new Error('This file has no levels. (Single levels are opened with "Import level JSON".)');
  const ws = createWorkspace();
  ws.title = str(j.title, 'Untitled World');
  ws.levels = j.levels.map(levelFromJson);
  ws.activeLevel = num(j.activeLevel, 0, 0, Math.max(0, ws.levels.length - 1)) | 0;
  ws.metatileSets = (j.metatileSets ?? []).map(readSet);
  ws.terrains = (j.terrains ?? []).map(readTerrain);
  ws.stamps = (j.stamps ?? []).map(readStamp);
  ws.templates = Array.isArray(j.templates) && j.templates.length ? j.templates.map(readTemplate) : defaultTemplates();
  if (Array.isArray(j.materials)) ws.materials = j.materials.map((m: Json) => ({ id: num(m.id, 1, 1, 15) | 0, name: str(m.name, 'material'), color: str(m.color, '#ffffff') }));
  for (const s of j.pixelSources ?? []) {
    if (ws.pixelSources.some((x) => x.id === s.id)) continue;
    if (s.kind === 'file' && s.json) ws.pixelSources.push({ id: str(s.id, uid('pxs')), name: str(s.name, 'Pixel project'), kind: 'file', json: s.json });
  }
  const soundFiles = new Map<string, Uint8Array>();
  for (const s of j.soundSources ?? []) {
    if (ws.soundSources.some((x) => x.id === s.id)) continue;
    if (s.kind === 'file' && s.fileBase64) {
      const id = str(s.id, uid('snd'));
      ws.soundSources.push({ id, name: str(s.name, 'Sound project'), kind: 'file' });
      soundFiles.set(id, base64ToBytes(s.fileBase64));
    }
  }
  return { ws, soundFiles };
}

const readSet = (s: Json): MetatileSet => ({
  id: str(s.id, uid('mts')),
  name: str(s.name, 'Metatiles'),
  tilesetRef: str(s.tilesetRef),
  size: s.size === 32 ? 32 : 16,
  metatiles: (s.metatiles ?? []).map((m: Json) => ({
    id: num(m.id, 0) | 0,
    name: str(m.name, 'Metatile'),
    words: (m.words ?? []).map((w: number) => w & 0xffff),
    collision: num(m.collision, 0, 0, 255) | 0,
  })),
});

const readTerrain = (t: Json): Terrain => ({
  id: str(t.id, uid('ter')),
  name: str(t.name, 'Terrain'),
  setId: str(t.setId),
  kind: t.kind === 'wang16' ? 'wang16' : 'blob47',
  slots: Object.fromEntries(Object.entries(t.slots ?? {}).map(([k, v]) => [Number(k), Number(v)])),
});

const readStamp = (s: Json): Stamp => ({
  id: str(s.id, uid('stamp')),
  name: str(s.name, 'Stamp'),
  tilesetRef: str(s.tilesetRef),
  w: num(s.w, 1, 1, 1024) | 0,
  h: num(s.h, 1, 1, 1024) | 0,
  words: (s.words ?? []).map((w: number) => w & 0xffff),
  collision: (s.collision ?? []).map((c: number) => c & 255),
});

const readTemplate = (t: Json): EntityTemplate => ({
  id: str(t.id, uid('tpl')),
  name: str(t.name, 'Template'),
  type: str(t.type, 'entity'),
  spriteRef: t.spriteRef ?? null,
  width: num(t.width, 16, 1, 512) | 0,
  height: num(t.height, 16, 1, 512) | 0,
  color: str(t.color, '#ffffff'),
  properties: props(t.properties),
});

// ---- single level, spec schema (§3) --------------------------------------------------------------

const SLOPE_NAMES: Record<number, string> = { [SHAPE.SLOPE_UP]: '45_UP', [SHAPE.SLOPE_DOWN]: '45_DOWN' };

/** One level in the spec's JSON schema, with HiROM extensions (collision layer, materials, terrain). */
export function levelToSpecJson(l: Level, ws: Workspace) {
  const { w: tw, h: th } = levelTiles(l);
  const tilesetRefs = l.layers.map((y) => y.tilesetRef).filter((r): r is string => !!r);
  const sets = ws.metatileSets.filter((s) => tilesetRefs.includes(s.tilesetRef) && s.size === l.meta.metatileSize);
  const matName = (c: number) => ws.materials.find((m) => m.id === materialOf(c))?.name ?? null;
  return {
    schemaVersion: SCHEMA_VERSION,
    generator: APP_NAME,
    meta: { ...l.meta, widthTiles: tw, heightTiles: th },
    assets: {
      cgramRef: pixelRef(l.pixelSourceId),
      tilesetRefs: [...new Set(tilesetRefs)],
    },
    metatiles: sets.flatMap((set) =>
      set.metatiles.map((m) => {
        const sh = shapeOf(m.collision);
        return {
          id: m.id,
          setId: set.id,
          tilesetRef: set.tilesetRef,
          name: m.name,
          subtiles: m.words.map((w) => ({ tileId: cellTile(w), pal: cellPal(w), hFlip: !!(cellFlip(w) & 1), vFlip: !!(cellFlip(w) & 2), prio: cellPrio(w) })),
          collision: SLOPE_NAMES[sh] ? 'SOLID' : SHAPE_NAMES[sh],
          slope: SLOPE_NAMES[sh] ?? 'NONE',
          material: matName(m.collision),
        };
      }),
    ),
    layers: [
      ...l.layers.map((y) => ({
        id: y.id,
        name: y.name,
        type: 'TILE_LAYER',
        hwSlot: y.hwSlot,
        tilesetRef: y.tilesetRef,
        parallax: { ...y.parallax },
        hdmaBands: y.hdmaBands.map((b) => ({ ...b })),
        visible: y.visible,
        screens: { main: y.main, sub: y.sub, colorMath: y.math },
        encoding: 'base64_u16',
        data: u16ToBase64(y.cells),
      })),
      {
        id: 'collision',
        type: 'COLLISION_LAYER',
        cellSize: l.meta.metatileSize,
        encoding: 'base64_u8',
        legend: { shapes: SHAPE_NAMES, materials: ws.materials.map((m) => ({ id: m.id, name: m.name })) },
        data: bytesToBase64(l.collision),
      },
    ],
    entities: l.entities.map((e) => {
      const t = e.templateId ? ws.templates.find((x) => x.id === e.templateId) : undefined;
      return {
        id: e.id,
        type: e.type ?? t?.type ?? 'entity',
        templateId: e.templateId,
        spriteRef: e.spriteRef ?? t?.spriteRef ?? null,
        x: e.x,
        y: e.y,
        hFlip: e.hFlip,
        priority: e.priority,
        properties: { ...(t?.properties ?? {}), ...e.properties },
        path: e.path,
      };
    }),
    zones: l.zones.map((z) => ({ ...z })),
    display: { bg3Priority: l.bg3Priority, obj: { ...l.obj }, colorMath: { ...l.colorMath } },
  };
}

/** Import a level saved with levelToSpecJson (or hand-written to the spec schema). */
export function levelFromSpecJson(data: unknown, ws: Workspace): Level {
  const j = data as Json;
  if (!j?.meta || !Array.isArray(j.layers)) throw new Error('Not a HiROM Map level file.');
  const tileLayers = j.layers.filter((y: Json) => y.type === 'TILE_LAYER');
  const internal = {
    meta: j.meta,
    pixelSourceId: refId(j.assets?.cgramRef) ?? 'pixel_live',
    layers: HW_SLOTS.map((slot) => {
      const y = tileLayers.find((x: Json) => x.hwSlot === slot) ?? {};
      return { ...y, cells: y.data, main: y.screens?.main, sub: y.screens?.sub, math: y.screens?.colorMath };
    }),
    collision: j.layers.find((y: Json) => y.type === 'COLLISION_LAYER')?.data,
    entities: (j.entities ?? []).map((e: Json) => ({
      ...e,
      templateId: e.templateId ?? ws.templates.find((t) => t.type === e.type)?.id ?? null,
    })),
    zones: j.zones,
    bg3Priority: j.display?.bg3Priority,
    obj: j.display?.obj,
    colorMath: j.display?.colorMath,
  };
  const level = levelFromJson(internal);
  level.meta.id = uid('lvl');
  // Metatiles that came with the file and aren't in the workspace yet
  for (const m of j.metatiles ?? []) {
    if (!m.tilesetRef || !Array.isArray(m.subtiles)) continue;
    let set = ws.metatileSets.find((s) => s.id === m.setId) ?? ws.metatileSets.find((s) => s.tilesetRef === m.tilesetRef && s.size === level.meta.metatileSize);
    if (!set) {
      set = { id: m.setId ?? uid('mts'), name: 'Imported metatiles', tilesetRef: m.tilesetRef, size: level.meta.metatileSize, metatiles: [] };
      ws.metatileSets.push(set);
    }
    if (set.metatiles.some((x) => x.id === m.id)) continue;
    const shape = m.slope === '45_UP' ? SHAPE.SLOPE_UP : m.slope === '45_DOWN' ? SHAPE.SLOPE_DOWN : Math.max(0, SHAPE_NAMES.indexOf(m.collision));
    const mat = ws.materials.find((x) => x.name === m.material)?.id ?? 0;
    set.metatiles.push({
      id: m.id | 0,
      name: str(m.name, 'Metatile'),
      words: m.subtiles.map((s: Json) => (s.tileId & 0x3ff) | ((s.pal & 7) << 10) | ((s.prio & 1) << 13) | (s.hFlip ? 0x4000 : 0) | (s.vFlip ? 0x8000 : 0)),
      collision: makeCollision(shape, mat),
    });
  }
  return level;
}
