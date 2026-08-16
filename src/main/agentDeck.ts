import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  applyAgentTransaction,
  validateDeckIntegrity,
  type AgentTransaction,
} from '@shared/agent.js';
import { type Deck, parseDeck } from '@shared/deck.js';
import { agentRuntimePaths, deckRevision } from './agentRuntime.js';
import { ASSETS_DIR, DECK_FILE, loadDeck } from './deckStore.js';

/**
 * Applying an agent transaction to a deck folder with no editor running.
 *
 * The online path (see `agentRuntime`) hands the transaction to the live
 * renderer so it lands in the undo history. This is the other half: the same
 * transaction format, the same validation, applied straight to `deck.json`
 * under an advisory lock so two concurrent CLI invocations cannot interleave a
 * read-modify-write and lose one of the two edits.
 */

export class RevisionConflict extends Error {
  readonly revision: string;

  constructor(expected: string, actual: string) {
    super(`Deck revision is ${actual}, not the expected ${expected}`);
    this.name = 'RevisionConflict';
    this.revision = actual;
  }
}

/** Assets referenced by a deck must exist; the CLI validates that on write. */
export async function assetChecker(deckDir: string): Promise<(src: string) => boolean> {
  const names = new Set(await readdir(join(deckDir, ASSETS_DIR)).catch(() => []));
  return (src: string) => {
    const abs = resolve(deckDir, src);
    if (abs !== resolve(deckDir) && !abs.startsWith(resolve(deckDir) + '/')) return false;
    const name = src.split('/').pop();
    return Boolean(name && names.has(name)) || existsSync(abs);
  };
}

/** Validate a deck the way the CLI's `validate` command does. */
export async function validateDeckFolder(deckDir: string): Promise<string[]> {
  let deck: Deck;
  try {
    deck = await loadDeck(deckDir);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  return validateDeckIntegrity(deck, await assetChecker(deckDir));
}

/**
 * Apply one transaction to `deck.json` on disk, atomically.
 *
 * Nothing is written unless the revision still matches, the result parses, and
 * every id, timeline reference and asset path checks out.
 */
export async function applyTransactionOffline(
  deckDir: string,
  transaction: AgentTransaction,
): Promise<{ revision: string; deck: Deck }> {
  return withDeckLock(deckDir, async () => {
    const current = await loadDeck(deckDir);
    const revision = deckRevision(current);
    if (revision !== transaction.expectedRevision) {
      throw new RevisionConflict(transaction.expectedRevision, revision);
    }

    const next = applyAgentTransaction(current, transaction);
    const errors = validateDeckIntegrity(next, await assetChecker(deckDir));
    if (errors.length > 0) throw new Error(errors.join('\n'));

    await atomicWrite(join(deckDir, DECK_FILE), `${JSON.stringify(parseDeck(next), null, 2)}\n`);
    return { revision: deckRevision(next), deck: next };
  });
}

/**
 * An advisory lock, held for the duration of one read-modify-write.
 *
 * `writeFile` with `wx` is the atomic test-and-set. The lock records its
 * owner's pid so a lock left behind by a killed process can be reclaimed
 * instead of wedging the deck forever.
 */
export async function withDeckLock<T>(
  deckDir: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  const path = join(agentRuntimePaths(deckDir).root, 'deck.lock');
  await mkdir(join(path, '..'), { recursive: true });

  const started = Date.now();
  for (;;) {
    try {
      await writeFile(
        path,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
        { encoding: 'utf8', flag: 'wx' },
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await reclaimStaleLock(path, staleMs)) continue;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for the deck lock at ${path}`);
      }
      await new Promise((wait) => setTimeout(wait, 25));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}

/** Remove a lock whose owner is gone or which has simply outlived any real edit. */
async function reclaimStaleLock(path: string, staleMs: number): Promise<boolean> {
  try {
    const held = JSON.parse(await readFile(path, 'utf8')) as { pid?: number; at?: string };
    const age = held.at ? Date.now() - Date.parse(held.at) : Number.POSITIVE_INFINITY;
    let alive = false;
    if (typeof held.pid === 'number') {
      try {
        // Signal 0 tests for existence without touching the process. Our own
        // pid counts as alive: two concurrent transactions in one process (the
        // app, or a batch script) must still take turns.
        process.kill(held.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive && age < staleMs) return false;
    await rm(path, { force: true });
    return true;
  } catch {
    // Unreadable or already gone: let the next attempt decide.
    return true;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, contents, 'utf8');
  await rename(temp, path);
}
