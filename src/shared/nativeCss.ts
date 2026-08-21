import type { MediaEffect, SlideElement } from './deck.js';

export interface CssMediaBorder {
  width: number;
  color: string;
}

export type CssMediaRadius =
  | { borderRadius: number }
  | { maskShape: 'circle' };

/** CSS border declarations that paint the same thing as typed media borders. */
export function isMediaBorderPaint(property: string): boolean {
  return (property === 'border' || property.startsWith('border-'))
    && !property.includes('radius');
}

/**
 * Whether a native typed property is authoritative over the same raw CSS.
 *
 * Renderer, live canvas patching, and HTML export all consult this one rule so
 * an inspector edit cannot clear a property in one path and reveal it in
 * another.
 */
export function typedPropertyOwnsCss(element: SlideElement, property: string): boolean {
  if (element.type === 'shape') {
    if (isMediaBorderPaint(property)) return true;
    if (property === 'border-radius') return true;
  }
  if (element.type === 'image' || element.type === 'video') {
    if (isMediaBorderPaint(property) && element.borderWidth !== undefined) return true;
    if (
      property === 'border-radius'
      && (element.borderRadius !== undefined || element.maskShape !== undefined)
    ) return true;
  }
  if (
    property === 'filter'
    && (element.type === 'text' || element.type === 'image' || element.type === 'video')
    && element.effects !== undefined
  ) return true;
  return property === 'white-space' && element.type === 'text' && element.noWrap !== undefined;
}

/** CSS white-space values equivalent to the native no-wrap option. */
export function cssNoWrap(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'nowrap' || value?.trim().toLowerCase() === 'pre';
}

/** A uniform, solid CSS border representable by the media inspector. */
export function cssMediaBorder(style: Record<string, string>): CssMediaBorder | null {
  const shorthand = style.border?.trim() ?? '';
  const shorthandWidths = [...shorthand.matchAll(
    /(?:^|\s)([+-]?(?:\d+(?:\.\d*)?|\.\d+)px)(?=\s|$)/gi,
  )];
  if (!style['border-width'] && shorthandWidths.length !== 1) return null;
  const widthSpec = style['border-width']?.trim()
    || shorthandWidths[0]?.[1]
    || '';
  const kindSpec = style['border-style']?.trim()
    || shorthand.match(/(?:^|\s)(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)(?=\s|$)/i)?.[1]
    || '';
  const width = uniformPixelValue(widthSpec);
  if (width === null || width <= 0) return null;
  if (!kindSpec.split(/\s+/).every((kind) => kind.toLowerCase() === 'solid')) return null;

  const color = style['border-color']?.trim() || shorthand
    .replace(/(?:^|\s)[+-]?(?:\d+(?:\.\d*)?|\.\d+)px(?=\s|$)/i, ' ')
    .replace(/(?:^|\s)solid(?=\s|$)/i, ' ')
    .trim();
  return color ? { width, color } : null;
}

/** A CSS radius representable by either the radius field or circle mask. */
export function cssMediaRadius(value: string | undefined): CssMediaRadius | null {
  if (!value || value.includes('/')) return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length === 0 || parts.length > 4) return null;
  if (parts.every((part) => part === '50%')) return { maskShape: 'circle' };
  const radius = uniformPixelValue(value);
  return radius === null || radius < 0 ? null : { borderRadius: radius };
}

/** A CSS filter stack fully representable by native editable effects. */
export function cssVisualEffects(value: string | undefined): MediaEffect[] | null {
  if (!value || value.trim() === 'none') return null;
  const effects: MediaEffect[] = [];
  const matcher = /([a-z-]+)\(([^()]*)\)/gi;
  let cursor = 0;
  for (let match = matcher.exec(value); match; match = matcher.exec(value)) {
    if (value.slice(cursor, match.index).trim()) return null;
    cursor = matcher.lastIndex;
    const name = match[1].toLowerCase();
    const argument = match[2].trim();
    if (name === 'blur') {
      const radius = pixelValue(argument);
      if (radius === null || radius < 0 || radius > 200) return null;
      effects.push({ type: 'blur', radius });
    } else if (name === 'grayscale') {
      const amount = argument.endsWith('%')
        ? Number(argument.slice(0, -1)) / 100 : Number(argument);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1) return null;
      effects.push({ type: 'grayscale', amount });
    } else {
      return null;
    }
  }
  if (value.slice(cursor).trim() || effects.length === 0) return null;
  return effects;
}

function uniformPixelValue(value: string): number | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length === 0 || parts.length > 4) return null;
  const values = parts.map(pixelValue);
  if (values.some((part) => part === null)) return null;
  const numbers = values as number[];
  return numbers.every((part) => part === numbers[0]) ? numbers[0] : null;
}

function pixelValue(value: string): number | null {
  if (/^[+-]?(?:0+(?:\.0*)?|\.0+)$/.test(value)) return 0;
  const match = value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))px$/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}
