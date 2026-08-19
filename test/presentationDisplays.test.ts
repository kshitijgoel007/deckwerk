import { describe, expect, it } from 'vitest';
import {
  chooseAudienceDisplay,
  chooseDisplayById,
  shouldOpenSpeakerView,
  swappedPresentationDisplays,
} from '../src/main/presentationDisplays.js';

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

  it('uses a requested mapping only while that display is connected', () => {
    const laptop = { id: 1 };
    const projector = { id: 2 };
    expect(chooseDisplayById([laptop, projector], 2, laptop)).toBe(projector);
    expect(chooseDisplayById([laptop], 2, laptop)).toBe(laptop);
  });

  it('opens Speaker View automatically only when the audience has another display', () => {
    const laptop = { id: 1 };
    const projector = { id: 2 };
    expect(shouldOpenSpeakerView(projector, laptop)).toBe(true);
    expect(shouldOpenSpeakerView(laptop, laptop)).toBe(false);
    expect(shouldOpenSpeakerView(laptop, laptop, true)).toBe(true);
  });

  it('switches the audience and presenter roles while both displays remain connected', () => {
    const laptop = { id: 1, name: 'laptop' };
    const projector = { id: 2, name: 'projector' };
    expect(swappedPresentationDisplays(
      [laptop, projector],
      { audienceDisplayId: projector.id, presenterDisplayId: laptop.id },
      laptop,
    )).toEqual({ audience: laptop, presenter: projector });
    expect(swappedPresentationDisplays(
      [laptop],
      { audienceDisplayId: projector.id, presenterDisplayId: laptop.id },
      laptop,
    )).toBeNull();
  });
});
