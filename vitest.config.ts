import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Tests and one-off scripts run against the same `@shared` alias the app build
 * uses, so a module imports identically wherever it is loaded from.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
