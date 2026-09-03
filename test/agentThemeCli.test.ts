import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Deck, emptyDeck, parseDeck } from '../src/shared/deck.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, runAgentCli } from '../src/cli/agentCli.js';
import { THEMES, THEME_BLOCK_START, themeById } from '../src/shared/themes.js';
import type { AgentContext } from '../src/shared/agent.js';
import { agentRuntimePaths, deckRevision } from '../src/main/agentRuntime.js';

/**
 * The theme system from the command line.
 *
 * These drive it the way an agent asked to "make me a theme like X" would:
 * read a shipped preset, derive one from it, register it on the deck, and
 * restyle with the aspects that were asked for — checking at each step that
 * the *deck* changed the way the panel would have changed it, since the whole
 * point is that a theme an agent writes is not a second-class one.
 */

const text = (id: string, html: string, over: Record<string, unknown> = {}) => ({
  id, type: 'text' as const, x: 100, y: 100, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
  class: ['role-title'], style: { 'font-size': '96px', 'font-family': 'Comic Sans MS' },
  html, align: 'left' as const, valign: 'top' as const, ...over,
});

describe('slide-agent theme', () => {
  let dir: string;
  let stateDir: string;
  let out: string[];
  let err: string[];

  const cli = async (...argv: string[]) => {
    out = [];
    err = [];
    const code = await runAgentCli(argv, {
      out: (chunk: string) => out.push(chunk),
      err: (chunk: string) => err.push(chunk),
      cwd: dir,
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };

  const parsed = async (...argv: string[]) => {
    const result = await cli(...argv);
    return { ...result, json: JSON.parse(result.stdout) };
  };

  const onDisk = async (): Promise<Deck> =>
    parseDeck(JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8')));

  /** A preset derived from a shipped one, which is the loop `show` exists for. */
  const derive = async (over: Record<string, unknown> = {}) => {
    const { json } = await parsed('theme', 'show', '--id', 'almanac');
    const spec = {
      ...json,
      id: 'lab-night',
      name: 'Lab Night',
      description: 'Slab titles on a deep ink ground.',
      colors: { background: '#12151a', text: '#e9edf2', muted: '#94a0ad', accent: '#f0a83c' },
      palette: ['#e9edf2', '#94a0ad', '#f0a83c', '#232a33', '#12151a'],
      ...over,
    };
    delete spec.mode;
    delete spec.css;
    const path = join(dir, 'spec.json');
    await writeFile(path, JSON.stringify(spec), 'utf8');
    return path;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-theme-'));
    stateDir = await mkdtemp(join(tmpdir(), 'agent-theme-state-'));
    process.env.DECKWERK_STATE_DIR = stateDir;
    const deck = emptyDeck('Theme deck');
    deck.slides = parseDeck({
      version: 1,
      slides: [
        { id: 'slide-1', name: 'One', elements: [text('title-1', 'First')] },
        { id: 'slide-2', name: 'Two', elements: [text('title-2', 'Second')] },
      ],
    }).slides;
    await writeFile(join(dir, 'deck.json'), `${JSON.stringify(parseDeck(deck), null, 2)}\n`, 'utf8');
    await writeFile(join(dir, 'theme.css'), '/* mine */\n.callout { border: 4px solid red; }\n', 'utf8');
  });

  afterEach(async () => {
    delete process.env.DECKWERK_STATE_DIR;
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it('lists every shipped preset, and says what the deck is wearing', async () => {
    const { code, json } = await parsed('theme', 'list');
    expect(code).toBe(EXIT_OK);
    expect(json.themes).toHaveLength(THEMES.length);
    expect(json.themes.every((theme: { source: string }) => theme.source === 'built-in')).toBe(true);
    expect(json.installed).toBeNull();
    expect(json.chosen).toBeNull();
  });

  it('shows a preset in exactly the shape create reads back', async () => {
    const spec = await derive();
    const { code, json } = await parsed('theme', 'create', '--spec', spec);
    expect(code).toBe(EXIT_OK);
    expect(json.applied).toBe(true);
    const deck = await onDisk();
    expect(deck.customThemes.map((theme) => theme.id)).toEqual(['lab-night']);
    // Adding a theme changes what is available and nothing else — the omarchy
    // rule the panel follows, and the one an agent is most likely to assume away.
    expect(deck.themePreset).toBeNull();
    expect(deck.themeSelection).toBeNull();
    expect(deck.slides[0].elements[0].style['font-family']).toBe('Comic Sans MS');
  });

  it('offers a deck theme alongside the built-ins, with its generated variant', async () => {
    await cli('theme', 'create', '--spec', await derive());
    const { json } = await parsed('theme', 'list');
    expect(json.themes).toHaveLength(THEMES.length + 1);
    expect(json.themes.at(-1)).toMatchObject({ id: 'lab-night', source: 'deck', mode: 'dark' });

    const light = await parsed('theme', 'show', '--id', 'lab-night-light');
    expect(light.code).toBe(EXIT_OK);
    expect(light.json.mode).toBe('light');
  });

  it('refuses a theme whose id shadows a built-in, or whose shape is wrong', async () => {
    const shadow = await cli('theme', 'create', '--spec', await derive({ id: 'noir' }));
    expect(shadow.code).toBe(EXIT_ERROR);
    expect(shadow.stderr).toContain('built-in preset id');

    const variant = await cli('theme', 'create', '--spec', await derive({ id: 'mine-dark' }));
    expect(variant.code).toBe(EXIT_ERROR);
    expect(variant.stderr).toContain('generated variant');

    const malformed = await cli('theme', 'create', '--spec', await derive({ palette: 'blue' }));
    expect(malformed.code).toBe(EXIT_ERROR);
    expect(malformed.stderr).toContain('palette');
    expect((await onDisk()).customThemes).toEqual([]);
  });

  it('replaces a deck theme only when asked, so iterating on one is explicit', async () => {
    await cli('theme', 'create', '--spec', await derive());
    const clash = await cli('theme', 'create', '--spec', await derive({ name: 'Lab Night II' }));
    expect(clash.code).toBe(EXIT_ERROR);
    expect(clash.stderr).toContain('--replace');

    const replaced = await cli('theme', 'create', '--spec', await derive({ name: 'Lab Night II' }), '--replace');
    expect(replaced.code).toBe(EXIT_OK);
    const deck = await onDisk();
    expect(deck.customThemes).toHaveLength(1);
    expect(deck.customThemes[0].name).toBe('Lab Night II');
  });

  it('chooses a theme for slides yet to exist without touching the ones that do', async () => {
    await cli('theme', 'create', '--spec', await derive());
    const { code, json } = await parsed('theme', 'choose', '--id', 'lab-night');
    expect(code).toBe(EXIT_OK);
    expect(json.note).toContain('New slides');
    const deck = await onDisk();
    expect(deck.themeSelection?.preset).toBe('lab-night');
    expect(deck.themePreset).toBeNull();
    expect(deck.slides[0].elements[0].style['font-family']).toBe('Comic Sans MS');
    expect(deck.slides[0].background.color).toBeNull();
  });

  it('applies a deck theme deck-wide: defaults, slides and the generated stylesheet block', async () => {
    await cli('theme', 'create', '--spec', await derive());
    const { code, json } = await parsed('theme', 'apply', '--id', 'lab-night', '--scope', 'deck');
    expect(code).toBe(EXIT_OK);
    expect(json.slides).toBe(2);
    expect(json.stylesheet).toBe('theme.css');

    const deck = await onDisk();
    expect(deck.themePreset).toBe('lab-night');
    expect(deck.themeStyle?.colors.background).toBe('#12151a');
    for (const slide of deck.slides) {
      expect(slide.background.color).toBe('#12151a');
      // Deck scope installs the values in the stylesheet, so the inline
      // overrides that used to win are removed rather than rewritten.
      expect(slide.elements[0].style['font-family']).toBeUndefined();
      expect(slide.elements[0].style['font-size']).toBeUndefined();
    }

    const css = await readFile(join(dir, 'theme.css'), 'utf8');
    expect(css).toContain(THEME_BLOCK_START);
    expect(css).toContain('#12151a');
    // The author's own CSS survives the install, below the generated block.
    expect(css).toContain('.callout { border: 4px solid red; }');
    // Hand-written CSS that sets no type or colour cannot outrank the theme,
    // so it is not something to warn about.
    expect(json.warnings).toBeUndefined();
  });

  it('warns when hand-written CSS will outrank the block it just installed', async () => {
    await writeFile(
      join(dir, 'theme.css'),
      '/* header prose, not a selector */\n.slide { font-family: "Comic Sans MS"; }\n',
      'utf8',
    );
    const { json } = await parsed('theme', 'apply', '--id', 'noir', '--scope', 'deck');
    expect(json.warnings?.join(' ')).toContain('.slide');
    expect(json.warnings?.join(' ')).not.toContain('header prose');
  });

  it('restyles only the slides named, leaving the deck defaults and the rest alone', async () => {
    const { code, json } = await parsed(
      'theme', 'apply', '--id', 'noir', '--scope', 'slides', '--slide', 'slide-2',
    );
    expect(code).toBe(EXIT_OK);
    expect(json.slides).toBe(1);
    expect(json.stylesheet).toBeUndefined();

    const deck = await onDisk();
    const noir = themeById('noir')!;
    expect(deck.slides[1].elements[0].style['font-family']).toBe(noir.fonts.title.family);
    expect(deck.slides[0].elements[0].style['font-family']).toBe('Comic Sans MS');
    // Slides scope is not an install: the deck defaults and the stylesheet are
    // untouched, and only the choice for future slides is recorded.
    expect(deck.themePreset).toBeNull();
    expect(deck.themeStyle).toBeNull();
    expect(deck.themeSelection?.preset).toBe('noir');
    expect(await readFile(join(dir, 'theme.css'), 'utf8')).not.toContain(THEME_BLOCK_START);
  });

  it('narrows an apply to the roles and properties asked for', async () => {
    const { code } = await cli(
      'theme', 'apply', '--id', 'noir', '--slide', 'slide-1',
      '--roles', 'title', '--properties', 'text-color',
    );
    expect(code).toBe(EXIT_OK);
    const element = (await onDisk()).slides[0].elements[0];
    expect(element.style['color']).toBe(themeById('noir')!.colors.text);
    // Asked for the colour alone, so the typeface it arrived with stays.
    expect(element.style['font-family']).toBe('Comic Sans MS');
  });

  it('rejects an unknown theme, role or property with the menu of real ones', async () => {
    const theme = await cli('theme', 'apply', '--id', 'nope', '--all');
    expect(theme.code).toBe(EXIT_USAGE);
    expect(theme.stderr).toContain('almanac');

    const role = await cli('theme', 'apply', '--id', 'noir', '--all', '--roles', 'subtitle');
    expect(role.code).toBe(EXIT_USAGE);
    expect(role.stderr).toContain('caption');

    const property = await cli('theme', 'apply', '--id', 'noir', '--all', '--properties', 'colours');
    expect(property.code).toBe(EXIT_USAGE);
    expect(property.stderr).toContain('object-colors');
  });

  it('warns when role detection had no font sizes to classify by', async () => {
    const deck = await onDisk();
    for (const slide of deck.slides) {
      for (const element of slide.elements) {
        element.class = [];
        element.style = {};
      }
    }
    await writeFile(join(dir, 'deck.json'), `${JSON.stringify(deck, null, 2)}\n`, 'utf8');

    const { json } = await parsed('theme', 'apply', '--id', 'noir', '--all', '--detect-roles');
    expect(json.warnings?.join(' ')).toContain('role-base');
    expect((await onDisk()).slides[0].elements[0].class).toContain('role-base');
  });

  it('deletes a deck theme, and says the deck still names it', async () => {
    await cli('theme', 'create', '--spec', await derive());
    await cli('theme', 'choose', '--id', 'lab-night');
    const { code, json } = await parsed('theme', 'delete', '--id', 'lab-night');
    expect(code).toBe(EXIT_OK);
    expect(json.note).toContain('still names this theme');
    expect((await onDisk()).customThemes).toEqual([]);

    const builtIn = await cli('theme', 'delete', '--id', 'noir');
    expect(builtIn.code).toBe(EXIT_ERROR);
    expect(builtIn.stderr).toContain('cannot be deleted');
  });

  describe('error paths', () => {
    it('refuses a missing or unknown subcommand with the menu, as usage', async () => {
      const none = await cli('theme');
      expect(none.code).toBe(EXIT_USAGE);
      expect(none.stderr).toContain('Expected list, show, create, delete, choose or apply');
      const unknown = await cli('theme', 'install');
      expect(unknown.code).toBe(EXIT_USAGE);
      expect(unknown.stderr).toContain('install');
      expect(unknown.stdout).toBe('');
    });

    it('refuses unknown flags and stray positionals before touching the deck', async () => {
      const before = await readFile(join(dir, 'deck.json'), 'utf8');
      expect((await cli('theme', 'list', '--verbose')).code).toBe(EXIT_USAGE);
      expect((await cli('theme', 'apply', '--id', 'noir', '--all', '--bogus')).code).toBe(EXIT_USAGE);
      const stray = await cli('theme', 'apply', '.', 'extra', '--id', 'noir', '--all');
      expect(stray.code).toBe(EXIT_USAGE);
      expect(stray.stderr).toContain('extra');
      expect(await readFile(join(dir, 'deck.json'), 'utf8')).toBe(before);
    });

    it('needs --spec, --id where they are required, and says so as usage errors', async () => {
      const create = await cli('theme', 'create');
      expect(create.code).toBe(EXIT_USAGE);
      expect(create.stderr).toContain('--spec');
      for (const sub of ['delete', 'choose', 'apply']) {
        const result = await cli('theme', sub);
        expect(result.code, sub).toBe(EXIT_USAGE);
        expect(result.stderr, sub).toContain('--id');
      }
    });

    it('reports a missing or unparsable spec file as an error, leaving the deck alone', async () => {
      const missing = await cli('theme', 'create', '--spec', 'nowhere.json');
      expect(missing.code).toBe(EXIT_ERROR);
      expect(missing.stderr).toContain('nowhere.json');
      await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8');
      const broken = await cli('theme', 'create', '--spec', 'broken.json');
      expect(broken.code).toBe(EXIT_ERROR);
      expect((await onDisk()).customThemes).toEqual([]);
    });

    it('rejects an empty font family and a one-swatch palette as things that would not work', async () => {
      const spec = await derive({ palette: ['#12151a'] });
      const short = await cli('theme', 'create', '--spec', spec);
      expect(short.code).toBe(EXIT_ERROR);
      expect(short.stderr).toContain('two swatches');
      const { json } = await parsed('theme', 'show', '--id', 'almanac');
      const blank = { ...json, id: 'blank', fonts: { ...json.fonts, body: { ...json.fonts.body, family: '  ' } } };
      delete blank.mode;
      delete blank.css;
      await writeFile(join(dir, 'blank.json'), JSON.stringify(blank), 'utf8');
      const empty = await cli('theme', 'create', '--spec', 'blank.json');
      expect(empty.code).toBe(EXIT_ERROR);
      expect(empty.stderr).toContain('fonts.body.family');
    });

    it('rejects an unknown scope and a stale slide id as usage errors', async () => {
      const scope = await cli('theme', 'apply', '--id', 'noir', '--all', '--scope', 'everything');
      expect(scope.code).toBe(EXIT_USAGE);
      expect(scope.stderr).toContain('--scope deck');
      const stale = await cli('theme', 'apply', '--id', 'noir', '--slide', 'slide-9');
      expect(stale.code).toBe(EXIT_USAGE);
      expect(stale.stderr).toContain('No such slide: slide-9');
      const deck = await onDisk();
      expect(deck.themeSelection).toBeNull();
      expect(deck.slides.every((slide) => slide.elements[0].style['font-family'] === 'Comic Sans MS')).toBe(true);
    });

    it('resolves show and choose against the deck, with the menu on a miss', async () => {
      const show = await cli('theme', 'show', '--id', 'nope');
      expect(show.code).toBe(EXIT_USAGE);
      expect(show.stderr).toContain('noir');
      expect(show.stderr).toContain('-dark');
      const choose = await cli('theme', 'choose', '--id', 'noir-dark');
      // Noir is already dark; the suffix names nothing.
      expect(choose.code).toBe(EXIT_USAGE);
      expect((await onDisk()).themeSelection).toBeNull();
    });

    it('asks for --id when the deck wears no theme yet', async () => {
      const bare = await cli('theme', 'show');
      expect(bare.code).toBe(EXIT_USAGE);
      expect(bare.stderr).toContain('--id');
      // Once a theme is chosen, show defaults to it.
      await cli('theme', 'choose', '--id', 'salon');
      const { code, json } = await parsed('theme', 'show');
      expect(code).toBe(EXIT_OK);
      expect(json.id).toBe('salon');
    });

    it('refuses to restyle an empty deck rather than reporting success', async () => {
      const deck = await onDisk();
      deck.slides = [];
      await writeFile(join(dir, 'deck.json'), `${JSON.stringify(deck, null, 2)}\n`, 'utf8');
      const result = await cli('theme', 'apply', '--id', 'noir');
      expect(result.code).toBe(EXIT_ERROR);
      expect(result.stderr).toContain('No slides selected');
    });
  });

  describe('output shape', () => {
    it('reports a second identical apply as nothing to change, with the common status fields', async () => {
      const first = await parsed('theme', 'apply', '--id', 'noir', '--slide', 'slide-1');
      expect(first.json).toMatchObject({ status: 'applied', applied: true, live: false, scope: 'slides', slides: 1 });
      expect(typeof first.json.revision).toBe('string');
      const again = await parsed('theme', 'apply', '--id', 'noir', '--slide', 'slide-1');
      expect(again.code).toBe(EXIT_OK);
      expect(again.json).toMatchObject({ status: 'applied', applied: false, changed: 0 });
    });

    it('applies a deck theme through its generated light variant and lists what the deck wears', async () => {
      await cli('theme', 'create', '--spec', await derive());
      const { code } = await cli('theme', 'apply', '--id', 'lab-night-light', '--slide', 'slide-2', '--properties', 'background');
      expect(code).toBe(EXIT_OK);
      const deck = await onDisk();
      expect(deck.slides[1].background.color).not.toBeNull();
      expect(deck.slides[1].background.color).not.toBe('#12151a');
      expect(deck.slides[0].background.color).toBeNull();
      const { json } = await parsed('theme', 'list');
      expect(json).toMatchObject({ installed: null, chosen: 'lab-night-light', modified: false });
    });
  });

  describe('scope and the stylesheet', () => {
    it('treats a bare --all as every slide, never as an install', async () => {
      const cssBefore = await readFile(join(dir, 'theme.css'), 'utf8');
      const { code, json } = await parsed('theme', 'apply', '--id', 'noir', '--all');
      expect(code).toBe(EXIT_OK);
      expect(json.scope).toBe('slides');
      expect(json.slides).toBe(2);
      expect(json.stylesheet).toBeUndefined();

      const deck = await onDisk();
      const noir = themeById('noir')!;
      // Every slide is restyled inline...
      for (const slide of deck.slides) {
        expect(slide.background.color).toBe(noir.colors.background);
        expect(slide.elements[0].style['font-family']).toBe(noir.fonts.title.family);
      }
      // ...and nothing that only --scope deck may touch has moved.
      expect(deck.themePreset).toBeNull();
      expect(deck.themeStyle).toBeNull();
      expect(deck.themeSelection?.preset).toBe('noir');
      expect(await readFile(join(dir, 'theme.css'), 'utf8')).toBe(cssBefore);
    });

    /**
     * Stand in for the editor: answer the one request the CLI files with the
     * given status, the way the real runtime would from its inbox watcher.
     */
    async function answerNextRequest(status: 'conflict' | 'error'): Promise<void> {
      const paths = agentRuntimePaths(dir);
      await mkdir(paths.inbox, { recursive: true });
      await mkdir(paths.responses, { recursive: true });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const [name] = (await readdir(paths.inbox)).filter((entry) => entry.endsWith('.json'));
        if (name) {
          const request = JSON.parse(await readFile(join(paths.inbox, name), 'utf8')) as { id: string };
          await writeFile(join(paths.responses, name), JSON.stringify({
            version: 1, id: request.id, status, revision: deckRevision(await onDisk()),
            message: `${status} from the fake editor`,
          }), 'utf8');
          // The runtime consumes the request it answered; so must we, or the
          // next round answers this stale one instead of the new request.
          await unlink(join(paths.inbox, name));
          return;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      throw new Error('the CLI never filed a request');
    }

    async function liveEditor(): Promise<void> {
      const paths = agentRuntimePaths(dir);
      await mkdir(paths.root, { recursive: true });
      const context: AgentContext = {
        version: 1, live: true, sessionId: 'session-theme', pid: process.pid,
        updatedAt: new Date().toISOString(), deckPath: dir,
        deckRevision: deckRevision(await onDisk()),
        activeSlideId: 'slide-1', activeSlideIndex: 0,
        selectedSlideIds: ['slide-1'], selectedElementIds: [], scenes: [],
      };
      await writeFile(paths.context, JSON.stringify(context, null, 2), 'utf8');
    }

    it('leaves theme.css untouched when the live editor refuses the install', async () => {
      const cssBefore = await readFile(join(dir, 'theme.css'), 'utf8');
      const deckBefore = await readFile(join(dir, 'deck.json'), 'utf8');
      await liveEditor();

      for (const status of ['conflict', 'error'] as const) {
        const answered = answerNextRequest(status);
        const result = await cli('theme', 'apply', '--id', 'noir', '--scope', 'deck');
        await answered;
        expect(result.code, status).not.toBe(EXIT_OK);
        expect(JSON.parse(result.stdout), status).toMatchObject({ status, live: true, applied: false });
        expect(await readFile(join(dir, 'theme.css'), 'utf8'), status).toBe(cssBefore);
        expect(await readFile(join(dir, 'deck.json'), 'utf8'), status).toBe(deckBefore);
      }
    });

    it('writes theme.css once the offline install has landed', async () => {
      const { code, json } = await parsed('theme', 'apply', '--id', 'noir', '--scope', 'deck');
      expect(code).toBe(EXIT_OK);
      expect(json).toMatchObject({ scope: 'deck', stylesheet: 'theme.css', live: false });
      expect((await onDisk()).themePreset).toBe('noir');
      expect(await readFile(join(dir, 'theme.css'), 'utf8')).toContain(THEME_BLOCK_START);
    });
  });
});
