# HiROM Map

Part of the **HiROM Studio** suite. The level, world and scene editor: it builds multi-layer SNES
stages out of HiROM Pixel tiles, palettes and sprites, and playtests them with HiROM Sound music.

## Where things live

This folder is the source (Vite + React + TypeScript). The leading underscore keeps GitHub Pages
from publishing it; the live app is the build output in `../map/` (served at `/tools/hirom/map/`).

```sh
npm install
npm run dev        # http://localhost:5173 (also serves ../brand and ../sound)
npm test           # unit tests: autotiling, compression, physics, validator, file formats
npm run build      # type-checks, then builds into ../map (the published app)
```

To publish a change: `npm run build`, then commit and push the `tools` repo.

## Shared with the rest of the suite

- **HiROM Pixel's code** is imported directly (`@pixel/*` → `../_pixel-source/src`): the WebGL2
  Mode 1 scene renderer (tilemap words, flips, priority order, bit-exact color math), the project
  model and file parser, CGRAM/tile helpers, the undo history, PNG/zip writers and the Tiled exporter.
  Map renders its own views with that renderer: the editor in ≤1024 px chunks (so huge levels never
  need a giant sprite buffer), the playtest screen in scanline strips for HDMA bands.
- **Live links.** All apps share a site, so Map reads HiROM Pixel's and HiROM Sound's autosaves
  straight from IndexedDB, and both apps broadcast on `BroadcastChannel('hirom-studio')` when they
  save. Editing a tile in Pixel updates every level using it within about a second.
- **Music** plays through HiROM Sound's own S-DSP engine, loaded at runtime from `../sound/js/`.
- **Brand kit**: `../brand/` is linked (not bundled) by a small Vite plugin.

## What's in it

- Levels up to 512×512 metatiles (16×16 or 32×32), three Mode 1 layers (BG1/BG2 4bpp, BG3 2bpp)
  with per-layer tilesets, x/y parallax, main/sub screen, color math and HDMA scanline bands.
- Tilemap cells are real SNES words (`vhopppcc cccccccc`).
- Metatile sets per tileset: generated from the sheet's 16×16 blocks, collected from a layer, or
  imported from a HiROM Pixel tilemap; editable sub-tiles (tile, palette, flips, priority) and
  default collision.
- Tools: metatile / tile / stamp brush, terrain autotiler (47-tile blob and 16-tile Wang with
  fallbacks), fill, rectangle, select → stamp, eyedropper, eraser, collision brush, entities,
  zones, patrol paths. H/V flip and priority toggles; flipping a slope mirrors its collision.
- Collision byte per metatile cell: shape (solid, one-way, ladder, water, hazard, 45° slopes) plus a
  material (ice, mud, conveyors, or your own).
- Entity templates with typed default properties; instances override per property.
- Zones: camera lock, music (switches the HiROM Sound track), trigger, hazard.
- Playtest: platformer, top-down or free camera, with parallax, HDMA, palette cycling, sprite
  animation and music.
- Screen-budget validator: 64 KB VRAM, 128 sprites per screen, 32 per scanline (Strict SNES mode).
- Export: Tiled `.tmj` (+ palette-expanded tileset PNGs, collision legend, entity and zone object
  layers), level JSON (spec schema), SNES binaries (32×32-screen nametables, metatile table,
  collision, each also RLE and LZSS compressed), world PNG with or without overlays.
- Workspaces save as `.hirommap`; everything autosaves to IndexedDB.

## Not yet built (spec Phase 3)

Mode 0, Mode 3 and the Mode 7 editor with affine/horizon preview need renderer work in HiROM
Pixel's shared shader; the world graph view; native tile graphics export lives in HiROM Pixel.
