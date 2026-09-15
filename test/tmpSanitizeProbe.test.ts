// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { it } from 'vitest';
import { sanitizeAuthoredHtml } from '../src/shared/htmlSafety.js';
it('probe', () => {
  const html = readFileSync('/Users/vincentsitzmann/Documents/talks/Claude_test_deck/edit/study.html', 'utf8');
  const out = sanitizeAuthoredHtml(html);
  console.log('SECTIONS', JSON.stringify([...out.html.matchAll(/<section[^>]*>/g)].map((m) => m[0].slice(0, 120))));
  console.log('SCOPE', /slide-editor-scope:[^\s]+/.exec(out.html)?.[0].slice(0, 80));
  console.log('REPORT', JSON.stringify(out.report).slice(0, 200));
});
