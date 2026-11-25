import { useMemo } from 'react';
import { Editor } from '../core/editor';
import { vramReport } from '../core/tiles';

const kb = (b: number) => (b / 1024).toFixed(b < 10240 ? 2 : 1);

/** 64 KB VRAM budget: compact bar in the status bar with a breakdown popover. */
export function VramMeter({ editor }: { editor: Editor }) {
  const version = editor.getVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const r = useMemo(() => vramReport(editor.project), [version]);
  const strict = editor.project.strict;
  const pct = r.total / r.limit;
  const over = strict && r.total > r.limit;
  return (
    <details className={`vram${over ? ' over' : pct > 0.85 && strict ? ' warn' : ''}`}>
      <summary title="Simulated VRAM usage — click for a breakdown">
        VRAM
        <span className="vram-bar">
          <span style={{ width: `${Math.min(100, pct * 100)}%` }} />
        </span>
        <span className="mono">
          {kb(r.total)} / {strict ? '64' : '∞'} KB
        </span>
      </summary>
      <div className="vram-pop">
        <h3>VRAM budget {strict ? '(Strict SNES)' : '(Modern 16-bit: no ceiling)'}</h3>
        <table>
          <tbody>
            {r.items.map((i, k) => (
              <tr key={k}>
                <td className={`kind ${i.kind}`}>{i.kind === 'tiles' ? 'CHR' : i.kind === 'map' ? 'MAP' : 'OBJ'}</td>
                <td>{i.label}</td>
                <td className="hint">{i.detail}</td>
                <td className="mono right">{kb(i.bytes)} KB</td>
              </tr>
            ))}
            <tr className="total">
              <td />
              <td>Total</td>
              <td className="hint">{(pct * 100).toFixed(1)}% of 64 KB</td>
              <td className="mono right">{kb(r.total)} KB</td>
            </tr>
          </tbody>
        </table>
        {over && <p className="warn">Over budget — real hardware can't hold all of this at once. Try Deduplicate &amp; Optimize on your tilesets.</p>}
        <p className="hint">CHR counts tiles up to the last used one. OBJ counts every frame's unique tiles (flips merged) as if all were resident.</p>
      </div>
    </details>
  );
}
