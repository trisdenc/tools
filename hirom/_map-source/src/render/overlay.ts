import type { MapEditor } from '../core/editor';
import { SCREEN_H, SCREEN_W, SHAPE, SHAPE_COLORS, ZONE_COLORS, levelPixels, materialOf, shapeOf } from '../core/level';
import { wordsCanvas } from '../ui/thumbs';

/**
 * Everything drawn on top of the WebGL scene, in CSS pixels: collision, zones, entity boxes and
 * paths, the 256×224 screen grid, validator hotspots, selections and the brush ghost.
 */
export function drawOverlay(ctx: CanvasRenderingContext2D, ed: MapEditor, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  const level = ed.level;
  if (!level) return;
  const { zoom: z, panX, panY } = ed.view;
  const X = (x: number) => panX + x * z, Y = (y: number) => panY + y * z;
  const { w: mapW, h: mapH } = levelPixels(level);
  const ms = level.meta.metatileSize;
  const W = level.meta.widthMetatiles, H = level.meta.heightMetatiles;
  const vx0 = Math.max(0, Math.floor(-panX / z / ms)), vy0 = Math.max(0, Math.floor(-panY / z / ms));
  const vx1 = Math.min(W, Math.ceil((w - panX) / z / ms)), vy1 = Math.min(H, Math.ceil((h - panY) / z / ms));

  // Level bounds
  ctx.strokeStyle = '#ffffff30';
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(X(0)) - 0.5, Math.round(Y(0)) - 0.5, mapW * z + 1, mapH * z + 1);

  // Metatile grid
  if (ed.overlays.metaGrid && ms * z >= 8) {
    ctx.strokeStyle = '#ffffff18';
    ctx.beginPath();
    for (let x = vx0; x <= vx1; x++) {
      ctx.moveTo(Math.round(X(x * ms)) + 0.5, Y(vy0 * ms));
      ctx.lineTo(Math.round(X(x * ms)) + 0.5, Y(vy1 * ms));
    }
    for (let y = vy0; y <= vy1; y++) {
      ctx.moveTo(X(vx0 * ms), Math.round(Y(y * ms)) + 0.5);
      ctx.lineTo(X(vx1 * ms), Math.round(Y(y * ms)) + 0.5);
    }
    ctx.stroke();
  }

  // Collision
  if (ed.overlays.collision) {
    const s = ms * z;
    for (let my = vy0; my < vy1; my++) {
      for (let mx = vx0; mx < vx1; mx++) {
        const c = level.collision[my * W + mx];
        if (!c) continue;
        drawCollisionCell(ctx, X(mx * ms), Y(my * ms), s, c, ed.ws.materials.find((m) => m.id === materialOf(c))?.color);
      }
    }
  }

  // 256×224 screen grid
  if (ed.overlays.screens) {
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#ffd23f80';
    ctx.beginPath();
    for (let x = SCREEN_W; x < mapW; x += SCREEN_W) {
      ctx.moveTo(Math.round(X(x)) + 0.5, Y(0));
      ctx.lineTo(Math.round(X(x)) + 0.5, Y(mapH));
    }
    for (let y = SCREEN_H; y < mapH; y += SCREEN_H) {
      ctx.moveTo(X(0), Math.round(Y(y)) + 0.5);
      ctx.lineTo(X(mapW), Math.round(Y(y)) + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Validator hotspots
  if (ed.overlays.validator && ed.validation) {
    ctx.strokeStyle = '#ff5d6c';
    ctx.fillStyle = '#ff5d6c22';
    for (const iss of ed.validation.issues) {
      ctx.fillRect(X(iss.x), Y(iss.y), SCREEN_W * z, SCREEN_H * z);
      ctx.strokeRect(X(iss.x) + 0.5, Y(iss.y) + 0.5, SCREEN_W * z - 1, SCREEN_H * z - 1);
    }
  }

  // Zones
  if (ed.overlays.zones) {
    ctx.font = '11px system-ui, sans-serif';
    for (const zn of level.zones) {
      const col = ZONE_COLORS[zn.type];
      const sel = ed.selection?.kind === 'zone' && ed.selection.id === zn.id;
      ctx.fillStyle = col + (sel ? '2a' : '14');
      ctx.fillRect(X(zn.x), Y(zn.y), zn.width * z, zn.height * z);
      ctx.strokeStyle = col;
      ctx.lineWidth = sel ? 2 : 1;
      ctx.setLineDash(zn.type === 'CAMERA_LOCK' ? [] : [4, 3]);
      ctx.strokeRect(X(zn.x) + 0.5, Y(zn.y) + 0.5, zn.width * z - 1, zn.height * z - 1);
      ctx.setLineDash([]);
      label(ctx, `${zn.name} · ${zn.type.replace('_', ' ').toLowerCase()}`, X(zn.x) + 4, Y(zn.y) + 4, col);
      if (sel) {
        ctx.fillStyle = col;
        for (const [px, py] of [[zn.x, zn.y], [zn.x + zn.width, zn.y], [zn.x + zn.width, zn.y + zn.height], [zn.x, zn.y + zn.height]])
          ctx.fillRect(X(px) - 4, Y(py) - 4, 8, 8);
      }
    }
    ctx.lineWidth = 1;
  }

  // Entities: boxes for sprite-less entities, outlines + labels otherwise, plus patrol paths
  if (ed.overlays.entities) {
    ctx.font = '11px system-ui, sans-serif';
    for (const e of level.entities) {
      const b = ed.entityBox(e);
      const sel = ed.selection?.kind === 'entity' && ed.selection.id === e.id;
      if (!b.sprite) {
        ctx.fillStyle = b.color + '55';
        ctx.fillRect(X(b.x), Y(b.y), b.w * z, b.h * z);
      }
      if (!b.sprite || sel || z >= 2) {
        ctx.strokeStyle = sel ? '#ffffff' : b.color + (b.sprite ? '80' : 'ff');
        ctx.lineWidth = sel ? 2 : 1;
        ctx.strokeRect(X(b.x) + 0.5, Y(b.y) + 0.5, b.w * z - 1, b.h * z - 1);
      }
      if ((!b.sprite && z >= 1) || sel) label(ctx, b.name, X(b.x), Y(b.y) - 16, b.color);
      if (e.path.length && (sel || ed.tool === 'path')) {
        ctx.strokeStyle = sel ? '#ffd23f' : '#ffd23f70';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(X(e.x), Y(e.y));
        for (const p of e.path) ctx.lineTo(X(p.x), Y(p.y));
        ctx.stroke();
        ctx.fillStyle = '#ffd23f';
        e.path.forEach((p, i) => {
          ctx.fillRect(X(p.x) - 3, Y(p.y) - 3, 6, 6);
          if (sel) label(ctx, String(i + 1), X(p.x) + 5, Y(p.y) - 6, '#ffd23f');
        });
      }
    }
    ctx.lineWidth = 1;
  }

  // Selection region (select tool)
  if (ed.selRect) {
    const r = ed.selRect;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.lineDashOffset = -(ed.tick % 18);
    ctx.strokeStyle = '#4fc3ff';
    ctx.strokeRect(X(r.x * ms) + 0.5, Y(r.y * ms) + 0.5, r.w * ms * z - 1, r.h * ms * z - 1);
    ctx.restore();
  }

  // Rectangle being dragged
  if (ed.dragRect) {
    const r = ed.dragRect;
    if (ed.tool === 'zone') {
      ctx.strokeStyle = '#ffd23f';
      ctx.strokeRect(X(Math.min(r.x, r.x + r.w)) + 0.5, Y(Math.min(r.y, r.y + r.h)) + 0.5, Math.abs(r.w) * z, Math.abs(r.h) * z);
    } else {
      const m = ed.metaRect(r);
      ctx.strokeStyle = ed.tool === 'select' ? '#4fc3ff' : '#ffffff';
      ctx.strokeRect(X(m.x * ms) + 0.5, Y(m.y * ms) + 0.5, m.w * ms * z - 1, m.h * ms * z - 1);
    }
  }

  drawCursor(ctx, ed, X, Y);
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = '#000000b0';
  ctx.fillRect(x, y, w, 15);
  ctx.fillStyle = color;
  ctx.fillText(text, x + 4, y + 11);
}

export function drawCollisionCell(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, c: number, materialColor?: string): void {
  const shape = shapeOf(c);
  const col = SHAPE_COLORS[shape];
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = col;
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(1, s / 12);
  switch (shape) {
    case SHAPE.SOLID:
      ctx.fillRect(x, y, s, s);
      break;
    case SHAPE.ONE_WAY:
      ctx.fillRect(x, y, s, Math.max(2, s / 5));
      ctx.globalAlpha = 0.25;
      ctx.fillRect(x, y, s, s);
      break;
    case SHAPE.LADDER:
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(x + s * 0.25, y);
      ctx.lineTo(x + s * 0.25, y + s);
      ctx.moveTo(x + s * 0.75, y);
      ctx.lineTo(x + s * 0.75, y + s);
      for (let k = 0.2; k < 1; k += 0.3) {
        ctx.moveTo(x + s * 0.25, y + s * k);
        ctx.lineTo(x + s * 0.75, y + s * k);
      }
      ctx.stroke();
      break;
    case SHAPE.WATER:
      ctx.globalAlpha = 0.3;
      ctx.fillRect(x, y, s, s);
      break;
    case SHAPE.HAZARD:
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.stroke();
      ctx.globalAlpha = 0.25;
      ctx.fillRect(x, y, s, s);
      break;
    case SHAPE.SLOPE_UP:
    case SHAPE.SLOPE_DOWN:
      ctx.beginPath();
      if (shape === SHAPE.SLOPE_UP) {
        ctx.moveTo(x, y + s);
        ctx.lineTo(x + s, y);
      } else {
        ctx.moveTo(x, y);
        ctx.lineTo(x + s, y + s);
      }
      ctx.lineTo(shape === SHAPE.SLOPE_UP ? x + s : x, y + s);
      ctx.lineTo(x + s, y + s);
      ctx.closePath();
      ctx.fill();
      break;
  }
  if (materialColor && materialOf(c)) {
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = materialColor;
    const d = Math.max(3, s / 4);
    ctx.fillRect(x + s - d - 1, y + 1, d, d);
  }
  ctx.restore();
}

function drawCursor(ctx: CanvasRenderingContext2D, ed: MapEditor, X: (v: number) => number, Y: (v: number) => number): void {
  const hv = ed.hover;
  if (!hv || ed.playing) return;
  const z = ed.view.zoom, ms = ed.level.meta.metatileSize;
  const src = ed.source;
  ctx.save();
  const tool = ed.tool;
  if (tool === 'brush' || tool === 'eraser' || tool === 'collision' || tool === 'autotile' || tool === 'fill' || tool === 'rect' || tool === 'picker') {
    const tileMode = ed.brushSource === 'tile' && tool !== 'collision' && tool !== 'autotile';
    const unit = tileMode ? 8 : ms;
    const cx = Math.floor(hv.x / unit) * unit, cy = Math.floor(hv.y / unit) * unit;
    if (tool === 'brush' && src) {
      const ts = ed.tilesetFor();
      const cg = src.cgram;
      let canvas: HTMLCanvasElement | null = null;
      if (ed.brushSource === 'metatile') {
        const m = ed.selectedMetatile();
        if (m) canvas = wordsCanvas(ts, ed.brushMetaWords(m), ed.k, cg);
      } else if (ed.brushSource === 'tile') canvas = wordsCanvas(ts, [ed.brushTileWord()], 1, cg);
      else if (ed.stamp) canvas = wordsCanvas(ts, ed.stamp.words, ed.stamp.w, cg);
      if (canvas) {
        ctx.globalAlpha = 0.6;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(canvas, X(cx), Y(cy), canvas.width * z, canvas.height * z);
        ctx.globalAlpha = 1;
      }
    }
    if (tool === 'collision') drawCollisionCell(ctx, X(cx), Y(cy), unit * z, ed.collisionBrush);
    const size = ed.brushSource === 'stamp' && tool === 'brush' && ed.stamp ? [ed.stamp.w * 8, ed.stamp.h * 8] : [unit, unit];
    ctx.strokeStyle = tool === 'eraser' ? '#ff5d6c' : '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(X(cx) + 0.5, Y(cy) + 0.5, size[0] * z - 1, size[1] * z - 1);
  } else if (tool === 'entity' && !ed.hitEntity(hv.x, hv.y) && ed.template) {
    const t = ed.template;
    const spr = ed.sprite(t.spriteRef);
    const w = spr?.width ?? t.width, h = spr?.height ?? t.height;
    const ax = Math.round(hv.x / 8) * 8, ay = Math.floor(hv.y / 8) * 8 + 7;
    ctx.strokeStyle = t.color;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(X(ax - (spr ? spr.originX : w / 2)) + 0.5, Y(ay - (spr ? spr.originY : h - 1)) + 0.5, w * z, h * z);
  }
  ctx.restore();
}
