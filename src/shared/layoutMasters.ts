import type { Deck, LayoutMaster, Slide, SlideElement, TextEl } from './deck.js';

export type FixedLayout = 'freeform' | 'standard' | 'title';

const roleClass = (slot: 'title' | 'body'): string => `role-${slot}`;

function placeholder(
  id: string,
  slot: 'title' | 'body',
  box: Pick<TextEl, 'x' | 'y' | 'w' | 'h' | 'align' | 'valign'>,
): TextEl {
  return {
    id,
    type: 'text',
    ...box,
    rot: 0,
    z: slot === 'title' ? 10 : 11,
    opacity: 1,
    class: [roleClass(slot), 'placeholder'],
    style: {},
    html: slot === 'title' ? 'Slide title' : 'Body text',
    autoFit: true,
    layoutPlaceholder: slot,
  };
}

/** Initial masters exactly match the legacy geometry, so installing them is visually neutral. */
export function defaultLayoutMasters(): NonNullable<Deck['layoutMasters']> {
  return {
    freeform: { background: { color: null, image: null }, elements: [] },
    standard: {
      background: { color: null, image: null },
      elements: [
        placeholder('master-standard-title', 'title', {
          x: 120, y: 58, w: 1680, h: 142, align: 'left', valign: 'middle',
        }),
        placeholder('master-standard-body', 'body', {
          x: 120, y: 252, w: 1680, h: 700, align: 'left', valign: 'top',
        }),
      ],
    },
    title: {
      background: { color: null, image: null },
      elements: [
        placeholder('master-title-title', 'title', {
          x: 180, y: 350, w: 1560, h: 300, align: 'center', valign: 'middle',
        }),
      ],
    },
  };
}

export function layoutMaster(
  deck: Deck,
  layout: FixedLayout,
): LayoutMaster {
  return deck.layoutMasters?.[layout] ?? defaultLayoutMasters()[layout];
}

function textForSlot(slide: Slide, slot: 'title' | 'body'): TextEl | undefined {
  return slide.elements.find((element): element is TextEl => element.type === 'text'
    && (element.layoutPlaceholder === slot || element.class.includes(roleClass(slot))));
}

function copyPlaceholderPresentation(target: TextEl, source: TextEl): void {
  target.x = source.x;
  target.y = source.y;
  target.w = source.w;
  target.h = source.h;
  target.rot = source.rot;
  target.opacity = source.opacity;
  target.style = structuredClone(source.style);
  target.contentStyle = source.contentStyle ? structuredClone(source.contentStyle) : undefined;
  target.align = source.align;
  target.valign = source.valign;
  target.autoFit = source.autoFit;
  target.noWrap = source.noWrap;
  target.noWrapMode = source.noWrapMode;
  target.paragraphSpacing = source.paragraphSpacing;
  // `placeholder` means "prompt copy the author has not replaced", and the
  // player, exports and rail thumbnails all hide such text (type.css). The
  // first real content commit retires it (see canvas.ts), so a master update
  // must never put it back: doing so blanked every authored title and body on
  // every slide the moment a layout was edited -- visibly, in the slide
  // picker, and on the projector.
  const stillPrompting = target.class.includes('placeholder');
  target.class = [
    ...source.class.filter((name) => name !== 'layout-master-element' && name !== 'placeholder'),
    roleClass(source.layoutPlaceholder ?? target.layoutPlaceholder ?? 'body'),
    ...(stillPrompting ? ['placeholder'] : []),
  ].filter((name, index, names) => names.indexOf(name) === index);
  target.layoutPlaceholder = source.layoutPlaceholder;
}

function decorationCopy(slideId: string, source: SlideElement, order: number): SlideElement {
  const copy = structuredClone(source);
  copy.id = `${slideId}--master--${source.id}`;
  copy.layoutMasterId = source.id;
  copy.magicMoveId = null;
  copy.lineageId = undefined;
  copy.z = -10_000 + order;
  copy.class = [...copy.class.filter((name) => name !== 'placeholder'), 'layout-master-element']
    .filter((name, index, names) => names.indexOf(name) === index);
  if (copy.type === 'text') copy.layoutPlaceholder = undefined;
  return copy;
}

/**
 * Synchronize one concrete slide from its master.
 *
 * Placeholder content stays slide-owned; geometry and presentation come from
 * the master. Repeated master objects are concrete, read-only copies so every
 * renderer and exporter sees the exact same ordinary slide structure.
 */
export function syncSlideWithLayoutMaster(
  slide: Slide,
  layout: FixedLayout,
  master: LayoutMaster,
  options: { forceBackground?: boolean } = {},
): void {
  slide.layout = layout;
  const retiredCopies = new Set(slide.elements
    .filter((element) => element.layoutMasterId)
    .map((element) => element.id));
  slide.elements = slide.elements.filter((element) => !element.layoutMasterId);

  for (const source of master.elements) {
    if (source.type !== 'text' || !source.layoutPlaceholder) continue;
    let target = textForSlot(slide, source.layoutPlaceholder);
    if (!target) {
      target = structuredClone(source);
      target.id = `text-${slide.id}-${source.layoutPlaceholder}`;
      target.html = source.layoutPlaceholder === 'title' ? 'Slide title' : 'Body text';
      slide.elements.push(target);
    }
    copyPlaceholderPresentation(target, source);
  }

  const decorations = master.elements.filter((element) => (
    element.type !== 'text' || !element.layoutPlaceholder
  ));
  slide.elements.unshift(...decorations.map((element, index) => decorationCopy(slide.id, element, index)));

  // A decoration the author removed from the master takes its per-slide copies
  // with it, so any build step aimed at one of them must go the same way --
  // every other deletion path prunes the timeline, and a step whose target no
  // longer exists is a click that does nothing during the talk.
  for (const element of slide.elements) retiredCopies.delete(element.id);
  if (retiredCopies.size > 0) {
    slide.timeline = slide.timeline.filter((entry) => (
      !retiredCopies.has(entry.action.target)
      && !(entry.trigger.ref && retiredCopies.has(entry.trigger.ref))
    ));
  }

  const inheritedAlready = slide.layoutBackgroundInherited === true;
  const hasNoExplicitBackground = slide.background.color === null && slide.background.image === null;
  if (options.forceBackground || inheritedAlready || (
    slide.layoutBackgroundInherited === undefined && hasNoExplicitBackground
  )) {
    slide.background = structuredClone(master.background);
    slide.layoutBackgroundInherited = true;
  } else if (slide.layoutBackgroundInherited === undefined) {
    slide.layoutBackgroundInherited = false;
  }
}

/** Synchronize every slide that uses one of the fixed layouts. */
export function syncDeckWithLayoutMasters(deck: Deck): void {
  if (!deck.layoutMasters) return;
  for (const slide of deck.slides) {
    const layout = (slide.layout ?? 'freeform') as FixedLayout;
    syncSlideWithLayoutMaster(slide, layout, deck.layoutMasters[layout]);
  }
}

