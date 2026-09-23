import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every page an author can have open in a browser tab carries the DeckWerk
 * icon, so the tab is easy to find among the others (reported: it was not).
 */
const PAGES = [
  'src/renderer/collab/index.html',
  'src/renderer/collab/present.html',
  'src/renderer/collab/print.html',
  'src/renderer/editor/index.html',
];

describe('favicon', () => {
  for (const page of PAGES) {
    it(`${page} links an icon that exists beside it`, () => {
      const html = readFileSync(join(process.cwd(), page), 'utf8');
      const match = /<link rel="icon" type="image\/svg\+xml" href="([^"]+)"/.exec(html);
      expect(match, 'no <link rel="icon"> in the page head').not.toBeNull();
      const icon = resolve(dirname(join(process.cwd(), page)), match![1]);
      expect(existsSync(icon), `${match![1]} does not exist`).toBe(true);
      expect(readFileSync(icon, 'utf8')).toContain('<svg');
    });
  }

  it('is the application icon', () => {
    const source = readFileSync(join(process.cwd(), 'resources/deckwerk-icon.svg'), 'utf8');
    for (const page of ['src/renderer/collab', 'src/renderer/editor']) {
      expect(readFileSync(join(process.cwd(), page, 'favicon.svg'), 'utf8')).toBe(source);
    }
  });
});
