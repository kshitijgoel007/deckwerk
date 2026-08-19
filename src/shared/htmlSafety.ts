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
