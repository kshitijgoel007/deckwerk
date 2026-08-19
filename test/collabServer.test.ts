import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { COLLAB_PROTOCOL_VERSION, ServerMessageSchema, type ClientMessage, type ServerMessage } from '../src/shared/collab.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';

const DECK_ID = 'demo';

class TestClient {
  private socket: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: Array<(message: ServerMessage) => void> = [];

  constructor(port: number, deckId = DECK_ID) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws?deck=${encodeURIComponent(deckId)}`);
    this.socket.on('message', (raw) => {
      const message = ServerMessageSchema.parse(JSON.parse(String(raw)));
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  next(timeoutMs = 4000): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for server message')), timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  async nextOfKind<K extends ServerMessage['kind']>(kind: K, timeoutMs = 4000):
    Promise<Extract<ServerMessage, { kind: K }>> {
    for (;;) {
      const message = await this.next(timeoutMs);
      if (message.kind === kind) return message as Extract<ServerMessage, { kind: K }>;
    }
  }

  close(): void {
    this.socket.close();
  }
}

async function hello(client: TestClient, name?: string) {
  await client.open();
  client.send({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name });
  return client.nextOfKind('welcome');
}

describe('collab server', () => {
  let rootDir: string;
  let deckDir: string;
  let server: RunningCollabServer;
  let clients: TestClient[] = [];

  const connect = async (name?: string, deckId = DECK_ID) => {
    const client = new TestClient(server.port, deckId);
    clients.push(client);
    const welcome = await hello(client, name);
    return { client, welcome };
  };

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-root-'));
    deckDir = join(rootDir, DECK_ID);
    await mkdir(deckDir, { recursive: true });
    const deck: Deck = parseDeck({
      ...emptyDeck('Collab'),
      slides: [
        { id: 's1', name: 'One', elements: [{ id: 'e1', type: 'text', x: 0, y: 0, w: 100, h: 50, html: 'hi' }] },
        { id: 's2', name: 'Two' },
      ],
    });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '/* test theme */\n', 'utf8');
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients = [];
    await server.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('lists the decks in the hosted directory', async () => {
    const decks = await (await fetch(`http://127.0.0.1:${server.port}/api/decks`)).json() as
      Array<{ id: string; title: string; slides: number }>;
    expect(decks).toEqual([{ id: DECK_ID, title: 'Collab', slides: 2 }]);
  });

  it('returns a compact deck-wide transcript in reading order with neighboring slides', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const transcript = await (await fetch(`${base}/api/text?deck=${DECK_ID}`)).json() as any;
    expect(transcript).toMatchObject({
      deckId: DECK_ID,
      title: 'Collab',
      slides: [
        {
          index: 1, id: 's1', name: 'One', previousSlideId: null, nextSlideId: 's2', notes: '',
          text: [{ elementId: 'e1', elementType: 'text', text: 'hi' }],
        },
        {
          index: 2, id: 's2', name: 'Two', previousSlideId: 's1', nextSlideId: null, notes: '', text: [],
        },
      ],
    });
    expect(transcript.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('redirects normal agent sessions to the read-only real-player viewer', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${base}/?deck=${DECK_ID}&agent=1&name=Test`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/present.html?deck=${DECK_ID}&agent=1&name=Test&slide=1`);

    const debug = await fetch(`${base}/?deck=${DECK_ID}&agent=1&debug=1`, { redirect: 'manual' });
    expect(debug.status).not.toBe(302);
  });

  it('creates new decks inside the root and refuses duplicates', async () => {
    const created = await fetch(`http://127.0.0.1:${server.port}/api/decks?name=Fresh%20Deck`, { method: 'POST' });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ id: 'Fresh Deck' });
    const listed = await (await fetch(`http://127.0.0.1:${server.port}/api/decks`)).json() as Array<{ id: string }>;
    expect(listed.map((d) => d.id).sort()).toEqual([DECK_ID, 'Fresh Deck'].sort());

    const duplicate = await fetch(`http://127.0.0.1:${server.port}/api/decks?name=Fresh%20Deck`, { method: 'POST' });
    expect(duplicate.status).toBe(409);
    const escape = await fetch(`http://127.0.0.1:${server.port}/api/decks?name=..%2Fescape`, { method: 'POST' });
    const escapeBody = await escape.json() as { id?: string };
    // basename() strips the traversal; whatever id results must be a child of root.
    expect(escapeBody.id ?? '').not.toContain('..');
  });

  it('welcomes clients with deck, theme, seq, identity, and peers', async () => {
    const { welcome } = await connect('Alice');
    expect(welcome.deck.slides.map((slide) => slide.id)).toEqual(['s1', 's2']);
    expect(welcome.themeCss).toContain('test theme');
    expect(welcome.seq).toBe(0);
    expect(welcome.self.name).toBe('Alice');
    expect(welcome.peers).toEqual([]);

    const second = await connect();
    expect(second.welcome.peers).toHaveLength(1);
    expect(second.welcome.peers[0].name).toBe('Alice');
  });

  it('keeps rooms independent: a txn in one deck never reaches another', async () => {
    const otherDir = join(rootDir, 'other');
    await mkdir(otherDir, { recursive: true });
    await saveDeck(otherDir, parseDeck({ ...emptyDeck('Other'), slides: [{ id: 'o1' }] }));
    await writeFile(join(otherDir, 'theme.css'), '', 'utf8');

    const a = await connect('A');
    const b = await connect('B', 'other');
    a.client.send({
      kind: 'txn', txnId: 't1', baseSeq: 0, label: 'rename',
      ops: [{ op: 'updateDeck', title: 'Renamed' }],
    });
    await a.client.nextOfKind('txn');
    await expect(b.client.nextOfKind('txn', 400)).rejects.toThrow(/timed out/);
  });

  it('serializes transactions and broadcasts them to everyone including the sender', async () => {
    const a = await connect('A');
    const b = await connect('B');
    await a.client.nextOfKind('presence'); // B joined

    a.client.send({
      kind: 'txn', txnId: 't1', baseSeq: 0, label: 'Move e1',
      ops: [{ op: 'deleteElements', slideId: 's1', elementIds: ['e1'] }],
    });
    const gotA = await a.client.nextOfKind('txn');
    const gotB = await b.client.nextOfKind('txn');
    expect(gotA.seq).toBe(1);
    expect(gotA.txnId).toBe('t1');
    expect(gotB.byClientId).toBe(a.welcome.clientId);
  });

  it('assigns strictly increasing seqs under concurrent sends and persists the result', async () => {
    const a = await connect('A');
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      a.client.send({
        kind: 'txn', txnId: `t${i}`, baseSeq: 0, label: `txn ${i}`,
        ops: [{ op: 'updateDeck', title: `Title ${i}` }],
      });
    }
    for (let i = 0; i < 5; i++) seqs.push((await a.client.nextOfKind('txn')).seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);

    await new Promise((resolve) => setTimeout(resolve, 1100)); // outlast the save debounce
    const persisted = parseDeck(JSON.parse(await readFile(join(deckDir, 'deck.json'), 'utf8')));
    expect(persisted.title).toBe('Title 4');
  });

  it('confirms fully-skipped transactions so the sender can drain pending', async () => {
    const a = await connect('A');
    a.client.send({
      kind: 'txn', txnId: 'ghost', baseSeq: 0, label: 'Edit deleted element',
      ops: [{ op: 'deleteElements', slideId: 's1', elementIds: ['nonexistent'] }],
    });
    const txn = await a.client.nextOfKind('txn');
    expect(txn.txnId).toBe('ghost');
  });

  it('broadcasts a resync deck on genuine external writes but not on its own autosave', async () => {
    const a = await connect('A');
    a.client.send({
      kind: 'txn', txnId: 't1', baseSeq: 0, label: 'rename',
      ops: [{ op: 'updateDeck', title: 'Own Write' }],
    });
    await a.client.nextOfKind('txn');
    await new Promise((resolve) => setTimeout(resolve, 1300)); // autosave lands; watcher echo must be silent

    const external = parseDeck({ ...emptyDeck('External'), slides: [{ id: 'sX', name: 'X' }] });
    await saveDeck(deckDir, external);
    const deckMsg = await a.client.nextOfKind('deck');
    expect(deckMsg.reason).toBe('external-edit');
    expect(deckMsg.deck.title).toBe('External');
  });

  it('relays presence and cursor to other clients only, and peerLeft on disconnect', async () => {
    const a = await connect('A');
    const b = await connect('B');
    await a.client.nextOfKind('presence'); // B joined

    b.client.send({
      kind: 'presence',
      activeSlideId: 's2', selectedSlideIds: ['s2'], selectedElementIds: ['e1'], editingElementId: null,
    });
    const presence = await a.client.nextOfKind('presence');
    expect(presence.state.activeSlideId).toBe('s2');
    expect(presence.state.name).toBe('B');

    b.client.send({ kind: 'cursor', cursor: { slideId: 's2', x: 10, y: 20 } });
    const cursor = await a.client.nextOfKind('cursor');
    expect(cursor.cursor).toEqual({ slideId: 's2', x: 10, y: 20 });

    b.client.close();
    const left = await a.client.nextOfKind('peerLeft');
    expect(left.clientId).toBe(b.welcome.clientId);
  });

  it('shows the slide requested by an HTTP agent as persistent presence', async () => {
    await server.close();
    server = await startCollabServer({
      rootDir,
      port: 0,
      host: '127.0.0.1',
      hostedDeckId: DECK_ID,
      agentMode: true,
    });
    const observer = await connect('Host');
    const rendered = await fetch(
      `http://127.0.0.1:${server.port}/api/render-slide?deck=${DECK_ID}&slideId=s2`,
    );
    expect(rendered.status).toBe(200);
    expect(await observer.client.nextOfKind('presence')).toMatchObject({
      state: {
        clientId: 'agent-http',
        name: 'Agent',
        activeSlideId: 's2',
        selectedSlideIds: ['s2'],
      },
    });

    const latePeer = await connect('Late peer');
    expect(latePeer.welcome.peers).toContainEqual(expect.objectContaining({
      clientId: 'agent-http',
      activeSlideId: 's2',
    }));
  });

  it('serves deck assets with Range support, confined to the deck folder', async () => {
    const bytes = Buffer.from('0123456789');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await writeFile(join(deckDir, 'assets', 'clip.mp4'), bytes);
    const base = `http://127.0.0.1:${server.port}/decks/${DECK_ID}`;

    const full = await fetch(`${base}/assets/clip.mp4`);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);

    const partial = await fetch(`${base}/assets/clip.mp4`, { headers: { range: 'bytes=2-5' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await partial.text()).toBe('2345');

    const invalid = await fetch(`${base}/assets/clip.mp4`, { headers: { range: 'bytes=99-' } });
    expect(invalid.status).toBe(416);

    for (const url of [
      `${base}/assets/../deck.json`,
      `${base}/assets/..%2Fdeck.json`,
      `http://127.0.0.1:${server.port}/decks/..%2F..%2Fetc/assets/passwd`,
    ]) {
      const escape = await fetch(url);
      expect([403, 404]).toContain(escape.status);
    }
  });

  it('uploads media through the content-hash importer', async () => {
    // A 1x1 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/upload?deck=${DECK_ID}&name=dot.png`,
      { method: 'POST', body: png },
    );
    expect(response.status).toBe(200);
    const imported = await response.json() as { src: string; kind: string };
    expect(imported.kind).toBe('image');
    expect(imported.src).toMatch(/^assets\/dot\.[0-9a-f]+\.png$/);
    const served = await fetch(`http://127.0.0.1:${server.port}/decks/${DECK_ID}/${imported.src}`);
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer())).toEqual(png);
  }, 15_000);

  it('rejects private-network URLs in the public asset importer', async () => {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/import-url?deck=${DECK_ID}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `http://127.0.0.1:${server.port}/deck.json`, name: 'private.png' }),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/must be public/) });
  });

  it.skipIf(!existsSync(join(process.cwd(), 'example_presentations', 'team_slide.key')))(
    'imports, lists, and opens a real Keynote deck through HTTP',
    async () => {
      const key = await readFile(join(process.cwd(), 'example_presentations', 'team_slide.key'));
      const imported = await fetch(
        `http://127.0.0.1:${server.port}/api/import-keynote?name=Imported%20Team`,
        { method: 'POST', body: key },
      );
      expect(imported.status).toBe(200);
      expect(await imported.json()).toMatchObject({ id: 'Imported Team' });

      const decks = await (await fetch(`http://127.0.0.1:${server.port}/api/decks`)).json() as
        Array<{ id: string; slides: number }>;
      expect(decks).toContainEqual(expect.objectContaining({ id: 'Imported Team', slides: expect.any(Number) }));
      expect(decks.find((deck) => deck.id === 'Imported Team')!.slides).toBeGreaterThan(0);

      const opened = await fetch(
        `http://127.0.0.1:${server.port}/api/deck?deck=Imported%20Team`,
      );
      expect(opened.status).toBe(200);
      const deck = await opened.json() as Deck;
      expect(deck.slides.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it('previews and applies HTML once while preserving slide comments', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const added = await fetch(`${base}/api/comments?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slideId: 's1', author: 'Benchmark', text: 'Replace this slide.' }),
    });
    expect(added.status).toBe(200);
    const comment = await added.json() as { id: string };
    const context = await (await fetch(`${base}/api/context?deck=${DECK_ID}`)).json() as { revision: string };
    const preview = await fetch(`${base}/api/preview-html?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        html: '<!doctype html><section class="slide" style="width:1920px;height:1080px;background:#123"><h1>Replaced</h1></section>',
        target: { mode: 'replace', slideIds: ['s1'] },
      }),
    });
    expect(preview.status).toBe(200);
    const draft = await preview.json() as { draftId: string; revision: string; report: { nativeObjectRatio: number } };
    expect(draft.revision).toBe(context.revision);
    expect(draft.report.nativeObjectRatio).toBeGreaterThan(0);

    const request = {
      draftId: draft.draftId, expectedRevision: draft.revision,
      idempotencyKey: 'replace-s1-once', label: 'Agent: replace first slide',
    };
    const observer = await connect('Observer');
    const applied = await fetch(`${base}/api/apply-html?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      idempotent: false,
      slideIds: ['s1'],
      label: 'Agent: replace first slide',
    });
    const historyTxn = await observer.client.nextOfKind('txn');
    expect(historyTxn).toMatchObject({
      byClientId: 'agent-http',
      label: 'Agent: replace first slide',
      ops: [expect.objectContaining({ op: 'replaceSlide', slideId: 's1' })],
    });
    const replay = await fetch(`${base}/api/apply-html?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(await replay.json()).toMatchObject({
      idempotent: true,
      slideIds: ['s1'],
      label: 'Agent: replace first slide',
    });

    const deck = await (await fetch(`${base}/api/deck?deck=${DECK_ID}`)).json() as Deck;
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides[0].id).toBe('s1');
    expect(deck.slides[0].comments?.some((row) => row.id === comment.id)).toBe(true);
    const rendered = await fetch(`${base}/api/render-slide?deck=${DECK_ID}&slideId=s1`);
    expect(rendered.status).toBe(200);
    expect(await rendered.json()).toMatchObject({
      slideId: 's1', slide: 1, url: `/present.html?deck=${DECK_ID}&slide=1&agent=1`,
    });
    const replied = await fetch(`${base}/api/comments?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slideId: 's1', parentId: comment.id, author: 'Agent',
        text: 'Implemented and verified in the real player.',
      }),
    });
    expect(replied.status).toBe(200);
    const reply = await replied.json() as { id: string };
    const resolved = await fetch(`${base}/api/comments/resolve?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentId: comment.id, resolved: true }),
    });
    expect(resolved.status).toBe(200);
    const replyResolved = await fetch(`${base}/api/comments/resolve?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commentId: reply.id, resolved: true }),
    });
    expect(replyResolved.status).toBe(200);

    const comments = await (await fetch(`${base}/api/comments?deck=${DECK_ID}`)).json() as {
      comments: Array<{ id: string; resolved: boolean }>;
    };
    expect(comments.comments.filter((row) => !row.resolved && [comment.id, reply.id].includes(row.id)))
      .toEqual([]);
    const afterResolve = await (await fetch(`${base}/api/context?deck=${DECK_ID}`)).json() as {
      outline: Array<{ id: string; openComments: number }>;
    };
    expect(afterResolve.outline.find((slide) => slide.id === 's1')?.openComments).toBe(0);
  }, 20_000);

  it('discovers, previews, and atomically applies surgical native edits', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const schema = await (await fetch(`${base}/api/edit-schema`)).json() as any;
    expect(schema.semantics).toContain('Unmentioned properties and unrelated objects are preserved exactly.');
    expect(schema.element.byType.text.map((row: any) => row.path)).toContain('align');

    const inspectedResponse = await fetch(`${base}/api/inspect?deck=${DECK_ID}&slideIds=s1`);
    expect(inspectedResponse.status).toBe(200);
    const inspected = await inspectedResponse.json() as any;
    expect(inspected.slides[0]).toMatchObject({
      id: 's1',
      elements: [expect.objectContaining({ id: 'e1', type: 'text', plainText: 'hi', semanticRole: 'title' })],
    });

    const previewResponse = await fetch(`${base}/api/preview-edits?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: inspected.revision,
        edits: [{
          target: 'element', slideId: 's1', elementId: 'e1', expectedType: 'text',
          set: { align: 'right', x: 40, w: 400, h: 80, 'style.font-family': 'Inter', 'style.font-size': '36px' },
          unset: [],
        }],
      }),
    });
    expect(previewResponse.status).toBe(200);
    const draft = await previewResponse.json() as any;
    expect(draft).toMatchObject({
      revision: inspected.revision,
      affectedSlideIds: ['s1'],
      affectedElementIds: ['e1'],
      report: { newOrWorsenedOverflows: [] },
    });
    expect(draft.operations).toEqual([expect.objectContaining({ op: 'replaceElement', slideId: 's1', elementId: 'e1' })]);

    // Preview is non-mutating and both states are directly inspectable.
    const beforeApply = await (await fetch(`${base}/api/deck?deck=${DECK_ID}`)).json() as Deck;
    expect(beforeApply.slides[0].elements[0]).toMatchObject({ x: 0, w: 100, align: 'left' });
    expect(draft.slides[0].beforeUrl).toContain(`deck=${DECK_ID}`);
    expect(draft.slides[0].afterUrl).toContain(`deck=${DECK_ID}`);
    const beforeView = await fetch(`${base}${draft.slides[0].beforeUrl}`);
    const afterView = await fetch(`${base}${draft.slides[0].afterUrl}`);
    expect(beforeView.status).toBe(200);
    expect(afterView.status).toBe(200);
    expect(await afterView.text()).toContain('hi');

    const observer = await connect('Native observer');
    const request = {
      draftId: draft.draftId,
      expectedRevision: draft.revision,
      idempotencyKey: 'native-edit-once',
      label: 'Agent: unify title formatting',
    };
    const appliedResponse = await fetch(`${base}/api/apply-edits?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(appliedResponse.status).toBe(200);
    expect(await appliedResponse.json()).toMatchObject({
      idempotent: false, slideIds: ['s1'], elementIds: ['e1'], label: request.label,
    });
    expect(await observer.client.nextOfKind('txn')).toMatchObject({
      byClientId: 'agent-http', label: request.label,
      ops: [expect.objectContaining({ op: 'replaceElement', slideId: 's1', elementId: 'e1' })],
    });
    const afterApply = await (await fetch(`${base}/api/deck?deck=${DECK_ID}`)).json() as Deck;
    expect(afterApply.slides[0].elements[0]).toMatchObject({
      x: 40, w: 400, h: 80, align: 'right', style: { 'font-family': 'Inter', 'font-size': '36px' },
    });
    expect(afterApply.slides[1]).toEqual(beforeApply.slides[1]);

    const replay = await fetch(`${base}/api/apply-edits?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(await replay.json()).toMatchObject({ idempotent: true, label: request.label });
    const reused = await fetch(`${base}/api/apply-edits?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, label: 'Different intent' }),
    });
    expect(reused.status).toBe(409);
  }, 20_000);

  it('rejects invalid native properties and revision-conflicted edit drafts without mutation', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const context = await (await fetch(`${base}/api/context?deck=${DECK_ID}`)).json() as { revision: string };
    const invalid = await fetch(`${base}/api/preview-edits?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ edits: [{ target: 'element', slideId: 's1', elementId: 'e1', set: { id: 'changed' }, unset: [] }] }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining('not editable') });

    const unsafe = await fetch(`${base}/api/preview-edits?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ edits: [{
        target: 'element', slideId: 's1', elementId: 'e1',
        set: { 'style.background-image': 'url(https://example.com/tracker.png)' }, unset: [],
      }] }),
    });
    expect(unsafe.status).toBe(400);
    expect(await unsafe.json()).toMatchObject({ error: expect.stringContaining('blocked external') });

    const preview = await fetch(`${base}/api/preview-edits?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: context.revision,
        edits: [{ target: 'element', slideId: 's1', elementId: 'e1', set: { align: 'right', w: 300 }, unset: [] }],
      }),
    });
    expect(preview.status).toBe(200);
    const draft = await preview.json() as { draftId: string; revision: string };
    await fetch(`${base}/api/comments?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slideId: 's1', text: 'Concurrent change' }),
    });
    const conflicted = await fetch(`${base}/api/apply-edits?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftId: draft.draftId, expectedRevision: draft.revision, idempotencyKey: 'conflict', label: 'Should not land' }),
    });
    expect(conflicted.status).toBe(409);
    const deck = await (await fetch(`${base}/api/deck?deck=${DECK_ID}`)).json() as Deck;
    expect(deck.slides[0].elements[0]).toMatchObject({ align: 'left', w: 100 });
  }, 20_000);

  it('accepts a raw HTML preview body so command-line agents do not escape large JSON', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const preview = await fetch(
      `${base}/api/preview-html?deck=${DECK_ID}&mode=replace&slideIds=s1`,
      {
        method: 'POST',
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!doctype html><section class="slide"><h1>Raw HTML</h1></section>',
      },
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      draftId: expect.any(String),
      target: { mode: 'replace', slideIds: ['s1'] },
    });
  }, 20_000);

  it('serves source previews with a deck-relative base and the real theme', async () => {
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    const pixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    await writeFile(join(deckDir, 'assets', 'pixel.png'), pixel);
    await writeFile(join(deckDir, 'theme.css'), '.from-deck-theme { color: rgb(1, 2, 3); }', 'utf8');

    const base = `http://127.0.0.1:${server.port}`;
    const preview = await fetch(`${base}/api/preview-html?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        html: '<!doctype html><html><head><link rel="stylesheet" href="theme.css"></head><body><section class="slide"><img src="assets/pixel.png"><p class="from-deck-theme">Themed</p></section></body></html>',
        target: { mode: 'replace', slideIds: ['s1'] },
      }),
    });
    expect(preview.status).toBe(200);
    const draft = await preview.json() as { sourceUrl: string };
    const source = await (await fetch(`${base}${draft.sourceUrl}?deck=${DECK_ID}`)).text();
    expect(source).toContain(`<base href="/decks/${DECK_ID}/">`);
    expect(source).toContain('.from-deck-theme { color: rgb(1, 2, 3); }');
    expect(source).toContain('src="assets/pixel.png"');

    const fitted = await (await fetch(
      `${base}${draft.sourceUrl}?deck=${DECK_ID}&scratchpad=slides`,
    )).text();
    expect(fitted).toContain('data-agent-scratchpad-script');
    expect(fitted).toContain("'ArrowRight'");
    expect(fitted).toContain('--agent-scratchpad-scale');
    const contact = await (await fetch(
      `${base}${draft.sourceUrl}?deck=${DECK_ID}&scratchpad=contact`,
    )).text();
    expect(contact).toContain('agent-scratchpad-grid');
    expect(contact).toContain('Contact sheet zoom');

    const asset = await fetch(`${base}/decks/${DECK_ID}/assets/pixel.png`);
    expect(asset.status).toBe(200);
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(pixel);
  }, 20_000);

  it('refuses to apply a draft with blocked resources', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const preview = await fetch(`${base}/api/preview-html?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        html: '<section class="slide"><img src="https://example.com/live.png"><h1>Unsafe draft</h1></section>',
        target: { mode: 'replace', slideIds: ['s1'] },
      }),
    });
    expect(preview.status).toBe(200);
    const draft = await preview.json() as { draftId: string; revision: string };
    const applied = await fetch(`${base}/api/apply-html?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: draft.draftId,
        expectedRevision: draft.revision,
        idempotencyKey: 'blocked-draft',
        label: 'Must not apply',
      }),
    });
    expect(applied.status).toBe(422);
    expect(await applied.json()).toMatchObject({
      error: expect.stringContaining('blocking import diagnostics'),
      blockingDiagnostics: expect.arrayContaining(['missingAssets', 'blockedResources']),
    });

    const deck = await (await fetch(`${base}/api/deck?deck=${DECK_ID}`)).json() as Deck;
    expect(deck.slides[0].elements[0].id).toBe('e1');
  }, 20_000);

  it('rejects an HTML draft after the deck revision changes', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const preview = await fetch(`${base}/api/preview-html?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        html: '<!doctype html><section class="slide" style="width:1920px;height:1080px"><h1>Stale</h1></section>',
        target: { mode: 'insert', afterSlideId: 's1' },
      }),
    });
    const draft = await preview.json() as { draftId: string; revision: string };
    await fetch(`${base}/api/comments?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slideId: 's1', text: 'This changes the revision.' }),
    });
    const conflict = await fetch(`${base}/api/apply-html?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        draftId: draft.draftId, expectedRevision: draft.revision,
        idempotencyKey: 'stale-draft',
      }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'revision conflict', expected: draft.revision });
  }, 20_000);

  it('saves and relays theme edits', async () => {
    const a = await connect('A');
    const b = await connect('B');
    await a.client.nextOfKind('presence');

    b.client.send({ kind: 'theme', css: 'body { color: red; }' });
    const theme = await a.client.nextOfKind('theme');
    expect(theme.css).toContain('red');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(join(deckDir, 'theme.css'), 'utf8')).toContain('red');

    const http = await fetch(`http://127.0.0.1:${server.port}/api/theme?deck=${DECK_ID}`);
    expect(await http.text()).toContain('red');
  });
});
