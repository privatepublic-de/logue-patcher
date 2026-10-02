import type { ParamValue } from './paramValueTypes'

/** Common fields every patch-node kind carries. */
interface PatchNodeBase {
  type: string
  name?: string
  x: number
  y: number
}

/**
 * An object instance, addressed by `type` (a slash-path like "logue/osc/sine"). The only node
 * kind that carries real DSP-graph content: a *logue patcher has no library to resolve against,
 * so `type` is an explicit, self-describing string with no separate definition lookup (see
 * LoguePrimitivePalette.tsx) -- ports/params come from `logue-codegen`'s own fixed primitive
 * table, not a scanned/embedded object definition.
 */
export interface ObjNode extends PatchNodeBase {
  kind: 'obj'
  params: ParamValue[]
  /** Only on a sample-reading primitive (`logue/osc/granular`). Lives on the node, not in a
   *  document-level table, so copy/paste and subpatch flattening carry it without extra work;
   *  codegen dedupes identical samples by content hash. */
  sample?: SampleAsset
}

/**
 * An imported sample, already processed into exactly what gets baked into the unit: mono, one
 * byte per sample. The source file itself is never kept -- re-importing at another size needs
 * the file again (`sourcePath` is a hint for that, not a dependency).
 */
export interface SampleAsset {
  sourceName: string
  sourcePath?: string
  /** Stored sample rate in Hz. Granular's import derives it from the chosen size; the plain
   *  (`logue/osc/sample`) import keeps the source's own rate unless it had to downsample. */
  rate: number
  /** `mulaw8`: G.711 mu-law (granular's import). `pcm8`: linear signed 8-bit, two's complement
   *  (the plain import -- an 8-bit source is stored bit-exactly). */
  encoding: SampleEncoding
  /** Base64 of the stored bytes. */
  data: string
  /** Set when the source was too long to fit and its tail was cut. */
  truncatedFromSeconds?: number
  /** Set when the plain import had to downsample to fit: the source's own rate. */
  resampledFromRate?: number
  /** A forward loop in stored samples, `loopEnd` exclusive; both or neither. */
  loopStart?: number
  loopEnd?: number
}

export type SampleEncoding = 'mulaw8' | 'pcm8'

/** A freeform text annotation. */
export interface CommentNode extends PatchNodeBase {
  kind: 'comment'
  text: string
}

export type PatchNode = ObjNode | CommentNode

/** One endpoint of a net. */
export interface NetSource {
  obj: string
  outlet?: string
}

export interface NetDest {
  obj: string
  inlet?: string
}

/**
 * A connection. Modeled as one-or-more sources and one-or-more dests even though every
 * real-world net has exactly one source today -- nothing enforces that at this layer, so
 * narrowing to a single source here would be an assumption this project doesn't need to make.
 */
export interface Net {
  sources: NetSource[]
  dests: NetDest[]
}

/** The Korg *logue SDK unit types: an oscillator, or one of the three effect slots. */
export type LogueModule = 'osc' | 'modfx' | 'delfx' | 'revfx'
export type LogueEffectModule = Exclude<LogueModule, 'osc'>

/**
 * `module` identifies which Korg *logue SDK unit type this document targets. Only `'osc'` can be
 * built so far (`logue-codegen/src/unitKinds.ts` has no effect entries yet, and
 * `resolvePlatformGraph` rejects a module without one); the effect modules decode and round-trip
 * so a document can already carry one. `undefined` (no `logueTarget` at
 * all) is still a real, permitted case -- a hand-edited or foreign `.loguepatch` file may not
 * carry one; the UI (LoguePrimitivePalette.tsx, BuildPanel.tsx) already treats that as "nothing to
 * show/build" rather than assuming every loaded document has a target.
 *
 * **No `platform` field** -- a document is fully
 * platform-agnostic, never committed to (or even currently "viewing") one platform. Earlier
 * phases (1-7) carried a `platform` here first as a document commitment, then as a mutable
 * "viewing platform" toggle backing a canvas-toolbar UI -- phase 8 removed that toggle outright
 * once the Device Param Matrix (phase 5) made it possible to see/edit both platforms' own param
 * slots at once with nothing to switch. `platform` as a concept still exists everywhere real
 * per-platform data lives (`LoguePlatform`, `ParamValue.logueParamIndex`, `LoguePrimitive.
 * platforms?`) -- it's only gone from here, since nothing needs a document-level "current
 * platform" any more. The one place a platform is still chosen is `BuildPanel.tsx`'s own local,
 * non-persisted build-target selector, decided fresh at the moment of clicking Export/Build.
 */
export interface LogueTargetSettings {
  module: LogueModule
}

/** The bare platform literal -- used anywhere real per-platform data lives (param slot maps,
 *  primitive platform restrictions, badges), independently of `LogueTargetSettings` (which no
 *  longer carries a platform at all, see its own doc comment). Not derived from
 *  `LogueTargetSettings` any more since phase 8 -- this is now the one canonical source. */
export type LoguePlatform = 'nts1mkii' | 'minilogue-xd'

export interface PatchSettings {
  logueTarget?: LogueTargetSettings
  /**
   * The device-visible unit/patch name -- what shows on the instrument's own menu when this
   * patch is selected (`manifest.json`'s `header.name` on minilogue xd, `unit_header_t.name` on
   * NTS-1 mkII). Optional and separate from the `.loguepatch` file's own filename: when unset,
   * `BuildPanel.tsx`'s `currentUnitName` falls back to the filename, matching this app's original
   * (pre-this-field) behavior -- an explicit `unitName` is only ever an override a user typed.
   */
  unitName?: string
  /**
   * Marks this document as a subpatch DEFINITION (a `.loguesub` file) rather than a buildable
   * root patch: it has no `logue/io/audio-out`, declares its ports via `logue/io/inlet`/
   * `logue/io/outlet` nodes instead, and is only ever placed as a `sub/<path>` instance inside
   * another document. The authoritative check -- not the file extension, since a never-saved
   * subpatch tab has no path yet.
   */
  subpatch?: true
}

/**
 * A full patch document -- one flat DSP graph. Subpatches are never nested inline: a subpatch
 * instance is an ordinary `ObjNode` whose `type` (`sub/<path>`) references a separate
 * `.loguesub` definition file, flattened into one graph only at codegen time
 * (`logue-codegen/src/subpatches.ts`).
 */
export interface PatchDocument {
  nodes: PatchNode[]
  nets: Net[]
  settings: PatchSettings
  notes: string
}
