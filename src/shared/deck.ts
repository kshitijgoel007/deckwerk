import { z } from 'zod';

/**
 * The deck format. This schema is the single source of truth: `deck.json` is
 * validated against it on load, and every other module derives its types from
 * here rather than declaring its own.
 *
 * Geometry is absolute pixels on a fixed canvas (default 1920x1080). The player
 * scales the whole stage with one CSS transform, so nothing downstream ever has
 * to reason about viewport size.
 */

const Id = z.string().min(1);

const ThemeFontRoleSchema = z.object({
  family: z.string(),
  size: z.number().positive(),
  weight: z.number(),
  lineHeight: z.number().positive(),
  letterSpacing: z.string(),
  color: z.string().optional(),
});

const ThemeStyleSchema = z.object({
  fonts: z.object({
    title: ThemeFontRoleSchema,
    heading: ThemeFontRoleSchema,
    body: ThemeFontRoleSchema,
    caption: ThemeFontRoleSchema,
    base: ThemeFontRoleSchema,
  }),
  palette: z.array(z.string()),
  colors: z.object({
    background: z.string(),
    text: z.string(),
    muted: z.string(),
    accent: z.string(),
  }),
});

/** Shared geometry for every element. */
const BaseElement = z.object({
  id: Id,
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  /** Clockwise degrees about the element's centre. */
  rot: z.number().default(0),
  /** Paint order within the slide; ties break on array order. */
  z: z.number().int().default(0),
  opacity: z.number().min(0).max(1).default(1),
  /** CSS classes hooking this element up to theme.css. */
  class: z.array(z.string()).default([]),
  /** Inline style escape hatch, applied after classes. */
  style: z.record(z.string()).default({}),
  /** Explicit identity shared by elements manually paired for Magic Move. */
  magicMoveId: z.string().nullable().optional(),
});

const TextElement = BaseElement.extend({
  type: z.literal('text'),
  /** Inline HTML. Fonts and sizes are expected to come from theme.css. */
  html: z.string().default(''),
  /** Shrink text as needed to keep it inside its box; never enlarge past its authored size. */
  autoFit: z.boolean().optional(),
  align: z.enum(['left', 'center', 'right', 'justify']).default('left'),
  valign: z.enum(['top', 'middle', 'bottom']).default('top'),
});

export const MediaEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('blur'), radius: z.number().min(0).max(200) }),
  z.object({ type: z.literal('posterize'), levels: z.number().int().min(2).max(32) }),
  z.object({ type: z.literal('grayscale'), amount: z.number().min(0).max(1) }),
]);

const ImageElement = BaseElement.extend({
  type: z.literal('image'),
  /** Deck-relative path, e.g. "assets/fig.png". */
  src: z.string(),
  fit: z.enum(['contain', 'cover', 'fill']).default('contain'),
  alt: z.string().default(''),
  /** Ordered, non-destructive visual effects. Order is significant. */
  effects: z.array(MediaEffectSchema).optional(),
  borderColor: z.string().nullable().optional(),
  borderWidth: z.number().min(0).optional(),
  borderRadius: z.number().min(0).optional(),
  /**
   * A crop, expressed as where the *whole* image sits relative to this
   * element's box. The element box is the visible window; anything outside it
   * is clipped.
   *
   * This is how Keynote's masks survive import: Keynote keeps the full image
   * (often far larger than the slide) and a separate mask rectangle, so a
   * cropped figure cannot be represented by the element box alone.
   */
  sourceBox: z
    .object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() })
    .nullable()
    .default(null),
});

const VideoElement = BaseElement.extend({
  type: z.literal('video'),
  src: z.string(),
  fit: z.enum(['contain', 'cover', 'fill']).default('contain'),
  autoplay: z.boolean().default(true),
  loop: z.boolean().default(true),
  muted: z.boolean().default(true),
  controls: z.boolean().default(false),
  /** Ordered, non-destructive visual effects. Order is significant. */
  effects: z.array(MediaEffectSchema).optional(),
  borderColor: z.string().nullable().optional(),
  borderWidth: z.number().min(0).optional(),
  borderRadius: z.number().min(0).optional(),
  /** Non-destructive in/out points in seconds; `end: null` means end of file. */
  start: z.number().min(0).default(0),
  end: z.number().min(0).nullable().default(null),
  poster: z.string().nullable().default(null),
  /**
   * Crop, expressed exactly as on an image: where the *whole* video sits
   * relative to this element's box, which acts as the visible window.
   *
   * Cropping is done in CSS rather than by re-encoding, so it is instant,
   * reversible and editable later. The cost is that an export still ships the
   * full source file, which is an accepted trade.
   */
  sourceBox: z
    .object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() })
    .nullable()
    .default(null),
});

const ShapeElement = BaseElement.extend({
  type: z.literal('shape'),
  shape: z.enum(['rect', 'ellipse', 'line', 'arrow', 'path']),
  fill: z.string().nullable().default(null),
  stroke: z.string().nullable().default(null),
  strokeWidth: z.number().min(0).default(2),
  radius: z.number().min(0).default(0),
  /**
   * SVG path data, for `shape: "path"`. This is how imported vector art and
   * Keynote connector lines keep their real geometry instead of degrading to a
   * bounding box.
   */
  path: z.string().nullable().default(null),
  /** Coordinate space `path` is drawn in; scaled to the element box on render. */
  pathSize: z
    .object({ w: z.number().positive(), h: z.number().positive() })
    .nullable()
    .default(null),
  arrowStart: z.boolean().default(false),
  arrowEnd: z.boolean().default(false),
  /** Absolute canvas-space control point for an editable quadratic curve. */
  control: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
});

/** Escape hatch: arbitrary markup that still drags and resizes like anything else. */
const HtmlElement = BaseElement.extend({
  type: z.literal('html'),
  html: z.string().default(''),
});

/**
 * Produced by the Keynote importer when it meets an object it cannot map.
 * Carries the original geometry so the slide stays laid out correctly, and
 * renders as a labelled dashed box so the gap is visible rather than silent.
 */
const UnsupportedElement = BaseElement.extend({
  type: z.literal('unsupported'),
  /** Originating archive type, e.g. "TSD.ChartArchive". */
  originalType: z.string().default('unknown'),
  note: z.string().default(''),
});

export const ElementSchema = z.discriminatedUnion('type', [
  TextElement,
  ImageElement,
  VideoElement,
  ShapeElement,
  HtmlElement,
  UnsupportedElement,
]);

/**
 * Timeline entries are `trigger + action` pairs evaluated in array order.
 *
 * v1 implements the `click`/`afterPrev` triggers and the `appear`/`play`
 * actions; the rest are accepted by the schema so that richer animations can
 * land later without a format migration.
 */
export const TriggerSchema = z.object({
  on: z.enum(['click', 'afterPrev', 'withPrev', 'mediaEnd']),
  /** Element whose event we wait on. Required for `mediaEnd`. */
  ref: Id.nullable().default(null),
  /** Milliseconds to wait after the trigger fires. */
  delay: z.number().min(0).default(0),
});

export const ActionSchema = z.object({
  type: z.enum([
    'appear',
    'disappear',
    'play',
    'pause',
    'seek',
    'addClass',
    'removeClass',
  ]),
  target: Id,
  /** Seconds for `seek`; class name for `addClass`/`removeClass`. */
  value: z.union([z.number(), z.string()]).nullable().default(null),
});

export const TimelineEntrySchema = z.object({
  id: Id,
  trigger: TriggerSchema,
  action: ActionSchema,
});

export const SlideSchema = z.object({
  id: Id,
  name: z.string().default(''),
  background: z
    .object({
      color: z.string().nullable().default(null),
      image: z.string().nullable().default(null),
    })
    .default({ color: null, image: null }),
  notes: z.string().default(''),
  /** Geometry preset; themes may decorate it but never own its positions. */
  layout: z.enum(['freeform', 'standard', 'title']).optional(),
  transition: z.object({
    type: z.enum(['none', 'magicMove']),
    duration: z.number().min(100).max(5000),
  }).optional(),
  elements: z.array(ElementSchema).default([]),
  timeline: z.array(TimelineEntrySchema).default([]),
});

export const DeckSchema = z.object({
  version: z.literal(1),
  title: z.string().default('Untitled'),
  canvas: z
    .object({ w: z.number().positive(), h: z.number().positive() })
    .default({ w: 1920, h: 1080 }),
  /** Deck-relative path to the stylesheet the user hand-edits. */
  theme: z.string().default('theme.css'),
  /** Installed theme preset id (see shared/themes.ts); null when none. */
  themePreset: z.string().nullable().default(null),
  /** Persistent deck defaults, composed property-by-property from theme presets. */
  themeStyle: ThemeStyleSchema.nullable().default(null),
  slides: z.array(SlideSchema).default([]),
});

export type Trigger = z.infer<typeof TriggerSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;
export type SlideElement = z.infer<typeof ElementSchema>;
export type ElementType = SlideElement['type'];
export type TextEl = z.infer<typeof TextElement>;
export type MediaEffect = z.infer<typeof MediaEffectSchema>;
export type ImageEl = z.infer<typeof ImageElement>;
export type VideoEl = z.infer<typeof VideoElement>;
export type ShapeEl = z.infer<typeof ShapeElement>;
export type HtmlEl = z.infer<typeof HtmlElement>;
export type UnsupportedEl = z.infer<typeof UnsupportedElement>;
export type Slide = z.infer<typeof SlideSchema>;
export type Deck = z.infer<typeof DeckSchema>;
export type ThemeStyle = z.infer<typeof ThemeStyleSchema>;

export const DECK_VERSION = 1 as const;

/**
 * Parse and normalise a deck, filling in every default. Throws with a readable,
 * path-annotated message rather than a raw ZodError dump.
 */
export function parseDeck(raw: unknown): Deck {
  const result = DeckSchema.safeParse(raw);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('\n');
  throw new Error(`deck.json is not valid:\n${details}`);
}

export function emptyDeck(title = 'Untitled'): Deck {
  return parseDeck({
    version: DECK_VERSION,
    title,
    canvas: { w: 1920, h: 1080 },
    theme: 'theme.css',
    slides: [{ id: 'slide-1', name: 'Slide 1' }],
  });
}
