#!/usr/bin/env node
/**
 * Point the Flathub manifest at a specific release tarball.
 *
 * Rewrites only the `url:` and `sha256:` of the first (archive) source, so a
 * release bump is a two-line diff in the flathub/org.deckwerk.DeckWerk PR and
 * every hand-written finish-arg and build command survives untouched.
 *
 * Usage:
 *   node scripts/render-flatpak-manifest.mjs <version> <linux-x64.tar.gz> [manifest]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [version, tarball, manifestPath = 'flatpak/org.deckwerk.DeckWerk.yml'] = process.argv.slice(2);
if (!version || !tarball) {
  console.error('usage: render-flatpak-manifest.mjs <version> <linux-x64.tar.gz> [manifest]');
  process.exit(2);
}

const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
const url =
  `https://github.com/vsitzmann/deckwerk/releases/download/v${version}/deckwerk-${version}-linux-x64.tar.gz`;

const original = readFileSync(manifestPath, 'utf8');
let seenArchive = false;
const updated = original
  .split('\n')
  .map((line) => {
    if (/^\s*-\s*type:\s*archive\s*$/.test(line)) seenArchive = true;
    if (!seenArchive) return line;
    if (/^\s*url:\s*https:\/\/github\.com\/vsitzmann\/deckwerk\/releases\//.test(line)) {
      return line.replace(/url:.*$/, `url: ${url}`);
    }
    if (/^\s*sha256:\s*[0-9a-f]{64}\s*$/.test(line)) {
      return line.replace(/sha256:.*$/, `sha256: ${sha256}`);
    }
    return line;
  })
  .join('\n');

if (updated === original) {
  console.error(`refusing to write: no url/sha256 line matched in ${manifestPath}`);
  process.exit(1);
}
writeFileSync(manifestPath, updated);
console.error(`${manifestPath}: ${version} ${sha256}`);
