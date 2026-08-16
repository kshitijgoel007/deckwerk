import type { SlideElement, TimelineEntry } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import { groupIntoSteps } from '@shared/timeline.js';
import type { EditorStore } from './store.js';

/**
 * Authoring for builds.
 *
 * Entries are shown grouped by the step they belong to, because "what appears
 * on the third click" is the question you actually ask while writing a talk.
 * The underlying array stays flat and ordered — the grouping is presentation.
 */
export class TimelinePanel {
  private host: HTMLElement;
  private store: EditorStore;
  private draggingEntryId: string | null = null;

  constructor(host: HTMLElement, store: EditorStore) {
    this.host = host;
    this.store = store;
    store.subscribe(() => this.render());
    this.render();
  }

  render(): void {
    const slide = this.store.slide;
    this.host.replaceChildren();
    if (!slide) return;

    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('h3');
    title.textContent = 'Build';
    header.appendChild(title);

    const add = document.createElement('button');
    add.textContent = 'Reveal selected on click';
    add.disabled = this.store.get().selection.size === 0;
    add.title = add.disabled
      ? 'Select an element first'
      : 'Hide the selected elements until the next click';
    add.addEventListener('click', () => this.addRevealForSelection());
    header.appendChild(add);
    this.host.appendChild(header);

    const help = document.createElement('p');
    help.className = 'insp-hint build-help';
    help.textContent = this.store.get().selection.size === 0
      ? 'Select one or more slide objects, then reveal them on a click.'
      : 'The selected objects will start hidden and appear at the next click.';
    this.host.appendChild(help);

    const elementsTitle = document.createElement('div');
    elementsTitle.className = 'step-label';
    elementsTitle.textContent = 'Slide elements';
    this.host.appendChild(elementsTitle);
    const revealTargets = new Set(slide.timeline
      .filter((entry) => entry.action.type === 'appear')
      .map((entry) => entry.action.target));
    for (const element of slide.elements) {
      const row = document.createElement('label');
      row.className = 'build-element-row';
      row.dataset.elementId = element.id;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = revealTargets.has(element.id);
      checkbox.addEventListener('change', () => this.setAppear(element.id, checkbox.checked));
      const name = document.createElement('span');
      name.textContent = describeElement(element);
      row.append(checkbox, name);
      this.host.appendChild(row);
    }

    if (slide.timeline.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'insp-hint';
      hint.textContent =
        'No build steps. Everything is visible when the slide appears, and videos with autoplay start immediately.';
      this.host.appendChild(hint);
      return;
    }

    const steps = groupIntoSteps(slide);
    steps.forEach((entries, stepIndex) => {
      const block = document.createElement('div');
      block.className = 'step-block';

      const label = document.createElement('div');
      label.className = 'step-label';
      label.textContent = stepIndex === 0 ? 'On slide enter' : `Click ${stepIndex}`;
      block.appendChild(label);

      if (entries.length === 0) {
        const none = document.createElement('div');
        none.className = 'step-empty';
        none.textContent = 'everything visible';
        block.appendChild(none);
      }

      for (const entry of entries) {
        block.appendChild(this.entryRow(entry, slide.elements));
      }
      this.host.appendChild(block);
    });
  }

  private entryRow(entry: TimelineEntry, elements: SlideElement[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'timeline-row';
    row.dataset.entryId = entry.id;
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'build-drag-handle';
    grip.textContent = '⋮⋮';
    grip.title = 'Drag above or below to reorder; drop in the centre to reveal together';
    grip.draggable = true;
    grip.addEventListener('dragstart', (event) => {
      this.draggingEntryId = entry.id;
      row.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', entry.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    grip.addEventListener('dragend', () => {
      this.draggingEntryId = null;
      row.classList.remove('dragging');
    });
    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const bounds = row.getBoundingClientRect();
      const ratio = bounds.height > 0 ? (event.clientY - bounds.top) / bounds.height : 0.5;
      row.dataset.dropMode = ratio > 0.33 && ratio < 0.67
        ? 'fuse' : ratio <= 0.33 ? 'before' : 'after';
    });
    row.addEventListener('dragleave', () => delete row.dataset.dropMode);
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const visualMode = row.dataset.dropMode as BuildDropMode | undefined;
      delete row.dataset.dropMode;
      if (!this.draggingEntryId || this.draggingEntryId === entry.id) return;
      const mode = visualMode ?? 'after';
      this.store.commit((deck) => {
        const timeline = deck.slides[this.store.get().slideIndex].timeline;
        reorderBuildEntry(timeline, this.draggingEntryId!, entry.id, mode);
      }, { label: mode === 'fuse' ? 'Group build animations' : 'Reorder build animations' });
    });

    const action = document.createElement('select');
    action.className = 'build-action';
    for (const t of ['appear', 'disappear', 'play', 'pause'] as const) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      action.appendChild(opt);
    }
    action.value = entry.action.type;
    action.addEventListener('change', () =>
      this.mutate(entry.id, (e) => {
        e.action.type = action.value as 'appear';
      }),
    );

    const target = document.createElement('select');
    target.className = 'build-target';
    for (const el of elements) {
      const opt = document.createElement('option');
      opt.value = el.id;
      opt.textContent = describeElement(el);
      target.appendChild(opt);
    }
    target.value = entry.action.target;
    target.addEventListener('change', () =>
      this.mutate(entry.id, (e) => {
        e.action.target = target.value;
      }),
    );

    const trigger = document.createElement('select');
    trigger.className = 'build-trigger';
    for (const t of ['click', 'afterPrev', 'withPrev', 'mediaEnd'] as const) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t === 'click' ? 'on click' : t;
      trigger.appendChild(opt);
    }
    trigger.value = entry.trigger.on;
    trigger.addEventListener('change', () =>
      this.mutate(entry.id, (e) => {
        e.trigger.on = trigger.value as 'click';
      }),
    );

    const delay = document.createElement('input');
    delay.type = 'number';
    delay.className = 'delay-input build-delay';
    delay.step = '50';
    delay.min = '0';
    delay.value = String(entry.trigger.delay);
    delay.title = 'Delay in milliseconds';
    delay.addEventListener('change', () =>
      this.mutate(entry.id, (e) => {
        e.trigger.delay = Math.max(0, Number(delay.value) || 0);
      }),
    );

    const remove = document.createElement('button');
    remove.className = 'icon-button';
    remove.textContent = '×';
    remove.title = 'Remove this step';
    remove.addEventListener('click', () => {
      this.store.commit((deck) => {
        const slide = deck.slides[this.store.get().slideIndex];
        slide.timeline = slide.timeline.filter((e) => e.id !== entry.id);
      });
    });

    // Selecting the row selects what it targets, so you can see what you're editing.
    row.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).tagName === 'SELECT') return;
      this.store.select([entry.action.target]);
    });

    row.append(grip, action, target, trigger, delay, remove);
    return row;
  }

  private mutate(entryId: string, fn: (entry: TimelineEntry) => void): void {
    this.store.commit((deck) => {
      const slide = deck.slides[this.store.get().slideIndex];
      const entry = slide.timeline.find((e) => e.id === entryId);
      if (entry) fn(entry);
    });
  }

  /**
   * Add one `appear`-on-click entry per selected element. The first takes the
   * click; the rest chain with `afterPrev` at zero delay so a multi-selection
   * reveals as a single group rather than needing one click each.
   */
  private addRevealForSelection(): void {
    const ids = [...this.store.get().selection];
    if (ids.length === 0) return;
    this.store.commit((deck) => {
      const slide = deck.slides[this.store.get().slideIndex];
      const existing = new Set(slide.timeline
        .filter((entry) => entry.action.type === 'appear')
        .map((entry) => entry.action.target));
      ids.filter((target) => !existing.has(target)).forEach((target, i) => {
        slide.timeline.push({
          id: makeId('t'),
          trigger: {
            on: i === 0 ? 'click' : 'afterPrev',
            ref: null,
            delay: 0,
          },
          action: { type: 'appear', target, value: null },
        });
      });
    }, { label: 'Reveal selected objects on click' });
  }

  private setAppear(target: string, enabled: boolean): void {
    this.store.commit((deck) => {
      const slide = deck.slides[this.store.get().slideIndex];
      slide.timeline = slide.timeline.filter((entry) =>
        !(entry.action.target === target && entry.action.type === 'appear'));
      if (enabled) {
        slide.timeline.push({
          id: makeId('t'), trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'appear', target, value: null },
        });
      }
    });
  }
}

export type BuildDropMode = 'before' | 'after' | 'fuse';

/** Reorder one build entry; fuse means reveal alongside the target click. */
export function reorderBuildEntry(
  timeline: TimelineEntry[],
  draggedId: string,
  targetId: string,
  mode: BuildDropMode,
): void {
  const draggedIndex = timeline.findIndex((entry) => entry.id === draggedId);
  if (draggedIndex < 0 || draggedId === targetId) return;
  const [dragged] = timeline.splice(draggedIndex, 1);
  const targetIndex = timeline.findIndex((entry) => entry.id === targetId);
  if (targetIndex < 0) {
    timeline.push(dragged);
    return;
  }
  if (mode === 'fuse') {
    dragged.trigger.on = 'withPrev';
    dragged.trigger.delay = 0;
    timeline.splice(targetIndex + 1, 0, dragged);
  } else {
    dragged.trigger.on = 'click';
    timeline.splice(targetIndex + (mode === 'after' ? 1 : 0), 0, dragged);
  }
}

function describeElement(el: SlideElement): string {
  switch (el.type) {
    case 'text':
      return `text: ${stripTags(el.html).slice(0, 24) || '(empty)'}`;
    case 'image':
    case 'video':
      return `${el.type}: ${el.src.split('/').pop()}`;
    default:
      return `${el.type} ${el.id.slice(-4)}`;
  }
}

function stripTags(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent ?? '';
}
