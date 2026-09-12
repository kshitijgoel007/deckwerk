import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { electronBinary } from './support/browserSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';

/**
 * Where the caret lands when a click opens a text edit — in the WEB client.
 *
 * The twin of test/caretOnEnterTextEditBrowser.test.ts, which drives the
 * desktop shell. The browser collaboration client shares the canvas but runs
 * it with live text sync on, inside the production Vite build served by the
 * real headless server; the caret reconstruction from the click point has to
 * hold there just the same. Every way that reconstruction can fail parks the
 * freshly focused contenteditable at offset 0, the whole box away from where
 * the author clicked.
 *
 * The gestures here are the real ones: CDP mouse input over measured glyph
 * boxes, through the shipped web client.
 */
const DECK_ID = 'caret-on-enter';
const TEXT_ID = 'caret-text';
const NODE = `#canvas [data-element-id="${TEXT_ID}"]`;
const CONTENT = `${NODE} .text-content`;
// One list and one paragraph: `body.textContent` runs the blocks together
// with no separator ("foxtrot" is immediately followed by "golf"), which is
// where a word scan can walk out of the block that was clicked.
const HTML = '<ul><li>alpha bravo charlie</li><li>delta <b>echo</b> foxtrot</li></ul>'
  + '<p>golf hotel india juliett</p>';

let session: WebEditorSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

/** The same single-text fixture launchDesktopEditor builds, served by the collab server. */
function launchCaretFixture(): Promise<WebEditorSession> {
  const deck = emptyDeck('Caret on enter');
  deck.slides[0].elements.push({
    id: TEXT_ID,
    type: 'text',
    x: 140,
    y: 150,
    w: 1640,
    h: 500,
    rot: 0,
    z: 1,
    opacity: 1,
    class: ['role-body'],
    style: {},
    html: HTML,
    align: 'left',
    valign: 'top',
  } as never);
  return launchWebEditor([{
    id: DECK_ID,
    deck,
    themeCss: [
      '.slide { background: #fff; color: #111827; }',
      '.role-body { font: 400 42px/1.35 Arial, sans-serif; }',
      '',
    ].join('\n'),
  }], {
    userName: 'Caret Tester',
    readyWhen: `Boolean(document.querySelector(${JSON.stringify(CONTENT)}))`,
    tmpPrefix: 'collab-caret-on-enter-',
  });
}

interface Caret { editing: boolean; start: number; end: number; error?: string }

/** Flat text offsets of the live selection inside the edited body. */
const CARET = `(() => {
  const body = document.querySelector(${JSON.stringify(CONTENT)});
  const selection = window.getSelection();
  if (!body) return { error: 'the text box is not rendered' };
  if (!selection || selection.rangeCount === 0) return { error: 'there is no selection' };
  const range = selection.getRangeAt(0);
  if (!body.contains(range.commonAncestorContainer)) {
    return { error: 'the selection is outside the text box' };
  }
  const measure = (node, offset) => {
    const probe = document.createRange();
    probe.setStart(body, 0);
    probe.setEnd(node, offset);
    return probe.toString().length;
  };
  return {
    editing: Boolean(document.querySelector('#canvas .editing')),
    start: measure(range.startContainer, range.startOffset),
    end: measure(range.endContainer, range.endOffset),
  };
})()`;

describe.skipIf(!electronBinary)('caret placement when a click opens a text edit (web client)', () => {
  it('takes the clicked word, and never falls back to the start of the box', {
    timeout: 420_000,
  }, async () => {
    session = await launchCaretFixture();
    const cdp = session.cdp;
    const text = await cdp.evaluate<string>(
      `document.querySelector(${JSON.stringify(CONTENT)}).textContent`);

    /** Leave the box unselected: the plain "double-click a text box" state. */
    const deselect = async () => {
      await cdp.key('Escape', 27);
      const spot = await cdp.evaluate<{ x: number; y: number }>(`(() => {
        const rect = document.querySelector('#canvas .slide').getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.bottom - 8 };
      })()`);
      await cdp.clickAt(spot.x, spot.y);
      expect(
        await cdp.evaluate<number>(`document.querySelectorAll('#canvas .handle').length`),
        'the fixture must start each gesture with nothing selected',
      ).toBe(0);
    };

    // A double-click on a word selects that word. Chromium dispatches no
    // dblclick for the gesture that opens the box — the pointerup that opened
    // it replaced the markup the first click hit — so the canvas has to
    // recognise the second click itself.
    for (const word of ['echo', 'foxtrot', 'juliett']) {
      const at = text.indexOf(word);
      expect(at, `fixture contains "${word}"`).toBeGreaterThanOrEqual(0);
      await deselect();
      await cdp.doubleClickTextAtOffset(CONTENT, at + 1, `the word "${word}"`);
      const caret = await cdp.evaluate<Caret>(CARET);
      expect(caret.error, `a selection exists after double-clicking "${word}"`).toBeUndefined();
      expect(caret.editing, `double-clicking "${word}" entered text editing`).toBe(true);
      // "foxtrot" ends its list item and "golf" opens the next paragraph with
      // no separator between them in textContent; the word must not span both.
      expect(
        caret,
        `double-clicking "${word}" must select exactly that word — not collapse `
        + 'to the start of the box, and not run into the next block',
      ).toMatchObject({ start: at, end: at + word.length });
    }

    // The blank area a text box keeps below its last line belongs to the box
    // but to no glyph. Chromium answers with the wrapper element there, and
    // having no text position to install is what sent the caret to offset 0.
    const blank = await cdp.evaluate<{ x: number; y: number; hit: string }>(`(() => {
      const node = document.querySelector(${JSON.stringify(NODE)});
      const body = document.querySelector(${JSON.stringify(CONTENT)});
      const outer = node.getBoundingClientRect();
      const inner = body.getBoundingClientRect();
      const x = outer.left + outer.width * 0.6;
      const y = Math.min(outer.bottom - 6, inner.bottom + 40);
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: hit ? hit.className : 'nothing' };
    })()`);
    expect(blank.hit, 'the probe point is inside the box but off the text').toContain('text-body');

    // Two separate clicks — select the box, then open it — so this measures
    // the caret alone, with no double-click word selection on top.
    await deselect();
    await cdp.clickAt(blank.x, blank.y);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await cdp.clickAt(blank.x, blank.y);
    const afterBlank = await cdp.evaluate<Caret>(CARET);
    expect(afterBlank.error, 'clicking the blank area opened an edit with a caret').toBeUndefined();
    expect(
      afterBlank,
      'a caret placed in the blank area below the text belongs to the nearest '
      + 'line — the end of the last one — not to the start of the box',
    ).toMatchObject({ editing: true, start: text.length, end: text.length });

    // Double-clicking the same blank area takes the nearest word, so the two
    // halves of the gesture agree about which line the click belongs to.
    await deselect();
    const lastWord = 'juliett';
    await cdp.clickAt(blank.x, blank.y);
    await cdp.clickAt(blank.x, blank.y);
    expect(
      await cdp.evaluate<Caret>(CARET),
      'a double-click in the blank area takes the nearest word',
    ).toMatchObject({
      editing: true,
      start: text.length - lastWord.length,
      end: text.length,
    });
  });
});

describe.skipIf(electronBinary)('caret placement when a click opens a text edit (web client, skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
