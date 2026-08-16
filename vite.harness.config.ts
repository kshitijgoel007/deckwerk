import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Dev-only server for the harness pages in dev/harness, which run the real
 * editor and trim UIs in a plain browser against a stubbed preload bridge.
 * Serving from the project root lets the harness reference example assets.
 */
export default defineConfig({
  root: resolve(__dirname),
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  server: { fs: { allow: [resolve(__dirname)] } },
});
