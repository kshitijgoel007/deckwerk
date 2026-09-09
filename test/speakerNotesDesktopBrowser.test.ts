import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  stopBrowser,
} from './support/browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

/**
 * The speaker notes drawer, driven the way a person drives it: real mouse
 * presses over the production desktop app, real keystrokes, and the result
 * read back from disk.
 *
 * This exists because the drawer once passed every jsdom test and did nothing
 * when clicked: the canvas captured the pointer on every press inside its host,
 * which changed the pointer-up target and suppressed the click on the toggle
 * and the focus on the text field. Only a genuine pointer gesture over a laid
 * out page can catch that class of bug, so nothing here calls `.click()` or
 * `.focus()` on a node.
 */

const TOGGLE = '#canvas .notes-toggle';
const DRAWER = '#canvas .notes-drawer';
const TEXT = '#canvas .notes-drawer-text';
const HANDLE = '#canvas .notes-drawer .panel-resize-top';

let workDir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(appProcess);
  appProcess = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!electronBinary)('speaker notes drawer in the desktop app', () => {
  it('opens on click, takes typed notes to disk, resizes by drag, follows notes.md, and closes', {
    retry: 2,
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-desktop-notes-'));
    const appDir = join(workDir, 'app');
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    await materializeDesktopApp(appDir, 'deckwerk-notes-test');

    // Two slides, the second already annotated, and — deliberately — no
    // notes.md: a deck saved before notes existed has to open all the same.
    const base = emptyDeck('Desktop notes');
    const deck: Deck = parseDeck({
      ...base,
      slides: [
        { ...base.slides[0], id: 's1', name: 'First' },
        { ...base.slides[0], id: 's2', name: 'Second', notes: 'Already here.' },
      ],
    });
    await saveDeck(deckDir, deck);
    await rm(join(deckDir, 'notes.md'), { force: true });

    const app = await launchDesktopApp(appDir, [deckDir], { profileDir });
    appProcess = app.process;
    const debugPort = app.debugPort;
    const appLog = app.log;
    const target = await findTarget(
      debugPort,
      isEditorTarget,
      appLog,
      20_000,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`window.api.getDeck().then(
      (session) => session?.dir === ${JSON.stringify(deckDir)}
        && Boolean(document.querySelector('#canvas .slide'))
        && !document.body.classList.contains('welcome-mode')
        && document.querySelector(${JSON.stringify(TOGGLE)})?.getBoundingClientRect().width > 0
    )`), 'desktop editor did not open the notes fixture');
    await editor.call('Page.bringToFront');
    await editor.evaluate('window.focus()');

    // Opening the deck wrote the file it did not have.
    const created = await eventually(
      () => readFile(join(deckDir, 'notes.md'), 'utf8').catch(() => ''),
      'notes.md was not written on open',
    );
    expect(created).toContain('<!-- slide: s1 -->');
    expect(created).toContain('Already here.');

    // The drawer is closed until the floating button is pressed.
    expect(await editor.evaluate<boolean>(`document.querySelector(${JSON.stringify(DRAWER)}).hidden`)).toBe(true);
    const slideBefore = await stageRect(editor);

    await editor.click(TOGGLE, 'speaker notes toggle');
    await eventually(
      () => editor!.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(DRAWER)})).display`),
      'drawer did not open on click',
      (display) => display === 'flex',
    );
    // The slide made room: its bottom sits above the drawer. (In a wide window
    // the fit is width-limited, so the slide moves up rather than shrinking.)
    const slideOpen = await eventually(
      () => stageRect(editor!),
      'slide did not move clear of the drawer',
      (rect) => rect.bottom <= slideBefore.bottom - 60,
    );
    expect(slideOpen.bottom).toBeLessThanOrEqual(await drawerTop(editor) + 1);

    // A click puts the caret in the field; keystrokes become the slide's note
    // and reach deck.json and notes.md through the ordinary autosave.
    await editor.evaluate('document.activeElement && document.activeElement.blur()');
    await editor.click(TEXT, 'speaker notes text');
    await eventually(
      () => editor!.evaluate<string>('document.activeElement.className'),
      'click did not focus the notes field',
      (className) => className.includes('notes-drawer-text'),
    );
    await editor.typeKeys('Open with the story');
    await eventually(
      () => editor!.evaluate<string>(`document.querySelector(${JSON.stringify(TEXT)}).value`),
      'typed text did not appear in the field',
      (value) => value === 'Open with the story',
    );
    await eventually(
      async () => JSON.parse(await readFile(join(deckDir, 'deck.json'), 'utf8')) as Deck,
      'typed note did not reach deck.json',
      (saved) => saved.slides[0].notes === 'Open with the story',
    );
    await eventually(
      () => readFile(join(deckDir, 'notes.md'), 'utf8'),
      'typed note did not reach notes.md',
      (markdown) => markdown.includes('<!-- slide: s1 -->\n\nOpen with the story\n'),
    );

    // Dragging the top edge makes the drawer taller and the slide smaller.
    const handle = await editor.evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector(${JSON.stringify(HANDLE)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const drag = await editor.beginDrag(handle.x, handle.y);
    await drag.moveTo(handle.x, handle.y - 60);
    await drag.moveTo(handle.x, handle.y - 120);
    await drag.drop();
    const heightAfterDrag = await eventually(
      () => editor!.evaluate<number>(
        `document.querySelector(${JSON.stringify(DRAWER)}).getBoundingClientRect().height`,
      ),
      'drag did not resize the drawer',
      (height) => height > 280,
    );
    expect(heightAfterDrag).toBeGreaterThan(280);
    const grownTop = await drawerTop(editor);
    await eventually(
      () => stageRect(editor!),
      'slide did not refit after the drawer grew',
      (rect) => rect.bottom <= grownTop + 1 && rect.bottom < slideOpen.bottom,
    );

    // The rail selects the second slide; the field follows it.
    await editor.click('#rail .rail-item[data-slide-id="s2"]', 'second slide');
    await eventually(
      () => editor!.evaluate<string>(`document.querySelector(${JSON.stringify(TEXT)}).value`),
      'field did not follow the slide selection',
      (value) => value === 'Already here.',
    );

    // A hand edit to notes.md lands on the slides and shows in the field.
    const onDisk = await readFile(join(deckDir, 'notes.md'), 'utf8');
    await writeFile(join(deckDir, 'notes.md'), onDisk.replace('Already here.', 'Rewritten outside.'), 'utf8');
    await eventually(
      () => editor!.evaluate<string>(`document.querySelector(${JSON.stringify(TEXT)}).value`),
      'external notes.md edit did not reach the drawer',
      (value) => value === 'Rewritten outside.',
    );
    await eventually(
      async () => JSON.parse(await readFile(join(deckDir, 'deck.json'), 'utf8')) as Deck,
      'external notes.md edit did not reach deck.json',
      (saved) => saved.slides[1].notes === 'Rewritten outside.' && saved.slides[0].notes === 'Open with the story',
    );

    // Close from the header button; the slide takes the room back.
    await editor.click('#canvas .notes-drawer-close', 'close speaker notes');
    await eventually(
      () => editor!.evaluate<boolean>(`document.querySelector(${JSON.stringify(DRAWER)}).hidden`),
      'drawer did not close',
    );
    await eventually(
      () => stageRect(editor!),
      'slide did not take the room back after closing',
      (rect) => Math.abs(rect.bottom - slideBefore.bottom) < 2 && Math.abs(rect.height - slideBefore.height) < 2,
    );

    // And the toggle opens it again at the dragged height.
    await editor.click(TOGGLE, 'speaker notes toggle again');
    const reopened = await eventually(
      () => editor!.evaluate<number>(
        `document.querySelector(${JSON.stringify(DRAWER)}).hidden ? 0
          : document.querySelector(${JSON.stringify(DRAWER)}).getBoundingClientRect().height`,
      ),
      'toggle did not reopen the drawer',
      (height) => height > 280,
    );
    expect(reopened).toBeCloseTo(heightAfterDrag, 0);
  });
});

async function drawerTop(cdp: Cdp): Promise<number> {
  return cdp.evaluate<number>(
    `document.querySelector(${JSON.stringify(DRAWER)}).getBoundingClientRect().top`,
  );
}

async function stageRect(cdp: Cdp): Promise<{ height: number; bottom: number }> {
  return cdp.evaluate<{ height: number; bottom: number }>(`(() => {
    const r = document.querySelector('#canvas .stage').getBoundingClientRect();
    return { height: r.height, bottom: r.bottom };
  })()`);
}
