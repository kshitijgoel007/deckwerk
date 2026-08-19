import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDeck, saveDeck } from '../src/main/deckStore.js';
import { defaultClientDir, startCollabServer } from '../src/server/collabServer.js';

const deckId = 'paper-showcase-benchmark';
const root = resolve(
  process.env.PAPER_BENCHMARK_OUTPUT
    ?? join('artifacts', 'paper-agent-eval', new Date().toISOString().replace(/[:.]/g, '-')),
);
const decksDir = join(root, 'decks');
const deckDir = join(decksDir, deckId);
const draftsDir = join(root, 'html-drafts');
const port = Number(process.env.PAPER_BENCHMARK_PORT ?? 5806);

await mkdir(root, { recursive: true });
const deck = await createDeck(deckDir, 'Four-paper agent benchmark');
deck.slides = [
  paperSlide(
    'slide-srns',
    'Scene Representation Networks',
    'Create the SRNs paper slide: takeaway headline, TL;DR, one or two central equations, a prominent playable result video, and a concrete why-it-matters claim. Verify Source, Imported, and the real player before resolving.',
  ),
  paperSlide(
    'slide-siren',
    'SIREN',
    'Create the SIREN paper slide: explain periodic activations visually, include one or two central equations, a prominent playable result video, a TL;DR, and a concrete why-it-matters claim. Verify Source, Imported, and the real player before resolving.',
  ),
  paperSlide(
    'slide-lfns',
    'Light Field Networks',
    'Create the LFN paper slide: explain the oriented-ray representation, include one or two central equations, a prominent playable comparison video, a TL;DR, and a concrete why-it-matters claim. Verify Source, Imported, and the real player before resolving.',
  ),
  paperSlide(
    'slide-metasdf',
    'MetaSDF',
    'Create the MetaSDF paper slide: explain the meta-learning update, include one or two central equations, a prominent playable optimization video, a TL;DR, and a concrete why-it-matters claim. Verify Source, Imported, and the real player before resolving.',
  ),
];
await saveDeck(deckDir, deck);

const clientDir = defaultClientDir(resolve(import.meta.dirname, '..'));
const server = await startCollabServer({
  rootDir: decksDir,
  hostedDeckId: deckId,
  agentMode: true,
  draftArchiveDir: draftsDir,
  clientDir,
  host: '0.0.0.0',
  port,
});

const session = {
  deckId,
  root,
  deckDir,
  draftsDir,
  prompt: resolve('test/fixtures/agent-eval/paper-showcase-prompt.md'),
  humanUrl: `http://127.0.0.1:${port}/?deck=${deckId}&name=Vincent`,
  playerUrl: `http://127.0.0.1:${port}/present.html?deck=${deckId}&slide=1&agent=1`,
  agentUrls: server.urls.map((url) => `${url}/?deck=${deckId}&name=Paper+Design+Agent&agent=1`),
};
await writeFile(join(root, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
process.stdout.write(`${JSON.stringify(session)}\n`);

const stop = () => void server.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise(() => {});

function paperSlide(id: string, name: string, instruction: string) {
  return {
    id,
    name,
    notes: '',
    background: { color: null, image: null },
    elements: [],
    timeline: [],
    comments: [{
      id: `comment-${id}`,
      author: 'Benchmark',
      text: instruction,
      ts: new Date().toISOString(),
      resolved: false,
    }],
  };
}
