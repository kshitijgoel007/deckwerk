import type { Comment, Deck } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import { setCommentAuthor } from '../editor/comments.js';
import type { EditorStore } from '../editor/store.js';

/**
 * The console API for agents joining a collab session: a small, documented
 * surface (`window.agent`) so an agent driving this page does not need to
 * reverse-engineer the store. GET /api/brief on the server describes it.
 */

export interface AgentCommentRow {
  /** 1-based slide number, so "go to slide N" needs no lookup. */
  slide: number;
  slideId: string;
  slideName: string;
  /** Set when the comment sits on an element rather than the slide. */
  elementId?: string;
  elementType?: string;
  id: string;
  author: string;
  text: string;
  ts: string;
  resolved: boolean;
}

export function installAgentApi(store: EditorStore, deckId: string): void {
  const seeComments = (): AgentCommentRow[] => {
    const rows: AgentCommentRow[] = [];
    const { deck } = store.get();
    deck.slides.forEach((slide, index) => {
      const base = { slide: index + 1, slideId: slide.id, slideName: slide.name };
      for (const comment of slide.comments ?? []) rows.push({ ...base, ...comment });
      for (const element of slide.elements) {
        for (const comment of element.comments ?? []) {
          rows.push({ ...base, elementId: element.id, elementType: element.type, ...comment });
        }
      }
    });
    return rows;
  };

  /** Find a comment by id anywhere in the deck and mutate it in a commit. */
  const withComment = (
    commentId: string,
    label: string,
    fn: (comment: Comment) => void,
  ): boolean => {
    let found = false;
    store.commit((deck) => {
      for (const slide of deck.slides) {
        for (const owner of [slide, ...slide.elements]) {
          const comment = owner.comments?.find((c) => c.id === commentId);
          if (comment) {
            fn(comment);
            found = true;
            return;
          }
        }
      }
    }, { label });
    return found;
  };

  window.agent = {
    /** Fetch the same onboarding text served at /api/brief. */
    brief: async (): Promise<string> => (await fetch('/api/brief')).text(),

    deckId,
    getDeck: (): Deck => store.get().deck,
    goToSlide: (n: number): void => store.selectSlide(n - 1),
    commit: (fn: (deck: Deck) => void, label = 'Agent edit'): void =>
      store.commit(fn, { label }),

    seeComments,

    addComment: (opts: { slideId?: string; elementId?: string; text: string }): string => {
      const comment: Comment = {
        id: makeId('comment'),
        author: agentName(),
        text: opts.text,
        ts: new Date().toISOString(),
        resolved: false,
      };
      store.commit((deck) => {
        for (const slide of deck.slides) {
          if (opts.elementId) {
            const element = slide.elements.find((e) => e.id === opts.elementId);
            if (element) {
              (element.comments ??= []).push(comment);
              return;
            }
          } else if (slide.id === opts.slideId) {
            (slide.comments ??= []).push(comment);
            return;
          }
        }
        throw new Error('addComment: no such slide/element');
      }, { label: 'Agent: add comment' });
      return comment.id;
    },

    resolveComment: (commentId: string): boolean =>
      withComment(commentId, 'Agent: resolve comment', (c) => {
        c.resolved = true;
      }),

    /** Upload media; returns {src, kind, width, height, duration}. */
    uploadAsset: async (
      name: string,
      data: Blob | ArrayBuffer,
    ): Promise<{ src: string; kind: string; width: number; height: number; duration: number }> => {
      const response = await fetch(
        `/api/upload?deck=${encodeURIComponent(deckId)}&name=${encodeURIComponent(name)}`,
        { method: 'POST', body: data },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error ?? `upload failed (${response.status})`);
      return result;
    },
  };

  // Make the brief discoverable by an agent that lands on the page cold.
  console.info(
    '[agent] This is a live collaborative slide editor. Read /api/brief '
    + '(or await window.agent.brief()) for how to edit; start with '
    + 'window.agent.seeComments().',
  );
}

/** The session display name, mirrored from the comments module default. */
let name = 'Agent';
export function setAgentName(value: string): void {
  if (value.trim()) name = value.trim();
  setCommentAuthor(value);
}
function agentName(): string {
  return name;
}

declare global {
  interface Window {
    agent: {
      brief: () => Promise<string>;
      deckId: string;
      getDeck: () => Deck;
      goToSlide: (n: number) => void;
      commit: (fn: (deck: Deck) => void, label?: string) => void;
      seeComments: () => AgentCommentRow[];
      addComment: (opts: { slideId?: string; elementId?: string; text: string }) => string;
      resolveComment: (commentId: string) => boolean;
      uploadAsset: (
        name: string,
        data: Blob | ArrayBuffer,
      ) => Promise<{ src: string; kind: string; width: number; height: number; duration: number }>;
    };
  }
}
