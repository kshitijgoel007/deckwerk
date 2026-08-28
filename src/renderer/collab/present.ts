import '../player/player.css';
import '../player/type.css';
import { Player } from '../player/player.js';
import { bindPresentKeys } from '../player/keys.js';
import { CollabBridge } from './collabBridge.js';
import { createConnectionNotice } from './connectionNotice.js';
import { PlayerPaintReadiness } from './playerReadiness.js';
import { trackVideoLoading } from '../player/videoLoadingProgress.js';
import { slideLinkFromEvent } from '../player/links.js';
import { selectionPreventsAdvance } from '../player/presentationPointer.js';

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
  if (embedded || document.fullscreenElement) return;
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
// Embedded: the editor tab mounted us in an iframe it already fullscreened, so
// fullscreen is somebody else's job and exiting means telling the parent.
const embedded = params.get('embed') === '1' && window.parent !== window;

function exitPresentation(): void {
  if (embedded) window.parent.postMessage({ type: 'present-exit' }, location.origin);
  else window.close();
}

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

/**
 * Put the deck on screen and wire the presenter controls.
 *
 * Called by whichever source produces a deck first: the parent tab's seed when
 * embedded, or this view's own WebSocket welcome. Idempotent, so a late arrival
 * reconciles the deck instead of building a second player.
 */
function startPlayer(
  deck: Parameters<Player['setDeck']>[0],
  themeCss: string | null,
  source: 'seed' | 'session',
): void {
  if (themeCss !== null) themeTag.textContent = themeCss;
  if (player) {
    replaceDeck(deck);
    return;
  }
  // Which source got the deck on screen first. Worth having in the DOM: it is
  // the difference between painting immediately and waiting out a WebSocket
  // handshake, and it is otherwise invisible once the slide is up.
  document.documentElement.dataset.presentSource = source;
  // Over a remote server video bytes arrive well after the slide paints; show
  // per-video progress and a page pill instead of unexplained black boxes.
  trackVideoLoading(document.getElementById('stage')!);
  player = new Player({
    deck,
    container: document.getElementById('stage')!,
    resolveSrc: (src) =>
      `/decks/${encodeURIComponent(deckId!)}/${src.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`,
  });
  player.goToSlide(startSlide);
  readiness.painting();
  // A deck arriving while the page-owning "disconnected" notice is up (e.g. a
  // late seed from the editor tab) means the slide is visible now — re-render
  // the notice so it shrinks to a pill instead of covering the presentation.
  if (connectionNotice.state() === 'disconnected') connectionNotice.showDisconnected();
  if (agentViewer) return;
  bindPresentKeys(window, player, { onExit: exitPresentation });
  // A click advances, like a presenter remote; double-click toggles fullscreen.
  window.addEventListener('click', (event) => {
    if (consumeFullscreenGesture()) return;
    if (slideLinkFromEvent(event)) return;
    if (selectionPreventsAdvance()) return;
    player?.next();
  });
  window.addEventListener('dblclick', () => {
    if (embedded) exitPresentation();
    else if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  });
  goFullscreen();
  window.focus();
}

/**
 * When the editor tab mounted this view, it already has the deck and the theme
 * in memory. Ask for them: opening a second WebSocket and waiting for its
 * welcome costs about a second, and that second was spent showing black.
 * The socket still connects, and its welcome remains authoritative.
 */
if (embedded) {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== location.origin) return;
    const data = event.data as { type?: string; deck?: unknown; themeCss?: string } | null;
    if (data?.type !== 'present-seed' || !data.deck) return;
    if (player) return;
    document.title = 'Presenting';
    startPlayer(data.deck as Parameters<Player['setDeck']>[0], data.themeCss ?? null, 'seed');
  });
  window.parent.postMessage({ type: 'present-hello' }, location.origin);
}

// A dead server must never mean an unexplained blank page. With a deck on
// screen (seeded or previously welcomed) a lost socket shows a pill and the
// presentation keeps working from memory; with no deck yet, the notice owns
// the page and says the server is unreachable.
const connectionNotice = createConnectionNotice({
  mode: 'present',
  blocking: () => player === null,
});

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?deck=${encodeURIComponent(deckId)}`;
const name = localStorage.getItem('collab-name');
const bridge = new CollabBridge(wsUrl, name ? `${name} (presenting)` : 'Presenting', {
  onWelcome: (welcome) => {
    document.title = `${agentViewer ? 'Agent viewer' : 'Presenting'} — ${welcome.deck.title}`;
    startPlayer(welcome.deck, welcome.themeCss, 'session');
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
  onConnectionChange: (isConnected) => {
    if (isConnected) connectionNotice.hide();
    else connectionNotice.showDisconnected();
  },
  onEnded: () => connectionNotice.showEnded('The host ended this presentation.'),
});

bridge.connect();
