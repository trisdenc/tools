import { useState } from 'react';
import { parseProject } from '@pixel/io/project';
import type { MapEditor } from '../core/editor';
import { LIVE_PIXEL_ID, LIVE_SOUND_ID, SCREEN_H, SCREEN_W, soundRef } from '../core/level';
import { OAM_LIMIT, OAM_LINE_LIMIT, VRAM_BYTES } from '../core/validator';
import type { MusicPlayer } from '../io/music';
import { parseSoundFile } from '../io/sources';
import { TextInput, pickFile } from './common';

export function AssetsPane({ ed, music }: { ed: MapEditor; music: MusicPlayer }) {
  const [previewing, setPreviewing] = useState<string | null>(null);
  const info = ed.pixelSourceInfo();
  const importPixel = async () => {
    const f = await pickFile('.hirompixel,.json');
    if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      const p = parseProject(json);
      const id = ed.addPixelFile(p.title || f.name, json);
      ed.toast(`Added "${p.title}" (${p.tilesets.length} tilesets, ${p.sprites.length} sprites).`);
      if (confirm(`Use "${p.title}" for the current level?`)) ed.setLevelSource(id);
    } catch (e) {
      ed.toast(`Couldn't read ${f.name}: ${e instanceof Error ? e.message : e}`, true);
    }
  };
  const importSound = async () => {
    const f = await pickFile('.hiromsound,.snesproj,.zip');
    if (!f) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const t = await parseSoundFile('check', f.name, bytes);
      await ed.addSoundFile(t.name, bytes);
      ed.toast(`Added the track "${t.name}". Pick it as the level music or in a music zone.`);
    } catch (e) {
      ed.toast(`Couldn't read ${f.name}: ${e instanceof Error ? e.message : e}`, true);
    }
  };
  const preview = async (id: string) => {
    if (previewing === id) {
      music.stop();
      setPreviewing(null);
      return;
    }
    await music.warmUp();
    music.stop();
    await music.play(soundRef(id));
    setPreviewing(id);
    ed.toast(music.status);
  };
  return (
    <>
      <div className="panel">
        <h2>Tiles & sprites <span className="sub">HiROM Pixel</span></h2>
        {ed.ws.pixelSources.map((s) => {
          const active = s.id === ed.level.pixelSourceId;
          const st = ed.pixelSourceInfo(s.id);
          return (
            <div key={s.id} className={`asset${active ? ' active' : ''}`}>
              <button className="asset-btn" onClick={() => !active && ed.setLevelSource(s.id)} title={active ? 'Used by this level' : 'Use for this level'}>
                <span className="asset-name">{s.name}</span>
                <span className="asset-meta">
                  {s.kind === 'live' ? 'live link' : s.kind === 'builtin' ? 'built in' : 'imported file'}
                  {active && st.project && ` · ${st.project.tilesets.length} tilesets · ${st.project.sprites.length} sprites`}
                  {active && st.status === 'missing' && ' · nothing saved yet'}
                </span>
              </button>
              {s.kind === 'file' && <button className="x" title="Remove" onClick={() => ed.removeSource('pixel', s.id)}>×</button>}
            </div>
          );
        })}
        <div className="row">
          <button className="btn small" onClick={importPixel}>Import .hirompixel…</button>
          {ed.level.pixelSourceId === LIVE_PIXEL_ID && (
            <button className="btn small" onClick={() => ed.refreshPixel(LIVE_PIXEL_ID)}>Reload</button>
          )}
          <a className="btn small" href="../pixel/" target="_blank" rel="noopener">Open HiROM Pixel ↗</a>
        </div>
        <p className="hint">
          The live link reads HiROM Pixel's current project on this device. Edit a tile or palette there and every level using it updates here within a second. Imported files are snapshots.
        </p>
        {info.status === 'error' && <p className="warn">{info.error}</p>}
      </div>
      <div className="panel">
        <h2>Music <span className="sub">HiROM Sound</span></h2>
        {ed.ws.soundSources.map((s) => (
          <div key={s.id} className="asset">
            <button className="asset-btn" onClick={() => preview(s.id)} title="Preview">
              <span className="asset-name">
                {previewing === s.id ? '■ ' : '▶ '}
                {s.name}
              </span>
              <span className="asset-meta">{s.kind === 'live' ? 'live link' : 'imported file'}</span>
            </button>
            {s.id !== LIVE_SOUND_ID && <button className="x" title="Remove" onClick={() => ed.removeSource('sound', s.id)}>×</button>}
          </div>
        ))}
        <div className="row">
          <button className="btn small" onClick={importSound}>Import .hiromsound…</button>
          <a className="btn small" href="../sound/" target="_blank" rel="noopener">Open HiROM Sound ↗</a>
        </div>
        <p className="hint">Music plays through HiROM Sound's own S-DSP engine. Set the level's track in the Level panel and switch tracks with music zones.</p>
      </div>
      <div className="panel">
        <h2>Materials</h2>
        {ed.ws.materials.map((m) => (
          <div key={m.id} className="row tight">
            <input type="color" value={m.color} onChange={(e) => ed.changeWs('Material color', 'materials', () => (ed.ws.materials.find((x) => x.id === m.id)!.color = e.target.value))} />
            <TextInput value={m.name} onChange={(v) => ed.changeWs('Rename material', 'materials', () => (ed.ws.materials.find((x) => x.id === m.id)!.name = v.replace(/\s+/g, '_') || m.name))} />
            <span className="asset-meta">#{m.id}</span>
          </div>
        ))}
        <button
          className="btn small"
          disabled={ed.ws.materials.length >= 15}
          onClick={() => ed.changeWs('Add material', 'materials', () => {
            const id = [...Array(15).keys()].map((i) => i + 1).find((i) => !ed.ws.materials.some((m) => m.id === i))!;
            ed.ws.materials.push({ id, name: `material_${id}`, color: '#ffffff' });
          })}
        >
          + Material
        </button>
        <p className="hint">Materials ride along in the collision data (ice, mud, conveyors…). The playtest understands ice, mud and conveyor_left / conveyor_right.</p>
      </div>
    </>
  );
}

export function ValidatePane({ ed }: { ed: MapEditor }) {
  const r = ed.validation;
  const strict = ed.level.meta.strictHardwareLimits;
  const pct = (v: number, max: number) => `${Math.round((v / max) * 100)}%`;
  return (
    <div className="panel">
      <h2>Screen budget</h2>
      <p className="hint">
        Slides a {SCREEN_W}×{SCREEN_H} screen across the level and checks what the SNES would need loaded at once: 64 KB of VRAM (background tiles, tilemaps and sprite tiles) and the sprite limits ({OAM_LIMIT} on screen, {OAM_LINE_LIMIT} per scanline).
      </p>
      <button className="btn primary wide" onClick={() => ed.validate()}>Check this level</button>
      {r && (
        <>
          <div className="budget">
            <div>
              Worst VRAM <b>{(r.worst.vram / 1024).toFixed(1)} KB</b> <span className="hint">{pct(r.worst.vram, VRAM_BYTES)} of 64 KB</span>
            </div>
            <div>
              Most sprites on screen <b>{r.worst.oam}</b> <span className="hint">of {OAM_LIMIT}</span>
            </div>
            <div>
              Most on one line <b>{r.worst.line}</b> <span className="hint">of {OAM_LINE_LIMIT}</span>
            </div>
            <div className="hint">{r.windows} screen positions checked.</div>
          </div>
          {!strict && <p className="hint">Modern mode: limits are reported but not enforced. Switch to Strict SNES to list problem screens.</p>}
          {strict && r.issues.length === 0 && <p className="ok">Every screen fits the hardware budget.</p>}
          {r.issues.length > 0 && (
            <>
              <p className="warn">{r.issues.length} screen position{r.issues.length === 1 ? '' : 's'} over budget (red on the canvas):</p>
              <div className="ent-list">
                {r.issues.slice(0, 200).map((i, n) => (
                  <button key={n} className="ent" onClick={() => ed.centerOn(i.x + SCREEN_W / 2, i.y + SCREEN_H / 2)}>
                    <span className="mono">{i.x},{i.y}</span> {i.problems.join(' · ')}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
