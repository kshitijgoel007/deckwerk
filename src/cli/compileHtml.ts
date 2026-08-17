import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Deck, Slide } from '@shared/deck.js';
import {
  authoringPageHtml,
  measureSlidesSource,
  measureTextOverflowsSource,
  type TextOverflow,
} from '@shared/htmlMeasure.js';
import { PLAYER_TYPE_CSS } from '@shared/playerTypeCss.js';
import { slidesFromMeasured, slidesToHtml, type MeasuredSlide } from '@shared/htmlSlides.js';
import { loadTheme } from '../main/deckStore.js';

/**
 * Compile authored HTML into deck slides with the editor closed.
 *
 * This is the offline half: a headless Electron window lays the page out and
 * reports what it measured. When the editor *is* open its own renderer does the
 * same work in an iframe — same page, same walk, no extra process — so this
 * path exists for `slide-agent apply --html` and for tests, not for the
 * everyday save-and-watch loop.
 */

const COMPILE_TIMEOUT_MS = 60_000;

export interface CompileRequest {
  deckDir: string;
  deck: Deck;
  htmlPath: string;
}

export interface CompiledHtml {
  slides: Slide[];
  /** Inline style the browser silently dropped; see `MeasuredSlide.warnings`. */
  warnings: string[];
}

export async function compileHtmlToSlides(request: CompileRequest): Promise<CompiledHtml> {
  const authored = await readFile(request.htmlPath, 'utf8');
  const work = await mkdtemp(join(tmpdir(), 'slide-agent-compile-'));
  const pagePath = join(work, 'page.html');

  const theme = await loadTheme(request.deckDir, request.deck.theme);
  await writeFile(
    pagePath,
    authoringPageHtml({
      authored,
      typeCss: PLAYER_TYPE_CSS,
      theme,
      themeHref: request.deck.theme,
      canvas: request.deck.canvas,
      base: pathToFileURL(`${request.deckDir}/`).href,
    }),
    'utf8',
  );

  const [measured] = await runPages([pagePath], request.deck.canvas) as MeasuredSlide[][];
  return {
    slides: slidesFromMeasured(request.deck, measured),
    warnings: measured.flatMap((slide) => slide.warnings ?? []),
  };
}

/**
 * Whether each compiled slide's text still fits once it is *built*.
 *
 * The compile above measures the author's markup; this renders what the deck
 * will actually show — the same export `inspect --html` produces, boxes fixed
 * and the auto-fit script aboard — and reports every text element whose
 * content spills past its box. That is the difference an agent cannot see in
 * the transaction itself: a fitted box that a theme or font change has pushed
 * into clipping.
 */
export async function measureBuiltTextOverflows(
  deckDir: string,
  deck: Deck,
  slides: Slide[],
): Promise<TextOverflow[]> {
  if (slides.length === 0) return [];
  const work = await mkdtemp(join(tmpdir(), 'slide-agent-overflow-'));
  const pagePath = join(work, 'built.html');
  await writeFile(
    pagePath,
    slidesToHtml(slides, deck.canvas, {
      typeCss: PLAYER_TYPE_CSS,
      // The page sits in a temp folder, so assets and theme.css resolve
      // against the deck itself.
      base: pathToFileURL(`${deckDir}/`).href,
      theme: deck.theme,
    }),
    'utf8',
  );
  const [overflows] = await runPages([pagePath], deck.canvas, measureTextOverflowsSource());
  return overflows as TextOverflow[];
}

/**
 * Measure a page exactly as it sits on disk: its own URL, its own `<base>`,
 * nothing assembled and nothing rewritten.
 *
 * This is what the author's browser does when they double-click the file, and
 * it is the only way to check that the two agree. Everything else here goes
 * through `authoringPageHtml`, which retargets the base — useful in production,
 * and precisely what would hide an export that only works because the compiler
 * repaired it on the way in.
 */
export async function measureSavedPage(
  pagePath: string,
  canvas: { w: number; h: number },
  script?: string,
): Promise<unknown> {
  const [result] = await runPages([pagePath], canvas, script);
  return result;
}

/**
 * The same, for many pages at once. One browser, one launch: measuring a deck
 * a page at a time otherwise spends most of its time starting Electron.
 */
export async function measureSavedPages(
  pagePaths: string[],
  canvas: { w: number; h: number },
  script?: string,
): Promise<unknown[]> {
  return runPages(pagePaths, canvas, script);
}

/** Hand a list of pages to the offscreen browser and collect what it measured. */
async function runPages(
  pages: string[],
  canvas: { w: number; h: number },
  script: string = measureSlidesSource(),
): Promise<unknown[]> {
  const work = await mkdtemp(join(tmpdir(), 'slide-agent-measure-'));
  const outPath = join(work, 'measured.json');
  const jobPath = join(work, 'job.json');
  // The walk travels with the job: the runner is a bundler-less Electron
  // script, so handing it the source is what keeps one implementation shared
  // with the live renderer.
  await writeFile(jobPath, JSON.stringify({ pages, outPath, canvas, script }), 'utf8');
  await runElectron(compilerScript(), jobPath);
  return (JSON.parse(await readFile(outPath, 'utf8')) as { results: unknown[] }).results;
}

function compilerScript(): string {
  return fileURLToPath(new URL('../../scripts/compile-slides.cjs', import.meta.url));
}

function runElectron(script: string, jobPath: string): Promise<string> {
  const electron = createRequire(import.meta.url)('electron') as unknown as string;
  if (!existsSync(electron)) throw new Error(`Electron is not installed at ${electron}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(electron, [script, jobPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => {
      err += chunk;
      if (process.env.SLIDE_AGENT_DEBUG === '1') process.stderr.write(String(chunk));
    });
    // A child that fails before installing its own handlers — a syntax error
    // in the compiler, a window that never loads — keeps Electron alive with
    // nothing to do, and the CLI would wait on it forever.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`HTML compile timed out after ${COMPILE_TIMEOUT_MS / 1000}s.\n${err.trim()}`));
    }, COMPILE_TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out);
      else reject(new Error(err.trim() || `HTML compile failed with exit code ${code}`));
    });
  });
}
