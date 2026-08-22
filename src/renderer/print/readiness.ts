import type { Slide } from '@shared/deck.js';
import type { SlideState } from '@shared/timeline.js';

const eventOrTimeout = (target: EventTarget, event: string, timeout = 5_000): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      target.removeEventListener(event, finish);
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    target.addEventListener(event, finish, { once: true });
  });

async function settleImage(image: HTMLImageElement): Promise<void> {
  if (!image.complete) await Promise.race([
    eventOrTimeout(image, 'load'),
    eventOrTimeout(image, 'error'),
  ]);
  if (typeof image.decode === 'function') await image.decode().catch(() => {});
}

export function isAnimatedImageSource(src: string): boolean {
  return /\.gif(?:$|[?#])/i.test(src);
}

/** PDF pages must be reproducible: an animated GIF otherwise advances while
 * Chromium is laying out/printing and lands on an arbitrary frame. Decode the
 * source as an ImageBitmap (whose GIF representation is frame zero), then pin
 * that frame into an ordinary PNG data URL. */
async function freezeAnimatedImage(image: HTMLImageElement): Promise<void> {
  const src = image.currentSrc || image.src;
  if (!isAnimatedImageSource(src) || typeof createImageBitmap !== 'function') return;
  try {
    const response = await fetch(src);
    if (!response.ok) return;
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, bitmap.width);
    canvas.height = Math.max(1, bitmap.height);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    image.src = canvas.toDataURL('image/png');
    await settleImage(image);
  } catch {
    // A failed still-frame decode is non-fatal: the original GIF remains and
    // the normal image readiness path below still prevents a blank export.
  }
}

async function settleVideo(video: HTMLVideoElement, at: number): Promise<void> {
  // Claim the frame before pausing: the Player restarts playback it believes
  // was interrupted, which would drift the frame this pins.
  video.dataset.holdFrame = 'true';
  video.autoplay = false;
  video.pause();
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await Promise.race([
      eventOrTimeout(video, 'loadedmetadata'),
      eventOrTimeout(video, 'error'),
    ]);
  }
  if (!Number.isFinite(video.duration)) return;
  const target = Math.max(0, Math.min(at, Math.max(0, video.duration - 0.03)));
  // The PDF contract pins a video to its exact poster/in-point. A two-
  // hundredths tolerance is visible on fast-motion clips and made repeated
  // exports nondeterministic by one decoded frame.
  if (Math.abs(video.currentTime - target) > 0.0001) {
    const sought = eventOrTimeout(video, 'seeked');
    try { video.currentTime = target; } catch { return; }
    await sought;
  }
  if ('requestVideoFrameCallback' in video) {
    await Promise.race([
      new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

function deepImages(root: ParentNode): HTMLImageElement[] {
  const images = [...root.querySelectorAll<HTMLImageElement>('img')];
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (element.shadowRoot) images.push(...deepImages(element.shadowRoot));
  }
  return images;
}

/** Wait until a PDF page contains the same decoded assets and media frame as the player. */
export async function waitForPdfPage(
  page: HTMLElement,
  slide: Slide,
  state: SlideState,
): Promise<void> {
  const images = deepImages(page);
  await Promise.all(images.map(freezeAnimatedImage));
  await Promise.all(images.map(settleImage));
  // A plugin-rendered <embed> (a PDF used as an image) never paints into
  // printed output, and waiting on it is all this layer can do about that; at
  // least the wait means a slow plugin cannot also cost the page its images.
  await Promise.all([...page.querySelectorAll<HTMLEmbedElement>('embed')].map((embed) =>
    Promise.race([eventOrTimeout(embed, 'load'), eventOrTimeout(embed, 'error')])));
  await Promise.all([...page.querySelectorAll<HTMLVideoElement>('video')].map((video) => {
    const id = video.closest<HTMLElement>('[data-element-id]')?.dataset.elementId;
    const element = slide.elements.find((candidate) => candidate.id === id);
    const at = element?.type === 'video' ? state.seeks.get(element.id) ?? element.start : 0;
    return settleVideo(video, at);
  }));
}

/** Wait for font replacement, auto-fit, decoded media, and finite CSS motion. */
export async function waitForPdfDocument(
  pages: Array<{ page: HTMLElement; slide: Slide; state: SlideState }>,
): Promise<void> {
  await document.fonts.ready;
  await Promise.all(pages.map(({ page, slide, state }) => waitForPdfPage(page, slide, state)));
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  for (const animation of document.getAnimations()) {
    const iterations = animation.effect?.getComputedTiming().iterations;
    if (iterations !== Infinity) {
      try { animation.finish(); } catch { /* A non-finite animation is safe to leave alone. */ }
    }
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
