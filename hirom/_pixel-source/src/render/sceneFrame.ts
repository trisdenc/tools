import { Editor } from '../core/editor';
import { Region, buildObjBuffer, layerTilemap, layerTileset, objectBounds, sceneMapSize } from '../core/scene';
import { SceneLayerInput, SceneOverlays, SceneParams } from './sceneRenderer';

export interface SceneFrame {
  params: SceneParams;
  obj: Uint16Array;
  region: Region;
}

const NONE: [number, number, number, number] = [0, 0, 0, 0];

/**
 * Collect everything the scene shader needs for one frame. By default it frames what the editor
 * shows; `view` forces the whole map or the camera screen (used for export).
 */
export function buildSceneFrame(
  ed: Editor,
  opts: { overlays: boolean; view?: 'screen' | 'map'; objBuf?: Uint16Array },
): SceneFrame {
  const p = ed.project;
  const sc = p.scene;
  const screenMode = opts.view ? opts.view === 'screen' : ed.sceneView === 'screen';
  const cam = ed.camera;
  const mapSize = sceneMapSize(p);
  const region: Region = screenMode
    ? { x: Math.round(cam.x), y: Math.round(cam.y), w: sc.resolution.width, h: sc.resolution.height }
    : { x: 0, y: 0, w: mapSize.w, h: mapSize.h };

  const layers: (SceneLayerInput | null)[] = sc.layers.map((l, i) => {
    const map = layerTilemap(p, i);
    const ts = layerTileset(p, i);
    if (!map || !ts || !l.visible) return null;
    return {
      tiles: ts.sheet,
      tilesVersion: ed.pixelVersion,
      cells: map.cells,
      mapW: map.width,
      mapH: map.height,
      cellsVersion: ed.cellsVersion,
      bpp: ts.bpp,
      scrollX: screenMode ? Math.round(cam.x * l.scrollFactor) : 0,
      scrollY: screenMode ? Math.round(cam.y * l.scrollFactor) : 0,
    };
  });

  let mainMask = 0, subMask = 0, mathMask = 16;
  sc.layers.forEach((l, i) => {
    if (!l.visible) return;
    if (l.main) mainMask |= 1 << i;
    if (l.sub) subMask |= 1 << i;
    if (l.math) mathMask |= 1 << i;
  });
  if (sc.obj.visible && sc.obj.main) mainMask |= 16;
  if (sc.obj.visible && sc.obj.sub) subMask |= 16;
  if (sc.colorMath.backdropMath) mathMask |= 32;

  const obj = buildObjBuffer(p, region, ed.tick, ed.playing, opts.objBuf);

  let overlays: SceneOverlays | null = null;
  if (opts.overlays) {
    const rect = (x: number, y: number, w: number, h: number): [number, number, number, number] => [x - region.x, y - region.y, w, h];
    let cursor = NONE;
    const h = ed.hover;
    if (h && ed.sceneTool !== 'object') {
      const s = ed.layerScroll(ed.activeLayer);
      const cw = ed.sceneTool === 'stamp' || ed.sceneTool === 'tileRect' ? ed.stamp.w : 1;
      const ch = ed.sceneTool === 'stamp' || ed.sceneTool === 'tileRect' ? ed.stamp.h : 1;
      cursor = [Math.floor((h.x + s.x) / 8) * 8 - s.x, Math.floor((h.y + s.y) / 8) * 8 - s.y, cw * 8, ch * 8];
    }
    let selection = NONE;
    const so = ed.selectedObject;
    const ss = so && p.sprites.find((s) => s.id === so.spriteId);
    if (so && ss) {
      const b = objectBounds(so, ss);
      selection = rect(b.x, b.y, b.w, b.h);
    }
    let pick = NONE;
    if (ed.pickRect) {
      const s = ed.layerScroll(ed.activeLayer);
      const r = ed.pickRect;
      pick = [r.x * 8 - s.x, r.y * 8 - s.y, r.w * 8, r.h * 8];
    }
    overlays = {
      active: ed.activeLayer,
      grid: ed.view.tileGrid > 0,
      priority: ed.showPriority,
      screen: screenMode ? NONE : [Math.round(ed.camera.x), Math.round(ed.camera.y), sc.resolution.width, sc.resolution.height],
      cursor,
      selection,
      pick,
    };
  }

  return {
    region,
    obj,
    params: {
      originX: 0,
      originY: 0,
      scaleX: 1,
      scaleY: 1,
      regionW: region.w,
      regionH: region.h,
      layers,
      mainMask,
      subMask,
      mathMask,
      bg3Priority: sc.bg3Priority,
      subtract: sc.colorMath.mode === 'sub',
      half: sc.colorMath.half,
      useFixed: sc.colorMath.source === 'fixed',
      fixedColor: sc.colorMath.fixedColor,
      overlays,
    },
  };
}
