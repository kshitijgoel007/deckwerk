import { describe, expect, it } from 'vitest';
import { isAnimatedImageSource } from '../src/renderer/print/readiness.js';

describe('PDF media readiness', () => {
  it('recognizes GIF assets even through URL query and fragment suffixes', () => {
    expect(isAnimatedImageSource('assets/sequence.gif')).toBe(true);
    expect(isAnimatedImageSource('deck://asset/sequence.GIF?cache=1#frame')).toBe(true);
    expect(isAnimatedImageSource('assets/still.png')).toBe(false);
  });
});
