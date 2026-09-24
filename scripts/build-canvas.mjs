#!/usr/bin/env node
// Builds the canvas app (React + Excalidraw) into dist/canvas/.
// Usage: node scripts/build-canvas.mjs [--dev]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const src = path.join(root, 'src', 'canvas');
const out = path.join(root, 'dist', 'canvas');
const dev = process.argv.includes('--dev');

// Excalidraw's fonts (dist/prod/fonts), served locally through window.EXCALIDRAW_ASSET_PATH
// (the package doesn't export package.json; its main entry is dist/prod/index.js)
const fontsDir = path.join(path.dirname(require.resolve('@excalidraw/excalidraw')), 'fonts');

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: { main: path.join(src, 'main.jsx') },
  outdir: out,
  bundle: true,
  format: 'esm',
  splitting: true, // locales, font subsetting etc. go into chunks loaded on demand
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  platform: 'browser',
  target: ['es2020', 'chrome90', 'firefox90', 'safari15'],
  conditions: dev ? ['development'] : ['production'],
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  jsx: 'automatic',
  minify: !dev,
  sourcemap: dev ? 'linked' : false,
  legalComments: 'none',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file' },
  metafile: true,
  logLevel: 'warning',
  plugins: [{
    // Mermaid / "Text to diagram" don't exist in cc-draw: swap the package (which pulls in mermaid) for a stub.
    name: 'cc-draw-stubs',
    setup(build) {
      build.onResolve({ filter: /^@excalidraw\/mermaid-to-excalidraw$/ }, () => ({
        path: path.join(src, 'stubs', 'mermaid-to-excalidraw.js'),
      }));
    },
  }],
});

await fs.cp(fontsDir, path.join(out, 'fonts'), { recursive: true });
await fs.copyFile(path.join(src, 'index.html'), path.join(out, 'index.html'));

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const outputs = Object.entries(result.metafile.outputs);
const main = outputs.filter(([f]) => /main\.(js|css)$/.test(f)).map(([f, o]) => `${path.basename(f)} ${kb(o.bytes)}`);
const total = outputs.reduce((s, [, o]) => s + o.bytes, 0);
console.log(`[cc-draw] canvas built into ${path.relative(root, out)}/ — ${main.join(', ')} (all chunks: ${kb(total)})`);
