import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { networkInterfaces, tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { createDeck, importAsset, resolveAsset } from '../main/deckStore.js';
import { AGENT_BRIEF } from './agentBrief.js';
import { capabilities } from '../shared/capabilities.js';
import { probeMedia } from '../main/ffmpeg.js';
import { ClientMessageSchema, COLLAB_PROTOCOL_VERSION, type PresenceState, type ServerMessage } from '../shared/collab.js';
import { CollabSession } from './collabSession.js';
import { writeZip, type ZipFile } from './zip.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

/** Distinguishable hues for peer cursors; assigned least-used-first per deck. */
const PALETTE = [
  '#e0533d', '#3d7de0', '#3daf5e', '#c33dbf', '#e09c3d',
  '#3dbfc3', '#7a5ce0', '#a0b23d', '#e05c8a', '#5c8fa0',
];

interface Peer {
  socket: WebSocket;
  state: PresenceState;
  greeted: boolean;
}

/** One hosted deck: its authoritative session plus the peers editing it. */
interface Room {
  session: CollabSession;
  peers: Map<string, Peer>;
  guestCounter: number;
}

export interface CollabServerOptions {
  /**
   * The single directory this server exposes. Every immediate subdirectory
   * containing a deck.json is an openable deck; nothing outside this
   * directory is ever readable or writable.
   */
  rootDir: string;
  /** Directory holding the built browser client; may be absent in dev (vite proxy). */
  clientDir?: string;
  port?: number;
  host?: string;
  /**
   * Hosted-session mode: the desktop app sharing the one deck it has open.
   * Only this deck id is joinable; listing shows nothing else, and creating
   * or importing decks is disabled — joiners edit the host's presentation,
   * they don't browse the host's disk.
   */
  hostedDeckId?: string;
  /**
   * Called when the host requests the session end (POST /api/end from
   * loopback in a hosted session). The owner tears the server down; the
   * endpoint itself only notifies peers.
   */
  onSessionEnd?: () => void;
}

export interface RunningCollabServer {
  urls: string[];
  port: number;
  close: () => Promise<void>;
}

export async function startCollabServer(options: CollabServerOptions): Promise<RunningCollabServer> {
  const rootDir = resolve(options.rootDir);
  const clientDir = options.clientDir;
  const host = options.host ?? '0.0.0.0';
  const hostedDeckId = options.hostedDeckId;
  const rooms = new Map<string, Room>();
  /** Known once listen() succeeds; /api/config reports the invite URLs. */
  let boundPort: number | null = null;

  /** Deck ids are immediate-child directory names; reject anything else. */
  function deckDirOf(deckId: string): string {
    if (!deckId || deckId.includes('/') || deckId.includes('\\') || deckId === '.' || deckId === '..') {
      throw new Error(`invalid deck id: ${deckId}`);
    }
    if (hostedDeckId && deckId !== hostedDeckId) {
      throw new Error(`this session only hosts "${hostedDeckId}"`);
    }
    const dir = resolve(rootDir, deckId);
    if (dir !== join(rootDir, deckId)) throw new Error(`invalid deck id: ${deckId}`);
    return dir;
  }

  async function listDecks(): Promise<Array<{ id: string; title: string; slides: number }>> {
    const out: Array<{ id: string; title: string; slides: number }> = [];
    for (const entry of await readdir(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (hostedDeckId && entry.name !== hostedDeckId) continue;
      const deckPath = join(rootDir, entry.name, 'deck.json');
      if (!existsSync(deckPath)) continue;
      try {
        const raw = JSON.parse(await readFile(deckPath, 'utf8')) as {
          title?: string; slides?: unknown[];
        };
        out.push({
          id: entry.name,
          title: raw.title ?? entry.name,
          slides: Array.isArray(raw.slides) ? raw.slides.length : 0,
        });
      } catch {
        // Half-written or invalid deck.json; skip rather than fail the listing.
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function getRoom(deckId: string): Promise<Room> {
    const existing = rooms.get(deckId);
    if (existing) return existing;
    const session = await CollabSession.open(deckDirOf(deckId));
    const room: Room = { session, peers: new Map(), guestCounter: 0 };
    session.watch({
      onExternalDeck: (deck, seq) => broadcast(room, { kind: 'deck', seq, deck, reason: 'external-edit' }),
      onExternalTheme: (css) => broadcast(room, { kind: 'theme', css, byClientId: '' }),
    });
    rooms.set(deckId, room);
    return room;
  }

  const send = (peer: Peer, message: ServerMessage) => {
    if (peer.socket.readyState === peer.socket.OPEN) peer.socket.send(JSON.stringify(message));
  };
  const broadcast = (room: Room, message: ServerMessage, except?: string) => {
    for (const [id, peer] of room.peers) {
      if (id !== except && peer.greeted) send(peer, message);
    }
  };

  const httpServer = createServer((request, response) => {
    void handleHttp(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(`server error: ${String(error)}`);
    });
  });

  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    const deckParam = url.searchParams.get('deck');

    // Deck-scoped asset streaming: /decks/<id>/assets/<relpath>
    const assetMatch = /^\/decks\/([^/]+)\/(assets\/.+)$/.exec(path);
    if (assetMatch) {
      let absolute: string;
      try {
        const deckDir = deckDirOf(assetMatch[1]);
        absolute = resolveAsset(deckDir, assetMatch[2]);
        // Stricter than resolveAsset's deck-folder guard: over HTTP, only the
        // assets/ subtree is servable — never deck.json or edit/ files.
        if (!absolute.startsWith(join(deckDir, 'assets') + '/')) throw new Error('outside assets');
      } catch {
        response.writeHead(403, { 'content-type': 'text/plain' });
        response.end('forbidden');
        return;
      }
      await serveFileWithRanges(request, response, absolute);
      return;
    }

    // The feature cookbook: every editor capability with a minimal, valid
    // example element. The antidote to agents hand-building what already
    // exists (literal "•" bullets instead of <ul>, equations out of positioned
    // text, re-encoded videos instead of sourceBox crops).
    if (path === '/api/capabilities' && request.method === 'GET') {
      const only = (url.searchParams.get('only') ?? '').split(',').filter(Boolean);
      const all = capabilities();
      const picked = only.length > 0 ? all.filter((c) => only.includes(c.id)) : all;
      respondJson(response, 200, {
        howToUse: [
          'Copy an element from `elements` and change the ids, geometry and text.',
          'Element ids must be unique across the whole deck.',
          'Sizes and colours belong in theme.css via the class, not in inline style.',
          'Filter with ?only=<id>,<id> once you know what you need.',
        ],
        capabilities: picked,
      });
      return;
    }

    if (path === '/api/brief' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      response.end(AGENT_BRIEF);
      return;
    }

    if (path === '/api/config' && request.method === 'GET') {
      respondJson(response, 200, {
        hosted: Boolean(hostedDeckId),
        deckId: hostedDeckId ?? null,
        urls: boundPort === null ? [] : reachableUrls(host, boundPort),
      });
      return;
    }

    if (path === '/api/decks' && request.method === 'GET') {
      respondJson(response, 200, await listDecks());
      return;
    }

    if (hostedDeckId && (path === '/api/decks' || path === '/api/import-keynote') && request.method === 'POST') {
      respondJson(response, 403, { error: 'this session hosts a single shared presentation' });
      return;
    }

    if (path === '/api/decks' && request.method === 'POST') {
      const name = sanitizeDeckId(url.searchParams.get('name') ?? '');
      if (!name) return respondJson(response, 400, { error: 'missing or invalid name' });
      const dir = deckDirOf(name);
      if (existsSync(dir)) return respondJson(response, 409, { error: `deck "${name}" already exists` });
      await createDeck(dir, name);
      respondJson(response, 200, { id: name });
      return;
    }

    if (path === '/api/import-keynote' && request.method === 'POST') {
      const name = sanitizeDeckId(url.searchParams.get('name') ?? '');
      if (!name) return respondJson(response, 400, { error: 'missing or invalid name' });
      const dir = deckDirOf(name);
      if (existsSync(dir)) return respondJson(response, 409, { error: `deck "${name}" already exists` });
      const body = await readBody(request);
      const tmp = await mkdtemp(join(tmpdir(), 'collab-keynote-'));
      try {
        const keyFile = join(tmp, `${name}.key`);
        await writeFile(keyFile, body);
        const report = await runKeynoteImport(keyFile, dir);
        respondJson(response, 200, { id: name, report });
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      return;
    }

    if (path === '/api/upload' && request.method === 'POST') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const name = url.searchParams.get('name') ?? 'upload';
      const body = await readBody(request);
      const dir = await mkdtemp(join(tmpdir(), 'collab-upload-'));
      const tmpFile = join(dir, sanitizeFilename(name));
      try {
        await writeFile(tmpFile, body);
        const imported = await importAsset(deckDirOf(deckParam), tmpFile);
        respondJson(response, 200, imported);
      } catch (error) {
        respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return;
    }

    if (path === '/api/probe') {
      const src = url.searchParams.get('src');
      if (!src || !deckParam) return respondJson(response, 400, { error: 'missing deck or src' });
      try {
        respondJson(response, 200, await probeMedia(resolveAsset(deckDirOf(deckParam), src)));
      } catch (error) {
        respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
      }
      return;
    }

    // Download the whole deck folder as a zip. Flushing the live session first
    // means the archive holds exactly what everyone currently sees.
    if (path === '/api/download' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      let deckDir: string;
      try {
        deckDir = deckDirOf(deckParam);
      } catch {
        return respondJson(response, 403, { error: 'forbidden' });
      }
      if (!existsSync(join(deckDir, 'deck.json'))) {
        return respondJson(response, 404, { error: 'no such deck' });
      }
      await rooms.get(deckParam)?.session.flush();
      const files = await collectDeckFiles(deckDir);
      response.writeHead(200, {
        'content-type': 'application/zip',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${sanitizeFilename(deckParam)}.zip"`,
      });
      await writeZip(response, files);
      response.end();
      return;
    }

    // Host-only, hosted-session-only: end the collaboration. The desktop app's
    // own window is the sole loopback client, so loopback is the auth check.
    if (path === '/api/end' && request.method === 'POST') {
      const remote = request.socket.remoteAddress ?? '';
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      if (!hostedDeckId || !loopback) {
        return respondJson(response, 403, { error: 'only the host can end the session' });
      }
      for (const room of rooms.values()) broadcast(room, { kind: 'ended' });
      respondJson(response, 200, { ok: true });
      options.onSessionEnd?.();
      return;
    }

    // The live deck as JSON — for agents that talk HTTP rather than driving
    // the client page. Served from the room's session, so it is exactly what
    // every connected client currently sees.
    if (path === '/api/deck' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      respondJson(response, 200, room.session.deck);
      return;
    }

    // Every comment in the deck, with 1-based slide numbers. This is the
    // "see comments" entry point for agents: humans leave instructions as
    // comments, an agent starts by reading this list.
    if (path === '/api/comments' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      const rows: unknown[] = [];
      room.session.deck.slides.forEach((slide, index) => {
        const base = { slide: index + 1, slideId: slide.id, slideName: slide.name };
        for (const comment of slide.comments ?? []) rows.push({ ...base, ...comment });
        for (const element of slide.elements) {
          for (const comment of element.comments ?? []) {
            rows.push({ ...base, elementId: element.id, elementType: element.type, ...comment });
          }
        }
      });
      respondJson(response, 200, { commentCount: rows.length, comments: rows });
      return;
    }

    if (path === '/api/theme') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
      response.end(room.session.themeCss);
      return;
    }

    // Static client bundle.
    if (!clientDir) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('no client bundle configured (dev mode: use the vite dev server)');
      return;
    }
    const relative = normalize(path).replace(/^([/\\]|\.\.)+/, '');
    const file = join(clientDir, relative === '' || relative === '.' ? 'index.html' : relative);
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
  }

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const deckId = url.searchParams.get('deck');
    if (!deckId) {
      socket.close(4000, 'missing deck parameter');
      return;
    }

    // Opening the room reads files; pause the socket so a hello frame sent
    // immediately after the handshake isn't emitted before a listener exists.
    socket.pause();
    void (async () => {
      let room: Room;
      try {
        room = await getRoom(deckId);
      } catch (error) {
        socket.close(4004, String(error instanceof Error ? error.message : error).slice(0, 120));
        return;
      }
      bindPeer(room, socket);
      socket.resume();
    })();
  });

  function bindPeer(room: Room, socket: WebSocket): void {
    const clientId = randomUUID();
    const peer: Peer = {
      socket,
      greeted: false,
      state: {
        clientId,
        name: '',
        color: '',
        activeSlideId: null,
        selectedSlideIds: [],
        selectedElementIds: [],
        editingElementId: null,
        cursor: null,
      },
    };
    room.peers.set(clientId, peer);

    socket.on('message', (raw) => {
      let message;
      try {
        message = ClientMessageSchema.parse(JSON.parse(String(raw)));
      } catch {
        return; // Trusted network; a malformed frame is a bug, not an attack. Drop it.
      }

      if (message.kind === 'hello') {
        room.guestCounter += 1;
        peer.state.name = message.name?.trim() || `Guest ${room.guestCounter}`;
        peer.state.color = pickColor(room.peers);
        peer.greeted = true;
        send(peer, {
          kind: 'welcome',
          version: COLLAB_PROTOCOL_VERSION,
          clientId,
          self: { name: peer.state.name, color: peer.state.color },
          seq: room.session.seq,
          deck: room.session.deck,
          themeCss: room.session.themeCss,
          peers: [...room.peers.values()].filter((p) => p !== peer && p.greeted).map((p) => p.state),
        });
        broadcast(room, { kind: 'presence', state: peer.state }, clientId);
        return;
      }
      if (!peer.greeted) return;

      switch (message.kind) {
        case 'txn': {
          try {
            const applied = room.session.applyOps(message.ops);
            broadcast(room, {
              kind: 'txn',
              seq: applied.seq,
              txnId: message.txnId,
              byClientId: clientId,
              label: message.label,
              ops: message.ops,
            });
          } catch (error) {
            console.error(`txn rejected: ${String(error)}`);
            send(peer, { kind: 'deck', seq: room.session.seq, deck: room.session.deck, reason: 'resync' });
          }
          return;
        }
        case 'presence':
          peer.state = {
            ...peer.state,
            activeSlideId: message.activeSlideId,
            selectedSlideIds: message.selectedSlideIds,
            selectedElementIds: message.selectedElementIds,
            editingElementId: message.editingElementId,
          };
          broadcast(room, { kind: 'presence', state: peer.state }, clientId);
          return;
        case 'cursor':
          peer.state.cursor = message.cursor;
          broadcast(room, { kind: 'cursor', clientId, cursor: message.cursor }, clientId);
          return;
        case 'theme':
          room.session.saveThemeCss(message.css);
          broadcast(room, { kind: 'theme', css: message.css, byClientId: clientId }, clientId);
          return;
      }
    });

    socket.on('close', () => {
      room.peers.delete(clientId);
      if (peer.greeted) broadcast(room, { kind: 'peerLeft', clientId });
    });
  }

  const port = await new Promise<number>((resolvePromise, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 5800, host, () => {
      const address = httpServer.address();
      resolvePromise(typeof address === 'object' && address ? address.port : options.port ?? 5800);
    });
  });
  boundPort = port;

  return {
    port,
    urls: reachableUrls(host, port),
    close: async () => {
      wss.close();
      for (const room of rooms.values()) {
        for (const peer of room.peers.values()) peer.socket.close();
      }
      await new Promise<void>((resolvePromise) => httpServer.close(() => resolvePromise()));
      for (const room of rooms.values()) await room.session.close();
    },
  };
}

function pickColor(peers: Map<string, Peer>): string {
  const used = new Map<string, number>();
  for (const peer of peers.values()) {
    if (peer.state.color) used.set(peer.state.color, (used.get(peer.state.color) ?? 0) + 1);
  }
  let best = PALETTE[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const color of PALETTE) {
    const count = used.get(color) ?? 0;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolvePromise(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return base || 'upload';
}

/** A new deck's folder name: human-typed, so normalise instead of rejecting. */
function sanitizeDeckId(name: string): string {
  return basename(name)
    .replace(/\.key$/i, '')
    .replace(/[^a-zA-Z0-9._ -]+/g, '-')
    .replace(/^[.\s-]+|[\s-]+$/g, '')
    .slice(0, 80);
}

/**
 * Run the Keynote importer sidecar without Electron: the frozen binary when
 * built (build/importers), otherwise the project venv's Python and the source
 * script — the same fallbacks the desktop app uses.
 */
async function runKeynoteImport(keyFile: string, outDir: string): Promise<unknown> {
  const repoRoot = resolve(import.meta.dirname, '../..');
  const binary = join(repoRoot, 'build/importers', process.platform === 'win32' ? 'keynote-import.exe' : 'keynote-import');
  const script = join(repoRoot, 'importers/keynote/import_keynote.py');
  const venv = join(repoRoot, '.venv-import/bin/python');

  let command: string;
  let args: string[];
  if (existsSync(binary)) {
    command = binary;
    args = [keyFile, '--out', outDir];
  } else if (existsSync(script)) {
    command = existsSync(venv) ? venv : 'python3';
    args = [script, keyFile, '--out', outDir];
  } else {
    throw new Error('Keynote importer not found (run npm run build:importer)');
  }

  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolvePromise(out) : reject(new Error(`importer failed: ${err || `exit ${code}`}`)),
    );
  });
  const payload = JSON.parse(stdout) as { report?: unknown };
  return payload.report ?? null;
}

/**
 * Every regular file under the deck folder, as lazy zip entries so only one
 * file's bytes are in memory at a time. Dotfiles (.DS_Store & co) are noise
 * in a download; skip them.
 */
async function collectDeckFiles(deckDir: string): Promise<ZipFile[]> {
  const files: ZipFile[] = [];
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(join(deckDir, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const relPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(relPath);
      else if (entry.isFile()) {
        files.push({ name: relPath, load: () => readFile(join(deckDir, relPath)) });
      }
    }
  }
  await walk('');
  return files;
}

/** Stream a file honouring HTTP Range requests, so <video> can seek. */
async function serveFileWithRanges(
  request: IncomingMessage,
  response: ServerResponse,
  absolute: string,
): Promise<void> {
  let info;
  try {
    info = await stat(absolute);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
    return;
  }

  const type = MIME[extname(absolute).toLowerCase()] ?? 'application/octet-stream';
  const range = request.headers.range;
  const common = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };

  if (!range) {
    response.writeHead(200, { ...common, 'content-length': info.size });
    createReadStream(absolute).pipe(response);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const start = match?.[1] ? Number(match[1]) : 0;
  const end = match?.[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
  if (!match || Number.isNaN(start) || start > end || start >= info.size) {
    response.writeHead(416, { 'content-range': `bytes */${info.size}` });
    response.end();
    return;
  }

  response.writeHead(206, {
    ...common,
    'content-range': `bytes ${start}-${end}/${info.size}`,
    'content-length': end - start + 1,
  });
  createReadStream(absolute, { start, end }).pipe(response);
}

function reachableUrls(host: string, port: number): string[] {
  if (host !== '0.0.0.0' && host !== '::') return [`http://${host}:${port}/`];
  const urls = [`http://127.0.0.1:${port}/`];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) urls.push(`http://${iface.address}:${port}/`);
    }
  }
  return urls;
}

export function defaultClientDir(repoRoot: string): string | undefined {
  // app.getAppPath() is out/main when Electron is launched as
  // `electron out/main/index.js`, so walk up looking for dist/collab.
  let base = repoRoot;
  for (let i = 0; i < 4; i++) {
    const dir = join(base, 'dist', 'collab');
    if (existsSync(join(dir, 'index.html'))) return dir;
    const parent = dirname(base);
    if (parent === base) break;
    base = parent;
  }
  return undefined;
}
