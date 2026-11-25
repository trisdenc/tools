import { useState } from 'react';
import { fromHex, toHex, toSnesHex } from '../core/color';
import { Editor } from '../core/editor';
import { MODE1_BPP } from '../core/project';

function Toggle({ on, onClick, label, title }: { on: boolean; onClick: () => void; label: string; title: string }) {
  return (
    <button className={`tg${on ? ' on' : ''}`} onClick={onClick} title={title} aria-pressed={on}>
      {label}
    </button>
  );
}

export function LayersPanel({ editor }: { editor: Editor }) {
  const sc = editor.project.scene;
  const upd = editor.updateScene.bind(editor);
  return (
    <section className="panel">
      <h2>
        Layers <span className="sub">Mode 1</span>
        <span className="seg">
          {(['edit', 'screen'] as const).map((v) => (
            <button key={v} className={editor.sceneView === v ? 'on' : ''} onClick={() => editor.setSceneView(v)}
              title={v === 'edit' ? 'Whole tilemap, no parallax' : 'The 256×224 camera window with parallax scrolling (arrow keys move the camera)'}>
              {v === 'edit' ? 'Map' : 'Screen'}
            </button>
          ))}
        </span>
      </h2>
      <div className="layers">
        <div className="layer-head">
          <span />
          <span>Layer</span>
          <span title="Visible">👁</span>
          <span title="Main screen">M</span>
          <span title="Sub screen">S</span>
          <span title="Color math">±</span>
          <span title="Parallax scroll factor">Scroll</span>
        </div>
        {sc.layers.map((l, i) => (
          <div key={l.id} className={`layer-row${editor.activeLayer === i ? ' active' : ''}`}>
            <input type="radio" name="active-layer" checked={editor.activeLayer === i} onChange={() => editor.setActiveLayer(i)} aria-label={`Edit ${l.id}`} />
            <button className="layer-name" onClick={() => editor.setActiveLayer(i)}>
              {l.id} <span className="hint">{MODE1_BPP[l.id]}bpp</span>
            </button>
            <Toggle on={l.visible} onClick={() => upd(() => (l.visible = !l.visible))} label="●" title="Visible" />
            <Toggle on={l.main} onClick={() => upd(() => (l.main = !l.main))} label="M" title="On the main screen" />
            <Toggle on={l.sub} onClick={() => upd(() => (l.sub = !l.sub))} label="S" title="On the sub screen (color-math source)" />
            <Toggle on={l.math} onClick={() => upd(() => (l.math = !l.math))} label="±" title="Apply color math where this layer is the main-screen pixel" />
            <input
              type="number"
              step={0.05}
              min={-4}
              max={4}
              value={l.scrollFactor}
              onChange={(e) => upd(() => (l.scrollFactor = Number.isFinite(+e.target.value) ? +e.target.value : 1))}
              aria-label={`${l.id} scroll factor`}
            />
          </div>
        ))}
        <div className="layer-row">
          <span />
          <span className="layer-name static">OBJ <span className="hint">4bpp</span></span>
          <Toggle on={sc.obj.visible} onClick={() => upd(() => (sc.obj.visible = !sc.obj.visible))} label="●" title="Visible" />
          <Toggle on={sc.obj.main} onClick={() => upd(() => (sc.obj.main = !sc.obj.main))} label="M" title="On the main screen" />
          <Toggle on={sc.obj.sub} onClick={() => upd(() => (sc.obj.sub = !sc.obj.sub))} label="S" title="On the sub screen" />
          <span className="hint center-text" title="Per object (see Objects)">obj</span>
          <span className="hint">1.0</span>
        </div>
      </div>
      <div className="row">
        <label className="opt" title="$2105 bit 3: BG3 high-priority tiles appear in front of everything (HUDs)">
          <input type="checkbox" checked={sc.bg3Priority} onChange={(e) => upd(() => (sc.bg3Priority = e.target.checked))} />
          BG3 on top
        </label>
      </div>
      <div className="row">
        <span className="hint">Auto-scroll px/frame</span>
        <label className="opt">
          X
          <input type="number" step={0.25} value={sc.scroll.speedX} onChange={(e) => upd(() => (sc.scroll.speedX = +e.target.value || 0))} />
        </label>
        <label className="opt">
          Y
          <input type="number" step={0.25} value={sc.scroll.speedY} onChange={(e) => upd(() => (sc.scroll.speedY = +e.target.value || 0))} />
        </label>
        <button className="btn small" onClick={() => editor.resetCamera()} title="Camera back to 0,0">
          ⌂ {Math.round(editor.camera.x)},{Math.round(editor.camera.y)}
        </button>
      </div>
    </section>
  );
}

export function FxPanel({ editor }: { editor: Editor }) {
  const sc = editor.project.scene;
  const cm = sc.colorMath;
  const upd = editor.updateScene.bind(editor);
  const [hex, setHex] = useState<string | null>(null);
  const cycles = editor.project.cycles;
  const slot = editor.selectedSlot;
  return (
    <section className="panel">
      <h2>Color math &amp; FX</h2>
      <div className="row">
        <span className="seg inline">
          {(['add', 'sub'] as const).map((m) => (
            <button key={m} className={cm.mode === m ? 'on' : ''} onClick={() => upd(() => (cm.mode = m))}>
              {m === 'add' ? 'Add' : 'Subtract'}
            </button>
          ))}
        </span>
        <label className="opt" title="Halve the result (50% blend). Skipped where the sub screen is transparent.">
          <input type="checkbox" checked={cm.half} onChange={(e) => upd(() => (cm.half = e.target.checked))} />
          Half
        </label>
        <label className="opt" title="Apply color math to the backdrop color too">
          <input type="checkbox" checked={cm.backdropMath} onChange={(e) => upd(() => (cm.backdropMath = e.target.checked))} />
          Backdrop
        </label>
      </div>
      <div className="row">
        <span className="hint">Blend with</span>
        <span className="seg inline">
          {(['subscreen', 'fixed'] as const).map((s) => (
            <button key={s} className={cm.source === s ? 'on' : ''} onClick={() => upd(() => (cm.source = s))}>
              {s === 'subscreen' ? 'Sub screen' : 'Fixed color'}
            </button>
          ))}
        </span>
        <span className="swatch-sm" style={{ background: toHex(cm.fixedColor) }} title={`Fixed color ${toSnesHex(cm.fixedColor)} (also used where the sub screen is empty)`} />
        <input
          className="hex"
          value={hex ?? toHex(cm.fixedColor)}
          onChange={(e) => setHex(e.target.value)}
          onBlur={() => {
            const c = hex ? fromHex(hex) : null;
            if (c !== null) upd(() => (cm.fixedColor = c));
            setHex(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label="Fixed color"
        />
      </div>
      <p className="hint">
        Put the layer to blend on the sub screen (S), then enable ± on the layer it should affect. Sprites use their object's color-math flag
        {editor.project.strict ? '; only OBJ palettes 12–15 can blend (hardware rule).' : '.'}
      </p>

      <h3>Palette cycling</h3>
      {cycles.length === 0 && <p className="hint">No cycles. Select a color in CGRAM, then add one.</p>}
      {cycles.map((c) => (
        <div key={c.id} className="cycle">
          <input type="checkbox" checked={c.enabled} onChange={(e) => editor.updateCycle(c.id, { enabled: e.target.checked })} title="Enabled" />
          <span className="mono">pal {c.paletteId}</span>
          <input type="number" min={0} max={15} value={c.start} onChange={(e) => editor.updateCycle(c.id, { start: +e.target.value })} aria-label="First index" />
          –
          <input type="number" min={0} max={15} value={c.end} onChange={(e) => editor.updateCycle(c.id, { end: +e.target.value })} aria-label="Last index" />
          <input type="number" min={1} max={120} value={c.framesPerStep} onChange={(e) => editor.updateCycle(c.id, { framesPerStep: Math.max(1, +e.target.value) })} title="Frames per step (60 Hz)" />
          <span className="hint">f</span>
          <button className={`tg${c.reverse ? ' on' : ''}`} onClick={() => editor.updateCycle(c.id, { reverse: !c.reverse })} title="Reverse direction">
            ⇄
          </button>
          <button className="x" onClick={() => editor.removeCycle(c.id)} title="Remove">
            ×
          </button>
        </div>
      ))}
      <button
        className="btn wide"
        onClick={() => {
          const local = Math.max(1, slot & 15);
          editor.addCycle({ paletteId: slot >> 4, start: local, end: Math.min(15, local + 3), framesPerStep: 6, reverse: false, enabled: true });
        }}
      >
        + Cycle from slot {slot} (pal {slot >> 4}, idx {slot & 15}…)
      </button>
      <p className="hint">Cycles animate while playing (▶ or Enter).</p>
    </section>
  );
}

export function ObjectsPanel({ editor }: { editor: Editor }) {
  const p = editor.project;
  const o = editor.selectedObject;
  const sprite = o && p.sprites.find((s) => s.id === o.spriteId);
  return (
    <section className="panel">
      <h2>
        Objects <span className="sub">{p.scene.objects.length} placed</span>
      </h2>
      <div className="row">
        <span className="hint">Place</span>
        <select value={editor.objectSpriteId ?? ''} onChange={(e) => editor.set({ objectSpriteId: e.target.value })}>
          {p.sprites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="btn small" onClick={() => editor.setTool('object')} disabled={editor.sceneTool === 'object'}>
          Object tool (M)
        </button>
      </div>
      {o && sprite ? (
        <div className="obj-props">
          <div className="row">
            <b>{sprite.name}</b>
            <span className="hint mono">
              {o.x},{o.y}
            </span>
            <button className="btn small" style={{ marginLeft: 'auto' }} onClick={() => editor.deleteObject(o.id)}>
              Delete
            </button>
          </div>
          <div className="row">
            <span className="hint">Priority</span>
            <span className="seg inline">
              {([0, 1, 2, 3] as const).map((pr) => (
                <button key={pr} className={o.priority === pr ? 'on' : ''} onClick={() => editor.updateObject(o.id, { priority: pr })}
                  title={['Behind BG1/BG2 and high BG3', 'Above BG3, behind BG1/BG2 low', 'Above low BG1/BG2 tiles', 'In front of all BG tiles'][pr]}>
                  {pr}
                </button>
              ))}
            </span>
            <label className="opt">
              <input type="checkbox" checked={o.hFlip} onChange={(e) => editor.updateObject(o.id, { hFlip: e.target.checked })} />
              Flip H
            </label>
            <label className="opt" title={p.strict && sprite.paletteId < 12 ? 'Strict mode: only sprites on OBJ palettes 12–15 can blend' : 'Take part in color math'}>
              <input type="checkbox" checked={o.colorMath} onChange={(e) => editor.updateObject(o.id, { colorMath: e.target.checked })} />
              Color math{p.strict && sprite.paletteId < 12 && o.colorMath ? ' ⚠' : ''}
            </label>
          </div>
        </div>
      ) : (
        <p className="hint">Select an object with the Object tool to edit it.</p>
      )}
    </section>
  );
}
