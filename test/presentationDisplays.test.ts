import { describe, expect, it } from 'vitest';
import { chooseAudienceDisplay } from '../src/main/presentationDisplays.js';

describe('presenter display placement', () => {
  it('uses an external display for the audience', () => {
    const laptop = { id: 1, name: 'laptop' };
    const projector = { id: 2, name: 'projector' };
    expect(chooseAudienceDisplay([laptop, projector], laptop)).toBe(projector);
  });

  it('falls back to the laptop when it is the only display', () => {
    const laptop = { id: 1 };
    expect(chooseAudienceDisplay([laptop], laptop)).toBe(laptop);
  });
});
