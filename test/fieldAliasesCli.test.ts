import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_OK, runAgentCli } from '../src/cli/agentCli.js';
import { type Deck, emptyDeck, parseDeck } from '../src/shared/deck.js';

/**
 * The CLI parses a transaction file through a schema that strips unknown
 * keys, so a file written against retired field names has to be canonicalised
 * before that parse -- `applyAgentTransaction` renaming on its own would only
 * ever see the stripped copy, and the edit would vanish without an error.
 */
describe('slide-agent transaction apply with retired field names', () => {
  let dir: string;
  let stateDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-cli-alias-'));
    stateDir = await mkdtemp(join(tmpdir(), 'agent-cli-alias-state-'));
    process.env.DECKWERK_STATE_DIR = stateDir;
    await mkdir(join(dir, 'assets'), { recursive: true });
    const deck = emptyDeck('Alias deck');
    deck.slides = parseDeck({ version: 1, slides: [
      { id: 'slide-1', name: 'One', elements: [{ id: 'title-1', type: 'text', x: 0, y: 0, w: 300, h: 80, html: 'One' }] },
      { id: 'slide-2', name: 'Two', elements: [{ id: 'title-2', type: 'text', x: 0, y: 0, w: 300, h: 80, html: 'Two' }] },
    ] }).slides;
    await writeFile(join(dir, 'deck.json'), `${JSON.stringify(parseDeck(deck), null, 2)}\n`, 'utf8');
    await writeFile(join(dir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
  });

  afterEach(async () => {
    delete process.env.DECKWERK_STATE_DIR;
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  const onDisk = async (): Promise<Deck> => parseDeck(JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8')));

  it('applies the retired names instead of silently stripping them', async () => {
    const out: string[] = [];
    await writeFile(join(dir, 'txn.json'), JSON.stringify({
      version: 1,
      label: 'Old brief',
      operations: [
        { op: 'updateDeck', magicMoveEasing: 'linear' },
        { op: 'setSlideProperties', slideId: 'slide-2', slide: { id: 'slide-2', magicMoveFromPrevious: true, magicMoveDuration: 640 } },
        {
          op: 'replaceElement', slideId: 'slide-1', elementId: 'title-1', element: {
            id: 'title-1', type: 'text', x: 0, y: 0, w: 300, h: 80, html: 'One', magicMoveId: 'pair',
          },
        },
      ],
    }), 'utf8');
    const code = await runAgentCli(['transaction', 'apply', dir, 'txn.json'], {
      out: (text) => out.push(text), err: (text) => out.push(text), cwd: dir,
    });
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(out.join(''))).toMatchObject({ status: 'applied', applied: true });
    const deck = await onDisk();
    expect(deck.morphEasing).toBe('linear');
    expect(deck.slides[1]).toMatchObject({ morphFromPrevious: true, morphDuration: 640 });
    expect(deck.slides[0].elements[0].morphId).toBe('pair');
    expect(await readFile(join(dir, 'deck.json'), 'utf8')).not.toMatch(/magicMove/);
  });
});
