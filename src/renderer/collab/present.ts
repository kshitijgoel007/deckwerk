import '../player/player.css';
import '../player/type.css';
import { Player } from '../player/player.js';
import { bindPresentKeys } from '../player/keys.js';
import { CollabBridge } from './collabBridge.js';

/**
 * The collab Present view: the real Player in a fullscreen-able browser tab,
 * fed live by the same WebSocket session as the editor — edits made while
 * presenting land on screen immediately, exactly like the desktop projector
 * window. Read-only: it never sends transactions, but it does appear to
 * collaborators as a peer so they know a presentation is running.
 */

const params = new URLSearchParams(location.search);
const deckId = params.get('deck');
if (!deckId) {
  document.body.textContent = 'Missing ?deck= parameter.';
  throw new Error('missing deck');
}
const startSlide = Math.max(0, Number(params.get('slide') ?? '1') - 1);
const agentViewer = params.get('agent') === '1';

const themeTag = document.createElement('style');
document.head.appendChild(themeTag);

let player: Player | null = null;

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?deck=${encodeURIComponent(deckId)}`;
const name = localStorage.getItem('collab-name');
const bridge = new CollabBridge(wsUrl, name ? `${name} (presenting)` : 'Presenting', {
  onWelcome: (welcome) => {
    themeTag.textContent = welcome.themeCss;
    document.title = `${agentViewer ? 'Agent viewer' : 'Presenting'} — ${welcome.deck.title}`;
    if (!player) {
      player = new Player({
        deck: welcome.deck,
        container: document.getElementById('stage')!,
        resolveSrc: (src) =>
          `/decks/${encodeURIComponent(deckId)}/${src.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`,
      });
      player.goToSlide(startSlide);
      if (!agentViewer) {
        bindPresentKeys(window, player, { onExit: () => window.close() });
        // A click advances, like a presenter remote; double-click toggles fullscreen.
        window.addEventListener('click', () => player?.next());
        window.addEventListener('dblclick', () => {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen();
        });
      }
    } else {
      player.setDeck(welcome.deck);
    }
  },
  onDeckReplaced: (deck) => player?.setDeck(deck),
  onPeerPresence: () => {},
  onPeerCursor: () => {},
  onPeerLeft: () => {},
  onThemeCss: (css) => {
    themeTag.textContent = css;
  },
  onStatus: () => {},
  onCleanChange: () => {},
});

bridge.connect();
