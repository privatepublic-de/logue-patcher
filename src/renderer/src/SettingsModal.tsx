import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { ArmToolchainInfo, PathSettingKey } from '@shared/ipc/contract'
import { abbreviateHome } from './util/paths'
import { useDraggableModal } from './useDraggableModal'
import { usePathSettingsStore } from './state/pathSettingsStore'

/**
 * A path setting can come back as `''` rather than `undefined` (Clear writes `''`), so both
 * must fall through to the placeholder or the field renders as a blank, broken-looking box.
 */
function PathDisplay({
  path,
  placeholder
}: {
  path: string | undefined
  placeholder: string
}): React.JSX.Element {
  if (!path) {
    return (
      <span className="settings-modal__path settings-modal__path--placeholder">{placeholder}</span>
    )
  }
  // Cut from the left (rtl box, ltr text inside), so the folder names at the end stay visible.
  return (
    <span className="settings-modal__path settings-modal__path--tail" data-tooltip={path}>
      <bdi dir="ltr">{abbreviateHome(path)}</bdi>
    </span>
  )
}

/** One short line under a field; the rest of the explanation is its tooltip. */
function Hint({ text, more }: { text: string; more: string }): React.JSX.Element {
  return (
    <span className="settings-modal__hint" data-tooltip={more}>
      {text}
    </span>
  )
}

/**
 * One folder setting's value plus its Browse/Clear actions. Clear writes `''` rather than
 * removing the key: `resolveArmToolchainBinDir` treats a configured toolchain path as
 * authoritative (its error says "clear it to auto-detect"), and every reader treats `''` like
 * unset.
 */
function usePathSetting(key: PathSettingKey): {
  path: string | undefined
  browse: () => Promise<void>
  clear: () => Promise<void>
} {
  const [path, setPath] = useState<string | undefined>(undefined)
  const changed = usePathSettingsStore((s) => s.changed)
  useEffect(() => {
    window.axoloti.settings.getPath(key).then((value) => setPath(value || undefined))
  }, [key])
  const browse = async (): Promise<void> => {
    const picked = await window.axoloti.settings.pickPath(key)
    if (!picked) return
    await window.axoloti.settings.setPath(key, picked)
    setPath(picked)
    changed()
  }
  const clear = async (): Promise<void> => {
    await window.axoloti.settings.setPath(key, '')
    setPath(undefined)
    changed()
  }
  return { path, browse, clear }
}

/**
 * The app's settings surface: the local `logue-sdk` checkout path `main/ipc/logueBuild.ts` needs
 * for a real build, an optional ARM toolchain override -- most users never need the latter, since
 * auto-detection already covers Homebrew's gcc-arm-embedded cask and the Arm GNU Toolchain
 * installer's own layout -- and the Build Output Folder Export/Build now write into directly
 * (BuildPanel.tsx shows this same value read-only, with a link back here to change it). This
 * modal is the one canonical place with Browse/Clear controls for all three. Deliberately no
 * live validation here (e.g. checking the SDK checkout's layout, or that the toolchain path has
 * the right binaries) -- Build's own error messages already cover an invalid/missing path either
 * way, and duplicating that check here would be a second place to keep in sync for no real
 * benefit yet.
 */
function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { modalRef, onHeaderPointerDown } = useDraggableModal()
  const logueSdk = usePathSetting('logueSdkPath')
  const armToolchain = usePathSetting('armToolchainPath')
  const buildOutput = usePathSetting('buildOutputFolder')
  const subpatchLibrary = usePathSetting('subpatchLibraryPath')
  // Shown in place of an empty toolchain field, so "automatic" says what it found.
  const [detected, setDetected] = useState<ArmToolchainInfo | null | undefined>(undefined)
  useEffect(() => {
    window.axoloti.logueBuild.detectLocalArmToolchain().then(setDetected)
  }, [armToolchain.path])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={modalRef} className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header" onPointerDown={onHeaderPointerDown}>
          <span>Settings</span>
          <button onClick={onClose} data-tooltip="Close" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="modal__body">
          <label className="settings-modal__field">
            <span>logue SDK folder</span>
            <div className="settings-modal__path-row">
              <PathDisplay path={logueSdk.path} placeholder="not set" />
              <button onClick={logueSdk.browse}>Browse…</button>
            </div>
            <Hint
              text="Your clone of korginc/logue-sdk. Needed to build."
              more="A local clone of korginc/logue-sdk -- Build stages the generated unit inside it and runs its Makefile to produce an installable .mnlgxdunit/.nts1mkiiunit."
            />
          </label>
          <label className="settings-modal__field">
            <span>ARM toolchain</span>
            <div className="settings-modal__path-row">
              <PathDisplay
                path={armToolchain.path}
                placeholder={
                  detected === undefined
                    ? 'looking…'
                    : detected
                      ? `automatic: ${detected.version}`
                      : 'none found'
                }
              />
              <button onClick={armToolchain.browse}>Browse…</button>
              {armToolchain.path && <button onClick={armToolchain.clear}>Clear</button>}
            </div>
            <Hint
              text="Leave empty to use the one found automatically."
              more={
                "Where your arm-none-eabi-gcc lives (e.g. Homebrew's gcc-arm-embedded cask). Empty, Build looks in the usual install locations" +
                (detected ? ` and found ${detected.binDir}.` : '.')
              }
            />
          </label>
          <label className="settings-modal__field">
            <span>Build output folder</span>
            <div className="settings-modal__path-row">
              <PathDisplay path={buildOutput.path} placeholder="not set" />
              <button onClick={buildOutput.browse}>Browse…</button>
              {buildOutput.path && <button onClick={buildOutput.clear}>Clear</button>}
            </div>
            <Hint
              text="Where Export and Build write. Needed to build."
              more="If something is already at the destination, it's renamed aside with a timestamp instead of overwritten."
            />
          </label>
          <label className="settings-modal__field">
            <span>Subpatch library folder</span>
            <div className="settings-modal__path-row">
              <PathDisplay path={subpatchLibrary.path} placeholder="not set" />
              <button onClick={subpatchLibrary.browse}>Browse…</button>
              {subpatchLibrary.path && <button onClick={subpatchLibrary.clear}>Clear</button>}
            </div>
            <Hint
              text="Your reusable subpatches; subfolders become palette groups."
              more="Patches refer to a subpatch by its path inside this folder, so renaming or moving a file inside it breaks the patches that use it. Moving the whole folder is fine."
            />
          </label>
        </div>
      </div>
    </div>
  )
}

export default SettingsModal
