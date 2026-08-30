// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { parseDeck } from '../src/shared/deck.js';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { isGated, resetMediaLoadGateForTests } from '../src/renderer/player/mediaLoadGate.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { installCanvasDomShims } from './support/canvasHarness.js';

describe('editor video navigation resources', () => {
  beforeEach(() => {
    installCanvasDomShims();
    resetMediaLoadGateForTests();
    HTMLMediaElement.prototype.pause = () => {};
    HTMLMediaElement.prototype.load = () => {};
    document.body.replaceChildren();
  });

  it('tears down an undecoded outgoing video instead of retaining its load', () => {
    const deck = parseDeck({
      version: 1,
      slides: ['one', 'two'].map((name, index) => ({
        id: `slide-${name}`,
        elements: [{
          id: `video-${name}`, type: 'video', x: 0, y: 0, w: 640, h: 360,
          src: `assets/${name}.${index}0000000.mp4`,
        }],
      })),
    });
    const store = new EditorStore(deck, '/tmp/video-resources');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new EditorCanvas(host, store);
    const outgoing = host.querySelector<HTMLVideoElement>('video')!;
    expect(outgoing.getAttribute('src')).not.toBeNull();
    expect(isGated(outgoing)).toBe(true);

    store.selectSlide(1);

    expect(outgoing.getAttribute('src')).toBeNull();
    expect(isGated(outgoing)).toBe(false);
    expect(host.querySelector('video')).not.toBe(outgoing);
  });
});
