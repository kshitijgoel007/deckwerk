import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import WebSocket from 'ws';

/**
 * Shared plumbing for the production-browser tests: launch a hidden Electron
 * window on a real HTTP origin, attach to it over the DevTools protocol, and
 * drive it with genuine input events.
 *
 * `evaluate` is for reading state and for setup the UI has no control for.
 * `click`, `typeInto`, and `choose` go through `Input.dispatch*`, so the browser
 * itself does hit-testing, focus, and event dispatch — a control hidden behind
 * an overlay, sized to nothing, or never wired up cannot pass.
 */

/** The Electron binary, or `''` when the install has no downloaded binary. */
export const electronBinary = (() => {
  try {
    const path = createRequire(import.meta.url)('electron') as unknown;
    return typeof path === 'string' && existsSync(path) ? path : '';
  } catch {
    return '';
  }
})();

export interface DevToolsTarget {
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** A point in viewport coordinates plus the box it came from. */
interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class Cdp {
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();

  private constructor(private socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.on('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('Electron DevTools connection closed'));
      }
      this.pending.clear();
    });
  }

  static async connect(webSocketDebuggerUrl: string): Promise<Cdp> {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const cdp = new Cdp(socket);
    await cdp.call('Runtime.enable');
    return cdp;
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'renderer evaluation failed';
      throw new Error(detail);
    }
    return result.result?.value as T;
  }

  /**
   * Scroll a selector into view and report the visible box the mouse can hit.
   * A control that is missing, zero-sized, or scrolled outside the viewport is
   * reported as such rather than silently clicked at (0, 0).
   */
  private async boxOf(selector: string, label: string): Promise<ElementBox> {
    const box = await this.evaluate<ElementBox | { error: string }>(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { error: 'no element matches' };
      node.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { error: 'element has no size' };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
        return { error: 'element centre is outside the viewport' };
      }
      const hit = document.elementFromPoint(x, y);
      if (hit !== node && !node.contains(hit)) {
        return { error: 'another element covers it: ' + (hit?.className || hit?.tagName) };
      }
      return { x, y, width: rect.width, height: rect.height };
    })()`);
    if ('error' in box) throw new Error(`cannot click ${label}: ${box.error} (${selector})`);
    return box;
  }

  /** A real left click at the centre of the first node matching `selector`. */
  async click(selector: string, label = selector): Promise<void> {
    const box = await this.boxOf(selector, label);
    await this.mouse('mouseMoved', box.x, box.y, 0);
    await this.mouse('mousePressed', box.x, box.y, 1);
    await this.mouse('mouseReleased', box.x, box.y, 1);
  }

  /** A real left click at a point inside the matching node, given as 0..1. */
  async clickWithin(
    selector: string,
    fractionX: number,
    fractionY: number,
    label = selector,
  ): Promise<void> {
    const box = await this.boxOf(selector, label);
    const x = box.x + (fractionX - 0.5) * box.width;
    const y = box.y + (fractionY - 0.5) * box.height;
    await this.mouse('mouseMoved', x, y, 0);
    await this.mouse('mousePressed', x, y, 1);
    await this.mouse('mouseReleased', x, y, 1);
  }

  /** Click near the leading edge of a rendered character at a text offset. */
  async clickTextAtOffset(
    selector: string,
    offset: number,
    label = selector,
  ): Promise<void> {
    const point = await this.evaluate<{ x: number; y: number } | { error: string }>(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return { error: 'no element matches' };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let remaining = ${JSON.stringify(offset)};
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (remaining >= node.data.length) {
          remaining -= node.data.length;
          continue;
        }
        const range = document.createRange();
        range.setStart(node, remaining);
        range.setEnd(node, Math.min(node.data.length, remaining + 1));
        const rect = range.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return { error: 'character has no rendered box' };
        return { x: rect.left + rect.width * 0.2, y: rect.top + rect.height / 2 };
      }
      return { error: 'offset is outside rendered text' };
    })()`);
    if ('error' in point) throw new Error(`cannot click ${label}: ${point.error}`);
    await this.mouse('mouseMoved', point.x, point.y, 0);
    await this.mouse('mousePressed', point.x, point.y, 1);
    await this.mouse('mouseReleased', point.x, point.y, 1);
  }

  private mouse(type: string, x: number, y: number, clickCount: number): Promise<void> {
    return this.call('Input.dispatchMouseEvent', {
      type, x, y, clickCount, button: clickCount ? 'left' : 'none', buttons: 0,
    });
  }

  /**
   * Focus a text field by clicking it, replace what is there, and commit with
   * Enter — the keypress an editor number or hex field waits for.
   *
   * The text itself goes in through `Input.insertText` rather than synthesised
   * key codes: it is the browser's own IME insertion path, so the field gets a
   * real `input` event on a really focused node, and no per-character key code
   * table stands between the test and the control.
   */
  async typeInto(selector: string, value: string, label = selector): Promise<void> {
    await this.click(selector, label);
    const focused = await this.evaluate<boolean>(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (document.activeElement !== node) return false;
      node.select?.();
      return true;
    })()`);
    if (!focused) throw new Error(`clicking ${label} did not focus it (${selector})`);
    if (value === '') await this.key('Delete', 46);
    else await this.call('Input.insertText', { text: value });
    const typed = await this.evaluate<string>(
      `document.querySelector(${JSON.stringify(selector)}).value`);
    if (typed !== value) {
      throw new Error(`typing into ${label} left ${JSON.stringify(typed)}, not ${JSON.stringify(value)}`);
    }
    await this.key('Enter', 13);
    // Enter commits some fields; Tab commits the rest by moving focus, which is
    // the other way an author leaves a box. Both are real key events.
    await this.key('Tab', 9);
  }

  async key(key: string, windowsVirtualKeyCode: number): Promise<void> {
    const text = key === 'Enter' ? '\r' : key === 'Tab' ? '\t' : undefined;
    for (const type of ['keyDown', 'keyUp']) {
      await this.call('Input.dispatchKeyEvent', {
        type,
        key,
        code: key,
        text: type === 'keyDown' ? text : undefined,
        windowsVirtualKeyCode,
        nativeVirtualKeyCode: windowsVirtualKeyCode,
      });
    }
  }

  /** Dispatch a real modified key chord (Ctrl/Meta/Shift/Alt bitmask from CDP). */
  async chord(
    key: string,
    code: string,
    windowsVirtualKeyCode: number,
    modifiers: number,
  ): Promise<void> {
    for (const type of ['keyDown', 'keyUp']) {
      await this.call('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        modifiers,
        windowsVirtualKeyCode,
        nativeVirtualKeyCode: windowsVirtualKeyCode,
      });
    }
  }

  /** A real double-click at the centre of a visible node. */
  async doubleClick(selector: string, label = selector): Promise<void> {
    const box = await this.boxOf(selector, label);
    await this.mouse('mouseMoved', box.x, box.y, 0);
    await this.mouse('mousePressed', box.x, box.y, 1);
    await this.mouse('mouseReleased', box.x, box.y, 1);
    await this.mouse('mousePressed', box.x, box.y, 2);
    await this.mouse('mouseReleased', box.x, box.y, 2);
  }

  /** Double-click the first rendered word in a node, using its glyph box. */
  async doubleClickText(selector: string, label = selector): Promise<void> {
    const point = await this.evaluate<{ x: number; y: number } | { error: string }>(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return { error: 'no element matches' };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const offset = node.data.search(/\\S/);
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, Math.min(node.data.length, offset + 1));
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      return { error: 'node has no rendered text' };
    })()`);
    if ('error' in point) throw new Error(`cannot double-click ${label}: ${point.error}`);
    await this.mouse('mouseMoved', point.x, point.y, 0);
    await this.mouse('mousePressed', point.x, point.y, 1);
    await this.mouse('mouseReleased', point.x, point.y, 1);
    await this.mouse('mousePressed', point.x, point.y, 2);
    await this.mouse('mouseReleased', point.x, point.y, 2);
  }

  /** Select all rendered text in a node by dragging from its first to last glyph. */
  async dragSelectText(selector: string, label = selector): Promise<void> {
    const points = await this.evaluate<{
      start: { x: number; y: number };
      end: { x: number; y: number };
    } | { error: string }>(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return { error: 'no element matches' };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const texts = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.data.length) texts.push(node);
      }
      if (!texts.length) return { error: 'node has no text' };
      const first = document.createRange();
      first.setStart(texts[0], 0);
      first.setEnd(texts[0], Math.min(1, texts[0].data.length));
      const lastText = texts[texts.length - 1];
      const last = document.createRange();
      last.setStart(lastText, Math.max(0, lastText.data.length - 1));
      last.setEnd(lastText, lastText.data.length);
      const a = first.getBoundingClientRect();
      const b = last.getBoundingClientRect();
      return {
        start: { x: a.left + 1, y: a.top + a.height / 2 },
        end: { x: b.right - 1, y: b.top + b.height / 2 }
      };
    })()`);
    if ('error' in points) throw new Error(`cannot select ${label}: ${points.error}`);
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: points.start.x, y: points.start.y, button: 'none', buttons: 0,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: points.start.x, y: points.start.y,
      button: 'left', buttons: 1, clickCount: 1,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: points.end.x, y: points.end.y,
      button: 'left', buttons: 1,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: points.end.x, y: points.end.y,
      button: 'left', buttons: 0, clickCount: 1,
    });
  }

  /** Select the first rendered word with a real pointer drag. */
  async dragSelectFirstWord(selector: string, label = selector): Promise<void> {
    const points = await this.evaluate<{
      start: { x: number; y: number };
      end: { x: number; y: number };
    } | { error: string }>(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return { error: 'no element matches' };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const match = /\\S+/.exec(node.data);
        if (!match) continue;
        const first = document.createRange();
        first.setStart(node, match.index);
        first.setEnd(node, match.index + 1);
        const last = document.createRange();
        last.setStart(node, match.index + match[0].length - 1);
        last.setEnd(node, match.index + match[0].length);
        const a = first.getBoundingClientRect();
        const b = last.getBoundingClientRect();
        return {
          start: { x: a.left + 1, y: a.top + a.height / 2 },
          end: { x: b.right - 1, y: b.top + b.height / 2 }
        };
      }
      return { error: 'node has no rendered word' };
    })()`);
    if ('error' in points) throw new Error(`cannot select ${label}: ${points.error}`);
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: points.start.x, y: points.start.y, button: 'none', buttons: 0,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: points.start.x, y: points.start.y,
      button: 'left', buttons: 1, clickCount: 1,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: points.end.x, y: points.end.y,
      button: 'left', buttons: 1,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: points.end.x, y: points.end.y,
      button: 'left', buttons: 0, clickCount: 1,
    });
  }

  /**
   * Choose a `<select>` option. Native dropdowns render outside the page, so
   * the browser's own change event is the closest faithful stand-in for the
   * click; the assertion still proves the listener is wired.
   */
  async choose(selector: string, value: string, label = selector): Promise<void> {
    const ok = await this.evaluate<boolean>(`(() => {
      const select = document.querySelector(${JSON.stringify(selector)});
      if (!select) return false;
      if (![...select.options].some((option) => option.value === ${JSON.stringify(value)})) {
        return false;
      }
      select.focus();
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`cannot choose ${JSON.stringify(value)} in ${label} (${selector})`);
  }

  close(): void {
    this.socket.close();
  }
}

export interface RunningBrowser {
  process: ChildProcess;
  debugPort: number;
  log: () => string;
}

/** Launch the hidden Electron browser used by the production-browser tests. */
export async function launchBrowser(
  url: string,
  profileDir: string,
): Promise<RunningBrowser> {
  const debugPort = await freePort();
  const child = spawn(electronBinary, [
    join(process.cwd(), 'scripts/eval-browser.cjs'),
    url,
    String(debugPort),
    profileDir,
  ], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  return { process: child, debugPort, log: collectProcessOutput(child) };
}

export async function findTarget(
  port: number,
  predicate: (target: DevToolsTarget) => boolean,
  browserLog: () => string,
  timeoutMs = 15_000,
): Promise<DevToolsTarget> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json() as DevToolsTarget[];
      const target = targets.find((candidate) => candidate.webSocketDebuggerUrl && predicate(candidate));
      if (target) return target;
    } catch {
      // Electron is still starting.
    }
    await wait(100);
  }
  throw new Error(`timed out waiting for Electron target\n${browserLog()}`);
}

export async function eventually<T>(
  read: () => Promise<T>,
  message: string,
  accept: (value: T) => boolean = Boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  const detail = lastError instanceof Error ? lastError.message : JSON.stringify(last);
  throw new Error(`${message}: ${detail}`);
}

export function collectProcessOutput(child: ChildProcess): () => string {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
  return () => [stdout, stderr].filter(Boolean).join('\n').trim();
}

export async function freePort(): Promise<number> {
  const portServer = createServer();
  await new Promise<void>((resolve, reject) => {
    portServer.once('error', reject);
    portServer.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const address = portServer.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate debug port');
  await new Promise<void>((resolve, reject) =>
    portServer.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron browser did not exit')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Stop a launched browser, escalating to SIGKILL if it ignores SIGTERM. */
export async function stopBrowser(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitForProcessExit(child, 5_000).catch(() => child.kill('SIGKILL'));
}
