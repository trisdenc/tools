import { useRef } from 'react';
import { Editor } from '../core/editor';
import {
  exportIndexedPng,
  exportPal,
  exportProject,
  exportRgbaPng,
  exportScenePng,
  exportSpritesheet,
  exportTiled,
} from '../io/exporters';
import { decodePal } from '../io/palfile';
import { parseProject } from '../io/project';

interface Props {
  editor: Editor;
  onError: (msg: string) => void;
}

export function TopBar({ editor, onError }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const exportRef = useRef<HTMLDetailsElement>(null);
  const { view } = editor;
  const scene = editor.mode === 'scene';

  const run = (fn: () => unknown) => async () => {
    if (exportRef.current) exportRef.current.open = false;
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const onFile = async (file: File) => {
    try {
      if (/\.pal$/i.test(file.name)) {
        editor.replaceCgram(decodePal(new Uint8Array(await file.arrayBuffer())), 'Import palette');
      } else {
        editor.load(parseProject(JSON.parse(await file.text())));
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <header className="topbar">
      <a className="brand hirom-lockup" href="../" title="HiROM Studio home">
        <img src="../brand/pixel.svg" alt="" />
        <span className="names">
          <span className="hirom-suite">HiROM Studio</span>
          <span className="hirom-word">
            HiROM <span className="sub">Pixel</span>
          </span>
        </span>
      </a>
      <input className="title-input" value={editor.project.title} aria-label="Project title" onChange={(e) => editor.setTitle(e.target.value)} />
      <button
        className="btn"
        onClick={() => window.confirm('Start a new project? Unsaved work in this one will be replaced (export it first with Save).') && editor.newProject()}
      >
        New
      </button>
      <button className="btn" onClick={() => fileRef.current?.click()} title="Open a project (.hirompixel, older .hirom.json / .snesproj.json) or a palette (.pal)">
        Open
      </button>
      <button className="btn" onClick={run(() => exportProject(editor))} title="Save the project as a .hirompixel file (Ctrl+S)">
        Save
      </button>
      <details className="menu" ref={exportRef}>
        <summary className="btn">Export ▾</summary>
        <div className="menu-pop">
          <div className="menu-label">Scene</div>
          <button onClick={run(() => exportScenePng(editor, 'screen'))}>Screen PNG (256×224 at camera)</button>
          <button onClick={run(() => exportScenePng(editor, 'screen', 4, true))}>Screen PNG (4×, 8:7 PAR)</button>
          <button onClick={run(() => exportScenePng(editor, 'map'))}>Full map PNG</button>
          <button onClick={run(() => exportTiled(editor))}>Tiled map (.tmx + .tmj + PNGs, zip)</button>
          <div className="menu-label">Open {scene ? 'tileset' : editor.target.kind}</div>
          <button onClick={run(() => exportRgbaPng(editor, 1, false))}>PNG (RGBA, 1×)</button>
          <button onClick={run(() => exportRgbaPng(editor, 4, false))}>PNG (RGBA, 4×)</button>
          <button onClick={run(() => exportIndexedPng(editor))}>Indexed PNG (active palette)</button>
          {editor.target.kind === 'sprite' && <button onClick={run(() => exportSpritesheet(editor))}>Spritesheet (PNG + JSON, zip)</button>}
          <div className="menu-label">Project</div>
          <button onClick={run(() => exportPal(editor))}>CGRAM .pal (512 B BGR555)</button>
          <button onClick={run(() => exportProject(editor))}>Project (.hirompixel)</button>
        </div>
      </details>
      <input
        ref={fileRef}
        type="file"
        accept=".hirompixel,.json,.pal"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
      <span className="sep" />
      <button className="btn icon" disabled={!editor.history.canUndo} onClick={() => editor.undo()} title="Undo (Ctrl+Z)">↶</button>
      <button className="btn icon" disabled={!editor.history.canRedo} onClick={() => editor.redo()} title="Redo (Ctrl+Shift+Z / Ctrl+Y)">↷</button>
      <button className={`btn play${editor.playing ? ' on' : ''}`} onClick={() => editor.setPlaying(!editor.playing)} title="Play animations, palette cycles and auto-scroll (Enter)">
        {editor.playing ? '■ Stop' : '▶ Play'}
      </button>
      <span className="sep" />
      <button className="btn icon" onClick={() => editor.zoomStep(-1)} title="Zoom out (-)">−</button>
      <span className="num zoom">{view.zoom * 100}%</span>
      <button className="btn icon" onClick={() => editor.zoomStep(1)} title="Zoom in (+)">+</button>
      <button className="btn" onClick={() => editor.fitView()} title="Fit to window (0)">Fit</button>
      <span className="sep" />
      {!scene && (
        <button className={`btn toggle${view.pixelGrid ? ' on' : ''}`} onClick={() => editor.setView({ pixelGrid: !view.pixelGrid })} title="Pixel grid (#)">
          Grid
        </button>
      )}
      <button
        className={`btn toggle${view.tileGrid ? ' on' : ''}`}
        onClick={() => editor.setView({ tileGrid: view.tileGrid === 0 ? 8 : view.tileGrid === 8 && !scene ? 16 : 0 })}
        title="Tile grid (T)"
      >
        Tiles {view.tileGrid ? `${view.tileGrid}` : 'off'}
      </button>
      <button className={`btn toggle${view.par ? ' on' : ''}`} onClick={() => editor.togglePar()} title="8:7 NTSC pixel aspect ratio">
        8:7
      </button>
      {!scene && (
        <button
          className={`btn toggle${view.showBackdrop ? ' on' : ''}`}
          onClick={() => editor.setView({ showBackdrop: !view.showBackdrop })}
          title="Show index 0 as the CGRAM backdrop color instead of transparency (K)"
        >
          Backdrop
        </button>
      )}
      <span className="sep" />
      <span className="seg inline mode-switch" title="Strict SNES enforces 64 KB VRAM and hardware color-math rules; Modern keeps the look without the ceilings">
        <button className={editor.project.strict ? 'on' : ''} onClick={() => editor.setStrict(true)}>Strict SNES</button>
        <button className={!editor.project.strict ? 'on' : ''} onClick={() => editor.setStrict(false)}>Modern</button>
      </span>
    </header>
  );
}
