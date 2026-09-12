import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import { Cdp, electronBinary, eventually } from './support/browserSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';

/**
 * The speaker notes drawer in the WEB client, driven the way a person drives
 * it: real mouse presses over the production browser build served by the real
 * collaboration server, real keystrokes, and the result read back from the
 * deck the server holds.
 *
 * This is the twin of `speakerNotesDesktopBrowser.test.ts`. What differs is
 * where a note has to end up. The web client has no notes.md and no disk:
 * persistence is the server, so durability is `GET /api/deck`. And where the
 * desktop suite proves an external notes.md edit flows back into the drawer,
 * this one proves the collaboration equivalent — a peer in a second tab types
 * a note and the first tab's drawer shows it.
 *
 * Nothing here calls `.click()` or `.focus()` on a node; page-side
 * evaluations only read state.
 */

const DECK_ID = 'web-notes';
const TOGGLE = '#canvas .notes-toggle';
const DRAWER = '#canvas .notes-drawer';
const TEXT = '#canvas .notes-drawer-text';
const HANDLE = '#canvas .notes-drawer .panel-resize-top';
const CLOSE = '#canvas .notes-drawer-close';
/** A non-focusable header label: clicking it is how a person leaves the field without closing the drawer. */
const TITLE = '#canvas .notes-drawer-title';
const PEER_NAME = 'Second Tab';
const MOD = process.platform === 'darwin' ? 4 : 2;

let session: WebEditorSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

describe.skipIf(!electronBinary)('speaker notes drawer in the web client', () => {
  it('opens on click, takes typed notes to the server, resizes by drag, follows a peer, and closes', {
    retry: 2,
    timeout: 120_000,
  }, async () => {
    // Two slides, the second already annotated — the same fixture the
    // desktop suite opens.
    const base = emptyDeck('Web notes');
    const deck: Deck = parseDeck({
      ...base,
      slides: [
        { ...base.slides[0], id: 's1', name: 'First' },
        { ...base.slides[0], id: 's2', name: 'Second', notes: 'Already here.' },
      ],
    });
    session = await launchWebEditor([{ id: DECK_ID, deck }], {
      tmpPrefix: 'deckwerk-web-notes-',
      readyWhen: `Boolean(document.querySelector('#canvas .slide'))
        && document.querySelector(${JSON.stringify(TOGGLE)})?.getBoundingClientRect().width > 0
        && document.querySelector('#rail .rail-item[data-slide-id="s2"]')?.getBoundingClientRect().width > 0`,
    });
    const editor = session.cdp;

    // The server holds the fixture as seeded.
    const seeded = await session.fetchDeck();
    expect(seeded.slides.map((slide) => slide.notes ?? '')).toEqual(['', 'Already here.']);

    // The drawer is closed until the floating button is pressed.
    expect(await editor.evaluate<boolean>(`document.querySelector(${JSON.stringify(DRAWER)}).hidden`)).toBe(true);
    const slideBefore = await stageRect(editor);

    await editor.click(TOGGLE, 'speaker notes toggle');
    await eventually(
      () => editor.evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(DRAWER)})).display`),
      'drawer did not open on click',
      (display) => display === 'flex',
    );
    // The slide made room: its bottom sits above the drawer.
    const slideOpen = await eventually(
      () => stageRect(editor),
      'slide did not move clear of the drawer',
      (rect) => rect.bottom <= slideBefore.bottom - 60,
    );
    expect(slideOpen.bottom).toBeLessThanOrEqual(await drawerTop(editor) + 1);

    // A click puts the caret in the field; keystrokes become the slide's
    // note. The drawer edits in one transaction per visit to the field (focus
    // to blur — one undo step), and the collaboration bridge sends a
    // transaction when it ends, so the note reaches the server once the
    // author leaves the field.
    await editor.evaluate('document.activeElement && document.activeElement.blur()');
    await editor.click(TEXT, 'speaker notes text');
    await eventually(
      () => editor.evaluate<string>('document.activeElement.className'),
      'click did not focus the notes field',
      (className) => className.includes('notes-drawer-text'),
    );
    await editor.typeKeys('Open with the story');
    await eventually(
      () => editor.evaluate<string>(`document.querySelector(${JSON.stringify(TEXT)}).value`),
      'typed text did not appear in the field',
      (value) => value === 'Open with the story',
    );
    await eventually(
      () => editor.evaluate<string>('window.store.get().deck.slides[0].notes ?? ""'),
      'typed note did not reach the store',
      (value) => value === 'Open with the story',
    );
    await editor.click(TITLE, 'drawer header, to leave the field');
    await eventually(
      () => editor.evaluate<string>('document.activeElement.className'),
      'clicking the header did not leave the notes field',
      (className) => !className.includes('notes-drawer-text'),
    );
    await eventually(
      () => session!.fetchDeck(),
      'typed note did not reach the server',
      (saved) => saved.slides[0].notes === 'Open with the story' && saved.slides[1].notes === 'Already here.',
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
      () => editor.evaluate<number>(
        `document.querySelector(${JSON.stringify(DRAWER)}).getBoundingClientRect().height`,
      ),
      'drag did not resize the drawer',
      (height) => height > 280,
    );
    expect(heightAfterDrag).toBeGreaterThan(280);
    const grownTop = await drawerTop(editor);
    await eventually(
      () => stageRect(editor),
      'slide did not refit after the drawer grew',
      (rect) => rect.bottom <= grownTop + 1 && rect.bottom < slideOpen.bottom,
    );

    // The rail selects the second slide; the field follows it.
    await editor.click('#rail .rail-item[data-slide-id="s2"]', 'second slide');
    await eventually(
      () => editor.evaluate<string>(`document.querySelector(${JSON.stringify(TEXT)}).value`),
      'field did not follow the slide selection',
      (value) => value === 'Already here.',
    );

    // A peer in a second tab of the same deck rewrites that slide's note; the
    // first tab's drawer follows the remote edit. (The web twin of a hand
    // edit to notes.md landing in the desktop drawer.)
    const peerUrl = `${session.origin}/?deck=${encodeURIComponent(DECK_ID)}&name=${encodeURIComponent(PEER_NAME)}`;
    expect(await editor.evaluate<boolean>(
      `Boolean(window.open(${JSON.stringify(peerUrl)}, 'peer'))`,
    )).toBe(true);
    const peer = await session.connectTarget(
      (target) => target.url.includes(`name=${encodeURIComponent(PEER_NAME)}`),
      'second editor tab',
    );
    await eventually(async () => peer.evaluate<boolean>(`(() => (
      document.getElementById('status')?.textContent?.includes(${JSON.stringify(`connected as ${PEER_NAME}`)}) === true
      && Boolean(document.querySelector('#canvas .slide'))
      && document.querySelector('#rail .rail-item[data-slide-id="s2"]')?.getBoundingClientRect().width > 0
    ))()`), 'the second tab did not finish connecting');
    await peer.call('Page.bringToFront');
    await peer.evaluate('window.focus()');
    await peer.click('#rail .rail-item[data-slide-id="s2"]', 'second slide in the peer tab');
    await peer.click(TOGGLE, 'speaker notes toggle in the peer tab');
    await eventually(
      () => peer.evaluate<string>(`document.querySelector(${JSON.stringify(TEXT)}).value`),
      'the peer drawer did not show the second slide’s note',
      (value) => value === 'Already here.',
    );
    await peer.evaluate('document.activeElement && document.activeElement.blur()');
    await peer.click(TEXT, 'speaker notes text in the peer tab');
    await eventually(
      () => peer.evaluate<string>('document.activeElement.className'),
      'click did not focus the peer notes field',
      (className) => className.includes('notes-drawer-text'),
    );
    await peer.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    await peer.typeKeys('Rewritten by a peer.');
    await eventually(
      () => peer.evaluate<string>(`document.querySelector(${JSON.stringify(TEXT)}).value`),
      'peer typing did not replace the note',
      (value) => value === 'Rewritten by a peer.',
    );
    await peer.click(TITLE, 'peer drawer header, to leave the field');
    await eventually(
      () => session!.fetchDeck(),
      'peer note did not reach the server',
      (saved) => saved.slides[1].notes === 'Rewritten by a peer.' && saved.slides[0].notes === 'Open with the story',
    );
    await eventually(
      () => editor.evaluate<string>(`document.querySelector(${JSON.stringify(TEXT)}).value`),
      'peer edit did not reach the first tab’s drawer',
      (value) => value === 'Rewritten by a peer.',
    );

    // Back to the first tab: close from the header button; the slide takes
    // the room back.
    await editor.call('Page.bringToFront');
    await editor.evaluate('window.focus()');
    await editor.click(CLOSE, 'close speaker notes');
    await eventually(
      () => editor.evaluate<boolean>(`document.querySelector(${JSON.stringify(DRAWER)}).hidden`),
      'drawer did not close',
    );
    await eventually(
      () => stageRect(editor),
      'slide did not take the room back after closing',
      (rect) => Math.abs(rect.bottom - slideBefore.bottom) < 2 && Math.abs(rect.height - slideBefore.height) < 2,
    );

    // And the toggle opens it again at the dragged height.
    await editor.click(TOGGLE, 'speaker notes toggle again');
    const reopened = await eventually(
      () => editor.evaluate<number>(
        `document.querySelector(${JSON.stringify(DRAWER)}).hidden ? 0
          : document.querySelector(${JSON.stringify(DRAWER)}).getBoundingClientRect().height`,
      ),
      'toggle did not reopen the drawer',
      (height) => height > 280,
    );
    expect(reopened).toBeCloseTo(heightAfterDrag, 0);
  });
});

describe.skipIf(electronBinary)('speaker notes drawer in the web client (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
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
