# Workspace-independent agent evaluation

Run this command from the editor repository:

```bash
OPENAI_API_KEY=... npm run eval:agent
```

The command builds the collaboration client and runs three fresh attempts by
default. Set `AGENT_EVAL_ATTEMPTS` to change the count. Set
`AGENT_EVAL_OUTPUT` to select the artifact folder.

## Workspace-independent profile

The author model is `gpt-5.6-luna` with low reasoning. It receives these tools:

- OpenAI web search.
- Browser navigation, page text, public-page media discovery, clicking, typing,
  screenshots, and a short wait.
- A public-URL asset importer that returns a deck-relative path.
- Named presentation tools for the brief, capabilities, context, comments,
  HTML preview/apply, preview views, and the real player.

The author does not start in the editor repository and cannot assume a working
directory, checkout, CLI, or filesystem path. This is an environment constraint,
not an information embargo. The app can provide the brief, capability examples,
deck context, comments, diagnostics, and previews through its documented tools.

This profile receives no shell or filesystem tool. Electron starts with Node
integration disabled and no preload script. The collaboration server exposes only
the benchmark deck. Future profiles can provide more app-supplied context while
keeping the same workspace-independent constraint.

The asset tool rejects local and private-network addresses. It downloads public
HTTP or HTTPS media, then sends the bytes through the app's normal content-hash
asset importer.

## Benchmark

Each attempt starts with three empty slides and three unresolved comments:

1. Vincent introduction, with public biography and portrait.
2. A section anchor after which the agent must insert a current Scene
   Representation Group slide with ten portraits.
3. A timeline for SRNs, SIREN, Neural Descriptor Fields, pixelSplat, Diffusion
   Forcing, and MilliVid.

The prompt requires comment discovery, both insertion and replacement, HTML
preview, source/import comparison, real-player verification, replies, and comment
resolution. After the first Vincent apply, the harness adds visual feedback. The
agent must discover it and revise the slide against a new revision.

## Evidence

Each attempt stores the exact prompt, browser tool log, screenshots, final model
text, deck outline, unresolved seeded-comment count, latency, token use, and an
estimated token cost. A separate low-reasoning model receives only the saved
screenshots. It scores hierarchy and fidelity and reports clipping, broken
assets, duplication, and insufficient evidence.

The output is in `artifacts/agent-eval/<timestamp>/` unless you set a different
folder.

## Acceptance

An attempt passes only when all of these conditions are true:

- The three target slides are in the correct positions and are not duplicated.
- All seeded comments have a reply and are resolved.
- No asset is missing and no text overflows.
- The imported result matches the source within the configured pixel tolerance.
- Undo treats a multi-slide application as one labeled change.
- The complete attempt did not assume a repository or filesystem workspace.

The harness records evidence for these checks. It does not convert a missing
screenshot or a null pixel measurement into a pass.

## Current run status

The harness was validated through build and typecheck on 18 August 2026. The
current task process did not inherit `OPENAI_API_KEY`, so no paid attempt has run
yet. A fresh task process is required after the environment secret becomes
available.
