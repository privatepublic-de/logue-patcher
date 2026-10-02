import { CircleOff, X } from 'lucide-react'
import { useDraggableModal } from './useDraggableModal'
import {
  PORT_COLOR_AUDIO,
  PORT_COLOR_BIPOLAR,
  PORT_COLOR_BUFFER,
  PORT_COLOR_GATE,
  PORT_COLOR_NEUTRAL,
  PORT_COLOR_UNIPOLAR,
  withAlpha
} from './canvas/portColors'

// ParamDial.tsx's own amber for a wired dial's badge.
const WIRED_BADGE_STYLE = {
  color: withAlpha(PORT_COLOR_BIPOLAR, 0.85),
  backgroundColor: withAlpha(PORT_COLOR_BIPOLAR, 0.16)
}

type DotShape = 'round' | 'square' | 'diamond' | 'ring'

interface WireLegendRow {
  color: string
  shape: DotShape
  dashed?: boolean
  label: string
  description: string
}

// Colours come from portColors.ts itself and shapes mirror outletShapeClassForBucket, so this
// legend can't drift from what the canvas actually paints. Which outlets fall in which bucket
// is each primitive's `outletPolarity` (logue-codegen/src/primitives/*).
const WIRE_LEGEND: WireLegendRow[] = [
  {
    color: PORT_COLOR_AUDIO,
    shape: 'round',
    label: 'Audio',
    description: 'The sound path. Every oscillator outlet is audio, even when it modulates.'
  },
  {
    color: PORT_COLOR_UNIPOLAR,
    shape: 'square',
    label: 'Unipolar 0…1',
    description:
      'Envelopes (ad, ahd, adsr, follower), the sense objects’ unipolar outlet, tempo’s ramp.'
  },
  {
    color: PORT_COLOR_BIPOLAR,
    shape: 'square',
    label: 'Bipolar −1…1',
    description:
      'LFOs, the multistage envelope, constants, quantize’s pitch, the sense objects’ bipolar outlet.'
  },
  {
    color: PORT_COLOR_GATE,
    shape: 'diamond',
    label: 'Gate 0/1',
    description: 'Logic objects, sense/gate, tempo’s clock, quantize’s trig, multistage’s eoc.'
  },
  {
    color: PORT_COLOR_BUFFER,
    shape: 'ring',
    label: 'Buffer',
    description: 'A recording buffer handed to its taps and grains (effects only).'
  },
  {
    color: PORT_COLOR_NEUTRAL,
    shape: 'square',
    label: 'Mixed',
    description: 'A pass-through fed two different kinds of signal. Also an unwired control inlet.'
  },
  {
    color: PORT_COLOR_BIPOLAR,
    shape: 'square',
    dashed: true,
    label: 'Broken',
    description:
      'Dashed, in its signal’s colour: a port that no longer exists, a buffer into a non-buffer inlet, or two sources into one inlet (only from an edited file).'
  }
]

interface SymbolRow {
  /** Drawn with the canvas's own classes, so it looks like what it explains. */
  sample: React.ReactNode
  label: string
  description: string
}

const INLET_AND_DIAL_ROWS: SymbolRow[] = [
  {
    sample: <span className="patch-node__inlet-mod patch-node__inlet-mod--add">±</span>,
    label: 'Adds to a dial',
    description: 'A wire here moves the dial’s value; the dial still sets the centre.'
  },
  {
    sample: <span className="patch-node__inlet-mod patch-node__inlet-mod--replace">⇥</span>,
    label: 'Replaces a dial',
    description:
      'A wire here takes over (vca gain, mux selectors); the dial does nothing while wired.'
  },
  {
    sample: <span className="patch-node__inlet-mod patch-node__inlet-mod--warn">!</span>,
    label: 'Check this wire',
    description:
      'On the inlet and the wire: a signal that doesn’t suit it, e.g. a bipolar LFO into vca gain (it would invert).'
  },
  {
    sample: (
      <span className="param-widget__wired-badge" style={WIRED_BADGE_STYLE}>
        Modulated
      </span>
    ),
    label: 'Dial, wired',
    description: 'An additive inlet is wired; the dial still applies.'
  },
  {
    sample: (
      <span className="param-widget__wired-badge" style={WIRED_BADGE_STYLE}>
        Overridden
      </span>
    ),
    label: 'Dial, replaced',
    description: 'A replacing inlet is wired; the dial is dimmed and has no effect.'
  },
  {
    sample: <CircleOff size={12} className="help-modal__muted-icon" />,
    label: 'Inactive',
    description: 'Switched off by another setting (TRACK, SYNC), on a dial or an inlet.'
  }
]

const DEVICE_CONTROL_ROWS: SymbolRow[] = [
  {
    sample: <span className="param-widget__slot-badge">n1 5</span>,
    label: 'Menu param',
    description: 'Param 5 in the device menu on the NTS-1 mkII (n1) or minilogue xd (xd).'
  },
  {
    sample: <span className="param-widget__slot-badge">xd SHP</span>,
    label: 'Knob',
    description: 'Set by a fixed knob: SHP shape, ALT/SH+ the second shape knob, TIM, DEP, MIX.'
  },
  {
    sample: <span className="param-widget__slot-badge">xd ↳3</span>,
    label: 'Follows',
    description: 'Moves with Param 3, over its own range.'
  },
  {
    sample: (
      <span className="patch-node__control-badge patch-node__control-badge--unbound">
        Not on minilogue xd
      </span>
    ),
    label: 'No control',
    description:
      'A control with nothing assigned on this device outputs its VALUE as a constant. Click to choose one.'
  }
]

const NODE_ROWS: SymbolRow[] = [
  {
    sample: <span className="help-modal__subpatch-sample" />,
    label: 'Subpatch',
    description: 'A doubled border: a placed subpatch. Double-click to edit its definition.'
  },
  {
    sample: <span className="patch-node__unresolved-badge">2 issues</span>,
    label: 'Issues',
    description: 'Something on the node won’t build (an unknown type, an outdated param or wire).'
  },
  {
    sample: (
      <span className="patch-node__unresolved-badge patch-node__unresolved-badge--info">
        Renamed
      </span>
    ),
    label: 'Renamed',
    description: 'An old type name that still works.'
  },
  {
    sample: <span className="patch-node__platform-badge">Only on NTS-1 mkII</span>,
    label: 'One device',
    description: 'This object builds for one device only.'
  }
]

function SymbolSection({ title, rows }: { title: string; rows: SymbolRow[] }): React.JSX.Element {
  return (
    <div className="help-modal__section">
      <div className="help-modal__section-title">{title}</div>
      {rows.map((row) => (
        <div className="help-modal__row help-modal__row--symbol" key={row.label}>
          <span className="help-modal__symbol">{row.sample}</span>
          <span className="help-modal__legend-label">{row.label}</span>
          <span className="help-modal__description">{row.description}</span>
        </div>
      ))}
    </div>
  )
}

interface ShortcutRow {
  keys: string[]
  description: string
}

interface ShortcutSection {
  title: string
  note?: string
  rows: ShortcutRow[]
}

// Pulled directly from where each is implemented -- src/main/index.ts's menu accelerators,
// PatchWorkspace.tsx's undo/redo handler, PatchCanvas.tsx's keydown handler,
// LoguePrimitivePalette.tsx's filter keys and TabBar.tsx -- rather than a separate list, so a
// category here is a fact about the code, not a guess.
const SECTIONS: ShortcutSection[] = [
  {
    title: 'File',
    note: 'Also shown in the menu bar.',
    rows: [
      { keys: ['⌘', 'N'], description: 'New oscillator' },
      { keys: ['⌘', '⇧', 'N'], description: 'New subpatch' },
      { keys: ['⌘', 'O'], description: 'Open…' },
      { keys: ['⌘', 'S'], description: 'Save' },
      { keys: ['⌘', '⇧', 'S'], description: 'Save As…' },
      { keys: ['⌘', ','], description: 'Settings' },
      { keys: ['⌘', '?'], description: 'This help' }
    ]
  },
  {
    title: 'Build',
    note: 'Also shown in the menu bar.',
    rows: [
      { keys: ['⌘', 'B'], description: 'Build unit' },
      { keys: ['⌘', '⇧', 'E'], description: 'Export unit source' }
    ]
  },
  {
    title: 'Edit',
    rows: [
      { keys: ['⌘', 'Z'], description: 'Undo' },
      { keys: ['⌘', '⇧', 'Z'], description: 'Redo' },
      { keys: ['⌘', 'C'], description: 'Copy selected nodes' },
      { keys: ['⌘', 'X'], description: 'Cut selected nodes' },
      { keys: ['⌘', 'V'], description: 'Paste at cursor' },
      { keys: ['⌘', 'D'], description: 'Duplicate selected nodes beside them' },
      { keys: ['Delete'], description: 'Delete selected nodes/edges' }
    ]
  },
  {
    title: 'View',
    note: 'Also shown in the menu bar.',
    rows: [
      { keys: ['⌥', '⌘', '0'], description: 'Zoom to fit' },
      { keys: ['⌥', '⌘', 'A'], description: 'Arrange by signal flow' }
    ]
  },
  {
    title: 'Add an object',
    note: 'Space opens the object search at the cursor; a palette entry dragged onto the canvas lands where it is dropped.',
    rows: [
      { keys: ['Space'], description: 'Search all objects' },
      { keys: ['C'], description: 'Add a comment' },
      { keys: ['⌘', '5'], description: 'Add a comment' }
    ]
  },
  {
    title: 'Palette',
    rows: [
      { keys: ['⌘', 'F'], description: 'Filter the palette (also /)' },
      { keys: ['Enter'], description: 'Insert the first match' },
      { keys: ['Esc'], description: 'Clear the filter' }
    ]
  },
  {
    title: 'Move',
    rows: [
      { keys: ['↑', '↓', '←', '→'], description: 'Nudge selection one grid step' },
      { keys: ['⇧', '↑', '↓', '←', '→'], description: 'Nudge selection 1px (fine)' }
    ]
  },
  {
    title: 'Tabs',
    rows: [{ keys: ['⌘', 'click'], description: "Show a tab's file in Finder" }]
  }
]

function HelpModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { modalRef, onHeaderPointerDown } = useDraggableModal()
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={modalRef} className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header" onPointerDown={onHeaderPointerDown}>
          <span>Help</span>
          <button onClick={onClose} data-tooltip="Close" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="modal__body help-modal__body">
          <div className="help-modal__heading">Wire colors</div>
          <p className="help-modal__intro">
            Wires and outlet dots are coloured by the kind of signal they carry. Inlets are round
            for audio, square for control and a ring for a buffer, and take the colour of the wire
            landing on them. Filters, VCAs, mixers, shapers, delays and math/mux objects pass on the
            colour of their audio input (a VCA follows <i>in</i>, not <i>gain</i>). Wires not
            touching the selected node are dimmed.
          </p>
          <div className="help-modal__section">
            {WIRE_LEGEND.map((row) => (
              <div className="help-modal__row" key={row.label}>
                <span className="help-modal__wire-sample" aria-hidden="true">
                  <svg width="36" height="10" viewBox="0 0 36 10">
                    <line
                      x1="0"
                      y1="5"
                      x2="28"
                      y2="5"
                      stroke={row.color}
                      strokeWidth="1.5"
                      strokeDasharray={row.dashed ? '6 4' : undefined}
                    />
                  </svg>
                  <span
                    className={`help-modal__dot help-modal__dot--${row.shape}${row.dashed ? ' help-modal__dot--stale' : ''}`}
                    style={
                      row.dashed
                        ? undefined
                        : row.shape === 'ring'
                          ? { borderColor: row.color }
                          : { backgroundColor: row.color }
                    }
                  />
                </span>
                <span className="help-modal__legend-label">{row.label}</span>
                <span className="help-modal__description">{row.description}</span>
              </div>
            ))}
          </div>
          <div className="help-modal__heading">Reading the canvas</div>
          <SymbolSection title="Inlets and dials" rows={INLET_AND_DIAL_ROWS} />
          <SymbolSection title="Device controls" rows={DEVICE_CONTROL_ROWS} />
          <SymbolSection title="Nodes" rows={NODE_ROWS} />
          <div className="help-modal__heading">Keyboard shortcuts</div>
          <p className="help-modal__intro">
            Canvas shortcuts are disabled while a text field is focused or a right-click menu is
            open, and apply to whichever tab is active.
          </p>
          {SECTIONS.map((section) => (
            <div className="help-modal__section" key={section.title}>
              <div className="help-modal__section-title">{section.title}</div>
              {section.note && <div className="help-modal__section-note">{section.note}</div>}
              {section.rows.map((row, i) => (
                <div className="help-modal__row" key={i}>
                  <span className="help-modal__keys">
                    {row.keys.map((k, j) => (
                      <kbd className="help-modal__key" key={j}>
                        {k}
                      </kbd>
                    ))}
                  </span>
                  <span className="help-modal__description">{row.description}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default HelpModal
