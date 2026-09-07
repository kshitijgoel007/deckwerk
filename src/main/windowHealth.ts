import { dialog } from 'electron';
import type { BrowserWindow, MessageBoxOptions, RenderProcessGoneDetails } from 'electron';

/**
 * Recovery for an editor window whose renderer has hung or died.
 *
 * Electron does nothing on its own in either case: a renderer that deadlocks
 * keeps painting its last frame while ignoring every click, and one that
 * crashes leaves a blank window. Both looked like "the app crashed" to the
 * author of the X-Reason deck (Sept 2026) — the renderer had deadlocked inside
 * Chromium's media pipeline — and the only way out was to force-quit the whole
 * app, satellite windows and all. These handlers turn that into a dialog on
 * the affected window with a reload button.
 *
 * Deck state lives in the main process (`DeckWindowState.session`), so a
 * reload re-requests the open deck and comes back where it was; nothing that
 * had been saved is lost. Edits the renderer had not yet flushed are gone in
 * either case, hung or crashed, and the dialog says so.
 */

/** How long a renderer may stay unresponsive before the author is asked. */
export const UNRESPONSIVE_GRACE_MS = 8_000;

export interface RendererHealthDeps {
  showMessageBox: (win: BrowserWindow, options: MessageBoxOptions) => Promise<{ response: number }>;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  log: (message: string) => void;
}

const defaultDeps: RendererHealthDeps = {
  showMessageBox: (win, options) => dialog.showMessageBox(win, options),
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  log: (message) => console.error(message),
};

/**
 * A scripted answer for integration tests, which cannot click a native
 * dialog: `reload` or `dismiss` skips the panel and takes that action.
 */
function scriptedAnswer(): 'reload' | 'dismiss' | null {
  const value = process.env['DECKWERK_TEST_RENDERER_RECOVERY'];
  return value === 'reload' || value === 'dismiss' ? value : null;
}

/** Restart the renderer of a window that may be hung, crashed, or fine. */
function reloadRenderer(win: BrowserWindow, hung: boolean): void {
  if (win.isDestroyed()) return;
  // A deadlocked renderer never processes the navigation a plain reload
  // sends it; crashing it first is what Electron documents for this case.
  if (hung) win.webContents.forcefullyCrashRenderer();
  win.webContents.reload();
}

export function attachRendererHealth(win: BrowserWindow, deps: RendererHealthDeps = defaultDeps): void {
  let hangTimer: ReturnType<typeof setTimeout> | null = null;
  let asking = false;
  /** Set once we reload a hung renderer on purpose, so the crash it causes is not reported. */
  let expectedCrash = false;

  /** Button 0 is always the reload; `onDismiss` is what the other button does. */
  const ask = async (options: MessageBoxOptions, onReload: () => void, onDismiss: () => void): Promise<void> => {
    if (asking || win.isDestroyed()) return;
    asking = true;
    try {
      const scripted = scriptedAnswer();
      const choice = scripted ?? ((await deps.showMessageBox(win, options)).response === 0 ? 'reload' : 'dismiss');
      if (win.isDestroyed()) return;
      if (choice === 'reload') onReload();
      else onDismiss();
    } finally {
      asking = false;
    }
  };

  win.on('unresponsive', () => {
    if (hangTimer !== null || asking) return;
    // Heavy work — a large paste, a long import — can stall the renderer for
    // a moment without anything being wrong. Only a hang that outlasts the
    // grace period earns a dialog.
    hangTimer = deps.setTimeout(() => {
      hangTimer = null;
      deps.log(`Editor renderer unresponsive for ${UNRESPONSIVE_GRACE_MS} ms: ${win.getTitle()}`);
      void ask(
        {
          type: 'warning',
          title: 'DeckWerk is not responding',
          message: 'This deck window has stopped responding.',
          detail: 'Everything saved so far is safe on disk. Reloading restarts the editor for this deck; edits made in the last few seconds may be lost.',
          buttons: ['Reload', 'Wait'],
          defaultId: 0,
          cancelId: 1,
        },
        () => {
          expectedCrash = true;
          reloadRenderer(win, true);
        },
        // "Wait": keep the window; a further hang will ask again.
        () => {},
      );
    }, UNRESPONSIVE_GRACE_MS);
  });

  win.on('responsive', () => {
    if (hangTimer !== null) {
      deps.clearTimeout(hangTimer);
      hangTimer = null;
    }
  });

  win.webContents.on('render-process-gone', (_event, details: RenderProcessGoneDetails) => {
    if (details.reason === 'clean-exit') return;
    if (expectedCrash) {
      expectedCrash = false;
      return;
    }
    deps.log(`Editor renderer gone (${details.reason}, exit code ${details.exitCode}): ${win.getTitle()}`);
    void ask(
      {
        type: 'error',
        title: 'DeckWerk stopped',
        message: 'The editor for this deck stopped unexpectedly.',
        detail: `Reason: ${details.reason}. Everything saved so far is safe on disk. Reload to reopen the deck in this window.`,
        buttons: ['Reload', 'Close window'],
        defaultId: 0,
        cancelId: 1,
      },
      () => reloadRenderer(win, false),
      () => win.close(),
    );
  });
}
