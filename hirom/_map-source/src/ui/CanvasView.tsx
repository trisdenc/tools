import { useEffect, useRef, useState } from 'react';
import { createMapContext as createContext } from '../render/gl';
import { SceneRenderer } from '@pixel/render/sceneRenderer';
import type { MapEditor } from '../core/editor';
import { renderEditor } from '../render/frame';
import { drawOverlay } from '../render/overlay';
import { syncThumbs } from './thumbs';

export interface RendererHandle {
  gl: WebGL2RenderingContext;
  r: SceneRenderer;
}

/** The shared WebGL context (also used for PNG export). */
export const rendererRef: { current: RendererHandle | null } = { current: null };

export function CanvasView({ ed, spaceHeld }: { ed: MapEditor; spaceHeld: { current: boolean } }) {
  const wrap = useRef<HTMLDivElement>(null);
  const glCanvas = useRef<HTMLCanvasElement>(null);
  const ovCanvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);

  useEffect(() => {
    const canvas = glCanvas.current!, ov = ovCanvas.current!, box = wrap.current!;
    let handle: RendererHandle;
    try {
      const gl = createContext(canvas);
      handle = { gl, r: new SceneRenderer(gl) };
      rendererRef.current = handle;
      (window as unknown as Record<string, unknown>).hiromMapGl = handle;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    let raf = 0, lastKey = '', lastTime = performance.now(), acc = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = box.clientWidth, h = box.clientHeight;
      for (const c of [canvas, ov]) {
        c.width = Math.max(1, Math.round(w * dpr));
        c.height = Math.max(1, Math.round(h * dpr));
      }
      ed.setViewport(w, h);
      lastKey = '';
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    resize();

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      acc += Math.min(100, now - lastTime);
      lastTime = now;
      const animate = ed.overlays.animate;
      while (acc >= 1000 / 60) {
        acc -= 1000 / 60;
        if (animate || ed.selRect) ed.tick++;
      }
      const src = ed.source;
      const key = [ed.fastVersion, ed.cellsVersion, ed.pixelVersion, animate || ed.selRect ? ed.tick : 0, canvas.width, canvas.height, ed.level?.meta.id].join(':');
      if (key === lastKey) return;
      lastKey = key;
      const dpr = window.devicePixelRatio || 1;
      const { gl, r } = handle;
      syncThumbs(ed.pixelVersion);
      if (src && ed.level) {
        renderEditor(
          r,
          gl,
          { level: ed.level, project: src, templates: ed.ws.templates, tick: ed.tick, animate, pixelVersion: ed.pixelVersion, cellsVersion: ed.cellsVersion },
          { zoom: ed.view.zoom * dpr, panX: ed.view.panX * dpr, panY: ed.view.panY * dpr },
          canvas.width,
          canvas.height,
          { activeLayer: ed.activeLayer, grid: ed.overlays.grid, priority: ed.overlays.priority, entities: ed.overlays.entities },
        );
      } else {
        gl.clearColor(0.09, 0.094, 0.11, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      const ctx = ov.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawOverlay(ctx, ed, ov.width / dpr, ov.height / dpr);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (rendererRef.current === handle) rendererRef.current = null;
    };
  }, [ed]);

  // Pointer handling
  useEffect(() => {
    const ov = ovCanvas.current;
    if (!ov) return;
    let pan: { x: number; y: number } | null = null;
    const world = (e: PointerEvent | WheelEvent) => {
      const r = ov.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      return { sx, sy, x: (sx - ed.view.panX) / ed.view.zoom, y: (sy - ed.view.panY) / ed.view.zoom };
    };
    const down = (e: PointerEvent) => {
      ov.focus();
      ov.setPointerCapture(e.pointerId);
      const p = world(e);
      if (e.button === 1 || spaceHeld.current) {
        pan = { x: e.clientX, y: e.clientY };
        setPanning(true);
        e.preventDefault();
        return;
      }
      if (e.button !== 0 && e.button !== 2) return;
      ed.pointerDown(p.x, p.y, e.button, { alt: e.altKey, shift: e.shiftKey });
    };
    const move = (e: PointerEvent) => {
      if (pan) {
        ed.panBy(e.clientX - pan.x, e.clientY - pan.y);
        pan = { x: e.clientX, y: e.clientY };
        return;
      }
      const p = world(e);
      ed.pointerMove(p.x, p.y, { shift: e.shiftKey });
    };
    const up = (e: PointerEvent) => {
      if (ov.hasPointerCapture(e.pointerId)) ov.releasePointerCapture(e.pointerId);
      if (pan) {
        pan = null;
        setPanning(false);
        return;
      }
      ed.pointerUp();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = world(e);
      if (e.shiftKey && !e.ctrlKey) ed.panBy(-e.deltaY, 0);
      else if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) ed.panBy(-e.deltaX, 0);
      else ed.zoomAt(e.deltaY < 0 ? 2 : 0.5, p.sx, p.sy);
    };
    const leave = () => ed.setHover(null);
    const menu = (e: Event) => e.preventDefault();
    ov.addEventListener('pointerdown', down);
    ov.addEventListener('pointermove', move);
    ov.addEventListener('pointerup', up);
    ov.addEventListener('pointercancel', up);
    ov.addEventListener('wheel', wheel, { passive: false });
    ov.addEventListener('pointerleave', leave);
    ov.addEventListener('contextmenu', menu);
    return () => {
      ov.removeEventListener('pointerdown', down);
      ov.removeEventListener('pointermove', move);
      ov.removeEventListener('pointerup', up);
      ov.removeEventListener('pointercancel', up);
      ov.removeEventListener('wheel', wheel);
      ov.removeEventListener('pointerleave', leave);
      ov.removeEventListener('contextmenu', menu);
    };
  }, [ed, spaceHeld]);

  const info = ed.pixelSourceInfo();
  return (
    <div className={`canvas-wrap ${panning ? 'pan' : ''}`} ref={wrap}>
      <canvas ref={glCanvas} />
      <canvas ref={ovCanvas} tabIndex={0} aria-label="Level canvas" />
      {error && (
        <div className="gl-error">
          <strong>WebGL2 isn't available</strong>
          <p>{error}</p>
        </div>
      )}
      {!error && ed.ready && !info.project && (
        <div className="canvas-note">
          {info.status === 'loading' && 'Loading tiles…'}
          {info.status === 'missing' && (
            <>
              <strong>No HiROM Pixel project yet</strong>
              <p>This level uses HiROM Pixel's current project, but nothing has been saved there. Draw some tiles in HiROM Pixel, or pick the starter kit or an imported .hirompixel file in the Assets tab.</p>
            </>
          )}
          {info.status === 'error' && (
            <>
              <strong>Couldn't load the HiROM Pixel project</strong>
              <p>{info.error}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
