export interface PanelResizeOptions {
  storageKey: string;
  /** Where the CSS size variables live. Defaults to the panel itself. */
  sizeTarget?: HTMLElement;
  width?: {
    property: string;
    initial: number;
    min: number;
    max: () => number;
    edge: 'left' | 'right';
  };
  height?: {
    property: string;
    initial: number;
    min: number;
    max: () => number;
    edge: 'top' | 'bottom';
  };
}

interface StoredPanelSize {
  width?: number;
  height?: number;
}

const RESIZE_STEP = 16;

/** Adds mouse/touch and keyboard resize handles to editor chrome. */
export function makePanelResizable(element: HTMLElement, options: PanelResizeOptions): () => void {
  const sizeTarget = options.sizeTarget ?? element;
  const stored = readStoredSize(options.storageKey);
  const width = options.width ? clamp(stored.width ?? options.width.initial, options.width.min, options.width.max()) : undefined;
  const height = options.height ? clamp(stored.height ?? options.height.initial, options.height.min, options.height.max()) : undefined;
  if (width !== undefined) sizeTarget.style.setProperty(options.width!.property, `${width}px`);
  if (height !== undefined) sizeTarget.style.setProperty(options.height!.property, `${height}px`);

  const handles: HTMLElement[] = [];
  if (options.width) handles.push(createHandle(element, options, options.width.edge));
  if (options.height) handles.push(createHandle(element, options, options.height.edge));
  if (options.width && options.height) {
    handles.push(createHandle(element, options, `${options.height.edge}-${options.width.edge}`));
  }

  const onWindowResize = () => constrain(element, options, false);
  window.addEventListener('resize', onWindowResize);
  return () => {
    window.removeEventListener('resize', onWindowResize);
    for (const handle of handles) handle.remove();
  };
}

type ResizeEdge = 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

function createHandle(element: HTMLElement, options: PanelResizeOptions, edge: ResizeEdge): HTMLElement {
  const sizeTarget = options.sizeTarget ?? element;
  const handle = document.createElement('div');
  handle.className = `panel-resize-handle panel-resize-${edge}`;
  handle.dataset.resizeEdge = edge;
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-label', resizeLabel(edge));
  handle.setAttribute('aria-orientation', edge === 'top' || edge === 'bottom' ? 'horizontal' : 'vertical');

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = currentSize(sizeTarget, options.width, 'width');
    const startHeight = currentSize(sizeTarget, options.height, 'height');
    handle.setPointerCapture?.(event.pointerId);
    document.body.classList.add('panel-resizing');

    const move = (moveEvent: PointerEvent) => {
      if (options.width && edge.includes(options.width.edge)) {
        const direction = options.width.edge === 'left' ? -1 : 1;
        setDimension(sizeTarget, options.width.property, startWidth + ((moveEvent.clientX - startX) * direction), options.width);
      }
      if (options.height && edge.includes(options.height.edge)) {
        const direction = options.height.edge === 'top' ? -1 : 1;
        setDimension(sizeTarget, options.height.property, startHeight + ((moveEvent.clientY - startY) * direction), options.height);
      }
    };
    const finish = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      document.body.classList.remove('panel-resizing');
      storeSize(sizeTarget, options);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  });

  handle.addEventListener('keydown', (event) => {
    const amount = event.shiftKey ? 4 : RESIZE_STEP;
    let changed = false;
    if (options.width && edge.includes(options.width.edge)) {
      const delta = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0;
      if (delta) {
        const direction = options.width.edge === 'left' ? -1 : 1;
        setDimension(sizeTarget, options.width.property, currentSize(sizeTarget, options.width, 'width') + (delta * direction), options.width);
        changed = true;
      }
    }
    if (options.height && edge.includes(options.height.edge)) {
      const delta = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0;
      if (delta) {
        const direction = options.height.edge === 'top' ? -1 : 1;
        setDimension(sizeTarget, options.height.property, currentSize(sizeTarget, options.height, 'height') + (delta * direction), options.height);
        changed = true;
      }
    }
    if (changed) {
      event.preventDefault();
      storeSize(sizeTarget, options);
    }
  });

  handle.addEventListener('dblclick', () => {
    if (options.width && edge.includes(options.width.edge)) {
      setDimension(sizeTarget, options.width.property, options.width.initial, options.width);
    }
    if (options.height && edge.includes(options.height.edge)) {
      setDimension(sizeTarget, options.height.property, options.height.initial, options.height);
    }
    storeSize(sizeTarget, options);
  });

  element.append(handle);
  return handle;
}

function constrain(element: HTMLElement, options: PanelResizeOptions, persist: boolean): void {
  const sizeTarget = options.sizeTarget ?? element;
  if (options.width) setDimension(sizeTarget, options.width.property, currentSize(sizeTarget, options.width, 'width'), options.width);
  if (options.height) setDimension(sizeTarget, options.height.property, currentSize(sizeTarget, options.height, 'height'), options.height);
  if (persist) storeSize(sizeTarget, options);
}

function setDimension(
  element: HTMLElement,
  property: string,
  value: number,
  bounds: { min: number; max: () => number },
): void {
  element.style.setProperty(property, `${Math.round(clamp(value, bounds.min, bounds.max()))}px`);
}

function currentSize(
  element: HTMLElement,
  dimension: { property: string; initial: number } | undefined,
  fallback: 'width' | 'height',
): number {
  if (!dimension) return 0;
  const authored = Number.parseFloat(element.style.getPropertyValue(dimension.property));
  if (Number.isFinite(authored)) return authored;
  return element.getBoundingClientRect()[fallback] || dimension.initial;
}

function storeSize(element: HTMLElement, options: PanelResizeOptions): void {
  const size: StoredPanelSize = {};
  if (options.width) size.width = currentSize(element, options.width, 'width');
  if (options.height) size.height = currentSize(element, options.height, 'height');
  try {
    window.localStorage.setItem(options.storageKey, JSON.stringify(size));
  } catch {
    // Resizing still works in privacy modes where local storage is unavailable.
  }
}

function readStoredSize(key: string): StoredPanelSize {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? '{}') as StoredPanelSize;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function resizeLabel(edge: ResizeEdge): string {
  if (edge.includes('-')) return 'Resize panel';
  return edge === 'left' || edge === 'right' ? 'Resize panel width' : 'Resize panel height';
}
