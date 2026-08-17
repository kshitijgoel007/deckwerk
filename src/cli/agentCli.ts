import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_PROTOCOL_VERSION,
  AgentTransactionSchema,
  authoredScene,
  type AgentContext,
  type ComputedSlideScene,
} from '@shared/agent.js';
import { deckOutline, deckStyleDigest } from '@shared/deckDigest.js';
import { slidesToHtml } from '@shared/htmlSlides.js';
import { capabilities } from '@shared/capabilities.js';
import { PLAYER_TYPE_CSS } from '@shared/playerTypeCss.js';
import type { Deck } from '@shared/deck.js';
import { RevisionConflict, applyTransactionOffline, validateDeckFolder } from '../main/agentDeck.js';
import {
  deckRevision,
  readAgentContextFile,
  readLiveAgentContext,
  waitForAgentResponse,
  writeAgentRequest,
} from '../main/agentRuntime.js';
import { adoptAuthoredIds } from '@shared/htmlSlides.js';
import { DECK_FILE, importAsset, loadDeck } from '../main/deckStore.js';
import { htmlEditTransaction } from '../main/htmlAuthoring.js';
import { renderSlidesToPng } from './renderSlides.js';

/**
 * `slide-agent` — the filesystem-first agent interface.
 *
 * Everything is JSON on stdout, so an agent parses one thing rather than
 * scraping prose. Every command works whether or not the editor is running:
 * with it, inspection is the editor's *computed* view and edits land in its
 * undo history; without it, the same commands read and rewrite `deck.json`
 * directly under a lock.
 */

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  cwd: string;
}

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_CONFLICT = 3;

/**
 * A transaction as an agent may write it: the revision is optional, because
 * the CLI can resolve it far more reliably than a caller juggling hashes.
 */
const DraftTransactionSchema = AgentTransactionSchema.extend({
  expectedRevision: AgentTransactionSchema.shape.expectedRevision.optional(),
});
type DraftTransaction = z.infer<typeof DraftTransactionSchema>;

const USAGE = `usage: slide-agent <command> [options]

The loop — edit HTML, the editor syncs it back:

  context   [deck]                        the outline, and is the editor live
  inspect   [deck] --html [--selected|--slide id|--all]
                                          export slides as an editable page
  # then edit edit/<file>.html and save it; with the editor open the deck
  # follows within ~200ms. With it closed, apply the same file explicitly:
  apply     [deck] --html <file> [--after <slideId>] [--label <text>]

Everything else:

  docs                                    the full agent guide, as markdown
  capabilities                            every feature, with copyable JSON
  validate  [deck] [--slide id|--selected]
                                          schema, ids, references, assets, and
                                          canvas overflows (scoped to your slides)
  asset import <deck> <paths...>          copy media into assets/, probed
  inspect   [deck] [--dom]                computed scenes, for questions
  render    [deck] [--selected|--slide id|--all] --output <dir> [--annotate] [--built]
  transaction apply <deck> <file.json>    JSON fallback, for tooling with no
                                          browser — not how slides are authored

Do not hand-compute geometry: write CSS and let the browser measure.
`;

export async function runAgentCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'docs':
        // Markdown, not JSON: this one is for an agent to read, and it is how
        // an agent working in a deck folder finds the format documentation
        // without knowing where the editor is installed.
        io.out(await readFile(agentGuidePath(), 'utf8'));
        return EXIT_OK;
      case 'capabilities':
        // Bare, it is the whole cookbook; named, just the features asked for,
        // for when an agent only needs to check how cropping works.
        io.out(json(capabilitiesReport(parseFlags(rest).positional)));
        return EXIT_OK;
      case 'context':
        return await contextCommand(rest, io);
      case 'apply':
        return await applyCommand(rest, io);
      case 'inspect':
        return await inspectCommand(rest, io);
      case 'render':
        return await renderCommand(rest, io);
      case 'validate':
        return await validateCommand(rest, io);
      case 'asset':
        return await assetCommand(rest, io);
      case 'transaction':
        return await transactionCommand(rest, io);
      case 'help':
      case '--help':
      case undefined:
        io.out(USAGE);
        return command === undefined ? EXIT_USAGE : EXIT_OK;
      default:
        io.err(`Unknown command: ${command}\n\n${USAGE}`);
        return EXIT_USAGE;
    }
  } catch (error) {
    if (error instanceof RevisionConflict) {
      io.out(json({ status: 'conflict', revision: error.revision, message: error.message }));
      return EXIT_CONFLICT;
    }
    io.err(error instanceof Error ? error.message : String(error));
    return error instanceof UsageError ? EXIT_USAGE : EXIT_ERROR;
  }
}

/* --- commands --- */

async function contextCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  ensureKnownFlags('context', flags, []);
  ensurePositionals('context', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const context = await currentContext(deckDir, { scenes: false, digest: true });
  const outline = (context as { outline?: unknown[] }).outline ?? [];
  // The count first, before hundreds of outline entries: an agent that pipes
  // this through `head` must not mistake the visible outline for the deck.
  // Outline entries are one line each — pretty-printing them tripled the size
  // of the output an agent reads on every task, for no information at all.
  io.out(jsonCompactArrays({ slideCount: outline.length, ...context }, ['outline']));
  return EXIT_OK;
}

/**
 * Author slides in HTML and CSS.
 *
 * The browser lays the markup out; what lands in the deck is ordinary objects
 * with the geometry it computed. Slides whose `data-slide-id` already exists
 * are replaced, so the same file can be edited and recompiled; new ones are
 * inserted after `--after`, or appended.
 */
async function applyCommand(argv: string[], io: CliIo): Promise<number> {
  // `--html` takes a filename here, while `inspect --html` is a bare flag, so
  // the value-taking flags are named per command rather than globally.
  const { flags, options, positional } = parseFlags(argv, ['html', 'after', 'label']);
  ensureKnownFlags('apply', flags, []);
  ensurePositionals('apply', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const htmlPath = options.get('html');
  if (!htmlPath) {
    io.err('apply needs --html <file>');
    return EXIT_USAGE;
  }

  const deck = await loadDeck(deckDir);
  const filePath = resolve(io.cwd, htmlPath);
  const authoredBefore = await readFile(filePath, 'utf8');
  // The same compile the editor performs on a watched save, in a headless
  // window because this path is the one taken with the editor closed.
  const { transaction, slides } = await htmlEditTransaction(
    deckDir,
    deck,
    filePath,
    { after: options.get('after') ?? null, label: options.get('label') },
  );

  const code = await applyTransaction(deckDir, transaction, io, {
    slides: slides.map((slide) => ({
      id: slide.id,
      elements: slide.elements.map((element) => ({
        id: element.id, type: element.type,
        box: { x: element.x, y: element.y, w: element.w, h: element.h },
      })),
    })),
  });

  // Stamp the assigned ids back into the file so applying it again replaces
  // these slides instead of inserting them a second time. Skipped if the file
  // changed while the compile ran — stamping ids onto contents that were not
  // compiled would misattribute them.
  if (code === EXIT_OK) {
    const authored = await readFile(filePath, 'utf8');
    if (authored === authoredBefore) {
      const adopted = adoptAuthoredIds(authored, slides);
      if (adopted) await writeFile(filePath, adopted, 'utf8');
    }
  }
  return code;
}

async function inspectCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  ensureKnownFlags('inspect', flags, ['html', 'dom', 'selected', 'slide', 'all']);
  ensurePositionals('inspect', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);

  if (flags.has('html')) {
    const deck = await loadDeck(deckDir);
    ensureSlideIdsExist(flags, deck);
    const context = await currentContext(deckDir, { scenes: false });
    const wanted = selectionFilter(flags);
    const chosen = deck.slides.filter((slide, index) => !wanted || wanted({
      id: slide.id,
      index,
      selected: context.selectedSlideIds.includes(slide.id),
      active: slide.id === context.activeSlideId,
    }));
    // Written to a file the agent opens in a browser, so it has to be a page
    // and not a fragment: the deck's stylesheet, the type rules, and a base
    // that assumes the conventional home of `edit/` inside the deck.
    io.out(slidesToHtml(chosen, deck.canvas, {
      typeCss: PLAYER_TYPE_CSS,
      base: '../',
      theme: deck.theme,
    }));
    return EXIT_OK;
  }

  if (flags.has('dom')) {
    const live = await readLiveAgentContext(deckDir);
    if (!live) {
      io.err('--dom needs the editor running; it renders the live DOM. Use plain inspect otherwise.');
      return EXIT_ERROR;
    }
    const response = await request(deckDir, {
      version: AGENT_PROTOCOL_VERSION,
      id: requestId(),
      kind: 'dom',
      expectedRevision: live.deckRevision,
    });
    if (response.status === 'conflict') {
      io.out(json({ status: 'conflict', revision: response.revision, message: response.message }));
      return EXIT_CONFLICT;
    }
    if (response.status === 'error') {
      io.err(response.message ?? 'The editor could not produce the DOM');
      return EXIT_ERROR;
    }
    io.out(json({ live: true, revision: response.revision, dom: response.payload }));
    return EXIT_OK;
  }

  ensureSlideIdsExist(flags, await loadDeck(deckDir));
  const context = await currentContext(deckDir, { scenes: true });
  const wanted = selectionFilter(flags);
  io.out(json({
    ...context,
    scenes: wanted ? context.scenes.filter((scene) => wanted(scene)) : context.scenes,
  }));
  return EXIT_OK;
}


async function renderCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, options, positional } = parseFlags(argv);
  ensureKnownFlags('render', flags, ['selected', 'slide', 'all', 'annotate', 'built']);
  ensurePositionals('render', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const outDir = options.get('output');
  if (!outDir) {
    io.err('render needs --output <dir>');
    return EXIT_USAGE;
  }

  const context = await currentContext(deckDir, { scenes: false });
  const deck = await loadDeck(deckDir);
  ensureSlideIdsExist(flags, deck);
  const wanted = selectionFilter(flags);
  const chosen = deck.slides
    .map((slide, index) => ({ id: slide.id, number: index + 1, index, slide }))
    .filter((entry) => !wanted || wanted({
      id: entry.id,
      index: entry.index,
      selected: context.selectedSlideIds.includes(entry.id),
      active: entry.id === context.activeSlideId,
    }));
  if (chosen.length === 0) {
    io.err('Nothing to render: no slide matched.');
    return EXIT_ERROR;
  }

  const images = await renderSlidesToPng({
    deckDir,
    deck,
    outDir: resolve(io.cwd, outDir),
    slides: chosen.map(({ id, number }) => ({ id, number })),
    annotate: flags.has('annotate'),
    built: flags.has('built'),
    selectedElementIds: context.selectedElementIds,
  });
  io.out(json({ revision: context.deckRevision, images }));
  return EXIT_OK;
}

async function validateCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  ensureKnownFlags('validate', flags, ['slide', 'selected', 'all']);
  ensurePositionals('validate', positional, 1);
  const deckDir = resolveDeckDir(positional[0], io);
  const errors = await validateDeckFolder(deckDir);

  // Per-slide findings can be scoped: an agent that touched three slides
  // wants its own report, not the whole deck's pre-existing bleeds drowning
  // it. Structural errors stay deck-wide — a broken deck is broken for
  // everyone. With no scope flags, the whole deck is reported as before.
  const scoped = flags.has('selected') || requestedSlideIds(flags).length > 0;
  let wanted: ((scene: { id: string; index: number; selected: boolean; active: boolean }) => boolean) | null = null;
  let selectedSlideIds: string[] = [];
  if (scoped) {
    selectedSlideIds = (await currentContext(deckDir, { scenes: false })).selectedSlideIds;
    wanted = selectionFilter(flags);
    try {
      ensureSlideIdsExist(flags, await loadDeck(deckDir));
    } catch (error) {
      // A stale id is a usage error; an unparseable deck is already in `errors`.
      if (error instanceof UsageError) throw error;
    }
  }
  let importGaps: Array<{
    slideId: string; elementId: string; originalType: string; note: string;
  }> = [];
  try {
    const deck = await loadDeck(deckDir);
    importGaps = deck.slides.flatMap((slide) => slide.elements
      .filter((element) => element.type === 'unsupported')
      .map((element) => ({
        slideId: slide.id,
        elementId: element.id,
        originalType: element.originalType,
        note: element.note,
      })));
  } catch {
    // The parse failure is already represented in `errors`.
  }
  // Elements reaching past the canvas, reported from authored geometry so it
  // works with no browser. Warnings, not errors: a picture bleeding off the
  // edge is a real design — but a text box running off the bottom is the
  // classic silent authoring failure, and this is the only offline place an
  // agent can catch it without rendering a PNG.
  let overflows: Array<{ slideId: string; elementId: string; type: string; beyond: Record<string, number> }> = [];
  try {
    const deck = await loadDeck(deckDir);
    overflows = deck.slides.flatMap((slide) => slide.elements.flatMap((element) => {
      const beyond: Record<string, number> = {};
      if (element.x < 0) beyond.left = round2(-element.x);
      if (element.y < 0) beyond.top = round2(-element.y);
      if (element.x + element.w > deck.canvas.w) beyond.right = round2(element.x + element.w - deck.canvas.w);
      if (element.y + element.h > deck.canvas.h) beyond.bottom = round2(element.y + element.h - deck.canvas.h);
      return Object.keys(beyond).length > 0
        ? [{ slideId: slide.id, elementId: element.id, type: element.type, beyond }]
        : [];
    }));
  } catch {
    // The parse failure is already represented in `errors`.
  }
  if (wanted) {
    const filter = wanted;
    const keep = (slideId: string): boolean =>
      filter({ id: slideId, index: 0, selected: selectedSlideIds.includes(slideId), active: false });
    importGaps = importGaps.filter((gap) => keep(gap.slideId));
    overflows = overflows.filter((overflow) => keep(overflow.slideId));
  }

  io.out(jsonCompactArrays(
    {
      valid: errors.length === 0,
      deckPath: deckDir,
      ...(scoped ? { scope: requestedSlideIds(flags).length > 0 ? requestedSlideIds(flags) : 'selected' } : {}),
      errors,
      importGaps,
      overflows,
    },
    ['overflows'],
  ));
  return errors.length === 0 ? EXIT_OK : EXIT_ERROR;
}

async function assetCommand(argv: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'import') {
    io.err(`Unknown asset command: ${sub ?? '(none)'}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { positional } = parseFlags(rest);
  const deckDir = resolveDeckDir(positional[0], io);
  const paths = positional.slice(1);
  if (paths.length === 0) {
    io.err('asset import needs at least one file path');
    return EXIT_USAGE;
  }

  const assets = [];
  const failures = [];
  for (const path of paths) {
    try {
      assets.push(await importAsset(deckDir, resolve(io.cwd, path)));
    } catch (error) {
      // One unsupported file in a batch must not lose the imports that worked.
      failures.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  io.out(json({ assets, failures }));
  return failures.length > 0 && assets.length === 0 ? EXIT_ERROR : EXIT_OK;
}

async function transactionCommand(argv: string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'apply') {
    io.err(`Unknown transaction command: ${sub ?? '(none)'}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { positional } = parseFlags(rest);
  const deckDir = resolveDeckDir(positional[0], io);
  const file = positional[1];
  if (!file) {
    io.err('transaction apply needs a transaction file');
    return EXIT_USAGE;
  }

  const draft = DraftTransactionSchema.parse(
    JSON.parse(await readFile(resolve(io.cwd, file), 'utf8')),
  );
  return applyTransaction(deckDir, draft, io);
}

/**
 * Send one transaction, resolving the revision on the agent's behalf.
 *
 * Quoting a hash is ceremony an agent should not have to perform: the CLI
 * knows the current revision, and reading it here narrows the conflict window
 * to changes that land *during* the call — which is the only case where a
 * conflict was ever protecting anything. An explicit `expectedRevision` is
 * still honoured, for a caller that prepared its change earlier and wants the
 * check.
 */
async function applyTransaction(
  deckDir: string,
  draft: DraftTransaction,
  io: CliIo,
  extra: Record<string, unknown> = {},
): Promise<number> {
  const live = await readLiveAgentContext(deckDir);
  const expectedRevision = draft.expectedRevision
    ?? live?.deckRevision
    ?? deckRevision(await loadDeck(deckDir));
  const transaction = AgentTransactionSchema.parse({ ...draft, expectedRevision });

  // With the editor up, the transaction must go through it: its in-memory deck
  // is the real document, and routing through it is what makes the change one
  // undo entry rather than a surprise reload.
  if (live) {
    // A generous wait: the editor may be busy compiling a watched save of the
    // very same file. Timing out while the editor still applies the change is
    // worse than waiting — the caller's natural reaction is to apply again.
    const response = await request(deckDir, {
      version: AGENT_PROTOCOL_VERSION,
      id: requestId(),
      kind: 'transaction',
      transaction,
    }, 120_000);
    io.out(json({
      status: response.status,
      revision: response.revision,
      applied: response.status === 'applied',
      live: true,
      ...(response.message ? { message: response.message } : {}),
      ...extra,
    }));
    if (response.status === 'conflict') return EXIT_CONFLICT;
    return response.status === 'error' ? EXIT_ERROR : EXIT_OK;
  }

  const result = await applyTransactionOffline(deckDir, transaction);
  io.out(json({
    status: 'applied', revision: result.revision, applied: true, live: false, ...extra,
  }));
  return EXIT_OK;
}

/* --- shared helpers --- */

/**
 * The agent's view of the deck right now.
 *
 * A live editor is authoritative: it holds unsaved edits and the real
 * selection, and its scenes are measured rather than inferred. Offline, the
 * deck on disk is the truth and the last sidecar is used only as a hint about
 * what the user was last looking at.
 */
export async function currentContext(
  deckDir: string,
  opts: { scenes: boolean; digest?: boolean },
): Promise<AgentContext & { diskRevision: string; stale: boolean }> {
  const deck = await loadDeck(deckDir);
  const diskRevision = deckRevision(deck);
  // The outline and the house style are what an agent needs before it can
  // place anything, and deriving them here is what saves it from reading every
  // slide to work them out.
  const digest = opts.digest
    ? { outline: deckOutline(deck), style: deckStyleDigest(deck) }
    : {};
  const live = await readLiveAgentContext(deckDir);
  if (live) {
    return {
      ...live,
      ...digest,
      scenes: opts.scenes ? live.scenes : [],
      diskRevision,
      stale: live.deckRevision !== diskRevision,
    };
  }

  const remembered = await readAgentContextFile(deckDir);
  const slideIds = new Set(deck.slides.map((slide) => slide.id));
  const selectedSlideIds = (remembered?.selectedSlideIds ?? []).filter((id) => slideIds.has(id));
  const fallback = selectedSlideIds.length > 0
    ? selectedSlideIds
    : deck.slides[0] ? [deck.slides[0].id] : [];
  const selectedElementIds = (remembered?.selectedElementIds ?? []).filter((id) =>
    deck.slides.some((slide) => slide.elements.some((element) => element.id === id)));
  // The slide the user was last on, if it is still there. Offline this is a
  // memory rather than a fact, but it is a far better default than "slide 1".
  const activeIndex = Math.max(
    0,
    deck.slides.findIndex((slide) => slide.id === remembered?.activeSlideId),
  );
  const activeSlideId = deck.slides[activeIndex]?.id ?? null;

  return {
    ...digest,
    version: AGENT_PROTOCOL_VERSION,
    live: false,
    sessionId: remembered?.sessionId ?? '',
    pid: remembered?.pid ?? process.pid,
    updatedAt: new Date().toISOString(),
    deckPath: deckDir,
    deckRevision: diskRevision,
    activeSlideId,
    activeSlideIndex: activeIndex,
    selectedSlideIds: fallback,
    selectedElementIds,
    scenes: opts.scenes
      ? authoredScenes(deck, new Set(fallback), new Set(selectedElementIds), activeSlideId)
      : [],
    diskRevision,
    // Offline the deck on disk *is* the revision, so nothing can be stale;
    // a leftover sidecar contributed a hint at the selection, nothing more.
    stale: Boolean(remembered?.live),
  };
}

function authoredScenes(
  deck: Deck,
  selectedSlideIds: Set<string>,
  selectedElementIds: Set<string>,
  activeSlideId: string | null,
): ComputedSlideScene[] {
  return deck.slides.map((slide, index) =>
    authoredScene(deck, slide, index, selectedSlideIds, selectedElementIds, activeSlideId));
}

/** A caller mistake, reported as usage rather than as a failure of the tool. */
export class UsageError extends Error {}

/**
 * Refuse flags a command does not know.
 *
 * A misspelt flag that is silently dropped does not fail — it does something
 * *else*: `inspect --slides x` once fell back to the current selection and
 * exported a different slide than the one named, and everything downstream of
 * that export was wrong. An agent can recover from an error; it cannot recover
 * from the wrong slide.
 */
function ensureKnownFlags(command: string, flags: Set<string>, allowed: string[]): void {
  for (const flag of flags) {
    const name = flag.split('=', 1)[0];
    if (allowed.includes(name)) continue;
    const hint = name === 'slides' ? ' Did you mean --slide <id>?'
      : allowed.find((known) => known.startsWith(name) || name.startsWith(known))
        ? ` Did you mean --${allowed.find((known) => known.startsWith(name) || name.startsWith(known))}?`
        : '';
    throw new UsageError(`Unknown flag --${name} for ${command}.`
      + (allowed.length > 0 ? ` Known flags: ${allowed.map((known) => `--${known}`).join(', ')}.` : '')
      + hint);
  }
}

/** Refuse stray positionals — usually the value of a flag that was misspelt. */
function ensurePositionals(command: string, positional: string[], max: number): void {
  if (positional.length > max) {
    throw new UsageError(`Unexpected argument for ${command}: ${positional.slice(max).join(' ')}.`
      + ' The only positional argument is the deck folder.');
  }
}

/** The ids named by `--slide`, each flag holding one id or a comma-separated list. */
function requestedSlideIds(flags: Set<string>): string[] {
  return [...flags]
    .filter((flag) => flag.startsWith('slide='))
    .flatMap((flag) => flag.slice('slide='.length).split(','))
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * A `--slide` naming a slide that does not exist must be an error, not an
 * empty (or fallback) result: the caller is holding a stale id, and the sooner
 * it re-reads `context` the less it builds on the wrong slide.
 */
function ensureSlideIdsExist(flags: Set<string>, deck: Deck): void {
  const known = new Set(deck.slides.map((slide) => slide.id));
  const missing = requestedSlideIds(flags).filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new UsageError(`No such slide: ${missing.join(', ')}.`
      + ' Run `slide-agent context` for the current outline.');
  }
}

/** `--selected` (default), `--slide <id>` (repeatable, or comma-separated) or `--all`. */
function selectionFilter(
  flags: Set<string>,
): ((scene: { id: string; index: number; selected: boolean; active: boolean }) => boolean) | null {
  if (flags.has('all')) return null;
  const slideIds = new Set(requestedSlideIds(flags));
  if (slideIds.size > 0) return (scene) => slideIds.has(scene.id);
  return (scene) => scene.selected || scene.active;
}

async function request(
  deckDir: string,
  payload: Parameters<typeof writeAgentRequest>[1],
  timeoutMs?: number,
) {
  const responsePath = await writeAgentRequest(deckDir, payload);
  return waitForAgentResponse(responsePath, timeoutMs);
}

function requestId(): string {
  return `req-${randomUUID()}`;
}

/**
 * Every feature, with a working example of each.
 *
 * Read this before authoring anything: an agent that does not know KaTeX is
 * built in will lay an equation out by hand, and one that does not know about
 * `sourceBox` will ask for a figure to be re-exported to crop it. The examples
 * are the same declarations the reference deck is generated from, so each one
 * can also be looked at as a rendered slide or as real markup.
 */
export function capabilitiesReport(only: string[] = []): unknown {
  const deck = referenceDeckPath();
  const wanted = new Set(only);
  const artifact = (kind: 'preview' | 'html', id: string, extension: string) => {
    const path = join(deck, kind, `${id}.${extension}`);
    return existsSync(path) ? path : null;
  };

  return {
    referenceDeck: existsSync(deck) ? deck : null,
    howToUse: [
      'Copy an element from `elements` and change the ids, geometry and text.',
      'Element ids must be unique across the whole deck.',
      'Open `screenshot` to see what the feature looks like, `html` for the markup it renders to.',
      'Sizes and colours belong in theme.css via the class, not in inline style.',
    ],
    capabilities: capabilities()
      .filter((capability) => wanted.size === 0 || wanted.has(capability.id))
      .map((capability) => ({
        ...capability,
        screenshot: artifact('preview', capability.id, 'png'),
        html: artifact('html', capability.id, 'html'),
      })),
  };
}

export function referenceDeckPath(): string {
  return fileURLToPath(new URL('../../examples/agent-reference', import.meta.url));
}

/** The guide ships with the editor, so it is found relative to this module. */
export function agentGuidePath(): string {
  return fileURLToPath(new URL('../../AGENTS.md', import.meta.url));
}

export function resolveDeckDir(candidate: string | undefined, io: CliIo): string {
  const dir = resolve(io.cwd, candidate ?? '.');
  if (!existsSync(join(dir, DECK_FILE))) {
    throw new Error(`No ${DECK_FILE} in ${dir}. Pass the deck folder explicitly.`);
  }
  return dir;
}

/** `--flag`, `--key value` and bare positionals, with no dependency to install. */
export function parseFlags(argv: string[], valuedFlags: string[] = ['output']): {
  flags: Set<string>;
  options: Map<string, string>;
  positional: string[];
} {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positional: string[] = [];
  const valued = new Set(valuedFlags);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) {
      if (valued.has(name)) options.set(name, inline);
      else flags.add(`${name}=${inline}`);
      continue;
    }
    if (valued.has(name) || name === 'slide') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--${name} needs a value`);
      if (valued.has(name)) options.set(name, value);
      else flags.add(`${name}=${value}`);
      continue;
    }
    flags.add(name);
  }
  return { flags, options, positional };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Pretty-printed JSON, except that each element of the named top-level arrays
 * is emitted on a single line. Still perfectly parseable; a third the bytes
 * for list-shaped output an agent pays tokens to read.
 */
function jsonCompactArrays(value: Record<string, unknown>, keys: string[]): string {
  const parts = Object.entries(value).map(([key, entry]) => {
    if (keys.includes(key) && Array.isArray(entry)) {
      const items = entry.map((item) => `    ${JSON.stringify(item)}`).join(',\n');
      return `  ${JSON.stringify(key)}: [\n${items}\n  ]`;
    }
    const printed = JSON.stringify(entry, null, 2);
    return `  ${JSON.stringify(key)}: ${printed === undefined ? 'null' : printed.replace(/\n/g, '\n  ')}`;
  });
  return `{\n${parts.join(',\n')}\n}\n`;
}

/** A scratch directory for the export a render is captured from. */
export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
