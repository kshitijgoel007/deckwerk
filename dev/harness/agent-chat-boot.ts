import '../../src/renderer/editor/editor.css';
import type { AgentChatState } from '../../src/shared/ipc.js';
import {
  AgentChatPanel,
  type AgentChatApi,
} from '../../src/renderer/editor/agentChatPanel.js';

let listener: (state: AgentChatState) => void = () => undefined;
let state: AgentChatState = {
  deckPath: '/tmp/harness',
  connection: 'ready',
  auth: 'signedIn',
  accountLabel: 'slides@example.com',
  busy: false,
  activity: null,
  messages: [],
  error: null,
};

const publish = (next: AgentChatState) => {
  state = next;
  listener(state);
  return state;
};

const api: AgentChatApi = {
  getAgentChatState: async () => state,
  sendAgentChatMessage: async (request) => {
    const user = { id: crypto.randomUUID(), role: 'user' as const, text: request.text };
    publish({ ...state, busy: true, activity: 'Editing slides…', messages: [...state.messages, user] });
    setTimeout(() => publish({
      ...state,
      busy: false,
      activity: null,
      messages: [...state.messages, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: 'I previewed and applied the title hierarchy update through the deck API.',
      }],
    }), 650);
    return state;
  },
  loginAgentChat: async () => publish({ ...state, auth: 'signedIn', accountLabel: 'slides@example.com' }),
  switchAgentChatAccount: async () => publish({
    ...state,
    auth: 'signedIn',
    accountLabel: state.accountLabel === 'slides@example.com'
      ? 'vsitzmann@rhoda.ai'
      : 'slides@example.com',
    messages: [],
  }),
  interruptAgentChat: async () => publish({ ...state, busy: false, activity: null }),
  resetAgentChat: async () => publish({ ...state, busy: false, activity: null, messages: [] }),
  onAgentChatState: (fn) => { listener = fn; return () => undefined; },
};

const panel = new AgentChatPanel({
  api,
  currentDeckPath: () => '/tmp/harness',
});
panel.show();

Object.assign(window, { panel, setAgentState: publish });
