import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { capabilities } from '../src/shared/capabilities.js';
import { type Deck, parseDeck } from '../src/shared/deck.js';

/**
 * Build the agent reference deck from the capability cookbook:
 *   npm run build:reference
 *
 * One slide per capability, so the deck an agent renders to see what this
 * editor can do is generated from the same declarations it reads as JSON.
 * They cannot drift.
 */

const OUT = join(process.cwd(), 'examples', 'agent-reference');
const ASSETS = ['swatch.png', 'testclip.mp4'];

const THEME = `/* The reference deck's theme. Deliberately plain: it is here to show what
   the *format* can do, not to be a design to copy. */

.slide {
  background: #ffffff;
  color: #111827;
  font-family: "Helvetica Neue", Inter, system-ui, sans-serif;
}

.role-title {
  font-size: 78px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.role-body {
  font-size: 40px;
  line-height: 1.35;
}

.role-caption {
  font-size: 28px;
  color: #6b7280;
}
`;

const deck: Deck = parseDeck({
  version: 1,
  title: 'Slide editor capabilities',
  canvas: { w: 1920, h: 1080 },
  theme: 'theme.css',
  slides: capabilities().map((capability) => ({
    id: capability.id,
    name: capability.what,
    notes: `${capability.what}\n\nWhen: ${capability.when}\n${(capability.notes ?? []).map((note) => `- ${note}`).join('\n')}`,
    elements: capability.elements,
    timeline: capability.timeline ?? [],
    ...capability.slide,
  })),
});

await mkdir(join(OUT, 'assets'), { recursive: true });
for (const asset of ASSETS) {
  await copyFile(join('examples', 'demo-deck', 'assets', asset), join(OUT, 'assets', asset));
}
await writeFile(join(OUT, 'deck.json'), `${JSON.stringify(deck, null, 2)}\n`, 'utf8');
await writeFile(join(OUT, 'theme.css'), THEME, 'utf8');
await writeHtml(deck);
console.log(`built ${deck.slides.length}-slide reference deck -> ${OUT}`);

/**
 * The markup each slide becomes, one file per capability.
 *
 * Rendered through the real renderer under jsdom, so an agent reading
 * `html/latex.html` sees the KaTeX output the player actually produces rather
 * than a hand-written approximation of it.
 */
async function writeHtml(built: Deck): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const globals = globalThis as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'DOMParser', 'NodeFilter', 'getComputedStyle']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[name];
  }
  globals.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);

  const { renderSlide } = await import('../src/renderer/player/render.js');
  await mkdir(join(OUT, 'html'), { recursive: true });
  for (const slide of built.slides) {
    const root = renderSlide(slide, { resolveSrc: (src) => src });
    await writeFile(join(OUT, 'html', `${slide.id}.html`), `${root.outerHTML}\n`, 'utf8');
  }
}
