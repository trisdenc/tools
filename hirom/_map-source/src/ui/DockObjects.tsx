import type { MapEditor } from '../core/editor';
import type { ZoneType } from '../core/level';
import { ZONE_COLORS, ZONE_TYPES, pixelRef, refId, resolveEntity, soundRef } from '../core/level';
import { NumInput, PropsEditor, TextInput, Thumb } from './common';

function SpriteSelect({ ed, value, onChange, allowInherit }: { ed: MapEditor; value: string | null; onChange: (v: string | null) => void; allowInherit?: string }) {
  const sprites = ed.source?.sprites ?? [];
  return (
    <select value={value === null ? '' : refId(value) ?? ''} onChange={(e) => onChange(e.target.value ? pixelRef(e.target.value) : null)}>
      <option value="">{allowInherit ?? '— box (no sprite) —'}</option>
      {sprites.map((s) => (
        <option key={s.id} value={s.id}>{s.name} ({s.width}×{s.height})</option>
      ))}
    </select>
  );
}

function spriteThumb(ed: MapEditor, ref: string | null): HTMLCanvasElement | null {
  const spr = ed.sprite(ref);
  const src = ed.source;
  if (!spr || !src || !spr.frames.length) return null;
  const img = spr.frames[0].image;
  const c = document.createElement('canvas');
  c.width = spr.width;
  c.height = spr.height;
  const ctx = c.getContext('2d')!;
  const data = ctx.createImageData(spr.width, spr.height);
  for (let i = 0; i < img.pixels.length; i++) {
    const v = img.pixels[i];
    if (!v) continue;
    const col = src.cgram[spr.paletteId * 16 + v];
    data.data.set([((col & 31) << 3) | ((col & 31) >> 2), (((col >> 5) & 31) << 3) | (((col >> 5) & 31) >> 2), (((col >> 10) & 31) << 3) | (((col >> 10) & 31) >> 2), 255], i * 4);
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

export function EntitiesPane({ ed }: { ed: MapEditor }) {
  const tpl = ed.template;
  const e = ed.selectedEntity;
  return (
    <>
      <div className="panel">
        <h2>
          Templates <span className="grow" />
          <button className="btn small" onClick={() => ed.addTemplate()}>+ New</button>
        </h2>
        <div className="tpl-list">
          {ed.ws.templates.map((t) => {
            const n = ed.level.entities.filter((x) => x.templateId === t.id).length;
            return (
              <button key={t.id} className={`tpl${t.id === ed.templateId ? ' on' : ''}`} onClick={() => ((ed.templateId = t.id), ed.setTool('entity'))} title={`${t.type} · ${n} in this level`}>
                {t.spriteRef ? <Thumb src={spriteThumb(ed, t.spriteRef)} size={24} /> : <span className="tpl-box" style={{ background: t.color }} />}
                <span>{t.name}</span>
                {n > 0 && <span className="asset-meta">{n}</span>}
              </button>
            );
          })}
        </div>
        {tpl && (
          <details className="panel-section">
            <summary>Edit "{tpl.name}" (changes every linked entity)</summary>
            <div className="row tight">
              <label className="field">
                Name <TextInput value={tpl.name} onChange={(v) => ed.updateTemplate(tpl.id, (t) => (t.name = v || t.name))} />
              </label>
              <label className="field">
                Type <TextInput value={tpl.type} onChange={(v) => ed.updateTemplate(tpl.id, (t) => (t.type = v || t.type))} />
              </label>
            </div>
            <label className="field">
              Sprite (HiROM Pixel)
              <SpriteSelect ed={ed} value={tpl.spriteRef} onChange={(v) => ed.updateTemplate(tpl.id, (t) => (t.spriteRef = v))} />
            </label>
            <div className="row tight">
              <span className="hint">Box</span>
              <NumInput value={tpl.width} min={1} max={512} width={50} onChange={(v) => ed.updateTemplate(tpl.id, (t) => (t.width = v | 0))} />×
              <NumInput value={tpl.height} min={1} max={512} width={50} onChange={(v) => ed.updateTemplate(tpl.id, (t) => (t.height = v | 0))} />
              <input type="color" value={tpl.color} onChange={(ev) => ed.updateTemplate(tpl.id, (t) => (t.color = ev.target.value))} title="Editor color" />
            </div>
            <div className="hint">Default properties</div>
            <PropsEditor value={tpl.properties} onChange={(v) => ed.updateTemplate(tpl.id, (t) => (t.properties = v))} />
            <button className="btn small" onClick={() => confirm(`Delete template "${tpl.name}"?`) && ed.deleteTemplate(tpl.id)}>Delete template</button>
          </details>
        )}
      </div>
      <div className="panel">
        <h2>
          Entities <span className="sub">{ed.level.entities.length} in this level</span>
        </h2>
        {!e && <p className="hint">Pick a template, then click in the level with the Entities tool (O) to place it. Click an entity to edit it.</p>}
        {e && <EntityInspector ed={ed} />}
        <div className="ent-list">
          {ed.level.entities.map((x) => {
            const r = resolveEntity(x, ed.ws.templates);
            return (
              <button key={x.id} className={`ent${e?.id === x.id ? ' on' : ''}`} onClick={() => (ed.select({ kind: 'entity', id: x.id }), ed.centerOn(x.x, x.y))}>
                <span className="tpl-box" style={{ background: r.color }} /> {r.name} <span className="asset-meta">{x.x},{x.y}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

function EntityInspector({ ed }: { ed: MapEditor }) {
  const e = ed.selectedEntity!;
  const t = e.templateId ? ed.ws.templates.find((x) => x.id === e.templateId) : undefined;
  const r = resolveEntity(e, ed.ws.templates);
  const set = (fn: (x: typeof e) => void) => ed.updateEntity(e.id, fn);
  return (
    <div className="inspector">
      <div className="row tight">
        <label className="field">
          Template
          <select value={e.templateId ?? ''} onChange={(ev) => set((x) => (x.templateId = ev.target.value || null))}>
            <option value="">— none —</option>
            {ed.ws.templates.map((tp) => (
              <option key={tp.id} value={tp.id}>{tp.name}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Type
          <TextInput value={e.type ?? ''} placeholder={t?.type ?? 'entity'} onChange={(v) => set((x) => (x.type = v || null))} />
        </label>
      </div>
      <label className="field">
        Sprite
        <SpriteSelect ed={ed} value={e.spriteRef} allowInherit={t ? `— template (${ed.sprite(t.spriteRef)?.name ?? 'box'}) —` : undefined} onChange={(v) => set((x) => (x.spriteRef = v))} />
      </label>
      <div className="row tight">
        <span className="hint">Anchor</span>
        x <NumInput value={e.x} width={60} onChange={(v) => set((x) => (x.x = v | 0))} />
        y <NumInput value={e.y} width={60} onChange={(v) => set((x) => (x.y = v | 0))} />
      </div>
      <div className="row tight">
        <label><input type="checkbox" checked={e.hFlip} onChange={(ev) => set((x) => (x.hFlip = ev.target.checked))} /> Face left</label>
        <label className="opt" title="OBJ priority vs. background layers">
          Priority
          <select value={e.priority} onChange={(ev) => set((x) => (x.priority = Number(ev.target.value) as 0 | 1 | 2 | 3))}>
            {[0, 1, 2, 3].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="hint">Properties {t && '(grey = from the template; edit to override)'}</div>
      <PropsEditor value={e.properties} inherited={t?.properties} onChange={(v) => set((x) => (x.properties = v))} />
      <div className="row tight">
        <span className="hint">Patrol path: {e.path.length} waypoint{e.path.length === 1 ? '' : 's'}</span>
        <button className="btn small" onClick={() => ed.setTool('path')}>Edit path (W)</button>
        {e.path.length > 0 && <button className="btn small" onClick={() => set((x) => (x.path = []))}>Clear</button>}
      </div>
      <div className="row tight">
        <span className="hint">{r.type}</span>
        <span className="grow" />
        <button className="btn small" onClick={() => ed.deleteSelected()}>Delete (Del)</button>
      </div>
    </div>
  );
}

export function ZonesPane({ ed }: { ed: MapEditor }) {
  const z = ed.selectedZone;
  return (
    <div className="panel">
      <h2>
        Zones <span className="sub">{ed.level.zones.length}</span>
        <span className="grow" />
        <button className="btn small" onClick={() => ed.setTool('zone')}>Draw (Z)</button>
      </h2>
      <p className="hint">Camera locks keep the playtest camera inside a room (great for boss fights). Music zones switch the HiROM Sound track. Triggers fire named events.</p>
      {z && (
        <div className="inspector">
          <div className="row tight">
            <label className="field">
              Name <TextInput value={z.name} onChange={(v) => ed.updateZone(z.id, (x) => (x.name = v || x.name))} />
            </label>
            <label className="field">
              Type
              <select value={z.type} onChange={(e) => ed.updateZone(z.id, (x) => (x.type = e.target.value as ZoneType))}>
                {ZONE_TYPES.map((t) => (
                  <option key={t} value={t}>{t.replace('_', ' ').toLowerCase()}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="row tight">
            x <NumInput value={z.x} width={56} onChange={(v) => ed.updateZone(z.id, (x) => (x.x = v | 0))} />
            y <NumInput value={z.y} width={56} onChange={(v) => ed.updateZone(z.id, (x) => (x.y = v | 0))} />
            w <NumInput value={z.width} min={8} width={56} onChange={(v) => ed.updateZone(z.id, (x) => (x.width = v | 0))} />
            h <NumInput value={z.height} min={8} width={56} onChange={(v) => ed.updateZone(z.id, (x) => (x.height = v | 0))} />
          </div>
          <label className="field">
            On enter, play
            <select value={z.onEnterBgm ?? ''} onChange={(e) => ed.updateZone(z.id, (x) => (x.onEnterBgm = e.target.value || null))}>
              <option value="">— no change —</option>
              {ed.ws.soundSources.map((s) => (
                <option key={s.id} value={soundRef(s.id)}>{s.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Event
            <TextInput value={z.event} placeholder="e.g. boss_intro" onChange={(v) => ed.updateZone(z.id, (x) => (x.event = v))} />
          </label>
          <PropsEditor value={z.properties} onChange={(v) => ed.updateZone(z.id, (x) => (x.properties = v))} />
          <button className="btn small" onClick={() => ed.deleteSelected()}>Delete zone</button>
        </div>
      )}
      <div className="ent-list">
        {ed.level.zones.map((x) => (
          <button key={x.id} className={`ent${z?.id === x.id ? ' on' : ''}`} onClick={() => (ed.select({ kind: 'zone', id: x.id }), ed.centerOn(x.x + x.width / 2, x.y + x.height / 2))}>
            <span className="tpl-box" style={{ background: ZONE_COLORS[x.type] }} /> {x.name} <span className="asset-meta">{x.type.replace('_', ' ').toLowerCase()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
