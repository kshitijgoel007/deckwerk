import { closePopover, openAnchoredPopover } from './ui.js';

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface HsvColor {
  h: number;
  s: number;
  v: number;
}

export interface ColorFieldOptions {
  /** The colour painted by CSS when this value is inherited. */
  inheritedValue?: string | null;
  /** Why the displayed paint is not an ordinary explicit solid colour. */
  source?: { kind: 'theme' | 'css'; preview?: string | null; label?: string };
  /** What a null value means for this particular property. */
  clear?: { kind: 'theme' | 'css' | 'none'; label: string };
}

const clamp = (value: number, min = 0, max = 1): number =>
  Math.max(min, Math.min(max, value));

/** Parse the CSS colour forms authored by the editor and common imports. */
export function parseCssColor(value: string | null | undefined): RgbaColor | null {
  if (!value) return null;
  const source = value.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(source)?.[1];
  if (hex) {
    const expanded = hex.length <= 4
      ? [...hex].map((part) => part + part).join('')
      : hex;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }

  const rgb = /^rgba?\(\s*([^)]*)\)$/i.exec(source)?.[1];
  if (!rgb) return null;
  const [channels, alphaSource] = rgb.includes('/')
    ? rgb.split('/').map((part) => part.trim())
    : [rgb, undefined];
  const channelParts = channels.includes(',')
    ? channels.split(',').map((part) => part.trim())
    : channels.split(/\s+/);
  let alphaPart = alphaSource;
  if (!alphaPart && channelParts.length === 4) alphaPart = channelParts.pop();
  if (channelParts.length !== 3) return null;
  const channel = (part: string): number => part.endsWith('%')
    ? Math.round(clamp(Number.parseFloat(part) / 100) * 255)
    : Math.round(clamp(Number.parseFloat(part), 0, 255));
  const alpha = !alphaPart ? 1 : alphaPart.endsWith('%')
    ? clamp(Number.parseFloat(alphaPart) / 100)
    : clamp(Number.parseFloat(alphaPart));
  const result = { r: channel(channelParts[0]), g: channel(channelParts[1]), b: channel(channelParts[2]), a: alpha };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

export function colorForInput(value: string | null | undefined): string | null {
  const color = parseCssColor(value);
  if (!color) return null;
  return `#${[color.r, color.g, color.b]
    .map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

function rgbToHsv({ r, g, b }: RgbaColor): HsvColor {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === red) h = 60 * (((green - blue) / delta) % 6);
    else if (max === green) h = 60 * ((blue - red) / delta + 2);
    else h = 60 * ((red - green) / delta + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

function hsvToRgb({ h, s, v }: HsvColor, a: number): RgbaColor {
  const chroma = v * s;
  const section = ((h % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const offset = v - chroma;
  const [r, g, b] = section < 1 ? [chroma, x, 0]
    : section < 2 ? [x, chroma, 0]
      : section < 3 ? [0, chroma, x]
        : section < 4 ? [0, x, chroma]
          : section < 5 ? [x, 0, chroma]
            : [chroma, 0, x];
  return {
    r: Math.round((r + offset) * 255),
    g: Math.round((g + offset) * 255),
    b: Math.round((b + offset) * 255),
    a: clamp(a),
  };
}

function colorToCss(color: RgbaColor): string {
  const hex = `#${[color.r, color.g, color.b]
    .map((part) => part.toString(16).padStart(2, '0')).join('')}`;
  if (color.a >= 0.9995) return hex;
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.round(color.a * 1000) / 1000})`;
}

function themeColors(): string[] {
  const list = document.getElementById('theme-swatches');
  if (!list) return [];
  return [...list.querySelectorAll<HTMLOptionElement>('option')]
    .map((option) => option.value)
    .filter((value, index, values) => parseCssColor(value) && values.indexOf(value) === index);
}

function previewStyle(node: HTMLElement, color: RgbaColor): void {
  node.style.setProperty('--picker-color', colorToCss(color));
}

/**
 * An explicit, cross-platform colour field. Unlike the native colour input it
 * shows the palette, full saturation/value plane, hue, and alpha in one click.
 */
export function colorField(
  label: string,
  value: string | null,
  onChange: (value: string | null) => void,
  options: ColorFieldOptions = {},
): HTMLElement {
  const clear = options.clear ?? { kind: 'none' as const, label: 'No color' };
  const source = options.source
    ?? (value === null && clear.kind === 'theme' ? { kind: 'theme' as const } : null);
  const inherited = parseCssColor(options.inheritedValue);
  const explicit = parseCssColor(value);
  const initial = explicit ?? inherited ?? { r: 136, g: 136, b: 136, a: 1 };

  const wrap = document.createElement('div');
  wrap.className = 'field field-color';
  const fieldLabel = document.createElement('span');
  fieldLabel.textContent = label;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'color-picker-trigger';
  trigger.setAttribute('aria-label', `${label}: ${value === null && clear.kind === 'theme' ? 'theme color' : value ?? clear.label}`);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');

  const preview = document.createElement('span');
  preview.className = 'color-picker-preview';
  if (source?.kind === 'css' && source.preview) {
    preview.style.setProperty('--picker-color', source.preview);
  } else if (value === null && clear.kind === 'none') {
    preview.style.setProperty('--picker-color', 'transparent');
  } else {
    previewStyle(preview, initial);
  }
  trigger.appendChild(preview);
  if (source) {
    trigger.classList.add(`is-${source.kind}`);
    const badge = document.createElement('span');
    badge.className = `color-picker-source-badge color-picker-${source.kind}-badge`;
    badge.textContent = source.kind === 'theme' ? 'T' : 'CSS';
    badge.setAttribute('aria-hidden', 'true');
    trigger.appendChild(badge);
    const sourceLabel = source.label ?? (source.kind === 'theme' ? 'Theme color' : 'CSS-defined paint');
    trigger.setAttribute('aria-label', `${label}: ${sourceLabel}`);
    trigger.title = `${sourceLabel}${options.inheritedValue ? ` (${options.inheritedValue})` : ''}`;
  } else {
    trigger.title = value ?? clear.label;
  }

  trigger.addEventListener('click', () => {
    let current = { ...initial };
    let hsv = rgbToHsv(current);
    let currentIsTheme = source?.kind === 'theme';

    const popover = document.createElement('div');
    popover.className = 'color-picker-popover';
    popover.role = 'dialog';
    popover.setAttribute('aria-label', `${label} color picker`);

    const paletteTitle = document.createElement('div');
    paletteTitle.className = 'color-picker-section-title';
    paletteTitle.textContent = 'Theme colors';
    const palette = document.createElement('div');
    palette.className = 'color-picker-palette';

    const themeDefault = clear.kind === 'theme' ? document.createElement('button') : null;
    if (themeDefault) {
      themeDefault.type = 'button';
      themeDefault.className = `color-picker-theme-default${currentIsTheme ? ' selected' : ''}`;
      themeDefault.setAttribute('aria-label', clear.label);
      themeDefault.title = clear.label;
      const defaultPreview = document.createElement('span');
      defaultPreview.className = 'color-picker-palette-swatch';
      previewStyle(defaultPreview, inherited ?? initial);
      const defaultBadge = document.createElement('span');
      defaultBadge.className = 'color-picker-source-badge color-picker-theme-badge';
      defaultBadge.textContent = 'T';
      defaultBadge.setAttribute('aria-hidden', 'true');
      themeDefault.append(defaultPreview, defaultBadge);
      themeDefault.addEventListener('click', () => {
        currentIsTheme = true;
        onChange(null);
        closePopover();
      });
      palette.appendChild(themeDefault);
    }

    const swatchButtons: HTMLButtonElement[] = [];
    for (const themeColor of themeColors()) {
      const parsed = parseCssColor(themeColor)!;
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'color-picker-palette-button';
      swatch.setAttribute('aria-label', `Theme color ${themeColor}`);
      swatch.title = themeColor;
      previewStyle(swatch, parsed);
      swatch.addEventListener('click', () => {
        current = { ...parsed, a: current.a };
        hsv = rgbToHsv(current);
        currentIsTheme = false;
        paint();
        commit();
      });
      swatchButtons.push(swatch);
      palette.appendChild(swatch);
    }
    if (swatchButtons.length === 0 && !themeDefault) {
      const empty = document.createElement('div');
      empty.className = 'color-picker-palette-empty';
      empty.textContent = 'No theme palette';
      palette.appendChild(empty);
    }

    const plane = document.createElement('div');
    plane.className = 'color-picker-plane';
    plane.tabIndex = 0;
    plane.role = 'slider';
    plane.setAttribute('aria-label', 'Saturation and brightness');
    const planeCursor = document.createElement('span');
    planeCursor.className = 'color-picker-plane-cursor';
    plane.appendChild(planeCursor);

    const hueLabel = document.createElement('label');
    hueLabel.className = 'color-picker-slider-row';
    const hueText = document.createElement('span');
    hueText.textContent = 'Hue';
    const hue = document.createElement('input');
    hue.type = 'range';
    hue.min = '0';
    hue.max = '360';
    hue.step = '1';
    hue.setAttribute('aria-label', 'Hue');
    hueLabel.append(hueText, hue);

    const opacityLabel = document.createElement('label');
    opacityLabel.className = 'color-picker-slider-row color-picker-opacity';
    const opacityText = document.createElement('span');
    opacityText.textContent = 'Opacity';
    const opacity = document.createElement('input');
    opacity.type = 'range';
    opacity.min = '0';
    opacity.max = '100';
    opacity.step = '1';
    opacity.setAttribute('aria-label', 'Opacity');
    const opacityOutput = document.createElement('output');
    opacityLabel.append(opacityText, opacity, opacityOutput);

    const values = document.createElement('div');
    values.className = 'color-picker-values';
    const hexLabel = document.createElement('label');
    const hexTitle = document.createElement('span');
    hexTitle.textContent = 'Hex';
    const hexInput = document.createElement('input');
    hexInput.type = 'text';
    hexInput.maxLength = 7;
    hexInput.spellcheck = false;
    hexInput.setAttribute('aria-label', 'Hex color');
    hexLabel.append(hexTitle, hexInput);
    values.appendChild(hexLabel);

    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = `color-picker-clear color-picker-clear-${clear.kind}`;
    clearButton.textContent = clear.label;
    clearButton.addEventListener('click', () => {
      onChange(null);
      closePopover();
    });

    const commit = () => {
      previewStyle(preview, current);
      onChange(colorToCss(current));
    };
    const paint = () => {
      current = hsvToRgb(hsv, current.a);
      plane.style.setProperty('--picker-hue', `hsl(${hsv.h} 100% 50%)`);
      planeCursor.style.left = `${hsv.s * 100}%`;
      planeCursor.style.top = `${(1 - hsv.v) * 100}%`;
      plane.setAttribute('aria-valuetext', `Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`);
      hue.value = String(Math.round(hsv.h));
      opacity.value = String(Math.round(current.a * 100));
      opacityOutput.value = `${Math.round(current.a * 100)}%`;
      opacity.style.setProperty('--picker-opaque-color', colorToCss({ ...current, a: 1 }));
      hexInput.value = colorForInput(colorToCss(current)) ?? '#888888';
      themeDefault?.classList.toggle('selected', currentIsTheme);
      for (const swatch of swatchButtons) {
        const parsed = parseCssColor(swatch.title);
        swatch.classList.toggle('selected', Boolean(parsed)
          && parsed!.r === current.r && parsed!.g === current.g && parsed!.b === current.b
          && !currentIsTheme);
      }
    };

    const updatePlane = (clientX: number, clientY: number) => {
      const rect = plane.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      hsv.s = clamp((clientX - rect.left) / rect.width);
      hsv.v = 1 - clamp((clientY - rect.top) / rect.height);
      currentIsTheme = false;
      paint();
    };
    plane.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      plane.setPointerCapture?.(event.pointerId);
      updatePlane(event.clientX, event.clientY);
    });
    plane.addEventListener('pointermove', (event) => {
      if (!plane.hasPointerCapture?.(event.pointerId)) return;
      updatePlane(event.clientX, event.clientY);
    });
    plane.addEventListener('pointerup', (event) => {
      if (plane.hasPointerCapture?.(event.pointerId)) plane.releasePointerCapture?.(event.pointerId);
      updatePlane(event.clientX, event.clientY);
      commit();
    });
    plane.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.1 : 0.01;
      if (event.key === 'ArrowLeft') hsv.s = clamp(hsv.s - step);
      else if (event.key === 'ArrowRight') hsv.s = clamp(hsv.s + step);
      else if (event.key === 'ArrowUp') hsv.v = clamp(hsv.v + step);
      else if (event.key === 'ArrowDown') hsv.v = clamp(hsv.v - step);
      else return;
      event.preventDefault();
      currentIsTheme = false;
      paint();
      commit();
    });
    hue.addEventListener('input', () => {
      hsv.h = Number(hue.value);
      currentIsTheme = false;
      paint();
    });
    hue.addEventListener('change', commit);
    opacity.addEventListener('input', () => {
      current.a = Number(opacity.value) / 100;
      currentIsTheme = false;
      paint();
    });
    opacity.addEventListener('change', commit);
    hexInput.addEventListener('change', () => {
      const parsed = parseCssColor(hexInput.value);
      if (!parsed) {
        paint();
        return;
      }
      current = { ...parsed, a: current.a };
      hsv = rgbToHsv(current);
      currentIsTheme = false;
      paint();
      commit();
    });
    popover.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      closePopover();
      trigger.focus();
    });

    if (source?.kind === 'css') {
      const sourceNote = document.createElement('div');
      sourceNote.className = 'color-picker-source-note';
      const sourceBadge = document.createElement('strong');
      sourceBadge.textContent = 'CSS';
      const sourceText = document.createElement('span');
      sourceText.textContent = source.label ?? 'This text paint is defined by CSS.';
      sourceNote.append(sourceBadge, sourceText);
      popover.append(sourceNote);
    }
    popover.append(paletteTitle, palette, plane, hueLabel, opacityLabel, values, clearButton);
    paint();
    openAnchoredPopover(trigger, popover, { focus: false });
  });

  wrap.append(fieldLabel, trigger);
  return wrap;
}
