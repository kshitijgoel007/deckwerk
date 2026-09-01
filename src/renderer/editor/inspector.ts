import type { MediaEffect, Slide, SlideElement } from '@shared/deck.js';
import {
  paragraphsToList,
  paragraphsToOrderedList,
  changeListType,
  hasList,
  listMarkerColorState,
  listToParagraphs,
  setListMarkerColor,
  type ListMarkerColorState,
} from '@shared/paragraphs.js';
import type {
  TableBorderPreset,
  TableBorderSettings,
  TableSelection,
} from './canvas.js';
import { type AlignMode, alignElements } from './align.js';
import type { EditorStore } from './store.js';
import { LAYOUT_LABELS, applySlideLayout, type SlideLayout } from './slideLayouts.js';
import { MagicMovePanel } from './magicMovePanel.js';
import { fontFamilyField, primaryFamily } from './fontPicker.js';
import { themeById } from '@shared/themes.js';
import { colorField, colorForInput } from './colorPicker.js';
import {
  cssMediaBorder,
  cssMediaRadius,
  cssNoWrap,
  cssVisualEffects,
  isMediaBorderPaint,
} from '@shared/nativeCss.js';
import {
  setWholeTextAlignment,
  setWholeTextColor,
  setWholeTextFormat,
  setWholeTextParagraphSpacing,
  setWholeTextStyle,
  wholeTextFormatState,
} from './textFormatting.js';

interface TextPaintInfo {
  value: string | null;
  inheritedValue: string | null;
  source?: { kind: 'theme' | 'css'; preview?: string | null; label?: string };
  clear: { kind: 'theme' | 'css'; label: string };
}

type ListStyle = 'None' | 'Bulleted' | 'Numbered';

function listStyleOfHtml(html: string): ListStyle {
  if (hasList(html, true)) return 'Numbered';
  if (hasList(html, false)) return 'Bulleted';
  return 'None';
}

function applyListStyleToHtml(html: string, style: ListStyle): string {
  if (style === 'None') return listToParagraphs(html);
  if (style === 'Numbered') {
    return hasList(html, false) ? changeListType(html, true) : paragraphsToOrderedList(html);
  }
  return hasList(html, true) ? changeListType(html, false) : paragraphsToList(html);
}

/** Display labels for the video behaviour flags. */
const VIDEO_FLAG_LABELS = {
  autoplay: 'Autoplay',
  loop: 'Loop',
  muted: 'Mute',
  controls: 'Controls',
} as const;

/**
 * The properties panel.
 *
 * It covers geometry and per-type behaviour — the things that are awkward or
 * impossible to express by dragging (exact coordinates, autoplay, loop, fit).
 * Typography and colour are exposed through dedicated controls below; broader
 * deck styling belongs in the theme editor.
 */
export class Inspector {
  private host: HTMLElement;
  private store: EditorStore;
  /** Clip lengths, probed on demand so the trim sliders can be scaled. */
  private durations = new Map<string, number>();

  onTrimRequest?: (el: Extract<SlideElement, { type: 'video' }>) => void;
  /** Open the desktop-only raster paint window for an image. */
  onRasterRequest?: (el: Extract<SlideElement, { type: 'image' }>) => void;
  /** Play/pause the video on the editing canvas; returns the new playing state. */
  onTogglePlay?: (elementId: string) => boolean;
  /** Start editing a text element in place on the canvas. */
  onEditText?: (elementId: string) => void;
  /** Whether the canvas currently owns a live text selection. */
  editingText?: () => boolean;
  /** Apply weight to only the selected characters in the live text edit. */
  onApplyTextSelectionWeight?: (weight: number) => boolean;
  onToggleTextSelectionFormat?: (format: 'bold' | 'italic' | 'underline') => boolean;
  textSelectionFormatState?: (format: 'bold' | 'italic' | 'underline') => boolean;
  /** Apply a family to only the selected characters in the live text edit. */
  onApplyTextSelectionFontFamily?: (value: string) => boolean;
  onApplyTextSelectionFontSize?: (value: number) => boolean;
  /** Apply spacing after only the paragraphs covered by the live text selection. */
  onApplyTextSelectionParagraphSpacing?: (value: number | null) => boolean;
  /** Authored spacing shared by the paragraphs in the live text selection. */
  textSelectionParagraphSpacing?: () => number | null;
  onApplyTextSelectionColor?: (value: string | null) => boolean;
  onApplyTextSelectionAlignment?: (value: 'left' | 'center' | 'right' | 'justify') => boolean;
  /** Convert only the paragraphs covered by the live text selection. */
  onApplyTextSelectionListStyle?: (style: ListStyle) => boolean;
  textSelectionListStyle?: () => ListStyle | null;
  /** Marker paint for the list items touched by the live text selection. */
  textSelectionMarkerColor?: () => ListMarkerColorState | null;
  onApplyTextSelectionMarkerColor?: (value: string | null) => boolean;
  tableSelection?: () => TableSelection | null;
  tableBorderSettings?: () => TableBorderSettings;
  onSetTableBorderColor?: (color: string) => void;
  onSetTableBorderWidth?: (width: number) => void;
  onApplyTableBorderPreset?: (preset: TableBorderPreset) => void;
  onSetTableBorderDrawing?: (active: boolean) => void;
  onApplyTableCellColor?: (property: 'backgroundColor' | 'color', value: string | null) => void;
  onApplyTableCellTextStyle?: (
    property: 'fontFamily' | 'fontSize' | 'fontWeight' | 'fontStyle'
      | 'textDecorationLine' | 'textAlign' | 'verticalAlign',
    value: string | null,
  ) => boolean;
  textComputedTypography?: (elementId: string) => {
    fontFamily: string | null;
    fontSize: number | null;
    fontWeight: number | null;
    fontFamilyExplicit: boolean;
    fontSizeExplicit: boolean;
    fontWeightExplicit: boolean;
    fittedFontSize: number | null;
    paragraphSpacing: number | null;
  };
  onInsertTableColumn?: (after: boolean) => void;
  onDeleteTableColumn?: () => void;
  /** Toggle crop-editing mode on the canvas for an image or video. */
  onToggleMask?: (elementId: string) => void;
  /** Which element is currently in mask mode, so the button can reflect it. */
  maskingElement?: () => string | null;
  /** Show the frame at a given time on the canvas while a trim handle moves. */
  onSeekPreview?: (elementId: string, time: number) => void;
  /** Clip length from the canvas video element, when ffprobe cannot say. */
  videoDuration?: (elementId: string) => number | null;
  /** Seeks the sidebar trim preview; rebuilt with the panel. */
  private trimPreviewSeek: ((t: number) => void) | null = null;
  /** What the panel showed last, to skip re-renders that would change nothing. */
  private lastDeck: unknown = null;
  private lastSelection = '';
  private lastSlide = -1;
  private lastSlideSelection = '';
  /** Keep the opacity slider mounted while its live drag updates the deck. */
  private changingOpacity = false;
  private magicMoveHost = document.createElement('section');
  private magicMovePanel: MagicMovePanel;
  /** Enter the dedicated editor for the three fixed layout masters. */
  onEditLayouts?: (layout: SlideLayout) => void;

  constructor(host: HTMLElement, store: EditorStore) {
    this.host = host;
    this.host.classList.add('editor-inspector');
    this.store = store;
    this.magicMoveHost.className = 'magic-move-section';
    this.magicMovePanel = new MagicMovePanel(this.magicMoveHost, store, false);
    // Only re-render when the deck, selection or slide actually changed. The
    // store also emits for bookkeeping (autosave's markClean among them), and
    // rebuilding then destroys whatever control the user is holding — the trim
    // slider died ~800ms into every drag this way.
    store.subscribe(() => {
      const { deck, selection, slideIndex, slideSelection } = this.store.get();
      const sel = [...selection].sort().join(',');
      const slideSel = [...slideSelection].sort().join(',');
      // Opacity previews continuously on the canvas. Those transient deck
      // updates must not replace the range input currently under the pointer.
      // A genuine selection change still rebuilds the panel as usual.
      if (
        this.changingOpacity
        && sel === this.lastSelection
        && slideIndex === this.lastSlide
        && slideSel === this.lastSlideSelection
      ) {
        return;
      }
      if (this.changingOpacity) {
        // A selection change can remove the focused slider before its normal
        // pointerup/blur cleanup. Close the drag transaction before rendering
        // the newly selected object's controls.
        this.store.endTransaction();
        this.changingOpacity = false;
      }
      if (
        deck === this.lastDeck
        && sel === this.lastSelection
        && slideIndex === this.lastSlide
        && slideSel === this.lastSlideSelection
      ) {
        return;
      }
      if (this.host.hidden) return;
      this.render();
    });
    this.render();
  }

  render(): void {
    // Rebuilding the panel destroys whatever control holds the keyboard. When
    // that control is a form field, Chromium hands focus to the element that
    // owns the document selection — during a text edit, the contenteditable —
    // so the Tab meant for the next panel field indented a list instead.
    // Remember the focused control and give the rebuilt panel's equivalent
    // control the keyboard back.
    const focused = this.captureFocusedControl();
    this.renderPanel();
    this.restoreFocusedControl(focused);
  }

  private static controlKey(node: Element): string {
    const label = node.closest('label, .field-number, .field')?.querySelector('span')
      ?.textContent
      ?? node.getAttribute('aria-label')
      ?? '';
    return `${node.tagName}|${label}`;
  }

  /** The deck theme's font families (title→base order), primary names only. */
  private deckThemeFamilies(): string[] {
    const deck = this.store.get().deck;
    const fonts = deck.themeStyle?.fonts ?? themeById(deck.themePreset)?.fonts;
    if (!fonts) return [];
    const roles = [fonts.title, fonts.heading, fonts.body, fonts.caption, fonts.base];
    return [...new Set(roles.map((role) => primaryFamily(role.family)).filter(Boolean))];
  }

  private captureFocusedControl(): {
    key: string;
    index: number;
    selection: [number, number] | null;
  } | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.host.contains(active)) return null;
    if (!active.matches('input, select, textarea')) return null;
    const key = Inspector.controlKey(active);
    const peers = [...this.host.querySelectorAll('input, select, textarea')]
      .filter((node) => Inspector.controlKey(node) === key);
    let selection: [number, number] | null = null;
    try {
      const field = active as HTMLInputElement;
      if (typeof field.selectionStart === 'number' && typeof field.selectionEnd === 'number') {
        selection = [field.selectionStart, field.selectionEnd];
      }
    } catch {
      // Some input types refuse selection access; focus alone is enough there.
    }
    return { key, index: Math.max(0, peers.indexOf(active)), selection };
  }

  private restoreFocusedControl(
    memo: { key: string; index: number; selection: [number, number] | null } | null,
  ): void {
    if (!memo) return;
    const peers = [...this.host.querySelectorAll<HTMLElement>('input, select, textarea')]
      .filter((node) => Inspector.controlKey(node) === memo.key);
    const control = peers[memo.index] ?? peers[0];
    if (!control) return;
    control.focus({ preventScroll: true });
    if (memo.selection) {
      try {
        (control as HTMLInputElement).setSelectionRange(memo.selection[0], memo.selection[1]);
      } catch {
        // Selection restore is a nicety; number inputs refuse it.
      }
    }
  }

  private renderPanel(): void {
    const { deck, selection, slideIndex, slideSelection } = this.store.get();
    this.lastDeck = deck;
    this.lastSelection = [...selection].sort().join(',');
    this.lastSlide = slideIndex;
    this.lastSlideSelection = [...slideSelection].sort().join(',');
    const selected = this.store.selectedElements();
    this.host.replaceChildren();
    if (selected.length > 0) this.magicMovePanel.dismiss();
    if (slideSelection.size > 1 && selected.length === 0) {
      this.host.appendChild(sectionTitle('slides'));
      this.host.appendChild(hint(`${slideSelection.size} slides selected`));
      this.host.appendChild(this.slideLayoutSection(this.store.selectedSlides()));
      this.appendMagicMove();
      return;
    }

    if (selected.length === 0) {
      this.host.appendChild(sectionTitle('slide'));
      const slide = deck.slides[slideIndex];
      if (slide) this.host.appendChild(this.slideLayoutSection([slide]));
      this.appendMagicMove();
      return;
    }
    if (selected.length > 1) {
      this.host.appendChild(hint(`${selected.length} elements selected`));
      this.host.appendChild(this.alignSection());
      this.host.appendChild(this.geometrySection(selected));
      const first = selected[0];
      const sameType = selected.every((element) => element.type === first.type);
      if (
        first.type === 'shape' &&
        selected.every((element) => element.type === 'shape' && element.shape === first.shape)
      ) {
        this.host.appendChild(this.multiShapeSection(
          selected as Array<Extract<SlideElement, { type: 'shape' }>>,
        ));
      } else if (sameType && first.type === 'text') {
        this.host.appendChild(this.multiTextSection(
          selected as Array<Extract<SlideElement, { type: 'text' }>>,
        ));
      } else if (sameType && (first.type === 'image' || first.type === 'video')) {
        this.host.appendChild(this.multiMediaSection(
          selected as Array<Extract<SlideElement, { type: 'image' | 'video' }>>,
        ));
      }
      return;
    }

    const el = selected[0];
    if (el.type === 'image' || el.type === 'video') {
      const header = document.createElement('div');
      header.className = 'type-heading-row';
      header.append(sectionTitle(el.type), mediaSourceButton(el.src));
      this.host.appendChild(header);
    } else {
      this.host.appendChild(sectionTitle(el.type));
    }
    this.host.appendChild(this.geometrySection(selected));
    const specific = this.typeSection(el);
    if (specific) this.host.appendChild(specific);
  }

  private appendMagicMove(): void {
    this.magicMovePanel.render();
    this.host.appendChild(this.magicMoveHost);
  }

  /** Slide-level controls apply uniformly to every slide selected in the rail. */
  private slideLayoutSection(slides: Slide[]): HTMLElement {
    const section = optionSection('Layout', 'slide-layout-options');
    const selectedIds = new Set(slides.map((slide) => slide.id));
    const layouts = sharedValue(slides.map((slide) => slide.layout ?? 'freeform'));
    const layout = document.createElement('label');
    layout.className = 'field';
    const layoutLabel = document.createElement('span');
    layoutLabel.textContent = 'Preset';
    const layoutSelect = document.createElement('select');
    if (layouts.mixed) {
      const mixed = document.createElement('option');
      mixed.value = '__mixed__';
      mixed.textContent = 'Mixed';
      mixed.disabled = true;
      layoutSelect.appendChild(mixed);
    }
    for (const [value, label] of LAYOUT_LABELS) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      layoutSelect.appendChild(option);
    }
    const editLayouts = document.createElement('option');
    editLayouts.value = '__edit_layouts__';
    editLayouts.textContent = 'Edit layouts…';
    layoutSelect.appendChild(editLayouts);
    layoutSelect.value = layouts.mixed ? '__mixed__' : layouts.value ?? 'freeform';
    layoutSelect.addEventListener('change', () => {
      if (layoutSelect.value === '__mixed__') return;
      if (layoutSelect.value === '__edit_layouts__') {
        const current = layouts.mixed ? 'freeform' : layouts.value ?? 'freeform';
        layoutSelect.value = layouts.mixed ? '__mixed__' : current;
        this.onEditLayouts?.(current);
        return;
      }
      this.store.commit((next) => {
        for (const slide of next.slides) {
          if (selectedIds.has(slide.id)) {
            applySlideLayout(slide, layoutSelect.value as SlideLayout, next.layoutMasters);
          }
        }
      }, {
        label: `Apply ${layoutSelect.selectedOptions[0]?.textContent ?? 'slide'} layout`,
      });
    });
    layout.append(layoutLabel, layoutSelect);
    section.content.appendChild(layout);

    const masters = this.store.get().deck.layoutMasters;
    const backgroundValues = slides.map((slide) => (
      slide.layoutBackgroundInherited ? null : slide.background.color ?? null
    ));
    const backgrounds = sharedValue(backgroundValues);
    const inheritedBackground = sharedValue(slides.map((slide) => {
      const layoutName = (slide.layout ?? 'freeform') as SlideLayout;
      return masters?.[layoutName].background.color
        ?? this.store.get().deck.themeStyle?.colors.background
        ?? null;
    }));
    section.content.appendChild(colorField(
      backgrounds.mixed ? 'Background (mixed)' : 'Background',
      backgrounds.value,
      (value) => {
        this.store.commit((next) => {
          for (const slide of next.slides) {
            if (!selectedIds.has(slide.id)) continue;
            const layoutName = (slide.layout ?? 'freeform') as SlideLayout;
            if (value === null && next.layoutMasters) {
              slide.background = structuredClone(next.layoutMasters[layoutName].background);
              slide.layoutBackgroundInherited = true;
            } else {
              slide.background = { color: value, image: null };
              slide.layoutBackgroundInherited = false;
            }
          }
        }, { label: slides.length > 1 ? 'Set slide backgrounds' : 'Set slide background' });
      },
      {
        inheritedValue: inheritedBackground.mixed ? null : inheritedBackground.value,
        clear: {
          kind: 'theme',
          label: masters ? 'Use layout background' : 'Use theme background',
        },
        mixed: backgrounds.mixed,
      },
    ));
    return section.section;
  }

  /**
   * The crop control. Cropping is done in CSS, so it is instant and
   * reversible — the media is never re-encoded and the original is untouched.
   */
  private maskButton(elementId: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'mask-action-row';
    const active = this.maskingElement?.() === elementId;

    wrap.appendChild(button(
      active ? 'Done editing mask' : 'Edit mask',
      () => this.onToggleMask?.(elementId),
      'primary panel-action',
    ));

    const el = this.store
      .selectedElements()
      .find((e) => e.id === elementId);
    if (el && (el.type === 'image' || el.type === 'video') && el.sourceBox && !active) {
      const reset = smallButton(
        '×',
        'Reset mask',
        () => this.store.updateSelected((target) => {
          if (target.type === 'image' || target.type === 'video') target.sourceBox = null;
        }, { label: 'Reset mask' }),
      );
      reset.classList.add('primary', 'mask-reset-segment');
      wrap.classList.add('has-reset');
      wrap.appendChild(reset);
    }
    return wrap;
  }

  /** Rounded corners clip media, so keep them with the other mask controls. */
  private mediaMaskControls(elementId: string): HTMLElement {
    const el = this.store.selectedElements().find((element) => element.id === elementId);
    const masking = optionSection(
      'Masking - non-destructive & revertible',
      'media-masking-options',
    );
    if (!el || (el.type !== 'image' && el.type !== 'video')) return masking.section;

    const settings = document.createElement('div');
    settings.className = 'media-mask-settings';
    settings.appendChild(
      numberField('Corner radius', editableMediaRadius(el), (value) =>
        this.store.updateSelected((target) => {
          if (target.type === 'image' || target.type === 'video') {
            setMediaRadius(target, value);
          }
        })),
    );
    // Circle clips the element box to its inscribed ellipse. Mask editing then
    // moves and scales the media behind that fixed window.
    settings.appendChild(
      checkboxField('Circular mask', editableCircularMask(el), (on) =>
        this.store.updateSelected((target) => {
          if (target.type === 'image' || target.type === 'video') {
            setMediaMask(target, on);
          }
        }, { label: on ? 'Circular mask' : 'Rectangular mask' })),
    );
    masking.content.appendChild(settings);
    masking.content.appendChild(this.maskButton(elementId));
    return masking.section;
  }

  /**
   * Trim, in the sidebar rather than under the video.
   *
   * Trimming is non-destructive: `start` and `end` are honoured by the player,
   * which also loops between them — the native `loop` attribute cannot, since
   * it always restarts at zero.
   */
  private trimSection(el: Extract<SlideElement, { type: 'video' }>): HTMLElement {
    const trim = optionSection('Trim', 'video-trim-options');
    const wrap = trim.content;
    const duration = this.durations.get(el.id) ?? null;

    if (duration === null) {
      // Probed once per element and cached; the value is needed to scale the
      // range control and is not stored in the deck. ffprobe occasionally
      // fails on containers Chromium itself can read (.m4v among them), so
      // the video element's own metadata is the fallback — without one, this panel says
      // "Reading clip length" forever and the trim cannot be touched.
      void window.api.probeAsset(el.src).then((info) => {
        const fromProbe = info.duration && info.duration > 0 ? info.duration : null;
        const fromElement = this.videoDuration?.(el.id) ?? null;
        const found = fromProbe ?? fromElement;
        if (found && found > 0) {
          this.durations.set(el.id, found);
          this.render();
        }
      });
      wrap.appendChild(hint('Reading clip length…'));
      return trim.section;
    }

    const end = el.end ?? duration;
    const readout = document.createElement('p');
    readout.className = 'insp-hint';
    const setReadout = (from: number, to: number) => {
      readout.textContent = `${from.toFixed(2)}s → ${to.toFixed(2)}s  (${(to - from).toFixed(2)}s of ${duration.toFixed(2)}s)`;
    };
    setReadout(el.start, end);

    const commit = (start: number, stop: number) => {
      this.store.updateSelected((e) => {
        if (e.type !== 'video') return;
        e.start = Math.max(0, Math.min(start, stop - 0.05));
        // `null` means "to the end of the file", which survives the clip being
        // replaced by a longer one.
        e.end = stop >= duration - 0.01 ? null : stop;
      });
    };

    // While either handle moves: readout + live frame preview only. The store is
    // NOT touched — a commit re-renders this panel, which would destroy the
    // slider mid-drag and make it impossible to move at all. The value commits
    // once, on release.
    const range = trimRangeSlider(
      el.start,
      end,
      duration,
      (_edge, v, start, stop) => {
        setReadout(start, stop);
        this.trimPreviewSeek?.(v);
        this.onSeekPreview?.(el.id, v);
      },
      commit,
    );

    // The frame under the handle, previewed right here in the sidebar. The
    // canvas is also seeked, but this element is self-contained and cannot be
    // affected by canvas state — the preview always shows something.
    const preview = document.createElement('video');
    preview.className = 'trim-preview';
    preview.muted = true;
    preview.preload = 'auto';
    preview.src = window.api.assetUrl(el.src);
    const seekPreview = (t: number) => {
      if (preview.readyState >= HTMLMediaElement.HAVE_METADATA) {
        preview.currentTime = t;
      } else {
        preview.addEventListener('loadedmetadata', () => (preview.currentTime = t), { once: true });
      }
    };
    seekPreview(el.start);
    this.trimPreviewSeek = seekPreview;

    wrap.append(preview, range, readout);
    wrap.appendChild(
      button('Reset trim', () =>
        this.store.updateSelected((e) => {
          if (e.type !== 'video') return;
          e.start = 0;
          e.end = null;
        }),
        'primary panel-action',
      ),
    );
    return trim.section;
  }

  /** Align / distribute / match-size for a multi-selection, one undo entry. */
  private alignSection(): HTMLElement {
    const wrap = group('Align');
    const apply = (mode: AlignMode) => {
      const rects = this.store
        .selectedElements()
        .map((e) => ({ id: e.id, x: e.x, y: e.y, w: e.w, h: e.h }));
      const moves = alignElements(rects, mode);
      if (moves.size === 0) return;
      this.store.updateSelected((el) => {
        const m = moves.get(el.id);
        if (!m) return;
        const dx = m.x === undefined ? 0 : Math.round(m.x) - el.x;
        const dy = m.y === undefined ? 0 : Math.round(m.y) - el.y;
        if (m.x !== undefined) el.x += dx;
        if (m.y !== undefined) el.y += dy;
        if (el.type === 'shape' && el.control) {
          el.control.x += dx;
          el.control.y += dy;
        }
        if (m.w !== undefined) el.w = Math.round(m.w);
        if (m.h !== undefined) el.h = Math.round(m.h);
      });
    };
    const row = (pairs: Array<[string, AlignMode]>) => {
      const div = document.createElement('div');
      div.className = 'button-row';
      for (const [label, mode] of pairs) div.appendChild(button(label, () => apply(mode)));
      return div;
    };
    wrap.appendChild(row([['⟵', 'left'], ['⇔', 'hcenter'], ['⟶', 'right']]));
    wrap.appendChild(row([['⤒', 'top'], ['⇕', 'vcenter'], ['⤓', 'bottom']]));
    wrap.appendChild(row([['dist ⇢', 'distributeH'], ['dist ⇣', 'distributeV']]));
    wrap.appendChild(row([['match W', 'matchW'], ['match H', 'matchH']]));
    wrap.appendChild(hint('Match sizes uses the first-selected element as the reference.'));
    return wrap;
  }

  /** x/y/w/h, plus opacity and rotation. Applies to the whole selection. */
  private geometrySection(selected: SlideElement[]): HTMLElement {
    const geometry = optionSection('Geometry', 'geometry-options');
    geometry.section.classList.add('geometry-section');
    const wrap = geometry.content;
    const first = selected[0];
    const multi = selected.length > 1;

    const row = document.createElement('div');
    row.className = 'field-grid';
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      row.appendChild(
        numberField(
          key.toUpperCase(),
          multi ? commonValue(selected.map((element) => element[key])) : first[key],
          (v) => {
            this.store.updateSelected((el) => {
              if (key === 'w' || key === 'h') el[key] = Math.max(8, v);
              else {
                const delta = v - el[key];
                el[key] = v;
                if (el.type === 'shape' && el.control) el.control[key] += delta;
              }
            });
          },
        ),
      );
    }
    wrap.appendChild(row);

    const row2 = document.createElement('div');
    row2.className = 'field-grid field-grid-2';
    row2.appendChild(
      numberField('ROT', multi ? commonValue(selected.map((element) => element.rot)) : first.rot, (v) =>
        this.store.updateSelected((el) => (el.rot = v)),
      ),
    );
    row2.appendChild(
      numberField('Z', multi ? commonValue(selected.map((element) => element.z)) : first.z, (v) =>
        this.store.updateSelected((el) => (el.z = Math.round(v))),
      ),
    );
    wrap.appendChild(row2);

    wrap.appendChild(opacityField(
      multi ? commonValue(selected.map((element) => element.opacity)) : first.opacity,
      () => {
        this.changingOpacity = true;
        this.store.beginTransaction('Change opacity');
      },
      (value) => this.store.updateSelected((element) => {
        element.opacity = clamp(value, 0, 1);
      }, { label: 'Change opacity' }),
      () => {
        this.store.endTransaction();
        this.changingOpacity = false;
      },
    ));

    const order = document.createElement('div');
    order.className = 'button-row z-order-row';
    order.append(
      button('Front', () => this.reorder('front')),
      button('Forward', () => this.reorder('forward')),
      button('Back', () => this.reorder('backward')),
      button('To back', () => this.reorder('back')),
    );
    wrap.appendChild(order);
    return geometry.section;
  }

  private reorder(dir: 'front' | 'forward' | 'backward' | 'back'): void {
    const slide = this.store.slide;
    if (!slide) return;
    const zs = slide.elements.map((e) => e.z);
    const min = Math.min(...zs, 0);
    const max = Math.max(...zs, 0);
    this.store.updateSelected((el) => {
      if (dir === 'front') el.z = max + 1;
      else if (dir === 'back') el.z = min - 1;
      else if (dir === 'forward') el.z += 1;
      else el.z -= 1;
    });
  }

  /** Shared, safe style controls for a same-kind shape multi-selection. */
  private multiShapeSection(
    shapes: Array<Extract<SlideElement, { type: 'shape' }>>,
  ): HTMLElement {
    const kind = shapes[0].shape;
    const label = kind === 'arrow' ? 'Arrow style' : kind === 'line' ? 'Line style' : 'Shape style';
    const wrap = group(label);
    wrap.appendChild(hint(`Changes apply to all ${shapes.length} selected ${kind}s.`));

    if (kind === 'line' || kind === 'arrow') {
      wrap.appendChild(mixedCheckboxField(
        'Curved',
        commonValue(shapes.map((shape) => Boolean(shape.control))),
        (on) => this.store.updateSelected((element) => {
          if (element.type !== 'shape') return;
          element.control = on
            ? { x: element.x + element.w / 2, y: element.y + element.h / 2 - Math.max(80, element.w / 3) }
            : null;
        }),
      ));
    } else {
      wrap.appendChild(colorField(
        'Fill',
        commonValue(shapes.map((shape) => shape.fill)) ?? shapes[0].fill,
        (value) => this.store.updateSelected((element) => {
          if (element.type === 'shape') element.fill = value;
        }),
        { clear: { kind: 'none', label: 'No fill (transparent)' } },
      ));
    }

    wrap.appendChild(colorField(
      'Stroke',
      commonValue(shapes.map((shape) => shape.stroke)) ?? shapes[0].stroke,
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'shape') element.stroke = value;
      }),
      { clear: { kind: 'none', label: 'No stroke' } },
    ));
    const numbers = document.createElement('div');
    numbers.className = 'field-grid';
    numbers.appendChild(numberField(
      'WIDTH',
      commonValue(shapes.map((shape) => shape.strokeWidth)),
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'shape') element.strokeWidth = Math.max(0, value);
      }),
      { step: 0.5 },
    ));
    if (kind === 'rect' || kind === 'ellipse') {
      numbers.appendChild(numberField(
        'RADIUS',
        commonValue(shapes.map((shape) => shape.radius)),
        (value) => this.store.updateSelected((element) => {
          if (element.type === 'shape') element.radius = Math.max(0, value);
        }),
      ));
    }
    wrap.appendChild(numbers);
    return wrap;
  }

  private multiTextSection(
    texts: Array<Extract<SlideElement, { type: 'text' }>>,
  ): HTMLElement {
    const wrap = group('Text');
    wrap.appendChild(hint(`Changes apply to all ${texts.length} selected text boxes.`));
    wrap.appendChild(mixedCheckboxField(
      'Auto-fit text to box',
      commonValue(texts.map((text) => Boolean(text.autoFit))),
      (on) => this.store.updateSelected((element) => {
        if (element.type === 'text') {
          element.autoFit = on;
          if (on && element.style['font-size']) {
            setWholeTextStyle(element, 'font-size', element.style['font-size']);
          }
        }
      }),
    ));
    wrap.appendChild(mixedCheckboxField(
      'Disable automatic line breaks',
      commonValue(texts.map(editableTextNoWrap)),
      (on) => this.store.updateSelected((element) => {
        if (element.type === 'text') setTextNoWrap(element, on);
      }),
    ));
    if (texts.some(editableTextNoWrap)) {
      wrap.appendChild(mixedSelectField(
        'Compress by', ['shrink', 'condense'],
        commonValue(texts.map((text) => text.noWrapMode ?? 'shrink')),
        (v) => this.store.updateSelected((element) => {
          if (element.type === 'text') element.noWrapMode = v as 'shrink' | 'condense';
        }),
      ));
    }

    const computedTypography = texts.map((text) => this.textComputedTypography?.(text.id));
    const families = commonValue(texts.map((text) => text.style['font-family'] ?? ''));
    const themeFamilies = sharedValue(computedTypography.map((value) => value?.fontFamily ?? null));
    const inheritedFamiliesDiffer = families === '' && themeFamilies.mixed;
    wrap.appendChild(fontFamilyField(
      'Font family', families ?? '',
      (value) => this.store.updateSelected((element) => {
        if (element.type !== 'text') return;
        setWholeTextStyle(element, 'font-family', value || null);
      }, { label: 'Change font family' }),
      {
        mixed: families === null || inheritedFamiliesDiffer,
        themeValue: families === '' && !themeFamilies.mixed
          ? themeFamilies.value ?? undefined
          : undefined,
        themeFamilies: this.deckThemeFamilies(),
      },
    ));

    const sizes = sharedValue(texts.map((text) => {
      const size = Number.parseFloat(text.style['font-size'] ?? '');
      return Number.isFinite(size) ? size : null;
    }));
    const themeSizes = sharedValue(computedTypography.map((value) => value?.fontSize ?? null));
    const inheritedSizesDiffer = sizes.value === null && themeSizes.mixed;
    const sizeField = optionalNumberField(
      'Font size', sizes.mixed || inheritedSizesDiffer ? null : sizes.value,
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'text') {
          setWholeTextStyle(element, 'font-size', `${fontSizeValue(value)}px`);
        }
      }),
      () => this.store.updateSelected((element) => {
        if (element.type === 'text') setWholeTextStyle(element, 'font-size', null);
      }),
      'px',
      {
        min: 6,
        max: 400,
        maxFractionDigits: 1,
        themeValue: !sizes.mixed && sizes.value === null && !themeSizes.mixed
          ? themeSizes.value
          : null,
      },
    );
    if (sizes.mixed || inheritedSizesDiffer) sizeField.querySelector('input')!.placeholder = 'Mixed';
    wrap.appendChild(sizeField);

    const weights = sharedValue(texts.map((text) => {
      const weight = Number.parseFloat(text.style['font-weight'] ?? '');
      return Number.isFinite(weight) ? weight : null;
    }));
    const themeWeights = sharedValue(computedTypography.map((value) => value?.fontWeight ?? null));
    const inheritedWeightsDiffer = weights.value === null && themeWeights.mixed;
    const weightField = optionalNumberField(
      'Font weight', weights.mixed || inheritedWeightsDiffer ? null : weights.value,
      (value) => this.store.updateSelected((element) => {
        if (element.type !== 'text') return;
        setWholeTextStyle(
          element,
          'font-weight',
          String(Math.max(1, Math.min(1000, value))),
        );
      }),
      () => this.store.updateSelected((element) => {
        if (element.type === 'text') setWholeTextStyle(element, 'font-weight', null);
      }),
      '',
      {
        min: 1,
        max: 1000,
        step: 25,
        themeValue: !weights.mixed && weights.value === null && !themeWeights.mixed
          ? themeWeights.value
          : null,
      },
    );
    if (weights.mixed || inheritedWeightsDiffer) weightField.querySelector('input')!.placeholder = 'Mixed';
    wrap.appendChild(weightField);

    const roles = texts.map((text) =>
      text.class.find((name) => /^role-(title|body|caption)$/.test(name)) ?? 'none');
    wrap.appendChild(mixedSelectField(
      'Role', ['none', 'role-title', 'role-body', 'role-caption'],
      commonValue(roles),
      (value) => this.store.updateSelected((element) => {
        if (element.type !== 'text') return;
        element.class = element.class.filter((name) => !name.startsWith('role-'));
        if (value !== 'none') element.class.push(value);
      }),
    ));

    wrap.appendChild(mixedSelectField(
      'List', ['None', 'Bulleted', 'Numbered'],
      commonValue(texts.map((text) => listStyleOfHtml(text.html))),
      (style) => this.store.updateSelected((element) => {
        if (element.type === 'text') element.html = applyListStyleToHtml(element.html, style as ListStyle);
      }),
    ));

    const markerStates = texts.map((text) => listMarkerColorState(text.html))
      .filter((state) => state.hasList);
    if (markerStates.length > 0) {
      const markerMixed = markerStates.some((state) => state.mixed)
        || !markerStates.every((state) => state.value === markerStates[0].value);
      const inherited = this.textPaintInfo(texts[0]).inheritedValue;
      wrap.appendChild(colorField(
        markerMixed ? 'Marker colour (mixed)' : 'Marker colour',
        markerMixed ? null : markerStates[0].value,
        (value) => this.store.updateSelected((element) => {
          if (element.type === 'text') element.html = setListMarkerColor(element.html, value);
        }, { label: value ? 'Change list marker colour' : 'Make list markers follow text colour' }),
        {
          inheritedValue: inherited,
          clear: { kind: 'css', label: 'Follow text colour' },
        },
      ));
    }

    const colors = commonValue(texts.map((text) => text.style.color ?? ''));
    const paint = this.textPaintInfo(texts[0]);
    wrap.appendChild(colorField(
      colors === null ? 'Colour (mixed)' : 'Colour',
      colors === null ? paint.value : (colors || paint.value),
      (value) => this.store.updateSelected((element) => {
        if (element.type !== 'text') return;
        setWholeTextColor(element, value);
      }),
      {
        inheritedValue: paint.inheritedValue,
        source: paint.source,
        clear: paint.clear,
      },
    ));
    wrap.appendChild(alignButtonsField(
      'Align',
      commonValue(texts.map((text) => text.align)),
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'text') setWholeTextAlignment(element, value);
      }, { label: 'Change text alignment' }),
    ));
    wrap.appendChild(mixedSelectField(
      'Vertical', ['top', 'middle', 'bottom'],
      commonValue(texts.map((text) => text.valign)),
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'text') element.valign = value as 'top';
      }),
    ));
    const spacings = sharedValue(texts.map((text) => text.paragraphSpacing ?? null));
    const themeSpacings = sharedValue(
      computedTypography.map((value) => value?.paragraphSpacing ?? null),
    );
    const spacingField = optionalNumberField(
      'Paragraph spacing', spacings.mixed ? null : spacings.value,
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'text') setWholeTextParagraphSpacing(element, value);
      }),
      () => this.store.updateSelected((element) => {
        if (element.type === 'text') setWholeTextParagraphSpacing(element, null);
      }),
      'px',
      {
        min: 0,
        themeValue: !spacings.mixed && spacings.value === null && !themeSpacings.mixed
          ? themeSpacings.value
          : null,
      },
    );
    if (spacings.mixed) spacingField.querySelector('input')!.placeholder = 'Mixed';
    wrap.appendChild(spacingField);
    return wrap;
  }

  private multiMediaSection(
    media: Array<Extract<SlideElement, { type: 'image' | 'video' }>>,
  ): HTMLElement {
    const kind = media[0].type;
    const wrap = group(kind === 'image' ? 'Image' : 'Video');
    wrap.appendChild(hint(`Changes apply to all ${media.length} selected ${kind}s.`));
    if (kind === 'video') {
      const playback = optionSection('Playback', 'video-checkbox-grid');
      for (const key of ['autoplay', 'loop', 'muted', 'controls'] as const) {
        playback.content.appendChild(mixedCheckboxField(
          VIDEO_FLAG_LABELS[key],
          commonValue(media.map((element) => element.type === 'video' && element[key])),
          (value) => this.store.updateSelected((element) => {
            if (element.type === 'video') element[key] = value;
          }),
        ));
      }
      wrap.appendChild(playback.section);
    }
    const sizing = optionSection('Sizing', 'media-sizing-options');
    sizing.content.appendChild(mixedCheckboxField(
      'Keep aspect ratio',
      commonValue(media.map((element) => element.fit !== 'fill')),
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'image' || element.type === 'video') {
          element.fit = value ? 'contain' : 'fill';
        }
      }),
    ));
    wrap.appendChild(sizing.section);

    const masking = optionSection(
      'Masking - non-destructive & revertible',
      'media-masking-options',
    );
    const maskSettings = document.createElement('div');
    maskSettings.className = 'media-mask-settings';
    maskSettings.append(
      numberField(
        'Corner radius',
        commonValue(media.map(editableMediaRadius)),
        (value) => this.store.updateSelected((element) => {
          if (element.type === 'image' || element.type === 'video') {
            setMediaRadius(element, value);
          }
        }),
      ),
      mixedCheckboxField(
        'Circular mask',
        commonValue(media.map(editableCircularMask)),
        (on) => this.store.updateSelected((element) => {
          if (element.type === 'image' || element.type === 'video') {
            setMediaMask(element, on);
          }
        }),
      ),
    );
    masking.content.appendChild(maskSettings);
    wrap.appendChild(masking.section);

    const editableBorders = media.map(editableMediaBorder);
    const borderColors = commonValue(editableBorders.map((border) => border.color ?? ''));
    const border = optionSection('Border', 'media-border-options');
    border.content.appendChild(colorField(
      borderColors === null ? 'Color (mixed)' : 'Color',
      borderColors === null ? editableBorders[0].color : (borderColors || null),
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'image' || element.type === 'video') {
          clearLegacyMediaBorder(element);
          element.borderColor = value;
          if (value === null) element.borderWidth = 0;
        }
      }),
      { clear: { kind: 'none', label: 'No border' } },
    ));
    border.content.appendChild(
      numberField('Width', commonValue(editableBorders.map((border) => border.width)), (value) =>
        this.store.updateSelected((element) => {
          if (element.type === 'image' || element.type === 'video') {
            clearLegacyMediaBorder(element);
            element.borderWidth = Math.max(0, value);
          }
        })),
    );
    wrap.appendChild(border.section);
    if (commonValue(media.map((element) => JSON.stringify(editableVisualEffects(element)))) !== null) {
      wrap.appendChild(this.mediaEffectsControls());
    } else {
      const effects = optionSection('Effects', 'media-effects-controls');
      effects.content.appendChild(
        hint('Effects differ across the selection. Clear or align them individually first.'),
      );
      wrap.appendChild(effects.section);
    }
    return wrap;
  }

  private typeSection(el: SlideElement): HTMLElement | null {
    switch (el.type) {
      case 'video': {
        const wrap = typeSections();

        const playback = optionSection('Playback', 'video-playback-options');

        // Preview in place. Double-clicking the video on the canvas does the
        // same thing; this is the discoverable version.
        const play = document.createElement('button');
        play.className = 'primary panel-action';
        const setLabel = (playing: boolean) => {
          play.textContent = playing ? '❚❚ Pause preview' : '▶ Play preview';
        };
        setLabel(false);
        play.addEventListener('click', () => {
          setLabel(this.onTogglePlay?.(el.id) ?? false);
        });
        playback.content.appendChild(play);

        const flags = document.createElement('div');
        flags.className = 'video-checkbox-grid';
        for (const key of ['autoplay', 'loop', 'muted', 'controls'] as const) {
          flags.appendChild(
            checkboxField(VIDEO_FLAG_LABELS[key], el[key], (v) =>
              this.store.updateSelected((e) => {
                if (e.type === 'video') e[key] = v;
              }),
            ),
          );
        }
        playback.content.appendChild(flags);
        wrap.appendChild(playback.section);

        const sizing = optionSection('Sizing', 'media-sizing-options');
        sizing.content.appendChild(
          checkboxField('Keep aspect ratio', el.fit !== 'fill', (on) =>
            this.store.updateSelected((e) => {
              // 'contain' letterboxes inside the box (AR fixed); 'fill'
              // stretches with it — which is what resizing feels like it
              // should do when this is off.
              if (e.type === 'video') e.fit = on ? 'contain' : 'fill';
            }),
          ),
        );
        wrap.appendChild(sizing.section);
        wrap.appendChild(this.mediaMaskControls(el.id));
        wrap.appendChild(this.mediaBorderControls());
        wrap.appendChild(this.mediaEffectsControls());
        wrap.appendChild(this.trimSection(el));

        // Last resort: the destructive ffmpeg editor. Writes a new file and
        // relinks — for when the non-destructive CSS path is not enough.
        // Desktop only: shells that can't spawn ffmpeg leave onTrimRequest unset.
        if (this.onTrimRequest) {
          const request = this.onTrimRequest;
          const advanced = optionSection('Advanced', 'media-advanced-options');
          const edit = button('Edit w/ ffmpeg…', () => request(el), 'panel-action');
          edit.title = 'Re-encodes to a new file; the original is kept';
          advanced.content.appendChild(edit);
          wrap.appendChild(advanced.section);
        }
        return wrap;
      }

      case 'image': {
        const wrap = typeSections();
        const sizing = optionSection('Sizing', 'media-sizing-options');
        sizing.content.appendChild(
          checkboxField('Keep aspect ratio', el.fit !== 'fill', (on) =>
            this.store.updateSelected((e) => {
              if (e.type === 'image') e.fit = on ? 'contain' : 'fill';
            }),
          ),
        );
        wrap.appendChild(sizing.section);
        wrap.appendChild(this.mediaMaskControls(el.id));
        wrap.appendChild(this.mediaBorderControls());
        wrap.appendChild(this.mediaEffectsControls());
        // PDF is rendered by Chromium's document viewer rather than an image
        // decoder, so it cannot be used as a canvas source here.
        if (this.onRasterRequest && !/\.pdf(?:$|[?#])/i.test(el.src)) {
          const request = this.onRasterRequest;
          const advanced = optionSection('Advanced', 'media-advanced-options');
          const edit = button('Rasterize & paint…', () => request(el), 'panel-action');
          edit.title = 'Paints pixels into a new PNG; the original is kept';
          advanced.content.appendChild(edit);
          wrap.appendChild(advanced.section);
        }
        return wrap;
      }

      case 'text': {
        const wrap = typeSections();
        const typography = optionSection('Typography', 'text-typography-options');
        const layout = optionSection('Layout', 'text-layout-options');

        if (el.table) {
          layout.content.appendChild(hint(
            'Table rows automatically fit their contents. Drag the outer handles or blue column dividers to resize.',
          ));
        } else {
          layout.content.appendChild(checkboxField('Auto-fit text to box', Boolean(el.autoFit), (on) =>
            this.store.updateSelected((target) => {
              if (target.type === 'text') {
                target.autoFit = on;
                if (on && target.style['font-size']) {
                  setWholeTextStyle(target, 'font-size', target.style['font-size']);
                }
              }
            }, { label: on ? 'Enable text auto-fit' : 'Disable text auto-fit' }),
          ));
          layout.content.appendChild(checkboxField('Disable automatic line breaks', editableTextNoWrap(el), (on) =>
            this.store.updateSelected((target) => {
              if (target.type === 'text') setTextNoWrap(target, on);
            }, { label: on ? 'Disable automatic line breaks' : 'Enable automatic line breaks' }),
          ));
        }

        if (!el.table && editableTextNoWrap(el)) {
          layout.content.appendChild(selectField(
            'Compress by', ['shrink', 'condense'], el.noWrapMode ?? 'shrink',
            (v) => this.store.updateSelected((target) => {
              if (target.type === 'text') target.noWrapMode = v as 'shrink' | 'condense';
            }, { label: 'Change no-wrap compression' }),
          ));
        }

        const computedTypography = this.textComputedTypography?.(el.id);
        const authoredFamily = el.style['font-family'] ?? '';
        const displayedFamily = authoredFamily
          || (computedTypography?.fontFamilyExplicit ? computedTypography.fontFamily ?? '' : '');
        typography.content.appendChild(fontFamilyField(
          'Font family', displayedFamily,
          (value) => {
            if (this.onApplyTextSelectionFontFamily?.(value)) return;
            this.store.updateSelected((target) => {
              if (target.type !== 'text') return;
              setWholeTextStyle(target, 'font-family', value || null);
            }, { label: 'Change font family' });
          },
          {
            themeValue: displayedFamily ? undefined : computedTypography?.fontFamily ?? undefined,
            themeFamilies: this.deckThemeFamilies(),
          },
        ));

        const authoredSize = Number.parseFloat(el.style['font-size'] ?? '') || null;
        const displayedSize = authoredSize
          ?? (computedTypography?.fontSizeExplicit ? computedTypography.fontSize : null);
        const authoredWeight = Number.parseFloat(el.style['font-weight'] ?? '') || null;
        const displayedWeight = authoredWeight
          ?? (computedTypography?.fontWeightExplicit ? computedTypography.fontWeight : null);
        const fontMetrics = document.createElement('div');
        fontMetrics.className = 'compact-field-row';
        const fontSizeField = optionalNumberField(
          'Font size',
          displayedSize,
          (value) => {
            const normalized = fontSizeValue(value);
            const size = `${normalized}px`;
            if (this.onApplyTextSelectionFontSize?.(normalized)) return;
            this.store.updateSelected((target) => {
              if (target.type === 'text') setWholeTextStyle(target, 'font-size', size);
            }, { label: 'Change font size' });
          },
          () => {
            if (this.onApplyTableCellTextStyle?.('fontSize', null)) return;
            this.store.updateSelected((target) => {
              if (target.type === 'text') setWholeTextStyle(target, 'font-size', null);
            }, { label: 'Use theme font size' });
          },
          'px',
          {
            min: 6,
            max: 400,
            themeValue: displayedSize === null ? computedTypography?.fontSize ?? null : null,
            maxFractionDigits: 1,
          },
        );
        const ceilingSize = displayedSize ?? computedTypography?.fontSize ?? null;
        const fittedSize = computedTypography?.fittedFontSize ?? null;
        if (
          ceilingSize !== null && fittedSize !== null
          && !computedTypography?.fontSizeExplicit
          && fittedSize < ceilingSize - 0.05
        ) {
          const status = document.createElement('span');
          status.className = 'auto-fit-value';
          status.textContent = `Fitted to ${formatNumber(fittedSize, 1)} px`;
          status.title = `Auto-fit reduced the displayed text from ${formatNumber(ceilingSize, 1)} px to ${formatNumber(fittedSize, 1)} px to fit this box.`;
          fontSizeField.appendChild(status);
        }
        fontMetrics.appendChild(fontSizeField);
        fontMetrics.appendChild(optionalNumberField(
          'Font weight',
          displayedWeight,
          (value) => {
            const weight = String(Math.max(1, Math.min(1000, value)));
            if (this.onApplyTextSelectionWeight?.(Number(weight))) return;
            this.store.updateSelected((target) => {
              if (target.type === 'text') setWholeTextStyle(target, 'font-weight', weight);
            }, { label: 'Change font weight' });
          },
          () => {
            if (this.onApplyTableCellTextStyle?.('fontWeight', null)) return;
            this.store.updateSelected((target) => {
              if (target.type === 'text') setWholeTextStyle(target, 'font-weight', null);
            }, { label: 'Use theme font weight' });
          },
          '',
          {
            min: 1,
            max: 1000,
            step: 25,
            themeValue: displayedWeight === null ? computedTypography?.fontWeight ?? null : null,
          },
        ));
        typography.content.appendChild(fontMetrics);

        if (this.editingText?.()) {
          const selectionStyle = document.createElement('div');
          selectionStyle.className = 'text-selection-style';
          const formatButtons = document.createElement('div');
          formatButtons.className = 'button-row text-format-buttons';
          for (const [format, label, title] of [
            ['bold', 'B', 'Bold (Cmd/Ctrl+B)'],
            ['italic', 'I', 'Italic (Cmd/Ctrl+I)'],
            ['underline', 'U', 'Underline (Cmd/Ctrl+U)'],
          ] as const) {
            const choice = button(label, () => {
              if (this.onToggleTextSelectionFormat?.(format)) return;
              const active = wholeTextFormatState(el, format);
              this.store.updateSelected((target) => {
                if (target.type === 'text') setWholeTextFormat(target, format, !active);
              }, { label: `${active ? 'Remove' : 'Apply'} ${format}` });
            });
            choice.classList.add(`text-format-${format}`);
            choice.title = title;
            choice.setAttribute('aria-label', title);
            choice.setAttribute(
              'aria-pressed',
              String(this.textSelectionFormatState?.(format) ?? false),
            );
            choice.addEventListener('pointerdown', (event) => event.preventDefault());
            formatButtons.appendChild(choice);
          }
          selectionStyle.appendChild(formatButtons);
          typography.content.appendChild(selectionStyle);
        }

        // Semantic role, orthogonal to the free-form class field: the role is
        // what "Cast fonts" and theme.css target, so restyling the deck later
        // lands on the right elements.
        const ROLES: Array<[string, string]> = [
          ['role-title', 'Title'],
          ['role-body', 'Body'],
          ['role-caption', 'Caption'],
          ['', 'None'],
        ];
        const current = ROLES.find(([cls]) => cls && el.class.includes(cls))?.[0] ?? '';
        const roleSelect = document.createElement('label');
        roleSelect.className = 'field';
        const roleSpan = document.createElement('span');
        roleSpan.textContent = 'Role';
        const roleDrop = document.createElement('select');
        for (const [value, label] of ROLES) {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = label;
          roleDrop.appendChild(opt);
        }
        roleDrop.value = current;
        roleDrop.addEventListener('change', () =>
          this.store.updateSelected((e) => {
            e.class = e.class.filter((c) => !c.startsWith('role-'));
            if (roleDrop.value) e.class.push(roleDrop.value);
          }),
        );
        roleSelect.append(roleSpan, roleDrop);
        typography.content.appendChild(roleSelect);

        // One mutually-exclusive list style control. When a live selection is
        // inside a list, the canvas transforms that entire list in place.
        const selectedListStyle = this.textSelectionListStyle?.();
        const listStyle = selectField(
          'List', ['None', 'Bulleted', 'Numbered'],
          selectedListStyle ?? listStyleOfHtml(el.html),
          (style) => {
            if (this.onApplyTextSelectionListStyle?.(style as ListStyle)) return;
            this.store.updateSelected((e) => {
              if (e.type === 'text') e.html = applyListStyleToHtml(e.html, style as ListStyle);
            }, { label: `Change list style to ${style.toLowerCase()}` });
          },
        );
        listStyle.classList.add('text-list-style');
        if (/<table\b/i.test(el.html)) {
          const select = listStyle.querySelector('select');
          if (select) {
            select.disabled = true;
            select.title = 'List styles do not apply to tables';
          }
        }
        layout.content.appendChild(listStyle);

        const authoredMarker = listMarkerColorState(el.html);
        if (authoredMarker.hasList) {
          const marker = this.textSelectionMarkerColor?.() ?? authoredMarker;
          layout.content.appendChild(colorField(
            marker.mixed ? 'Marker colour (mixed)' : 'Marker colour',
            marker.value,
            (value) => {
              if (this.onApplyTextSelectionMarkerColor?.(value)) return;
              this.store.updateSelected((target) => {
                if (target.type === 'text') {
                  target.html = setListMarkerColor(target.html, value);
                }
              }, { label: value ? 'Change list marker colour' : 'Make list markers follow text colour' });
            },
            {
              inheritedValue: this.textPaintInfo(el).inheritedValue,
              clear: { kind: 'css', label: 'Follow text colour' },
            },
          ));
        }

        if (/<table\b/i.test(el.html)) {
          const table = optionSection('Table', 'text-table-options');
          const selected = this.tableSelection?.();
          if (!selected || selected.elementId !== el.id) {
            table.content.appendChild(hint(
              'Double-click the table, then drag horizontally, vertically, or diagonally across cells.',
            ));
          } else {
            const rowStart = Math.min(selected.row, selected.rowEnd) + 1;
            const rowEnd = Math.max(selected.row, selected.rowEnd) + 1;
            const columnStart = Math.min(selected.column, selected.columnEnd) + 1;
            const columnEnd = Math.max(selected.column, selected.columnEnd) + 1;
            const location = selected.mode === 'cell'
              ? `Row ${rowStart}, column ${columnStart}`
              : selected.mode === 'row'
                ? `Row ${rowStart}, columns ${columnStart}–${columnEnd}`
                : selected.mode === 'column'
                  ? `Column ${columnStart}, rows ${rowStart}–${rowEnd}`
                  : `Rows ${rowStart}–${rowEnd}, columns ${columnStart}–${columnEnd}`;
            table.content.appendChild(hint(
              `${location} · drag to select a rectangular range`,
            ));
            table.content.appendChild(colorField(
              'Cell fill', null,
              (value) => this.onApplyTableCellColor?.('backgroundColor', value),
              { clear: { kind: 'none', label: 'No fill' } },
            ));
            table.content.appendChild(colorField(
              'Cell text', null,
              (value) => this.onApplyTableCellColor?.('color', value),
              { clear: { kind: 'none', label: 'Inherited text colour' } },
            ));
            const borderSettings = this.tableBorderSettings?.() ?? {
              color: '#000000', width: 1, drawing: false,
            };
            const borderPaint = document.createElement('div');
            borderPaint.className = 'compact-field-row table-border-paint';
            borderPaint.append(
              colorField('Border color', borderSettings.color, (value) =>
                this.onSetTableBorderColor?.(value ?? '#000000')),
              numberField('Border width', borderSettings.width, (value) =>
                this.onSetTableBorderWidth?.(value), { step: 0.25 }),
            );
            table.content.appendChild(borderPaint);
            const borders = document.createElement('div');
            borders.className = 'button-row table-border-buttons';
            borders.append(
              button('No borders', () => this.onApplyTableBorderPreset?.('none')),
              button('Vertical borders', () => this.onApplyTableBorderPreset?.('vertical')),
              button('Horizontal borders', () => this.onApplyTableBorderPreset?.('horizontal')),
            );
            const draw = button('Draw borders', () =>
              this.onSetTableBorderDrawing?.(!borderSettings.drawing));
            draw.setAttribute('aria-pressed', String(borderSettings.drawing));
            borders.appendChild(draw);
            table.content.appendChild(borders);
            const columns = document.createElement('div');
            columns.className = 'button-row table-column-buttons';
            columns.append(
              button('Insert before', () => this.onInsertTableColumn?.(false)),
              button('Insert after', () => this.onInsertTableColumn?.(true)),
            );
            const remove = button('Delete column', () => this.onDeleteTableColumn?.());
            remove.classList.add('danger');
            (remove as HTMLButtonElement).disabled = selected.columns <= 1;
            columns.appendChild(remove);
            table.content.appendChild(columns);
          }
          // Table actions operate on the cell selection owned by the live
          // contenteditable. None of these buttons needs focus; keeping the
          // pointer-down on the canvas prevents a null-relatedTarget blur from
          // ending the edit and clearing that selection before click.
          table.content.addEventListener('pointerdown', (event) => {
            if (event.target instanceof Element && event.target.closest('button')) {
              event.preventDefault();
            }
          });
          layout.content.appendChild(table.section);
        }

        const paint = this.textPaintInfo(el);
        typography.content.appendChild(
          colorField(
            'Colour',
            paint.value,
            (v) => {
              if (this.onApplyTextSelectionColor?.(v)) return;
              this.store.updateSelected((e) => {
                if (e.type === 'text') setWholeTextColor(e, v);
              });
            },
            {
              inheritedValue: paint.inheritedValue,
              source: paint.source,
              clear: paint.clear,
            },
          ),
        );
        const alignment = document.createElement('div');
        alignment.className = 'compact-field-row';
        alignment.appendChild(
          alignButtonsField('Align', el.align, (v) =>
            this.onApplyTextSelectionAlignment?.(v) || this.store.updateSelected((e) => {
              if (e.type === 'text') setWholeTextAlignment(e, v);
            }, { label: 'Change text alignment' }),
          ),
        );
        alignment.appendChild(
          selectField('Vertical', ['top', 'middle', 'bottom'], el.valign, (v) =>
            this.onApplyTableCellTextStyle?.('verticalAlign', v) || this.store.updateSelected((e) => {
              if (e.type === 'text') e.valign = v as 'top';
            }),
          ),
        );
        layout.content.appendChild(alignment);
        const selectedParagraphSpacing = this.textSelectionParagraphSpacing?.() ?? null;
        layout.content.appendChild(optionalNumberField(
          'Paragraph spacing',
          selectedParagraphSpacing ?? el.paragraphSpacing ?? null,
          (value) => {
            const spacing = Math.max(0, value);
            if (this.onApplyTextSelectionParagraphSpacing?.(spacing)) return;
            this.store.updateSelected((e) => {
              if (e.type === 'text') setWholeTextParagraphSpacing(e, spacing);
            }, { label: 'Change paragraph spacing' });
          },
          () => {
            if (this.onApplyTextSelectionParagraphSpacing?.(null)) return;
            this.store.updateSelected((e) => {
              if (e.type === 'text') setWholeTextParagraphSpacing(e, null);
            }, { label: 'Use theme paragraph spacing' });
          },
          'px',
          {
            min: 0,
            themeValue: (selectedParagraphSpacing ?? el.paragraphSpacing ?? null) === null
              ? computedTypography?.paragraphSpacing ?? null
              : null,
          },
        ));
        wrap.append(typography.section, layout.section);
        return wrap;
      }

      case 'html': {
        const wrap = typeSections();
        const markup = optionSection('Markup', 'html-markup-options');
        markup.content.appendChild(
          textAreaField('Markup', el.html, (v) =>
            this.store.updateSelected((e) => {
              if (e.type === 'html') e.html = v;
            }),
          ),
        );
        wrap.appendChild(markup.section);
        return wrap;
      }

      case 'shape': {
        const wrap = typeSections();
        const style = optionSection('Style', 'shape-style-options');
        style.content.appendChild(
          selectField('Kind', ['rect', 'ellipse', 'line', 'arrow'], el.shape, (v) =>
            this.store.updateSelected((e) => {
              if (e.type === 'shape') e.shape = v as 'rect';
            }),
          ),
        );
        if (el.shape === 'line' || el.shape === 'arrow') {
          style.content.appendChild(
            checkboxField('Curved', Boolean(el.control), (on) =>
              this.store.updateSelected((e) => {
                if (e.type !== 'shape') return;
                e.control = on
                  ? { x: e.x + e.w / 2, y: e.y + e.h / 2 - Math.max(80, e.w / 3) }
                  : null;
              }),
            ),
          );
        }
        const colors = document.createElement('div');
        colors.className = 'compact-field-row';
        colors.appendChild(
          colorField('Fill', el.fill, (v) =>
            this.store.updateSelected((e) => {
              if (e.type === 'shape') e.fill = v;
            }),
            { clear: { kind: 'none', label: 'No fill (transparent)' } },
          ),
        );
        colors.appendChild(
          colorField('Stroke', el.stroke, (v) =>
            this.store.updateSelected((e) => {
              if (e.type === 'shape') e.stroke = v;
            }),
            { clear: { kind: 'none', label: 'No stroke' } },
          ),
        );
        style.content.appendChild(colors);
        const nums = document.createElement('div');
        nums.className = 'compact-field-row';
        nums.appendChild(
          numberField('WIDTH', el.strokeWidth, (v) =>
            this.store.updateSelected((e) => {
              if (e.type === 'shape') e.strokeWidth = Math.max(0, v);
            }),
          ),
        );
        nums.appendChild(
          numberField('RADIUS', el.radius, (v) =>
            this.store.updateSelected((e) => {
              if (e.type === 'shape') e.radius = Math.max(0, v);
            }),
          ),
        );
        style.content.appendChild(nums);
        wrap.appendChild(style.section);
        return wrap;
      }

      case 'unsupported': {
        const wrap = typeSections();
        const details = optionSection('Details', 'unsupported-details');
        details.content.appendChild(
          hint(
            `Imported from ${el.originalType}. Geometry was preserved; replace it with a native element.`,
          ),
        );
        wrap.appendChild(details.section);
        return wrap;
      }
    }
  }

  /** The solid colour reported by the live canvas after the full CSS cascade. */
  private computedTextColor(el: Extract<SlideElement, { type: 'text' }>): string | null {
    const escapeCss = (globalThis.CSS as { escape?: (value: string) => string } | undefined)
      ?.escape;
    const escaped = escapeCss ? escapeCss(el.id) : el.id.replace(/["\\]/g, '\\$&');
    const wrapper = document.querySelector<HTMLElement>(
      `.canvas-host [data-element-id="${escaped}"]`,
    );
    const node = wrapper?.querySelector<HTMLElement>('.text-content') ?? wrapper;
    return node ? colorForInput(getComputedStyle(node).color) : null;
  }

  /** The installed theme colour for this semantic role, if the deck has one. */
  private themeTextColor(el: Extract<SlideElement, { type: 'text' }>): string | null {
    const style = this.store.get().deck.themeStyle;
    if (!style) return null;
    const role = el.class.find((name) =>
      /^role-(title|heading|body|caption)$/.test(name))?.slice(5) as
      | 'title' | 'heading' | 'body' | 'caption' | undefined;
    return colorForInput(
      (role ? style.fonts[role].color : undefined) ?? style.colors.text,
    );
  }

  /**
   * Distinguish an explicit solid from an installed theme value and from
   * arbitrary CSS paint (gradients, inline runs, or user-authored rules).
   * `null` alone is never enough evidence that a colour came from the theme.
   */
  private textPaintInfo(el: Extract<SlideElement, { type: 'text' }>): TextPaintInfo {
    const declarations = [el.contentStyle ?? {}, el.style];
    const declared = (property: string): string | undefined =>
      declarations.map((style) => style[property]).find((value) => value !== undefined);
    const declaredColor = declared('color') ?? declared('-webkit-text-fill-color') ?? null;
    const background = declared('background-image') ?? declared('background') ?? null;
    const clip = declared('background-clip') ?? declared('-webkit-background-clip') ?? '';
    const gradient = background && background !== 'none' && /gradient\(/i.test(background)
      ? background
      : null;
    const inlineRunPaint = /style\s*=\s*["'][^"']*(?:color|-webkit-text-fill-color|background(?:-image)?)\s*:/i
      .test(el.html);
    const cssPaint = Boolean(
      (gradient && /text/i.test(clip))
      || declared('-webkit-text-fill-color')
      || inlineRunPaint,
    );
    const computed = this.computedTextColor(el);
    const theme = this.themeTextColor(el);
    const explicitSolid = colorForInput(declaredColor);

    if (cssPaint || (declaredColor !== null && !explicitSolid)) {
      return {
        value: declaredColor,
        inheritedValue: computed ?? explicitSolid,
        source: {
          kind: 'css',
          preview: gradient ?? explicitSolid,
          label: gradient ? 'CSS gradient text' : 'CSS-defined text paint',
        },
        clear: { kind: 'css', label: 'Remove CSS text paint' },
      };
    }

    if (explicitSolid) {
      return {
        value: declaredColor,
        inheritedValue: computed ?? explicitSolid,
        clear: theme
          ? { kind: 'theme', label: 'Use theme text color' }
          : { kind: 'css', label: 'Use inherited text color' },
      };
    }

    if (theme && (!computed || computed === theme)) {
      return {
        value: null,
        inheritedValue: computed ?? theme,
        source: { kind: 'theme', label: 'Theme color' },
        clear: { kind: 'theme', label: 'Use theme text color' },
      };
    }

    return {
      value: null,
      inheritedValue: computed,
      source: { kind: 'css', preview: computed, label: 'CSS-defined text color' },
      clear: { kind: 'css', label: 'Use inherited text color' },
    };
  }

  private mediaBorderControls(): HTMLElement {
    const el = this.store.selectedElements()[0];
    const border = optionSection('Border', 'media-border-options');
    if (!el || (el.type !== 'image' && el.type !== 'video')) return border.section;
    const editable = editableMediaBorder(el);
    border.content.appendChild(colorField('Color', editable.color, (value) =>
      this.store.updateSelected((target) => {
        if (target.type === 'image' || target.type === 'video') {
          clearLegacyMediaBorder(target);
          target.borderColor = value;
          if (value === null) target.borderWidth = 0;
        }
      }), { clear: { kind: 'none', label: 'No border' } }));
    border.content.appendChild(
      numberField('Width', editable.width, (value) =>
        this.store.updateSelected((target) => {
          if (target.type === 'image' || target.type === 'video') {
            clearLegacyMediaBorder(target);
            target.borderWidth = Math.max(0, value);
          }
        })),
    );
    return border.section;
  }

  private mediaEffectsControls(): HTMLElement {
    const el = this.store.selectedElements()[0];
    const effects = optionSection('Effects', 'media-effects-controls');
    const wrap = effects.content;
    if (!el || !supportsVisualEffects(el)) return effects.section;

    const editableEffects = editableVisualEffects(el);
    for (const [index, effect] of editableEffects.entries()) {
      const row = document.createElement('div');
      row.className = effect.type === 'gaussianNoise'
        ? 'media-effect-row media-effect-row-noise'
        : 'media-effect-row';
      row.dataset.effectIndex = String(index);
      const name = document.createElement('span');
      name.textContent = effect.type === 'grayscale' ? 'Greyscale' :
        effect.type === 'gaussianNoise' ? 'Gaussian Noise' :
          effect.type[0].toUpperCase() + effect.type.slice(1);
      const value = document.createElement('input');
      value.type = 'number';
      value.min = effect.type === 'posterize' ? '2' : '0';
      value.max = effect.type === 'blur' ? '200' : effect.type === 'posterize' ? '32' : '1';
      value.step = effect.type === 'grayscale' || effect.type === 'gaussianNoise'
        ? '0.05' : '1';
      value.value = String(effectValue(effect));
      value.title = effect.type === 'blur' ? 'Blur radius in pixels' :
        effect.type === 'posterize' ? 'Number of colour levels' : 'Amount from 0 to 1';
      value.setAttribute('aria-label', value.title);
      value.addEventListener('change', () => {
        const next = Number(value.value);
        if (!Number.isFinite(next)) return;
        this.store.updateSelected((target) => {
          if (!supportsVisualEffects(target)) return;
          const current = takeVisualEffectsOwnership(target)[index];
          if (!current) return;
          if (current.type === 'blur') current.radius = clamp(next, 0, 200);
          else if (current.type === 'posterize') current.levels = Math.round(clamp(next, 2, 32));
          else current.amount = clamp(next, 0, 1);
        }, { label: `Adjust ${effect.type} effect` });
      });

      const cutoff = document.createElement('input');
      if (effect.type === 'gaussianNoise') {
        cutoff.type = 'number';
        cutoff.min = '0.001';
        cutoff.max = '1';
        cutoff.step = '0.01';
        cutoff.value = String(effect.frequencyCutoff);
        cutoff.title = 'Frequency cutoff from 0.001 to 1; higher values make finer grain';
        cutoff.setAttribute('aria-label', 'Frequency cutoff');
        cutoff.addEventListener('change', () => {
          const next = Number(cutoff.value);
          if (!Number.isFinite(next)) return;
          this.store.updateSelected((target) => {
            if (!supportsVisualEffects(target)) return;
            const current = takeVisualEffectsOwnership(target)[index];
            if (current?.type === 'gaussianNoise') {
              current.frequencyCutoff = clamp(next, 0.001, 1);
            }
          }, { label: 'Adjust Gaussian noise frequency cutoff' });
        });
      }

      const up = smallButton('↑', 'Move effect earlier', () => this.moveMediaEffect(index, -1));
      const down = smallButton('↓', 'Move effect later', () => this.moveMediaEffect(index, 1));
      up.disabled = index === 0;
      down.disabled = index === editableEffects.length - 1;
      const remove = smallButton('×', 'Remove effect', () => {
        this.store.updateSelected((target) => {
          if (!supportsVisualEffects(target)) return;
          target.effects = takeVisualEffectsOwnership(target)
            .filter((_, candidate) => candidate !== index);
        }, { label: `Remove ${effect.type} effect` });
      });
      row.append(name, value);
      if (effect.type === 'gaussianNoise') row.appendChild(cutoff);
      row.append(up, down, remove);
      wrap.appendChild(row);
    }

    const add = document.createElement('select');
    add.className = 'effect-add panel-action-select';
    for (const [value, label] of [
      ['', '+ Add effect'],
      ['blur', 'Blur'],
      ['posterize', 'Posterize'],
      ['grayscale', 'Greyscale'],
      ['gaussianNoise', 'Gaussian Noise'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      add.appendChild(option);
    }
    add.addEventListener('change', () => {
      if (!add.value) return;
      const effect: MediaEffect = add.value === 'blur'
        ? { type: 'blur', radius: 8 }
        : add.value === 'posterize'
          ? { type: 'posterize', levels: 4 }
          : add.value === 'gaussianNoise'
            ? { type: 'gaussianNoise', amount: 0.35, frequencyCutoff: 0.12 }
            : { type: 'grayscale', amount: 1 };
      this.store.updateSelected((target) => {
        if (supportsVisualEffects(target)) {
          target.effects = [...takeVisualEffectsOwnership(target), structuredClone(effect)];
        }
      }, { label: `Add ${effect.type} effect` });
      add.value = '';
    });
    wrap.appendChild(add);
    return effects.section;
  }

  private moveMediaEffect(index: number, delta: -1 | 1): void {
    this.store.updateSelected((target) => {
      if (!supportsVisualEffects(target)) return;
      const effects = [...takeVisualEffectsOwnership(target)];
      const destination = index + delta;
      if (!effects[index] || destination < 0 || destination >= effects.length) return;
      [effects[index], effects[destination]] = [effects[destination], effects[index]];
      target.effects = effects;
    }, { label: 'Reorder media effects' });
  }
}

/* --- small DOM helpers, kept local so the panel stays self-contained --- */

function group(title: string): HTMLElement {
  const el = document.createElement('section');
  el.className = 'insp-group';
  const h = document.createElement('h3');
  h.textContent = title;
  el.appendChild(h);
  return el;
}

/** Type-specific sections; the selected element type is already named above. */
function typeSections(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'insp-type-sections';
  return el;
}

/** A compact, ellipsized media path that reveals and copies its full value. */
function mediaSourceButton(source: string): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = 'media-source';
  control.textContent = source;
  const defaultTitle = `${source}\nClick to copy path`;
  control.title = defaultTitle;
  control.setAttribute('aria-label', `Copy media path: ${source}`);
  control.addEventListener('click', () => {
    void copyText(source).then((copied) => {
      control.classList.toggle('copied', copied);
      control.title = copied ? `Copied: ${source}` : `Could not copy: ${source}`;
      window.setTimeout(() => {
        control.classList.remove('copied');
        control.title = defaultTitle;
      }, 1200);
    });
  });
  return control;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.style.position = 'fixed';
    scratch.style.opacity = '0';
    document.body.appendChild(scratch);
    scratch.select();
    const copied = document.execCommand('copy');
    scratch.remove();
    return copied;
  } catch {
    return false;
  }
}

function sectionTitle(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'insp-title';
  el.textContent = text;
  return el;
}

function hint(text: string): HTMLElement {
  const el = document.createElement('p');
  el.className = 'insp-hint';
  el.textContent = text;
  return el;
}

function effectValue(effect: MediaEffect): number {
  if (effect.type === 'blur') return effect.radius;
  if (effect.type === 'posterize') return effect.levels;
  return effect.amount;
}

/**
 * Visual effects are a media control. Text elements still carry `effects` in
 * the schema (and existing decks still render theirs), but the editor no
 * longer offers them: blur, posterize, greyscale and Gaussian noise on type
 * were never a good idea, and the controls are gone from every surface.
 */
function supportsVisualEffects(
  element: SlideElement,
): element is Extract<SlideElement, { type: 'image' | 'video' }> {
  return element.type === 'image' || element.type === 'video';
}

function clearLegacyMediaBorder(
  element: Extract<SlideElement, { type: 'image' | 'video' }>,
): void {
  const style = { ...element.style };
  for (const property of Object.keys(style)) {
    if (isMediaBorderPaint(property)) delete style[property];
  }
  element.style = style;
}

function editableTextNoWrap(element: Extract<SlideElement, { type: 'text' }>): boolean {
  return element.noWrap ?? cssNoWrap(element.style['white-space']);
}

function setTextNoWrap(
  element: Extract<SlideElement, { type: 'text' }>,
  noWrap: boolean,
): void {
  const style = { ...element.style };
  delete style['white-space'];
  element.style = style;
  element.noWrap = noWrap;
}

/** The radius the media visibly has, including pre-typed Agent HTML imports. */
function editableMediaRadius(
  element: Extract<SlideElement, { type: 'image' | 'video' }>,
): number {
  if (element.borderRadius !== undefined) return element.borderRadius;
  const radius = cssMediaRadius(element.style['border-radius']);
  return radius && 'borderRadius' in radius ? radius.borderRadius : 0;
}

/** Move inspector-owned radius state out of the legacy CSS fallback. */
function setMediaRadius(
  element: Extract<SlideElement, { type: 'image' | 'video' }>,
  value: number,
): void {
  const style = { ...element.style };
  delete style['border-radius'];
  element.style = style;
  element.borderRadius = Math.max(0, value);
}

function editableCircularMask(
  element: Extract<SlideElement, { type: 'image' | 'video' }>,
): boolean {
  if (element.maskShape !== undefined) return element.maskShape === 'circle';
  const radius = cssMediaRadius(element.style['border-radius']);
  return Boolean(radius && 'maskShape' in radius && radius.maskShape === 'circle');
}

function setMediaMask(
  element: Extract<SlideElement, { type: 'image' | 'video' }>,
  circular: boolean,
): void {
  const style = { ...element.style };
  delete style['border-radius'];
  element.style = style;
  // `rect` is deliberately explicit: it prevents an old CSS 50% radius from
  // reappearing after the checkbox is turned off.
  element.maskShape = circular ? 'circle' : 'rect';
}

function editableMediaBorder(
  element: Extract<SlideElement, { type: 'image' | 'video' }>,
): { width: number; color: string | null } {
  if (element.borderWidth !== undefined) {
    return { width: element.borderWidth, color: element.borderColor ?? null };
  }
  const border = cssMediaBorder(element.style);
  return border
    ? { width: border.width, color: element.borderColor ?? border.color }
    : { width: 0, color: element.borderColor ?? null };
}

function editableVisualEffects(
  element: Extract<SlideElement, { type: 'text' | 'image' | 'video' }>,
): MediaEffect[] {
  return element.effects ?? cssVisualEffects(element.style.filter) ?? [];
}

/** Promote or replace legacy filter CSS before an inspector effect mutation. */
function takeVisualEffectsOwnership(
  element: Extract<SlideElement, { type: 'text' | 'image' | 'video' }>,
): MediaEffect[] {
  const effects = structuredClone(editableVisualEffects(element));
  const style = { ...element.style };
  delete style.filter;
  element.style = style;
  element.effects = effects;
  return effects;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smallButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button';
  control.className = 'icon-button';
  control.textContent = label;
  control.title = title;
  control.addEventListener('click', onClick);
  return control;
}

function numberField(
  label: string,
  value: number | null,
  onChange: (v: number) => void,
  opts: { step?: number } = {},
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field field-number';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(opts.step ?? 1);
  input.value = value === null ? '' : String(round(value));
  input.placeholder = value === null ? '—' : '';
  // `change`, not `input`: committing on every keystroke would flood undo and
  // fight you mid-typing.
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onChange(v);
  });
  wrap.append(span, input);
  return wrap;
}

/** Element opacity as a familiar percentage slider with a live canvas preview. */
function opacityField(
  value: number | null,
  onBegin: () => void,
  onInput: (value: number) => void,
  onEnd: () => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field field-opacity';

  const label = document.createElement('span');
  label.textContent = 'Opacity';

  const controls = document.createElement('div');
  controls.className = 'field-opacity-controls';
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '100';
  input.step = '1';
  input.value = String(value === null ? 50 : Math.round(clamp(value, 0, 1) * 100));
  input.setAttribute('aria-label', 'Opacity');

  const output = document.createElement('output');
  output.textContent = value === null ? 'Mixed' : `${input.value}%`;
  output.htmlFor = input.id;

  let active = false;
  const begin = () => {
    if (active) return;
    active = true;
    onBegin();
  };
  const update = () => {
    begin();
    output.textContent = `${input.value}%`;
    input.setAttribute('aria-valuetext', output.textContent);
    onInput(Number(input.value) / 100);
  };
  const end = () => {
    if (!active) return;
    active = false;
    onEnd();
  };
  input.addEventListener('pointerdown', begin);
  input.addEventListener('input', update);
  input.addEventListener('change', end);
  input.addEventListener('pointerup', end);
  input.addEventListener('pointercancel', end);
  input.addEventListener('blur', end);

  controls.append(input, output);
  wrap.append(label, controls);
  return wrap;
}

function optionalNumberField(
  label: string,
  value: number | null,
  onChange: (value: number) => void,
  onClear: () => void,
  suffix = '',
  opts: {
    min?: number;
    max?: number;
    step?: number;
    themeValue?: number | null;
    maxFractionDigits?: number;
  } = {},
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field field-number';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(opts.min ?? 1);
  if (opts.max !== undefined) input.max = String(opts.max);
  input.step = String(opts.step ?? 1);
  const inherited = value === null && Number.isFinite(opts.themeValue)
    ? opts.themeValue as number
    : null;
  const display = (number: number): string => opts.maxFractionDigits === undefined
    ? String(round(number))
    : formatNumber(number, opts.maxFractionDigits);
  input.value = value === null ? (inherited === null ? '' : display(inherited)) : display(value);
  input.placeholder = inherited === null ? 'theme' : '';
  input.title = suffix ? `Value in ${suffix}` : label;
  input.setAttribute('aria-label', label);
  let lastAppliedValue = input.value;
  const applyValue = () => {
    if (input.value === lastAppliedValue) return;
    lastAppliedValue = input.value;
    if (!input.value.trim()) onClear();
    else {
      const parsed = Number(input.value);
      if (Number.isFinite(parsed)) onChange(parsed);
    }
  };
  input.addEventListener('change', applyValue);
  // Chromium's native number steppers update the value before pointerup but
  // may defer `change` until blur. Commit on pointerup as well so the inspector
  // can preserve and format the live canvas selection immediately. The value
  // guard above keeps this to one history entry when `change` also fires.
  input.addEventListener('pointerup', applyValue);
  const steppers = document.createElement('span');
  steppers.className = 'number-step-buttons';
  for (const [direction, glyph] of [['up', '▲'], ['down', '▼']] as const) {
    const step = document.createElement('button');
    step.type = 'button';
    step.className = `number-step-${direction}`;
    step.textContent = glyph;
    step.setAttribute('aria-label', `${label} ${direction}`);
    step.addEventListener('pointerdown', (event) => event.preventDefault());
    step.addEventListener('click', (event) => {
      event.preventDefault();
      const increment = Number(input.step) || 1;
      const fallback = Number(input.min) || 0;
      const current = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : fallback;
      const next = current + (direction === 'up' ? increment : -increment);
      const minimum = Number(input.min);
      const maximum = Number(input.max);
      input.valueAsNumber = Math.min(
        Number.isFinite(maximum) ? maximum : Number.POSITIVE_INFINITY,
        Math.max(Number.isFinite(minimum) ? minimum : Number.NEGATIVE_INFINITY, next),
      );
      applyValue();
    });
    steppers.appendChild(step);
  }
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'icon-button';
  clear.textContent = '×';
  clear.title = 'Use theme value';
  clear.addEventListener('click', (event) => {
    event.preventDefault();
    onClear();
  });
  const controls = document.createElement('div');
  controls.className = 'optional-number-controls';
  controls.appendChild(input);
  if (inherited !== null) {
    const indicator = document.createElement('span');
    indicator.className = 'theme-value-indicator';
    indicator.textContent = '(Theme)';
    controls.appendChild(indicator);
    controls.classList.add('has-theme-value');
  }
  controls.appendChild(steppers);
  controls.appendChild(clear);
  wrap.append(span, controls);
  return wrap;
}

function textAreaField(
  label: string,
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('textarea');
  input.rows = 4;
  input.value = value;
  input.addEventListener('change', () => onChange(input.value));
  wrap.append(span, input);
  return wrap;
}

function checkboxField(
  label: string,
  value: boolean,
  onChange: (v: boolean) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field field-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  const span = document.createElement('span');
  span.textContent = label;
  wrap.append(input, span);
  return wrap;
}

/** A named cluster of related inspector controls. */
function optionSection(
  title: string,
  contentClass: string,
): { section: HTMLElement; content: HTMLElement } {
  const section = document.createElement('section');
  section.className = 'insp-option-section';
  const heading = document.createElement('h4');
  heading.className = 'insp-subtitle';
  heading.textContent = title;
  const content = document.createElement('div');
  content.className = contentClass;
  section.append(heading, content);
  return { section, content };
}

function mixedCheckboxField(
  label: string,
  value: boolean | null,
  onChange: (v: boolean) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field field-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value ?? false;
  input.indeterminate = value === null;
  input.addEventListener('change', () => {
    input.indeterminate = false;
    onChange(input.checked);
  });
  const span = document.createElement('span');
  span.textContent = label;
  wrap.append(input, span);
  return wrap;
}

function selectField(
  label: string,
  options: string[],
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const select = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    select.appendChild(opt);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  wrap.append(span, select);
  return wrap;
}

/** The four horizontal alignments, drawn as the usual ragged-line glyphs. */
const TEXT_ALIGN_CHOICES: { value: TextAlign; title: string; lines: number[][] }[] = [
  { value: 'left', title: 'Align left', lines: [[0, 10], [0, 7], [0, 10], [0, 5]] },
  { value: 'center', title: 'Align centre', lines: [[0, 10], [1.5, 7], [0, 10], [2.5, 5]] },
  { value: 'right', title: 'Align right', lines: [[0, 10], [3, 7], [0, 10], [5, 5]] },
  { value: 'justify', title: 'Justify', lines: [[0, 10], [0, 10], [0, 10], [0, 10]] },
];

type TextAlign = 'left' | 'center' | 'right' | 'justify';

function alignGlyph(lines: number[][]): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('aria-hidden', 'true');
  lines.forEach(([offset, length], index) => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    line.setAttribute('x', String(offset));
    line.setAttribute('y', String(1.4 + index * 2.4));
    line.setAttribute('width', String(length));
    line.setAttribute('height', '1');
    line.setAttribute('rx', '0.5');
    svg.appendChild(line);
  });
  return svg;
}

/**
 * Horizontal alignment as the four familiar buttons. `null` means the selection
 * disagrees, so no button is shown as active until one is pressed.
 */
function alignButtonsField(
  label: string,
  value: TextAlign | null,
  onChange: (v: TextAlign) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const group = document.createElement('div');
  group.className = 'align-buttons';
  group.setAttribute('role', 'group');
  for (const choice of TEXT_ALIGN_CHOICES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'align-button';
    button.title = choice.title;
    button.setAttribute('aria-label', choice.title);
    button.setAttribute('aria-pressed', String(value === choice.value));
    if (value === choice.value) button.classList.add('is-active');
    button.appendChild(alignGlyph(choice.lines));
    button.addEventListener('click', () => onChange(choice.value));
    group.appendChild(button);
  }
  wrap.append(span, group);
  return wrap;
}

function mixedSelectField(
  label: string,
  options: string[],
  value: string | null,
  onChange: (v: string) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const select = document.createElement('select');
  if (value === null) {
    const mixed = document.createElement('option');
    mixed.value = '__mixed__';
    mixed.textContent = 'Mixed';
    mixed.disabled = true;
    select.appendChild(mixed);
  }
  for (const optionValue of options) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = optionValue;
    select.appendChild(option);
  }
  select.value = value ?? '__mixed__';
  select.addEventListener('change', () => {
    if (select.value !== '__mixed__') onChange(select.value);
  });
  wrap.append(span, select);
  return wrap;
}

/**
 * One range control over a clip's duration, with separate in and out thumbs.
 *
 * The two native inputs are overlaid on one visual track. This keeps both
 * thumbs keyboard-accessible while presenting one range slider, and the
 * inputs only receive pointer events on their thumbs so neither masks the
 * other. The values stay at least one frame-ish step apart.
 */
function trimRangeSlider(
  start: number,
  end: number,
  max: number,
  onInput: (edge: 'start' | 'end', value: number, start: number, end: number) => void,
  onCommit: (start: number, end: number) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field trim-range-field';
  const span = document.createElement('span');
  span.textContent = 'Range';

  const slider = document.createElement('div');
  slider.className = 'trim-range-slider';
  const track = document.createElement('div');
  track.className = 'trim-range-track';
  const fill = document.createElement('div');
  fill.className = 'trim-range-fill';
  track.appendChild(fill);

  const makeInput = (edge: 'start' | 'end', value: number) => {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = `trim-range-input trim-range-${edge}`;
    input.min = '0';
    input.max = String(max);
    input.step = '0.01';
    input.value = String(value);
    input.setAttribute('aria-label', edge === 'start' ? 'Trim start' : 'Trim end');
    return input;
  };
  const startInput = makeInput('start', start);
  const endInput = makeInput('end', end);
  const minimumGap = Math.min(0.05, max);

  const paint = () => {
    slider.style.setProperty('--trim-start', `${max > 0 ? (start / max) * 100 : 0}%`);
    slider.style.setProperty('--trim-end', `${max > 0 ? (end / max) * 100 : 100}%`);
  };
  const update = (edge: 'start' | 'end') => {
    if (edge === 'start') {
      start = Math.max(0, Math.min(Number(startInput.value), end - minimumGap));
      startInput.value = String(start);
      onInput(edge, start, start, end);
    } else {
      end = Math.min(max, Math.max(Number(endInput.value), start + minimumGap));
      endInput.value = String(end);
      onInput(edge, end, start, end);
    }
    paint();
  };

  // `input` fires continuously while dragging and must stay side-effect-free
  // on the store; `change` fires once on release and is when the deck commits.
  startInput.addEventListener('input', () => update('start'));
  endInput.addEventListener('input', () => update('end'));
  startInput.addEventListener('change', () => {
    update('start');
    onCommit(start, end);
  });
  endInput.addEventListener('change', () => {
    update('end');
    onCommit(start, end);
  });

  paint();
  slider.append(track, startInput, endInput);
  wrap.append(span, slider);
  return wrap;
}

function button(label: string, onClick: () => void, variant = ''): HTMLElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (variant) b.className = variant;
  b.addEventListener('click', onClick);
  return b;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function formatNumber(value: number, maxFractionDigits: number): string {
  const scale = 10 ** maxFractionDigits;
  return String(Math.round(value * scale) / scale);
}

function fontSizeValue(value: number): number {
  return Math.round(Math.max(6, Math.min(400, value)) * 10) / 10;
}

function commonValue<T>(values: T[]): T | null {
  if (values.length === 0) return null;
  return values.every((value) => Object.is(value, values[0])) ? values[0] : null;
}

function sharedValue<T>(values: T[]): { mixed: boolean; value: T | null } {
  if (values.length === 0) return { mixed: false, value: null };
  const mixed = !values.every((value) => Object.is(value, values[0]));
  return { mixed, value: mixed ? null : values[0] };
}
