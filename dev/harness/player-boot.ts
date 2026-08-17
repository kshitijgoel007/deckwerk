import '../../src/renderer/player/player.css';
import '../../src/renderer/player/type.css';
import { DeckSchema } from '../../src/shared/deck.js';
import { Player } from '../../src/renderer/player/player.js';

/**
 * Mounts the real Player against a deck folder served from the project root,
 * so magic-move transitions can be watched and inspected in a plain browser.
 * Query params: ?deck=animation-reference&duration=3000
 */
const params = new URLSearchParams(location.search);
const deckName = params.get('deck') ?? 'animation-reference';

const raw = await (await fetch(`/${deckName}/deck.json`)).json();
const deck = DeckSchema.parse(raw);
const duration = Number(params.get('duration'));
if (Number.isFinite(duration) && duration > 0) deck.magicMoveDuration = duration;

const theme = document.createElement('style');
theme.textContent = await (await fetch(`/${deckName}/theme.css`)).text();
document.head.appendChild(theme);

const player = new Player({
  deck,
  container: document.getElementById('stage')!,
  resolveSrc: (src) => `/${deckName}/${src.replace(/^\/+/, '')}`,
});
player.goToSlide(0);

window.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowRight' || event.key === ' ') player.next();
  if (event.key === 'ArrowLeft') player.prev();
});

(window as unknown as { player: Player }).player = player;
