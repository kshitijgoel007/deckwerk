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
const SERIF_HINTS = /serif|georgia|times|garamond|baskerville|charter|palatino|didot|caslon|bookman|minion|hoefler|iowan|cambria|constantia|utopia|century|rockwell|slab|clarendon/i;
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
  'Arial', 'Avenir', 'Avenir Next', 'Avenir Next Condensed', 'Baskerville',
  'Charter', 'Comic Sans MS', 'Courier New', 'Futura', 'Georgia', 'Gill Sans',
  'Helvetica', 'Helvetica Neue', 'Hoefler Text', 'Impact', 'Inter',
  'Iowan Old Style', 'JetBrains Mono', 'Menlo', 'Monaco', 'Optima', 'Palatino',
  'Roboto', 'Roboto Slab', 'Rockwell', 'SF Mono', 'Segoe UI', 'Source Code Pro',
  'Source Sans 3', 'Source Sans Pro', 'Times New Roman', 'Trebuchet MS',
  'Verdana',
];

let cachedFamilies: string[] | null = null;

/**
 * Families installed on this machine, sorted and deduped. Cached for the
 * session — the list is large and the OS font set doesn't change mid-edit.
 */
/**
 * How long the picker waits for the Local Font Access API before it shows the
 * probed list instead. The API answers in milliseconds once permitted, but in
 * a window without focus (a second window, a busy machine, a test browser)
 * its permission prompt can sit unanswered indefinitely, and the dropdown
 * would say "Loading fonts…" for as long as it did.
 */
const LOCAL_FONTS_PATIENCE_MS = 1_500;

function probedFontFamilies(): string[] {
  return PROBE_LIST.filter((f) => {
    try { return document.fonts.check(`16px "${f}"`); } catch { return false; }
  });
}

export async function installedFontFamilies(): Promise<string[]> {
  if (cachedFamilies) return cachedFamilies;
  let families: string[] = [];
  if (window.queryLocalFonts) {
    const local = window.queryLocalFonts()
      .then((fonts) => [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b)))
      .catch((): string[] => []); // Permission denied or API unusable: probe instead.
    const patience = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), LOCAL_FONTS_PATIENCE_MS);
    });
    const answered = await Promise.race([local, patience]);
    if (answered) {
      families = answered;
    } else {
      // Show what probing finds now; when the API does answer, later pickers
      // get the complete list.
      void local.then((complete) => {
        if (complete.length > 0) cachedFamilies = complete;
      });
    }
  }
  if (families.length === 0) families = probedFontFamilies();
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
  options: {
    mixed?: boolean;
    emptyLabel?: string;
    themeValue?: string;
    /**
     * The deck theme's families. They are pinned at the top of the list AND
     * appear at their alphabetical place, both suffixed "(theme)", so the
     * theme's own voices are one flick away wherever the author is scrolled.
     */
    themeFamilies?: string[];
  } = {},
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

  // The theme case needs no note: the selected option already says "(Theme)".
  const showFallback = (family: string | null): void => {
    if (!family) {
      const mixed = options.mixed && select.value === '__mixed__';
      fallbackNote.textContent = mixed ? 'Mixed fonts selected.' : '';
      fallbackNote.hidden = !mixed;
      return;
    }
    fallbackNote.hidden = false;
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
  // The theme's families, pinned. Duplicate values are fine in a <select>:
  // choosing either copy selects the pinned one, and both mean the family.
  const pinned = [...new Set(
    (options.themeFamilies ?? []).map((family) => primaryFamily(family)).filter(Boolean),
  )];
  const pinnedKeys = new Set(pinned.map((family) => family.toLowerCase()));
  for (const family of pinned) addOption(family, `${family} (theme)`);
  if (pinned.length > 0) addOption('__divider__', '────────', true);
  const placeholder = addOption('__loading__', 'Loading fonts…', true);

  select.value = options.mixed ? '__mixed__' : '';
  showFallback(current || null);

  void installedFontFamilies().then((families) => {
    placeholder.remove();
    const seen = new Set<string>();
    for (const family of families) {
      seen.add(family.toLowerCase());
      addOption(family, pinnedKeys.has(family.toLowerCase()) ? `${family} (theme)` : family);
    }
    // A theme family that isn't installed still deserves its alphabetical
    // slot — the deck renders it through its fallback stack either way.
    for (const family of pinned) {
      if (seen.has(family.toLowerCase())) continue;
      seen.add(family.toLowerCase());
      const at = [...select.options].findIndex((option) =>
        !option.disabled && option.value && !pinnedKeys.has(option.value.toLowerCase())
        && option.value.localeCompare(family) > 0);
      const option = document.createElement('option');
      option.value = family;
      option.textContent = `${family} (theme)`;
      if (at === -1) select.appendChild(option);
      else select.insertBefore(option, select.options[at]);
    }
    if (current && !seen.has(current.toLowerCase()) && !pinnedKeys.has(current.toLowerCase())) {
      addOption(current, `${current} (not installed)`);
    }
    if (!options.mixed) select.value = current || '';
    showFallback(select.value && select.value !== '__mixed__' ? select.value : null);
  });

  select.addEventListener('change', () => {
    if (['__mixed__', '__loading__', '__divider__'].includes(select.value)) return;
    const family = select.value;
    showFallback(family || null);
    onChange(family ? fontFamilyValue(family) : '');
  });

  return wrap;
}
