import type { Deck, Slide, SlideElement } from '@shared/deck.js';
import { parseDeck } from '@shared/deck.js';
import {
  type ClipboardWriteRequest,
  remapElementIds,
  remapSlideIds,
} from '@shared/clipboard.js';

/**
 * Editor state: the deck, the selection, and an undo history.
 *
 * Every mutation goes through `commit`, which snapshots the previous deck onto
 * an undo stack and notifies subscribers. Snapshotting whole decks is
 * unapologetically simple — a deck is a few hundred KB of JSON with media held
 * as file references, so the cost is irrelevant next to the bug surface of
 * hand-written inverse operations.
 */

export interface EditorState {
  dir: string | null;
  deck: Deck;
  slideIndex: number;
  /** Slide ids selected in the rail. The current slide is always included. */
  slideSelection: Set<string>;
  selection: Set<string>;
  dirty: boolean;
}

type Listener = (state: EditorState) => void;

export interface HistoryItem {
  id: number;
  label: string;
  at: number;
  slideIndex: number;
}

interface DeckHistoryItem extends HistoryItem {
  deck: Deck;
}

interface UndoItem {
  deck: Deck;
  label: string;
}

const HISTORY_LIMIT = 200;

export class EditorStore {
  /**
   * Fired whenever a local undo unit is born (commit, drag transaction end,
   * history replace) with the deck before and after. Unset in the Electron
   * shell; the collab shell diffs the pair into ops and sends them to the
   * server. Never fired for remote or external deck replacements.
   */
  onLocalEdit:
    | ((prev: Deck, next: Deck, label: string, coalesceKey?: string) => void)
    | null = null;

  private state: EditorState;
  private listeners = new Set<Listener>();
  private undoStack: UndoItem[] = [];
  private redoStack: UndoItem[] = [];
  private historyLog: DeckHistoryItem[] = [];
  private nextHistoryId = 1;
  /** Fixed end of a Shift-click range; ordinary slide selection resets it. */
  private slideSelectionAnchor = 0;
  /** Coalesces a drag into one undo entry instead of one per mousemove. */
  private txnBase: Deck | null = null;
  private txnLabel = 'Move or resize objects';

  constructor(deck: Deck, dir: string | null = null) {
    this.state = {
      dir,
      deck,
      slideIndex: 0,
      slideSelection: new Set(deck.slides[0] ? [deck.slides[0].id] : []),
      selection: new Set(),
      dirty: false,
    };
    this.recordHistory('Initial state');
  }

  get(): EditorState {
    return this.state;
  }

  get slide(): Slide | undefined {
    return this.state.deck.slides[this.state.slideIndex];
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  /** Replace the deck wholesale (open, import, external reload). Clears history. */
  load(deck: Deck, dir: string, opts: { keepView?: boolean } = {}): void {
    this.undoStack = [];
    this.redoStack = [];
    this.historyLog = [];
    // An external reload (agent edit, git) must not teleport the editor away
    // from the slide being worked on.
    const slideIndex = opts.keepView
      ? Math.min(this.state.slideIndex, Math.max(0, deck.slides.length - 1))
      : 0;
    this.slideSelectionAnchor = slideIndex;
    this.state = {
      dir,
      deck,
      slideIndex,
      slideSelection: new Set(deck.slides[slideIndex] ? [deck.slides[slideIndex].id] : []),
      selection: new Set(),
      dirty: false,
    };
    this.recordHistory('Opened deck');
    this.emit();
  }

  /**
   * Incorporate a deck written outside the editor without throwing away the
   * user's undo history or stable-id selection. Agent transactions and hand
   * edits therefore behave like ordinary, reversible editor actions.
   */
  replaceExternal(deck: Deck, dir: string, label = 'External edit'): void {
    const anchor = this.cursorAnchor();
    this.pushUndo(this.state.deck, label);
    this.state = { ...this.state, dir, deck: parseDeck(deck), dirty: false };
    this.restoreCursor(anchor);
    this.recordHistory(label);
    this.emit();
  }

  /** Replace the document as one local, dirty, undoable transaction. */
  replaceWithHistory(deck: Deck, label: string): void {
    const anchor = this.cursorAnchor();
    const previous = this.state.deck;
    this.pushUndo(previous, label);
    this.state = { ...this.state, deck: parseDeck(deck), dirty: true };
    this.restoreCursor(anchor);
    this.recordHistory(label);
    this.onLocalEdit?.(previous, this.state.deck, label);
    this.emit();
  }

  /**
   * Absorb a deck decided elsewhere (the collab server) without an undo entry
   * and without dirtying the document — persistence is the server's job. Slide
   * object identity is re-shared so untouched slides keep their DOM and
   * playing videos; the cursor stays on the same slide by id.
   */
  applyRemote(deck: Deck, label = 'Remote edit'): void {
    const anchor = this.cursorAnchor();
    const next = parseDeck(deck);
    shareUnchangedSlides(this.state.deck, next);
    this.state = { ...this.state, deck: next };
    this.restoreCursor(anchor);
    // Live typing arrives as a stream of same-label transactions; folding them
    // into one history entry keeps the History panel legible.
    this.recordHistory(label, { coalesce: true });
    this.emit();
  }

  /** The slide the user is looking at, named by id rather than by position. */
  private cursorAnchor(): string | null {
    return this.state.deck.slides[this.state.slideIndex]?.id ?? null;
  }

  /**
   * Put the cursor back on the slide it was on.
   *
   * A rewrite from outside — an agent transaction, a hand edit, a git checkout
   * — routinely inserts or removes slides ahead of the one being worked on.
   * Restoring by index would silently teleport the user; restoring by id is
   * what makes those edits feel like edits.
   */
  private restoreCursor(anchorSlideId: string | null): void {
    const at = anchorSlideId === null
      ? -1
      : this.state.deck.slides.findIndex((slide) => slide.id === anchorSlideId);
    if (at !== -1) this.state = { ...this.state, slideIndex: at };
    this.clampCursor();
  }

  /**
   * Apply a mutation to a structurally-cloned deck.
   *
   * The clone is what lets the undo stack hold plain references: no other code
   * can mutate a deck that history is holding.
   */
  commit(
    fn: (deck: Deck) => void,
    opts: { history?: boolean; label?: string; transient?: boolean; coalesceKey?: string } = {},
  ): void {
    const previous = this.state.deck;
    const next = structuredClone(previous) as Deck;
    fn(next);
    shareUnchangedSlides(previous, next);

    // Transient commits stream work in progress (live typing) to collaborators
    // without consuming undo slots or history entries; the coalesce key lets
    // the collab undo layer fold the stream into one undoable edit.
    if (opts.history !== false && !this.txnBase && !opts.transient) {
      this.pushUndo(previous, opts.label ?? 'Edit slide');
    }
    this.state = { ...this.state, deck: next, dirty: true };
    if (!this.txnBase) {
      if (!opts.transient) this.recordHistory(opts.label ?? 'Edit slide');
      this.onLocalEdit?.(previous, next, opts.label ?? 'Edit slide', opts.coalesceKey);
    }
    this.emit();
  }

  /**
   * Group everything until `endTransaction` into a single undo entry. Used for
   * drags and resizes, which fire continuously but mean one edit.
   */
  beginTransaction(label = 'Move or resize objects'): void {
    if (!this.txnBase) {
      this.txnBase = this.state.deck;
      this.txnLabel = label;
    }
  }

  endTransaction(): void {
    if (!this.txnBase) return;
    const base = this.txnBase;
    this.txnBase = null;
    // A drag that ended where it started shouldn't consume an undo slot.
    if (base !== this.state.deck) {
      this.pushUndo(base, this.txnLabel);
      this.recordHistory(this.txnLabel);
      this.onLocalEdit?.(base, this.state.deck, this.txnLabel);
    }
  }

  private pushUndo(deck: Deck, label: string): void {
    this.undoStack.push({ deck, label });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push({ deck: this.state.deck, label: prev.label });
    this.state = { ...this.state, deck: prev.deck, dirty: true };
    this.clampCursor();
    this.recordHistory(`Undo: ${prev.label}`);
    this.emit();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push({ deck: this.state.deck, label: next.label });
    this.state = { ...this.state, deck: next.deck, dirty: true };
    this.clampCursor();
    this.recordHistory(`Redo: ${next.label}`);
    this.emit();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  history(): HistoryItem[] {
    return this.historyLog.map(({ deck: _deck, ...item }) => ({ ...item })).reverse();
  }

  restoreHistory(id: number): boolean {
    const snapshot = this.historyLog.find((item) => item.id === id);
    if (!snapshot || snapshot.deck === this.state.deck) return false;
    const previous = this.state.deck;
    const slideIndex = Math.min(
      snapshot.slideIndex,
      Math.max(0, snapshot.deck.slides.length - 1),
    );
    this.pushUndo(this.state.deck, `Revert to ${snapshot.label}`);
    this.redoStack = [];
    this.state = {
      ...this.state,
      deck: structuredClone(snapshot.deck),
      slideIndex,
      slideSelection: new Set(snapshot.deck.slides[slideIndex]
        ? [snapshot.deck.slides[slideIndex].id]
        : []),
      selection: new Set(),
      dirty: true,
    };
    this.slideSelectionAnchor = this.state.slideIndex;
    this.recordHistory(`Reverted to ${snapshot.label}`);
    this.onLocalEdit?.(previous, this.state.deck, `Revert to ${snapshot.label}`);
    this.emit();
    return true;
  }

  markClean(): void {
    this.state = { ...this.state, dirty: false };
    this.emit();
  }

  selectSlide(index: number, extendRange = false): void {
    const clamped = Math.min(Math.max(index, 0), this.state.deck.slides.length - 1);
    const slide = this.state.deck.slides[clamped];
    if (!slide) return;
    const slideSelection = extendRange
      ? new Set(this.state.deck.slides
        .slice(
          Math.min(this.slideSelectionAnchor, clamped),
          Math.max(this.slideSelectionAnchor, clamped) + 1,
        )
        .map((candidate) => candidate.id))
      : new Set([slide.id]);
    if (!extendRange) this.slideSelectionAnchor = clamped;
    const unchanged = clamped === this.state.slideIndex
      && this.state.selection.size === 0
      && slideSelection.size === this.state.slideSelection.size
      && [...slideSelection].every((id) => this.state.slideSelection.has(id));
    if (unchanged) return;
    this.state = {
      ...this.state,
      slideIndex: clamped,
      slideSelection,
      selection: new Set(),
    };
    this.emit();
  }

  select(ids: string[], additive = false): void {
    const selection = additive ? new Set(this.state.selection) : new Set<string>();
    for (const id of ids) {
      if (additive && selection.has(id)) selection.delete(id);
      else selection.add(id);
    }
    const currentSlide = this.slide;
    this.slideSelectionAnchor = this.state.slideIndex;
    this.state = {
      ...this.state,
      slideSelection: new Set(currentSlide ? [currentSlide.id] : []),
      selection,
    };
    this.emit();
  }

  clearSelection(): void {
    const currentSlide = this.slide;
    const collapseRail = this.state.slideSelection.size > 1 && currentSlide;
    if (this.state.selection.size === 0 && !collapseRail) return;
    if (collapseRail) this.slideSelectionAnchor = this.state.slideIndex;
    this.state = {
      ...this.state,
      selection: new Set(),
      ...(collapseRail ? { slideSelection: new Set([currentSlide.id]) } : {}),
    };
    this.emit();
  }

  selectedElements(): SlideElement[] {
    const slide = this.slide;
    if (!slide) return [];
    return slide.elements.filter((e) => this.state.selection.has(e.id));
  }

  /** Slides selected in the rail, returned in deck order. */
  selectedSlides(): Slide[] {
    return this.state.deck.slides.filter((slide) => this.state.slideSelection.has(slide.id));
  }

  /** Mutate every selected element on the current slide in one commit. */
  updateSelected(
    fn: (el: SlideElement) => void,
    opts: { history?: boolean; label?: string } = {},
  ): void {
    const ids = this.state.selection;
    if (ids.size === 0) return;
    const index = this.state.slideIndex;
    this.commit((deck) => {
      for (const el of deck.slides[index].elements) {
        if (ids.has(el.id)) fn(el);
      }
    }, opts);
  }

  /** Remove the selected elements and any timeline entries that target them. */
  deleteSelection(): void {
    const ids = this.state.selection;
    if (ids.size === 0) return;
    const index = this.state.slideIndex;
    this.commit((deck) => {
      const slide = deck.slides[index];
      slide.elements = slide.elements.filter((e) => !ids.has(e.id));
      slide.timeline = slide.timeline.filter(
        (t) => !ids.has(t.action.target) && !(t.trigger.ref && ids.has(t.trigger.ref)),
      );
    }, { label: ids.size === 1 ? 'Delete object' : 'Delete objects' });
    this.clearSelection();
  }

  /** Keep the slide index and selection valid after history moves. */
  private clampCursor(): void {
    const count = this.state.deck.slides.length;
    const slideIndex = Math.min(this.state.slideIndex, Math.max(0, count - 1));
    const live = new Set(
      (this.state.deck.slides[slideIndex]?.elements ?? []).map((e) => e.id),
    );
    const liveSlideIds = new Set(this.state.deck.slides.map((slide) => slide.id));
    const slideSelection = new Set(
      [...this.state.slideSelection].filter((id) => liveSlideIds.has(id)),
    );
    const currentSlide = this.state.deck.slides[slideIndex];
    if (slideSelection.size === 0 && currentSlide) slideSelection.add(currentSlide.id);
    this.slideSelectionAnchor = slideIndex;
    this.state = {
      ...this.state,
      slideIndex,
      slideSelection,
      selection: new Set([...this.state.selection].filter((id) => live.has(id))),
    };
  }

  private recordHistory(label: string, opts: { coalesce?: boolean } = {}): void {
    const last = this.historyLog[this.historyLog.length - 1];
    if (opts.coalesce && last && last.label === label) {
      last.at = Date.now();
      last.slideIndex = this.state.slideIndex;
      last.deck = this.state.deck;
      return;
    }
    this.historyLog.push({
      id: this.nextHistoryId++,
      label,
      at: Date.now(),
      slideIndex: this.state.slideIndex,
      deck: this.state.deck,
    });
    if (this.historyLog.length > HISTORY_LIMIT) this.historyLog.shift();
  }
}

/**
 * Restore object identity for slides an edit did not touch.
 *
 * `commit` deliberately gives mutation callbacks a fully independent clone,
 * but the canvas and slide rail use slide identity to retain expensive DOM and
 * decoded media. Without this reconciliation, changing one layout in a large
 * imported deck rebuilds every thumbnail and can exhaust the renderer.
 */
export function shareUnchangedSlides(previous: Deck, next: Deck): void {
  const byId = new Map(previous.slides.map((slide) => [slide.id, slide]));
  for (let i = 0; i < next.slides.length; i++) {
    const candidate = byId.get(next.slides[i].id);
    if (candidate && JSON.stringify(candidate) === JSON.stringify(next.slides[i])) {
      next.slides[i] = candidate;
    }
  }
}

/**
 * Copy and paste, backed by the OS pasteboard.
 *
 * The payload crosses the system clipboard (via the main process) so that a
 * second running instance of the app can paste it into another deck; assets
 * are re-imported and ids re-minted on the way in. The module-level fallback
 * keeps copy/paste working when no system clipboard is reachable — a deck
 * that isn't open as a session yet, or tests without a preload bridge.
 */
let fallbackClipboard: ClipboardWriteRequest | null = null;

async function writeSystemClipboard(request: ClipboardWriteRequest): Promise<void> {
  fallbackClipboard = request;
  try {
    await window.api?.writeClipboard?.(request);
  } catch (err) {
    console.error('Could not write the system clipboard:', err);
  }
}

async function readSystemClipboard(): Promise<ClipboardWriteRequest | null> {
  try {
    const payload = await window.api?.readClipboard?.();
    if (payload) return payload;
  } catch (err) {
    console.error('Could not read the system clipboard:', err);
  }
  return fallbackClipboard;
}

export async function copySelectionToClipboard(store: EditorStore): Promise<number> {
  const els = store.selectedElements();
  if (els.length === 0) return 0;
  const ids = new Set(els.map((e) => e.id));
  // Builds ride along: an element that appears on click should still appear
  // on click after the paste. Entries triggered by elements staying behind
  // keep their action; the dangling ref is nulled during id remapping.
  const timeline = (store.slide?.timeline ?? []).filter((t) => ids.has(t.action.target));
  await writeSystemClipboard({
    kind: 'elements',
    elements: structuredClone(els),
    timeline: structuredClone(timeline),
  });
  return els.length;
}

export async function cutSelectionToClipboard(store: EditorStore): Promise<number> {
  const n = await copySelectionToClipboard(store);
  if (n > 0) store.deleteSelection();
  return n;
}

/** Copy whole slides (the rail selection, in deck order). */
export async function copySlidesToClipboard(store: EditorStore): Promise<number> {
  const slides = store.selectedSlides();
  if (slides.length === 0) return 0;
  await writeSystemClipboard({ kind: 'slides', slides: structuredClone(slides) });
  return slides.length;
}

/**
 * Paste whatever fragment is on the clipboard: elements land on the current
 * slide, slides land after it. Returns a summary for the status bar, or null
 * when the clipboard holds nothing of ours.
 */
export async function pasteFromClipboard(
  store: EditorStore,
): Promise<{ kind: 'elements' | 'slides'; count: number } | null> {
  const payload = await readSystemClipboard();
  if (!payload) return null;

  if (payload.kind === 'slides') {
    const slides = structuredClone(payload.slides);
    for (const slide of slides) remapSlideIds(slide);
    const at = store.get().slideIndex + 1;
    store.commit((deck) => {
      deck.slides.splice(at, 0, ...slides);
    }, { label: slides.length === 1 ? 'Paste slide' : `Paste ${slides.length} slides` });
    store.selectSlide(at + slides.length - 1);
    return { kind: 'slides', count: slides.length };
  }

  const elements = structuredClone(payload.elements);
  const timeline = structuredClone(payload.timeline);
  remapElementIds(elements, timeline);
  const created = elements.map((el) => el.id);
  store.commit((deck) => {
    const slide = deck.slides[store.get().slideIndex];
    if (!slide) return;
    const maxZ = slide.elements.reduce((m, e) => Math.max(m, e.z), 0);
    elements.forEach((el, i) => {
      el.x += 24;
      el.y += 24;
      if (el.type === 'shape' && el.control) {
        el.control.x += 24;
        el.control.y += 24;
      }
      el.z = maxZ + 1 + i;
      slide.elements.push(el);
    });
    slide.timeline.push(...timeline);
  }, { label: elements.length === 1 ? 'Paste object' : `Paste ${elements.length} objects` });
  store.select(created);
  return { kind: 'elements', count: elements.length };
}

export function deckFrom(raw: unknown): Deck {
  return parseDeck(raw);
}
