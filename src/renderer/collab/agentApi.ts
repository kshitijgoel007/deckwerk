import type { Deck, Slide } from '@shared/deck.js';
import { setCommentAuthor } from '../editor/comments.js';
import type { EditorStore } from '../editor/store.js';

/** HTML-first agent surface shared by automation and the visible workspace. */
export interface AgentCommentRow {
  slide: number; slideId: string; slideName: string;
  elementId?: string; elementType?: string;
  id: string; parentId?: string; author: string; text: string; ts: string; resolved: boolean;
}

export interface HtmlTarget {
  mode: 'insert' | 'replace';
  afterSlideId?: string | null;
  slideIds?: string[];
}

export interface HtmlImportReport {
  nativeObjectRatio: number;
  nativeObjects: number;
  fallbackObjects: number;
  fallbackReasons: string[];
  warnings: string[];
  missingAssets: string[];
  blockedResources: string[];
  extractedAssets: string[];
  overflows: unknown[];
  pixelDifference: number | null;
  tolerance: number;
  timingsMs?: { sanitize: number; compile: number; overflowCheck: number; total: number };
}

export interface HtmlDraft {
  draftId: string;
  revision: string;
  sourceUrl: string;
  importedUrl: string;
  comparisonUrl: string;
  diffUrl: string | null;
  report: HtmlImportReport;
  workflow: {
    state: 'blocked' | 'ready-to-apply';
    blockingIssues: Array<{
      code: string; message: string; fix: string; slideId?: string | null; elementId?: string | null;
    }>;
    nextAction: { action: 'revise-html' | 'inspect-comparison-once'; reason: string };
    verificationPolicy: { draft: string; afterApply: string; stopWhen: string };
  };
  slides?: Slide[];
  target: HtmlTarget;
}

export interface NativeEdit {
  target: 'deck' | 'slide' | 'element';
  slideId?: string;
  elementId?: string;
  expectedType?: 'text' | 'image' | 'video' | 'shape' | 'html' | 'unsupported';
  set?: Record<string, unknown>;
  unset?: string[];
}

export interface NativeEditDraft {
  draftId: string;
  revision: string;
  affectedSlideIds: string[];
  affectedElementIds: string[];
  comparisonUrl: string;
  beforeUrl: string;
  afterUrl: string;
  slides: Array<{ slideId: string; beforeUrl: string; afterUrl: string }>;
  report: { beforeOverflows: unknown[]; afterOverflows: unknown[]; newOrWorsenedOverflows: unknown[] };
}

export interface AgentApiOptions { theme: () => string }

export function installAgentApi(store: EditorStore, deckId: string, _options: AgentApiOptions): void {
  const deckUrl = (path: string): string => {
    const url = new URL(path, location.origin);
    url.searchParams.set('deck', deckId);
    return url.href;
  };
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(deckUrl(path), {
      ...init,
      headers: init?.body instanceof Blob || init?.body instanceof ArrayBuffer
        ? init.headers
        : { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error ?? `Request failed (${response.status})`);
    return value as T;
  };
  const listComments = async (filter: 'open' | 'all' | 'resolved' = 'open'): Promise<AgentCommentRow[]> => {
    const payload = await request<{ comments: AgentCommentRow[] }>('/api/comments');
    return payload.comments.filter((row) => filter === 'all' || (filter === 'open' ? !row.resolved : row.resolved));
  };
  const uploadAsset = async (assetName: string, data: Blob | ArrayBuffer) => {
    const url = new URL('/api/upload', location.origin);
    url.searchParams.set('deck', deckId);
    url.searchParams.set('name', assetName);
    const response = await fetch(url, { method: 'POST', body: data });
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error ?? `Upload failed (${response.status})`);
    return value as { src: string; kind: string; width: number; height: number; duration: number };
  };

  window.agent = {
    brief: async () => (await fetch('/api/brief')).text(),
    deckId,
    getContext: () => request('/api/context'),
    listComments,
    seeComments: () => listComments('all'),
    addComment: (body) => request('/api/comments', { method: 'POST', body: JSON.stringify({ ...body, author: agentName() }) }),
    resolveComment: (commentId) => request('/api/comments/resolve', { method: 'POST', body: JSON.stringify({ commentId, resolved: true }) }),
    reopenComment: (commentId) => request('/api/comments/resolve', { method: 'POST', body: JSON.stringify({ commentId, resolved: false }) }),
    editSchema: () => request('/api/edit-schema'),
    inspect: ({ slideIds = [], elementIds = [], all = false } = {}) => {
      const url = new URL('/api/inspect', location.origin);
      if (slideIds.length > 0) url.searchParams.set('slideIds', slideIds.join(','));
      if (elementIds.length > 0) url.searchParams.set('elementIds', elementIds.join(','));
      if (all) url.searchParams.set('all', '1');
      return request(`${url.pathname}${url.search}`);
    },
    previewEdits: (body) => request<NativeEditDraft>('/api/preview-edits', { method: 'POST', body: JSON.stringify(body) }),
    applyEdits: (body) => request('/api/apply-edits', { method: 'POST', body: JSON.stringify(body) }),
    previewHtml: (body) => request<HtmlDraft>('/api/preview-html', { method: 'POST', body: JSON.stringify(body) }),
    applyHtml: (body) => request('/api/apply-html', { method: 'POST', body: JSON.stringify(body) }),
    renderSlide: (slideId) => {
      const index = store.get().deck.slides.findIndex((slide) => slide.id === slideId);
      if (index < 0) throw new Error(`No slide ${slideId}`);
      return `${location.origin}/present.html?deck=${encodeURIComponent(deckId)}&slide=${index + 1}&agent=1`;
    },
    uploadAsset,
    getDeck: () => store.get().deck,
    goToSlide: (number) => store.selectSlide(number - 1),
  };
  console.info('[agent] HTTP-backed API ready. Read /api/brief, then get context and comments before authoring.');
}

let name = 'Agent';
export function setAgentName(value: string): void { if (value.trim()) name = value.trim(); setCommentAuthor(value); }
function agentName(): string { return name; }

declare global {
  interface Window {
    agent: {
      brief: () => Promise<string>; deckId: string; getContext: () => Promise<unknown>;
      listComments: (filter?: 'open' | 'all' | 'resolved') => Promise<AgentCommentRow[]>;
      seeComments: () => Promise<AgentCommentRow[]>;
      addComment: (request: { slideId?: string; elementId?: string; parentId?: string; text: string }) => Promise<unknown>;
      resolveComment: (id: string) => Promise<unknown>; reopenComment: (id: string) => Promise<unknown>;
      editSchema: () => Promise<unknown>;
      inspect: (request?: { slideIds?: string[]; elementIds?: string[]; all?: boolean }) => Promise<unknown>;
      previewEdits: (request: { expectedRevision?: string; edits: NativeEdit[] }) => Promise<NativeEditDraft>;
      applyEdits: (request: { draftId: string; expectedRevision?: string; idempotencyKey: string; label?: string }) => Promise<{ revision: string; slideIds: string[]; elementIds: string[]; idempotent: boolean }>;
      previewHtml: (request: { html: string; target?: HtmlTarget }) => Promise<HtmlDraft>;
      applyHtml: (request: { draftId: string; expectedRevision?: string; idempotencyKey: string; label?: string; target?: HtmlTarget }) => Promise<{
        revision: string; slideIds: string[]; idempotent: boolean;
        playerUrls: Array<{ slideId: string; url: string; pngUrl: string }>;
        stopCondition: string;
      }>;
      renderSlide: (slideId: string) => string;
      uploadAsset: (name: string, data: Blob | ArrayBuffer) => Promise<{ src: string; kind: string; width: number; height: number; duration: number }>;
      getDeck: () => Deck; goToSlide: (number: number) => void;
    };
  }
}
