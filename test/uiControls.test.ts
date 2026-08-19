import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePopover, helpButton, menuButton } from '../src/renderer/editor/ui.js';
import { createExportPicker } from '../src/renderer/editor/exportPicker.js';
import { showPdfExportDialog } from '../src/renderer/editor/pdfExportDialog.js';

describe('shared editor controls', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      Node: dom.window.Node,
      HTMLElement: dom.window.HTMLElement,
    });
  });
  afterEach(() => closePopover());

  it('makes help popovers keyboard discoverable and non-modal', () => {
    const help = helpButton({ title: 'Magic Move', description: 'Pairs objects.', firstAction: 'Select slides.' });
    document.body.appendChild(help);
    expect(help.getAttribute('aria-label')).toBe('Help: Magic Move');
    expect(help.getAttribute('aria-haspopup')).toBe('true');
    help.click();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Start here: Select slides.');
  });

  it('gives toolbar menus roles and closes after an action', () => {
    let called = false;
    const trigger = menuButton('File', () => [{ label: 'Open', action: () => { called = true; } }]);
    document.body.appendChild(trigger);
    trigger.click();
    const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    item.click();
    expect(called).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('keeps frequent authoring and deck actions as one-click toolbar controls', () => {
    for (const file of ['src/renderer/editor/main.ts', 'src/renderer/collab/main.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source).toContain("barButton('New'");
      expect(source).toContain("barButton('Open'");
      expect(source).toContain("barButton('Import Keynote…'");
      expect(source).toContain("barIconButton('Text'");
      expect(source).toContain('createShapeInsertPicker(store)');
      expect(source).not.toContain("menuButton('File'");
      expect(source).not.toContain("menuButton('Insert'");
    }
  });

  it('groups only PDF and web export in the classic toolbar menu', () => {
    const actions: string[] = [];
    const picker = createExportPicker([
      { label: 'PDF…', action: () => actions.push('pdf') },
      { label: 'Web…', action: () => actions.push('web') },
    ]);
    document.body.appendChild(picker);
    expect(picker.querySelector('button')?.textContent).toBe('Export…');
    picker.querySelector<HTMLButtonElement>('.shape-menu-trigger')!.click();
    const items = [...picker.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(['PDF…', 'Web…']);
    items[0].click();
    expect(actions).toEqual(['pdf']);

    const editor = readFileSync(join(process.cwd(), 'src/renderer/editor/main.ts'), 'utf8');
    const importAt = editor.indexOf("barButton('Import Keynote…'");
    const exportAt = editor.indexOf('createExportPicker([');
    expect(importAt).toBeGreaterThan(-1);
    expect(exportAt).toBeGreaterThan(importAt);
    expect(editor).not.toContain("barButton('Export PDF…'");
    expect(editor).not.toContain("barButton('Export web…'");
  });

  it('uses one in-editor PDF option for build stages', async () => {
    const result = showPdfExportDialog();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-labelledby')).toBe('pdf-export-title');
    expect(dialog.textContent).toContain('Include each stage of builds');
    expect(dialog.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    const checkbox = dialog.querySelector<HTMLInputElement>('input')!;
    checkbox.checked = true;
    [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Export')!.click();
    await expect(result).resolves.toEqual({ includeEachBuildStage: true });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const editor = readFileSync(join(process.cwd(), 'src/renderer/editor/main.ts'), 'utf8');
    expect(editor).toContain("mode: choice.includeEachBuildStage ? 'every' : 'final'");
    const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8');
    expect(main).not.toContain('Choose which build states to export.');
    expect(main).not.toContain("buttons: ['Initial state', 'Final built state', 'Every build'");
  });
});
