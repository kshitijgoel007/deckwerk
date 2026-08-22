/**
 * A page-wide throttle on how many preview `<video>` elements may fetch at
 * once.
 *
 * A browser gives an origin six HTTP/1.1 connections, shared across every tab
 * on that origin. The collab editor mounts a video element per slide-rail
 * thumbnail plus the canvas's own — a deck reusing one clip across sixteen
 * elements used to issue ~20 fetches the moment it opened. Even under
 * `preload="metadata"` each of those holds a connection while its header and
 * poster frame arrive, and on a slow link they hold all six for long enough
 * that everything else on the origin — the Present view's HTML, its bundle,
 * the WebSocket upgrade — sits in a queue behind pictures nobody is waiting
 * for. That is the "click Present, get a black screen; try again later and it
 * works" bug.
 *
 * Preview loads therefore go through this gate. Elements are created with
 * their `src` in place but `preload="none"`, which a browser honours by not
 * fetching anything; the gate promotes at most MAX_CONCURRENT of them at a
 * time to `preload="metadata"` (with a `load()` to make the promotion take
 * effect everywhere), and promotes the next as each one decodes its poster
 * frame, fails, or is abandoned. Keeping `src` on the element from the start
 * matters: the video pools in the editor canvas and the player key reuse by
 * source URL.
 *
 * Live playback surfaces (`preload="auto"`) are never gated — playback is
 * imminent there and a slide shows at most a handful of videos.
 */

const MAX_CONCURRENT = 3;
const WATCHDOG_MS = 2_000;
/** How long a never-attached element may wait before it is presumed dead. */
const ORPHAN_GRACE_MS = 10_000;

interface PendingLoad {
  video: HTMLVideoElement;
  queuedAt: number;
  everConnected: boolean;
}

const queue: PendingLoad[] = [];
const active = new Set<PendingLoad>();
let watchdog: ReturnType<typeof setInterval> | null = null;

/**
 * Register a `preload="none"` element (src already set) for a metered
 * metadata load. The gate flips it to `preload="metadata"` when a slot frees.
 */
export function gateVideoLoad(video: HTMLVideoElement): void {
  const entry: PendingLoad = {
    video,
    queuedAt: Date.now(),
    everConnected: video.isConnected,
  };
  queue.push(entry);
  // Elements are built detached and appended in the same task, so sample
  // connectivity once the caller's task has run. Without this an element that
  // is discarded quickly (a panel that re-renders on every click) looks
  // "never attached" and holds its slot for the full orphan grace, starving
  // the previews that are actually on screen.
  setTimeout(() => {
    entry.everConnected ||= entry.video.isConnected;
  }, 0);
  pump();
  ensureWatchdog();
}

/** Whether the gate is already carrying this element's load. */
export function isGated(video: HTMLVideoElement): boolean {
  if (queue.some((entry) => entry.video === video)) return true;
  for (const entry of active) if (entry.video === video) return true;
  return false;
}

/** True while any gated load is queued or in flight (exposed for tests). */
export function gatedLoadsPending(): boolean {
  return queue.length > 0 || active.size > 0;
}

/** Drop all gate state. Test isolation only — the page never needs this. */
export function resetMediaLoadGateForTests(): void {
  queue.length = 0;
  active.clear();
  if (watchdog !== null) {
    clearInterval(watchdog);
    watchdog = null;
  }
}

function pump(): void {
  while (active.size < MAX_CONCURRENT && queue.length > 0) {
    const entry = queue.shift()!;
    active.add(entry);
    start(entry);
  }
}

function start(entry: PendingLoad): void {
  const { video } = entry;
  // Chromium defers the load of a `preload="none"` element and resumes it
  // when the hint is upgraded — no load() call needed. Deliberately no
  // load(): it fires a queued 'emptied', which the listeners below would
  // read as "this slot is free", releasing the whole queue at once.
  video.preload = 'metadata';
  const listeners: Array<() => void> = [];
  const done = () => {
    for (const off of listeners) off();
    active.delete(entry);
    pump();
  };
  // 'loadeddata' covers the normal path; 'seeked' covers the poster-frame
  // seek that render.ts issues on 'loadedmetadata'; 'error' and 'emptied'
  // cover failure and an abort by other code (`removeAttribute('src')`).
  for (const name of ['loadeddata', 'seeked', 'error', 'emptied'] as const) {
    const handler = () => done();
    video.addEventListener(name, handler);
    listeners.push(() => video.removeEventListener(name, handler));
  }
}

function ensureWatchdog(): void {
  if (watchdog !== null) return;
  watchdog = setInterval(() => {
    const now = Date.now();
    const abandoned = (entry: PendingLoad): boolean => {
      entry.everConnected ||= entry.video.isConnected;
      return entry.everConnected
        ? !entry.video.isConnected
        : now - entry.queuedAt > ORPHAN_GRACE_MS;
    };
    // Loading elements that left the DOM: abort the fetch, free the slot.
    // removeAttribute + load fires 'emptied', which releases through done().
    for (const entry of [...active]) {
      if (!abandoned(entry)) continue;
      // Stash the source before dropping it: a detached preview element is
      // often coming back (the slide rail caches thumbnail DOM and re-appends
      // it), and an element with no src is black forever. Recovery restores
      // this (see previewFrameRecovery.ts).
      const src = entry.video.getAttribute('src');
      if (src) entry.video.dataset.gateAbortedSrc = src;
      entry.video.removeAttribute('src');
      try {
        entry.video.load();
      } catch {
        // jsdom stub
      }
      active.delete(entry);
    }
    // Waiting elements that will never be shown: drop them from the queue.
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (abandoned(queue[i])) queue.splice(i, 1);
    }
    pump();
    if (queue.length === 0 && active.size === 0 && watchdog !== null) {
      clearInterval(watchdog);
      watchdog = null;
    }
  }, WATCHDOG_MS);
}
