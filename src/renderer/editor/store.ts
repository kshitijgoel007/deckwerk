import type { Deck, Slide, SlideElement } from '@shared/deck.js';
import { parseDeck } from '@shared/deck.js';

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
  private state: EditorState;
  private listeners = new Set<Listener>();
  private undoStack: UndoItem[] = [];
  private redoStack: UndoItem[] = [];
  private historyLog: DeckHistoryItem[] = [];
  private nextHistoryId = 1;
  /** Coalesces a drag into one undo entry instead of one per mousemove. */
  private txnBase: Deck | null = null;
  private txnLabel = 'Move or resize objects';

  constructor(deck: Deck, dir: string | null = null) {
    this.state = {
      dir,
      deck,
      slideIndex: 0,
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
    this.state = {
      dir,
      deck,
      slideIndex,
      selection: new Set(),
      dirty: false,
    };
    this.recordHistory('Opened deck');
    this.emit();
  }

  /**
   * Apply a mutation to a structurally-cloned deck.
   *
   * The clone is what lets the undo stack hold plain references: no other code
   * can mutate a deck that history is holding.
   */
  commit(
    fn: (deck: Deck) => void,
    opts: { history?: boolean; label?: string } = {},
  ): void {
    const previous = this.state.deck;
    const next = structuredClone(previous) as Deck;
    fn(next);
    shareUnchangedSlides(previous, next);

    if (opts.history !== false && !this.txnBase) {
      this.pushUndo(previous, opts.label ?? 'Edit slide');
    }
    this.state = { ...this.state, deck: next, dirty: true };
    if (!this.txnBase) this.recordHistory(opts.label ?? 'Edit slide');
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
    this.pushUndo(this.state.deck, `Revert to ${snapshot.label}`);
    this.redoStack = [];
    this.state = {
      ...this.state,
      deck: structuredClone(snapshot.deck),
      slideIndex: Math.min(snapshot.slideIndex, Math.max(0, snapshot.deck.slides.length - 1)),
      selection: new Set(),
      dirty: true,
    };
    this.recordHistory(`Reverted to ${snapshot.label}`);
    this.emit();
    return true;
  }

  markClean(): void {
    this.state = { ...this.state, dirty: false };
    this.emit();
  }

  selectSlide(index: number): void {
    const clamped = Math.min(Math.max(index, 0), this.state.deck.slides.length - 1);
    if (clamped === this.state.slideIndex) return;
    this.state = { ...this.state, slideIndex: clamped, selection: new Set() };
    this.emit();
  }

  select(ids: string[], additive = false): void {
    const selection = additive ? new Set(this.state.selection) : new Set<string>();
    for (const id of ids) {
      if (additive && selection.has(id)) selection.delete(id);
      else selection.add(id);
    }
    this.state = { ...this.state, selection };
    this.emit();
  }

  clearSelection(): void {
    if (this.state.selection.size === 0) return;
    this.state = { ...this.state, selection: new Set() };
    this.emit();
  }

  selectedElements(): SlideElement[] {
    const slide = this.slide;
    if (!slide) return [];
    return slide.elements.filter((e) => this.state.selection.has(e.id));
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
    this.state = {
      ...this.state,
      slideIndex,
      selection: new Set([...this.state.selection].filter((id) => live.has(id))),
    };
  }

  private recordHistory(label: string): void {
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
function shareUnchangedSlides(previous: Deck, next: Deck): void {
  const byId = new Map(previous.slides.map((slide) => [slide.id, slide]));
  for (let i = 0; i < next.slides.length; i++) {
    const candidate = byId.get(next.slides[i].id);
    if (candidate && JSON.stringify(candidate) === JSON.stringify(next.slides[i])) {
      next.slides[i] = candidate;
    }
  }
}

/**
 * App-wide element clipboard. Module-level so it survives slide switches and
 * deck swaps; new ids are minted on paste so timelines never cross-wire.
 */
let elementClipboard: SlideElement[] = [];

export function copySelectionToClipboard(store: EditorStore): number {
  const els = store.selectedElements();
  if (els.length > 0) elementClipboard = structuredClone(els);
  return els.length;
}

export function cutSelectionToClipboard(store: EditorStore): number {
  const n = copySelectionToClipboard(store);
  if (n > 0) store.deleteSelection();
  return n;
}

export function pasteFromClipboard(store: EditorStore): string[] {
  if (elementClipboard.length === 0) return [];
  const created: string[] = [];
  store.commit((deck) => {
    const slide = deck.slides[store.get().slideIndex];
    if (!slide) return;
    const maxZ = slide.elements.reduce((m, e) => Math.max(m, e.z), 0);
    elementClipboard.forEach((el, i) => {
      const copy = structuredClone(el);
      copy.id = `${el.type}-${Math.random().toString(36).slice(2, 10)}`;
      copy.x += 24;
      copy.y += 24;
      if (copy.type === 'shape' && copy.control) {
        copy.control.x += 24;
        copy.control.y += 24;
      }
      copy.z = maxZ + 1 + i;
      created.push(copy.id);
      slide.elements.push(copy);
    });
  });
  store.select(created);
  return created;
}

export function deckFrom(raw: unknown): Deck {
  return parseDeck(raw);
}
