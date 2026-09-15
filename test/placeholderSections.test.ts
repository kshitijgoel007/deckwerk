// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { isPristinePlaceholder, slidesToHtml } from '../src/shared/htmlSlides.js';
import { PLAYER_TYPE_CSS } from '../src/shared/playerTypeCss.js';

/**
 * `slide-agent new > edit/add.html` writes the starter page into the watched
 * folder before anyone edits it. The editor used to compile that save on the
 * spot — N slides titled "Title" in the deck — and stamp the file with their
 * ids while the author was still editing a copy without them, so the real
 * slides then arrived as N more. An untouched starter section is not a slide.
 */
describe('untouched starter sections', () => {
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

  it('are marked by the blank authoring page and recognised as pristine', () => {
    const page = slidesToHtml([], emptyDeck().canvas, { typeCss: PLAYER_TYPE_CSS, base: '../', blank: 3 });
    const sections = [...parse(page).querySelectorAll('section.slide')];
    expect(sections).toHaveLength(3);
    expect(sections.every((section) => isPristinePlaceholder(section))).toBe(true);
  });

  it('stop being pristine the moment their content changes, attribute or not', () => {
    const edited = parse('<section class="slide" data-placeholder="true"><h1 class="role-title">Results</h1></section>');
    expect(isPristinePlaceholder(edited.body.firstElementChild!)).toBe(false);
    const grown = parse('<section class="slide" data-placeholder="true"><h1 class="role-title">Title</h1><p>body</p></section>');
    expect(isPristinePlaceholder(grown.body.firstElementChild!)).toBe(false);
    const stamped = parse('<section class="slide" data-placeholder="true" data-slide-id="s1"><h1 class="role-title">Title</h1></section>');
    expect(isPristinePlaceholder(stamped.body.firstElementChild!)).toBe(false);
    const plain = parse('<section class="slide"><h1 class="role-title">Title</h1></section>');
    expect(isPristinePlaceholder(plain.body.firstElementChild!)).toBe(false);
  });
});
