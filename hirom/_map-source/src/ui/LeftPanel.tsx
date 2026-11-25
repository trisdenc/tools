import { useState } from 'react';
import type { MapEditor } from '../core/editor';
import type { MetatileSize, PlaytestMode } from '../core/level';
import { MAX_METATILES_PER_SIDE, refId, soundRef } from '../core/level';
import { NumInput, TextInput } from './common';

export function LeftPanel({ ed }: { ed: MapEditor }) {
  const [creating, setCreating] = useState(false);
  return (
    <aside className="assets map-left">
      <div className="panel">
        <h2>
          Levels <span className="grow" />
          <button className="btn small" onClick={() => setCreating(true)}>+ New</button>
        </h2>
        <div className="level-list">
          {ed.ws.levels.map((l, i) => (
            <button key={l.meta.id} className={`level-item${i === ed.ws.activeLevel ? ' active' : ''}`} onClick={() => ed.setActiveLevel(i)}>
              <span className="asset-name">{l.meta.title}</span>
              <span className="asset-meta">
                {l.meta.widthMetatiles}×{l.meta.heightMetatiles} · {l.entities.length} entities
              </span>
            </button>
          ))}
        </div>
        <div className="row">
          <button className="btn small" onClick={() => ed.duplicateLevel()}>Duplicate</button>
          <button className="btn small" onClick={() => confirm(`Delete "${ed.level.meta.title}"?`) && ed.deleteLevel()}>Delete</button>
        </div>
      </div>
      <LayersPanel ed={ed} />
      <LevelSettings ed={ed} />
      {creating && <NewLevelDialog ed={ed} onClose={() => setCreating(false)} />}
    </aside>
  );
}

function LayersPanel({ ed }: { ed: MapEditor }) {
  const level = ed.level;
  const src = ed.source;
  const [bandsFor, setBandsFor] = useState<number | null>(null);
  return (
    <div className="panel">
      <h2>Layers <span className="sub">Mode 1</span></h2>
      {level.layers.map((l, i) => {
        const want = l.hwSlot === 'BG3' ? 2 : 4;
        const options = (src?.tilesets ?? []).filter((t) => t.bpp === want);
        const missing = ed.missingTiles(l);
        return (
          <div key={l.id} className={`map-layer${i === ed.activeLayer ? ' active' : ''}`}>
            <div className="row tight">
              <input type="radio" name="active-layer" checked={i === ed.activeLayer} onChange={() => ed.setActiveLayer(i)} title="Edit this layer" />
              <button className="layer-name" onClick={() => ed.setActiveLayer(i)}>
                {l.hwSlot}
              </button>
              <TextInput value={l.name} width={80} onChange={(v) => ed.changeLevel('Rename layer', () => (l.name = v || l.hwSlot))} />
              <label title="Visible">
                <input type="checkbox" checked={l.visible} onChange={(e) => ed.changeLevel('Layer visibility', () => (l.visible = e.target.checked))} />
              </label>
            </div>
            <div className="row tight">
              <select value={refId(l.tilesetRef) ?? ''} onChange={(e) => ed.setLayerTileset(i, e.target.value)} title={`${want}bpp tileset from HiROM Pixel`}>
                <option value="">— no tiles —</option>
                {options.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} ({t.bpp}bpp)</option>
                ))}
              </select>
            </div>
            {missing > 0 && <div className="warn">{missing} cells point past the end of this tileset.</div>}
            <div className="row tight">
              <span className="hint" title="Scroll speed relative to the camera">Parallax</span>
              x <NumInput value={l.parallax.x} step={0.05} min={-4} max={4} width={52} onChange={(v) => ed.changeLevel('Parallax', () => (l.parallax.x = v))} />
              y <NumInput value={l.parallax.y} step={0.05} min={-4} max={4} width={52} onChange={(v) => ed.changeLevel('Parallax', () => (l.parallax.y = v))} />
            </div>
            <div className="row tight screens">
              {(['main', 'sub', 'math'] as const).map((k) => (
                <label key={k} title={k === 'main' ? 'On the main screen' : k === 'sub' ? 'On the sub screen (color-math source)' : 'Apply color math where this layer is on top'}>
                  <input type="checkbox" checked={l[k]} onChange={(e) => ed.changeLevel('Layer screens', () => (l[k] = e.target.checked))} /> {k}
                </label>
              ))}
              <button className={`btn small${bandsFor === i ? ' on' : ''}`} onClick={() => setBandsFor(bandsFor === i ? null : i)} title="HDMA parallax bands">
                HDMA {l.hdmaBands.length ? `(${l.hdmaBands.length})` : ''}
              </button>
            </div>
            {bandsFor === i && (
              <div className="bands">
                <div className="hint">Scanline bands with their own horizontal scroll, like the classic SNES split-parallax trick. Rows outside every band use parallax x.</div>
                {l.hdmaBands.map((b, j) => (
                  <div className="row tight" key={j}>
                    <NumInput value={b.startY} min={0} max={223} width={46} onChange={(v) => ed.updateBand(i, j, { startY: v | 0 })} />–
                    <NumInput value={b.endY} min={0} max={223} width={46} onChange={(v) => ed.updateBand(i, j, { endY: v | 0 })} />
                    ×<NumInput value={b.scrollX} min={-8} max={8} step={0.05} width={52} onChange={(v) => ed.updateBand(i, j, { scrollX: v })} />
                    <button className="x" onClick={() => ed.removeBand(i, j)} title="Remove band">×</button>
                  </div>
                ))}
                <button className="btn small" onClick={() => ed.addBand(i)}>+ Band</button>
              </div>
            )}
          </div>
        );
      })}
      <label className="row tight" title="$2105 bit 3: BG3 high-priority tiles appear in front of everything (HUDs)">
        <input type="checkbox" checked={level.bg3Priority} onChange={(e) => ed.changeLevel('BG3 priority', () => (level.bg3Priority = e.target.checked))} /> BG3 on top
      </label>
      <div className="row tight">
        <span className="hint">Color math</span>
        <select value={level.colorMath.mode} onChange={(e) => ed.changeLevel('Color math', () => (level.colorMath.mode = e.target.value as 'add' | 'sub'))}>
          <option value="add">add</option>
          <option value="sub">subtract</option>
        </select>
        <label>
          <input type="checkbox" checked={level.colorMath.half} onChange={(e) => ed.changeLevel('Color math', () => (level.colorMath.half = e.target.checked))} /> ½
        </label>
      </div>
    </div>
  );
}

function LevelSettings({ ed }: { ed: MapEditor }) {
  const level = ed.level;
  const [w, setW] = useState(level.meta.widthMetatiles);
  const [h, setH] = useState(level.meta.heightMetatiles);
  const [forId, setForId] = useState(level.meta.id);
  if (forId !== level.meta.id) {
    setForId(level.meta.id);
    setW(level.meta.widthMetatiles);
    setH(level.meta.heightMetatiles);
  }
  const changed = w !== level.meta.widthMetatiles || h !== level.meta.heightMetatiles;
  return (
    <div className="panel">
      <h2>Level</h2>
      <label className="field">
        Title
        <TextInput value={level.meta.title} onChange={(v) => ed.changeLevel('Rename level', () => (level.meta.title = v || 'Untitled Level'))} />
      </label>
      <div className="row tight">
        <span className="hint">Size</span>
        <NumInput value={w} min={1} max={MAX_METATILES_PER_SIDE} width={56} onChange={setW} />×
        <NumInput value={h} min={1} max={MAX_METATILES_PER_SIDE} width={56} onChange={setH} />
        <button className="btn small" disabled={!changed} onClick={() => ed.resizeLevel(w, h)}>Resize</button>
      </div>
      <div className="hint">
        Metatiles are {level.meta.metatileSize}×{level.meta.metatileSize} px. Resizing keeps the top-left corner.
      </div>
      <label className="field">
        Tiles, palettes and sprites from
        <select value={level.pixelSourceId} onChange={(e) => ed.setLevelSource(e.target.value)}>
          {ed.ws.pixelSources.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </label>
      <label className="field">
        Music (HiROM Sound)
        <select value={level.meta.bgmTrackId ?? ''} onChange={(e) => ed.changeLevel('Level music', () => (level.meta.bgmTrackId = e.target.value || null))}>
          <option value="">— silence —</option>
          {ed.ws.soundSources.map((s) => (
            <option key={s.id} value={soundRef(s.id)}>{s.name}</option>
          ))}
        </select>
      </label>
      <div className="row tight">
        <label className="field">
          Playtest as
          <select value={level.playtest.mode} onChange={(e) => ed.changeLevel('Playtest mode', () => (level.playtest.mode = e.target.value as PlaytestMode))}>
            <option value="platformer">Platformer</option>
            <option value="topdown">Top-down</option>
            <option value="camera">Free camera</option>
          </select>
        </label>
        <label className="field">
          Collision from
          <select value={level.collisionLayer} onChange={(e) => ed.changeLevel('Collision layer', () => (level.collisionLayer = Number(e.target.value)))}>
            {level.layers.map((l, i) => (
              <option key={l.id} value={i}>{l.hwSlot}</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

function NewLevelDialog({ ed, onClose }: { ed: MapEditor; onClose: () => void }) {
  const [title, setTitle] = useState(`Level ${ed.ws.levels.length + 1}`);
  const [w, setW] = useState(64);
  const [h, setH] = useState(28);
  const [size, setSize] = useState<MetatileSize>(16);
  const [source, setSource] = useState(ed.level.pixelSourceId);
  const presets: [string, number, number][] = [
    ['1 screen', 16, 14],
    ['Side-scroller 8 screens', 128, 14],
    ['Side-scroller, 2 high', 128, 28],
    ['Big room 4×4', 64, 56],
    ['Overworld 512×512 px', 32, 32],
  ];
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="New level">
        <h2>New level</h2>
        <label className="field">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="presets">
          {presets.map(([n, pw, ph]) => (
            <button key={n} className="btn" onClick={() => ((size === 16 ? (setW(pw), setH(ph)) : (setW(Math.ceil(pw / 2)), setH(Math.ceil(ph / 2)))))}>
              {n}
            </button>
          ))}
        </div>
        <div className="row">
          <label className="field">
            Width (metatiles)
            <input type="number" min={1} max={512} value={w} onChange={(e) => setW(Math.max(1, Math.min(512, Number(e.target.value) | 0)))} />
          </label>
          <label className="field">
            Height
            <input type="number" min={1} max={512} value={h} onChange={(e) => setH(Math.max(1, Math.min(512, Number(e.target.value) | 0)))} />
          </label>
          <label className="field">
            Metatile
            <select value={size} onChange={(e) => setSize(Number(e.target.value) as MetatileSize)}>
              <option value={16}>16×16</option>
              <option value={32}>32×32</option>
            </select>
          </label>
        </div>
        <div className="hint">
          {w * size}×{h * size} px · {Math.ceil((w * size) / 256)}×{Math.ceil((h * size) / 224)} screens
        </div>
        <label className="field">
          Tiles from
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {ed.ws.pixelSources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            onClick={() => {
              ed.addLevel({ title: title || 'Untitled Level', widthMetatiles: w, heightMetatiles: h, metatileSize: size, pixelSourceId: source });
              onClose();
            }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
