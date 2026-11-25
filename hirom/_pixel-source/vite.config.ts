import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared HiROM Studio brand kit (fonts, icons, brand.css) lives next to this folder.
const brandDir = fileURLToPath(new URL('../brand/', import.meta.url));
const types: Record<string, string> = {
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
};

type Middleware = (req: { url?: string }, res: { setHeader(k: string, v: string): void; end(d: Buffer): void }, next: () => void) => void;

const serveBrand: Middleware = async (req, res, next) => {
  const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = path.join(brandDir, rel);
  if (!file.startsWith(brandDir)) return next();
  try {
    const data = await readFile(file);
    res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
    res.end(data);
  } catch {
    next();
  }
};

/**
 * Links the shared brand kit (../brand) instead of bundling a private copy, so brand updates
 * apply without rebuilding. The tags are added after Vite's own HTML processing, right after
 * <title> and before the app's stylesheet, so the app's own tokens win.
 * In `npm run dev` and `npm run preview`, ../brand is served at /brand.
 */
function hiromBrand(): Plugin {
  return {
    name: 'hirom-brand',
    transformIndexHtml: {
      order: 'post',
      handler: (html: string) =>
        html.replace(
          '</title>',
          '</title>\n    <link rel="icon" href="../brand/pixel.svg" type="image/svg+xml" />' +
            '\n    <link rel="stylesheet" href="../brand/brand.css" />',
        ),
    },
    configureServer(server) {
      server.middlewares.use('/brand', serveBrand as never);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/brand', serveBrand as never);
    },
  };
}

export default defineConfig({
  plugins: [react(), hiromBrand()],
  // Built straight into the published app folder; relative paths work under /tools/hirom/pixel/.
  base: './',
  build: { outDir: '../pixel', emptyOutDir: true },
  test: { environment: 'node' },
} as never);
