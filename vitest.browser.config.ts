import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { BROWSER_WORKERS, PARALLEL_BROWSER_TEST_FILES } from './test/testTiers.js';

/**
 * The Electron tier: every suite that launches the production browser shell
 * or the desktop app, other than the serial and long ones. Run through
 * `npm run test:browser`; see test/testTiers.ts for the reasoning behind the
 * worker cap.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  test: {
    include: [...PARALLEL_BROWSER_TEST_FILES],
    maxWorkers: BROWSER_WORKERS,
    css: { include: [/type\.css/] },
  },
});
