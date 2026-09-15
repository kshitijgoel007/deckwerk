import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Deck } from '@shared/deck.js';
import { exportDeck } from '../main/exportDeck.js';
import { tempDir } from './agentCli.js';

/**
 * Optional PNGs of slides, captured from the shared presentation renderer.
 *
 * The deck is exported to a scratch bundle and then screenshotted by Electron
 * running `scripts/capture-slides.cjs`. That indirection is the point: the
 * capture loads the same Player the app and the projector use, so a screenshot
 * cannot disagree with what a human would see.
 */

export interface RenderRequest {
  deckDir: string;
  deck: Deck;
  outDir: string;
  slides: Array<{ id: string; number: number }>;
  annotate: boolean;
  /** Fire every build, so the capture shows the finished slide. */
  built: boolean;
  /** Also compose one tiled, numbered overview of every captured slide. */
  contactSheet?: boolean;
  selectedElementIds: string[];
  /**
   * An already exported bundle of this deck to capture from, instead of
   * exporting a scratch copy. A web export that wants a thumbnail of itself
   * has just written one; copying a gigabyte of media again for a screenshot
   * would be absurd.
   */
  bundleDir?: string;
}

export interface RenderedImage {
  slideId: string;
  number: number;
  path: string;
}

export interface RenderResult {
  images: RenderedImage[];
  /** Path of the tiled overview, when one was requested. */
  contactSheet: string | null;
}

export async function renderSlidesToPng(request: RenderRequest): Promise<RenderResult> {
  let bundleDir = request.bundleDir;
  if (!bundleDir) {
    bundleDir = await tempDir('slide-agent-bundle-');
    await exportDeck(request.deckDir, request.deck, bundleDir);
  }

  // The job file lives with the captures, never in a caller's bundle: a web
  // export handed in here is the folder the author is about to publish.
  await mkdir(request.outDir, { recursive: true });
  const jobPath = join(request.outDir, 'capture-job.json');
  await writeFile(jobPath, JSON.stringify({
    bundleDir,
    outDir: request.outDir,
    slides: request.slides,
    canvas: request.deck.canvas,
    annotate: request.annotate,
    built: request.built,
    contactSheet: request.contactSheet ?? false,
    selectedElementIds: request.selectedElementIds,
    // SLIDE_AGENT_DEBUG=1 keeps the capture's own diagnostics on stderr, which
    // is the only way to see inside a headless render that came out wrong.
    debug: process.env.SLIDE_AGENT_DEBUG === '1',
  }), 'utf8');

  const stdout = await runElectron(captureScript(), jobPath);
  const parsed = JSON.parse(stdout) as { images: RenderedImage[]; contactSheet?: string | null };
  return { images: parsed.images, contactSheet: parsed.contactSheet ?? null };
}

function captureScript(): string {
  // Resolved from this module, not from the cwd: the CLI is normally run from
  // the deck folder, which is not this repository.
  return fileURLToPath(new URL('../../scripts/capture-slides.cjs', import.meta.url));
}

function electronBinary(): string {
  // Inside Electron (the editor spawning a capture for a workflow) the
  // `electron` module is the API object, not a path — but the running binary
  // itself is the Electron we want.
  if (process.versions.electron) return process.execPath;
  // Resolved lazily and through `require`: the `electron` package exports the
  // path to its executable, which is only meaningful outside Electron itself.
  return createRequire(import.meta.url)('electron') as unknown as string;
}

/**
 * Load a web page headlessly the way a web element shows it and report what a
 * PNG cannot: console errors, overflow, network dependence, bridge use.
 */
export async function checkWebPage(request: {
  pagePath: string;
  width: number;
  height: number;
  screenshot?: string | null;
}): Promise<WebPageCheck> {
  const dir = await tempDir('slide-agent-web-check-');
  const jobPath = join(dir, 'check-job.json');
  await writeFile(jobPath, JSON.stringify({ ...request, settleMs: 800 }), 'utf8');
  const script = fileURLToPath(new URL('../../scripts/check-web-page.cjs', import.meta.url));
  return JSON.parse(await runElectron(script, jobPath)) as WebPageCheck;
}

export interface WebPageCheck {
  ok: boolean;
  problems: string[];
  page: Record<string, unknown>;
  console: Array<{ level: string; message: string; line: number; source: string }>;
  remoteRequests: string[];
  screenshot: string | null;
}

function runElectron(script: string, jobPath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(electronBinary(), [script, jobPath], {
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
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && out.trim()) resolvePromise(out);
      else reject(new Error(err.trim() || `Slide capture failed with exit code ${code}`));
    });
  });
}
