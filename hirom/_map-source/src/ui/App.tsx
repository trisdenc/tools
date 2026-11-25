import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapEditor, TOOLS } from '../core/editor';
import { MusicPlayer } from '../io/music';
import { CanvasView } from './CanvasView';
import { Dock } from './Dock';
import { LeftPanel } from './LeftPanel';
import { PlaytestView } from './PlaytestView';
import { StatusBar, ToolOptions, Toolbar, TopBar } from './Chrome';
import { isTyping, useVersion } from './common';
import { saveWorkspace } from './files';

export function App() {
  const ed = useMemo(() => new MapEditor(), []);
  const music = useMemo(() => new MusicPlayer(ed), [ed]);
  useVersion(ed);
  const spaceHeld = useRef(false);
  const [playFrom, setPlayFrom] = useState<{ x: number; y: number } | undefined>(undefined);

  useEffect(() => {
    void ed.init();
    // Debug / test hook
    (window as unknown as Record<string, unknown>).hiromMap = { ed, music };
  }, [ed, music]);

  const play = useCallback(
    (from?: { x: number; y: number }) => {
      if (!ed.source) {
        ed.toast('Load some tiles first (Assets tab) to playtest.', true);
        return;
      }
      void music.warmUp();
      ed.cancelDrag();
      setPlayFrom(from);
      ed.playing = true;
      ed.bump(false);
    },
    [ed, music],
  );
  const stop = useCallback(() => {
    music.stop();
    ed.playing = false;
    ed.bump(false);
  }, [ed, music]);

  // Shortcuts
  useEffect(() => {
    let spaceAt = 0, spaceMoved = false;
    const onMove = () => {
      if (spaceHeld.current) spaceMoved = true;
    };
    const down = (e: KeyboardEvent) => {
      if (isTyping(e) || ed.playing) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl) {
        if (k === 'z' && !e.shiftKey) ed.undo();
        else if ((k === 'z' && e.shiftKey) || k === 'y') ed.redo();
        else if (k === 's') void saveWorkspace(ed);
        else if (k === 'c') ed.copySelection();
        else return;
        e.preventDefault();
        return;
      }
      if (e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!spaceHeld.current) {
          spaceHeld.current = true;
          spaceAt = performance.now();
          spaceMoved = false;
        }
        return;
      }
      if (k === 'escape') {
        ed.cancelDrag();
        ed.selRect = null;
        ed.select(null);
        return;
      }
      if (k === 'delete' || k === 'backspace') {
        ed.deleteSelected();
        e.preventDefault();
        return;
      }
      if (k === 'enter' || k === 'f5') {
        e.preventDefault();
        play(ed.hover ?? undefined);
        return;
      }
      const tool = TOOLS.find((t) => t.key.toLowerCase() === k);
      if (tool) {
        ed.setTool(tool.id);
        return;
      }
      if (k === 'h') ed.flipH = !ed.flipH;
      else if (k === 'v') ed.flipV = !ed.flipV;
      else if (k === 'p') ed.forcePrio = !ed.forcePrio;
      else if (k === '1' || k === '2' || k === '3') ed.setActiveLayer(Number(k) - 1);
      else if (k === '0') ed.fitView();
      else if (k === '+' || k === '=') ed.zoomAt(2, ed.view.width / 2, ed.view.height / 2);
      else if (k === '-') ed.zoomAt(0.5, ed.view.width / 2, ed.view.height / 2);
      else if (k === '#') ed.toggleOverlay('grid');
      else if (k === 'k') ed.toggleOverlay('collision');
      else if (k === 'tab') {
        e.preventDefault();
        ed.setActiveLayer((ed.activeLayer + 1) % 3);
      } else return;
      ed.bump(false);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const tap = spaceHeld.current && !spaceMoved && performance.now() - spaceAt < 300;
      spaceHeld.current = false;
      if (tap && !isTyping(e)) {
        if (ed.playing) stop();
        else play();
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('pointermove', onMove);
    };
  }, [ed, play, stop]);

  // Notifications fade on their own (errors stay a little longer)
  const msg = ed.message;
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => {
      if (ed.message === msg) {
        ed.message = null;
        ed.bump(false);
      }
    }, msg.error ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [ed, msg]);

  if (!ed.ready) return <div className="loading">Loading HiROM Map…</div>;
  return (
    <div className="app map-app">
      <TopBar ed={ed} onPlay={() => (ed.playing ? stop() : play())} />
      <ToolOptions ed={ed} />
      <div className="main map-main">
        <LeftPanel ed={ed} />
        <Toolbar ed={ed} />
        <div className="center">
          {ed.playing ? <PlaytestView ed={ed} music={music} start={playFrom} onExit={stop} /> : <CanvasView ed={ed} spaceHeld={spaceHeld} />}
        </div>
        <Dock ed={ed} music={music} />
      </div>
      <StatusBar ed={ed} />
      {ed.message && (
        <div className={`toast ${ed.message.error ? '' : 'info'}`} role="status" onClick={() => ((ed.message = null), ed.bump(false))}>
          {ed.message.text}
        </div>
      )}
    </div>
  );
}
