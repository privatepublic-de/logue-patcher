import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { clampToViewport } from '../util/viewportClamp'
import {
  colorForCategory,
  compareCategories,
  groupByCategory,
  matchesFilter
} from '../browser/loguePrimitiveCatalog'
import { useInsertableEntries } from '../browser/useInsertableEntries'

interface ObjectInsertPopupProps {
  screenPos: { x: number; y: number }
  onInsert: (id: string) => void
  onClose: () => void
  /**
   * Ids to hide from the candidate list -- used by the canvas node context menu's "Replace
   * with..." item (`PatchCanvas.tsx`) to exclude the node's own current type (replacing a
   * primitive with itself is a no-op `patchStore.ts`'s `replaceNode` already refuses). The fixed
   * `logue/io/audio-out` sink never needs excluding explicitly any more -- `listInsertablePrimitives`
   * itself no longer includes it at all (see that function's own doc comment). Omitted entirely
   * for the plain double-click insert flow, which has no "current type" to exclude.
   */
  excludeIds?: string[]
  /** Also offer `COMMENT_ENTRY` -- the plain insert flow only; a node can't be replaced BY a
   *  comment. */
  includeComment?: boolean
}

/**
 * The in-place object browser opened by double-clicking empty canvas (PatchCanvas.tsx's
 * `handlePaneDoubleClick`) -- lets an object be picked and dropped at exactly the double-click
 * position, without a trip over to the sidebar palette. Same primitive catalog/filter logic as
 * `LoguePrimitivePalette.tsx` (`loguePrimitiveCatalog.ts`), but a flat, always-expanded list
 * (a floating popup has no room for the sidebar's own collapsible category tree, and a quick
 * filter-then-pick flow doesn't need one) rather than the sidebar's collapsed-by-default tree.
 * Reused as-is (via `excludeIds`) by the node context menu's "Replace with..." item -- picking
 * an id calls back through `onInsert` either way, since both flows are ultimately "the user
 * picked one primitive id from this catalog."
 */
function ObjectInsertPopup({
  screenPos,
  onInsert,
  onClose,
  excludeIds,
  includeComment
}: ObjectInsertPopupProps): React.JSX.Element {
  const [filterText, setFilterText] = useState('')
  // Index into `filteredIds` of the row ↑/↓ have moved to; Enter inserts it. Reset to the first
  // match whenever the filter changes.
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  // The row under the mouse, if any -- takes precedence over the keyboard highlight for the
  // description column, so pointing at a row previews it without moving the highlight.
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [pos, setPos] = useState(screenPos)
  const popupRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const all = useInsertableEntries(includeComment ?? false)
  const entries = useMemo(
    () =>
      excludeIds && excludeIds.length > 0
        ? all.filter((entry) => !excludeIds.includes(entry.id))
        : all,
    [all, excludeIds]
  )
  const groups = useMemo(() => groupByCategory(entries), [entries])
  const categories = useMemo(
    () =>
      [...groups.keys()]
        .filter((category) =>
          groups.get(category)!.some((entry) => matchesFilter(entry, filterText))
        )
        .sort(compareCategories),
    [groups, filterText]
  )
  const filteredIds = useMemo(
    () =>
      categories.flatMap((category) =>
        groups
          .get(category)!
          .filter((entry) => matchesFilter(entry, filterText))
          .map((entry) => entry.id)
      ),
    [categories, groups, filterText]
  )

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Only on a highlight move (or a new filter), never on every render, so it doesn't fight a
  // mouse-wheel scroll. 'nearest' scrolls just enough to reveal the row, and not at all while
  // it's already visible.
  useLayoutEffect(() => {
    listRef.current
      ?.querySelector('.object-insert-popup__item--active')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, filterText])

  // Same viewport-clamp treatment as ContextMenu.tsx's own popup -- runs after every commit
  // since the popup's height changes with the filtered result count.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = popupRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const clamped = clampToViewport(screenPos.x, screenPos.y, rect.width, rect.height)
    setPos((prev) => (prev.x === clamped.x && prev.y === clamped.y ? prev : clamped))
  })

  useEffect(() => {
    function handlePointerDown(e: PointerEvent): void {
      const target = e.target as HTMLElement
      if (!target.closest('.object-insert-popup')) onClose()
    }
    window.addEventListener('pointerdown', handlePointerDown, true)
    return () => window.removeEventListener('pointerdown', handlePointerDown, true)
  }, [onClose])

  const insertAndClose = (id: string): void => {
    onInsert(id)
    onClose()
  }

  const previewId = hoveredId ?? filteredIds[Math.min(activeIndex, filteredIds.length - 1)]
  const previewEntry = entries.find((entry) => entry.id === previewId)

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (filteredIds.length === 0) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((i) => Math.min(filteredIds.length - 1, Math.max(0, i + delta)))
    } else if (e.key === 'Enter' && filteredIds.length > 0) {
      e.preventDefault()
      insertAndClose(filteredIds[Math.min(activeIndex, filteredIds.length - 1)])
    }
  }

  return (
    <div
      ref={popupRef}
      className="object-insert-popup nodrag nopan"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <input
        ref={inputRef}
        type="text"
        className="object-insert-popup__input"
        placeholder="Filter by name or category…"
        value={filterText}
        onChange={(e) => {
          setFilterText(e.target.value)
          setActiveIndex(0)
        }}
        onKeyDown={handleKeyDown}
      />
      <div className="object-insert-popup__body">
        <ul
          ref={listRef}
          className="object-insert-popup__list"
          onMouseLeave={() => setHoveredId(null)}
        >
          {categories.map((category) => (
            <li key={category} className="object-insert-popup__category">
              <div className="object-insert-popup__category-title">
                <span
                  className="logue-category-dot"
                  style={{ backgroundColor: colorForCategory(category) }}
                />
                <span>{category}</span>
              </div>
              <ul className="object-insert-popup__category-items">
                {groups
                  .get(category)!
                  .filter((entry) => matchesFilter(entry, filterText))
                  .map((entry) => (
                    <li key={entry.id}>
                      <button
                        className={
                          'object-insert-popup__item' +
                          (entry.id === filteredIds[activeIndex]
                            ? ' object-insert-popup__item--active'
                            : '')
                        }
                        onClick={() => insertAndClose(entry.id)}
                        onMouseEnter={() => setHoveredId(entry.id)}
                      >
                        {entry.label}
                      </button>
                    </li>
                  ))}
              </ul>
            </li>
          ))}
          {filteredIds.length === 0 && (
            <li className="object-insert-popup__empty">No matching objects</li>
          )}
        </ul>
        <p className="object-insert-popup__description">{previewEntry?.description}</p>
      </div>
    </div>
  )
}

export default ObjectInsertPopup
