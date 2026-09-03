import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'electron-vite';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck } from '../src/shared/deck.js';
import {
  Cdp,
  collectProcessOutput,
  electronBinary,
  eventually,
  findTarget,
  freePort,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';
import {
  EXHAUSTIVE_CONTENT,
  EXHAUSTIVE_HTML,
  EXHAUSTIVE_TEXT,
  EXHAUSTIVE_TEXT_ID,
  runExhaustiveTextFormatting,
  takeRecoveries,
} from './support/exhaustiveTextFormatting.js';

/**
 * Opt-in, production-interaction formatting soak.
 *
 * Full matrix: 3 selection targets (prose, inline math, and display math) ×
 * 4 weight/bold modes × 2 italic × 2 underline × 2 sizes × 2 typefaces ×
 * 4 alignments × 3 list styles = 2,304 states in collaboration Chromium and
 * again in packaged Electron (4,608 interactive states total). Shortcut and
 * button routes alternate across the matrix.
 */
const RUN_EXHAUSTIVE = process.env.RUN_EXHAUSTIVE_FORMAT_FUZZ === '1';
const DECK_ID = 'exhaustive-formatting';
const TEST_TIMEOUT = 30 * 60_000;

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? appProcess);
  browser = null;
  appProcess = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

async function createFixture(deckDir: string): Promise<void> {
  const deck = emptyDeck('Exhaustive formatting fuzz');
  deck.themePreset = 'basic';
  deck.slides[0].elements.push({
    id: EXHAUSTIVE_TEXT_ID,
    type: 'text',
    x: 120,
    y: 100,
    w: 1680,
    h: 820,
    rot: 0,
    z: 1,
    opacity: 1,
    class: ['role-body'],
    // An explicit paint, the way an imported box carries one: the role round
    // trip asserts a role change never takes it away.
    style: { color: 'rgb(220, 38, 38)' },
    html: EXHAUSTIVE_HTML,
    align: 'left',
    valign: 'top',
  });
  await saveDeck(deckDir, deck);
  // Distinct type per role and no `color` on any of them — how the deck
  // stylesheets in decks/ are written. `.role-title` deliberately disagrees
  // with the deck's own theme (96px here, 108px there), which is what lets the
  // role round trip tell "wearing the current theme" apart from "wearing
  // whatever theme.css was installed with the deck".
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #fff; color: #111827; }',
    '.role-title { font: 700 96px/1.05 Georgia, serif; letter-spacing: -0.02em; }',
    '.role-body { font: 400 42px/1.35 Arial, sans-serif; }',
    '.role-caption { font: 400 24px/1.3 Arial, sans-serif; }',
    '',
  ].join('\n'), 'utf8');
}

function textFromHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replaceAll('&nbsp;', '\u00a0');
}

describe.skipIf(!RUN_EXHAUSTIVE || !electronBinary)('exhaustive formatting fuzz in Chromium', () => {
  it('covers the full interactive formatting outer product', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'format-exhaustive-chromium-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'chromium-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await createFixture(deckDir);

    server = await startCollabServer({
      rootDir: decksRoot,
      clientDir: await collabClientDir(),
      host: '127.0.0.1',
      port: 0,
    });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Exhaustive%20Fuzz`,
      profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.includes(`deck=${DECK_ID}`),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`(
      document.getElementById('status')?.textContent?.includes('connected as Exhaustive Fuzz') === true
      && Boolean(document.querySelector(${JSON.stringify(EXHAUSTIVE_CONTENT)}))
    )`), 'Chromium exhaustive fixture did not connect');

    const cases = await runExhaustiveTextFormatting(editor, { budgetMs: TEST_TIMEOUT - 60_000 });
    // Recoveries are the symptom under test surfacing in the harness itself.
    // A handful across thousands of real-input steps is machine-load noise; a
    // pattern is a regression that silent retries used to hide.
    const recoveries = takeRecoveries();
    if (recoveries.length > 0) {
      console.warn(`[harness-recovery] ${recoveries.length} recoveries this run:`, recoveries);
    }
    expect(recoveries.length, `harness recoveries: ${recoveries.join('; ')}`)
      .toBeLessThanOrEqual(Math.max(3, Math.ceil(cases / 100)));
    const persisted = await eventually(async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      return response.json() as Promise<{
        slides: Array<{ elements: Array<{ id: string; html?: string }> }>;
      }>;
    }, 'Chromium exhaustive result did not persist', (deck) => {
      const html = deck.slides[0].elements.find((item) => item.id === EXHAUSTIVE_TEXT_ID)?.html ?? '';
      return textFromHtml(html) === EXHAUSTIVE_TEXT;
    }, 15_000);
    const html = persisted.slides[0].elements.find((item) => item.id === EXHAUSTIVE_TEXT_ID)?.html ?? '';
    expect(textFromHtml(html)).toBe(EXHAUSTIVE_TEXT);
    expect(html).toContain('$E = mc^2$');
    expect(html).toContain('$$\\int_0^1 x^2\\,dx = 1/3$$');
    expect(cases).toBeGreaterThan(0);
  }, TEST_TIMEOUT);
});

describe.skipIf(!RUN_EXHAUSTIVE || !electronBinary)('exhaustive formatting fuzz in Electron', () => {
  it('covers the full interactive formatting outer product', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'format-exhaustive-electron-'));
    const checkout = process.cwd();
    const appDir = join(workDir, 'app');
    const outDir = join(appDir, 'out');
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await createFixture(deckDir);

    await build({
      root: checkout,
      configFile: join(checkout, 'electron.vite.config.ts'),
      logLevel: 'silent',
      build: { outDir },
    });
    await writeFile(join(appDir, 'package.json'), JSON.stringify({
      name: 'deckwerk-exhaustive-formatting-test',
      private: true,
      type: 'module',
      main: 'out/main/index.js',
    }), 'utf8');
    await symlink(join(checkout, 'node_modules'), join(appDir, 'node_modules'), 'dir');

    const debugPort = await freePort();
    appProcess = spawn(electronBinary, [
      appDir,
      `--remote-debugging-port=${debugPort}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      deckDir,
    ], {
      cwd: checkout,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    const appLog = collectProcessOutput(appProcess);
    const target = await findTarget(
      debugPort,
      (candidate) => candidate.title === 'DeckWerk' || candidate.url.includes('/editor/index.html'),
      appLog,
      20_000,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`(
      window.api?.getDeck?.().then((session) => (
        session?.dir === ${JSON.stringify(deckDir)}
          && Boolean(document.querySelector(${JSON.stringify(EXHAUSTIVE_CONTENT)}))
      )) ?? false
    )`), 'Electron exhaustive fixture did not open');
    await editor.call('Page.bringToFront');
    await editor.evaluate('window.focus()');

    const cases = await runExhaustiveTextFormatting(editor, { budgetMs: TEST_TIMEOUT - 60_000 });
    // Recoveries are the symptom under test surfacing in the harness itself.
    // A handful across thousands of real-input steps is machine-load noise; a
    // pattern is a regression that silent retries used to hide.
    const recoveries = takeRecoveries();
    if (recoveries.length > 0) {
      console.warn(`[harness-recovery] ${recoveries.length} recoveries this run:`, recoveries);
    }
    expect(recoveries.length, `harness recoveries: ${recoveries.join('; ')}`)
      .toBeLessThanOrEqual(Math.max(3, Math.ceil(cases / 100)));
    const html = await eventually(async () => {
      const disk = JSON.parse(await readFile(join(deckDir, 'deck.json'), 'utf8')) as {
        slides: Array<{ elements: Array<{ id: string; html?: string }> }>;
      };
      return disk.slides[0].elements.find((item) => item.id === EXHAUSTIVE_TEXT_ID)?.html ?? '';
    }, 'Electron exhaustive result did not autosave',
    (value) => textFromHtml(value) === EXHAUSTIVE_TEXT, 15_000);
    expect(textFromHtml(html)).toBe(EXHAUSTIVE_TEXT);
    expect(html).toContain('$E = mc^2$');
    expect(html).toContain('$$\\int_0^1 x^2\\,dx = 1/3$$');
    expect(cases).toBeGreaterThan(0);
  }, TEST_TIMEOUT);
});

describe.skipIf(RUN_EXHAUSTIVE)('exhaustive formatting fuzz (opt-in)', () => {
  it('runs only through npm run test:formatting:exhaustive', () => {
    expect(RUN_EXHAUSTIVE).toBe(false);
  });
});
