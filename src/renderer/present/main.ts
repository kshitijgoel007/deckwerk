import '../player/player.css';
import type { DeckSession } from '@shared/ipc.js';
import type { PresentationCommand } from '@shared/ipc.js';
import { bindPresentKeys } from '../player/keys.js';
import { Player } from '../player/player.js';

/**
 * The fullscreen presentation window. Thin by design: it renders the deck with
 * the same `Player` the editor previews with, so what you rehearse is exactly
 * what the projector shows.
 */

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

let player: Player | null = null;
let themeLink: HTMLStyleElement | null = null;
const startedAt = Date.now();

async function applyTheme(): Promise<void> {
  const css = await window.api.loadTheme();
  if (!themeLink) {
    themeLink = document.createElement('style');
    document.head.appendChild(themeLink);
  }
  themeLink.textContent = css;
}

function start(session: DeckSession): void {
  const startSlide = Number(new URLSearchParams(location.search).get('slide') ?? 0);

  if (player) {
    player.setDeck(session.deck);
    return;
  }

  player = new Player({
    deck: session.deck,
    container: root!,
    resolveSrc: (src) => window.api.assetUrl(src),
    onCursor: (cursor, steps) => window.api.publishPresentState({ cursor, steps, startedAt }),
  });
  // Presenting from a skipped slide would put it on the projector anyway;
  // land on the nearest slide that is actually part of the talk.
  let first = Number.isFinite(startSlide) ? startSlide : 0;
  const slides = session.deck.slides;
  if (slides[first]?.skipped) {
    const forward = slides.findIndex((s, i) => i > first && !s.skipped);
    if (forward >= 0) {
      first = forward;
    } else {
      for (let i = slides.length - 1; i >= 0; i--) {
        if (!slides[i].skipped) { first = i; break; }
      }
    }
  }
  player.goToSlide(first);

  bindPresentKeys(window, player, { onExit: () => window.close() });

  // Clicking advances, like every other presentation tool.
  window.addEventListener('mousedown', (e) => {
    if (e.button === 0) player?.next();
    else if (e.button === 2) player?.prev();
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
}

window.api.onPresentCommand((command: PresentationCommand) => {
  if (!player) return;
  if (command.type === 'next') player.next();
  else if (command.type === 'prev') player.prev();
  else if (command.type === 'goTo') player.goToSlide(command.slide);
  else if (command.type === 'toggleBlank') player.toggleBlank();
});

// Live updates while presenting (editing on a second screen mid-rehearsal).
window.api.onDeckState((session) => {
  void applyTheme();
  start(session);
});

// Pull the current deck on load, rather than waiting for a broadcast that may
// already have fired — reopening this window mid-talk must not show black.
void (async () => {
  const session = await window.api.getDeck();
  if (!session) return;
  await applyTheme();
  start(session);
})();
