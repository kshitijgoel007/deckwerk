import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_GUIDE_FILE,
  AGENT_GUIDE_MARKER,
  defaultLauncherPath,
  renderAgentGuide,
  writeAgentGuide,
} from '../src/main/agentGuide.js';
import { capabilities } from '../src/shared/capabilities.js';

describe('the per-deck agent brief', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function deckFolder(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'deck-guide-'));
    cleanup.push(dir);
    return dir;
  }

  it('renders the deck brief with the launcher path and the marker on line one', () => {
    const text = renderAgentGuide({ launcher: '/opt/deckwerk/bin/slide-agent' });
    expect(text.split('\n')[0]).toBe(AGENT_GUIDE_MARKER);
    expect(text).toContain('# Working on this deck');
    expect(text).toContain('/opt/deckwerk/bin/slide-agent');
    // The four steps, and nothing an agent has to choose between.
    expect(text).toContain('slide-agent render . --slide 8,9,10');
    expect(text).toContain('drafts/slide.html');
    expect(text).toContain('slide-agent apply . --html drafts/slide.html --after 8');
    expect(text).toContain('## 4. Check and iterate');
    expect(text.split('\n').length).toBeLessThan(90);
    expect(text).not.toContain('{{LAUNCHER_HINT}}');
  });

  it('tells a packaged installation how to get the CLI instead of inventing a path', () => {
    const text = renderAgentGuide({ launcher: null });
    expect(text).toContain('does not bundle it');
    expect(text).not.toContain('~/bin/slide-agent`.');
  });

  it('routes every specialized authoring capability from the generated brief', () => {
    const brief = renderAgentGuide({ launcher: '/opt/deckwerk/bin/slide-agent' });
    const authoring = readFile(join(process.cwd(), 'docs', 'agent-authoring.md'), 'utf8');
    return authoring.then((detail) => {
      for (const capability of capabilities()) expect(`${brief}\n${detail}`).toContain(capability.id);
    });
  });

  it('finds this checkout\'s launcher when running from source', () => {
    expect(defaultLauncherPath()).toMatch(/bin\/slide-agent$/);
  });

  it('writes the brief into an empty deck folder', async () => {
    const dir = await deckFolder();
    expect(await writeAgentGuide(dir, { launcher: '/x/slide-agent' })).toBe('written');
    const text = await readFile(join(dir, AGENT_GUIDE_FILE), 'utf8');
    expect(text).toBe(renderAgentGuide({ launcher: '/x/slide-agent' }));
  });

  it('refreshes a stale generated brief but reports an identical one as unchanged', async () => {
    const dir = await deckFolder();
    await writeFile(join(dir, AGENT_GUIDE_FILE), `${AGENT_GUIDE_MARKER}\n# old brief\n`, 'utf8');
    expect(await writeAgentGuide(dir, { launcher: '/x/slide-agent' })).toBe('written');
    expect(await writeAgentGuide(dir, { launcher: '/x/slide-agent' })).toBe('unchanged');
    // A different installation (launcher moved) is a content change.
    expect(await writeAgentGuide(dir, { launcher: '/y/slide-agent' })).toBe('written');
    expect(await readFile(join(dir, AGENT_GUIDE_FILE), 'utf8')).toContain('/y/slide-agent');
  });

  it('never touches a brief the author has taken over', async () => {
    const dir = await deckFolder();
    const owned = '# My talk\n\nRemember to thank the organisers.\n';
    await writeFile(join(dir, AGENT_GUIDE_FILE), owned, 'utf8');
    expect(await writeAgentGuide(dir, { launcher: '/x/slide-agent' })).toBe('owned');
    expect(await readFile(join(dir, AGENT_GUIDE_FILE), 'utf8')).toBe(owned);
  });
});
