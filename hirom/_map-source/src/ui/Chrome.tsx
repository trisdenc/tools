import { useEffect, useRef } from 'react';
import type { MapEditor } from '../core/editor';
import { TOOLS } from '../core/editor';
import { SHAPE_LABELS, levelPixels, materialOf, shapeOf, makeCollision } from '../core/level';
import { Icon, TextInput, useFast } from './common';
import {
  exportLevelJson,
  exportPng,
  exportSnes,
  exportTiled,
  importLevelJson,
  newEmptyWorld,
  newStarterWorld,
  openWorkspace,
  saveWorkspace,
} from './files';

export function TopBar({ ed, onPlay }: { ed: MapEditor; onPlay: () => void }) {
  const fileRef = useRef<HTMLDetailsElement>(null);
  const exportRef = useRef<HTMLDetailsElement>(null);
  const close = (fn: () => unknown) => () => {
    if (fileRef.current) fileRef.current.open = false;
    if (exportRef.current) exportRef.current.open = false;
    fn();
  };
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      for (const d of [fileRef.current, exportRef.current]) if (d?.open && !d.contains(e.target as Node)) d.open = false;
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const o = ed.overlays;
  const tog = (k: keyof MapEditor['overlays'], label: string, title: string) => (
    <button className={`btn toggle${o[k] ? ' on' : ''}`} onClick={() => ed.toggleOverlay(k)} title={title}>
      {label}
    </button>
  );
  const strict = ed.level.meta.strictHardwareLimits;
  return (
    <header className="topbar">
      <a className="brand hirom-lockup" href="../" title="HiROM Studio home">
        <img src="../brand/map.svg" alt="" />
        <span className="names">
          <span className="hirom-suite">HiROM Studio</span>
          <span className="hirom-word">
            HiROM <span className="sub">Map</span>
          </span>
        </span>
      </a>
      <TextInput className="title-input" value={ed.ws.title} onChange={(v) => ((ed.ws.title = v || 'Untitled World'), ed.bump())} />
      <details className="menu" ref={fileRef}>
        <summary className="btn">File ▾</summary>
        <div className="menu-pop">
          <button onClick={close(() => openWorkspace(ed))}>Open workspace or level… (.hirommap / .json)</button>
          <button onClick={close(() => saveWorkspace(ed))}>Save workspace (.hirommap) · Ctrl+S</button>
          <div className="menu-label">New</div>
          <button onClick={close(() => newStarterWorld(ed))}>Starter world (demo level)</button>
          <button onClick={close(() => newEmptyWorld(ed))}>Empty workspace</button>
          <div className="menu-label">Level</div>
          <button onClick={close(() => importLevelJson(ed))}>Import level JSON…</button>
        </div>
      </details>
      <details className="menu" ref={exportRef}>
        <summary className="btn">Export ▾</summary>
        <div className="menu-pop">
          <div className="menu-label">Game engines</div>
          <button onClick={close(() => exportTiled(ed))}>Tiled map (.tmj + tileset PNGs, zip)</button>
          <button onClick={close(() => exportLevelJson(ed))}>Level JSON (HiROM schema)</button>
          <div className="menu-label">SNES hardware</div>
          <button onClick={close(() => exportSnes(ed))}>Nametables, metatiles, collision (.map/.bin + RLE/LZSS)</button>
          <div className="menu-label">Images</div>
          <button onClick={close(() => exportPng(ed, false))}>World PNG</button>
          <button onClick={close(() => exportPng(ed, true))}>World PNG with collision, entities and zones</button>
        </div>
      </details>
      <span className="sep" />
      <button className="btn icon" disabled={!ed.history.canUndo} onClick={() => ed.undo()} title="Undo (Ctrl+Z)">↶</button>
      <button className="btn icon" disabled={!ed.history.canRedo} onClick={() => ed.redo()} title="Redo (Ctrl+Shift+Z)">↷</button>
      <button className={`btn play${ed.playing ? ' on' : ''}`} onClick={onPlay} title="Playtest from the spawn point (tap Space), or from the cursor (Enter)">
        <Icon name={ed.playing ? 'stop' : 'play'} size={12} /> {ed.playing ? 'Stop' : 'Play'}
      </button>
      <span className="sep" />
      <button className="btn icon" onClick={() => ed.zoomAt(0.5, ed.view.width / 2, ed.view.height / 2)} title="Zoom out (-)">−</button>
      <span className="num zoom">{Math.round(ed.view.zoom * 100)}%</span>
      <button className="btn icon" onClick={() => ed.zoomAt(2, ed.view.width / 2, ed.view.height / 2)} title="Zoom in (+)">+</button>
      <button className="btn" onClick={() => ed.fitView()} title="Fit the level (0)">Fit</button>
      <span className="sep" />
      {tog('grid', 'Tiles', '8×8 tile grid on the active layer when zoomed in (#)')}
      {tog('metaGrid', 'Meta', 'Metatile grid')}
      {tog('screens', 'Screens', '256×224 NTSC screen boundaries')}
      {tog('collision', 'Collision', 'Collision overlay (K)')}
      {tog('priority', 'Priority', 'Highlight high-priority tiles on the active layer')}
      {tog('entities', 'Entities', 'Entities')}
      {tog('zones', 'Zones', 'Trigger and camera zones')}
      {tog('animate', 'Animate', 'Palette cycles and sprite animation in the editor')}
      <button className={`btn toggle${ed.par ? ' on' : ''}`} onClick={() => ((ed.par = !ed.par), ed.bump(false))} title="8:7 NTSC pixel aspect ratio in playtest">
        8:7
      </button>
      <span className="sep" />
      <span className="seg inline mode-switch" title="Strict SNES flags screens over the 64 KB VRAM / OAM budgets; Modern keeps the look without the ceilings">
        <button className={strict ? 'on' : ''} onClick={() => ed.changeLevel('Strict limits', () => (ed.level.meta.strictHardwareLimits = true))}>Strict SNES</button>
        <button className={!strict ? 'on' : ''} onClick={() => ed.changeLevel('Modern limits', () => (ed.level.meta.strictHardwareLimits = false))}>Modern</button>
      </span>
    </header>
  );
}

export function Toolbar({ ed }: { ed: MapEditor }) {
  return (
    <nav className="toolbar" aria-label="Tools">
      {TOOLS.map((t) => (
        <button key={t.id} className={`tool${ed.tool === t.id ? ' active' : ''}`} title={`${t.name} (${t.key})`} onClick={() => ed.setTool(t.id)}>
          <Icon name={t.id} />
        </button>
      ))}
      <div className="layer-chips" title="Active layer (1–3, Tab)">
        {ed.level.layers.map((l, i) => (
          <button key={l.id} className={`chip-layer${ed.activeLayer === i ? ' on' : ''}`} onClick={() => ed.setActiveLayer(i)}>
            {l.hwSlot.replace('BG', '')}
          </button>
        ))}
      </div>
    </nav>
  );
}

export function ToolOptions({ ed }: { ed: MapEditor }) {
  const t = ed.tool;
  const flips = (
    <>
      <label className="opt" title="Flip horizontally (H)">
        <input type="checkbox" checked={ed.flipH} onChange={(e) => ((ed.flipH = e.target.checked), ed.bump(false))} /> H flip
      </label>
      <label className="opt" title="Flip vertically (V)">
        <input type="checkbox" checked={ed.flipV} onChange={(e) => ((ed.flipV = e.target.checked), ed.bump(false))} /> V flip
      </label>
      <label className="opt" title="Set the priority bit, so tiles draw in front of sprites (P)">
        <input type="checkbox" checked={ed.forcePrio} onChange={(e) => ((ed.forcePrio = e.target.checked), ed.bump(false))} /> Priority
      </label>
    </>
  );
  const source = (
    <span className="seg inline">
      {(['metatile', 'tile', 'stamp'] as const).map((s) => (
        <button key={s} className={ed.brushSource === s ? 'on' : ''} onClick={() => ((ed.brushSource = s), ed.setDock(s === 'metatile' ? 'metatiles' : s === 'tile' ? 'tiles' : 'stamps'))}>
          {s === 'metatile' ? `Metatile ${ed.level.meta.metatileSize}×${ed.level.meta.metatileSize}` : s === 'tile' ? 'Tile 8×8' : 'Stamp'}
        </button>
      ))}
    </span>
  );
  const colLayer = ed.activeLayer === ed.level.collisionLayer;
  const autoCol = (
    <label className="opt" title="Painting metatiles on the collision layer also writes their collision">
      <input type="checkbox" checked={ed.autoCollision} disabled={!colLayer} onChange={(e) => ((ed.autoCollision = e.target.checked), ed.bump(false))} /> Paint collision
      {!colLayer && <span className="hint"> (only on {ed.level.layers[ed.level.collisionLayer].hwSlot})</span>}
    </label>
  );
  let body: JSX.Element;
  switch (t) {
    case 'brush':
    case 'fill':
    case 'rect':
    case 'eraser':
      body = (
        <>
          {source}
          {t !== 'eraser' && flips}
          {autoCol}
          <span className="hint">Right-click erases · Alt-click picks</span>
        </>
      );
      break;
    case 'select':
      body = (
        <>
          <span className="hint">Drag to select metatiles on the active layer.</span>
          <button className="btn small" disabled={!ed.selRect} onClick={() => ed.copySelection()}>Copy as stamp (Ctrl+C)</button>
          <button className="btn small" disabled={!ed.selRect} onClick={() => ed.clearSelection()}>Clear (Delete)</button>
        </>
      );
      break;
    case 'autotile':
      body = (
        <>
          <label className="opt">
            Terrain
            <select value={ed.terrainIndex} onChange={(e) => ((ed.terrainIndex = Number(e.target.value)), ed.bump(false))}>
              {ed.ws.terrains.map((tr, i) => (
                <option key={tr.id} value={i}>{tr.name}</option>
              ))}
            </select>
          </label>
          {autoCol}
          <span className="hint">Paint to grow the terrain; edges and corners resolve automatically. Right-click erases.</span>
        </>
      );
      break;
    case 'collision':
      body = (
        <>
          <label className="opt">
            Shape
            <select value={shapeOf(ed.collisionBrush)} onChange={(e) => ((ed.collisionBrush = makeCollision(Number(e.target.value), materialOf(ed.collisionBrush))), ed.bump(false))}>
              {SHAPE_LABELS.map((l, i) => (
                <option key={i} value={i}>{l}</option>
              ))}
            </select>
          </label>
          <label className="opt">
            Material
            <select value={materialOf(ed.collisionBrush)} onChange={(e) => ((ed.collisionBrush = makeCollision(shapeOf(ed.collisionBrush), Number(e.target.value))), ed.bump(false))}>
              <option value={0}>none</option>
              {ed.ws.materials.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
          <span className="hint">Paints on the {ed.level.meta.metatileSize}×{ed.level.meta.metatileSize} collision grid. Right-click clears · Alt-click picks.</span>
        </>
      );
      break;
    case 'entity':
      body = (
        <>
          <label className="opt">
            Place
            <select value={ed.templateId} onChange={(e) => ((ed.templateId = e.target.value), ed.bump(false))}>
              {ed.ws.templates.map((tp) => (
                <option key={tp.id} value={tp.id}>{tp.name}</option>
              ))}
            </select>
          </label>
          <span className="hint">Click empty space to place · drag to move (Shift = free, no 8 px snap) · Delete removes</span>
        </>
      );
      break;
    case 'zone':
      body = <span className="hint">Drag to draw a zone · drag a zone to move it · drag the corner handles of the selected zone to resize</span>;
      break;
    case 'path':
      body = <span className="hint">{ed.selectedEntity ? 'Click to add waypoints · drag to move · right-click deletes' : 'Select an entity with the Entities tool first.'}</span>;
      break;
    default:
      body = <span className="hint">Click a tile in the level to pick it up.</span>;
  }
  return (
    <div className="tool-options">
      <span className="opt-title">{TOOLS.find((x) => x.id === t)?.name}</span>
      {body}
    </div>
  );
}

export function StatusBar({ ed }: { ed: MapEditor }) {
  useFast(ed);
  const h = ed.hover;
  const level = ed.level;
  const ms = level.meta.metatileSize;
  const { w, h: hh } = levelPixels(level);
  let col = '';
  if (h && h.x >= 0 && h.y >= 0 && h.x < w && h.y < hh) {
    const c = level.collision[Math.floor(h.y / ms) * level.meta.widthMetatiles + Math.floor(h.x / ms)];
    if (c) col = `${SHAPE_LABELS[shapeOf(c)]}${materialOf(c) ? ' · ' + (ed.ws.materials.find((m) => m.id === materialOf(c))?.name ?? '') : ''}`;
  }
  return (
    <footer className="statusbar">
      <span>{level.meta.title}</span>
      <span>
        {level.meta.widthMetatiles}×{level.meta.heightMetatiles} metatiles · {w}×{hh} px · {Math.ceil(w / 256)}×{Math.ceil(hh / 224)} screens
      </span>
      <span>{ed.layer.hwSlot} {ed.layer.name}</span>
      {h && (
        <span className="mono">
          x {Math.floor(h.x)} y {Math.floor(h.y)} · tile {Math.floor(h.x / 8)},{Math.floor(h.y / 8)} · meta {Math.floor(h.x / ms)},{Math.floor(h.y / ms)}
        </span>
      )}
      {col && <span>{col}</span>}
      <span className="grow" />
      <span>{ed.history.undoCount} undo</span>
    </footer>
  );
}
