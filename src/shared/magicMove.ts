import type { SlideElement } from './deck.js';

export type MagicMovePair = [SlideElement, SlideElement];

/**
 * Objects that are already visually identical need neither an explicit pair
 * nor an animation. Matching them keeps the target render continuously visible
 * while genuinely changed, unpaired objects switch on the timeline.
 */
export function unchangedMagicMovePairs(
  previous: SlideElement[],
  next: SlideElement[],
): MagicMovePair[] {
  const available = new Set(previous);
  const pairs: MagicMovePair[] = [];
  for (const target of next) {
    const signature = visualSignature(target);
    const source = [...available].find((candidate) => visualSignature(candidate) === signature);
    if (!source) continue;
    available.delete(source);
    pairs.push([source, target]);
  }
  return pairs;
}

/** Runtime matching is deliberately explicit: unpaired objects never animate. */
export function explicitMagicMovePairs(
  previous: SlideElement[],
  next: SlideElement[],
): MagicMovePair[] {
  const sources = new Map(
    previous.filter((element) => element.magicMoveId)
      .map((element) => [element.magicMoveId!, element]),
  );
  return next.flatMap((target): MagicMovePair[] => {
    if (!target.magicMoveId) return [];
    const source = sources.get(target.magicMoveId);
    return source ? [[source, target]] : [];
  });
}

/** Conservative heuristic suggestions used only when the author presses Auto-pair. */
export function suggestMagicMovePairs(
  previous: SlideElement[],
  next: SlideElement[],
): MagicMovePair[] {
  const alreadyPaired = new Set(explicitMagicMovePairs(previous, next).flat());
  const candidates: Array<{ source: SlideElement; target: SlideElement; score: number }> = [];
  for (const source of previous) {
    if (alreadyPaired.has(source)) continue;
    for (const target of next) {
      if (alreadyPaired.has(target)) continue;
      const score = similarity(source, target);
      if (score >= 55) candidates.push({ source, target, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const usedSource = new Set<string>();
  const usedTarget = new Set<string>();
  const pairs: MagicMovePair[] = [];
  for (const candidate of candidates) {
    if (usedSource.has(candidate.source.id) || usedTarget.has(candidate.target.id)) continue;
    usedSource.add(candidate.source.id);
    usedTarget.add(candidate.target.id);
    pairs.push([candidate.source, candidate.target]);
  }
  return pairs;
}

function similarity(a: SlideElement, b: SlideElement): number {
  if (a.type !== b.type) return 0;
  const identityA = a.lineageId ?? a.id;
  const identityB = b.lineageId ?? b.id;
  if (identityA === identityB) return 150;
  if (a.id === b.id) return 120;
  if (visualSignature(a) === visualSignature(b)) return 140;
  switch (a.type) {
    case 'text': {
      if (b.type !== 'text') return 0;
      const left = plainText(a.html);
      const right = plainText(b.html);
      if (left && left === right) return 110;
      const roleA = a.class.find((name) => name.startsWith('role-'));
      const roleB = b.class.find((name) => name.startsWith('role-'));
      return jaccard(left, right) * 75 + (roleA && roleA === roleB ? 30 : 0);
    }
    case 'image': return b.type === 'image' && a.src === b.src ? 110 : 0;
    case 'video': return b.type === 'video' && a.src === b.src ? 110 : 0;
    case 'shape': {
      if (b.type !== 'shape' || a.shape !== b.shape || a.fill !== b.fill ||
        a.stroke !== b.stroke || a.strokeWidth !== b.strokeWidth ||
        a.radius !== b.radius || a.path !== b.path ||
        a.arrowStart !== b.arrowStart || a.arrowEnd !== b.arrowEnd) return 0;
      const sizeDelta = Math.abs(Math.log(a.w / b.w)) + Math.abs(Math.log(a.h / b.h));
      const sizeScore = Math.max(0, 40 - sizeDelta * 100);
      const centerDistance = Math.hypot(
        a.x + a.w / 2 - (b.x + b.w / 2),
        a.y + a.h / 2 - (b.y + b.h / 2),
      );
      const positionScore = Math.max(0, 30 - centerDistance / 10);
      return 20 + sizeScore + positionScore;
    }
    case 'html': return b.type === 'html' && a.html === b.html ? 100 : 0;
    case 'unsupported':
      return b.type === 'unsupported' && a.originalType === b.originalType &&
        a.note === b.note ? 90 : 0;
  }
}

function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function jaccard(left: string, right: string): number {
  const a = new Set(left.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const b = new Set(right.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((word) => b.has(word)).length;
  return intersection / new Set([...a, ...b]).size;
}

function visualSignature(element: SlideElement): string {
  const {
    id: _id,
    magicMoveId: _magicMoveId,
    lineageId: _lineageId,
    ...visual
  } = element;
  return JSON.stringify(visual);
}
