import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeAuthoredHtml } from '../src/shared/htmlSafety';

const fixtureDir = path.join(__dirname, 'fixtures', 'html-import');

describe('HTML importer fixture catalog', () => {
  const previous = globalThis.DOMParser;
  beforeEach(() => {
    globalThis.DOMParser = new JSDOM('').window.DOMParser;
  });
  afterEach(() => {
    globalThis.DOMParser = previous;
  });

  it('keeps the fidelity and safety cases available to the browser harness', () => {
    expect(fs.readdirSync(fixtureDir).filter((name) => name.endsWith('.html')).sort()).toEqual([
      'agent-paper-showcase.html',
      'agent-team.html',
      'agent-timeline.html',
      'agent-vincent.html',
      'grid-flex.html',
      'media-svg.html',
      'unsafe-malformed.html',
      'unsupported-css.html'
    ]);
  });

  it('keeps the professional agent drafts as self-contained 1920x1080 regressions', () => {
    for (const name of [
      'agent-vincent.html',
      'agent-team.html',
      'agent-timeline.html',
      'agent-paper-showcase.html',
    ]) {
      const html = fs.readFileSync(path.join(fixtureDir, name), 'utf8');
      expect(html).toContain('width:1920px');
      expect(html).toContain('height:1080px');
      expect(html).toContain('<section class="slide');
      for (const src of [...html.matchAll(/src="(assets\/[^"]+)"/g)].map((match) => match[1])) {
        const assetPath = src.replace(/[?#].*$/u, '');
        expect(fs.existsSync(path.join(fixtureDir, assetPath)), `${name}: ${src}`).toBe(true);
      }
    }
  });

  it('keeps the complete four-paper deck as one atomic multi-slide fixture', () => {
    const html = fs.readFileSync(path.join(fixtureDir, 'agent-paper-showcase.html'), 'utf8');
    expect(html.match(/<section class="slide/gu)).toHaveLength(4);
    for (const paper of [
      'Scene Representation Networks',
      'SIREN',
      'Light Field Networks',
      'MetaSDF',
    ]) expect(html).toContain(paper);
    expect(html.match(/<video /gu)).toHaveLength(4);
    expect(html).toContain('$$\\Phi:');
  });

  it('sanitizes the malformed fixture before measurement', () => {
    const input = fs.readFileSync(path.join(fixtureDir, 'unsafe-malformed.html'), 'utf8');
    const result = sanitizeAuthoredHtml(input);
    expect(result.html).not.toMatch(/<script|onclick|onerror|javascript:|https:\/\/example\.com\/live/iu);
    expect(result.report.removedScripts).toBe(1);
    expect(result.report.removedEventHandlers).toBe(2);
    expect(result.report.blockedUrls.length).toBeGreaterThanOrEqual(2);
  });
});
