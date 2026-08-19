import type { CursorPosition, PresenceState } from '@shared/collab.js';
import type { EditorCanvas } from '../editor/canvas.js';
import type { EditorStore } from '../editor/store.js';

const CURSOR_FADE_MS = 5000;

interface PeerView {
  state: PresenceState;
  cursorAt: number;
}

/**
 * Draws collaborators into the canvas: a named cursor glyph and colored
 * selection outlines for every peer whose presence points at the slide the
 * local user is looking at. Lives in its own stage layer (slide coordinate
 * space, scaled with the stage) so high-frequency cursor motion never touches
 * the selection overlay that drawOverlay rebuilds wholesale.
 */
export class PresenceOverlay {
  private peers = new Map<string, PeerView>();
  private layer: HTMLElement;
  private fadeTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly canvas: EditorCanvas,
    private readonly store: EditorStore,
  ) {
    this.layer = canvas.addStageLayer('presence-layer');
    canvas.onViewportChange = () => this.render();
    store.subscribe(() => this.render());
    this.fadeTimer = setInterval(() => this.render(), 1000);
  }

  destroy(): void {
    clearInterval(this.fadeTimer);
    this.layer.remove();
  }

  upsert(state: PresenceState): void {
    const existing = this.peers.get(state.clientId);
    this.peers.set(state.clientId, {
      state: { ...state, cursor: state.cursor ?? existing?.state.cursor ?? null },
      cursorAt: existing?.cursorAt ?? 0,
    });
    this.render();
  }

  moveCursor(clientId: string, cursor: CursorPosition | null): void {
    const peer = this.peers.get(clientId);
    if (!peer) return;
    peer.state = { ...peer.state, cursor };
    peer.cursorAt = performance.now();
    this.render();
  }

  remove(clientId: string): void {
    this.peers.delete(clientId);
    this.render();
  }

  /** Peers whose active slide is the given one — for rail dots and selections. */
  peersOnSlide(slideId: string): Array<{
    name: string;
    color: string;
    selectedElementIds: string[];
  }> {
    return [...this.peers.values()]
      .filter((peer) => peer.state.activeSlideId === slideId)
      .map((peer) => ({
        name: peer.state.name,
        color: peer.state.color,
        selectedElementIds: peer.state.selectedElementIds,
      }));
  }

  private render(): void {
    const slide = this.store.slide;
    if (!slide) {
      this.layer.replaceChildren();
      return;
    }
    const inv = 1 / Math.max(this.canvas.stageScale(), 0.0001);
    const now = performance.now();
    const nodes: HTMLElement[] = [];

    for (const peer of this.peers.values()) {
      const { state } = peer;

      // Selection outlines for peers working on this slide.
      if (state.activeSlideId === slide.id && state.selectedElementIds.length > 0) {
        const byId = new Map(slide.elements.map((element) => [element.id, element]));
        for (const id of state.selectedElementIds) {
          const element = byId.get(id);
          if (!element) continue;
          const box = document.createElement('div');
          box.className = 'presence-selection';
          box.style.cssText = [
            'position:absolute',
            `left:${element.x}px`,
            `top:${element.y}px`,
            `width:${element.w}px`,
            `height:${element.h}px`,
            `transform:rotate(${element.rot}deg)`,
            `outline:${2 * inv}px solid ${state.color}`,
            `outline-offset:${2 * inv}px`,
          ].join(';');
          if (state.editingElementId === id || id === state.selectedElementIds[0]) {
            const tag = document.createElement('span');
            tag.textContent = state.editingElementId === id ? `✎ ${state.name}` : state.name;
            tag.className = 'presence-tag';
            tag.style.cssText = [
              'position:absolute',
              `top:${-24 * inv}px`,
              'left:0',
              `background:${state.color}`,
              'color:#fff',
              `font-size:${12 * inv}px`,
              `padding:${2 * inv}px ${6 * inv}px`,
              `border-radius:${4 * inv}px`,
              'white-space:nowrap',
              'font-family:system-ui,sans-serif',
            ].join(';');
            box.append(tag);
          }
          nodes.push(box);
        }
      }

      // Cursor glyph, faded out after inactivity.
      const cursor = state.cursor;
      if (cursor && cursor.slideId === slide.id) {
        const age = now - peer.cursorAt;
        const opacity = age > CURSOR_FADE_MS ? 0.25 : 1;
        const glyph = document.createElement('div');
        glyph.className = 'presence-cursor';
        glyph.style.cssText = [
          'position:absolute',
          `left:${cursor.x}px`,
          `top:${cursor.y}px`,
          `opacity:${opacity}`,
          'transition:opacity .3s',
          `transform:scale(${inv})`,
          'transform-origin:top left',
        ].join(';');
        glyph.innerHTML =
          `<svg width="18" height="24" viewBox="0 0 18 24" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))">` +
          `<path d="M1 1 L1 17 L5.5 13.5 L8.5 20 L11.5 18.5 L8.5 12 L14 11.5 Z" fill="${state.color}" stroke="#fff" stroke-width="1"/>` +
          `</svg>`;
        const label = document.createElement('span');
        label.textContent = state.name;
        label.style.cssText = [
          'position:absolute',
          'left:14px',
          'top:20px',
          `background:${state.color}`,
          'color:#fff',
          'font-size:12px',
          'padding:2px 6px',
          'border-radius:4px',
          'white-space:nowrap',
          'font-family:system-ui,sans-serif',
        ].join(';');
        glyph.append(label);
        nodes.push(glyph);
      }
    }

    this.layer.replaceChildren(...nodes);
  }
}
