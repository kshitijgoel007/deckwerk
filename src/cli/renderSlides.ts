import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  selectedElementIds: string[];
}

export interface RenderedImage {
  slideId: string;
  number: number;
  path: string;
}

export async function renderSlidesToPng(request: RenderRequest): Promise<RenderedImage[]> {
  const bundleDir = await tempDir('slide-agent-bundle-');
  await exportDeck(request.deckDir, request.deck, bundleDir);

  const jobPath = join(bundleDir, 'capture-job.json');
  await writeFile(jobPath, JSON.stringify({
    bundleDir,
    outDir: request.outDir,
    slides: request.slides,
    canvas: request.deck.canvas,
    annotate: request.annotate,
    built: request.built,
    selectedElementIds: request.selectedElementIds,
    // SLIDE_AGENT_DEBUG=1 keeps the capture's own diagnostics on stderr, which
    // is the only way to see inside a headless render that came out wrong.
    debug: process.env.SLIDE_AGENT_DEBUG === '1',
  }), 'utf8');

  const stdout = await runElectron(captureScript(), jobPath);
  const parsed = JSON.parse(stdout) as { images: RenderedImage[] };
  return parsed.images;
}

function captureScript(): string {
  return join(process.cwd(), 'scripts', 'capture-slides.cjs');
}

function electronBinary(): string {
  // Resolved lazily and through `require`: the `electron` package exports the
  // path to its executable, which is only meaningful outside Electron itself.
  return createRequire(import.meta.url)('electron') as unknown as string;
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
