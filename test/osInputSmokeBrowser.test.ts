import { afterEach, describe, expect, it } from 'vitest';
import { eventually } from './support/browserSession.js';
import {
  assertOsInputPermission,
  launchVisibleDesktopEditor,
  osActivateApp,
  osActivateProcess,
  osDoubleClickAt,
  osKeyCode,
  osKeystroke,
  osInputOptIn,
  osTypeText,
  screenPointOf,
  type OsDesktopEditor,
} from './support/osInput.js';

/**
 * OS-event input smoke tier.
 *
 * Every other browser tier injects input through the CDP Input domain — the
 * real Chromium pipeline, but nothing above it. This suite is the layer above:
 * a VISIBLE desktop window made frontmost at the macOS level, driven by real
 * System Events keystrokes and clicks. It exists for exactly the paths CDP
 * cannot reach:
 *
 *  1. Native menu/accelerator and macOS editing-command routing (Cmd+B can
 *     arrive as a `formatBold` beforeinput with no keydown at all).
 *  2. Real Cmd+Z through the OS (the default application menu owns that
 *     accelerator, so it reaches the page as the menu's undo role).
 *  3. Real inter-application focus loss: the app-switch blur exemption in
 *     canvas.ts only runs when macOS actually moves focus to another app.
 *
 * macOS only and OPT-IN (RUN_OS_INPUT_SMOKE=1, `npm run test:osinput`): it
 * steals the user's keyboard and focus while it runs, so it must never run in
 * CI or in the default suite. It requires Accessibility permission for the
 * terminal app; without it the suite FAILS with instructions rather than
 * silently skipping, because opting in means asking for the coverage.
 */

const TEXT_ID = 'os-input-smoke-text';
const BASE_TEXT = 'Base sentence for the smoke run.';
const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;

let editor: OsDesktopEditor | null = null;

afterEach(async () => {
  await editor?.close();
  editor = null;
});

/** Authored text plus a per-character bold map, read (never driven) via CDP. */
async function readTextState(): Promise<{ text: string; boldMap: boolean[]; editing: boolean }> {
  return editor!.cdp.evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(CONTENT)});
    if (!root) return { text: '', boldMap: [], editing: false };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const boldMap = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const style = getComputedStyle(node.parentElement);
      const bold = style.fontWeight === 'bold' || Number.parseInt(style.fontWeight, 10) >= 600;
      const authored = node.data.replaceAll('\\u2060', '');
      for (let index = 0; index < authored.length; index += 1) boldMap.push(bold);
    }
    return {
      text: root.textContent?.replaceAll('\\u2060', '') ?? '',
      boldMap,
      editing: root.isContentEditable === true,
    };
  })()`);
}

function occurrences(text: string, word: string): number {
  return text.split(word).length - 1;
}

async function waitForText(
  accept: (state: { text: string; boldMap: boolean[]; editing: boolean }) => boolean,
  message: string,
  timeoutMs = 8_000,
): Promise<{ text: string; boldMap: boolean[]; editing: boolean }> {
  return eventually(readTextState, message, accept, timeoutMs);
}

describe.skipIf(!osInputOptIn)('OS-event input smoke (macOS, opt-in)', () => {
  it('routes real OS keystrokes, menu undo, and app-switch focus through the visible editor', {
    timeout: 180_000,
  }, async () => {
    // Fail fast, with instructions, when Accessibility permission is missing.
    await assertOsInputPermission();

    editor = await launchVisibleDesktopEditor(TEXT_ID, `<p>${BASE_TEXT}</p>`);
    const { cdp, pid } = editor;
    await osActivateProcess(pid);
    await cdp.call('Page.bringToFront');
    await eventually(
      () => cdp.evaluate<boolean>('document.hasFocus()'),
      'the visible editor window never took OS focus',
    );

    // Enter text editing with a real OS double-click on the rendered text.
    // If the AppleScript double-click is delivered as two single clicks (no
    // cliclick installed and the interval ran long), fall back to ONE CDP
    // double-click purely to position the caret — every keystroke afterwards
    // still comes from the OS.
    const glyph = await screenPointOf(cdp, CONTENT, 'smoke fixture text');
    await osDoubleClickAt(glyph.x, glyph.y);
    try {
      await waitForText((state) => state.editing, 'OS double-click did not enter text editing', 4_000);
    } catch {
      await cdp.doubleClickTextAtOffset(CONTENT, 2, 'caret fallback for OS input');
      await waitForText((state) => state.editing, 'text editing never started', 6_000);
    }

    // ── Scenario 1: menu accelerator / macOS editing-command routing ──────
    // Move the caret to the end of the line, type a plain word, toggle bold
    // with a REAL Cmd+B (System Events), type a bold word. On macOS this
    // chord can arrive as a native formatBold editing command instead of a
    // keydown — the routing CDP injection can never exercise.
    await osKeyCode(124, ['command']); // Cmd+Right: caret to end of line.
    await osTypeText(' plainword ');
    await waitForText(
      (state) => occurrences(state.text, 'plainword') === 1,
      'OS-typed plain word did not appear exactly once',
    );
    await osKeystroke('b', ['command']);
    await osTypeText('boldword');
    const afterBold = await waitForText(
      (state) => occurrences(state.text, 'boldword') === 1,
      'OS-typed bold word did not appear exactly once',
    );
    expect(occurrences(afterBold.text, 'boldword'), 'bold word must appear exactly once').toBe(1);
    const boldStart = afterBold.text.indexOf('boldword');
    for (let index = boldStart; index < boldStart + 'boldword'.length; index += 1) {
      expect(afterBold.boldMap[index], `character ${index} of the Cmd+B word is bold`).toBe(true);
    }
    const plainStart = afterBold.text.indexOf('plainword');
    for (let index = plainStart; index < plainStart + 'plainword'.length; index += 1) {
      expect(afterBold.boldMap[index], `character ${index} before Cmd+B stays plain`).toBe(false);
    }
    // Close the pending bold run so later typing is plain again.
    await osKeystroke('b', ['command']);

    // ── Scenario 2: real Cmd+Z through the OS (default menu owns it) ──────
    const beforeUndo = (await readTextState()).text;
    await osTypeText(' undome');
    await waitForText(
      (state) => occurrences(state.text, 'undome') === 1,
      'the to-be-undone OS-typed word did not appear',
    );
    await osKeystroke('z', ['command']);
    const afterUndo = await waitForText(
      (state) => !state.text.includes('undome'),
      'real Cmd+Z did not remove the typed run',
    );
    expect(afterUndo.text, 'Cmd+Z must undo exactly the typed run').toBe(beforeUndo);
    const boldAfterUndo = afterUndo.text.indexOf('boldword');
    expect(boldAfterUndo, 'undo must not eat the earlier bold word').toBeGreaterThanOrEqual(0);
    expect(afterUndo.boldMap[boldAfterUndo], 'undo must not strip the earlier bold formatting')
      .toBe(true);

    // ── Scenario 3: real app-switch focus loss and return ─────────────────
    // The blur exemption in canvas.ts only triggers when macOS itself moves
    // focus to another application: blur with no relatedTarget while the
    // document has lost focus. Activate Finder, come back, and prove the edit
    // session (and its caret) survived by typing again from the OS.
    const beforeSwitch = await readTextState();
    expect(beforeSwitch.editing, 'the edit session must be live before the app switch').toBe(true);
    await osActivateApp('Finder');
    await eventually(
      () => cdp.evaluate<boolean>('!document.hasFocus()'),
      'activating Finder never took OS focus from the editor',
    );
    const whileBlurred = await readTextState();
    expect(whileBlurred.editing, 'app switch must not end the text-edit session').toBe(true);
    expect(whileBlurred.text, 'app switch must not change the text').toBe(beforeSwitch.text);
    await osActivateProcess(pid);
    await eventually(
      () => cdp.evaluate<boolean>('document.hasFocus()'),
      'the editor never regained OS focus after the app switch',
    );
    await osTypeText(' back');
    const afterReturn = await waitForText(
      (state) => occurrences(state.text, ' back') === 1,
      'typing after the app switch did not land in the surviving edit session',
    );
    expect(afterReturn.text, 'the caret survived the round trip')
      .toBe(`${beforeSwitch.text} back`);
    expect(afterReturn.editing, 'the session is still live after the round trip').toBe(true);
  });
});

// Repo convention: the skipped configuration still reports one green test so
// a CI/default run shows the tier was consciously gated, not lost.
describe.skipIf(osInputOptIn)('OS-event input smoke (skipped)', () => {
  it('needs macOS and RUN_OS_INPUT_SMOKE=1 (npm run test:osinput)', () => {
    expect(osInputOptIn).toBe(false);
  });
});
