// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PlayerPaintReadiness } from '../src/renderer/collab/playerReadiness.js';

describe('collaboration player paint readiness', () => {
  it('does not report ready until fonts and two paint frames finish', async () => {
    const root = document.createElement('html');
    const frames: FrameRequestCallback[] = [];
    let releaseFonts!: () => void;
    const fontsReady = new Promise<void>((resolve) => { releaseFonts = resolve; });
    const painted: number[] = [];
    const readiness = new PlayerPaintReadiness({
      root,
      fontsReady,
      requestFrame: (callback) => { frames.push(callback); return frames.length; },
      currentSlide: () => 4,
      onPainted: (slide) => painted.push(slide),
    });

    readiness.connecting();
    expect(root.dataset.playerStatus).toBe('connecting');
    readiness.painting();
    expect(root.dataset.playerStatus).toBe('painting');
    expect(root.dataset.playerReady).toBeUndefined();

    releaseFonts();
    await fontsReady;
    await Promise.resolve();
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    expect(root.dataset.playerReady).toBeUndefined();
    frames.shift()!(16);

    expect(root.dataset).toMatchObject({
      playerStatus: 'ready', playerReady: 'true', playerSlide: '4',
    });
    expect(painted).toEqual([4]);
  });

  it('cannot let a stale render mark a newer render ready', async () => {
    const root = document.createElement('html');
    const frames: FrameRequestCallback[] = [];
    let slide = 2;
    const painted: number[] = [];
    const readiness = new PlayerPaintReadiness({
      root,
      fontsReady: Promise.resolve(),
      requestFrame: (callback) => { frames.push(callback); return frames.length; },
      currentSlide: () => slide,
      onPainted: (value) => painted.push(value),
    });

    readiness.painting();
    await Promise.resolve();
    slide = 5;
    readiness.painting();
    await Promise.resolve();

    while (frames.length > 0) frames.shift()!(0);
    expect(root.dataset.playerSlide).toBe('5');
    expect(painted).toEqual([5]);
  });
});
