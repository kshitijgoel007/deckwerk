// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { HistoryPanel } from '../src/renderer/editor/historyPanel.js';
import { EditorStore } from '../src/renderer/editor/store.js';

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
    store.applyRemote(first, 'Agent: revise paper slides', { coalesce: false });
    const second = structuredClone(first);
    second.title = 'Agent revision two';
    store.applyRemote(second, 'Agent: revise paper slides', { coalesce: false });

    const agentRevisions = store.history()
      .filter((item) => item.label === 'Agent: revise paper slides');
    expect(agentRevisions).toHaveLength(2);
    expect(store.restoreHistory(agentRevisions[1].id)).toBe(true);
    expect(store.get().deck.title).toBe('Agent revision one');
    expect(store.history()[0].label).toBe('Reverted to Agent: revise paper slides');
  });
});
