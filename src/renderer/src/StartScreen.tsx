import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import type { LogueEffectModule } from '@shared/domain/patch'
import { NEW_EFFECT_LABEL } from './tabs/TabBar'
import { abbreviateHome, basenamePath } from './util/paths'
import mascotUrl from './assets/mascot.png'

/**
 * What the window shows with no tab open: every way to start (the same choices as File › New,
 * plus Open), and the recently opened or saved patches (`patchFile.listRecent`), newest first.
 */
function StartScreen({
  onNewOsc,
  onNewEffect,
  onNewSubpatch,
  onOpen,
  onOpenRecent
}: {
  onNewOsc: () => void
  onNewEffect: (module: LogueEffectModule) => void
  onNewSubpatch: () => void
  onOpen: () => void
  onOpenRecent: (path: string) => void
}): React.JSX.Element {
  const [recent, setRecent] = useState<string[]>([])
  useEffect(() => {
    window.axoloti.patchFile.listRecent().then(setRecent)
  }, [])

  return (
    <div className="app-empty-state">
      <img className="app-empty-state__mascot" src={mascotUrl} alt="" />
      <div className="app-empty-state__buttons">
        <button onClick={onNewOsc}>New Oscillator</button>
        {(Object.keys(NEW_EFFECT_LABEL) as LogueEffectModule[]).map((module) => (
          <button key={module} onClick={() => onNewEffect(module)}>
            {NEW_EFFECT_LABEL[module]}
          </button>
        ))}
        <button onClick={onNewSubpatch}>New Subpatch</button>
      </div>
      <div className="app-empty-state__buttons">
        <button onClick={onOpen}>Open…</button>
      </div>
      {recent.length > 0 && (
        <div className="app-empty-state__recent">
          <div className="app-empty-state__recent-title">Recent</div>
          {recent.map((path) => (
            <button
              key={path}
              className="app-empty-state__recent-item"
              onClick={() => onOpenRecent(path)}
              data-tooltip={path}
            >
              <FileText size={13} />
              <span className="app-empty-state__recent-name">{basenamePath(path)}</span>
              <span className="app-empty-state__recent-folder">
                {abbreviateHome(path.slice(0, path.lastIndexOf('/')))}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default StartScreen
