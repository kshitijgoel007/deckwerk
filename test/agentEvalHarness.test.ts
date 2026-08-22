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
const playerReadinessSource = readFileSync(
  join(process.cwd(), 'src/renderer/collab/playerReadiness.ts'),
  'utf8',
);
const serverSource = readFileSync(join(process.cwd(), 'src/server/collabServer.ts'), 'utf8');
const paperServeSource = readFileSync(join(process.cwd(), 'scripts/serve-paper-benchmark.mts'), 'utf8');
const editServeSource = readFileSync(join(process.cwd(), 'scripts/serve-edit-benchmark.mts'), 'utf8');
const paperPrompt = readFileSync(
  join(process.cwd(), 'test/fixtures/agent-eval/paper-showcase-prompt.md'),
  'utf8',
);
const editPrompt = readFileSync(
  join(process.cwd(), 'test/fixtures/agent-eval/native-reformatting-prompt.md'),
  'utf8',
);
const cssLayoutPrompt = readFileSync(
  join(process.cwd(), 'test/fixtures/agent-eval/native-css-layout-prompt.md'),
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
    expect(briefSource).toContain("Open and screenshot every affected slide's Before and After URLs");
    expect(briefSource).toContain('Inventory every');
    expect(briefSource).toContain('A clean diagnostic report is not proof of task completion');
    expect(briefSource).toContain('Judge the real player');
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
    expect(presentSource).toContain('if (agentViewer) return;');
    expect(presentSource).toContain("new CustomEvent('slide-player-painted'");
    expect(presentSource).toContain('readiness.painting()');
    expect(playerReadinessSource).toContain("dataset.playerStatus = 'connecting'");
    expect(playerReadinessSource).toContain("dataset.playerReady = 'true'");
    expect(playerReadinessSource).toContain('this.options.requestFrame(() => this.options.requestFrame(');
    expect(workspaceSource).toContain("params.get('debug') !== '1'");
    expect(workspaceSource).toContain("request<HtmlDraft>('/api/preview-html'");
    expect(workspaceSource).toContain("request<{ slideIds: string[] }>('/api/apply-html'");
    expect(workspaceSource).toContain("request<{ src: string; kind: string }>('/api/import-url'");
    expect(workspaceSource).toContain('oldSide.hidden = true');
    expect(workspaceSource).toContain("oldSide.insertAdjacentElement('afterend', panel)");
    expect(workspaceSource).toContain("button('API brief'");
    expect(agentApiSource).toContain("previewHtml: (body) => request<HtmlDraft>('/api/preview-html'");
    expect(agentApiSource).toContain("previewEdits: (body) => request<NativeEditDraft>('/api/preview-edits'");
    expect(agentApiSource).toContain("applyEdits: (body) => request('/api/apply-edits'");
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

  it('keeps the all-hands native editing benchmark and prompt separation durable', () => {
    expect(editServeSource).toContain('2608_all_HANDS.key');
    expect(editServeSource).toContain('agentClipboardPrompt(agentUrl, deckId)');
    expect(editServeSource).toContain('# Concrete task');
    expect(editServeSource).toContain('general-prompt.txt');
    expect(editServeSource).toContain('combined-prompt.txt');
    expect(editPrompt).toContain('slides 2 through 8');
    expect(editPrompt).toMatch(/Do not rebuild or\s+replace slides through HTML/);
    expect(editPrompt).toContain('Avenir Next');
    expect(editPrompt).toContain('Right-align all seven titles');
    expect(editPrompt).toContain('Preserve all wording');
  });

  it('keeps the advanced CSS/layout task native, atomic, and visually verified', () => {
    expect(cssLayoutPrompt).toContain('Do not rebuild or replace any');
    expect(cssLayoutPrompt).toContain('contentStyle.<css-property>');
    expect(cssLayoutPrompt).toContain('maskShape: "circle"');
    expect(cssLayoutPrompt).toContain('8-pixel radius');
    expect(cssLayoutPrompt).toContain('one revision-bound native preview batch');
    expect(cssLayoutPrompt).toContain('verify every affected slide in the real player');
  });

  it('keeps the comment-driven media replacement benchmark durable', () => {
    expect(editServeSource).toContain('comment-media-replacement-prompt.md');
    expect(editServeSource).toContain('commentSlideIndex = commentMedia ? 3 : 1');
    expect(editServeSource).toContain('replace the low-resolution minecraft+noise grid');
    const prompt = readFileSync(
      join(process.cwd(), 'test/fixtures/agent-eval/comment-media-replacement-prompt.md'), 'utf8');
    expect(prompt).toContain('discover it through the comments API');
    expect(prompt).toMatch(/resolve the\s+original comment and your reply/);
    expect(prompt).toContain('Preview before applying');
  });
});
