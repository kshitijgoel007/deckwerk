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
    add.textContent = '+ Reveal on click';
    add.disabled = this.store.get().selection.size === 0;
    add.title = add.disabled
      ? 'Select an element first'
      : 'Hide the selected elements until the next click';
    add.addEventListener('click', () => this.addRevealForSelection());
    header.appendChild(add);
    this.host.appendChild(header);

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

    const action = document.createElement('select');
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
    delay.className = 'delay-input';
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

    row.append(trigger, action, target, delay, remove);
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
    });
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
