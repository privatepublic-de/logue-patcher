import { useEffect, useState } from 'react'
import { CircleHelp, Settings } from 'lucide-react'
import { useTabsStore } from './state/tabsStore'
import type { LogueEffectModule } from '@shared/domain/patch'
import { MODULE_LABEL } from '@logue-codegen/unitKinds'
import { openPatchTab, closeTab, getPatchStoreApi } from './state/tabRegistry'
import { PatchStoreContext, useOptionalPatchStore } from './state/patchStore'
import { newSubpatchDocument } from './state/patchDocHelpers'
import { refreshSubpatchLibrary } from './state/refreshSubpatchLibrary'
import TabBar from './tabs/TabBar'
import PatchWorkspace from './PatchWorkspace'
import LoguePrimitivePalette from './browser/LoguePrimitivePalette'
import Inspector from './canvas/Inspector'
import ParamMatrixOverlay from './canvas/ParamMatrixOverlay'
import BuildPanel from './build/BuildPanel'
import HelpModal from './HelpModal'
import AboutModal from './AboutModal'
import SettingsModal from './SettingsModal'
import GlobalTooltip from './GlobalTooltip'
import { useSidebarResize } from './useSidebarResize'
import { basenamePath } from './util/paths'
import { isTextFieldFocused } from './util/textFocus'
import StartScreen from './StartScreen'

const STATUS_FADE_MS = 4000

const LEFT_SIDEBAR_DEFAULT_WIDTH = 240
const RIGHT_SIDEBAR_DEFAULT_WIDTH = 260
const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 520

/**
 * Deliberately a separate component rendered INSIDE `<PatchStoreContext.Provider>` (see `body`
 * below), not read directly in `App()` itself: `App` is the component that CREATES that
 * Provider further down its own render, so a hook call in `App`'s own body sees only the
 * ambient (non-existent) outer context, never the value the Provider it's about to render will
 * carry -- context only flows to descendants, never back up to the component establishing it.
 * `useOptionalPatchStore` falls back to the permanently-empty store whenever no patch tab is
 * active. The palette only has real content for a logue-target document -- a document with no
 * `logueTarget` (no active tab, or a hand-edited/foreign file missing one) gets no palette at
 * all rather than a broken one.
 */
function LeftSidebarContent(): React.JSX.Element {
  const logueTarget = useOptionalPatchStore((s) => s.rootDoc?.settings.logueTarget)
  return <>{logueTarget && <LoguePrimitivePalette />}</>
}

/**
 * The app shell: owns the tab strip and which tab is active, and provides that tab's own
 * store instance to whichever workspace it mounts (see state/tabRegistry.ts and
 * patchStore.ts's Context export). Everything document-specific -- canvas, inspector, build
 * panel -- lives inside PatchWorkspace, reached through Context, not here.
 */
function App(): React.JSX.Element {
  const [status, setStatus] = useState('')
  const statusIsError = status.startsWith("Couldn't")
  // A success ("Opened x", "Saved x") is a passing confirmation; an error stays until the next
  // action replaces it.
  useEffect(() => {
    if (!status || statusIsError) return
    const timer = setTimeout(() => setStatus(''), STATUS_FADE_MS)
    return () => clearTimeout(timer)
  }, [status, statusIsError])
  const [showHelp, setShowHelp] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [persistedSidebarWidths, setPersistedSidebarWidths] = useState<
    { left: number; right: number } | undefined
  >(undefined)

  useEffect(() => {
    window.axoloti.settings.getSidebarWidths().then(setPersistedSidebarWidths)
  }, [])

  const persistSidebarWidths = (left: number, right: number): void => {
    void window.axoloti.settings.setSidebarWidths({ left, right })
  }

  const leftSidebar = useSidebarResize({
    persistedWidth: persistedSidebarWidths?.left,
    defaultWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
    side: 'left',
    onCommit: (width) => persistSidebarWidths(width, rightSidebar.width)
  })
  const rightSidebar = useSidebarResize({
    persistedWidth: persistedSidebarWidths?.right,
    defaultWidth: RIGHT_SIDEBAR_DEFAULT_WIDTH,
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
    side: 'right',
    onCommit: (width) => persistSidebarWidths(leftSidebar.width, width)
  })

  const tabs = useTabsStore((s) => s.tabs)
  const activeTabId = useTabsStore((s) => s.activeTabId)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  const handleCloseTab = (id: string): void => {
    const tab = useTabsStore.getState().tabs.find((t) => t.id === id)
    if (tab?.dirty && !window.confirm(`Discard unsaved changes to "${tab.title}"?`)) return
    closeTab(id)
  }

  const handleNewSubpatch = (): void => {
    openPatchTab({ doc: newSubpatchDocument(), filePath: null })
  }

  const handleNewLogueOsc = (): void => {
    openPatchTab(undefined, { module: 'osc' })
    setStatus('New oscillator')
  }

  const handleNewLogueEffect = (module: LogueEffectModule): void => {
    openPatchTab(undefined, { module })
    setStatus(`New ${MODULE_LABEL[module].toLowerCase()}`)
  }

  const handleOpen = async (): Promise<void> => {
    try {
      const result = await window.axoloti.patchFile.openDialog()
      if (!result) return
      openPatchTab({ doc: result.doc, filePath: result.filePath })
      setStatus(`Opened ${basenamePath(result.filePath)}`)
    } catch (err) {
      setStatus(`Couldn't open: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleOpenRecentFile = async (recentPath: string): Promise<void> => {
    try {
      const result = await window.axoloti.patchFile.openPath(recentPath)
      openPatchTab({ doc: result.doc, filePath: result.filePath })
      setStatus(`Opened ${basenamePath(result.filePath)}`)
    } catch (err) {
      setStatus(`Couldn't open: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Saves one tab (a Save As dialog when untitled or `saveAs`); true only once it's really on disk. */
  const saveTab = async (id: string, saveAs = false): Promise<boolean> => {
    const api = getPatchStoreApi(id)
    if (!api) return false
    const { rootDoc, filePath, markSaved } = api.getState()
    if (!rootDoc) return false
    try {
      if (filePath && !saveAs) {
        await window.axoloti.patchFile.save(filePath, rootDoc)
        markSaved(rootDoc)
        setStatus(`Saved ${basenamePath(filePath)}`)
      } else {
        const savedPath = await window.axoloti.patchFile.saveDialog(rootDoc, filePath ?? undefined)
        if (!savedPath) return false
        markSaved(rootDoc, savedPath)
        setStatus(`Saved ${basenamePath(savedPath)}`)
      }
      return true
    } catch (err) {
      setStatus(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  const activePatchTabId = (): string | null => {
    const { tabs, activeTabId } = useTabsStore.getState()
    const tab = tabs.find((t) => t.id === activeTabId)
    return tab?.kind === 'patch' ? tab.id : null
  }

  const handleSave = async (): Promise<void> => {
    const id = activePatchTabId()
    if (id) await saveTab(id)
  }

  const handleSaveAs = async (): Promise<void> => {
    const id = activePatchTabId()
    if (id) await saveTab(id, true)
  }

  // Stops at the first cancelled/failed save so the window stays open with that tab in front.
  const handleSaveAllAndClose = async (): Promise<void> => {
    for (const tab of useTabsStore.getState().tabs.filter((t) => t.dirty)) {
      if (!tab.filePath) useTabsStore.getState().setActiveTab(tab.id)
      if (!(await saveTab(tab.id))) {
        useTabsStore.getState().setActiveTab(tab.id)
        return
      }
    }
    await window.axoloti.system.closeWindowAfterSave()
  }

  const unsavedTitles = tabs
    .filter((t) => t.dirty)
    .map((t) => t.title)
    .join('\n')
  useEffect(() => {
    void window.axoloti.system.setUnsavedDocuments(unsavedTitles ? unsavedTitles.split('\n') : [])
  }, [unsavedTitles])

  // File menu (main/index.ts) has no access to renderer state, so its clicks arrive as IPC
  // events. Registered once -- each handler reads whatever's currently active fresh off
  // useTabsStore.getState() rather than closing over reactive props, so this effect never
  // needs to re-subscribe.
  useEffect(() => {
    const unsubscribers = [
      window.axoloti.events.onMenuNewLogueOsc(handleNewLogueOsc),
      window.axoloti.events.onMenuNewLogueEffect(handleNewLogueEffect),
      window.axoloti.events.onMenuNewSubpatch(handleNewSubpatch),
      window.axoloti.events.onSubpatchLibraryChanged(() => void refreshSubpatchLibrary()),
      // A tab switch or a Save As into another folder changes which local subpatches apply.
      useTabsStore.subscribe((state, prev) => {
        const path = (st: typeof state): string | null =>
          st.tabs.find((t) => t.id === st.activeTabId)?.filePath ?? null
        if (path(state) !== path(prev)) void refreshSubpatchLibrary()
      }),
      window.axoloti.events.onMenuOpenPatch(handleOpen),
      window.axoloti.events.onMenuSavePatch(handleSave),
      window.axoloti.events.onMenuSavePatchAs(handleSaveAs),
      window.axoloti.events.onSaveAllAndClose(handleSaveAllAndClose),
      window.axoloti.events.onMenuOpenRecentFile(handleOpenRecentFile),
      window.axoloti.events.onMenuOpenAbout(() => setShowAbout(true)),
      window.axoloti.events.onMenuOpenSettings(() => setShowSettings(true)),
      window.axoloti.events.onMenuOpenHelp(() => setShowHelp(true)),
      // A text field's own undo, from the Edit menu (its ⌘Z included, see main/index.ts); the
      // patch's undo is PatchWorkspace.tsx's half of the same event.
      window.axoloti.events.onMenuUndo(() => {
        if (isTextFieldFocused()) document.execCommand('undo')
      }),
      window.axoloti.events.onMenuRedo(() => {
        if (isTextFieldFocused()) document.execCommand('redo')
      })
    ]
    void refreshSubpatchLibrary()
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registered once on purpose (see above)
  }, [])

  // The palette (left) and inspector+build (right) panels are always visible,
  // regardless of tab state -- see state/patchStore.ts's useOptional* hooks, which is what lets
  // Inspector/BuildPanel render (inert) even with no patch tab active. This Provider is what
  // makes them resolve to the REAL active document when one exists; when it doesn't, it's
  // simply omitted and those hooks fall back on their own.
  const body = (
    // With no tab, the start screen gets the whole width: the sidebars are hidden, not
    // unmounted, since BuildPanel also owns the Device menu's backup/restore dialogs.
    <div className={'app-body' + (activeTab ? '' : ' app-body--start')}>
      <aside className="app-sidebar-left" style={{ width: leftSidebar.width }}>
        <LeftSidebarContent />
      </aside>
      <div
        className={`app-resize-handle${leftSidebar.dragging ? ' app-resize-handle--dragging' : ''}`}
        onPointerDown={leftSidebar.onPointerDown}
      />
      <main className="app-main">
        {activeTab ? (
          <PatchWorkspace />
        ) : (
          <StartScreen
            onNewOsc={handleNewLogueOsc}
            onNewEffect={handleNewLogueEffect}
            onNewSubpatch={handleNewSubpatch}
            onOpen={() => void handleOpen()}
            onOpenRecent={(path) => void handleOpenRecentFile(path)}
          />
        )}
      </main>
      <div
        className={`app-resize-handle${rightSidebar.dragging ? ' app-resize-handle--dragging' : ''}`}
        onPointerDown={rightSidebar.onPointerDown}
      />
      {/* Properties on the right, like most editors: the palette gets the left column's full
          height, and Build sits pinned under the Inspector so its button never moves with the
          selection. */}
      <aside className="app-sidebar-right" style={{ width: rightSidebar.width }}>
        <Inspector />
        <BuildPanel
          key={activeTab ? activeTab.id : 'none'}
          onOpenSettings={() => setShowSettings(true)}
        />
      </aside>
      <ParamMatrixOverlay />
    </div>
  )

  return (
    <div className="app-shell">
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {/* One row for tabs and the app's own controls: the window title already names the app,
          and Settings/Help are in the menus too, so a header row of its own only cost canvas
          height. */}
      <TabBar
        onCloseTab={handleCloseTab}
        onNewLogueOsc={handleNewLogueOsc}
        onNewLogueEffect={handleNewLogueEffect}
        onNewSubpatch={handleNewSubpatch}
      >
        <span
          className={`app-status${status ? ` app-status--${statusIsError ? 'error' : 'success'}` : ''}`}
        >
          {status}
        </span>
        <button
          className="tab-bar__icon-button"
          data-tooltip="Settings (⌘,)"
          aria-label="Settings"
          onClick={() => setShowSettings(true)}
        >
          <Settings size={15} />
        </button>
        <button
          className="tab-bar__icon-button"
          data-tooltip="Help (⌘?)"
          aria-label="Help"
          onClick={() => setShowHelp(true)}
        >
          <CircleHelp size={15} />
        </button>
      </TabBar>
      {activeTab ? (
        <PatchStoreContext.Provider
          value={{ tabId: activeTab.id, api: getPatchStoreApi(activeTab.id)! }}
        >
          {body}
        </PatchStoreContext.Provider>
      ) : (
        body
      )}
      <GlobalTooltip />
    </div>
  )
}

export default App
