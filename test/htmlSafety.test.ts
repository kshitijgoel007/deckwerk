import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeAuthoredHtml } from '../src/shared/htmlSafety.js';
import { ElementSchema } from '../src/shared/deck.js';

describe('HTML import safety and fallback compatibility', () => {
  const previous = globalThis.DOMParser;
  beforeEach(() => {
    globalThis.DOMParser = new JSDOM('').window.DOMParser;
  });
  afterEach(() => {
    globalThis.DOMParser = previous;
  });

  it('removes scripts, event handlers, JavaScript URLs, and external media', () => {
    const result = sanitizeAuthoredHtml(`<!doctype html><html><head>
      <style>@import url("https://bad.test/a.css"); .x{background:url(https://bad.test/a.png)}</style>
      </head><body><section class="slide" onclick="steal()">
      <script>steal()</script><img src="https://bad.test/photo.png" onerror="steal()">
      <a href="javascript:steal()">bad</a></section></body></html>`);

    expect(result.html).not.toMatch(/<script|onclick|onerror|javascript:/i);
    expect(result.html).not.toContain('https://bad.test/photo.png');
    expect(result.report.removedScripts).toBe(1);
    expect(result.report.removedEventHandlers).toBe(2);
    expect(result.report.blockedUrls.length).toBeGreaterThanOrEqual(3);
  });

  it('reports data URLs for extraction into deck assets', () => {
    const result = sanitizeAuthoredHtml('<section class="slide"><img src="data:image/png;base64,AAAA"></section>');
    expect(result.report.dataUrls).toEqual([{ mime: 'image/png', value: 'data:image/png;base64,AAAA' }]);
  });

  it('keeps old HTML elements unchanged and accepts isolated fallback fields', () => {
    const base = { id: 'html-1', type: 'html', x: 0, y: 0, w: 100, h: 100, rot: 0, z: 0, opacity: 1, class: [], style: {}, html: '<b>Hi</b>' };
    expect(ElementSchema.parse(base)).not.toHaveProperty('sandboxed');
    expect(ElementSchema.parse({ ...base, sandboxed: true, css: '.x{}', fallbackReason: 'table' }))
      .toMatchObject({ sandboxed: true, css: '.x{}', fallbackReason: 'table' });
  });
});
