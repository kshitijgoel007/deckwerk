// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignWorkspace } from '../src/renderer/editor/designWorkspace.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import { defaultLayoutMasters } from '../src/shared/layoutMasters.js';
import { PLAYER_TYPE_CSS } from '../src/shared/playerTypeCss.js';
import { THEMES } from '../src/shared/themes.js';

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** jsdom ships neither `CSS.escape` nor pointer capture, which the canvas uses. */
function installDomShims(): void {
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
  if (!globalThis.CSS) {
    (globalThis as unknown as { CSS: unknown }).CSS = {
      escape: (value: string) => value.replace(/["\\]/g, '\\$&'),
    };
  }
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    if (!(name in Element.prototype)) {
      Object.defineProperty(Element.prototype, name, { configurable: true, value: () => {} });
    }
  }
  (globalThis as unknown as { window: Window }).window.api = {
    assetUrl: (src: string) => src,
    pathForFile: () => '',
    importAssets: async () => [],
  } as never;
}

function build(deck: Deck = emptyDeck('Design')): {
  workspace: DesignWorkspace; store: EditorStore; save: ReturnType<typeof vi.fn>;
} {
  const canvasHost = document.createElement('main');
  document.body.appendChild(canvasHost);
  const store = new EditorStore(deck, '/tmp/design');
  const save = vi.fn();
  return {
    store,
    save,
    workspace: new DesignWorkspace({ canvasHost, store, save, setStatusMessage: vi.fn() }),
  };
}

/** Click a labelled button inside one of the layout editor's toolbars. */
function clickInOverlay(group: string, label: string): void {
  const button = [...document.querySelectorAll<HTMLButtonElement>(`${group} button`)]
    .find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`no ${label} button in ${group}`);
  button.click();
}

describe('design workspace dismissal', () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    installDomShims();
  });

  function setup(): DesignWorkspace {
    return build().workspace;
  }

  it('escapes the theme preview', () => {
    const workspace = setup();
    workspace.show(THEMES[0]);

    expect(workspace.escape()).toBe('theme');
    expect(document.querySelector<HTMLElement>('.design-preview-workspace')!.hidden).toBe(true);
    expect(workspace.escape()).toBeNull();
  });

  it('cancels the layout editor before leaving the theme preview', () => {
    const workspace = setup();
    workspace.show(THEMES[0]);
    workspace.openLayoutEditor('standard');

    expect(document.querySelector('.layout-editor-overlay')).not.toBeNull();
    expect(workspace.escape()).toBe('layout');
    expect(document.querySelector('.layout-editor-overlay')).toBeNull();
    expect(document.querySelector<HTMLElement>('.design-preview-workspace')!.hidden).toBe(false);
  });
});

/**
 * Every design surface draws masters through the player's renderer, which
 * hides prompt copy the author has not replaced (`type.css`). The layout
 * gallery is nothing but prompt copy, so without an explicit opt-out the whole
 * design mode presented empty slides.
 */
describe('the layout gallery', () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    const style = document.createElement('style');
    style.textContent = PLAYER_TYPE_CSS;
    document.head.appendChild(style);
    installDomShims();
  });

  const shownIn = (selector: string): string[] =>
    [...document.querySelectorAll<HTMLElement>(`${selector} .text-body`)]
      .filter((body) => getComputedStyle(body).visibility === 'visible')
      .map((body) => body.textContent ?? '');

  it('draws the sample copy in the preview grid rather than three empty frames', () => {
    build().workspace.show(THEMES[0]);
    expect(shownIn('.design-preview-grid')).toEqual([
      'The big idea', 'Readable body copy for the story.', 'Supporting detail',
      'The big idea', 'Readable body copy for the story.', 'Supporting detail',
      'The big idea',
    ]);
  });

  it('draws the sidebar summary', () => {
    const summary = build().workspace.createLayoutSummary(THEMES[0], vi.fn());
    document.body.appendChild(summary);
    expect(shownIn('.theme-layout-summary'))
      .toEqual(['The big idea', 'Readable body copy for the story.']);
  });

  it('dresses the sidebar summary in the chosen theme', () => {
    const theme = THEMES.find((candidate) => candidate.fonts.title.family !== THEMES[0].fonts.title.family)!;
    const summary = build().workspace.createLayoutSummary(theme, vi.fn());
    document.body.appendChild(summary);

    // The summary renders outside the preview stylesheet, so the theme reaches
    // it as inline CSS declarations or not at all.
    const title = document.querySelector<HTMLElement>('.theme-layout-summary .element-text')!;
    expect(title.style.getPropertyValue('font-family')).toBe(theme.fonts.title.family);
    expect(title.style.getPropertyValue('font-size')).toBe(`${theme.fonts.title.size}px`);
    const ground = document.querySelector<HTMLElement>('.theme-layout-summary .slide')!;
    expect(ground.style.background).not.toBe('');
  });

  it('draws the master being edited in the layout editor rail', () => {
    build().workspace.openLayoutEditor('standard');
    expect(shownIn('.layout-editor-rail-thumb')).toEqual(['Slide title', 'Body text', 'Slide title']);
  });
});

describe('leaving the layout editor', () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    installDomShims();
  });

  /** A deck holding one authored Title + Body slide, masters already installed. */
  function authoredDeck(): Deck {
    const deck = emptyDeck('Design');
    deck.layoutMasters = defaultLayoutMasters();
    applySlideLayout(deck.slides[0], 'standard', deck.layoutMasters);
    for (const element of deck.slides[0].elements) {
      if (element.type !== 'text') continue;
      element.html = `Authored ${element.layoutPlaceholder}`;
      element.class = element.class.filter((name) => name !== 'placeholder');
    }
    return deck;
  }

  const titleOf = (store: EditorStore) => {
    const element = store.get().deck.slides[0].elements
      .find((candidate) => candidate.type === 'text' && candidate.layoutPlaceholder === 'title');
    if (!element || element.type !== 'text') throw new Error('no title placeholder');
    return element;
  };

  it('pushes a new master object onto the deck on Done, keeping authored copy', () => {
    const { workspace, store, save } = build(authoredDeck());
    workspace.openLayoutEditor('standard');
    clickInOverlay('.layout-editor-tools', 'Text');
    clickInOverlay('.layout-editor-actions', 'Done');

    const master = store.get().deck.layoutMasters!.standard;
    expect(master.elements.filter((element) => !(
      element.type === 'text' && element.layoutPlaceholder
    ))).toHaveLength(1);

    // Every slide on that layout gains a locked copy of it, and its own
    // authored title is untouched by the round trip.
    const copies = store.get().deck.slides[0].elements.filter((element) => element.layoutMasterId);
    expect(copies).toHaveLength(1);
    expect(copies[0].class).toContain('layout-master-element');
    expect(titleOf(store).html).toBe('Authored title');
    expect(titleOf(store).class).not.toContain('placeholder');

    expect(save).toHaveBeenCalled();
    expect(document.querySelector('.layout-editor-overlay')).toBeNull();
    // One undoable step for the whole layout edit.
    store.undo();
    expect(store.get().deck.slides[0].elements.some((element) => element.layoutMasterId)).toBe(false);
  });

  /**
   * A master carries geometry, not a type scale: the deck's title size is set
   * once in the theme. A size that reaches a master anyway (an older deck) is
   * dropped on Done rather than stamped onto every slide. The locked size
   * field itself is covered in textFormattingControls.test.ts.
   */
  it('keeps sizes with the theme, not the layout', () => {
    const deck = authoredDeck();
    const title = deck.layoutMasters!.standard.elements[0];
    if (title.type !== 'text') throw new Error('the standard master starts with its title');
    title.style['font-size'] = '64px';
    const { workspace, store } = build(deck);
    workspace.openLayoutEditor('standard');
    clickInOverlay('.layout-editor-actions', 'Done');

    const saved = store.get().deck.layoutMasters!.standard.elements[0];
    expect(saved.type === 'text' && saved.style['font-size']).toBeUndefined();
    expect(titleOf(store).style['font-size']).toBeUndefined();
  });

  it('leaves the deck untouched on Cancel', () => {
    const { workspace, store, save } = build(authoredDeck());
    const before = JSON.stringify(store.get().deck);
    workspace.openLayoutEditor('standard');
    clickInOverlay('.layout-editor-tools', 'Text');
    clickInOverlay('.layout-editor-actions', 'Cancel');

    expect(JSON.stringify(store.get().deck)).toBe(before);
    expect(save).not.toHaveBeenCalled();
  });
});
