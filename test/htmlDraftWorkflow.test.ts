import { describe, expect, it } from 'vitest';
import { htmlDraftWorkflow } from '../src/server/htmlDraftWorkflow.js';

describe('HTML draft workflow decisions', () => {
  it('surfaces a tiny overflow as one local fix instead of a renderer investigation', () => {
    const workflow = htmlDraftWorkflow({
      overflows: [{
        slideId: 'slide-1', elementId: 'subtitle', overflowX: false, overflowY: true,
        beyond: { x: 0, y: 2 }, fittedFontSize: null,
      }],
    });

    expect(workflow).toMatchObject({
      state: 'blocked',
      nextAction: { action: 'revise-html' },
      blockingIssues: [{
        code: 'text-overflow', elementId: 'subtitle', beyond: { x: 0, y: 2 },
        message: expect.stringContaining('2px'),
        fix: expect.stringContaining('Do not debug media rendering'),
      }],
    });
  });

  it('makes a clean draft ready for one comparison and one final player check', () => {
    expect(htmlDraftWorkflow({})).toMatchObject({
      state: 'ready-to-apply',
      blockingIssues: [],
      nextAction: { action: 'inspect-comparison-once' },
      verificationPolicy: {
        draft: 'one-comparison-view',
        afterApply: 'one-real-player-check',
      },
    });
  });

  it('deduplicates the same blocked external asset', () => {
    const workflow = htmlDraftWorkflow({
      missingAssets: ['https://example.com/portrait.png'],
      blockedResources: ['https://example.com/portrait.png'],
    });
    expect(workflow.blockingIssues).toHaveLength(1);
  });
});
