// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { AgentPanel, type AgentPanelApi } from '../src/renderer/editor/agentPanel.js';
import type { AgentPanelState } from '../src/shared/ipc.js';

function state(overrides: Partial<AgentPanelState> = {}): AgentPanelState {
  return {
    deckPath: 'talk', connection: 'unavailable', agentName: null,
    scratchpad: null, busy: false, activity: null, messages: [], error: null, ...overrides,
  };
}

function api(initial: AgentPanelState): AgentPanelApi & { publish: (next: AgentPanelState) => void } {
  const listeners = new Set<(value: AgentPanelState) => void>();
  return {
    getState: vi.fn(async () => initial),
    onState: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    publish: (next) => { for (const listener of listeners) listener(next); },
  };
}

describe('filesystem agent panel', () => {
  it('onboards an existing agent without chat, account, or model controls', async () => {
    const transport = api(state());
    const panel = new AgentPanel({
      api: transport, currentDeckPath: () => 'talk', connectCommand: 'slide-agent connect https://deck/session',
    });
    panel.show();
    await Promise.resolve();
    expect(panel.element.textContent).toContain('filesystem-based agent');
    expect(panel.element.textContent).toContain('slide-agent connect');
    expect(panel.element.querySelector('textarea')).toBeNull();
    expect(panel.element.textContent).not.toContain('Sign in');
    expect(panel.element.textContent).not.toContain('Model');
  });

  it('shows bridge activity and opens the latest source/import scratchpad', () => {
    const transport = api(state());
    const panel = new AgentPanel({
      api: transport, currentDeckPath: () => 'talk', connectCommand: 'slide-agent connect session',
    });
    transport.publish(state({
      connection: 'ready', agentName: 'Codex',
      messages: [{ id: 'm1', role: 'assistant', text: 'applied slides: Add interactive chart' }],
      scratchpad: {
        draftId: 'd1', slideCount: 2, sourceUrl: '/draft/source', importedUrl: '/draft/imported',
        comparisonUrl: '/draft/compare', sourceContactSheetUrl: '/draft/source.png',
        importedContactSheetUrl: '/draft/imported.png',
      },
    }));
    expect(panel.element.textContent).toContain('applied slides: Add interactive chart');
    expect(panel.element.textContent).toContain('Scratchpad · 2 slides');
    expect([...document.querySelectorAll<HTMLIFrameElement>('.agent-scratchpad-panel iframe')].at(-1)?.src)
      .toContain('/draft/source?scratchpad=slides');
  });
});
