import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A save that dies halfway must not take the presentation with it.
 *
 * deck.json is the only copy of a deck's content, and a partial write is the
 * one failure this app cannot recover from: the folder still looks like a deck,
 * the file no longer parses, and the work is gone. A full disk is the everyday
 * way that happens — the write returns ENOSPC *after* placing some of the
 * bytes — so that is what these tests reproduce: a writeFile that lands the
 * first half of the document and then fails.
 *
 * Mocked at the fs boundary rather than by filling a real disk, and in its own
 * file because module mocks are file-scoped.
 */

/** Set per-test: which write should half-succeed, and how the rename behaves. */
let failWriteContaining: string | null = null;
let failRename = false;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (path: unknown, data: unknown, ...rest: unknown[]) => {
      const target = String(path);
      if (failWriteContaining && target.includes(failWriteContaining)) {
        const text = String(data);
        // Exactly the ENOSPC shape: bytes reach the file, then the call fails.
        await actual.writeFile(target, text.slice(0, Math.floor(text.length / 2)), 'utf8');
        const error: NodeJS.ErrnoException = new Error('ENOSPC: no space left on device');
        error.code = 'ENOSPC';
        throw error;
      }
      return actual.writeFile(
        path as Parameters<typeof actual.writeFile>[0],
        data as Parameters<typeof actual.writeFile>[1],
        ...(rest as []),
      );
    },
    rename: async (from: unknown, to: unknown) => {
      if (failRename) {
        const error: NodeJS.ErrnoException = new Error('EXDEV: cross-device link');
        error.code = 'EXDEV';
        throw error;
      }
      return actual.rename(from as string, to as string);
    },
  };
});

const { createDeck, loadDeck, saveDeck } = await import('../src/main/deckStore.js');
const { readdir } = await import('node:fs/promises');

describe('deck.json survives a failed save', () => {
  const cleanup: string[] = [];
  let deckDir = '';

  beforeEach(async () => {
    failWriteContaining = null;
    failRename = false;
    const root = await mkdtemp(join(tmpdir(), 'deck-atomic-'));
    cleanup.push(root);
    deckDir = join(root, 'Talk');
    await createDeck(deckDir, 'Original talk');
  });

  afterEach(async () => {
    failWriteContaining = null;
    failRename = false;
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('leaves the previous deck intact and readable when the write is cut short', async () => {
    const before = await readFile(join(deckDir, 'deck.json'), 'utf8');
    const next = await loadDeck(deckDir);
    next.title = 'Renamed while the disk was full';

    failWriteContaining = 'deck.json';
    await expect(saveDeck(deckDir, next)).rejects.toThrow('ENOSPC');

    // Not merely "still exists": still parses, and still holds the old deck.
    expect(await readFile(join(deckDir, 'deck.json'), 'utf8')).toBe(before);
    expect((await loadDeck(deckDir)).title).toBe('Original talk');
  });

  it('leaves the previous deck intact when the atomic replacement itself fails', async () => {
    const before = await readFile(join(deckDir, 'deck.json'), 'utf8');
    const next = await loadDeck(deckDir);
    next.title = 'Renamed across devices';

    failRename = true;
    await expect(saveDeck(deckDir, next)).rejects.toThrow('EXDEV');

    expect(await readFile(join(deckDir, 'deck.json'), 'utf8')).toBe(before);
    expect((await loadDeck(deckDir)).title).toBe('Original talk');
  });

  it('does not litter the deck folder with the debris of failed saves', async () => {
    const next = await loadDeck(deckDir);
    next.title = 'Attempt';

    failRename = true;
    await expect(saveDeck(deckDir, next)).rejects.toThrow();
    failRename = false;
    failWriteContaining = 'deck.json';
    await expect(saveDeck(deckDir, next)).rejects.toThrow();
    failWriteContaining = null;

    // A half-written scratch file left behind would show up in the deck folder
    // and, worse, get copied into every Save As from then on.
    await saveDeck(deckDir, next);
    expect((await readdir(deckDir)).filter((name) => name.includes('.tmp'))).toEqual([]);
    expect((await loadDeck(deckDir)).title).toBe('Attempt');
  });
});
