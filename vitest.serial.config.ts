import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { SERIAL_TEST_FILES } from './test/serialTestFiles.js';

/** Native-window integrations run alone so parallel Chromium workers cannot
 * turn synchronization assertions into machine-load-dependent timeouts. */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  test: {
    include: [...SERIAL_TEST_FILES],
    fileParallelism: false,
    maxWorkers: 1,
    css: { include: [/type\.css/] },
  },
});
