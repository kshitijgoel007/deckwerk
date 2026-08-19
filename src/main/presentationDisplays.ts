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
