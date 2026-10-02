import { useEffect } from 'react'
import { usePatchStoreApi } from './state/patchStore'
import PatchCanvas from './canvas/PatchCanvas'
import { useArrangeActions } from './canvas/useArrangeActions'
import { isTextFieldFocused } from './util/textFocus'

/**
 * The active patch tab's own content -- the canvas, plus its keyboard undo and Arrange menu. The always-visible
 * library/inspector/build panels live one level up now (see App.tsx), rendered unconditionally
 * via the `useOptional*` hooks (state/patchStore.ts) so they stay on screen regardless of which
 * tab (if any) is active -- this component keeps using the *strict* `usePatchStore` throughout,
 * since it's only ever mounted inside a real `PatchStoreContext.Provider` (App.tsx only renders
 * it when `activeTab?.kind === 'patch'`).
 */
function PatchWorkspace(): React.JSX.Element {
  const patchStoreApi = usePatchStoreApi()
  const arrange = useArrangeActions()

  // Subscribed per render so a menu click always reaches the current tab's document.
  useEffect(() => {
    const unsubscribers = [
      // Edit › Undo/Redo outside a text field (App.tsx handles the text-field half).
      window.axoloti.events.onMenuUndo(() => {
        if (!isTextFieldFocused()) patchStoreApi.getState().undo()
      }),
      window.axoloti.events.onMenuRedo(() => {
        if (!isTextFieldFocused()) patchStoreApi.getState().redo()
      }),
      window.axoloti.events.onMenuArrangeByFlow(arrange.byFlow),
      window.axoloti.events.onMenuSpreadOutNodes(arrange.spreadOut)
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  })

  // Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z, scoped to whichever patch tab is CURRENTLY active --
  // re-subscribes whenever `patchStoreApi` changes (i.e. on every tab switch), since
  // PatchWorkspace doesn't remount between two patch tabs and a stale closure over the first
  // tab's store would silently undo the wrong document. Skips entirely while a text field is
  // focused: unhandled, the keystroke goes on to the Edit menu, which undoes the field's text.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const cmdOrCtrl = e.metaKey || e.ctrlKey
      if (!cmdOrCtrl || e.key.toLowerCase() !== 'z') return
      // Left to the Edit menu, which gives a text field its own undo.
      if (isTextFieldFocused()) return
      e.preventDefault()
      if (e.shiftKey) patchStoreApi.getState().redo()
      else patchStoreApi.getState().undo()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [patchStoreApi])

  // Undo/redo/arrange live in the canvas's own control stack (PatchCanvas.tsx), and the file
  // name and unsaved dot are on the tab, so there's no toolbar strip above the canvas.
  return (
    <>
      <main className="app-canvas">
        <PatchCanvas />
      </main>
    </>
  )
}

export default PatchWorkspace
