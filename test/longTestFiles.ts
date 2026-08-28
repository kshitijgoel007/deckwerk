/**
 * Tests observed taking at least ten seconds in the August 2026 full-suite
 * run. Times are approximate wall-clock durations from that concurrent run;
 * they are recorded to make the quarantine concrete and reviewable.
 */
export const LONG_TESTS = [
  {
    file: 'test/pdfLooksLikePlayer.test.ts',
    observedSeconds: 160,
    scope: 'Electron PDF rasterization and whole-slide pixel comparison',
  },
  {
    file: 'test/exportLooksLikeSlide.test.ts',
    observedSeconds: 92,
    scope: 'Rendered export fidelity across representative slides',
  },
  {
    file: 'test/keynoteImport.test.ts',
    observedSeconds: 49,
    scope: 'Keynote importer process and fixture integration',
  },
  {
    file: 'test/collabServer.test.ts',
    observedSeconds: 40,
    scope: 'Collaboration server end-to-end scenarios',
  },
  {
    file: 'test/collabFormattingUndoBrowser.test.ts',
    observedSeconds: 23,
    scope: 'Large browser formatting and undo omnibus',
  },
  {
    file: 'test/collabPdfExportBrowser.test.ts',
    observedSeconds: 23,
    scope: 'Browser collaboration and PDF export integration',
  },
  {
    file: 'test/presentSlowNetwork.test.ts',
    observedSeconds: 18,
    scope: 'Presentation behavior under deliberately slow networking',
  },
  {
    file: 'test/bitterLessonExport.test.ts',
    observedSeconds: 18,
    scope: 'Full Bitter Lesson deck export regression',
  },
  {
    file: 'test/agentCli.test.ts',
    observedSeconds: 14,
    scope: 'Agent CLI process-level integration',
  },
  {
    file: 'test/operationFuzz.test.ts',
    observedSeconds: 13,
    scope: 'High-volume randomized editor operations',
  },
] as const;

export const LONG_TEST_FILES = LONG_TESTS.map(({ file }) => file);
