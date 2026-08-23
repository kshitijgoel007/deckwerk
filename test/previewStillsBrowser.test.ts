import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'vite';
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
  type RunningBrowser,
} from './support/browserSession.js';

/**
 * Preview surfaces must show a picture that cannot be taken away.
 *
 * Reported three times over one deck (rhoda_intro_2: five slides, one clip
 * across sixteen elements): rail thumbnails and Magic Move previews show black
 * rectangles. Scrolling the rail away and back brings them back black; so does
 * presenting and closing the presentation. The cause is that a `<video>` paints
 * nothing until a frame is decoded, and the decoded frames of a page that is
 * hidden, occluded, or holding many media players are Chromium's to reclaim —
 * a fullscreen presentation overlay with its own playing clips is exactly that
 * pressure. Nothing then re-decodes, because the poster-frame seek is a `once`
 * listener that already fired.
 *
 * A thumbnail never plays, so it does not need an element that can lose its
 * picture: previews are captured stills (previewPoster.ts). This test drives
 * the real editor over a throttled link and asserts the property that makes
 * the bug impossible — every preview is a painted `<img>`, no preview `<video>`
 * is left on the page, and presenting changes neither.
 */

const execFileAsync = promisify(execFile);
const DECK_ID = 'preview-stills';
const CLIP = 'assets/loop.05a38d7a.mp4';

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

/** One clip through four presentations, the way a Keynote import lands. */
function videos(slide: number): SlideElement[] {
  const common = {
    type: 'video' as const, y: 560, w: 420, h: 420, rot: 0, z: 2, opacity: 1,
    class: [], style: {}, src: CLIP, fit: 'contain' as const,
    autoplay: false, loop: true, muted: true, controls: false,
    end: null, poster: null,
  };
  return [
    { ...common, id: `a${slide}`, x: 60, start: 0, sourceBox: null },
    { ...common, id: `b${slide}`, x: 520, start: 3, sourceBox: null },
    {
      ...common, id: `c${slide}`, x: 980, start: 0,
      sourceBox: { x: 0, y: -240, w: 820, h: 900 },
    },
    { ...common, id: `d${slide}`, x: 1440, start: 6, sourceBox: null },
  ] as SlideElement[];
}

interface Survey {
  stills: number;
  paintedStills: number;
  previewVideos: number;
  canvasVideos: number;
}

describe.skipIf(!electronBinary || !ffmpeg)('preview surfaces show stills', () => {
  it('paints every thumbnail, and presenting cannot black them out', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'preview-stills-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = join(workDir, 'client');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await mkdir(profileDir, { recursive: true });

    await execFileAsync(ffmpeg, [
      '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=480x480:rate=24',
      '-t', '10', '-an', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-b:v', '1M',
      join(deckDir, 'assets', 'loop.05a38d7a.mp4'),
    ]);

    const deck = emptyDeck('Preview stills');
    const base = deck.slides[0];
    deck.slides = [0, 1, 2, 3].map((i) => ({
      ...base,
      id: `stills-${i}`,
      elements: [
        {
          id: `t${i}`, type: 'text',
          x: 160, y: 160, w: 1600, h: 160, rot: 0, z: 1, opacity: 1,
          class: ['role-title'], style: {}, html: `SLIDE ${i + 1}`,
          align: 'center', valign: 'middle',
        } as SlideElement,
        ...videos(i),
      ],
    }));
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #ffffff; color: #101010; }',
      '.element-text { font: 700 64px/1.15 sans-serif; }',
      '',
    ].join('\n'), 'utf8');

    await build({
      configFile: join(process.cwd(), 'vite.collab.config.ts'),
      logLevel: 'silent',
      build: { outDir: clientDir, emptyOutDir: true },
    });
    server = await startCollabServer({
      rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
    });

    browser = await launchBrowser('about:blank', profileDir);
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.startsWith('about:blank'),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    // Throttled: sixteen elements fetching one clip is the state the bug was
    // reported in, and it is the state where a still has to pay for itself.
    await editor.call('Network.enable');
    await editor.call('Network.emulateNetworkConditions', {
      offline: false, latency: 60,
      downloadThroughput: 700_000, uploadThroughput: 700_000,
    });
    await editor.evaluate(`(location.href = ${JSON.stringify(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Stills%20Test`,
    )}, true)`);

    await eventually(async () => editor!.evaluate<number>(
      `document.querySelectorAll('.rail-item').length`,
    ), 'the rail never listed the fixture slides', (count) => count === 4, 60_000);

    const survey = () => editor!.evaluate<Survey>(`(() => {
      const stills = [...document.querySelectorAll('img[data-preview-still]')];
      const previewVideo = (video) =>
        video.closest('.rail-thumb') || video.closest('.magic-preview');
      const all = [...document.querySelectorAll('video')];
      return {
        stills: stills.length,
        paintedStills: stills.filter((img) => img.complete && img.naturalWidth > 0).length,
        previewVideos: all.filter(previewVideo).length,
        canvasVideos: all.filter((video) => video.closest('#canvas')).length,
      };
    })()`);

    // Sixteen rail elements plus the Magic Move panel's two previews.
    const settled = await eventually(
      survey,
      'the previews never became painted stills',
      (state) => state.stills >= 16 && state.paintedStills === state.stills
        && state.previewVideos === 0,
      90_000,
    );
    expect(settled.previewVideos, 'a preview kept a video that could go black').toBe(0);

    /* --- present, then come back ----------------------------------------- */

    const clicked = await editor.evaluate<boolean>(`(() => {
      const button = [...document.querySelectorAll('#toolbar button')]
        .find((candidate) => candidate.textContent?.trim() === 'Present');
      button?.click();
      return Boolean(button);
    })()`);
    expect(clicked).toBe(true);
    await eventually(async () => editor!.evaluate<boolean>(`(() => {
      const doc = document.querySelector('iframe')?.contentDocument;
      return Boolean(doc?.querySelector('.slide'));
    })()`), 'the presentation stayed blank', Boolean, 60_000);

    // Close it the way the present view asks the shell to.
    await editor.evaluate(`(() => {
      window.postMessage({ type: 'present-exit' }, location.origin);
      return true;
    })()`);
    await eventually(async () => editor!.evaluate<boolean>(
      `!document.querySelector('iframe')`,
    ), 'the presentation overlay never closed', Boolean, 30_000);

    // The reported symptom: black thumbnails after closing a presentation.
    const after = await survey();
    expect(after.stills, 'previews were lost while presenting')
      .toBeGreaterThanOrEqual(settled.stills);
    expect(after.paintedStills, 'a preview came back without a picture')
      .toBe(after.stills);
    expect(after.previewVideos, 'a preview came back as a video').toBe(0);
  }, 300_000);
});

describe.skipIf(electronBinary && ffmpeg)('preview surfaces show stills (skipped)', () => {
  it('needs Electron and ffmpeg', () => {
    expect(!electronBinary || !ffmpeg).toBe(true);
  });
});
