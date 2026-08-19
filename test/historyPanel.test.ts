// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { HistoryPanel } from '../src/renderer/editor/historyPanel.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { describeAgentEdit } from '../src/renderer/collab/collabBridge.js';

describe('edit history', () => {
  beforeEach(() => document.body.replaceChildren());

  it('restores any recorded state and makes the revert undoable', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    const initial = store.history()[0];
    store.commit((deck) => { deck.slides[0].name = 'First edit'; }, { label: 'Rename slide' });
    store.commit((deck) => { deck.slides[0].name = 'Second edit'; }, { label: 'Rename again' });

    expect(store.history().map((item) => item.label).slice(0, 3)).toEqual([
      'Rename again', 'Rename slide', 'Initial state',
    ]);
    expect(store.restoreHistory(initial.id)).toBe(true);
    expect(store.slide?.name).toBe('Slide 1');
    expect(store.get().dirty).toBe(true);

    store.undo();
    expect(store.slide?.name).toBe('Second edit');
  });

  it('shows the current state and lets an older state be selected from the panel', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    store.commit((deck) => { deck.title = 'Edited title'; }, { label: 'Change title' });
    const host = document.createElement('div');
    document.body.appendChild(host);
    new HistoryPanel(host, store);

    const buttons = host.querySelectorAll<HTMLButtonElement>('.history-item');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[0].textContent).toContain('Current · Change title');
    buttons[1].click();
    expect(store.get().deck.title).toBe('History');
    expect(host.querySelector('.history-item')?.textContent).toContain('Reverted to Initial state');
  });

  it('keeps identically labelled agent applies as separate restorable revisions', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    const first = structuredClone(store.get().deck);
    first.title = 'Agent revision one';
    store.applyRemote(first, 'Agent edit', {
      coalesce: false,
      description: 'Revised the paper slides. Changed 1 revised slide.',
      agentChatId: 'thread-1',
    });
    const second = structuredClone(first);
    second.title = 'Agent revision two';
    store.applyRemote(second, 'Agent edit', {
      coalesce: false,
      description: 'Revised the paper slides again. Changed 1 revised slide.',
      agentChatId: 'thread-1',
    });

    const agentRevisions = store.history()
      .filter((item) => item.label === 'Agent edit');
    expect(agentRevisions).toHaveLength(2);
    expect(store.restoreHistory(agentRevisions[1].id)).toBe(true);
    expect(store.get().deck.title).toBe('Agent revision one');
    expect(store.history()[0].label).toBe('Reverted to Agent edit');
  });

  it('shows a verbose Agent description and opens its linked chat independently', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    const revised = structuredClone(store.get().deck);
    revised.title = 'Agent revision';
    store.applyRemote(revised, 'Agent edit', {
      coalesce: false,
      description: 'Reworked the opening. Changed 2 revised slides and 3 added objects.',
      agentChatId: 'thread-7',
    });
    const host = document.createElement('div');
    const opened: string[] = [];
    new HistoryPanel(host, store, { onOpenAgentChat: (chatId) => opened.push(chatId) });
    expect(host.querySelector('.history-description')?.textContent)
      .toContain('Changed 2 revised slides and 3 added objects');
    host.querySelector<HTMLButtonElement>('.history-chat-link')?.click();
    expect(opened).toEqual(['thread-7']);
  });

  it('expands an Agent transaction label with a structural edit summary', () => {
    expect(describeAgentEdit('Agent: Refine the opening', [
      { op: 'replaceSlide', slideId: 's1', slide: emptyDeck().slides[0] },
      { op: 'setSlideProperties', slideId: 's2', slide: emptyDeck().slides[0] },
      { op: 'deleteElements', slideId: 's1', elementIds: ['e1', 'e2', 'e3'] },
    ])).toBe('Refine the opening. Changed 2 revised slides and 3 removed objects.');
  });
});
