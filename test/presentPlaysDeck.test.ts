import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
 * The most elementary promise the app makes: clicking Present shows the deck,
 * and the videos on it actually play.
 *
 * Nothing covered this. `exportLooksLikeSlide` compares an export against the
 * Player and `pdfLooksLikePlayer` compares print pages against it, but no test
 * drove the real Present control and looked at what the audience gets -- so a
 * presentation could come up blank, or come up with every clip frozen on a
 * black frame, and the suite stayed green.
 *
 * Two things make this test see what a viewer sees rather than what the DOM
 * claims:
 *
 *   - Playback is asserted by watching `currentTime` advance, not by reading
 *     `paused`. A video can report itself playing and still be stuck.
 *   - "Not black" is asserted by drawing the frame to a canvas and measuring
 *     the pixels. A <video> with no decoded frame paints as a black rectangle,
 *     at the right size, with its border intact -- indistinguishable from a
 *     working video by any structural check.
 *
 * The fixture clip is deliberately stripped of its audio track. Chromium
 * suspends muted, audio-less video it considers background "to save power",
 * which rejects the in-flight play() with an AbortError; that is the exact
 * shape of clip a deck of silent figure animations is made of.
 */

const execFileAsync = promisify(execFile);
const DECK_ID = 'present-plays';
const TITLE_MARKER = 'PRESENT PLAYS THE DECK';
const VIDEO_ID = 'silent-clip';
const SECOND_VIDEO_ID = 'silent-clip-copy';

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
    src: 'assets/silent.mp4',
    fit: 'contain',
    autoplay: true, loop: true, muted: true, controls: false,
    start: 0, end: null, poster: null, sourceBox: null,
  } as SlideElement;
}

/** Read the present view through the editor tab: it is mounted in an iframe. */
const PRESENT_DOC = `(() => {
  const frame = document.querySelector('iframe[src*="present.html"]');
  return frame && frame.contentDocument ? frame : null;
})()`;

describe.skipIf(!electronBinary || !ffmpeg)('presenting the deck', () => {
  it('paints the slide and actually plays its videos', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'present-plays-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = join(workDir, 'client');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await mkdir(profileDir, { recursive: true });

    // An audio-less clip: the shape Chromium suspends as background media.
    await copyFile(
      join(process.cwd(), 'decks/agent-reference/assets/testclip.mp4'),
      join(workDir, 'source.mp4'),
    );
    await execFileAsync(ffmpeg, [
      '-loglevel', 'error', '-y',
      '-i', join(workDir, 'source.mp4'),
      '-an', '-c:v', 'copy',
      join(deckDir, 'assets', 'silent.mp4'),
    ]);

    const deck = emptyDeck('Present plays the deck');
    deck.slides[0].elements.push({
      id: 'title', type: 'text',
      x: 160, y: 120, w: 1600, h: 160, rot: 0, z: 1, opacity: 1,
      class: ['role-title'], style: {}, html: TITLE_MARKER,
      align: 'center', valign: 'middle',
    } as SlideElement);
    // Two elements sharing one file: the case where continuity between slides
    // has to pick the right element rather than the first one painted.
    deck.slides[0].elements.push(video(VIDEO_ID, 160));
    deck.slides[0].elements.push(video(SECOND_VIDEO_ID, 900));
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

    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Present%20Test`,
      profileDir,
    );
    const editorTarget = await findTarget(
      browser.debugPort,
      (target) => target.url.includes(`deck=${DECK_ID}`) && !target.url.includes('present.html'),
      browser.log,
    );
    editor = await Cdp.connect(editorTarget.webSocketDebuggerUrl!);
    const loaded = await eventually(async () => editor!.evaluate<{
      title: string; elements: number; types: string[];
    }>(`(() => {
      const deck = window.store?.get().deck;
      const slide = deck?.slides?.[0];
      return {
        title: deck?.title ?? '(none)',
        elements: slide?.elements?.length ?? -1,
        types: (slide?.elements ?? []).map((e) => e.type + ':' + e.id),
      };
    })()`), 'the editor never loaded the fixture deck',
      (value) => value.elements === 3);
    expect(loaded.title).toBe('Present plays the deck');

    /* --- press the real Present control ---------------------------------- */

    const clicked = await editor.evaluate<boolean>(`(() => {
      const button = [...document.querySelectorAll('#toolbar button')]
        .find((candidate) => candidate.textContent?.trim() === 'Present');
      button?.click();
      return Boolean(button);
    })()`);
    expect(clicked).toBe(true);

    /* --- the audience sees the slide ------------------------------------- */

    const painted = await eventually(async () => editor!.evaluate<{
      elements: number; title: boolean; videos: number;
    } | null>(`(() => {
      const frame = ${PRESENT_DOC};
      const doc = frame && frame.contentDocument;
      if (!doc || !doc.querySelector('.slide')) return null;
      return {
        elements: doc.querySelectorAll('[data-element-id]').length,
        title: doc.body.textContent?.includes(${JSON.stringify(TITLE_MARKER)}) === true,
        videos: doc.querySelectorAll('video').length,
      };
    })()`), 'the presentation never painted the deck',
      (value) => value !== null && value.elements === 3);
    expect(painted).toEqual({ elements: 3, title: true, videos: 2 });

    /* --- it painted from the editor's deck, not from a fresh session ------ */

    // The editor tab already holds the deck and the theme, so the presentation
    // is seeded with them over postMessage. Waiting for its own WebSocket
    // welcome instead meant a second of black screen before the first slide --
    // longer on a remote server, where that handshake crosses the network.
    const source = await editor.evaluate<string | null>(`(() => {
      const frame = ${PRESENT_DOC};
      return frame?.contentDocument?.documentElement?.dataset?.presentSource ?? null;
    })()`);
    expect(source, 'the presentation waited for its own session instead of being seeded')
      .toBe('seed');

    /* --- and the videos are running, not frozen on a black frame --------- */

    const playback = await eventually(async () => editor!.evaluate<Array<{
      id: string; advanced: number; distinctColours: number; readyState: number;
      width: number; error: string | null;
    }>>(`(async () => {
      const frame = ${PRESENT_DOC};
      const doc = frame.contentDocument;
      const videos = [...doc.querySelectorAll('video')];
      const before = videos.map((v) => v.currentTime);
      await new Promise((resolve) => setTimeout(resolve, 900));
      return videos.map((v, i) => {
        // Draw the live frame and count distinct colours. A video that never
        // decoded paints one flat colour; real content never does.
        let distinct = 0;
        try {
          const canvas = doc.createElement('canvas');
          canvas.width = 32;
          canvas.height = 32;
          const context = canvas.getContext('2d');
          context.drawImage(v, 0, 0, 32, 32);
          const data = context.getImageData(0, 0, 32, 32).data;
          const seen = new Set();
          for (let p = 0; p < data.length; p += 4) {
            seen.add((data[p] << 16) | (data[p + 1] << 8) | data[p + 2]);
          }
          distinct = seen.size;
        } catch (e) { distinct = -1; }
        return {
          id: v.closest('[data-element-id]')?.dataset.elementId ?? '?',
          advanced: Math.round((v.currentTime - before[i]) * 1000) / 1000,
          distinctColours: distinct,
          readyState: v.readyState,
          width: v.videoWidth,
          error: v.error ? v.error.code + ':' + v.error.message : null,
        };
      });
    })()`), 'the presentation never started its videos',
      (rows) => rows.length === 2 && rows.every((row) => row.advanced > 0.1));

    for (const row of playback) {
      expect(row.error, `${row.id} failed to load`).toBeNull();
      expect(row.width, `${row.id} never decoded a frame`).toBeGreaterThan(0);
      // The assertion the structural checks cannot make: the clip is moving.
      expect(row.advanced, `${row.id} is not playing`).toBeGreaterThan(0.1);
      // And it is showing picture rather than a black rectangle.
      expect(row.distinctColours, `${row.id} painted a flat colour`).toBeGreaterThan(3);
    }
  }, 120_000);
});

describe.skipIf(electronBinary && ffmpeg)('presenting the deck (skipped)', () => {
  it('needs Electron and ffmpeg', () => {
    expect(!electronBinary || !ffmpeg).toBe(true);
  });
});
