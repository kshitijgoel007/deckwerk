import '../player/player.css';
import './presenter.css';
import type { Deck } from '@shared/deck.js';
import type { DeckSession, PresentationState } from '@shared/ipc.js';
import { resolveState } from '@shared/timeline.js';
import { applyParagraphVisibility } from '@shared/paragraphs.js';
import { applyStageScale, renderSlide } from '../player/render.js';
import { formatElapsed, presentationLabel } from './model.js';

let deck: Deck | null = null;
let state: PresentationState = { cursor: { slide: 0, step: 0 }, steps: 1, startedAt: Date.now() };
let theme: HTMLStyleElement | null = null;
const current = document.getElementById('current')!;
const next = document.getElementById('next')!;

async function load(session: DeckSession): Promise<void> {
  deck = session.deck;
  if (!theme) { theme = document.createElement('style'); document.head.appendChild(theme); }
  theme.textContent = await window.api.loadTheme();
  render();
}

function preview(host: HTMLElement, slideIndex: number, step = 0): void {
  host.replaceChildren();
  if (!deck?.slides[slideIndex]) return;
  const stage = document.createElement('div');
  stage.className = 'stage';
  const slide = deck.slides[slideIndex];
  stage.appendChild(renderSlide(slide, { resolveSrc: window.api.assetUrl }));
  host.appendChild(stage);
  const resolved = resolveState(slide, step);
  for (const element of slide.elements) {
    const node = stage.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(element.id)}"]`);
    if (node) node.style.visibility = resolved.visible.has(element.id) ? 'visible' : 'hidden';
  }
  applyParagraphVisibility(stage, resolved);
  const bounds = host.getBoundingClientRect();
  applyStageScale(stage, deck, { w: bounds.width, h: bounds.height });
  for (const video of stage.querySelectorAll('video')) video.pause();
}

function render(): void {
  if (!deck) return;
  preview(current, state.cursor.slide, state.cursor.step);
  preview(next, state.cursor.slide + 1);
  document.getElementById('position')!.textContent = presentationLabel(state, deck.slides.length);
}

window.api.onDeckState((session) => void load(session));
window.api.onPresentState((nextState) => { state = nextState; render(); });
window.addEventListener('resize', render);
document.getElementById('prev')!.addEventListener('click', () => window.api.sendPresentCommand({ type: 'prev' }));
document.getElementById('nextButton')!.addEventListener('click', () => window.api.sendPresentCommand({ type: 'next' }));
document.getElementById('blank')!.addEventListener('click', () => window.api.sendPresentCommand({ type: 'toggleBlank' }));
document.getElementById('end')!.addEventListener('click', () => window.api.sendPresentCommand({ type: 'exit' }));
window.addEventListener('keydown', (event) => {
  if (['ArrowRight', ' ', 'PageDown'].includes(event.key)) window.api.sendPresentCommand({ type: 'next' });
  else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(event.key)) window.api.sendPresentCommand({ type: 'prev' });
  else if (event.key === 'b') window.api.sendPresentCommand({ type: 'toggleBlank' });
  else if (event.key === 'Escape') window.api.sendPresentCommand({ type: 'exit' });
});
setInterval(() => {
  document.getElementById('timer')!.textContent = formatElapsed(Date.now(), state.startedAt);
}, 250);
void window.api.getDeck().then((session) => session && load(session));
