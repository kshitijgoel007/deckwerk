import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Builds the standalone player used by exported decks.
 *
 * Kept separate from the app build because the output contract is different:
 * one self-contained IIFE with no module graph and no hashed filenames, so the
 * generated index.html can reference `player.js` and `player.css` by fixed name
 * and run straight off the filesystem.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  build: {
    outDir: 'out/export',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(__dirname, 'src/renderer/export/standalone.ts'),
      name: 'SlideExport',
      formats: ['iife'],
      fileName: () => 'player.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: 'player.[ext]',
      },
    },
  },
});
