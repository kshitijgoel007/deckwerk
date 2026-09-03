import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, agentRuntimePaths } from '../src/main/agentRuntime.js';
import { DECK_HISTORY_FILE, loadDeckHistory } from '../src/main/deckHistoryStore.js';
import { CLIPBOARD_FORMAT, parseClipboardPayload } from '../src/shared/clipboard.js';
import { DECK_VERSION } from '../src/shared/deck.js';

/**
 * Three more places that read JSON written outside the process through a
 * schema that strips unknown keys. Each has to canonicalise retired field
 * names *before* that parse, or a rename silently erases the field instead of
 * carrying it forward.
 */
const gzipAsync = promisify(gzip);

const legacyDeck = () => ({
  version: DECK_VERSION,
  title: 'Legacy',
  canvas: { w: 1920, h: 1080 },
  theme: 'theme.css',
  magicMoveEasing: 'ease-out',
  slides: [{
    id: 's1', name: 'One', magicMoveFromPrevious: true, magicMoveDuration: 700,
    elements: [{ id: 'e1', type: 'text', x: 0, y: 0, w: 300, h: 80, html: 'x', magicMoveId: 'pair' }],
  }],
});

describe('retired field names in persisted stores', () => {
  let dir: string;
  let stateDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'alias-stores-'));
    stateDir = await mkdtemp(join(tmpdir(), 'alias-stores-state-'));
    process.env.SLIDE_EDITOR_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    delete process.env.SLIDE_EDITOR_STATE_DIR;
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it('loads a history sidecar whose base deck and operations use retired names', async () => {
    const history = {
      version: 2,
      base: legacyDeck(),
      // entries[0] is the base checkpoint and carries no operations.
      entries: [{ label: 'Checkpoint', at: 1, slideIndex: 0, operations: [] }, {
        label: 'Old edit', at: 2, slideIndex: 0,
        operations: [
          { op: 'updateDeck', magicMoveEasing: 'linear' },
          { op: 'setSlideProperties', slideId: 's1', slide: { id: 's1', magicMoveDuration: 300 } },
        ],
      }],
    };
    await writeFile(join(dir, DECK_HISTORY_FILE), await gzipAsync(JSON.stringify(history)));

    const loaded = await loadDeckHistory(dir);
    expect(loaded.base?.morphEasing).toBe('ease-out');
    expect(loaded.base?.slides[0]).toMatchObject({ morphFromPrevious: true, morphDuration: 700 });
    expect(loaded.base?.slides[0].elements[0].morphId).toBe('pair');
    expect(loaded.entries[1].operations).toEqual([
      { op: 'updateDeck', morphEasing: 'linear' },
      { op: 'setSlideProperties', slideId: 's1', slide: { id: 's1', morphDuration: 300 } },
    ]);
    expect(JSON.stringify(loaded)).not.toMatch(/magicMove/);
  });

  it('accepts a pasteboard payload written by a build that used retired names', () => {
    const elements = parseClipboardPayload({
      format: CLIPBOARD_FORMAT, version: 1, kind: 'elements', timeline: [],
      elements: [{ id: 'e1', type: 'text', x: 0, y: 0, w: 300, h: 80, html: 'x', magicMoveId: 'pair' }],
    });
    expect(elements?.kind).toBe('elements');
    if (elements?.kind === 'elements') expect(elements.elements[0].morphId).toBe('pair');

    const slides = parseClipboardPayload({
      format: CLIPBOARD_FORMAT, version: 1, kind: 'slides', slides: legacyDeck().slides,
    });
    expect(slides?.kind).toBe('slides');
    if (slides?.kind === 'slides') {
      expect(slides.slides[0]).toMatchObject({ morphFromPrevious: true, morphDuration: 700 });
      expect(slides.slides[0].elements[0].morphId).toBe('pair');
    }
  });

  it('forwards an inbox request written against retired names with the fields intact', async () => {
    const sent: unknown[] = [];
    const runtime = new AgentRuntime(() => ({
      isDestroyed: () => false,
      webContents: { send: (_channel: string, payload: unknown) => sent.push(payload) },
    }) as never);
    const paths = agentRuntimePaths(dir);
    await mkdir(paths.inbox, { recursive: true });
    await writeFile(join(paths.inbox, 'req-1.json'), JSON.stringify({
      version: 1, id: 'req-1', kind: 'transaction',
      transaction: {
        version: 1, expectedRevision: 'a'.repeat(64), label: 'Old brief',
        operations: [{ op: 'updateDeck', magicMoveEasing: 'linear' }],
      },
    }), 'utf8');

    try {
      await runtime.open(dir); // drains the inbox once on open
    } finally {
      await runtime.close();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      id: 'req-1', transaction: { operations: [{ op: 'updateDeck', morphEasing: 'linear' }] },
    });
    expect(JSON.stringify(sent[0])).not.toMatch(/magicMove/);
  });
});
