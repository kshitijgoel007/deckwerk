export interface AgentVisualDecision {
  url: URL;
  key: string;
  duplicate: boolean;
  canonicalized: boolean;
}

/**
 * Keep visual evidence lean inside a Codex turn. Draft source/imported/PNG
 * variants all collapse onto the supported comparison page, and an identical
 * visual is only sent to model context once per turn.
 */
export class AgentVisualPolicy {
  private readonly seenByTurn = new Map<string, Set<string>>();

  decide(turnId: string, requested: URL, collaborationOrigin?: string): AgentVisualDecision {
    const url = new URL(requested.href);
    const original = url.href;
    if (collaborationOrigin && url.origin === collaborationOrigin) {
      const alternate = /^\/api\/html-drafts\/([^/]+)\/(?:source|imported)(?:\/.*)?$/.exec(url.pathname);
      if (alternate) url.pathname = `/api/html-drafts/${alternate[1]}/compare`;
      const nativeAlternate = /^\/api\/edit-drafts\/([^/]+)\/(?:before|after)$/.exec(url.pathname);
      if (nativeAlternate) {
        url.pathname = `/api/edit-drafts/${nativeAlternate[1]}/compare`;
        url.searchParams.delete('slideId');
      }
    }
    const key = visualKey(url);
    let seen = this.seenByTurn.get(turnId);
    if (!seen) {
      seen = new Set();
      this.seenByTurn.set(turnId, seen);
      while (this.seenByTurn.size > 128) {
        const oldest = this.seenByTurn.keys().next().value as string | undefined;
        if (!oldest) break;
        this.seenByTurn.delete(oldest);
      }
    }
    const duplicate = seen.has(key);
    if (!duplicate) seen.add(key);
    return { url, key, duplicate, canonicalized: url.href !== original };
  }
}

function visualKey(url: URL): string {
  const comparison = /^\/api\/html-drafts\/([^/]+)\/compare$/.exec(url.pathname);
  if (comparison) return `draft-comparison:${comparison[1]}`;
  const nativeComparison = /^\/api\/edit-drafts\/([^/]+)\/compare$/.exec(url.pathname);
  if (nativeComparison) return `native-comparison:${nativeComparison[1]}`;
  if (url.pathname === '/present.html') {
    return `live-player:${url.searchParams.get('deck') ?? ''}:${url.searchParams.get('slide') ?? ''}`;
  }
  const normalized = new URL(url.href);
  normalized.hash = '';
  normalized.searchParams.sort();
  return normalized.href;
}
