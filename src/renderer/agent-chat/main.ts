import '../editor/editor.css';
import './agentChat.css';
import { AgentChatPanel } from '../editor/agentChatPanel.js';

const session = await window.api.getDeck();
if (!session) throw new Error('No presentation is open');

const panel = new AgentChatPanel({
  api: window.api,
  currentDeckPath: () => session.dir,
  onClose: () => window.close(),
});

panel.show();
