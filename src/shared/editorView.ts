import type { Deck, Slide } from './deck.js';

/** The part of editor UI state that should survive a shell/window handoff. */
export interface EditorViewSnapshot {
  activeSlideId: string | null;
  selectedSlideIds: string[];
  selectedElementIds: string[];
}

interface EditorViewStore {
  get: () => {
    deck: Deck;
    slideIndex: number;
    slideSelection: Set<string>;
    selection: Set<string>;
  };
  readonly slide: Slide | undefined;
  selectSlide: (index: number, extendRange?: boolean) => void;
  select: (ids: string[], additive?: boolean) => void;
}

export function captureEditorView(store: EditorViewStore): EditorViewSnapshot {
  const { deck, slideIndex, slideSelection, selection } = store.get();
  return {
    activeSlideId: deck.slides[slideIndex]?.id ?? null,
    selectedSlideIds: [...slideSelection],
    selectedElementIds: [...selection],
  };
}

/** Restore only ids that still exist; collaboration may have changed the deck. */
export function restoreEditorView(store: EditorViewStore, snapshot: EditorViewSnapshot | null): void {
  if (!snapshot) return;
  const { deck } = store.get();
  const activeIndex = snapshot.activeSlideId === null
    ? -1
    : deck.slides.findIndex((slide) => slide.id === snapshot.activeSlideId);
  if (activeIndex !== -1) store.selectSlide(activeIndex);

  const slide = store.slide;
  const liveElementIds = new Set(slide?.elements.map((element) => element.id) ?? []);
  const selectedElements = snapshot.selectedElementIds.filter((id) => liveElementIds.has(id));
  if (selectedElements.length > 0) {
    store.select(selectedElements);
    return;
  }

  const selectedIndexes = snapshot.selectedSlideIds
    .map((id) => deck.slides.findIndex((slide) => slide.id === id))
    .filter((index) => index !== -1)
    .sort((a, b) => a - b);
  if (selectedIndexes.length > 1) {
    // Rail multi-selection is always a contiguous range.
    const first = selectedIndexes[0];
    const last = selectedIndexes[selectedIndexes.length - 1];
    // The active slide is normally the range endpoint the user shift-clicked.
    // Start at the opposite endpoint so restoring the range also restores it.
    const target = activeIndex === first || activeIndex === last ? activeIndex : last;
    store.selectSlide(target === first ? last : first);
    store.selectSlide(target, true);
  }
}

export function encodeEditorView(snapshot: EditorViewSnapshot): string {
  return JSON.stringify(snapshot);
}

export function decodeEditorView(value: string | null): EditorViewSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<EditorViewSnapshot>;
    return {
      activeSlideId: typeof parsed.activeSlideId === 'string' ? parsed.activeSlideId : null,
      selectedSlideIds: Array.isArray(parsed.selectedSlideIds)
        ? parsed.selectedSlideIds.filter((id): id is string => typeof id === 'string')
        : [],
      selectedElementIds: Array.isArray(parsed.selectedElementIds)
        ? parsed.selectedElementIds.filter((id): id is string => typeof id === 'string')
        : [],
    };
  } catch {
    return null;
  }
}
