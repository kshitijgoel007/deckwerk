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

async function settleVideo(video: HTMLVideoElement, at: number): Promise<void> {
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
  if (Math.abs(video.currentTime - target) > 0.02) {
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
  await Promise.all(deepImages(page).map(settleImage));
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
