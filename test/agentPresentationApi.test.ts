import { describe, expect, it, vi } from 'vitest';
import {
  callPresentationApi,
  PRESENTATION_API_TOOL,
} from '../src/main/agentPresentationApi.js';
import type { DynamicToolCall } from '../src/main/codexAppServer.js';

function call(arguments_: unknown): DynamicToolCall {
  return {
    threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', namespace: null,
    tool: PRESENTATION_API_TOOL.name,
    arguments: arguments_,
  };
}

describe('embedded Agent presentation API tool', () => {
  it('scopes JSON requests to the open deck and live local server', async () => {
    const requested: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requested.push({ url: String(input), init });
      return new Response(JSON.stringify({ revision: 'r1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await callPresentationApi(
      call({ path: '/api/preview-html?deck=wrong', method: 'POST', body: { html: '<section />' } }),
      { port: 6123, deckPath: '/decks/My Talk' },
      fetcher as typeof fetch,
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(requested[0]?.url).toBe('http://127.0.0.1:6123/api/preview-html?deck=My+Talk');
    expect(requested[0]?.init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ html: '<section />' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(result.success).toBe(true);
    expect(result.contentItems[0]).toMatchObject({ type: 'inputText' });
  });

  it('returns rendered PNGs directly to the model', async () => {
    const fetcher = vi.fn(async () => new Response(Uint8Array.from([137, 80, 78, 71]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));
    const result = await callPresentationApi(
      call({ path: '/api/render-slide.png?slideId=s1' }),
      { port: 6123, deckPath: '/decks/talk' },
      fetcher as typeof fetch,
    );

    expect(result.contentItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'inputImage', imageUrl: expect.stringMatching(/^data:image\/png;base64,/) }),
    ]));
  });

  it('does not become an arbitrary localhost or session-control primitive', async () => {
    const fetcher = vi.fn();
    await expect(callPresentationApi(
      call({ path: '/api/end', method: 'POST' }),
      { port: 6123, deckPath: '/decks/talk' },
      fetcher as typeof fetch,
    )).rejects.toThrow('does not expose POST /api/end');
    await expect(callPresentationApi(
      call({ path: 'http://127.0.0.1:9999/api/context' }),
      { port: 6123, deckPath: '/decks/talk' },
      fetcher as typeof fetch,
    )).rejects.toThrow('relative /api');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
