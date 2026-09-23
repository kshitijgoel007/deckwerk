// Builds the deckwerk.org website into dist-site/.
//
//   node scripts/build-site.mjs
//
// The site is static HTML in site/, so this is a copy. Plain Node, so the
// Pages workflow does not need the Electron toolchain.
import { cpSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = resolve(root, 'site');
const out = resolve(root, 'dist-site');

rmSync(out, { recursive: true, force: true });
cpSync(site, out, { recursive: true });

console.log(`site -> ${out}`);
