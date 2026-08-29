import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { createDeck, loadDeck, saveDeck } from '../src/main/deckStore.js';
import { startCollabServer } from '../src/server/collabServer.js';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.log('eval:agent skipped: set OPENAI_API_KEY to run workspace-independent attempts.');
  process.exit(0);
}

const attempts = Math.max(1, Number(process.env.AGENT_EVAL_ATTEMPTS ?? 3));
const model = process.env.AGENT_EVAL_MODEL ?? 'gpt-5.6-terra';
const reasoningEffort = process.env.AGENT_EVAL_REASONING ?? 'low';
const promptVariants = ['api-led', 'budget-led', 'stop-led'] as const;
const root = resolve(process.env.AGENT_EVAL_OUTPUT ?? 'artifacts/agent-eval', new Date().toISOString().replace(/[:.]/g, '-'));
const clientDir = resolve('dist/collab');
if (!existsSync(join(clientDir, 'index.html'))) {
  throw new Error('The collaboration client is not built. Run npm run build:collab first.');
}

class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private constructor(private socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.on('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('Evaluation browser connection closed.'));
      this.pending.clear();
    });
  }
  static async connect(port: number): Promise<Cdp> {
    let pages: any[] = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[]; } catch { /* browser starting */ }
      if (pages[0]?.webSocketDebuggerUrl) break;
      await wait(200);
    }
    if (!pages[0]?.webSocketDebuggerUrl) throw new Error('Could not connect to evaluation browser.');
    const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
    await new Promise<void>((resolveOpen, reject) => { socket.once('open', resolveOpen); socket.once('error', reject); });
    const cdp = new Cdp(socket);
    await cdp.call('Page.enable'); await cdp.call('Runtime.enable');
    return cdp;
  }
  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Evaluation browser connection is not open.'));
    }
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression: string): Promise<unknown> {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'browser evaluation failed');
    return result.result?.value ?? result.result?.description ?? null;
  }
  async close(): Promise<void> { this.socket.close(); }
}

await mkdir(root, { recursive: true });

const summaries: unknown[] = [];
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const attemptDir = join(root, `attempt-${attempt}`);
  const decksDir = join(attemptDir, 'decks');
  const deckId = 'workspace-independent-benchmark';
  const deckDir = join(decksDir, deckId);
  await mkdir(attemptDir, { recursive: true });
  await seedBenchmark(deckDir);
  const server = await startCollabServer({
    rootDir: decksDir,
    hostedDeckId: deckId,
    agentMode: true,
    clientDir,
    host: '127.0.0.1',
    port: 0,
  });
  const debugPort = await freePort();
  const url = `http://127.0.0.1:${server.port}/?deck=${deckId}&name=Evaluation+Agent+${attempt}&agent=1`;
  const browser = launchBrowser(url, debugPort);
  let cdp: Cdp | null = null;
  try {
    cdp = await Cdp.connect(debugPort);
    const promptVariant = promptVariants[(attempt - 1) % promptVariants.length];
    const run = await runAttempt(cdp, attemptDir, attempt, url, promptVariant);
    const judge = await judgeScreenshots(attemptDir, run.artifacts);
    const deck = await loadDeck(deckDir);
    const comments = collectComments(deck);
    const summary = {
      attempt,
      promptVariant,
      model,
      reasoningEffort,
      workspaceIndependent: true,
      viewerOnly: true,
      initialSourceAccess: false,
      toolAccess: [
        'web_search', 'browser_navigate', 'browser_page_text', 'browser_list_media',
        'browser_import_asset', 'browser_screenshot', 'browser_wait',
        'agent_read_brief', 'agent_get_capabilities', 'agent_get_context', 'agent_list_comments', 'agent_preview_html',
        'agent_open_comparison', 'agent_apply_html', 'agent_add_comment', 'agent_resolve_comment',
        'agent_open_player',
      ],
      slides: deck.slides.map((slide, index) => ({ index: index + 1, id: slide.id, name: slide.name, elements: slide.elements.length })),
      unresolvedSeededComments: comments.filter((comment) => !comment.resolved && comment.author === 'Benchmark').length,
      usage: run.usage,
      workflowMetrics: run.metrics,
      estimatedTokenCostUsd: estimateCost(run.usage),
      latencyMs: run.latencyMs,
      finalText: run.finalText,
      artifacts: run.artifacts,
      screenshotJudge: judge,
    };
    summaries.push(summary);
    await writeFile(join(attemptDir, 'summary.json'), JSON.stringify(summary, null, 2));
  } finally {
    if (cdp) {
      await cdp.call('Browser.close').catch(() => {});
      await cdp.close().catch(() => {});
      await waitForExit(browser, 5_000);
    }
    if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGTERM');
    await server.close();
  }
}
await writeFile(join(root, 'summary.json'), JSON.stringify({ model, attempts: summaries }, null, 2));
console.log(`Workspace-independent evaluation artifacts: ${root}`);

async function seedBenchmark(deckDir: string): Promise<void> {
  const deck = await createDeck(deckDir, 'Source-blind agent benchmark');
  deck.slides = [
    benchmarkSlide('slide-vincent', 'Vincent introduction', 'Create an introduction slide for Vincent. Use his public biography and portrait from vincentsitzmann.com. Reply when verified, then resolve this comment.'),
    benchmarkSlide('slide-team-anchor', 'Scene Representation Group · section', 'Insert a new current-team slide immediately after this anchor. Use ten names and portraits from scenerepresentations.org/people/. Keep this anchor slide. Reply with any missing source, then resolve this comment.'),
    benchmarkSlide('slide-timeline', 'Research timeline', 'Create a visual timeline for SRNs, SIREN, Neural Descriptor Fields, pixelSplat, Diffusion Forcing, and MilliVid. Use publication media where available. Verify the real player, then resolve this comment.'),
  ];
  await saveDeck(deckDir, deck);
}

function promptVariantInstruction(variant: typeof promptVariants[number]): string {
  if (variant === 'api-led') {
    return 'Treat workflow.state, blockingIssues, comparisonUrl, playerUrls, and stopCondition as executable API instructions.';
  }
  if (variant === 'budget-led') {
    return 'Optimize for the smallest complete trace: one asset import per asset, one full draft unless blocked, one comparison, one apply, and one player check.';
  }
  return 'At each successful milestone ask whether the documented stop condition is satisfied; once it is, return the final record immediately.';
}

function benchmarkSlide(id: string, name: string, instruction: string) {
  return {
    id, name, notes: '', background: { color: null, image: null }, elements: [], timeline: [],
    comments: [{ id: `comment-${id}`, author: 'Benchmark', text: instruction, ts: new Date().toISOString(), resolved: false }],
  };
}

async function runAttempt(
  cdp: Cdp,
  attemptDir: string,
  attempt: number,
  url: string,
  promptVariant: typeof promptVariants[number],
) {
  const prompt = `You are a presentation designer working through a hosted slide-editing session. Do not assume a repository checkout, working directory, CLI, or filesystem access. The app may provide any useful authoring information through its documented tools.
Use only web search and the named browser and presentation API tools. Open ${url}. Read the agent brief and all open comments through the API tools. The app page is a read-only real-player viewer; do not look for authoring controls.
Complete the three requested slides as beautiful, independent 1920×1080 HTML/CSS designs. Use public facts and media from vincentsitzmann.com and scenerepresentations.org. Import public images with browser_import_asset. Give every section a data-name. Preview before apply.

VISUAL VERIFICATION IS MANDATORY, AND THE API DEFINES THE FAST PATH. Create one complete draft. Read its workflow. If blocked, fix only the listed blocking issues and preview the complete draft again. If ready, open comparisonUrl once and take one screenshot of the side-by-side Source / Imported view. Do not open alternate source, imported, PNG, contact-sheet, or scratchpad routes when that comparison is correct. Apply once, open one playerUrl returned by apply, and take one final screenshot. A successful apply plus one correct real-player screenshot is the stopping condition. Do not continue checking after it passes. If the supported comparison itself is unavailable, stop as blocked rather than generating experimental drafts.

Prompt variant: ${promptVariant}. ${promptVariantInstruction(promptVariant)}

MECHANICAL SUCCESS IS NOT DESIGN SUCCESS. Before applying, turn each request into a content inventory and verify every item in the screenshots. The team slide must contain ten current lab members excluding Vincent, with ten distinct portraits. The timeline must include all six named papers and meaningful publication media or thumbnails for every paper where media is publicly available; a bare line of labels is incomplete. Reject an incomplete, generic, or overly sparse composition even when the importer reports no errors. State the completed inventory in your final record.

Prefer flat styled text elements over nested tags such as <b>. Apply without duplication. Reply to and resolve every seeded comment only after the final real-player screenshot passes. Resolve any reply comments you create so the completed thread does not remain open.
The Vincent and timeline placeholders must be replaced. The team slide must be inserted immediately after its anchor slide. If new visual feedback appears after an apply, inspect it, revise the affected slide, verify it again, reply, and resolve it.
Do not ask for repository access. Keep a concise final record of changes and any importer fallback.`;
  await writeFile(join(attemptDir, 'prompt.txt'), prompt);
  const tools = [
    { type: 'web_search' },
    fnTool('browser_navigate', 'Open the presentation app or a public HTTP(S) research page. Local app source and bundle URLs are blocked.', { url: { type: 'string' } }, ['url']),
    fnTool('browser_page_text', 'Read the visible text of the current browser page.', {}, []),
    fnTool('browser_list_media', 'List image and video URLs, labels, and dimensions from the current public page.', {}, []),
    fnTool('browser_import_asset', 'Download one public image or video URL into the open deck. Returns a deck-relative asset path for HTML.', { url: { type: 'string' }, name: { type: 'string' } }, ['url', 'name']),
    fnTool('agent_read_brief', 'Read the app-provided HTML-first authoring instructions.', {}, []),
    fnTool('agent_get_capabilities', 'Request the app’s documented feature examples and HTML/data-attribute capabilities. Pass an empty list for all capabilities.', {
      only: { type: 'array', items: { type: 'string' } },
    }, ['only']),
    fnTool('agent_get_context', 'Read the deck outline, canvas, current revision, and open-comment counts. Raw deck data is not exposed.', {}, []),
    fnTool('agent_list_comments', 'List presentation comments.', { filter: { type: 'string', enum: ['open', 'all', 'resolved'] } }, ['filter']),
    fnTool('agent_preview_html', 'Compile complete HTML/CSS without changing the deck. Use replace for placeholders and insert for the requested team slide.', {
      html: { type: 'string' }, mode: { type: 'string', enum: ['insert', 'replace'] },
      after_slide_id: { type: 'string' }, slide_ids: { type: 'array', items: { type: 'string' } },
    }, ['html', 'mode', 'after_slide_id', 'slide_ids']),
    fnTool('agent_open_comparison', 'Open the one supported side-by-side Source / Imported comparison for an existing draft.', {
      draft_id: { type: 'string' },
    }, ['draft_id']),
    fnTool('agent_apply_html', 'Atomically apply a previewed draft with revision and idempotency protection.', {
      draft_id: { type: 'string' }, expected_revision: { type: 'string' }, idempotency_key: { type: 'string' }, label: { type: 'string' },
    }, ['draft_id', 'expected_revision', 'idempotency_key', 'label']),
    fnTool('agent_add_comment', 'Reply to a comment after implementing and verifying it. Use an empty parent_id only for a new comment.', {
      slide_id: { type: 'string' }, parent_id: { type: 'string' }, text: { type: 'string' },
    }, ['slide_id', 'parent_id', 'text']),
    fnTool('agent_resolve_comment', 'Resolve a completed comment after verification.', { comment_id: { type: 'string' } }, ['comment_id']),
    fnTool('agent_open_player', 'Open one exact real-player URL returned by apply for final visual verification.', { url: { type: 'string' } }, ['url']),
    fnTool('browser_screenshot', 'Capture the current browser viewport for visual inspection.', { label: { type: 'string' } }, ['label']),
    fnTool('browser_wait', 'Wait briefly for rendering or synchronization.', { milliseconds: { type: 'number', minimum: 0, maximum: 5000 } }, ['milliseconds']),
  ];
  const state: EvalToolState = {
    appUrl: new URL(url), drafts: new Map(), feedbackSeeded: false,
    comparedDrafts: new Set(), playerOpenedForApply: false,
    visualGeneration: 0, screenshotGeneration: -1,
    metrics: { previews: 0, comparisons: 0, applies: 0, playerChecks: 0, screenshots: 0, suppressedVisuals: 0 },
  };
  const toolLog: unknown[] = [];
  const artifacts: string[] = [];
  const usage = { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } };
  const start = Date.now();
  let response = await openai({ model, reasoning: { effort: reasoningEffort }, text: { verbosity: 'low' }, instructions: 'Use only the provided tools. The presentation tools are the complete supported interface. Never seek or infer hidden application internals.', input: prompt, tools });
  addUsage(usage, response.usage);
  for (let turn = 0; turn < 80; turn += 1) {
    const calls = (response.output ?? []).filter((item: any) => item.type === 'function_call');
    if (calls.length === 0) {
      const finalText = (response.output ?? []).flatMap((item: any) => item.content ?? []).filter((item: any) => item.type === 'output_text').map((item: any) => item.text).join('\n');
      await writeFile(join(attemptDir, 'tool-log.json'), JSON.stringify(toolLog, null, 2));
      await writeFile(join(attemptDir, 'final.txt'), finalText);
      return { finalText, usage, latencyMs: Date.now() - start, artifacts, metrics: state.metrics };
    }
    const outputs: any[] = [];
    for (const call of calls) {
      const args = JSON.parse(call.arguments || '{}');
      const result = await executeBrowserTool(cdp, call.name, args, attemptDir, artifacts, state);
      toolLog.push({ turn, call: call.name, args, result: result.summary });
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result.output) });
      if (result.image) {
        outputs.push({ role: 'user', content: [
          { type: 'input_text', text: `Browser screenshot: ${args.label || 'viewport'}` },
          { type: 'input_image', image_url: result.image },
        ] });
      }
    }
    response = await openai({ model, reasoning: { effort: reasoningEffort }, text: { verbosity: 'low' }, previous_response_id: response.id, input: outputs, tools });
    addUsage(usage, response.usage);
  }
  throw new Error('Source-blind attempt exceeded 80 browser turns.');
}

function fnTool(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: 'function', name, description, strict: true, parameters: { type: 'object', properties, required, additionalProperties: false } };
}

interface EvalToolState {
  appUrl: URL;
  drafts: Map<string, { comparison: string }>;
  feedbackSeeded: boolean;
  comparedDrafts: Set<string>;
  playerOpenedForApply: boolean;
  visualGeneration: number;
  screenshotGeneration: number;
  metrics: { previews: number; comparisons: number; applies: number; playerChecks: number; screenshots: number; suppressedVisuals: number };
}

async function executeBrowserTool(
  cdp: Cdp,
  name: string,
  args: any,
  dir: string,
  artifacts: string[],
  state: EvalToolState,
) {
  switch (name) {
    case 'browser_navigate': {
      const target = safeBrowserUrl(args.url, state);
      await cdp.call('Page.navigate', { url: target.href });
      await wait(700);
      state.visualGeneration += 1;
      return simple({ url: target.href });
    }
    case 'browser_page_text': return simple(await cdp.evaluate(
      `document.body?.innerText?.slice(0, 40000) || ''`));
    case 'browser_list_media': return simple(await cdp.evaluate(`(() => [
      ...document.querySelectorAll('img,video,source')
    ].slice(0, 120).map((node) => ({
      kind: node.tagName.toLowerCase(),
      url: node.currentSrc || node.src || node.getAttribute('src') || '',
      alt: node.alt || node.getAttribute('aria-label') || '',
      width: node.naturalWidth || node.videoWidth || node.clientWidth || 0,
      height: node.naturalHeight || node.videoHeight || node.clientHeight || 0
    })).filter((item) => item.url))()`));
    case 'browser_click': return simple(await cdp.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(args.selector)}); if (!node) throw new Error('selector not found'); node.click(); return true; })()`));
    case 'browser_type': return simple(await cdp.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(args.selector)}); if (!node) throw new Error('selector not found'); node.value = ${JSON.stringify(args.text)}; node.dispatchEvent(new Event('input', {bubbles:true})); node.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`));
    case 'browser_import_asset': {
      const source = publicAssetUrl(args.url);
      const downloaded = await fetch(source, { redirect: 'follow' });
      if (!downloaded.ok) throw new Error(`asset download failed: ${downloaded.status}`);
      const upload = appEndpoint(state, '/api/upload');
      upload.searchParams.set('name', args.name);
      const imported = await fetch(upload, { method: 'POST', body: Buffer.from(await downloaded.arrayBuffer()) });
      const value = await imported.json();
      if (!imported.ok) throw new Error(`asset import failed: ${JSON.stringify(value)}`);
      return simple(value);
    }
    case 'agent_read_brief': {
      const response = await fetch(appEndpoint(state, '/api/brief'));
      return simple(await response.text());
    }
    case 'agent_get_capabilities': {
      const endpoint = appEndpoint(state, '/api/capabilities');
      if (args.only.length > 0) endpoint.searchParams.set('only', args.only.join(','));
      const response = await fetch(endpoint);
      const value = await response.json();
      if (!response.ok) throw new Error(`Capabilities ${response.status}: ${JSON.stringify(value)}`);
      return simple(value);
    }
    case 'agent_get_context': return simple(await agentJson(state, '/api/context'));
    case 'agent_list_comments': {
      const value = await agentJson(state, '/api/comments') as { comments?: Array<{ resolved?: boolean }> };
      const comments = (value.comments ?? []).filter((comment) =>
        args.filter === 'all' || (args.filter === 'open' ? !comment.resolved : comment.resolved));
      return simple({ commentCount: comments.length, comments });
    }
    case 'agent_preview_html': {
      state.metrics.previews += 1;
      const target = htmlTarget(args);
      const value = await agentJson(state, '/api/preview-html', {
        method: 'POST', body: JSON.stringify({ html: args.html, target }),
      }) as { draftId: string; comparisonUrl: string };
      const comparison = appEndpoint(state, value.comparisonUrl);
      state.drafts.set(value.draftId, { comparison: comparison.href });
      return simple({ ...value, comparisonUrl: comparison.href });
    }
    case 'agent_open_comparison': {
      if (state.comparedDrafts.has(args.draft_id)) {
        state.metrics.suppressedVisuals += 1;
        return simple({ suppressed: true, reason: 'This draft comparison is already in model context.' });
      }
      state.metrics.comparisons += 1;
      const draft = state.drafts.get(args.draft_id);
      if (!draft) throw new Error('Unknown draft. Preview HTML first.');
      const url = draft.comparison;
      await cdp.call('Page.navigate', { url });
      await wait(700);
      state.comparedDrafts.add(args.draft_id);
      state.visualGeneration += 1;
      return simple({ url, view: 'source-imported-comparison' });
    }
    case 'agent_apply_html': {
      state.metrics.applies += 1;
      const value = await agentJson(state, '/api/apply-html', {
        method: 'POST',
        body: JSON.stringify({
          draftId: args.draft_id, expectedRevision: args.expected_revision,
          idempotencyKey: args.idempotency_key, label: args.label,
        }),
      }) as { slideIds?: string[]; playerUrls?: Array<{ url: string }> };
      state.playerOpenedForApply = false;
      if (!state.feedbackSeeded && value.slideIds?.includes('slide-vincent')) {
        const feedback = await agentJson(state, '/api/comments', {
          method: 'POST',
          body: JSON.stringify({
            slideId: 'slide-vincent', author: 'Benchmark',
            text: 'Visual feedback: make Vincent’s MIT affiliation and the lab’s research focus more prominent, then preview and verify the revision.',
          }),
        });
        state.feedbackSeeded = true;
        return simple({ ...value, visualFeedbackAdded: feedback });
      }
      return simple(value);
    }
    case 'agent_add_comment': return simple(await agentJson(state, '/api/comments', {
      method: 'POST', body: JSON.stringify({
        slideId: args.slide_id, parentId: args.parent_id || undefined,
        author: 'Blind Agent', text: args.text,
      }),
    }));
    case 'agent_resolve_comment': return simple(await agentJson(state, '/api/comments/resolve', {
      method: 'POST', body: JSON.stringify({ commentId: args.comment_id, resolved: true }),
    }));
    case 'agent_open_player': {
      if (state.metrics.applies === 0) throw new Error('Apply a verified draft before opening the final player.');
      if (state.playerOpenedForApply) {
        state.metrics.suppressedVisuals += 1;
        return simple({ suppressed: true, reason: 'The final player has already been opened for this apply. Stop if its screenshot passed.' });
      }
      state.metrics.playerChecks += 1;
      const target = safeBrowserUrl(args.url, state);
      await cdp.call('Page.navigate', { url: target.href });
      await wait(900);
      state.playerOpenedForApply = true;
      state.visualGeneration += 1;
      return simple({ url: target.href });
    }
    case 'browser_wait': await wait(Math.min(5000, Math.max(0, args.milliseconds))); return simple({ waited: args.milliseconds });
    case 'browser_screenshot': {
      if (state.screenshotGeneration === state.visualGeneration) {
        state.metrics.suppressedVisuals += 1;
        return simple({ suppressed: true, reason: 'This visual is already in model context. Navigate only when another documented check is required.' });
      }
      state.metrics.screenshots += 1;
      const capture = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = join(dir, `${String(artifacts.length + 1).padStart(3, '0')}-${safe(args.label || 'screenshot')}.png`);
      await writeFile(file, Buffer.from(capture.data, 'base64'));
      artifacts.push(basename(file));
      state.screenshotGeneration = state.visualGeneration;
      return { output: { saved: basename(file) }, summary: { saved: basename(file) }, image: `data:image/png;base64,${capture.data}` };
    }
    default: throw new Error(`Unknown browser tool ${name}`);
  }
}

function htmlTarget(args: any) {
  return args.mode === 'replace'
    ? { mode: 'replace', slideIds: args.slide_ids }
    : { mode: 'insert', afterSlideId: args.after_slide_id || null };
}

function appEndpoint(state: EvalToolState, path: string): URL {
  const url = new URL(path, state.appUrl.origin);
  url.searchParams.set('deck', state.appUrl.searchParams.get('deck') ?? '');
  return url;
}

async function agentJson(state: EvalToolState, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(appEndpoint(state, path), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`Presentation API ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

function safeBrowserUrl(raw: string, state: EvalToolState): URL {
  const url = new URL(raw, state.appUrl);
  if (url.origin !== state.appUrl.origin) return publicAssetUrl(url.href);
  const deck = state.appUrl.searchParams.get('deck') ?? '';
  const allowedAppPage = url.pathname === '/' && url.searchParams.get('deck') === deck;
  const allowedPlayer = url.pathname === '/present.html' && url.searchParams.get('deck') === deck;
  const allowedDraft = [...state.drafts.values()].some((draft) =>
    url.href === draft.comparison);
  if (!allowedAppPage && !allowedPlayer && !allowedDraft) {
    throw new Error('Local app source, bundle, and undocumented API navigation is blocked.');
  }
  return url;
}

function publicAssetUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('asset URL must use HTTP or HTTPS');
  const host = url.hostname.toLowerCase();
  const privateHost = host === 'localhost' || host === '::1' || host.startsWith('127.') || host.startsWith('10.')
    || host.startsWith('192.168.') || host.startsWith('169.254.')
    || /^172\.(1[6-9]|2\d|3[01])\./u.test(host);
  if (privateHost) throw new Error('asset URL must be public');
  return url;
}

async function judgeScreenshots(dir: string, artifacts: string[]) {
  const screenshots = artifacts.filter((name) => name.endsWith('.png')).slice(-8);
  if (screenshots.length === 0) {
    return { status: 'missing', reason: 'The author did not capture source/imported previews.' };
  }
  const content: any[] = [{
    type: 'input_text',
    text: 'You are a source-blind visual judge. You receive only screenshots from an HTML-slide import attempt. Identify paired SOURCE and IMPORTED views when present. Score visual hierarchy and source/import fidelity from 0 to 10. Report obvious clipping, broken assets, duplication, and whether the evidence is sufficient. Return compact JSON only.'
  }];
  for (const name of screenshots) {
    const bytes = await readFile(join(dir, name));
    content.push({ type: 'input_image', image_url: `data:image/png;base64,${bytes.toString('base64')}` });
  }
  const response = await openai({
    model,
    reasoning: { effort: 'low' },
    text: { verbosity: 'low', format: { type: 'json_object' } },
    input: [{ role: 'user', content }],
  });
  const raw = outputText(response);
  try { return { status: 'judged', model, result: JSON.parse(raw), usage: response.usage }; }
  catch { return { status: 'judged', model, result: raw, usage: response.usage }; }
}

function outputText(response: any): string {
  return (response.output ?? []).flatMap((item: any) => item.content ?? [])
    .filter((item: any) => item.type === 'output_text').map((item: any) => item.text).join('\n');
}

function simple(output: unknown) { return { output, summary: clip(output), image: null as string | null }; }
function clip(value: unknown) { const text = JSON.stringify(value); return text.length > 4000 ? `${text.slice(0, 4000)}…` : value; }
function safe(value: string) { return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '') || 'screenshot'; }
function wait(ms: number) { return new Promise((resolveWait) => setTimeout(resolveWait, ms)); }

function waitForExit(child: ChildProcess, timeout: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(false), timeout);
    child.once('exit', () => { clearTimeout(timer); resolveWait(true); });
  });
}

async function openai(body: unknown): Promise<any> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

function addUsage(total: any, next: any) {
  if (!next) return;
  total.input_tokens += next.input_tokens ?? 0;
  total.output_tokens += next.output_tokens ?? 0;
  total.input_tokens_details.cached_tokens += next.input_tokens_details?.cached_tokens ?? 0;
}
function estimateCost(usage: any) {
  const cached = usage.input_tokens_details.cached_tokens;
  const uncached = Math.max(0, usage.input_tokens - cached);
  return Number(((uncached * 0.2 + cached * 0.02 + usage.output_tokens * 1.2) / 1_000_000).toFixed(6));
}

function collectComments(deck: Awaited<ReturnType<typeof loadDeck>>) {
  return deck.slides.flatMap((slide) => [
    ...(slide.comments ?? []),
    ...slide.elements.flatMap((element) => element.comments ?? []),
  ]);
}

function launchBrowser(url: string, port: number): ChildProcess {
  const electron = createRequire(import.meta.url)('electron') as unknown as string;
  return spawn(electron, [resolve('scripts/eval-browser.cjs'), url, String(port)], { stdio: ['ignore', 'ignore', 'inherit'] });
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}
