import type { LoguePlatform } from '@shared/domain/patch'
import { PLATFORM_LABEL } from '../browser/loguePrimitiveCatalog'
import { ALL_LOGUE_PLATFORMS } from '../state/exposedLogueParams'
import { useTargetPlatformStore } from '../state/targetPlatformStore'

/**
 * The one platform switch, shared by the Build panel and the Device Param Matrix: both drive the
 * session-global `targetPlatformStore`, so flipping either flips the other.
 */
function PlatformToggle({
  ariaLabel,
  tooltip
}: {
  ariaLabel: string
  tooltip: (platform: LoguePlatform) => string
}): React.JSX.Element {
  const current = useTargetPlatformStore((s) => s.platform)
  const setPlatform = useTargetPlatformStore((s) => s.setPlatform)
  return (
    <div className="build-panel__platform-toggle" role="group" aria-label={ariaLabel}>
      {ALL_LOGUE_PLATFORMS.map((platform) => (
        <button
          key={platform}
          type="button"
          className={
            'view-mode-pill__option' +
            (current === platform ? ' view-mode-pill__option--active' : '')
          }
          aria-pressed={current === platform}
          onClick={() => setPlatform(platform)}
          data-tooltip={tooltip(platform)}
        >
          {PLATFORM_LABEL[platform]}
        </button>
      ))}
    </div>
  )
}

export default PlatformToggle
