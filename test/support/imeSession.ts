import {
  startSelectionSession,
  type SelectionSession,
} from './selectionSession.js';
import { wait } from './browserSession.js';

/**
 * A real editor session plus an IME composition driver.
 *
 * The composition itself is driven through the DevTools protocol's own IME
 * surface — `Input.imeSetComposition` for each preedit state and
 * `Input.insertText` for the commit — which is the same
 * InputMethodController path a native macOS/Windows IME uses, not synthetic
 * `dispatchEvent` calls. The first test in the suite validates, via a
 * page-side event log, that this produces the genuine composition event
 * sequence (compositionstart → compositionupdate×N with
 * beforeinput/input `insertCompositionText` → compositionend) before any
 * hypothesis test trusts it.
 */

/** One captured page event, as recorded by the injected probe. */
export interface ProbeEvent {
  /** compositionstart | compositionupdate | compositionend | beforeinput | input */
  type: string;
  /** InputEvent.inputType for beforeinput/input, '' otherwise. */
  inputType: string;
  /** event.data, null-safe. */
  data: string | null;
  /** InputEvent.isComposing for beforeinput/input. */
  isComposing: boolean;
}

export interface ImeSession extends SelectionSession {
  /** Install document-level capture listeners recording composition traffic. */
  installProbe(): Promise<void>;
  /** Events recorded since the last clearProbe(). */
  probeLog(): Promise<ProbeEvent[]>;
  clearProbe(): Promise<void>;
  /** Uncaught page errors and unhandled rejections since the probe went in. */
  pageErrors(): Promise<string[]>;
  /** One preedit state: what the candidate window shows mid-composition. */
  setComposition(text: string): Promise<void>;
  /** Commit text through the IME path (fires compositionend when composing). */
  commitText(text: string): Promise<void>;
  /** Walk preedit states then commit, with human-scale pauses. */
  compose(preedits: string[], commit: string): Promise<void>;
  /** Enter edit mode on a text box and put the caret at the very end. */
  editAtEnd(elementId: string): Promise<void>;
  /** The html the store holds for an element right now. */
  committedHtml(elementId: string): Promise<string>;
  /** Editor-only debris (sentinels, marker spans) in the committed html. */
  committedDebris(elementId: string): Promise<string[]>;
}

const PROBE = `(() => {
  if (window.__imeProbe) return true;
  window.__imeProbe = true;
  window.__imeLog = [];
  window.__pageErrors = [];
  const record = (event) => {
    const target = event.target;
    const editable = target && target.closest
      ? Boolean(target.closest('.text-content'))
      : Boolean(target && target.parentElement
          && target.parentElement.closest('.text-content'));
    if (!editable) return;
    window.__imeLog.push({
      type: event.type,
      inputType: event.inputType || '',
      data: event.data === undefined ? null : event.data,
      isComposing: Boolean(event.isComposing),
    });
  };
  for (const type of [
    'compositionstart', 'compositionupdate', 'compositionend',
    'beforeinput', 'input',
  ]) {
    document.addEventListener(type, record, true);
  }
  window.addEventListener('error', (event) => {
    window.__pageErrors.push(String(event.message || event.error));
  });
  window.addEventListener('unhandledrejection', (event) => {
    window.__pageErrors.push('unhandled rejection: ' + String(event.reason));
  });
  return true;
})()`;

export async function startImeSession(deckId: string, name: string): Promise<{
  session: ImeSession;
  close: () => Promise<void>;
}> {
  const started = await startSelectionSession(deckId, name);
  const base = started.session;
  const cdp = base.cdp;

  const session: ImeSession = {
    ...base,
    async installProbe() {
      await cdp.evaluate<boolean>(PROBE);
    },
    probeLog() {
      return cdp.evaluate<ProbeEvent[]>('window.__imeLog ?? []');
    },
    async clearProbe() {
      await cdp.evaluate<boolean>('(window.__imeLog = [], true)');
    },
    pageErrors() {
      return cdp.evaluate<string[]>('window.__pageErrors ?? []');
    },
    async setComposition(text) {
      await cdp.call('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
      await wait(40);
    },
    async commitText(text) {
      await cdp.call('Input.insertText', { text });
      await wait(60);
    },
    async compose(preedits, commit) {
      for (const preedit of preedits) await session.setComposition(preedit);
      await session.commitText(commit);
    },
    async editAtEnd(elementId) {
      await base.doubleClick(elementId);
      const editing = await cdp.evaluate<string | null>(
        'window.canvas.editingElementId()');
      if (editing !== elementId) {
        throw new Error(`double-click opened ${editing ?? 'nothing'}, not ${elementId}`);
      }
      // Real keys walk the caret to the end of the box: last line, line end.
      for (let i = 0; i < 4; i++) await cdp.key('ArrowDown', 40);
      await cdp.key('End', 35);
      await wait(60);
    },
    committedHtml(elementId) {
      return cdp.evaluate<string>(`(() => {
        const state = window.store.get();
        const slide = state.deck.slides[state.slideIndex];
        const el = (slide ? slide.elements : []).find(
          (item) => item.id === ${JSON.stringify(elementId)});
        return el && typeof el.html === 'string' ? el.html : '';
      })()`);
    },
    async committedDebris(elementId) {
      const html = await session.committedHtml(elementId);
      const debris: string[] = [];
      if (html.includes('⁠')) debris.push('typing-style sentinel \\u2060 in committed html');
      if (html.includes('data-editor-typing-style')) {
        debris.push('data-editor-typing-style marker span in committed html');
      }
      if (html.includes('editor-table-selected')) debris.push('table highlight class in committed html');
      return debris;
    },
  };
  return { session, close: started.close };
}
