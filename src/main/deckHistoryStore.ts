import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import {
  DeckHistoryDocumentSchema,
  emptyDeckHistory,
  type DeckHistoryDocument,
} from '@shared/deckHistory.js';

/** Kept separate from deck.json so snapshots never alter the presentation. */
export const DECK_HISTORY_FILE = 'deck-history.json.gz';
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Load history defensively. A damaged or obsolete sidecar must never prevent
 * its presentation from opening; the editor can simply start a fresh log.
 */
export async function loadDeckHistory(dir: string): Promise<DeckHistoryDocument> {
  try {
    const compressed = await readFile(join(dir, DECK_HISTORY_FILE));
    const raw = await gunzipAsync(compressed);
    const parsed = DeckHistoryDocumentSchema.safeParse(JSON.parse(raw.toString('utf8')));
    return parsed.success ? parsed.data : emptyDeckHistory();
  } catch {
    return emptyDeckHistory();
  }
}

interface QueuedHistoryWrite {
  history: DeckHistoryDocument;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

interface HistoryWriteQueue {
  running: boolean;
  latest: QueuedHistoryWrite | null;
}

/** One active write and at most one latest-wins pending snapshot per deck. */
const writeQueues = new Map<string, HistoryWriteQueue>();

export function saveDeckHistory(dir: string, value: DeckHistoryDocument): Promise<void> {
  const history = DeckHistoryDocumentSchema.parse(value);
  const queue = writeQueues.get(dir) ?? { running: false, latest: null };
  writeQueues.set(dir, queue);
  const promise = new Promise<void>((resolve, reject) => {
    if (queue.latest) {
      // Nobody needs an intermediate full-history file. Attach its waiter to
      // the newest document so all callers still observe completion/failure.
      queue.latest.history = history;
      queue.latest.waiters.push({ resolve, reject });
    } else {
      queue.latest = { history, waiters: [{ resolve, reject }] };
    }
  });
  if (!queue.running) void drainHistoryWrites(dir, queue);
  return promise;
}

async function drainHistoryWrites(dir: string, queue: HistoryWriteQueue): Promise<void> {
  queue.running = true;
  while (queue.latest) {
    const pending = queue.latest;
    queue.latest = null;
    try {
      const target = join(dir, DECK_HISTORY_FILE);
      const temporary = join(dir, `.${DECK_HISTORY_FILE}.${randomUUID()}.tmp`);
      const compressed = await gzipAsync(`${JSON.stringify(pending.history)}\n`);
      await writeFile(temporary, compressed);
      await rename(temporary, target);
      pending.waiters.forEach(({ resolve }) => resolve());
    } catch (error) {
      pending.waiters.forEach(({ reject }) => reject(error));
    }
  }
  queue.running = false;
  if (writeQueues.get(dir) === queue) writeQueues.delete(dir);
}
