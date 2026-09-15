import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAuthoringFileName, readSettledFile } from '../src/main/htmlAuthoring.js';

/**
 * The edit-folder watcher fires when a file is opened for writing, not when
 * its last byte lands. A large authoring page written in place used to be
 * read once mid-write, seen as "still growing", and dropped for good — the
 * save never reached the deck. The reader must wait the write out instead.
 */
describe('reading a watched authoring file that is still being written', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('returns the complete document once the slow write has finished', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'edit-settle-'));
    cleanup.push(dir);
    const path = join(dir, 'work.html');
    const body = `<!doctype html><html><body>${'<section class="slide"><p>x</p></section>\n'.repeat(4000)}</body></html>`;
    // A writer that lands the document in many small chunks over ~300 ms,
    // the way a 600 KB page arrives from a tool writing in place. Chunks come
    // faster than the reader's pause, so no two reads agree until the end.
    const handle = await open(path, 'w');
    const chunks = 30;
    const size = Math.ceil(body.length / chunks);
    const writing = (async () => {
      for (let i = 0; i < chunks; i++) {
        await handle.write(body.slice(i * size, (i + 1) * size));
        await new Promise((r) => setTimeout(r, 10));
      }
      await handle.close();
    })();
    const read = await readSettledFile(path, { delayMs: 60, attempts: 50 });
    await writing;
    expect(read.length).toBe(body.length);
    expect(read.endsWith('</html>')).toBe(true);
  });

  it('gives a stalled writer a bounded number of chances rather than hanging', async () => {
    let calls = 0;
    const read = await readSettledFile('ignored', { delayMs: 1, attempts: 3 },
      async () => `partial ${calls++}`);
    expect(calls).toBe(4);
    expect(read).toBe('partial 3');
  });

  it('only treats visible .html files as authored documents', () => {
    expect(isAuthoringFileName('work.html')).toBe(true);
    expect(isAuthoringFileName('add.html')).toBe(true);
    expect(isAuthoringFileName('.!89764!work.html')).toBe(false);
    expect(isAuthoringFileName('.work.html.swp')).toBe(false);
    expect(isAuthoringFileName('notes.md')).toBe(false);
  });
});
