// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  contextMenuPlacement,
  openContextMenu,
} from '../src/renderer/editor/contextMenuPlacement.js';

/**
 * The right-click menu stays on screen. Reported: opened near the bottom of a
 * small Mac screen, its last rows were cut off and could not be clicked.
 */
describe('context menu placement', () => {
  const viewport = { width: 1280, height: 720 };
  const menu = { width: 200, height: 300 };

  it('opens at the pointer when there is room', () => {
    expect(contextMenuPlacement({ x: 100, y: 100 }, menu, viewport)).toEqual({ left: 100, top: 100 });
  });

  it('opens upwards from a pointer near the bottom edge', () => {
    const placed = contextMenuPlacement({ x: 100, y: 600 }, menu, viewport);
    expect(placed).toEqual({ left: 100, top: 300 });
    expect(placed.top + menu.height).toBeLessThanOrEqual(viewport.height);
  });

  it('opens leftwards from a pointer near the right edge', () => {
    const placed = contextMenuPlacement({ x: 1200, y: 100 }, menu, viewport);
    expect(placed).toEqual({ left: 1000, top: 100 });
  });

  it('pins a menu taller than the space on either side to the edge', () => {
    const tall = { width: 200, height: 700 };
    const placed = contextMenuPlacement({ x: 100, y: 400 }, tall, viewport);
    expect(placed.top).toBe(720 - 700 - 4);
    expect(placed.top + tall.height).toBeLessThanOrEqual(viewport.height);
    const short = { width: 200, height: 100 };
    expect(contextMenuPlacement({ x: 100, y: 719 }, short, viewport).top).toBe(720 - 100 - 4);
  });

  it('never places the menu off the top or left edge', () => {
    const placed = contextMenuPlacement({ x: 2, y: 2 }, menu, viewport);
    expect(placed.left).toBeGreaterThanOrEqual(4);
    expect(placed.top).toBeGreaterThanOrEqual(4);
  });

  it('measures the attached menu and moves it on screen', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    const menu = document.createElement('div');
    menu.id = 'ctx-menu';
    menu.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 150, bottom: 250, width: 150, height: 250, toJSON: () => ({}),
    }) as DOMRect;
    openContextMenu(menu, { x: 700, y: 500 });
    expect(menu.isConnected).toBe(true);
    expect(menu.style.left).toBe('550px');
    expect(menu.style.top).toBe('250px');
    menu.remove();
  });
});
