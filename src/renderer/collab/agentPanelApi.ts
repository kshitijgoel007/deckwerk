import type { AgentPanelState } from '@shared/ipc.js';
import type { AgentPanelApi } from '../editor/agentPanel.js';

export interface AgentPanelBrowserApi {
  api: AgentPanelApi;
  participantId: string;
  close: () => void;
}

/** Private browser transport for filesystem-bridge status and scratchpad. */
export function createAgentPanelApi(deckId: string): AgentPanelBrowserApi {
  const participantId = browserParticipantId();
  const listeners = new Set<(state: AgentPanelState) => void>();
  const deckUrl = (path: string): string => {
    const url = new URL(path, location.origin);
    url.searchParams.set('deck', deckId);
    url.searchParams.set('participant', participantId);
    return url.href;
  };
  const request = async <T>(path: string): Promise<T> => {
    const response = await fetch(deckUrl(path));
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error ?? `Agent panel request failed (${response.status})`);
    return value as T;
  };
  const events = new EventSource(deckUrl('/api/agent-panel/events'));
  events.onmessage = (event) => {
    const state = JSON.parse(event.data) as AgentPanelState;
    for (const listener of listeners) listener(state);
  };
  return {
    api: {
      getState: () => request('/api/agent-panel/state'),
      onState: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    participantId,
    close: () => events.close(),
  };
}

export function browserParticipantId(): string {
  const requested = new URLSearchParams(location.search).get('agentParticipant');
  if (requested && /^[a-zA-Z0-9_-]{8,80}$/.test(requested)) return requested;
  const storageKey = 'deckwerk.agent-panel-participant-id';
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing && /^[a-zA-Z0-9_-]{8,80}$/.test(existing)) return existing;
    const created = `participant-${crypto.randomUUID()}`;
    localStorage.setItem(storageKey, created);
    return created;
  } catch {
    return `participant-${crypto.randomUUID()}`;
  }
}
