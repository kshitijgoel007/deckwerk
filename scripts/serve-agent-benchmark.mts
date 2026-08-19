import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDeck, saveDeck } from '../src/main/deckStore.js';
import { defaultClientDir, startCollabServer } from '../src/server/collabServer.js';

const deckId = 'agent-design-gap-benchmark';
const root = resolve(
  process.env.AGENT_BENCHMARK_OUTPUT
    ?? join('artifacts', 'agent-eval-live', new Date().toISOString().replace(/[:.]/g, '-')),
);
const decksDir = join(root, 'decks');
const deckDir = join(decksDir, deckId);
const draftsDir = join(root, 'html-drafts');
const port = Number(process.env.AGENT_BENCHMARK_PORT ?? 5803);

await mkdir(root, { recursive: true });
const deck = await createDeck(deckDir, 'Agent design-gap benchmark');
deck.slides = [
  benchmarkSlide(
    'slide-vincent',
    'Vincent introduction',
    'Replace this with a beautiful introduction slide for Vincent using his public biography and portrait from vincentsitzmann.com.',
  ),
  benchmarkSlide(
    'slide-team-anchor',
    'Scene Representation Group · section',
    'Keep this anchor. Insert a beautiful current-team slide immediately after it with ten lab members excluding Vincent and ten distinct portraits from scenerepresentations.org/people/.',
  ),
  benchmarkSlide(
    'slide-timeline',
    'Research timeline',
    'Replace this with a beautiful visual timeline for SRNs, SIREN, Neural Descriptor Fields, pixelSplat, Diffusion Forcing, and MilliVid, using publication media or thumbnails where available.',
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
  urls: server.urls.map((url) => `${url}/?deck=${deckId}&name=Design+Gap+Agent&agent=1`),
};
await writeFile(join(root, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
process.stdout.write(`${JSON.stringify(session)}\n`);

const stop = () => void server.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise(() => {});

function benchmarkSlide(id: string, name: string, instruction: string) {
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
