import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, Hammer, SquareArrowRightEnter } from 'lucide-react'
import { useTargetPlatformStore } from '../state/targetPlatformStore'
import type { ArmToolchainInfo } from '@shared/ipc/contract'
import type { LogueEffectModule, PatchDocument } from '@shared/domain/patch'

const EFFECT_MODULES: readonly LogueEffectModule[] = ['modfx', 'delfx', 'revfx']
const EFFECT_PILL: Record<LogueEffectModule, string> = {
  modfx: 'Mod',
  delfx: 'Delay',
  revfx: 'Reverb'
}
const EFFECT_SLOT: Record<LogueEffectModule, string> = {
  modfx: 'MOD',
  delfx: 'DELAY',
  revfx: 'REVERB'
}
import { UNIT_NAME_MAX_LEN } from '@logue-codegen/nts1mkii/generateOscUnit'
import { estimateOscStateCost } from '@logue-codegen/estimateOscStateCost'
import { findUnitKind, isEffectModule, MODULE_LABEL } from '@logue-codegen/unitKinds'
import {
  CPU_GAUGE,
  cpuZone,
  estimateOscCpuCost,
  NTS1MKII_OSC_CEILING_CYCLES,
  XD_CONFIRMED_WORKING_CYCLES,
  XD_HUNG_REFERENCE_CYCLES
} from '@logue-codegen/estimateOscCpuCost'
import { usedSubpatchTypes } from '@logue-codegen/subpatches'
import { useOptionalPatchStore } from '../state/patchStore'
import { useSubpatchLibraryStore } from '../state/subpatchLibraryStore'
import { useTabsStore } from '../state/tabsStore'
import { usePositionFreeDoc } from '../state/positionFreeDoc'
import { abbreviateHome, normalizePath } from '../util/paths'
import { computeCrossPlatformExposureWarnings } from '../state/exposedLogueParams'
import { listUnboundDeviceControls } from '@logue-codegen/deviceControls'
import PlatformToggle from './PlatformToggle'
import { PLATFORM_LABEL } from '../browser/loguePrimitiveCatalog'
import { useBuildResultsStore, type BuildResultEntry } from '../state/buildResultsStore'
import UploadUnitDialog from '../device/UploadUnitDialog'
import DeviceBackupDialog from '../device/DeviceBackupDialog'
import UsageGauge from './UsageGauge'
import WarningLine from './WarningLine'

/** Last path segment, for display -- this app's renderer has no Node `path` module available. */
function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

/**
 * A patch tab with no `logueTarget` (no active tab at all, or a hand-edited/foreign
 * `.loguepatch` file missing one) gets a plain placeholder instead of the export/build actions.
 */
function BuildPanel({ onOpenSettings }: { onOpenSettings: () => void }): React.JSX.Element {
  const rootDoc = useOptionalPatchStore((s) => s.rootDoc)
  // The live-analysis memos below key on this instead, so dragging a node doesn't re-flatten
  // and re-resolve the whole graph every frame.
  const analysisDoc = usePositionFreeDoc(rootDoc ?? null)
  const filePath = useOptionalPatchStore((s) => s.filePath)
  const openParamMatrix = useOptionalPatchStore((s) => s.openParamMatrix)
  const setPatchSettings = useOptionalPatchStore((s) => s.setPatchSettings)
  const setEffectModule = useOptionalPatchStore((s) => s.setEffectModule)
  const logueTarget = rootDoc?.settings.logueTarget
  const effect = logueTarget !== undefined && isEffectModule(logueTarget.module)
  // A definition has no audio-out and never builds on its own -- only as part of a patch.
  const isSubpatchDoc = rootDoc?.settings.subpatch === true
  const subpatchDefs = useSubpatchLibraryStore((s) => s.defs)
  const subpatchEntries = useSubpatchLibraryStore((s) => s.entries)
  const tabs = useTabsStore((s) => s.tabs)
  const [collapsed, setCollapsed] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A non-blocking problem from a panel action (e.g. a knob binding an effect type lacks).
  const [notice, setNotice] = useState<string | null>(null)
  // The row a success just added, flashed once instead of a "Built x" line repeating it.
  const [highlightId, setHighlightId] = useState<string | null>(null)
  // Shared with the Param Matrix's own toggle, not stored on the document (see
  // targetPlatformStore.ts).
  const buildPlatform = useTargetPlatformStore((s) => s.platform)

  // undefined = not checked yet, null = checked and nothing found.
  const [armToolchainInfo, setArmToolchainInfo] = useState<ArmToolchainInfo | null | undefined>(
    undefined
  )

  useEffect(() => {
    window.axoloti.logueBuild.detectLocalArmToolchain().then(setArmToolchainInfo)
  }, [])

  // Read-only here (SettingsModal.tsx owns the Browse/Clear controls) -- fetched once per mount,
  // same "not live-synced with Settings while both are open" tradeoff `armToolchainInfo` above
  // already accepts; the actual write always re-reads the live setting in the main process
  // regardless, so this is a display-only staleness window, not a correctness one.
  const [buildOutputFolder, setBuildOutputFolder] = useState<string | undefined>(undefined)

  useEffect(() => {
    window.axoloti.settings.getPath('buildOutputFolder').then(setBuildOutputFolder)
  }, [])

  const buildResults = useBuildResultsStore((s) => s.results)
  const [uploadEntry, setUploadEntry] = useState<BuildResultEntry | null>(null)
  const [backupMode, setBackupMode] = useState<'backup' | 'restore' | null>(null)
  const addBuildResult = useBuildResultsStore((s) => s.addResult)

  // Advisory only, recomputed live from the current
  // graph + build-target selector (not gated behind actually pressing Export/Build), so a real
  // gap shows up the moment the selector points at a platform that would silently drop a param,
  // not only after the fact.
  const exposureWarnings = useMemo(
    () =>
      analysisDoc && logueTarget && !isSubpatchDoc
        ? computeCrossPlatformExposureWarnings(analysisDoc, buildPlatform)
        : [],
    // `subpatchDefs` isn't read directly -- the warnings flatten against the library store --
    // but a saved definition can change them, so it has to recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [analysisDoc, logueTarget, isSubpatchDoc, buildPlatform, subpatchDefs]
  )

  // A device control with nothing assigned on this target builds as a constant -- almost always
  // an assignment made only for the other device.
  const unboundControls = useMemo(
    () =>
      analysisDoc && logueTarget && !isSubpatchDoc
        ? listUnboundDeviceControls(analysisDoc, subpatchDefs, buildPlatform)
        : [],
    [analysisDoc, logueTarget, isSubpatchDoc, buildPlatform, subpatchDefs]
  )

  // Export/Build read definitions from disk, so an open definition tab's unsaved edits won't
  // be in the unit -- say so up front rather than let the result silently differ from the screen.
  const unsavedSubpatches = useMemo(() => {
    if (!analysisDoc || isSubpatchDoc) return []
    const used = usedSubpatchTypes(analysisDoc, subpatchDefs)
    const dirtyPaths = new Set(
      tabs.filter((t) => t.dirty && t.filePath).map((t) => normalizePath(t.filePath!))
    )
    return subpatchEntries
      .filter((e) => used.has(e.type) && dirtyPaths.has(normalizePath(e.filePath)))
      .map((e) => e.type)
  }, [analysisDoc, isSubpatchDoc, subpatchDefs, subpatchEntries, tabs])

  // 2026-09-21 -- the deferred size-estimate feature (`project_cost_estimator_deferred` memory),
  // narrowed to its exact/state-only half (see `estimateOscStateCost.ts`'s own doc comment for
  // why the code-size half stays deferred). Same "recompute live against `buildPlatform`" pattern
  // as `exposureWarnings`/`unitNameTooLong` above -- a graph can resolve fine on one platform and
  // be incomplete (unconnected, a fan-in conflict, a platform-unsupported primitive, ...) on the
  // other.
  const stateCost = useMemo(
    () =>
      analysisDoc && logueTarget && !isSubpatchDoc
        ? estimateOscStateCost(analysisDoc, buildPlatform, subpatchDefs)
        : null,
    [analysisDoc, logueTarget, isSubpatchDoc, buildPlatform, subpatchDefs]
  )

  const cpuCost = useMemo(
    () =>
      analysisDoc && logueTarget && !isSubpatchDoc
        ? estimateOscCpuCost(analysisDoc, subpatchDefs, buildPlatform)
        : null,
    [analysisDoc, logueTarget, isSubpatchDoc, buildPlatform, subpatchDefs]
  )

  /** Fallback only -- used when the document has no explicit `settings.unitName` override. */
  const nameFromFilePath = (): string =>
    filePath
      ? filePath
          .split('/')
          .pop()!
          .replace(/\.loguepatch$/, '')
      : 'untitled'

  /**
   * The device-visible unit name Export/Build actually use: an explicit `settings.unitName`
   * (edited below) takes priority; an unset/blank one falls back to the file name, preserving
   * this app's original (pre-editable-name) behavior for anyone who never touches the field.
   */
  const currentUnitName = (): string => rootDoc?.settings.unitName?.trim() || nameFromFilePath()

  // NTS-1 mkII enforces a real fixed-size on-device name buffer (see generateOscUnit.ts's own
  // `UNIT_NAME_MAX_LEN` doc comment); minilogue xd's generator enforces no length at all. Export/
  // Build already throw a clear `InvalidLogueUnitNameError` for an over-long name (surfaced via
  // this panel's own `error` state), but that only fires on click -- this mirrors
  // `exposureWarnings`'s own "recomputed live against `buildPlatform`" pattern so an
  // NTS-1-mkii-too-long name is visible before the user tries to export/build at all.
  const unitNameTooLong =
    buildPlatform === 'nts1mkii' && currentUnitName().length > UNIT_NAME_MAX_LEN

  // The Build menu's items are never disabled the way the buttons are, so a repeated Cmd+B would
  // otherwise start a second build racing `makeRoomForDestination` on the same destination.
  // A ref, not state: two IPC events can land before React re-renders with `building` set.
  const inFlight = useRef(false)

  /** Export and Build share the guard, the one-at-a-time lock, and the status/error handling. */
  const runUnitAction = async (
    setBusy: (busy: boolean) => void,
    run: (doc: PatchDocument, unitName: string) => Promise<void>
  ): Promise<void> => {
    if (!rootDoc || !logueTarget || isSubpatchDoc || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await run(rootDoc, currentUnitName())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  /**
   * Writes real generated `header.c`/`osc.h`/`unit.cc` (via `logue-codegen`'s
   * `generateOscUnit`, main/ipc/logueExport.ts) into a named subfolder of the configured build
   * output folder -- NOT a full build. No
   * per-click folder-picker dialog any more (build result file management, 2026-09-23): a
   * pre-existing folder at that exact destination is renamed aside first, and the new folder is
   * recorded in the growing Build Results list below.
   */
  const handleExportLogueUnit = (): Promise<void> =>
    runUnitAction(setExporting, async (doc, unitName) => {
      // Two genuinely different SDK generations, each with its own generator/IPC handler.
      const result =
        buildPlatform === 'nts1mkii'
          ? await window.axoloti.logueExport.exportNts1MkiiUnit(doc, unitName, filePath ?? null)
          : await window.axoloti.logueExport.exportMinilogueXdUnit(doc, unitName, filePath ?? null)
      addBuildResult({ kind: 'export', platform: buildPlatform, unitName, path: result.folderPath })
      setHighlightId(useBuildResultsStore.getState().results[0].id)
    })

  /**
   * The real, end-to-end sibling of `handleExportLogueUnit` -- see main/ipc/logueBuild.ts.
   * Both platforms now real (real-hardware verification confirmed a built `.nts1mkiiunit`
   * uploads and runs correctly via Kontrol Editor, the earlier "NTS-1 mkII has no working
   * upload tool" assumption behind the old minilogue-xd-only gate was never actually tested and
   * turned out to be wrong) -- dispatched on this panel's own `buildPlatform` selector, same
   * shape as `handleExportLogueUnit`'s own platform dispatch.
   */
  const handleBuildUnit = (): Promise<void> =>
    runUnitAction(setBuilding, async (doc, unitName) => {
      const result =
        buildPlatform === 'nts1mkii'
          ? await window.axoloti.logueBuild.buildNts1MkiiUnit(doc, unitName, filePath ?? null)
          : await window.axoloti.logueBuild.buildMinilogueXdUnit(doc, unitName, filePath ?? null)
      addBuildResult({
        kind: 'build',
        platform: buildPlatform,
        unitName,
        path: result.savedPath,
        builtWith: result.builtWith
      })
      setHighlightId(useBuildResultsStore.getState().results[0].id)
    })

  // Subscribed once; always calls the latest render's handlers so a menu click acts on the
  // current document and build-target selector, not the ones from mount time.
  const menuActions = useRef({ exportSource: handleExportLogueUnit, build: handleBuildUnit })
  useEffect(() => {
    menuActions.current = { exportSource: handleExportLogueUnit, build: handleBuildUnit }
  })

  useEffect(() => {
    // A menu action's result/error only renders while expanded, so expand first -- otherwise a
    // Cmd+B on a collapsed panel would give no feedback at all.
    const runDocAction = (action: 'exportSource' | 'build') => (): void => {
      setCollapsed(false)
      void menuActions.current[action]()
    }
    const unsubscribers = [
      window.axoloti.events.onMenuExportUnitSource(runDocAction('exportSource')),
      window.axoloti.events.onMenuBuildUnit(runDocAction('build')),
      window.axoloti.events.onMenuOpenParamMatrix(() => openParamMatrix()),
      window.axoloti.events.onMenuDeviceBackup(() => setBackupMode('backup')),
      window.axoloti.events.onMenuDeviceRestore(() => setBackupMode('restore'))
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [openParamMatrix])

  return (
    <div className={'build-panel' + (collapsed ? ' build-panel--collapsed' : '')}>
      <div
        className="build-panel__toolbar"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand Build' : 'Collapse Build'}
        onClick={() => setCollapsed((c) => !c)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          setCollapsed((c) => !c)
        }}
      >
        <span className="build-panel__toggle" aria-hidden="true">
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </span>
        <span className="build-panel__title">Build</span>
      </div>
      {!collapsed && isSubpatchDoc && (
        <div className="build-panel__hint">
          This is a subpatch -- it doesn&apos;t build on its own. Save it, then place it in a patch
          from the palette&apos;s subpatch group; Export and Build use the saved file.
        </div>
      )}
      {!collapsed && logueTarget && !isSubpatchDoc && (
        <>
          {/* Device-visible unit name (manifest.json's `header.name` on minilogue xd,
              `unit_header_t.name` on NTS-1 mkII) -- an explicit override persisted on the
              document (`settings.unitName`), separate from the `.loguepatch` file's own name.
              Uncontrolled + `onBlur` commit, matching Inspector.tsx's own Name field; `key`
              forces a fresh `defaultValue` whenever the underlying value changes from elsewhere
              (undo/redo, switching tabs) rather than showing a stale one, same reasoning as
              Inspector.tsx's own param-value inputs. An empty/whitespace-only edit clears the
              override (falls back to the file name) rather than persisting a blank name. */}
          <label className="build-panel__field build-panel__field--inline">
            <span>Name</span>
            <input
              type="text"
              key={`${filePath ?? ''}-${rootDoc?.settings.unitName ?? ''}`}
              defaultValue={rootDoc?.settings.unitName ?? ''}
              placeholder={nameFromFilePath()}
              data-tooltip="Name shown on the device's own menu when this patch is selected"
              onBlur={(e) => {
                const trimmed = e.target.value.trim()
                setPatchSettings({ unitName: trimmed === '' ? undefined : trimmed })
              }}
            />
          </label>
          {effect && (
            <div className="build-panel__field">
              <span>Effect Type</span>
              {/* Among effects only (user's call, 2026-09-30): an oscillator's audio in/out and
                  wiring differ. `setEffectModule` re-lays the params for the new type. */}
              <div className="build-panel__platform-toggle" role="group" aria-label="Effect type">
                {EFFECT_MODULES.map((module) => (
                  <button
                    key={module}
                    type="button"
                    className={
                      'view-mode-pill__option' +
                      (logueTarget.module === module ? ' view-mode-pill__option--active' : '')
                    }
                    aria-pressed={logueTarget.module === module}
                    onClick={() => {
                      const removed = setEffectModule(module)
                      setNotice(
                        removed.length === 0
                          ? null
                          : `${MODULE_LABEL[module]} units have no such knob -- removed the binding of ${removed.join(', ')} (undo brings it back).`
                      )
                    }}
                    data-tooltip={`Build as a ${MODULE_LABEL[module].toLowerCase()} (the device's ${EFFECT_SLOT[module]} slot)`}
                  >
                    {EFFECT_PILL[module]}
                  </button>
                ))}
              </div>
            </div>
          )}
          {unitNameTooLong && (
            <WarningLine
              summary={`Name too long for ${PLATFORM_LABEL.nts1mkii} (${currentUnitName().length}/${UNIT_NAME_MAX_LEN})`}
            >
              &quot;{currentUnitName()}&quot; is {currentUnitName().length} characters, over NTS-1
              mkII&apos;s {UNIT_NAME_MAX_LEN}-character on-device limit -- shorten it before
              exporting/building for {PLATFORM_LABEL.nts1mkii}.
            </WarningLine>
          )}
          {/* Which platform Export/Build/the warning below act on -- shared with the Param
              Matrix's toggle, NOT persisted (see `buildPlatform` above). */}
          <PlatformToggle
            ariaLabel="Build target platform"
            tooltip={(p) => `Export/Build/warn for ${PLATFORM_LABEL[p]}`}
          />
          {effect && !findUnitKind(buildPlatform, logueTarget.module) && (
            <WarningLine
              summary={`No ${MODULE_LABEL[logueTarget.module].toLowerCase()} on ${PLATFORM_LABEL[buildPlatform]} yet`}
            >
              {MODULE_LABEL[logueTarget.module]} units can&apos;t be built for the{' '}
              {PLATFORM_LABEL[buildPlatform]} yet -- switch the target to export or build this one.
            </WarningLine>
          )}
          {armToolchainInfo === null && (
            <WarningLine summary="No ARM toolchain found">
              Install one (e.g. &quot;brew install --cask gcc-arm-embedded&quot;) or set its bin
              directory in{' '}
              <button type="button" className="build-panel__hint-link" onClick={onOpenSettings}>
                Settings
              </button>
              .
            </WarningLine>
          )}
          {/* Nothing rendered while `stateCost.status === 'incomplete'` (an empty/unconnected
              graph, most often a freshly-created document) -- Export/Build's own `error` state
              already surfaces that same condition on click, so a second warning here would just
              be noise for the common "haven't wired anything yet" case. Only a real `'ok'`
              estimate is worth a line. */}
          {stateCost?.status === 'ok' &&
            stateCost.estimate.perInstance.length > 0 &&
            (() => {
              const { totalBytes, budgetBytes } = stateCost.estimate
              const pct = (totalBytes / budgetBytes) * 100
              return (
                <UsageGauge
                  label="RAM"
                  value={totalBytes}
                  // RAM has an exact limit, so the colour only warns as it fills up.
                  fineUpTo={budgetBytes * 0.75}
                  limit={budgetBytes}
                  className={totalBytes > budgetBytes ? 'build-panel__warning' : undefined}
                  tooltip={(() => {
                    const e = stateCost.estimate
                    const codeOf = new Map(e.code.perInstance.map((c) => [c.nodeName, c.bytes]))
                    return (
                      `RAM: ${totalBytes} of ${budgetBytes} bytes.\n\n` +
                      // The band is checkCodeSizeEstimate.ts' run against whole builds.
                      'Code, measured per primitive from real builds (within -7%..+23% of ' +
                      'whole builds, usually over), plus exact state. Code and state share one ' +
                      `budget on ${PLATFORM_LABEL[buildPlatform]}.\n\n` +
                      [
                        `code ${e.codeBytes}B, state ${e.stateBytes}B`,
                        `fixed code: ${e.codeBaselineBytes}B`,
                        `fixed state: ${e.baselineBytes}B`,
                        ...e.perInstance.map(
                          (i) =>
                            `${i.nodeName} · ${i.primitiveId}: code ${codeOf.get(i.nodeName) ?? 0}B, state ${i.bytes}B`
                        ),
                        ...e.code.helpers.map((h) => `${h.helperKey} (shared code): ${h.bytes}B`),
                        ...e.sharedHelpers.map((h) => `${h.helperKey} (shared table): ${h.bytes}B`),
                        ...(e.code.unmeasured.length > 0
                          ? [`code not measured (counted as 0): ${e.code.unmeasured.join(', ')}`]
                          : [])
                      ].join('\n')
                    )
                  })()}
                  text={`${pct.toFixed(0)}%`}
                />
              )
            })()}
          {stateCost?.status === 'ok' &&
            stateCost.estimate.sdram &&
            stateCost.estimate.sdram.usedBytes > 0 &&
            (() => {
              const { usedBytes, budgetBytes, perInstance } = stateCost.estimate.sdram
              const kb = (bytes: number): string => `${Math.round(bytes / 1024)} KB`
              return (
                <UsageGauge
                  label="SDRAM"
                  value={usedBytes}
                  fineUpTo={budgetBytes * 0.75}
                  limit={budgetBytes}
                  className={usedBytes > budgetBytes ? 'build-panel__warning' : undefined}
                  tooltip={
                    `SDRAM: ${kb(usedBytes)} of ${kb(budgetBytes)}.\n\n` +
                    "External memory for delay lines (the unit's SDRAM), exact -- over the limit, " +
                    'Export stops.\n\n' +
                    perInstance
                      .map((i) => `${i.nodeName} · ${i.primitiveId}: ${kb(i.bytes)}`)
                      .join('\n')
                  }
                  text={`${((usedBytes / budgetBytes) * 100).toFixed(0)}%`}
                />
              )
            })()}
          {effect && findUnitKind(buildPlatform, logueTarget.module) && (
            <UsageGauge label="CPU" text="—" tooltip="CPU: not measured for effects yet." />
          )}
          {cpuCost?.status === 'ok' &&
            cpuCost.estimate.perInstance.length > 0 &&
            (() => {
              const { cyclesPerVoice, maxCyclesPerVoice, perInstance, unmeasured } =
                cpuCost.estimate
              const xd = buildPlatform === 'minilogue-xd'
              const { zone } = cpuZone(cyclesPerVoice, buildPlatform)
              const max = cpuZone(maxCyclesPerVoice, buildPlatform)
              const gauge = CPU_GAUGE[buildPlatform]
              const verdictOf = (z: typeof zone): string =>
                z === 'fine'
                  ? 'likely fine'
                  : z === 'over'
                    ? xd
                      ? 'likely to hang'
                      : 'likely to break up'
                    : xd
                      ? 'untested'
                      : 'tight'
              // The row's one word; `verdictOf` spells it out in the tooltip.
              const shortVerdictOf = (z: typeof zone): string =>
                z === 'fine'
                  ? 'fine'
                  : z === 'over'
                    ? xd
                      ? 'may hang'
                      : 'overload'
                    : xd
                      ? 'untested'
                      : 'tight'
              const knobsMatter = maxCyclesPerVoice > cyclesPerVoice && max.zone !== zone
              const anchors = xd
                ? `A patch at ~${XD_CONFIRMED_WORKING_CYCLES} plays 4-note chords fine on a real ` +
                  `xd; one at ~${XD_HUNG_REFERENCE_CYCLES} hung.`
                : `On a real NTS-1 mkII the oscillator stays clean up to ~${NTS1MKII_OSC_CEILING_CYCLES}` +
                  ' (measured with the factory Submarine reverb on; a heavier effect leaves less). ' +
                  "The costs are the minilogue xd emulator's, standing in: the NTS-1 mkII usually " +
                  'needs fewer cycles.'
              return (
                <UsageGauge
                  label="CPU"
                  value={cyclesPerVoice}
                  fineUpTo={gauge.fineUpTo}
                  limit={gauge.limit}
                  reach={maxCyclesPerVoice}
                  markFine
                  tooltip={
                    `CPU: ${verdictOf(zone)}` +
                    (knobsMatter ? `; with the knobs turned up: ${verdictOf(max.zone)}` : '') +
                    '.\n\n' +
                    `Estimated ${cyclesPerVoice} cycles ${xd ? 'per voice' : 'per sample'} at the saved settings` +
                    (maxCyclesPerVoice > cyclesPerVoice
                      ? `, up to ${maxCyclesPerVoice} with the device knobs at their costliest`
                      : '') +
                    ' (emulator, not measured on the synth).\n\n' +
                    anchors +
                    '\n\nBiggest costs:\n' +
                    [...perInstance]
                      .filter((i) => i.cycles > 0)
                      .sort((a, b) => b.cycles - a.cycles)
                      .slice(0, 4)
                      .map((i) => `${i.nodeName}: ${i.cycles}`)
                      .join('\n') +
                    (unmeasured.length ? `\n\nNot measured: ${unmeasured.join(', ')}` : '')
                  }
                  text={
                    shortVerdictOf(zone) + (knobsMatter ? ` → ${shortVerdictOf(max.zone)}` : '')
                  }
                />
              )
            })()}
          {unsavedSubpatches.length > 0 && (
            <WarningLine
              summary={
                unsavedSubpatches.length === 1
                  ? `Unsaved subpatch: ${unsavedSubpatches[0]}`
                  : `${unsavedSubpatches.length} unsaved subpatches`
              }
            >
              Unsaved changes in {unsavedSubpatches.join(', ')} -- Export/Build use the saved
              version. Save {unsavedSubpatches.length > 1 ? 'them' : 'it'} first to include your
              edits.
            </WarningLine>
          )}
          {exposureWarnings.length > 0 && (
            <WarningLine
              summary={`${exposureWarnings.length} param${exposureWarnings.length > 1 ? 's' : ''} only on ${PLATFORM_LABEL[exposureWarnings[0].otherPlatform]}`}
            >
              On a device control on {PLATFORM_LABEL[exposureWarnings[0].otherPlatform]} but not{' '}
              {PLATFORM_LABEL[buildPlatform]}, so they won&apos;t appear in this build:
              <ul className="warning-line__list">
                {exposureWarnings.map((w) => (
                  <li key={`${w.nodeName} · ${w.displayName}`}>
                    {w.nodeName} · {w.displayName}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="build-panel__hint-link"
                onClick={() => openParamMatrix()}
              >
                Open the Device Param Matrix
              </button>
            </WarningLine>
          )}
          {unboundControls.length > 0 && (
            <WarningLine
              summary={`${unboundControls.length} control${unboundControls.length > 1 ? 's' : ''} unassigned`}
            >
              Nothing assigned on the {PLATFORM_LABEL[buildPlatform]}, so{' '}
              {unboundControls.length === 1 ? 'it outputs' : 'they output'} a constant:
              <ul className="warning-line__list">
                {unboundControls.map((c, i) => (
                  <li key={`${c.nodeName}-${i}`}>
                    {c.nodeName} ({c.value})
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="build-panel__hint-link"
                onClick={() => openParamMatrix()}
              >
                Assign in the Device Param Matrix
              </button>
            </WarningLine>
          )}
          {/* Last control above the results: the gauges and warnings above are what decide
              whether to press it. */}
          <button
            type="button"
            className="build-panel__build-button"
            onClick={handleBuildUnit}
            disabled={!rootDoc || exporting || building}
            data-tooltip={
              building
                ? 'Building…'
                : `Build .${buildPlatform === 'nts1mkii' ? 'nts1mkiiunit' : 'mnlgxdunit'} (${armToolchainInfo ? armToolchainInfo.version : 'local ARM toolchain'})`
            }
          >
            <Hammer size={16} />
            {building ? 'Building…' : 'Build Unit'}
          </button>
          {error && <div className="build-panel__error">{error}</div>}
          {/* Successes aren't echoed here: the new Build Results row (highlighted) says it. */}
          {notice && <div className="build-panel__error">{notice}</div>}
          {/* Global (all patches, this session -- see buildResultsStore.ts), newest first; only
              successes are recorded (a failure has no file to reveal). The output folder is a
              set-once setting (SettingsModal.tsx owns it), so it lives behind the header's folder
              button rather than as a line of its own -- unless it's unset, since Build needs it. */}
          <div className="build-panel__results">
            <div className="build-panel__results-header">
              <span>Results</span>
              {buildOutputFolder && (
                <button
                  type="button"
                  className="build-panel__icon-button"
                  onClick={() => window.axoloti.system.showItemInFolder(buildOutputFolder)}
                  data-tooltip={`Output folder: ${abbreviateHome(buildOutputFolder)} -- click to show in Finder (change it in Settings)`}
                  aria-label="Show the build output folder in Finder"
                >
                  <FolderOpen size={14} />
                </button>
              )}
            </div>
            {!buildOutputFolder && (
              <div className="build-panel__output-folder">
                No build output folder set.{' '}
                <button type="button" className="build-panel__hint-link" onClick={onOpenSettings}>
                  Set…
                </button>
              </div>
            )}
            {buildResults.length > 0 && (
              <div className="build-panel__results-list">
                {buildResults.map((r, idx) => (
                  <div
                    key={r.id}
                    className={
                      'build-panel__result-row' +
                      (r.id === highlightId ? ' build-panel__result-row--new' : '')
                    }
                  >
                    {/* Only the file name and device stay visible; kind/time live in the tooltip
                        so a narrow sidebar truncates the device label before the file name. */}
                    <button
                      type="button"
                      className="build-panel__hint-link build-panel__result-name"
                      onClick={() => window.axoloti.system.showItemInFolder(r.path)}
                      data-tooltip={`${r.kind === 'export' ? 'Exported' : 'Built'} ${new Date(r.createdAt).toLocaleTimeString()}${r.builtWith ? ` (${r.builtWith})` : ''} -- click to reveal in Finder: ${r.path}`}
                    >
                      {baseName(r.path)}
                    </button>
                    <span className="build-panel__result-meta">{PLATFORM_LABEL[r.platform]}</span>
                    {/* Both platforms' uploads are captured and byte-exact (logue-cli for the
                        xd, Kontrol Editor for the NTS-1 mkII). Only the newest row per path gets a
                        button: a rebuild renames the previous file aside
                        (makeRoomForDestination), so an older row's `path` now holds the NEWER
                        build and would silently upload that instead. */}
                    {r.kind === 'build' &&
                      !buildResults.slice(0, idx).some((newer) => newer.path === r.path) && (
                        <button
                          type="button"
                          className="build-panel__result-upload"
                          onClick={() => setUploadEntry(r)}
                          data-tooltip={`Upload this unit straight to a connected ${PLATFORM_LABEL[r.platform]} over MIDI`}
                          aria-label={`Upload ${baseName(r.path)} to ${PLATFORM_LABEL[r.platform]}`}
                        >
                          <SquareArrowRightEnter size={14} />
                        </button>
                      )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      {!collapsed && !logueTarget && (
        <div className="build-panel__empty-hint">No patch opened to build</div>
      )}
      {uploadEntry && <UploadUnitDialog entry={uploadEntry} onClose={() => setUploadEntry(null)} />}
      {backupMode && <DeviceBackupDialog mode={backupMode} onClose={() => setBackupMode(null)} />}
    </div>
  )
}

export default BuildPanel
