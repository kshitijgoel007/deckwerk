import { readFileSync, writeFileSync } from 'node:fs';
import { dialog } from 'electron';
import type {
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue,
} from 'electron';

/**
 * File dialogs, with one seam for integration tests.
 *
 * New, Open, Save As and Import all begin with a native panel, and no
 * automated test can drive one. When `DECKWERK_TEST_DIALOGS` names a JSON file
 * holding a queue of answers, each call consumes the next entry instead of
 * showing a panel — so the real IPC handlers, and everything they then do to
 * the open session, stay under test rather than being stubbed out wholesale.
 *
 * Running out of scripted answers throws. A test that opened an unexpected
 * panel should fail loudly instead of hanging on a dialog nobody can click.
 */

interface ScriptedAnswer {
  canceled?: boolean;
  filePath?: string;
  filePaths?: string[];
}

function nextScriptedAnswer(kind: 'open' | 'save'): ScriptedAnswer | null {
  const path = process.env['DECKWERK_TEST_DIALOGS'];
  if (!path) return null;
  const queue = JSON.parse(readFileSync(path, 'utf8')) as ScriptedAnswer[];
  if (!Array.isArray(queue) || queue.length === 0) {
    throw new Error(`No scripted ${kind} dialog answer left in ${path}`);
  }
  const [next, ...rest] = queue;
  writeFileSync(path, JSON.stringify(rest), 'utf8');
  return next;
}

export async function showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  const scripted = nextScriptedAnswer('open');
  if (!scripted) return dialog.showOpenDialog(options);
  return { canceled: scripted.canceled ?? false, filePaths: scripted.filePaths ?? [] };
}

export async function showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  const scripted = nextScriptedAnswer('save');
  if (!scripted) return dialog.showSaveDialog(options);
  return { canceled: scripted.canceled ?? false, filePath: scripted.filePath ?? '' };
}
