import type { MediaEffect, SlideElement } from '@shared/deck.js';
import { paragraphsToList, listToParagraphs } from '@shared/paragraphs.js';
import { type AlignMode, alignElements } from './align.js';
import type { EditorStore } from './store.js';
import { LAYOUT_LABELS, applySlideLayout, type SlideLayout } from './slideLayouts.js';
import { MagicMovePanel } from './magicMovePanel.js';
import { fontFamilyField } from './fontPicker.js';

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
 * Typography and colour deliberately are *not* here: those belong in theme.css,
 * reached through the `class` field.
 */
export class Inspector {
  private host: HTMLElement;
  private store: EditorStore;
  /** Clip lengths, probed on demand so the trim sliders can be scaled. */
  private durations = new Map<string, number>();

  onTrimRequest?: (el: Extract<SlideElement, { type: 'video' }>) => void;
  /** Play/pause the video on the editing canvas; returns the new playing state. */
  onTogglePlay?: (elementId: string) => boolean;
  /** Start editing a text element in place on the canvas. */
  onEditText?: (elementId: string) => void;
  /** Whether the canvas currently owns a live text selection. */
  editingText?: () => boolean;
  /** Apply weight to only the selected characters in the live text edit. */
  onApplyTextSelectionWeight?: (weight: number) => boolean;
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
  private magicMoveHost = document.createElement('section');
  private magicMovePanel: MagicMovePanel;

  constructor(host: HTMLElement, store: EditorStore) {
    this.host = host;
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
    const { deck, selection, slideIndex, slideSelection } = this.store.get();
    this.lastDeck = deck;
    this.lastSelection = [...selection].sort().join(',');
    this.lastSlide = slideIndex;
    this.lastSlideSelection = [...slideSelection].sort().join(',');
    const selected = this.store.selectedElements();
    this.host.replaceChildren();
    if (selected.length > 0) this.magicMovePanel.dismiss();
    if (slideSelection.size > 1 && selected.length === 0) {
      this.host.appendChild(hint(`${slideSelection.size} slides selected`));
      this.appendMagicMove();
      return;
    }

    if (selected.length === 0) {
      this.host.appendChild(hint('Nothing selected'));
      const slideGroup = group('Slide');
      const slide = deck.slides[slideIndex];
      const layout = document.createElement('label');
      layout.className = 'field';
      const layoutLabel = document.createElement('span');
      layoutLabel.textContent = 'Layout';
      const layoutSelect = document.createElement('select');
      for (const [value, label] of LAYOUT_LABELS) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        layoutSelect.appendChild(option);
      }
      layoutSelect.value = slide?.layout ?? 'freeform';
      layoutSelect.addEventListener('change', () => {
        this.store.commit((next) => {
          applySlideLayout(next.slides[slideIndex], layoutSelect.value as SlideLayout);
        }, { label: `Apply ${layoutSelect.selectedOptions[0]?.textContent ?? 'slide'} layout` });
      });
      layout.append(layoutLabel, layoutSelect);
      slideGroup.appendChild(layout);
      slideGroup.appendChild(
        colorField('Background (clear = theme)', slide?.background.color ?? null, (value) => {
          this.store.commit((next) => {
            next.slides[slideIndex].background = { color: value, image: null };
          });
        }),
      );
      this.host.appendChild(slideGroup);
      this.appendMagicMove();
      return;
    }
    if (selected.length > 1) {
      this.host.appendChild(hint(`${selected.length} elements selected`));
      this.host.appendChild(this.alignSection());
      this.host.appendChild(this.geometrySection(selected));
      const first = selected[0];
      const sameType = selected.every((element) => element.type === first.type);
      if (sameType) this.host.appendChild(this.styleSection(first, selected));
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
    this.host.appendChild(sectionTitle(el.type));
    this.host.appendChild(this.geometrySection(selected));
    this.host.appendChild(this.styleSection(el));
    const specific = this.typeSection(el);
    if (specific) this.host.appendChild(specific);
  }

  private appendMagicMove(): void {
    this.magicMovePanel.render();
    this.host.appendChild(this.magicMoveHost);
  }

  /**
   * The crop control. Cropping is done in CSS, so it is instant and
   * reversible — the media is never re-encoded and the original is untouched.
   */
  private maskButton(elementId: string): HTMLElement {
    const wrap = document.createElement('div');
    const active = this.maskingElement?.() === elementId;

    wrap.appendChild(
      button(
        active ? 'Done editing mask' : 'Edit mask',
        () => this.onToggleMask?.(elementId),
        'primary panel-action',
      ),
    );
    wrap.appendChild(
      hint(
        active
          ? 'Drag the handles to change the visible area. The picture stays where it is.'
          : 'Crop with the handles on the slide. Non-destructive — the file is not re-encoded.',
      ),
    );

    const el = this.store
      .selectedElements()
      .find((e) => e.id === elementId);
    if (el && (el.type === 'image' || el.type === 'video')) {
      // The mask's shape. Circle clips the element box to its inscribed
      // ellipse; "Edit mask" then moves/scales the picture behind it and the
      // box handles resize the mask itself — Keynote's circular-mask workflow.
      wrap.appendChild(checkboxField('Circular mask', el.maskShape === 'circle', (on) =>
        this.store.updateSelected((target) => {
          if (target.type === 'image' || target.type === 'video') {
            target.maskShape = on ? 'circle' : undefined;
          }
        }, { label: on ? 'Circular mask' : 'Rectangular mask' }),
      ));
    }
    if (el && (el.type === 'image' || el.type === 'video') && el.sourceBox) {
      wrap.appendChild(
        button('Reset crop', () =>
          this.store.updateSelected((e) => {
            if (e.type === 'image' || e.type === 'video') e.sourceBox = null;
          }),
          'primary panel-action',
        ),
      );
    }
    return wrap;
  }

  /**
   * Trim, in the sidebar rather than under the video.
   *
   * Trimming is non-destructive: `start` and `end` are honoured by the player,
   * which also loops between them — the native `loop` attribute cannot, since
   * it always restarts at zero.
   */
  private trimSection(el: Extract<SlideElement, { type: 'video' }>): HTMLElement {
    const wrap = group('Trim');
    const duration = this.durations.get(el.id) ?? null;

    if (duration === null) {
      // Probed once per element and cached; the value is needed to scale the
      // sliders and is not stored in the deck. ffprobe occasionally fails on
      // containers Chromium itself can read (.m4v among them), so the video
      // element's own metadata is the fallback — without one, this panel says
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
      return wrap;
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

    // While the handle moves: readout + live frame preview only. The store is
    // NOT touched — a commit re-renders this panel, which would destroy the
    // slider mid-drag and make it impossible to move at all. The value commits
    // once, on release.
    const startSlider = rangeSlider(
      'Start',
      el.start,
      duration,
      (v) => {
        setReadout(v, end);
        this.trimPreviewSeek?.(v);
        this.onSeekPreview?.(el.id, v);
      },
      (v) => commit(v, end),
    );
    const endSlider = rangeSlider(
      'End',
      end,
      duration,
      (v) => {
        setReadout(el.start, v);
        this.trimPreviewSeek?.(v);
        this.onSeekPreview?.(el.id, v);
      },
      (v) => commit(el.start, v),
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

    wrap.append(preview, startSlider, endSlider, readout);
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
    return wrap;
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
    const wrap = group('Geometry');
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
    row2.className = 'field-grid';
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
    row2.appendChild(
      numberField(
        'OPACITY',
        multi ? commonValue(selected.map((element) => element.opacity)) : first.opacity,
        (v) => this.store.updateSelected((el) =>
          (el.opacity = Math.min(1, Math.max(0, v)))),
        { step: 0.05 },
      ),
    );
    wrap.appendChild(row2);

    const order = document.createElement('div');
    order.className = 'button-row';
    order.append(
      button('Front', () => this.reorder('front')),
      button('Forward', () => this.reorder('forward')),
      button('Back', () => this.reorder('backward')),
      button('To back', () => this.reorder('back')),
    );
    wrap.appendChild(order);
    return wrap;
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

  /** The hook into theme.css, plus the inline-style escape hatch. */
  private styleSection(el: SlideElement, selected: SlideElement[] = [el]): HTMLElement {
    const wrap = group('Style');
    const classValues = selected.map((element) => element.class.join(' '));
    const commonClasses = commonValue(classValues);
    wrap.appendChild(
      textField('CSS classes', commonClasses ?? '', (v) => {
        const classes = v.split(/\s+/).filter(Boolean);
        this.store.updateSelected((e) => (e.class = classes));
      }, commonClasses === null ? 'Mixed — enter to replace all' : 'Space-separated, defined in theme.css'),
    );
    const inlineValues = selected.map((element) => Object.entries(element.style)
      .map(([k, v]) => `${k}: ${v}`)
      .join('; '));
    const commonInline = commonValue(inlineValues);
    wrap.appendChild(
      textField(
        'Inline style',
        commonInline ?? '',
        (v) => {
          const style: Record<string, string> = {};
          for (const decl of v.split(';')) {
            const idx = decl.indexOf(':');
            if (idx <= 0) continue;
            style[decl.slice(0, idx).trim()] = decl.slice(idx + 1).trim();
          }
          this.store.updateSelected((e) => (e.style = style));
        },
        commonInline === null
          ? 'Mixed — enter to replace all'
          : 'e.g. color: #e33; letter-spacing: -0.02em',
      ),
    );
    return wrap;
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
      wrap.appendChild(colorField('Fill', commonValue(shapes.map((shape) => shape.fill)) ?? shapes[0].fill, (value) =>
        this.store.updateSelected((element) => {
          if (element.type === 'shape') element.fill = value;
        }),
      ));
    }

    wrap.appendChild(colorField(
      'Stroke',
      commonValue(shapes.map((shape) => shape.stroke)) ?? shapes[0].stroke,
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'shape') element.stroke = value;
      }),
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
        if (element.type === 'text') element.autoFit = on;
      }),
    ));
    wrap.appendChild(mixedCheckboxField(
      'Disable automatic line breaks',
      commonValue(texts.map((text) => Boolean(text.noWrap))),
      (on) => this.store.updateSelected((element) => {
        if (element.type === 'text') element.noWrap = on;
      }),
    ));
    if (texts.some((text) => text.noWrap)) {
      wrap.appendChild(mixedSelectField(
        'Compress by', ['shrink', 'condense'],
        commonValue(texts.map((text) => text.noWrapMode ?? 'shrink')),
        (v) => this.store.updateSelected((element) => {
          if (element.type === 'text') element.noWrapMode = v as 'shrink' | 'condense';
        }),
      ));
    }

    const families = commonValue(texts.map((text) => text.style['font-family'] ?? ''));
    wrap.appendChild(fontFamilyField(
      'Font family', families ?? '',
      (value) => this.store.updateSelected((element) => {
        if (element.type !== 'text') return;
        const style = { ...element.style };
        if (value) style['font-family'] = value;
        else delete style['font-family'];
        element.style = style;
      }, { label: 'Change font family' }),
      { mixed: families === null },
    ));

    const sizes = sharedValue(texts.map((text) => {
      const size = Number.parseFloat(text.style['font-size'] ?? '');
      return Number.isFinite(size) ? size : null;
    }));
    const sizeField = optionalNumberField(
      'Font size', sizes.mixed ? null : sizes.value,
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'text') element.style = {
          ...element.style, 'font-size': `${Math.max(6, Math.min(400, value))}px`,
        };
      }),
      () => this.store.updateSelected((element) => {
        if (element.type !== 'text') return;
        const style = { ...element.style };
        delete style['font-size'];
        element.style = style;
      }),
      'px',
    );
    if (sizes.mixed) sizeField.querySelector('input')!.placeholder = 'Mixed';
    wrap.appendChild(sizeField);

    wrap.appendChild(mixedSelectField(
      'Font weight',
      ['inherit', '100', '200', '300', '400', '500', '600', '700', '800', '900'],
      commonValue(texts.map((text) => text.style['font-weight'] ?? 'inherit')),
      (value) => this.store.updateSelected((element) => {
        if (element.type !== 'text') return;
        const style = { ...element.style };
        if (value === 'inherit') delete style['font-weight'];
        else style['font-weight'] = value;
        element.style = style;
      }),
    ));

    const roles = texts.map((text) =>
      text.class.find((name) => /^role-(title|heading|body|caption)$/.test(name)) ?? 'none');
    wrap.appendChild(mixedSelectField(
      'Role', ['none', 'role-title', 'role-heading', 'role-body', 'role-caption'],
      commonValue(roles),
      (value) => this.store.updateSelected((element) => {
        if (element.type !== 'text') return;
        element.class = element.class.filter((name) => !name.startsWith('role-'));
        if (value !== 'none') element.class.push(value);
      }),
    ));

    wrap.appendChild(mixedCheckboxField(
      'Bulleted list',
      commonValue(texts.map((text) => text.html.trimStart().startsWith('<ul'))),
      (on) => this.store.updateSelected((element) => {
        if (element.type !== 'text') return;
        if (on && !element.html.trimStart().startsWith('<ul')) {
          element.html = paragraphsToList(element.html);
        } else if (!on && element.html.trimStart().startsWith('<ul')) {
          element.html = listToParagraphs(element.html);
        }
      }),
    ));

    const colors = commonValue(texts.map((text) => text.style.color ?? ''));
    wrap.appendChild(colorField(
      colors === null ? 'Colour (mixed)' : 'Colour',
      colors === null ? (texts[0].style.color ?? null) : (colors || null),
      (value) => this.store.updateSelected((element) => {
        if (element.type !== 'text') return;
        const style = { ...element.style };
        if (value) style.color = value;
        else delete style.color;
        element.style = style;
      }),
      this.effectiveTextColor(texts[0]),
    ));
    wrap.appendChild(mixedSelectField(
      'Align', ['left', 'center', 'right', 'justify'],
      commonValue(texts.map((text) => text.align)),
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'text') element.align = value as 'left';
      }),
    ));
    wrap.appendChild(mixedSelectField(
      'Vertical', ['top', 'middle', 'bottom'],
      commonValue(texts.map((text) => text.valign)),
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'text') element.valign = value as 'top';
      }),
    ));
    const spacings = sharedValue(texts.map((text) => text.paragraphSpacing ?? null));
    const spacingField = optionalNumberField(
      'Paragraph spacing', spacings.mixed ? null : spacings.value,
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'text') element.paragraphSpacing = Math.max(0, value);
      }),
      () => this.store.updateSelected((element) => {
        if (element.type === 'text') delete element.paragraphSpacing;
      }),
      'px',
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
      for (const key of ['autoplay', 'loop', 'muted', 'controls'] as const) {
        wrap.appendChild(mixedCheckboxField(
          VIDEO_FLAG_LABELS[key],
          commonValue(media.map((element) => element.type === 'video' && element[key])),
          (value) => this.store.updateSelected((element) => {
            if (element.type === 'video') element[key] = value;
          }),
        ));
      }
    }
    wrap.appendChild(mixedCheckboxField(
      'Keep aspect ratio',
      commonValue(media.map((element) => element.fit !== 'fill')),
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'image' || element.type === 'video') {
          element.fit = value ? 'contain' : 'fill';
        }
      }),
    ));
    const borderColors = commonValue(media.map((element) => element.borderColor ?? ''));
    wrap.appendChild(colorField(
      borderColors === null ? 'Border colour (mixed)' : 'Border colour',
      borderColors === null ? (media[0].borderColor ?? null) : (borderColors || null),
      (value) => this.store.updateSelected((element) => {
        if (element.type === 'image' || element.type === 'video') element.borderColor = value;
      }),
    ));
    const numbers = document.createElement('div');
    numbers.className = 'field-grid';
    numbers.append(
      numberField('WIDTH', commonValue(media.map((element) => element.borderWidth ?? 0)), (value) =>
        this.store.updateSelected((element) => {
          if (element.type === 'image' || element.type === 'video') element.borderWidth = Math.max(0, value);
        })),
      numberField('RADIUS', commonValue(media.map((element) => element.borderRadius ?? 0)), (value) =>
        this.store.updateSelected((element) => {
          if (element.type === 'image' || element.type === 'video') element.borderRadius = Math.max(0, value);
        })),
    );
    wrap.appendChild(numbers);
    if (commonValue(media.map((element) => JSON.stringify(element.effects ?? []))) !== null) {
      wrap.appendChild(this.mediaEffectsControls());
    } else {
      wrap.appendChild(hint('Effects differ across the selection. Clear or align them individually first.'));
    }
    return wrap;
  }

  private typeSection(el: SlideElement): HTMLElement | null {
    switch (el.type) {
      case 'video': {
        const wrap = group('Video');
        wrap.appendChild(hint(el.src));

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
        wrap.appendChild(play);

        for (const key of ['autoplay', 'loop', 'muted', 'controls'] as const) {
          wrap.appendChild(
            checkboxField(VIDEO_FLAG_LABELS[key], el[key], (v) =>
              this.store.updateSelected((e) => {
                if (e.type === 'video') e[key] = v;
              }),
            ),
          );
        }
        wrap.appendChild(
          checkboxField('Keep aspect ratio', el.fit !== 'fill', (on) =>
            this.store.updateSelected((e) => {
              // 'contain' letterboxes inside the box (AR fixed); 'fill'
              // stretches with it — which is what resizing feels like it
              // should do when this is off.
              if (e.type === 'video') e.fit = on ? 'contain' : 'fill';
            }),
          ),
        );
        wrap.appendChild(this.mediaBorderControls());
        wrap.appendChild(this.mediaEffectsControls());

        wrap.appendChild(this.maskButton(el.id));
        wrap.appendChild(this.trimSection(el));

        // Last resort: the destructive ffmpeg editor. Writes a new file and
        // relinks — for when the non-destructive CSS path is not enough.
        // Desktop only: shells that can't spawn ffmpeg leave onTrimRequest unset.
        if (this.onTrimRequest) {
          const request = this.onTrimRequest;
          wrap.appendChild(button('Edit w/ ffmpeg…', () => request(el), 'primary panel-action'));
          wrap.appendChild(hint('Re-encodes to a new file. The original is kept.'));
        }
        return wrap;
      }

      case 'image': {
        const wrap = group('Image');
        wrap.appendChild(hint(el.src));
        wrap.appendChild(
          checkboxField('Keep aspect ratio', el.fit !== 'fill', (on) =>
            this.store.updateSelected((e) => {
              if (e.type === 'image') e.fit = on ? 'contain' : 'fill';
            }),
          ),
        );
        wrap.appendChild(this.mediaBorderControls());
        wrap.appendChild(this.mediaEffectsControls());
        // Same order as the video section: options, border, effects, then crop.
        wrap.appendChild(this.maskButton(el.id));
        return wrap;
      }

      case 'text': {
        const wrap = group('Text');

        wrap.appendChild(checkboxField('Auto-fit text to box', Boolean(el.autoFit), (on) =>
          this.store.updateSelected((target) => {
            if (target.type === 'text') target.autoFit = on;
          }, { label: on ? 'Enable text auto-fit' : 'Disable text auto-fit' }),
        ));

        wrap.appendChild(checkboxField('Disable automatic line breaks', Boolean(el.noWrap), (on) =>
          this.store.updateSelected((target) => {
            if (target.type === 'text') target.noWrap = on;
          }, { label: on ? 'Disable automatic line breaks' : 'Enable automatic line breaks' }),
        ));

        if (el.noWrap) {
          wrap.appendChild(selectField(
            'Compress by', ['shrink', 'condense'], el.noWrapMode ?? 'shrink',
            (v) => this.store.updateSelected((target) => {
              if (target.type === 'text') target.noWrapMode = v as 'shrink' | 'condense';
            }, { label: 'Change no-wrap compression' }),
          ));
        }

        wrap.appendChild(fontFamilyField(
          'Font family', el.style['font-family'] ?? '',
          (value) => this.store.updateSelected((target) => {
            if (target.type !== 'text') return;
            const style = { ...target.style };
            if (value) style['font-family'] = value;
            else delete style['font-family'];
            target.style = style;
          }, { label: 'Change font family' }),
        ));

        wrap.appendChild(optionalNumberField(
          'Font size',
          Number.parseFloat(el.style['font-size'] ?? '') || null,
          (value) => this.store.updateSelected((target) => {
            target.style = { ...target.style, 'font-size': `${Math.max(6, Math.min(400, value))}px` };
          }, { label: 'Change font size' }),
          () => this.store.updateSelected((target) => {
            const style = { ...target.style };
            delete style['font-size'];
            target.style = style;
          }, { label: 'Use theme font size' }),
          'px',
        ));
        wrap.appendChild(selectField(
          'Font weight',
          ['inherit', '100', '200', '300', '400', '500', '600', '700', '800', '900'],
          el.style['font-weight'] ?? 'inherit',
          (value) => this.store.updateSelected((target) => {
            const style = { ...target.style };
            if (value === 'inherit') delete style['font-weight'];
            else style['font-weight'] = value;
            target.style = style;
          }, { label: 'Change font weight' }),
        ));

        if (this.editingText?.()) {
          const selectionStyle = document.createElement('div');
          selectionStyle.className = 'text-selection-style';
          const selectionLabel = document.createElement('span');
          selectionLabel.textContent = 'Selected text weight';
          const buttons = document.createElement('div');
          buttons.className = 'button-row';
          for (const weight of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
            const choice = button(String(weight), () => this.onApplyTextSelectionWeight?.(weight));
            // Keep the contenteditable selection alive while the button is
            // pressed; blur would commit and destroy its Range before click.
            choice.addEventListener('pointerdown', (event) => event.preventDefault());
            buttons.appendChild(choice);
          }
          selectionStyle.append(selectionLabel, buttons);
          wrap.appendChild(selectionStyle);
        }

        // Semantic role, orthogonal to the free-form class field: the role is
        // what "Cast fonts" and theme.css target, so restyling the deck later
        // lands on the right elements.
        const ROLES: Array<[string, string]> = [
          ['role-title', 'Title'],
          ['role-heading', 'Subtitle'],
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
        wrap.appendChild(roleSelect);

        // Bulleted list: stored as real markup so the player needs no special
        // case and theme.css can style markers.
        const isList = el.html.trimStart().startsWith('<ul');
        wrap.appendChild(
          checkboxField('Bulleted list', isList, (on) =>
            this.store.updateSelected((e) => {
              if (e.type !== 'text') return;
              if (on && !e.html.trimStart().startsWith('<ul')) {
                e.html = paragraphsToList(e.html);
              } else if (!on && e.html.trimStart().startsWith('<ul')) {
                e.html = listToParagraphs(e.html);
              }
            }),
          ),
        );

        wrap.appendChild(hint('Double-click the text on the slide to edit it.'));
        wrap.appendChild(
          colorField(
            'Colour',
            el.style['color'] ?? null,
            (v) => this.store.updateSelected((e) => {
                const rest = { ...e.style };
                if (v) rest['color'] = v;
                else delete rest['color'];
                e.style = rest;
              }),
            this.effectiveTextColor(el),
          ),
        );
        wrap.appendChild(
          selectField('Align', ['left', 'center', 'right', 'justify'], el.align, (v) =>
            this.store.updateSelected((e) => {
              if (e.type === 'text') e.align = v as 'left';
            }),
          ),
        );
        wrap.appendChild(
          selectField('Vertical', ['top', 'middle', 'bottom'], el.valign, (v) =>
            this.store.updateSelected((e) => {
              if (e.type === 'text') e.valign = v as 'top';
            }),
          ),
        );
        wrap.appendChild(optionalNumberField(
          'Paragraph spacing',
          el.paragraphSpacing ?? null,
          (value) => this.store.updateSelected((e) => {
            if (e.type === 'text') e.paragraphSpacing = Math.max(0, value);
          }, { label: 'Change paragraph spacing' }),
          () => this.store.updateSelected((e) => {
            if (e.type === 'text') delete e.paragraphSpacing;
          }, { label: 'Use theme paragraph spacing' }),
          'px',
        ));
        return wrap;
      }

      case 'html': {
        const wrap = group('HTML');
        wrap.appendChild(
          textAreaField('Markup', el.html, (v) =>
            this.store.updateSelected((e) => {
              if (e.type === 'html') e.html = v;
            }),
          ),
        );
        return wrap;
      }

      case 'shape': {
        const wrap = group('Shape');
        wrap.appendChild(
          selectField('Kind', ['rect', 'ellipse', 'line', 'arrow'], el.shape, (v) =>
            this.store.updateSelected((e) => {
              if (e.type === 'shape') e.shape = v as 'rect';
            }),
          ),
        );
        if (el.shape === 'line' || el.shape === 'arrow') {
          wrap.appendChild(
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
        wrap.appendChild(
          colorField('Fill', el.fill, (v) =>
            this.store.updateSelected((e) => {
              if (e.type === 'shape') e.fill = v;
            }),
          ),
        );
        wrap.appendChild(
          colorField('Stroke', el.stroke, (v) =>
            this.store.updateSelected((e) => {
              if (e.type === 'shape') e.stroke = v;
            }),
          ),
        );
        const nums = document.createElement('div');
        nums.className = 'field-grid';
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
        wrap.appendChild(nums);
        return wrap;
      }

      case 'unsupported': {
        const wrap = group('Unsupported');
        wrap.appendChild(
          hint(
            `Imported from ${el.originalType}. Geometry was preserved; replace it with a native element.`,
          ),
        );
        return wrap;
      }
    }
  }

  /** The colour the canvas actually paints when the element inherits from CSS. */
  private effectiveTextColor(el: SlideElement): string | null {
    if (el.type !== 'text') return null;
    const escapeCss = (globalThis.CSS as { escape?: (value: string) => string } | undefined)
      ?.escape;
    const escaped = escapeCss ? escapeCss(el.id) : el.id.replace(/["\\]/g, '\\$&');
    const node = document.querySelector<HTMLElement>(
      `.canvas-host [data-element-id="${escaped}"]`,
    );
    const rendered = node ? colorForInput(getComputedStyle(node).color) : null;
    if (rendered) return rendered;

    const style = this.store.get().deck.themeStyle;
    if (!style) return null;
    const role = el.class.find((name) =>
      /^role-(title|heading|body|caption)$/.test(name))?.slice(5) as
      | 'title' | 'heading' | 'body' | 'caption' | undefined;
    return colorForInput(
      (role ? style.fonts[role].color : undefined) ?? style.colors.text,
    );
  }

  private mediaBorderControls(): HTMLElement {
    const el = this.store.selectedElements()[0];
    const wrap = document.createElement('div');
    wrap.className = 'media-border-controls';
    if (!el || (el.type !== 'image' && el.type !== 'video')) return wrap;
    wrap.appendChild(colorField('Border colour', el.borderColor ?? null, (value) =>
      this.store.updateSelected((target) => {
        if (target.type === 'image' || target.type === 'video') target.borderColor = value;
      })));
    const numbers = document.createElement('div');
    numbers.className = 'field-grid';
    numbers.append(
      numberField('WIDTH', el.borderWidth ?? 0, (value) =>
        this.store.updateSelected((target) => {
          if (target.type === 'image' || target.type === 'video') {
            target.borderWidth = Math.max(0, value);
          }
        })),
      numberField('RADIUS', el.borderRadius ?? 0, (value) =>
        this.store.updateSelected((target) => {
          if (target.type === 'image' || target.type === 'video') {
            target.borderRadius = Math.max(0, value);
          }
        })),
    );
    wrap.appendChild(numbers);
    return wrap;
  }

  private mediaEffectsControls(): HTMLElement {
    const el = this.store.selectedElements()[0];
    const wrap = document.createElement('div');
    wrap.className = 'media-effects-controls';
    if (!el || (el.type !== 'image' && el.type !== 'video')) return wrap;

    const title = document.createElement('div');
    title.className = 'insp-subtitle';
    title.textContent = 'Effects';
    wrap.appendChild(title);

    for (const [index, effect] of (el.effects ?? []).entries()) {
      const row = document.createElement('div');
      row.className = 'media-effect-row';
      row.dataset.effectIndex = String(index);
      const name = document.createElement('span');
      name.textContent = effect.type === 'grayscale' ? 'Greyscale' :
        effect.type[0].toUpperCase() + effect.type.slice(1);
      const value = document.createElement('input');
      value.type = 'number';
      value.min = effect.type === 'posterize' ? '2' : '0';
      value.max = effect.type === 'blur' ? '200' : effect.type === 'posterize' ? '32' : '1';
      value.step = effect.type === 'grayscale' ? '0.05' : '1';
      value.value = String(effectValue(effect));
      value.title = effect.type === 'blur' ? 'Blur radius in pixels' :
        effect.type === 'posterize' ? 'Number of colour levels' : 'Amount from 0 to 1';
      value.addEventListener('change', () => {
        const next = Number(value.value);
        if (!Number.isFinite(next)) return;
        this.store.updateSelected((target) => {
          if (target.type !== 'image' && target.type !== 'video') return;
          const current = target.effects?.[index];
          if (!current) return;
          if (current.type === 'blur') current.radius = clamp(next, 0, 200);
          else if (current.type === 'posterize') current.levels = Math.round(clamp(next, 2, 32));
          else current.amount = clamp(next, 0, 1);
        }, { label: `Adjust ${effect.type} effect` });
      });

      const up = smallButton('↑', 'Move effect earlier', () => this.moveMediaEffect(index, -1));
      const down = smallButton('↓', 'Move effect later', () => this.moveMediaEffect(index, 1));
      up.disabled = index === 0;
      down.disabled = index === (el.effects?.length ?? 0) - 1;
      const remove = smallButton('×', 'Remove effect', () => {
        this.store.updateSelected((target) => {
          if (target.type !== 'image' && target.type !== 'video') return;
          target.effects = (target.effects ?? []).filter((_, candidate) => candidate !== index);
        }, { label: `Remove ${effect.type} effect` });
      });
      row.append(name, value, up, down, remove);
      wrap.appendChild(row);
    }

    const add = document.createElement('select');
    add.className = 'effect-add panel-action-select';
    for (const [value, label] of [
      ['', '+ Add effect'], ['blur', 'Blur'], ['posterize', 'Posterize'], ['grayscale', 'Greyscale'],
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
          : { type: 'grayscale', amount: 1 };
      this.store.updateSelected((target) => {
        if (target.type === 'image' || target.type === 'video') {
          target.effects = [...(target.effects ?? []), structuredClone(effect)];
        }
      }, { label: `Add ${effect.type} effect` });
      add.value = '';
    });
    wrap.appendChild(add);
    return wrap;
  }

  private moveMediaEffect(index: number, delta: -1 | 1): void {
    this.store.updateSelected((target) => {
      if (target.type !== 'image' && target.type !== 'video') return;
      const effects = [...(target.effects ?? [])];
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

function optionalNumberField(
  label: string,
  value: number | null,
  onChange: (value: number) => void,
  onClear: () => void,
  suffix = '',
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field field-number';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.value = value === null ? '' : String(value);
  input.placeholder = 'theme';
  input.title = suffix ? `Value in ${suffix}` : label;
  input.addEventListener('change', () => {
    if (!input.value.trim()) onClear();
    else {
      const parsed = Number(input.value);
      if (Number.isFinite(parsed)) onChange(parsed);
    }
  });
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'icon-button';
  clear.textContent = '×';
  clear.title = 'Use theme value';
  clear.addEventListener('click', (event) => {
    event.preventDefault();
    onClear();
  });
  wrap.append(span, input, clear);
  return wrap;
}

function textField(
  label: string,
  value: string,
  onChange: (v: string) => void,
  placeholder = '',
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('change', () => onChange(input.value));
  wrap.append(span, input);
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
 * A slider over a clip's duration.
 *
 * Commits continuously while dragging so the canvas preview follows the
 * handle; the store coalesces a drag into one undo entry.
 */
function rangeSlider(
  label: string,
  value: number,
  max: number,
  onInput: (v: number) => void,
  onCommit: (v: number) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = String(max);
  input.step = '0.01';
  input.value = String(value);
  // `input` fires continuously while dragging and must stay side-effect-free
  // on the store; `change` fires once on release and is when the deck commits.
  input.addEventListener('input', () => onInput(Number(input.value)));
  input.addEventListener('change', () => onCommit(Number(input.value)));
  wrap.append(span, input);
  return wrap;
}

/**
 * A colour swatch picker. `null` means "no colour" (transparent fill, no
 * stroke, inherit text colour), cleared with the x button.
 */
function colorField(
  label: string,
  value: string | null,
  onChange: (v: string | null) => void,
  inheritedValue: string | null = null,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field field-color';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'color';
  // Swatches from the installed theme, if any (a <datalist> the toolbar keeps
  // up to date). This is what "installing a theme updates the choices" means.
  input.setAttribute('list', 'theme-swatches');
  // <input type=color> only speaks 6-digit hex; anything else (rgba, names,
  // unset) previews as mid-grey until picked.
  input.value = colorForInput(value) ?? inheritedValue ?? '#888888';
  input.dataset.inherited = String(value === null);
  input.title = value === null ? 'Inherited colour' : 'Explicit colour';
  // Native colour panels emit `input` while their gradient is being explored.
  // Committing there rebuilds this inspector and destroys the input anchoring
  // the still-open panel. Commit once the choice is accepted instead.
  input.addEventListener('change', () => onChange(input.value));
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'icon-button';
  clear.textContent = '×';
  clear.title = 'No colour';
  clear.addEventListener('click', (e) => {
    e.preventDefault();
    onChange(null);
  });
  wrap.append(span, input, clear);
  return wrap;
}

/** Convert CSS hex/rgb colours to the six-digit format native colour inputs require. */
function colorForInput(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) return `#${hex[1].toLowerCase()}`;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value.trim());
  if (short) return `#${short.slice(1).map((part) => part + part).join('').toLowerCase()}`;
  const rgb = /^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)(?:\s*[,/]\s*(?:1(?:\.0+)?))?\s*\)$/i.exec(
    value.trim(),
  );
  if (!rgb) return null;
  return `#${rgb.slice(1, 4).map((part) =>
    Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, '0')).join('')}`;
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

function commonValue<T>(values: T[]): T | null {
  if (values.length === 0) return null;
  return values.every((value) => Object.is(value, values[0])) ? values[0] : null;
}

function sharedValue<T>(values: T[]): { mixed: boolean; value: T | null } {
  if (values.length === 0) return { mixed: false, value: null };
  const mixed = !values.every((value) => Object.is(value, values[0]));
  return { mixed, value: mixed ? null : values[0] };
}
