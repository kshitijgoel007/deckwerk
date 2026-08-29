import { describe, expect, it } from 'vitest';
import { AgentVisualPolicy } from '../src/main/agentVisualPolicy.js';

describe('embedded-agent visual policy', () => {
  it('normalizes all draft render variants to one comparison capture', () => {
    const policy = new AgentVisualPolicy();
    const origin = 'http://127.0.0.1:5800';
    const first = policy.decide('turn-1', new URL(`${origin}/api/html-drafts/d1/source/slide-1.png?deck=talk`), origin);
    expect(first.url.pathname).toBe('/api/html-drafts/d1/compare');
    expect(first.canonicalized).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(policy.decide('turn-1', new URL(`${origin}/api/html-drafts/d1/imported?deck=talk`), origin).duplicate).toBe(true);
  });

  it('suppresses an identical player capture only within the same turn', () => {
    const policy = new AgentVisualPolicy();
    const url = new URL('http://127.0.0.1:5800/present.html?deck=talk&slide=2&agent=1');
    expect(policy.decide('turn-1', url).duplicate).toBe(false);
    expect(policy.decide('turn-1', url).duplicate).toBe(true);
    expect(policy.decide('turn-2', url).duplicate).toBe(false);
  });

  it('collapses native before and after routes onto one comparison', () => {
    const policy = new AgentVisualPolicy();
    const origin = 'http://127.0.0.1:5800';
    const before = policy.decide('turn-1', new URL(`${origin}/api/edit-drafts/n1/before?deck=talk&slideId=s1`), origin);
    expect(before.url.href).toBe(`${origin}/api/edit-drafts/n1/compare?deck=talk`);
    expect(policy.decide('turn-1', new URL(`${origin}/api/edit-drafts/n1/after?deck=talk`), origin).duplicate).toBe(true);
  });
});
