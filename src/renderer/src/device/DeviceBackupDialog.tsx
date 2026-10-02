import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { LogueDeviceSession } from '@logue-codegen/sysex/deviceSession'
import type { LogueUnitModule } from '@logue-codegen/sysex/korgUserUnitMessages'
import {
  backupZipName,
  parseBackupIndex,
  planBackup,
  type BackupIndex,
  type BackupSlotEntry,
  type DownloadedSlot
} from '@logue-codegen/sysex/unitBackup'
import type { LoguePlatform } from '@shared/domain/patch'
import { findLogueDevices, linkFor, type FoundDevice } from './midiLink'
import { useDraggableModal } from '../useDraggableModal'

const DEVICE_LABEL: Record<LoguePlatform, string> = {
  'minilogue-xd': 'minilogue xd',
  nts1mkii: 'NTS-1 digital kit mkII'
}

const MODULES: LogueUnitModule[] = ['osc', 'modfx', 'delfx', 'revfx']

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; text: string }
  | { kind: 'done'; text: string; folder?: string }
  | { kind: 'error'; text: string }

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function openSession(device: FoundDevice): Promise<LogueDeviceSession> {
  const s = new LogueDeviceSession(
    linkFor(device.inputId, device.outputId),
    device.platform!,
    device.channel
  )
  await s.apiVersion()
  return s
}

/**
 * Whole-device backup and restore for a minilogue xd, over the native MIDI helper (downloads need
 * raw bytes: the device's long SysEx carries stray F7s that Web MIDI truncates at). A backup is one
 * fresh `backup-<timestamp>.<device>.zip` under `<build output folder>/backups/`; a restore uploads each backed-up `.body.bin`
 * -- the device's own stored bytes, not a reconstruction -- back into its original slot.
 */
function DeviceBackupDialog({
  mode,
  onClose
}: {
  mode: 'backup' | 'restore'
  onClose: () => void
}): React.JSX.Element {
  const { modalRef, onHeaderPointerDown } = useDraggableModal()
  const [devices, setDevices] = useState<FoundDevice[] | null>(null)
  const [deviceIndex, setDeviceIndex] = useState(0)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [backup, setBackup] = useState<{
    folder: string
    index: BackupIndex
    bodies: Record<string, Uint8Array>
  } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  /** The device kind the opened backup came from; a restore only ever targets that kind. */
  const restorePlatform = useRef<LoguePlatform | null>(null)
  const [restoreKind, setRestoreKind] = useState<LoguePlatform | null>(null)

  const busy = phase.kind === 'working'
  const device = devices?.[deviceIndex]
  const key = (e: BackupSlotEntry): string => `${e.module}/${e.slot}`

  const scan = useCallback(async (): Promise<void> => {
    // A pending overwrite confirmation belongs to the device it was given for; discovery order
    // isn't stable, so a rescan must never carry it over to whichever device lands at index 0.
    setConfirming(false)
    setDevices(null)
    try {
      // A restore must go to the same kind of device the backup came from.
      const supported: LoguePlatform[] =
        mode === 'backup'
          ? ['minilogue-xd', 'nts1mkii']
          : restorePlatform.current
            ? [restorePlatform.current]
            : []
      const found = (await findLogueDevices()).filter(
        (d) => d.platform && supported.includes(d.platform)
      )
      setDevices(found)
      setDeviceIndex(0)
    } catch (e) {
      setDevices([])
      setPhase({ kind: 'error', text: errorMessage(e) })
    }
  }, [mode])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (mode === 'restore') {
        try {
          const opened = await window.axoloti.logueDevice.openBackup()
          if (cancelled) return
          if (!opened) return onClose()
          const index = parseBackupIndex(opened.indexJson)
          const platform = (Object.keys(DEVICE_LABEL) as LoguePlatform[]).find(
            (p) => DEVICE_LABEL[p] === index.device
          )
          if (!platform) throw new Error(`unknown device "${index.device}" in index.json.`)
          restorePlatform.current = platform
          setRestoreKind(platform)
          const restorable = index.slots.filter((e) => !e.empty && e.body && opened.bodies[e.body])
          setBackup({ folder: opened.folder, index, bodies: opened.bodies })
          setSelected(new Set(restorable.map(key)))
        } catch (e) {
          if (!cancelled)
            setPhase({ kind: 'error', text: `Couldn't open that backup: ${errorMessage(e)}` })
          return
        }
      }
      if (!cancelled) await scan()
    })()
    return () => {
      cancelled = true
    }
  }, [mode, onClose, scan])

  const runBackup = async (): Promise<void> => {
    if (!device) return
    try {
      setPhase({ kind: 'working', text: 'Connecting…' })
      const s = await openSession(device)
      const downloaded: DownloadedSlot[] = []
      for (const module of MODULES) {
        const { slotCount } = await s.moduleInfo(module)
        for (let slot = 0; slot < slotCount; slot++) {
          setPhase({ kind: 'working', text: `Reading ${module} ${slot + 1}/${slotCount}…` })
          downloaded.push({ module, slot, body: await s.downloadSlot(module, slot) })
        }
      }
      const now = new Date()
      const platform = device.platform!
      const { files, index } = planBackup(DEVICE_LABEL[platform], downloaded, now, platform)
      const folder = await window.axoloti.logueDevice.writeBackup(
        backupZipName(platform, now),
        files
      )
      const units = index.slots.filter((e) => !e.empty).length
      const unpackaged = index.slots.filter((e) => !e.empty && !e.unitFile).length
      const emptySlots = index.slots.length - units
      setPhase({
        kind: 'done',
        folder,
        text:
          `Backed up ${units} unit${units === 1 ? '' : 's'} ` +
          `(${emptySlots} empty slot${emptySlots === 1 ? '' : 's'}).` +
          (unpackaged ? ` ${unpackaged} kept as .body.bin only (see index.json).` : '')
      })
    } catch (e) {
      setPhase({ kind: 'error', text: `Couldn't back up: ${errorMessage(e)}` })
    }
  }

  const runRestore = async (): Promise<void> => {
    if (!device || !backup) return
    if (!confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    const todo = backup.index.slots.filter((e) => selected.has(key(e)))
    let done = 0
    try {
      setPhase({ kind: 'working', text: 'Connecting…' })
      const s = await openSession(device)
      for (const e of todo) {
        setPhase({
          kind: 'working',
          text: `Restoring ${e.module} ${e.slot + 1} "${e.name}" (${done + 1}/${todo.length})…`
        })
        await s.upload(e.module, e.slot, backup.bodies[e.body!])
        const now = await s.slotStatus(e.module, e.slot)
        if (now.empty || now.name !== e.name) {
          throw new Error(
            `${e.module} ${e.slot + 1} reads back as "${now.name}" after restoring "${e.name}".`
          )
        }
        done++
      }
      setPhase({
        kind: 'done',
        text: `Restored ${done} unit${done === 1 ? '' : 's'}; each read back correctly.`
      })
    } catch (e) {
      setPhase({
        kind: 'error',
        text: `Restore stopped after ${done} of ${todo.length}: ${errorMessage(e)}`
      })
    }
  }

  const restorable =
    backup?.index.slots.filter((e) => !e.empty && e.body && backup.bodies[e.body]) ?? []

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div ref={modalRef} className="modal upload-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header" onPointerDown={onHeaderPointerDown}>
          <span>{mode === 'backup' ? 'Back up device' : 'Restore device backup'}</span>
          <button onClick={onClose} disabled={busy} data-tooltip="Close" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="modal__body">
          {mode === 'backup' && (
            <div className="upload-modal__meta">
              Reads every user slot (oscillators and effects) into one new <code>backup-…zip</code>{' '}
              in your build output folder&apos;s <code>backups/</code>. Nothing on the device is
              changed.
            </div>
          )}
          {backup && (
            <div className="upload-modal__meta" title={backup.folder}>
              {backup.folder.split('/').pop()} · {new Date(backup.index.createdAt).toLocaleString()}
            </div>
          )}

          {devices === null && (
            <div className="upload-modal__meta">
              Looking for{' '}
              {mode === 'backup' || !restoreKind
                ? 'a minilogue xd or NTS-1 mkII'
                : `a ${DEVICE_LABEL[restoreKind]}`}
              …
            </div>
          )}
          {devices?.length === 0 && (
            <div className="build-panel__warning">
              No{' '}
              {mode === 'backup' || !restoreKind
                ? 'minilogue xd or NTS-1 mkII'
                : DEVICE_LABEL[restoreKind]}{' '}
              answered. Connect it over USB and make sure it&apos;s switched on.
            </div>
          )}
          {devices && devices.length > 1 && (
            <label className="upload-modal__field">
              <span>Device</span>
              <select
                value={deviceIndex}
                disabled={busy}
                onChange={(e) => {
                  setDeviceIndex(Number(e.target.value))
                  setConfirming(false)
                }}
              >
                {devices.map((d, i) => (
                  <option key={d.outputId} value={i}>
                    {d.platform ? DEVICE_LABEL[d.platform] : '?'} · {d.outputName} (ch{' '}
                    {d.channel + 1})
                  </option>
                ))}
              </select>
            </label>
          )}
          {devices?.length === 1 && device && (
            <div className="upload-modal__meta">
              {device.outputName} · global channel {device.channel + 1}
            </div>
          )}

          {mode === 'restore' && restorable.length > 0 && (
            <div className="backup-modal__list">
              {restorable.map((e) => (
                <label key={key(e)} className="backup-modal__row">
                  <input
                    type="checkbox"
                    className="param-widget__checkbox-input"
                    disabled={busy}
                    checked={selected.has(key(e))}
                    onChange={(ev) => {
                      const next = new Set(selected)
                      if (ev.target.checked) next.add(key(e))
                      else next.delete(key(e))
                      setSelected(next)
                      setConfirming(false)
                    }}
                  />
                  <span className="backup-modal__slot">
                    {e.module} {e.slot + 1}
                  </span>
                  <span className="upload-modal__slot-name">{e.name}</span>
                </label>
              ))}
            </div>
          )}
          {confirming && (
            <div className="build-panel__warning">
              This overwrites {selected.size} slot{selected.size === 1 ? '' : 's'} on{' '}
              <strong>
                {device?.outputName} (ch {(device?.channel ?? 0) + 1})
              </strong>{' '}
              with the backed-up units. Click again to go ahead.
            </div>
          )}

          {phase.kind === 'working' && <div className="upload-modal__meta">{phase.text}</div>}
          {phase.kind === 'done' && (
            <div className="upload-modal__success">
              {phase.text}{' '}
              {phase.folder && (
                <button
                  type="button"
                  className="build-panel__hint-link"
                  onClick={() => window.axoloti.system.showItemInFolder(phase.folder!)}
                >
                  Reveal in Finder
                </button>
              )}
            </div>
          )}
          {phase.kind === 'error' && <div className="build-panel__error">{phase.text}</div>}

          <div className="upload-modal__actions">
            <button type="button" onClick={() => void scan()} disabled={busy}>
              Rescan
            </button>
            {mode === 'backup' ? (
              <button type="button" onClick={() => void runBackup()} disabled={busy || !device}>
                Back up
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void runRestore()}
                disabled={busy || !device || selected.size === 0}
              >
                {confirming
                  ? `Overwrite ${selected.size} slot${selected.size === 1 ? '' : 's'}`
                  : `Restore ${selected.size} unit${selected.size === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default DeviceBackupDialog
