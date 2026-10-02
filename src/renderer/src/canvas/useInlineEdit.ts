import { useEffect, useRef, useState, type RefObject } from 'react'
import { useOptionalPatchStore } from '../state/patchStore'

/**
 * Shared double-click-to-edit interaction for a node's title/text (ObjectNode's instance
 * name, CommentNode's text) -- just the editing-mode toggle, not a shared
 * input component, since each consumer renders a different input shape (single-line vs a
 * `<textarea>`). `commitEdit` always calls `onCommit`; the store action itself already
 * no-ops on an unchanged value (see `renameNode`/`setCommentText` in patchStore.ts), so this
 * hook doesn't need its own dirty-check.
 *
 * Also watches `pendingEditNodeId` (patchStore.ts) and self-starts editing (clearing the flag)
 * the instant it matches this node's own `nodeId` -- the mechanism behind every non-double-click
 * way to enter rename mode: the `C` canvas shortcut's freshly-placed comment, and the node
 * context menu's "edit instance name" item.
 *
 * `inputRef` must be attached to the consumer's `<input>`/`<textarea>` -- plain JSX `autoFocus`
 * alone isn't reliable here: both of these triggers fire a structural insert/edit that bumps
 * `reloadNonce`, remounting the whole PatchCanvasSession (a fresh React Flow instance), and
 * React Flow's own post-mount initialization can steal focus back before `autoFocus` "wins" the
 * race. Found live: a freshly-placed comment's editor rendered but was never actually focused,
 * so typed characters went nowhere. The deferred imperative `.focus()`/`.select()` below (after
 * a macrotask, giving React Flow's own init a chance to finish first) reliably wins instead.
 */
export function useInlineEdit(
  nodeId: string,
  onCommit: (next: string) => void
): {
  editing: boolean
  startEditing: () => void
  commitEdit: (value: string) => void
  cancelEdit: () => void
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>
} {
  const [editing, setEditing] = useState(false)
  // Optional (non-throwing): ObjectNode.tsx also renders this hook from a definition-only
  // preview with no PatchStoreContext.Provider above it at all (ObjectLivePreview.tsx) -- see its
  // doc comment. `pendingEditNodeId` reads as permanently null there, so a preview node can never
  // self-trigger rename mode, which is exactly the desired inert behavior.
  const pendingEditNodeId = useOptionalPatchStore((s) => s.pendingEditNodeId)
  const setPendingEditNodeId = useOptionalPatchStore((s) => s.setPendingEditNodeId)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  // Flipping `editing` during render (not in the effect below) is React's sanctioned way to
  // derive state from a changing input; only the store write, an external system, is an effect.
  const isPendingEdit = pendingEditNodeId === nodeId
  if (isPendingEdit && !editing) setEditing(true)

  useEffect(() => {
    if (isPendingEdit) setPendingEditNodeId(null)
  }, [isPendingEdit, setPendingEditNodeId])

  useEffect(() => {
    if (!editing) return
    const timer = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
    return () => clearTimeout(timer)
  }, [editing])

  return {
    editing,
    startEditing: () => setEditing(true),
    commitEdit: (value) => {
      setEditing(false)
      onCommit(value)
    },
    cancelEdit: () => setEditing(false),
    inputRef
  }
}
