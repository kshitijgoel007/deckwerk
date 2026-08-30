// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DecodedVideoPool } from '../src/renderer/player/decodedVideoPool.js';

function video(src: string): HTMLVideoElement {
  const node = document.createElement('video');
  node.src = src;
  return node;
}

describe('decoded video pool resource bounds', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  });

  it('evicts and tears down the least-recent key at the global limit', () => {
    const pool = new DecodedVideoPool(3, 2);
    const first = video('/one.mp4');
    const second = video('/two.mp4');
    const third = video('/three.mp4');
    const fourth = video('/four.mp4');

    pool.add('one', first);
    pool.add('two', second);
    pool.add('three', third);
    pool.add('four', fourth);

    expect(pool.size).toBe(3);
    expect(first.hasAttribute('src')).toBe(false);
    expect(first.load).toHaveBeenCalled();
    expect(pool.take('one')).toBeUndefined();
    expect(pool.take('four')).toBe(fourth);
  });

  it('tears down nodes rejected by the per-key cap and on clear', () => {
    const pool = new DecodedVideoPool(4, 1);
    const retained = video('/same.mp4');
    const rejected = video('/same.mp4');
    expect(pool.add('same', retained)).toBe(true);
    expect(pool.add('same', rejected)).toBe(false);
    expect(rejected.hasAttribute('src')).toBe(false);

    pool.clear();
    expect(pool.size).toBe(0);
    expect(retained.hasAttribute('src')).toBe(false);
  });
});
