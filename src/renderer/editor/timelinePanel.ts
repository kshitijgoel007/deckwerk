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
    this.host.appendChild(header);

    const selection = this.store.get().selection;

    const elementsTitle = document.createElement('div');
    elementsTitle.className = 'step-label';
    elementsTitle.textContent = 'Slide elements';
    this.host.appendChild(elementsTitle);

    // The list mirrors the canvas selection: picking an object on the slide
    // lights up its row here, and picking a row selects it on the slide, so
    // "add animation" never requires hunting through the list.
    const list = document.createElement('div');
    list.className = 'build-element-list';
    for (const element of slide.elements) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'build-element-row';
      row.dataset.elementId = element.id;
      row.classList.toggle('selected', selection.has(element.id));
      row.textContent = describeElement(element);
      row.title = row.textContent;
      row.addEventListener('click', () => this.store.select([element.id]));
      list.appendChild(row);
    }
    this.host.appendChild(list);

    const add = document.createElement('button');
    add.className = 'primary panel-action';
    add.textContent = 'Add animation';
    add.disabled = selection.size === 0;
    add.title = add.disabled
      ? 'Select an element on the slide or in the list first'
      : 'Hide the selected elements until the next click';
    add.addEventListener('click', () => this.addAnimationForSelection());
    this.host.appendChild(add);

    if (slide.timeline.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'insp-hint';
      hint.textContent =
        'No build steps. Everything is visible when the slide appears, and videos with autoplay start immediately.';
      this.host.appendChild(hint);
      return;
    }

    // The same numbers appear as badges on the canvas, so a card can be
    // matched to the object it animates at a glance.
    const orderOf = new Map(slide.timeline.map((entry, i) => [entry.id, i + 1]));

    const steps = groupIntoSteps(slide);
    steps.forEach((entries, stepIndex) => {
      const block = document.createElement('div');
      block.className = 'step-block';

      if (stepIndex === 0) {
        const label = document.createElement('div');
        label.className = 'step-label';
        label.textContent = 'On slide enter';
        block.appendChild(label);
        if (entries.length === 0) {
          const none = document.createElement('div');
          none.className = 'step-empty';
          none.textContent = 'everything visible';
          block.appendChild(none);
        }
      }
      if (stepIndex > 0 && entries.length === 0) return;

      for (const entry of entries) {
        block.appendChild(this.entryRow(entry, slide.elements, orderOf.get(entry.id) ?? 0));
      }
      this.host.appendChild(block);
    });
  }

  private entryRow(entry: TimelineEntry, elements: SlideElement[], num: number): HTMLElement {
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

    // Each card is bound to one element — matching the numbered badge on the
    // canvas — rather than offering a dropdown to retarget it.
    const numChip = document.createElement('span');
    numChip.className = 'build-num';
    numChip.textContent = String(num);
    numChip.title = 'Matches the numbered badge on the slide';

    const targetEl = elements.find((el) => el.id === entry.action.target);
    const name = document.createElement('span');
    name.className = 'build-target-name';
    name.textContent = targetEl ? describeElement(targetEl) : '(missing element)';
    name.title = name.textContent;

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

    const head = document.createElement('div');
    head.className = 'build-card-head';
    head.append(grip, numChip, trigger, remove);
    const body = document.createElement('div');
    body.className = 'build-card-body';
    body.append(action, name, delay);
    row.append(head, body);
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
  private addAnimationForSelection(): void {
    const ids = [...this.store.get().selection];
    if (ids.length === 0) return;
    this.store.commit((deck) => {
      const slide = deck.slides[this.store.get().slideIndex];
      ids.forEach((target, i) => {
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
    }, { label: 'Add animation' });
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

const SHAPE_NAMES: Record<string, string> = {
  rect: 'rectangle',
  ellipse: 'ellipse',
  line: 'line',
  arrow: 'arrow',
  path: 'shape',
};

function describeElement(el: SlideElement): string {
  switch (el.type) {
    case 'text':
      return stripTags(el.html).slice(0, 32) || 'text (empty)';
    case 'image':
    case 'video':
      return `${el.type}: ${el.src.split('/').pop()}`;
    case 'shape':
      return SHAPE_NAMES[el.shape] ?? el.shape;
    default:
      return `${el.type} ${el.id.slice(-4)}`;
  }
}

function stripTags(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent ?? '';
}
