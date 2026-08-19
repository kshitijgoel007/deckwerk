import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Deck, emptyDeck, parseDeck } from '@shared/deck.js';
import type { ImportedAsset } from '@shared/ipc.js';
import { classifyMediaName } from '@shared/media.js';
import { isWebSafeCodec, probeMedia, transcodeToH264, videoCodec } from './ffmpeg.js';

/**
 * Reading and writing deck folders.
 *
 * A deck is a directory, not a file: `deck.json` (content and geometry),
 * `theme.css` (typography and colour, hand-edited), `assets/` (media), and an
 * optional `agent-chats.json` sidecar managed by the embedded Agent panel.
 * Keeping media as real files on disk rather than embedded data is what makes
 * video practical — a 200 MB clip is referenced, never copied into the document.
 */

export const DECK_FILE = 'deck.json';
export const ASSETS_DIR = 'assets';
export const AGENT_GUIDE_FILE = 'AGENTS.md';


const DEFAULT_THEME = `/* Fonts, sizes and colours live here. The editor never rewrites this file. */

.slide {
  background: #ffffff;
  color: #111111;
  font-family: "Helvetica Neue", Inter, system-ui, sans-serif;
}

.element-text {
  font-size: 44px;
  line-height: 1.25;
}

.role-title, .title {
  font-size: 92px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.role-body {
  font-size: 44px;
  line-height: 1.3;
}

.role-caption, .caption {
  font-size: 28px;
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
  await mkdir(join(dir, ASSETS_DIR), { recursive: true });
  const deck = emptyDeck(title ?? basename(dir));
  await saveDeck(dir, deck);
  await writeFile(join(dir, deck.theme), DEFAULT_THEME, 'utf8');
  await ensureAgentGuide(dir);
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
  const deck = await loadDeck(target);
  await ensureAgentGuide(target);
  return deck;
}

/**
 * Leave a short brief for coding agents in the deck folder.
 *
 * Agent CLIs read `AGENTS.md` from their working directory, and their working
 * directory is the deck — not this repository, where the real guide lives. So
 * every deck gets a stub that points at `slide-agent docs`, which is how an
 * agent finds the format and the transaction contract without being told where
 * the editor is installed.
 *
 * Never overwrites: once the file exists it belongs to the user, who may well
 * have added their own notes about the talk to it.
 */
export async function ensureAgentGuide(dir: string): Promise<boolean> {
  // The guide's first instruction is to write into `edit/`; the folder must
  // exist by then, or every agent's first save is a failed redirect.
  await mkdir(join(dir, 'edit'), { recursive: true });
  const path = join(dir, AGENT_GUIDE_FILE);
  if (existsSync(path)) return false;
  await writeFile(path, await agentGuideStub(), 'utf8');
  return true;
}

async function agentGuideStub(): Promise<string> {
  // A checkout has the launcher next to it; a packaged app does not ship the
  // dev CLI at all, so the absolute-path hint is offered only when it is real.
  const launcher = fileURLToPath(new URL('../../bin/slide-agent', import.meta.url));
  const fallback = existsSync(launcher)
    ? `\nIf \`slide-agent\` is not on your PATH, it is at:\n\n    ${launcher}\n`
    : '';

  // The brief's text lives in docs/deck-brief.md so the Keynote importer (a
  // Python process with no access to this module) writes the identical brief.
  // The inline fallback keeps deck creation working in a packaged app that
  // did not ship the docs folder.
  try {
    const canonical = await readFile(
      fileURLToPath(new URL('../../docs/deck-brief.md', import.meta.url)), 'utf8');
    return canonical.replace('{{LAUNCHER_HINT}}', fallback);
  } catch {
    return `# Working on this deck

Author slides through the \`slide-agent\` CLI from this folder. Start with
\`slide-agent docs\` for the full guide; the loop is \`context\` →
\`inspect --html\` → edit the file in \`edit/\` → save (editor open) or
\`apply\` (editor closed). Never edit \`deck.json\`.
${fallback}`;
  }
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
