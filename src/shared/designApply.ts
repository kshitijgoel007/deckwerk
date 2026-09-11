import type { Deck, LayoutMaster, Slide, SlideElement, TextEl } from './deck.js';
import { deckProseMax, roleForSize } from './fontSets.js';
import {
  defaultLayoutMasters,
  layoutMaster,
  type FixedLayout,
} from './layoutMasters.js';
import {
  ROLE_TYPE_SCALE_PROPERTIES,
  adoptThemeStyles,
  type ThemePreset,
  type ThemeTextRole,
} from './themes.js';

/**
 * The one design operation.
 *
 * Every surface that puts deck defaults onto existing slides — the Props tab's
 * layout picker, its "Follow deck theme" button, the Design tab's batch Apply
 * and every hover preview — runs through here, so they cannot disagree about
 * what a change does. Two axes, each an explicit argument:
 *
 * - **Layout** (`layout`): put the slide on that master. Geometry only. Boxes
 *   are matched to slots by role; untagged text can be cast first. Nothing is
 *   ever created on a slide that has text, and nothing is ever deleted.
 * - **Theme** (`typography`, `typeScale`, `colour`): make the in-scope boxes
 *   follow the deck theme for those properties, and hand a slide's ground back
 *   to the theme.
 *
 * Everything else on a slide — a background the author picked, a shape, a box
 * that matches no slot — is free styling and is left alone.
 */
export interface DesignApplyOptions {
  /** Font family and weight follow the theme. */
  typography: boolean;
  /** Size, line height and letter spacing follow the theme. */
  typeScale: boolean;
  /** Text colour, shape colours and the slide ground follow the theme. */
  colour: boolean;
  /** Put the slides on this master; `null` leaves geometry alone. */
  layout: FixedLayout | null;
  /** Cast untagged text into roles before matching slots or restyling. */
  detectRoles: boolean;
  /** Which roles the theme axis restyles. */
  roles: ThemeTextRole[];
}

export const DEFAULT_DESIGN_ROLES: ThemeTextRole[] = ['title', 'heading', 'body', 'caption'];

/** The Props tab's layout picker: geometry with role detection, nothing else. */
export function layoutOnlyOptions(layout: FixedLayout): DesignApplyOptions {
  return {
    typography: false, typeScale: false, colour: false, layout, detectRoles: true,
    roles: [...DEFAULT_DESIGN_ROLES],
  };
}

/** The Props tab's "Follow deck theme": the whole theme axis, no geometry. */
export function themeResetOptions(): DesignApplyOptions {
  return {
    typography: true, typeScale: true, colour: true, layout: null, detectRoles: false,
    roles: [...DEFAULT_DESIGN_ROLES],
  };
}

export interface DesignApplyReport {
  /** Text boxes now following the theme for the requested properties. */
  followed: string[];
  /** Of those, the boxes that carried their own values and lost them. */
  overridesCleared: string[];
  /** Slides whose own ground went back to the theme. */
  backgroundsReset: string[];
  /** Boxes that moved into a slot. */
  moved: string[];
  /** Untagged boxes that were given a role. */
  retagged: string[];
  /** Placeholder boxes created on empty slides. */
  created: string[];
  /** Boxes released from a slot because the slide went freeform. */
  released: string[];
  /** Slides whose layout changed. */
  assigned: string[];
  /** Slots that found no box, per slide: `{ slideId, slot }`. Nothing is created. */
  unplaced: Array<{ slideId: string; slot: 'title' | 'body' }>;
  /** Slides with untagged text that could not be placed because detection was off. */
  undetected: string[];
}

function emptyReport(): DesignApplyReport {
  return {
    followed: [], overridesCleared: [], backgroundsReset: [], moved: [], retagged: [],
    created: [], released: [], assigned: [], unplaced: [], undetected: [],
  };
}

const ROLE_CLASS = /^role-(title|heading|body|caption|base)$/;

function explicitRole(el: SlideElement): ThemeTextRole | null {
  const found = el.class.find((name) => ROLE_CLASS.test(name));
  return (found?.slice(5) as ThemeTextRole | undefined) ?? null;
}

function isText(el: SlideElement): el is TextEl {
  return el.type === 'text';
}

function proseLength(html: string): number {
  return html.replace(/<[^>]+>/g, '').trim().length;
}

/**
 * Cast untagged text on a slide into roles.
 *
 * The size ratio does the heavy lifting, as it does for Apply theme; a
 * position prior then keeps a slide to one title — the topmost of the large
 * boxes — and demotes the rest to headings, because two titles per slide is
 * how an imported agenda ends up with a body box in the title slot.
 */
export function castUntaggedRoles(slide: Slide, maxProse: number, report: DesignApplyReport): void {
  const texts = slide.elements.filter(isText).filter((el) => !el.layoutMasterId);
  const guesses = new Map<string, ThemeTextRole>();
  for (const el of texts) {
    if (explicitRole(el)) continue;
    if (proseLength(el.html) === 0) continue;
    const size = Number.parseFloat(el.style['font-size'] ?? el.contentStyle?.['font-size'] ?? '0') || 0;
    guesses.set(el.id, roleForSize(size || maxProse * 0.5, maxProse));
  }
  const titles = texts.filter((el) => guesses.get(el.id) === 'title').sort((a, b) => a.y - b.y);
  for (const extra of titles.slice(1)) guesses.set(extra.id, 'heading');
  for (const el of texts) {
    const role = guesses.get(el.id);
    if (!role) continue;
    el.class = [...el.class.filter((name) => !name.startsWith('role-')), `role-${role}`];
    report.retagged.push(el.id);
  }
}

function slotCandidates(slide: Slide, slot: 'title' | 'body'): TextEl[] {
  return slide.elements.filter(isText).filter((el) => !el.layoutMasterId && (
    el.layoutPlaceholder === slot || explicitRole(el) === slot
  ));
}

function geometryDistance(a: TextEl, b: Pick<TextEl, 'x' | 'y' | 'w' | 'h'>): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.w - b.w) + Math.abs(a.h - b.h);
}

function decorationCopy(slideId: string, source: SlideElement, order: number): SlideElement {
  const copy = structuredClone(source);
  copy.id = `${slideId}--master--${source.id}`;
  copy.layoutMasterId = source.id;
  copy.morphId = null;
  copy.lineageId = undefined;
  copy.z = -10_000 + order;
  copy.class = [...copy.class.filter((name) => name !== 'placeholder'), 'layout-master-element']
    .filter((name, index, names) => names.indexOf(name) === index);
  if (copy.type === 'text') copy.layoutPlaceholder = undefined;
  return copy;
}

/**
 * Put one slide on a layout.
 *
 * Only geometry and alignment travel from a slot to its box. Styling stays the
 * slide's — that is the theme axis — and so does the background: the master's
 * colour is not consulted, because a ground is either the theme's default or
 * the author's own choice, never the layout's.
 */
export function placeSlideOnLayout(
  slide: Slide,
  layout: FixedLayout,
  master: LayoutMaster,
  report: DesignApplyReport,
  options: { detectRoles: boolean },
): void {
  if ((slide.layout ?? 'freeform') !== layout) report.assigned.push(slide.id);
  slide.layout = layout;

  // Master decorations are part of the layout: swap the old layout's copies
  // for the new one's, and drop build steps aimed at copies that went away.
  const retired = new Set(slide.elements.filter((el) => el.layoutMasterId).map((el) => el.id));
  slide.elements = slide.elements.filter((el) => !el.layoutMasterId);
  const decorations = master.elements.filter((el) => el.type !== 'text' || !el.layoutPlaceholder);
  slide.elements.unshift(...decorations.map((el, index) => decorationCopy(slide.id, el, index)));
  for (const el of slide.elements) retired.delete(el.id);
  if (retired.size > 0) {
    slide.timeline = slide.timeline.filter((entry) => (
      !retired.has(entry.action.target) && !(entry.trigger.ref && retired.has(entry.trigger.ref))
    ));
  }

  const own = slide.elements.filter((el) => !el.layoutMasterId);
  const ownText = own.filter(isText);
  if (layout === 'freeform') {
    for (const el of ownText) {
      if (!el.layoutPlaceholder) continue;
      el.layoutPlaceholder = undefined;
      report.released.push(el.id);
    }
    return;
  }

  const slots = master.elements.filter((el): el is TextEl => isText(el) && Boolean(el.layoutPlaceholder));
  // Prompts are created only where there is no text to place: a slide of
  // pictures gets its title and body, a slide with prose never gets a second.
  const empty = ownText.length === 0;
  const hasUntagged = ownText.some((el) => !explicitRole(el) && proseLength(el.html) > 0);
  if (hasUntagged && !options.detectRoles) report.undetected.push(slide.id);
  const taken = new Set<string>();
  for (const source of slots) {
    const slot = source.layoutPlaceholder!;
    const candidates = slotCandidates(slide, slot).filter((el) => !taken.has(el.id));
    if (candidates.length === 0) {
      if (empty) {
        const created = structuredClone(source);
        created.id = `text-${slide.id}-${slot}`;
        created.html = slot === 'title' ? 'Slide title' : 'Body text';
        for (const property of ROLE_TYPE_SCALE_PROPERTIES) {
          delete created.style[property];
          if (created.contentStyle) delete created.contentStyle[property];
        }
        created.class = [...created.class.filter((name) => name !== 'layout-master-element'), 'placeholder']
          .filter((name, index, names) => names.indexOf(name) === index);
        slide.elements.push(created);
        report.created.push(created.id);
      } else {
        report.unplaced.push({ slideId: slide.id, slot });
      }
      continue;
    }
    // A box whose role names the slot outranks one that merely held the slot
    // before (an import can leave stale slot tags on every box); among equals
    // the one already in the slot keeps it, then the nearest.
    const rank = (el: TextEl): number => (explicitRole(el) === slot ? 0 : 2) + (el.layoutPlaceholder === slot ? 0 : 1);
    const target = [...candidates].sort((a, b) => (
      rank(a) - rank(b) || geometryDistance(a, source) - geometryDistance(b, source)
    ))[0];
    taken.add(target.id);
    const movedGeometry = geometryDistance(target, source) > 0 || target.rot !== source.rot
      || target.align !== source.align || target.valign !== source.valign;
    target.x = source.x;
    target.y = source.y;
    target.w = source.w;
    target.h = source.h;
    target.rot = source.rot;
    target.align = source.align;
    target.valign = source.valign;
    target.layoutPlaceholder = slot;
    if (movedGeometry) report.moved.push(target.id);
  }
  // A box that held a slot but lost it to a better candidate is released.
  for (const el of ownText) {
    if (el.layoutPlaceholder && !taken.has(el.id)) {
      el.layoutPlaceholder = undefined;
      report.released.push(el.id);
    }
  }
}

const THEME_AXIS_PROPERTIES: Record<'typography' | 'typeScale' | 'colour', string[]> = {
  typography: ['font-family', 'font-weight'],
  typeScale: ['font-size', 'line-height', 'letter-spacing'],
  colour: ['color'],
};

function carriesOwn(el: TextEl, properties: string[]): boolean {
  return properties.some((property) => (
    el.style[property] !== undefined || el.contentStyle?.[property] !== undefined
  ));
}

/**
 * Apply deck design to `slideIds`. Mutates `deck`; returns what it did.
 *
 * `theme` is the deck's current theme (see `deckTheme`). With no theme the
 * theme axis does nothing and only geometry can change.
 */
export function applyDesign(
  deck: Deck,
  theme: ThemePreset | null,
  options: DesignApplyOptions,
  slideIds: Set<string>,
): DesignApplyReport {
  const report = emptyReport();
  const slides = deck.slides.filter((slide) => slideIds.has(slide.id));
  if (slides.length === 0) return report;

  if (options.detectRoles) {
    const maxProse = deckProseMax(deck.slides.flatMap((slide) => slide.elements
      .filter(isText)
      .map((el) => ({
        html: el.html,
        size: Number.parseFloat(el.style['font-size'] ?? el.contentStyle?.['font-size'] ?? '0') || 0,
      }))));
    for (const slide of slides) castUntaggedRoles(slide, maxProse, report);
  }

  if (options.layout) {
    const masters = deck.layoutMasters ?? defaultLayoutMasters();
    const master = masters[options.layout] ?? layoutMaster(deck, options.layout);
    for (const slide of slides) {
      placeSlideOnLayout(slide, options.layout, master, report, { detectRoles: options.detectRoles });
    }
  }

  const themeAxis = options.typography || options.typeScale || options.colour;
  if (themeAxis && theme) {
    const properties = [
      ...(options.typography ? THEME_AXIS_PROPERTIES.typography : []),
      ...(options.typeScale ? THEME_AXIS_PROPERTIES.typeScale : []),
      ...(options.colour ? THEME_AXIS_PROPERTIES.colour : []),
    ];
    for (const slide of slides) {
      if (options.colour && (slide.background.color !== null || slide.background.image !== null)) {
        report.backgroundsReset.push(slide.id);
      }
      for (const el of slide.elements) {
        if (!isText(el) || el.layoutMasterId) continue;
        const role = explicitRole(el);
        if (!role || !options.roles.includes(role)) continue;
        report.followed.push(el.id);
        if (carriesOwn(el, properties)) report.overridesCleared.push(el.id);
      }
    }
    adoptThemeStyles(deck, theme, {
      scope: 'slides',
      roles: [...options.roles],
      fontFamily: options.typography,
      fontWeight: options.typography,
      typeScale: options.typeScale,
      textColor: options.colour,
      background: options.colour,
      objectColors: options.colour,
      replaceOverrides: true,
      detectRoles: false,
    }, 0, new Set(), slideIds);
  }
  return report;
}

/** Run `applyDesign` on a copy, for previews and readouts. */
export function dryRunDesign(
  deck: Deck,
  theme: ThemePreset | null,
  options: DesignApplyOptions,
  slideIds: Set<string>,
): { deck: Deck; report: DesignApplyReport } {
  const copy = structuredClone(deck);
  const report = applyDesign(copy, theme, options, slideIds);
  return { deck: copy, report };
}

export function reportChangesAnything(report: DesignApplyReport): boolean {
  return report.followed.length > 0 || report.backgroundsReset.length > 0
    || report.moved.length > 0 || report.retagged.length > 0 || report.created.length > 0
    || report.released.length > 0 || report.assigned.length > 0;
}

const LAYOUT_NAMES: Record<FixedLayout, string> = {
  freeform: 'Freeform', standard: 'Title + Body', title: 'Title',
};

export function layoutName(layout: FixedLayout | null | undefined): string {
  return LAYOUT_NAMES[layout ?? 'freeform'];
}

function plural(count: number, noun: string): string {
  if (count === 1) return `1 ${noun}`;
  return `${count} ${noun.endsWith('x') ? `${noun}es` : `${noun}s`}`;
}

/** One line saying what a report did or would do. */
export function summarizeDesignReport(report: DesignApplyReport): string {
  const parts: string[] = [];
  if (report.created.length) parts.push(`creates ${plural(report.created.length, 'prompt')}`);
  if (report.moved.length) parts.push(`moves ${plural(report.moved.length, 'box')}`);
  if (report.retagged.length) parts.push(`tags ${plural(report.retagged.length, 'role')}`);
  if (report.released.length) parts.push(`releases ${plural(report.released.length, 'box')}`);
  if (report.followed.length) parts.push(`${plural(report.followed.length, 'box')} follow the theme`);
  if (report.overridesCleared.length) {
    parts.push(`${plural(report.overridesCleared.length, 'local override')} removed`);
  }
  if (report.backgroundsReset.length) {
    parts.push(`${plural(report.backgroundsReset.length, 'background')} back to the theme`);
  }
  if (report.unplaced.length) {
    const slots = [...new Set(report.unplaced.map((entry) => entry.slot))];
    parts.push(`no ${slots.join(' or ')} box to place`);
  }
  if (report.undetected.length) parts.push('untagged text cannot be placed');
  return parts.length > 0 ? parts.join(', ') : 'nothing changes';
}
