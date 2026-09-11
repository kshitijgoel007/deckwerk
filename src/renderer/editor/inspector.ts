import type { Deck, MediaEffect, Slide, SlideElement } from '@shared/deck.js';
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
import { sameDeckIgnoringNotes, type EditorStore } from './store.js';
import type { SlideLayout } from './slideLayouts.js';
import {
  applyDesign,
  dryRunDesign,
  layoutName,
  layoutOnlyOptions,
  reportChangesAnything,
  summarizeDesignReport,
  themeResetOptions,
  type DesignApplyOptions,
} from '@shared/designApply.js';
import { FIXED_LAYOUTS, masterTile } from './layoutPreview.js';
import { MorphPanel } from './morphPanel.js';
import { fontFamilyField, primaryFamily } from './fontPicker.js';
import { deckTheme, deckThemes, themeById, type ThemeTextRole } from '@shared/themes.js';
import { colorField, colorForInput } from './colorPicker.js';
import { setCircularMask } from '@shared/mediaMask.js';
import { mediaNaturalSize } from './mediaNatural.js';
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
  applyTextRole,
  isBaselineFormat,
  type InlineTextFormat,
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

/** What fits in one stop of the playback toggle strip. */
const VIDEO_FLAG_SHORT = {
  autoplay: 'auto',
  loop: 'loop',
  muted: 'mute',
  controls: 'ctrl',
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
  /**
   * Whether the typography controls address something narrower than the whole
   * box — an expanded character selection or a selected table cell. The box's
   * authored declarations are then only the backdrop those characters inherit
   * from, so the fields must read the selection rather than the box.
   */
  textStyleTargetsSelection?: () => boolean;
  /** Apply weight to only the selected characters in the live text edit. */
  onApplyTextSelectionWeight?: (weight: number) => boolean;
  onToggleTextSelectionFormat?: (format: InlineTextFormat) => boolean;
  textSelectionFormatState?: (format: InlineTextFormat) => boolean;
  /** Apply a family to only the selected characters in the live text edit. */
  onApplyTextSelectionFontFamily?: (value: string) => boolean;
  onApplyTextSelectionFontSize?: (value: number) => boolean;
  /**
   * This inspector edits layout masters. A master carries no type scale (see
   * layoutMasters.ts), so its size field is shown for what a placeholder
   * inherits and cannot be typed into: the deck's sizes live in the theme.
   */
  editsLayoutMasters = false;
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
  private lastDeck: Deck | null = null;
  private lastSelection = '';
  private lastSlide = -1;
  private lastSlideSelection = '';
  /** Keep the opacity slider mounted while its live drag updates the deck. */
  private changingOpacity = false;
  private morphHost = document.createElement('section');
  private morphPanel: MorphPanel;
  /** Enter the dedicated editor for the three fixed layout masters. */
  onEditLayouts?: (layout: SlideLayout) => void;
  /** Show a dry-run slide on the canvas in place of the real one; `null` clears it. */
  onPreviewSlide?: (slide: Slide | null, label: string) => void;
  /** Whether the layout popover is open, so a re-render keeps it open. */
  private layoutPopoverOpen = false;
  private closeLayoutPopover: (() => void) | null = null;

  /** Close the layout popover if it is open. Returns whether anything closed. */
  dismissPopovers(): boolean {
    if (!this.closeLayoutPopover) return false;
    this.closeLayoutPopover();
    return true;
  }

  constructor(host: HTMLElement, store: EditorStore) {
    this.host = host;
    this.host.classList.add('editor-inspector');
    this.store = store;
    this.morphHost.className = 'morph-section';
    this.morphPanel = new MorphPanel(this.morphHost, store, false);
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
      // Speaker notes are not shown here. Each keystroke in the notes drawer
      // commits a fresh deck, and rebuilding for it re-mounted the layout and
      // Morph previews — every slide picture in the panel flickered per key.
      if (
        this.lastDeck !== null
        && sameDeckIgnoringNotes(deck, this.lastDeck)
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

  /**
   * The stylesheet changed under the panel. Font family, size, weight and
   * paragraph spacing readouts for the selected elements are computed styles,
   * so they go stale the moment theme.css does — but only the element sections
   * read them. With nothing selected the panel shows slide layout and the
   * Morph previews, and rebuilding those re-mounts every preview video: the
   * torn-down surfaces keep fetching until the load gate's watchdog notices,
   * so for a moment twice the budgeted videos are on the wire.
   */
  noteThemeChanged(): void {
    if (this.store.selectedElements().length > 0) this.render();
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
    const fonts = deck.themeStyle?.fonts ?? themeById(deck.themePreset, deckThemes(deck))?.fonts;
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
    if (selected.length > 0) this.morphPanel.dismiss();
    if (slideSelection.size > 1 && selected.length === 0) {
      this.host.appendChild(sectionTitle('slides'));
      this.host.appendChild(hint(`${slideSelection.size} slides selected`));
      this.host.appendChild(this.slideLayoutSection(this.store.selectedSlides()));
      this.appendMorph();
      return;
    }

    if (selected.length === 0) {
      this.host.appendChild(sectionTitle('slide'));
      const slide = deck.slides[slideIndex];
      if (slide) this.host.appendChild(this.slideLayoutSection([slide]));
      this.appendMorph();
      return;
    }
    if (selected.length > 1) {
      this.host.appendChild(sectionTitle(`${selected.length} elements`));
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

  private appendMorph(): void {
    this.morphPanel.render();
    this.host.appendChild(this.morphHost);
  }

  /**
   * Slide-level controls apply uniformly to every slide selected in the rail.
   *
   * Two of them are reset axes rather than styling: Layout puts the slides on
   * a master (geometry only) and Theme makes them follow the deck theme (type
   * and colours, ground included). Everything else here — the background — is
   * the author's own styling, initialised from the theme and free to change.
   * Both axes run the same `applyDesign` the Design tab uses for its batch
   * Apply, and both say beforehand what they will do.
   */
  private slideLayoutSection(slides: Slide[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'slide-design-sections';
    wrap.append(
      this.layoutAxisSection(slides),
      this.themeAxisSection(slides),
      this.backgroundSection(slides),
    );
    return wrap;
  }

  /** The current slide when it is in `ids`, else the first slide in `ids`. */
  private previewTarget(ids: Set<string>): Slide | undefined {
    const { deck, slideIndex } = this.store.get();
    const current = deck.slides[slideIndex];
    if (current && ids.has(current.id)) return current;
    return deck.slides.find((slide) => ids.has(slide.id));
  }

  private previewDesign(options: DesignApplyOptions, ids: Set<string>, label: string): void {
    const target = this.previewTarget(ids);
    if (!target || !this.onPreviewSlide) return;
    const deck = this.store.get().deck;
    const { deck: previewDeck, report } = dryRunDesign(deck, deckTheme(deck), options, ids);
    const shown = previewDeck.slides.find((slide) => slide.id === target.id) ?? null;
    this.onPreviewSlide(shown, `${label} · ${summarizeDesignReport(report)}`);
  }

  private commitDesign(options: DesignApplyOptions, ids: Set<string>, label: string): void {
    this.onPreviewSlide?.(null, '');
    let summary = '';
    this.store.commit((deck) => {
      const report = applyDesign(deck, deckTheme(deck), options, ids);
      summary = summarizeDesignReport(report);
    }, { label: `${label} · ${summary || 'design'}` });
  }

  private layoutAxisSection(slides: Slide[]): HTMLElement {
    const section = optionSection('Layout', 'slide-layout-options');
    const ids = new Set(slides.map((slide) => slide.id));
    const layouts = sharedValue(slides.map((slide) => (slide.layout ?? 'freeform') as SlideLayout));
    const deck = this.store.get().deck;
    const theme = deckTheme(deck);

    const field = document.createElement('div');
    field.className = 'field slide-layout-field';
    const label = document.createElement('span');
    label.textContent = 'Layout';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'layout-pick';
    pick.textContent = layouts.mixed ? 'Mixed' : layoutName(layouts.value);
    pick.setAttribute('aria-haspopup', 'true');
    pick.setAttribute('aria-expanded', String(this.layoutPopoverOpen));
    field.append(label, pick);
    section.content.appendChild(field);

    // What Apply would do to put the slides back on their own layout: the
    // author sees drift without opening the picker, and can fix it in place.
    const readout = document.createElement('p');
    readout.className = 'insp-hint design-readout layout-readout';
    if (layouts.mixed) {
      readout.textContent = 'Slides are on different layouts. Pick one to put them all on it.';
    } else if ((layouts.value ?? 'freeform') === 'freeform') {
      readout.textContent = 'Boxes sit where you put them.';
    } else {
      const own = layoutOnlyOptions(layouts.value!);
      const { report } = dryRunDesign(deck, theme, own, ids);
      if (report.moved.length > 0 || report.retagged.length > 0) {
        readout.append(`Off its layout: `);
        const detail = document.createElement('em');
        detail.textContent = summarizeDesignReport(report);
        readout.append(detail, '. ');
        const realign = document.createElement('button');
        realign.type = 'button';
        realign.className = 'design-readout-action';
        realign.textContent = 'Re-align';
        realign.addEventListener('mouseenter', () => this.previewDesign(own, ids, `Re-align to ${layoutName(layouts.value)}`));
        realign.addEventListener('mouseleave', () => this.onPreviewSlide?.(null, ''));
        realign.addEventListener('click', () => this.commitDesign(own, ids, `Re-align to ${layoutName(layouts.value)}`));
        readout.appendChild(realign);
      } else {
        readout.textContent = 'All boxes in their layout positions.';
      }
    }
    section.content.appendChild(readout);

    const popover = document.createElement('div');
    popover.className = 'layout-popover';
    popover.hidden = !this.layoutPopoverOpen;
    const grid = document.createElement('div');
    grid.className = 'layout-popover-grid';
    const hint = document.createElement('div');
    hint.className = 'layout-popover-footer';
    const hintText = document.createElement('span');
    const idleHint = 'Hover to preview on the canvas. Click to put the slide on it.';
    hintText.textContent = idleHint;
    const editLayouts = document.createElement('button');
    editLayouts.type = 'button';
    editLayouts.className = 'bar-button';
    editLayouts.textContent = 'Edit layouts…';
    editLayouts.addEventListener('click', () => {
      close();
      this.onEditLayouts?.(layouts.mixed ? 'freeform' : layouts.value ?? 'freeform');
    });
    hint.append(hintText, editLayouts);
    for (const layout of FIXED_LAYOUTS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `layout-popover-item${!layouts.mixed && layouts.value === layout ? ' selected' : ''}`;
      item.setAttribute('aria-label', `Put slide on ${layoutName(layout)}`);
      const { frame } = masterTile(layout, deck.layoutMasters, theme, { caption: false });
      const caption = document.createElement('em');
      caption.textContent = layoutName(layout);
      item.append(frame, caption);
      const options = layoutOnlyOptions(layout);
      item.addEventListener('mouseenter', () => {
        const { report } = dryRunDesign(deck, theme, options, ids);
        hintText.textContent = `${layoutName(layout)}: ${summarizeDesignReport(report)}.`;
        this.previewDesign(options, ids, layoutName(layout));
      });
      item.addEventListener('mouseleave', () => {
        hintText.textContent = idleHint;
        this.onPreviewSlide?.(null, '');
      });
      item.addEventListener('click', () => {
        close();
        this.commitDesign(options, ids, `Put ${ids.size === 1 ? 'slide' : `${ids.size} slides`} on ${layoutName(layout)}`);
      });
      grid.appendChild(item);
    }
    popover.append(grid, hint);
    section.content.appendChild(popover);

    const onOutside = (event: PointerEvent): void => {
      if (section.section.contains(event.target as Node)) return;
      close();
    };
    const close = (): void => {
      if (!this.layoutPopoverOpen) return;
      this.layoutPopoverOpen = false;
      popover.hidden = true;
      pick.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onOutside, true);
      this.closeLayoutPopover = null;
      this.onPreviewSlide?.(null, '');
    };
    const open = (): void => {
      this.layoutPopoverOpen = true;
      popover.hidden = false;
      pick.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', onOutside, true);
      this.closeLayoutPopover = close;
    };
    if (this.layoutPopoverOpen) open();
    pick.addEventListener('click', () => (this.layoutPopoverOpen ? close() : open()));
    return section.section;
  }

  private themeAxisSection(slides: Slide[]): HTMLElement {
    const ids = new Set(slides.map((slide) => slide.id));
    const deck = this.store.get().deck;
    const theme = deckTheme(deck);
    // The deck theme is the section's caption; changing it lives in Design.
    const section = optionSection('Theme', 'slide-theme-options', theme?.name ?? 'None');

    const options = themeResetOptions();
    const { report } = dryRunDesign(deck, theme, options, ids);
    const follow = document.createElement('button');
    follow.type = 'button';
    follow.className = 'bar-button follow-theme';
    follow.textContent = 'Follow theme';
    follow.disabled = !theme || !reportChangesAnything(report);
    follow.title = follow.disabled
      ? 'Type and colours already follow the deck theme'
      : 'Reset type and colours to the deck theme. Layout and other styling stay.';
    follow.addEventListener('mouseenter', () => {
      if (!follow.disabled) this.previewDesign(options, ids, 'Follow theme');
    });
    follow.addEventListener('mouseleave', () => this.onPreviewSlide?.(null, ''));
    follow.addEventListener('click', () => this.commitDesign(options, ids, 'Follow theme'));
    section.content.appendChild(follow);

    if (!follow.disabled) {
      const line = document.createElement('p');
      line.className = 'insp-hint design-readout follow-readout';
      line.textContent = summarizeDesignReport(report);
      section.content.appendChild(line);
    }
    return section.section;
  }

  private backgroundSection(slides: Slide[]): HTMLElement {
    const section = optionSection('Background', 'slide-background-options');
    const selectedIds = new Set(slides.map((slide) => slide.id));
    const deck = this.store.get().deck;
    const theme = deckTheme(deck);
    const backgrounds = sharedValue(slides.map((slide) => slide.background.color ?? null));
    const themeGround = deck.themeStyle?.colors.background ?? theme?.colors.background ?? null;
    section.content.appendChild(colorField(
      backgrounds.mixed ? 'Colour (mixed)' : 'Colour',
      backgrounds.value,
      (value) => {
        this.store.commit((next) => {
          for (const slide of next.slides) {
            if (!selectedIds.has(slide.id)) continue;
            // A ground is the theme's default or the author's own; a layout
            // master's colour is never consulted.
            slide.background = { color: value, image: null };
            slide.layoutBackgroundInherited = false;
          }
        }, { label: slides.length > 1 ? 'Set slide backgrounds' : 'Set slide background' });
      },
      {
        inheritedValue: themeGround,
        clear: { kind: 'theme', label: 'Use theme background' },
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
      active ? 'primary panel-action' : 'panel-action',
    ));

    const el = this.store
      .selectedElements()
      .find((e) => e.id === elementId);
    if (el && (el.type === 'image' || el.type === 'video') && el.sourceBox && !active) {
      const reset = smallButton(
        '×',
        'Reset mask',
        () => this.store.updateSelected((target) => {
          if (target.type !== 'image' && target.type !== 'video') return;
          target.sourceBox = null;
          // A circle has no corners to fill, so dropping the crop entirely
          // would leave slide showing through it. Re-centre the picture in the
          // circle instead -- that is what "the whole frame" means here.
          if (target.maskShape === 'circle') {
            setCircularMask(target, true, mediaNaturalSize(target.id));
          }
        }, { label: 'Reset mask' }),
      );
      reset.classList.add('mask-reset-segment');
      wrap.classList.add('has-reset');
      wrap.appendChild(reset);
    }
    return wrap;
  }

  /** Rounded corners clip media, so keep them with the other mask controls. */
  private mediaMaskControls(elementId: string): HTMLElement {
    const el = this.store.selectedElements().find((element) => element.id === elementId);
    const masking = optionSection('Mask', 'media-masking-options', 'non-destructive');
    if (!el || (el.type !== 'image' && el.type !== 'video')) return masking.section;

    const settings = document.createElement('div');
    settings.className = 'media-mask-settings';
    settings.appendChild(
      numberField('Corner radius', editableMediaRadius(el), (value) =>
        this.store.updateSelected((target) => {
          if (target.type === 'image' || target.type === 'video') {
            setMediaRadius(target, value);
          }
        }), { unit: 'px' }),
    );
    // Circle squares the window and crops the picture to it, so the mask is a
    // true circle whatever the media's aspect ratio. Mask editing then drags
    // the picture around behind that fixed window.
    settings.appendChild(
      checkboxField('Circular mask', editableCircularMask(el), (on) =>
        this.store.updateSelected((target) => {
          if (target.type === 'image' || target.type === 'video') {
            setMediaMask(target, on);
          }
        }, { label: on ? 'Circular mask' : 'Rectangular mask' })),
    );
    masking.content.appendChild(settings);
    // 'contain' letterboxes inside the box (aspect ratio fixed); 'fill'
    // stretches with it, which is what resizing feels like it should do
    // when this is off. It clips like the mask does, so it lives here.
    masking.content.appendChild(
      checkboxField('Keep aspect ratio', el.fit !== 'fill', (on) =>
        this.store.updateSelected((target) => {
          if (target.type === 'image' || target.type === 'video') {
            target.fit = on ? 'contain' : 'fill';
          }
        }),
      ),
    );
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
    const readout = trim.caption;
    readout.hidden = false;
    const setReadout = (from: number, to: number) => {
      readout.textContent = `${from.toFixed(2)} – ${to.toFixed(2)} s of ${duration.toFixed(2)}`;
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

    wrap.append(preview, range);
    const reset = button('Reset trim', () =>
      this.store.updateSelected((e) => {
        if (e.type !== 'video') return;
        e.start = 0;
        e.end = null;
      }),
      'ghost trim-reset',
    );
    reset.disabled = el.start === 0 && el.end === null;
    wrap.appendChild(reset);
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
    const strip = (entries: Array<[AlignMode, string]>) => {
      const div = document.createElement('div');
      div.className = 'align-strip';
      for (const [mode, title] of entries) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'align-strip-button';
        b.title = title;
        b.setAttribute('aria-label', title);
        b.dataset.mode = mode;
        b.appendChild(alignModeGlyph(mode));
        b.addEventListener('click', () => apply(mode));
        div.appendChild(b);
      }
      return div;
    };
    const pair = document.createElement('div');
    pair.className = 'align-strip-pair';
    pair.appendChild(strip([['left', 'Align left'], ['hcenter', 'Align horizontal centres'], ['right', 'Align right']]));
    pair.appendChild(strip([['top', 'Align top'], ['vcenter', 'Align vertical centres'], ['bottom', 'Align bottom']]));
    wrap.appendChild(pair);
    wrap.appendChild(strip([
      ['distributeH', 'Distribute horizontally'],
      ['distributeV', 'Distribute vertically'],
      ['matchW', 'Match width of the first selected element'],
      ['matchH', 'Match height of the first selected element'],
    ]));
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
        this.store.updateSelected((el) => (el.rot = v)), { unit: '°' },
      ),
    );
    row2.appendChild(
      numberField('Z', multi ? commonValue(selected.map((element) => element.z)) : first.z, (v) =>
        this.store.updateSelected((el) => (el.z = Math.round(v))),
      ),
    );
    wrap.appendChild(row2);

    const bottom = document.createElement('div');
    bottom.className = 'geometry-bottom-row';
    bottom.appendChild(opacityField(
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

    const arrange = document.createElement('div');
    arrange.className = 'field field-arrange';
    const arrangeLabel = document.createElement('span');
    arrangeLabel.textContent = 'Arrange';
    const order = document.createElement('div');
    order.className = 'align-strip z-order-row';
    for (const [dir, title] of [
      ['front', 'Bring to front'],
      ['forward', 'Bring forward'],
      ['backward', 'Send backward'],
      ['back', 'Send to back'],
    ] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'align-strip-button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.appendChild(inlineGlyph(ARRANGE_GLYPHS[dir]));
      b.addEventListener('click', () => this.reorder(dir));
      order.appendChild(b);
    }
    arrange.append(arrangeLabel, order);
    bottom.appendChild(arrange);
    wrap.appendChild(bottom);
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
    const roles = texts.map((text) =>
      text.class.find((name) => /^role-(title|heading|body|caption|base)$/.test(name)) ?? 'none');
    wrap.appendChild(mixedSelectField(
      'Role', ['none', ...ROLE_ORDER.map((role) => `role-${role}`)],
      commonValue(roles),
      (value) => {
        const role = value === 'none' ? null : value.slice(5);
        const defaults = this.roleTypeDefaults(role);
        this.store.updateSelected((element) => {
          if (element.type !== 'text') return;
          applyTextRole(element, role, defaults);
        }, { label: role ? `Set role to ${role}` : 'Clear role' });
      },
    ));

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
    if (this.editsLayoutMasters) lockSizeToTheme(sizeField);
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
    if (kind === 'video') {
      const playback = optionSection('Playback', 'video-playback-options');
      const flags = document.createElement('div');
      flags.className = 'video-checkbox-grid';
      for (const key of ['autoplay', 'loop', 'muted', 'controls'] as const) {
        flags.appendChild(toggleSegment(mixedCheckboxField(
          VIDEO_FLAG_LABELS[key],
          commonValue(media.map((element) => element.type === 'video' && element[key])),
          (value) => this.store.updateSelected((element) => {
            if (element.type === 'video') element[key] = value;
          }),
        ), VIDEO_FLAG_SHORT[key]));
      }
      playback.content.appendChild(flags);
      wrap.appendChild(playback.section);
    }
    const masking = optionSection('Mask', 'media-masking-options', 'non-destructive');
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
        { unit: 'px' },
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
    masking.content.appendChild(mixedCheckboxField(
      'Keep aspect ratio',
      commonValue(media.map((element) => element.fit !== 'fill')),
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'image' || element.type === 'video') {
          element.fit = value ? 'contain' : 'fill';
        }
      }),
    ));
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
        }), { unit: 'px' }),
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
        play.className = 'primary panel-action video-preview-toggle';
        const setLabel = (playing: boolean) => {
          play.textContent = playing ? '❚❚ Pause preview' : '▶ Play preview';
          play.title = playing ? 'Pause the preview on the canvas' : 'Play the clip on the canvas';
        };
        setLabel(false);
        play.addEventListener('click', () => {
          setLabel(this.onTogglePlay?.(el.id) ?? false);
        });
        playback.content.appendChild(play);

        // Four independent on/off states read as one toggle strip, the same
        // idiom as Bold / Italic / Underline.
        const flags = document.createElement('div');
        flags.className = 'video-checkbox-grid';
        for (const key of ['autoplay', 'loop', 'muted', 'controls'] as const) {
          flags.appendChild(toggleSegment(
            checkboxField(VIDEO_FLAG_LABELS[key], el[key], (v) =>
              this.store.updateSelected((e) => {
                if (e.type === 'video') e[key] = v;
              }),
            ),
            VIDEO_FLAG_SHORT[key],
          ));
        }
        playback.content.appendChild(flags);
        wrap.appendChild(playback.section);

        // Trim is about time, like playback, so it sits beside it rather than
        // after the mask and border sections.
        wrap.appendChild(this.trimSection(el));
        wrap.appendChild(this.mediaMaskControls(el.id));
        wrap.appendChild(this.mediaBorderControls());
        wrap.appendChild(this.mediaEffectsControls());

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
          layout.caption.textContent = 'rows fit their contents';
          layout.caption.hidden = false;
          layout.caption.title =
            'Table rows automatically fit their contents. Drag the outer handles or blue column dividers to resize.';
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
        // A character selection (or a selected cell) reads its own typography.
        // The box declaration is what those characters inherit when they
        // declare nothing themselves, so letting it win here would report a
        // size the selection does not have — and every edit would then be
        // computed from, and snap back to, the box's number.
        const scoped = this.textStyleTargetsSelection?.() ?? false;
        const authoredFamily = scoped ? '' : el.style['font-family'] ?? '';
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

        const authoredSize = scoped
          ? null
          : Number.parseFloat(el.style['font-size'] ?? '') || null;
        const displayedSize = authoredSize
          ?? (computedTypography?.fontSizeExplicit ? computedTypography.fontSize : null);
        const authoredWeight = scoped
          ? null
          : Number.parseFloat(el.style['font-weight'] ?? '') || null;
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
        if (this.editsLayoutMasters) lockSizeToTheme(fontSizeField);
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

        // Shown whether or not a live edit is open: with a caret/selection the
        // buttons format the selected characters, and with the box merely
        // selected they fall through to the whole-box toggle below.
        {
          const editing = this.editingText?.() ?? false;
          const selectionStyle = document.createElement('div');
          selectionStyle.className = 'text-selection-style field';
          const styleLabel = document.createElement('span');
          styleLabel.textContent = 'Style';
          selectionStyle.appendChild(styleLabel);
          const formatButtons = document.createElement('div');
          formatButtons.className = 'button-row text-format-buttons';
          for (const [format, label, title] of [
            ['bold', 'B', 'Bold (Cmd/Ctrl+B)'],
            ['italic', 'I', 'Italic (Cmd/Ctrl+I)'],
            ['underline', 'U', 'Underline (Cmd/Ctrl+U)'],
            ['superscript', 'x²', 'Superscript (Cmd/Ctrl+Shift+=)'],
            ['subscript', 'x₂', 'Subscript (Cmd/Ctrl+Shift+-)'],
          ] as const) {
            const choice = button(label, () => {
              if (this.onToggleTextSelectionFormat?.(format)) return;
              // A baseline shift describes a run, never a whole block, so
              // there is no box-level fallback to fall through to.
              if (isBaselineFormat(format)) return;
              const active = wholeTextFormatState(el, format, computedTypography?.fontWeight ?? null);
              this.store.updateSelected((target) => {
                if (target.type === 'text') setWholeTextFormat(target, format, !active);
              }, { label: `${active ? 'Remove' : 'Apply'} ${format}` });
            });
            choice.classList.add(`text-format-${format}`);
            choice.title = title;
            choice.setAttribute('aria-label', title);
            choice.setAttribute(
              'aria-pressed',
              String(
                editing
                  ? this.textSelectionFormatState?.(format) ?? false
                  : !isBaselineFormat(format)
                    && wholeTextFormatState(el, format, computedTypography?.fontWeight ?? null),
              ),
            );
            if (!editing && isBaselineFormat(format)) {
              // Raised/lowered describes a run, so it needs a caret to act on.
              choice.disabled = true;
              choice.title = `${title} — select characters in the text first`;
            }
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
          ...ROLE_ORDER.map((role): [string, string] => [`role-${role}`, ROLE_LABELS[role]]),
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
        roleDrop.addEventListener('change', () => {
          const role = roleDrop.value ? roleDrop.value.slice(5) : null;
          const defaults = this.roleTypeDefaults(role);
          this.store.updateSelected((e) => {
            if (e.type !== 'text') return;
            applyTextRole(e, role, defaults);
          }, { label: role ? `Set role to ${role}` : 'Clear role' });
        });
        roleSelect.append(roleSpan, roleDrop);
        roleSelect.classList.add('text-role');
        typography.content.prepend(roleSelect);

        // One mutually-exclusive list style control. When a live selection is
        // inside a list, the canvas transforms that entire list in place.
        const selectedListStyle = this.textSelectionListStyle?.();
        const listStyle = segmentedSelectField(
          'List',
          [
            { value: 'None', title: 'No list', icon: LIST_GLYPHS.None },
            { value: 'Bulleted', title: 'Bulleted list', icon: LIST_GLYPHS.Bulleted },
            { value: 'Numbered', title: 'Numbered list', icon: LIST_GLYPHS.Numbered },
          ],
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
          for (const choice of listStyle.querySelectorAll('button')) choice.disabled = true;
        }
        const listRow = document.createElement('div');
        listRow.className = 'text-list-row';
        listRow.appendChild(listStyle);
        layout.content.appendChild(listRow);

        // The marker swatch sits beside List so it does not shift the layout
        // when a list is switched on.
        const authoredMarker = listMarkerColorState(el.html);
        if (authoredMarker.hasList) {
          const marker = this.textSelectionMarkerColor?.() ?? authoredMarker;
          listRow.appendChild(colorField(
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
          listRow.lastElementChild?.classList.add('field-color-stacked');
        }

        if (/<table\b/i.test(el.html)) {
          const table = optionSection('Table', 'text-table-options');
          const selected = this.tableSelection?.();
          if (!selected || selected.elementId !== el.id) {
            table.caption.textContent = 'double-click to select cells';
            table.caption.hidden = false;
            table.caption.title =
              'Double-click the table, then drag horizontally, vertically, or diagonally across cells.';
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
            table.caption.textContent = location;
            table.caption.hidden = false;
            table.caption.title = 'Drag to select a rectangular range';
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

        // Colour shares the row with the style buttons: both act on the
        // same run of characters, and the swatch was floating alone in an
        // otherwise empty row.
        const paint = this.textPaintInfo(el);
        const colour = colorField(
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
        );
        colour.classList.add('field-color-stacked');
        const styleRow = typography.content.querySelector('.text-selection-style');
        if (styleRow) {
          const row = document.createElement('div');
          row.className = 'text-style-row';
          styleRow.replaceWith(row);
          row.append(styleRow, colour);
        } else {
          typography.content.appendChild(colour);
        }
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
          segmentedSelectField(
            'Vertical',
            [
              { value: 'top', title: 'Align top', icon: VALIGN_GLYPHS.top },
              { value: 'middle', title: 'Align middle', icon: VALIGN_GLYPHS.middle },
              { value: 'bottom', title: 'Align bottom', icon: VALIGN_GLYPHS.bottom },
            ],
            el.valign,
            (v) =>
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
        const kinds: Array<{ value: string; title: string; icon: string }> = [
          { value: 'rect', title: 'Rectangle', icon: SHAPE_KIND_GLYPHS.rect },
          { value: 'ellipse', title: 'Ellipse', icon: SHAPE_KIND_GLYPHS.ellipse },
          { value: 'line', title: 'Line', icon: SHAPE_KIND_GLYPHS.line },
          { value: 'arrow', title: 'Arrow', icon: SHAPE_KIND_GLYPHS.arrow },
        ];
        // Imported vector art keeps its geometry as a path; it can be shown
        // but not chosen, since there is no path to switch another kind to.
        if (el.shape === 'path') {
          kinds.push({ value: 'path', title: 'Path (imported)', icon: SHAPE_KIND_GLYPHS.path });
        }
        style.content.appendChild(
          segmentedSelectField('Kind', kinds, el.shape, (v) =>
            this.store.updateSelected((e) => {
              if (e.type === 'shape') e.shape = v as 'rect';
            }),
          ),
        );
        const stroked = el.shape === 'line' || el.shape === 'arrow';
        const paint = document.createElement('div');
        paint.className = 'compact-field-row';
        // A line has no interior, so Fill and Radius would do nothing; the
        // slot goes to the stroke width instead.
        if (!stroked) {
          const fill = colorField('Fill', el.fill, (v) =>
            this.store.updateSelected((e) => {
              if (e.type === 'shape') e.fill = v;
            }),
            { clear: { kind: 'none', label: 'No fill (transparent)' } },
          );
          fill.classList.add('field-color-stacked');
          paint.appendChild(fill);
        }
        const stroke = colorField('Stroke', el.stroke, (v) =>
          this.store.updateSelected((e) => {
            if (e.type === 'shape') e.stroke = v;
          }),
          { clear: { kind: 'none', label: 'No stroke' } },
        );
        stroke.classList.add('field-color-stacked');
        paint.appendChild(stroke);
        const width = numberField('WIDTH', el.strokeWidth, (v) =>
          this.store.updateSelected((e) => {
            if (e.type === 'shape') e.strokeWidth = Math.max(0, v);
          }), { unit: 'px' },
        );
        if (stroked) paint.appendChild(width);
        style.content.appendChild(paint);
        if (!stroked) {
          const nums = document.createElement('div');
          nums.className = 'compact-field-row';
          nums.appendChild(width);
          nums.appendChild(
            numberField('RADIUS', el.radius, (v) =>
              this.store.updateSelected((e) => {
                if (e.type === 'shape') e.radius = Math.max(0, v);
              }), { unit: 'px' },
            ),
          );
          style.content.appendChild(nums);
        } else {
          const flags = document.createElement('div');
          flags.className = 'compact-field-row shape-line-flags';
          flags.appendChild(
            checkboxField('Curved', Boolean(el.control), (on) =>
              this.store.updateSelected((e) => {
                if (e.type !== 'shape') return;
                e.control = on
                  ? { x: e.x + e.w / 2, y: e.y + e.h / 2 - Math.max(80, e.w / 3) }
                  : null;
              }),
            ),
          );
          flags.appendChild(
            checkboxField('Head at end', el.arrowEnd, (on) =>
              this.store.updateSelected((e) => {
                if (e.type === 'shape') e.arrowEnd = on;
              }, { label: on ? 'Add arrowhead at end' : 'Remove arrowhead at end' }),
            ),
          );
          flags.appendChild(
            checkboxField('Head at start', el.arrowStart, (on) =>
              this.store.updateSelected((e) => {
                if (e.type === 'shape') e.arrowStart = on;
              }, { label: on ? 'Add arrowhead at start' : 'Remove arrowhead at start' }),
            ),
          );
          style.content.appendChild(flags);
        }
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

  /**
   * The current theme's type for a role, or `null` when the deck wears no
   * theme at all.
   *
   * `deckTheme` is how every other surface — the theme card, the layout master
   * preview, a newly created slide — answers "which theme is this deck
   * wearing", including the deck's own edits to it. Resolving the role's type
   * anywhere else is how the control came to dress a box in whichever theme
   * happened to be installed in theme.css when the deck was made.
   */
  private roleTypeDefaults(role: string | null): {
    family: string;
    size: number;
    weight: number;
    lineHeight: number;
    letterSpacing: string;
  } | null {
    if (!role) return null;
    const theme = deckTheme(this.store.get().deck);
    return theme?.fonts[role as keyof typeof theme.fonts] ?? null;
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
        }), { unit: 'px' }),
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

/**
 * A multi-selection group. Same markup as `optionSection`, so a two-element
 * panel reads with the hierarchy of a one-element panel rather than as cards
 * nested under headings.
 */
function group(title: string): HTMLElement {
  const { section } = optionSection(title, 'insp-group-content');
  section.classList.add('insp-group');
  return section;
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
  setCircularMask(element, circular, mediaNaturalSize(element.id));
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

export function numberField(
  label: string,
  value: number | null,
  onChange: (v: number) => void,
  opts: { step?: number; unit?: string } = {},
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
  wrap.appendChild(span);
  if (opts.unit) {
    // The unit reads as the input's suffix ("12 px") rather than a caption.
    const box = document.createElement('span');
    box.className = 'field-unit-wrap';
    const unit = document.createElement('span');
    unit.className = 'field-unit';
    unit.textContent = opts.unit;
    unit.setAttribute('aria-hidden', 'true');
    input.title = `Value in ${opts.unit}`;
    box.append(input, unit);
    wrap.appendChild(box);
  } else {
    wrap.appendChild(input);
  }
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

/**
 * A named cluster of related inspector controls. The heading is one or two
 * words; anything that needs explaining goes in `caption`, a short muted note
 * on the heading line, so a sentence never sits in a label slot.
 */
function optionSection(
  title: string,
  contentClass: string,
  caption?: string,
): { section: HTMLElement; content: HTMLElement; caption: HTMLElement } {
  const section = document.createElement('section');
  section.className = 'insp-option-section';
  const row = document.createElement('div');
  row.className = 'insp-subtitle-row';
  const heading = document.createElement('h4');
  heading.className = 'insp-subtitle';
  heading.textContent = title;
  const note = document.createElement('span');
  note.className = 'insp-subtitle-caption';
  if (caption) note.textContent = caption;
  else note.hidden = true;
  row.append(heading, note);
  const content = document.createElement('div');
  content.className = contentClass;
  section.append(row, content);
  return { section, content, caption: note };
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
 * Icons for the multi-selection align panel: a guide line the boxes snap to
 * plus two boxes of different size, all in currentcolor so they follow hover.
 */
const ALIGN_MODE_GLYPHS: Record<AlignMode, string> = {
  left: '<path d="M1.5 1v12"/><rect class="fill" x="3" y="3" width="9" height="3" rx=".5"/><rect class="fill" x="3" y="8" width="5.5" height="3" rx=".5"/>',
  hcenter: '<path d="M7 1v12"/><rect class="fill" x="2.5" y="3" width="9" height="3" rx=".5"/><rect class="fill" x="4.25" y="8" width="5.5" height="3" rx=".5"/>',
  right: '<path d="M12.5 1v12"/><rect class="fill" x="2" y="3" width="9" height="3" rx=".5"/><rect class="fill" x="5.5" y="8" width="5.5" height="3" rx=".5"/>',
  top: '<path d="M1 1.5h12"/><rect class="fill" x="3" y="3" width="3" height="9" rx=".5"/><rect class="fill" x="8" y="3" width="3" height="5.5" rx=".5"/>',
  vcenter: '<path d="M1 7h12"/><rect class="fill" x="3" y="2.5" width="3" height="9" rx=".5"/><rect class="fill" x="8" y="4.25" width="3" height="5.5" rx=".5"/>',
  bottom: '<path d="M1 12.5h12"/><rect class="fill" x="3" y="2" width="3" height="9" rx=".5"/><rect class="fill" x="8" y="5.5" width="3" height="5.5" rx=".5"/>',
  distributeH: '<path d="M1.5 1v12M12.5 1v12"/><rect class="fill" x="4" y="3.5" width="2.5" height="7" rx=".5"/><rect class="fill" x="7.5" y="3.5" width="2.5" height="7" rx=".5"/>',
  distributeV: '<path d="M1 1.5h12M1 12.5h12"/><rect class="fill" x="3.5" y="4" width="7" height="2.5" rx=".5"/><rect class="fill" x="3.5" y="7.5" width="7" height="2.5" rx=".5"/>',
  matchW: '<rect x="1.5" y="2" width="11" height="4" rx=".5"/><path d="M1.5 10.5h11M3.5 8.5l-2 2 2 2M10.5 8.5l2 2-2 2"/>',
  matchH: '<rect x="2" y="1.5" width="4" height="11" rx=".5"/><path d="M10.5 1.5v11M8.5 3.5l2-2 2 2M8.5 10.5l2 2 2-2"/>',
};

function alignModeGlyph(mode: AlignMode): SVGElement {
  return inlineGlyph(ALIGN_MODE_GLYPHS[mode]);
}

/** A 14×14 stroke-and-fill icon in currentcolor; see `.align-strip-button svg`. */
function inlineGlyph(markup: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = markup;
  return svg;
}

/** Stacking order: the filled square is the selection, the outline the rest. */
const ARRANGE_GLYPHS = {
  front: '<rect x="1.5" y="5.5" width="7" height="7" rx=".5"/><rect class="fill" x="5.5" y="1.5" width="7" height="7" rx=".5"/>',
  forward: '<rect x="1.5" y="5.5" width="7" height="7" rx=".5"/><rect class="fill" x="5.5" y="1.5" width="7" height="7" rx=".5"/><path d="M3.5 4.5V1.5M2 3l1.5-1.5L5 3"/>',
  backward: '<rect class="fill" x="1.5" y="5.5" width="7" height="7" rx=".5"/><rect x="5.5" y="1.5" width="7" height="7" rx=".5"/><path d="M10.5 9.5v3M9 11l1.5 1.5L12 11"/>',
  back: '<rect class="fill" x="1.5" y="5.5" width="7" height="7" rx=".5"/><rect x="5.5" y="1.5" width="7" height="7" rx=".5"/>',
} as const;

const VALIGN_GLYPHS = {
  top: '<path d="M1.5 1.5h11"/><rect class="fill" x="4" y="3.5" width="6" height="2" rx=".5"/><rect class="fill" x="4" y="7" width="6" height="2" rx=".5"/>',
  middle: '<path d="M1.5 7h11" stroke-dasharray="1.5 1.5"/><rect class="fill" x="4" y="3" width="6" height="2" rx=".5"/><rect class="fill" x="4" y="9" width="6" height="2" rx=".5"/>',
  bottom: '<path d="M1.5 12.5h11"/><rect class="fill" x="4" y="5" width="6" height="2" rx=".5"/><rect class="fill" x="4" y="8.5" width="6" height="2" rx=".5"/>',
} as const;

const LIST_GLYPHS = {
  None: '<path d="M2 3.5h10M2 7h10M2 10.5h10"/>',
  Bulleted: '<circle class="fill" cx="3" cy="3.5" r="1.2"/><circle class="fill" cx="3" cy="7" r="1.2"/><circle class="fill" cx="3" cy="10.5" r="1.2"/><path d="M6 3.5h6M6 7h6M6 10.5h6"/>',
  Numbered: '<path class="fill" d="M2.2 2.2h1.2v2.8h-.9V3h-.6zM2 6.3c0-.6.5-1 1.2-1s1.2.4 1.2 1c0 .4-.3.7-.8 1.1l-.5.4h1.3v.7H2v-.6l1.3-1.1c.3-.2.4-.4.4-.5 0-.2-.1-.3-.4-.3-.2 0-.4.1-.4.4zm.1 4.1h.8c0 .2.2.3.4.3s.4-.1.4-.3-.2-.3-.5-.3H3v-.6h.2c.3 0 .4-.1.4-.3s-.1-.3-.3-.3-.4.1-.4.3h-.8c0-.6.5-.9 1.2-.9s1.1.3 1.1.8c0 .3-.2.5-.5.6.3.1.6.3.6.7 0 .5-.5.9-1.2.9s-1.2-.4-1.2-.9z"/><path d="M6 3.5h6M6 7h6M6 10.5h6"/>',
} as const;

const SHAPE_KIND_GLYPHS = {
  rect: '<rect x="2" y="3" width="10" height="8" rx=".5"/>',
  ellipse: '<ellipse cx="7" cy="7" rx="5" ry="4"/>',
  line: '<path d="M2 12L12 2"/>',
  arrow: '<path d="M2 12L12 2M7 2h5v5"/>',
  path: '<path d="M2 11C4 3 6 3 8 8s3 4 4-6"/>',
} as const;

/**
 * A short menu drawn as a segmented strip. A real `<select>` carries the
 * value for keyboard users, assistive technology and the test harnesses,
 * and is visually hidden; the buttons are its face. Each button sets the
 * select and dispatches `change`, so there is one code path for both.
 */
function segmentedSelectField(
  label: string,
  choices: Array<{ value: string; title: string; icon?: string; text?: string }>,
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field field-segmented';
  const span = document.createElement('span');
  span.textContent = label;
  const select = document.createElement('select');
  select.className = 'segmented-select';
  select.setAttribute('aria-label', label);
  for (const choice of choices) {
    const opt = document.createElement('option');
    opt.value = choice.value;
    opt.textContent = choice.title;
    select.appendChild(opt);
  }
  select.value = value;
  const strip = document.createElement('div');
  strip.className = 'segmented-buttons';
  const buttons: HTMLButtonElement[] = [];
  const reflect = () => {
    for (const b of buttons) {
      const on = b.dataset.value === select.value;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  for (const choice of choices) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'segment-button';
    b.dataset.value = choice.value;
    b.title = choice.title;
    b.setAttribute('aria-label', choice.title);
    if (choice.icon) b.appendChild(inlineGlyph(choice.icon));
    if (choice.text) b.append(choice.text);
    // Keep the pointer-down on the canvas: a focus change would end a live
    // text edit before the click lands.
    b.addEventListener('pointerdown', (event) => event.preventDefault());
    b.addEventListener('click', () => {
      if (select.disabled || select.value === choice.value) return;
      select.value = choice.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    buttons.push(b);
    strip.appendChild(b);
  }
  select.addEventListener('change', () => {
    reflect();
    onChange(select.value);
  });
  reflect();
  wrap.append(span, select, strip);
  return wrap;
}

/**
 * Dress a checkbox field as one stop of a toggle strip: the box is hidden,
 * the label text stays for assistive technology and a short word is shown.
 */
function toggleSegment(field: HTMLElement, short: string): HTMLElement {
  field.classList.add('toggle-segment');
  const shortSpan = document.createElement('span');
  shortSpan.className = 'toggle-segment-short';
  shortSpan.textContent = short;
  shortSpan.setAttribute('aria-hidden', 'true');
  field.appendChild(shortSpan);
  field.title = field.querySelector('span')?.textContent ?? short;
  return field;
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

/** In the layout editor the size field only reports what the theme gives. */
function lockSizeToTheme(sizeField: HTMLElement): void {
  const reason = 'Sizes are the deck\u2019s, not the layout\u2019s: change them under Theme \u203a Edit theme.';
  for (const control of sizeField.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) {
    control.disabled = true;
    control.title = reason;
  }
  sizeField.classList.add('theme-owned');
  sizeField.title = reason;
}

type ThemeTypeRole = ThemeTextRole;
const ROLE_ORDER: ThemeTypeRole[] = ['title', 'heading', 'body', 'caption', 'base'];
const ROLE_LABELS: Record<ThemeTypeRole, string> = {
  title: 'Title', heading: 'Heading', body: 'Body', caption: 'Caption', base: 'Base',
};

function button(label: string, onClick: () => void, variant = ''): HTMLButtonElement {
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
