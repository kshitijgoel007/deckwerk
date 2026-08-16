import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Deck } from '@shared/deck.js';
import { loadTheme } from './deckStore.js';

/**
 * Export a deck as a self-contained folder that opens in any browser.
 *
 * The exported page runs the same `Player` as the app, so a deck presents
 * identically whether or not the editor is installed. That matters for the
 * usual conference situation: someone else's laptop, no install rights, five
 * minutes before the talk.
 */

/** Where the export player bundle lives, in dev and when packaged. */
function playerBundleDir(): string {
  const candidates = [
    join(import.meta.dirname, '../export'),
    join(import.meta.dirname, '../../out/export'),
    join(process.cwd(), 'out/export'),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'player.js'))) ?? candidates[0];
}

export async function exportDeck(
  deckDir: string,
  deck: Deck,
  outDir: string,
): Promise<void> {
  const bundleDir = playerBundleDir();
  const playerJs = join(bundleDir, 'player.js');
  if (!existsSync(playerJs)) {
    throw new Error(
      `Export player bundle not found at ${playerJs}. Run: npm run build:export`,
    );
  }

  await mkdir(outDir, { recursive: true });

  await copyFile(playerJs, join(outDir, 'player.js'));

  // The player's structural CSS, then the deck's theme, in that order — the
  // theme must win, exactly as it does in the app.
  const playerCss = join(bundleDir, 'player.css');
  const structural = existsSync(playerCss) ? await readFile(playerCss, 'utf8') : '';
  const theme = await loadTheme(deckDir, deck.theme);
  await writeFile(join(outDir, 'player.css'), structural, 'utf8');
  await writeFile(join(outDir, 'theme.css'), theme, 'utf8');

  await copyAssets(deckDir, outDir, deck);
  await writeFile(join(outDir, 'index.html'), indexHtml(deck), 'utf8');
}

/** Copy only the assets this deck actually references, plus nothing else. */
async function copyAssets(
  deckDir: string,
  outDir: string,
  deck: Deck,
): Promise<void> {
  const wanted = new Set<string>();
  for (const slide of deck.slides) {
    if (slide.background.image) wanted.add(slide.background.image);
    for (const el of slide.elements) {
      if (el.type === 'image' || el.type === 'video') wanted.add(el.src);
      if (el.type === 'video' && el.poster) wanted.add(el.poster);
    }
  }
  if (wanted.size === 0) return;

  const srcAssets = join(deckDir, 'assets');
  const destAssets = join(outDir, 'assets');
  await mkdir(destAssets, { recursive: true });

  const available = new Set(await readdir(srcAssets).catch(() => []));
  for (const rel of wanted) {
    const name = rel.split('/').pop();
    if (!name || !available.has(name)) continue;
    await copyFile(join(srcAssets, name), join(destAssets, name));
  }
}

/**
 * The generated page. The deck is inlined as JSON so the export works off
 * `file://`, where fetching a sibling .json is blocked by CORS.
 */
function indexHtml(deck: Deck): string {
  // `</script>` inside the JSON would close the tag early; escaping the slash is
  // the standard defence and stays valid JSON.
  const json = JSON.stringify(deck).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(deck.title)}</title>
    <link rel="stylesheet" href="./player.css" />
    <link rel="stylesheet" href="./theme.css" />
    <style>
      html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
      #root { width: 100vw; height: 100vh; }
      body:fullscreen #root { cursor: none; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>window.__DECK__ = ${json};</script>
    <script src="./player.js"></script>
  </body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
