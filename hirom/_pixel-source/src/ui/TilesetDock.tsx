import { useEffect, useMemo, useRef, useState } from 'react';
import { paletteBase } from '../core/cgram';
import { Editor } from '../core/editor';
import { SHEET_COLS, Tileset } from '../core/project';
import { tileCount, tileUsage } from '../core/tiles';
import { toRgba } from '../io/exporters';

const CELL = 16; // tiles drawn at 2×

/** Tileset maintenance shared by the scene dock and the tileset editor. */
export function TilesetTools({ editor, ts, onMessage }: { editor: Editor; ts: Tileset; onMessage: (m: string) => void }) {
  const [flips, setFlips] = useState(true);
  const [removeUnused, setRemoveUnused] = useState(false);
  const maps = editor.project.tilemaps.filter((m) => m.tilesetId === ts.id);
  return (
    <div className="ts-tools">
      <div className="row">
        <button
          className="btn"
          title="Merge identical tiles (and H/V/HV-flipped copies) and rewrite every map that uses this tileset"
          onClick={() => {
            const r = editor.optimizeTileset(ts.id, { flips, removeUnused });
            if (r) onMessage(`Optimized: ${r.before} → ${r.after} tiles (${r.before - r.after} saved, ${(r.before - r.after) * ts.bpp * 8} B VRAM).`);
          }}
        >
          Deduplicate &amp; Optimize
        </button>
        <button className="btn" onClick={() => editor.addTileRows(ts.id, 1)} disabled={tileCount(ts) >= 1024} title="Add a row of 16 tiles">
          +16 tiles
        </button>
      </div>
      <div className="row">
        <label className="opt">
          <input type="checkbox" checked={flips} onChange={(e) => setFlips(e.target.checked)} />
          Match flips
        </label>
        <label className="opt" title="Drop tiles no map references">
          <input type="checkbox" checked={removeUnused} onChange={(e) => setRemoveUnused(e.target.checked)} />
          Remove unused
        </label>
      </div>
      <p className="hint">Used by {maps.length ? maps.map((m) => m.name).join(', ') : 'no maps'}.</p>
    </div>
  );
}

/** Scene-mode tile picker: click a tile or drag a rectangle to make a stamp. */
export function TilesetDock({ editor, onMessage }: { editor: Editor; onMessage: (m: string) => void }) {
  const ts = editor.layerTileset;
  const map = editor.layerMap;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [showUsage, setShowUsage] = useState(true);
  const [sel, setSel] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [hoverTile, setHoverTile] = useState<number | null>(null);
  const dragging = useRef(false);
  const usage = useMemo(
    () => (ts ? tileUsage(ts, editor.project.tilemaps) : new Uint32Array(0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ts, editor.getVersion()],
  );

  useEffect(() => {
    if (!ts) return;
    const ed = editor;
    let raf = 0;
    let lastKey = '';
    const scratch = document.createElement('canvas');
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const key = [ed.pixelVersion, ed.paletteVersion, ed.scenePalette, ts.sheet.height, showUsage, usage.length, ed.structureVersion].join(':');
      const c = canvasRef.current;
      if (!c || key === lastKey) return;
      lastKey = key;
      const { width: w, height: h } = ts.sheet;
      scratch.width = w;
      scratch.height = h;
      const rgba = toRgba(ts.sheet, ed.displayCgram(), paletteBase(ts.bpp, ed.scenePalette), false);
      scratch.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0);
      c.width = w * 2;
      c.height = h * 2;
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(scratch, 0, 0, c.width, c.height);
      if (showUsage) {
        ctx.fillStyle = 'rgba(10,10,14,0.55)';
        for (let i = 1; i < usage.length; i++) {
          if (!usage[i]) ctx.fillRect((i % SHEET_COLS) * CELL, Math.floor(i / SHEET_COLS) * CELL, CELL, CELL);
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [editor, ts, showUsage, usage]);

  if (!ts || !map) return null;
  const n = tileCount(ts);
  const tileAt = (e: React.PointerEvent) => {
    const r = (e.target as HTMLElement).getBoundingClientRect();
    const x = Math.max(0, Math.min(SHEET_COLS - 1, Math.floor(((e.clientX - r.left) / r.width) * SHEET_COLS)));
    const rows = n / SHEET_COLS;
    const y = Math.max(0, Math.min(rows - 1, Math.floor(((e.clientY - r.top) / r.height) * rows)));
    return { x, y };
  };
  const box = sel && {
    x: Math.min(sel.x0, sel.x1),
    y: Math.min(sel.y0, sel.y1),
    w: Math.abs(sel.x1 - sel.x0) + 1,
    h: Math.abs(sel.y1 - sel.y0) + 1,
  };
  const sameBpp = editor.project.tilesets.filter((t) => t.bpp === ts.bpp);

  return (
    <section className="panel">
      <h2>
        Tiles <span className="sub">{ts.name}</span>
      </h2>
      <div className="row">
        <select value={ts.id} onChange={(e) => editor.setLayerTileset(editor.activeLayer, e.target.value)} title="Tileset used by the active layer">
          {sameBpp.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.bpp}bpp)
            </option>
          ))}
        </select>
        <select
          value={`${map.width}x${map.height}`}
          title="Tilemap size (SNES: 32 or 64 tiles per side)"
          onChange={(e) => {
            const [w, h] = e.target.value.split('x').map(Number);
            editor.resizeLayerMap(editor.activeLayer, w, h);
          }}
        >
          {['32x32', '64x32', '32x64', '64x64'].map((s) => (
            <option key={s} value={s}>
              {s.replace('x', '×')}
            </option>
          ))}
          {!['32x32', '64x32', '32x64', '64x64'].includes(`${map.width}x${map.height}`) && (
            <option value={`${map.width}x${map.height}`}>
              {map.width}×{map.height}
            </option>
          )}
        </select>
        <button className="btn small" onClick={() => editor.setTarget({ kind: 'tileset', id: ts.id })} title="Open this tileset in the pixel editor">
          Edit tiles
        </button>
      </div>
      <div className="dock-scroll">
        <div className="dock" style={{ width: SHEET_COLS * CELL }}>
          <canvas
            ref={canvasRef}
            className="checker"
            style={{ width: SHEET_COLS * CELL, height: (n / SHEET_COLS) * CELL }}
            onPointerDown={(e) => {
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
              dragging.current = true;
              const t = tileAt(e);
              setSel({ x0: t.x, y0: t.y, x1: t.x, y1: t.y });
            }}
            onPointerMove={(e) => {
              const t = tileAt(e);
              setHoverTile(t.y * SHEET_COLS + t.x);
              if (dragging.current) setSel((s) => s && { ...s, x1: t.x, y1: t.y });
            }}
            onPointerLeave={() => setHoverTile(null)}
            onPointerUp={() => {
              dragging.current = false;
              if (box) editor.setStampFromTiles(box.y * SHEET_COLS + box.x, box.w, box.h);
            }}
          />
          {box && <div className="dock-sel" style={{ left: box.x * CELL, top: box.y * CELL, width: box.w * CELL, height: box.h * CELL }} />}
        </div>
      </div>
      <div className="row">
        <span className="hint mono">
          {hoverTile !== null ? `Tile #${hoverTile} · used ${usage[hoverTile] ?? 0}×` : `${n} tiles · drag to select a stamp`}
        </span>
        <label className="opt" style={{ marginLeft: 'auto' }} title="Dim tiles that no map uses">
          <input type="checkbox" checked={showUsage} onChange={(e) => setShowUsage(e.target.checked)} />
          Usage
        </label>
      </div>
      <TilesetTools editor={editor} ts={ts} onMessage={onMessage} />
    </section>
  );
}
