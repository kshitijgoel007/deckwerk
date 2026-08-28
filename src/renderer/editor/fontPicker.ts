/**
 * Font-family picker for the inspector.
 *
 * A dropdown of the families actually installed on this machine (via the
 * Local Font Access API), with a read-only readout underneath showing the
 * fallback stack a viewer's machine will substitute when it doesn't have the
 * chosen family. The stored `font-family` value is always the chosen family
 * followed by that stack, so the deck keeps rendering sensibly everywhere.
 */

declare global {
  interface Window {
    queryLocalFonts?: (options?: { postscriptNames?: string[] }) =>
      Promise<Array<{ family: string }>>;
  }
}

/** Generic stacks, mirroring the system-first philosophy of fontSets.ts. */
const SANS_FALLBACK = ['Helvetica Neue', 'Inter', 'Segoe UI', 'system-ui', 'sans-serif'];
const SERIF_FALLBACK = ['Charter', 'Iowan Old Style', 'Georgia', 'Times New Roman', 'serif'];
const MONO_FALLBACK = ['SF Mono', 'JetBrains Mono', 'ui-monospace', 'Menlo', 'monospace'];

// "bookman", not "book": Book is a weight name (Avenir-Book, Futura Book).
const SERIF_HINTS = /serif|georgia|times|garamond|baskerville|charter|palatino|didot|caslon|bookman|minion|hoefler|iowan|cambria|constantia|utopia|century/i;
const MONO_HINTS = /mono|code|courier|consolas|menlo|monaco|inconsolata|hack|terminal|typewriter|fira ?code|source code/i;

/** The stack that stands in for `family` on machines that lack it. */
export function fallbackStackFor(family: string): string[] {
  if (MONO_HINTS.test(family) && !/sans/i.test(family)) {
    return MONO_FALLBACK.filter((f) => f.toLowerCase() !== family.toLowerCase());
  }
  if (SERIF_HINTS.test(family) && !/sans[- ]?serif|sans/i.test(family)) {
    return SERIF_FALLBACK.filter((f) => f.toLowerCase() !== family.toLowerCase());
  }
  return SANS_FALLBACK.filter((f) => f.toLowerCase() !== family.toLowerCase());
}

const quote = (f: string): string => (/[^a-zA-Z0-9-]/.test(f) ? `"${f}"` : f);

/** The full CSS value stored on the element for a chosen family. */
export function fontFamilyValue(family: string): string {
  return [family, ...fallbackStackFor(family)].map(quote).join(', ');
}

/** First family of a stored `font-family` value, unquoted. */
export function primaryFamily(value: string): string {
  return (value.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
}

/**
 * Fonts most machines have; probed via `document.fonts.check` when the Local
 * Font Access API is unavailable (the browser collab client, mostly).
 */
const PROBE_LIST = [
  'Arial', 'Avenir', 'Avenir Next', 'Baskerville', 'Charter', 'Comic Sans MS',
  'Courier New', 'Futura', 'Georgia', 'Gill Sans', 'Helvetica', 'Helvetica Neue',
  'Hoefler Text', 'Impact', 'Inter', 'Iowan Old Style', 'JetBrains Mono',
  'Menlo', 'Monaco', 'Optima', 'Palatino', 'Roboto', 'SF Mono', 'Segoe UI',
  'Source Code Pro', 'Times New Roman', 'Trebuchet MS', 'Verdana',
];

let cachedFamilies: string[] | null = null;

/**
 * Families installed on this machine, sorted and deduped. Cached for the
 * session — the list is large and the OS font set doesn't change mid-edit.
 */
export async function installedFontFamilies(): Promise<string[]> {
  if (cachedFamilies) return cachedFamilies;
  let families: string[] = [];
  try {
    if (window.queryLocalFonts) {
      const fonts = await window.queryLocalFonts();
      families = [...new Set(fonts.map((f) => f.family))];
    }
  } catch {
    // Permission denied or API unusable; fall through to probing.
  }
  if (families.length === 0) {
    families = PROBE_LIST.filter((f) => {
      try { return document.fonts.check(`16px "${f}"`); } catch { return false; }
    });
  }
  families.sort((a, b) => a.localeCompare(b));
  cachedFamilies = families;
  return families;
}

/**
 * The picker: a select of installed families plus a read-only line naming the
 * fallback families used where the chosen font isn't installed.
 *
 * `value` is the element's current `font-family` (may be a full stack, or ''
 * for the theme font); `themeValue` is the resolved theme stack shown when
 * that empty option is active; `mixed` renders a disabled "Mixed" entry on top.
 */
export function fontFamilyField(
  label: string,
  value: string,
  onChange: (cssValue: string) => void,
  options: { mixed?: boolean; emptyLabel?: string; themeValue?: string } = {},
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'font-family-field';
  const labelEl = document.createElement('label');
  labelEl.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const select = document.createElement('select');
  labelEl.append(span, select);

  const fallbackNote = document.createElement('output');
  fallbackNote.className = 'font-fallback-note';
  wrap.append(labelEl, fallbackNote);

  const current = options.mixed ? null : primaryFamily(value);

  const showFallback = (family: string | null): void => {
    if (!family) {
      fallbackNote.textContent = options.mixed && select.value === '__mixed__'
        ? 'Mixed fonts selected.'
        : 'Uses the theme’s font.';
      return;
    }
    fallbackNote.textContent =
      `Falls back to: ${fallbackStackFor(family).join(', ')}`;
  };

  const addOption = (v: string, text: string, disabled = false): HTMLOptionElement => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = text;
    opt.disabled = disabled;
    select.appendChild(opt);
    return opt;
  };

  if (options.mixed) addOption('__mixed__', 'Mixed', true);
  const themeFamily = primaryFamily(options.themeValue ?? '');
  addOption('', options.emptyLabel ?? (themeFamily ? `${themeFamily} (Theme)` : 'Theme font'));
  const placeholder = addOption('__loading__', 'Loading fonts…', true);

  select.value = options.mixed ? '__mixed__' : '';
  showFallback(current || null);

  void installedFontFamilies().then((families) => {
    placeholder.remove();
    const seen = new Set<string>();
    for (const family of families) {
      seen.add(family.toLowerCase());
      addOption(family, family);
    }
    if (current && !seen.has(current.toLowerCase())) {
      addOption(current, `${current} (not installed)`);
    }
    if (!options.mixed) select.value = current || '';
    showFallback(select.value && select.value !== '__mixed__' ? select.value : null);
  });

  select.addEventListener('change', () => {
    if (select.value === '__mixed__' || select.value === '__loading__') return;
    const family = select.value;
    showFallback(family || null);
    onChange(family ? fontFamilyValue(family) : '');
  });

  return wrap;
}
