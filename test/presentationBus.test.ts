// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import {
  createPresentationBus,
  presentationChannelName,
  type PresentationBus,
  type PresentationBusMessage,
} from '../src/renderer/collab/presentationBus.js';

/**
 * The browser presentation's transport between its audience surface and its
 * Speaker View. Both are ordinary same-origin pages with no server in between,
 * so this is the whole mechanism by which one drives the other.
 */

const open: PresentationBus[] = [];
const track = (bus: PresentationBus): PresentationBus => {
  open.push(bus);
  return bus;
};

afterEach(() => {
  for (const bus of open.splice(0)) bus.close();
  vi.unstubAllGlobals();
});

/**
 * Both transports deliver asynchronously; let the queue drain. One zero-delay
 * timer is usually enough, but on a loaded CI runner the BroadcastChannel
 * message port has been seen to deliver a turn later, so wait a few turns.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

describe('presentation bus', () => {
  it('carries commands and state between two surfaces of the same deck', async () => {
    const audience = track(createPresentationBus('talk'));
    const speaker = track(createPresentationBus('talk'));
    const atAudience: PresentationBusMessage[] = [];
    const atSpeaker: PresentationBusMessage[] = [];
    audience.subscribe((message) => atAudience.push(message));
    speaker.subscribe((message) => atSpeaker.push(message));

    speaker.post({ kind: 'command', command: { type: 'next' } });
    audience.post({
      kind: 'state',
      state: { cursor: { slide: 3, step: 1 }, steps: 2, startedAt: 0, slideStartedAt: 0 },
    });
    await settle();

    expect(atAudience).toEqual([{ kind: 'command', command: { type: 'next' } }]);
    expect(atSpeaker).toEqual([{
      kind: 'state',
      state: { cursor: { slide: 3, step: 1 }, steps: 2, startedAt: 0, slideStartedAt: 0 },
    }]);
  });

  it('keeps two decks presenting in the same browser apart', async () => {
    const talk = track(createPresentationBus('talk'));
    const other = track(createPresentationBus('other-talk'));
    const heard: PresentationBusMessage[] = [];
    other.subscribe((message) => heard.push(message));

    talk.post({ kind: 'command', command: { type: 'next' } });
    await settle();

    expect(heard).toEqual([]);
  });

  it('stops delivering after close', async () => {
    const audience = track(createPresentationBus('talk'));
    const speaker = track(createPresentationBus('talk'));
    const heard: PresentationBusMessage[] = [];
    audience.subscribe((message) => heard.push(message));

    audience.close();
    speaker.post({ kind: 'command', command: { type: 'next' } });
    await settle();

    expect(heard).toEqual([]);
  });

  it('unsubscribes one listener without silencing the rest', async () => {
    const audience = track(createPresentationBus('talk'));
    const speaker = track(createPresentationBus('talk'));
    const dropped: PresentationBusMessage[] = [];
    const kept: PresentationBusMessage[] = [];
    const unsubscribe = audience.subscribe((message) => dropped.push(message));
    audience.subscribe((message) => kept.push(message));

    unsubscribe();
    speaker.post({ kind: 'command', command: { type: 'prev' } });
    await settle();

    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(1);
  });

  describe('without BroadcastChannel', () => {
    // Older WebKit falls back to storage events. jsdom does not fire them
    // between windows, so the fallback is driven directly: what matters is
    // that a post becomes a distinguishable write under the channel key, and
    // that a write from another page is decoded back into a message.

    /** jsdom here ships no working Storage, so supply a minimal real one. */
    const memoryStorage = (): Storage => {
      const entries = new Map<string, string>();
      return {
        get length() { return entries.size; },
        key: (index: number) => [...entries.keys()][index] ?? null,
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => { entries.set(key, String(value)); },
        removeItem: (key: string) => { entries.delete(key); },
        clear: () => entries.clear(),
      } as Storage;
    };

    const withoutBroadcastChannel = <T>(body: () => T): T => {
      vi.stubGlobal('BroadcastChannel', undefined);
      vi.stubGlobal('localStorage', memoryStorage());
      return body();
    };

    it('writes each post under the channel key, repeats included', () => {
      withoutBroadcastChannel(() => {
        const bus = track(createPresentationBus('talk'));
        const key = presentationChannelName('talk');

        bus.post({ kind: 'command', command: { type: 'next' } });
        const first = localStorage.getItem(key);
        bus.post({ kind: 'command', command: { type: 'next' } });
        const second = localStorage.getItem(key);

        expect(JSON.parse(first!).message).toEqual({ kind: 'command', command: { type: 'next' } });
        // Two identical commands must still be two distinct writes, or the
        // second `next` would not fire a storage event anywhere.
        expect(second).not.toBe(first);
      });
    });

    it('never puts a whole deck through localStorage', () => {
      withoutBroadcastChannel(() => {
        const bus = track(createPresentationBus('talk'));
        bus.post({ kind: 'seed', deck: emptyDeck('Talk'), themeCss: 'body{}' });
        expect(localStorage.getItem(presentationChannelName('talk'))).toBeNull();
      });
    });

    it('decodes a write from another page and ignores foreign or broken ones', () => {
      withoutBroadcastChannel(() => {
        const bus = track(createPresentationBus('talk'));
        const heard: PresentationBusMessage[] = [];
        bus.subscribe((message) => heard.push(message));

        const fire = (key: string, newValue: string | null) =>
          window.dispatchEvent(new StorageEvent('storage', { key, newValue }));

        fire('some-other-key', JSON.stringify({ n: 0, message: { kind: 'bye' } }));
        fire(presentationChannelName('talk'), 'not json');
        fire(presentationChannelName('talk'), null);
        fire(
          presentationChannelName('talk'),
          JSON.stringify({ n: 0, message: { kind: 'command', command: { type: 'prev' } } }),
        );

        expect(heard).toEqual([{ kind: 'command', command: { type: 'prev' } }]);
      });
    });

    it('survives a storage refusal, as in a private window', () => {
      vi.stubGlobal('BroadcastChannel', undefined);
      vi.stubGlobal('localStorage', {
        ...memoryStorage(),
        setItem: () => { throw new Error('quota exceeded'); },
      } as Storage);
      const bus = track(createPresentationBus('talk'));
      expect(() => bus.post({ kind: 'command', command: { type: 'next' } })).not.toThrow();
      expect(() => bus.close()).not.toThrow();
    });
  });
});
