import type {
  PatchDocument,
  PatchNode,
  ObjNode,
  CommentNode,
  Net,
  NetSource,
  NetDest,
  PatchSettings,
  LogueModule,
  LogueTargetSettings,
  LoguePlatform,
  SampleAsset
} from '../domain/patch'
import {
  LOGUE_KNOBS,
  type ParamValue,
  type LogueParamSlot,
  type LogueKnob,
  type LogueKnobBinding
} from '../domain/paramValueTypes'
import {
  ADDITIVE_DIAL_INLETS_FILE_VERSION,
  migrateAdditiveDialInlets
} from './additiveDialInletMigration'

/**
 * The on-disk `.loguepatch` file format version -- a real, checked field (unlike the old XML
 * codec's `appVersion`, which was never actually read by anything). Bumped 1 -> 2
 * for the first real migration this codec has ever
 * needed: `ParamValue.logueParamIndex` went from a flat number to a per-platform map. Bumped
 * again, 2 -> 3, for a narrowing rather than a migration: `logueTarget.platform` is
 * dropped from the schema entirely (a document no longer has -- or needs -- a document-level
 * "current platform" at all). A v1 or v2 file's own `platform` value is simply not carried
 * forward into the decoded `PatchSettings` any more; it's still read from the RAW file for v1's
 * own `logueParamIndex` migration fallback (see `decodeLogueParamIndex`'s own doc comment), just
 * no longer through the trimmed `LogueTargetSettings` shape. All versions are still
 * readable (`parsePatchFile` migrates/narrows on load); only `PATCH_FILE_VERSION` itself (what a
 * save writes) advances -- still no general migration FRAMEWORK, just version-keyed branches,
 * since there are still only two real format changes to support. `PatchSettings.unitName`
 * (device-visible unit name) was added without a version bump, same precedent as `ParamValue.
 * label`'s own earlier addition -- a plain new optional field needs no migration branch, since
 * `optionalString` already decodes its absence on any older file as `undefined`. `ObjNode.sample`
 * (an imported granular sample) followed the same no-bump precedent, as did `ParamValue.logueKnob`/
 * `logueFollow` (fixed-knob and follower bindings), and the sample's `pcm8` encoding and loop pair
 * (an older app refuses a `pcm8` file on the encoding). 3 -> 4 is a meaning change, not a schema
 * one: the filters' `cutoff`, crossfader `fade` and additive `timbre` inlets add to their dial
 * instead of replacing it, so a v3 file's wired ones get their dial set to 0
 * (`migrateAdditiveDialInlets`) and sound the same.
 */
export const PATCH_FILE_VERSION = ADDITIVE_DIAL_INLETS_FILE_VERSION

/** Oldest file version `parsePatchFile` still accepts (and migrates). */
const MIN_SUPPORTED_FILE_VERSION = 1

/**
 * Thrown by `parsePatchFile` for anything that isn't a well-formed `.loguepatch` document --
 * malformed JSON itself throws its own native `SyntaxError`, this is specifically for JSON that
 * parses but doesn't have the shape this app can act on. File input is a real system boundary
 * (an on-disk file can be hand-edited, corrupted, or from a future/foreign version), so this
 * hand-rolled structural validation is warranted here, unlike the speculative validation this
 * project otherwise avoids for its own internal data.
 */
export class InvalidPatchFileError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function expectRecord(v: unknown, what: string): Record<string, unknown> {
  if (!isRecord(v)) throw new InvalidPatchFileError(`expected ${what} to be an object`)
  return v
}

function expectArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new InvalidPatchFileError(`expected ${what} to be an array`)
  return v
}

function expectString(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new InvalidPatchFileError(`expected ${what} to be a string`)
  return v
}

function expectNumber(v: unknown, what: string): number {
  if (typeof v !== 'number') throw new InvalidPatchFileError(`expected ${what} to be a number`)
  return v
}

function optionalString(v: unknown, what: string): string | undefined {
  return v === undefined ? undefined : expectString(v, what)
}

function optionalNumber(v: unknown, what: string): number | undefined {
  return v === undefined ? undefined : expectNumber(v, what)
}

// ---- parameter values -------------------------------------------------------------------

/**
 * `logueParamIndex` migration, v1 -> v2: a v1 file's flat number (one slot, for whichever
 * platform the whole document was committed to at the time) becomes a one-entry per-platform map
 * keyed by `fallbackPlatform` -- the RAW file's own `logueTarget.platform` if it had one, else
 * `'nts1mkii'` (arbitrary but consistent, matching this same fallback's use in
 * `exposedLogueParams.ts`) -- read straight from the undecoded JSON (`rawFallbackPlatform`) since
 * `platform` was later dropped from the decoded `LogueTargetSettings` shape itself. A v2-or-later
 * file already stores the real per-platform map directly.
 */
function decodeLogueParamIndex(
  v: unknown,
  what: string,
  fileVersion: number,
  fallbackPlatform: LoguePlatform
): LogueParamSlot | undefined {
  if (v === undefined) return undefined
  if (fileVersion === 1) {
    const legacyIndex = expectNumber(v, what)
    return { [fallbackPlatform]: legacyIndex }
  }
  const r = expectRecord(v, what)
  const slot: LogueParamSlot = {}
  const nts1mkii = optionalNumber(r.nts1mkii, `${what}.nts1mkii`)
  const minilogueXd = optionalNumber(r['minilogue-xd'], `${what}.minilogue-xd`)
  if (nts1mkii !== undefined) slot.nts1mkii = nts1mkii
  if (minilogueXd !== undefined) slot['minilogue-xd'] = minilogueXd
  return slot
}

function decodeLogueKnob(v: unknown, what: string): LogueKnobBinding | undefined {
  if (v === undefined) return undefined
  const r = expectRecord(v, what)
  const binding: LogueKnobBinding = {}
  for (const platform of ['nts1mkii', 'minilogue-xd'] as const) {
    const knob = optionalString(r[platform], `${what}.${platform}`)
    if (knob === undefined) continue
    if (!(LOGUE_KNOBS as readonly string[]).includes(knob)) {
      throw new InvalidPatchFileError(
        `expected ${what}.${platform} to be one of ${LOGUE_KNOBS.join(', ')}`
      )
    }
    binding[platform] = knob as LogueKnob
  }
  return binding
}

function encodeLogueParamIndex(slot: LogueParamSlot): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (slot.nts1mkii !== undefined) out.nts1mkii = slot.nts1mkii
  if (slot['minilogue-xd'] !== undefined) out['minilogue-xd'] = slot['minilogue-xd']
  return out
}

function decodeParamValue(
  v: unknown,
  what: string,
  fileVersion: number,
  fallbackPlatform: LoguePlatform
): ParamValue {
  const r = expectRecord(v, what)
  return {
    name: expectString(r.name, `${what}.name`),
    value: expectString(r.value, `${what}.value`),
    logueParamIndex: decodeLogueParamIndex(
      r.logueParamIndex,
      `${what}.logueParamIndex`,
      fileVersion,
      fallbackPlatform
    ),
    logueKnob: decodeLogueKnob(r.logueKnob, `${what}.logueKnob`),
    // Introduced after v1, so never the v1 flat-number shape.
    logueFollow: decodeLogueParamIndex(r.logueFollow, `${what}.logueFollow`, 2, fallbackPlatform),
    label: optionalString(r.label, `${what}.label`),
    subpatchExpose: decodeSubpatchExpose(r.subpatchExpose, `${what}.subpatchExpose`)
  }
}

function decodeSubpatchExpose(v: unknown, what: string): ParamValue['subpatchExpose'] {
  if (v === undefined) return undefined
  const r = expectRecord(v, what)
  return { outerName: expectString(r.outerName, `${what}.outerName`) }
}

function encodeParamValue(p: ParamValue): Record<string, unknown> {
  const out: Record<string, unknown> = { name: p.name, value: p.value }
  if (p.logueParamIndex !== undefined)
    out.logueParamIndex = encodeLogueParamIndex(p.logueParamIndex)
  if (p.logueKnob !== undefined) out.logueKnob = { ...p.logueKnob }
  if (p.logueFollow !== undefined) out.logueFollow = encodeLogueParamIndex(p.logueFollow)
  if (p.label !== undefined) out.label = p.label
  if (p.subpatchExpose !== undefined) out.subpatchExpose = { outerName: p.subpatchExpose.outerName }
  return out
}

// ---- nets ---------------------------------------------------------------------------------

function decodeNetSource(v: unknown, what: string): NetSource {
  const r = expectRecord(v, what)
  return {
    obj: expectString(r.obj, `${what}.obj`),
    outlet: optionalString(r.outlet, `${what}.outlet`)
  }
}

function decodeNetDest(v: unknown, what: string): NetDest {
  const r = expectRecord(v, what)
  return {
    obj: expectString(r.obj, `${what}.obj`),
    inlet: optionalString(r.inlet, `${what}.inlet`)
  }
}

function decodeNet(v: unknown, what: string): Net {
  const r = expectRecord(v, what)
  return {
    sources: expectArray(r.sources, `${what}.sources`).map((s, i) =>
      decodeNetSource(s, `${what}.sources[${i}]`)
    ),
    dests: expectArray(r.dests, `${what}.dests`).map((d, i) =>
      decodeNetDest(d, `${what}.dests[${i}]`)
    )
  }
}

function encodeNet(net: Net): Record<string, unknown> {
  return {
    sources: net.sources.map((s) => ({ obj: s.obj, outlet: s.outlet })),
    dests: net.dests.map((d) => ({ obj: d.obj, inlet: d.inlet }))
  }
}

// ---- settings -------------------------------------------------------------------------------

/**
 * Absent, or an unrecognized `module`, falls back to `undefined` rather than throwing --
 * matching this codec's general "don't invent a value the rest of the app can't act on" posture
 * for this one specific, genuinely optional field (contrast every other decoder in this file,
 * which hard-errors on a structurally broken required field -- a missing `logueTarget` is a
 * normal, handled case, not file corruption). A v1/v2 file's own `platform` key, if present, is
 * simply not read here any more -- see `rawFallbackPlatform` for the one place it's still
 * consulted, straight from the undecoded JSON.
 */
function decodeLogueTarget(v: unknown, what: string): LogueTargetSettings | undefined {
  if (v === undefined) return undefined
  const r = expectRecord(v, what)
  const targetModule = expectString(r.module, `${what}.module`)
  return (LOGUE_MODULES as readonly string[]).includes(targetModule)
    ? { module: targetModule as LogueModule }
    : undefined
}

const LOGUE_MODULES: readonly LogueModule[] = ['osc', 'modfx', 'delfx', 'revfx']

function decodeSettings(v: unknown, what: string): PatchSettings {
  const r = expectRecord(v, what)
  return {
    logueTarget: decodeLogueTarget(r.logueTarget, `${what}.logueTarget`),
    unitName: optionalString(r.unitName, `${what}.unitName`),
    subpatch: r.subpatch === true ? true : undefined
  }
}

function encodeSettings(s: PatchSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (s.logueTarget !== undefined) {
    out.logueTarget = { module: s.logueTarget.module }
  }
  if (s.unitName !== undefined) {
    out.unitName = s.unitName
  }
  if (s.subpatch) out.subpatch = true
  return out
}

/**
 * Reads a `logueTarget.platform` value straight from the RAW (undecoded) `document.settings`
 * JSON, for `decodeLogueParamIndex`'s own v1 migration fallback ONLY -- a v1 or v2 file may still
 * have one on disk even though `decodeLogueTarget`/`LogueTargetSettings` no longer carry it
 * forward. Falls back to `'nts1mkii'` for anything else (no settings, no target, no
 * platform, or an unrecognized value) -- same arbitrary-but-consistent default this fallback has
 * always used.
 */
function rawFallbackPlatform(settingsRaw: unknown): LoguePlatform {
  if (!isRecord(settingsRaw)) return 'nts1mkii'
  const targetRaw = settingsRaw.logueTarget
  if (!isRecord(targetRaw)) return 'nts1mkii'
  const platform = targetRaw.platform
  return platform === 'nts1mkii' || platform === 'minilogue-xd' ? platform : 'nts1mkii'
}

// ---- patch nodes ----------------------------------------------------------------------------

interface DecodedBase {
  type: string
  name?: string
  x: number
  y: number
}

function decodeBase(r: Record<string, unknown>, what: string): DecodedBase {
  return {
    type: expectString(r.type, `${what}.type`),
    name: optionalString(r.name, `${what}.name`),
    x: expectNumber(r.x, `${what}.x`),
    y: expectNumber(r.y, `${what}.y`)
  }
}

function encodeBase(base: DecodedBase): Record<string, unknown> {
  const out: Record<string, unknown> = { type: base.type, x: base.x, y: base.y }
  if (base.name !== undefined) out.name = base.name
  return out
}

function decodeObjNode(
  r: Record<string, unknown>,
  what: string,
  fileVersion: number,
  fallbackPlatform: LoguePlatform
): ObjNode {
  const node: ObjNode = {
    kind: 'obj',
    ...decodeBase(r, what),
    params: expectArray(r.params, `${what}.params`).map((p, i) =>
      decodeParamValue(p, `${what}.params[${i}]`, fileVersion, fallbackPlatform)
    )
  }
  if (r.sample !== undefined) node.sample = decodeSampleAsset(r.sample, `${what}.sample`)
  return node
}
function encodeObjNode(n: ObjNode): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...encodeBase(n),
    kind: 'obj',
    params: n.params.map(encodeParamValue)
  }
  if (n.sample !== undefined) out.sample = encodeSampleAsset(n.sample)
  return out
}

function decodeSampleAsset(v: unknown, what: string): SampleAsset {
  const r = expectRecord(v, what)
  const encoding = expectString(r.encoding, `${what}.encoding`)
  if (encoding !== 'mulaw8' && encoding !== 'pcm8') {
    throw new InvalidPatchFileError(`unrecognized ${what}.encoding: ${JSON.stringify(encoding)}`)
  }
  const sample: SampleAsset = {
    sourceName: expectString(r.sourceName, `${what}.sourceName`),
    rate: expectNumber(r.rate, `${what}.rate`),
    encoding,
    data: expectString(r.data, `${what}.data`)
  }
  const sourcePath = optionalString(r.sourcePath, `${what}.sourcePath`)
  if (sourcePath !== undefined) sample.sourcePath = sourcePath
  const truncated = optionalNumber(r.truncatedFromSeconds, `${what}.truncatedFromSeconds`)
  if (truncated !== undefined) sample.truncatedFromSeconds = truncated
  const resampledFrom = optionalNumber(r.resampledFromRate, `${what}.resampledFromRate`)
  if (resampledFrom !== undefined) sample.resampledFromRate = resampledFrom
  const loopStart = optionalNumber(r.loopStart, `${what}.loopStart`)
  const loopEnd = optionalNumber(r.loopEnd, `${what}.loopEnd`)
  if (loopStart !== undefined || loopEnd !== undefined) {
    const length = base64ByteLength(sample.data)
    if (
      loopStart === undefined ||
      loopEnd === undefined ||
      !Number.isInteger(loopStart) ||
      !Number.isInteger(loopEnd) ||
      loopStart < 0 ||
      loopStart >= loopEnd ||
      loopEnd > length
    ) {
      throw new InvalidPatchFileError(
        `${what} has an invalid loop (${loopStart}..${loopEnd} in ${length} samples)`
      )
    }
    sample.loopStart = loopStart
    sample.loopEnd = loopEnd
  }
  return sample
}

function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

function encodeSampleAsset(s: SampleAsset): Record<string, unknown> {
  const out: Record<string, unknown> = { sourceName: s.sourceName }
  if (s.sourcePath !== undefined) out.sourcePath = s.sourcePath
  out.rate = s.rate
  out.encoding = s.encoding
  if (s.truncatedFromSeconds !== undefined) out.truncatedFromSeconds = s.truncatedFromSeconds
  if (s.resampledFromRate !== undefined) out.resampledFromRate = s.resampledFromRate
  if (s.loopStart !== undefined && s.loopEnd !== undefined) {
    out.loopStart = s.loopStart
    out.loopEnd = s.loopEnd
  }
  out.data = s.data
  return out
}

function decodeCommentNode(r: Record<string, unknown>, what: string): CommentNode {
  return { kind: 'comment', ...decodeBase(r, what), text: expectString(r.text, `${what}.text`) }
}
function encodeCommentNode(n: CommentNode): Record<string, unknown> {
  return { ...encodeBase(n), kind: 'comment', text: n.text }
}

/**
 * A hyperlink node (an Axoloti leftover: a clickable URL/patch-file link whose target was its
 * `name`) now loads as a plain comment showing that target, so no file stops opening.
 */
function decodeHyperlinkAsComment(r: Record<string, unknown>, what: string): CommentNode {
  const { name, x, y } = decodeBase(r, what)
  return { kind: 'comment', type: 'patch/comment', x, y, text: name ?? '' }
}

function decodeNode(
  v: unknown,
  what: string,
  fileVersion: number,
  fallbackPlatform: LoguePlatform
): PatchNode {
  const r = expectRecord(v, what)
  const kind = r.kind
  if (kind === 'obj') return decodeObjNode(r, what, fileVersion, fallbackPlatform)
  if (kind === 'comment') return decodeCommentNode(r, what)
  if (kind === 'hyperlink') return decodeHyperlinkAsComment(r, what)
  throw new InvalidPatchFileError(`unrecognized ${what}.kind: ${JSON.stringify(kind)}`)
}

function encodeNode(n: PatchNode): Record<string, unknown> {
  if (n.kind === 'obj') return encodeObjNode(n)
  return encodeCommentNode(n)
}

// ---- patch document -------------------------------------------------------------------------

/** `fileVersion` defaults to `PATCH_FILE_VERSION` for callers that decode a document they
 *  already know is current (e.g. `serializeSelectionForClipboard`'s own clipboard round-trip,
 *  which never touches disk and so never sees a legacy version). */
export function decodePatchDocument(
  v: unknown,
  fileVersion: number = PATCH_FILE_VERSION
): PatchDocument {
  const r = expectRecord(v, 'document')
  const settings = decodeSettings(r.settings, 'document.settings')
  const fallbackPlatform: LoguePlatform = rawFallbackPlatform(r.settings)
  const doc: PatchDocument = {
    nodes: expectArray(r.nodes, 'document.nodes').map((n, i) =>
      decodeNode(n, `document.nodes[${i}]`, fileVersion, fallbackPlatform)
    ),
    nets: expectArray(r.nets, 'document.nets').map((n, i) => decodeNet(n, `document.nets[${i}]`)),
    settings,
    notes: expectString(r.notes, 'document.notes')
  }
  return fileVersion < ADDITIVE_DIAL_INLETS_FILE_VERSION ? migrateAdditiveDialInlets(doc) : doc
}

export function encodePatchDocument(doc: PatchDocument): Record<string, unknown> {
  return {
    nodes: doc.nodes.map(encodeNode),
    nets: doc.nets.map(encodeNet),
    settings: encodeSettings(doc.settings),
    notes: doc.notes
  }
}

/** Parses a `.loguepatch` file's text into a `PatchDocument`, migrating a v1 file's
 *  `logueParamIndex` in the process (see `decodeLogueParamIndex`). Throws `InvalidPatchFileError`
 *  (or a native `SyntaxError` for malformed JSON) on anything this app can't act on. */
export function parsePatchFile(text: string): PatchDocument {
  const parsed: unknown = JSON.parse(text)
  const r = expectRecord(parsed, 'file')
  const fileVersion = r.version
  if (
    typeof fileVersion !== 'number' ||
    fileVersion < MIN_SUPPORTED_FILE_VERSION ||
    fileVersion > PATCH_FILE_VERSION
  ) {
    throw new InvalidPatchFileError(
      `unsupported .loguepatch file version ${JSON.stringify(fileVersion)} (expected ${MIN_SUPPORTED_FILE_VERSION}-${PATCH_FILE_VERSION})`
    )
  }
  return decodePatchDocument(r, fileVersion)
}

/** Serializes a `PatchDocument` to `.loguepatch` file text -- pretty-printed so a saved file stays readable/diffable by hand. */
export function serializePatchFile(doc: PatchDocument): string {
  return (
    JSON.stringify({ version: PATCH_FILE_VERSION, ...encodePatchDocument(doc) }, null, 2) + '\n'
  )
}
