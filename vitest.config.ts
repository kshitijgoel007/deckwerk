import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { LONG_TEST_FILES } from './test/longTestFiles.js';
import { SERIAL_TEST_FILES } from './test/serialTestFiles.js';

/**
 * IMPORTANT FOR AGENTS: run the complete suite outside restricted sandboxes.
 * Integration tests bind localhost and launch Electron/Chromium, ffmpeg,
 * importer, semaphore, and filesystem-watcher processes. `npm test` includes
 * a fail-fast environment preflight; focused pure unit files remain safe to
 * run directly with `npx vitest run test/<name>.test.ts` in the sandbox.
 *
 * Tests and one-off scripts run against the same `@shared` alias the app build
 * uses, so a module imports identically wherever it is loaded from.
 */
// Each browser test launches a full Electron app (several processes) plus a
// collab server and sometimes ffmpeg. Running as many in parallel as the box
// has cores oversubscribes a small CI runner badly enough that Electron stops
// responding inside test timeouts — one heavy suite starves the rest, and
// unrelated suites then fail with "could not select" / timeout. Capping
// concurrency on CI gives each browser suite enough CPU to finish; local
// machines with more cores keep running fully parallel.
const ciWorkerCap = process.env.CI
  ? { minWorkers: 1, maxWorkers: 2 }
  : {};

export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') },
  },
  test: {
    ...ciWorkerCap,
    include: ['test/**/*.test.ts'],
    // Keep the ordinary correctness gate responsive. These broad end-to-end
    // scenarios remain available through `npm run test:long` while they are
    // split into narrower tests or otherwise made cheaper.
    exclude: [...configDefaults.exclude, ...LONG_TEST_FILES, ...SERIAL_TEST_FILES],
    // Vitest stubs CSS imports to an empty string, `?raw` included — which
    // would quietly hand the HTML exporter no type rules and let a test pass
    // on a page the app would never produce. Only `type.css` is exempted, so
    // stylesheets the editor imports for effect stay stubbed as before.
    css: { include: [/type\.css/] },
  },
});
