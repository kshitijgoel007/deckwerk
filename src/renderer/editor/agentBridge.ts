import {
  AGENT_PROTOCOL_VERSION,
  applyAgentTransaction,
  canonicalDeckJson,
  type AgentContextDraft,
  type AgentRequest,
  type AgentResponse,
  type ComputedElementScene,
  type ComputedSlideScene,
} from '@shared/agent.js';
import type { Deck, Slide, SlideElement } from '@shared/deck.js';
import { fitAutoText, renderSlide } from '../player/render.js';
import type { EditorStore } from './store.js';

const COMPUTED_PROPERTIES = [
  'color', 'background-color', 'font-family', 'font-size', 'font-weight',
  'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration',
  'border-color', 'border-width', 'border-radius', 'filter', 'object-fit',
  'display', 'justify-content', 'align-items', 'overflow',
] as const;

export interface AgentBridgeOptions {
  publish: (context: AgentContextDraft) => Promise<void>;
  respond: (response: AgentResponse) => void;
  save: () => Promise<void>;
  resolveSrc: (src: string) => string;
}

/** Publishes the editor's live, computed selection through the file-backed main-process bridge. */
export class AgentBridge {
  private store: EditorStore;
  private options: AgentBridgeOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(store: EditorStore, options: AgentBridgeOptions) {
    this.store = store;
    this.options = options;
    store.subscribe(() => this.schedule());
    document.fonts?.ready.then(() => this.schedule());
    this.schedule();
  }

  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.publish();
    }, 140);
  }

  async handle(request: AgentRequest): Promise<void> {
    const deck = this.store.get().deck;
    const revision = await browserDeckRevision(deck);
    if (request.kind === 'transaction') {
      if (request.transaction.expectedRevision !== revision) {
        this.options.respond({
          version: AGENT_PROTOCOL_VERSION,
          id: request.id,
          status: 'conflict',
          revision,
          message: 'The deck changed after this transaction was prepared',
        });
        return;
      }
      try {
        const next = applyAgentTransaction(deck, request.transaction);
        this.store.replaceWithHistory(next, request.transaction.label);
        await this.options.save();
        const nextRevision = await browserDeckRevision(this.store.get().deck);
        this.options.respond({
          version: AGENT_PROTOCOL_VERSION,
          id: request.id,
          status: 'applied',
          revision: nextRevision,
        });
      } catch (error) {
        this.options.respond({
          version: AGENT_PROTOCOL_VERSION,
          id: request.id,
          status: 'error',
          revision,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (request.expectedRevision !== revision) {
      this.options.respond({
        version: AGENT_PROTOCOL_VERSION,
        id: request.id,
        status: 'conflict',
        revision,
        message: 'The deck changed before DOM inspection completed',
      });
      return;
    }
    try {
      const state = this.store.get();
      const slides = state.deck.slides.filter((slide) => state.slideSelection.has(slide.id));
      const payload = await buildInlineDom(
        state.deck,
        slides,
        state.selection,
        this.options.resolveSrc,
      );
      this.options.respond({
        version: AGENT_PROTOCOL_VERSION,
        id: request.id,
        status: 'ok',
        revision,
        payload,
      });
    } catch (error) {
      this.options.respond({
        version: AGENT_PROTOCOL_VERSION,
        id: request.id,
        status: 'error',
        revision,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async publish(): Promise<void> {
    const state = this.store.get();
    if (!state.dir) return;
    try {
      const selectedSlides = state.deck.slides
        .map((slide, index) => ({ slide, index }))
        .filter(({ slide }) => state.slideSelection.has(slide.id));
      const scenes = await buildComputedScenes(
        state.deck,
        selectedSlides,
        state.slideIndex,
        state.slideSelection,
        state.selection,
        this.options.resolveSrc,
      );
      await this.options.publish({
        version: AGENT_PROTOCOL_VERSION,
        deckRevision: await browserDeckRevision(state.deck),
        activeSlideId: state.deck.slides[state.slideIndex]?.id ?? null,
        activeSlideIndex: state.slideIndex,
        selectedSlideIds: state.deck.slides
          .filter((slide) => state.slideSelection.has(slide.id))
          .map((slide) => slide.id),
        selectedElementIds: [...state.selection],
        scenes,
      });
    } catch (error) {
      console.warn('Could not publish agent context:', error);
    }
  }
}

export async function browserDeckRevision(deck: Deck): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalDeckJson(deck));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildComputedScenes(
  deck: Deck,
  slides: Array<{ slide: Slide; index: number }>,
  activeSlideIndex: number,
  selectedSlideIds: Set<string>,
  selectedElementIds: Set<string>,
  resolveSrc: (src: string) => string,
): Promise<ComputedSlideScene[]> {
  const output: ComputedSlideScene[] = [];
  for (const { slide, index } of slides) {
    const { host, root } = mountSlide(deck, slide, resolveSrc);
    fitAutoText(root);
    // Allow layout, fonts and media wrappers to settle before measuring.
    await nextFrame();
    const rootRect = root.getBoundingClientRect();
    output.push({
      id: slide.id,
      index,
      name: slide.name,
      active: index === activeSlideIndex,
      selected: selectedSlideIds.has(slide.id),
      canvas: deck.canvas,
      background: slide.background,
      layout: slide.layout ?? 'freeform',
      magicMoveFromPrevious: slide.magicMoveFromPrevious ?? false,
      timeline: structuredClone(slide.timeline),
      elements: slide.elements.map((element) => computedElement(
        element,
        root.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(element.id)}"]`),
        rootRect,
        selectedElementIds,
      )),
    });
    host.remove();
  }
  return output;
}

async function buildInlineDom(
  deck: Deck,
  slides: Slide[],
  selectedElementIds: Set<string>,
  resolveSrc: (src: string) => string,
): Promise<Array<{ slideId: string; html: string }>> {
  const result: Array<{ slideId: string; html: string }> = [];
  for (const slide of slides) {
    const { host, root } = mountSlide(deck, slide, resolveSrc);
    fitAutoText(root);
    await nextFrame();
    for (const node of root.querySelectorAll<HTMLElement>('*')) {
      const style = getComputedStyle(node);
      let inline = '';
      for (const property of style) inline += `${property}:${style.getPropertyValue(property)};`;
      node.setAttribute('style', inline);
    }
    for (const id of selectedElementIds) {
      root.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(id)}"]`)
        ?.setAttribute('data-agent-selected', 'true');
    }
    result.push({ slideId: slide.id, html: root.outerHTML });
    host.remove();
  }
  return result;
}

function mountSlide(deck: Deck, slide: Slide, resolveSrc: (src: string) => string) {
  const host = document.createElement('div');
  host.className = 'agent-measure-host';
  Object.assign(host.style, {
    position: 'fixed', left: '-100000px', top: '0', width: `${deck.canvas.w}px`,
    height: `${deck.canvas.h}px`, visibility: 'hidden', pointerEvents: 'none',
  });
  const root = renderSlide(slide, { resolveSrc });
  root.style.width = `${deck.canvas.w}px`;
  root.style.height = `${deck.canvas.h}px`;
  host.appendChild(root);
  document.body.appendChild(host);
  return { host, root };
}

function computedElement(
  element: SlideElement,
  node: HTMLElement | null,
  rootRect: DOMRect,
  selectedIds: Set<string>,
): ComputedElementScene {
  const rect = node?.getBoundingClientRect();
  const style = node ? getComputedStyle(node) : null;
  const content = node?.querySelector<HTMLElement>('.text-content') ?? null;
  const body = node?.querySelector<HTMLElement>('.text-body') ?? null;
  const computedStyle: Record<string, string> = {};
  if (style) for (const property of COMPUTED_PROPERTIES) computedStyle[property] = style.getPropertyValue(property);
  return {
    id: element.id,
    type: element.type,
    selected: selectedIds.has(element.id),
    authored: {
      x: element.x, y: element.y, w: element.w, h: element.h,
      rot: element.rot, z: element.z, opacity: element.opacity,
    },
    rendered: rect ? {
      x: rect.left - rootRect.left,
      y: rect.top - rootRect.top,
      w: rect.width,
      h: rect.height,
    } : null,
    computedStyle,
    text: element.type === 'text' ? {
      html: element.html,
      plain: htmlToPlainText(element.html),
      fittedFontSize: content?.dataset.fittedFontSize
        ? Number(content.dataset.fittedFontSize)
        : null,
      overflowX: Boolean(content && body && content.scrollWidth > body.clientWidth + 0.5),
      overflowY: Boolean(content && body && content.scrollHeight > body.clientHeight + 0.5),
    } : null,
    media: element.type === 'image' || element.type === 'video' ? {
      src: element.src,
      fit: element.fit,
      sourceBox: element.sourceBox,
      effects: element.effects ?? [],
      borderColor: element.borderColor ?? null,
      borderWidth: element.borderWidth ?? 0,
      borderRadius: element.borderRadius ?? 0,
      duration: element.type === 'video' && element.end !== null
        ? Math.max(0, element.end - element.start)
        : null,
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

function htmlToPlainText(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
