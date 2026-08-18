import type { AssetImportProgress } from '@shared/ipc.js';

/**
 * Client-local state of in-flight media imports.
 *
 * The placeholder *element* lives in the deck and syncs to everyone; what's
 * here is only what this client knows beyond that — live progress and a
 * locally captured preview frame. Peers render the same placeholder with an
 * indeterminate ring, which is all they can know.
 *
 * State is applied by mutating the rendered placeholder DOM directly, and
 * re-applied after every canvas rebuild (a drag or a peer edit replaces the
 * nodes and would otherwise reset the HUD).
 */

interface PendingState {
  phase: 'upload' | 'processing' | 'failed';
  ratio: number | null;
  preview: string | null;
}

const states = new Map<string, PendingState>();

export function setPendingPreview(token: string, preview: string | null): void {
  const s = states.get(token) ?? { phase: 'upload' as const, ratio: null, preview: null };
  states.set(token, { ...s, preview });
}

export function setPendingProgress(p: AssetImportProgress): void {
  const s = states.get(p.token);
  if (s?.phase === 'failed') return;
  states.set(p.token, { phase: p.phase, ratio: p.ratio, preview: s?.preview ?? null });
}

export function markPendingFailed(token: string): void {
  const s = states.get(token);
  states.set(token, { phase: 'failed', ratio: null, preview: s?.preview ?? null });
}

export function clearPending(token: string): void {
  states.delete(token);
}

/** Re-apply progress and previews to every placeholder under `root`. */
export function applyPendingHud(root: ParentNode): void {
  for (const box of root.querySelectorAll<HTMLElement>('.pending-asset[data-pending-token]')) {
    const state = states.get(box.dataset.pendingToken ?? '');
    if (!state) continue;

    const preview = box.querySelector<HTMLElement>('.pending-asset-preview');
    if (preview && state.preview) preview.style.backgroundImage = `url("${state.preview}")`;

    const ring = box.querySelector<HTMLElement>('.pending-asset-ring');
    const status = box.querySelector<HTMLElement>('.pending-asset-status');
    box.classList.toggle('upload-failed', state.phase === 'failed');
    if (state.phase === 'failed') {
      if (status) status.textContent = 'Upload failed';
      continue;
    }
    if (ring) {
      ring.classList.toggle('indeterminate', state.ratio === null);
      if (state.ratio !== null) ring.style.setProperty('--pending-ratio', String(state.ratio));
    }
    if (status) {
      const pct = state.ratio === null ? '' : ` ${Math.round(state.ratio * 100)}%`;
      status.textContent =
        state.phase === 'upload' ? `Uploading${pct}…` : `Processing${pct}…`;
    }
  }
}

/**
 * Natural size and a downscaled preview frame, read from the dropped File
 * itself before any bytes leave the machine. Images decode directly; videos
 * yield their first frame via a throwaway <video>. PDFs decode as neither, so
 * they fall through to nulls and the caller's fallback box.
 */
export async function probeLocalFile(
  file: File,
  kind: 'image' | 'video',
): Promise<{ width: number | null; height: number | null; preview: string | null }> {
  const url = URL.createObjectURL(file);
  try {
    if (kind === 'image') {
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('undecodable image'));
        img.src = url;
      });
      return {
        width: img.naturalWidth || null,
        height: img.naturalHeight || null,
        preview: thumbnail(img, img.naturalWidth, img.naturalHeight),
      };
    }
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    await new Promise<void>((res, rej) => {
      video.onloadeddata = () => res();
      video.onerror = () => rej(new Error('undecodable video'));
      video.src = url;
    });
    return {
      width: video.videoWidth || null,
      height: video.videoHeight || null,
      preview: thumbnail(video, video.videoWidth, video.videoHeight),
    };
  } catch {
    return { width: null, height: null, preview: null };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function thumbnail(
  source: CanvasImageSource,
  w: number,
  h: number,
): string | null {
  if (!w || !h) return null;
  const scale = Math.min(1, 640 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    // SVG without intrinsic size, or a codec the canvas can't rasterise.
    return null;
  }
}
