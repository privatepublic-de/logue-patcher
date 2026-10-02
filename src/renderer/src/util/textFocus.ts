/** Whether the keyboard is in a text field, where Undo/Redo mean the field's own text history. */
export function isTextFieldFocused(): boolean {
  const active = document.activeElement
  if (!active) return false
  if (active instanceof HTMLElement && active.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)
}
