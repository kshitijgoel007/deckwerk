import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { type Deck, emptyDeck, parseDeck } from '@shared/deck.js';
import type { ImportedAsset } from '@shared/ipc.js';
import { classifyMediaName } from '@shared/media.js';
import { isWebSafeCodec, probeMedia, transcodeToH264, videoCodec } from './ffmpeg.js';

/**
 * Reading and writing deck folders.
 *
 * A deck is a directory, not a file: `deck.json` (content and geometry),
 * `theme.css` (typography and colour, hand-edited), `assets/` (media), and an
 * optional `agent-chats.json` and `deck-history.json.gz` sidecars.
 * Keeping media as real files on disk rather than embedded data is what makes
 * video practical — a 200 MB clip is referenced, never copied into the document.
 */

export const DECK_FILE = 'deck.json';
export const ASSETS_DIR = 'assets';

/**
 * Extensions a save dialog can plausibly hand us for a *new deck folder*.
 *
 * A deck is a directory with no extension, but the panel returns whatever text
 * is in its name field — and clicking an existing document in the panel's
 * browser copies that document's name, extension and all. Left alone, the
 * result is a folder called `talk.key`, which Launch Services then reports as
 * `com.apple.iwork.keynote.sffkey`: Finder draws it with a Keynote icon and
 * double-clicking it opens Keynote, which cannot read it.
 *
 * Deliberately a fixed list rather than "strip any dotted suffix", so a deck
 * legitimately named `Q3 2026 v1.2` keeps its `.2`.
 */
const PRESENTATION_EXTENSIONS = new Set(['.key', '.keynote', '.pptx', '.ppt', '.pdf', '.deck']);

/**
 * Normalise a path chosen in a save dialog into a deck folder path, dropping a
 * presentation extension the user did not mean to type.
 */
export function deckFolderPath(chosen: string): string {
  const ext = extname(chosen).toLowerCase();
  if (!PRESENTATION_EXTENSIONS.has(ext)) return chosen;
  return chosen.slice(0, -ext.length);
}


const DEFAULT_THEME = `/* Fonts, sizes and colours live here. The editor never rewrites this file. */

.slide {
  background: #ffffff;
  color: #111111;
  font-family: "Helvetica Neue", Inter, system-ui, sans-serif;
}

.element-text {
  font-size: 48px;
  line-height: 1.28;
}

.role-title, .title {
  font-size: 92px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.role-body {
  font-size: 48px;
  line-height: 1.3;
}

.role-caption, .caption {
  font-size: 30px;
  color: #666666;
}
`;

export async function loadDeck(dir: string): Promise<Deck> {
  const raw = await readFile(join(dir, DECK_FILE), 'utf8');
  return parseDeck(JSON.parse(raw));
}

/**
 * Write `deck.json`. Stable 2-space JSON with a trailing newline, so a deck
 * diffs cleanly in git and a load/save round-trip of an untouched deck is a
 * no-op.
 */
export async function saveDeck(dir: string, deck: Deck): Promise<string> {
  const validated = parseDeck(deck);
  await mkdir(dir, { recursive: true });
  const json = `${JSON.stringify(validated, null, 2)}\n`;
  await writeFile(join(dir, DECK_FILE), json, 'utf8');
  // Returned so the caller can recognise the watcher echo of this very write.
  return json;
}

export async function createDeck(dir: string, title?: string): Promise<Deck> {
  await Promise.all([
    mkdir(join(dir, ASSETS_DIR), { recursive: true }),
    mkdir(join(dir, 'edit'), { recursive: true }),
  ]);
  const deck = emptyDeck(title ?? basename(dir));
  await saveDeck(dir, deck);
  await writeFile(join(dir, deck.theme), DEFAULT_THEME, 'utf8');
  return deck;
}

/** Copy a complete deck folder without overwriting an existing destination. */
export async function copyDeck(sourceDir: string, targetDir: string): Promise<Deck> {
  const source = resolve(sourceDir);
  const target = resolve(targetDir);
  if (target === source) throw new Error('Choose a different folder for Save As');
  if (target.startsWith(source + sep)) {
    throw new Error('A saved copy cannot be placed inside the open deck');
  }
  if (existsSync(target)) throw new Error(`A file or folder already exists at ${target}`);

  await cp(source, target, { recursive: true, force: false, errorOnExist: true });
  return loadDeck(target);
}

export async function loadTheme(dir: string, theme: string): Promise<string> {
  const path = join(dir, theme);
  if (!existsSync(path)) return DEFAULT_THEME;
  return readFile(path, 'utf8');
}

export async function saveTheme(
  dir: string,
  theme: string,
  css: string,
): Promise<void> {
  await writeFile(join(dir, theme), css, 'utf8');
}

export function classifyMedia(path: string): 'image' | 'video' | null {
  return classifyMediaName(path);
}

/**
 * Copy a dropped file into `assets/`, then probe it.
 *
 * The destination name is the original stem plus a short content hash. That
 * dedupes re-drops of the same file (common when iterating on a render) while
 * keeping names human-readable in the folder, and it means two different files
 * that happen to share a name never collide.
 */
export async function importAsset(
  deckDir: string,
  sourcePath: string,
  onProgress?: (ratio: number | null) => void,
): Promise<ImportedAsset> {
  const kind = classifyMedia(sourcePath);
  if (!kind) throw new Error(`Unsupported media type: ${basename(sourcePath)}`);

  const assetsDir = join(deckDir, ASSETS_DIR);
  await mkdir(assetsDir, { recursive: true });

  const hash = await hashFile(sourcePath);
  const ext = extname(sourcePath).toLowerCase();
  const stem = sanitize(basename(sourcePath, extname(sourcePath)));
  const name = `${stem}.${hash}${ext}`;
  const dest = join(assetsDir, name);

  if (!existsSync(dest)) await copyFile(sourcePath, dest);

  // Screen recordings are routinely HEVC, which Chromium cannot decode: the
  // element imports but renders as nothing. Transcode on the way in, exactly
  // as the Keynote importer does.
  let finalName = name;
  if (kind === 'video') {
    const codec = await videoCodec(dest);
    if (!isWebSafeCodec(codec)) {
      const converted = `${stem}.${hash}.h264.mp4`;
      const convertedPath = join(assetsDir, converted);
      if (!existsSync(convertedPath)) await transcodeToH264(dest, convertedPath, onProgress);
      finalName = converted;
    }
  }
  const finalPath = join(assetsDir, finalName);

  const info = await probeMedia(finalPath);
  const fallback = ext === '.pdf' ? { width: 1400, height: 1000 } : { width: null, height: null };
  return {
    src: `${ASSETS_DIR}/${finalName}`,
    kind,
    width: info.width ?? fallback.width,
    height: info.height ?? fallback.height,
    duration: info.duration,
  };
}

/** Import image bytes that have no filesystem source, such as a screenshot on
 * the OS clipboard. Content-addressing gives repeated pastes the same asset. */
export async function importImageBuffer(
  deckDir: string,
  data: Uint8Array,
  sourceName: string,
  dimensions: { width: number; height: number },
): Promise<ImportedAsset> {
  const ext = extname(sourceName).toLowerCase();
  if (classifyMediaName(sourceName) !== 'image') {
    throw new Error(`Unsupported image type: ${basename(sourceName)}`);
  }
  const assetsDir = join(deckDir, ASSETS_DIR);
  await mkdir(assetsDir, { recursive: true });
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 8);
  const stem = sanitize(basename(sourceName, extname(sourceName)));
  const name = `${stem}.${hash}${ext}`;
  const dest = join(assetsDir, name);
  if (!existsSync(dest)) await writeFile(dest, data);
  return {
    src: `${ASSETS_DIR}/${name}`,
    kind: 'image',
    width: dimensions.width,
    height: dimensions.height,
    duration: null,
  };
}

/** Name for a derived (trimmed/cropped) file that won't clash with the original. */
export async function derivedAssetPath(
  deckDir: string,
  src: string,
  suffix: string,
  extension = '.mp4',
): Promise<{ absolute: string; relative: string }> {
  const assetsDir = join(deckDir, ASSETS_DIR);
  await mkdir(assetsDir, { recursive: true });
  const stem = sanitize(basename(src, extname(src)));
  const existing = new Set(await readdir(assetsDir).catch(() => []));
  // Trim callers keep the .mp4 default; raster edits opt into .png.
  for (let n = 1; ; n++) {
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    const name = `${stem}.${suffix}${n}${ext}`;
    if (!existing.has(name)) {
      return { absolute: join(assetsDir, name), relative: `${ASSETS_DIR}/${name}` };
    }
  }
}

/** Resolve a deck-relative asset path, refusing anything that escapes the deck. */
export function resolveAsset(deckDir: string, src: string): string {
  const abs = resolve(deckDir, src);
  const root = resolve(deckDir);
  if (abs !== root && !abs.startsWith(root + '/')) {
    throw new Error(`Asset path escapes the deck folder: ${src}`);
  }
  return abs;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset';
}

async function hashFile(path: string): Promise<string> {
  // Whole-file hash: assets are read once on import, and partial hashing would
  // collide across re-encodes that share a header.
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex').slice(0, 8);
}
