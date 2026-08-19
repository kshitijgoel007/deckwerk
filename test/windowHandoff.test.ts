import { describe, expect, it } from 'vitest';
import { handoffWhenReady } from '../src/main/windowHandoff.js';

class FakeWindow {
  private readyListeners: Array<() => void> = [];
  destroyed = false;
  closed = false;

  once(event: 'ready-to-show', listener: () => void): this {
    if (event === 'ready-to-show') this.readyListeners.push(listener);
    return this;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  close(): void {
    this.closed = true;
  }

  ready(): void {
    for (const listener of this.readyListeners.splice(0)) listener();
  }
}

describe('window handoff', () => {
  it('keeps the outgoing app window open until the replacement is ready', async () => {
    const outgoing = new FakeWindow();
    const replacement = new FakeWindow();
    const handoff = handoffWhenReady(replacement, outgoing);

    expect(outgoing.closed).toBe(false);
    replacement.ready();
    await handoff;
    expect(outgoing.closed).toBe(true);
  });

  it('does not close an outgoing window that was already destroyed', async () => {
    const outgoing = new FakeWindow();
    outgoing.destroyed = true;
    const replacement = new FakeWindow();
    const handoff = handoffWhenReady(replacement, outgoing);

    replacement.ready();
    await handoff;
    expect(outgoing.closed).toBe(false);
  });
});
