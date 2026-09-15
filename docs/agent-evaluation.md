# Filesystem-agent evaluation

DeckWerk evaluates agents through the same filesystem interface users receive.
There is no benchmark-only chat runtime or direct HTTP authoring API.

Build the browser client and start a fresh benchmark deck:

```bash
npm run eval:agent:serve
```

Open the printed human URL, click **Agent…**, and run its `slide-agent connect`
command on the machine that hosts the agent. Point any filesystem-capable agent
at the resulting mirror. The mirror contains `AGENTS.md`; the agent should begin
with `slide-agent context` and author under `edit/` exactly as it would for a
desktop deck.

The other reusable fixtures work the same way:

```bash
npm run eval:papers:serve
npm run eval:edits:serve
```

## What to measure

Record the wall time and command trace for the whole attempt, including:

- startup and reading `AGENTS.md`;
- `context`, HTML export or `new`, asset and web-page staging, saves/applies,
  validation, and renders;
- bytes and elapsed time for each bridge request in a remote run;
- time spent authoring versus waiting for compilation, rendering, or sync;
- the final source HTML, imported deck, screenshots, validation result, and
  History labels.

Run each task once against a desktop deck and once through the remote mirror.
The two results should use the same commands and produce equivalent native
slides. Interactive charts belong in explicit web elements; titles, captions,
and explanatory content should remain ordinary editable objects.

## Acceptance

An attempt passes when:

- the requested slides are inserted or replaced at the correct positions
  without duplication;
- comments used as task instructions are replied to and resolved;
- validation reports no unintended overflow, missing asset, or import gap;
- source, imported, and real-player views agree closely enough that the result
  matches the agent's authored design;
- every save is one descriptive History entry and undo restores the prior deck;
- desktop and remote runs require no authoring interface beyond the documented
  filesystem/`slide-agent` loop.

The collaboration server's HTTP and WebSocket endpoints remain implementation
details of `slide-agent connect`; benchmark agents should not call them directly.
