'use strict';

/**
 * `npm test`: every tier, in order, with one summary at the end.
 *
 * The tiers are separate Vitest configurations because they need different
 * parallelism (see test/testTiers.ts): unit suites one per core, Electron
 * suites a few at a time, suites that share machine-wide state one at a
 * time. Running them with `&&` stopped at the first failing tier and left the
 * others unknown; this runs all of them and fails if any did.
 */

const { spawnSync } = require('node:child_process');

const TIERS = [
  { name: 'unit', args: ['vitest', 'run'] },
  { name: 'browser', args: ['vitest', 'run', '--config', 'vitest.browser.config.ts'] },
  { name: 'serial', args: ['vitest', 'run', '--config', 'vitest.serial.config.ts'] },
];

const only = process.argv.slice(2);
const results = [];
for (const tier of TIERS) {
  if (only.length > 0 && !only.includes(tier.name)) continue;
  const startedAt = Date.now();
  console.log(`\n=== ${tier.name} tier ===\n`);
  const run = spawnSync('npx', tier.args, { stdio: 'inherit', env: process.env });
  results.push({ ...tier, code: run.status ?? 1, seconds: Math.round((Date.now() - startedAt) / 1000) });
}

console.log('\n=== summary ===');
for (const result of results) {
  console.log(`${result.code === 0 ? 'passed' : 'FAILED'}  ${result.name.padEnd(8)} ${result.seconds}s`);
}
process.exit(results.some((result) => result.code !== 0) ? 1 : 0);
