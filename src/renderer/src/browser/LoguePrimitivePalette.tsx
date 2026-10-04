import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Plus, X } from 'lucide-react'
import { useOptionalPatchStore } from '../state/patchStore'
import { findInsertPosition } from '../canvas/freeSpot'
import {
  COMMENT_ENTRY,
  colorForCategory,
  compareCategories,
  groupByCategory,
  matchesFilter,
  insertArgsFor,
  PALETTE_DRAG_TYPE
} from './loguePrimitiveCatalog'
import { useInsertableEntries } from './useInsertableEntries'

/**
 * The palette shown for a logue-target document (`doc.settings.logueTarget`) -- a small, hardcoded
 * list of `logue-codegen`'s own primitive registry, not a scanned object library (no such
 * library exists post-Axoloti-removal). Reuses `insertSpecialObject` (the same patchStore
 * action that places any explicit-`type` node with no library definition to resolve) rather
 * than inventing a new insertion action.
 */

function LoguePrimitivePalette(): React.JSX.Element {
  const insertSpecialObject = useOptionalPatchStore((s) => s.insertSpecialObject)
  const insertComment = useOptionalPatchStore((s) => s.insertComment)
  const [insertCount, setInsertCount] = useState(0)
  const [filterText, setFilterText] = useState('')
  // Every category starts collapsed -- a user opening a document with the full registry
  // otherwise faces a long scroll of every category expanded before ever touching anything.
  // Manual toggles land here; while `filterText` is non-empty this is bypassed entirely (see
  // `isOpen` below) so a search result is never hidden behind a category the user hasn't
  // opened yet.
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set())

  // Fallback only, for when no canvas is mounted to ask (findInsertPosition returns null): a
  // cascading grid so a freshly inserted node never lands stacked directly on top of the
  // previous one.
  const nextPosition = (): { x: number; y: number } => {
    const x = 60 + (insertCount % 5) * 160
    const y = 60 + Math.floor(insertCount / 5) * 110
    setInsertCount((c) => c + 1)
    return { x, y }
  }

  const dragProps = (id: string): React.ButtonHTMLAttributes<HTMLButtonElement> => ({
    // Dropped on the canvas it lands at the pointer instead of a free spot.
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(PALETTE_DRAG_TYPE, id)
      e.dataTransfer.effectAllowed = 'copy'
    }
  })

  const handleInsert = (id: string): void => {
    if (id === COMMENT_ENTRY.id) {
      const { x, y } = findInsertPosition(id) ?? nextPosition()
      insertComment(x, y)
      return
    }
    const { type, shortId, params, bus } = insertArgsFor(id)
    const { x, y } = findInsertPosition(type) ?? nextPosition()
    insertSpecialObject(type, shortId, x, y, params, bus)
  }

  const entries = useInsertableEntries(true)
  const groups = useMemo(() => groupByCategory(entries), [entries])
  const filterActive = filterText.trim() !== ''
  // Filtered down to categories with at least one matching item so an empty group never
  // renders while searching.
  const categories = [...groups.keys()]
    .filter((category) => groups.get(category)!.some((entry) => matchesFilter(entry, filterText)))
    .sort(compareCategories)
  const visibleEntries = (category: string): typeof entries =>
    groups.get(category)!.filter((entry) => matchesFilter(entry, filterText))
  // The comment's own group is the comment: one row that inserts it, with nothing to expand. Only
  // that one -- a category with a single primitive today (gain, a subpatch folder) can grow, so it
  // stays collapsible.
  const isSingle = (category: string): boolean => category === COMMENT_ENTRY.category
  const expandable = categories.filter((c) => !isSingle(c))
  const anyOpen = expandable.some((c) => openCategories.has(c))

  // ⌘F or `/` (outside a text field) jumps to the filter, like the canvas's Space popup does
  // for inserting at the pointer.
  const filterRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const active = document.activeElement
      const typing = !!active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)
      const find = e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f'
      if (!find && !(e.key === '/' && !typing && !e.metaKey && !e.ctrlKey)) return
      e.preventDefault()
      filterRef.current?.focus()
      filterRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="library-panel logue-primitive-palette">
      <div className="logue-primitive-palette__header">
        <span className="logue-primitive-palette__title">Primitives</span>
        {!filterActive && (
          <button
            type="button"
            className="logue-primitive-palette__header-button"
            onClick={() => setOpenCategories(anyOpen ? new Set() : new Set(expandable))}
            data-tooltip={anyOpen ? 'Collapse all categories' : 'Expand all categories'}
            aria-label={anyOpen ? 'Collapse all categories' : 'Expand all categories'}
          >
            {anyOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
          </button>
        )}
      </div>
      <div className="library-panel__filter-row">
        <input
          ref={filterRef}
          type="text"
          className="library-panel__path-input"
          placeholder="Filter (⌘F)"
          data-tooltip="Enter inserts the first match, Esc clears"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setFilterText('')
              e.currentTarget.blur()
            } else if (e.key === 'Enter' && filterActive) {
              const first = categories.length > 0 ? visibleEntries(categories[0])[0] : undefined
              if (first) handleInsert(first.id)
            }
          }}
        />
        {filterActive && (
          <button
            type="button"
            className="logue-primitive-palette__clear"
            onClick={() => {
              setFilterText('')
              filterRef.current?.focus()
            }}
            aria-label="Clear filter"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {categories.map((category) => {
        if (isSingle(category)) {
          const entry = groups.get(category)![0]
          return (
            <button
              key={category}
              type="button"
              className="logue-primitive-palette__single"
              onClick={() => handleInsert(entry.id)}
              {...dragProps(entry.id)}
              data-tooltip={entry.description || `Insert ${entry.label}`}
              data-tooltip-side="right"
            >
              <Plus size={12} className="logue-primitive-palette__single-icon" />
              <span
                className="logue-category-dot"
                style={{ backgroundColor: colorForCategory(category) }}
              />
              <span>{category}</span>
              <span className="logue-primitive-palette__single-entry">{entry.label}</span>
            </button>
          )
        }
        const isOpen = filterActive || openCategories.has(category)
        return (
          <details
            key={category}
            className="logue-primitive-palette__group"
            open={isOpen}
            onToggle={(e) => {
              if (filterActive) return
              const nowOpen = e.currentTarget.open
              setOpenCategories((prev) => {
                const next = new Set(prev)
                if (nowOpen) next.add(category)
                else next.delete(category)
                return next
              })
            }}
          >
            <summary className="library-panel__section-title">
              <ChevronRight size={12} className="details-chevron" />
              <span
                className="logue-category-dot"
                style={{ backgroundColor: colorForCategory(category) }}
              />
              <span>{category}</span>
              <span className="logue-primitive-palette__count">
                {visibleEntries(category).length}
              </span>
            </summary>
            <ul className="logue-primitive-palette__list">
              {visibleEntries(category).map((entry) => (
                <li key={entry.id}>
                  <button
                    className="logue-primitive-palette__item"
                    onClick={() => handleInsert(entry.id)}
                    {...dragProps(entry.id)}
                    data-tooltip={entry.description || `Insert ${entry.label}`}
                    data-tooltip-side="right"
                  >
                    {entry.label}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )
      })}
    </div>
  )
}

export default LoguePrimitivePalette
