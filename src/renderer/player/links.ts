/**
 * Links are authored slide content, so they must never replace the editor or
 * presentation document that happens to be rendering them.
 */
export function prepareSlideLinks(root: ParentNode): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    anchor.target = '_blank';
    const rel = new Set(anchor.rel.split(/\s+/).filter(Boolean));
    rel.add('noopener');
    anchor.rel = [...rel].join(' ');
  }

  // Sandboxed HTML elements use an open shadow root. querySelectorAll does not
  // cross that boundary, so prepare those authored links explicitly too.
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (element.shadowRoot) prepareSlideLinks(element.shadowRoot);
  }
}

/** Find an authored link even when the event crossed an HTML element's shadow root. */
export function slideLinkFromEvent(event: Event): HTMLAnchorElement | null {
  for (const target of event.composedPath()) {
    if (target instanceof HTMLAnchorElement && target.hasAttribute('href')) return target;
  }
  return event.target instanceof Element
    ? event.target.closest<HTMLAnchorElement>('a[href]')
    : null;
}

/** Activate a slide link explicitly when a host (the editor) owns pointer input. */
export function openSlideLinkInNewTab(
  event: Event,
  open: (url: string, target: string, features: string) => unknown = window.open.bind(window),
): boolean {
  const anchor = slideLinkFromEvent(event);
  if (!anchor) return false;
  event.preventDefault();
  open(anchor.href, '_blank', 'noopener');
  return true;
}
