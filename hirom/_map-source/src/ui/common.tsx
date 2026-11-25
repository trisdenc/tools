import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MapEditor, ToolId } from '../core/editor';
import type { PropValue, Props } from '../core/level';

export const useVersion = (ed: MapEditor): number => useSyncExternalStore(ed.subscribe, ed.getVersion);
export const useFast = (ed: MapEditor): number => useSyncExternalStore(ed.subscribeFast, ed.getFastVersion);

/** True when keyboard focus is in a text field, so global shortcuts should stand aside. */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return true;
  if (tag === 'INPUT') return !['checkbox', 'radio', 'range', 'button'].includes((t as HTMLInputElement).type);
  return false;
}

/** Shows a pre-rendered canvas, scaled with crisp pixels. */
export function Thumb({ src, size, width, height, title, className }: { src: HTMLCanvasElement | null; size: number; width?: number; height?: number; title?: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = src?.width ?? 1, h = src?.height ?? 1;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    if (src) ctx.drawImage(src, 0, 0);
  }, [src]);
  return <canvas ref={ref} className={`thumb ${className ?? ''}`} style={{ width: width ?? size, height: height ?? size }} title={title} />;
}

// 8×8 one-bit pixel icons, matching HiROM Pixel's toolbar.
const ICONS: Record<ToolId | 'play' | 'stop', string[]> = {
  brush: ['......##', '.....###', '....###.', '...###..', '..###...', '.##.....', '##......', '#.......'],
  autotile: ['..####..', '.#....#.', '#.####.#', '#.#..#.#', '#.#..#.#', '#.####.#', '.#....#.', '..####..'],
  fill: ['..##....', '.#..#...', '#.##.#..', '#....##.', '.#..#.##', '..##..##', '......#.', '........'],
  rect: ['........', '########', '#......#', '#......#', '#......#', '#......#', '########', '........'],
  select: ['##.##.##', '#......#', '........', '#......#', '#......#', '........', '#......#', '##.##.##'],
  picker: ['......##', '.....###', '....###.', '...#.#..', '..#.#...', '.#.#....', '#.#.....', '##......'],
  eraser: ['...####.', '..#..##.', '.#..#.#.', '####..#.', '#..#.#..', '#..##...', '####....', '........'],
  collision: ['########', '#.#.#.##', '##.#.#.#', '#.#.#.##', '##.#.#.#', '#.#.#.##', '##.#.#.#', '########'],
  entity: ['..###...', '.#####..', '.#.#.#..', '.#####..', '..###...', '.#####..', '#.###.#.', '.#...#..'],
  zone: ['###..###', '#......#', '#......#', '........', '........', '#......#', '#......#', '###..###'],
  path: ['#.......', '##......', '.#......', '.##.....', '..###...', '....##..', '.....##.', '......##'],
  play: ['.#......', '.##.....', '.###....', '.####...', '.####...', '.###....', '.##.....', '.#......'],
  stop: ['........', '.######.', '.######.', '.######.', '.######.', '.######.', '.######.', '........'],
};

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS; size?: number }) {
  const rects: JSX.Element[] = [];
  ICONS[name].forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '#') rects.push(<rect key={`${x},${y}`} x={x} y={y} width={1} height={1} />);
    }),
  );
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges" fill="currentColor" aria-hidden>
      {rects}
    </svg>
  );
}

/** Number field that commits on blur / Enter and clamps. */
export function NumInput({ value, onChange, min, max, step = 1, width = 64, title }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; width?: number; title?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    let v = Number(text);
    if (!Number.isFinite(v)) {
      setText(String(value));
      return;
    }
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    if (v !== value) onChange(v);
    else setText(String(value));
  };
  return (
    <input
      type="number"
      value={text}
      min={min}
      max={max}
      step={step}
      style={{ width }}
      title={title}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** Text field that commits on blur / Enter. */
export function TextInput({ value, onChange, placeholder, width, className }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number | string; className?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className={className ?? 'text'}
      value={text}
      placeholder={placeholder}
      style={{ width }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onChange(text)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

const typeOf = (v: PropValue): 'number' | 'string' | 'boolean' => (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string');

/** Typed key / value editor. `inherited` values show greyed until overridden. */
export function PropsEditor({ value, inherited, onChange }: { value: Props; inherited?: Props; onChange: (v: Props) => void }) {
  const [newKey, setNewKey] = useState('');
  const keys = [...new Set([...Object.keys(inherited ?? {}), ...Object.keys(value)])];
  const set = (k: string, v: PropValue | undefined) => {
    const next = { ...value };
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };
  return (
    <div className="props">
      {keys.length === 0 && <div className="hint">No properties.</div>}
      {keys.map((k) => {
        const own = k in value;
        const v = own ? value[k] : inherited![k];
        const t = typeOf(v);
        return (
          <div className={`prop ${own ? '' : 'inherited'}`} key={k}>
            <span className="prop-key" title={own ? k : `${k} (from template)`}>{k}</span>
            {t === 'boolean' ? (
              <input type="checkbox" checked={v as boolean} onChange={(e) => set(k, e.target.checked)} />
            ) : t === 'number' ? (
              <NumInput value={v as number} onChange={(x) => set(k, x)} width={80} />
            ) : (
              <TextInput value={v as string} onChange={(x) => set(k, x)} width={110} />
            )}
            <select
              value={t}
              title="Type"
              onChange={(e) => set(k, e.target.value === 'number' ? Number(v) || 0 : e.target.value === 'boolean' ? !!v && v !== 'false' : String(v))}
            >
              <option value="number">num</option>
              <option value="string">text</option>
              <option value="boolean">bool</option>
            </select>
            {own ? (
              <button className="x" title={inherited && k in inherited ? 'Reset to the template value' : 'Remove'} onClick={() => set(k, undefined)}>
                ×
              </button>
            ) : (
              <span className="x" />
            )}
          </div>
        );
      })}
      <div className="row">
        <input className="text" placeholder="new property" value={newKey} style={{ flex: 1 }} onChange={(e) => setNewKey(e.target.value.replace(/\s+/g, '_'))} />
        <button
          className="btn small"
          disabled={!newKey || newKey in value}
          onClick={() => {
            set(newKey, 0);
            setNewKey('');
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

export function download(data: Blob | Uint8Array | string, name: string, type = 'application/octet-stream'): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}
