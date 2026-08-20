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

/**
 * Serialize writes per deck and publish by rename. This prevents a slower,
 * older renderer update from winning a race or a crash from truncating the
 * only history file.
 */
const writeQueues = new Map<string, Promise<void>>();

export function saveDeckHistory(dir: string, value: DeckHistoryDocument): Promise<void> {
  const history = DeckHistoryDocumentSchema.parse(value);
  const previous = writeQueues.get(dir) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    const target = join(dir, DECK_HISTORY_FILE);
    const temporary = join(dir, `.${DECK_HISTORY_FILE}.${randomUUID()}.tmp`);
    const compressed = await gzipAsync(`${JSON.stringify(history)}\n`);
    await writeFile(temporary, compressed);
    await rename(temporary, target);
  });
  writeQueues.set(dir, pending);
  void pending.finally(() => {
    if (writeQueues.get(dir) === pending) writeQueues.delete(dir);
  }).catch(() => undefined);
  return pending;
}
