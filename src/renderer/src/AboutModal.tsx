import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useDraggableModal } from './useDraggableModal'

interface LibraryEntry {
  name: string
  license: string
  author: string
}

// Only what actually ships -- this app's own runtime `dependencies` (package.json), bundled
// into out/renderer + out/main. Deliberately excludes dev-only tooling (vitest, eslint,
// playwright-core, etc.), since none of it is distributed with the app. License/author fields
// read directly off each package's own package.json/LICENSE file (node_modules/<pkg>), not from
// memory.
const APP_LIBRARIES: LibraryEntry[] = [
  { name: 'Electron', license: 'MIT', author: 'Electron contributors' },
  { name: 'React / React DOM', license: 'MIT', author: 'Meta Platforms, Inc. and affiliates' },
  { name: '@xyflow/react (React Flow)', license: 'MIT', author: 'webkid GmbH' },
  { name: 'Zustand', license: 'MIT', author: 'Paul Henschel' },
  { name: 'lucide-react', license: 'ISC', author: 'Lucide Icons and Contributors' },
  { name: '@electron-toolkit/utils', license: 'MIT', author: 'Alex Wei' }
]

function LibraryTable({ entries }: { entries: LibraryEntry[] }): React.JSX.Element {
  return (
    <div className="about-modal__table">
      {entries.map((entry) => (
        <div className="about-modal__row" key={entry.name}>
          <span className="about-modal__row-name">{entry.name}</span>
          <span className="about-modal__row-license">{entry.license}</span>
          <span className="about-modal__row-author">{entry.author}</span>
        </div>
      ))}
    </div>
  )
}

function AboutModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { modalRef, onHeaderPointerDown } = useDraggableModal()
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.axoloti.system.getAppVersion().then(setVersion)
  }, [])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={modalRef} className="modal about-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header" onPointerDown={onHeaderPointerDown}>
          <span>About Logue Patcher</span>
          <button onClick={onClose} data-tooltip="Close" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="modal__body about-modal__body">
          <div className="about-modal__identity">
            <div className="about-modal__app-name">
              Logue Patcher{version && <span className="about-modal__version"> {version}</span>}
            </div>
            <div className="about-modal__copyright">
              Copyright © 2026 Peter Witzel. Licensed under the MIT License.
            </div>
          </div>

          <div className="about-modal__section">
            <div className="about-modal__section-title">Open Source Libraries</div>
            <div className="about-modal__section-note">Bundled into the app itself.</div>
            <LibraryTable entries={APP_LIBRARIES} />
          </div>
        </div>
      </div>
    </div>
  )
}

export default AboutModal
