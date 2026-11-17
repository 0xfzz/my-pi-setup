/**
 * Picker search keeps keyboard focus on pointer devices, where typing is the
 * fastest way to pick a row. On touch devices that focus opens the on-screen
 * keyboard immediately and hides the list the picker exists to show.
 */
export function shouldFocusPickerSearch(coarsePointer: boolean): boolean {
  return !coarsePointer;
}
