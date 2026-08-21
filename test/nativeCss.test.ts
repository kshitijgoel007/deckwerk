import { describe, expect, it } from 'vitest';
import {
  cssNoWrap,
  cssMediaBorder,
  cssMediaRadius,
  cssVisualEffects,
  typedPropertyOwnsCss,
} from '../src/shared/nativeCss.js';

describe('editable native properties authored as CSS', () => {
  it('parses uniform solid borders without misreading spaced functional colours', () => {
    expect(cssMediaBorder({ border: '6px solid rgba(10, 20, 30, 0.5)' })).toEqual({
      width: 6,
      color: 'rgba(10, 20, 30, 0.5)',
    });
    expect(cssMediaBorder({
      'border-width': '3px',
      'border-style': 'solid',
      'border-color': '#abcdef',
    })).toEqual({ width: 3, color: '#abcdef' });
    expect(cssMediaBorder({ border: '3px dashed red' })).toBeNull();
    expect(cssMediaBorder({ border: '1px 2px solid red' })).toBeNull();
  });

  it('separates editable pixel radii and circular masks from unsupported radii', () => {
    expect(cssMediaRadius('24px')).toEqual({ borderRadius: 24 });
    expect(cssMediaRadius('24px 24px 24px 24px')).toEqual({ borderRadius: 24 });
    expect(cssMediaRadius('50%')).toEqual({ maskShape: 'circle' });
    expect(cssMediaRadius('20%')).toBeNull();
    expect(cssMediaRadius('24px / 12px')).toBeNull();
  });

  it('promotes only filter stacks the native effects editor can represent losslessly', () => {
    expect(cssVisualEffects('blur(8px) grayscale(35%)')).toEqual([
      { type: 'blur', radius: 8 },
      { type: 'grayscale', amount: 0.35 },
    ]);
    expect(cssVisualEffects('grayscale(0.4) blur(2px)')).toEqual([
      { type: 'grayscale', amount: 0.4 },
      { type: 'blur', radius: 2 },
    ]);
    expect(cssVisualEffects('saturate(.8) contrast(1.1)')).toBeNull();
    expect(cssVisualEffects('blur(8px) drop-shadow(0 2px 4px #0008)')).toBeNull();
  });

  it('recognises CSS no-wrap and centralises every typed ownership overlap', () => {
    expect(cssNoWrap('nowrap')).toBe(true);
    expect(cssNoWrap('pre')).toBe(true);
    expect(cssNoWrap('pre-wrap')).toBe(false);

    const image = {
      id: 'image', type: 'image' as const, x: 0, y: 0, w: 10, h: 10, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, src: 'image.png', fit: 'cover' as const,
      alt: '', sourceBox: null, borderWidth: 0, borderRadius: 0, maskShape: 'rect' as const,
      effects: [],
    };
    expect(typedPropertyOwnsCss(image, 'border')).toBe(true);
    expect(typedPropertyOwnsCss(image, 'border-radius')).toBe(true);
    expect(typedPropertyOwnsCss(image, 'filter')).toBe(true);
    expect(typedPropertyOwnsCss(image, 'box-shadow')).toBe(false);

    const text = {
      id: 'text', type: 'text' as const, x: 0, y: 0, w: 10, h: 10, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, html: 'Text', align: 'left' as const,
      valign: 'top' as const, noWrap: false,
    };
    expect(typedPropertyOwnsCss(text, 'white-space')).toBe(true);
    expect(typedPropertyOwnsCss(text, 'color')).toBe(false);
  });
});
