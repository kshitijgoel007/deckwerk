import { describe, expect, it } from 'vitest';
import { clipboardImageName } from '../src/renderer/editor/store.js';

/**
 * The name a pasted clipboard file is imported under. The Electron path names
 * OS-clipboard bytes `Screenshot.png`; the browser paste event hands the same
 * bytes over as Chromium's placeholder `image.png`, and the two must agree so
 * an asset is not called something different depending on which path won.
 */
describe('naming a pasted clipboard image', () => {
  it('turns Chromium placeholder names into Screenshot.<ext>', () => {
    expect(clipboardImageName({ name: 'image.png', type: 'image/png' })).toBe('Screenshot.png');
    expect(clipboardImageName({ name: 'Image.JPG', type: 'image/jpeg' })).toBe('Screenshot.jpg');
    expect(clipboardImageName({ name: 'image.webp', type: 'image/webp' })).toBe('Screenshot.webp');
  });

  it('keeps a real file name', () => {
    expect(clipboardImageName({ name: 'figure-3.png', type: 'image/png' })).toBe('figure-3.png');
    expect(clipboardImageName({ name: 'images.png', type: 'image/png' })).toBe('images.png');
    expect(clipboardImageName({ name: 'image.final.png', type: 'image/png' })).toBe('image.final.png');
  });

  it('derives a name from the MIME type when the file has none that counts', () => {
    expect(clipboardImageName({ name: 'blob', type: 'image/png' })).toBe('Screenshot.png');
    expect(clipboardImageName({ name: '', type: 'image/jpeg' })).toBe('Screenshot.jpg');
    expect(clipboardImageName({ name: 'x', type: 'image/svg+xml' })).toBe('Screenshot.svg');
  });

  it('refuses anything that is not an image', () => {
    expect(clipboardImageName({ name: 'notes.txt', type: 'text/plain' })).toBeNull();
    expect(clipboardImageName({ name: 'image.txt', type: 'text/plain' })).toBeNull();
    expect(clipboardImageName({ name: 'clip.mp4', type: 'video/mp4' })).toBeNull();
  });
});
