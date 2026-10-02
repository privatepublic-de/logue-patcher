import { ChevronRight, Info, TriangleAlert } from 'lucide-react'

/**
 * One warning as a single line that expands to its explanation, so several of them don't push a
 * panel's controls down a screen (the Build panel, the Inspector's reference issues). `info` is
 * for something that resolves fine but is worth knowing (an old type id).
 */
function WarningLine({
  summary,
  tone = 'warning',
  children
}: {
  summary: string
  tone?: 'warning' | 'info'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <details className={'warning-line' + (tone === 'info' ? ' warning-line--info' : '')}>
      <summary className="warning-line__summary">
        {tone === 'info' ? (
          <Info size={12} className="warning-line__icon" />
        ) : (
          <TriangleAlert size={12} className="warning-line__icon" />
        )}
        <span className="warning-line__text">{summary}</span>
        <ChevronRight size={12} className="details-chevron" />
      </summary>
      <div className="warning-line__detail">{children}</div>
    </details>
  )
}

export default WarningLine
