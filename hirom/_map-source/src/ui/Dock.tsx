import { useRef, useState } from 'react';
import type { Tileset } from '@pixel/core/project';
import { cellFlip, cellPal, cellPrio, cellTile, makeCell } from '@pixel/core/project';
import { tileCount } from '@pixel/core/tiles';
import { maskPicture, slotsFor, fillSlotsSequential } from '../core/autotile';
import type { DockTab, MapEditor } from '../core/editor';
import type { Metatile, MetatileSet } from '../core/level';
import { SHAPE_LABELS, makeCollision, materialOf, shapeOf } from '../core/level';
import type { MusicPlayer } from '../io/music';
import { NumInput, TextInput, Thumb } from './common';
import { AssetsPane, ValidatePane } from './DockAssets';
import { EntitiesPane, ZonesPane } from './DockObjects';
import { sheetCanvas, wordsCanvas } from './thumbs';

const TABS: { id: DockTab; label: string }[] = [
  { id: 'metatiles', label: 'Metatiles' },
  { id: 'tiles', label: 'Tiles' },
  { id: 'terrain', label: 'Terrain' },
  { id: 'stamps', label: 'Stamps' },
  { id: 'entities', label: 'Entities' },
  { id: 'zones', label: 'Zones' },
  { id: 'assets', label: 'Assets' },
  { id: 'validate', label: 'Budget' },
];

export function Dock({ ed, music }: { ed: MapEditor; music: MusicPlayer }) {
  return (
    <aside className="side map-dock">
      <div className="dock-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={ed.dock === t.id} className={ed.dock === t.id ? 'on' : ''} onClick={() => ed.setDock(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="dock-body">
        {ed.dock === 'metatiles' && <MetatilesPane ed={ed} />}
        {ed.dock === 'tiles' && <TilesPane ed={ed} />}
        {ed.dock === 'terrain' && <TerrainPane ed={ed} />}
        {ed.dock === 'stamps' && <StampsPane ed={ed} />}
        {ed.dock === 'entities' && <EntitiesPane ed={ed} />}
        {ed.dock === 'zones' && <ZonesPane ed={ed} />}
        {ed.dock === 'assets' && <AssetsPane ed={ed} music={music} />}
        {ed.dock === 'validate' && <ValidatePane ed={ed} />}
      </div>
    </aside>
  );
}

function NeedTiles({ ed }: { ed: MapEditor }) {
  if (!ed.source) return <p className="hint">No tiles are loaded for this level. Pick an asset source in the Assets tab.</p>;
  return <p className="hint">The active layer ({ed.layer.hwSlot}) has no tileset. Choose one in the Layers panel.</p>;
}

/** Tileset sheet with click-to-pick. */
export function TilesView({ ts, palette, cgram, selected, onPick, scale = 2 }: { ts: Tileset; palette: number; cgram: Uint16Array; selected: number; onPick: (t: number) => void; scale?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const n = tileCount(ts);
  const canvas = sheetCanvas(ts, palette, cgram, 1);
  return (
    <div className="dock-scroll tiles-view" ref={ref}>
      <div
        className="sheet"
        style={{ width: 128 * scale, height: (canvas.height) * scale }}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          const t = Math.floor((e.clientY - r.top) / (8 * scale)) * 16 + Math.floor((e.clientX - r.left) / (8 * scale));
          if (t >= 0 && t < n) onPick(t);
        }}
      >
        <Thumb src={canvas} size={0} width={128 * scale} height={canvas.height * scale} className="sheet-img" />
        <div className="sheet-sel" style={{ left: (selected % 16) * 8 * scale, top: Math.floor(selected / 16) * 8 * scale, width: 8 * scale, height: 8 * scale }} />
      </div>
    </div>
  );
}

function PaletteSelect({ bpp, value, onChange }: { bpp: number; value: number; onChange: (v: number) => void }) {
  if (bpp === 8) return null;
  return (
    <label className="opt">
      Palette
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {Array.from({ length: 8 }, (_, i) => (
          <option key={i} value={i}>{i}</option>
        ))}
      </select>
    </label>
  );
}

function MetatilesPane({ ed }: { ed: MapEditor }) {
  const ts = ed.tilesetFor();
  const src = ed.source;
  const [genPal, setGenPal] = useState(ts?.paletteId ?? 0);
  if (!ts || !src) return <div className="panel"><NeedTiles ed={ed} /></div>;
  const set = ed.setFor();
  const k = ed.k;
  if (!set) {
    const maps = src.tilemaps.filter((m) => `hirom_pixel:${m.tilesetId}` === ed.layer.tilesetRef);
    return (
      <div className="panel">
        <h2>Metatiles <span className="sub">{ts.name}</span></h2>
        <p className="hint">
          Levels are built from {ed.level.meta.metatileSize}×{ed.level.meta.metatileSize} metatiles: {k}×{k} groups of 8×8 tiles with their palettes, flips and a default collision. Make a set for "{ts.name}":
        </p>
        <div className="row">
          <PaletteSelect bpp={ts.bpp} value={genPal} onChange={setGenPal} />
          <button className="btn primary" onClick={() => ed.createSetFromSheet(ed.layer, genPal)}>From {k}×{k} blocks of the tileset</button>
        </div>
        <div className="row">
          <button className="btn" onClick={() => ed.createSetFromLevel()}>Collect the blocks used in this layer</button>
        </div>
        {maps.length > 0 && (
          <div className="row">
            <select id="pixel-map" defaultValue={maps[0].id}>
              {maps.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <button className="btn" onClick={() => ed.createSetFromPixelMap((document.getElementById('pixel-map') as HTMLSelectElement).value)}>Import from HiROM Pixel map</button>
          </div>
        )}
        <div className="row">
          <button className="btn" onClick={() => ed.createEmptySet()}>Start an empty set</button>
        </div>
      </div>
    );
  }
  const sel = ed.selectedMetatile(set);
  return (
    <>
      <div className="panel">
        <h2>
          Metatiles <span className="sub">{set.metatiles.length}</span>
          <span className="grow" />
          <button className="btn small" onClick={() => ed.addMetatile(set)} title="New metatile filled with the selected 8×8 tile">+ New</button>
        </h2>
        <div className="meta-grid">
          {set.metatiles.map((m) => (
            <button key={m.id} className={`meta-cell${sel?.id === m.id ? ' on' : ''}`} title={`${m.id} · ${m.name}${shapeOf(m.collision) ? ' · ' + SHAPE_LABELS[shapeOf(m.collision)] : ''}`} onClick={() => ed.selectMetatile(set, m.id)}>
              <Thumb src={wordsCanvas(ts, m.words, k, src.cgram)} size={34} />
              {shapeOf(m.collision) > 0 && <span className="meta-col" style={{ background: `var(--col-${shapeOf(m.collision)})` }} />}
            </button>
          ))}
        </div>
        <div className="row">
          <button className="btn small" onClick={() => ed.createSetFromLevel()} title="Add every block in this layer that isn't a metatile yet">Collect from layer</button>
          <button className="btn small" onClick={() => confirm(`Delete the set "${set.name}"? Painted tiles stay in the level.`) && ed.deleteSet(set.id)}>Delete set</button>
        </div>
      </div>
      {sel && <MetatileEditor ed={ed} set={set} m={sel} ts={ts} cgram={src.cgram} />}
    </>
  );
}

function MetatileEditor({ ed, set, m, ts, cgram }: { ed: MapEditor; set: MetatileSet; m: Metatile; ts: Tileset; cgram: Uint16Array }) {
  const k = ed.k;
  const [sub, setSub] = useState(0);
  const w = m.words[Math.min(sub, m.words.length - 1)] ?? 0;
  const setWord = (word: number) => {
    const words = m.words.slice();
    words[sub] = word;
    ed.updateMetatile(set.id, m.id, { words });
  };
  return (
    <div className="panel">
      <h2>
        #{m.id} <TextInput value={m.name} width={150} onChange={(v) => ed.updateMetatile(set.id, m.id, { name: v || m.name })} />
        <span className="grow" />
        {m.id !== 0 && (
          <button className="x" title="Delete metatile" onClick={() => ed.deleteMetatile(set.id, m.id)}>
            ×
          </button>
        )}
      </h2>
      <div className="row">
        <label className="opt">
          Collision
          <select value={shapeOf(m.collision)} onChange={(e) => ed.updateMetatile(set.id, m.id, { collision: makeCollision(Number(e.target.value), materialOf(m.collision)) })}>
            {SHAPE_LABELS.map((l, i) => (
              <option key={i} value={i}>{l}</option>
            ))}
          </select>
        </label>
        <select value={materialOf(m.collision)} title="Material" onChange={(e) => ed.updateMetatile(set.id, m.id, { collision: makeCollision(shapeOf(m.collision), Number(e.target.value)) })}>
          <option value={0}>no material</option>
          {ed.ws.materials.map((x) => (
            <option key={x.id} value={x.id}>{x.name}</option>
          ))}
        </select>
      </div>
      <div className="meta-edit">
        <div className="meta-quads" style={{ gridTemplateColumns: `repeat(${k}, 1fr)` }}>
          {m.words.map((word, i) => (
            <button key={i} className={`quad${i === sub ? ' on' : ''}`} onClick={() => setSub(i)} title={`Sub-tile ${i + 1}: tile ${cellTile(word)}, palette ${cellPal(word)}`}>
              <Thumb src={wordsCanvas(ts, [word], 1, cgram)} size={k === 2 ? 44 : 22} />
            </button>
          ))}
        </div>
        <div className="quad-opts">
          <div className="hint">Sub-tile {sub + 1} of {k * k}</div>
          <label className="opt">
            Tile <NumInput value={cellTile(w)} min={0} max={1023} width={56} onChange={(v) => setWord(makeCell(v, cellPal(w), cellPrio(w), cellFlip(w)))} />
          </label>
          {ts.bpp !== 8 && (
            <label className="opt">
              Palette
              <select value={cellPal(w)} onChange={(e) => setWord(makeCell(cellTile(w), Number(e.target.value), cellPrio(w), cellFlip(w)))}>
                {Array.from({ length: 8 }, (_, i) => (
                  <option key={i} value={i}>{i}</option>
                ))}
              </select>
            </label>
          )}
          <div className="row tight">
            <label><input type="checkbox" checked={!!(cellFlip(w) & 1)} onChange={() => setWord(w ^ 0x4000)} /> H</label>
            <label><input type="checkbox" checked={!!(cellFlip(w) & 2)} onChange={() => setWord(w ^ 0x8000)} /> V</label>
            <label title="Priority: draws in front of sprites"><input type="checkbox" checked={!!cellPrio(w)} onChange={() => setWord(w ^ 0x2000)} /> Prio</label>
          </div>
        </div>
      </div>
      <div className="hint">Click a tile to put it in sub-tile {sub + 1}:</div>
      <TilesView ts={ts} palette={cellPal(w)} cgram={cgram} selected={cellTile(w)} onPick={(t) => {
        setWord(makeCell(t, cellPal(w), cellPrio(w), cellFlip(w)));
        setSub((s) => (s + 1) % (k * k));
      }} />
    </div>
  );
}

function TilesPane({ ed }: { ed: MapEditor }) {
  const ts = ed.tilesetFor();
  const src = ed.source;
  if (!ts || !src) return <div className="panel"><NeedTiles ed={ed} /></div>;
  const w = ed.brushTileWord();
  return (
    <div className="panel">
      <h2>Tiles <span className="sub">{ts.name} · {ts.bpp}bpp · {tileCount(ts)} tiles</span></h2>
      <div className="row">
        <PaletteSelect bpp={ts.bpp} value={ed.tilePalette} onChange={(p) => ed.selectTile(cellTile(ed.tileWord), p)} />
        <Thumb src={wordsCanvas(ts, [w], 1, src.cgram, 4)} size={32} />
        <span className="mono">tile {cellTile(w)} · word ${w.toString(16).toUpperCase().padStart(4, '0')}</span>
      </div>
      <TilesView ts={ts} palette={ed.tilePalette} cgram={src.cgram} selected={cellTile(ed.tileWord)} onPick={(t) => ed.selectTile(t)} />
      <p className="hint">Paints single 8×8 tiles (words vhopppcc cccccccc). Use H / V / P for flips and priority. Tile painting doesn't change collision.</p>
    </div>
  );
}

function TerrainPane({ ed }: { ed: MapEditor }) {
  const src = ed.source;
  const t = ed.terrain;
  const set = t && ed.ws.metatileSets.find((s) => s.id === t.setId);
  const ts = set && src?.tilesets.find((x) => `hirom_pixel:${x.id}` === set.tilesetRef);
  const [first, setFirst] = useState(1);
  const sel = set && ed.selectedMetatile(set);
  return (
    <>
      <div className="panel">
        <h2>
          Terrains <span className="grow" />
          <button className="btn small" onClick={() => ed.createTerrain('blob47')} title="47-tile blob set (edges and inner corners)">+ 47-tile</button>
          <button className="btn small" onClick={() => ed.createTerrain('wang16')} title="16-tile Wang set (edges only)">+ 16-tile</button>
        </h2>
        {ed.ws.terrains.length === 0 && <p className="hint">A terrain lets one brush paint grass, walls, cliffs or water and picks the right edge and corner metatiles automatically.</p>}
        {ed.ws.terrains.map((tr, i) => (
          <div key={tr.id} className={`asset${i === ed.terrainIndex ? ' active' : ''}`}>
            <button className="asset-btn" onClick={() => ((ed.terrainIndex = i), ed.setTool('autotile'))}>
              <span className="asset-name">{tr.name}</span>
              <span className="asset-meta">
                {tr.kind === 'blob47' ? '47-tile blob' : '16-tile Wang'} · {Object.keys(tr.slots).length} slots set
              </span>
            </button>
            <button className="x" title="Delete terrain" onClick={() => confirm(`Delete "${tr.name}"?`) && ed.deleteTerrain(i)}>×</button>
          </div>
        ))}
      </div>
      {t && set && ts && src && (
        <div className="panel">
          <h2>
            <TextInput value={t.name} width={160} onChange={(v) => ed.updateTerrain(ed.terrainIndex, (x) => (x.name = v || x.name))} />
          </h2>
          <p className="hint">
            Click a slot to give it the selected metatile{sel ? ` (#${sel.id} ${sel.name})` : ''}. The pictures show which neighbours are the same terrain. Right-click a slot to clear it. Empty slots fall back to the nearest shape.
          </p>
          <div className={`slots ${t.kind}`}>
            {slotsFor(t).map((mask) => {
              const id = t.slots[mask];
              const m = id !== undefined ? set.metatiles.find((x) => x.id === id) : undefined;
              return (
                <button
                  key={mask}
                  className="slot"
                  title={`Mask ${mask}${m ? ` → #${m.id} ${m.name}` : ''}`}
                  onClick={() => sel && ed.updateTerrain(ed.terrainIndex, (x) => (x.slots[mask] = sel.id))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    ed.updateTerrain(ed.terrainIndex, (x) => delete x.slots[mask]);
                  }}
                >
                  <span className="mask">
                    {maskPicture(mask, t.kind).map((on, j) => (
                      <i key={j} className={on ? 'on' : ''} />
                    ))}
                  </span>
                  {m ? <Thumb src={wordsCanvas(ts, m.words, ed.k, src.cgram)} size={26} /> : <span className="slot-empty" />}
                </button>
              );
            })}
          </div>
          <div className="row">
            <span className="hint">Fill in order from metatile #</span>
            <NumInput value={first} min={0} width={56} onChange={setFirst} />
            <button className="btn small" onClick={() => ed.updateTerrain(ed.terrainIndex, (x) => fillSlotsSequential(x, first))}>Fill</button>
            <button className="btn small" onClick={() => ed.updateTerrain(ed.terrainIndex, (x) => (x.slots = {}))}>Clear</button>
          </div>
          <button className="btn wide primary" onClick={() => ed.setTool('autotile')}>Paint with this terrain (A)</button>
        </div>
      )}
      {t && (!set || !ts) && <div className="panel"><p className="warn">This terrain's metatile set or tileset isn't available in this level's assets.</p></div>}
    </>
  );
}

function StampsPane({ ed }: { ed: MapEditor }) {
  const src = ed.source;
  const [name, setName] = useState('');
  const thumb = (words: number[], w: number, ref: string) => {
    const ts = src?.tilesets.find((t) => `hirom_pixel:${t.id}` === ref);
    return src ? wordsCanvas(ts, words, w, src.cgram) : null;
  };
  return (
    <>
      <div className="panel">
        <h2>Clipboard</h2>
        {ed.clipboard ? (
          <>
            <div className={`stamp${ed.stampId === '__clipboard' ? ' on' : ''}`} onClick={() => ed.selectStamp('__clipboard')}>
              <Thumb src={thumb(ed.clipboard.words, ed.clipboard.w, ed.clipboard.tilesetRef)} size={Math.min(240, ed.clipboard.w * 8 * 2)} />
            </div>
            <div className="row">
              <input className="text" placeholder="Stamp name (tree, house…)" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn small primary" onClick={() => (ed.saveClipboardAsStamp(name || `Stamp ${ed.ws.stamps.length + 1}`), setName(''))}>Save to library</button>
            </div>
          </>
        ) : (
          <p className="hint">Use the Select tool (S) to drag over part of the level, then Copy as stamp (Ctrl+C) to reuse trees, houses and bridges.</p>
        )}
      </div>
      <div className="panel">
        <h2>Stamp library <span className="sub">{ed.ws.stamps.length}</span></h2>
        {ed.ws.stamps.map((s) => (
          <div key={s.id} className={`stamp-row${ed.stampId === s.id ? ' on' : ''}`}>
            <button className="stamp" onClick={() => ed.selectStamp(s.id)} title={`${s.w / ed.k}×${s.h / ed.k} metatiles`}>
              <Thumb src={thumb(s.words, s.w, s.tilesetRef)} size={64} />
            </button>
            <TextInput value={s.name} width={110} onChange={(v) => ed.changeWs('Rename stamp', 'stamps', () => (ed.ws.stamps.find((x) => x.id === s.id)!.name = v || s.name))} />
            <button className="x" title="Delete stamp" onClick={() => ed.changeWs('Delete stamp', 'stamps', () => (ed.ws.stamps = ed.ws.stamps.filter((x) => x.id !== s.id)))}>×</button>
          </div>
        ))}
      </div>
    </>
  );
}
