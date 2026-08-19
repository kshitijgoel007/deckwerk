const { contextBridge } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const prefix = '--pdf-fidelity-job=';
const path = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
if (!path) throw new Error('Missing PDF fidelity job');
const job = JSON.parse(readFileSync(path, 'utf8'));
const deckJob = job.decks[Number(process.argv.find((argument) => argument.startsWith('--deck-index='))?.split('=')[1] ?? 0)];
const deck = JSON.parse(readFileSync(join(deckJob.deckDir, 'deck.json'), 'utf8'));

contextBridge.exposeInMainWorld('api', {
  getDeck: async () => ({ dir: deckJob.deckDir, deck }),
  loadTheme: async () => readFileSync(join(deckJob.deckDir, deck.theme), 'utf8'),
  assetUrl: (src) => `deck://asset/${String(src).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`,
  pdfReady: () => {},
});
