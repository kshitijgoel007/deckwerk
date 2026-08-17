import { z } from 'zod';
import {
  DeckSchema,
  ElementSchema,
  SlideSchema,
  parseDeck,
  type Deck,
  type Slide,
  type SlideElement,
} from './deck.js';

export const AGENT_PROTOCOL_VERSION = 1 as const;

const RectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

export const ComputedElementSceneSchema = z.object({
  id: z.string(),
  type: z.string(),
  selected: z.boolean(),
  authored: RectSchema.extend({ rot: z.number(), z: z.number(), opacity: z.number() }),
  rendered: RectSchema.nullable(),
  computedStyle: z.record(z.string()),
  text: z.object({
    html: z.string(),
    plain: z.string(),
    fittedFontSize: z.number().nullable(),
    overflowX: z.boolean(),
    overflowY: z.boolean(),
  }).nullable(),
  media: z.object({
    src: z.string(),
    fit: z.string(),
    sourceBox: z.unknown().nullable(),
    effects: z.array(z.unknown()),
    borderColor: z.string().nullable(),
    borderWidth: z.number(),
    borderRadius: z.number(),
    duration: z.number().nullable(),
  }).nullable(),
  shape: z.object({
    kind: z.string(),
    stroke: z.string().nullable(),
    fill: z.string().nullable(),
    strokeWidth: z.number(),
    arrowStart: z.boolean(),
    arrowEnd: z.boolean(),
    control: z.object({ x: z.number(), y: z.number() }).nullable(),
    path: z.string().nullable(),
  }).nullable(),
  magicMoveId: z.string().nullable(),
  lineageId: z.string().nullable(),
});

export const ComputedSlideSceneSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  name: z.string(),
  active: z.boolean(),
  selected: z.boolean(),
  canvas: z.object({ w: z.number().positive(), h: z.number().positive() }),
  background: z.unknown(),
  layout: z.string(),
  magicMoveFromPrevious: z.boolean(),
  skipped: z.boolean(),
  timeline: z.array(z.unknown()),
  elements: z.array(ComputedElementSceneSchema),
});

export const AgentContextSchema = z.object({
  version: z.literal(AGENT_PROTOCOL_VERSION),
  live: z.boolean(),
  sessionId: z.string(),
  pid: z.number().int().positive(),
  updatedAt: z.string(),
  deckPath: z.string(),
  deckRevision: z.string(),
  activeSlideId: z.string().nullable(),
  activeSlideIndex: z.number().int().nonnegative(),
  selectedSlideIds: z.array(z.string()),
  selectedElementIds: z.array(z.string()),
  scenes: z.array(ComputedSlideSceneSchema),
});

export type AgentContext = z.infer<typeof AgentContextSchema>;
export type ComputedSlideScene = z.infer<typeof ComputedSlideSceneSchema>;
export type ComputedElementScene = z.infer<typeof ComputedElementSceneSchema>;
export type AgentContextDraft = Omit<AgentContext, 'live' | 'sessionId' | 'pid' | 'updatedAt' | 'deckPath'>;

const InsertSlidesOperation = z.object({
  op: z.literal('insertSlides'),
  afterSlideId: z.string().nullable(),
  slides: z.array(SlideSchema).min(1),
});
const ReplaceSlideOperation = z.object({
  op: z.literal('replaceSlide'),
  slideId: z.string(),
  slide: SlideSchema,
});
const DeleteSlideOperation = z.object({ op: z.literal('deleteSlide'), slideId: z.string() });
const MoveSlideOperation = z.object({
  op: z.literal('moveSlide'),
  slideId: z.string(),
  afterSlideId: z.string().nullable(),
});
const InsertElementsOperation = z.object({
  op: z.literal('insertElements'),
  slideId: z.string(),
  elements: z.array(ElementSchema).min(1),
});
const ReplaceElementOperation = z.object({
  op: z.literal('replaceElement'),
  slideId: z.string(),
  elementId: z.string(),
  element: ElementSchema,
});
const DeleteElementsOperation = z.object({
  op: z.literal('deleteElements'),
  slideId: z.string(),
  elementIds: z.array(z.string()).min(1),
});
const UpdateDeckOperation = z.object({
  op: z.literal('updateDeck'),
  title: z.string().optional(),
  magicMoveDuration: z.number().min(100).max(5000).optional(),
});

export const AgentOperationSchema = z.discriminatedUnion('op', [
  InsertSlidesOperation,
  ReplaceSlideOperation,
  DeleteSlideOperation,
  MoveSlideOperation,
  InsertElementsOperation,
  ReplaceElementOperation,
  DeleteElementsOperation,
  UpdateDeckOperation,
]);

export const AgentTransactionSchema = z.object({
  version: z.literal(AGENT_PROTOCOL_VERSION),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().min(1).max(200),
  operations: z.array(AgentOperationSchema).min(1),
});

export type AgentOperation = z.infer<typeof AgentOperationSchema>;
export type AgentTransaction = z.infer<typeof AgentTransactionSchema>;

export const AgentRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(AGENT_PROTOCOL_VERSION),
    id: z.string(),
    kind: z.literal('transaction'),
    transaction: AgentTransactionSchema,
  }),
  z.object({
    version: z.literal(AGENT_PROTOCOL_VERSION),
    id: z.string(),
    kind: z.literal('dom'),
    expectedRevision: z.string(),
  }),
]);

export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export const AgentResponseSchema = z.object({
  version: z.literal(AGENT_PROTOCOL_VERSION),
  id: z.string(),
  status: z.enum(['applied', 'ok', 'conflict', 'error']),
  revision: z.string(),
  message: z.string().optional(),
  payload: z.unknown().optional(),
});

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

/** Stable input for SHA-256 in Node or the browser. */
export function canonicalDeckJson(deck: Deck): string {
  return JSON.stringify(parseDeck(deck));
}

export function applyAgentTransaction(deck: Deck, transaction: AgentTransaction): Deck {
  const tx = AgentTransactionSchema.parse(transaction);
  const next = structuredClone(parseDeck(deck));

  for (const operation of tx.operations) applyOperation(next, operation);
  const parsed = DeckSchema.parse(next);
  const errors = validateDeckIntegrity(parsed);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return parsed;
}

function applyOperation(deck: Deck, operation: AgentOperation): void {
  switch (operation.op) {
    case 'insertSlides': {
      const at = operation.afterSlideId === null
        ? 0
        : requireSlideIndex(deck, operation.afterSlideId) + 1;
      deck.slides.splice(at, 0, ...structuredClone(operation.slides));
      return;
    }
    case 'replaceSlide': {
      const at = requireSlideIndex(deck, operation.slideId);
      if (operation.slide.id !== operation.slideId) {
        throw new Error(`Replacement slide id must remain ${operation.slideId}`);
      }
      deck.slides[at] = structuredClone(operation.slide);
      return;
    }
    case 'deleteSlide': {
      if (deck.slides.length === 1) throw new Error('A deck must retain at least one slide');
      deck.slides.splice(requireSlideIndex(deck, operation.slideId), 1);
      return;
    }
    case 'moveSlide': {
      if (operation.afterSlideId === operation.slideId) throw new Error('A slide cannot follow itself');
      const from = requireSlideIndex(deck, operation.slideId);
      const [slide] = deck.slides.splice(from, 1);
      const at = operation.afterSlideId === null
        ? 0
        : requireSlideIndex(deck, operation.afterSlideId) + 1;
      deck.slides.splice(at, 0, slide);
      return;
    }
    case 'insertElements':
      requireSlide(deck, operation.slideId).elements.push(...structuredClone(operation.elements));
      return;
    case 'replaceElement': {
      const slide = requireSlide(deck, operation.slideId);
      const at = slide.elements.findIndex((element) => element.id === operation.elementId);
      if (at === -1) throw new Error(`Unknown element id: ${operation.elementId}`);
      if (operation.element.id !== operation.elementId) {
        throw new Error(`Replacement element id must remain ${operation.elementId}`);
      }
      slide.elements[at] = structuredClone(operation.element);
      return;
    }
    case 'deleteElements': {
      const slide = requireSlide(deck, operation.slideId);
      const ids = new Set(operation.elementIds);
      for (const id of ids) {
        if (!slide.elements.some((element) => element.id === id)) throw new Error(`Unknown element id: ${id}`);
      }
      slide.elements = slide.elements.filter((element) => !ids.has(element.id));
      slide.timeline = slide.timeline.filter((entry) =>
        !ids.has(entry.action.target) && !(entry.trigger.ref && ids.has(entry.trigger.ref)));
      return;
    }
    case 'updateDeck':
      if (operation.title !== undefined) deck.title = operation.title;
      if (operation.magicMoveDuration !== undefined) deck.magicMoveDuration = operation.magicMoveDuration;
  }
}

function requireSlide(deck: Deck, id: string): Slide {
  const slide = deck.slides.find((candidate) => candidate.id === id);
  if (!slide) throw new Error(`Unknown slide id: ${id}`);
  return slide;
}

function requireSlideIndex(deck: Deck, id: string): number {
  const index = deck.slides.findIndex((slide) => slide.id === id);
  if (index === -1) throw new Error(`Unknown slide id: ${id}`);
  return index;
}

/** Semantic constraints that Zod cannot express locally. */
export function validateDeckIntegrity(deck: Deck, assetExists?: (src: string) => boolean): string[] {
  const errors: string[] = [];
  const slideIds = new Set<string>();
  const elementIds = new Set<string>();
  for (const slide of deck.slides) {
    if (slideIds.has(slide.id)) errors.push(`Duplicate slide id: ${slide.id}`);
    slideIds.add(slide.id);
    const local = new Set(slide.elements.map((element) => element.id));
    for (const element of slide.elements) {
      if (elementIds.has(element.id)) errors.push(`Duplicate element id: ${element.id}`);
      elementIds.add(element.id);
      if (assetExists && (element.type === 'image' || element.type === 'video')) {
        if (!assetExists(element.src)) errors.push(`Missing asset for ${element.id}: ${element.src}`);
        if (element.type === 'video' && element.poster && !assetExists(element.poster)) {
          errors.push(`Missing poster for ${element.id}: ${element.poster}`);
        }
      }
    }
    if (assetExists && slide.background.image && !assetExists(slide.background.image)) {
      errors.push(`Missing background asset on ${slide.id}: ${slide.background.image}`);
    }
    for (const entry of slide.timeline) {
      if (!local.has(entry.action.target)) {
        errors.push(`Timeline ${entry.id} targets missing element ${entry.action.target}`);
      }
      if (entry.trigger.ref && !local.has(entry.trigger.ref)) {
        errors.push(`Timeline ${entry.id} references missing element ${entry.trigger.ref}`);
      }
    }
  }
  return errors;
}

/**
 * A scene derived from `deck.json` alone, for when no editor is running.
 *
 * Everything the authored deck states is here; everything only a rendering can
 * know — measured bounds, resolved styles, the size auto-fit settled on — is
 * explicitly null rather than guessed, so an agent can tell the difference.
 */
export function authoredScene(
  deck: Deck,
  slide: Slide,
  index: number,
  selectedSlideIds = new Set<string>(),
  selectedElementIds = new Set<string>(),
  activeSlideId: string | null = null,
): ComputedSlideScene {
  return {
    id: slide.id,
    index,
    name: slide.name,
    active: activeSlideId === null ? index === 0 : slide.id === activeSlideId,
    selected: selectedSlideIds.has(slide.id),
    canvas: deck.canvas,
    background: slide.background,
    layout: slide.layout ?? 'freeform',
    magicMoveFromPrevious: slide.magicMoveFromPrevious ?? false,
    skipped: slide.skipped ?? false,
    timeline: slide.timeline,
    elements: slide.elements.map((element) => authoredElementScene(element, selectedElementIds)),
  };
}

function authoredElementScene(element: SlideElement, selected: Set<string>): ComputedElementScene {
  return {
    id: element.id,
    type: element.type,
    selected: selected.has(element.id),
    authored: {
      x: element.x, y: element.y, w: element.w, h: element.h,
      rot: element.rot, z: element.z, opacity: element.opacity,
    },
    rendered: null,
    computedStyle: {},
    text: element.type === 'text' ? {
      html: element.html,
      plain: element.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      fittedFontSize: null,
      overflowX: false,
      overflowY: false,
    } : null,
    media: element.type === 'image' || element.type === 'video' ? {
      src: element.src,
      fit: element.fit,
      sourceBox: element.sourceBox,
      effects: element.effects ?? [],
      borderColor: element.borderColor ?? null,
      borderWidth: element.borderWidth ?? 0,
      borderRadius: element.borderRadius ?? 0,
      duration: element.type === 'video' ? element.end : null,
    } : null,
    shape: element.type === 'shape' ? {
      kind: element.shape,
      stroke: element.stroke,
      fill: element.fill,
      strokeWidth: element.strokeWidth,
      arrowStart: element.arrowStart,
      arrowEnd: element.arrowEnd,
      control: element.control ?? null,
      path: element.path,
    } : null,
    magicMoveId: element.magicMoveId ?? null,
    lineageId: element.lineageId ?? null,
  };
}
