---
name: bug-report
description: >
  Turn a bug the user describes in DeckWerk into a GitHub issue on
  vsitzmann/deckwerk. Use when the user reports that the editor, presenter,
  agent CLI, importer, exporter, or web export misbehaves, crashes, hangs,
  loses work, or renders wrongly — "this is broken", "I found a bug",
  "it crashed when I…", "file a bug", "write a bug report", "open an issue".
  Also use when a bug surfaces during other work and is worth recording.
  Covers verifying, searching for duplicates, drafting, and filing with gh.
---

# Reporting a DeckWerk bug

The goal is an issue a maintainer can act on without asking a follow-up
question: what happened, what should have happened, how to make it happen
again, and where it was running. Never file anything without the user's
explicit yes on the exact text.

## 1. Understand and pin the bug down

Get the facts before drafting. Ask only what you cannot find out yourself.

- **What happened, and what was expected.** One or two sentences each.
- **Steps to reproduce.** Numbered, starting from a state anyone can reach
  (e.g. "open `decks/demo-deck`"). If the user only has it in their own deck,
  try to reproduce on `decks/demo-deck` or a fresh deck first; user decks
  are private data and must not be attached or quoted in an issue.
- **Frequency.** Every time, sometimes, once.
- **Where it runs.** Dev checkout (`npm run dev`), packaged app, or the
  web/collab client. Collect the environment yourself (see §2).
- **Evidence.** Error text from the DevTools console or terminal, a
  screenshot path, the relevant `slide-agent` command and its output.

If the repo is at hand and the bug is cheap to confirm, confirm it: run the
focused test that covers the area (`npx vitest run test/<name>.test.ts`),
call the CLI, or read the code path. Say clearly in the issue what you
**verified** versus what the user **reported**. Do not fix the bug as part
of reporting it unless the user asks; a report and a fix are separate tasks.

Not everything is a bug. A feature request or a "should it work like this?"
belongs in a Discussion or a conversation, not an issue; say so and offer
the text anyway.

## 2. Collect the environment

Run from the deckwerk checkout and put the results in the issue:

```bash
git rev-parse --short HEAD && git branch --show-current && git status --short | head
node -e 'const p=require("./package.json");console.log("deckwerk",p.version,"electron",p.devDependencies.electron)'
node --version
sw_vers 2>/dev/null || uname -srm
```

For a packaged app, ask the user for the version from the About panel
instead of the checkout version. Note any uncommitted changes, because a
bug on a dirty tree may be the user's own.

## 3. Search before filing

A duplicate costs more maintainer time than no report.

```bash
gh issue list --repo vsitzmann/deckwerk --state all --search "<distinctive words>"
```

Search on the symptom and the component (e.g. "paste image collab",
"pptx import fonts"), not on your draft title. Include closed issues: a bug
that was closed as fixed and reproduces again is a regression, and saying
so is the most useful report of all.

If a match exists, read it with `gh issue view <n> --repo vsitzmann/deckwerk
--comments`. Add a comment only if you bring something new: a different
reproduction, a narrower trigger, a stack trace, the commit where it
regressed. "Happens to me too" is noise; tell the user and file nothing.

## 4. Draft and show the issue

Use this shape. Keep it short; the reproduction steps are what matter.

```markdown
## What happened
…

## What I expected
…

## Steps to reproduce
1. …
2. …

## Environment
- deckwerk <version> @ <sha> on <branch> (clean / dirty: …)
- Electron <version>, Node <version>
- <OS and version>
- Running as: dev checkout / packaged app / web client

## Evidence
<console or terminal output in a fenced block; screenshot path if any>

## Notes
<what was verified vs. reported; suspected code path if known, e.g. `src/main/pptxImport.ts`>

Filed by <model name> via <agent harness>.
```

Title: component first, then the symptom, under ~70 characters.
`Collab: pasted image lands on the wrong slide`, not `Bug with paste`.

The signature line is required so a reader knows the text was
machine-authored. Use your real model and harness names; if unsure, say so
rather than inventing a version string.

Show the user the full title and body and **wait for an explicit yes**.
Apply any edits they ask for and show it again if the change is material.

## 5. File it

Only after the yes, and only if the machine can:

```bash
gh auth status
```

If `gh` is missing or not authenticated, do not install or log in. Hand the
user the finished text and the URL
<https://github.com/vsitzmann/deckwerk/issues/new> to submit themselves.

Otherwise write the body to a temp file and create the issue:

```bash
gh issue create --repo vsitzmann/deckwerk --title "<title>" --body-file <path> --label bug
```

If the `bug` label does not exist, retry without `--label`. `gh` cannot
attach images; give the user the screenshot path to drag into the issue on
the web afterwards. Report the resulting URL.

## What not to do

- Do not file unprompted, and do not treat "yes, that's the bug" as
  permission to file; the permission is for the exact text.
- Do not include deck contents, speaker notes, asset paths under the user's
  home directory, or anything from `decks/` other than `demo-deck` and
  `deckwerk_intro`.
- Do not pad the report with speculation. Separate what the evidence shows
  from what you guess, and label the guess.
