import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';

/** Real-Chromium coverage for repeated, overlapping inline-format edits. */
const DECK_ID = 'format-toggle-fuzz';
const TEXT_ID = 'format-toggle-text';
const TEXT = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.';
const MOD = process.platform === 'darwin' ? 4 : 2;
const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;
const PANEL = '#inspector';

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

type Format = 'bold' | 'italic';
type Operation = { start: number; end: number; format: Format; input: 'button' | 'shortcut' };

describe.skipIf(!electronBinary)('stateful inline formatting in Chromium', () => {
  it('types text, repeatedly toggles words, and clears subsets without stale paint or scope drift', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'format-toggle-fuzz-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = join(workDir, 'client');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const deck = emptyDeck('Format toggle fuzz');
    deck.themePreset = 'basic';
    deck.slides[0].elements.push({
      id: TEXT_ID, type: 'text', x: 120, y: 180, w: 1680, h: 500,
      rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
      html: '<p>Replace this text</p>', align: 'left', valign: 'top',
    });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #fff; color: #111827; }',
      '.role-body { font: 400 42px/1.35 sans-serif; }',
      '',
    ].join('\n'), 'utf8');
    await build({
      configFile: join(process.cwd(), 'vite.collab.config.ts'), logLevel: 'silent',
      build: { outDir: clientDir, emptyOutDir: true },
    });
    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Toggle%20Fuzz`, profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.includes(`deck=${DECK_ID}`),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`(
      document.getElementById('status')?.textContent?.includes('connected as Toggle Fuzz') === true
      && Boolean(document.querySelector('${CONTENT}'))
    )`), 'format-toggle browser did not connect');

    await editor.doubleClickText(CONTENT, 'editable text');
    await editor.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    const suffixStart = TEXT.indexOf(', consectetur');
    await editor.call('Input.insertText', { text: TEXT.slice(0, suffixStart) });
    const earlyIpsum = { start: TEXT.indexOf('ipsum'), end: TEXT.indexOf('ipsum') + 'ipsum'.length };
    await selectRange(editor, earlyIpsum.start, earlyIpsum.end, true);
    await editor.chord('i', 'KeyI', 73, MOD);
    await editor.evaluate(`(() => {
      const root = document.querySelector('${CONTENT}');
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      root.focus();
    })()`);
    await editor.call('Input.insertText', { text: TEXT.slice(suffixStart) });
    // A collapsed-caret shortcut is an explicit style for text typed next,
    // independent of Chromium's deprecated execCommand typing state.
    await editor.chord('b', 'KeyB', 66, MOD);
    await editor.call('Input.insertText', { text: 'B' });
    await editor.chord('b', 'KeyB', 66, MOD);
    await editor.call('Input.insertText', { text: 'P' });
    const authoredText = `${TEXT}BP`;
    await eventually(async () => editor!.evaluate<string>(
      `window.store.get().deck.slides[0].elements.find((element) => element.id === '${TEXT_ID}').html`,
    ), 'typed text did not reach the live deck', (html) => html.replace(/<[^>]+>/g, '') === authoredText);
    const typedState = await readState(editor, 'bold');
    const typedHtml = await editor.evaluate<string>(
      `document.querySelector('${CONTENT}').innerHTML`,
    );
    expect(
      typedState.map.slice(TEXT.length),
      `collapsed-caret bold run was not retained: ${typedHtml}`,
    ).toEqual([true, false]);

    const word = (value: string) => ({ start: TEXT.indexOf(value), end: TEXT.indexOf(value) + value.length });
    const ipsum = word('ipsum');
    const phrase = { start: TEXT.indexOf('dolor'), end: TEXT.indexOf(' amet') };
    const sit = word('sit');
    const consectetur = word('consectetur');
    const adipiscing = word('adipiscing');
    const operations: Operation[] = [
      { ...ipsum, format: 'italic', input: 'shortcut' },
      { ...ipsum, format: 'italic', input: 'button' },
      { ...phrase, format: 'italic', input: 'button' },
      { ...sit, format: 'italic', input: 'shortcut' },
      { ...consectetur, format: 'bold', input: 'shortcut' },
      { ...adipiscing, format: 'bold', input: 'button' },
      { ...consectetur, format: 'italic', input: 'button' },
      { ...consectetur, format: 'bold', input: 'shortcut' },
      { ...ipsum, format: 'italic', input: 'shortcut' },
      { ...ipsum, format: 'italic', input: 'shortcut' },
    ];
    const expected: Record<Format, boolean[]> = {
      bold: Array(authoredText.length).fill(false), italic: Array(authoredText.length).fill(false),
    };
    expected.italic.fill(true, earlyIpsum.start, earlyIpsum.end);
    expected.bold[TEXT.length] = true;

    for (const [step, operation] of operations.entries()) {
      // Alternate which adjacent text node owns an exact start boundary. Real
      // pointer selections can produce either affinity after formatting has
      // split a run, while Selection#toString is identical for both.
      await selectRange(editor, operation.start, operation.end, step % 2 === 0);
      const next = !expected[operation.format][operation.start];
      if (operation.input === 'shortcut') {
        const key = operation.format === 'italic' ? 'i' : 'b';
        await editor.chord(key, `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), MOD);
      } else {
        const label = operation.format === 'italic'
          ? 'Italic (Cmd/Ctrl+I)' : 'Bold (Cmd/Ctrl+B)';
        await editor.click(`${PANEL} button[aria-label="${label}"]`, `${label} at step ${step + 1}`);
      }
      expected[operation.format].fill(next, operation.start, operation.end);

      const state = await eventually(async () => readState(editor!, operation.format),
        `formatting step ${step + 1} did not settle`,
        (value) => value.text === authoredText && value.selected === TEXT.slice(operation.start, operation.end));
      expect(state.map, `format scope drifted at step ${step + 1}`).toEqual(expected[operation.format]);
      expect(state.editing, `editing stopped at step ${step + 1}`).toBe(true);
    }

    // Drive the same deterministic overlapping-range workload as the fast
    // stateful fuzzer through real Chromium focus, keyboard, and pointer input.
    let browserStep = operations.length;
    for (const seed of [4103, 7919, 12011, 19301, 27581]) {
      const random = mulberry32(seed);
      for (let seedStep = 0; seedStep < 40; seedStep += 1) {
        browserStep += 1;
        const format: Format = random() < 0.5 ? 'italic' : 'bold';
        const start = Math.floor(random() * (TEXT.length - 1));
        const end = start + 1 + Math.floor(random() * Math.min(18, TEXT.length - start));
        await selectRange(editor, start, end, seedStep % 2 === 0);
        const next = !expected[format][start];
        if (random() < 0.5) {
          const key = format === 'italic' ? 'i' : 'b';
          await editor.chord(key, `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), MOD);
        } else {
          const label = format === 'italic'
            ? 'Italic (Cmd/Ctrl+I)' : 'Bold (Cmd/Ctrl+B)';
          await editor.click(`${PANEL} button[aria-label="${label}"]`,
            `${label} for seed ${seed}, step ${seedStep + 1}`);
        }
        expected[format].fill(next, start, end);
        const state = await readState(editor, format);
        expect(state.text, `visible text changed for seed ${seed}, step ${seedStep + 1}`).toBe(authoredText);
        expect(state.selected, `selection drifted for seed ${seed}, step ${seedStep + 1}`)
          .toBe(TEXT.slice(start, end));
        expect(state.map, `format scope drifted for seed ${seed}, step ${seedStep + 1}`)
          .toEqual(expected[format]);
        expect(state.editing, `editing stopped at browser step ${browserStep}`).toBe(true);
      }
    }

    const spanCount = await editor.evaluate<number>(
      `document.querySelector('${CONTENT}').querySelectorAll('span').length`,
    );
    expect(spanCount, 'formatting wrappers grew without normalization')
      .toBeLessThan(TEXT.length * 2);

    const persisted = await eventually(async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      return response.json() as Promise<{ slides: Array<{ elements: Array<{ id: string; html?: string }> }> }>;
    }, 'final formatted text did not persist', (value) =>
      value.slides[0].elements.find((element) => element.id === TEXT_ID)?.html?.length !== 0);
    const html = persisted.slides[0].elements.find((element) => element.id === TEXT_ID)!.html!;
    const parsed = html.replace(/<[^>]+>/g, '');
    expect(parsed).toBe(authoredText);
  }, 90_000);
});

describe.skipIf(electronBinary)('stateful inline formatting in Chromium (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});

async function selectRange(
  cdp: Cdp,
  start: number,
  end: number,
  preferNextStart: boolean,
): Promise<void> {
  const selected = await cdp.evaluate<string>(`(() => {
    const root = document.querySelector('${CONTENT}');
    const locate = (target, preferNext) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let remaining = target;
      let previous = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (remaining < node.data.length || (remaining === node.data.length && !preferNext)) {
          return { node, offset: remaining };
        }
        remaining -= node.data.length;
        previous = node;
      }
      return { node: previous, offset: previous.data.length };
    };
    const a = locate(${start}, ${preferNextStart});
    const b = locate(${end}, false);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    root.focus();
    document.dispatchEvent(new Event('selectionchange'));
    return selection.toString();
  })()`);
  expect(selected).toBe(TEXT.slice(start, end));
}

async function readState(cdp: Cdp, format: Format): Promise<{
  text: string; selected: string; map: boolean[]; editing: boolean;
}> {
  return cdp.evaluate(`(() => {
    const root = document.querySelector('${CONTENT}');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const map = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      const style = getComputedStyle(parent);
      const active = ${JSON.stringify(format)} === 'italic'
        ? style.fontStyle === 'italic'
        : (style.fontWeight === 'bold' || Number.parseInt(style.fontWeight, 10) >= 600);
      const authored = node.data.replaceAll('\u2060', '');
      for (let index = 0; index < authored.length; index += 1) map.push(active);
    }
    return {
      text: root.textContent.replaceAll('\u2060', ''),
      selected: getSelection()?.toString() ?? '',
      map,
      editing: root.isContentEditable === true,
    };
  })()`);
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
