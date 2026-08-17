import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AGENT_PROTOCOL_VERSION, type AgentTransaction } from '@shared/agent.js';
import type { Deck, Slide } from '@shared/deck.js';
import { htmlSlideScope, htmlSyncOperations, slidesToHtml } from '@shared/htmlSlides.js';
import { PLAYER_TYPE_CSS } from '@shared/playerTypeCss.js';
import { compileHtmlToSlides } from '../cli/compileHtml.js';
import { deckRevision } from './agentRuntime.js';

export const HTML_EDIT_DIR = 'edit';

/** Write the selected slides as one self-describing, authoritative HTML range. */
export async function writeHtmlScope(
  deckDir: string,
  deck: Deck,
  slideIds: string[],
): Promise<{ path: string; contents: string }> {
  const wanted = new Set(slideIds);
  const slides = deck.slides.filter((slide) => wanted.has(slide.id));
  if (slides.length === 0) throw new Error('Select at least one slide to edit as HTML');
  const editDir = join(deckDir, HTML_EDIT_DIR);
  await mkdir(editDir, { recursive: true });
  const first = safeName(slides[0].id);
  const last = slides.length > 1 ? `-${safeName(slides[slides.length - 1].id)}` : '';
  const path = join(editDir, `${first}${last}.html`);
  // The file lives one folder below the deck, so that is what its assets and
  // its stylesheet are relative to when the author opens it in a browser.
  const contents = slidesToHtml(slides, deck.canvas, {
    typeCss: PLAYER_TYPE_CSS,
    base: '../',
    theme: deck.theme,
  });
  await writeFile(path, contents, 'utf8');
  return { path, contents };
}

export interface HtmlEditOptions {
  /** Where new slides land when the file carries no recorded scope. */
  after?: string | null;
  label?: string;
}

/**
 * Compile an authoring file into the transaction that syncs its range, with a
 * headless browser.
 *
 * This is the editor-closed path, behind `slide-agent apply --html`. With the
 * editor open the same compile happens in its renderer instead
 * (`renderer/editor/htmlCompile.ts`), which is faster and applies in the live
 * document — but both produce the same transaction from the same walk.
 */
export async function htmlEditTransaction(
  deckDir: string,
  deck: Deck,
  htmlPath: string,
  options: HtmlEditOptions = {},
): Promise<{ transaction: AgentTransaction; slides: Slide[]; warnings: string[] }> {
  const authored = await readFile(htmlPath, 'utf8');
  const scope = htmlSlideScope(authored);
  const { slides, warnings } = await compileHtmlToSlides({ deckDir, deck, htmlPath });
  if (slides.length === 0 && scope === null) {
    throw new Error(`No slides found in ${basename(htmlPath)}.`
      + ' Wrap each slide in <section class="slide" data-slide-id="…">.');
  }
  const operations = htmlSyncOperations(
    deck,
    slides,
    scope,
    options.after ?? deck.slides[deck.slides.length - 1]?.id ?? null,
  );
  if (operations.length === 0) {
    throw new Error(`${basename(htmlPath)} compiles to what the deck already holds.`);
  }
  return {
    transaction: {
      version: AGENT_PROTOCOL_VERSION,
      expectedRevision: deckRevision(deck),
      label: options.label ?? `Update slides from ${basename(htmlPath)}`,
      operations,
    },
    slides,
    warnings,
  };
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'slides';
}
