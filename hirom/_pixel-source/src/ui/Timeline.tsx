import { useEffect, useRef } from 'react';
import { Editor } from '../core/editor';
import { frameAt } from '../core/project';
import { toRgba } from '../io/exporters';
import { useFastVersion } from './hooks';

/** 60 FPS animation timeline for the open sprite: frames, durations in ticks, boxes and anchor. */
export function Timeline({ editor }: { editor: Editor }) {
  useFastVersion(editor);
  const s = editor.spriteAsset;
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ed = editor;
    let raf = 0;
    let lastKey = '';
    const scratch = document.createElement('canvas');
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const sp = ed.spriteAsset;
      const strip = stripRef.current;
      if (!sp || !strip) return;
      const key = [sp.id, sp.frames.length, ed.pixelVersion, ed.paletteVersion, ed.structureVersion, sp.paletteId].join(':');
      if (key === lastKey) return;
      lastKey = key;
      scratch.width = sp.width;
      scratch.height = sp.height;
      strip.querySelectorAll('canvas').forEach((c, i) => {
        const f = sp.frames[i];
        if (!f) return;
        scratch.getContext('2d')!.putImageData(new ImageData(toRgba(f.image, ed.cgram, sp.paletteId * 16, false), sp.width, sp.height), 0, 0);
        c.width = sp.width;
        c.height = sp.height;
        const ctx = c.getContext('2d')!;
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(scratch, 0, 0);
      });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [editor]);

  if (!s) return null;
  const cur = editor.frameIndex;
  const total = s.frames.reduce((n, f) => n + f.duration, 0);
  const playingFrame = editor.playing ? frameAt(s, editor.tick) : -1;
  const f = s.frames[cur];

  return (
    <div className="timeline">
      <div className="tl-controls">
        <button className={`btn${editor.playing ? ' on' : ''}`} onClick={() => editor.setPlaying(!editor.playing)} title="Play / stop (Enter)">
          {editor.playing ? '■ Stop' : '▶ Play'}
        </button>
        <span className="hint mono">
          {s.frames.length} frames · {total} ticks · {(total / 60).toFixed(2)} s @ 60 Hz
        </span>
        <span className="sep" />
        <button className="btn small" onClick={() => editor.addFrame(false)} title="Add a blank frame after this one">+ Frame</button>
        <button className="btn small" onClick={() => editor.addFrame(true)} title="Duplicate this frame">Duplicate</button>
        <button className="btn small" onClick={() => editor.moveFrame(-1)} disabled={cur === 0} title="Move left">◀</button>
        <button className="btn small" onClick={() => editor.moveFrame(1)} disabled={cur === s.frames.length - 1} title="Move right">▶</button>
        <button className="btn small" onClick={() => editor.deleteFrame()} disabled={s.frames.length < 2}>Delete</button>
        <span className="sep" />
        <label className="opt" title="Anchor point used to position the sprite in the scene">
          Origin
          <input type="number" value={s.originX} onChange={(e) => editor.setOrigin(+e.target.value | 0, s.originY)} />
          <input type="number" value={s.originY} onChange={(e) => editor.setOrigin(s.originX, +e.target.value | 0)} />
        </label>
      </div>
      <div className="tl-frames" ref={stripRef}>
        {s.frames.map((fr, i) => (
          <div key={i} className={`tl-frame${i === cur ? ' current' : ''}${i === playingFrame ? ' playing' : ''}`}>
            <button className="tl-thumb checker" onClick={() => editor.setFrame(i)} title={`Frame ${i + 1}`}>
              <canvas />
            </button>
            <label className="tl-dur" title="Duration in 60 Hz frames">
              <input type="number" min={1} max={999} value={fr.duration} onChange={(e) => editor.setFrameDuration(i, +e.target.value)} />
              <span className="hint">f</span>
            </label>
          </div>
        ))}
      </div>
      {f && (f.hitboxes.length > 0 || f.hurtboxes.length > 0) && (
        <div className="tl-boxes">
          {f.hitboxes.map((b, i) => (
            <span key={`h${i}`} className="boxtag hit">
              hit {b.x},{b.y} {b.w}×{b.h}
              <button className="x" onClick={() => editor.deleteBox('hit', i)}>×</button>
            </span>
          ))}
          {f.hurtboxes.map((b, i) => (
            <span key={`u${i}`} className="boxtag hurt">
              hurt {b.x},{b.y} {b.w}×{b.h}
              <button className="x" onClick={() => editor.deleteBox('hurt', i)}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
