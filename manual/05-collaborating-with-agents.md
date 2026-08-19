# Collaborating with agents

Click **Agent…** to start a deck-scoped agent session. DeckWerk moves the presentation into its live collaboration shell and opens a small companion chat window with the message box focused. Type a request and press **Enter** to send it; use **Shift+Enter** for a new line.

Sign in with ChatGPT if DeckWerk asks you to. The agent receives the same complete HTTP API onboarding that the Agent button copies to the clipboard: the loopback session URL, deck ID, inspection endpoints, native-edit and HTML-authoring lanes, and the preview/apply/verification contract.

> Screenshot placeholder: Asking the embedded HTTP agent to polish the presentation.

The agent works through the revision-bound HTTP API while you watch changes appear live. Applied drafts become named, undoable changes in **History**. The collaboration shell remains the deck's only writer while the agent session is open.

Choose **Stop** to interrupt a turn or **New chat** to discard the current conversation while keeping the same live session. Closing the companion chat ends the agent session and returns DeckWerk to the ordinary editor.

Agents can also read and reply to comments. This makes a comment a useful way to leave a precise request on a slide or object before opening the chat.

Keep DeckWerk open while the agent works so the loopback API and live player remain available.
