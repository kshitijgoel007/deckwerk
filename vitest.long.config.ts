import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { LONG_TEST_FILES } from './test/longTestFiles.js';

/**
 * Explicit quarantine for broad end-to-end and stress scenarios. Keeping
 * these in their own suite makes their cost visible without deleting their
 * coverage or slowing every ordinary validation run.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  test: {
    include: [...LONG_TEST_FILES],
    css: { include: [/type\.css/] },
  },
});
