import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hirom = path.resolve(here, '..');

const types: Record<string, string> = {
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
  '.js': 'text/javascript',
  '.json': 'application/json',
};

type Middleware = (req: { url?: string }, res: { setHeader(k: string, v: string): void; end(d: Buffer): void }, next: () => void) => void;

/** Serve a sibling HiROM folder (../brand, ../sound) the way the live site does. */
function serveDir(dir: string): Middleware {
  return async (req, res, next) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path.join(dir, rel);
    if (!file.startsWith(dir + path.sep)) return next();
    try {
      const data = await readFile(file);
      res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
      res.end(data);
    } catch {
      next();
    }
  };
}

/**
 * HiROM Studio wiring:
 * - links the shared brand kit (../brand) after <title> instead of bundling a private copy;
 * - in dev/preview, serves ../brand and ../sound (HiROM Sound's live audio engine, loaded at runtime).
 */
function hiromSuite(): Plugin {
  const mount = (server: { middlewares: { use(p: string, m: never): void } }) => {
    server.middlewares.use('/brand', serveDir(path.join(hirom, 'brand')) as never);
    server.middlewares.use('/sound', serveDir(path.join(hirom, 'sound')) as never);
  };
  return {
    name: 'hirom-suite',
    transformIndexHtml: {
      order: 'post',
      handler: (html: string) =>
        html.replace(
          '</title>',
          '</title>\n    <link rel="icon" href="../brand/map.svg" type="image/svg+xml" />' +
            '\n    <link rel="stylesheet" href="../brand/brand.css" />',
        ),
    },
    configureServer: mount,
    configurePreviewServer: mount,
  };
}

export default defineConfig({
  plugins: [react(), hiromSuite()],
  resolve: { alias: { '@pixel': path.join(hirom, '_pixel-source', 'src') } },
  server: { fs: { allow: [hirom] } },
  // Built straight into the published app folder; relative paths work under /tools/hirom/map/.
  base: './',
  build: { outDir: '../map', emptyOutDir: true },
  test: { environment: 'node' },
} as never);
