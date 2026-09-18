/**
 * Prepare a deck's videos for streaming, ahead of any presentation.
 *
 *   npx vite-node --config vitest.config.ts scripts/prepare-media.mts -- <deck-or-root> [...]
 *
 * The collab server does this itself when a deck is opened, one clip at a
 * time, so a talk given from a freshly imported deck gets faster as it warms.
 * That is the wrong moment to discover a 1 GB deck of screen recordings: this
 * command does the whole job up front, which is what you want the day before
 * a talk. Renditions live in a cache outside the deck (nothing is written
 * into assets/), so running it twice is free and running it never is safe.
 */
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadDeck } from '../src/main/deckStore.js';
import {
  RenditionStore,
  defaultRenditionCacheDir,
  isVideoAsset,
} from '../src/server/streamingRenditions.js';

async function deckDirsUnder(root: string): Promise<string[]> {
  if (existsSync(join(root, 'deck.json'))) return [root];
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const child = join(dir, entry.name);
      if (existsSync(join(child, 'deck.json'))) found.push(child);
      else await walk(child, depth + 1);
    }
  };
  await walk(root, 0);
  return found;
}

async function main(): Promise<void> {
  const targets = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  if (targets.length === 0) {
    console.error('usage: prepare-media.mts <deck-or-decks-root> [...]');
    process.exit(2);
  }
  const store = new RenditionStore({
    concurrency: Number(process.env.DECKWERK_RENDITION_JOBS ?? '2'),
    onProgress: (event) => {
      const name = basename(event.source);
      if (event.status === 'started') console.log(`  encoding  ${name}`);
      else if (event.status === 'done') {
        console.log(`  ready     ${name}  (-${Math.round((event.savedBytes ?? 0) / 1048576)} MB)`);
      } else if (event.status === 'skipped') console.log(`  as-is     ${name}  (${event.detail})`);
      else console.warn(`  FAILED    ${name}  ${event.detail ?? ''}`);
    },
  });

  console.log(`renditions cached in ${defaultRenditionCacheDir()}`);
  let prepared = 0;
  let savedBytes = 0;
  for (const target of targets) {
    for (const deckDir of await deckDirsUnder(resolve(target))) {
      const deck = await loadDeck(deckDir);
      const sources = new Set<string>();
      for (const slide of deck.slides) {
        for (const element of slide.elements) {
          if (element.type !== 'video') continue;
          const absolute = join(deckDir, element.src);
          if (isVideoAsset(absolute) && existsSync(absolute)) sources.add(absolute);
        }
      }
      console.log(`\n${deck.title} — ${sources.size} clip(s)`);
      // Sequentially by queue, but all queued at once so the store's own
      // concurrency limit is what paces the machine.
      const results = await Promise.all([...sources].map(async (source) => {
        const before = (await stat(source)).size;
        const rendition = await store.ensure(source);
        if (!rendition) return 0;
        return before - (await stat(rendition)).size;
      }));
      for (const saved of results) {
        if (saved > 0) {
          prepared += 1;
          savedBytes += saved;
        }
      }
    }
  }
  console.log(`\n${prepared} clip(s) prepared, ${Math.round(savedBytes / 1048576)} MB less to send.`);
}

void main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
