import { useEffect, useRef, useState } from 'react';
import { createMapContext as createContext } from '../render/gl';
import { SceneRenderer } from '@pixel/render/sceneRenderer';
import type { MapEditor } from '../core/editor';
import { Playtest } from '../core/playtest';
import { MusicPlayer } from '../io/music';
import { renderScreen } from '../render/frame';

/**
 * Live playtest: the 256×224 screen with parallax, HDMA bands, color math, palette cycling and
 * sprite animation, a controllable dummy character, and the level's HiROM Sound music.
 */
export function PlaytestView({ ed, music, start, onExit }: { ed: MapEditor; music: MusicPlayer; start?: { x: number; y: number }; onExit: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const hud = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    const c = canvas.current!;
    const level = ed.level, src = ed.source;
    if (!src) return;
    let gl: WebGL2RenderingContext, r: SceneRenderer;
    try {
      gl = createContext(c);
      r = new SceneRenderer(gl);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
      return;
    }
    const pt = new Playtest(level, ed.ws, start);
    let raf = 0, last = performance.now(), acc = 0, frames = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(c.clientWidth * dpr);
      c.height = Math.round(c.clientHeight * dpr);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(c);
    resize();
    void music.play(pt.track());

    const key = (down: boolean) => (e: KeyboardEvent) => {
      if (e.code === 'Escape' && down) {
        onExit();
        return;
      }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyZ', 'KeyX', 'KeyA', 'KeyS', 'KeyD', 'KeyW', 'KeyJ', 'KeyK', 'ShiftLeft', 'ShiftRight'].includes(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        if (down) pt.keys.add(e.code);
        else pt.keys.delete(e.code);
      }
    };
    const kd = key(true), ku = key(false);
    const blur = () => pt.keys.clear();
    window.addEventListener('keydown', kd, true);
    window.addEventListener('keyup', ku, true);
    window.addEventListener('blur', blur);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      acc += Math.min(100, now - last);
      last = now;
      let track = pt.track();
      while (acc >= 1000 / 60) {
        acc -= 1000 / 60;
        track = pt.step();
        frames++;
      }
      void music.play(track);
      const objects = pt.objects(src);
      const fr = renderScreen(
        r,
        gl,
        { level, project: src, templates: ed.ws.templates, tick: pt.tick, animate: true, pixelVersion: ed.pixelVersion, cellsVersion: ed.cellsVersion },
        pt.cam,
        objects,
        c.width,
        c.height,
        ed.par,
      );
      // Box for a sprite-less player, drawn into the HUD layer
      const h = hud.current;
      if (h) {
        const dpr = window.devicePixelRatio || 1;
        const box = h.querySelector<HTMLDivElement>('.pt-player');
        if (box) {
          if (pt.playerIsBox(src)) {
            box.style.display = 'block';
            box.style.left = `${(fr.ox + (pt.body.x - Math.round(pt.cam.x)) * fr.sx) / dpr}px`;
            box.style.top = `${(fr.oy + (pt.body.y - Math.round(pt.cam.y)) * fr.scale) / dpr}px`;
            box.style.width = `${(pt.body.w * fr.sx) / dpr}px`;
            box.style.height = `${(pt.body.h * fr.scale) / dpr}px`;
          } else box.style.display = 'none';
        }
        const msg = h.querySelector<HTMLDivElement>('.pt-msg');
        if (msg) msg.textContent = pt.message && pt.message.until > pt.tick ? pt.message.text : '';
        if (frames % 15 === 0) setStatus(music.status);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', kd, true);
      window.removeEventListener('keyup', ku, true);
      window.removeEventListener('blur', blur);
      music.stop();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [ed, music, start, onExit]);

  const mode = ed.level.playtest.mode;
  return (
    <div className="playtest">
      <canvas ref={canvas} />
      <div className="pt-hud" ref={hud}>
        <div className="pt-player" />
        <div className="pt-msg" />
        <div className="pt-help">
          {mode === 'camera' ? 'Arrows: move camera · X: faster' : mode === 'topdown' ? 'Arrows: move · X: run' : 'Arrows: move / climb · Z or Space: jump · X: run'} · Esc: back to editing
        </div>
        <div className="pt-status">{status}</div>
      </div>
    </div>
  );
}
