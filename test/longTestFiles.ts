/**
 * Tests that still take at least ten seconds when run in isolation after the
 * August 2026 speed pass. Isolated time avoids quarantining useful coverage
 * merely because several CPU-heavy workers happened to overlap in a full run.
 */
export const LONG_TESTS = [
  {
    file: 'test/exportLooksLikeSlide.test.ts',
    observedSeconds: 17,
    scope: 'Rendered export fidelity across representative slides',
  },
  {
    file: 'test/collabFormattingUndoBrowser.test.ts',
    observedSeconds: 12,
    scope: 'Large browser formatting and undo omnibus',
  },
] as const;

export const LONG_TEST_FILES = LONG_TESTS.map(({ file }) => file);
