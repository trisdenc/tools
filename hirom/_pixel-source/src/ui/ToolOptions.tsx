import { Editor, PIXEL_TOOLS, SCENE_TOOLS, ToolSettings } from '../core/editor';
import { DitherPattern } from '../core/raster';

function Check({ editor, k, label, title }: { editor: Editor; k: keyof ToolSettings; label: string; title?: string }) {
  return (
    <label className="opt" title={title}>
      <input type="checkbox" checked={editor.settings[k] as boolean} onChange={(e) => editor.setSetting(k, e.target.checked as never)} />
      {label}
    </label>
  );
}

function SceneOptions({ editor }: { editor: Editor }) {
  const t = editor.sceneTool;
  const s = editor.stamp;
  const paints = t === 'stamp' || t === 'tileRect' || t === 'tileFill';
  return (
    <>
      {paints && (
        <>
          <span className="hint">
            Stamp {s.w}×{s.h} · pal {editor.scenePalette}
          </span>
          <button className="btn small" onClick={() => editor.flipStamp('h')} title="Flip stamp horizontally (H)">
            Flip H
          </button>
          <button className="btn small" onClick={() => editor.flipStamp('v')} title="Flip stamp vertically (V)">
            Flip V
          </button>
          <label className="opt" title="Paint tiles with the priority bit set (Q)">
            <input type="checkbox" checked={editor.paintPriority} onChange={(e) => editor.set({ paintPriority: e.target.checked })} />
            High priority
          </label>
        </>
      )}
      {t === 'tilePick' && <span className="hint">Click a cell, or drag to grab a multi-tile stamp. Alt-click picks with any tile tool.</span>}
      {t === 'priority' && <span className="hint">Left drag sets the priority bit, right drag clears it.</span>}
      {t === 'object' && (
        <span className="hint">Click empty space to place the selected sprite · drag to move · right-click or Delete removes.</span>
      )}
      <span className="sep" />
      <label className="opt" title="Tint high-priority cells of the active layer blue">
        <input type="checkbox" checked={editor.showPriority} onChange={(e) => editor.set({ showPriority: e.target.checked })} />
        Priority overlay
      </label>
    </>
  );
}

export function ToolOptions({ editor }: { editor: Editor }) {
  const { tool, settings: s } = editor;
  const label = [...PIXEL_TOOLS, ...SCENE_TOOLS].find((t) => t.id === tool)?.label.replace(/ \(.*\)$/, '');
  if (editor.mode === 'scene') {
    return (
      <div className="tool-options">
        <span className="opt-title">{label}</span>
        <SceneOptions editor={editor} />
      </div>
    );
  }
  const brush = ['pencil', 'eraser', 'dither', 'line', 'rect', 'ellipse'].includes(tool);
  return (
    <div className="tool-options">
      <span className="opt-title">{label}</span>
      {brush && (
        <label className="opt" title="Brush size ([ and ])">
          Size
          <input type="range" min={1} max={16} value={s.brushSize} onChange={(e) => editor.setSetting('brushSize', +e.target.value)} />
          <span className="num">{s.brushSize}px</span>
        </label>
      )}
      {(tool === 'pencil' || tool === 'eraser') && (
        <Check editor={editor} k="pixelPerfect" label="Pixel-perfect" title="Remove L-shaped corners from 1px strokes" />
      )}
      {(tool === 'rect' || tool === 'ellipse') && <Check editor={editor} k="filled" label="Filled" title="Hold Shift while dragging for a square / circle" />}
      {tool === 'dither' && (
        <>
          <label className="opt">
            Pattern
            <select value={s.ditherPattern} onChange={(e) => editor.setSetting('ditherPattern', e.target.value as DitherPattern)}>
              <option value="checker">Checkerboard</option>
              <option value="bayer2">Bayer 2×2</option>
              <option value="bayer4">Bayer 4×4</option>
            </select>
          </label>
          {s.ditherPattern !== 'checker' && (
            <label className="opt">
              Density
              <input
                type="range"
                min={0}
                max={1}
                step={s.ditherPattern === 'bayer2' ? 0.25 : 0.0625}
                value={s.ditherDensity}
                onChange={(e) => editor.setSetting('ditherDensity', +e.target.value)}
              />
              <span className="num">{Math.round(s.ditherDensity * 100)}%</span>
            </label>
          )}
          <Check editor={editor} k="ditherBothColors" label="Secondary on off-cells" />
        </>
      )}
      {tool === 'replace' && <span className="hint">Click a pixel: every pixel with that index becomes the primary color.</span>}
      {tool === 'picker' && <span className="hint">Left click → primary, right click → secondary. Alt-click works with any tool.</span>}
      {tool === 'box' && (
        <span className="seg inline">
          {(['hit', 'hurt'] as const).map((k) => (
            <button key={k} className={editor.boxKind === k ? 'on' : ''} onClick={() => editor.set({ boxKind: k })}>
              {k === 'hit' ? 'Hitbox' : 'Hurtbox'}
            </button>
          ))}
        </span>
      )}
      <span className="sep" />
      <Check editor={editor} k="mirrorH" label="Mirror ↔" title="Horizontal symmetry" />
      <Check editor={editor} k="mirrorV" label="Mirror ↕" title="Vertical symmetry" />
      <Check editor={editor} k="wrap" label="Tile wrap" title="Strokes and fills wrap around the edges; shows neighbouring repeats (W)" />
      {editor.target.kind === 'sprite' && (
        <label className="opt" title="Show previous (red) and next (blue) frames">
          <input type="checkbox" checked={editor.onionSkin} onChange={(e) => editor.set({ onionSkin: e.target.checked })} />
          Onion skin
        </label>
      )}
    </div>
  );
}
