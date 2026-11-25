import { useState } from 'react';
import { Editor, Target } from '../core/editor';
import { tileCount } from '../core/tiles';

export type AssetKind = 'canvas' | 'tileset' | 'sprite';

interface Props {
  editor: Editor;
  onNew: (kind: AssetKind) => void;
  onError: (msg: string) => void;
}

function Item(props: {
  editor: Editor;
  kind: AssetKind;
  id: string;
  name: string;
  meta: string;
  active: boolean;
  target: Target;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const { editor, kind, id } = props;
  return (
    <li className={`asset${props.active ? ' active' : ''}`}>
      {editing ? (
        <input
          className="rename"
          autoFocus
          defaultValue={props.name}
          onBlur={(e) => {
            editor.renameAsset(kind, id, e.target.value.trim() || props.name);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button className="asset-btn" onClick={() => editor.setTarget(props.target)} onDoubleClick={() => setEditing(true)} title="Double-click to rename">
          <span className="asset-name">{props.name}</span>
          <span className="asset-meta">{props.meta}</span>
        </button>
      )}
      <button
        className="x"
        title="Delete"
        onClick={() => {
          if (!window.confirm(`Delete "${props.name}"? You can undo this.`)) return;
          const err = editor.deleteAsset(kind, id);
          if (err) props.onError(err);
        }}
      >
        ×
      </button>
    </li>
  );
}

export function AssetsPanel({ editor, onNew, onError }: Props) {
  const p = editor.project;
  const t = editor.target;
  const is = (kind: string, id: string) => t.kind === kind && 'id' in t && t.id === id;
  const section = (title: string, kind: AssetKind, children: JSX.Element[]) => (
    <div className="asset-section">
      <h3>
        {title}
        <button className="add" onClick={() => onNew(kind)} title={`New ${kind}`}>
          +
        </button>
      </h3>
      <ul>{children}</ul>
    </div>
  );
  return (
    <aside className="assets" aria-label="Project assets">
      <button className={`scene-btn${t.kind === 'scene' ? ' active' : ''}`} onClick={() => editor.setTarget({ kind: 'scene' })}>
        <b>Scene</b>
        <span className="asset-meta">Mode 1 · BG1–3 + OBJ</span>
      </button>
      {section(
        'Tilesets',
        'tileset',
        p.tilesets.map((ts) => (
          <Item key={ts.id} editor={editor} kind="tileset" id={ts.id} name={ts.name} meta={`${ts.bpp}bpp · ${tileCount(ts)} tiles`}
            active={is('tileset', ts.id)} target={{ kind: 'tileset', id: ts.id }} onError={onError} />
        )),
      )}
      {section(
        'Sprites',
        'sprite',
        p.sprites.map((s) => (
          <Item key={s.id} editor={editor} kind="sprite" id={s.id} name={s.name} meta={`${s.width}×${s.height} · ${s.frames.length}f`}
            active={is('sprite', s.id)} target={{ kind: 'sprite', id: s.id, frame: 0 }} onError={onError} />
        )),
      )}
      {section(
        'Canvases',
        'canvas',
        p.canvases.map((c) => (
          <Item key={c.id} editor={editor} kind="canvas" id={c.id} name={c.name} meta={`${c.image.width}×${c.image.height} · ${c.image.bpp}bpp`}
            active={is('canvas', c.id)} target={{ kind: 'canvas', id: c.id }} onError={onError} />
        )),
      )}
    </aside>
  );
}
