import { useEffect, useRef, useState } from 'react';
import {
  Bgr555,
  DEFAULT_RAMP,
  RampOptions,
  fromHex,
  fromHsv,
  generateRamp,
  pack,
  toHex,
  toHsv,
  toSnesHex,
  unpack,
} from '../core/color';
import { blockSize, isTransparentSlot, paletteBase, slotToPalette } from '../core/cgram';
import { Editor } from '../core/editor';

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  display?: string;
  onChange: (v: number) => void;
  gradient?: string;
}) {
  return (
    <label className="slider">
      <span className="slider-label">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        style={props.gradient ? { background: props.gradient } : undefined}
        onChange={(e) => props.onChange(+e.target.value)}
      />
      <span className="num">{props.display ?? props.value}</span>
    </label>
  );
}

function CgramGrid({ editor }: { editor: Editor }) {
  const bpp = editor.bpp;
  const bs = blockSize(bpp);
  const base = editor.base;
  const [lo, hi] = editor.paletteRange();
  const reachLo = paletteBase(bpp, lo);
  const reachHi = paletteBase(bpp, hi) + bs;

  const onPick = (slot: number, button: 0 | 2) => {
    const m = slotToPalette(bpp, slot);
    if (m && m.paletteId >= lo && m.paletteId <= hi) {
      editor.setPaletteId(m.paletteId);
      if (button === 2) editor.setSecondary(m.local);
      else editor.setPrimary(m.local);
    }
    editor.selectSlot(slot);
  };

  return (
    <div className="cgram" role="grid" aria-label="CGRAM, 16 sub-palettes of 16 colors">
      {Array.from({ length: 16 }, (_, row) => (
        <div className="cgram-row" key={row} role="row">
          <span className={`row-label${row < 8 ? '' : ' obj'}`} title={row < 8 ? 'Background palette' : 'Sprite (OBJ) palette'}>
            {row < 8 ? 'BG' : 'OB'}
            {row.toString(16).toUpperCase()}
          </span>
          {Array.from({ length: 16 }, (_, col) => {
            const slot = row * 16 + col;
            const active = slot >= base && slot < base + bs;
            const local = slot - base;
            const cls = [
              'sw',
              active && 'active',
              (slot < reachLo || slot >= reachHi) && 'unreachable',
              editor.selectedSlot === slot && 'selected',
              isTransparentSlot(bpp, slot) && 'transparent',
              slot === 0 && 'backdrop',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button
                key={col}
                role="gridcell"
                className={cls}
                style={{ background: toHex(editor.cgram[slot]) }}
                title={`Slot ${slot} (pal ${row}, idx ${col}) ${toSnesHex(editor.cgram[slot])}${slot === 0 ? ' — backdrop' : isTransparentSlot(bpp, slot) ? ' — transparent' : ''}`}
                onClick={() => onPick(slot, 0)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onPick(slot, 2);
                }}
              >
                {active && local === editor.primary && <span className="mark p">P</span>}
                {active && local === editor.secondary && <span className="mark s">S</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ColorEditor({ editor }: { editor: Editor }) {
  const slot = editor.selectedSlot;
  const color = editor.cgram[slot];
  const [r, g, b] = unpack(color);
  const [hsv, setHsv] = useState(() => toHsv(color));
  const [hex, setHex] = useState(toHex(color));

  // Keep local HSV while dragging (snapping would otherwise make the sliders jump), but resync
  // whenever the stored color changes underneath us.
  useEffect(() => {
    if (fromHsv(hsv[0], hsv[1], hsv[2]) !== color) setHsv(toHsv(color));
    setHex(toHex(color));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color, slot]);

  const setChannel = (i: 0 | 1 | 2, v: number) => {
    const c: [number, number, number] = [r, g, b];
    c[i] = v;
    editor.setColor(slot, pack(c[0], c[1], c[2]));
  };
  const setHsvPart = (i: 0 | 1 | 2, v: number) => {
    const n: [number, number, number] = [...hsv];
    n[i] = v;
    setHsv(n);
    editor.setColor(slot, fromHsv(n[0], n[1], n[2]));
  };
  const ch = (rr: number, gg: number, bb: number) => toHex(pack(rr, gg, bb));

  return (
    <div className="color-editor">
      <div className="ce-head">
        <div className="big-swatch" style={{ background: toHex(color) }} />
        <div className="ce-meta">
          <div>
            Slot <b>{slot}</b> · pal {slot >> 4} idx {slot & 15}
          </div>
          <div className="mono">{toSnesHex(color)} BGR555</div>
          <input
            className="hex"
            value={hex}
            aria-label="Hex color"
            onChange={(e) => setHex(e.target.value)}
            onBlur={() => setHex(toHex(color))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const c = fromHex(hex);
                if (c !== null) editor.setColor(slot, c);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </div>
      </div>
      <Slider label="R" value={r} min={0} max={31} onChange={(v) => setChannel(0, v)}
        gradient={`linear-gradient(90deg, ${ch(0, g, b)}, ${ch(31, g, b)})`} />
      <Slider label="G" value={g} min={0} max={31} onChange={(v) => setChannel(1, v)}
        gradient={`linear-gradient(90deg, ${ch(r, 0, b)}, ${ch(r, 31, b)})`} />
      <Slider label="B" value={b} min={0} max={31} onChange={(v) => setChannel(2, v)}
        gradient={`linear-gradient(90deg, ${ch(r, g, 0)}, ${ch(r, g, 31)})`} />
      <Slider label="H" value={Math.round(hsv[0])} min={0} max={359} display={`${Math.round(hsv[0])}°`}
        onChange={(v) => setHsvPart(0, v)}
        gradient="linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)" />
      <Slider label="S" value={Math.round(hsv[1] * 100)} min={0} max={100} display={`${Math.round(hsv[1] * 100)}%`}
        onChange={(v) => setHsvPart(1, v / 100)} />
      <Slider label="V" value={Math.round(hsv[2] * 100)} min={0} max={100} display={`${Math.round(hsv[2] * 100)}%`}
        onChange={(v) => setHsvPart(2, v / 100)} />
    </div>
  );
}

function RampGenerator({ editor }: { editor: Editor }) {
  const bs = blockSize(editor.bpp);
  const [from, setFrom] = useState(2);
  const [to, setTo] = useState(Math.min(8, bs - 1));
  const [opts, setOpts] = useState<RampOptions>(DEFAULT_RAMP);
  const lo = Math.max(1, Math.min(from, to, bs - 1));
  const hi = Math.min(bs - 1, Math.max(from, to));
  const baseColor = editor.cgram[editor.selectedSlot];
  const ramp: Bgr555[] = generateRamp(baseColor, hi - lo + 1, opts);
  const base = editor.base;

  const apply = () => {
    const slots = ramp.map((_, i) => base + lo + i);
    editor.setColors(slots, ramp, 'Generate ramp');
  };

  return (
    <details className="panel-section">
      <summary>Ramp generator</summary>
      <p className="hint">Builds a hue-shifted shadow → highlight ramp around the selected color, snapped to 15-bit.</p>
      <div className="ramp-preview">
        {ramp.map((c, i) => (
          <span key={i} style={{ background: toHex(c) }} title={toSnesHex(c)} />
        ))}
      </div>
      <div className="row">
        <label className="opt">
          Index
          <input type="number" min={1} max={bs - 1} value={from} onChange={(e) => setFrom(+e.target.value)} />
        </label>
        <label className="opt">
          to
          <input type="number" min={1} max={bs - 1} value={to} onChange={(e) => setTo(+e.target.value)} />
        </label>
        <span className="hint">of pal {editor.paletteId}</span>
      </div>
      <Slider label="Hue" value={opts.hueShift} min={0} max={60} display={`${opts.hueShift}°`}
        onChange={(v) => setOpts({ ...opts, hueShift: v })} />
      <Slider label="Sat" value={Math.round(opts.saturationShift * 100)} min={0} max={60}
        display={`${Math.round(opts.saturationShift * 100)}%`}
        onChange={(v) => setOpts({ ...opts, saturationShift: v / 100 })} />
      <Slider label="Range" value={Math.round(opts.contrast * 100)} min={10} max={100}
        display={`${Math.round(opts.contrast * 100)}%`}
        onChange={(v) => setOpts({ ...opts, contrast: v / 100 })} />
      <button className="btn wide" onClick={apply}>
        Apply to indices {lo}–{hi}
      </button>
    </details>
  );
}

function PaletteOps({ editor }: { editor: Editor }) {
  const clip = useRef<Bgr555[] | null>(null);
  const [hasClip, setHasClip] = useState(false);
  const bs = Math.min(16, blockSize(editor.bpp));
  const base = editor.base;
  return (
    <div className="row ops">
      <button
        className="btn"
        title="Copy the active sub-palette"
        onClick={() => {
          clip.current = Array.from(editor.cgram.subarray(base, base + bs));
          setHasClip(true);
        }}
      >
        Copy pal
      </button>
      <button
        className="btn"
        disabled={!hasClip}
        title="Paste into the active sub-palette (index 0 kept)"
        onClick={() => {
          const c = clip.current;
          if (!c) return;
          const slots: number[] = [], vals: number[] = [];
          for (let i = 1; i < Math.min(bs, c.length); i++) {
            slots.push(base + i);
            vals.push(c[i]);
          }
          editor.setColors(slots, vals, 'Paste palette');
        }}
      >
        Paste pal
      </button>
      <span className="hint">, / . cycle palettes</span>
    </div>
  );
}

export function PaletteStudio({ editor }: { editor: Editor }) {
  return (
    <section className="panel">
      <h2>
        CGRAM <span className="sub">{editor.bpp}bpp · palette {editor.paletteId}</span>
      </h2>
      <CgramGrid editor={editor} />
      <PaletteOps editor={editor} />
      <ColorEditor editor={editor} />
      <RampGenerator editor={editor} />
    </section>
  );
}
