import type { RefObject } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { CommentFlowNode } from '../state/toFlowGraph'
import { usePatchStore } from '../state/patchStore'
import { useInlineEdit } from './useInlineEdit'

function CommentNode({ id, data, selected }: NodeProps<CommentFlowNode>): React.JSX.Element {
  const { node } = data
  const text = node.text
  const setCommentText = usePatchStore((s) => s.setCommentText)
  const { editing, startEditing, commitEdit, cancelEdit, inputRef } = useInlineEdit(id, (next) =>
    setCommentText(id, next)
  )

  return (
    <div
      className={`comment-node${selected ? ' comment-node--selected' : ''}`}
      onDoubleClick={(e) => {
        e.stopPropagation()
        startEditing()
      }}
    >
      {editing ? (
        <textarea
          ref={inputRef as RefObject<HTMLTextAreaElement>}
          className="comment-node__textarea nodrag nopan"
          autoFocus
          defaultValue={text}
          onBlur={(e) => commitEdit(e.target.value)}
          onKeyDown={(e) => {
            // Plain Enter commits (matching every other single-line-feeling input in this
            // app); Shift+Enter keeps default textarea behavior for an actual line break.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              cancelEdit()
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        text
      )}
    </div>
  )
}

export default CommentNode
