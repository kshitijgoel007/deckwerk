import '../player/player.css';
import { parseDeck } from '@shared/deck.js';
import { bindPresentKeys } from '../player/keys.js';
import { Player } from '../player/player.js';

/**
 * Entry point for the exported standalone bundle.
 *
 * This is built separately as a self-contained IIFE so an exported deck is a
 * plain folder that opens in any browser with no app, no server and no build
 * step — which is also the safest way to present on a machine you don't control.
 *
 * The deck itself is injected as `window.__DECK__` by the generated index.html,
 * so the page needs no fetch and works straight off `file://`.
 */

declare global {
  interface Window {
    __DECK__?: unknown;
  }
}

function boot(): void {
  const root = document.getElementById('root');
  if (!root) throw new Error('missing #root');
  if (!window.__DECK__) {
    root.textContent = 'No deck data found in this export.';
    return;
  }

  const deck = parseDeck(window.__DECK__);
  const player = new Player({
    deck,
    container: root,
    // Assets sit next to index.html, so their deck-relative paths already work.
    resolveSrc: (src) => src,
  });

  bindPresentKeys(window, player);

  // Deep-linking for humans and agents alike: index.html#7 opens slide 7.
  // With this, "render slide N" is one headless-chromium screenshot away —
  // no app, no server.
  const jumpToHash = () => {
    const n = Number.parseInt(location.hash.replace('#', ''), 10);
    if (Number.isFinite(n) && n >= 1) player.goToSlide(n - 1);
  };
  window.addEventListener('hashchange', jumpToHash);
  jumpToHash();

  window.addEventListener('mousedown', (e) => {
    if (e.button === 0) player.next();
    else if (e.button === 2) player.prev();
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
