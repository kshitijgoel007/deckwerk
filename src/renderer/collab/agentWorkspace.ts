import type { EditorStore } from '../editor/store.js';
import { button, helpButton } from '../editor/ui.js';
import type { AgentCommentRow, HtmlDraft, HtmlTarget } from './agentApi.js';

/** A server-backed workspace that replaces the inspector in agent sessions. */
export function installAgentWorkspace(store: EditorStore): void {
  const params = new URLSearchParams(location.search);
  if (params.get('agent') !== '1' || params.get('debug') !== '1') return;
  const deckId = params.get('deck') ?? '';
  if (!deckId) return;
  const author = params.get('name')?.trim() || 'Agent';

  document.body.classList.add('agent-session');
  const panel = document.createElement('aside');
  panel.id = 'agent-workspace';

  const head = document.createElement('header');
  const title = document.createElement('div');
  const heading = document.createElement('h2');
  heading.textContent = 'Agent workspace';
  const subtitle = document.createElement('p');
  subtitle.textContent = 'HTTP API first. Manual HTML and diagnostics are available here.';
  title.append(heading, subtitle);
  const collapse = button('Hide', () => {
    const collapsed = panel.classList.toggle('collapsed');
    document.body.classList.toggle('agent-workspace-collapsed', collapsed);
    collapse.textContent = collapsed ? 'Show agent workspace' : 'Hide';
  }, { variant: 'quiet' });
  const headActions = document.createElement('div');
  headActions.className = 'agent-head-actions';
  const apiBrief = button('API brief', () => {
    window.open(deckUrl('/api/brief'), '_blank', 'noopener');
  }, { variant: 'quiet' });
  headActions.append(apiBrief, helpButton({
    title: 'Agent HTML workflow',
    description: 'Programmatic agents can use the HTTP API. This pane is a manual client for the same endpoints.',
    firstAction: 'Read the API brief, then get the context and open comments.',
  }), collapse);
  head.append(title, headActions);

  const controls = document.createElement('div');
  controls.className = 'agent-controls';
  const targetMode = document.createElement('select');
  targetMode.innerHTML = '<option value="insert">Insert after</option><option value="replace">Replace</option>';
  targetMode.setAttribute('aria-label', 'Apply mode');
  const targetSlide = document.createElement('select');
  const syncTargetLabel = () => {
    targetSlide.setAttribute('aria-label', targetMode.value === 'replace' ? 'Replace slide' : 'Insert after slide');
  };
  targetMode.addEventListener('change', syncTargetLabel);
  syncTargetLabel();
  const syncTargets = () => {
    const current = targetSlide.value;
    const slides = store.get().deck.slides;
    targetSlide.replaceChildren();
    for (const [index, slide] of slides.entries()) {
      const option = document.createElement('option');
      option.value = slide.id;
      option.textContent = `${index + 1}. ${slide.name || slide.id}`;
      targetSlide.appendChild(option);
    }
    const fallback = store.slide?.id || targetSlide.options[0]?.value || '';
    targetSlide.value = slides.some((slide) => slide.id === current) ? current : fallback;
  };
  syncTargets();
  store.subscribe(syncTargets);
  const comments = button('Open comments', () => void toggleComments(), { variant: 'quiet' });
  controls.append(targetMode, targetSlide, comments);

  const commentList = document.createElement('div');
  commentList.className = 'agent-comment-list';
  commentList.hidden = true;

  const assets = document.createElement('div');
  assets.className = 'agent-assets';
  const assetUrl = document.createElement('input');
  assetUrl.type = 'url';
  assetUrl.placeholder = 'https://example.org/portrait.jpg';
  assetUrl.setAttribute('aria-label', 'Public asset URL');
  const assetName = document.createElement('input');
  assetName.placeholder = 'portrait.jpg (optional)';
  assetName.setAttribute('aria-label', 'Asset filename');
  const assetStatus = document.createElement('output');
  assetStatus.textContent = 'External URLs in HTML are blocked. Import them here first.';
  const importAsset = button('Import public asset', () => void importPublicAsset());
  assets.append(assetUrl, assetName, importAsset, assetStatus);

  const source = document.createElement('textarea');
  source.className = 'agent-html-source';
  source.spellcheck = false;
  source.setAttribute('aria-label', 'Manual authored slide HTML');
  source.placeholder = 'Optional manual client · programmatic agents POST HTML to /api/preview-html\n\n<!doctype html>\n<html>…<section class="slide">…</section>…</html>';

  const actions = document.createElement('div');
  actions.className = 'agent-actions';
  const status = document.createElement('span');
  status.textContent = 'No draft yet.';
  let currentDraft: HtmlDraft | null = null;
  const preview = button('Preview import', () => void previewSource(), { variant: 'primary' });
  const apply = button('Apply draft', () => void applyDraft());
  apply.disabled = true;
  actions.append(status, preview, apply);

  const views = document.createElement('div');
  views.className = 'agent-previews';
  const sourceFrame = previewFrame('Source');
  const importedFrame = previewFrame('Imported');
  views.append(sourceFrame.wrap, importedFrame.wrap);
  const diagnostics = document.createElement('pre');
  diagnostics.className = 'agent-diagnostics';
  diagnostics.textContent = 'Import diagnostics appear after preview.';

  panel.append(head, controls, commentList, assets, source, actions, views, diagnostics);
  const oldSide = document.getElementById('side');
  if (oldSide) {
    oldSide.hidden = true;
    oldSide.insertAdjacentElement('afterend', panel);
  }
  else document.getElementById('body')?.appendChild(panel);

  function target(): HtmlTarget {
    return targetMode.value === 'replace'
      ? { mode: 'replace', slideIds: [targetSlide.value] }
      : { mode: 'insert', afterSlideId: targetSlide.value };
  }

  async function previewSource(): Promise<void> {
    if (!source.value.trim()) return setStatus('Add HTML before previewing.', true);
    preview.disabled = true;
    setStatus('Measuring source HTML…');
    const requestedTarget = target();
    try {
      currentDraft = await request<HtmlDraft>('/api/preview-html', {
        method: 'POST', body: JSON.stringify({ html: source.value, target: requestedTarget }),
      });
      currentDraft.target = currentDraft.target ?? requestedTarget;
      sourceFrame.frame.src = deckUrl(currentDraft.sourceUrl);
      importedFrame.frame.src = deckUrl(currentDraft.importedUrl);
      diagnostics.textContent = JSON.stringify({
        workflow: currentDraft.workflow,
        importReport: currentDraft.report,
      }, null, 2);
      apply.disabled = currentDraft.workflow.state !== 'ready-to-apply';
      setStatus(currentDraft.workflow.state === 'ready-to-apply'
        ? `Draft ready · ${Math.round(currentDraft.report.nativeObjectRatio * 100)}% native objects · compare once, then apply`
        : currentDraft.workflow.nextAction.reason,
      currentDraft.workflow.state !== 'ready-to-apply');
    } catch (error) {
      currentDraft = null;
      apply.disabled = true;
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      preview.disabled = false;
    }
  }

  async function applyDraft(): Promise<void> {
    if (!currentDraft) return;
    const draft = currentDraft;
    apply.disabled = true;
    setStatus('Applying previewed draft to the shared deck…');
    try {
      const result = await request<{ slideIds: string[] }>('/api/apply-html', {
        method: 'POST',
        body: JSON.stringify({
          draftId: draft.draftId,
          expectedRevision: draft.revision,
          idempotencyKey: `workspace-${draft.draftId}`,
          label: `Agent: ${draft.target.mode === 'replace' ? 'replace' : 'insert'} HTML slide`,
          target: draft.target,
        }),
      });
      currentDraft = null;
      setStatus(`Applied ${result.slideIds.length} slide${result.slideIds.length === 1 ? '' : 's'} to the shared deck.`);
    } catch (error) {
      setStatus(`${error instanceof Error ? error.message : String(error)} Preview again before retrying.`, true);
      currentDraft = null;
    }
  }

  async function importPublicAsset(): Promise<void> {
    if (!assetUrl.value.trim()) {
      assetStatus.textContent = 'Enter a public HTTP or HTTPS asset URL.';
      return;
    }
    importAsset.disabled = true;
    assetStatus.textContent = 'Downloading and importing asset…';
    try {
      const imported = await request<{ src: string; kind: string }>('/api/import-url', {
        method: 'POST', body: JSON.stringify({ url: assetUrl.value.trim(), name: assetName.value.trim() || undefined }),
      });
      assetStatus.textContent = `Imported ${imported.kind}: ${imported.src} — use this deck-relative path in HTML.`;
    } catch (error) {
      assetStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      importAsset.disabled = false;
    }
  }

  async function toggleComments(): Promise<void> {
    if (!commentList.hidden) {
      commentList.hidden = true;
      comments.textContent = 'Open comments';
      return;
    }
    await renderComments();
  }

  async function renderComments(): Promise<void> {
    comments.disabled = true;
    try {
      const payload = await request<{ comments: AgentCommentRow[] }>('/api/comments');
      const rows = payload.comments.filter((row) => !row.resolved);
      commentList.replaceChildren();
      commentList.hidden = false;
      comments.textContent = 'Hide comments';
      if (rows.length === 0) {
        commentList.textContent = 'No open comments.';
        return;
      }
      for (const row of rows) commentList.appendChild(commentEditor(row));
    } catch (error) {
      commentList.hidden = false;
      commentList.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      comments.disabled = false;
    }
  }

  function commentEditor(row: AgentCommentRow): HTMLElement {
    const item = document.createElement('article');
    item.className = 'agent-comment';
    const navigate = document.createElement('button');
    navigate.type = 'button';
    navigate.className = 'agent-comment-context';
    navigate.textContent = `Slide ${row.slide} · ${row.author}: ${row.text}`;
    navigate.addEventListener('click', () => {
      window.agent.goToSlide(row.slide);
      targetSlide.value = row.slideId;
    });
    const reply = document.createElement('textarea');
    reply.rows = 2;
    reply.placeholder = 'Reply after implementing and verifying…';
    reply.setAttribute('aria-label', `Reply to comment on slide ${row.slide}`);
    const replyButton = button('Reply', () => void sendReply());
    const resolveButton = button('Resolve', () => void resolveComment(), { variant: 'quiet' });
    const rowActions = document.createElement('div');
    rowActions.append(replyButton, resolveButton);
    item.append(navigate, reply, rowActions);
    return item;

    async function sendReply(): Promise<void> {
      if (!reply.value.trim()) return;
      replyButton.disabled = true;
      try {
        await request('/api/comments', {
          method: 'POST',
          body: JSON.stringify({ slideId: row.slideId, parentId: row.id, author, text: reply.value.trim() }),
        });
        await renderComments();
      } finally {
        replyButton.disabled = false;
      }
    }

    async function resolveComment(): Promise<void> {
      resolveButton.disabled = true;
      try {
        await request('/api/comments/resolve', {
          method: 'POST', body: JSON.stringify({ commentId: row.id, resolved: true }),
        });
        await renderComments();
      } finally {
        resolveButton.disabled = false;
      }
    }
  }

  async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(deckUrl(path), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error ?? `Request failed (${response.status})`);
    return value as T;
  }

  function deckUrl(path: string): string {
    const url = new URL(path, location.origin);
    url.searchParams.set('deck', deckId);
    return url.href;
  }

  function setStatus(text: string, error = false): void {
    status.textContent = text;
    status.classList.toggle('error', error);
  }
}

function previewFrame(label: string): { wrap: HTMLElement; frame: HTMLIFrameElement } {
  const wrap = document.createElement('section');
  const heading = document.createElement('h3');
  heading.textContent = label;
  const frame = document.createElement('iframe');
  frame.title = `${label} slide preview`;
  frame.sandbox.add('allow-same-origin');
  wrap.append(heading, frame);
  return { wrap, frame };
}
