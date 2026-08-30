// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { HistoryPanel } from '../src/renderer/editor/historyPanel.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { describeAgentEdit } from '../src/renderer/collab/collabBridge.js';

describe('edit history', () => {
  beforeEach(() => document.body.replaceChildren());

  it('restores any recorded state and makes the revert undoable', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    store.commit((deck) => { deck.slides[0].name = 'First edit'; }, { label: 'Rename slide' });
    const first = store.history()[0];
    store.commit((deck) => { deck.slides[0].name = 'Second edit'; }, { label: 'Rename again' });
    store.commit((deck) => { deck.slides[0].name = 'Third edit'; }, { label: 'Rename third' });

    expect(store.history().map((item) => item.label).slice(0, 3)).toEqual([
      'Rename third', 'Rename again', 'Rename slide',
    ]);
    expect(store.restoreHistory(first.id)).toBe(true);
    expect(store.slide?.name).toBe('First edit');
    expect(store.get().dirty).toBe(true);

    store.undo();
    expect(store.slide?.name).toBe('Third edit');
  });

  it('hydrates the complete persisted log before exposing the opened deck', () => {
    const first = new EditorStore(emptyDeck('History'), '/tmp/history');
    first.commit((deck) => { deck.title = 'One'; }, { label: 'First edit' });
    first.commit((deck) => { deck.title = 'Two'; }, { label: 'Second edit' });

    const reopened = new EditorStore(emptyDeck());
    reopened.load(first.get().deck, '/tmp/history', {
      history: first.persistedHistory(),
    });

    expect(reopened.history().map((item) => item.label)).toEqual([
      'Second edit', 'First edit',
    ]);
    expect(reopened.restoreHistory(reopened.history().at(-1)!.id)).toBe(true);
    expect(reopened.get().deck.title).toBe('One');
  });

  it('does not record an opened disk state when it differs from the persisted tip', () => {
    const previous = new EditorStore(emptyDeck('Previous'), '/tmp/history');
    previous.commit((deck) => { deck.title = 'Persisted tip'; }, { label: 'Old edit' });
    const disk = emptyDeck('Changed outside the app');
    const reopened = new EditorStore(emptyDeck());

    reopened.load(disk, '/tmp/history', { history: previous.persistedHistory() });

    expect(reopened.history().map((item) => item.label)).toEqual(['Old edit']);
    expect(reopened.isHistoryCurrent(reopened.history()[0].id)).toBe(false);
    expect(reopened.get().deck.title).toBe('Changed outside the app');
    const old = reopened.history().find((item) => item.label === 'Old edit')!;
    expect(reopened.restoreHistory(old.id)).toBe(true);
    expect(reopened.get().deck.title).toBe('Persisted tip');
  });

  it('drops a semantically broken delta log without blocking the deck', () => {
    const disk = emptyDeck('Still opens');
    const reopened = new EditorStore(emptyDeck());
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    reopened.load(disk, '/tmp/history', {
      history: {
        version: 2,
        base: emptyDeck('Old base'),
        entries: [
          { label: 'Base', at: 1, slideIndex: 0, operations: [] },
          {
            label: 'Broken edit',
            at: 2,
            slideIndex: 0,
            operations: [{
              op: 'deleteElements',
              slideId: 'missing-slide',
              elementIds: ['missing-element'],
            }],
          },
        ],
      },
    });

    expect(reopened.get().deck.title).toBe('Still opens');
    expect(reopened.history()).toEqual([]);
    expect(report).toHaveBeenCalledWith('Could not hydrate edit history:', expect.anything());
    report.mockRestore();
  });

  it('does not duplicate an optimistic local state when its server echo arrives', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    store.commit((deck) => { deck.title = 'Local'; }, { label: 'Change title' });
    const before = store.history();

    store.applyRemote(structuredClone(store.get().deck), 'Change title');

    expect(store.history()).toEqual(before);
  });

  it('coalesces remote streams while keeping a replayable base and delta log', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    const first = structuredClone(store.get().deck);
    first.title = 'Typing one';
    store.applyRemote(first, 'Edit text');
    const second = structuredClone(first);
    second.title = 'Typing two';
    store.applyRemote(second, 'Edit text');

    const persisted = store.persistedHistory();
    expect(store.history()).toHaveLength(1);
    expect(persisted.base?.title).toBe('Typing two');
    expect(persisted.entries[0].operations).toEqual([]);

    const reopened = new EditorStore(emptyDeck());
    reopened.load(second, '/tmp/history', { history: persisted });
    expect(reopened.history()).toHaveLength(1);
    expect(reopened.isHistoryCurrent(reopened.history()[0].id)).toBe(true);
  });

  it('treats filesystem replacements as non-historical synchronization boundaries', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    store.commit((deck) => { deck.title = 'User edit'; }, { label: 'Change title' });
    const history = store.history();
    expect(store.canUndo()).toBe(true);
    const replacement = emptyDeck('Changed on disk');

    store.replaceExternal(replacement, '/tmp/history');

    expect(store.history()).toEqual(history);
    expect(store.history().some((item) => /open|external/i.test(item.label))).toBe(false);
    expect(store.isHistoryCurrent(store.history()[0].id)).toBe(false);
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(false);
  });

  it('applies collaboration resyncs without adding them to authored history', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    store.commit((deck) => { deck.title = 'User edit'; }, { label: 'Change title' });
    const history = store.history();
    const replacement = emptyDeck('Server disk state');

    store.applyRemote(replacement, 'External edit', { history: false, coalesce: false });

    expect(store.get().deck.title).toBe('Server disk state');
    expect(store.history()).toEqual(history);
    expect(store.isHistoryCurrent(history[0].id)).toBe(false);
  });

  it('broadcasts and records a revert with one consistent label', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    store.commit((deck) => { deck.title = 'First'; }, { label: 'First edit' });
    const first = store.history()[0];
    store.commit((deck) => { deck.title = 'Edited'; }, { label: 'Second edit' });
    const edits: string[] = [];
    store.onLocalEdit = (_before, _after, label) => edits.push(label);

    expect(store.restoreHistory(first.id)).toBe(true);

    expect(store.history()[0].label).toBe('Reverted to First edit');
    expect(edits).toEqual(['Reverted to First edit']);
    const beforeEcho = store.history();
    store.applyRemote(structuredClone(store.get().deck), edits[0]);
    expect(store.history()).toEqual(beforeEcho);
  });

  it('does not manufacture a revert when two revisions have identical content', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    store.commit((deck) => { deck.title = 'Edited'; }, { label: 'Change title' });
    const same = structuredClone(store.get().deck);
    store.replaceExternal(same, '/tmp/history');
    const duplicate = store.history()[0];

    expect(store.restoreHistory(duplicate.id)).toBe(false);
    expect(store.history()[0].label).toBe('Change title');
  });

  it('bounds both live and persisted history while retaining restorable snapshots', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    for (let revision = 1; revision <= 205; revision++) {
      store.commit((deck) => { deck.title = `Revision ${revision}`; }, {
        label: `Edit ${revision}`,
      });
    }

    expect(store.history()).toHaveLength(200);
    expect(store.persistedHistory().entries).toHaveLength(200);
    expect(store.history().at(-1)?.label).toBe('Edit 6');
    expect(store.restoreHistory(store.history().at(-1)!.id)).toBe(true);
    expect(store.get().deck.title).toBe('Revision 6');
  });

  it('keeps the checkpoint and immutable operation log by reference per read', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    store.commit((deck) => { deck.title = 'One'; }, { label: 'First edit' });
    store.commit((deck) => { deck.title = 'Two'; }, { label: 'Second edit' });

    const first = store.persistedHistory();
    const second = store.persistedHistory();
    expect(second.base).toBe(first.base);
    expect(second.entries[0].operations).toBe(first.entries[0].operations);
    expect(second.entries[1].operations).toBe(first.entries[1].operations);
  });

  it('persists one deck checkpoint instead of repeating it in every revision', () => {
    const deck = emptyDeck('Compact history');
    deck.slides = Array.from({ length: 50 }, (_, index) => ({
      ...structuredClone(deck.slides[0]),
      id: `slide-${index}`,
      name: `Slide ${index}`,
    }));
    const store = new EditorStore(deck, '/tmp/history');
    for (let revision = 1; revision <= 50; revision++) {
      store.commit((next) => { next.title = `Revision ${revision}`; }, {
        label: `Edit ${revision}`,
      });
    }

    const persisted = store.persistedHistory();
    const oneDeckBytes = JSON.stringify(persisted.base).length;
    expect(persisted.entries).toHaveLength(50);
    expect(persisted.entries.every((entry) => !('deck' in entry))).toBe(true);
    expect(JSON.stringify(persisted).length).toBeLessThan(oneDeckBytes * 2);
  });

  it('does not notify history subscribers for ordinary selection changes', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    let notifications = 0;
    store.subscribeHistory(() => { notifications += 1; });

    store.select(['missing']);
    store.clearSelection();
    store.selectSlide(0);
    expect(notifications).toBe(0);

    store.commit((deck) => { deck.title = 'Edited'; }, { label: 'Edit title' });
    expect(notifications).toBe(1);
  });

  it('defers hidden history-panel rebuilding until the tab becomes visible', async () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    const host = document.createElement('div');
    host.hidden = true;
    document.body.appendChild(host);
    new HistoryPanel(host, store);

    store.commit((deck) => { deck.title = 'Edited'; }, { label: 'Edit title' });
    expect(host.querySelectorAll('.history-item')).toHaveLength(0);

    host.hidden = false;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.querySelectorAll('.history-item')).toHaveLength(1);
  });

  it('shows the current state and lets an older state be selected from the panel', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    store.commit((deck) => { deck.title = 'First title'; }, { label: 'First title' });
    store.commit((deck) => { deck.title = 'Edited title'; }, { label: 'Change title' });
    const host = document.createElement('div');
    document.body.appendChild(host);
    new HistoryPanel(host, store);

    const buttons = host.querySelectorAll<HTMLButtonElement>('.history-item');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].disabled).toBe(true);
    expect(buttons[0].textContent).toContain('Current · Change title');
    buttons[1].click();
    expect(store.get().deck.title).toBe('First title');
    expect(host.querySelector('.history-item')?.textContent).toContain('Reverted to First title');
  });

  it('shows an empty state instead of an opening revision before the first edit', () => {
    const store = new EditorStore(emptyDeck('History'), '/tmp/history');
    const host = document.createElement('div');
    new HistoryPanel(host, store);

    expect(store.history()).toEqual([]);
    expect(host.querySelectorAll('.history-item')).toHaveLength(0);
    expect(host.querySelector('.history-empty')?.textContent).toBe('No authored edits yet.');
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
