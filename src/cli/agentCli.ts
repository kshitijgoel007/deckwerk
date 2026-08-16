import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AGENT_PROTOCOL_VERSION,
  AgentTransactionSchema,
  authoredScene,
  type AgentContext,
  type ComputedSlideScene,
} from '@shared/agent.js';
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

const USAGE = `usage: slide-agent <command> [options]

  context   [deck]                        current selection, revision, liveness
  inspect   [deck] [--selected|--slide id|--all] [--dom]
  render    [deck] [--selected|--slide id|--all] --output <dir> [--annotate] [--built]
  validate  [deck]                        schema, ids, references, assets
  asset import <deck> <paths...>          copy media into assets/, probed
  transaction apply <deck> <file.json>    one atomic, named change

Coordinates are absolute pixels on the deck canvas, origin top-left.
`;

export async function runAgentCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'context':
        return await contextCommand(rest, io);
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
  io.out(json(await currentContext(deckDir, { scenes: false })));
  return EXIT_OK;
}

async function inspectCommand(argv: string[], io: CliIo): Promise<number> {
  const { flags, positional } = parseFlags(argv);
  const deckDir = resolveDeckDir(positional[0], io);

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
  io.out(json({ valid: errors.length === 0, deckPath: deckDir, errors }));
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

  const transaction = AgentTransactionSchema.parse(
    JSON.parse(await readFile(resolve(io.cwd, file), 'utf8')),
  );

  // With the editor up, the transaction must go through it: its in-memory deck
  // is the real document, and routing through it is what makes the change one
  // undo entry rather than a surprise reload.
  const live = await readLiveAgentContext(deckDir);
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
    }));
    if (response.status === 'conflict') return EXIT_CONFLICT;
    return response.status === 'error' ? EXIT_ERROR : EXIT_OK;
  }

  const result = await applyTransactionOffline(deckDir, transaction);
  io.out(json({ status: 'applied', revision: result.revision, applied: true, live: false }));
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
  opts: { scenes: boolean },
): Promise<AgentContext & { diskRevision: string; stale: boolean }> {
  const deck = await loadDeck(deckDir);
  const diskRevision = deckRevision(deck);
  const live = await readLiveAgentContext(deckDir);
  if (live) {
    return {
      ...live,
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

export function resolveDeckDir(candidate: string | undefined, io: CliIo): string {
  const dir = resolve(io.cwd, candidate ?? '.');
  if (!existsSync(join(dir, DECK_FILE))) {
    throw new Error(`No ${DECK_FILE} in ${dir}. Pass the deck folder explicitly.`);
  }
  return dir;
}

/** `--flag`, `--key value` and bare positionals, with no dependency to install. */
export function parseFlags(argv: string[]): {
  flags: Set<string>;
  options: Map<string, string>;
  positional: string[];
} {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positional: string[] = [];
  const valued = new Set(['output']);

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
