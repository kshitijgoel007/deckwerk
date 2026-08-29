import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyDeck, createDeck, deckFolderPath, importImageBuffer } from '../src/main/deckStore.js';

describe('deck folder persistence', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('creates the authoring folder without adding agent instructions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-create-'));
    cleanup.push(root);
    const deckDir = join(root, 'Deck');

    await createDeck(deckDir);

    await expect(access(join(deckDir, 'edit'))).resolves.toBeUndefined();
    await expect(access(join(deckDir, 'AGENTS.md'))).rejects.toThrow();
  });

  it('copies the complete deck for Save As without changing the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-save-as-'));
    cleanup.push(root);
    const source = join(root, 'Original');
    const target = join(root, 'Copy');
    const deck = await createDeck(source, 'Original title');
    await writeFile(join(source, 'assets', 'figure.svg'), '<svg/>', 'utf8');
    await writeFile(join(source, 'edit', 'work.html'), '<section></section>', 'utf8');

    const copied = await copyDeck(source, target);

    expect(copied).toEqual(deck);
    expect(await readFile(join(target, 'assets', 'figure.svg'), 'utf8')).toBe('<svg/>');
    expect(await readFile(join(target, 'edit', 'work.html'), 'utf8')).toBe('<section></section>');
    expect(await readFile(join(source, 'assets', 'figure.svg'), 'utf8')).toBe('<svg/>');
  });

  it('refuses to overwrite an existing destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-save-as-existing-'));
    cleanup.push(root);
    const source = join(root, 'Original');
    const target = join(root, 'Existing');
    await createDeck(source);
    await createDeck(target);

    await expect(copyDeck(source, target)).rejects.toThrow('already exists');
  });

  it('imports clipboard image bytes as a content-addressed asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-clipboard-image-'));
    cleanup.push(root);
    const deckDir = join(root, 'Deck');
    await createDeck(deckDir);
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    const first = await importImageBuffer(
      deckDir,
      png,
      'Screenshot.png',
      { width: 1440, height: 900 },
    );
    const second = await importImageBuffer(
      deckDir,
      png,
      'Screenshot.png',
      { width: 1440, height: 900 },
    );

    expect(first).toEqual(second);
    expect(first).toMatchObject({ kind: 'image', width: 1440, height: 900, duration: null });
    expect(first.src).toMatch(/^assets\/Screenshot\.[a-f0-9]{8}\.png$/);
    expect(new Uint8Array(await readFile(join(deckDir, first.src)))).toEqual(png);
  });
});

/**
 * A deck folder called `talk.key` is not a cosmetic wart: Launch Services reads
 * the extension, reports the folder as com.apple.iwork.keynote.sffkey, and
 * Finder then opens it in Keynote, which cannot read a deck.json. The save
 * panel hands back whatever sits in its name field, so the extension has to be
 * dropped on our side.
 */
describe('deck folder naming', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('drops a presentation extension the save panel handed back', () => {
    expect(deckFolderPath('/talks/rhoda_intro.key')).toBe('/talks/rhoda_intro');
    expect(deckFolderPath('/talks/rhoda_intro.KEY')).toBe('/talks/rhoda_intro');
    expect(deckFolderPath('/talks/deck.keynote')).toBe('/talks/deck');
    expect(deckFolderPath('/talks/deck.pptx')).toBe('/talks/deck');
    expect(deckFolderPath('/talks/deck.pdf')).toBe('/talks/deck');
  });

  it('leaves a deliberate name alone, dots and all', () => {
    expect(deckFolderPath('/talks/Untitled deck')).toBe('/talks/Untitled deck');
    // A version number is not an extension, so a fixed list beats a regex.
    expect(deckFolderPath('/talks/Q3 2026 v1.2')).toBe('/talks/Q3 2026 v1.2');
    expect(deckFolderPath('/talks/rhoda.intro')).toBe('/talks/rhoda.intro');
  });

  it('names the deck folder and its title from the same stripped path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deck-ext-'));
    cleanup.push(root);
    const dir = deckFolderPath(join(root, 'rhoda_intro.key'));
    const deck = await createDeck(dir, basename(dir));

    expect(basename(dir)).toBe('rhoda_intro');
    expect(deck.title).toBe('rhoda_intro');
    expect(JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8')).title).toBe('rhoda_intro');
  });
});
