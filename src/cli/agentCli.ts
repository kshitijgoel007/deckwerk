import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
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
  validate  [deck]                        schema, ids, references, assets
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
    return EXIT_ERROR;
  }
}

/* --- commands --- */

async function contextCommand(argv: string[], io: CliIo): Promise<number> {
  const { positional } = parseFlags(argv);
  const deckDir = resolveDeckDir(positional[0], io);
  io.out(json(await currentContext(deckDir, { scenes: false, digest: true })));
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
  const { options, positional } = parseFlags(argv, ['html', 'after', 'label']);
  const deckDir = resolveDeckDir(positional[0], io);
  const htmlPath = options.get('html');
  if (!htmlPath) {
    io.err('apply needs --html <file>');
    return EXIT_USAGE;
  }

  const deck = await loadDeck(deckDir);
  // The same compile the editor performs on a watched save, in a headless
  // window because this path is the one taken with the editor closed.
  const { transaction, slides, warnings } = await htmlEditTransaction(
    deckDir,
    deck,
    resolve(io.cwd, htmlPath),
    { after: options.get('after') ?? null, label: options.get('label') },
  );

  return applyTransaction(deckDir, transaction, io, {
    slides: slides.map((slide) => ({
      id: slide.id,
      elements: slide.elements.map((element) => ({
        id: element.id, type: element.type,
        box: { x: element.x, y: element.y, w: element.w, h: element.h },
      })),
    })),
    // Inline style the browser's parser silently dropped: without this the
    // apply reports success while the page laid out without the declaration.
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

async function inspectCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const deckDir = resolveDeckDir(positional[0], io);

  if (flags.has('html')) {
    const deck = await loadDeck(deckDir);
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
  const deckDir = resolveDeckDir(positional[0], io);
  const outDir = options.get('output');
  if (!outDir) {
    io.err('render needs --output <dir>');
    return EXIT_USAGE;
  }

  const context = await currentContext(deckDir, { scenes: false });
  const deck = await loadDeck(deckDir);
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
  const { positional } = parseFlags(argv);
  const deckDir = resolveDeckDir(positional[0], io);
  const errors = await validateDeckFolder(deckDir);
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
  io.out(json({ valid: errors.length === 0, deckPath: deckDir, errors, importGaps }));
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
    const response = await request(deckDir, {
      version: AGENT_PROTOCOL_VERSION,
      id: requestId(),
      kind: 'transaction',
      transaction,
    });
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

/** `--selected` (default), `--slide <id>` or `--all`. */
function selectionFilter(
  flags: Set<string>,
): ((scene: { id: string; index: number; selected: boolean; active: boolean }) => boolean) | null {
  if (flags.has('all')) return null;
  const slideId = [...flags].find((flag) => flag.startsWith('slide='))?.slice('slide='.length);
  if (slideId) return (scene) => scene.id === slideId;
  return (scene) => scene.selected || scene.active;
}

async function request(deckDir: string, payload: Parameters<typeof writeAgentRequest>[1]) {
  const responsePath = await writeAgentRequest(deckDir, payload);
  return waitForAgentResponse(responsePath);
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

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A scratch directory for the export a render is captured from. */
export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
