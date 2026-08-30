import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import {
  DECK_HISTORY_FILE,
  LEGACY_DECK_HISTORY_FILE,
  loadDeckHistory,
  saveDeckHistory,
} from '../src/main/deckHistoryStore.js';

const document = (label: string) => ({
  version: 2 as const,
  base: emptyDeck(label),
  entries: [{
    label,
    at: Date.now(),
    slideIndex: 0,
    operations: [],
  }],
});
const gunzipAsync = promisify(gunzip);

describe('deck history persistence', () => {
  it('round-trips a validated checkpoint and delta log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deckwerk-history-'));
    const history = document('Saved edit');

    await saveDeckHistory(dir, history);

    expect(await loadDeckHistory(dir)).toEqual(history);
    const compressed = await readFile(join(dir, DECK_HISTORY_FILE));
    expect(JSON.parse((await gunzipAsync(compressed)).toString('utf8'))).toEqual(history);
  });

  it('opens safely when the sidecar is absent, truncated, or schema-invalid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deckwerk-history-bad-'));
    expect(await loadDeckHistory(dir)).toEqual({ version: 2, base: null, entries: [] });

    await writeFile(join(dir, DECK_HISTORY_FILE), '{"version":2,"entries":[', 'utf8');
    expect(await loadDeckHistory(dir)).toEqual({ version: 2, base: null, entries: [] });

    await writeFile(join(dir, DECK_HISTORY_FILE), JSON.stringify({
      version: 2,
      base: {},
      entries: [{ label: '', at: -1, slideIndex: -2, operations: [] }],
    }), 'utf8');
    expect(await loadDeckHistory(dir)).toEqual({ version: 2, base: null, entries: [] });
  });

  it('ignores the legacy full-snapshot sidecar without modifying it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deckwerk-history-legacy-'));
    const legacy = Buffer.from('legacy history remains recoverable');
    await writeFile(join(dir, LEGACY_DECK_HISTORY_FILE), legacy);

    expect(await loadDeckHistory(dir)).toEqual({ version: 2, base: null, entries: [] });
    expect(await readFile(join(dir, LEGACY_DECK_HISTORY_FILE))).toEqual(legacy);
  });

  it('serializes overlapping writes so the newest invocation wins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deckwerk-history-race-'));

    const first = saveDeckHistory(dir, document('First'));
    const second = saveDeckHistory(dir, document('Second'));
    const third = saveDeckHistory(dir, document('Third'));
    await Promise.all([first, second, third]);

    expect((await loadDeckHistory(dir)).entries[0].label).toBe('Third');
  });
});
