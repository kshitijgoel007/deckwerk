import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { SpeakerNotesDrawer } from '../src/renderer/editor/speakerNotesDrawer.js';

/**
 * The speaker notes drawer is the in-app view onto one slide's `notes`
 * string. Typing has to reach the deck as one undo step per editing session,
 * a note changed elsewhere must not yank the caret while the author types,
 * and the canvas has to learn how much of its bottom the drawer covers.
 */

function makeStore(): EditorStore {
  const deck = emptyDeck('Notes');
  deck.slides = [1, 2].map((n) => parseDeck({
    ...deck,
    slides: [{ id: `slide-${n}`, notes: n === 2 ? 'second' : '' }],
  }).slides[0]);
  return new EditorStore(deck, '/decks/notes');
}

describe('speaker notes drawer', () => {
  let host: HTMLElement;
  let insets: number[];

  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><body><main id="canvas"></main></body>', {
      pretendToBeVisual: true,
      url: 'https://deckwerk.test',
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      KeyboardEvent: dom.window.KeyboardEvent,
      localStorage: dom.window.localStorage,
    });
    host = document.getElementById('canvas')!;
    insets = [];
  });

  it('opens from the floating button, shows the current note and closes again', () => {
    const store = makeStore();
    const drawer = new SpeakerNotesDrawer(host, store, { onInsetChange: (px) => insets.push(px) });
    expect(host.querySelector('.notes-toggle')).toBe(drawer.toggleButton);
    expect(drawer.element.hidden).toBe(true);

    store.selectSlide(1);
    drawer.toggleButton.click();
    expect(drawer.isOpen()).toBe(true);
    expect(drawer.element.hidden).toBe(false);
    expect(host.classList.contains('notes-open')).toBe(true);
    expect(drawer.textarea.value).toBe('second');
    expect(drawer.toggleButton.getAttribute('aria-expanded')).toBe('true');

    drawer.element.querySelector<HTMLButtonElement>('.notes-drawer-close')!.click();
    expect(drawer.isOpen()).toBe(false);
    expect(drawer.element.hidden).toBe(true);
    expect(host.classList.contains('notes-open')).toBe(false);
    // Reported once for opening and once (zero) for closing.
    expect(insets.at(-1)).toBe(0);
  });

  it('writes typing to the slide as one undo step per editing session', () => {
    const store = makeStore();
    const drawer = new SpeakerNotesDrawer(host, store);
    drawer.show();
    drawer.textarea.dispatchEvent(new window.FocusEvent('focus'));
    for (const value of ['R', 'Re', 'Rem', 'Remember to pause']) {
      drawer.textarea.value = value;
      drawer.textarea.dispatchEvent(new window.Event('input'));
    }
    expect(store.get().deck.slides[0].notes).toBe('Remember to pause');
    expect(store.canUndo()).toBe(false); // still inside the session

    drawer.textarea.dispatchEvent(new window.FocusEvent('blur'));
    expect(store.canUndo()).toBe(true);
    store.undo();
    expect(store.get().deck.slides[0].notes).toBe('');
    expect(store.canUndo()).toBe(false);
  });

  it('marks the toggle when the current slide has notes and follows slide selection', () => {
    const store = makeStore();
    const drawer = new SpeakerNotesDrawer(host, store);
    expect(drawer.toggleButton.classList.contains('has-notes')).toBe(false);
    store.selectSlide(1);
    expect(drawer.toggleButton.classList.contains('has-notes')).toBe(true);
    drawer.show();
    expect(drawer.element.querySelector('.notes-drawer-title')!.textContent).toBe('Notes · Slide 2');
    store.selectSlide(0);
    expect(drawer.textarea.value).toBe('');
  });

  it('holds back an outside change to the note being typed until blur', () => {
    const store = makeStore();
    const drawer = new SpeakerNotesDrawer(host, store);
    drawer.show();
    drawer.textarea.focus();
    expect(document.activeElement).toBe(drawer.textarea);
    drawer.textarea.value = 'mine';
    drawer.textarea.dispatchEvent(new window.Event('input'));

    // notes.md rewritten on disk while the caret is in the field.
    const external = structuredClone(store.get().deck);
    external.slides[0].notes = 'theirs';
    store.replaceExternal(external, '/decks/notes');
    expect(drawer.textarea.value).toBe('mine');

    drawer.textarea.blur();
    expect(drawer.textarea.value).toBe('theirs');
  });

  it('opens the file through the callback and reports its outcome', async () => {
    const store = makeStore();
    const openFile = vi.fn(async () => '/decks/notes/notes.md');
    const status: string[] = [];
    const drawer = new SpeakerNotesDrawer(host, store, { openFile, onStatus: (m) => status.push(m) });
    drawer.show();
    const button = [...drawer.element.querySelectorAll<HTMLButtonElement>('.notes-drawer-button')]
      .find((b) => b.textContent === 'Open notes.md')!;
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(status).toEqual(['Opened notes.md']);
  });
});
