import { afterAll, describe, expect, it } from 'vitest';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';

/**
 * Text durability in the WEB client while focus is parked on a panel control.
 *
 * The twin of the `unsealed-text durability (desktop shell)` block in
 * test/modeFocusBugs.test.ts. The desktop shell has no live text sync, so the
 * only routes typed text has into the store are sealTextChunk and
 * commitTextEdit — and a seal that refuses while `document.activeElement` is a
 * whitelisted inspector control leaves the word in the DOM alone. The web
 * client runs the same canvas with `liveTextSync` on: typing streams to the
 * store every 250ms, and the store streams to the collaboration server. So
 * the durability surface here is the SERVER deck (`session.fetchDeck()`),
 * which is what every peer, Present, and download would read — the web
 * equivalent of `deck.json` on disk.
 *
 * Real input only: CDP mouse and key events through the production client
 * build; page-side evaluations are read-only probes.
 */
const DECK_ID = 'text-durability';
const TEXT_ID = 'durability-text';
const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;
// The Geometry section's first number field is X (inspector.ts, geometrySection).
const X_INPUT = '#inspector .geometry-options .field-number input';

/** The same single-text fixture launchDesktopEditor builds, served by the collab server. */
function launchDurabilityFixture(): Promise<WebEditorSession> {
  const deck = emptyDeck('Mode focus durability');
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
    html: '<p>alpha bravo charlie</p>',
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
    userName: 'Durability Tester',
    readyWhen: `Boolean(document.querySelector(${JSON.stringify(CONTENT)}))`,
    tmpPrefix: 'collab-text-durability-',
  });
}

/** The html of the fixture text element as `deck` holds it. */
function htmlIn(deck: Deck): string {
  for (const slide of deck.slides) {
    for (const element of slide.elements) {
      if (element.id === TEXT_ID && element.type === 'text') return element.html;
    }
  }
  return '';
}

describe.skipIf(!electronBinary)('unsealed-text durability (web client)', () => {
  let session: WebEditorSession | null = null;

  afterAll(async () => {
    await session?.close();
    session = null;
  });

  // Desktop counterpart: sealTextChunk refused to commit while
  // document.activeElement was not the text body, so a run typed just before
  // focus moved to a whitelisted inspector control never reached the store.
  // On the web the live stream (250ms) and the idle seal (600ms) both commit
  // to the store, and the store is pushed to the server; the word must show
  // up in the server deck within a few seconds while the edit stays open.
  it('persists typed text to the store and the server while focus is parked on a panel control', {
    timeout: 420_000,
  }, async () => {
    session = await launchDurabilityFixture();
    const cdp = session.cdp;
    const fetchDeck = session.fetchDeck;
    const serverHtml = async () => htmlIn(await fetchDeck());
    const storeHtml = () => cdp.evaluate<string>(`(() => {
      for (const slide of window.store.get().deck.slides) {
        for (const element of slide.elements) {
          if (element.id === ${JSON.stringify(TEXT_ID)}) return element.html;
        }
      }
      return '';
    })()`);

    // Control: type with the caret staying in the box. Live sync (250ms) or
    // the idle seal (600ms) commits, the collab client pushes, and the word
    // reaches the server deck. This proves the read route before the
    // parked-focus assertion uses it.
    await cdp.doubleClickText(CONTENT, 'the text');
    await eventually(
      async () => cdp.evaluate<boolean>(`Boolean(document.querySelector('#canvas .editing'))`),
      'the double-click did not open a text edit',
    );
    await cdp.typeKeys('CTRLWORD');
    await eventually(
      serverHtml,
      'the control word never reached the server deck',
      (html) => html.includes('CTRLWORD'),
      30_000,
    );

    // The durability hole: type, then immediately move focus onto a
    // whitelisted inspector control (the geometry X field) before the 600ms
    // idle seal — and, on the web, before the 250ms live push — fires. The
    // edit session must stay alive (the whitelist), and the word must still
    // reach the store and the server.
    await cdp.typeKeys(' PARKWORD');
    await cdp.click(X_INPUT, 'inspector X field');
    await wait(100);
    const parked = await cdp.evaluate<{ active: string; editing: boolean; dom: string }>(`(() => ({
      active: document.activeElement
        ? document.activeElement.tagName + '.' + document.activeElement.className
        : 'none',
      editing: Boolean(document.querySelector('#canvas .editing')),
      dom: document.querySelector(${JSON.stringify(CONTENT)})?.textContent ?? '',
    }))()`);
    expect(parked.dom, 'the word is visible on the slide').toContain('PARKWORD');
    expect(parked.active, 'focus moved to the inspector X field').toMatch(/^INPUT/);
    expect(parked.editing, 'the whitelist kept the edit session alive').toBe(true);

    // Within a few seconds — well past the live push, the idle-seal window,
    // and the client-to-server round trip — the word is in the store...
    const store = await eventually(
      storeHtml,
      'text typed with focus parked on the X field never reached the store',
      (html) => html.includes('PARKWORD'),
      15_000,
    );
    expect(store, 'the store holds the parked word').toContain('PARKWORD');

    // ...and in the deck the server holds — what a peer, Present, and a
    // download would read — while the edit session is still open.
    const domNow = await cdp.evaluate<string>(
      `document.querySelector(${JSON.stringify(CONTENT)})?.textContent ?? ''`);
    expect(domNow, 'the slide still shows the word').toContain('PARKWORD');
    const server = await eventually(
      serverHtml,
      `text typed a few seconds ago is on the slide (${JSON.stringify(domNow.slice(0, 80))}) `
      + 'but the deck on the server does not contain it',
      (html) => html.includes('PARKWORD'),
      15_000,
    );
    expect(server, 'the server deck holds the parked word').toContain('PARKWORD');
    expect(
      await cdp.evaluate<boolean>(`Boolean(document.querySelector('#canvas .editing'))`),
      'the edit session is still alive after the word became durable',
    ).toBe(true);
  });
});

describe.skipIf(electronBinary)('unsealed-text durability (web client, skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
