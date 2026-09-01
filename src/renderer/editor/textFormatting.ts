import type { SlideElement } from '@shared/deck.js';

type TextElement = Extract<SlideElement, { type: 'text' }>;
export type TextFormat = 'bold' | 'italic' | 'underline';

function serialized(fragment: DocumentFragment): string {
  const out = document.createElement('div');
  out.append(fragment.cloneNode(true));
  return out.innerHTML;
}

function removeEmptyStyleAttribute(node: HTMLElement): void {
  if (!node.getAttribute('style')?.trim()) node.removeAttribute('style');
}

/**
 * Make a character property uniform across authored rich text. A box-level
 * declaration alone is not enough: styles on paragraphs, cells, and inline
 * runs beat an inherited value. Writing the property on every text-bearing
 * leaf keeps the existing block/list/table structure while giving every
 * character the requested formatting.
 */
function setHtmlTextProperty(
  html: string,
  property: string,
  value: string | null,
  aliases: string[] = [],
): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const properties = [property, ...aliases];
  let changed = false;

  for (const node of template.content.querySelectorAll<HTMLElement>('*')) {
    for (const candidate of properties) {
      if (node.style.getPropertyValue(candidate)) {
        node.style.removeProperty(candidate);
        changed = true;
      }
    }
    removeEmptyStyleAttribute(node);
  }

  if (value !== null) {
    const parents = new Set<HTMLElement>();
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const text = current as Text;
      if (!text.data) continue;
      if (text.parentElement) parents.add(text.parentElement);
      else {
        const span = document.createElement('span');
        text.replaceWith(span);
        span.appendChild(text);
        parents.add(span);
      }
    }
    for (const parent of parents) {
      parent.style.setProperty(property, value);
      if (property === 'color') parent.style.setProperty('-webkit-text-fill-color', value);
    }

    // Decorations painted by an ancestor propagate through descendants and
    // cannot be cancelled by a leaf alone. Override every authored ancestor.
    if (property === 'text-decoration' && value === 'none') {
      for (const node of template.content.querySelectorAll<HTMLElement>('*')) {
        if (node.textContent) node.style.setProperty(property, value);
      }
    }
    changed = parents.size > 0;
  }

  return changed ? serialized(template.content) : html;
}

export function setWholeTextStyle(
  element: TextElement,
  property: 'font-family' | 'font-size' | 'font-weight' | 'font-style' | 'text-decoration',
  value: string | null,
): void {
  const style = { ...element.style };
  if (value === null) delete style[property];
  else style[property] = value;
  element.style = style;
  const aliases = property === 'text-decoration' ? ['text-decoration-line'] : [];
  // Auto-fit owns the font-size on `.text-content`. Descendant sizes would
  // defeat that fitted value, so an authored box size is only the ceiling and
  // all run-level size overrides are removed.
  const inlineValue = property === 'font-size' && element.autoFit ? null : value;
  element.html = setHtmlTextProperty(element.html, property, inlineValue, aliases);
}

export function setWholeTextColor(element: TextElement, value: string | null): void {
  const style = { ...element.style };
  const contentStyle = { ...element.contentStyle };
  for (const declarations of [style, contentStyle]) {
    const textClipped = /text/i.test(
      declarations['background-clip'] ?? declarations['-webkit-background-clip'] ?? '',
    );
    delete declarations.color;
    delete declarations['-webkit-text-fill-color'];
    if (textClipped) {
      delete declarations.background;
      delete declarations['background-image'];
      delete declarations['background-clip'];
      delete declarations['-webkit-background-clip'];
    }
  }
  if (value) style.color = value;
  element.style = style;
  if (Object.keys(contentStyle).length > 0) element.contentStyle = contentStyle;
  else delete element.contentStyle;
  element.html = setHtmlTextProperty(
    element.html,
    'color',
    null,
    [
      '-webkit-text-fill-color',
      'background',
      'background-image',
      'background-clip',
      '-webkit-background-clip',
    ],
  );
}

export function setWholeTextAlignment(
  element: TextElement,
  value: 'left' | 'center' | 'right' | 'justify',
): void {
  element.align = value;
  element.html = setHtmlTextProperty(element.html, 'text-align', value);
}

export function setWholeTextParagraphSpacing(element: TextElement, value: number | null): void {
  if (value === null) delete element.paragraphSpacing;
  else element.paragraphSpacing = Math.max(0, value);
  const template = document.createElement('template');
  template.innerHTML = element.html;
  let changed = false;
  for (const node of template.content.querySelectorAll<HTMLElement>('*')) {
    for (const property of ['margin-top', 'margin-bottom']) {
      if (!node.style.getPropertyValue(property)) continue;
      node.style.removeProperty(property);
      changed = true;
    }
    removeEmptyStyleAttribute(node);
  }
  if (changed) element.html = serialized(template.content);
}

/** One text node's effective toggle state, resolved from the inside out. */
function textNodeState(text: Text, format: TextFormat): boolean {
  for (let node = text.parentElement; node; node = node.parentElement) {
    if (format === 'bold') {
      if (node.style.fontWeight) {
        const weight = Number.parseInt(node.style.fontWeight, 10);
        return node.style.fontWeight === 'bold' || weight >= 600;
      }
      if (/^(B|STRONG)$/.test(node.tagName)) return true;
    } else if (format === 'italic') {
      if (node.style.fontStyle) return node.style.fontStyle === 'italic';
      if (/^(I|EM)$/.test(node.tagName)) return true;
    } else {
      const declared = node.style.textDecorationLine || node.style.textDecoration;
      if (declared) return declared.includes('underline');
      if (node.tagName === 'U') return true;
    }
  }
  return false;
}

/** Whether every character of authored markup renders with the format. */
function htmlFormatState(html: string, format: TextFormat): boolean | null {
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  let sawText = false;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text;
    if (!text.data.trim()) continue;
    sawText = true;
    if (!textNodeState(text, format)) return false;
  }
  return sawText ? true : null;
}

export function wholeTextFormatState(element: TextElement, format: TextFormat): boolean {
  // An explicit box-level declaration wins; otherwise the state is what the
  // authored markup actually renders. Reading only `element.style` made
  // Cmd/Ctrl+B on a box of pasted-bold text toggle the wrong way: the box
  // read as "not bold", so the shortcut double-bolded instead of unbolding.
  if (format === 'bold') {
    const declared = element.style['font-weight'];
    if (declared) {
      return declared === 'bold' || Number.parseInt(declared, 10) >= 600;
    }
  } else if (format === 'italic') {
    const declared = element.style['font-style'];
    if (declared) return declared === 'italic';
  } else {
    const declared = element.style['text-decoration'];
    if (declared) return declared.includes('underline');
  }
  return htmlFormatState(element.html, format) ?? false;
}

export function setWholeTextFormat(
  element: TextElement,
  format: TextFormat,
  active: boolean,
): void {
  if (format === 'bold') setWholeTextStyle(element, 'font-weight', active ? '700' : '400');
  else if (format === 'italic') setWholeTextStyle(element, 'font-style', active ? 'italic' : 'normal');
  else setWholeTextStyle(element, 'text-decoration', active ? 'underline' : 'none');
}

export function toggleWholeTextFormat(element: TextElement, format: TextFormat): void {
  setWholeTextFormat(element, format, !wholeTextFormatState(element, format));
}
