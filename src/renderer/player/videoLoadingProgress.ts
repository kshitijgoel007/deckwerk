/**
 * Loading feedback for `<video>` elements while they cannot paint yet.
 *
 * Over a remote connection (the headless collab server on a far-away machine)
 * a video fetch can take many seconds, during which the element is a black
 * rectangle indistinguishable from a bug. This module watches every video
 * under a root, overlays a progress ring on each one until it has a decoded
 * frame, and shows one page-level pill ("Loading videos… 2 of 5") so the
 * viewer can tell the deck is healthy and merely still transferring.
 *
 * Purely additive and passive: overlays are `pointer-events: none`, carry
 * `data-editor-only` so the editor's render-invariant checker ignores them,
 * and never touch playback state. Electron-free, like the rest of the player.
 */

/** A video can paint once it has data for the current position and isn't mid-seek. */
function hasPaintableFrame(video: HTMLVideoElement): boolean {
  return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.seeking;
}

/** 0..1 of the file buffered from the start, or null while unknowable. */
function bufferedRatio(video: HTMLVideoElement): number | null {
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const ranges = video.buffered;
  if (ranges.length === 0) return 0;
  return Math.min(1, ranges.end(ranges.length - 1) / duration);
}

const VIDEO_EVENTS = [
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'seeked',
  'progress',
  'error',
  'stalled',
] as const;

interface Entry {
  video: HTMLVideoElement;
  overlay: HTMLElement;
  ring: HTMLElement;
  status: HTMLElement;
  onEvent: () => void;
  failed: boolean;
}

export interface VideoLoadingTracker {
  dispose(): void;
}

/**
 * Watch `root` for videos that cannot paint yet and show progress until every
 * one of them can. Safe to call once at boot: a MutationObserver picks up
 * videos mounted later (slide changes, deck replacement, live edits).
 */
export function trackVideoLoading(root: HTMLElement): VideoLoadingTracker {
  const entries = new Map<HTMLVideoElement, Entry>();
  // How many videos the current loading batch started with; the pill shows
  // "done of batchTotal" and a batch ends when nothing is pending anymore.
  let batchTotal = 0;
  let pill: HTMLElement | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  function ensurePill(): HTMLElement {
    if (!pill) {
      pill = document.createElement('div');
      pill.className = 'video-loading-pill';
      pill.dataset.editorOnly = 'true';
      document.body.appendChild(pill);
    }
    return pill;
  }

  function updatePill(): void {
    const pending = entries.size;
    if (pending === 0) {
      batchTotal = 0;
      pill?.remove();
      pill = null;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      return;
    }
    batchTotal = Math.max(batchTotal, pending);
    const done = batchTotal - pending;
    ensurePill().textContent = batchTotal > 1
      ? `Loading videos… ${done} of ${batchTotal}`
      : 'Loading video…';
    if (pollTimer === null) {
      // 'progress' events can be sparse mid-transfer; a slow poll keeps the
      // rings honest without costing anything once loading finishes.
      pollTimer = setInterval(() => {
        for (const entry of [...entries.values()]) update(entry);
      }, 500);
    }
  }

  function detach(entry: Entry): void {
    for (const name of VIDEO_EVENTS) entry.video.removeEventListener(name, entry.onEvent);
    entry.overlay.remove();
    entries.delete(entry.video);
  }

  function update(entry: Entry): void {
    const { video } = entry;
    if (!video.isConnected) {
      detach(entry);
      updatePill();
      return;
    }
    if (hasPaintableFrame(video)) {
      detach(entry);
      updatePill();
      return;
    }
    if (video.error) {
      // Leave the overlay up as an error marker, but stop counting it toward
      // the pill — "loading" would otherwise never resolve.
      if (!entry.failed) {
        entry.failed = true;
        entry.overlay.classList.add('failed');
        entry.ring.remove();
        entry.status.textContent = 'Video failed to load';
        for (const name of VIDEO_EVENTS) video.removeEventListener(name, entry.onEvent);
        entries.delete(video);
        updatePill();
      }
      return;
    }
    const ratio = bufferedRatio(video);
    if (ratio === null) {
      entry.ring.classList.add('indeterminate');
      entry.ring.style.removeProperty('--video-loading-ratio');
      entry.status.textContent = 'Loading…';
    } else {
      entry.ring.classList.remove('indeterminate');
      entry.ring.style.setProperty('--video-loading-ratio', String(ratio));
      entry.status.textContent = `${Math.round(ratio * 100)}%`;
    }
  }

  function track(video: HTMLVideoElement): void {
    const parent = video.parentElement;
    if (!parent) return;
    const overlay = document.createElement('div');
    overlay.className = 'video-loading-overlay';
    overlay.dataset.editorOnly = 'true';
    const ring = document.createElement('div');
    ring.className = 'video-loading-ring indeterminate';
    const status = document.createElement('div');
    status.className = 'video-loading-status';
    status.textContent = 'Loading…';
    overlay.append(ring, status);
    parent.appendChild(overlay);

    const entry: Entry = { video, overlay, ring, status, failed: false, onEvent: () => {} };
    entry.onEvent = () => update(entry);
    for (const name of VIDEO_EVENTS) video.addEventListener(name, entry.onEvent);
    entries.set(video, entry);
    update(entry);
  }

  function scan(): void {
    if (disposed) return;
    for (const entry of [...entries.values()]) {
      if (!entry.video.isConnected) detach(entry);
    }
    for (const video of root.querySelectorAll('video')) {
      if (entries.has(video)) continue;
      if (hasPaintableFrame(video) || video.error) continue;
      track(video);
    }
    updatePill();
  }

  // Coalesce mutation bursts (a slide mount adds many nodes) into one scan.
  // A timeout, not requestAnimationFrame: rAF never fires in a hidden tab,
  // and a backgrounded present view must keep tracking (see the player's
  // visibilitychange handling for the same reason).
  let scanQueued = false;
  const observer = new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => {
      scanQueued = false;
      scan();
    }, 50);
  });
  observer.observe(root, { childList: true, subtree: true });
  scan();

  return {
    dispose(): void {
      disposed = true;
      observer.disconnect();
      for (const entry of [...entries.values()]) detach(entry);
      updatePill();
    },
  };
}
