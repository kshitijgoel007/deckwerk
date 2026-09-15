// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importKeynoteToServer } from '../src/renderer/collab/deckPicker.js';

describe('headless Web UI presentation import', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows delayed progress and asks for sharing before opening an imported deck', async () => {
    let finishImport!: (response: Response) => void;
    const importResponse = new Promise<Response>((resolve) => { finishImport = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(importResponse)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        owner: 'alice@example.com',
        visibility: 'private',
        publicRole: 'view',
        sharedWith: [],
        canManage: true,
        role: 'owner',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function pickFile(this: HTMLInputElement) {
      Object.defineProperty(this, 'files', {
        configurable: true,
        value: [new File(['keynote fixture'], 'research.key', { type: 'application/octet-stream' })],
      });
      this.dispatchEvent(new Event('change'));
    });

    importKeynoteToServer(vi.fn(), '', { configureSharing: true });
    expect(document.querySelector('.import-progress-overlay')).toBeNull();

    await vi.advanceTimersByTimeAsync(500);
    const progress = document.querySelector<HTMLElement>('.import-progress-status')!;
    expect(progress.textContent).toContain('research.key');
    expect(progress.getAttribute('aria-busy')).toBe('true');

    finishImport(new Response(JSON.stringify({ id: 'research' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await vi.waitFor(() => {
      expect(document.querySelector('.import-progress-overlay')).toBeNull();
      expect(document.querySelector('.share-dialog')?.textContent).toContain('Private — only you and people you list');
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/import-keynote?name=research',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/access?deck=research');
  });

  it('keeps an import failure visible in the workflow dialog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'converter unavailable' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function pickFile(this: HTMLInputElement) {
      Object.defineProperty(this, 'files', {
        configurable: true,
        value: [new File(['bad'], 'broken.key')],
      });
      this.dispatchEvent(new Event('change'));
    });

    importKeynoteToServer(vi.fn());
    await vi.waitFor(() => {
      const dialog = document.querySelector('.import-progress-dialog');
      expect(dialog?.textContent).toContain('Keynote import failed');
      expect(dialog?.textContent).toContain('converter unavailable');
      expect(dialog?.querySelector('button')?.textContent).toBe('Close');
    });
  });
});
