import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { createDeck } from '../src/main/deckStore.js';
import { exportDeck, webExportUnavailableReason } from '../src/main/exportDeck.js';

/**
 * The web export copies every asset a deck references into the output folder.
 * `resolveAsset` is the deck boundary everywhere else in the app; the export
 * has to honour the same boundary, or a symlink planted in `assets/` walks a
 * private file into a folder that is about to be zipped and handed out.
 */
describe.skipIf(webExportUnavailableReason() !== null)('web export asset copying', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function deckWithImage(src: string): Promise<{ root: string; dir: string; out: string }> {
    const root = await mkdtemp(join(tmpdir(), 'export-assets-'));
    cleanup.push(root);
    const dir = join(root, 'Deck');
    await createDeck(dir, 'Deck');
    const deck = emptyDeck();
    deck.slides[0].elements.push({
      id: 'img-1', type: 'image', x: 0, y: 0, w: 400, h: 300, rot: 0, z: 0, opacity: 1,
      class: [], style: {}, src, fit: 'contain', alt: '',
    } as never);
    await writeFile(join(dir, 'deck.json'), JSON.stringify(deck), 'utf8');
    const out = join(root, 'out');
    return { root, dir, out };
  }

  it('copies an ordinary asset, subfolders included', async () => {
    const { dir, out } = await deckWithImage('assets/figures/plot.png');
    await mkdir(join(dir, 'assets', 'figures'), { recursive: true });
    await writeFile(join(dir, 'assets', 'figures', 'plot.png'), Buffer.from([1, 2, 3]));
    const deck = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));

    await exportDeck(dir, deck, out);
    expect(existsSync(join(out, 'assets', 'figures', 'plot.png'))).toBe(true);
  });

  it('refuses a symlink in assets/ that points outside the deck', async () => {
    const { root, dir, out } = await deckWithImage('assets/escape.png');
    await writeFile(join(root, 'secret.png'), Buffer.from([9, 9, 9]));
    await symlink(join(root, 'secret.png'), join(dir, 'assets', 'escape.png'));
    const deck = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));

    await exportDeck(dir, deck, out);
    expect(existsSync(join(out, 'assets', 'escape.png'))).toBe(false);
    // The rest of the export still lands; one bad reference is the deck's
    // problem to show, not a reason to abandon the folder.
    expect(existsSync(join(out, 'player.js'))).toBe(true);
    expect(await readdir(join(out, 'assets'))).toEqual([]);
  });

  it('refuses a lexical escape as before', async () => {
    const { root, dir, out } = await deckWithImage('../secret.png');
    await writeFile(join(root, 'secret.png'), Buffer.from([9, 9, 9]));
    const deck = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8'));

    await exportDeck(dir, deck, out);
    expect(existsSync(join(root, 'out', 'secret.png'))).toBe(false);
    expect(existsSync(join(out, 'player.js'))).toBe(true);
  });
});
