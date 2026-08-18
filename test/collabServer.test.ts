import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  });

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
