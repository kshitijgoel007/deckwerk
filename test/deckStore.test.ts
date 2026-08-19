import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyDeck, createDeck } from '../src/main/deckStore.js';

describe('deck folder persistence', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
});
