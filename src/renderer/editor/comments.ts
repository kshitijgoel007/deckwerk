import type { Comment } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';

/**
 * Comment UI shared by the slide rail (slide comments) and the canvas
 * (element comments). Comments live in deck.json (`comments` arrays on slides
 * and elements) so they travel through the ordinary diff/merge machinery in a
 * collab session; this module is only presentation.
 */

/**
 * Display name stamped on new comments. The desktop app leaves the default;
 * the collab shell sets the session display name, so comments from a shared
 * session carry real authorship.
 */
let commentAuthor = 'You';

export function setCommentAuthor(name: string): void {
  if (name.trim()) commentAuthor = name.trim();
}

export function newComment(text: string): Comment {
  return {
    id: makeId('comment'),
    author: commentAuthor,
    text,
    ts: new Date().toISOString(),
    resolved: false,
  };
}

/** Unresolved-comment count; drives the indicator badges. */
export function openCount(comments: Comment[] | undefined): number {
  return (comments ?? []).filter((c) => !c.resolved).length;
}

export interface CommentsPopoverOptions {
  /** Anchor rectangle in viewport coordinates; the popover opens beside it. */
  anchor: DOMRect;
  title: string;
  comments: Comment[];
  onAdd: (text: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
}

/**
 * Open the comments popover. Singleton: opening a second one closes the
 * first, and any outside pointerdown dismisses it. The popover re-reads
 * nothing — the caller re-opens it (via the returned refresh) after commits,
 * with fresh comment data.
 */
export function openCommentsPopover(options: CommentsPopoverOptions): {
  refresh: (comments: Comment[]) => void;
  close: () => void;
} {
  closeCommentsPopover();

  const pop = document.createElement('div');
  pop.id = 'comments-popover';

  const render = (comments: Comment[]) => {
    pop.replaceChildren();

    const head = document.createElement('div');
    head.className = 'comments-title';
    head.textContent = options.title;
    pop.appendChild(head);

    const list = document.createElement('div');
    list.className = 'comments-list';
    if (comments.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'comments-empty';
      empty.textContent = 'No comments yet.';
      list.appendChild(empty);
    }
    for (const comment of comments) {
      const row = document.createElement('div');
      row.className = `comment${comment.resolved ? ' resolved' : ''}`;

      const meta = document.createElement('div');
      meta.className = 'comment-meta';
      const author = document.createElement('span');
      author.className = 'comment-author';
      author.textContent = comment.author || 'Unknown';
      const when = document.createElement('span');
      when.className = 'comment-when';
      when.textContent = formatWhen(comment.ts);
      meta.append(author, when);

      const body = document.createElement('div');
      body.className = 'comment-text';
      body.textContent = comment.text;

      const actions = document.createElement('div');
      actions.className = 'comment-actions';
      const resolve = document.createElement('button');
      resolve.textContent = comment.resolved ? 'Reopen' : 'Resolve';
      resolve.addEventListener('click', () =>
        options.onResolve(comment.id, !comment.resolved));
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.addEventListener('click', () => options.onDelete(comment.id));
      actions.append(resolve, del);

      row.append(meta, body, actions);
      list.appendChild(row);
    }
    pop.appendChild(list);

    const compose = document.createElement('div');
    compose.className = 'comment-compose';
    const input = document.createElement('textarea');
    input.placeholder = 'Add a comment…';
    input.rows = 2;
    const send = document.createElement('button');
    send.textContent = 'Comment';
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      options.onAdd(text);
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      // Enter posts; Shift+Enter makes a newline, matching every chat box.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
      e.stopPropagation();
    });
    compose.append(input, send);
    pop.appendChild(compose);
  };

  render(options.comments);
  document.body.appendChild(pop);

  // Beside the anchor, clamped to the viewport.
  const { anchor } = options;
  const rect = pop.getBoundingClientRect();
  let left = anchor.right + 8;
  if (left + rect.width > window.innerWidth - 8) left = anchor.left - rect.width - 8;
  left = Math.max(8, left);
  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - rect.height - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  const dismiss = () => closeCommentsPopover();
  setTimeout(() => document.addEventListener('pointerdown', dismiss), 0);
  pop.dataset.hasDismiss = 'true';
  activeDismiss = dismiss;

  pop.querySelector('textarea')?.focus();

  return {
    refresh: (comments) => {
      if (!pop.isConnected) return;
      render(comments);
    },
    close: closeCommentsPopover,
  };
}

let activeDismiss: (() => void) | null = null;

export function closeCommentsPopover(): void {
  document.getElementById('comments-popover')?.remove();
  if (activeDismiss) {
    document.removeEventListener('pointerdown', activeDismiss);
    activeDismiss = null;
  }
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
