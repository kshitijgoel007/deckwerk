'use strict';
const { statSync } = require('node:fs');
const { join } = require('node:path');

/**
 * electron-builder beforePack hook: refuse to package a stale Keynote
 * importer binary.
 *
 * The frozen binary in build/importers is produced by `npm run build:importer`
 * and shipped as an extraResource. Nothing else ties it to the Python source
 * it was frozen from, so a binary built before an importer change would ship
 * silently — that is exactly how a packaged app once imported decks with no
 * colours and 12px text. Packaging fails loudly instead when the binary is
 * missing or older than importers/keynote/import_keynote.py.
 */
module.exports = async function assertImporterFresh(context) {
  const root = context.packager.projectDir;
  const binaryName = process.platform === 'win32' ? 'keynote-import.exe' : 'keynote-import';
  const binary = join(root, 'build/importers', binaryName);
  const source = join(root, 'importers/keynote/import_keynote.py');

  let binaryStat;
  try {
    binaryStat = statSync(binary);
  } catch {
    throw new Error(
      `Keynote importer binary is missing (${binary}). Run: npm run build:importer`,
    );
  }
  if (binaryStat.mtimeMs < statSync(source).mtimeMs) {
    throw new Error(
      `Keynote importer binary is older than import_keynote.py — it was frozen ` +
      `from outdated source and would ship broken imports. Run: npm run build:importer`,
    );
  }
};
