import type { SlideElement } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import { EditorCanvas } from './canvas.js';
import { Inspector } from './inspector.js';
import { SlideRail } from './slideRail.js';
import {
  EditorStore,
  copySelectionToClipboard,
  copySlidesToClipboard,
  cutSelectionToClipboard,
  pasteFromClipboard,
} from './store.js';

/**
 * Shell-independent wiring shared by the Electron editor and the browser
 * collab client: the canvas↔inspector callback lattice, the keyboard map,
 * clipboard actions, and the canvas context menu. Anything only one shell can
 * do (ffmpeg trim, presenting, agent workflows) arrives as an optional dep and
 * simply doesn't exist in shells that can't provide it.
 */

type VideoElement = Extract<SlideElement, { type: 'video' }>;

export interface ShellDeps {
  store: EditorStore;
  canvas: EditorCanvas;
  rail: SlideRail;
  save: () => Promise<void>;
  setStatusMessage: (text: string) => void;
  /** Desktop only: open the destructive ffmpeg trim/crop window. */
  openTrim?: (element: VideoElement) => void;
  /**
   * Undo/redo overrides. The Electron shell uses the store's snapshot stacks;
   * the collab shell substitutes op-based selective undo, because restoring a
   * whole-deck snapshot would also revert other people's concurrent edits.
   */
  undo?: () => void;
  redo?: () => void;
}

export function wireCanvasInspector(
  canvas: EditorCanvas,
  inspector: Inspector,
  openTrim?: (element: VideoElement) => void,
): void {
  if (openTrim) {
    canvas.onTrimRequest = openTrim;
    inspector.onTrimRequest = openTrim;
  }
  inspector.onTogglePlay = (id) => canvas.toggleVideo(id);
  inspector.onEditText = (id) => canvas.beginTextEdit(id);
  inspector.editingText = () => canvas.isEditing();
  inspector.onApplyTextSelectionWeight = (weight) => canvas.applyTextSelectionWeight(weight);
  inspector.onToggleMask = (id) => canvas.toggleMaskMode(id);
  inspector.maskingElement = () => canvas.maskingElement();
  inspector.onSeekPreview = (id, t) => canvas.seekVideo(id, t);
  inspector.videoDuration = (id) => canvas.videoDuration(id);
  canvas.onMaskModeChange = () => inspector.render();
  canvas.onTextEditModeChange = () => inspector.render();
}

export interface ClipboardActions {
  copyToClipboard: (verb: 'Copied' | 'Cut') => Promise<'elements' | 'slides' | null>;
  cutToClipboard: () => Promise<void>;
  pasteClipboard: () => Promise<void>;
}

/**
 * Copy targets whatever the user has selected: canvas elements when any are
 * selected, otherwise the slides picked in the rail.
 */
export function createClipboardActions(deps: ShellDeps): ClipboardActions {
  const { store, rail, setStatusMessage } = deps;

  const copyToClipboard = async (verb: 'Copied' | 'Cut') => {
    if (store.get().selection.size > 0) {
      const n = await copySelectionToClipboard(store);
      if (n) setStatusMessage(`${verb} ${n} element${n > 1 ? 's' : ''}.`);
      return n ? ('elements' as const) : null;
    }
    const n = await copySlidesToClipboard(store);
    if (n) setStatusMessage(`${verb} ${n} slide${n > 1 ? 's' : ''}.`);
    return n ? ('slides' as const) : null;
  };

  const cutToClipboard = async () => {
    const copied = await copyToClipboard('Cut');
    if (copied === 'elements') store.deleteSelection();
    else if (copied === 'slides') rail.deleteSlide();
  };

  const pasteClipboard = async () => {
    const pasted = await pasteFromClipboard(store);
    if (pasted) {
      const noun = pasted.kind === 'slides' ? 'slide' : 'element';
      setStatusMessage(`Pasted ${pasted.count} ${noun}${pasted.count > 1 ? 's' : ''}.`);
    }
  };

  return { copyToClipboard, cutToClipboard, pasteClipboard };
}

export function duplicateSelection(store: EditorStore): void {
  const ids = store.get().selection;
  if (ids.size === 0) return;
  const created: string[] = [];
  store.commit((deck) => {
    const slide = deck.slides[store.get().slideIndex];
    for (const el of slide.elements.filter((e) => ids.has(e.id))) {
      const copy = structuredClone(el);
      copy.lineageId = el.lineageId ?? el.id;
      copy.magicMoveId = null;
      copy.id = makeId(el.type);
      copy.x += 24;
      copy.y += 24;
      if (copy.type === 'shape' && copy.control) {
        copy.control.x += 24;
        copy.control.y += 24;
      }
      created.push(copy.id);
      slide.elements.push(copy);
    }
  });
  store.select(created);
}

/** Let Chromium copy selected chrome text instead of copying deck objects. */
export function hasNativeCopySelection(selection = window.getSelection()): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const common = selection.getRangeAt(0).commonAncestorContainer;
  const element = common.nodeType === Node.ELEMENT_NODE
    ? common as Element
    : common.parentElement;
  return element?.closest('[data-native-copy]') !== null;
}

export function bindEditorKeys(deps: ShellDeps, clipboard: ClipboardActions): void {
  const { store, canvas, rail, save } = deps;
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    const typing =
      t &&
      (t.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) ||
        t.closest('.cm-editor') !== null);
    // Also bail while a canvas text edit is live, so Delete edits the text
    // rather than deleting the element being typed into.
    if (typing || canvas.isEditing()) return;

    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) (deps.redo ?? (() => store.redo()))();
      else (deps.undo ?? (() => store.undo()))();
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
      return;
    }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateSelection(store);
      return;
    }
    if (mod && e.key.toLowerCase() === 'c') {
      if (hasNativeCopySelection()) return;
      e.preventDefault();
      void clipboard.copyToClipboard('Copied');
      return;
    }
    if (mod && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      void clipboard.cutToClipboard();
      return;
    }
    if (mod && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      void clipboard.pasteClipboard();
      return;
    }

    switch (e.key) {
      case 'Backspace':
      case 'Delete': {
        e.preventDefault();
        store.deleteSelection();
        break;
      }
      case 'Escape':
        store.clearSelection();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        // Shift for a coarse nudge; plain arrows for pixel-accurate placement.
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        store.updateSelected((el) => {
          el.x += dx;
          el.y += dy;
          if (el.type === 'shape' && el.control) {
            el.control.x += dx;
            el.control.y += dy;
          }
        });
        break;
      }
      case 'n':
        if (!mod) rail.addSlide();
        break;
    }
  });
}

type ContextItems = Array<{ label: string; action: () => void } | 'separator'>;

export function makeContextActions(
  deps: ShellDeps,
  clipboard: ClipboardActions,
): (el: SlideElement | null) => ContextItems {
  const { store, canvas, openTrim } = deps;
  return (el) => {
    const sel = store.get().selection.size;
    const items: ContextItems = [];
    if (el) {
      items.push(
        { label: 'Cut', action: () => void cutSelectionToClipboard(store) },
        { label: 'Copy', action: () => void copySelectionToClipboard(store) },
      );
    }
    items.push({ label: 'Paste', action: () => void clipboard.pasteClipboard() });
    if (el) {
      items.push(
        { label: 'Duplicate', action: () => duplicateSelection(store) },
        { label: 'Delete', action: () => store.deleteSelection() },
        'separator',
        {
          label: (el.comments?.length ?? 0) > 0 ? 'Comments…' : 'Add comment…',
          action: () => canvas.openElementComments(el.id),
        },
        { label: 'Bring to front', action: () => store.updateSelected((e) => (e.z += 1000)) },
        { label: 'Send to back', action: () => store.updateSelected((e) => (e.z -= 1000)) },
      );
      if (el.type === 'image' || el.type === 'video') {
        items.push('separator', {
          label: canvas.maskingElement() === el.id ? 'Done editing mask' : 'Edit mask (crop)',
          action: () => canvas.toggleMaskMode(el.id),
        });
      }
      if (el.type === 'image' || el.type === 'video') {
        items.push({
          label: el.maskShape === 'circle' ? 'Rectangular mask' : 'Circular mask',
          action: () => store.updateSelected((target) => {
            if (target.type === 'image' || target.type === 'video') {
              target.maskShape = target.maskShape === 'circle' ? undefined : 'circle';
            }
          }, { label: 'Mask shape' }),
        });
      }
      if (el.type === 'video') {
        items.push({
          label: canvas.isPlaying(el.id) ? 'Pause' : 'Play',
          action: () => void canvas.toggleVideo(el.id),
        });
        if (openTrim) {
          items.push({ label: 'Edit w/ ffmpeg…', action: () => openTrim(el) });
        }
      }
      if (el.type === 'text' && sel === 1) {
        items.unshift({ label: 'Edit text', action: () => canvas.beginTextEdit(el.id) }, 'separator');
      }
    }
    return items;
  };
}

export function barButton(label: string, onClick: () => void, variant = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (variant) b.className = variant;
  b.addEventListener('click', onClick);
  return b;
}

/** Bar button with a small leading SVG icon. */
export function barIconButton(label: string, iconSvg: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'bar-icon-button';
  b.innerHTML = `${iconSvg}<span>${label}</span>`;
  b.addEventListener('click', onClick);
  return b;
}

export const TEXT_ICON =
  '<svg class="bar-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M3 3.5V2.5h10v1M8 2.5v11M6 13.5h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
