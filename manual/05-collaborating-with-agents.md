# Collaborating with agents

Click **Agent…** to start a deck-scoped agent session. A compact chat panel drops down beneath the toolbar with the message box focused, while the ordinary editor remains visible. Type a request and press **Enter** to send it; use **Shift+Enter** for a new line.

Sign in with ChatGPT if DeckWerk asks you to. The agent receives the same complete HTTP API onboarding that the Agent button copies to the clipboard: the loopback session URL, deck ID, inspection endpoints, native-edit and HTML-authoring lanes, and the preview/apply/verification contract.

The signed-in email appears at the top of the panel. Choose **Switch account** to use a different ChatGPT account; DeckWerk keeps this login isolated from other Codex clients on the computer.

Choose a model from the **Model** menu. DeckWerk starts with the default reported by Codex for the signed-in account, and a new choice takes effect with the next message.

You can keep typing while the agent works. Sending another message steers the active turn; use **Stop** separately when you want to interrupt it. The ⚡ button switches supported models between standard and Fast mode (lit means Fast).

> Screenshot placeholder: Asking the embedded HTTP agent to polish the presentation.

The agent works through the revision-bound HTTP API while you watch changes appear live. Applied drafts become named changes in **History**. In the background, the editor is a peer of the same authoritative collaboration session, so local and agent edits stay synchronized.

Choose **Stop** to interrupt a turn or **New chat** to discard the current conversation while keeping the same live session. Click **Agent…** or press Escape to tuck the panel away without stopping the session; choose **Close** in the panel to end it.

Agents can also read and reply to comments. This makes a comment a useful way to leave a precise request on a slide or object before opening the chat.

Keep DeckWerk open while the agent works so the loopback API and live player remain available.
