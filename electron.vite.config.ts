import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

const shared = resolve(__dirname, 'src/shared');

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') },
    },
    resolve: { alias: { '@shared': shared } },
  },
  preload: {
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') },
    },
    resolve: { alias: { '@shared': shared } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          editor: resolve(__dirname, 'src/renderer/editor/index.html'),
          present: resolve(__dirname, 'src/renderer/present/index.html'),
          trim: resolve(__dirname, 'src/renderer/trim/index.html'),
        },
      },
    },
    resolve: { alias: { '@shared': shared } },
  },
});
