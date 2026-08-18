import type { SlideElement, TimelineEntry } from './deck.js';

/**
 * What this editor can do, as copy-pasteable JSON.
 *
 * An agent that does not know a feature exists reimplements it badly — it
 * hardcodes an equation as text because it never learned that `$…$` renders
 * through KaTeX, or it re-encodes a video to crop it because it never learned
 * about `sourceBox`. This is the antidote: every capability with a minimal,
 * valid example element beside it.
 *
 * `scripts/build-agent-reference.mts` builds a real deck out of these entries,
 * so the reference deck an agent can render and the cookbook it reads are the
 * same source and cannot drift apart.
 */

export interface Capability {
  id: string;
  /** One line: what this is. */
  what: string;
  /** One line: when to reach for it. */
  when: string;
  /** Gotchas worth knowing before using it. */
  notes?: string[];
  /** Valid elements demonstrating the feature, on a 1920×1080 canvas. */
  elements: SlideElement[];
  timeline?: TimelineEntry[];
  /** Slide-level fields the feature needs, e.g. a background or Magic Move. */
  slide?: { background?: { color: string | null; image: string | null }; magicMoveFromPrevious?: boolean };
}

const text = (
  id: string,
  html: string,
  box: { x: number; y: number; w: number; h: number },
  over: Partial<Extract<SlideElement, { type: 'text' }>> = {},
): SlideElement => ({
  id, type: 'text', ...box, rot: 0, z: 1, opacity: 1,
  class: ['role-body'], style: {}, html, align: 'left', valign: 'top', ...over,
});

const CAPTION = { x: 160, y: 900, w: 1600, h: 90 };
const TITLE = { x: 160, y: 90, w: 1600, h: 150 };

export function capabilities(): Capability[] {
  return [
    {
      id: 'text-roles',
      what: 'Text styled by theme class, never by inline font sizes.',
      when: 'Every piece of text. Pick the role; let theme.css size it.',
      notes: [
        'role-title, role-heading, role-body, role-caption are the vocabulary.',
        'An inline `style` overrides the theme and should be a deliberate one-off.',
        'html may contain inline markup: <b>, <i>, <br>, <span>.',
        'paragraphSpacing (px) sets the gap between paragraphs and between bullets; unset keeps the theme default.',
      ],
      elements: [
        text('cap-roles-title', 'A title in the deck’s own type', TITLE, { class: ['role-title'] }),
        text('cap-roles-body', 'Body text carries <b>bold</b> and <i>italic</i> inline.', { x: 160, y: 300, w: 1600, h: 200 }),
        text('cap-roles-caption', 'A caption, for figure credits and asides.', CAPTION, { class: ['role-caption'] }),
      ],
    },
    {
      id: 'latex',
      what: 'LaTeX maths, rendered by KaTeX at present time.',
      when: 'Any equation. Never hand-build maths out of positioned text.',
      notes: [
        '$…$ is inline and stays in the sentence flow; $$…$$ is display.',
        'A literal dollar sign is written \\$.',
        'The equation is part of the text element’s html — not a separate element.',
      ],
      elements: [
        text('cap-latex-title', 'Maths is text, not layout', TITLE, { class: ['role-title'] }),
        text(
          'cap-latex-inline',
          'A rendering is a function $f_\\theta(\\mathbf{x}) \\rightarrow (\\mathbf{c}, \\sigma)$ of position.',
          { x: 160, y: 320, w: 1600, h: 120 },
        ),
        text(
          'cap-latex-display',
          'Volume rendering integrates along the ray: $$C(\\mathbf{r}) = \\int_{t_n}^{t_f} T(t)\\,\\sigma(\\mathbf{r}(t))\\,\\mathbf{c}(t)\\,dt$$',
          { x: 160, y: 470, w: 1600, h: 300 },
        ),
      ],
    },
    {
      id: 'auto-fit',
      what: 'Text that shrinks to stay inside its box.',
      when: 'Titles and quotes whose length you cannot predict.',
      notes: [
        'autoFit never grows text past its authored size; it only shrinks.',
        'inspect reports the size it settled on as text.fittedFontSize.',
        'noWrap: true disables automatic line wrapping — lines break only where the author wrote one — and implies the auto-fit shrink for overlong lines.',
        "noWrapMode picks how a no-wrap line is compressed: 'shrink' (default) reduces the font size uniformly; 'condense' keeps the size and squeezes the type horizontally.",
      ],
      elements: [
        text('cap-fit-title', 'Auto-fit', TITLE, { class: ['role-title'] }),
        text(
          'cap-fit-body',
          'This sentence is far longer than its box would normally allow, and is shrunk to fit rather than spilling over the edge of the slide.',
          { x: 160, y: 320, w: 1600, h: 200 },
          { autoFit: true, class: ['role-title'] },
        ),
      ],
    },
    {
      id: 'image',
      what: 'An image, fitted inside its box.',
      when: 'Figures, screenshots, diagrams. PDFs and SVGs stay vector.',
      notes: [
        'fit: contain preserves the whole figure; cover fills the box and clips.',
        'Import media with `slide-agent asset import` — never reference a path outside the deck.',
      ],
      elements: [
        text('cap-image-title', 'Images', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-image', type: 'image', x: 560, y: 300, w: 800, h: 500, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, src: 'assets/swatch.png', fit: 'contain',
          alt: 'A figure', sourceBox: null,
        },
      ],
    },
    {
      id: 'crop',
      what: 'A non-destructive crop, on images and video alike.',
      when: 'Showing part of a figure. Never re-encode or re-export to crop.',
      notes: [
        'The element box is the window; sourceBox places the *whole* image relative to it.',
        'A sourceBox larger than the box, with negative x/y, is a zoom-in on the middle.',
        'Reversible and editable later: the original file is untouched.',
      ],
      elements: [
        text('cap-crop-title', 'Cropping with sourceBox', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-crop', type: 'image', x: 660, y: 300, w: 600, h: 400, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, src: 'assets/swatch.png', fit: 'cover',
          alt: 'A cropped figure',
          sourceBox: { x: -300, y: -200, w: 1200, h: 800 },
        },
        text('cap-crop-caption', 'The box is the window; the source is placed behind it.', CAPTION, { class: ['role-caption'] }),
      ],
    },
    {
      id: 'media-frame',
      what: 'Borders, rounded corners and visual effects on media.',
      when: 'Setting a figure off from the background, or de-emphasising it.',
      notes: [
        'effects apply in array order: blur, posterize, grayscale.',
        'borderWidth/borderColor/borderRadius work on both images and video.',
      ],
      elements: [
        text('cap-frame-title', 'Framed and filtered media', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-frame-plain', type: 'image', x: 200, y: 320, w: 700, h: 440, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, src: 'assets/swatch.png', fit: 'cover', alt: '',
          sourceBox: null, borderColor: '#ff3366', borderWidth: 10, borderRadius: 18,
        },
        {
          id: 'cap-frame-effect', type: 'image', x: 1020, y: 320, w: 700, h: 440, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, src: 'assets/swatch.png', fit: 'cover', alt: '',
          sourceBox: null, effects: [{ type: 'blur', radius: 6 }, { type: 'grayscale', amount: 0.8 }],
        },
      ],
    },
    {
      id: 'video',
      what: 'Video as a first-class object, with a non-destructive trim.',
      when: 'Any result clip. This editor exists for this.',
      notes: [
        'start/end are seconds; end: null means the end of the file. Looping honours them.',
        'autoplay/loop/muted default to true — a slide video normally plays itself.',
        'Only H.264/VP8/VP9/AV1 decode; `asset import` transcodes anything else.',
        'A video can be cropped and framed exactly like an image.',
      ],
      elements: [
        text('cap-video-title', 'Video, trimmed and framed', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-video', type: 'video', x: 460, y: 300, w: 1000, h: 500, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, src: 'assets/testclip.mp4', fit: 'contain',
          autoplay: true, loop: true, muted: true, controls: false,
          start: 1, end: 5, poster: null, sourceBox: null,
          borderColor: '#111111', borderWidth: 6, borderRadius: 12,
        },
        text('cap-video-caption', 'Seconds 1–5 of the source, looping, untouched on disk.', CAPTION, { class: ['role-caption'] }),
      ],
    },
    {
      id: 'shapes',
      what: 'Rectangles, ellipses, lines and arrows, including curved ones.',
      when: 'Callouts, connectors, emphasis boxes.',
      notes: [
        'An arrow’s `control` is an absolute canvas-space point making it a quadratic curve.',
        'shape: "path" carries real SVG path data, scaled from pathSize to the element box.',
      ],
      elements: [
        text('cap-shape-title', 'Shapes and connectors', TITLE, { class: ['role-title'] }),
        {
          id: 'cap-shape-box', type: 'shape', x: 200, y: 380, w: 460, h: 260, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, shape: 'rect', fill: null, stroke: '#2563eb',
          strokeWidth: 4, radius: 16, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
        },
        {
          id: 'cap-shape-arrow', type: 'shape', x: 700, y: 380, w: 500, h: 260, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, shape: 'arrow', fill: null, stroke: '#111111',
          strokeWidth: 6, radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: true,
          control: { x: 950, y: 300 },
        },
        {
          id: 'cap-shape-ellipse', type: 'shape', x: 1260, y: 380, w: 460, h: 260, rot: 0, z: 2,
          opacity: 1, class: [], style: {}, shape: 'ellipse', fill: '#fde68a', stroke: null,
          strokeWidth: 2, radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
        },
      ],
    },
    {
      id: 'builds',
      what: 'Timeline builds: reveal objects on click or after the previous step.',
      when: 'Walking an audience through a slide one point at a time.',
      notes: [
        'An entry is a trigger (click / afterPrev / withPrev / mediaEnd) plus an action.',
        'Every timeline entry must target an element id on the same slide.',
        'Objects with no build are visible from the start.',
        "An appear with value: 'byParagraph' on a text element reveals it one paragraph (or list item) at a time, in document order — one click each, or a cascade when triggered afterPrev/withPrev.",
      ],
      elements: [
        text('cap-build-title', 'Builds', TITLE, { class: ['role-title'] }),
        text('cap-build-1', 'First this appears with the slide.', { x: 160, y: 340, w: 1600, h: 100 }),
        text('cap-build-2', 'Then this, on a click.', { x: 160, y: 470, w: 1600, h: 100 }),
        text('cap-build-3', 'And this, half a second later.', { x: 160, y: 600, w: 1600, h: 100 }),
      ],
      timeline: [
        {
          id: 'cap-build-t1',
          trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'appear', target: 'cap-build-2', value: null },
        },
        {
          id: 'cap-build-t2',
          trigger: { on: 'afterPrev', ref: null, delay: 500 },
          action: { type: 'appear', target: 'cap-build-3', value: null },
        },
      ],
    },
    {
      id: 'magic-move',
      what: 'Animated transitions between slides, pairing objects by identity.',
      when: 'A derivation, a growing diagram, a figure that moves and scales.',
      notes: [
        'Give the same magicMoveId to the objects that are "the same thing" on both slides.',
        'Set magicMoveFromPrevious: true on the *later* slide.',
        'Unpaired objects cross-fade; deck.magicMoveDuration sets the timing.',
        "deck.magicMoveEasing picks the motion curve: 'ease-in-out' (default), 'ease-out' (snappy start, soft landing), or 'linear'.",
      ],
      elements: [
        text('cap-magic-title', 'Magic Move', TITLE, { class: ['role-title'] }),
        text('cap-magic-term', '$E = mc^2$', { x: 260, y: 420, w: 700, h: 200 }, {
          class: ['role-title'], magicMoveId: 'cap-magic-equation',
        }),
      ],
    },
    {
      id: 'magic-move-target',
      what: 'The second half of the pair: same identity, new position.',
      when: 'Always authored together with the slide before it.',
      notes: ['This slide carries magicMoveFromPrevious: true.'],
      slide: { magicMoveFromPrevious: true },
      elements: [
        text('cap-magic2-title', 'The same object, moved', TITLE, { class: ['role-title'] }),
        text('cap-magic2-term', '$E = mc^2$', { x: 1000, y: 640, w: 700, h: 200 }, {
          class: ['role-title'], magicMoveId: 'cap-magic-equation',
        }),
      ],
    },
    {
      id: 'background',
      what: 'A slide background colour or full-bleed image.',
      when: 'Section dividers and full-bleed figures.',
      notes: ['A background image covers the canvas; text on it needs contrast.'],
      slide: { background: { color: '#0f172a', image: null } },
      elements: [
        text('cap-bg-title', 'Section divider', TITLE, {
          class: ['role-title'], style: { color: '#f8fafc' },
        }),
      ],
    },
  ];
}
