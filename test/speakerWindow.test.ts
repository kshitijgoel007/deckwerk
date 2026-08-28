import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPresentWindow,
  createPresenterWindow,
  showSpeakerWindowAboveFullscreen,
} from '../src/main/windows.js';

const electron = vi.hoisted(() => ({
  created: [] as Array<{
    options: Record<string, unknown>;
    ready: () => void;
    window: { show: ReturnType<typeof vi.fn>; setFullScreen: ReturnType<typeof vi.fn> };
  }>,
  display: {
    id: 7,
    bounds: { x: 120, y: 40, width: 1920, height: 1080 },
    workArea: { x: 120, y: 64, width: 1920, height: 1056 },
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: class {
    once = vi.fn((event: string, listener: () => void) => {
      if (event === 'ready-to-show') electron.created.at(-1)!.ready = listener;
    });
    show = vi.fn();
    focus = vi.fn();
    setFullScreen = vi.fn();
    setAlwaysOnTop = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    loadFile = vi.fn();
    loadURL = vi.fn();
    webContents = { setWindowOpenHandler: vi.fn() };

    constructor(options: Record<string, unknown>) {
      electron.created.push({ options, ready: () => {}, window: this });
    }
  },
  screen: {
    getPrimaryDisplay: () => electron.display,
    getAllDisplays: () => [electron.display],
  },
}));

describe('Speaker View window visibility', () => {
  beforeEach(() => electron.created.splice(0));

  it('fills its assigned display like the audience presentation', () => {
    createPresenterWindow(electron.display.id);

    expect(electron.created[0].options).toMatchObject({
      x: electron.display.bounds.x,
      y: electron.display.bounds.y,
      width: electron.display.bounds.width,
      height: electron.display.bounds.height,
      fullscreen: true,
      autoHideMenuBar: true,
    });

    electron.created[0].ready();
    expect(electron.created[0].window.show).toHaveBeenCalledOnce();
    expect(electron.created[0].window.setFullScreen).toHaveBeenCalledWith(true);
  });

  it('opens one-display Speaker View directly without flashing the audience view', () => {
    createPresentWindow(0, electron.display.id, undefined, false);
    createPresenterWindow(electron.display.id);

    const [audience, speaker] = electron.created;
    audience.ready();
    expect(audience.options.fullscreen).toBe(false);
    expect(audience.window.show).not.toHaveBeenCalled();
    expect(audience.window.setFullScreen).not.toHaveBeenCalled();

    speaker.ready();
    expect(speaker.window.show).toHaveBeenCalledOnce();
    expect(speaker.window.setFullScreen).toHaveBeenCalledWith(true);
  });

  it('makes Speaker View visible above a fullscreen audience window', () => {
    const win = {
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      show: vi.fn(),
      setFullScreen: vi.fn(),
      focus: vi.fn(),
    } as unknown as BrowserWindow;

    showSpeakerWindowAboveFullscreen(win);

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(
      true,
      { visibleOnFullScreen: true },
    );
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.setFullScreen).toHaveBeenCalledWith(true);
    expect(win.focus).toHaveBeenCalledOnce();
  });
});
