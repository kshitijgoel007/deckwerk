import type { Api } from '../preload/index.js';

/** The preload bridge, as seen from renderer code. */
declare global {
  interface Window {
    api: Api;
  }
}

export {};
