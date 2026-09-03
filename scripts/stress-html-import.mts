/**
 * Stress harness for the HTML authoring importer.
 *
 * Compiles each HTML file given on the command line the way `slide-agent apply`
 * does and prints, per slide, what every authored region became: the deck
 * element type, its geometry, and — for anything that fell back — why. It is a
 * reporting tool, not an assertion: the point is to see where editability is
 * lost before deciding what to fix.
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { createDeck } from '../src/main/deckStore.js';
import { compileHtmlToSlides } from '../src/cli/compileHtml.js';

const files = process.argv.slice(2).filter((arg) => arg.endsWith('.html'));
if (files.length === 0) throw new Error('usage: stress-html-import <files...>');

const root = resolve(process.env.STRESS_OUTPUT ?? 'artifacts/html-import-stress');
// The output folder is wiped on every run, so only wipe one this script made:
// a mistyped STRESS_OUTPUT must not take a real folder with it.
const marker = join(root, '.html-import-stress');
if (existsSync(root) && !existsSync(marker)) {
  throw new Error(`${root} exists and was not created by this script; refusing to delete it`);
}
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await writeFile(marker, '', 'utf8');
const deckDir = join(root, 'deck');
const deck = await createDeck(deckDir, 'HTML import stress');

const report: unknown[] = [];
for (const file of files) {
  const path = resolve(file);
  const assets = join(dirname(path), 'assets');
  if (existsSync(assets)) await cp(assets, join(deckDir, 'assets'), { recursive: true });
  const compiled = await compileHtmlToSlides({ deckDir, deck, htmlPath: path });
  compiled.slides.forEach((slide) => {
    console.log(`\n=== ${basename(file)} :: ${slide.name || slide.id} `
      + `(${slide.elements.length} elements)`);
    for (const element of slide.elements) {
      const box = `${Math.round(element.x)},${Math.round(element.y)} `
        + `${Math.round(element.w)}x${Math.round(element.h)}`;
      const detail = element.type === 'html'
        ? `FALLBACK: ${(element as { fallbackReason?: string }).fallbackReason ?? ''} `
          + `| ${((element as { html: string }).html ?? '').replace(/\s+/g, ' ').slice(0, 90)}`
        : element.type === 'text'
          ? `"${((element as { html: string }).html ?? '').replace(/\s+/g, ' ').slice(0, 70)}"`
          : element.type === 'shape'
            ? `${(element as { shape: string }).shape} fill=${(element as { fill: string | null }).fill} stroke=${(element as { stroke: string | null }).stroke}`
            : element.type === 'image' || element.type === 'video'
              ? `${(element as { src: string }).src} fit=${(element as { fit: string }).fit}`
              : JSON.stringify(element).slice(0, 90);
      console.log(`  [${element.type.padEnd(6)}] ${box.padEnd(24)} ${detail}`);
    }
  });
  if (compiled.warnings.length > 0) console.log('  warnings:', compiled.warnings);
  deck.slides = [...deck.slides, ...compiled.slides];
  report.push({ file, slides: compiled.slides });
}
await writeFile(join(root, 'elements.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`\nfull element dump: ${join(root, 'elements.json')}`);
