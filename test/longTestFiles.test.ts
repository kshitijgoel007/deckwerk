import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LONG_TEST_FILES, LONG_TESTS } from './longTestFiles.js';

describe('long-test quarantine manifest', () => {
  it('contains only unique, existing test files with a recorded slow runtime', () => {
    expect(new Set(LONG_TEST_FILES).size).toBe(LONG_TEST_FILES.length);

    for (const test of LONG_TESTS) {
      expect(test.observedSeconds).toBeGreaterThanOrEqual(10);
      expect(existsSync(resolve(process.cwd(), test.file)), test.file).toBe(true);
    }
  });
});
