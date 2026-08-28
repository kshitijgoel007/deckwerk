import { basename } from 'node:path';
import type { DynamicToolCall, DynamicToolResult } from './codexAppServer.js';

export const PRESENTATION_API_TOOL = {
  type: 'function',
  name: 'presentation_api',
  description: 'Call the deck-scoped DeckWerk presentation API. Use this for every presentation read, preview, apply, comment, asset import, and PNG render; the host supplies access to the live local slide server.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'A relative documented /api/... path, including any non-deck query parameters.',
      },
      method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
      body: {
        description: 'JSON-compatible request body, or a string for text/html and base64 uploads.',
      },
      contentType: {
        type: 'string',
        description: 'Optional request content type. Objects default to application/json.',
      },
      bodyEncoding: {
        type: 'string',
        enum: ['utf8', 'base64'],
        default: 'utf8',
        description: 'Decode a string body as base64 for binary uploads when requested.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
} as const;

const GET_ENDPOINTS = [
  /^\/api\/(?:brief|context|text|edit-schema|capabilities|inspect|comments|render-slide|render-slide\.png)$/,
  /^\/api\/edit-drafts\/[^/]+\/(?:before|after)$/,
  /^\/api\/html-drafts\/(?:latest|[^/]+\/(?:source|imported))$/,
  /^\/api\/html-drafts\/[^/]+\/(?:source|imported)\/(?:contact-sheet|slide-\d+)\.png$/,
];

const POST_ENDPOINTS = new Set([
  '/api/preview-edits',
  '/api/apply-edits',
  '/api/comments',
  '/api/comments/resolve',
  '/api/upload',
  '/api/import-url',
  '/api/preview-html',
  '/api/apply-html',
]);

export interface PresentationApiSession {
  port: number;
  deckPath: string;
}

/**
 * Give the sandboxed embedded agent a narrow bridge to the live slide server.
 *
 * The agent never chooses a host or deck: both come from the open desktop
 * session. It may only call the documented agent endpoints, so this does not
 * become a generic localhost request primitive.
 */
export async function callPresentationApi(
  call: DynamicToolCall,
  session: PresentationApiSession,
  fetchImpl: typeof fetch = fetch,
): Promise<DynamicToolResult> {
  if (call.tool !== PRESENTATION_API_TOOL.name) {
    throw new Error(`Unknown DeckWerk API tool: ${call.tool}`);
  }
  const args = record(call.arguments);
  if (typeof args.path !== 'string' || !args.path.startsWith('/api/')) {
    throw new Error('presentation_api requires a relative /api/... path');
  }
  if (args.path.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(args.path)) {
    throw new Error('presentation_api does not accept an absolute URL');
  }

  const method = args.method === undefined ? 'GET' : String(args.method).toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw new Error('presentation_api supports GET and POST');
  const origin = `http://127.0.0.1:${session.port}`;
  const url = new URL(args.path, origin);
  if (url.origin !== origin || !endpointAllowed(method, url.pathname)) {
    throw new Error(`presentation_api does not expose ${method} ${url.pathname}`);
  }
  url.searchParams.set('deck', basename(session.deckPath));

  const init: RequestInit = { method };
  if (method === 'POST') {
    const body = args.body;
    const encoding = args.bodyEncoding === 'base64' ? 'base64' : 'utf8';
    if (encoding === 'base64') {
      if (typeof body !== 'string') throw new Error('A base64 request body must be a string');
      init.body = Buffer.from(body, 'base64');
    } else if (typeof body === 'string') {
      init.body = body;
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const contentType = typeof args.contentType === 'string'
      ? args.contentType
      : typeof body === 'string' && url.pathname === '/api/preview-html'
        ? 'text/html; charset=utf-8'
        : 'application/json';
    init.headers = { 'content-type': contentType };
  }

  const response = await fetchImpl(url, init);
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().startsWith('image/')) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      success: response.ok,
      contentItems: [
        { type: 'inputText', text: JSON.stringify({ status: response.status, url: url.href, contentType }) },
        { type: 'inputImage', imageUrl: `data:${contentType.split(';')[0]};base64,${bytes.toString('base64')}` },
      ],
    };
  }

  const body = (await response.text()).slice(0, 250_000);
  return {
    success: response.ok,
    contentItems: [{
      type: 'inputText',
      text: JSON.stringify({ status: response.status, url: url.href, contentType, body }),
    }],
  };
}

function endpointAllowed(method: 'GET' | 'POST', pathname: string): boolean {
  return method === 'GET'
    ? GET_ENDPOINTS.some((pattern) => pattern.test(pathname))
    : POST_ENDPOINTS.has(pathname);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
