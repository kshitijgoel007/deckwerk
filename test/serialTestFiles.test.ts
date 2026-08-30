import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERIAL_TEST_FILES } from './serialTestFiles.js';

describe('serialized integration manifest', () => {
  it('contains only unique, existing test files', () => {
    expect(new Set(SERIAL_TEST_FILES).size).toBe(SERIAL_TEST_FILES.length);
    for (const file of SERIAL_TEST_FILES) {
      expect(existsSync(resolve(process.cwd(), file)), file).toBe(true);
    }
  });
});
