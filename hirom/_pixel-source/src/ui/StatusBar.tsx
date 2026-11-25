import { toSnesHex } from '../core/color';
import { Editor } from '../core/editor';
import { cellFlip, cellPal, cellPrio, cellTile } from '../core/project';
import { useFastVersion } from './hooks';
import { VramMeter } from './VramMeter';

function SceneHover({ editor }: { editor: Editor }) {
  const h = editor.hover;
  if (!h) return null;
  const c = editor.cellAt(editor.activeLayer, h.x, h.y);
  const r = editor.sceneRegion();
  const L = editor.project.scene.layers[editor.activeLayer];
  if (!c) return null;
  const w = c.map.cells[c.idx];
  const f = cellFlip(w);
  return (
    <span className="mono">
      x{h.x + r.x} y{h.y + r.y} · {L.id} cell ({c.cx},{c.cy}) · tile #{cellTile(w)} pal {cellPal(w)}
      {cellPrio(w) ? ' PRI' : ''}
      {f & 1 ? ' H' : ''}
      {f & 2 ? ' V' : ''} · ${w.toString(16).toUpperCase().padStart(4, '0')}
    </span>
  );
}

function PixelHover({ editor }: { editor: Editor }) {
  const h = editor.hover;
  if (!h) return null;
  const v = editor.pixelAt(h.x, h.y);
  const tile = editor.target.kind === 'tileset' ? ` · tile #${(h.y >> 3) * 16 + (h.x >> 3)}` : ` · tile (${h.x >> 3},${h.y >> 3})`;
  return (
    <span className="mono">
      x{h.x} y{h.y}
      {tile}
      {v !== null && (
        <>
          {' '}· idx {v}
          {v === 0 ? ' (transparent)' : ` → slot ${editor.base + v} ${toSnesHex(editor.colorOf(v))}`}
        </>
      )}
    </span>
  );
}

export function StatusBar({ editor }: { editor: Editor }) {
  useFastVersion(editor);
  const { image } = editor;
  const kb = (editor.history.bytes() / 1024).toFixed(1);
  const t = editor.target;
  return (
    <footer className="statusbar">
      <span>
        {t.kind === 'scene'
          ? `Scene · ${editor.project.scene.layers[editor.activeLayer].id} · pal ${editor.scenePalette}`
          : `${image.width}×${image.height} · ${image.bpp}bpp · pal ${editor.paletteId}${t.kind === 'sprite' ? ` · frame ${t.frame + 1}/${editor.spriteAsset?.frames.length}` : ''}`}
      </span>
      {editor.mode === 'scene' ? <SceneHover editor={editor} /> : <PixelHover editor={editor} />}
      <span className="grow" />
      {editor.playing && <span className="mono">tick {editor.tick}</span>}
      <VramMeter editor={editor} />
      <span>
        {editor.history.undoCount} undo · {kb} KB
      </span>
    </footer>
  );
}
