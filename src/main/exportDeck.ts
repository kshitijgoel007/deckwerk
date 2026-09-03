import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Deck } from '@shared/deck.js';
import { loadTheme, resolveAsset } from './deckStore.js';

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

/**
 * Why a web export cannot run right now, or null when it can.
 *
 * The export player is a build artefact rather than source, so a checkout that
 * has not run `npm run build:export` — or a server deployed without it — can
 * only find out by trying. Callers that hand the result straight to a browser
 * download need to know before they start writing bytes.
 */
export function webExportUnavailableReason(): string | null {
  const playerJs = join(playerBundleDir(), 'player.js');
  return existsSync(playerJs)
    ? null
    : `Export player bundle not found at ${playerJs}. Run: npm run build:export`;
}

export async function exportDeck(
  deckDir: string,
  deck: Deck,
  outDir: string,
  onProgress?: (message: string, ratio: number | null) => void,
): Promise<void> {
  const unavailable = webExportUnavailableReason();
  if (unavailable) throw new Error(unavailable);
  const bundleDir = playerBundleDir();
  const playerJs = join(bundleDir, 'player.js');

  const wanted = referencedAssets(deck);
  const total = 5 + wanted.size;
  let completed = 0;
  const progress = (message: string): void => {
    onProgress?.(message, completed / total);
  };

  progress(`Creating ${outDir}`);
  await mkdir(outDir, { recursive: true });
  completed++;

  progress('Copying player.js');
  await copyFile(playerJs, join(outDir, 'player.js'));
  completed++;

  // The player's structural CSS, then the deck's theme, in that order — the
  // theme must win, exactly as it does in the app.
  const playerCss = join(bundleDir, 'player.css');
  progress('Writing player.css');
  const structural = existsSync(playerCss) ? await readFile(playerCss, 'utf8') : '';
  await writeFile(join(outDir, 'player.css'), structural, 'utf8');
  completed++;

  progress(`Writing ${deck.theme}`);
  const theme = await loadTheme(deckDir, deck.theme);
  await writeFile(join(outDir, 'theme.css'), theme, 'utf8');
  completed++;

  await copyAssets(deckDir, outDir, wanted, (name) => {
    progress(`Copying assets/${name}`);
  }, () => completed++);
  progress('Writing index.html');
  await writeFile(join(outDir, 'index.html'), indexHtml(deck), 'utf8');
  completed++;
  onProgress?.('Web export complete', completed / total);
}

/** Copy only the assets this deck actually references, plus nothing else. */
async function copyAssets(
  deckDir: string,
  outDir: string,
  wanted: Set<string>,
  beforeCopy?: (name: string) => void,
  afterCopy?: () => void,
): Promise<void> {
  if (wanted.size === 0) return;

  await mkdir(join(outDir, 'assets'), { recursive: true });

  for (const rel of wanted) {
    beforeCopy?.(rel.split('/').pop() ?? rel);
    // Copy to the same relative path the deck refers to. Flattening to the
    // basename and looking it up in a non-recursive listing of `assets/` meant
    // anything in a subfolder -- `assets/figures/plot.png`, which every other
    // path in the app loads happily -- was skipped without a word, and would
    // have landed under a name the exported deck does not reference anyway.
    // Never follow a reference out of the deck folder -- lexically or through
    // a symlink planted in `assets/`, which `resolveAsset` also refuses.
    let from: string;
    try {
      from = resolveAsset(deckDir, rel);
    } catch {
      afterCopy?.();
      continue;
    }
    const within = relative(resolve(deckDir), from);
    if (within === '') {
      afterCopy?.();
      continue;
    }
    const to = join(outDir, within);
    try {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    } catch {
      // A reference to a file that is not there is the deck's problem to show,
      // not a reason to abandon the export.
    }
    afterCopy?.();
  }
}

function referencedAssets(deck: Deck): Set<string> {
  const wanted = new Set<string>();
  for (const slide of deck.slides) {
    if (slide.background.image) wanted.add(slide.background.image);
    for (const el of slide.elements) {
      if (el.type === 'image' || el.type === 'video') wanted.add(el.src);
      if (el.type === 'video' && el.poster) wanted.add(el.poster);
      if (el.type === 'html') {
        collectFallbackAssets(el.html, wanted);
        collectFallbackAssets(el.css ?? '', wanted);
      }
    }
  }
  return wanted;
}

/** Assets referenced only by an isolated HTML region still belong in exports. */
function collectFallbackAssets(source: string, wanted: Set<string>): void {
  const patterns = [
    /\b(?:src|poster)\s*=\s*["'](assets\/[^"'#?]+)(?:[?#][^"']*)?["']/gi,
    /url\(\s*["']?(assets\/[^"')#?]+)(?:[?#][^"')]*)?["']?\s*\)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) wanted.add(match[1]);
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
