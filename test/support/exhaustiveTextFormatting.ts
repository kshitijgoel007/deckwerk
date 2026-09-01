import { expect } from 'vitest';
import { Cdp, eventually } from './browserSession.js';

export const EXHAUSTIVE_TEXT_ID = 'exhaustive-format-text';
export const EXHAUSTIVE_CONTENT = `#canvas [data-element-id="${EXHAUSTIVE_TEXT_ID}"] .text-content`;
export const EXHAUSTIVE_HTML = [
  '<p>Lorem ipsum carries inline math $E = mc^2$ through every style.</p>',
  '<p>Second paragraph keeps display math $$\\int_0^1 x^2\\,dx = 1/3$$ intact.</p>',
  '<p>Third paragraph exercises lists, alignment, and typography together.</p>',
].join('');
export const EXHAUSTIVE_TEXT = [
  'Lorem ipsum carries inline math $E = mc^2$ through every style.',
  'Second paragraph keeps display math $$\\int_0^1 x^2\\,dx = 1/3$$ intact.',
  'Third paragraph exercises lists, alignment, and typography together.',
].join('');

type Alignment = 'left' | 'center' | 'right' | 'justify';
type ListStyle = 'None' | 'Bulleted' | 'Numbered';
type WeightMode = 'bold-off' | 'bold-on' | 'numeric-350' | 'numeric-850';
type ToggleRoute = 'shortcut' | 'button';

type ExhaustiveCase = {
  target: { start: number; end: number; label: string };
  weight: WeightMode;
  italic: boolean;
  underline: boolean;
  size: number;
  family: '' | 'Arial';
  alignment: Alignment;
  list: ListStyle;
  route: ToggleRoute;
};

const PANEL = '#inspector';
const ALIGN_LABEL: Record<Alignment, string> = {
  left: 'Align left',
  center: 'Align centre',
  right: 'Align right',
  justify: 'Justify',
};

function target(fragment: string, label: string): ExhaustiveCase['target'] {
  const start = EXHAUSTIVE_TEXT.indexOf(fragment);
  if (start < 0) throw new Error(`missing exhaustive target ${JSON.stringify(fragment)}`);
  return { start, end: start + fragment.length, label };
}

function cases(): ExhaustiveCase[] {
  const result: ExhaustiveCase[] = [];
  const targets = [
    target('ipsum', 'word in first paragraph'),
    target('$E = mc^2$', 'inline math in first paragraph'),
    target('$$\\int_0^1 x^2\\,dx = 1/3$$', 'display math in second paragraph'),
  ];
  const weights: WeightMode[] = ['bold-off', 'bold-on', 'numeric-350', 'numeric-850'];
  const alignments: Alignment[] = ['left', 'center', 'right', 'justify'];
  const lists: ListStyle[] = ['None', 'Bulleted', 'Numbered'];
  for (const selected of targets) {
    // Block styles are outermost because changing them rebuilds paragraph/list
    // structure. Inline toggles are innermost, so adjacent Cartesian states
    // normally need only one production interaction.
    for (const list of lists) {
      for (const alignment of alignments) {
        for (const family of ['', 'Arial'] as const) {
          for (const size of [28, 48]) {
            for (const weight of weights) {
              for (const italic of [false, true]) {
                for (const underline of [false, true]) {
                  result.push({
                    target: selected,
                    weight,
                    italic,
                    underline,
                    size,
                    family,
                    alignment,
                    list,
                    route: result.length % 2 === 0 ? 'shortcut' : 'button',
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return result;
}

function numberField(label: string): string {
  return `${PANEL} input[aria-label="${label}"]`;
}

async function setToggle(
  editor: Cdp,
  label: string,
  active: boolean,
  route: ToggleRoute,
  recoverSelection?: () => Promise<void>,
): Promise<void> {
  const selector = `${PANEL} button[aria-label="${label}"]`;
  const format = label.startsWith('Italic')
    ? 'italic' : label.startsWith('Underline') ? 'underline' : 'bold';
  const formatActive = (state: Awaited<ReturnType<typeof selectedInlineState>>) => format === 'bold'
    ? state.weight >= 600 : format === 'italic' ? state.italic : state.underline;
  let current = await selectedInlineState(editor);
  let currentActive = formatActive(current);
  if (currentActive === active) return;
  const invoke = async () => {
    if (route === 'button') {
      await editor.click(selector, label);
      return;
    }
    const focused = await editor.evaluate<boolean>(
      `document.activeElement === document.querySelector(${JSON.stringify(EXHAUSTIVE_CONTENT)})`,
    );
    expect(focused, `${label}: shortcut target lost contenteditable focus`).toBe(true);
    const key = format === 'italic' ? 'i' : format === 'underline' ? 'u' : 'b';
    const keyCode = key.toUpperCase().charCodeAt(0);
    const modifier = process.platform === 'darwin' ? 4 : 2;
    await editor.chord(key, `Key${key.toUpperCase()}`, keyCode, modifier);
  };
  const editing = await editor.evaluate<boolean>(
    `document.querySelector(${JSON.stringify(EXHAUSTIVE_CONTENT)})?.isContentEditable === true`,
  );
  if (!editing && recoverSelection) await recoverSelection();
  await invoke();
  let after = await selectedInlineState(editor);
  let afterActive = formatActive(after);
  if (afterActive !== active && recoverSelection) {
    await recoverSelection();
    current = await selectedInlineState(editor);
    currentActive = formatActive(current);
    if (currentActive !== active) await invoke();
    after = await selectedInlineState(editor);
    afterActive = formatActive(after);
  }
  expect(afterActive, `${label}: toggle did not reach requested state; ${after.html}`).toBe(active);
}

async function typeNumber(editor: Cdp, label: string, value: number): Promise<void> {
  const selector = numberField(label);
  await editor.click(selector, label);
  const selected = await editor.evaluate<boolean>(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement) || document.activeElement !== input) return false;
    input.select();
    return true;
  })()`);
  if (!selected) throw new Error(`${label} did not focus for exhaustive typing`);
  await editor.typeKeys(String(value));
  // Native number fields commit on blur. Trigger that browser transition
  // directly after genuine focus + text insertion; the control's change
  // handler restores the bookmarked canvas Range. Sending Enter/Tab here can
  // leak a paragraph/list command after that focus restoration.
  await editor.evaluate(`document.querySelector(${JSON.stringify(selector)})?.blur()`);
}

async function setWeight(
  editor: Cdp,
  mode: WeightMode,
  route: ToggleRoute,
  recoverSelection?: () => Promise<void>,
): Promise<number> {
  if (mode === 'bold-off' || mode === 'bold-on') {
    const active = mode === 'bold-on';
    await setToggle(editor, 'Bold (Cmd/Ctrl+B)', active, route, recoverSelection);
    return active ? 700 : 400;
  }
  const weight = mode === 'numeric-350' ? 350 : 850;
  await typeNumber(editor, 'Font weight', weight);
  return weight;
}

function weightValue(mode: WeightMode): number {
  if (mode === 'bold-off') return 400;
  if (mode === 'bold-on') return 700;
  return mode === 'numeric-350' ? 350 : 850;
}

function selectedInlineState(editor: Cdp): Promise<{
  weight: number;
  italic: boolean;
  underline: boolean;
  html: string;
}> {
  return editor.evaluate(`(() => {
    const range = getSelection()?.rangeCount ? getSelection().getRangeAt(0) : null;
    const parent = range?.startContainer instanceof Text
      ? range.startContainer.parentElement : range?.startContainer;
    const style = parent instanceof Element ? getComputedStyle(parent) : null;
    return {
      weight: Number.parseInt(style?.fontWeight ?? '', 10),
      italic: style?.fontStyle === 'italic',
      underline: style?.textDecorationLine.includes('underline') === true,
      html: document.querySelector(${JSON.stringify(EXHAUSTIVE_CONTENT)})?.innerHTML ?? '',
    };
  })()`);
}

async function selectExactRange(
  editor: Cdp,
  selected: ExhaustiveCase['target'],
  label: string,
): Promise<void> {
  const wanted = EXHAUSTIVE_TEXT.slice(selected.start, selected.end);
  let lastSelection = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await editor.call('Page.bringToFront');
    await editor.evaluate('window.focus()');
    const editing = await editor.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(EXHAUSTIVE_CONTENT)})?.isContentEditable === true`,
    );
    if (!editing) {
      await editor.click(`#canvas [data-element-id="${EXHAUSTIVE_TEXT_ID}"]`, `${label}: text box`);
      await editor.clickTextAtOffset(EXHAUSTIVE_CONTENT, 2, `${label}: resume text editing`);
      await eventually(async () => editor.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(EXHAUSTIVE_CONTENT)})?.isContentEditable === true`,
      ), `${label}: text editing did not resume`, Boolean, 2_000);
    } else {
      await editor.evaluate(
        `document.querySelector(${JSON.stringify(EXHAUSTIVE_CONTENT)})?.focus({ preventScroll: true })`,
      );
    }
    await editor.selectTextRange(
      EXHAUSTIVE_CONTENT,
      selected.start,
      selected.end,
      label,
    );
    try {
      await eventually(async () => editor.evaluate<string>(`getSelection()?.toString() ?? ''`),
        `${label}: pointer selection did not settle`, (value) => value === wanted, 1_500);
      return;
    } catch {
      lastSelection = await editor.evaluate<string>(`getSelection()?.toString() ?? ''`);
    }
  }
  throw new Error(`${label}: pointer selection did not settle: ${JSON.stringify(lastSelection)}`);
}

/**
 * Run the opt-in Cartesian interaction matrix against either editor shell.
 * Every state is reached through production controls and a genuine pointer
 * selection. `EXHAUSTIVE_FORMAT_FUZZ_CASES` can cap it for a quick smoke run.
 */
export async function runExhaustiveTextFormatting(editor: Cdp): Promise<number> {
  await editor.click(`#canvas [data-element-id="${EXHAUSTIVE_TEXT_ID}"]`, 'exhaustive text box');
  // The focused regression test owns strict double-click-to-edit coverage.
  // This long matrix enters editing through the equally real and less
  // timing-sensitive selected-box click path so failures belong to formatting.
  await editor.clickTextAtOffset(EXHAUSTIVE_CONTENT, 2, 'selected exhaustive text box');
  await eventually(async () => editor.evaluate<boolean>(
    `document.querySelector(${JSON.stringify(EXHAUSTIVE_CONTENT)})?.isContentEditable === true`,
  ), 'exhaustive fixture did not enter text editing');

  const allCases = cases();
  const configuredLimit = Number(process.env.EXHAUSTIVE_FORMAT_FUZZ_CASES ?? allCases.length);
  const selectedCases = allCases.slice(0, Math.max(1, Math.min(allCases.length, configuredLimit)));
  let previous: ExhaustiveCase | null = null;

  for (const [index, state] of selectedCases.entries()) {
    const label = `exhaustive case ${index + 1}/${selectedCases.length}`;
    const editing = await editor.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(EXHAUSTIVE_CONTENT)})?.isContentEditable === true`,
    );
    if (!editing) {
      // A long production soak crosses autosaves and thousands of inspector
      // focus transitions. Re-enter through real canvas clicks if the browser
      // committed the edit surface between cases; the exact pointer-selected
      // source range below remains the assertion target.
      await editor.click(`#canvas [data-element-id="${EXHAUSTIVE_TEXT_ID}"]`, `${label}: text box`);
      await editor.clickTextAtOffset(EXHAUSTIVE_CONTENT, 2, `${label}: resume text editing`);
      await eventually(async () => editor.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(EXHAUSTIVE_CONTENT)})?.isContentEditable === true`,
      ), `${label}: text editing did not resume`);
    }
    await editor.evaluate(`new Promise((resolve) => requestAnimationFrame(
      () => requestAnimationFrame(() => resolve(true)),
    ))`);
    await selectExactRange(editor, state.target, `${label}: ${state.target.label}`);

    // Block operations intentionally expand the live Range to the paragraphs
    // or list they touched. Apply those first, then reselect the exact inline
    // target before the character-level half of the Cartesian state.
    const targetChanged = previous?.target.start !== state.target.start;
    const listChanged = targetChanged || previous?.list !== state.list;
    const alignmentChanged = targetChanged || previous?.alignment !== state.alignment;
    if (listChanged) await editor.choose(`${PANEL} .text-list-style select`, state.list, 'List');
    if (alignmentChanged) {
      await editor.click(`${PANEL} button[aria-label="${ALIGN_LABEL[state.alignment]}"]`,
        ALIGN_LABEL[state.alignment]);
    }
    if (listChanged || alignmentChanged) {
      const afterBlocks = await editor.evaluate<{ text: string; nested: boolean; html: string }>(`(() => {
        const root = document.querySelector(${JSON.stringify(EXHAUSTIVE_CONTENT)});
        return {
          text: root?.textContent?.replaceAll('\u2060', '') ?? '',
          nested: Boolean(root?.querySelector('ol ol, ol ul, ul ol, ul ul')),
          html: root?.innerHTML ?? '',
        };
      })()`);
      expect(afterBlocks.text, `${label}: block operations changed text`).toBe(EXHAUSTIVE_TEXT);
      expect(afterBlocks.nested, `${label}: block operations nested lists; ${afterBlocks.html}`)
        .toBe(false);
      await editor.evaluate(`new Promise((resolve) => requestAnimationFrame(
        () => requestAnimationFrame(() => resolve(true)),
      ))`);
      await selectExactRange(editor, state.target, `${label}: reselect ${state.target.label}`);
    }
    const recoverSelection = () => selectExactRange(
      editor,
      state.target,
      `${label}: recover ${state.target.label}`,
    );
    const expectedWeight = targetChanged || previous?.weight !== state.weight
      ? await setWeight(editor, state.weight, state.route, recoverSelection)
      : weightValue(state.weight);
    await setToggle(editor, 'Italic (Cmd/Ctrl+I)', state.italic, state.route, recoverSelection);
    await setToggle(
      editor,
      'Underline (Cmd/Ctrl+U)',
      state.underline,
      state.route,
      recoverSelection,
    );
    if (targetChanged || previous?.size !== state.size) {
      const preSize = await selectedInlineState(editor);
      expect(preSize.weight, `${label}: weight reverted before font size; ${preSize.html}`)
        .toBe(expectedWeight);
      expect(preSize.italic, `${label}: italic reverted before font size; ${preSize.html}`)
        .toBe(state.italic);
      expect(preSize.underline, `${label}: underline reverted before font size; ${preSize.html}`)
        .toBe(state.underline);
      await typeNumber(editor, 'Font size', state.size);
      const postSize = await selectedInlineState(editor);
      expect(postSize.weight >= 600,
        `${label}: font size restored bold; before=${preSize.html}; after=${postSize.html}`)
        .toBe(expectedWeight >= 600);
      expect(postSize.italic, `${label}: font size restored italic; ${postSize.html}`)
        .toBe(state.italic);
      expect(postSize.underline, `${label}: font size restored underline; ${postSize.html}`)
        .toBe(state.underline);
    }
    if (targetChanged || previous?.family !== state.family) {
      await editor.choose(`${PANEL} .font-family-field select`, state.family, 'Font family');
    }

    if (!await editor.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(EXHAUSTIVE_CONTENT)})?.isContentEditable === true`,
    )) {
      await recoverSelection();
    }

    const observed = await editor.evaluate<{
      text: string;
      selected: string;
      weight: number;
      italic: boolean;
      underline: boolean;
      size: number;
      family: string;
      alignment: string;
      list: string;
      nested: boolean;
      html: string;
    }>(`(() => {
      const root = document.querySelector(${JSON.stringify(EXHAUSTIVE_CONTENT)});
      const selection = getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const node = range?.startContainer?.nodeType === Node.TEXT_NODE
        ? range.startContainer : range?.startContainer?.firstChild;
      const parent = node?.parentElement ?? range?.startContainer;
      const style = parent instanceof Element ? getComputedStyle(parent) : null;
      const block = parent instanceof Element ? parent.closest('p, li') : null;
      const list = block?.closest('ol') ? 'Numbered' : block?.closest('ul') ? 'Bulleted' : 'None';
      return {
        text: root?.textContent?.replaceAll('\u2060', '') ?? '',
        selected: selection?.toString() ?? '',
        weight: Number.parseInt(style?.fontWeight ?? '', 10),
        italic: style?.fontStyle === 'italic',
        underline: style?.textDecorationLine.includes('underline') === true,
        size: Number.parseFloat(style?.fontSize ?? ''),
        family: style?.fontFamily ?? '',
        alignment: block instanceof HTMLElement ? getComputedStyle(block).textAlign : '',
        list,
        nested: Boolean(root?.querySelector('ol ol, ol ul, ul ol, ul ul')),
        html: root?.innerHTML ?? '',
      };
    })()`);
    expect(observed.text, `${label}: visible/source text`).toBe(EXHAUSTIVE_TEXT);
    expect(observed.selected, `${label}: selection retention`)
      .toBe(EXHAUSTIVE_TEXT.slice(state.target.start, state.target.end));
    expect(observed.weight, `${label}: weight; ${observed.html}`).toBe(expectedWeight);
    expect(observed.italic, `${label}: italic`).toBe(state.italic);
    expect(observed.underline, `${label}: underline`).toBe(state.underline);
    expect(observed.size, `${label}: size`).toBe(state.size);
    if (state.family) expect(observed.family, `${label}: family`).toContain(state.family);
    expect(observed.alignment, `${label}: alignment`).toBe(state.alignment);
    expect(observed.list, `${label}: list`).toBe(state.list);
    expect(observed.nested, `${label}: inline formatting nested lists`).toBe(false);
    previous = state;
  }

  await editor.click('#rail .rail-item', 'slide thumbnail to commit exhaustive text editing');
  await eventually(async () => editor.evaluate<number>(
    `document.querySelectorAll(${JSON.stringify(`${EXHAUSTIVE_CONTENT} .katex`)}).length`,
  ), 'math did not render after exhaustive formatting', (count) => count >= 2, 15_000);
  return selectedCases.length;
}
