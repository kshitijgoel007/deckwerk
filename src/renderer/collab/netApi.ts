import type { ImportedAsset, MediaInfo } from '@shared/ipc.js';

/**
 * The browser collab client's stand-in for the Electron preload bridge.
 *
 * Only the surface the reused editor components actually touch is real:
 * assets resolve to the collab server's deck-scoped HTTP routes, drops upload
 * bytes, and theme saves go to the WebSocket (injected by the shell).
 * Everything else on the full Api type is desktop-only and intentionally
 * absent — the collab shell never calls it, and shared code paths feature-test
 * with optional chaining.
 */
export interface NetApiOptions {
  deckId: string;
  saveTheme: (css: string) => void;
}

export function installNetApi(options: NetApiOptions): void {
  const deck = encodeURIComponent(options.deckId);
  const api = {
    assetUrl: (src: string): string =>
      `/decks/${deck}/${src.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`,

    importAssetFiles: async (files: File[]): Promise<ImportedAsset[]> => {
      const imported: ImportedAsset[] = [];
      for (const file of files) {
        const response = await fetch(
          `/api/upload?deck=${deck}&name=${encodeURIComponent(file.name)}`,
          { method: 'POST', body: file },
        );
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `upload failed (${response.status})`);
        }
        imported.push(await response.json() as ImportedAsset);
      }
      return imported;
    },

    // The drop handler prefers importAssetFiles; these exist so shared code
    // that feature-tests them degrades quietly.
    importAssets: async (): Promise<ImportedAsset[]> => [],
    pathForFile: (): string => '',

    probeAsset: async (src: string): Promise<MediaInfo> => {
      const response = await fetch(`/api/probe?deck=${deck}&src=${encodeURIComponent(src)}`);
      if (!response.ok) return { width: null, height: null, duration: null };
      return response.json() as Promise<MediaInfo>;
    },

    loadTheme: async (): Promise<string> => {
      const response = await fetch(`/api/theme?deck=${deck}`);
      return response.ok ? response.text() : '';
    },
    saveTheme: async (css: string): Promise<void> => {
      options.saveTheme(css);
    },

    // Persistence belongs to the server; edits reach it as transactions.
    saveDeck: async (): Promise<void> => {},
  };

  (window as unknown as { api: typeof api }).api = api;
}
