import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { importKeynote } from '../src/main/keynoteImport.js';
import { loadDeck, saveDeck } from '../src/main/deckStore.js';
import { defaultClientDir, startCollabServer } from '../src/server/collabServer.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';

const existingDeckDir = process.env.EDIT_BENCHMARK_EXISTING_DECK
  ? resolve(process.env.EDIT_BENCHMARK_EXISTING_DECK)
  : null;
const deckId = existingDeckDir ? basename(existingDeckDir) : 'all-hands-edit-benchmark';
const root = resolve(
  process.env.EDIT_BENCHMARK_OUTPUT
    ?? join('artifacts', 'native-edit-eval', new Date().toISOString().replace(/[:.]/g, '-')),
);
const decksDir = existingDeckDir ? resolve(existingDeckDir, '..') : join(root, 'decks');
const deckDir = existingDeckDir ?? join(decksDir, deckId);
const port = Number(process.env.EDIT_BENCHMARK_PORT ?? 5810);
const source = resolve(process.env.EDIT_BENCHMARK_KEYNOTE ?? 'example_presentations/2608_all_HANDS.key');
const taskPromptPath = resolve(
  process.env.EDIT_BENCHMARK_TASK
    ?? 'test/fixtures/agent-eval/native-reformatting-prompt.md',
);

await Promise.all([
  mkdir(root, { recursive: true }),
  mkdir(decksDir, { recursive: true }),
]);
const imported = existingDeckDir ? null : await importKeynote(source, deckDir);
const deck = imported?.deck ?? await loadDeck(deckDir);
if (deck.slides.length < 8) throw new Error(`all_HANDS benchmark needs at least 8 slides; imported ${deck.slides.length}`);
const advanced = taskPromptPath.endsWith('native-css-layout-prompt.md');
const commentMedia = taskPromptPath.endsWith('comment-media-replacement-prompt.md');
const commentSlideIndex = commentMedia ? 3 : 1;
const commentId = commentMedia
  ? 'comment-media-replacement'
  : advanced ? 'comment-native-css-layout' : 'comment-native-reformatting';
deck.slides[commentSlideIndex].comments ??= [];
if (!deck.slides[commentSlideIndex].comments.some((comment) => comment.id === commentId)) {
  deck.slides[commentSlideIndex].comments.push({
    id: commentId,
    author: 'Benchmark',
    text: commentMedia
      ? 'replace the low-resolution minecraft+noise grid that you can see here with a different, higher-resolution and more pretty frame sequence + noise grid. Use matplotlib and ffmpeg or whatever other tools you think are best fit for the task.'
      : advanced
        ? 'Swap primary body/video regions where applicable, round-mask and blur every video, and apply the pink-to-green title gradient through native CSS. Verify every affected slide.'
        : 'Unify typography and title treatment on slides 2–8 through native edits. Preserve every unrelated property and verify all seven real-player renders.',
    ts: new Date().toISOString(),
    resolved: false,
  });
}
await saveDeck(deckDir, deck);

const clientDir = defaultClientDir(resolve(import.meta.dirname, '..'));
if (!clientDir) throw new Error('The collaboration client is not built. Run npm run build:collab first.');
const server = await startCollabServer({
  rootDir: decksDir,
  hostedDeckId: deckId,
  localAgents: new LocalAgentRegistry({ name: 'Native editing agent' }),
  clientDir,
  host: '0.0.0.0',
  port,
});

const base = (server.urls.find((url) => !url.includes('127.0.0.1')) ?? server.urls[0]).replace(/\/$/, '');
const generalPrompt = `# DeckWerk filesystem-agent benchmark

Use only DeckWerk's filesystem authoring interface. Work in the mirror folder
created by the collaboration page's Agent… command. Read its AGENTS.md in full,
begin with \`slide-agent context\`, and author slides by editing and saving HTML
files under \`edit/\`. Do not call the collaboration server's HTTP or WebSocket
routes directly.`;
const taskPrompt = await readFile(taskPromptPath, 'utf8');
const session = {
  deckId,
  root,
  deckDir,
  source,
  importReport: imported?.report ?? { reusedDeck: true },
  generalPrompt: join(root, 'general-prompt.txt'),
  taskPrompt: taskPromptPath,
  combinedPrompt: join(root, 'combined-prompt.txt'),
  humanUrl: `http://127.0.0.1:${port}/?deck=${encodeURIComponent(deckId)}&name=Vincent`,
  playerUrl: `http://127.0.0.1:${port}/present.html?deck=${encodeURIComponent(deckId)}&slide=${commentSlideIndex + 1}&agent=1`,
  url: `${base}/?deck=${encodeURIComponent(deckId)}&name=Native+Editing+Evaluator`,
};
await writeFile(session.generalPrompt, generalPrompt, 'utf8');
await writeFile(session.combinedPrompt, `${generalPrompt}\n\n# Concrete task\n\n${taskPrompt}`, 'utf8');
await writeFile(join(root, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
process.stdout.write(`${JSON.stringify(session)}\n`);

const stop = () => void server.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise(() => {});
