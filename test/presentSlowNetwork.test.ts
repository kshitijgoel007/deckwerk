import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  wait,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * Presenting over a slow network — the collab server on a remote machine, a
 * deck that reuses one sizeable clip across many elements. Everything here is
 * a regression that shipped at least once:
 *
 *  1. Clicking Present showed a black screen. The editor's rail thumbnails
 *     and canvas each mounted a fetching <video>; together they held all six
 *     of the origin's connections, and the present view's HTML and bundle
 *     (served `no-store` back then, so never cached either) sat in the queue
 *     behind them. Closing the presentation, waiting, and clicking Present a
 *     second time worked — which is exactly the bug report.
 *  2. Slide transitions started every video from byte zero (nothing warms the
 *     next slide's files, and elements are rebuilt per slide).
 *  3. Navigating forward and then back showed videos that never loaded again:
 *     each transition discarded the old elements without aborting their
 *     fetches, so a few round trips accumulated enough orphaned downloads to
 *     starve the visible slide's own videos indefinitely.
 *
 * The throttle is CDP's network emulation: 500 KB/s, 40 ms latency — a
 * plausible remote link, slow enough that the ~5 MB fixture clip takes ~10 s,
 * fast enough for the suite. The regressions all reproduce as *ordering*
 * failures (media starving control resources), so the assertions are about
 * what the audience can see and when, not about byte counts.
 */

const execFileAsync = promisify(execFile);
const DECK_ID = 'slow-network';
const TITLE = ['SLOW ONE', 'SLOW TWO', 'SLOW THREE'];

const ffmpeg = (() => {
  try {
    return createRequire(import.meta.url)('ffmpeg-static') as string;
  } catch {
    return '';
  }
})();

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

function video(id: string, x: number): SlideElement {
  return {
    id, type: 'video',
    x, y: 420, w: 520, h: 300, rot: 0, z: 2, opacity: 1,
    class: [], style: {},
    src: 'assets/silent.05a38d7a.mp4',
    fit: 'contain',
    autoplay: true, loop: true, muted: true, controls: false,
    start: 0, end: null, poster: null, sourceBox: null,
  } as SlideElement;
}

function title(id: string, html: string): SlideElement {
  return {
    id, type: 'text',
    x: 160, y: 120, w: 1600, h: 160, rot: 0, z: 1, opacity: 1,
    class: ['role-title'], style: {}, html,
    align: 'center', valign: 'middle',
  } as SlideElement;
}

const PRESENT_DOC = `(() => {
  const frame = document.querySelector('iframe[src*="present.html"]');
  return frame && frame.contentDocument ? frame : null;
})()`;

describe.skipIf(!electronBinary || !ffmpeg)('presenting over a slow network', () => {
  it('paints promptly, and videos survive forward-and-back navigation', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'present-slow-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await mkdir(profileDir, { recursive: true });

    // A ~5 MB synthetic clip (deliberately sizeable: the bug class only shows
    // when video bytes take real time), named like an imported asset so the
    // server treats it as content-hashed and immutable.
    await execFileAsync(ffmpeg, [
      '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
      '-t', '20', '-an', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-b:v', '2M',
      join(deckDir, 'assets', 'silent.05a38d7a.mp4'),
    ]);

    // Three slides sharing the clip, two elements each: the rhoda_intro_2
    // shape scaled down. The rail alone mounts six video elements at boot.
    const deck = emptyDeck('Slow network');
    const base = deck.slides[0];
    deck.slides = TITLE.map((text, i) => ({
      ...base,
      id: `slow-${i}`,
      elements: [title(`t${i}`, text), video(`v${i}a`, 160), video(`v${i}b`, 900)],
    }));
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #ffffff; color: #101010; }',
      '.element-text { font: 700 64px/1.15 sans-serif; }',
      '',
    ].join('\n'), 'utf8');

    server = await startCollabServer({
      rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
    });

    // Launch on about:blank so the throttle is in force before the editor
    // makes its first request — the whole point is a slow first load.
    browser = await launchBrowser('about:blank', profileDir);
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.startsWith('about:blank'),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await editor.call('Network.enable');
    await editor.call('Network.emulateNetworkConditions', {
      offline: false,
      latency: 40,
      downloadThroughput: 500_000,
      uploadThroughput: 500_000,
    });
    await editor.evaluate(`(location.href = ${JSON.stringify(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Slow%20Test`,
    )}, true)`);

    await eventually(async () => editor!.evaluate<number>(
      `window.store?.get()?.deck?.slides?.length ?? 0`,
    ), 'the editor never loaded the fixture deck', (slides) => slides === 3, 60_000);

    /* --- the editor rations its video connections ------------------------- */

    // Rail + canvas mount many video elements for this deck. The gate must
    // keep media from occupying every connection the present view will need,
    // so the number of videos *actively fetching* (NETWORK_LOADING) has to
    // stay small. The preload attribute is not the measure — a finished or
    // aborted element keeps whatever hint it was promoted to. And a single
    // sample is not the measure either: a freshly mounted preload="none"
    // element reports NETWORK_LOADING for a task or two before Chromium defers
    // its load, so on a busy machine one snapshot can catch a whole slide of
    // them mid-deferral. A genuine violation — ungated elements transferring a
    // 5 MB file at 500 KB/s — stays high for many seconds, so the *minimum*
    // across spaced samples separates the two cleanly.
    let leastFetching = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < 5; sample += 1) {
      const fetching = await editor.evaluate<number>(`(() => {
        return [...document.querySelectorAll('video')]
          .filter((v) => v.networkState === HTMLMediaElement.NETWORK_LOADING).length;
      })()`);
      leastFetching = Math.min(leastFetching, fetching);
      await wait(150);
    }
    expect(leastFetching, 'too many preview videos fetching at once').toBeLessThanOrEqual(4);

    /* --- Present paints while video bytes are still in flight ------------- */

    await editor!.clickByText('#toolbar button', 'Present', 'Present');
    const clickedAt = Date.now();

    await eventually(async () => editor!.evaluate<boolean>(`(() => {
      const frame = ${PRESENT_DOC};
      const doc = frame && frame.contentDocument;
      return Boolean(doc?.querySelector('.slide'))
        && doc.body.textContent.includes(${JSON.stringify(TITLE[0])});
    })()`), 'the presentation stayed blank', Boolean, 20_000);
    // Generous, but the regression is an order of magnitude worse: with media
    // hogging every connection and a no-store bundle, first paint took as
    // long as the whole deck's video transfer.
    expect(Date.now() - clickedAt, 'Present took too long to show the slide')
      .toBeLessThan(15_000);

    /* --- forward fast, then back: videos must come back ------------------- */

    const key = async (name: 'ArrowRight' | 'ArrowLeft') => {
      const code = name === 'ArrowRight' ? 39 : 37;
      for (const type of ['rawKeyDown', 'keyUp']) {
        await editor!.call('Input.dispatchKeyEvent', {
          type, key: name, code: name,
          windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
        });
      }
    };
    // Two rapid round trips — the presenter skimming while nothing has
    // finished loading. Under the old code every
    // transition orphaned in-flight fetches and restarted the rest from byte
    // zero; by the second trip the visible slide's videos starved.
    for (const step of [
      'ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft',
      'ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft',
    ] as const) {
      await key(step);
      await wait(250);
    }

    // Back on slide one. Its videos must reach a paintable frame and the
    // loading pill must clear — "a progress sign forever" is the bug report.
    const settled = await eventually(async () => editor!.evaluate<{
      onFirstSlide: boolean; videos: number[]; pill: boolean;
    }>(`(() => {
      const doc = ${PRESENT_DOC}.contentDocument;
      return {
        onFirstSlide: doc.body.textContent.includes(${JSON.stringify(TITLE[0])}),
        videos: [...doc.querySelectorAll('video')].map((v) => v.readyState),
        pill: Boolean(doc.querySelector('.video-loading-pill')),
      };
    })()`), 'videos never recovered after navigating back', (state) =>
      state.onFirstSlide
      && state.videos.length === 2
      && state.videos.every((readyState) => readyState >= 2)
      && !state.pill,
    30_000);
    expect(settled.videos.length).toBe(2);
  }, 240_000);
});

describe.skipIf(electronBinary && ffmpeg)('presenting over a slow network (skipped)', () => {
  it('needs Electron and ffmpeg', () => {
    expect(!electronBinary || !ffmpeg).toBe(true);
  });
});
