/**
 * Field names this format has retired, mapped to the name in use today.
 *
 * Renaming a persisted field is cheap in code and expensive in the wild: decks
 * already saved to disk, HTML sources written by hand, and agent requests
 * composed against an older brief all keep the old spelling. So no reader
 * knows about any particular rename — every entry point that takes data from
 * outside the process canonicalises through this table, and the next rename is
 * one row here plus a sweep of the current names in code.
 *
 * The `magicMove*` row retired in 2026-09, when Magic Move became Morph.
 */
export const RETIRED_FIELD_NAMES: Readonly<Record<string, string>> = {
  magicMove: 'morph',
  magicMoveId: 'morphId',
  magicMoveFromPrevious: 'morphFromPrevious',
  magicMoveDuration: 'morphDuration',
  magicMoveEasing: 'morphEasing',
};

/** The current spelling of `name`, which is `name` itself unless it is retired. */
export function canonicalFieldName(name: string): string {
  return RETIRED_FIELD_NAMES[name] ?? name;
}

/** The current spelling of a dotted edit path, segment by segment. */
export function canonicalFieldPath(path: string): string {
  return path.split('.').map(canonicalFieldName).join('.');
}

/**
 * A copy of `value` with every retired object key renamed. Arrays and plain
 * objects are walked; anything else is returned as-is. An object that already
 * carries the current name keeps it — a retired duplicate never wins.
 */
export function renameRetiredFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => renameRetiredFields(item)) as unknown as T;
  if (!value || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    const name = canonicalFieldName(key);
    if (name !== key && Object.prototype.hasOwnProperty.call(source, name)) continue;
    result[name] = renameRetiredFields(entry);
  }
  return result as T;
}

/**
 * `data-magic-move-duration=` → `data-morph-duration=`, for every retired
 * name. Hand-authored HTML outlives a rename the same way saved decks do, and
 * the walker that reads these attributes is stringified into the measuring
 * page and so cannot import this table — the authoring page is normalised on
 * the way in instead.
 */
export function renameRetiredDataAttributes(html: string): string {
  let result = html;
  for (const [retired, current] of Object.entries(RETIRED_FIELD_NAMES)) {
    // The `=` lookahead keeps `data-magic-move` from eating the prefix of
    // `data-magic-move-duration`, whichever order the entries come in. HTML
    // attribute names are case-insensitive, so the match is too.
    result = result.replace(new RegExp(`\\bdata-${kebabCase(retired)}(?==)`, 'gi'), `data-${kebabCase(current)}`);
  }
  return result;
}

function kebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
