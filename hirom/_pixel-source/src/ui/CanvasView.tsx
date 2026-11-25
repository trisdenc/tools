import { useEffect, useRef, useState } from 'react';
import { BRUSH_TOOLS, Editor, Mods } from '../core/editor';
import { registerSceneCapture } from '../io/exporters';
import { createContext } from '../render/gl';
import { Renderer } from '../render/renderer';
import { buildSceneFrame } from '../render/sceneFrame';
import { SceneRenderer } from '../render/sceneRenderer';
import { isTyping, useFastVersion } from './hooks';

const modsOf = (e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): Mods => ({
  shift: e.shiftKey,
  alt: e.altKey,
  ctrl: e.ctrlKey || e.metaKey,
});

/** SVG overlay for sprite hit/hurt boxes and the anchor point, kept in sync with zoom/pan. */
function SpriteOverlay({ editor }: { editor: Editor }) {
  useFastVersion(editor);
  const s = editor.spriteAsset;
  const f = editor.spriteFrame;
  if (!s || !f) return null;
  const sx = editor.scaleX(), sy = editor.view.zoom;
  const { panX, panY } = editor.view;
  const r = (b: { x: number; y: number; w: number; h: number }, cls: string, key: string) => (
    <rect key={key} className={cls} x={panX + b.x * sx} y={panY + b.y * sy} width={b.w * sx} height={b.h * sy} />
  );
  const ox = panX + (s.originX + 0.5) * sx, oy = panY + (s.originY + 0.5) * sy;
  const d = editor.draftBox;
  return (
    <svg className="overlay">
      {f.hitboxes.map((b, i) => r(b, 'box hit', `h${i}`))}
      {f.hurtboxes.map((b, i) => r(b, 'box hurt', `u${i}`))}
      {d && r(d, `box ${d.kind} draft`, 'draft')}
      <g className="origin">
        <line x1={ox - 8} y1={oy} x2={ox + 8} y2={oy} />
        <line x1={ox} y1={oy - 8} x2={ox} y2={oy + 8} />
      </g>
    </svg>
  );
}

export function CanvasView({ editor }: { editor: Editor }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [panMode, setPanMode] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ed = editor;
    let gl: WebGL2RenderingContext, pixelR: Renderer, sceneR: SceneRenderer;
    try {
      gl = createContext(canvas);
      pixelR = new Renderer(gl);
      sceneR = new SceneRenderer(gl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    // ---- sizing & render loop ----------------------------------------------------------------
    let cssW = 0;
    let sizeDirty = true;
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cssW = r.width;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      sizeDirty = true;
      ed.setViewport(r.width, r.height);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const seen = { image: -1, pixel: -1, palette: -1, render: -1, mode: '' };
    let objBuf = new Uint16Array(1);
    let raf = 0;
    let lastT = performance.now();

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      ed.advance(t - lastT);
      lastT = t;
      if (gl.isContextLost()) return;
      const mode = ed.mode;
      if (mode !== seen.mode) {
        seen.mode = mode;
        seen.render = seen.image = seen.pixel = seen.palette = -1;
      }
      if (seen.palette !== ed.paletteVersion) {
        const cg = ed.displayCgram();
        if (mode === 'pixel') pixelR.uploadPalette(cg);
        else sceneR.uploadCgram(cg);
        seen.palette = ed.paletteVersion;
      }
      if (seen.render === ed.renderVersion && !sizeDirty) return;
      seen.render = ed.renderVersion;
      sizeDirty = false;
      const dpr = canvas.width / (cssW || 1);
      const v = ed.view;

      if (mode === 'pixel') {
        if (seen.image !== ed.imageVersion || seen.pixel !== ed.pixelVersion) {
          pixelR.uploadPixels(ed.image);
          seen.image = ed.imageVersion;
          seen.pixel = ed.pixelVersion;
        }
        let cursor: [number, number, number, number] | null = null;
        if (ed.hover) {
          const size = BRUSH_TOOLS.has(ed.tool) ? ed.settings.brushSize : 1;
          const off = Math.floor((size - 1) / 2);
          cursor = [ed.hover.x - off, ed.hover.y - off, size, size];
        }
        const s = ed.spriteAsset;
        const i = ed.frameIndex;
        const onion = !!s && ed.onionSkin && s.frames.length > 1;
        pixelR.render(
          {
            originX: v.panX * dpr,
            originY: v.panY * dpr,
            scaleX: ed.scaleX() * dpr,
            scaleY: v.zoom * dpr,
            base: ed.base,
            pixelGrid: v.pixelGrid,
            tileGrid: v.tileGrid,
            showBackdrop: v.showBackdrop,
            cursor,
            mirrorH: ed.settings.mirrorH,
            mirrorV: ed.settings.mirrorV,
            wrap: ed.settings.wrap,
            onionPrev: onion && i > 0 ? s!.frames[i - 1].image : null,
            onionNext: onion && i < s!.frames.length - 1 ? s!.frames[i + 1].image : null,
          },
          canvas.width,
          canvas.height,
        );
      } else {
        const { region } = { region: ed.sceneRegion() };
        if (objBuf.length !== region.w * region.h) objBuf = new Uint16Array(region.w * region.h);
        const f = buildSceneFrame(ed, { overlays: true, objBuf });
        sceneR.uploadObj(f.obj, f.region.w, f.region.h);
        sceneR.render(
          { ...f.params, originX: v.panX * dpr, originY: v.panY * dpr, scaleX: ed.scaleX() * dpr, scaleY: v.zoom * dpr },
          canvas.width,
          canvas.height,
        );
      }
    };
    raf = requestAnimationFrame(frame);

    registerSceneCapture((mode) => {
      const f = buildSceneFrame(ed, { overlays: false, view: mode });
      sceneR.uploadCgram(ed.displayCgram());
      sceneR.uploadObj(f.obj, f.region.w, f.region.h);
      const rgba = sceneR.capture(f.params);
      seen.render = seen.palette = -1; // restore the live view next frame
      return { rgba, w: f.region.w, h: f.region.h };
    });

    // ---- input -------------------------------------------------------------------------------
    const toDoc = (clientX: number, clientY: number) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.floor((clientX - r.left - ed.view.panX) / ed.scaleX()),
        y: Math.floor((clientY - r.top - ed.view.panY) / ed.view.zoom),
      };
    };
    let spaceDown = false;
    let pan: { x: number; y: number; panX: number; panY: number; id: number } | null = null;

    const onDown = (e: PointerEvent) => {
      canvas.focus();
      if (e.button === 1 || (e.button === 0 && spaceDown)) {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        pan = { x: e.clientX, y: e.clientY, panX: ed.view.panX, panY: ed.view.panY, id: e.pointerId };
        return;
      }
      if (e.button !== 0 && e.button !== 2) return;
      if (ed.isDrawing) return;
      canvas.setPointerCapture(e.pointerId);
      const p = toDoc(e.clientX, e.clientY);
      ed.setHover(p);
      ed.pointerDown(p.x, p.y, e.button === 2 ? 2 : 0, modsOf(e));
    };
    const onMove = (e: PointerEvent) => {
      if (pan && e.pointerId === pan.id) {
        ed.setView({ panX: pan.panX + e.clientX - pan.x, panY: pan.panY + e.clientY - pan.y }, true);
        return;
      }
      if (ed.isDrawing) {
        // Coalesced events recover every sample the OS delivered between frames.
        const evs = e.getCoalescedEvents?.() ?? [];
        for (const ev of evs.length ? evs : [e]) {
          const p = toDoc(ev.clientX, ev.clientY);
          ed.pointerMove(p.x, p.y, modsOf(e));
        }
      }
      ed.setHover(toDoc(e.clientX, e.clientY));
    };
    const onUp = (e: PointerEvent) => {
      if (pan && e.pointerId === pan.id) {
        pan = null;
        ed.emit();
        return;
      }
      ed.pointerUp();
    };
    const onLeave = () => {
      if (!ed.isDrawing) ed.setHover(null);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      ed.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1 : -1);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e)) {
        e.preventDefault();
        if (!spaceDown) {
          spaceDown = true;
          setPanMode(true);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDown = false;
        setPanMode(false);
      }
    };
    const noMenu = (e: Event) => e.preventDefault();

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', noMenu);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      registerSceneCapture(null);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', noMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [editor]);

  return (
    <div className={`canvas-wrap${panMode ? ' pan' : ''}`} ref={wrapRef}>
      <canvas ref={canvasRef} tabIndex={0} aria-label="Pixel canvas" />
      {editor.target.kind === 'sprite' && <SpriteOverlay editor={editor} />}
      {error && (
        <div className="gl-error">
          <strong>Can't start the renderer</strong>
          <p>{error}</p>
          <p>HiROM Pixel needs WebGL2 (Chrome/Edge/Firefox 100+, Safari 16+). Check that hardware acceleration is enabled.</p>
        </div>
      )}
    </div>
  );
}
