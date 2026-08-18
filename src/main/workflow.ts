import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Deck } from '@shared/deck.js';
import { deckOutline } from '@shared/deckDigest.js';
import { slidesToHtml } from '@shared/htmlSlides.js';
import { PLAYER_TYPE_CSS } from '@shared/playerTypeCss.js';
import type { WorkflowStartRequest, WorkflowStartResult } from '@shared/ipc.js';
import { renderSlidesToPng } from '../cli/renderSlides.js';

/**
 * Turn a UI click into a running agent session.
 *
 * A workflow button does three things, in order: render the slides in scope
 * (the agent must *see* the current state before touching it — the templates
 * insist on it, so the editor pays that cost up front), assemble the prompt
 * from the matching template in workflows/, and open a terminal running the
 * agent in the deck folder. Everything the agent needs from then on it gets
 * through `slide-agent`, exactly as a hand-started session would.
 *
 * The prompt is written to a file in the deck rather than passed as an
 * argument: it stays inspectable, re-runnable by hand, and out of `ps` output.
 */
export async function startWorkflow(
  deckDir: string,
  deck: Deck,
  request: WorkflowStartRequest,
): Promise<WorkflowStartResult> {
  const scope = workflowScope(deck, request);
  const renderDir = join(deckDir, 'edit', '.workflow', 'renders');
  await mkdir(renderDir, { recursive: true });
  await renderSlidesToPng({
    deckDir,
    deck,
    outDir: renderDir,
    slides: scope,
    annotate: false,
    built: true,
    contactSheet: true,
    selectedElementIds: [],
  });

  // Pre-export the scope so the agent's first action is an edit, not a CLI
  // expedition: this is byte-for-byte the file `inspect --html` would print,
  // already in edit/ where saving it syncs.
  let exportPath = '';
  if (request.kind !== 'draft-new-slides') {
    const wanted = new Set(scope.map((slide) => slide.id));
    const page = slidesToHtml(deck.slides.filter((slide) => wanted.has(slide.id)), deck.canvas, {
      typeCss: PLAYER_TYPE_CSS,
      base: '../',
      theme: deck.theme,
    });
    exportPath = join(deckDir, 'edit', 'workflow.html');
    await writeFile(exportPath, page, 'utf8');
  }

  const prompt = fillTemplate(await loadTemplate(request.kind), {
    DECK_DIR: deckDir,
    SELECTED_IDS: scope.map((slide) => slide.id).join(','),
    INSTRUCTIONS: request.instructions.trim() || '(none — use your judgement)',
    RENDER_DIR: renderDir,
    EXPORT_PATH: exportPath,
    OUTLINE: JSON.stringify(deckOutline(deck), null, 1),
    ANCHOR_ID: request.activeSlideId ?? deck.slides[deck.slides.length - 1]?.id ?? '',
  });
  const promptPath = join(deckDir, 'edit', '.workflow-prompt.md');
  await writeFile(promptPath, prompt, 'utf8');

  // Quoting the path once here and reading the prompt from its file keeps the
  // command identical whether a human retypes it or AppleScript runs it.
  // Cheap and quiet by default: slide edits are mechanical once the prompt
  // carries the plan, so a small model with pre-granted permissions turns the
  // session from minutes of narration into seconds of edits.
  // SLIDE_AGENT_MODEL overrides for tasks that deserve a bigger model.
  const model = process.env.SLIDE_AGENT_MODEL ?? 'haiku';
  const command = `cd ${shellQuote(deckDir)} && claude --model ${shellQuote(model)}`
    + ` --permission-mode acceptEdits --allowedTools ${shellQuote('Bash(slide-agent:*)')}`
    + ` "$(cat edit/.workflow-prompt.md)"`;
  const launched = process.platform === 'darwin' ? await openTerminal(command) : false;
  return { promptPath, renderDir, launched, command };
}

function workflowScope(deck: Deck, request: WorkflowStartRequest): Array<{ id: string; number: number }> {
  const all = deck.slides.map((slide, index) => ({ id: slide.id, number: index + 1 }));
  if (request.kind === 'rework-selected-slides' && request.selectedSlideIds.length > 0) {
    const wanted = new Set(request.selectedSlideIds);
    return all.filter((slide) => wanted.has(slide.id));
  }
  if (request.kind === 'draft-new-slides') {
    // The agent writes new slides; what it needs to see is the neighbourhood
    // of the insertion point, not the whole deck.
    const anchor = all.findIndex((slide) => slide.id === request.activeSlideId);
    const centre = anchor >= 0 ? anchor : all.length - 1;
    return all.slice(Math.max(0, centre - 1), centre + 2);
  }
  return all;
}

async function loadTemplate(kind: WorkflowStartRequest['kind']): Promise<string> {
  const path = fileURLToPath(new URL(`../../workflows/${kind}.md`, import.meta.url));
  const full = await readFile(path, 'utf8');
  // The template documents itself around the prompt; only the text between
  // the first pair of `---` rules is what the agent receives.
  const parts = full.split(/^---$/m);
  if (parts.length < 3) throw new Error(`workflows/${kind}.md has no ----delimited prompt`);
  return parts[1].trim() + '\n';
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Z_]+)\}/g, (match, key: string) => values[key] ?? match);
}

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Which terminal app runs the agent.
 *
 * `SLIDE_AGENT_TERMINAL=iterm|terminal` decides explicitly; unset, iTerm is
 * preferred whenever it is installed — people who installed iTerm live in it,
 * and an agent session popping up in the stock Terminal reads as lost.
 */
function terminalApp(): 'iTerm' | 'Terminal' {
  const preference = (process.env.SLIDE_AGENT_TERMINAL ?? '').toLowerCase();
  if (preference === 'iterm') return 'iTerm';
  if (preference === 'terminal') return 'Terminal';
  const installed = ['/Applications/iTerm.app', join(homedir(), 'Applications/iTerm.app')];
  return installed.some((path) => existsSync(path)) ? 'iTerm' : 'Terminal';
}

/** Open a terminal window running the given command; resolves false on failure. */
function openTerminal(command: string): Promise<boolean> {
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const app = terminalApp();
  const script = app === 'iTerm'
    ? [
      '-e', 'tell application "iTerm" to activate',
      '-e', `tell application "iTerm" to tell current session of (create window with default profile) to write text "${escaped}"`,
    ]
    : [
      '-e', 'tell application "Terminal" to activate',
      '-e', `tell application "Terminal" to do script "${escaped}"`,
    ];
  return new Promise((resolvePromise) => {
    const child = spawn('osascript', script, { stdio: 'ignore' });
    child.on('error', () => resolvePromise(false));
    child.on('close', (code) => resolvePromise(code === 0));
  });
}
