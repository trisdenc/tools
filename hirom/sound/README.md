# HiROM Sound

Part of the **HiROM Studio** suite. A browser DAW for writing SNES-style music and sound effects that sound like the
real S-DSP, not a generic chiptune sampler. Live at `/tools/hirom/sound/` (the old
`/tools/snes/` address forwards here). Brand assets live in `../brand/`.

## What's accurate

The audio core (`js/dsp.js`) is an integer-exact model of the S-DSP, following
blargg's SPC_DSP (the reference used by bsnes/higan):

- BRR decoding with the four hardware IIR filters, END/LOOP handling and the
  immediate silence on a non-looping END block
- 4-point Gaussian interpolation with the 512-entry hardware table (bit-exact, tested)
- ADSR and all five GAIN modes, driven by the shared envelope rate counter
- 14-bit pitch, pitch modulation (PMON), 15-bit noise LFSR with 32 clock rates
- Echo: EDL (16 ms steps), EFB, EVOL, 8-tap FIR with the hardware's 16-bit wrap/clamp order
- 16-bit clamping at every mixing stage; fixed 32 kHz, resampled to the device rate
- Key on/off latched every other sample, 5-sample KON delay

## Layout

| File | Purpose |
| --- | --- |
| `js/dsp.js` | S-DSP core (8 voices, echo, FIR, noise, envelopes) |
| `js/brr.js` | BRR encoder (exhaustive filter/shift search against the real decoder), windowed-sinc resampler, loop alignment, pitch detection |
| `js/engine.js` | Sequencer and voice ownership (music, SFX on voices 8/7, live audition). Runs in the AudioWorklet and offline |
| `js/processor.js` | AudioWorklet glue + Hermite resampler (32 kHz → device rate) |
| `js/audio.js` | Main-thread audio controller, offline export, WAV writer with `smpl` loop points |
| `js/project.js` | Project schema, generated starter library, demo song, ARAM budget, import/export |
| `js/store.js` | State, undo/redo, pattern editing ops, IndexedDB autosave |
| `js/ui/*` | Song (piano roll + tracker), Instruments, Samples (BRR Studio), Mixer & Echo, SFX |

No build step: plain ES modules. The worklet script is assembled at runtime from
`dsp.js` + `engine.js` + `processor.js`, so the exact same engine code runs live
and in offline export.

## Tests

```
cd hirom/sound
node --test
```

Covers Gaussian table bit-exactness, BRR round trips and block flags, unaligned
loop fitting with exact pitch, pitch accuracy through the full voice pipeline,
ADSR/GAIN timing against the hardware rate table, release time, noise LFSR period,
echo delay, PMON, sample-accurate sequencer timing, SFX voice takeover and ARAM
accounting.

## Differences from the original spec

- **JavaScript instead of Rust/C++ WASM.** The DSP is typed-array integer math with
  no allocation in the audio loop, so it's deterministic and GC-free; it renders
  about 70× faster than real time (≈1.5% of a core for live playback). Porting
  `dsp.js` to Rust later is straightforward since it has no dependencies.
- **Project files use `.hiromsound`** instead of the spec's `.snesproj` (same zip
  layout: `project.json`, `samples/*.brr`, `sources/*.wav`). Old `.snesproj` files still open.
- **Vanilla JS + canvas instead of React**, to keep the site build-free.
- **MessagePort instead of SharedArrayBuffer** for meters/playhead: GitHub Pages
  can't send the COOP/COEP headers that SharedArrayBuffer needs (the spec's fallback).
- **Not yet built:** `.spc` export (needs an SPC700 sound driver; Phase 2 in the
  spec) and Ogg Vorbis export (browsers have no Vorbis encoder). WAV, stems and
  SFX packs export today.
- Output latency is whatever the OS audio device adds on top of one 128-frame
  render quantum; on Windows that's typically 20–50 ms.
