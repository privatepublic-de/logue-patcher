import { usePatchStore, usePatchTabId } from '../state/patchStore'
import { buildCanvasSessionKey, getSessionMeasurements } from './nodeMeasurements'

/**
 * The canvas's two layout actions, fed the real per-node sizes the mounted canvas session records
 * under its session key (see nodeMeasurements.ts/autoArrange.ts for why a measurement beats
 * autoArrange.ts's text-length estimate). Shared by the canvas's control stack and the Arrange
 * menu.
 */
export function useArrangeActions(): { byFlow: () => void; spreadOut: () => void } {
  const tabId = usePatchTabId()
  const filePath = usePatchStore((s) => s.filePath)
  const hasDoc = usePatchStore((s) => s.rootDoc !== null)
  const arrangeCurrentDocByFlow = usePatchStore((s) => s.arrangeCurrentDocByFlow)
  const autoArrangeCurrentDoc = usePatchStore((s) => s.autoArrangeCurrentDoc)
  const measurements = (): ReturnType<typeof getSessionMeasurements> =>
    getSessionMeasurements(buildCanvasSessionKey(tabId, filePath))
  return {
    byFlow: () => hasDoc && arrangeCurrentDocByFlow(measurements()),
    spreadOut: () => hasDoc && autoArrangeCurrentDoc(measurements())
  }
}
