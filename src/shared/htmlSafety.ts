export interface HtmlSanitizationReport {
  removedScripts: number;
  removedEventHandlers: number;
  blockedUrls: string[];
  dataUrls: Array<{ mime: string; value: string }>;
}

/**
 * Sanitize a complete authored document before it enters the measuring frame.
 * Imported slides can use HTML, CSS, SVG, images, video, and CSS animation.
 * They cannot run JavaScript or fetch presentation-time external resources.
 */
export function sanitizeAuthoredHtml(source: string): {
  html: string;
  report: HtmlSanitizationReport;
} {
  const parser = new DOMParser();
  const document = parser.parseFromString(source, 'text/html');
  const report: HtmlSanitizationReport = {
    removedScripts: 0,
    removedEventHandlers: 0,
    blockedUrls: [],
    dataUrls: [],
  };

  for (const node of document.querySelectorAll('script, object, embed, iframe')) {
    report.removedScripts += 1;
    node.remove();
  }
  for (const node of document.querySelectorAll<HTMLElement>('*')) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) {
        node.removeAttribute(attribute.name);
        report.removedEventHandlers += 1;
        continue;
      }
      if (!['src', 'href', 'poster', 'xlink:href'].includes(name)) continue;
      const value = attribute.value.trim();
      if (/^javascript:/i.test(value)) {
        node.removeAttribute(attribute.name);
        report.blockedUrls.push(value);
      } else if (/^https?:/i.test(value)) {
        // A normal anchor is inert slide content. Media, styles, and SVG links
        // would fetch during authoring or presentation, so remove those.
        if (!(node.tagName.toLowerCase() === 'a' && name === 'href')) {
          node.removeAttribute(attribute.name);
          report.blockedUrls.push(value);
        }
      } else if (/^data:/i.test(value)) {
        const mime = /^data:([^;,]+)/i.exec(value)?.[1] ?? 'application/octet-stream';
        report.dataUrls.push({ mime, value });
      }
    }
  }

  for (const style of document.querySelectorAll('style')) {
    const original = style.textContent ?? '';
    style.textContent = original
      .replace(/@import\s+(?:url\()?\s*['"]?https?:[^;]+;/gi, (match) => {
        report.blockedUrls.push(match);
        return '/* external import removed */';
      })
      .replace(/url\(\s*(['"]?)https?:[^)]+\)/gi, (match) => {
        report.blockedUrls.push(match);
        return 'none';
      });
  }

  const doctype = document.doctype ? '<!doctype html>\n' : '';
  return { html: doctype + document.documentElement.outerHTML, report };
}

/**
 * Markup that may live inside a text box, dropped in from another
 * application's clipboard.
 *
 * A text box holds prose: paragraphs, lists, tables, inline runs, links and
 * embedded images. Everything else on the clipboard is either a document-level
 * artefact (`<meta>`, `<style>`, Word's conditional comments), a control that
 * cannot be edited as text, or an active element — and a pasted `<iframe>` or
 * remote `<img>` would be saved into the deck and fetched again every time the
 * slide is shown. Nodes that only wrap text are unwrapped so the words stay;
 * active ones are removed outright.
 */
const PASTE_REMOVED = 'script, style, link, meta, base, iframe, object, embed, form, input,'
  + ' textarea, select, button, noscript, template, audio, source, track, canvas, map, area';
const PASTE_UNWRAPPED = 'font, marquee, center, header, footer, nav, aside, main, article,'
  + ' section, figure, figcaption, label, fieldset, legend, video';

/** Tag-based inline formatting and the style-only span it canonicalizes to. */
const TAG_FORMAT_STYLES: Record<string, [string, string]> = {
  B: ['font-weight', '700'],
  STRONG: ['font-weight', '700'],
  I: ['font-style', 'italic'],
  EM: ['font-style', 'italic'],
  U: ['text-decoration-line', 'underline'],
};

export function sanitizePastedTextHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content;
  root.querySelectorAll(PASTE_REMOVED).forEach((node) => node.remove());
  // Innermost first, so nested wrappers all collapse in one pass.
  [...root.querySelectorAll<HTMLElement>(PASTE_UNWRAPPED)].reverse().forEach((node) => {
    node.replaceWith(...node.childNodes);
  });
  // Word namespace remnants (<o:p> and friends) are invisible plumbing.
  for (const node of [...root.querySelectorAll<HTMLElement>('*')].reverse()) {
    if (node.tagName.includes(':')) node.replaceWith(...node.childNodes);
  }
  // The editor writes inline formatting as style-only spans; readers accept
  // both dialects but the writers cancel rather than remove tag formatting,
  // so pasted <strong>/<em>/<u> accreted contradictory layers
  // (<strong><span style="font-weight:400">…) that no toggle could clean up.
  // Convert the tag dialect to the span dialect on the way in.
  for (const node of [...root.querySelectorAll<HTMLElement>('b, strong, i, em, u')].reverse()) {
    const [property, value] = TAG_FORMAT_STYLES[node.tagName]!;
    const span = document.createElement('span');
    for (const attribute of [...node.attributes]) {
      span.setAttribute(attribute.name, attribute.value);
    }
    if (!span.style.getPropertyValue(property)) span.style.setProperty(property, value);
    span.append(...node.childNodes);
    node.replaceWith(span);
  }
  // Word's pseudo-lists arrive as MsoListParagraph paragraphs whose "bullet"
  // is a literal glyph in the text. Strip the fake marker and the vendor
  // classes; the paragraphs stay paragraphs (the author can re-list them).
  for (const node of root.querySelectorAll<HTMLElement>('[class*="Mso"]')) {
    if (/MsoListParagraph/i.test(node.className)) {
      const marker = /^\s*(?:[·•§▪◦]\s*|o\s+)/u;
      const first = node.firstChild;
      if (first instanceof Text) {
        first.data = first.data.replace(marker, '');
        if (!first.data) first.remove();
      } else if (first instanceof HTMLElement && marker.test(first.textContent ?? '')
        && !(first.textContent ?? '').replace(marker, '').trim()) {
        first.remove();
      }
    }
    const kept = [...node.classList].filter((name) => !/^Mso/i.test(name));
    if (kept.length > 0) node.className = kept.join(' ');
    else node.removeAttribute('class');
  }
  // Vendor style declarations (mso-*) mean nothing outside Office and keep
  // resurfacing in later edits; drop them, keep the rest of the style.
  for (const node of root.querySelectorAll<HTMLElement>('[style*="mso-"]')) {
    for (let index = node.style.length - 1; index >= 0; index -= 1) {
      const property = node.style.item(index);
      if (property.startsWith('mso-')) node.style.removeProperty(property);
    }
    if (!node.getAttribute('style')?.trim()) node.removeAttribute('style');
  }
  for (const node of root.querySelectorAll<HTMLElement>('*')) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'contenteditable' || name === 'draggable') {
        node.removeAttribute(attribute.name);
        continue;
      }
      if (!['src', 'href', 'poster', 'xlink:href', 'srcset', 'background'].includes(name)) continue;
      const value = attribute.value.trim();
      const inertAnchor = node.tagName === 'A' && name === 'href' && /^https?:/i.test(value);
      if (/^(?:data|deck|asset):/i.test(value) || inertAnchor) continue;
      // Anything else would fetch while authoring or presenting.
      node.removeAttribute(attribute.name);
      if (node.tagName === 'IMG') node.remove();
    }
  }
  return template.innerHTML;
}
