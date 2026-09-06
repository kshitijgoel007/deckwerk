import type { Deck, Slide } from './deck.js';

/**
 * Speaker notes as a Markdown file.
 *
 * `deck.json` holds the truth: each slide carries a `notes` string, so notes
 * follow their slide through reorders, copies, undo, history and collaboration.
 * `notes.md` in the deck folder mirrors those strings so an author can read
 * and write them in any editor. The editor rewrites the file whenever it saves
 * the deck, and a change to the file on disk is parsed back into the slides.
 *
 * The format asks one thing of a human: slides are separated by a line holding
 * only `---`. Everything else in a section is that slide's note, verbatim.
 *
 * The editor additionally writes two lines at the top of every section, both
 * optional on the way back in:
 *
 *   ## 3 · Demo                     a heading for outline views; regenerated
 *   <!-- slide: slide-zz81qpl2 -->  the slide id; invisible in previews
 *
 * The anchor lets a section find its slide by id even after slides were
 * reordered in the editor while the file sat open elsewhere. A section without
 * an anchor (or with one naming a slide that no longer exists) is matched by
 * position among the slides no anchored section claimed.
 */

export const SPEAKER_NOTES_FILE = 'notes.md';

const DIVIDER = /^---\s*$/;
const ANCHOR = /^<!--\s*slide:\s*(\S+)\s*-->\s*$/;
/** Only headings shaped like the ones we write, so a note that opens with its own heading keeps it. */
const GENERATED_HEADING = /^##\s+(?:\d+\s+·|Slide\s+\d+\s*$)/;

export interface SpeakerNotesSection {
  /** Slide id from the anchor comment, when the section has one. */
  id: string | null;
  text: string;
}

/** The exact bytes the editor writes for a deck's `notes.md`. */
export function serializeSpeakerNotes(deck: Deck): string {
  const sections = deck.slides.map((slide, index) => {
    const lines = [sectionHeading(slide, index), `<!-- slide: ${slide.id} -->`];
    const text = normalizeNote(slide.notes);
    if (text) lines.push('', text);
    return lines.join('\n');
  });
  return `${sections.join('\n\n---\n\n')}\n`;
}

/** Split a notes file into sections, stripping the lines the editor generates. */
export function parseSpeakerNotes(markdown: string): SpeakerNotesSection[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const sections: SpeakerNotesSection[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (DIVIDER.test(line)) {
      sections.push(readSection(current));
      current = [];
    } else {
      current.push(line);
    }
  }
  sections.push(readSection(current));
  return sections;
}

export interface AppliedSpeakerNotes {
  deck: Deck;
  /** Whether any slide's note changed. */
  changed: boolean;
  /** Sections that found no slide: more sections than slides, or unknown ids with no slide left. */
  dropped: number;
}

/**
 * Bring a deck's slide notes in line with a `notes.md`. Anchored sections go to
 * their slide; the rest fill the unclaimed slides in order. Slides no section
 * reaches are left with an empty note — the file is the whole set of notes.
 */
export function applySpeakerNotes(deck: Deck, markdown: string): AppliedSpeakerNotes {
  const sections = parseSpeakerNotes(markdown);
  const byId = new Map(deck.slides.map((slide) => [slide.id, slide]));
  const assigned = new Map<string, string>();
  const unplaced: SpeakerNotesSection[] = [];
  for (const section of sections) {
    if (section.id && byId.has(section.id) && !assigned.has(section.id)) {
      assigned.set(section.id, section.text);
    } else {
      unplaced.push(section);
    }
  }
  let next = 0;
  for (const slide of deck.slides) {
    if (assigned.has(slide.id)) continue;
    if (next >= unplaced.length) break;
    assigned.set(slide.id, unplaced[next++].text);
  }
  const dropped = unplaced.length - next;

  let changed = false;
  const slides = deck.slides.map((slide) => {
    const text = assigned.get(slide.id) ?? '';
    if (normalizeNote(slide.notes) === text) return slide;
    changed = true;
    return { ...slide, notes: text };
  });
  return { deck: changed ? { ...deck, slides } : deck, changed, dropped };
}

function readSection(lines: string[]): SpeakerNotesSection {
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  let id: string | null = null;
  let sawHeading = false;
  for (let guard = 0; guard < 2 && start < lines.length; guard++) {
    const line = lines[start];
    if (!sawHeading && GENERATED_HEADING.test(line)) {
      sawHeading = true;
      start++;
    } else if (id === null && ANCHOR.test(line)) {
      id = ANCHOR.exec(line)![1];
      start++;
    } else {
      break;
    }
  }
  return { id, text: normalizeNote(lines.slice(start).join('\n')) };
}

/** A note as stored and compared: LF line endings, no leading blank lines, no trailing whitespace. */
export function normalizeNote(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
}

function sectionHeading(slide: Slide, index: number): string {
  const title = slide.name.trim() || titleFromElements(slide);
  return title ? `## ${index + 1} · ${title}` : `## Slide ${index + 1}`;
}

/** The slide's title text, if it has a title element — a courtesy for outline views. */
function titleFromElements(slide: Slide): string {
  for (const element of slide.elements) {
    if (element.type !== 'text') continue;
    const classes = Array.isArray(element.class) ? element.class : [];
    if (!classes.includes('role-title')) continue;
    const text = element.html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text.length > 80 ? `${text.slice(0, 77).trimEnd()}…` : text;
  }
  return '';
}
