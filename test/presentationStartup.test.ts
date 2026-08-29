import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('presentation startup', () => {
  const source = readFileSync(
    join(process.cwd(), 'src', 'renderer', 'editor', 'main.ts'),
    'utf8',
  );
  const start = source.slice(
    source.indexOf('async function startPresentation'),
    source.indexOf('async function exportWeb'),
  );

  it('opens from an in-memory snapshot without awaiting disk/history persistence', () => {
    expect(start).toContain('await syncMainSessionSnapshot()');
    expect(start).not.toContain('await save()');
    expect(start.indexOf('window.api.present')).toBeLessThan(start.indexOf('scheduleSave()'));
  });
});
