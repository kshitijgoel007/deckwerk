import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeEndCollaborationPopover,
  openEndCollaborationPopover,
} from '../src/renderer/collab/endCollaborationPopover.js';

describe('end collaboration confirmation', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><body><button id="end">End collaboration</button></body>', {
      pretendToBeVisual: true,
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      Node: dom.window.Node,
      HTMLElement: dom.window.HTMLElement,
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
  });

  afterEach(() => closeEndCollaborationPopover());

  it('opens a red alert dialog directly below its toolbar button', () => {
    const anchor = document.getElementById('end') as HTMLButtonElement;
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
      x: 800, y: 10, left: 800, top: 10, right: 940, bottom: 40,
      width: 140, height: 30, toJSON: () => ({}),
    });
    openEndCollaborationPopover(anchor, vi.fn());

    const popover = document.getElementById('end-collaboration-popover')!;
    expect(popover.getAttribute('role')).toBe('alertdialog');
    expect(popover.style.top).toBe('46px');
    expect(popover.textContent).toContain('Everyone will be disconnected');
    expect(popover.querySelector('.end-collaboration-confirm')?.textContent).toBe('End collaboration');
    expect(anchor.getAttribute('aria-expanded')).toBe('true');
  });

  it('requires the explicit red action and lets Cancel dismiss safely', () => {
    const anchor = document.getElementById('end') as HTMLButtonElement;
    const confirm = vi.fn();
    openEndCollaborationPopover(anchor, confirm);
    document.querySelector<HTMLButtonElement>('.end-collaboration-cancel')!.click();
    expect(confirm).not.toHaveBeenCalled();
    expect(document.getElementById('end-collaboration-popover')).toBeNull();

    openEndCollaborationPopover(anchor, confirm);
    document.querySelector<HTMLButtonElement>('.end-collaboration-confirm')!.click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(document.getElementById('end-collaboration-popover')).toBeNull();
  });
});
