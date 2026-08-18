/**
 * Boots the real Trim & Crop window against a stubbed preload bridge.
 *
 * The bridge must exist before the window's module runs, because that module
 * subscribes to it at import time — hence the dynamic import below.
 */

const listeners: Array<(p: { src: string; elementId: string }) => void> = [];

(window as unknown as { api: unknown }).api = {
  // Served by Vite from the project root.
  assetUrl: (src: string) => `/${src.replace(/^\/+/, '')}`,
  onTrimTarget: (fn: (p: { src: string; elementId: string }) => void) => {
    listeners.push(fn);
    return () => {};
  },
  onTrimProgress: () => () => {},
  onTrimDone: () => () => {},
  runTrim: async (req: unknown) => {
    console.info('[harness] runTrim', req);
    return { src: 'assets/fake.mp4', width: 640, height: 360, duration: 1 };
  },
};

await import('../../src/renderer/trim/main.js');

// Hand the window a real clip, the way the main process would.
const clip =
  new URLSearchParams(location.search).get('src') ??
  'decks/demo-deck/assets/testclip.mp4';
for (const fn of listeners) fn({ src: clip, elementId: 'harness-video' });
