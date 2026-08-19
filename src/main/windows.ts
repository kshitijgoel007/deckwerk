import { join } from 'node:path';
import { BrowserWindow, screen } from 'electron';
import { chooseAudienceDisplay, chooseDisplayById } from './presentationDisplays.js';

/**
 * Window creation. Three kinds: the editor, the fullscreen present window and
 * the video trim window.
 *
 * electron-vite serves the renderer from a dev server while developing and from
 * built files otherwise; `ELECTRON_RENDERER_URL` is how it signals which.
 */

const preload = () => join(import.meta.dirname, '../preload/index.mjs');

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

export function createEditorWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#1c1c1e',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  loadRenderer(win, 'editor');
  return win;
}

/**
 * The host's window while collaborating: the same browser collab client the
 * joiners use, served over localhost. Deliberately NO preload — the collab
 * client installs its own network-backed `window.api`, which the context
 * bridge would otherwise make read-only.
 */
export function createCollabHostWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#1c1c1e',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.once('ready-to-show', () => win.show());
  void win.loadURL(url);
  return win;
}

/**
 * Fullscreen presentation. Prefers an external display when one is attached,
 * which is the normal case at a talk, and keeps the editor usable behind it.
 */
export function createPresentWindow(cursorSlide = 0, displayId?: number): BrowserWindow {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const target = chooseDisplayById(displays, displayId, chooseAudienceDisplay(displays, primary));

  const win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    backgroundColor: '#000000',
    fullscreen: true,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Videos must start on their own when a slide appears; without this the
      // whole autoplay model would depend on a click per slide.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.once('ready-to-show', () => win.show());
  loadRenderer(win, 'present', `?slide=${cursorSlide}`);
  return win;
}

/** Laptop control surface; the audience window remains fullscreen externally. */
export function createPresenterWindow(displayId?: number): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const target = chooseDisplayById(screen.getAllDisplays(), displayId, primary);
  const win = new BrowserWindow({
    x: target.workArea.x + 40,
    y: target.workArea.y + 40,
    width: Math.min(1200, target.workArea.width - 80),
    height: Math.min(820, target.workArea.height - 80),
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#111218',
    title: 'Presenter View',
    show: false,
    webPreferences: {
      preload: preload(), contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  loadRenderer(win, 'presenter');
  return win;
}

/** Hidden document that lays every requested slide state out as print pages. */
export function createPdfWindow(query: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 540,
    show: false,
    backgroundColor: '#000000',
    webPreferences: {
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
    backgroundColor: '#1c1c1e',
    title: 'Trim & Crop',
    show: false,
    webPreferences: {
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.once('ready-to-show', () => win.show());
  loadRenderer(win, 'trim');
  return win;
}
