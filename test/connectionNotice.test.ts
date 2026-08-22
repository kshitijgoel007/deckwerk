// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectionNotice } from '../src/renderer/collab/connectionNotice.js';

/**
 * The connection notice is what stands between a killed collab server and an
 * unexplained blank page. These tests pin the contract: the editor banner
 * names what still works (and offers the client-side backup — the only save
 * that works without the server), the present view keeps a live slide visible
 * behind a pill, and only a deck-less present page gets the blocking message.
 */

afterEach(() => {
  document.getElementById('connection-notice')?.remove();
  vi.restoreAllMocks();
});

const notice = () => document.getElementById('connection-notice');

describe('editor connection notice', () => {
  it('tells the user what survives a disconnect and offers a deck backup', () => {
    const banner = createConnectionNotice({
      mode: 'editor',
      backup: () => ({ fileName: 'deck-backup.json', text: '{"deck":1}' }),
    });
    banner.showDisconnected();

    const node = notice()!;
    expect(node.dataset.state).toBe('disconnected');
    expect(node.dataset.blocking).toBeUndefined();
    const text = node.textContent!;
    expect(text).toContain('Session disconnected');
    // The save contract must be spelled out: synced edits are safe, new ones are not.
    expect(text).toContain('discarded when the session reconnects');
    expect(text).toContain('already saved on the host');
    expect(document.getElementById('connection-notice-backup')).toBeTruthy();

    expect(banner.state()).toBe('disconnected');
    banner.hide();
    expect(notice()).toBeNull();
    expect(banner.state()).toBeNull();
  });

  it('downloads the in-memory deck when the backup button is clicked', () => {
    const banner = createConnectionNotice({
      mode: 'editor',
      backup: () => ({ fileName: 'deck-backup.json', text: '{"deck":1}' }),
    });
    banner.showDisconnected();

    // jsdom has no URL.createObjectURL; the download itself is stubbed and the
    // test asserts the blob + anchor handoff.
    const createObjectURL = vi.fn(() => 'blob:backup');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }));
    const clicks: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push(this.download);
      });

    document.getElementById('connection-notice-backup')!.click();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clicks).toEqual(['deck-backup.json']);
    click.mockRestore();
  });

  it('shows an ended message without the reconnect guidance', () => {
    const banner = createConnectionNotice({ mode: 'editor' });
    banner.showEnded('The host ended this collaboration.');
    const node = notice()!;
    expect(node.dataset.state).toBe('ended');
    expect(node.textContent).toContain('Session ended');
    expect(node.textContent).toContain('The host ended this collaboration.');
    expect(node.textContent).not.toContain('discarded');
  });
});

describe('present connection notice', () => {
  it('is a non-blocking pill while a slide is on screen', () => {
    const pill = createConnectionNotice({ mode: 'present', blocking: () => false });
    pill.showDisconnected();
    const node = notice()!;
    expect(node.dataset.state).toBe('disconnected');
    expect(node.dataset.blocking).toBeUndefined();
    expect(node.textContent).toContain('Session disconnected — reconnecting…');
  });

  it('owns the page when no deck has ever painted — the white-screen case', () => {
    const page = createConnectionNotice({ mode: 'present', blocking: () => true });
    page.showDisconnected();
    const node = notice()!;
    expect(node.dataset.blocking).toBe('true');
    expect(node.textContent).toContain('Session disconnected.');
    expect(node.textContent).toContain('server is unreachable');
  });

  it('re-rendering after a deck paints downgrades the page notice to a pill', () => {
    let painted = false;
    const dynamic = createConnectionNotice({ mode: 'present', blocking: () => !painted });
    dynamic.showDisconnected();
    expect(notice()!.dataset.blocking).toBe('true');
    painted = true;
    dynamic.showDisconnected();
    expect(notice()!.dataset.blocking).toBeUndefined();
    expect(document.querySelectorAll('#connection-notice')).toHaveLength(1);
  });

  it('announces a host-ended session', () => {
    const pill = createConnectionNotice({ mode: 'present', blocking: () => false });
    pill.showEnded('The host ended this presentation.');
    expect(notice()!.textContent).toContain('The host ended this presentation.');
  });
});
