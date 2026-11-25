# HiROM Pixel

Part of the **HiROM Studio** suite. Browser-based pixel art studio built around the S-PPU's constraints: true indexed color,
15-bit BGR555 CGRAM, 16 × 16 sub-palettes, and 2/4/8bpp art.

## Where things live

This folder is the source. It sits inside the `tools` repo at `hirom/_pixel-source/`; the leading
underscore keeps GitHub Pages from publishing it. The live app is the build output in `../pixel/`
(served at `/tools/hirom/pixel/`). Brand assets (fonts, icons, `brand.css`) are shared with the rest
of HiROM Studio in `../brand/` and are linked, not bundled.

```sh
npm install
npm run dev        # http://localhost:5173 (also serves ../brand at /brand)
npm test           # unit tests: color math, raster, tiles, scene compositing, file formats
npm run build      # type-checks, then builds into ../pixel (the published app)
```

To publish a change: `npm run build`, then commit and push the `tools` repo (both this folder
and `../pixel/`).

## Status

### Phase 1: indexed canvas and palette core ✔
- **WebGL2 indexed renderer.** Pixels are stored as local palette indices and resolved through a
  CGRAM texture, so palette edits and swaps never rewrite pixels.
- **CGRAM studio.** R/G/B sliders locked to 0–31, HSV sliders that snap to BGR555, hex entry,
  copy/paste of a sub-palette, and a hue-shifted ramp generator.
- **Tools.** Pixel-perfect pencil, eraser, fill, line, rectangle and ellipse, dither brush,
  index replace, and eyedropper, with brush size, mirroring and tile-wrap.
- **View.** 8:7 NTSC aspect, pixel and tile grids, and a backdrop toggle.
- **Undo.** Sparse per-pixel deltas, up to 1000 steps.

### Phase 2: tilemaps, animation and FX ✔
- **Project.** A scene, tilesets, sprites, and free-form canvases, autosaved to IndexedDB.
- **Tilesets.** 8×8 tiles on 16-wide sheets, editable with every pixel tool.
  **Deduplicate & Optimize** merges identical and H/V/HV-flipped tiles, optionally drops unused
  ones, and rewrites every map that uses them (undoable).
- **Canvas → tiles.** Cuts a canvas into deduplicated tiles on BG1, BG2 or BG3. A canvas drawn with
  an OBJ palette gets its colors copied into the matching BG palette.
- **Mode 1 tilemap editor.** BG1/BG2 (4bpp) and BG3 (2bpp). Cells are stored as real SNES words
  (`vhopppcc cccccccc`). Tools: tile brush with multi-tile stamps (H/V flip, priority), erase, fill,
  rectangle, picker (drag to grab a stamp), and a priority brush with a blue overlay. Each layer
  can switch tileset and use 32/64-tile map sizes.
- **Scene compositor.** A WebGL2 shader that follows the Mode 1 priority order (including "BG3 on
  top") on separate main and sub screens. Color math covers add, subtract, half, and a fixed
  color, computed on 5-bit integer channels. In Strict mode, only OBJ palettes 12–15 can blend.
- **Parallax preview.** Map view or a 256×224 Screen view, with per-layer scroll factors,
  auto-scroll, and arrow-key camera control.
- **Sprites.** A 60 FPS timeline with frame durations in ticks, onion skinning, hit/hurt boxes,
  and an anchor point. Sprites can be placed in the scene as objects with priority 0–3, H flip,
  and color math.
- **Playback (▶ / Enter).** Runs animations, palette cycles (rotating CGRAM ranges), and auto-scroll.
- **64 KB VRAM meter.** Shows CHR, map and OBJ usage with a breakdown. **Strict SNES** enforces the
  hardware limits; **Modern** keeps the look without the ceilings.
- **Export.**
  - Screen or full-map PNG.
  - Tiled zip (`.tmx` + `.tmj` + palette-expanded tileset PNGs, parallax and objects included).
  - Spritesheet zip (RGBA + indexed PNG + JSON with durations and boxes).
  - Indexed PNG, `.pal`, and `.hirompixel` project files (JSON, schema 1.1.0; also opens older
    `.hirom.json` and Phase 1 files).

### Phase 3 (next)
HDMA gradient editor, Mode 7 preview, CRT/NTSC shader, OAM scanline-limit overlay, metasprite
composer, native `.chr`/`.4bpp`/`.map` export, image-to-SNES importer, and GIF/APNG export.

## Layout

```
src/core     editor state, color math, CGRAM, raster, tiles/dedupe, scene (OBJ buffer, color math), history
src/render   WebGL2 pixel renderer and Mode 1 scene compositor
src/io       PNG/zip writers, Tiled and spritesheet export, project JSON, .pal, IndexedDB
src/ui       React components
```

## Shortcuts

**Everywhere:** Ctrl+Z / Ctrl+Shift+Z undo/redo · Ctrl+S save · Enter play/stop · `,` `.` cycle palettes ·
T tile grid · 0 fit · +/- zoom · Space- or middle-drag to pan · wheel to zoom

**Pixel editing:** B pencil · E eraser · G fill · L line · U rect · O ellipse · D dither · R replace · I picker ·
J hit/hurt box (sprites) · X swap colors · [ ] brush size · F filled · W tile wrap · # pixel grid ·
K backdrop · ←/→ previous/next frame (sprites) · Alt-click pick · right-click draws with secondary

**Scene:** B tile brush · E erase · G fill · U rectangle · I picker · P priority brush · M objects ·
H/V flip stamp · Q high-priority painting · 1/2/3 active layer · arrows move camera (Shift = faster) ·
Delete removes the selected object

## Notes

- Tiled has no per-tile priority, so priority bits are kept only in the project JSON, and Tiled layers
  are ordered BG3 → BG1.
- The VRAM meter counts every sprite frame's unique tiles as if all were resident at once.
