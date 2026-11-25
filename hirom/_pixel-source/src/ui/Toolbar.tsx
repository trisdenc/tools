import { toHex } from '../core/color';
import { Editor, PIXEL_TOOLS, SCENE_TOOLS, ToolDef } from '../core/editor';
import { ToolIcon } from './icons';

function ColorChip({ editor, local, label }: { editor: Editor; local: number; label: string }) {
  const transparent = local === 0;
  return (
    <div
      className={`chip${transparent ? ' transparent' : ''}`}
      style={transparent ? undefined : { background: toHex(editor.colorOf(local)) }}
      title={`${label}: index ${local}${transparent ? ' (transparent)' : ''}`}
    />
  );
}

export function Toolbar({ editor }: { editor: Editor }) {
  const scene = editor.mode === 'scene';
  const tools: ToolDef[] = scene
    ? SCENE_TOOLS
    : PIXEL_TOOLS.filter((t) => t.id !== 'box' || editor.target.kind === 'sprite');
  return (
    <nav className="toolbar" aria-label="Tools">
      {tools.map((t) => (
        <button
          key={t.id}
          className={`tool${editor.tool === t.id ? ' active' : ''}`}
          title={`${t.label} (${t.key})`}
          aria-pressed={editor.tool === t.id}
          onClick={() => editor.setTool(t.id)}
        >
          <ToolIcon tool={t.id} />
        </button>
      ))}
      {!scene && (
        <>
          <div className="chips" onClick={() => editor.swapColors()} title="Primary / secondary color — click or press X to swap">
            <ColorChip editor={editor} local={editor.secondary} label="Secondary (right click)" />
            <ColorChip editor={editor} local={editor.primary} label="Primary (left click)" />
          </div>
          <div className="chip-idx">
            {editor.primary}/{editor.secondary}
          </div>
        </>
      )}
    </nav>
  );
}
