/** Pick a projector when available, otherwise present on the laptop display. */
export function chooseAudienceDisplay<T extends { id: number }>(
  displays: T[],
  primary: T,
): T {
  return displays.find((display) => display.id !== primary.id) ?? primary;
}

/** Use a remembered/user-selected display when it is still connected. */
export function chooseDisplayById<T extends { id: number }>(
  displays: T[],
  requestedId: number | undefined,
  fallback: T,
): T {
  return displays.find((display) => display.id === requestedId) ?? fallback;
}

/**
 * Speaker View is automatic when the audience has its own display. The
 * explicit menu action can still force it for a one-display rehearsal.
 */
export function shouldOpenSpeakerView(
  audience: { id: number },
  presenter: { id: number },
  forced = false,
): boolean {
  return forced || audience.id !== presenter.id;
}

/** Resolve the inverse of the active audience/presenter mapping. */
export function swappedPresentationDisplays<T extends { id: number }>(
  displays: T[],
  active: { audienceDisplayId: number; presenterDisplayId: number },
  fallback: T,
): { audience: T; presenter: T } | null {
  const audience = chooseDisplayById(displays, active.presenterDisplayId, fallback);
  const presenter = chooseDisplayById(displays, active.audienceDisplayId, fallback);
  return audience.id === presenter.id ? null : { audience, presenter };
}
