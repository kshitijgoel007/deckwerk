import type { SlideElement } from '@shared/deck.js';
import { type AlignMode, alignElements } from './align.js';
import type { EditorStore } from './store.js';

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
  /** Apply the installed theme (with the toolbar's checkboxes) to this slide. */
  onApplyTheme?: () => void;

  /** What the panel showed last, to skip re-renders that would change nothing. */
  private lastDeck: unknown = null;
  private lastSelection = '';
  private lastSlide = -1;

  constructor(host: HTMLElement, store: EditorStore) {
    this.host = host;
    this.store = store;
    // Only re-render when the deck, selection or slide actually changed. The
    // store also emits for bookkeeping (autosave's markClean among them), and
    // rebuilding then destroys whatever control the user is holding — the trim
    // slider died ~800ms into every drag this way.
    store.subscribe(() => {
      const { deck, selection, slideIndex } = this.store.get();
      const sel = [...selection].sort().join(',');
      if (deck === this.lastDeck && sel === this.lastSelection && slideIndex === this.lastSlide) {
        return;
      }
      this.render();
    });
    this.render();
  }

  render(): void {
    const { deck, selection, slideIndex } = this.store.get();
    this.lastDeck = deck;
    this.lastSelection = [...selection].sort().join(',');
    this.lastSlide = slideIndex;
    const selected = this.store.selectedElements();
    this.host.replaceChildren();

    if (selected.length === 0) {
      this.host.appendChild(hint('Nothing selected'));
      const slideGroup = group('Slide');
      slideGroup.appendChild(
        button('Apply theme to slide', () => this.onApplyTheme?.()),
      );
      slideGroup.appendChild(
        hint('Applies the installed theme with the aspects ticked in the toolbar.'),
      );
      this.host.appendChild(slideGroup);
      return;
    }
    if (selected.length > 1) {
      this.host.appendChild(hint(`${selected.length} elements selected`));
      this.host.appendChild(this.alignSection());
      this.host.appendChild(this.geometrySection(selected));
      return;
    }

    const el = selected[0];
    this.host.appendChild(sectionTitle(el.type));
    this.host.appendChild(this.geometrySection(selected));
    this.host.appendChild(this.styleSection(el));

    const specific = this.typeSection(el);
    if (specific) this.host.appendChild(specific);
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
        active ? 'primary' : '',
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
    if (el && (el.type === 'image' || el.type === 'video') && el.sourceBox) {
      wrap.appendChild(
        button('Reset crop', () =>
          this.store.updateSelected((e) => {
            if (e.type === 'image' || e.type === 'video') e.sourceBox = null;
          }),
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
        if (m.x !== undefined) el.x = Math.round(m.x);
        if (m.y !== undefined) el.y = Math.round(m.y);
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
        numberField(key.toUpperCase(), multi ? null : first[key], (v) => {
          this.store.updateSelected((el) => {
            if (key === 'w' || key === 'h') el[key] = Math.max(8, v);
            else el[key] = v;
          });
        }),
      );
    }
    wrap.appendChild(row);

    const row2 = document.createElement('div');
    row2.className = 'field-grid';
    row2.appendChild(
      numberField('ROT', multi ? null : first.rot, (v) =>
        this.store.updateSelected((el) => (el.rot = v)),
      ),
    );
    row2.appendChild(
      numberField('Z', multi ? null : first.z, (v) =>
        this.store.updateSelected((el) => (el.z = Math.round(v))),
      ),
    );
    row2.appendChild(
      numberField('OPACITY', multi ? null : first.opacity, (v) =>
        this.store.updateSelected((el) => (el.opacity = Math.min(1, Math.max(0, v)))),
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
  private styleSection(el: SlideElement): HTMLElement {
    const wrap = group('Style');
    wrap.appendChild(
      textField('CSS classes', el.class.join(' '), (v) => {
        const classes = v.split(/\s+/).filter(Boolean);
        this.store.updateSelected((e) => (e.class = classes));
      }, 'Space-separated, defined in theme.css'),
    );
    wrap.appendChild(
      textField(
        'Inline style',
        Object.entries(el.style)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; '),
        (v) => {
          const style: Record<string, string> = {};
          for (const decl of v.split(';')) {
            const idx = decl.indexOf(':');
            if (idx <= 0) continue;
            style[decl.slice(0, idx).trim()] = decl.slice(idx + 1).trim();
          }
          this.store.updateSelected((e) => (e.style = style));
        },
        'e.g. color: #e33; letter-spacing: -0.02em',
      ),
    );
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
            checkboxField(key, el[key], (v) =>
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

        wrap.appendChild(this.maskButton(el.id));
        wrap.appendChild(this.trimSection(el));

        // Last resort: the destructive ffmpeg editor. Writes a new file and
        // relinks — for when the non-destructive CSS path is not enough.
        wrap.appendChild(button('Edit w/ ffmpeg…', () => this.onTrimRequest?.(el)));
        wrap.appendChild(hint('Re-encodes to a new file. The original is kept.'));
        return wrap;
      }

      case 'image': {
        const wrap = group('Image');
        wrap.appendChild(hint(el.src));
        wrap.appendChild(this.maskButton(el.id));
        wrap.appendChild(
          checkboxField('Keep aspect ratio', el.fit !== 'fill', (on) =>
            this.store.updateSelected((e) => {
              if (e.type === 'image') e.fit = on ? 'contain' : 'fill';
            }),
          ),
        );
        return wrap;
      }

      case 'text': {
        const wrap = group('Text');

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
                const items = e.html
                  .split(/<br\s*\/?>/i)
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => `<li>${line}</li>`)
                  .join('');
                e.html = `<ul>${items || '<li>Item</li>'}</ul>`;
              } else if (!on && e.html.trimStart().startsWith('<ul')) {
                const div = document.createElement('div');
                div.innerHTML = e.html;
                e.html = [...div.querySelectorAll('li')]
                  .map((li) => li.innerHTML)
                  .join('<br>');
              }
            }),
          ),
        );

        wrap.appendChild(hint('Double-click the text on the slide to edit it.'));
        wrap.appendChild(
          colorField('Colour', el.style['color'] ?? null, (v) =>
            this.store.updateSelected((e) => {
              const rest = { ...e.style };
              if (v) rest['color'] = v;
              else delete rest['color'];
              e.style = rest;
            }),
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
  input.value = /^#[0-9a-fA-F]{6}$/.test(value ?? '') ? (value as string) : '#888888';
  input.addEventListener('input', () => onChange(input.value));
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
