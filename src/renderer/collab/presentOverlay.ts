/**
 * Presenting from the editor tab, without an intermediate window.
 *
 * Browsers only grant fullscreen from a live user gesture, and a gesture does
 * not carry into a freshly opened popup — which is why Present used to land in
 * a plain window that needed a second click. Instead we mount the very same
 * present view in an iframe over the editor and fullscreen that element inside
 * the click handler, so the first click goes straight to fullscreen.
 */

let overlay: HTMLIFrameElement | null = null;

function teardown(): void {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  window.removeEventListener('message', onMessage);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
}

function onMessage(event: MessageEvent): void {
  if (event.origin !== location.origin) return;
  if ((event.data as { type?: string } | null)?.type !== 'present-exit') return;
  if (document.fullscreenElement) void document.exitFullscreen();
  teardown();
}

function onFullscreenChange(): void {
  // Escape (or the browser's own exit control) leaves fullscreen; that ends the
  // presentation, matching how the popup used to close.
  if (!document.fullscreenElement) teardown();
}

export function startPresenting(deckId: string, slideIndex: number): void {
  teardown();
  const frame = document.createElement('iframe');
  frame.src = `present.html?deck=${encodeURIComponent(deckId)}&slide=${slideIndex + 1}&embed=1`;
  frame.allow = 'fullscreen';
  frame.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;'
    + 'background:#000;z-index:9999;';
  document.body.appendChild(frame);
  overlay = frame;
  window.addEventListener('message', onMessage);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  frame.requestFullscreen().catch(() => {
    // Fullscreen refused: the overlay still covers the tab, so presenting works
    // and the viewer can hit F for fullscreen once they interact.
  });
  frame.focus();
}
