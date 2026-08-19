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
}

export interface HtmlDraft {
  draftId: string;
  revision: string;
  sourceUrl: string;
  importedUrl: string;
  diffUrl: string | null;
  report: HtmlImportReport;
  slides?: Slide[];
  target: HtmlTarget;
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
      previewHtml: (request: { html: string; target?: HtmlTarget }) => Promise<HtmlDraft>;
      applyHtml: (request: { draftId: string; expectedRevision?: string; idempotencyKey: string; label?: string; target?: HtmlTarget }) => Promise<{ revision: string; slideIds: string[]; idempotent: boolean }>;
      renderSlide: (slideId: string) => string;
      uploadAsset: (name: string, data: Blob | ArrayBuffer) => Promise<{ src: string; kind: string; width: number; height: number; duration: number }>;
      getDeck: () => Deck; goToSlide: (number: number) => void;
    };
  }
}
