import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNRESPONSIVE_GRACE_MS, attachRendererHealth, type RendererHealthDeps } from '../src/main/windowHealth.js';

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }));

/**
 * The recovery handlers for a hung or crashed editor renderer. A real
 * deadlock is not something a unit test can stage, so the window is a fake
 * that emits the events Electron would, and the assertions are about what
 * gets done to it: when a dialog is shown, and whether the renderer is
 * crashed-then-reloaded, reloaded, or the window closed.
 */

type Listener = (...args: unknown[]) => void;

function fakeWindow() {
  const windowListeners = new Map<string, Listener>();
  const contentsListeners = new Map<string, Listener>();
  const win = {
    destroyed: false,
    isDestroyed: () => win.destroyed,
    getTitle: () => 'X-Reason',
    close: vi.fn(),
    on: (event: string, listener: Listener) => windowListeners.set(event, listener),
    webContents: {
      forcefullyCrashRenderer: vi.fn(),
      reload: vi.fn(),
      on: (event: string, listener: Listener) => contentsListeners.set(event, listener),
    },
    emit: (event: string, ...args: unknown[]) => windowListeners.get(event)?.(...args),
    emitContents: (event: string, ...args: unknown[]) => contentsListeners.get(event)?.(...args),
  };
  return win;
}

function deps(answer: number): RendererHealthDeps & { shown: MessageBoxOptions[] } {
  const shown: MessageBoxOptions[] = [];
  return {
    shown,
    showMessageBox: async (_win, options) => {
      shown.push(options);
      return { response: answer };
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    log: () => {},
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  delete process.env['DECKWERK_TEST_RENDERER_RECOVERY'];
});

describe('renderer health', () => {
  it('waits out a short stall without bothering the author', async () => {
    const win = fakeWindow();
    const d = deps(0);
    attachRendererHealth(win as unknown as BrowserWindow, d);

    win.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(UNRESPONSIVE_GRACE_MS / 2);
    win.emit('responsive');
    await vi.advanceTimersByTimeAsync(UNRESPONSIVE_GRACE_MS * 2);

    expect(d.shown).toEqual([]);
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it('offers a reload once a hang outlasts the grace period, crashing the stuck renderer first', async () => {
    const win = fakeWindow();
    const d = deps(0);
    attachRendererHealth(win as unknown as BrowserWindow, d);

    win.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(UNRESPONSIVE_GRACE_MS + 1);
    await flush();

    expect(d.shown).toHaveLength(1);
    expect(d.shown[0].buttons).toEqual(['Reload', 'Wait']);
    // Order matters: a plain reload never reaches a deadlocked renderer.
    const crash = win.webContents.forcefullyCrashRenderer.mock.invocationCallOrder[0];
    const reload = win.webContents.reload.mock.invocationCallOrder[0];
    expect(crash).toBeLessThan(reload);

    // The crash we caused is not reported as a second failure.
    win.emitContents('render-process-gone', {}, { reason: 'killed', exitCode: 9 });
    await flush();
    expect(d.shown).toHaveLength(1);
  });

  it('lets the author keep waiting', async () => {
    const win = fakeWindow();
    const d = deps(1);
    attachRendererHealth(win as unknown as BrowserWindow, d);

    win.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(UNRESPONSIVE_GRACE_MS + 1);
    await flush();

    expect(d.shown).toHaveLength(1);
    expect(win.webContents.reload).not.toHaveBeenCalled();
    expect(win.close).not.toHaveBeenCalled();
  });

  it('reloads a crashed renderer on request and closes the window otherwise', async () => {
    const reloadWin = fakeWindow();
    const reloadDeps = deps(0);
    attachRendererHealth(reloadWin as unknown as BrowserWindow, reloadDeps);
    reloadWin.emitContents('render-process-gone', {}, { reason: 'oom', exitCode: 1 });
    await flush();
    expect(reloadDeps.shown[0].buttons).toEqual(['Reload', 'Close window']);
    expect(reloadDeps.shown[0].detail).toContain('oom');
    expect(reloadWin.webContents.reload).toHaveBeenCalledTimes(1);
    expect(reloadWin.webContents.forcefullyCrashRenderer).not.toHaveBeenCalled();

    const closeWin = fakeWindow();
    const closeDeps = deps(1);
    attachRendererHealth(closeWin as unknown as BrowserWindow, closeDeps);
    closeWin.emitContents('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await flush();
    expect(closeWin.close).toHaveBeenCalledTimes(1);
    expect(closeWin.webContents.reload).not.toHaveBeenCalled();
  });

  it('ignores a clean exit, which is what closing the window looks like', async () => {
    const win = fakeWindow();
    const d = deps(0);
    attachRendererHealth(win as unknown as BrowserWindow, d);
    win.emitContents('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    await flush();
    expect(d.shown).toEqual([]);
  });

  it('takes a scripted answer so integration tests never see a native panel', async () => {
    process.env['DECKWERK_TEST_RENDERER_RECOVERY'] = 'reload';
    const win = fakeWindow();
    const d = deps(1);
    attachRendererHealth(win as unknown as BrowserWindow, d);
    win.emitContents('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await flush();
    expect(d.shown).toEqual([]);
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
  });
});
