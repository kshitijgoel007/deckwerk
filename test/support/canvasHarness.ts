import { vi } from 'vitest';

/**
 * The DOM capabilities `EditorCanvas` relies on that jsdom does not provide.
 *
 * Extracted from the canvas tests so every suite that drives the real canvas --
 * editing, render invariants, operation fuzzing -- installs the same shims
 * rather than each growing its own copy.
 */
export function installCanvasDomShims(): void {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  // jsdom implements MouseEvent but not PointerEvent; the canvas listens for
  // pointer events, and they carry the same properties we rely on.
  if (!('PointerEvent' in globalThis)) {
    class PointerEventShim extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
  }
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    if (!(name in Element.prototype)) {
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        value: () => {},
      });
    }
  }
  if (!globalThis.CSS) {
    (globalThis as unknown as { CSS: unknown }).CSS = {
      escape: (v: string) => v.replace(/["\\]/g, '\\$&'),
    };
  }
  // The canvas resolves asset paths through the preload bridge.
  (globalThis as unknown as { window: Window }).window.api = {
    assetUrl: (src: string) => src,
    pathForFile: () => '',
    importAssets: async () => [],
  } as never;
  // jsdom has no media stack; the canvas only needs play/pause to exist.
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: false });
      return Promise.resolve();
    }),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: vi.fn(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: true });
    }),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    value: true,
    writable: true,
  });
}
