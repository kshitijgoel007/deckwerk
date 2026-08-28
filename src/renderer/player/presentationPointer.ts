/**
 * A click produced after dragging across text must belong to the browser's
 * native selection gesture, not to presentation navigation.
 */
export function selectionPreventsAdvance(selection: Selection | null = window.getSelection()): boolean {
  return selection !== null && selection.rangeCount > 0 && !selection.isCollapsed;
}
