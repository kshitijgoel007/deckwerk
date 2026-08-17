import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentContext, AgentTransaction, ComputedSlideScene } from '../src/shared/agent.js';
import { type Deck, type Slide, emptyDeck, parseDeck } from '../src/shared/deck.js';
import {
  EXIT_CONFLICT, EXIT_ERROR, EXIT_OK, EXIT_USAGE, agentGuidePath, runAgentCli,
} from '../src/cli/agentCli.js';
import { agentRuntimePaths, deckRevision } from '../src/main/agentRuntime.js';
import { createDeck, ensureAgentGuide } from '../src/main/deckStore.js';
import { getFfmpegPath } from '../src/main/ffmpeg.js';

/**
 * The CLI is the whole interface for an agent that cannot talk to the app, so
 * these tests drive it the way an agent does: run a command, parse the JSON,
 * feed the revision it printed back into the next command.
 */

const run = promisify(execFile);

const text = (id: string, html: string, over: Record<string, unknown> = {}) => ({
  id, type: 'text' as const, x: 100, y: 100, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
  class: ['role-body'], style: {}, html, align: 'left' as const, valign: 'top' as const, ...over,
});

function slideOf(id: string, elements: unknown[] = []): Slide {
  return parseDeck({ version: 1, slides: [{ id, name: id, elements }] }).slides[0];
}

describe('slide-agent CLI', () => {
  let dir: string;
  let stateDir: string;
  let out: string[];
  let err: string[];

  const io = () => ({
    out: (text: string) => out.push(text),
    err: (text: string) => err.push(text),
    cwd: dir,
  });

  const cli = async (...argv: string[]) => {
    out = [];
    err = [];
    const code = await runAgentCli(argv, io());
    return { code, stdout: out.join(''), stderr: err.join('') };
  };

  const parsed = async (...argv: string[]) => {
    const result = await cli(...argv);
    return { ...result, json: JSON.parse(result.stdout) };
  };

  const writeDeck = async (deck: Deck) =>
    writeFile(join(dir, 'deck.json'), `${JSON.stringify(parseDeck(deck), null, 2)}\n`, 'utf8');

  const onDisk = async (): Promise<Deck> =>
    parseDeck(JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8')));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-cli-'));
    stateDir = await mkdtemp(join(tmpdir(), 'agent-cli-state-'));
    process.env.SLIDE_EDITOR_STATE_DIR = stateDir;
    await mkdir(join(dir, 'assets'), { recursive: true });
    const deck = emptyDeck('CLI deck');
    deck.slides = [
      slideOf('slide-1', [text('title-1', 'First')]),
      slideOf('slide-2', [text('title-2', 'Second')]),
    ];
    await writeDeck(deck);
    await writeFile(join(dir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
  });

  afterEach(async () => {
    delete process.env.SLIDE_EDITOR_STATE_DIR;
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  /** Pretend an editor session left a sidecar behind. */
  async function writeSidecar(over: Partial<AgentContext>): Promise<void> {
    const paths = agentRuntimePaths(dir);
    await mkdir(paths.root, { recursive: true });
    const context: AgentContext = {
      version: 1,
      live: true,
      sessionId: 'session-1',
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      deckPath: dir,
      deckRevision: deckRevision(await onDisk()),
      activeSlideId: 'slide-2',
      activeSlideIndex: 1,
      selectedSlideIds: ['slide-2'],
      selectedElementIds: ['title-2'],
      scenes: [],
      ...over,
    };
    await writeFile(paths.context, JSON.stringify(context, null, 2), 'utf8');
  }

  it('reports the deck revision and offline status with no editor running', async () => {
    const { code, json } = await parsed('context');
    expect(code).toBe(EXIT_OK);
    expect(json.live).toBe(false);
    expect(json.deckRevision).toBe(deckRevision(await onDisk()));
    expect(json.deckRevision).toBe(json.diskRevision);
    expect(json.selectedSlideIds).toEqual(['slide-1']);
    expect(json.scenes).toEqual([]);
  });

  it('treats a sidecar left by a crashed app as dead, keeping its selection as a hint', async () => {
    // `live: true` but the owning process is long gone: the classic leftover.
    await writeSidecar({ pid: 0x7ffffffe, live: true });
    const { json } = await parsed('context');
    expect(json.live).toBe(false);
    expect(json.stale).toBe(true);
    expect(json.selectedSlideIds).toEqual(['slide-2']);
    expect(json.selectedElementIds).toEqual(['title-2']);
  });

  it('ignores a sidecar that names a different deck, or selects objects that are gone', async () => {
    await writeSidecar({ pid: 0x7ffffffe, deckPath: '/somewhere/else', selectedSlideIds: ['ghost-slide'] });
    const { json } = await parsed('context');
    expect(json.live).toBe(false);
    expect(json.selectedSlideIds).toEqual(['slide-1']);

    await writeSidecar({ pid: 0x7ffffffe, selectedElementIds: ['deleted-object'] });
    expect((await parsed('context')).json.selectedElementIds).toEqual([]);
  });

  it('inspects authored scenes for the selected slide, or a named one, or all of them', async () => {
    await writeSidecar({ pid: 0x7ffffffe });
    const selected = await parsed('inspect', '--selected');
    expect(selected.json.scenes.map((scene: ComputedSlideScene) => scene.id)).toEqual(['slide-2']);
    expect(selected.json.scenes[0].elements[0]).toMatchObject({
      id: 'title-2', type: 'text', selected: true, rendered: null,
    });
    expect(selected.json.scenes[0].elements[0].authored).toMatchObject({ x: 100, y: 100, w: 800, h: 200 });

    const named = await parsed('inspect', '--slide', 'slide-1');
    expect(named.json.scenes.map((scene: ComputedSlideScene) => scene.id)).toEqual(['slide-1']);

    const all = await parsed('inspect', '--all');
    expect(all.json.scenes.map((scene: ComputedSlideScene) => scene.id)).toEqual(['slide-1', 'slide-2']);
  });

  it('refuses --dom without a live editor rather than inventing one', async () => {
    const { code, stderr } = await cli('inspect', '--dom');
    expect(code).toBe(EXIT_ERROR);
    expect(stderr).toMatch(/needs the editor running/);
  });

  it('validates a deck folder and fails loudly on a dangling reference', async () => {
    const clean = await parsed('validate');
    expect(clean.code).toBe(EXIT_OK);
    expect(clean.json).toMatchObject({ valid: true, errors: [] });

    const deck = await onDisk();
    deck.slides[0].timeline = [{
      id: 'build-1',
      trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: 'not-here', value: null },
    }];
    await writeDeck(deck);

    const broken = await parsed('validate');
    expect(broken.code).toBe(EXIT_ERROR);
    expect(broken.json.valid).toBe(false);
    expect(broken.json.errors[0]).toMatch(/targets missing element not-here/);
  });

  it('applies a transaction offline and refuses the same one twice', async () => {
    const before = (await parsed('context')).json.deckRevision;
    const transaction: AgentTransaction = {
      version: 1,
      expectedRevision: before,
      label: 'Add a closing slide',
      operations: [{
        op: 'insertSlides',
        afterSlideId: 'slide-2',
        slides: [slideOf('slide-3', [text('title-3', 'Thanks')])],
      }],
    };
    await writeFile(join(dir, 'txn.json'), JSON.stringify(transaction), 'utf8');

    const applied = await parsed('transaction', 'apply', dir, 'txn.json');
    expect(applied.code).toBe(EXIT_OK);
    expect(applied.json).toMatchObject({ status: 'applied', applied: true, live: false });
    expect((await onDisk()).slides.map((slide) => slide.id)).toEqual(['slide-1', 'slide-2', 'slide-3']);
    expect(applied.json.revision).toBe(deckRevision(await onDisk()));

    // Replaying it is a conflict, not a duplicate slide.
    const replay = await parsed('transaction', 'apply', dir, 'txn.json');
    expect(replay.code).toBe(EXIT_CONFLICT);
    expect(replay.json).toMatchObject({ status: 'conflict' });
    expect(replay.json.revision).toBe(deckRevision(await onDisk()));
    expect((await onDisk()).slides).toHaveLength(3);
  });

  it('fails a render before launching anything when the request cannot be met', async () => {
    const missingOutput = await cli('render', '--all');
    expect(missingOutput.code).toBe(EXIT_USAGE);
    expect(missingOutput.stderr).toMatch(/needs --output/);

    const noSuchSlide = await cli('render', '--slide', 'not-a-slide', '--output', join(dir, 'shots'));
    expect(noSuchSlide.code).toBe(EXIT_ERROR);
    expect(noSuchSlide.stderr).toMatch(/no slide matched/);
  });

  it('hands an agent the format guide without needing to know where the editor lives', async () => {
    // The whole point: this runs in a deck folder that is not the checkout.
    const { code, stdout } = await cli('docs');
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain('# Working on a deck as an agent');
    expect(stdout).toContain('transaction apply');
    expect(stdout).toBe(await readFile(agentGuidePath(), 'utf8'));
  });

  describe('the brief left in the deck folder', () => {
    it('lands in a newly created deck, pointing at the real guide', async () => {
      const fresh = join(dir, 'new-talk');
      await createDeck(fresh, 'New talk');

      const brief = await readFile(join(fresh, 'AGENTS.md'), 'utf8');
      expect(brief).toContain('slide-agent capabilities');
      expect(brief).toContain('slide-agent context');
      expect(brief).toContain('slide-agent docs');
      // The stub exists to stop two failure modes: hand-editing the document,
      // and reading the whole deck before doing anything.
      expect(brief).toMatch(/never hand-edit/);
      expect(brief).toMatch(/Do not read deck\.json/);
      // And to name the one convention an agent reliably gets wrong.
      expect(brief).toContain('KaTeX');
    });

    it('is written for a deck that does not have one yet', async () => {
      expect(await ensureAgentGuide(dir)).toBe(true);
      expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toContain('slide-agent docs');
    });

    it('never overwrites notes the user has added to it', async () => {
      const mine = '# My talk\n\nRemember to rehearse the demo.\n';
      await writeFile(join(dir, 'AGENTS.md'), mine, 'utf8');

      expect(await ensureAgentGuide(dir)).toBe(false);
      expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(mine);
    });
  });

  it('rejects a deck folder that is not one, and unknown commands', async () => {
    const missing = await cli('context', join(dir, 'nope'));
    expect(missing.code).toBe(EXIT_ERROR);
    expect(missing.stderr).toMatch(/No deck.json/);

    const unknown = await cli('frobnicate');
    expect(unknown.code).toBe(EXIT_USAGE);
    expect(unknown.stderr).toMatch(/Unknown command/);
  });

  describe('asset import', () => {
    const fixtures = join(process.cwd(), 'examples', 'demo-deck', 'assets');

    it('imports stills, vectors and documents with deck-relative paths', async () => {
      const png = join(dir, 'figure.png');
      const svg = join(dir, 'diagram.svg');
      const pdf = join(dir, 'paper.pdf');
      const jpeg = join(dir, 'photo.jpg');
      await copyFile(join(fixtures, 'swatch.png'), png);
      await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"></svg>', 'utf8');
      await writeFile(pdf, minimalPdf(), 'utf8');
      await run(getFfmpegPath(), ['-y', '-loglevel', 'error', '-i', png, jpeg]);

      const { code, json } = await parsed('asset', 'import', dir, png, jpeg, svg, pdf);
      expect(code).toBe(EXIT_OK);
      expect(json.failures).toEqual([]);
      expect(json.assets.map((asset: { src: string }) => asset.src.split('.').pop()))
        .toEqual(['png', 'jpg', 'svg', 'pdf']);
      for (const asset of json.assets) {
        expect(asset.src.startsWith('assets/')).toBe(true);
        expect(asset.kind).toBe('image');
      }
      // Rasters get real dimensions; a PDF falls back to a sane page box.
      expect(json.assets[0]).toMatchObject({ width: 800, height: 600 });
      expect(json.assets[3]).toMatchObject({ width: 1400, height: 1000 });
    }, 60_000);

    it('reports an unsupported file without losing the rest of the batch', async () => {
      const png = join(dir, 'figure.png');
      await copyFile(join(fixtures, 'swatch.png'), png);
      const notes = join(dir, 'notes.txt');
      await writeFile(notes, 'not media', 'utf8');

      const { code, json } = await parsed('asset', 'import', dir, notes, png);
      expect(code).toBe(EXIT_OK);
      expect(json.assets).toHaveLength(1);
      expect(json.failures[0].message).toMatch(/Unsupported media type/);
    }, 60_000);

    it('keeps a web-safe video as-is and transcodes one the browser cannot play', async () => {
      const playable = join(dir, 'clip.mp4');
      await copyFile(join(fixtures, 'testclip.mp4'), playable);
      const supported = await parsed('asset', 'import', dir, playable);
      expect(supported.json.assets[0].src).toMatch(/^assets\/clip\.[0-9a-f]{8}\.mp4$/);
      expect(supported.json.assets[0].duration).toBeGreaterThan(0);

      // MPEG-4 Part 2 is a container Chromium will happily accept and then
      // refuse to decode, which is exactly the silent-black-box failure the
      // import path exists to prevent.
      const exotic = join(dir, 'legacy.mp4');
      await run(getFfmpegPath(), [
        '-y', '-loglevel', 'error', '-i', playable, '-t', '1',
        '-c:v', 'mpeg4', '-an', exotic,
      ]);
      const transcoded = await parsed('asset', 'import', dir, exotic);
      expect(transcoded.json.assets[0].src).toMatch(/\.h264\.mp4$/);
      expect(transcoded.json.assets[0].kind).toBe('video');
    }, 180_000);
  });

  it('carries an agent through create, import, reference, validate and inspect', async () => {
    // The end-to-end shape the plan describes: research happens elsewhere, and
    // what lands in the deck is slides, media and a plain-text citation.
    const figure = join(dir, 'figure.png');
    await copyFile(join(process.cwd(), 'examples', 'demo-deck', 'assets', 'swatch.png'), figure);

    const imported = await parsed('asset', 'import', dir, figure);
    const src = imported.json.assets[0].src as string;

    const revision = (await parsed('context')).json.deckRevision;
    const transaction: AgentTransaction = {
      version: 1,
      expectedRevision: revision,
      label: 'Draft the results section',
      operations: [{
        op: 'insertSlides',
        afterSlideId: 'slide-2',
        slides: [
          slideOf('results', [
            text('results-title', 'Results', { class: ['role-title'], y: 80 }),
            {
              id: 'results-figure', type: 'image', x: 200, y: 300, w: 600, h: 400, rot: 0, z: 2,
              opacity: 1, class: [], style: {}, src, fit: 'contain', alt: 'Result figure',
              sourceBox: null,
            },
            text('results-citation', 'SIREN, Sitzmann et al.', { class: ['role-caption'], y: 900 }),
          ]),
          slideOf('closing', [text('closing-title', 'Thank you', { class: ['role-title'] })]),
        ],
      }],
    };
    await writeFile(join(dir, 'txn.json'), JSON.stringify(transaction), 'utf8');
    expect((await parsed('transaction', 'apply', dir, 'txn.json')).code).toBe(EXIT_OK);

    const validated = await parsed('validate');
    expect(validated.code).toBe(EXIT_OK);
    expect(validated.json.valid).toBe(true);

    const inspected = await parsed('inspect', '--slide', 'results');
    const scene = inspected.json.scenes[0] as ComputedSlideScene;
    expect(scene.elements.map((element) => element.id))
      .toEqual(['results-title', 'results-figure', 'results-citation']);
    expect(scene.elements[1].media?.src).toBe(src);
    // The citation is ordinary text, not a bibliography entity.
    expect(scene.elements[2].text?.plain).toBe('SIREN, Sitzmann et al.');
    expect((await onDisk()).slides.map((slide) => slide.id))
      .toEqual(['slide-1', 'slide-2', 'results', 'closing']);
  }, 60_000);
});

/** The smallest structurally valid PDF, enough for classification and copying. */
function minimalPdf(): string {
  return [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
    '',
  ].join('\n');
}
