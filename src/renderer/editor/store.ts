import type { Deck, Slide, SlideElement } from '@shared/deck.js';
import { parseDeck } from '@shared/deck.js';
import { applyAgentOperations, type AgentOperation } from '@shared/agent.js';
import { diffDecks } from '@shared/deckDiff.js';
import {
  type ClipboardReadResult,
  type ClipboardWriteRequest,
  remapElementIds,
  remapSlideIds,
} from '@shared/clipboard.js';
import { makeId } from '@shared/geometry.js';
import { pastedTableData } from '@shared/paragraphs.js';
import type {
  DeckHistoryDocument,
} from '@shared/deckHistory.js';

/**
 * Editor state: the deck, the selection, and an undo history.
 *
 * Mutations become semantic forward/inverse operations for undo and persisted
 * history. Generic deck edits retain a fully isolated clone, while the hot
 * selected-element path uses copy-on-write for only the current slide branch.
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
  /** Longer explanation shown beneath the compact history title. */
  description?: string;
  /** Saved embedded Agent conversation that produced this state. */
  agentChatId?: string;
  at: number;
  slideIndex: number;
}

export interface RemoteHistoryOptions {
  coalesce?: boolean;
  /** False for synchronization events such as filesystem reloads/resyncs. */
  history?: boolean;
  description?: string;
  agentChatId?: string;
}

interface DeckHistoryItem extends HistoryItem {
  /** Operations from the preceding entry; empty for the base entry. */
  operations: AgentOperation[];
}

interface UndoItem {
  label: string;
  forward: AgentOperation[];
  inverse: AgentOperation[];
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

  /** Signals that the independently persisted history needs a later flush. */
  onHistoryChange: (() => void) | null = null;

  private state: EditorState;
  private listeners = new Set<Listener>();
  private historyListeners = new Set<() => void>();
  private undoStack: UndoItem[] = [];
  private redoStack: UndoItem[] = [];
  private historyLog: DeckHistoryItem[] = [];
  /** Materialized state represented by historyLog[0]. */
  private historyBase: Deck | null = null;
  /** One materialized cache for diffing the next history entry. */
  private historyTipDeck: Deck | null = null;
  /** The history row represented by `state.deck`, or null for an unrecorded state. */
  private currentHistoryId: number | null = null;
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
  }

  get(): EditorState {
    return this.state;
  }

  /** Whether pointer-driven edits are currently being grouped into one change. */
  isTransactionActive(): boolean {
    return this.txnBase !== null;
  }

  get slide(): Slide | undefined {
    return this.state.deck.slides[this.state.slideIndex];
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Subscribe only to history metadata/current-row changes, not canvas selection churn. */
  subscribeHistory(fn: () => void): () => void {
    this.historyListeners.add(fn);
    return () => this.historyListeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  private emitHistory(): void {
    for (const fn of this.historyListeners) fn();
  }

  /** Replace the deck wholesale and hydrate its independently persisted history. */
  load(
    deck: Deck,
    dir: string,
    opts: { keepView?: boolean; history?: DeckHistoryDocument } = {},
  ): void {
    this.undoStack = [];
    this.redoStack = [];
    const persisted = opts.history;
    try {
      this.historyBase = persisted?.base ? parseDeck(persisted.base) : null;
      this.historyLog = (persisted?.entries ?? []).slice(-HISTORY_LIMIT).map((item) => ({
        ...item,
        id: this.nextHistoryId++,
        operations: structuredClone(item.operations),
        slideIndex: Math.max(0, item.slideIndex),
      }));
      this.historyTipDeck = this.materializeHistoryIndex(this.historyLog.length - 1);
    } catch (error) {
      // A semantically broken sidecar is expendable. It must never prevent the
      // presentation itself from opening.
      console.error('Could not hydrate edit history:', error);
      this.historyBase = null;
      this.historyLog = [];
      this.historyTipDeck = null;
    }
    const persistedTip = this.historyLog[this.historyLog.length - 1];
    this.currentHistoryId = persistedTip && this.historyTipDeck
      && sameDeck(this.historyTipDeck, deck)
      ? persistedTip.id
      : null;
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
    this.emitHistory();
    this.emit();
  }

  /**
   * Incorporate a deck written outside the editor without throwing away the
   * user's undo history or stable-id selection. Agent transactions and hand
   * edits therefore behave like ordinary, reversible editor actions.
   */
  replaceExternal(deck: Deck, dir: string): void {
    const anchor = this.cursorAnchor();
    // A disk reload is a new synchronization baseline, not an authored edit.
    // Keeping pre-reload undo entries would make Command-Z silently restore
    // stale file contents, so both stacks stop at this boundary.
    this.undoStack = [];
    this.redoStack = [];
    this.txnBase = null;
    this.state = { ...this.state, dir, deck: parseDeck(deck), dirty: false };
    this.currentHistoryId = null;
    this.restoreCursor(anchor);
    this.emitHistory();
    this.emit();
  }

  /** Replace the document as one local, dirty, undoable transaction. */
  replaceWithHistory(deck: Deck, label: string): void {
    const anchor = this.cursorAnchor();
    const previous = this.state.deck;
    this.state = { ...this.state, deck: parseDeck(deck), dirty: true };
    this.pushUndo(previous, this.state.deck, label);
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
  applyRemote(
    deck: Deck,
    label = 'Remote edit',
    opts: RemoteHistoryOptions = {},
  ): void {
    const anchor = this.cursorAnchor();
    const next = parseDeck(deck);
    // Server acknowledgements normally contain the optimistic state already
    // on screen. Recording them again creates duplicate/misattributed rows and
    // makes the apparent current revision depend on network timing.
    if (sameDeck(this.state.deck, next)) return;
    shareUnchangedSlides(this.state.deck, next);
    this.state = { ...this.state, deck: next };
    this.restoreCursor(anchor);
    // Live typing arrives as a stream of same-label transactions; folding them
    // into one history entry keeps the History panel legible.
    if (opts.history !== false) {
      this.recordHistory(label, {
        coalesce: opts.coalesce ?? true,
        description: opts.description,
        agentChatId: opts.agentChatId,
      });
    } else {
      this.currentHistoryId = null;
      this.emitHistory();
    }
    this.emit();
  }

  /**
   * Re-baseline on the server's deck after a reconnect.
   *
   * A dropped WebSocket is not a new document. Reloading through `load` reset
   * the restorable revision log, both undo stacks and the element selection, so
   * a momentary network blip destroyed every revision the History panel held
   * even though the document had not changed. The log and the selection survive
   * here; the undo stacks deliberately do not, because a reconnect abandons the
   * unconfirmed transactions those inverses were computed against, and replaying
   * them would apply edits to a base the server never saw.
   */
  resyncRemote(deck: Deck, dir: string): void {
    const anchor = this.cursorAnchor();
    const next = parseDeck(deck);
    this.undoStack = [];
    this.redoStack = [];
    shareUnchangedSlides(this.state.deck, next);
    this.state = { ...this.state, dir, deck: next, dirty: false };
    this.currentHistoryId = null;
    this.restoreCursor(anchor);
    // Selection is by stable id, so drop only ids the new deck no longer has.
    const live = new Set(this.state.deck.slides.flatMap((slide) => slide.elements.map((e) => e.id)));
    this.state = {
      ...this.state,
      selection: new Set([...this.state.selection].filter((id) => live.has(id))),
    };
    this.emitHistory();
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
   * Apply an arbitrary mutation to a structurally-cloned deck.
   *
   * Narrow high-frequency operations use copy-on-write helpers instead; this
   * fallback keeps unconstrained callers isolated from the current state.
   */
  commit(
    fn: (deck: Deck) => void,
    opts: { history?: boolean; label?: string; transient?: boolean; coalesceKey?: string } = {},
  ): void {
    const previous = this.state.deck;
    const next = structuredClone(previous) as Deck;
    fn(next);
    shareUnchangedSlides(previous, next);
    this.finishCommit(previous, next, opts);
  }

  private finishCommit(
    previous: Deck,
    next: Deck,
    opts: { history?: boolean; label?: string; transient?: boolean; coalesceKey?: string },
  ): void {
    const forward = diffDecks(previous, next);
    if (forward.length === 0) return;

    // Transient commits stream work in progress (live typing) to collaborators
    // without consuming undo slots or history entries; the coalesce key lets
    // the collab undo layer fold the stream into one undoable edit.
    if (opts.history !== false && !this.txnBase && !opts.transient) {
      this.pushUndo(previous, next, opts.label ?? 'Edit slide', forward);
    }
    this.state = { ...this.state, deck: next, dirty: true };
    if (!this.txnBase) {
      if (!opts.transient && opts.history !== false) {
        this.recordHistory(opts.label ?? 'Edit slide');
      } else {
        this.currentHistoryId = null;
        this.emitHistory();
      }
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
      this.currentHistoryId = null;
      this.emitHistory();
    }
  }

  endTransaction(): void {
    if (!this.txnBase) return;
    const base = this.txnBase;
    this.txnBase = null;
    // A drag that ended where it started shouldn't consume an undo slot.
    if (base !== this.state.deck) {
      const forward = diffDecks(base, this.state.deck);
      if (forward.length > 0) {
        this.pushUndo(base, this.state.deck, this.txnLabel, forward);
        this.recordHistory(this.txnLabel);
        this.onLocalEdit?.(base, this.state.deck, this.txnLabel);
        // Transaction updates emit while the gesture is in progress. Emit once
        // more after clearing txnBase so views that deliberately defer costly
        // work during a drag can catch up to the committed deck.
        this.emit();
      }
    }
  }

  private pushUndo(
    previous: Deck,
    next: Deck,
    label: string,
    forward = diffDecks(previous, next),
  ): void {
    if (forward.length === 0) return;
    this.undoStack.push({
      label,
      forward,
      inverse: diffDecks(next, previous),
    });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(prev);
    this.state = {
      ...this.state,
      deck: applyAgentOperations(this.state.deck, prev.inverse),
      dirty: true,
    };
    this.clampCursor();
    this.recordHistory(`Undo: ${prev.label}`);
    this.emit();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(next);
    this.state = {
      ...this.state,
      deck: applyAgentOperations(this.state.deck, next.forward),
      dirty: true,
    };
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
    return this.historyLog.map(({ operations: _operations, ...item }) => ({ ...item })).reverse();
  }

  isHistoryCurrent(id: number): boolean {
    return id === this.currentHistoryId;
  }

  persistedHistory(): DeckHistoryDocument {
    return {
      version: 2,
      base: this.historyBase,
      entries: this.historyLog.map(({ id: _id, ...item }) => ({ ...item })),
    };
  }

  restoreHistory(id: number): boolean {
    const historyIndex = this.historyLog.findIndex((item) => item.id === id);
    const snapshot = this.historyLog[historyIndex];
    const snapshotDeck = this.materializeHistoryIndex(historyIndex);
    if (!snapshot || !snapshotDeck || sameDeck(snapshotDeck, this.state.deck)) return false;
    const previous = this.state.deck;
    const slideIndex = Math.min(
      snapshot.slideIndex,
      Math.max(0, snapshotDeck.slides.length - 1),
    );
    const label = `Reverted to ${snapshot.label}`;
    this.pushUndo(this.state.deck, snapshotDeck, label);
    this.redoStack = [];
    this.state = {
      ...this.state,
      deck: snapshotDeck,
      slideIndex,
      slideSelection: new Set(snapshotDeck.slides[slideIndex]
        ? [snapshotDeck.slides[slideIndex].id]
        : []),
      selection: new Set(),
      dirty: true,
    };
    this.currentHistoryId = null;
    this.slideSelectionAnchor = this.state.slideIndex;
    this.recordHistory(label);
    this.onLocalEdit?.(previous, this.state.deck, label);
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

  /** Select one contiguous rail range without first exposing either endpoint. */
  selectSlideRange(startIndex: number, endIndex: number): void {
    if (this.state.deck.slides.length === 0) return;
    const last = this.state.deck.slides.length - 1;
    const start = Math.min(Math.max(startIndex, 0), last);
    const end = Math.min(Math.max(endIndex, 0), last);
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    const slideSelection = new Set(
      this.state.deck.slides.slice(lo, hi + 1).map((slide) => slide.id),
    );
    this.slideSelectionAnchor = start;
    this.state = {
      ...this.state,
      slideIndex: end,
      slideSelection,
      selection: new Set(),
    };
    this.emit();
  }

  /**
   * Ctrl/Cmd+A in the slide rail. Selecting every slide is only meaningful
   * alongside an empty element selection -- the two selections are exclusive
   * everywhere else in the editor, and the rail's own commands read whichever
   * one is populated.
   */
  selectAllSlides(): void {
    const slides = this.state.deck.slides;
    if (slides.length === 0) return;
    this.slideSelectionAnchor = this.state.slideIndex;
    this.state = {
      ...this.state,
      slideSelection: new Set(slides.map((slide) => slide.id)),
      selection: new Set(),
    };
    this.emit();
  }

  /** Ctrl/Cmd+A on the canvas: every element of the slide being edited. */
  selectAllElements(): void {
    const slide = this.slide;
    if (!slide) return;
    this.select(slide.elements.map((el) => el.id));
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

  /**
   * Clone the selected objects and select the copies.
   *
   * The optional offset keeps Command-D's familiar nudge while allowing an
   * Option-drag to start its copies exactly on top of their sources.
   */
  duplicateSelection(offset = { x: 24, y: 24 }): string[] {
    const ids = this.state.selection;
    if (ids.size === 0) return [];
    const created: string[] = [];
    const index = this.state.slideIndex;
    this.commit((deck) => {
      const slide = deck.slides[index];
      for (const el of slide.elements.filter((candidate) => ids.has(candidate.id))) {
        const copy = structuredClone(el);
        copy.lineageId = el.lineageId ?? el.id;
        copy.magicMoveId = null;
        copy.id = makeId(el.type);
        copy.x += offset.x;
        copy.y += offset.y;
        if (copy.type === 'shape' && copy.control) {
          copy.control.x += offset.x;
          copy.control.y += offset.y;
        }
        created.push(copy.id);
        slide.elements.push(copy);
      }
    }, { label: ids.size === 1 ? 'Duplicate object' : 'Duplicate objects' });
    this.select(created);
    return created;
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
    const previous = this.state.deck;
    const previousSlide = previous.slides[index];
    if (!previousSlide) return;

    // Pointer moves can call this dozens of times per second. The generic
    // commit path must isolate an arbitrary deck mutator, but this method's
    // contract is narrower: only selected elements may change. Copy just that
    // branch so a drag on one object never clones every slide in a large deck.
    const elements = previousSlide.elements.map((element) => {
      if (!ids.has(element.id)) return element;
      const next = structuredClone(element);
      fn(next);
      return next;
    });
    const slides = previous.slides.slice();
    slides[index] = { ...previousSlide, elements };
    this.finishCommit(previous, { ...previous, slides }, opts);
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

  private recordHistory(label: string, opts: RemoteHistoryOptions = {}): void {
    const last = this.historyLog[this.historyLog.length - 1];
    if (opts.coalesce && last && last.label === label) {
      const previousTip = this.historyTipDeck;
      last.at = Date.now();
      last.slideIndex = this.state.slideIndex;
      if (this.historyLog.length === 1) {
        // Coalescing the base row replaces its materialized state; it can never
        // carry operations because there is no preceding revision.
        this.historyBase = this.state.deck;
        last.operations = [];
      } else if (previousTip) {
        last.operations.push(...diffDecks(previousTip, this.state.deck));
      }
      if (opts.description) last.description = opts.description;
      if (opts.agentChatId) last.agentChatId = opts.agentChatId;
      this.historyTipDeck = this.state.deck;
      this.currentHistoryId = last.id;
      this.emitHistory();
      this.onHistoryChange?.();
      return;
    }
    const operations = this.historyTipDeck
      ? diffDecks(this.historyTipDeck, this.state.deck)
      : [];
    if (this.historyLog.length === 0) this.historyBase = this.state.deck;
    this.historyLog.push({
      id: this.nextHistoryId++,
      label,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.agentChatId ? { agentChatId: opts.agentChatId } : {}),
      at: Date.now(),
      slideIndex: this.state.slideIndex,
      operations,
    });
    this.historyTipDeck = this.state.deck;
    if (this.historyLog.length > HISTORY_LIMIT) {
      const nextBase = this.historyLog[1];
      if (this.historyBase && nextBase) {
        this.historyBase = applyAgentOperations(this.historyBase, nextBase.operations);
        nextBase.operations = [];
      }
      this.historyLog.shift();
    }
    this.currentHistoryId = this.historyLog[this.historyLog.length - 1]?.id ?? null;
    this.emitHistory();
    this.onHistoryChange?.();
  }

  /** Materialize one persisted revision with a single clone/apply boundary. */
  private materializeHistoryIndex(index: number): Deck | null {
    if (!this.historyBase || index < 0 || index >= this.historyLog.length) return null;
    const operations = this.historyLog
      .slice(1, index + 1)
      .flatMap((entry) => entry.operations);
    return operations.length > 0
      ? applyAgentOperations(this.historyBase, operations)
      : this.historyBase;
  }
}

function sameDeck(left: Deck, right: Deck): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
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
    if (typeof window !== 'undefined') await window.api?.writeClipboard?.(request);
  } catch (err) {
    console.error('Could not write the system clipboard:', err);
  }
}

async function readSystemClipboard(): Promise<ClipboardReadResult | ClipboardWriteRequest | null> {
  if (typeof window !== 'undefined' && window.api?.readClipboard) {
    try {
      const payload = await window.api.readClipboard();
      if (payload) return payload;
    } catch (err) {
      console.error('Could not read the system clipboard:', err);
    }
  } else if (typeof navigator !== 'undefined' && navigator.clipboard?.read) {
    try {
      let html = '';
      let text = '';
      let image: Blob | null = null;
      for (const item of await navigator.clipboard.read()) {
        if (!html && item.types.includes('text/html')) {
          html = await (await item.getType('text/html')).text();
        }
        if (!text && item.types.includes('text/plain')) {
          text = await (await item.getType('text/plain')).text();
        }
        if (!image && item.types.includes('image/png')) {
          image = await item.getType('image/png');
        }
      }
      if (/<table\b/i.test(html) || text.includes('\t')) {
        return { kind: 'external-html', html, text };
      }
      if (image && window.api.importAssetFiles) {
        const [asset] = await window.api.importAssetFiles([
          new File([image], 'Screenshot.png', { type: 'image/png' }),
        ]);
        if (asset) return { kind: 'external-image', asset };
      }
    } catch (err) {
      console.error('Could not read the browser clipboard:', err);
    }
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
  providedPayload?: ClipboardReadResult | ClipboardWriteRequest | null,
): Promise<{ kind: 'elements' | 'slides'; count: number } | null> {
  const payload = providedPayload ?? await readSystemClipboard();
  if (!payload) return null;

  if (payload.kind === 'external-image') {
    return insertClipboardImage(store, payload.asset);
  }

  if (payload.kind === 'external-html') {
    const table = pastedTableData(payload.html, payload.text);
    if (!table) return null;
    const id = makeId('table');
    store.commit((deck) => {
      const slide = deck.slides[store.get().slideIndex];
      if (!slide) return;
      const w = Math.min(Math.max(360, table.columnWidths.length * 260), deck.canvas.w - 160);
      const naturalH = Math.max(72, table.rows * 72);
      const h = Math.min(naturalH, deck.canvas.h - 160);
      slide.elements.push({
        id,
        type: 'text',
        x: (deck.canvas.w - w) / 2,
        y: (deck.canvas.h - h) / 2,
        w,
        h,
        rot: 0,
        z: slide.elements.reduce((max, element) => Math.max(max, element.z), 0) + 1,
        opacity: 1,
        class: ['role-body'],
        style: {},
        html: table.html,
        align: 'left',
        valign: 'top',
        // Ordinary tables grow their rows instead of shrinking the type. Very
        // tall pasted ranges use the existing uniform font fit as a fallback.
        autoFit: naturalH > h,
        table: {
          columnWidths: table.columnWidths,
          autoHeight: true,
        },
      });
    }, { label: 'Paste table' });
    store.select([id]);
    return { kind: 'elements', count: 1 };
  }

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

/** Native browser paste events expose image bytes even on plain HTTP origins,
 * where `navigator.clipboard.read()` is unavailable. Upload those bytes using
 * the same collaboration asset bridge as drag-and-drop. */
export async function pasteImageFilesFromClipboard(
  store: EditorStore,
  files: File[],
): Promise<{ kind: 'elements'; count: number } | null> {
  const image = files.find((file) => file.type === 'image/png');
  if (!image || !window.api.importAssetFiles) return null;
  const [asset] = await window.api.importAssetFiles([
    new File([image], 'Screenshot.png', { type: 'image/png' }),
  ]);
  return asset ? insertClipboardImage(store, asset) : null;
}

function insertClipboardImage(
  store: EditorStore,
  asset: Extract<ClipboardReadResult, { kind: 'external-image' }>['asset'],
): { kind: 'elements'; count: number } {
  const id = makeId('image');
  store.commit((deck) => {
    const slide = deck.slides[store.get().slideIndex];
    if (!slide) return;
    const naturalW = asset.width ?? 1600;
    const naturalH = asset.height ?? 900;
    const scale = Math.min(
      1,
      (deck.canvas.w * 0.8) / naturalW,
      (deck.canvas.h * 0.8) / naturalH,
    );
    const w = Math.round(naturalW * scale);
    const h = Math.round(naturalH * scale);
    slide.elements.push({
      id,
      type: 'image',
      x: Math.round((deck.canvas.w - w) / 2),
      y: Math.round((deck.canvas.h - h) / 2),
      w,
      h,
      rot: 0,
      z: slide.elements.reduce((max, element) => Math.max(max, element.z), 0) + 1,
      opacity: 1,
      class: [],
      style: {},
      src: asset.src,
      fit: 'contain',
      alt: 'Pasted screenshot',
      sourceBox: null,
    });
  }, { label: 'Paste screenshot' });
  store.select([id]);
  return { kind: 'elements', count: 1 };
}

export function deckFrom(raw: unknown): Deck {
  return parseDeck(raw);
}
