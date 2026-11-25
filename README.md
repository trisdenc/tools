# tools

A simple webpage of the tools I use regularly.

## Editing the list

All tools live in [`tools.js`](tools.js). Add an entry like:

```js
{ name: "Example", url: "https://example.com", category: "Utilities", description: "What it does.", tags: ["optional"] },
```

Categories and filter buttons are generated automatically.

## Viewing locally

Open `index.html` in a browser — no build step needed.

## HiROM Studio

Everything under [`hirom/`](hirom/) is the HiROM Studio suite of SNES tools:

| Path | What it is |
| --- | --- |
| `hirom/index.html` | Suite home page |
| `hirom/brand/` | Shared brand kit: `brand.css`, chip icons, self-hosted pixel fonts (OFL) |
| `hirom/sound/` | HiROM Sound. Plain ES modules, no build step. Tests: `cd hirom/sound && node --test` |
| `hirom/pixel/` | HiROM Pixel, **build output only** (don't edit by hand) |
| `hirom/_pixel-source/` | HiROM Pixel source (Vite + React + TypeScript). Not published: GitHub Pages skips folders starting with `_` |

To work on HiROM Pixel:

```sh
cd hirom/_pixel-source
npm install
npm run dev     # local dev server
npm test        # unit tests
npm run build   # type-checks and rebuilds ../pixel
```

Then commit both `hirom/_pixel-source/` and `hirom/pixel/`.
