import { useState } from 'react';
import { Bpp } from '../core/cgram';
import { MAX_DIMENSION } from '../core/image';
import { AssetKind } from './AssetsPanel';

const CANVAS_PRESETS: { label: string; w: number; h: number }[] = [
  { label: '16×16', w: 16, h: 16 },
  { label: '32×32', w: 32, h: 32 },
  { label: '64×64', w: 64, h: 64 },
  { label: '128×128', w: 128, h: 128 },
  { label: '256×224 NTSC', w: 256, h: 224 },
  { label: '256×239 PAL', w: 256, h: 239 },
  { label: '512×224 Hi-Res', w: 512, h: 224 },
  { label: '512×256 BG map', w: 512, h: 256 },
];
const SPRITE_PRESETS = [8, 16, 32, 64].map((n) => ({ label: `${n}×${n}`, w: n, h: n }));

const BPP_INFO: Record<Bpp, string> = {
  2: '4 colors — HUD, text, BG3 parallax layers',
  4: '16 colors — sprites and main BG layers',
  8: '256 colors — title screens, Mode 7',
};

interface Props {
  kind: AssetKind;
  onCreate: (kind: AssetKind, name: string, w: number, h: number, bpp: Bpp) => void;
  onClose: () => void;
}

export function NewDocDialog({ kind, onCreate, onClose }: Props) {
  const [w, setW] = useState(kind === 'tileset' ? 256 : 32);
  const [h, setH] = useState(32);
  const [bpp, setBpp] = useState<Bpp>(4);
  const [name, setName] = useState(kind === 'canvas' ? 'Canvas' : kind === 'tileset' ? 'Tileset' : 'Sprite');
  const valid =
    kind === 'tileset' ? w >= 16 && w <= 1024 : w >= 1 && h >= 1 && w <= (kind === 'sprite' ? 256 : MAX_DIMENSION) && h <= (kind === 'sprite' ? 256 : MAX_DIMENSION);
  const title = kind === 'canvas' ? 'New canvas' : kind === 'tileset' ? 'New tileset' : 'New sprite';
  const presets = kind === 'sprite' ? SPRITE_PRESETS : CANVAS_PRESETS;

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onCreate(kind, name.trim() || title, w, h, kind === 'sprite' ? 4 : bpp);
        }}
      >
        <h2>{title}</h2>
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        {kind === 'tileset' ? (
          <label className="field">
            Tiles (rounded up to rows of 16, max 1024)
            <input type="number" min={16} max={1024} step={16} value={w} onChange={(e) => setW(+e.target.value)} />
          </label>
        ) : (
          <>
            <div className="presets">
              {presets.map((p) => (
                <button
                  type="button"
                  key={p.label}
                  className={`btn${w === p.w && h === p.h ? ' on' : ''}`}
                  onClick={() => {
                    setW(p.w);
                    setH(p.h);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="row">
              <label className="field">
                Width
                <input type="number" min={1} value={w} onChange={(e) => setW(+e.target.value)} />
              </label>
              <label className="field">
                Height
                <input type="number" min={1} value={h} onChange={(e) => setH(+e.target.value)} />
              </label>
            </div>
          </>
        )}
        {kind !== 'sprite' ? (
          <fieldset className="bpp">
            <legend>Bit depth</legend>
            {([2, 4, 8] as Bpp[]).map((b) => (
              <label key={b} className="opt">
                <input type="radio" name="bpp" checked={bpp === b} onChange={() => setBpp(b)} />
                <b>{b}bpp</b> <span className="hint">{BPP_INFO[b]}</span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="hint">Sprites are 4bpp and use OBJ palettes 8–15. Frames share this size.</p>
        )}
        {kind !== 'tileset' && valid && (w % 8 !== 0 || h % 8 !== 0) && (
          <p className="warn">Not a multiple of 8 — this won't split cleanly into 8×8 SNES tiles.</p>
        )}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!valid}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
