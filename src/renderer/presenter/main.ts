import '../player/player.css';
import '../appChrome.css';
import './presenter.css';
import type { Deck } from '@shared/deck.js';
import type { DeckSession, PresentationState } from '@shared/ipc.js';
import { resolveState } from '@shared/timeline.js';
import { revealImagesWhenDecoded } from '../player/imageDecode.js';
import { freezePreviewVideos } from '../player/previewPoster.js';
import { applyStageScale, renderSlide } from '../player/render.js';
import { applyStaticSlideState } from '../player/staticState.js';
import { formatElapsed, formatWallClock, presentationLabel } from './model.js';

let deck: Deck | null = null;
const openedAt = Date.now();
let state: PresentationState = {
  cursor: { slide: 0, step: 0 },
  steps: 1,
  startedAt: openedAt,
  slideStartedAt: openedAt,
};
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
  stage.appendChild(renderSlide(slide, {
    resolveSrc: window.api.assetUrl,
    mediaPreload: 'metadata',
  }));
  host.appendChild(stage);
  const resolved = resolveState(slide, step);
  applyStaticSlideState(stage, slide, resolved);
  const bounds = host.getBoundingClientRect();
  applyStageScale(stage, deck, { w: bounds.width, h: bounds.height });
  for (const video of stage.querySelectorAll('video')) video.pause();
  // Large JPEGs otherwise paint their first decoded scanlines as a thin strip
  // before the complete bitmap is ready. Keep both current and next previews
  // atomic just like the audience Player.
  revealImagesWhenDecoded(stage);
  // Speaker View is a pair of still previews, not a playback surface. Capture
  // one decoded frame per source/in-point and reuse it across re-renders. In
  // particular, the next slide is warm before it becomes current, so moving
  // through a video-heavy deck never opens on an undecoded black frame.
  freezePreviewVideos(stage);
}

function render(): void {
  if (!deck) return;
  preview(current, state.cursor.slide, state.cursor.step);
  const lastSlide = state.range?.end ?? deck.slides.length - 1;
  let nextSlide = state.cursor.slide + 1;
  while (nextSlide <= lastSlide && deck.slides[nextSlide]?.skipped) nextSlide += 1;
  preview(next, nextSlide <= lastSlide ? nextSlide : -1);
  document.getElementById('position')!.textContent = presentationLabel(state, deck.slides.length);
}

window.api.onDeckState((session) => void load(session));
window.api.onPresentState((nextState) => { state = nextState; render(); updateClocks(); });
window.addEventListener('resize', render);
document.getElementById('prev')!.addEventListener('click', () => window.api.sendPresentCommand({ type: 'prev' }));
document.getElementById('nextButton')!.addEventListener('click', () => window.api.sendPresentCommand({ type: 'next' }));
document.getElementById('blank')!.addEventListener('click', () => window.api.sendPresentCommand({ type: 'toggleBlank' }));
document.getElementById('switchDisplays')!.addEventListener('click', () => window.api.sendPresentCommand({ type: 'swapDisplays' }));
document.getElementById('end')!.addEventListener('click', () => window.api.sendPresentCommand({ type: 'exit' }));
window.addEventListener('keydown', (event) => {
  if (['ArrowRight', ' ', 'PageDown'].includes(event.key)) window.api.sendPresentCommand({ type: 'next' });
  else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(event.key)) window.api.sendPresentCommand({ type: 'prev' });
  else if (event.key === 'b') window.api.sendPresentCommand({ type: 'toggleBlank' });
  else if (event.key === 'Escape') window.api.sendPresentCommand({ type: 'exit' });
});
function updateClocks(): void {
  const now = Date.now();
  document.getElementById('presentation-timer')!.textContent = formatElapsed(now, state.startedAt);
  document.getElementById('slide-timer')!.textContent = formatElapsed(now, state.slideStartedAt);
  document.getElementById('wall-clock')!.textContent = formatWallClock(new Date(now));
}

updateClocks();
setInterval(updateClocks, 250);
void window.api.getDeck().then((session) => session && load(session));
