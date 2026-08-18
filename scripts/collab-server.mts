import { resolve } from 'node:path';
import { startCollabServer, defaultClientDir } from '../src/server/collabServer.js';

/**
 * Collaborative editing server:
 *   npm run collab -- <decksRootDir> [--port 5800] [--host 0.0.0.0]
 *
 * Hosts one directory of deck folders for browser clients over HTTP +
 * WebSocket: every immediate subdirectory containing a deck.json is openable,
 * new decks are created inside it, and nothing outside it is ever served.
 * Binds all interfaces by default so tailscale peers can reach it; pass
 * --host 127.0.0.1 to keep it local. Serves the built client from dist/collab
 * when present (npm run build:collab); during development, run the vite dev
 * server instead and let its proxy forward /ws, /assets, and /api here.
 */
const args = process.argv.slice(2);
let rootDir: string | null = null;
let port = 5800;
let host = '0.0.0.0';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--host') host = args[++i];
  else if (!args[i].startsWith('-') && !rootDir) rootDir = args[i];
}
if (!rootDir || Number.isNaN(port)) {
  process.stderr.write('usage: npm run collab -- <decksRootDir> [--port 5800] [--host 0.0.0.0]\n');
  process.exit(2);
}

const clientDir = defaultClientDir(resolve(import.meta.dirname, '..'));
const server = await startCollabServer({ rootDir: resolve(rootDir), clientDir, port, host });

process.stdout.write(`${JSON.stringify({
  status: 'serving',
  rootDir: resolve(rootDir),
  clientBundle: clientDir ?? null,
  urls: server.urls,
})}\n`);
if (!clientDir) {
  process.stderr.write('note: dist/collab not found — API/WS only (use the vite dev client)\n');
}

const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise(() => {});
