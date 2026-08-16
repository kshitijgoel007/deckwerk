// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { renderSlide } from '../src/renderer/player/render.js';

describe('LaTeX text rendering', () => {
  it('renders inline and display equations while preserving escaped dollars', () => {
    const slide = emptyDeck().slides[0];
    slide.elements.push({
      id: 'math', type: 'text', x: 0, y: 0, w: 1000, h: 500, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, align: 'left', valign: 'top',
      html: String.raw`Price: \$5. Inline $E=mc^2$. Display $$\int_0^1 x^2\,dx$$`,
    });
    const rendered = renderSlide(slide, { resolveSrc: (src) => src });
    expect(rendered.querySelectorAll('.katex')).toHaveLength(2);
    expect(rendered.querySelector('.katex-display')).not.toBeNull();
    expect(rendered.textContent).toContain('Price: $5');
  });

  it('shows invalid TeX without crashing the slide', () => {
    const slide = emptyDeck().slides[0];
    slide.elements.push({
      id: 'bad-math', type: 'text', x: 0, y: 0, w: 1000, h: 200, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, align: 'left', valign: 'top',
      html: String.raw`$$\notacommand{oops}$$`,
    });
    expect(() => renderSlide(slide, { resolveSrc: (src) => src })).not.toThrow();
  });
});
