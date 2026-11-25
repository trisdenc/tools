import { useEffect, useRef, useState } from 'react';
import { paletteBase } from '../core/cgram';
import { Editor } from '../core/editor';
import { IndexedImage } from '../core/image';
import { frameAt } from '../core/project';
import { toRgba } from '../io/exporters';

/**
 * Actual-size preview (tiled 3×3 in wrap mode; the live animation for sprites while playing)
 * plus a strip of every sub-palette variant the asset may use.
 */
export function Preview({ editor }: { editor: Editor }) {
  const [scale, setScale] = useState(2);
  const mainRef = useRef<HTMLCanvasElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [lo, hi] = editor.paletteRange();
  const count = hi - lo + 1;
  const showStrip = count > 1 && editor.image.width * editor.image.height <= 128 * 128;

  useEffect(() => {
    const ed = editor;
    const scratch = document.createElement('canvas');
    let raf = 0;
    let lastKey = '';
    let lastStrip = 0;
    let stripKey = '';

    const drawInto = (canvas: HTMLCanvasElement, img: IndexedImage, base: number, s: number, tiles: number, par: boolean) => {
      if (scratch.width !== img.width || scratch.height !== img.height) {
        scratch.width = img.width;
        scratch.height = img.height;
      }
      const rgba = toRgba(img, ed.displayCgram(), base, ed.view.showBackdrop);
      scratch.getContext('2d')!.putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
      const tw = Math.round(img.width * s * (par ? 8 / 7 : 1));
      const th = img.height * s;
      if (canvas.width !== tw * tiles || canvas.height !== th * tiles) {
        canvas.width = tw * tiles;
        canvas.height = th * tiles;
      }
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) ctx.drawImage(scratch, tx * tw, ty * th, tw, th);
    };

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const sprite = ed.spriteAsset;
      const animating = !!sprite && ed.playing && sprite.frames.length > 1;
      const img = animating ? sprite!.frames[frameAt(sprite!, ed.tick)].image : ed.image;
      const key = [ed.imageVersion, ed.pixelVersion, ed.paletteVersion, ed.paletteId, ed.view.showBackdrop, ed.view.par,
        ed.settings.wrap, scale, animating ? frameAt(sprite!, ed.tick) : -1, img.width].join(':');
      if (key !== lastKey && mainRef.current) {
        lastKey = key;
        drawInto(mainRef.current, img, ed.base, scale, ed.settings.wrap ? 3 : 1, ed.view.par);
      }
      // The palette strip is costlier, so throttle it while drawing.
      const sKey = [ed.imageVersion, ed.pixelVersion, ed.paletteVersion, ed.view.showBackdrop].join(':');
      if (stripRef.current && sKey !== stripKey && t - lastStrip > (ed.isDrawing ? 250 : 0)) {
        stripKey = sKey;
        lastStrip = t;
        const [plo] = ed.paletteRange();
        stripRef.current.querySelectorAll('canvas').forEach((c, i) => {
          const s = Math.max(1, Math.floor(40 / Math.max(ed.image.width, ed.image.height)));
          drawInto(c, ed.image, paletteBase(ed.bpp, plo + i), s, 1, false);
        });
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [editor, scale, showStrip, count, lo]);

  return (
    <section className="panel">
      <h2>
        Preview
        <span className="seg">
          {[1, 2, 3, 4].map((s) => (
            <button key={s} className={scale === s ? 'on' : ''} onClick={() => setScale(s)}>
              {s}×
            </button>
          ))}
        </span>
      </h2>
      <div className="preview-box">
        <canvas ref={mainRef} className="checker" />
      </div>
      {showStrip && (
        <>
          <h3>Palette swaps</h3>
          <div className="swap-strip" ref={stripRef}>
            {Array.from({ length: count }, (_, i) => (
              <button
                key={lo + i}
                className={`swap${editor.paletteId === lo + i ? ' on' : ''}`}
                title={`Preview with palette ${lo + i}`}
                onClick={() => editor.setPaletteId(lo + i)}
              >
                <canvas className="checker" />
                <span>{lo + i}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
