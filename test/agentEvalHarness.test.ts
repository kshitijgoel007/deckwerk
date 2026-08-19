import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'scripts/eval-agent.mts'), 'utf8');
const briefSource = readFileSync(join(process.cwd(), 'src/server/agentBrief.ts'), 'utf8');
const browserSource = readFileSync(join(process.cwd(), 'scripts/eval-browser.cjs'), 'utf8');
const workspaceSource = readFileSync(join(process.cwd(), 'src/renderer/collab/agentWorkspace.ts'), 'utf8');
const agentApiSource = readFileSync(join(process.cwd(), 'src/renderer/collab/agentApi.ts'), 'utf8');
const collabCss = readFileSync(join(process.cwd(), 'src/renderer/collab/collab.css'), 'utf8');
const presentSource = readFileSync(join(process.cwd(), 'src/renderer/collab/present.ts'), 'utf8');
const serverSource = readFileSync(join(process.cwd(), 'src/server/collabServer.ts'), 'utf8');
const paperServeSource = readFileSync(join(process.cwd(), 'scripts/serve-paper-benchmark.mts'), 'utf8');
const paperPrompt = readFileSync(
  join(process.cwd(), 'test/fixtures/agent-eval/paper-showcase-prompt.md'),
  'utf8',
);

describe('workspace-independent agent evaluation harness', () => {
  it('does not assume a checkout or expose arbitrary page evaluation', () => {
    expect(source).toContain('Do not assume a repository checkout, working directory, CLI, or filesystem access.');
    expect(source).not.toContain("fnTool('browser_eval'");
    expect(source).toContain("fnTool('agent_read_brief'");
    expect(source).toContain("fnTool('agent_get_capabilities'");
    expect(source).toContain("fnTool('agent_preview_html'");
  });

  it('tests insertion, replacement, comments, and revision after feedback', () => {
    expect(source).toContain("benchmarkSlide('slide-team-anchor'");
    expect(source).toContain("mode: { type: 'string', enum: ['insert', 'replace'] }");
    expect(source).toContain('visualFeedbackAdded');
    expect(source).toContain("fnTool('agent_add_comment'");
    expect(source).toContain("fnTool('agent_resolve_comment'");
    expect(source).toContain('VISUAL VERIFICATION IS MANDATORY');
    expect(source).toContain('Fetching HTML, checking status codes, or comparing byte counts does not count as looking.');
    expect(source).toContain('If browser screenshots are unavailable, stop as blocked');
    expect(source).toContain('MECHANICAL SUCCESS IS NOT DESIGN SUCCESS');
    expect(source).toContain('ten current lab members excluding Vincent');
    expect(source).toContain('a bare line of labels is incomplete');
  });

  it('requires both visual and editorial acceptance in the reusable agent brief', () => {
    expect(briefSource).toContain('capture a screenshot');
    expect(briefSource).toContain('make a content inventory');
    expect(briefSource).toContain('A clean render is still a failure if content is missing');
    expect(briefSource).toContain('diagnostics check import mechanics, not editorial completeness or quality');
  });

  it('closes the hidden browser gracefully before using a signal fallback', () => {
    const graceful = source.indexOf("cdp.call('Browser.close')");
    const fallback = source.indexOf("browser.kill('SIGTERM')");
    expect(graceful).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(graceful);
  });

  it('initializes the CDP client before the top-level evaluation loop', () => {
    expect(source.indexOf('class Cdp')).toBeLessThan(source.indexOf('await mkdir(root'));
  });

  it('retains the hidden browser window and fails closed CDP calls promptly', () => {
    expect(browserSource).toContain('let mainWindow;');
    expect(source).toContain("socket.on('close'");
    expect(source).toContain('WebSocket.OPEN');
    expect(source).toContain('AbortSignal.timeout(180_000)');
  });

  it('uses an API control plane and a read-only real-player viewer', () => {
    expect(source).toContain('The app page is a read-only real-player viewer');
    expect(source).not.toContain("fnTool('browser_click'");
    expect(source).not.toContain("fnTool('browser_type'");
    expect(serverSource).toContain("url.searchParams.get('agent') === '1'");
    expect(serverSource).toContain("new URL('/present.html'");
    expect(presentSource).toContain("const agentViewer = params.get('agent') === '1'");
    expect(presentSource).toContain('if (!agentViewer)');
    expect(workspaceSource).toContain("params.get('debug') !== '1'");
    expect(workspaceSource).toContain("request<HtmlDraft>('/api/preview-html'");
    expect(workspaceSource).toContain("request<{ slideIds: string[] }>('/api/apply-html'");
    expect(workspaceSource).toContain("request<{ src: string; kind: string }>('/api/import-url'");
    expect(workspaceSource).toContain('oldSide.hidden = true');
    expect(workspaceSource).toContain("oldSide.insertAdjacentElement('afterend', panel)");
    expect(workspaceSource).toContain("button('API brief'");
    expect(agentApiSource).toContain("previewHtml: (body) => request<HtmlDraft>('/api/preview-html'");
    expect(agentApiSource).not.toContain('store.commit(');
    expect(collabCss).toContain('.agent-session #body');
    expect(collabCss).toContain('.agent-session #side[hidden] { display: none !important; }');
    expect(collabCss).not.toMatch(/#agent-workspace\s*\{[^}]*position:\s*fixed/s);
  });

  it('keeps the four-paper collaboration benchmark and its control workflow durable', () => {
    for (const slideId of ['slide-srns', 'slide-siren', 'slide-lfns', 'slide-metasdf']) {
      expect(paperServeSource).toContain(`'${slideId}'`);
    }
    expect(paperPrompt).toContain('one complete four-slide HTML document');
    expect(paperPrompt).toContain('Do not optimize');
    expect(paperPrompt).toContain('native conversion in this first draft');
    expect(paperPrompt).toContain('Apply all four replacements atomically');
    expect(paperPrompt).toContain('initial and final draft IDs');
  });
});
