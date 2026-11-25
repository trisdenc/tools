import { describe, expect, it } from 'vitest';
import { cellTile } from '@pixel/core/project';
import { tileCount } from '@pixel/core/tiles';
import { BLOB47, E, N, NE, S, W, pickMetatile, reduceBlob, wangIndex } from './autotile';
import { lzssCompress, lzssDecompress, rleCompress, rleDecompress } from './compress';
import { SHAPE, levelPixels, levelTiles, makeCollision, shapeOf } from './level';
import { floodMeta, flipMetaWords, metatilesFromSheet, readMeta } from './metatiles';
import { createBody, stepPlatformer, stepTopDown, worldOf, type Input } from './physics';
import { STARTER_IDS, starterAssets, starterWorkspace } from './starter';
import { objectsFor, validateLevel } from './validator';
import { levelFromSpecJson, levelToSpecJson, parseWorkspace, serializeWorkspace } from '../io/workspace';
import { buildLevelTmj } from '../io/tmj';
import { buildSnesExport, screenChunks } from '../io/snes';

const idle: Input = { left: false, right: false, up: false, down: false, jump: false, jumpPressed: false, run: false };

describe('autotile', () => {
  it('collapses 256 neighbour masks to the 47 blob shapes', () => {
    expect(BLOB47.length).toBe(47);
    for (let m = 0; m < 256; m++) expect(reduceBlob(reduceBlob(m))).toBe(reduceBlob(m));
    // A corner without both of its edges is invisible
    expect(reduceBlob(NE)).toBe(0);
    expect(reduceBlob(N | E | NE)).toBe(N | E | NE);
  });
  it('maps edges to Wang indices and falls back when a slot is empty', () => {
    expect(wangIndex(N | E | S | W)).toBe(15);
    expect(wangIndex(N | W)).toBe(9);
    const t = { id: 't', name: 't', setId: 's', kind: 'blob47' as const, slots: { 255: 7, [N | S]: 3 } };
    expect(pickMetatile(t, N | S)).toBe(3);
    expect(pickMetatile(t, N | S | NE)).toBe(3); // corner dropped
    expect(pickMetatile(t, E)).toBe(7); // falls back to the centre
  });
});

describe('compression', () => {
  const samples = [
    new Uint8Array(0),
    new Uint8Array(5000),
    Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) & 255),
    Uint8Array.from({ length: 4000 }, (_, i) => ((i * 2654435761) >>> 13) & 255),
    Uint8Array.from({ length: 70000 }, (_, i) => (i % 97 < 40 ? 0 : i & 31)),
  ];
  it('RLE round-trips', () => {
    for (const s of samples) expect(rleDecompress(rleCompress(s))).toEqual(s);
  });
  it('LZSS round-trips and shrinks repetitive data', () => {
    for (const s of samples) expect(lzssDecompress(lzssCompress(s))).toEqual(s);
    expect(lzssCompress(samples[1]).length).toBeLessThan(800);
  });
});

describe('starter kit', () => {
  const ws = starterWorkspace();
  const level = ws.levels[0];
  const { project } = starterAssets();

  it('builds valid tilesets, sprites and a playable level', () => {
    for (const ts of project.tilesets) expect(tileCount(ts)).toBeLessThanOrEqual(1024);
    expect(project.sprites.map((s) => s.id)).toEqual([STARTER_IDS.hero, STARTER_IDS.slime, STARTER_IDS.coin]);
    expect(levelPixels(level)).toEqual({ w: 1792, h: 224 });
    expect(level.entities.some((e) => e.templateId === 'tpl_player')).toBe(true);
    // Ground under the spawn point is solid
    expect(shapeOf(level.collision[11 * level.meta.widthMetatiles + 2])).toBe(SHAPE.SOLID);
  });

  it('auto-generates metatiles from a sheet and flood-fills over matching cells', () => {
    const ground = project.tilesets.find((t) => t.id === STARTER_IDS.ground)!;
    expect(metatilesFromSheet(ground, 16, 0).length).toBe(15);
    const sky = floodMeta(level, 0, 0, 0);
    expect(sky.length).toBeGreaterThan(500);
    expect(sky.every(([x, y]) => readMeta(level.layers[0], levelTiles(level).w, x, y, 2).every((w) => w === 0))).toBe(true);
  });

  it('passes the strict screen budget', () => {
    const r = validateLevel(level, project, ws.templates);
    expect(r.windows).toBeGreaterThan(20);
    expect(r.issues).toEqual([]);
    expect(r.worst.vram).toBeLessThan(65536);
  });

  it('flips metatiles by swapping sub-tiles and toggling flip bits', () => {
    const f = flipMetaWords([1, 2, 3, 4], 2, true, false);
    expect(f.map(cellTile)).toEqual([2, 1, 4, 3]);
    expect(f.every((w) => (w & 0x4000) !== 0)).toBe(true);
  });
});

describe('validator', () => {
  it('splits sprites into 16×16 hardware objects', () => {
    expect(objectsFor(16, 24)).toEqual({ total: 2, perRow: 1 });
    expect(objectsFor(32, 32)).toEqual({ total: 4, perRow: 2 });
  });
  it('flags too many sprites on one scanline', () => {
    const ws = starterWorkspace();
    const level = ws.levels[0];
    for (let i = 0; i < 40; i++)
      level.entities.push({ id: `e${i}`, templateId: 'tpl_enemy', type: null, spriteRef: null, x: 8 + i * 6, y: 100, hFlip: false, priority: 2, properties: {}, path: [] });
    const r = validateLevel(level, starterAssets().project, ws.templates);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues[0].problems.join()).toMatch(/one line/);
  });
});

describe('physics', () => {
  const ws = starterWorkspace();
  const level = ws.levels[0];
  const world = worldOf(level, ws.materials);

  it('falls and lands on solid ground', () => {
    const b = createBody(32, 100);
    for (let i = 0; i < 120; i++) stepPlatformer(b, idle, world);
    expect(b.onGround).toBe(true);
    expect(b.y + b.h).toBeCloseTo(176, 0);
  });

  it('walks up a 45° slope', () => {
    const b = createBody(16 * 20, 100);
    for (let i = 0; i < 60; i++) stepPlatformer(b, idle, world);
    const startY = b.y;
    for (let i = 0; i < 90; i++) stepPlatformer(b, { ...idle, right: true }, world);
    expect(b.x).toBeGreaterThan(16 * 24);
    expect(b.y).toBeLessThan(startY - 10);
  });

  it('lands on a one-way platform from above but jumps through it from below', () => {
    const b = createBody(16 * 37, 60);
    for (let i = 0; i < 120; i++) stepPlatformer(b, idle, world);
    expect(b.y + b.h).toBeCloseTo(7 * 16, 0);
  });

  it('reports hazards', () => {
    const b = createBody(16 * 59, 130);
    let res = 'ok';
    for (let i = 0; i < 60 && res === 'ok'; i++) res = stepPlatformer(b, idle, world);
    expect(res).toBe('hazard');
  });

  it('blocks top-down movement at solid cells', () => {
    const b = createBody(16 * 31, 16 * 9 + 2, 12, 12); // level with the brick wall at x 33–34, rows 9–10
    for (let i = 0; i < 60; i++) stepTopDown(b, { ...idle, right: true }, world);
    expect(b.x + b.w).toBeLessThanOrEqual(16 * 33 + 0.01);
  });
});

describe('files', () => {
  it('round-trips a workspace', () => {
    const ws = starterWorkspace();
    ws.levels[0].collision[5] = makeCollision(SHAPE.LADDER, 2);
    const back = parseWorkspace(JSON.parse(JSON.stringify(serializeWorkspace(ws)))).ws;
    expect(back.levels[0].layers[0].cells).toEqual(ws.levels[0].layers[0].cells);
    expect(back.levels[0].collision).toEqual(ws.levels[0].collision);
    expect(back.levels[0].entities).toEqual(ws.levels[0].entities);
    expect(back.levels[0].layers[2].hdmaBands).toEqual(ws.levels[0].layers[2].hdmaBands);
    expect(back.metatileSets).toEqual(ws.metatileSets);
    expect(back.terrains).toEqual(ws.terrains);
  });

  it('round-trips a level through the spec schema', () => {
    const ws = starterWorkspace();
    const level = ws.levels[0];
    const json = JSON.parse(JSON.stringify(levelToSpecJson(level, ws)));
    expect(json.layers[0]).toMatchObject({ type: 'TILE_LAYER', hwSlot: 'BG1', encoding: 'base64_u16' });
    expect(json.metatiles.find((m: { name: string }) => m.name === 'Slope ◢')).toMatchObject({ collision: 'SOLID', slope: '45_UP' });
    const back = levelFromSpecJson(json, ws);
    expect(back.layers[0].cells).toEqual(level.layers[0].cells);
    expect(back.collision).toEqual(level.collision);
    expect(back.entities.length).toBe(level.entities.length);
  });

  it('cuts nametables into 32×32 screens', () => {
    const cells = new Uint16Array(64 * 32);
    cells[1 * 64 + 33] = 0x1234;
    const { data, cols, rows } = screenChunks(cells, 64, 32);
    expect([cols, rows]).toEqual([2, 1]);
    const o = (1024 + 1 * 32 + 1) * 2;
    expect(data[o] | (data[o + 1] << 8)).toBe(0x1234);
  });

  it('exports SNES binaries and Tiled JSON', () => {
    const ws = starterWorkspace();
    const level = ws.levels[0];
    const files = buildSnesExport(level, ws).map((f) => f.name);
    expect(files).toContain('starter_hills_-_act_1_bg1.map');
    expect(files).toContain('starter_hills_-_act_1_bg1_metamap.bin');
    expect(files.some((n) => n.endsWith('.lzss'))).toBe(true);
    const { tmj, images } = buildLevelTmj(level, ws, starterAssets().project);
    const layers = tmj.layers as { name: string; type: string; objects?: unknown[]; parallaxx?: number }[];
    expect(layers.map((l) => l.name)).toEqual(['BG3 Far / HUD', 'BG2 Background', 'BG1 Main', 'Collision', 'Entities', 'Zones']);
    expect(layers.find((l) => l.name === 'Entities')!.objects!.length).toBe(level.entities.length);
    expect(layers[0].parallaxx).toBe(0.25);
    expect(images.some((i) => i.name === 'collision_legend.png')).toBe(true);
  });
});
