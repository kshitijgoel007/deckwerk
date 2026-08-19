import { describe, expect, it } from 'vitest';
import { AGENT_BRIEF, agentClipboardPrompt, collaborationInviteUrl } from '../src/server/agentBrief.js';

describe('agent clipboard brief', () => {
  it('includes the live deck-scoped connection and both editing lanes without a concrete task', () => {
    const prompt = agentClipboardPrompt('http://10.0.0.4:5800/?deck=research&agent=1', 'research');
    expect(prompt).toContain('Session URL: http://10.0.0.4:5800/?deck=research&agent=1');
    expect(prompt).toContain('API origin: http://10.0.0.4:5800');
    expect(prompt).toContain('Deck ID: research');
    expect(prompt).toContain('Native edits — existing content and local changes');
    expect(prompt).toContain('HTML authoring — new slides and substantial redesigns');
    expect(prompt).toContain('The user will provide the concrete presentation task');
    expect(prompt).not.toContain('ten current lab members');
    expect(prompt).not.toContain('Scene Representation Networks');
  });

  it('documents the surgical discovery, preview, apply, and verification loop', () => {
    for (const endpoint of ['/api/text', '/api/edit-schema', '/api/inspect', '/api/preview-edits', '/api/apply-edits', '/api/render-slide']) {
      expect(AGENT_BRIEF).toContain(endpoint);
    }
    expect(AGENT_BRIEF).toContain("every slide's visible text");
    expect(AGENT_BRIEF).toMatch(/immediate preceding and\s+succeeding slides/);
    expect(AGENT_BRIEF).toMatch(/actually\s+look at all three/);
    expect(AGENT_BRIEF).toContain('progressively changing media');
    expect(AGENT_BRIEF).toContain("Never infer an image's content");
    expect(AGENT_BRIEF).toContain('Unmentioned properties and unrelated objects remain unchanged');
    expect(AGENT_BRIEF).toMatch(/new or\s+worsened overflow/);
    expect(AGENT_BRIEF).toContain('contentStyle.<css-property>');
    expect(AGENT_BRIEF).toContain('more expressive than the visible');
    expect(AGENT_BRIEF).toContain('data-player-ready="true"');
    expect(AGENT_BRIEF).toContain('neither remains in the unresolved set');
  });

  it('teaches both visual routes and the exact KaTeX convention', () => {
    expect(AGENT_BRIEF).toContain('browser_open');
    expect(AGENT_BRIEF).toContain('contact-sheet PNG');
    expect(AGENT_BRIEF).toContain('$f_\\theta(x)$');
    expect(AGENT_BRIEF).toContain('$$\\int p(x)\\,dx = 1$$');
    expect(AGENT_BRIEF).toContain('Never imitate equations with Unicode subscripts');
    expect(AGENT_BRIEF).not.toContain('Never install');
  });

  it('uses localhost for desktop agents and the LAN address for people', () => {
    const urls = ['http://127.0.0.1:5800/', 'http://10.0.0.4:5800/'];
    expect(collaborationInviteUrl(urls, 'research deck', true))
      .toBe('http://127.0.0.1:5800/?deck=research%20deck&agent=1');
    expect(collaborationInviteUrl(urls, 'research deck', false))
      .toBe('http://10.0.0.4:5800/?deck=research%20deck');
  });
});
