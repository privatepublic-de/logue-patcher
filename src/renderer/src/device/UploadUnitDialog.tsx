import { useCallback, useEffect, useState } from 'react'
import { LoaderCircle, RefreshCw, X } from 'lucide-react'
import { LogueDeviceSession } from '@logue-codegen/sysex/deviceSession'
import type { LogueUnitModule, SlotStatus } from '@logue-codegen/sysex/korgUserUnitMessages'
import { useBuildResultsStore, type BuildResultEntry } from '../state/buildResultsStore'
import { findLogueDevices, linkFor, type FoundDevice } from './midiLink'
import { useDraggableModal } from '../useDraggableModal'
import { errorMessage, prepareUnit, type PreparedUnit } from './unitUpload'
import { DEVICE_LABEL, NAME_MAX, holdsUnit, initialSlot } from './slotChoice'

type Phase =
  | { kind: 'scanning' }
  | { kind: 'no-device'; otherPlatforms: string[] }
  | { kind: 'reading-slots'; done: number; total: number }
  | { kind: 'ready' }
  | { kind: 'uploading' }
  | { kind: 'uploaded'; slot: number }
  | { kind: 'error'; message: string }

/**
 * Direct SysEx upload of a built unit (minilogue xd or NTS-1 mkII), over the native MIDI helper (see
 * `midiLink.ts`). The device's reply framing/ACK timing is still unconfirmed on real hardware
 * (`logue-codegen/harness/sysex-emu/PROTOCOL.md`), so every failure surfaces its real message
 * rather than a generic one, and nothing is retried behind the user's back.
 */
function UploadUnitDialog({
  entry,
  reason,
  onClose
}: {
  entry: BuildResultEntry
  /** Why Build & Upload couldn't go straight to a slot (`quickUpload`), shown at the top. */
  reason?: string
  onClose: () => void
}): React.JSX.Element {
  const { modalRef, onHeaderPointerDown } = useDraggableModal()
  const [unit, setUnit] = useState<PreparedUnit | null>(null)
  const [devices, setDevices] = useState<FoundDevice[]>([])
  const [deviceIndex, setDeviceIndex] = useState(0)
  const [session, setSession] = useState<LogueDeviceSession | null>(null)
  const [maxPayload, setMaxPayload] = useState<number | null>(null)
  const [slots, setSlots] = useState<SlotStatus[]>([])
  const [selectedSlot, setSelectedSlot] = useState(0)
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)
  const [alwaysReplace, setAlwaysReplace] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'scanning' })

  const busy = phase.kind === 'uploading'
  const recordUpload = useBuildResultsStore((s) => s.recordUpload)

  useEffect(() => {
    let cancelled = false
    void window.axoloti.settings.getUploadAlwaysReplace().then((value) => {
      if (!cancelled) setAlwaysReplace(value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const toggleAlwaysReplace = (value: boolean): void => {
    setAlwaysReplace(value)
    setConfirmOverwrite(false)
    void window.axoloti.settings.setUploadAlwaysReplace(value)
  }

  const connect = useCallback(
    async (module: LogueUnitModule, unitName: string, device: FoundDevice): Promise<void> => {
      const s = new LogueDeviceSession(
        linkFor(device.inputId, device.outputId),
        entry.platform,
        device.channel
      )
      await s.apiVersion()
      const info = await s.moduleInfo(module)
      setSession(s)
      setMaxPayload(info.maxPayloadSize)
      const total = info.slotCount
      const read: SlotStatus[] = []
      for (let slot = 0; slot < total; slot++) {
        setPhase({ kind: 'reading-slots', done: slot, total })
        read.push(await s.slotStatus(module, slot))
      }
      setSlots(read)
      const remembered = useBuildResultsStore.getState().uploads[entry.path]
      setSelectedSlot(
        initialSlot(read, unitName, remembered?.module === module ? remembered : undefined)
      )
      setConfirmOverwrite(false)
      setPhase({ kind: 'ready' })
    },
    [entry.platform, entry.path]
  )

  const scan = useCallback(
    async (u: PreparedUnit): Promise<void> => {
      setPhase({ kind: 'scanning' })
      setSession(null)
      setSlots([])
      try {
        const found = await findLogueDevices()
        const xds = found.filter((d) => d.platform === entry.platform)
        setDevices(xds)
        setDeviceIndex(0)
        if (xds.length === 0) {
          const others = found.map((d) =>
            d.platform ? DEVICE_LABEL[d.platform] : `Korg device 0x${d.familyId.toString(16)}`
          )
          setPhase({ kind: 'no-device', otherPlatforms: others })
          return
        }
        await connect(u.module, u.name, xds[0])
      } catch (e) {
        setPhase({ kind: 'error', message: errorMessage(e) })
      }
    },
    [connect, entry.platform]
  )

  // Scanning starts only once the unit itself is known to be uploadable -- no point probing MIDI
  // ports for a file that can't be sent anyway.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let prepared: PreparedUnit
      try {
        prepared = await prepareUnit(entry)
      } catch (e) {
        if (!cancelled) {
          setPhase({
            kind: 'error',
            message: `Couldn't read this unit: ${errorMessage(e)}`
          })
        }
        return
      }
      if (cancelled) return
      setUnit(prepared)
      await scan(prepared)
    })()
    return () => {
      cancelled = true
    }
  }, [entry, scan])

  const switchDevice = async (index: number): Promise<void> => {
    if (!unit) return
    setDeviceIndex(index)
    try {
      await connect(unit.module, unit.name, devices[index])
    } catch (e) {
      setPhase({ kind: 'error', message: errorMessage(e) })
    }
  }

  const upload = async (): Promise<void> => {
    if (!unit || !session) return
    const occupant = slots[selectedSlot]
    // Replacing this same unit is a re-upload, not an overwrite: no extra click.
    const overwrites = occupant && !occupant.empty && !holdsUnit(occupant, unit.name)
    if (overwrites && !confirmOverwrite && !alwaysReplace) {
      setConfirmOverwrite(true)
      return
    }
    setPhase({ kind: 'uploading' })
    try {
      await session.upload(unit.module, selectedSlot, unit.body)
      const refreshed = await session.slotStatus(unit.module, selectedSlot).catch(() => undefined)
      if (refreshed) setSlots((prev) => prev.map((st, i) => (i === selectedSlot ? refreshed : st)))
      setConfirmOverwrite(false)
      recordUpload(entry.path, {
        device: devices[deviceIndex]?.outputName ?? '',
        module: unit.module,
        slot: selectedSlot
      })
      setPhase({ kind: 'uploaded', slot: selectedSlot })
    } catch (e) {
      setPhase({ kind: 'error', message: `Couldn't upload: ${errorMessage(e)}` })
    }
  }

  const tooLarge = unit !== null && maxPayload !== null && unit.body.length > maxPayload
  const occupant = slots[selectedSlot]
  const canUpload =
    session !== null && !tooLarge && ['ready', 'uploaded', 'error'].includes(phase.kind)
  const device = devices[deviceIndex]

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div ref={modalRef} className="modal upload-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header" onPointerDown={onHeaderPointerDown}>
          <span>Upload to {DEVICE_LABEL[entry.platform]}</span>
          <button onClick={onClose} disabled={busy} data-tooltip="Close" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="modal__body">
          {reason && (
            <div className="upload-modal__meta">Build &amp; Upload needs a slot: {reason}.</div>
          )}
          <div className="upload-modal__unit">
            <span className="upload-modal__unit-name">{unit?.name ?? entry.unitName}</span>
            {unit && (
              <span className="upload-modal__meta">
                {(unit.body.length / 1024).toFixed(1)} KB · {unit.module}
              </span>
            )}
          </div>
          {unit?.truncatedName && (
            <div className="build-panel__warning">
              The device shows at most {NAME_MAX} characters -- this unit will appear as &quot;
              {unit.truncatedName}&quot;.
            </div>
          )}

          {/* No firmware shown: the real xd's Search Device version bytes (02 00 0a 00) only read as a
              real release (2.10) in the opposite order from the spec's, so either reading could be
              wrong on some other device. */}
          <div className="upload-modal__device">
            {devices.length > 1 && (
              <select
                value={deviceIndex}
                disabled={busy}
                aria-label="Device"
                onChange={(e) => void switchDevice(Number(e.target.value))}
              >
                {devices.map((d, i) => (
                  <option key={d.outputId} value={i}>
                    {d.outputName} (ch {d.channel + 1})
                  </option>
                ))}
              </select>
            )}
            {devices.length === 1 && device && (
              <span className="upload-modal__meta upload-modal__device-name">
                {device.outputName} · global channel {device.channel + 1}
              </span>
            )}
            <button
              type="button"
              className="upload-modal__rescan"
              onClick={() => unit && void scan(unit)}
              disabled={busy || !unit}
              data-tooltip="Rescan: look for the device again and re-read its slots"
              aria-label="Rescan"
            >
              <RefreshCw size={13} />
            </button>
          </div>

          {phase.kind === 'scanning' && (
            <div className="upload-modal__meta upload-modal__progress">
              <LoaderCircle size={12} className="icon-spin" aria-hidden="true" />
              Looking for a {DEVICE_LABEL[entry.platform]}…
            </div>
          )}
          {phase.kind === 'reading-slots' && (
            <div className="upload-modal__meta upload-modal__progress">
              <LoaderCircle size={12} className="icon-spin" aria-hidden="true" />
              Reading slots {phase.done + 1}/{phase.total}…
            </div>
          )}
          {phase.kind === 'no-device' && (
            <div className="build-panel__warning">
              No {DEVICE_LABEL[entry.platform]} answered. Connect it over USB and make sure
              it&apos;s switched on.
              {phase.otherPlatforms.length > 0 && (
                <>
                  {' '}
                  Found: {phase.otherPlatforms.join(', ')} -- direct upload isn&apos;t supported for
                  it yet.
                </>
              )}
            </div>
          )}

          {slots.length > 0 && (
            <div className="upload-modal__slots" role="radiogroup" aria-label="Target slot">
              {slots.map((st, i) => (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={i === selectedSlot}
                  disabled={busy}
                  className={`upload-modal__slot${i === selectedSlot ? ' upload-modal__slot--selected' : ''}${st.empty ? ' upload-modal__slot--empty' : ''}`}
                  onClick={() => {
                    setSelectedSlot(i)
                    setConfirmOverwrite(false)
                  }}
                >
                  <span className="upload-modal__slot-index">{i + 1}</span>
                  <span className="upload-modal__slot-name">
                    {st.empty ? 'empty' : st.name || '(unnamed)'}
                  </span>
                </button>
              ))}
            </div>
          )}

          {tooLarge && unit && maxPayload !== null && (
            <div className="build-panel__error">
              This unit is {unit.body.length} bytes; the device accepts at most {maxPayload}.
            </div>
          )}

          <div className="upload-modal__actions">
            <label
              className="upload-modal__always-replace"
              data-tooltip="Upload into an occupied slot without the extra Replace click"
            >
              <input
                type="checkbox"
                className="param-widget__checkbox-input"
                checked={alwaysReplace}
                disabled={busy}
                onChange={(e) => toggleAlwaysReplace(e.target.checked)}
              />
              Always replace
            </label>
            <button
              type="button"
              className="upload-modal__primary"
              onClick={() => void upload()}
              disabled={!canUpload}
            >
              {unit && holdsUnit(occupant, unit.name)
                ? `Update slot ${selectedSlot + 1}`
                : confirmOverwrite || (alwaysReplace && occupant && !occupant.empty)
                  ? `Replace slot ${selectedSlot + 1}`
                  : `Upload to slot ${selectedSlot + 1}`}
            </button>
          </div>
          {/* Below the buttons and always its full height, so a message appearing doesn't grow the
              modal and shift it (and the button just clicked) under the pointer. */}
          <div className="upload-modal__status" role="status" aria-live="polite">
            {confirmOverwrite && occupant && !occupant.empty && (
              <div className="upload-modal__notice">
                Slot {selectedSlot + 1} holds &quot;{occupant.name || '(unnamed)'}&quot;. Upload
                again to replace it.
              </div>
            )}
            {phase.kind === 'uploading' && (
              <div className="upload-modal__progress">
                <LoaderCircle size={12} className="icon-spin" aria-hidden="true" />
                Uploading to slot {selectedSlot + 1}…
              </div>
            )}
            {phase.kind === 'uploaded' && (
              <div className="upload-modal__success">Uploaded to slot {phase.slot + 1}.</div>
            )}
            {phase.kind === 'error' && <div className="build-panel__error">{phase.message}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

export default UploadUnitDialog
