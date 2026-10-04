import {
  findLoguePrimitive,
  formerPrimitiveIds,
  recognizedLoguePrimitiveIds
} from '@logue-codegen/primitives'
import {
  isSubpatchInstanceType,
  subpatchContains,
  LOGUE_SUBPATCH_INLET_TYPE,
  LOGUE_SUBPATCH_OUTLET_TYPE,
  LOGUE_SUBPATCH_INLET_DESCRIPTION,
  LOGUE_SUBPATCH_OUTLET_DESCRIPTION,
  SUBPATCH_TYPE_PREFIX
} from '@logue-codegen/subpatches'
import {
  BUS_NODE_TYPES,
  busesIn,
  isBusNodeType,
  LOGUE_BUS_RECEIVE_STEREO_TYPE,
  LOGUE_BUS_RECEIVE_TYPE,
  LOGUE_BUS_SEND_STEREO_TYPE,
  LOGUE_BUS_SEND_TYPE
} from '@logue-codegen/buses'
import type { LogueModule, LoguePlatform, PatchDocument } from '@shared/domain/patch'
import type { LogueKnob, ParamValue } from '@shared/domain/paramValueTypes'
import type { SubpatchLibraryEntry } from '@shared/ipc/contract'
import { ALL_LOGUE_PLATFORMS, PLATFORM_LABEL } from '../state/exposedLogueParams'
import { resolveNodePrimitive } from '../state/subpatchLibraryStore'
import { defaultNodeName } from '../state/patchDocHelpers'

/** Re-exported so every existing `from './loguePrimitiveCatalog'` import keeps working --
 *  `PLATFORM_LABEL` itself is defined in `exposedLogueParams.ts` (see that file's own doc
 *  comment on why: `describeExposedSlots` needs it, and that module can't import this one back
 *  without a cycle, since this module already imports `ALL_LOGUE_PLATFORMS` from it). */
export { PLATFORM_LABEL }

/**
 * Shared between `LoguePrimitivePalette.tsx` (the sidebar tree) and the canvas double-click
 * object-insert popup -- both browse the same `logue-codegen` primitive registry and need the
 * same id -> label/category derivation, so it lives here once rather than duplicated across the
 * two UIs. Neither UI filters by platform any more --
 * every primitive is always insertable; platform support is an advisory, per-node canvas badge
 * after placement, not a placement gate -- `supportsPlatform`/`unsupportedPlatforms` below still
 * live here since they're what compute that badge.
 */

/** A two-letter tag for `ParamDial.tsx`'s own compact per-platform slot badges --
 *  deliberately terser than `PLATFORM_LABEL`, which
 *  is for a tooltip/status line with room to spell the platform out; the on-canvas badge itself
 *  has to stay small enough to sit two-up on a param's own value row without crowding it. */
export const PLATFORM_TAG: Record<'nts1mkii' | 'minilogue-xd', string> = {
  nts1mkii: 'n1',
  'minilogue-xd': 'xd'
}

/** `logue/osc/sine` -> `sine`, `logue/io/audio-out` -> `audio out` -- derives automatically as `primitives.ts`'s registry grows, no palette edit needed per new primitive. Left lowercase (not title-cased) on request -- a plain lowercase label reads as a raw identifier, closer to the id it's derived from. */
export function labelForPrimitiveId(id: string): string {
  const last = id.split('/').pop() ?? id
  return last.split('-').join(' ')
}

export function shortIdForPrimitiveId(id: string): string {
  return id.split('/').pop() ?? id
}

/**
 * `logue/osc/sine` -> `osc`, `logue/io/audio-out` -> `io` -- the id's own middle path segment
 * IS this project's real category vocabulary (osc/mix/filter/gain/env/lfo/sense/io/shape/util)
 * already; no separate category table to keep in sync as the registry grows.
 */
export function categoryForPrimitiveId(id: string): string {
  // `sub/bass/pluck` -> `subpatch/bass`: one palette group per library subfolder, all sharing
  // the subpatch colour and sorting together.
  if (isSubpatchInstanceType(id)) {
    const folders = id.slice(SUBPATCH_TYPE_PREFIX.length).split('/').slice(0, -1)
    return [SUBPATCH_CATEGORY, ...folders].join('/')
  }
  return id.split('/')[1] ?? 'other'
}

export const SUBPATCH_CATEGORY = 'subpatch'
/** The subpatches next to the open patch (`SubpatchLibraryEntry.source` `local`): one group, shown
 *  ahead of the library's. */
export const LOCAL_SUBPATCH_CATEGORY = `${SUBPATCH_CATEGORY}/this folder`

/**
 * One fixed, distinct color per category (`categoryForPrimitiveId`'s own vocabulary) -- evenly
 * spaced hues at matched saturation/lightness so no two categories are any harder to tell apart
 * than any other pair, deliberately independent of `portColors.ts`'s audio/control colors (a
 * different dimension entirely: a wire's role, not its source primitive's category). Same color,
 * same meaning everywhere a category shows up: the browser dots (`LoguePrimitivePalette.tsx`,
 * `ObjectInsertPopup.tsx`) and the canvas node's own titlebar tint (`ObjectNode.tsx`).
 *
 * Re-derived again (2026-09-25, `logue/mux/*` added) as 13 evenly spaced stops -- was 12 as of
 * `logue/logic/*`'s own addition, 11 as of `logue/math/*`'s, 10 originally. Same anchor hue
 * (`env`'s own `#d46549`) and saturation/lightness each time, so every existing category's color
 * shifts slightly rather than bolting a new one onto an already-full wheel at a cramped, uneven
 * angle. A disclosed, one-time cosmetic reflow per addition: these colors aren't stored in any
 * `.loguepatch` file, only computed live from the registry's own category vocabulary, so there's
 * no save-compatibility concern.
 */
export const CATEGORY_COLORS: Record<string, string> = {
  // Not a DSP category -- the comment entry's own group (see COMMENT_ENTRY). A muted warm grey,
  // outside the evenly spaced hue wheel, so it reads as "not a primitive".
  annotate: '#a89f91',
  env: '#d46549',
  filter: '#d4a549',
  gain: '#c3d449',
  io: '#83d449',
  lfo: '#49d450',
  logic: '#49d490',
  math: '#49d4d0',
  mix: '#4998d4',
  mux: '#4958d4',
  osc: '#7a49d4',
  sense: '#bb49d4',
  shape: '#d449ad',
  util: '#d4496d'
}

/** Only ever reached by `categoryForPrimitiveId`'s own 'other' fallback, which no real registry id produces today -- kept so an id that somehow doesn't match the usual `logue/<cat>/<name>` shape still gets *a* color rather than a lookup crash. */
const CATEGORY_COLOR_FALLBACK = '#8a8a8a'

/** Like `annotate`, outside the evenly spaced hue wheel -- a user-made grouping, not a DSP
 *  category, so adding it doesn't reflow every other category's colour. */
const SUBPATCH_COLOR = '#e0e0e0'

export function colorForCategory(category: string): string {
  if (isSubpatchCategory(category)) {
    return SUBPATCH_COLOR
  }
  return CATEGORY_COLORS[category] ?? CATEGORY_COLOR_FALLBACK
}

/**
 * `logue/osc/sine` -> `osc/sine` -- the "logue/" root is implied everywhere this kind of label
 * shows (every id this app can insert has it), so spelling it out on every single node is pure
 * repetition. Left as-is for anything that doesn't start with it (a legacy Axoloti type already
 * has no such prefix, e.g. "env/adsr").
 */
export function stripLoguePrefix(id: string): string {
  return id.startsWith('logue/') ? id.slice('logue/'.length) : id
}

/**
 * The first primitives that aren't platform-agnostic
 * (`logue/sense/*`, minilogue-xd-only). No longer used to filter what's insertable (every
 * primitive is always insertable) -- only to compute
 * `ObjectNode.tsx`'s own advisory "Only on X" badge (`restrictedPlatforms` below); the real,
 * blocking enforcement is still `assertPrimitivesSupportPlatform` (`oscInstances.ts`) at
 * export/build time.
 */
export function supportsPlatform(id: string, platform: LoguePlatform): boolean {
  const platforms = resolveNodePrimitive(id)?.platforms
  return !platforms || platforms.includes(platform)
}

/** Every platform `id` does NOT support, in `ALL_LOGUE_PLATFORMS` order -- `[]` for a
 *  platform-agnostic primitive (most of the registry). Superseded by `restrictedPlatforms` below
 *  for `ObjectNode.tsx`'s own badge ("Not on X" read as an odd double-negative next to "Only on
 *  Y") but kept as a real, independently useful, tested query in its own right. */
export function unsupportedPlatforms(id: string): LoguePlatform[] {
  const platforms = resolveNodePrimitive(id)?.platforms
  if (!platforms) return []
  return ALL_LOGUE_PLATFORMS.filter((p) => !platforms.includes(p))
}

/** The platforms `id` is EXCLUSIVELY supported on, in `ALL_LOGUE_PLATFORMS` order -- `[]` for a
 *  platform-agnostic primitive (most of the registry, `platforms` unset). `ObjectNode.tsx`'s own
 *  badge lists whichever platform(s) this returns as "Only on X" -- today that's always exactly
 *  `['minilogue-xd']` for every restricted primitive (all of them are minilogue-xd-only), but
 *  this generalizes for free if a genuinely NTS-1-only primitive is ever added (multiple entries
 *  join into one badge -- see ObjectNode.tsx -- rather than one badge per platform, since "Only
 *  on X" read per-item would misleadingly imply mutual exclusivity for a primitive that ever
 *  ends up supported on more than one platform but not all of them). */
export function restrictedPlatforms(id: string): LoguePlatform[] {
  const platforms = resolveNodePrimitive(id)?.platforms
  if (!platforms) return []
  return ALL_LOGUE_PLATFORMS.filter((p) => platforms.includes(p))
}

export interface PrimitiveCatalogEntry {
  id: string
  label: string
  category: string
  /** The primitive's user-facing `description`, shown on hover in the palette and in the insert
   *  search's side column. */
  description: string
}

/**
 * Every insertable id -- no platform filter (every
 * primitive is always insertable regardless of platform support; see
 * `supportsPlatform`/`unsupportedPlatforms` above for the advisory badge that replaces
 * filtering). Unsorted -- callers group/sort for their own presentation.
 *
 * Deliberately excludes the fixed `logue/io/audio-out` sink: `newDoc`/`patchStore.ts` now seeds
 * every fresh document with exactly one, permanently (`deleteNodes` refuses to remove it), so
 * there's no longer a "place one" gesture for either the sidebar palette or the canvas
 * double-click popup to offer -- both of them just call this function with no audio-out-specific
 * code of their own (see their own doc comments).
 */
export function listInsertablePrimitives(module?: LogueModule): PrimitiveCatalogEntry[] {
  // A superseded primitive still builds in older documents but is never placed anew; one that
  // can't work in `module` (an oscillator-only sense reader in an effect, the SDRAM delay in an
  // oscillator) is hidden rather than badged, since it can never build there (user's call,
  // 2026-09-30). No `module` (a subpatch definition) offers everything.
  const ids = recognizedLoguePrimitiveIds().filter((id) => {
    const p = findLoguePrimitive(id)
    return !p?.supersededBy && !p?.internal && worksIn(p?.modules, module)
  })
  return [...ids, ...BUS_NODE_TYPES].map((id) => ({
    id,
    label: labelForPrimitiveId(id),
    category: categoryForPrimitiveId(id),
    description: resolveNodePrimitive(id)?.description ?? ''
  }))
}

/** The little a bus preset needs to know: cheap to compare, so a hook can select it per edit. */
export interface BusPresetSource {
  name: string
  stereo: boolean
  sends: number
}

/** `busPresetEntries`' input for a document, as one string so a store selector compares it by
 *  value (a dial drag doesn't re-render the palette). A mixed bus (an export error) is left out. */
export function busPresetKey(doc: PatchDocument | null | undefined): string {
  if (!doc) return '[]'
  const sources: BusPresetSource[] = busesIn(doc.nodes)
    .filter((b) => !b.mixed)
    .map((b) => ({ name: b.name, stereo: b.stereo, sends: b.sends.length }))
  return JSON.stringify(sources)
}

/**
 * One send and one receive preset per bus the document already uses (`logue/mix/send@verb`),
 * so the second send to a bus is one pick in the insert search. Insert-only, like the control
 * presets.
 */
export function busPresetEntries(buses: BusPresetSource[]): PrimitiveCatalogEntry[] {
  const plural = (n: number): string => `${n} send${n === 1 ? '' : 's'}`
  return buses.flatMap((b) => {
    const shown = b.name || '(unnamed)'
    const [sendType, receiveType] = b.stereo
      ? [LOGUE_BUS_SEND_STEREO_TYPE, LOGUE_BUS_RECEIVE_STEREO_TYPE]
      : [LOGUE_BUS_SEND_TYPE, LOGUE_BUS_RECEIVE_TYPE]
    const kind = b.stereo ? 'stereo bus' : 'bus'
    return [
      {
        id: `${sendType}@${b.name}`,
        label: `send → ${shown}`,
        category: 'mix',
        description: `A send onto the ${kind} "${shown}" (${plural(b.sends)} so far).`
      },
      {
        id: `${receiveType}@${b.name}`,
        label: `receive ${shown}`,
        category: 'mix',
        description: `Reads the ${kind} "${shown}": the sum of its ${plural(b.sends)}.`
      }
    ]
  })
}

/**
 * The canvas comment, offered next to the primitives in both the palette and the insert search
 * so it's discoverable beyond the C shortcut. Not a primitive: it generates no code, so it gets
 * its own `annotate` group rather than sitting among util's DSP helpers, and callers insert it
 * via `insertComment` instead of `insertSpecialObject`.
 */
export const COMMENT_ENTRY: PrimitiveCatalogEntry = {
  id: 'patch/comment',
  label: 'comment',
  category: 'annotate',
  description: 'A free-text note on the canvas, for labelling parts of a patch. Generates no code.'
}

/**
 * Ready-made `logue/sense/control` nodes already on a fixed knob (on both devices), so "I want
 * the Shape knob" is one pick in the palette or insert search. Offered only for inserting, not in
 * "Replace with…". A menu param has no preset: it needs a slot order and a name, the Param
 * Matrix's job. The `@knob` id suffix only identifies the entry; the node is a plain control.
 */
const CONTROL_PRESETS: Array<{
  knob: LogueKnob
  label: string
  shortId: string
  what: string
  modules: readonly LogueModule[]
}> = [
  {
    knob: 'shape',
    label: 'control · shape knob',
    shortId: 'shape',
    what: 'the SHAPE knob',
    modules: ['osc']
  },
  {
    knob: 'shape-2',
    label: 'control · 2nd shape knob',
    shortId: 'shape2',
    what: 'the second Shape knob (ALT-SHAPE on NTS-1 mkII, SHIFT+SHAPE on minilogue xd)',
    modules: ['osc']
  },
  {
    knob: 'time',
    label: 'control · time knob',
    shortId: 'time',
    what: "the effect's TIME knob",
    modules: ['modfx', 'delfx', 'revfx']
  },
  {
    knob: 'depth',
    label: 'control · depth knob',
    shortId: 'depth',
    what: "the effect's DEPTH knob",
    modules: ['modfx', 'delfx', 'revfx']
  },
  {
    knob: 'mix',
    label: 'control · mix',
    shortId: 'mix',
    what: 'the dry/wet control (MIX on NTS-1 mkII, SHIFT+DEPTH on minilogue xd)',
    modules: ['delfx', 'revfx']
  }
]

const DEVICE_CONTROL_TYPE = 'logue/sense/control'

/** The control presets for a document of `module`'s kind (all of them for a definition). */
export function controlPresetEntries(module?: LogueModule): PrimitiveCatalogEntry[] {
  return CONTROL_PRESETS.filter((p) => !module || p.modules.includes(module)).map((p) => ({
    id: `${DEVICE_CONTROL_TYPE}@${p.knob}`,
    label: p.label,
    category: 'sense',
    description: `A device control on ${p.what}, on both devices: its outlets follow the knob${p.knob === 'shape' ? " (and the device's Mod LFO)" : ''}. Change it by clicking its badge.`
  }))
}

function worksIn(modules: readonly LogueModule[] | undefined, module?: LogueModule): boolean {
  return !module || !modules || modules.includes(module)
}

/** What placing catalog entry `id` inserts: its node type, the name to number from, and (for a
 *  control preset) the params it starts with. */
export function insertArgsFor(id: string): {
  type: string
  shortId: string
  params?: ParamValue[]
  bus?: string
} {
  const at = id.indexOf('@')
  if (at > 0 && isBusNodeType(id.slice(0, at))) {
    const type = id.slice(0, at)
    return { type, shortId: defaultNodeName(type), bus: id.slice(at + 1) }
  }
  const preset = CONTROL_PRESETS.find((p) => id === `${DEVICE_CONTROL_TYPE}@${p.knob}`)
  if (!preset) return { type: id, shortId: defaultNodeName(id) }
  return {
    type: DEVICE_CONTROL_TYPE,
    shortId: preset.shortId,
    params: [
      {
        name: 'VALUE',
        value: '50',
        logueKnob: { nts1mkii: preset.knob, 'minilogue-xd': preset.knob }
      }
    ]
  }
}

/** A subpatch definition's own port nodes -- only offered while editing a subpatch. */
export const SUBPATCH_PORT_ENTRIES: PrimitiveCatalogEntry[] = [
  {
    id: LOGUE_SUBPATCH_INLET_TYPE,
    label: 'inlet',
    category: 'io',
    description: LOGUE_SUBPATCH_INLET_DESCRIPTION
  },
  {
    id: LOGUE_SUBPATCH_OUTLET_TYPE,
    label: 'outlet',
    category: 'io',
    description: LOGUE_SUBPATCH_OUTLET_DESCRIPTION
  }
]

/**
 * The library's subpatches as palette entries. `editingType` is the definition currently being
 * edited (if any): it and anything that already contains it are left out, since placing either
 * would make the definition contain itself. Unparseable files are left out too -- they have no
 * interface to place.
 */
export function listSubpatchEntries(
  library: SubpatchLibraryEntry[],
  defs: ReadonlyMap<string, PatchDocument>,
  editingType?: string,
  module?: LogueModule
): PrimitiveCatalogEntry[] {
  return library
    .filter((entry) => entry.doc)
    .filter((entry) => !editingType || !subpatchContains(defs, entry.type, editingType))
    .filter((entry) => worksIn(resolveNodePrimitive(entry.type)?.modules, module))
    .map((entry) => ({
      id: entry.type,
      label: labelForPrimitiveId(entry.type),
      category:
        entry.source === 'local' ? LOCAL_SUBPATCH_CATEGORY : categoryForPrimitiveId(entry.type),
      description: resolveNodePrimitive(entry.type)?.description ?? ''
    }))
}

function isSubpatchCategory(category: string): boolean {
  return category === SUBPATCH_CATEGORY || category.startsWith(`${SUBPATCH_CATEGORY}/`)
}

/**
 * Palette/popup category order: native categories alphabetical (axoloti-factory's own A-Z
 * precedent), then every `subpatch/*` group after them, the patch folder's own first. The library grows by a group per
 * subfolder, so sorting it among the natives would keep shifting where `env`..`util` sit.
 */
export function compareCategories(a: string, b: string): number {
  const aSub = isSubpatchCategory(a)
  const bSub = isSubpatchCategory(b)
  if (aSub !== bSub) return aSub ? 1 : -1
  const aLocal = a === LOCAL_SUBPATCH_CATEGORY
  if (aLocal !== (b === LOCAL_SUBPATCH_CATEGORY)) return aLocal ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Alphabetical by `label` (the displayed name, e.g. "sine lfo") within each category -- the
 *  registry's own insertion/history order has no meaning to a user scanning the palette for a
 *  primitive by name, and previously left each group in whatever order primitives.ts happened to
 *  declare them, which drifted further from alphabetical as the registry grew. Shared here
 *  (rather than sorted separately by each of the two callers) for the same "one derivation, not
 *  two that could drift apart" reasoning this module's own doc comment already gives for living
 *  here at all. */
export function groupByCategory(
  entries: PrimitiveCatalogEntry[]
): Map<string, PrimitiveCatalogEntry[]> {
  const groups = new Map<string, PrimitiveCatalogEntry[]>()
  for (const entry of entries) {
    const list = groups.get(entry.category) ?? []
    list.push(entry)
    groups.set(entry.category, list)
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.label.localeCompare(b.label))
  }
  return groups
}

/**
 * Matches by item name (label or raw id) OR category name -- typing a category word (e.g.
 * "osc") surfaces every primitive in that category, not just ids/labels literally containing
 * "osc". A renamed primitive also matches its former NAME (last id segment), so "ringmod"
 * still finds `logue/math/multiply` -- not the former category, or "mix" would list it too.
 * A primitive's `searchTerms`, `shortLabel` and `defaultName` match too ("invert" lists both
 * `negate` and `one-minus`, "b2u" finds `bipolar-to-unipolar`).
 */
export function matchesFilter(entry: PrimitiveCatalogEntry, filterText: string): boolean {
  const q = filterText.trim().toLowerCase()
  if (!q) return true
  const primitive = resolveNodePrimitive(entry.id)
  const extraTerms = [
    ...(primitive?.searchTerms ?? []),
    ...(primitive?.shortLabel ? [primitive.shortLabel] : []),
    ...(primitive?.defaultName ? [primitive.defaultName] : [])
  ]
  return (
    entry.category.toLowerCase().includes(q) ||
    entry.label.toLowerCase().includes(q) ||
    entry.id.toLowerCase().includes(q) ||
    formerPrimitiveIds(entry.id).some((oldId) =>
      oldId.split('/').pop()!.toLowerCase().includes(q)
    ) ||
    extraTerms.some((term) => term.toLowerCase().includes(q))
  )
}

/** The drag payload a palette entry carries onto the canvas (`PatchCanvas.tsx`'s drop handler). */
export const PALETTE_DRAG_TYPE = 'application/x-logue-palette-entry'
