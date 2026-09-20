// @vitest-environment jsdom
/**
 * The part of a Web UI import that happens after the bytes are out: the
 * server converts in silence, so a delayed dialog carries that wait and any
 * failure. The upload itself and the picker's menu are covered in
 * `deckPickerImportMenu.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importKeynoteToServer } from '../src/renderer/collab/deckPicker.js';

interface SentUpload {
  url: string;
  uploaded: () => void;
  finish: (status: number, payload: unknown) => void;
}
let uploads: SentUpload[] = [];

function stubXhr(): void {
  class FakeXhr {
    status = 0;
    responseText = '';
    private url = '';
    private readonly listeners = new Map<string, (() => void)[]>();
    readonly upload = {
      listeners: new Map<string, ((event: ProgressEvent) => void)[]>(),
      addEventListener(type: string, fn: (event: ProgressEvent) => void) {
        this.listeners.set(type, [...this.listeners.get(type) ?? [], fn]);
      },
    };

    open(_method: string, url: string) { this.url = url; }
    addEventListener(type: string, fn: () => void) {
      this.listeners.set(type, [...this.listeners.get(type) ?? [], fn]);
    }

    send() {
      uploads.push({
        url: this.url,
        uploaded: () => {
          for (const fn of this.upload.listeners.get('load') ?? []) fn({} as ProgressEvent);
        },
        finish: (status, payload) => {
          this.status = status;
          this.responseText = JSON.stringify(payload);
          for (const fn of this.listeners.get('load') ?? []) fn();
        },
      });
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
}

/** Stand in for the native chooser: hand the input a file and fire change. */
function pickFile(name: string): void {
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function choose(this: HTMLInputElement) {
    Object.defineProperty(this, 'files', {
      configurable: true,
      value: [new File(['keynote fixture'], name, { type: 'application/octet-stream' })],
    });
    this.dispatchEvent(new Event('change'));
  });
}

describe('headless Web UI presentation import', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    uploads = [];
    stubXhr();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the chooser in the document only while it is open', () => {
    let input: HTMLInputElement | null = null;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function open(this: HTMLInputElement) {
      input = this;
    });
    importKeynoteToServer(vi.fn());
    expect(input!.isConnected).toBe(true);
    expect(input!.hidden).toBe(true);
    input!.dispatchEvent(new Event('cancel'));
    expect(input!.isConnected).toBe(false);
  });

  it('shows delayed progress through the server-side conversion, then opens the deck', async () => {
    pickFile('research.key');
    const status = vi.fn();
    importKeynoteToServer(status, 'conferences');
    expect(uploads.map((upload) => upload.url)).toEqual(['/api/import-keynote?name=research&folder=conferences']);
    // A quick import never shows the dialog.
    expect(document.querySelector('.import-progress-overlay')).toBeNull();

    await vi.advanceTimersByTimeAsync(500);
    const progress = document.querySelector<HTMLElement>('.import-progress-status')!;
    expect(progress.textContent).toContain('research.key');
    expect(progress.getAttribute('aria-busy')).toBe('true');

    uploads[0].uploaded();
    expect(progress.textContent).toContain('Converting “research.key”');
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining('Converting “research.key”'));

    uploads[0].finish(200, { id: 'research' });
    await vi.waitFor(() => {
      expect(document.querySelector('.import-progress-overlay')).toBeNull();
    });
  });

  it('keeps an import failure visible in the workflow dialog', async () => {
    pickFile('broken.key');
    const status = vi.fn();
    importKeynoteToServer(status);
    uploads[0].finish(400, { error: 'converter unavailable' });
    await vi.waitFor(() => {
      const dialog = document.querySelector('.import-progress-dialog');
      expect(dialog?.textContent).toContain('Keynote import failed');
      expect(dialog?.textContent).toContain('converter unavailable');
      expect(dialog?.querySelector('button')?.textContent).toBe('Close');
    });
    expect(status).toHaveBeenLastCalledWith('Import failed: converter unavailable');
  });
});
