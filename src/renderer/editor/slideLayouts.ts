import type { Slide, TextEl } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';

export type SlideLayout = 'freeform' | 'standard' | 'title';

const geometry = {
  standard: {
    title: { x: 120, y: 58, w: 1680, h: 142, align: 'left' as const, valign: 'middle' as const },
    body: { x: 120, y: 252, w: 1680, h: 700, align: 'left' as const, valign: 'top' as const },
  },
  title: {
    title: { x: 180, y: 350, w: 1560, h: 300, align: 'center' as const, valign: 'middle' as const },
  },
};

function placeholder(slide: Slide, role: 'title' | 'body'): TextEl {
  const z = slide.elements.reduce((max, el) => Math.max(max, el.z), 0) + 1;
  return {
    id: makeId('text'), type: 'text', x: 0, y: 0, w: 100, h: 100, rot: 0, z,
    opacity: 1, class: [`role-${role}`, 'placeholder'], style: {},
    html: role === 'title' ? 'Slide title' : 'Body text', align: 'left', valign: 'top',
  };
}

/** Apply layout geometry without consulting or mutating the installed theme. */
export function applySlideLayout(slide: Slide, layout: SlideLayout): void {
  slide.layout = layout;
  if (layout === 'freeform') return;

  let title = slide.elements.find((el): el is TextEl =>
    el.type === 'text' && el.class.includes('role-title'));
  if (!title) {
    title = placeholder(slide, 'title');
    slide.elements.push(title);
  }
  Object.assign(title, geometry[layout].title);

  if (layout === 'standard') {
    let body = slide.elements.find((el): el is TextEl =>
      el.type === 'text' && el.class.includes('role-body'));
    if (!body) {
      body = placeholder(slide, 'body');
      slide.elements.push(body);
    }
    Object.assign(body, geometry.standard.body);
  }
}

export const LAYOUT_LABELS: Array<[SlideLayout, string]> = [
  ['freeform', 'Freeform'],
  ['standard', 'Title + body'],
  ['title', 'Title slide'],
];
