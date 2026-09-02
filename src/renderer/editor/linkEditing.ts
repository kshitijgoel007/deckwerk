import { TYPING_STYLE_SENTINEL } from '@shared/paragraphs.js';

/**
 * Turning typed and pasted URLs into links, the way chat apps do it.
 *
 * Two gestures, both taken from Slack: pasting a URL while text is selected
 * makes that text the link, and typing a space or Return after a URL links
 * the URL you just finished typing. Nothing else creates a link on its own —
 * a URL sitting mid-sentence is left alone until the author ends it.
 *
 * Only `http(s)` and `www.` are recognized. Everything else the clipboard can
 * carry (`mailto:`, `file:`, custom schemes) is stripped from anchors by the
 * paste sanitizer, so linking it here would produce an anchor that silently
 * loses its href on the next paste round-trip.
 *
 * DOM-in, DOM-out like listEditing.ts: the live contenteditable surface is
 * what is being edited, and the caret has to survive the surgery.
 */

/** Blocks a link may never span; a link is an inline run inside one of them. */
const BLOCKS = 'p, div, li, ul, ol, table, tr, td, th, h1, h2, h3, h4, h5, h6,'
  + ' blockquote, pre, figure';

const WHITESPACE = /[\s ]/;

/** The href this text should link to, or null if it is not a URL. */
export function linkHrefForText(text: string): string | null {
  const candidate = text.trim();
  if (!candidate || WHITESPACE.test(candidate)) return null;
  // A scheme is only a link once it has a host: "https://" alone is not one.
  if (/^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i.test(candidate)) return candidate;
  if (/^www\.[^\s/?#.]+\.[^\s/?#.]+(?:[/?#]\S*)?$/i.test(candidate)) return `https://${candidate}`;
  return null;
}

/**
 * Drop the punctuation that ends the sentence rather than the URL.
 *
 * A closing bracket the URL opened itself stays (Wikipedia's
 * "…_(disambiguation)"); one that closes a bracket around the URL does not.
 */
function trimSentencePunctuation(text: string): string {
  let end = text.length;
  while (end > 0) {
    const char = text[end - 1]!;
    if ('.,;:!?\'"'.includes(char)) {
      end -= 1;
      continue;
    }
    const opening = ')]}'.includes(char) ? '([{'[')]}'.indexOf(char)]! : null;
    if (opening) {
      const head = text.slice(0, end);
      const opened = head.split(opening).length - 1;
      const closed = head.split(char).length - 1;
      if (closed > opened) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return text.slice(0, end);
}

/** The anchor around a node, if it lies inside the edited text. */
function enclosingAnchor(node: Node, body: HTMLElement): HTMLAnchorElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const anchor = element?.closest('a') ?? null;
  return anchor && body.contains(anchor) ? anchor : null;
}

function placeCaretAfter(node: Node, selection: Selection): Range {
  const caret = (node.ownerDocument ?? document).createRange();
  caret.setStartAfter(node);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  return caret;
}

/**
 * Make the selected text a link to `href` — the paste-over-a-selection
 * gesture. Returns the anchor, or null when the selection is not something a
 * single link can wrap (empty, spanning paragraphs, already a link).
 */
export function linkifySelection(
  body: HTMLElement,
  selection: Selection,
  href: string,
): HTMLAnchorElement | null {
  if (selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (range.collapsed || !body.contains(range.commonAncestorContainer)) return null;
  if (enclosingAnchor(range.startContainer, body)) return null;
  if (enclosingAnchor(range.endContainer, body)) return null;
  const preview = range.cloneContents();
  if (preview.querySelector(BLOCKS)) return null;
  if (!(preview.textContent ?? '').replaceAll(TYPING_STYLE_SENTINEL, '').trim()) return null;

  const doc = body.ownerDocument ?? document;
  const anchor = doc.createElement('a');
  anchor.setAttribute('href', href);
  const contents = range.extractContents();
  // Nested anchors are not expressible in HTML; the URL just pasted wins.
  for (const nested of [...contents.querySelectorAll('a')].reverse()) {
    nested.replaceWith(...nested.childNodes);
  }
  anchor.appendChild(contents);
  range.insertNode(anchor);
  placeCaretAfter(anchor, selection);
  return anchor;
}

/** A URL the caret has just finished typing, located but not yet linked. */
export type TypedLink = {
  node: Text;
  /** Offsets of the URL itself within `node`. */
  start: number;
  end: number;
  /** Where the caret sits now, so it can be put back after the surgery. */
  caret: number;
  href: string;
};

/**
 * Find the URL the caret has just typed past — called from the space that
 * ended it and from Return. Detection is separate from `applyTypedLink` so
 * the caller can seal the typed run into its own undo entry first.
 */
export function typedLinkAtCaret(
  body: HTMLElement,
  selection: Selection | null,
): TypedLink | null {
  if (!selection?.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (!(node instanceof Text) || !body.contains(node)) return null;
  if (enclosingAnchor(node, body)) return null;
  const caret = range.startOffset;
  const data = node.data;

  // Space arrives with the caret after it, Return with the caret on the URL's
  // last character; skipping the whitespace makes both see the same token.
  let end = caret;
  while (end > 0 && WHITESPACE.test(data[end - 1]!)) end -= 1;
  let start = end;
  while (start > 0 && !WHITESPACE.test(data[start - 1]!)) start -= 1;
  // A pending bold/italic run opens with an invisible sentinel; it is editor
  // plumbing at the head of the typed text, not part of the URL.
  while (start < end && data[start] === TYPING_STYLE_SENTINEL) start += 1;
  const token = data.slice(start, end);
  if (token.includes(TYPING_STYLE_SENTINEL)) return null;
  // The token may continue into the previous run (a URL typed half in bold).
  // What is in this node is then only its tail — and a truncated URL still
  // parses as one, so refuse rather than link the wrong address.
  if (start === 0) {
    const before = node.previousSibling?.textContent ?? '';
    if (before && !WHITESPACE.test(before[before.length - 1]!)) return null;
  }

  const text = trimSentencePunctuation(token);
  const href = linkHrefForText(text);
  if (!href) return null;
  return { node, start, end: start + text.length, caret, href };
}

/** Wrap a located URL in an anchor, leaving the caret where it was. */
export function applyTypedLink(link: TypedLink, selection: Selection): HTMLAnchorElement {
  const { node, start, end, caret } = link;
  const doc = node.ownerDocument ?? document;
  const url = start > 0 ? node.splitText(start) : node;
  const tail = end - start < url.data.length ? url.splitText(end - start) : null;
  const anchor = doc.createElement('a');
  anchor.setAttribute('href', link.href);
  url.replaceWith(anchor);
  anchor.appendChild(url);
  if (tail) {
    const range = doc.createRange();
    range.setStart(tail, Math.max(0, Math.min(caret - end, tail.data.length)));
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    placeCaretAfter(anchor, selection);
  }
  return anchor;
}
