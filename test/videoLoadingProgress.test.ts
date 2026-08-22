// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackVideoLoading, type VideoLoadingTracker } from '../src/renderer/player/videoLoadingProgress.js';

/**
 * Loading feedback contract (videoLoadingProgress.ts).
 *
 * Over a remote collab server, video bytes arrive well after the slide paints;
 * until a frame decodes, a <video> is a black rectangle indistinguishable from
 * a bug. Each unready video gets an overlay and the page gets one roll-up pill,
 * both of which must disappear on their own the moment frames arrive — and
 * must never intercept pointer events or trip the render-invariant checker.
 */

let tracker: VideoLoadingTracker | null = null;
afterEach(() => {
  tracker?.dispose();
  tracker = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** jsdom media elements are inert; drive readyState by hand. */
function setReadyState(video: HTMLVideoElement, state: number): void {
  Object.defineProperty(video, 'readyState', { configurable: true, value: state });
}

function mountVideo(root: HTMLElement): HTMLVideoElement {
  const wrap = document.createElement('div');
  const video = document.createElement('video');
  setReadyState(video, HTMLMediaElement.HAVE_NOTHING);
  wrap.appendChild(video);
  root.appendChild(wrap);
  return video;
}

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

const overlayFor = (video: HTMLVideoElement) =>
  video.parentElement!.querySelector<HTMLElement>('.video-loading-overlay');
const pill = () => document.querySelector<HTMLElement>('.video-loading-pill');

describe('trackVideoLoading', () => {
  it('overlays an unready video and shows the page pill', () => {
    const root = makeRoot();
    const video = mountVideo(root);
    tracker = trackVideoLoading(root);
    expect(overlayFor(video)).not.toBeNull();
    expect(pill()?.textContent).toBe('Loading video…');
  });

  it('is exempt from the render-invariant diff and inert to the pointer', () => {
    const root = makeRoot();
    const video = mountVideo(root);
    tracker = trackVideoLoading(root);
    const overlay = overlayFor(video)!;
    // data-editor-only is what renderInvariants.ts strips before comparing.
    expect(overlay.dataset.editorOnly).toBe('true');
    expect(overlay.className).toContain('video-loading-overlay');
  });

  it('removes the overlay and pill once a frame is decodable', () => {
    const root = makeRoot();
    const video = mountVideo(root);
    tracker = trackVideoLoading(root);
    setReadyState(video, HTMLMediaElement.HAVE_CURRENT_DATA);
    video.dispatchEvent(new Event('loadeddata'));
    expect(overlayFor(video)).toBeNull();
    expect(pill()).toBeNull();
  });

  it('never tracks a video that mounts already ready — no spinner flash', () => {
    const root = makeRoot();
    const video = mountVideo(root);
    setReadyState(video, HTMLMediaElement.HAVE_ENOUGH_DATA);
    tracker = trackVideoLoading(root);
    expect(overlayFor(video)).toBeNull();
    expect(pill()).toBeNull();
  });

  it('counts the batch down in the pill as videos finish', () => {
    const root = makeRoot();
    const first = mountVideo(root);
    mountVideo(root);
    tracker = trackVideoLoading(root);
    expect(pill()?.textContent).toBe('Loading videos… 0 of 2');
    setReadyState(first, HTMLMediaElement.HAVE_CURRENT_DATA);
    first.dispatchEvent(new Event('loadeddata'));
    expect(pill()?.textContent).toBe('Loading videos… 1 of 2');
  });

  it('shows buffered percent once the duration is known', () => {
    const root = makeRoot();
    const video = mountVideo(root);
    Object.defineProperty(video, 'duration', { configurable: true, value: 10 });
    Object.defineProperty(video, 'buffered', {
      configurable: true,
      value: { length: 1, end: () => 4 } as unknown as TimeRanges,
    });
    tracker = trackVideoLoading(root);
    video.dispatchEvent(new Event('progress'));
    const overlay = overlayFor(video)!;
    expect(overlay.textContent).toContain('40%');
    expect(overlay.querySelector<HTMLElement>('.video-loading-ring')!.style
      .getPropertyValue('--video-loading-ratio')).toBe('0.4');
  });

  it('marks a failed video and stops counting it as loading', () => {
    const root = makeRoot();
    const video = mountVideo(root);
    tracker = trackVideoLoading(root);
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 4 } as MediaError,
    });
    video.dispatchEvent(new Event('error'));
    expect(overlayFor(video)!.classList.contains('failed')).toBe(true);
    expect(overlayFor(video)!.textContent).toContain('failed');
    expect(pill()).toBeNull();
  });

  it('picks up videos mounted later (slide changes) via mutation observation', async () => {
    vi.useFakeTimers();
    const root = makeRoot();
    tracker = trackVideoLoading(root);
    const video = mountVideo(root);
    // The scan is timeout-debounced, NOT rAF-debounced: rAF never fires in a
    // hidden tab, and a backgrounded present view must keep tracking.
    await vi.advanceTimersByTimeAsync(100);
    expect(overlayFor(video)).not.toBeNull();
    expect(pill()?.textContent).toBe('Loading video…');
  });

  it('drops everything it added on dispose', () => {
    const root = makeRoot();
    const video = mountVideo(root);
    tracker = trackVideoLoading(root);
    tracker.dispose();
    tracker = null;
    expect(overlayFor(video)).toBeNull();
    expect(pill()).toBeNull();
  });
});
