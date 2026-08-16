/** Pick a projector when available, otherwise present on the laptop display. */
export function chooseAudienceDisplay<T extends { id: number }>(
  displays: T[],
  primary: T,
): T {
  return displays.find((display) => display.id !== primary.id) ?? primary;
}
