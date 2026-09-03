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
      'native-conversion.html',
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

  it('keeps the native-conversion fixture exercising every editable conversion', () => {
    // The eval asserts the *result* (no HTML fallback on either slide); this
    // asserts the fixture still contains the cases that make that meaningful,
    // so nobody quietly deletes the hard half and keeps the green tick.
    const html = fs.readFileSync(path.join(fixtureDir, 'native-conversion.html'), 'utf8');
    expect(html.match(/<section class="slide/gu)).toHaveLength(3);
    for (const primitive of ['<circle', '<rect', '<line', '<path']) {
      expect(html, primitive).toContain(primitive);
    }
    for (const construct of [
      'marker-end',          // an SVG arrow, which becomes a native arrow shape
      'class="frame"',       // a bordered frame folded onto the media it holds
      'class="portrait"',    // a circular frame, likewise
      '<video',
      '<table>',
      '<dl>',
      '::after',             // paint that exists only as a pseudo-element
      'border-left',         // a quotation rule
      'background-image',    // a photograph behind words
      'object-fit: cover',   // a picture framed by its window, i.e. cropped
      'object-position: 22% 50%',
      'object-position: left top',
      'object-position: 50% 18%',
      'box-shadow: 0 0 0 5px',  // a ring the picture must carry itself
      'border-radius: 50%',     // a round window
    ]) expect(html, construct).toContain(construct);
    // The cropped sources must not be square, or `object-position` would have
    // no slack to move the picture in and the case would test nothing.
    expect(html).toContain('assets/srns.b4339eea.jpg');
    expect(html).toContain('assets/millivid.e1d65fa5.jpg');
    for (const src of [...html.matchAll(/(?:src|url)\(?["']?(assets\/[^"')]+)/g)].map((m) => m[1])) {
      expect(fs.existsSync(path.join(fixtureDir, src)), src).toBe(true);
    }
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
