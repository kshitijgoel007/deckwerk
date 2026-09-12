import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COLLAB_PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
  type ServerWelcomeMessage,
} from '../src/shared/collab.js';
import { emptyDeck } from '../src/shared/deck.js';
import { electronBinary, eventually } from './support/browserSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';

/**
 * The web-client twin of `agentPresentationSync.test.ts`.
 *
 * In the browser the editor is itself a collaboration peer and Present mounts
 * `present.html` in an iframe over the editor tab, seeded from the deck the
 * tab already holds. What has to hold is that an Agent edit which arrives
 * over the collaboration protocol (or through the HTTP Agent surface) is what
 * the audience sees the moment Present is clicked — not the deck the tab
 * loaded with.
 *
 * FakeAgent is the deterministic peer from the desktop suite, speaking the
 * real localhost protocol to the real server; no model, login, or network.
 */

const DECK_ID = 'agent-present-sync';
const MARKER = 'FAKE AGENT PRESENTS THIS';
const MARKER_ID = 'fake-agent-marker';
const THEME_CSS = [
  '.slide { background: #fff; color: #111; }',
  '.element-text { font: 700 72px/1.1 sans-serif; }',
  '',
].join('\n');

class FakeAgent {
  private queue: ServerMessage[] = [];
  private waiters: Array<(message: ServerMessage) => void> = [];

  private constructor(private socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = ServerMessageSchema.parse(JSON.parse(String(raw)));
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  static async connect(wsUrl: string): Promise<{ agent: FakeAgent; welcome: ServerWelcomeMessage }> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const agent = new FakeAgent(socket);
    agent.send({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name: 'Fake Agent' });
    // Opening the room reads the deck and its history off disk; on a loaded
    // machine (the rest of the suite, a second Electron app) that can take
    // longer than the per-message default.
    const welcome = await agent.nextOfKind('welcome', 20_000);
    return { agent, welcome };
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  async nextOfKind<K extends ServerMessage['kind']>(kind: K, timeoutMs = 5_000):
    Promise<Extract<ServerMessage, { kind: K }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for Agent ${kind} message`);
      const message = await this.next(remaining);
      if (message.kind === kind) return message as Extract<ServerMessage, { kind: K }>;
    }
  }

  close(): void {
    this.socket.close();
  }

  private next(timeoutMs: number): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for Agent message')), timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }
}

/** What the audience iframe is showing, read through the editor tab. */
interface AudienceReading {
  markerText: string | null;
  elementCount: number;
  slideId: string | null;
  width: number;
  height: number;
  source: string | null;
}

const AUDIENCE_PROBE = `(() => {
  const frame = document.querySelector('iframe[src*="present.html"]');
  const doc = frame && frame.contentDocument;
  if (!doc || !doc.querySelector('.slide')) return null;
  const element = doc.querySelector('[data-element-id=${JSON.stringify(MARKER_ID)}]');
  const rect = element?.getBoundingClientRect();
  return {
    markerText: element?.textContent ?? null,
    elementCount: doc.querySelectorAll('[data-element-id]').length,
    slideId: doc.querySelector('.slide')?.getAttribute('data-slide-id') ?? null,
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
    source: doc.documentElement?.dataset?.presentSource ?? null
  };
})()`;

const EDITOR_SHOWS_MARKER = `document.querySelector('#canvas [data-element-id=${JSON.stringify(MARKER_ID)}]')`
  + `?.textContent?.includes(${JSON.stringify(MARKER)}) === true`;

const OVERLAY_OPEN = `Boolean(document.querySelector('iframe[src*="present.html"]'))`;

let session: WebEditorSession | null = null;
let fakeAgent: FakeAgent | null = null;

afterEach(async () => {
  fakeAgent?.close();
  fakeAgent = null;
  await session?.close();
  session = null;
});

/** Click the real Present button and wait until the audience paints the marker. */
async function presentAndReadAudience(active: WebEditorSession): Promise<AudienceReading> {
  await active.cdp.clickByText('#toolbar button', 'Present', 'Present');
  return eventually(
    async () => active.cdp.evaluate<AudienceReading | null>(AUDIENCE_PROBE),
    'the audience did not render the Agent edit',
    (value) => value !== null && value.markerText?.includes(MARKER) === true
      && value.width > 0 && value.height > 0,
    30_000,
  ) as Promise<AudienceReading>;
}

/**
 * End the embedded show and wait for the overlay to unmount. A double-click on
 * the audience surface exits an embedded presentation (present.ts); Escape
 * would too, but DevTools key events sent to the editor tab never reach the
 * focused iframe, so the pointer is the gesture the harness can deliver.
 */
async function endPresentation(active: WebEditorSession): Promise<void> {
  await active.cdp.doubleClick('iframe[src*="present.html"]', 'the presentation');
  await eventually(
    async () => active.cdp.evaluate<boolean>(OVERLAY_OPEN),
    'the presentation overlay did not close',
    (open) => !open,
  );
}

describe.skipIf(!electronBinary)('web Agent presentation synchronization', () => {
  it('presents a fake Agent collaboration edit in the embedded audience view', async () => {
    session = await launchWebEditor(
      [{ id: DECK_ID, deck: emptyDeck('Agent presentation regression'), themeCss: THEME_CSS }],
      { tmpPrefix: 'web-agent-present-sync-' },
    );
    const { cdp, port } = session;
    expect((await session.fetchDeck()).slides[0].id).toBe('slide-1');

    // The web editor is already a collaboration peer; the Agent joins the same
    // room over the same WebSocket the tab uses.
    const connected = await FakeAgent.connect(`ws://127.0.0.1:${port}/ws?deck=${encodeURIComponent(DECK_ID)}`);
    fakeAgent = connected.agent;

    const txnId = 'fake-agent-presentation-edit';
    fakeAgent.send({
      kind: 'txn',
      txnId,
      baseSeq: connected.welcome.seq,
      label: 'Fake Agent: add presentation marker',
      ops: [{
        op: 'insertElements',
        slideId: 'slide-1',
        elements: [{
          id: MARKER_ID,
          type: 'text',
          x: 180,
          y: 400,
          w: 1560,
          h: 200,
          rot: 0,
          z: 0,
          opacity: 1,
          class: [],
          style: {},
          html: MARKER,
          align: 'center',
          valign: 'middle',
        }],
      }],
    });
    const echoed = await fakeAgent.nextOfKind('txn');
    expect(echoed.txnId).toBe(txnId);

    // The editor peer applies the transaction; Present must then be seeded
    // from that state, not from the deck the tab loaded with.
    await eventually(
      async () => cdp.evaluate<boolean>(EDITOR_SHOWS_MARKER),
      'the web editor did not receive the fake Agent transaction',
      Boolean,
      30_000,
    );
    await eventually(
      async () => (await session!.fetchDeck()).slides[0].elements.some((element) => element.id === MARKER_ID),
      'the server deck did not record the fake Agent transaction',
    );

    const rendered = await presentAndReadAudience(session);
    expect(rendered).toMatchObject({
      markerText: MARKER,
      elementCount: 1,
      slideId: 'slide-1',
    });

    fakeAgent.close();
    fakeAgent = null;
    await endPresentation(session);
  }, 120_000);

  it('presents an edit made through the HTTP Agent surface (/api/apply-edits)', async () => {
    // The HTTP surface patches existing objects (element, slide, deck) and has
    // no insertion form, so the marker element exists up front with
    // placeholder text and the Agent rewrites its `html`.
    const deck = emptyDeck('Agent presentation regression');
    deck.slides[0].elements.push({
      id: MARKER_ID,
      type: 'text',
      x: 180,
      y: 400,
      w: 1560,
      h: 200,
      rot: 0,
      z: 0,
      opacity: 1,
      class: [],
      style: {},
      html: 'PLACEHOLDER BEFORE THE AGENT',
      align: 'center',
      valign: 'middle',
    });
    session = await launchWebEditor(
      [{ id: DECK_ID, deck, themeCss: THEME_CSS }],
      { tmpPrefix: 'web-agent-present-http-' },
    );
    const { cdp, origin } = session;
    const deckQuery = `deck=${encodeURIComponent(DECK_ID)}`;

    // The contract the Agent reads before editing must document what it uses.
    const schema = await (await fetch(`${origin}/api/edit-schema`)).json() as {
      element: { byType: { text: Array<{ path: string }> } };
    };
    expect(schema.element.byType.text.map((property) => property.path)).toContain('html');

    const previewResponse = await fetch(`${origin}/api/preview-edits?${deckQuery}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        edits: [{
          target: 'element',
          slideId: 'slide-1',
          elementId: MARKER_ID,
          expectedType: 'text',
          set: { html: MARKER },
          unset: [],
        }],
      }),
    });
    expect(previewResponse.status, await previewResponse.clone().text()).toBe(200);
    const draft = await previewResponse.json() as {
      draftId: string; revision: string; affectedElementIds: string[];
    };
    expect(draft.affectedElementIds).toEqual([MARKER_ID]);

    const applyResponse = await fetch(`${origin}/api/apply-edits?${deckQuery}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: draft.draftId,
        expectedRevision: draft.revision,
        idempotencyKey: 'fake-agent-http-presentation-edit',
        label: 'Fake Agent (HTTP): set presentation marker',
      }),
    });
    expect(applyResponse.status, await applyResponse.clone().text()).toBe(200);
    expect(await applyResponse.json()).toMatchObject({
      idempotent: false,
      slideIds: ['slide-1'],
      elementIds: [MARKER_ID],
    });

    await eventually(
      async () => cdp.evaluate<boolean>(EDITOR_SHOWS_MARKER),
      'the web editor did not receive the HTTP Agent edit',
      Boolean,
      30_000,
    );
    await eventually(
      async () => (await session!.fetchDeck()).slides[0].elements
        .some((element) => element.id === MARKER_ID && element.type === 'text' && element.html === MARKER),
      'the server deck did not record the HTTP Agent edit',
    );

    const rendered = await presentAndReadAudience(session);
    expect(rendered).toMatchObject({
      markerText: MARKER,
      elementCount: 1,
      slideId: 'slide-1',
    });
    expect(rendered.markerText).not.toContain('PLACEHOLDER');

    await endPresentation(session);
  }, 120_000);
});

describe.skipIf(electronBinary)('web Agent presentation synchronization (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBe('');
  });
});
