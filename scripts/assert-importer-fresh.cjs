'use strict';
const { statSync } = require('node:fs');
const { join } = require('node:path');

/**
 * electron-builder beforePack hook: refuse to package a stale importer
 * binary.
 *
 * The frozen binaries in build/importers are produced by `npm run
 * build:importer` and shipped as extraResources. Nothing else ties them to the
 * Python source they were frozen from, so a binary built before an importer
 * change would ship silently — that is exactly how a packaged app once
 * imported decks with no colours and 12px text. Packaging fails loudly instead
 * when a binary is missing or older than its importer script.
 */
const IMPORTERS = [
  { binary: 'keynote-import', source: 'importers/keynote/import_keynote.py', label: 'Keynote' },
  { binary: 'pptx-import', source: 'importers/pptx/import_pptx.py', label: 'PowerPoint' },
];

module.exports = async function assertImporterFresh(context) {
  const root = context.packager.projectDir;
  for (const importer of IMPORTERS) {
    const binaryName = process.platform === 'win32' ? `${importer.binary}.exe` : importer.binary;
    const binary = join(root, 'build/importers', binaryName);
    const source = join(root, importer.source);

    let binaryStat;
    try {
      binaryStat = statSync(binary);
    } catch {
      throw new Error(
        `${importer.label} importer binary is missing (${binary}). Run: npm run build:importer`,
      );
    }
    if (binaryStat.mtimeMs < statSync(source).mtimeMs) {
      throw new Error(
        `${importer.label} importer binary is older than ${importer.source} — it was frozen ` +
        `from outdated source and would ship broken imports. Run: npm run build:importer`,
      );
    }
  }
};
