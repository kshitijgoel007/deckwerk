/**
 * Resource-exclusive integration tests.
 *
 * These are not necessarily slow in isolation, but they own a native Electron
 * app plus audience/collaboration windows and become timing-dependent when
 * several other Chromium suites compete with them in parallel.
 */
export const SERIAL_TEST_FILES = [
  'test/agentPresentationSync.test.ts',
  'test/clipboardImageBrowser.test.ts',
] as const;
