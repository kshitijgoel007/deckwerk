import '../player/player.css';
import '../player/type.css';
import { Player } from '../player/player.js';
import { bindPresentKeys } from '../player/keys.js';
import { CollabBridge } from './collabBridge.js';
import { PlayerPaintReadiness } from './playerReadiness.js';

/**
 * The collab Present view: the real Player in a fullscreen-able browser tab,
 * fed live by the same WebSocket session as the editor — edits made while
 * presenting land on screen immediately, exactly like the desktop projector
 * window. Read-only: it never sends transactions, but it does appear to
 * collaborators as a peer so they know a presentation is running.
 */

/**
 * Browsers only grant fullscreen from a user gesture, and the click that opened
 * this window does not carry over. So: try immediately (some browsers allow it
 * for a freshly opened popup), and if that is refused, fall back to a hint and
 * let the viewer's first click or keypress do it — that first gesture goes to
 * fullscreen instead of advancing the slide.
 */
let awaitingFullscreenGesture = false;

function hint(): HTMLElement {
  let node = document.getElementById('fullscreen-hint');
  if (!node) {
    node = document.createElement('div');
    node.id = 'fullscreen-hint';
    node.textContent = 'Click anywhere for fullscreen';
    node.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);'
      + 'padding:8px 16px;border-radius:999px;background:rgba(0,0,0,.7);color:#fff;'
      + 'font:14px system-ui,sans-serif;pointer-events:none;z-index:10;';
    document.body.appendChild(node);
  }
  return node;
}

function goFullscreen(): void {
  if (document.fullscreenElement) return;
  document.documentElement.requestFullscreen().then(() => {
    awaitingFullscreenGesture = false;
    hint().remove();
  }, () => {
    awaitingFullscreenGesture = true;
    hint();
  });
}

/** Returns true when this gesture was spent entering fullscreen. */
function consumeFullscreenGesture(): boolean {
  if (!awaitingFullscreenGesture) return false;
  awaitingFullscreenGesture = false;
  hint().remove();
  void document.documentElement.requestFullscreen().catch(() => {});
  return true;
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'f' || event.key === 'F') goFullscreen();
}, true);

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
const readiness = new PlayerPaintReadiness({
  root: document.documentElement,
  fontsReady: document.fonts.ready,
  requestFrame: (callback) => requestAnimationFrame(callback),
  currentSlide: () => player ? player.getCursor().slide + 1 : null,
  onPainted: (slide) => window.dispatchEvent(new CustomEvent('slide-player-painted', {
    detail: { slide },
  })),
});
readiness.connecting();

function replaceDeck(deck: Parameters<Player['setDeck']>[0]): void {
  player?.setDeck(deck);
  readiness.painting();
}

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
      readiness.painting();
      if (!agentViewer) {
        bindPresentKeys(window, player, { onExit: () => window.close() });
        // A click advances, like a presenter remote; double-click toggles fullscreen.
        window.addEventListener('click', () => {
          if (consumeFullscreenGesture()) return;
          player?.next();
        });
        window.addEventListener('dblclick', () => {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen();
        });
        goFullscreen();
      }
    } else {
      replaceDeck(welcome.deck);
    }
  },
  onDeckReplaced: (deck) => replaceDeck(deck),
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
