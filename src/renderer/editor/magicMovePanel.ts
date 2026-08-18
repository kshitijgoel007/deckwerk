import type { Slide } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import { explicitMagicMovePairs, suggestMagicMovePairs } from '@shared/magicMove.js';
import { renderSlide } from '../player/render.js';
import { describeElement as describe, renderElementLabel } from './elementLabel.js';
import type { EditorStore } from './store.js';

const PREVIEW_WIDTH_FALLBACK = 560;

/** Explicit Magic Move authoring between the selected slide and the next one. */
export class MagicMovePanel {
  private selectedSourceId: string | null = null;
  private message = '';
  private previewObservers: ResizeObserver[] = [];
  private modal: HTMLElement | null = null;
  private modalContent: HTMLElement | null = null;
  private onModalKeyDown = (event: KeyboardEvent) => {
    if (!this.modal?.isConnected) return;
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeModal();
    }
  };

  constructor(
    private host: HTMLElement,
    private store: EditorStore,
    subscribe = true,
  ) {
    if (subscribe) {
      store.subscribe(() => {
        const current = store.slide;
        if (!current?.elements.some((element) => element.id === this.selectedSourceId)) {
          this.selectedSourceId = null;
        }
        if (!this.host.closest('[hidden]')) this.render();
      });
      if (!this.host.closest('[hidden]')) this.render();
    }
  }

  /** Close any pairing UI when Props switches to object-specific controls. */
  dismiss(): void {
    this.closeModal();
  }

  render(): void {
    const { deck, slideIndex } = this.store.get();
    const selectedSlides = this.store.selectedSlides();
    if (selectedSlides.length > 1) {
      this.renderBulk(selectedSlides);
      return;
    }
    const current = deck.slides[slideIndex];
    const next = deck.slides[slideIndex + 1];
    for (const observer of this.previewObservers) observer.disconnect();
    this.previewObservers = [];
    this.host.replaceChildren();

    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('h3');
    title.textContent = 'Magic Move';
    header.appendChild(title);
    this.host.appendChild(header);

    const duration = document.createElement('label');
    duration.className = 'field magic-duration';
    const durationLabel = document.createElement('span');
    durationLabel.textContent = 'Duration for deck';
    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.min = '100';
    durationInput.max = '5000';
    durationInput.step = '50';
    durationInput.value = String(deck.magicMoveDuration);
    durationInput.addEventListener('change', () => {
      const value = Math.max(100, Math.min(5000, Number(durationInput.value) || 1000));
      this.store.commit((nextDeck) => {
        nextDeck.magicMoveDuration = value;
      }, { label: 'Change Magic Move duration' });
    });
    const suffix = document.createElement('span');
    suffix.className = 'field-suffix';
    suffix.textContent = 'ms';
    duration.append(durationLabel, durationInput, suffix);
    this.host.appendChild(duration);

    const easing = document.createElement('label');
    easing.className = 'field magic-easing';
    const easingLabel = document.createElement('span');
    easingLabel.textContent = 'Motion curve';
    const easingSelect = document.createElement('select');
    for (const [value, text] of [
      ['ease-in-out', 'Smooth (ease in-out)'],
      ['ease-out', 'Snappy (ease out)'],
      ['linear', 'Linear'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      easingSelect.appendChild(option);
    }
    easingSelect.value = deck.magicMoveEasing;
    easingSelect.addEventListener('change', () => {
      const value = easingSelect.value as typeof deck.magicMoveEasing;
      this.store.commit((nextDeck) => {
        nextDeck.magicMoveEasing = value;
      }, { label: 'Change Magic Move easing' });
    });
    easing.append(easingLabel, easingSelect);
    this.host.appendChild(easing);

    if (!current || !next) {
      const hint = document.createElement('p');
      hint.className = 'insp-hint';
      hint.textContent = 'Select a slide that has another slide after it to create Magic Move pairs.';
      this.host.appendChild(hint);
      return;
    }

    const pairs = explicitMagicMovePairs(current.elements, next.elements);
    const magicEnabled = next.magicMoveFromPrevious ?? pairs.length > 0;
    const enabled = document.createElement('label');
    enabled.className = 'field field-check magic-enable';
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = magicEnabled;
    enabledInput.addEventListener('change', () => {
      this.store.commit((nextDeck) => {
        nextDeck.slides[slideIndex + 1].magicMoveFromPrevious = enabledInput.checked;
      }, { label: enabledInput.checked ? 'Enable Magic Move' : 'Disable Magic Move' });
    });
    const enabledLabel = document.createElement('span');
    enabledLabel.textContent = 'Enabled';
    enabled.append(enabledInput, enabledLabel);
    this.host.appendChild(enabled);

    const enableAndPair = document.createElement('button');
    enableAndPair.className = 'panel-action magic-enable-pair';
    enableAndPair.textContent = 'Enable and Auto-Pair';
    enableAndPair.title = 'Enable Magic Move to the next slide and pair strongly matching objects';
    enableAndPair.addEventListener('click', () => this.enableAndAutoPair());
    this.host.appendChild(enableAndPair);

    const pairCount = pairs.length;
    const pairNumbers = new Map<string, number>();
    pairs.forEach(([source, target], index) => {
      pairNumbers.set(source.id, index + 1);
      pairNumbers.set(target.id, index + 1);
    });
    const previews = document.createElement('div');
    previews.className = 'magic-previews magic-compact-previews';
    previews.append(
      this.preview(current, `Slide ${slideIndex + 1}`, 'source', pairNumbers, false),
      this.preview(next, `Slide ${slideIndex + 2}`, 'target', pairNumbers, false),
    );
    const summary = document.createElement('p');
    summary.className = 'insp-hint magic-summary';
    summary.textContent = magicEnabled
      ? `${pairCount} paired; every other object will fade out or in.`
      : `Disabled · ${pairCount} object${pairCount === 1 ? '' : 's'} paired.`;
    const edit = document.createElement('button');
    edit.className = 'primary panel-action magic-open';
    edit.textContent = 'Open Magic Move editor…';
    edit.addEventListener('click', () => this.openModal());
    this.host.append(previews, summary, edit);
    if (this.message) {
      const status = document.createElement('p');
      status.className = 'insp-hint magic-message';
      status.textContent = this.message;
      this.host.appendChild(status);
    }

    if (this.modal?.isConnected) this.renderModal();
  }

  /**
   * With a run of slides selected, per-pair pairing UI is useless — offer the
   * one action that makes sense across the whole run instead.
   */
  private renderBulk(slides: Slide[]): void {
    for (const observer of this.previewObservers) observer.disconnect();
    this.previewObservers = [];
    this.host.replaceChildren();

    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('h3');
    title.textContent = 'Magic Move';
    header.appendChild(title);

    const action = document.createElement('button');
    action.className = 'primary panel-action magic-bulk-pair';
    action.textContent = 'Enable Magic-Move & Auto-Pair';
    action.addEventListener('click', () => this.autoPairAcross(slides));

    const hint = document.createElement('p');
    hint.className = 'insp-hint';
    hint.textContent = `${slides.length} slides selected.`;

    this.host.append(header, hint, action);
    if (this.message) {
      const status = document.createElement('p');
      status.className = 'insp-hint magic-message';
      status.textContent = this.message;
      this.host.appendChild(status);
    }
  }

  /** Auto-pair and enable Magic Move for every consecutive pair in the run. */
  private autoPairAcross(slides: Slide[]): void {
    const ids = slides.map((slide) => slide.id);
    let paired = 0;
    let transitions = 0;
    this.store.commit((deck) => {
      const byId = new Map(deck.slides.map((slide) => [slide.id, slide] as const));
      for (let i = 0; i + 1 < ids.length; i += 1) {
        const left = byId.get(ids[i]);
        const right = byId.get(ids[i + 1]);
        if (!left || !right) continue;
        for (const [source, target] of suggestMagicMovePairs(left.elements, right.elements)) {
          if (pairMagicMoveObjects(left, right, source.id, target.id)) paired += 1;
        }
        right.magicMoveFromPrevious = true;
        transitions += 1;
      }
    }, { label: 'Auto-pair and enable Magic Move' });
    this.message = `Enabled Magic Move across ${transitions} transition${transitions === 1 ? '' : 's'}; paired ${paired} object${paired === 1 ? '' : 's'}.`;
    this.render();
  }

  private openModal(): void {
    if (this.modal?.isConnected) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'magic-modal-backdrop';
    const dialog = document.createElement('section');
    dialog.className = 'magic-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Magic Move object pairing');
    const header = document.createElement('header');
    const heading = document.createElement('h2');
    heading.textContent = 'Magic Move';
    const close = document.createElement('button');
    close.className = 'magic-modal-close';
    close.textContent = 'Done';
    close.addEventListener('click', () => this.closeModal());
    header.append(heading, close);
    const content = document.createElement('div');
    content.className = 'magic-modal-content';
    dialog.append(header, content);
    backdrop.appendChild(dialog);
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) this.closeModal();
    });
    this.modal = backdrop;
    this.modalContent = content;
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', this.onModalKeyDown, true);
    this.renderModal();
    close.focus();
  }

  private closeModal(): void {
    for (const observer of this.previewObservers) observer.disconnect();
    this.previewObservers = [];
    this.modal?.remove();
    this.modal = null;
    this.modalContent = null;
    this.selectedSourceId = null;
    document.removeEventListener('keydown', this.onModalKeyDown, true);
    if (this.host.isConnected) this.render();
  }

  private renderModal(): void {
    const content = this.modalContent;
    if (!content) return;
    const { deck, slideIndex } = this.store.get();
    const current = deck.slides[slideIndex];
    const next = deck.slides[slideIndex + 1];
    for (const observer of this.previewObservers) observer.disconnect();
    this.previewObservers = [];
    content.replaceChildren();
    if (!current || !next) {
      const unavailable = document.createElement('p');
      unavailable.className = 'insp-hint';
      unavailable.textContent = 'This slide has no following slide to pair with.';
      content.appendChild(unavailable);
      return;
    }

    const pairs = explicitMagicMovePairs(current.elements, next.elements);
    const pairNumbers = new Map<string, number>();
    pairs.forEach(([source, target], index) => {
      pairNumbers.set(source.id, index + 1);
      pairNumbers.set(target.id, index + 1);
    });
    const instruction = document.createElement('p');
    instruction.className = 'insp-hint magic-instruction';
    instruction.textContent = this.selectedSourceId
      ? 'Now choose its partner on the target slide.'
      : 'Choose an object on the source slide, then its partner on the target slide.';
    const previews = document.createElement('div');
    previews.className = 'magic-previews';
    previews.append(
      this.preview(current, `Source · Slide ${slideIndex + 1}`, 'source', pairNumbers),
      this.preview(next, `Target · Slide ${slideIndex + 2}`, 'target', pairNumbers),
    );
    const actions = document.createElement('div');
    actions.className = 'button-row magic-actions';
    const auto = document.createElement('button');
    auto.textContent = 'Auto-pair';
    auto.title = 'Pair strongly matching text, media, and shapes; leave uncertain objects alone';
    auto.addEventListener('click', () => this.autoPair());
    const clear = document.createElement('button');
    clear.textContent = 'Clear pairs';
    clear.disabled = pairs.length === 0;
    clear.addEventListener('click', () => this.clearPairs());
    actions.append(auto, clear);
    content.append(instruction, previews, actions);
    if (this.message) {
      const status = document.createElement('p');
      status.className = 'insp-hint magic-message';
      status.textContent = this.message;
      content.appendChild(status);
    }
    const unpairTargets = new Map<string, string>();
    for (const [source, target] of pairs) {
      unpairTargets.set(source.id, target.id);
      unpairTargets.set(target.id, target.id);
    }
    const lists = document.createElement('div');
    lists.className = 'magic-lists';
    lists.append(
      this.elementList(current, 'source', pairNumbers, unpairTargets),
      this.elementList(next, 'target', pairNumbers, unpairTargets),
    );
    content.appendChild(lists);
  }

  /** Scrollable list of every object on one slide; paired objects float to the top. */
  private elementList(
    slide: Slide,
    side: 'source' | 'target',
    pairNumbers: Map<string, number>,
    unpairTargets: Map<string, string>,
  ): HTMLElement {
    const list = document.createElement('div');
    list.className = 'magic-list';
    list.dataset.side = side;
    const ordered = [...slide.elements].sort((a, b) => {
      const pairA = pairNumbers.get(a.id) ?? Infinity;
      const pairB = pairNumbers.get(b.id) ?? Infinity;
      if (pairA !== pairB) return pairA - pairB;
      return slide.elements.indexOf(a) - slide.elements.indexOf(b);
    });
    for (const element of ordered) {
      const row = document.createElement('div');
      row.className = 'magic-list-item';
      const pair = pairNumbers.get(element.id);
      if (pair) row.classList.add('paired');
      if (side === 'source' && element.id === this.selectedSourceId) {
        row.classList.add('selected-source');
      }
      const pick = document.createElement('button');
      pick.className = 'magic-list-pick';
      pick.dataset.elementId = element.id;
      pick.dataset.side = side;
      const badge = document.createElement('b');
      badge.className = 'magic-list-badge';
      badge.textContent = pair ? String(pair) : '';
      const label = document.createElement('span');
      label.className = 'magic-list-label';
      renderElementLabel(label, element);
      pick.append(badge, label);
      pick.addEventListener('click', () => this.handleObjectClick(side, element.id));
      row.appendChild(pick);
      if (pair) {
        const remove = document.createElement('button');
        remove.className = 'icon-button';
        remove.textContent = '×';
        remove.title = 'Unpair these objects';
        remove.addEventListener('click', () => this.unpair(unpairTargets.get(element.id)!));
        row.appendChild(remove);
      }
      list.appendChild(row);
    }
    return list;
  }

  private handleObjectClick(side: 'source' | 'target', elementId: string): void {
    if (side === 'source') {
      this.selectedSourceId = this.selectedSourceId === elementId ? null : elementId;
      this.message = '';
      this.render();
    } else if (this.selectedSourceId) {
      this.pair(this.selectedSourceId, elementId);
    } else {
      this.message = 'Choose an object on the first slide before choosing its partner.';
      this.render();
    }
  }

  private preview(
    slide: Slide,
    labelText: string,
    side: 'source' | 'target',
    pairNumbers: Map<string, number>,
    interactive = true,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'magic-preview-wrap';
    const label = document.createElement('div');
    label.className = 'magic-preview-label';
    label.textContent = labelText;
    const frame = document.createElement('div');
    frame.className = 'magic-preview';
    if (!interactive) {
      frame.classList.add('magic-compact-preview');
      frame.tabIndex = 0;
      frame.setAttribute('role', 'button');
      frame.setAttribute('aria-label', `Open Magic Move editor from ${labelText}`);
      frame.addEventListener('click', () => this.openModal());
      frame.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.openModal();
        }
      });
    }
    const canvas = this.store.get().deck.canvas;
    frame.style.aspectRatio = `${canvas.w} / ${canvas.h}`;
    const surface = document.createElement('div');
    surface.className = 'magic-preview-surface';
    surface.style.width = `${canvas.w}px`;
    surface.style.height = `${canvas.h}px`;
    const updateScale = () => {
      const width = frame.clientWidth || PREVIEW_WIDTH_FALLBACK;
      surface.style.transform = `scale(${width / canvas.w})`;
    };
    updateScale();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateScale);
      observer.observe(frame);
      this.previewObservers.push(observer);
    }
    surface.appendChild(renderSlide(slide, { resolveSrc: (src) => window.api.assetUrl(src) }));
    for (const video of surface.querySelectorAll('video')) video.pause();
    frame.appendChild(surface);

    for (const element of slide.elements) {
      const hit = document.createElement(interactive ? 'button' : 'div');
      hit.className = 'magic-object-hit';
      if (!interactive) hit.classList.add('magic-object-hit-readonly');
      hit.dataset.elementId = element.id;
      hit.dataset.side = side;
      hit.title = describe(element);
      hit.setAttribute('aria-label', `${side === 'source' ? 'First' : 'Next'} slide: ${describe(element)}`);
      hit.style.left = `${element.x / canvas.w * 100}%`;
      hit.style.top = `${element.y / canvas.h * 100}%`;
      hit.style.width = `${element.w / canvas.w * 100}%`;
      hit.style.height = `${element.h / canvas.h * 100}%`;
      const pair = pairNumbers.get(element.id);
      if (pair) {
        hit.classList.add('paired');
        hit.dataset.pairLabel = String(pair);
      }
      if (side === 'source' && element.id === this.selectedSourceId) {
        hit.classList.add('selected-source');
      }
      if (interactive) hit.addEventListener('click', () => this.handleObjectClick(side, element.id));
      frame.appendChild(hit);
    }
    wrap.append(label, frame);
    return wrap;
  }

  private pair(sourceId: string, targetId: string): void {
    const slideIndex = this.store.get().slideIndex;
    this.selectedSourceId = null;
    this.message = 'Objects paired.';
    this.store.commit((deck) => {
      pairMagicMoveObjects(deck.slides[slideIndex], deck.slides[slideIndex + 1], sourceId, targetId);
    }, { label: 'Pair Magic Move objects' });
  }

  private unpair(targetId: string): void {
    const slideIndex = this.store.get().slideIndex;
    this.message = '';
    this.store.commit((deck) => {
      const target = deck.slides[slideIndex + 1]?.elements.find((element) => element.id === targetId);
      if (target) target.magicMoveId = null;
    }, { label: 'Unpair Magic Move objects' });
  }

  private clearPairs(): void {
    const slideIndex = this.store.get().slideIndex;
    this.message = '';
    this.store.commit((deck) => {
      const current = deck.slides[slideIndex];
      const next = deck.slides[slideIndex + 1];
      if (!current || !next) return;
      for (const [, target] of explicitMagicMovePairs(current.elements, next.elements)) {
        target.magicMoveId = null;
      }
    }, { label: 'Clear Magic Move pairs' });
  }

  /** One-click: turn on Magic Move to the next slide and auto-pair matches. */
  private enableAndAutoPair(): void {
    const { deck, slideIndex } = this.store.get();
    const current = deck.slides[slideIndex];
    const next = deck.slides[slideIndex + 1];
    if (!current || !next) return;
    const suggestions = suggestMagicMovePairs(current.elements, next.elements);
    this.message = suggestions.length > 0
      ? `Enabled Magic Move; auto-paired ${suggestions.length} object${suggestions.length === 1 ? '' : 's'}.`
      : 'Enabled Magic Move; no confident new matches to pair.';
    this.store.commit((nextDeck) => {
      const left = nextDeck.slides[slideIndex];
      const right = nextDeck.slides[slideIndex + 1];
      for (const [source, target] of suggestions) {
        pairMagicMoveObjects(left, right, source.id, target.id);
      }
      right.magicMoveFromPrevious = true;
    }, { label: 'Enable and auto-pair Magic Move' });
  }

  private autoPair(): void {
    const { deck, slideIndex } = this.store.get();
    const current = deck.slides[slideIndex];
    const next = deck.slides[slideIndex + 1];
    if (!current || !next) return;
    const suggestions = suggestMagicMovePairs(current.elements, next.elements);
    if (suggestions.length === 0) {
      this.message = 'No confident new matches found.';
      this.render();
      return;
    }
    this.message = `Auto-paired ${suggestions.length} object${suggestions.length === 1 ? '' : 's'}.`;
    this.store.commit((nextDeck) => {
      const left = nextDeck.slides[slideIndex];
      const right = nextDeck.slides[slideIndex + 1];
      for (const [source, target] of suggestions) {
        pairMagicMoveObjects(left, right, source.id, target.id);
      }
    }, { label: 'Auto-pair Magic Move objects' });
  }
}

export function pairMagicMoveObjects(
  current: Slide,
  next: Slide,
  sourceId: string,
  targetId: string,
): boolean {
  const source = current.elements.find((element) => element.id === sourceId);
  const target = next.elements.find((element) => element.id === targetId);
  if (!source || !target) return false;
  const matchId = source.magicMoveId ?? makeId('magic');
  for (const element of current.elements) {
    if (element !== source && element.magicMoveId === matchId) element.magicMoveId = null;
  }
  for (const element of next.elements) {
    if (element !== target && element.magicMoveId === matchId) element.magicMoveId = null;
  }
  source.magicMoveId = matchId;
  target.magicMoveId = matchId;
  next.magicMoveFromPrevious = true;
  return true;
}

