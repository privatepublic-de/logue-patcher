import { useState } from 'react'
import { FileText, Plus, Waves, X } from 'lucide-react'
import type { LogueEffectModule } from '@shared/domain/patch'
import { isEffectModule, MODULE_LABEL } from '@logue-codegen/unitKinds'
import { useTabsStore } from '../state/tabsStore'
import ContextMenu from '../canvas/ContextMenu'

interface TabBarProps {
  onCloseTab: (id: string) => void
  onNewLogueOsc: () => void
  onNewLogueEffect: (module: LogueEffectModule) => void
  onNewSubpatch: () => void
  /** The app's own controls (status, Settings, Help), right-aligned after the tabs. */
  children?: React.ReactNode
}

/** Shared with the start screen, so both say the same as File › New. */
export const NEW_EFFECT_LABEL: Record<LogueEffectModule, string> = {
  modfx: 'New Mod Effect',
  delfx: 'New Delay Effect',
  revfx: 'New Reverb Effect'
}

/** Reads tabsStore only -- never looks up a tab's real store instance, see tabsStore.ts's doc comment on why its metadata is kept mirrored for exactly this. */
function TabBar({
  onCloseTab,
  onNewLogueOsc,
  onNewLogueEffect,
  onNewSubpatch,
  children
}: TabBarProps): React.JSX.Element {
  const [newMenuAt, setNewMenuAt] = useState<{ x: number; y: number } | null>(null)
  const tabs = useTabsStore((s) => s.tabs)
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const setActiveTab = useTabsStore((s) => s.setActiveTab)

  return (
    <div className="tab-bar">
      {/* Only the tabs scroll, so the controls on the right stay put however many are open. */}
      <div className="tab-bar__tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab-bar__tab${tab.id === activeTabId ? ' tab-bar__tab--active' : ''}`}
            // The full path lives here now that the canvas has no toolbar showing it.
            data-tooltip={
              tab.filePath ? `${tab.filePath} -- ⌘-click to show in Finder` : 'Not saved yet'
            }
            onClick={(e) => {
              if (e.metaKey && tab.filePath) window.axoloti.system.showItemInFolder(tab.filePath)
              else setActiveTab(tab.id)
            }}
          >
            <span className="tab-bar__kind">
              {tab.module !== undefined && isEffectModule(tab.module) ? (
                <Waves size={13} aria-label={MODULE_LABEL[tab.module]} />
              ) : (
                <FileText size={13} />
              )}
            </span>
            <span className="tab-bar__title">
              {tab.title}
              {tab.dirty ? ' •' : ''}
            </span>
            <button
              className="tab-bar__close"
              onClick={(e) => {
                e.stopPropagation()
                onCloseTab(tab.id)
              }}
              data-tooltip={`Close ${tab.title}`}
              aria-label={`Close ${tab.title}`}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {/* One "+" with the same choices as File › New: three look-alike icon buttons were hard to
          tell apart. */}
        <button
          className="tab-bar__new"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setNewMenuAt({ x: rect.left, y: rect.bottom + 2 })
          }}
          data-tooltip="New oscillator, effect or subpatch"
          aria-label="New"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="tab-bar__trailing">{children}</div>
      {newMenuAt && (
        <ContextMenu
          screenPos={newMenuAt}
          items={[
            { label: 'New Oscillator', onClick: onNewLogueOsc },
            ...(Object.keys(NEW_EFFECT_LABEL) as LogueEffectModule[]).map((module) => ({
              label: NEW_EFFECT_LABEL[module],
              onClick: () => onNewLogueEffect(module)
            })),
            { label: 'New Subpatch', onClick: onNewSubpatch }
          ]}
          onClose={() => setNewMenuAt(null)}
        />
      )}
    </div>
  )
}

export default TabBar
