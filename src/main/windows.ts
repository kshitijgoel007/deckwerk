import { join } from 'node:path';
import { BrowserWindow, screen, shell } from 'electron';
import type { Rectangle } from 'electron';
import { chooseAudienceDisplay, chooseDisplayById } from './presentationDisplays.js';

/**
 * Window creation. Three kinds: the editor, the fullscreen present window and
 * the video trim window.
 *
 * electron-vite serves the renderer from a dev server while developing and from
 * built files otherwise; `ELECTRON_RENDERER_URL` is how it signals which.
 */

const preload = () => join(import.meta.dirname, '../preload/index.mjs');
const APP_BACKGROUND = '#16161e';
const HEADLESS_TEST = process.env['DECKWERK_HEADLESS_TEST'] === '1';

export interface WindowContinuityState {
  bounds: Rectangle;
  maximized: boolean;
  fullScreen: boolean;
}

export function captureWindowContinuity(win: BrowserWindow): WindowContinuityState {
  const maximized = win.isMaximized();
  const fullScreen = win.isFullScreen();
  return {
    // Retain the window's restore geometry too: getBounds() while maximized
    // would make a later unmaximize fill the entire screen.
    bounds: maximized || fullScreen ? win.getNormalBounds() : win.getBounds(),
    maximized,
    fullScreen,
  };
}

function continuityOptions(state?: WindowContinuityState): Partial<Rectangle> {
  return state?.bounds ?? {};
}

/**
 * Where a second presentation's window goes: the same size as the window it
 * was opened from, stepped down and to the right so both are visible at once
 * and neither hides the other's title bar. Kept on the source window's display
 * and inside its work area, so a cascade near a screen edge does not walk a
 * window off it.
 */
export function cascadedEditorBounds(source: BrowserWindow): WindowContinuityState {
  const from = captureWindowContinuity(source);
  const step = 32;
  const area = screen.getDisplayMatching(from.bounds).workArea;
  const width = Math.min(from.bounds.width, area.width);
  const height = Math.min(from.bounds.height, area.height);
  return {
    bounds: {
      x: Math.min(from.bounds.x + step, area.x + area.width - width),
      y: Math.min(from.bounds.y + step, area.y + area.height - height),
      width,
      height,
    },
    // A cascade is only meaningful as an ordinary window: inheriting maximized
    // or fullscreen would put the new document exactly on top of the old one.
    maximized: false,
    fullScreen: false,
  };
}

function showWindow(win: BrowserWindow, state?: WindowContinuityState): void {
  // Production-browser integration tests drive windows through CDP. Keeping
  // them hidden prevents a successful test cleanup from looking like the
  // user's real DeckWerk app opened and then crashed.
  if (HEADLESS_TEST) return;
  if (state?.fullScreen) win.setFullScreen(true);
  else if (state?.maximized) win.maximize();
  win.show();
}

function revealWindow(win: BrowserWindow, state?: WindowContinuityState): void {
  win.once('ready-to-show', () => {
    showWindow(win, state);
  });
}

/** Reveal a window whose application-level readiness was checked elsewhere. */
export function revealReadyWindow(win: BrowserWindow, state?: WindowContinuityState): void {
  showWindow(win, state);
}

function loadRenderer(win: BrowserWindow, name: string, query = ''): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(`${devUrl}/${name}/index.html${query}`);
  } else {
    void win.loadFile(join(import.meta.dirname, `../renderer/${name}/index.html`), {
      search: query.replace(/^\?/, ''),
    });
  }
}

/** Send target=_blank web links to the user's browser, never a child app window. */
function openWebLinksExternally(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol;
      if (protocol === 'http:' || protocol === 'https:') {
        void shell.openExternal(url).catch(() => {});
      }
    } catch {
      // Invalid and non-web targets stay closed.
    }
    return { action: 'deny' };
  });
}

/**
 * Showing a hidden BrowserWindow does not reliably finish its constructor-time
 * fullscreen transition on macOS when another window is entering fullscreen at
 * the same time. Reassert the state after the window is ready and visible.
 */
function showFullscreenWindow(win: BrowserWindow): void {
  if (HEADLESS_TEST) return;
  win.show();
  win.setFullScreen(true);
}

export function createEditorWindow(query = '', state?: WindowContinuityState): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    ...continuityOptions(state),
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: APP_BACKGROUND,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      backgroundThrottling: !HEADLESS_TEST,
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  openWebLinksExternally(win);
  revealWindow(win, state);
  loadRenderer(win, 'editor', query);
  return win;
}

/**
 * The host's window while collaborating: the same browser collab client the
 * joiners use, served over localhost. Deliberately NO preload — the collab
 * client installs its own network-backed `window.api`, which the context
 * bridge would otherwise make read-only.
 */
export function createCollabHostWindow(url: string, state?: WindowContinuityState): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    ...continuityOptions(state),
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: APP_BACKGROUND,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      backgroundThrottling: !HEADLESS_TEST,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // Unlike a static editor window, the collaboration shell is not usable when
  // its HTML first paints: it still has to connect its WebSocket and receive
  // the authoritative deck. The main process reveals it only after that
  // application-level readiness handshake succeeds.
  void win.loadURL(url);
  return win;
}

/**
 * Fullscreen presentation. Prefers an external display when one is attached,
 * which is the normal case at a talk, and keeps the editor usable behind it.
 */
export function createPresentWindow(
  cursorSlide = 0,
  displayId?: number,
  endSlideIndex?: number,
  visible = true,
): BrowserWindow {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const target = chooseDisplayById(displays, displayId, chooseAudienceDisplay(displays, primary));

  const win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    backgroundColor: '#000000',
    fullscreen: visible,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      backgroundThrottling: !HEADLESS_TEST,
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Videos must start on their own when a slide appears; without this the
      // whole autoplay model would depend on a click per slide.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  openWebLinksExternally(win);
  if (visible) win.once('ready-to-show', () => showFullscreenWindow(win));
  const query = new URLSearchParams({ slide: String(cursorSlide) });
  if (endSlideIndex !== undefined) query.set('endSlide', String(endSlideIndex));
  loadRenderer(win, 'present', `?${query.toString()}`);
  return win;
}

/** Fullscreen control surface; the audience window remains fullscreen separately. */
export function createPresenterWindow(
  displayId?: number,
  visibleAboveFullscreen = false,
): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const target = chooseDisplayById(screen.getAllDisplays(), displayId, primary);
  const win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: APP_BACKGROUND,
    title: 'Speaker View',
    show: false,
    webPreferences: {
      backgroundThrottling: !HEADLESS_TEST,
      preload: preload(), contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.once('ready-to-show', () => {
    if (visibleAboveFullscreen) showSpeakerWindowAboveFullscreen(win);
    else showFullscreenWindow(win);
  });
  loadRenderer(win, 'presenter');
  return win;
}

/**
 * Keep Speaker View reachable when it has to share a display with the
 * fullscreen audience window. On macOS, fullscreen windows live in their own
 * Space, so always-on-top alone is not enough to make the second window
 * visible there. The workspace setting is a no-op on Windows.
 */
export function showSpeakerWindowAboveFullscreen(win: BrowserWindow): void {
  if (HEADLESS_TEST) return;
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  showFullscreenWindow(win);
  win.focus();
}

/** Hidden document that lays every requested slide state out as print pages. */
export function createPdfWindow(query: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 540,
    show: false,
    backgroundColor: '#000000',
    webPreferences: {
      backgroundThrottling: !HEADLESS_TEST,
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  loadRenderer(win, 'print', query);
  return win;
}

export function createTrimWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 800,
    minHeight: 640,
    backgroundColor: APP_BACKGROUND,
    title: 'Trim & Crop',
    show: false,
    webPreferences: {
      backgroundThrottling: !HEADLESS_TEST,
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.once('ready-to-show', () => { if (!HEADLESS_TEST) win.show(); });
  loadRenderer(win, 'trim');
  return win;
}

/** Destructive pixel editor. Like trim, it writes a derived asset on Apply. */
export function createRasterWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 760,
    minHeight: 580,
    backgroundColor: APP_BACKGROUND,
    title: 'Raster Paint',
    show: false,
    webPreferences: {
      backgroundThrottling: !HEADLESS_TEST,
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.once('ready-to-show', () => { if (!HEADLESS_TEST) win.show(); });
  loadRenderer(win, 'raster');
  return win;
}
