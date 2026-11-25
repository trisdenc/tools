import { useEffect, useMemo, useState } from 'react';
import { Editor, PIXEL_TOOLS, SCENE_TOOLS } from './core/editor';
import { exportProject } from './io/exporters';
import { parseProject, serializeProject } from './io/project';
import { idbGet, idbSet } from './io/storage';
import { AssetKind, AssetsPanel } from './ui/AssetsPanel';
import { CanvasView } from './ui/CanvasView';
import { NewDocDialog } from './ui/NewDocDialog';
import { PaletteStudio } from './ui/PaletteStudio';
import { Preview } from './ui/Preview';
import { FxPanel, LayersPanel, ObjectsPanel } from './ui/ScenePanels';
import { StatusBar } from './ui/StatusBar';
import { TilesetDock, TilesetTools } from './ui/TilesetDock';
import { Timeline } from './ui/Timeline';
import { ToolOptions } from './ui/ToolOptions';
import { Toolbar } from './ui/Toolbar';
import { TopBar } from './ui/TopBar';
import { isTyping, useEditorVersion } from './ui/hooks';

const AUTOSAVE_KEY = 'autosave';

function useAutosave(editor: Editor) {
  useEffect(() => {
    let cancelled = false;
    let loaded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let savedKey = '';
    const keyOf = () =>
      [editor.imageVersion, editor.pixelVersion, editor.paletteVersion, editor.cellsVersion, editor.structureVersion, editor.project.title].join(':');
    const save = () => {
      const key = keyOf();
      if (key === savedKey) return;
      savedKey = key;
      idbSet(AUTOSAVE_KEY, serializeProject(editor.project)).catch((e) => console.warn('Autosave failed', e));
    };

    idbGet(AUTOSAVE_KEY)
      .then((data) => {
        if (!cancelled && data) editor.load(parseProject(data));
      })
      .catch((e) => console.warn('Could not restore autosave', e))
      .finally(() => {
        loaded = true;
        savedKey = keyOf();
      });

    const unsub = editor.subscribe(() => {
      if (!loaded) return;
      clearTimeout(timer);
      timer = setTimeout(save, 1000);
    });
    const onHide = () => loaded && save();
    window.addEventListener('pagehide', onHide);
    return () => {
      cancelled = true;
      unsub();
      clearTimeout(timer);
      window.removeEventListener('pagehide', onHide);
    };
  }, [editor]);
}

function useShortcuts(editor: Editor) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl) {
        if (k === 'z' && !e.shiftKey) editor.undo();
        else if ((k === 'z' && e.shiftKey) || k === 'y') editor.redo();
        else if (k === 's') exportProject(editor);
        else return;
        e.preventDefault();
        return;
      }
      if (e.altKey) return;
      const scene = editor.mode === 'scene';
      const s = editor.settings;
      const v = editor.view;

      // Mode-specific keys first.
      if (scene) {
        const step = e.shiftKey ? 16 : 4;
        switch (e.key) {
          case 'h': case 'H': editor.flipStamp('h'); break;
          case 'v': case 'V': editor.flipStamp('v'); break;
          case 'q': case 'Q': editor.set({ paintPriority: !editor.paintPriority }); break;
          case 'Delete': case 'Backspace':
            if (editor.selectedObjectId) editor.deleteObject(editor.selectedObjectId);
            break;
          case 'ArrowLeft': editor.moveCamera(-step, 0); break;
          case 'ArrowRight': editor.moveCamera(step, 0); break;
          case 'ArrowUp': editor.moveCamera(0, -step); break;
          case 'ArrowDown': editor.moveCamera(0, step); break;
          case '1': case '2': case '3': editor.setActiveLayer(+e.key - 1); break;
          default: {
            const tool = SCENE_TOOLS.find((t) => t.key.toLowerCase() === k);
            if (!tool) break;
            editor.setTool(tool.id);
          }
        }
        if (/^(h|v|q|delete|backspace|arrow\w+|[123])$/i.test(e.key) || SCENE_TOOLS.some((t) => t.key.toLowerCase() === k)) {
          e.preventDefault();
          return;
        }
      } else {
        const tool = PIXEL_TOOLS.find((t) => t.key.toLowerCase() === k && (t.id !== 'box' || editor.target.kind === 'sprite'));
        if (tool) return editor.setTool(tool.id);
        if (editor.target.kind === 'sprite' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          editor.setFrame(editor.frameIndex + (e.key === 'ArrowLeft' ? -1 : 1));
          e.preventDefault();
          return;
        }
      }

      switch (e.key) {
        case 'x': case 'X': if (!scene) editor.swapColors(); break;
        case '[': editor.setSetting('brushSize', Math.max(1, s.brushSize - 1)); break;
        case ']': editor.setSetting('brushSize', Math.min(16, s.brushSize + 1)); break;
        case ',': editor.cyclePalette(-1); break;
        case '.': editor.cyclePalette(1); break;
        case 'f': case 'F': editor.setSetting('filled', !s.filled); break;
        case 'w': case 'W': editor.setSetting('wrap', !s.wrap); break;
        case '#': editor.setView({ pixelGrid: !v.pixelGrid }); break;
        case 't': case 'T': editor.setView({ tileGrid: v.tileGrid === 0 ? 8 : v.tileGrid === 8 && !scene ? 16 : 0 }); break;
        case 'k': case 'K': editor.setView({ showBackdrop: !v.showBackdrop }); break;
        case 'Enter': editor.setPlaying(!editor.playing); break;
        case '0': editor.fitView(); break;
        case '+': case '=': editor.zoomStep(1); break;
        case '-': case '_': editor.zoomStep(-1); break;
        case 'Escape': editor.cancelStroke(); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor]);
}

/** Canvas-only action: cut the canvas into deduplicated tiles on a BG layer. */
function CanvasActions({ editor, onMessage, onError }: { editor: Editor; onMessage: (m: string) => void; onError: (m: string) => void }) {
  const cv = editor.canvasAsset;
  const [layer, setLayer] = useState(cv?.image.bpp === 2 ? 2 : 0);
  const [flips, setFlips] = useState(true);
  if (!cv) return null;
  return (
    <section className="panel">
      <h2>Convert to tiles</h2>
      <p className="hint">Cut this canvas into 8×8 tiles, merge duplicates, and put the result on a background layer as a new tileset + tilemap.</p>
      <div className="row">
        <select value={layer} onChange={(e) => setLayer(+e.target.value)}>
          <option value={0}>BG1 (4bpp)</option>
          <option value={1}>BG2 (4bpp)</option>
          <option value={2}>BG3 (2bpp)</option>
        </select>
        <label className="opt">
          <input type="checkbox" checked={flips} onChange={(e) => setFlips(e.target.checked)} />
          Match H/V flips
        </label>
      </div>
      <button
        className="btn wide"
        onClick={() => {
          try {
            const r = editor.canvasToLayer(cv.id, layer, flips);
            const palNote = r.copiedFrom >= 0 ? ` OBJ palette ${r.copiedFrom} copied into BG palette ${r.palette}.` : '';
            onMessage(`${r.blocks} blocks → ${r.tiles} unique tiles (incl. blank). Placed on ${editor.project.scene.layers[layer].id}.${palNote}`);
          } catch (e) {
            onError(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        Convert to {editor.project.scene.layers[layer].id}
      </button>
    </section>
  );
}

export function App() {
  const editor = useMemo(() => new Editor(), []);
  useEditorVersion(editor);
  useAutosave(editor);
  useShortcuts(editor);
  const [newKind, setNewKind] = useState<AssetKind | null>(null);
  const [toast, setToast] = useState<{ msg: string; error: boolean } | null>(null);
  const onError = (msg: string) => setToast({ msg, error: true });
  const onMessage = (msg: string) => setToast({ msg, error: false });

  useEffect(() => {
    if (!toast || toast.error) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const kind = editor.target.kind;
  const ts = editor.tilesetAsset;

  return (
    <div className="app">
      <TopBar editor={editor} onError={onError} />
      <ToolOptions editor={editor} />
      <div className="main">
        <AssetsPanel editor={editor} onNew={setNewKind} onError={onError} />
        <Toolbar editor={editor} />
        <div className="center">
          <CanvasView editor={editor} />
          {kind === 'sprite' && <Timeline editor={editor} />}
        </div>
        <aside className="side">
          {kind === 'scene' ? (
            <>
              <LayersPanel editor={editor} />
              <TilesetDock editor={editor} onMessage={onMessage} />
              <PaletteStudio editor={editor} />
              <FxPanel editor={editor} />
              <ObjectsPanel editor={editor} />
            </>
          ) : (
            <>
              <PaletteStudio editor={editor} />
              <Preview editor={editor} />
              {kind === 'canvas' && <CanvasActions editor={editor} onMessage={onMessage} onError={onError} />}
              {ts && (
                <section className="panel">
                  <h2>Tileset</h2>
                  <TilesetTools editor={editor} ts={ts} onMessage={onMessage} />
                </section>
              )}
            </>
          )}
        </aside>
      </div>
      <StatusBar editor={editor} />
      {newKind && (
        <NewDocDialog
          kind={newKind}
          onClose={() => setNewKind(null)}
          onCreate={(k, name, w, h, bpp) => {
            if (k === 'canvas') editor.addCanvas(name, w, h, bpp);
            else if (k === 'tileset') editor.addTileset(name, bpp, w);
            else editor.addSprite(name, w, h);
            setNewKind(null);
          }}
        />
      )}
      {toast && (
        <div className={`toast${toast.error ? ' error' : ''}`} role={toast.error ? 'alert' : 'status'} onClick={() => setToast(null)}>
          {toast.msg} <span className="hint">(click to dismiss)</span>
        </div>
      )}
    </div>
  );
}
