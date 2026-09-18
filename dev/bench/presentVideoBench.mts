/**
 * How long a real deck's videos take to start playing when the present view
 * is on the far end of a slow link.
 *
 * Not a test — a measuring instrument for the media-loading work. It serves a
 * real deck folder through the collab server, drives the audience surface in a
 * throttled Chromium, and reports, per slide, how long each video took to show
 * a frame and to actually be playing.
 *
 *   npx vite-node --config vitest.config.ts dev/bench/presentVideoBench.mts -- \
 *     --deck "/home/you/Decks/Some talk/deck" --kbps 5000 --slides 1-12
 *
 * The deck is served through a scratch root of symlinks, so nothing under the
 * real deck folder is ever written to.
 */
import { execFile } from 'node:child_process';
import { copyFile, link, mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startCollabServer, type RunningCollabServer } from '../../src/server/collabServer.js';
import {
  Cdp, electronBinary, findTarget, launchBrowser, stopBrowser, wait,
  type RunningBrowser,
} from '../../test/support/browserSession.js';
import { collabClientDir } from '../../test/support/collabClient.js';

interface Options {
  deck: string;
  kbps: number;
  slides: number[];
  dwellMs: number;
  settleMs: number;
  /** Open each slide in a fresh page instead of walking to it. */
  cold: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string, fallback?: string): string => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1 || i + 1 >= argv.length) {
      if (fallback === undefined) throw new Error(`missing --${name}`);
      return fallback;
    }
    return argv[i + 1];
  };
  const range = get('slides', '1-10');
  const [from, to] = range.includes('-')
    ? range.split('-').map(Number)
    : [Number(range), Number(range)];
  const slides: number[] = [];
  for (let i = from; i <= to; i += 1) slides.push(i);
  return {
    deck: get('deck'),
    kbps: Number(get('kbps', '5000')),
    slides,
    dwellMs: Number(get('dwell', '4000')),
    settleMs: Number(get('settle', '20000')),
    cold: argv.includes('--cold'),
  };
}

interface State {
  slideId: string;
  videos: VideoSample[];
}

interface VideoSample {
  src: string;
  readyState: number;
  currentTime: number;
  paused: boolean;
  buffered: number;
}

const PRESENT_STATE = `(() => ({
  slideId: document.querySelector('[data-slide-id]')?.dataset.slideId ?? '',
  videos: [...document.querySelectorAll('.stage video')].map((v) => ({
  src: v.currentSrc || v.getAttribute('src') || '',
  readyState: v.readyState,
  currentTime: v.currentTime,
  paused: v.paused,
    buffered: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0,
  })),
}))()`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!electronBinary) throw new Error('no Electron binary');
  // Beside the user's cache, not in /tmp: the asset farm below is hard links,
  // and a hard link cannot cross a filesystem. Landing on a different device
  // would silently fall back to copies — new mtimes, so a different rendition
  // cache key, so a benchmark that measures the unprepared deck while
  // reporting the prepared one.
  const benchRoot = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'deckwerk');
  await mkdir(benchRoot, { recursive: true });
  const work = await mkdtemp(join(benchRoot, 'bench-'));
  const decksRoot = join(work, 'decks');
  const deckId = 'bench';
  const deckDir = join(decksRoot, deckId);
  await mkdir(join(deckDir, 'assets'), { recursive: true });

  // Symlinks, never copies: the source deck is the user's own and must not be
  // touched, and its assets are gigabytes.
  for (const name of await readdir(options.deck)) {
    if (name === 'assets') continue;
    const target = join(options.deck, name);
    if (name === 'deck.json' || name.endsWith('.css') || name.endsWith('.json')) {
      await copyFile(target, join(deckDir, name)).catch(() => {});
    } else {
      await symlink(target, join(deckDir, name)).catch(() => {});
    }
  }
  // Hard links, not symlinks: the server resolves an asset path and refuses
  // anything that leaves the deck folder, which a symlink does. Hard links
  // cost nothing, stay inside the folder, and are only ever read.
  for (const name of await readdir(join(options.deck, 'assets'))) {
    const from = join(options.deck, 'assets', name);
    const to = join(deckDir, 'assets', name);
    // A copy would carry a new mtime, which is part of the rendition cache
    // key: the benchmark would then measure an unprepared deck.
    await link(from, to);
  }

  const slideIds: string[] = JSON.parse(
    await readFile(join(options.deck, 'deck.json'), 'utf8'),
  ).slides.map((slide: { id: string }) => slide.id);

  const clientDir = await collabClientDir();
  const server: RunningCollabServer = await startCollabServer({
    rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
  });
  const profileDir = join(work, 'profile');
  await mkdir(profileDir, { recursive: true });
  let browser: RunningBrowser | null = null;
  let page: Cdp | null = null;
  try {
    browser = await launchBrowser('about:blank', profileDir);
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.startsWith('about:blank'),
      browser.log,
    );
    page = await Cdp.connect(target.webSocketDebuggerUrl!);
    await page.call('Network.enable');
    await page.call('Network.emulateNetworkConditions', {
      offline: false,
      latency: 30,
      downloadThroughput: options.kbps * 1000 / 8,
      uploadThroughput: options.kbps * 1000 / 8,
    });

    const first = options.slides[0];
    const url = `http://127.0.0.1:${server.port}/present.html?deck=${deckId}&slide=${first}`;
    const openedAt = Date.now();
    await page.evaluate(`(location.href = ${JSON.stringify(url)}, true)`);

    const rows: string[] = [];
    // Wait for the page to exist at all before timing anything.
    const bootDeadline = Date.now() + 120_000;
    while (Date.now() < bootDeadline) {
      const state = await page.evaluate<{ slideId: string }>(PRESENT_STATE).catch(() => null);
      if (state && state.slideId) break;
      await wait(200);
    }
    rows.push(`open  : ${((Date.now() - openedAt) / 1000).toFixed(1)}s to the first slide painting`);
    if (process.env.BENCH_DEBUG) {
      console.log(await page.evaluate<unknown>(`(() => ({
        playerSlide: document.documentElement.dataset.playerSlide ?? null,
        stages: document.querySelectorAll('.stage').length,
        videosAnywhere: document.querySelectorAll('video').length,
        videosInStage: document.querySelectorAll('.stage video').length,
        body: document.body.innerHTML.slice(0, 300),
      }))()`));
    }

    const press = async (): Promise<void> => {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await page!.call('Input.dispatchKeyEvent', {
          type, key: 'ArrowRight', code: 'ArrowRight',
          windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39,
        });
      }
    };

    for (const slide of options.slides) {
      // Arrow keys walk build steps as well as slides, so advance until the
      // player reports the slide we are actually measuring.
      const wantId = slideIds[slide - 1];
      // Cold: what a presenter gets when they click Present and land here,
      // with nothing warmed and nothing cached.
      if (options.cold) {
        await page.evaluate(`(location.href = ${JSON.stringify(
          `http://127.0.0.1:${server.port}/present.html?deck=${deckId}&slide=`,
        )} + ${slide}, true)`);
        const boot = Date.now() + 60_000;
        for (;;) {
          const probe = await page.evaluate<State>(PRESENT_STATE).catch(() => null);
          if (probe?.slideId === wantId || Date.now() > boot) break;
          await wait(100);
        }
      }
      const walkDeadline = Date.now() + 60_000;
      let state = await page.evaluate<State>(PRESENT_STATE);
      while (state.slideId !== wantId && Date.now() < walkDeadline) {
        await press();
        await wait(120);
        state = await page.evaluate<State>(PRESENT_STATE);
      }
      if (state.slideId !== wantId) {
        rows.push(`slide ${slide}: never reached (player on ${slideIds.indexOf(state.slideId) + 1})`);
        continue;
      }
      const enteredAt = Date.now();
      const firstFrame = new Map<string, number>();
      const playing = new Map<string, number>();
      const startTimes = new Map<string, number>();
      const last = new Map<string, VideoSample>();
      const deadline = Date.now() + options.settleMs;
      while (Date.now() < deadline) {
        state = await page.evaluate<State>(PRESENT_STATE)
          .catch(() => ({ slideId: wantId, videos: [] as VideoSample[] }));
        for (const sample of state.videos) {
          const key = basename(sample.src);
          last.set(key, sample);
          if (!startTimes.has(key)) startTimes.set(key, sample.currentTime);
          if (!firstFrame.has(key) && sample.readyState >= 2) {
            firstFrame.set(key, Date.now() - enteredAt);
          }
          if (!playing.has(key)
            && !sample.paused
            && sample.currentTime - (startTimes.get(key) ?? 0) > 0.15) {
            playing.set(key, Date.now() - enteredAt);
          }
        }
        if (state.videos.length > 0 && playing.size >= state.videos.length) break;
        await wait(100);
      }
      if (last.size === 0) {
        rows.push(`slide ${String(slide).padStart(3)}  (no videos)`);
      }
      for (const [key, sample] of last) {
        const frame = firstFrame.get(key);
        const play = playing.get(key);
        const stamp = (value: number | undefined): string =>
          (value === undefined ? 'never' : `${(value / 1000).toFixed(1)}s`).padStart(6);
        rows.push([
          `slide ${String(slide).padStart(3)}`,
          `${stamp(frame)} frame`,
          `${stamp(play)} playing`,
          `rs=${sample.readyState} buf=${sample.buffered.toFixed(1)}s`,
          key.slice(0, 46),
        ].join('  '));
      }
      await wait(options.dwellMs);
    }
    console.log(`\n=== ${options.kbps} kbit/s, ${basename(options.deck)} ===`);
    for (const row of rows) console.log(row);
  } finally {
    page?.close();
    await stopBrowser(browser?.process ?? null);
    await server.close();
    if (existsSync(work)) await rm(work, { recursive: true, force: true });
  }
}

void main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
