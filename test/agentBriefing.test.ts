import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilities } from '../src/shared/capabilities.js';
import { type Deck, type Slide, type SlideElement, emptyDeck, parseDeck } from '../src/shared/deck.js';
import { deckOutline, deckStyleDigest, htmlToText } from '../src/shared/deckDigest.js';
import { validateDeckIntegrity } from '../src/shared/agent.js';
import { capabilitiesReport, referenceDeckPath } from '../src/cli/agentCli.js';

/**
 * What an agent is told before it starts.
 *
 * The failure this guards against is not a crash: it is an agent that reads
 * the whole deck, still does not know KaTeX exists, and lays an equation out
 * by hand. So these tests assert that the briefing is small, that it is
 * derived from the deck rather than assumed, and that every example in the
 * cookbook is a valid element the agent can paste.
 */

const text = (
  id: string,
  html: string,
  box: { x: number; y: number; w: number; h: number },
  className: string,
): SlideElement => ({
  id, type: 'text', ...box, rot: 0, z: 1, opacity: 1,
  class: [className], style: {}, html, align: 'left', valign: 'top',
});

function talk(): Deck {
  const slide = (id: string, title: string, y: number, extra: SlideElement[] = []): Slide => ({
    id, name: '', background: { color: null, image: null }, notes: '',
    elements: [text(`${id}-title`, title, { x: 160, y, w: 1600, h: 200 }, 'role-title'), ...extra],
    timeline: [],
  });
  const deck = emptyDeck('The Bitter Lesson');
  deck.slides = [
    slide('slide-1', 'The Bitter Lesson', 120),
    slide('slide-2', 'Compute wins', 120, [
      text('slide-2-body', 'Search and learning scale.', { x: 160, y: 400, w: 1600, h: 300 }, 'role-body'),
    ]),
    slide('slide-3', 'Results', 120, [{
      id: 'slide-3-figure', type: 'image', x: 300, y: 400, w: 1200, h: 500, rot: 0, z: 2,
      opacity: 1, class: [], style: {}, src: 'assets/plot.png', fit: 'contain', alt: '',
      sourceBox: null,
    }]),
  ];
  return parseDeck(deck);
}

describe('the deck outline', () => {
  it('names every slide in order with what is on it', () => {
    const outline = deckOutline(talk());

    expect(outline.map((entry) => entry.id)).toEqual(['slide-1', 'slide-2', 'slide-3']);
    expect(outline.map((entry) => entry.title))
      .toEqual(['The Bitter Lesson', 'Compute wins', 'Results']);
    expect(outline[2].elements).toEqual({ text: 1, image: 1 });
    expect(outline[0].index).toBe(0);
  });

  it('stays small enough to read in one go', async () => {
    // Measured against a real imported deck rather than a synthetic one: the
    // saving comes from dropping per-element geometry, and only a deck with
    // real slides on it shows that honestly.
    const path = join(process.cwd(), 'examples', 'reference', 'deck.json');
    if (!existsSync(path)) return;
    const deck = parseDeck(JSON.parse(await readFile(path, 'utf8')));

    const outline = JSON.stringify(deckOutline(deck));
    expect(outline.length).toBeLessThan(JSON.stringify(deck).length / 4);
    expect(outline.length / deck.slides.length).toBeLessThan(400);
  });

  it('falls back to the topmost text when a slide has no title role', () => {
    const deck = talk();
    deck.slides[0].elements = [
      text('low', 'Lower text', { x: 0, y: 800, w: 800, h: 100 }, 'role-body'),
      text('high', 'Upper text', { x: 0, y: 100, w: 800, h: 100 }, 'role-body'),
    ];
    expect(deckOutline(parseDeck(deck))[0].title).toBe('Upper text');
  });

  it('reads through inline markup and entities', () => {
    expect(htmlToText('A <b>bold</b> claim&nbsp;&amp; a caveat<br>on two lines'))
      .toBe('A bold claim & a caveat on two lines');
  });
});

describe('the house style digest', () => {
  it('reports the roles this deck actually uses, with their real geometry', () => {
    const style = deckStyleDigest(talk());

    expect(style.roles.map((role) => role.class)).toEqual(['role-title', 'role-body']);
    expect(style.roles[0]).toMatchObject({ count: 3, box: { x: 160, y: 120, w: 1600, h: 200 } });
    expect(style.canvas).toEqual({ w: 1920, h: 1080 });
  });

  it('offers a template in those conventions, ready to fill in', () => {
    const style = deckStyleDigest(talk());
    const [title, body] = style.slideTemplate.elements;

    expect(title).toMatchObject({ class: ['role-title'], x: 160, y: 120, w: 1600, h: 200 });
    expect(body).toMatchObject({ class: ['role-body'], x: 160, y: 400 });
    // The placeholders are loud on purpose: a copied id would collide.
    expect(style.slideTemplate.id).toMatch(/REPLACE/);
    expect(title.id).toMatch(/REPLACE/);
  });

  it('keeps the template on the canvas even when the deck is laid out oddly', () => {
    const deck = talk();
    // An import whose titles sit half off the top of the canvas.
    for (const slide of deck.slides) slide.elements[0].y = -400;
    const style = deckStyleDigest(parseDeck(deck));

    // The reported usage stays honest…
    expect(style.roles[0].box.y).toBe(-400);
    // …while the template a new slide is built from is usable.
    const title = style.slideTemplate.elements[0];
    expect(title.y).toBeGreaterThanOrEqual(0);
    expect(title.y + title.h).toBeLessThanOrEqual(style.canvas.h);
  });

  it('describes a deck with no role classes at all without inventing any', () => {
    const deck = emptyDeck('Bare');
    deck.slides[0].elements = [text('bare', 'Just text', { x: 0, y: 0, w: 400, h: 100 }, '')];
    const style = deckStyleDigest(parseDeck(deck));

    expect(style.roles.every((role) => role.class !== 'role-title')).toBe(true);
    // The fallback template is derived from the canvas, not from nothing.
    expect(style.slideTemplate.elements[0]).toMatchObject({ class: ['role-title'], x: 159 });
  });
});

describe('the capability cookbook', () => {
  it('covers the features an agent would otherwise reimplement badly', () => {
    const ids = capabilities().map((capability) => capability.id);
    expect(ids).toEqual(expect.arrayContaining([
      'latex', 'crop', 'video', 'builds', 'magic-move', 'auto-fit', 'shapes', 'media-frame',
    ]));
  });

  it('teaches the maths convention explicitly, because it cannot be guessed', () => {
    const latex = capabilities().find((capability) => capability.id === 'latex')!;
    const html = latex.elements
      .filter((element): element is Extract<SlideElement, { type: 'text' }> => element.type === 'text')
      .map((element) => element.html)
      .join(' ');

    expect(html).toContain('$');
    expect(latex.notes?.join(' ')).toMatch(/\$\$…\$\$ is display/);
    expect(latex.when).toMatch(/[Nn]ever hand-build/);
  });

  it('is made of examples that are valid decks, not illustrative pseudo-JSON', () => {
    // Every capability, assembled into one deck and validated exactly as an
    // agent's own transaction would be.
    const deck = parseDeck({
      version: 1,
      slides: capabilities().map((capability) => ({
        id: capability.id,
        elements: capability.elements,
        timeline: capability.timeline ?? [],
        ...capability.slide,
      })),
    });
    expect(validateDeckIntegrity(deck)).toEqual([]);
  });

  it('can be asked about one feature instead of all of them', () => {
    const report = capabilitiesReport(['latex', 'crop']) as { capabilities: Array<{ id: string }> };
    expect(report.capabilities.map((capability) => capability.id)).toEqual(['latex', 'crop']);
  });

  it('points at a rendered screenshot and real markup for each feature', async () => {
    const report = capabilitiesReport() as {
      referenceDeck: string | null;
      capabilities: Array<{ id: string; screenshot: string | null; html: string | null }>;
    };
    // The reference deck is generated by `npm run build:reference`; skip
    // rather than fail in a checkout where it has not been built.
    if (!report.referenceDeck) return;

    for (const capability of report.capabilities) {
      expect(capability.screenshot, `${capability.id} screenshot`).not.toBeNull();
      expect(capability.html, `${capability.id} html`).not.toBeNull();
    }
    const latex = report.capabilities.find((capability) => capability.id === 'latex')!;
    expect(await readFile(latex.html!, 'utf8')).toContain('katex');
  });

  it('generates the reference deck from the cookbook, so they cannot drift', async () => {
    const deckPath = join(referenceDeckPath(), 'deck.json');
    if (!existsSync(deckPath)) return;
    const deck = parseDeck(JSON.parse(await readFile(deckPath, 'utf8')));

    expect(deck.slides.map((slide) => slide.id))
      .toEqual(capabilities().map((capability) => capability.id));
  });
});
