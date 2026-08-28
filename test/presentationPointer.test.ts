// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { selectionPreventsAdvance } from '../src/renderer/player/presentationPointer.js';

describe('presentation pointer navigation', () => {
  beforeEach(() => {
    document.body.innerHTML = '<p id="copy">Select these words</p>';
    window.getSelection()?.removeAllRanges();
  });

  it('lets an ordinary click advance', () => {
    expect(selectionPreventsAdvance()).toBe(false);
  });

  it('keeps the slide in place after selecting text with the mouse', () => {
    const text = document.getElementById('copy')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    const selection = window.getSelection()!;
    selection.addRange(range);

    expect(selection.toString()).toBe('Select');
    expect(selectionPreventsAdvance()).toBe(true);
  });

  it('does not suppress navigation for a collapsed caret', () => {
    const text = document.getElementById('copy')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 3);
    range.collapse(true);
    window.getSelection()!.addRange(range);

    expect(selectionPreventsAdvance()).toBe(false);
  });
});
