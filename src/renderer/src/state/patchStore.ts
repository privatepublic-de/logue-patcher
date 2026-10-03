import { createContext, useContext } from 'react'
import { createStore, useStore, type StateCreator, type StoreApi } from 'zustand'
import type {
  PatchDocument,
  PatchNode,
  CommentNode as CommentPatchNode,
  Net,
  ObjNode,
  LogueEffectModule,
  LogueTargetSettings,
  PatchSettings,
  SampleAsset
} from '@shared/domain/patch'
import type { ParamValue, LogueParamSlot, LogueKnob } from '@shared/domain/paramValueTypes'
import { parsePatchFile } from '@shared/json/patchCodec'
import { nodeId } from './nodeId'
import { autoArrangeNodes, type Size as AutoArrangeSize } from '../canvas/autoArrange'
import { layoutByFlow } from '../canvas/flowLayout'
import { outletPolarityChanged } from '../canvas/wirePolarity'
import { inletWarningsChanged } from '../canvas/wireWarnings'
import {
  isFixedIoNodeType,
  LOGUE_AUDIO_IN_TYPE,
  LOGUE_AUDIO_OUT_TYPE
} from '@logue-codegen/oscInstances'
import { isEffectModule } from '@logue-codegen/unitKinds'
import { normalizeRenamedFields } from '@logue-codegen/renamedFields'
import { isSubpatchInstanceType } from '@logue-codegen/subpatches'
import { deviceLayout, layoutModuleOf, slotsForOrder } from './exposedLogueParams'
import { resolveNodePrimitive } from './subpatchLibraryStore'
import {
  arrangeForLoad,
  disambiguateName,
  initialFreeLabelParam,
  applyPlatformLayout,
  currentPlatformLayout,
  dropOrphanedFollows,
  logueParamSlotsEqual,
  uniqueNodeName,
  withNodes,
  withoutNodeWires,
  remapStereoMonoInlets,
  type DeviceParamRef,
  serializeSelectionForClipboard,
  type PlatformControlLayout
} from './patchDocHelpers'

interface NetEndpointRef {
  obj: string
  outlet?: string
}
interface NetDestRef {
  obj: string
  inlet?: string
}

export interface PatchStoreState {
  rootDoc: PatchDocument | null
  filePath: string | null
  /** Bumped only on document-identity changes (load, insert) that the canvas must fully resync to -- see CLAUDE.md. */
  reloadNonce: number
  selectedNodeId: string | null
  /**
   * Full canvas multi-selection, kept only for the Inspector's collapsed-title selection count
   * -- unlike `selectedNodeId`, nothing else follows renames/deletes/undo into this array, since
   * every structural mutation already bumps `reloadNonce` and remounts `PatchCanvas`, which
   * reports a fresh selection via `onSelectionChange` right after mount anyway (see
   * `patchDocToFlow`'s selection-seeding doc comment). `selectedNodeId` stays the single source
   * of truth for which node's content the Inspector renders when exactly one is selected.
   */
  selectedNodeIds: string[]
  /**
   * A node id whose title/text editor should open itself immediately, without a double-click --
   * ephemeral (not undo-tracked, not part of `PatchDocument`), consumed and cleared the instant
   * `useInlineEdit.ts` sees a matching id. Backs both the `C` canvas shortcut's "comment appears
   * with its editor already focused" behavior (see `insertComment`) and the node context menu's
   * "edit instance name" item -- one mechanism for every non-double-click way to enter rename
   * mode.
   */
  pendingEditNodeId: string | null
  /**
   * Whether `ParamMatrixOverlay.tsx` is open, and (when opened via a right-click on a specific
   * param -- Inspector.tsx's `ParamRow` or `PatchCanvas.tsx`'s `ParamDial` context menu) which
   * param it should scroll to/highlight -- `null` outer value means closed, `focus: null` means
   * open in plain overview mode (e.g. from BuildPanel.tsx's own button). A single nullable
   * object rather than two separate booleans/fields specifically so "open" and "which param" can
   * never disagree with each other (there is no reachable state where one says open and the
   * other says nothing to focus on by accident). Ephemeral UI state, same as `selectedNodeId` --
   * never undo-tracked, never part of `PatchDocument`.
   */
  paramMatrix: { focus: { nodeId: string; paramName: string } | null } | null
  dirty: boolean
  /** The `rootDoc` object last loaded or written to disk -- `dirty` is `rootDoc !== savedDoc`, so undoing back to it reads clean again. */
  savedDoc: PatchDocument | null
  /** Pre-edit `rootDoc` snapshots, most-recent last -- see `withActiveDoc`'s doc comment for how these get pushed. */
  past: PatchDocument[]
  /** Undone `rootDoc` snapshots, most-recently-undone first -- cleared by any new edit. */
  future: PatchDocument[]
  /** Set while a continuous gesture (a knob/slider drag, a momentary-button press) is in progress -- see `beginGesture`. */
  pendingUndo: PatchDocument | null

  loadDoc: (doc: PatchDocument, filePath: string | null) => void
  /**
   * Starts a fresh, empty root patch with no file on disk yet -- `filePath` stays null until
   * the first Save. `logueTarget`, when given, marks the new document as meant for logue-sdk
   * export -- a real `PatchSettings` field, not a separate flag, so it survives the very first
   * save/reopen.
   */
  newDoc: (logueTarget?: LogueTargetSettings) => void
  setSelectedNodeId: (id: string | null) => void
  setSelectedNodeIds: (ids: string[]) => void
  setPendingEditNodeId: (id: string | null) => void
  /** Opens `ParamMatrixOverlay.tsx`, optionally scrolled/highlighted to one specific param.
   *  Omitting `focus` opens in plain overview mode. */
  openParamMatrix: (focus?: { nodeId: string; paramName: string }) => void
  closeParamMatrix: () => void
  /** No-op if `past` is empty or nothing's loaded. Restores the previous `rootDoc`, pushes the current one onto `future`, and bumps `reloadNonce` (a structural change, same as delete/insert). */
  undo: () => void
  /** No-op if `future` is empty. Mirror of `undo`. */
  redo: () => void
  /**
   * Marks the start of a continuous multi-step edit (a knob/slider drag, a momentary-button
   * press) -- snapshots the current `rootDoc` into `pendingUndo` so every mutating call made
   * before the matching `endGesture()` collapses into ONE `past` entry instead of one per
   * call. Safe to call while a gesture is already pending (no-ops, keeping the earliest
   * snapshot) -- see `useParamDrag.ts`'s `onDragStart`/`onDragEnd` for the real call sites.
   */
  beginGesture: () => void
  /** Pushes `pendingUndo` onto `past` (clearing `future`) and clears it. No-op if no gesture is pending. */
  endGesture: () => void
  moveNode: (id: string, x: number, y: number) => void
  /**
   * Renames a node. Sanitizes and disambiguates (see `uniqueNodeName`), rewrites every net reference to
   * the old name, and follows `selectedNodeId` to the new one -- a node's canvas id IS its name
   * (see `nodeId.ts`), so this is a real identity change, not just a cosmetic edit. No-ops if
   * the sanitized name is empty (never produce a nameless, net-orphaning node) or unchanged
   * from the current name.
   */
  renameNode: (id: string, newName: string) => void
  /** Edits a `comment`-kind node's own `text` -- comments have no other editable state. */
  setCommentText: (id: string, text: string) => void
  /** Replaces a node's imported sample (`logue/osc/granular`) in one undo step, also setting
   *  its ROOT param when the importer detected a pitch. */
  setNodeSample: (id: string, sample: SampleAsset, rootNote?: number) => void
  /**
   * Edits (or, for a freshly placed primitive whose `params` starts empty, creates) one param
   * entry on an `obj` node. Sets both `value` (the raw on-device-range number, as a string) and
   * `logueParamIndex` (the exposed hardware-knob slot, or `undefined` to leave/make it unexposed)
   * together, since the Inspector always has both current values in hand and a single full
   * replace avoids any partial-patch ambiguity about what to do when neither exists yet. No-op
   * for a non-`obj` node or an unresolvable node id.
   *
   * `label` is a 5th, optional co-written field -- only
   * `logue/sense/param`'s `freeLabel` spec reads it (see `ParamDial.tsx`/`Inspector.tsx`'s own
   * label editors); every other caller simply never passes it, so it stays `undefined` and
   * every call site that predates this field is unaffected.
   */
  setLogueParam: (
    id: string,
    paramName: string,
    value: string,
    logueParamIndex?: LogueParamSlot,
    label?: string
  ) => void
  /**
   * Lays out ONE platform's device params in exactly `order`: the n-th entry gets the n-th
   * `slotsForOrder` slot, every other param loses its slot on that platform (its OTHER platform's
   * slot is untouched). One mutation, so a drag-reorder, add or remove is one undo step and never
   * passes through a duplicate-slot state. Entries past the platform's slot count are dropped.
   * `value` seeds a param that has no stored `ParamValue` yet (still at its spec default). A param
   * taking a slot loses its knob binding or slot-following on that platform; every other knob
   * binding stays, and a follower moves with its lead (dropped when its lead leaves the list).
   */
  setPlatformSlotOrder: (platform: 'nts1mkii' | 'minilogue-xd', order: DeviceParamRef[]) => void
  /**
   * Switches an effect document to another effect type (one undo step), re-laying each
   * platform's device controls for it: menu params keep their order but move past the new
   * type's reserved rows (Mod has TIME/DEPTH, Delay/Reverb also MIX), and a knob binding the new
   * type lacks is removed. A platform that can't build the type yet is left as it is. Returns the
   * removed bindings, as "node · PARAM", for the caller to report.
   */
  setEffectModule: (module: LogueEffectModule) => string[]
  /**
   * Puts one param on a fixed knob on `platform` (or, with `null`, takes it off), ending any
   * slot or slot-following it had there. Any number of params may share a knob. Leaving a slot
   * lays the remaining ones out again, like a removal in `setPlatformSlotOrder`.
   */
  setKnobBinding: (
    platform: 'nts1mkii' | 'minilogue-xd',
    ref: DeviceParamRef,
    knob: LogueKnob | null
  ) => void
  /**
   * Makes one param follow `lead`'s menu slot on `platform` (or, with `null`, stop), ending any
   * slot or knob it had there. The follower keeps following as the lead moves; it is dropped
   * when the lead leaves the device.
   */
  setSlotFollow: (
    platform: 'nts1mkii' | 'minilogue-xd',
    ref: DeviceParamRef,
    lead: { nodeId: string; paramName: string } | null
  ) => void
  /**
   * Swaps a placed primitive instance's `type` in place (the node context menu's "Replace
   * with..."). Keeps `name` and position, so every net, which addresses nodes by name, stays wired.
   *
   * Params are rebuilt from the NEW primitive's specs only (the old type may not resolve): a
   * same-named existing param keeps its `logueParamIndex`/`label` and its value, clamped to the new
   * range; a missing one starts at its default (a `freeLabel` param set up as in
   * `insertSpecialObject`); a param the new primitive lacks is dropped, releasing its slot (a stale
   * entry would be invisible to the Param Matrix and could collide later). That can leave a
   * gap in the xd's contiguous slots; it isn't compacted behind the user's back -- the Param Matrix
   * shows it and closes it on the next edit there, and Export rejects it until then.
   *
   * Inlets are matched by exact name (the families this targets share inlet names), plus the
   * stereo/mono siblings' `l1`/`r1` <-> `in1` (`remapStereoMonoInlets`); any other unmatched one
   * stays as a dashed stale wire (`ports.ts`) rather than being guessed onto another port by role
   * or position -- visible, and removable from the Inspector. An outlet name the new primitive lacks is remapped to its first outlet --
   * unambiguous for single-outlet primitives, a visible, reversible guess otherwise.
   *
   * No-op for a non-`obj` node, an unknown id or `newType`, the same type, or `logue/io/audio-out`
   * (its shape lives outside the registry and the graph needs exactly one).
   */
  replaceNode: (id: string, newType: string) => void
  /**
   * Inside a subpatch definition: promotes (`outerName` set) or un-promotes (`null`) one inner
   * param onto the subpatch's outer interface -- see `ParamValue.subpatchExpose`. Promoting a
   * param the node has no `ParamValue` for yet creates one at the spec's default.
   */
  setSubpatchExpose: (id: string, paramName: string, outerName: string | null) => void
  /** Drops one stored `ParamValue` -- the way out of a stale one (Inspector's unresolved list),
   *  e.g. an instance value for a promoted param its subpatch no longer exposes. */
  removeParamValue: (id: string, paramName: string) => void
  /** Removes a node's wires into `inlets` / out of `outlets` (raw stored names) -- the way out of
   *  a stale wire in the Inspector's unresolved list. One undo step. */
  removeNodeWires: (id: string, ports: { inlets?: string[]; outlets?: string[] }) => void
  /**
   * Spreads the document's nodes apart to fit their real rendered size, without changing their
   * relative position-sort rank -- see autoArrange.ts's module doc comment for why that
   * constraint is non-negotiable. `measuredSizes` (nodeMeasurements.ts's React-Flow-measured
   * per-node footprint, gathered by the caller since this store has no DOM access of its own)
   * is preferred over autoArrange.ts's own text-length estimate whenever a node's real
   * measurement is available.
   */
  autoArrangeCurrentDoc: (measuredSizes?: Map<string, AutoArrangeSize>) => void
  /** Lays the document out by its signal flow (flowLayout.ts), one undo step. */
  arrangeCurrentDocByFlow: (measuredSizes?: Map<string, AutoArrangeSize>) => void
  addNet: (source: NetEndpointRef, dest: NetDestRef) => void
  removeNetDests: (pairs: Array<{ netIndex: number; destIndex: number }>) => void
  /**
   * Removes only ONE endpoint (by exact `obj`+port-name match) from a net's `sources` or
   * `dests` -- backs the jack context menu's "Disconnect" item, verified against
   * `IoletAbstract.disconnect()`/`Patch.disconnect(io)` (axoloti-1.0.12): a genuinely scoped
   * operation, distinct from `deleteNetAt` below. Drops the whole net afterward if it's left
   * with zero sources or zero dests (mirrors `deleteNodes`'s existing both-sides-required
   * filter), matching the real tool's own "≤1 remaining endpoint -> net is deleted anyway"
   * fallback for the common case (this app's nets only ever have plural `dests`, not plural
   * `sources`, via its own UI -- see `addNet` -- but a loaded `.axp` could still have either).
   */
  removeNetEndpoint: (
    netIndex: number,
    direction: 'source' | 'dest',
    obj: string,
    portName?: string
  ) => void
  /**
   * Removes an entire net outright, regardless of how many sources/dests it has -- backs the
   * jack context menu's "Delete net" item, verified against `Patch.delete(Net)`
   * (axoloti-1.0.12): the deliberately *un*-scoped sibling of `removeNetEndpoint` above (a
   * fan-out net's every connection disappears in one action, not just the clicked jack's own).
   */
  deleteNetAt: (netIndex: number) => void
  deleteNodes: (ids: string[]) => void
  /** Places a plain `obj` instance with an explicit `type` string -- how a logue primitive gets placed (see LoguePrimitivePalette.tsx) and, historically, how "patch/inlet ..."/"patch/outlet ..." pseudo-objects got created. A primitive with a `freeLabel` param (logue/sense/control) starts with that param unassigned in a root patch, or promoted inside a subpatch definition -- see `initialFreeLabelParam`. */
  insertSpecialObject: (
    type: string,
    shortId: string,
    x: number,
    y: number,
    /** Replaces the default starting params (a catalog preset, `insertArgsFor`). */
    params?: ParamValue[]
  ) => void
  /**
   * Places a nameless `comment` node with empty text and immediately arms `pendingEditNodeId`
   * with its synthetic `__unnamed_${index}` id (matching `nodeId.ts`'s existing fallback
   * convention for name-less nodes) -- backs the canvas `C` shortcut, whose real-tool behavior
   * (`PatchGUI.java`'s `keyPressed`) is "place a comment, then drop a focused editor on it
   * immediately," not "open the object-search overlay."
   */
  insertComment: (x: number, y: number) => void
  /**
   * Parses `text` (as produced by `serializeSelectionForClipboard`, but tolerates arbitrary
   * clipboard garbage -- a parse failure or zero-node result is a silent no-op, not a throw)
   * and merges its nodes/nets into the document. Renames a pasted node only on an actual name
   * collision (against the target doc AND already-renamed siblings this same paste), rewiring
   * the pasted subgraph's own internal nets through the same rename map -- verified against
   * `PatchGUI.paste`'s `dict`-based rename+rewire, though this reuses `disambiguateName`'s
   * existing `_<n>` suffix convention rather than porting Java's distinct "bump trailing digit
   * vs. append underscore" scheme (this app already has one established renaming convention;
   * matching *that* everywhere beats also matching Java's specific string here).
   * `cursorFlowPos` (flow-space, from `screenToFlowPosition`) offsets the pasted selection's
   * original bounding box, snapped to `GRID_SIZE` -- `null` (no tracked pointer position yet)
   * falls back to a fixed one-grid-cell nudge rather than Java's "exact original coordinates"
   * null-pos behavior, since every paste here is keyboard-driven and stacking new nodes exactly
   * atop the originals would be a worse default.
   */
  pasteFromClipboard: (text: string, cursorFlowPos: { x: number; y: number } | null) => void
  /**
   * Copies `ids` (with the wires among them) to `at`, through the paste path but without the
   * system clipboard -- the node context menu's Duplicate and ⌘D. Like any paste, the copies
   * drop their menu slots and followers.
   */
  duplicateNodes: (ids: string[], at: { x: number; y: number }) => void
  setPatchSettings: (patch: Partial<PatchSettings>) => void
  /**
   * Records `doc` -- the snapshot that was actually written, which an edit made while the save
   * was in flight may already have replaced -- as the on-disk state; optionally records the path
   * a "Save As" just wrote to, without the reload-nonce bump loadDoc would cause.
   */
  markSaved: (doc: PatchDocument, filePath?: string) => void
}

/** Grid-snap increment shared by paste placement and arrow-key nudging -- `Constants.X_GRID`/`Y_GRID` in axoloti-1.0.12. */
export const GRID_SIZE = 14

/** Caps `past`'s length -- patches are small, but unbounded growth across a long session is needless. */
const UNDO_LIMIT = 100

/**
 * Applies `mutator` to `rootDoc` and writes the result back, in one commit -- and, since every
 * mutating action in this store calls this one shared helper, this is also the single choke
 * point for undo tracking: the pre-mutation `rootDoc` is pushed onto `past` (clearing `future`,
 * since a completed edit invalidates redo) UNLESS a gesture is currently in progress
 * (`pendingUndo !== null`), in which case `beginGesture`'s own snapshot already covers the
 * whole gesture as one entry -- see its doc comment.
 *
 * Returns null when `mutator` hands back the same `rootDoc` object, so a no-op edit (a missing
 * net, a node dropped where it already was) leaves undo history, redo and `dirty` untouched --
 * every caller already skips its own `set` on null.
 */
function withActiveDoc(
  get: () => PatchStoreState,
  set: (partial: Partial<PatchStoreState>) => void,
  mutator: (activeDoc: PatchDocument) => PatchDocument
): PatchDocument | null {
  const { rootDoc, pendingUndo, past } = get()
  if (!rootDoc) return null
  const next = mutator(rootDoc)
  if (next === rootDoc) return null
  if (pendingUndo === null) {
    set({ past: [...past, rootDoc].slice(-UNDO_LIMIT), future: [] })
  }
  return next
}

/** Whether a param edit to `nodeName` changed what the canvas projects for wires: an outlet's
 *  polarity (`refinePolarity`) or a warning on a wire into it (a knob dead zone). */
function wiresChanged(before: PatchDocument, after: PatchDocument, nodeName: string): boolean {
  return (
    outletPolarityChanged(before, after, nodeName) || inletWarningsChanged(before, after, nodeName)
  )
}

/**
 * How every action changes the document: `withActiveDoc` (undo entry, no-op detection), then
 * `dirty`. By default it also bumps `reloadNonce` so the canvas remounts and re-derives edges and
 * badges; `remount: false` is for edits the canvas reads live (a param value, a move). `extra`
 * adds fields that depend on the new document, e.g. the selection after a rename or paste.
 */
function commitDoc(
  get: () => PatchStoreState,
  set: StoreApi<PatchStoreState>['setState'],
  options: {
    remount?: boolean
    extra?: (s: PatchStoreState, rootDoc: PatchDocument) => Partial<PatchStoreState>
  },
  mutator: (activeDoc: PatchDocument) => PatchDocument
): void {
  const rootDoc = withActiveDoc(get, set, mutator)
  if (!rootDoc) return
  const { remount = true, extra } = options
  set((s) => ({
    rootDoc,
    dirty: true,
    ...(remount ? { reloadNonce: s.reloadNonce + 1 } : {}),
    ...extra?.(s, rootDoc)
  }))
}

/** `applyPlatformLayout` as one undo step -- the Param Matrix's slot, knob and follow edits. */
function commitLayout(
  get: () => PatchStoreState,
  set: StoreApi<PatchStoreState>['setState'],
  platform: 'nts1mkii' | 'minilogue-xd',
  layout: PlatformControlLayout
): void {
  const activeDoc = get().rootDoc
  if (!activeDoc) return
  const nodes = applyPlatformLayout(activeDoc, platform, layout, (count) =>
    slotsForOrder(platform, layoutModuleOf(activeDoc), count)
  )
  if (!nodes) return
  commitDoc(get, set, { remount: false }, (doc) => withNodes(doc, nodes))
}

/**
 * One tab's worth of patch-editing state -- extracted from a single `create(...)` call into a
 * plain `StateCreator` so `tabRegistry.ts` can spin up one real vanilla store instance per open
 * tab (`createStore(createPatchStoreState)`), instead of every tab sharing one global document.
 * No action body below changed at all; only how a component reaches "the" store instance did
 * (see `usePatchStore`/`PatchStoreContext` below) -- every existing `usePatchStore((s) => ...)`
 * call site keeps its exact syntax.
 */
export const createPatchStoreState: StateCreator<PatchStoreState> = (set, get) => ({
  rootDoc: null,
  filePath: null,
  reloadNonce: 0,
  selectedNodeId: null,
  selectedNodeIds: [],
  pendingEditNodeId: null,
  paramMatrix: null,
  dirty: false,
  savedDoc: null,
  past: [],
  future: [],
  pendingUndo: null,

  loadDoc: (doc, filePath) => {
    const arranged = arrangeForLoad(doc)
    set((s) => ({
      rootDoc: arranged,
      savedDoc: arranged,
      filePath,
      reloadNonce: s.reloadNonce + 1,
      selectedNodeId: null,
      pendingEditNodeId: null,
      paramMatrix: null,
      dirty: false,
      past: [],
      future: [],
      pendingUndo: null
    }))
  },

  newDoc: (logueTarget) => {
    const rootDoc: PatchDocument = {
      // A logue document always needs exactly one `logue/io/audio-out` sink to ever export/build
      // (see `resolveAudioGraph`'s own hard error otherwise) -- seeded here rather than left for
      // the user to place, now that `deleteNodes` refuses to remove it and the palette/popup no
      // longer offer it as an insertable primitive (see `listInsertablePrimitives`'s own doc
      // comment). Skipped for a non-logue `newDoc()` call (no `logueTarget` at all, e.g. the
      // plain unit test in patchStore.spec.ts) since the fixed sink only means anything for a
      // logue-target document.
      // An effect also gets its fixed source, audio-in, wired straight through in stereo, so a
      // new effect builds and passes audio before anything goes between them (user's call,
      // 2026-09-30, over a pre-wired crossfader: the long delay has its own MIX).
      nodes: logueTarget
        ? [
            ...(isEffectModule(logueTarget.module)
              ? [
                  {
                    kind: 'obj' as const,
                    type: LOGUE_AUDIO_IN_TYPE,
                    name: 'audio-in',
                    x: 120,
                    y: 180,
                    params: []
                  }
                ]
              : []),
            {
              kind: 'obj',
              type: LOGUE_AUDIO_OUT_TYPE,
              name: 'audio-out',
              x: 480,
              y: 180,
              params: []
            }
          ]
        : [],
      nets:
        logueTarget && isEffectModule(logueTarget.module)
          ? (['l', 'r'] as const).map((side) => ({
              sources: [{ obj: 'audio-in', outlet: side }],
              dests: [{ obj: 'audio-out', inlet: side }]
            }))
          : [],
      settings: { logueTarget },
      notes: ''
    }
    set((s) => ({
      rootDoc,
      savedDoc: rootDoc,
      filePath: null,
      reloadNonce: s.reloadNonce + 1,
      selectedNodeId: null,
      pendingEditNodeId: null,
      paramMatrix: null,
      dirty: false,
      past: [],
      future: [],
      pendingUndo: null
    }))
  },

  undo: () => {
    const { past, rootDoc, future, savedDoc } = get()
    if (past.length === 0 || !rootDoc) return
    const previous = past[past.length - 1]
    set((s) => ({
      rootDoc: previous,
      past: past.slice(0, -1),
      future: [rootDoc, ...future],
      dirty: previous !== savedDoc,
      reloadNonce: s.reloadNonce + 1,
      selectedNodeId: null,
      pendingUndo: null
    }))
  },

  redo: () => {
    const { future, rootDoc, past, savedDoc } = get()
    if (future.length === 0 || !rootDoc) return
    const [next, ...rest] = future
    set((s) => ({
      rootDoc: next,
      future: rest,
      past: [...past, rootDoc].slice(-UNDO_LIMIT),
      dirty: next !== savedDoc,
      reloadNonce: s.reloadNonce + 1,
      selectedNodeId: null,
      pendingUndo: null
    }))
  },

  beginGesture: () => {
    const { rootDoc, pendingUndo } = get()
    if (pendingUndo !== null || !rootDoc) return
    set({ pendingUndo: rootDoc })
  },

  endGesture: () => {
    const { pendingUndo, past, rootDoc } = get()
    if (pendingUndo === null) return
    // A click on a dial with no drag changed nothing -- recording it would only clear redo.
    if (pendingUndo === rootDoc) {
      set({ pendingUndo: null })
      return
    }
    const remount = !!rootDoc?.nodes.some(
      (n) =>
        n.kind === 'obj' &&
        n.name !== undefined &&
        !pendingUndo.nodes.includes(n) &&
        wiresChanged(pendingUndo, rootDoc!, n.name)
    )
    set((s) => ({
      past: [...past, pendingUndo].slice(-UNDO_LIMIT),
      future: [],
      pendingUndo: null,
      ...(remount ? { reloadNonce: s.reloadNonce + 1 } : {})
    }))
  },

  setSelectedNodeId: (id) => set({ selectedNodeId: id }),
  setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),
  setPendingEditNodeId: (id) => set({ pendingEditNodeId: id }),
  openParamMatrix: (focus) => set({ paramMatrix: { focus: focus ?? null } }),
  closeParamMatrix: () => set({ paramMatrix: null }),

  moveNode: (id, x, y) => {
    commitDoc(get, set, { remount: false }, (doc) => {
      const target = doc.nodes.find((n, i) => nodeId(n, i) === id)
      if (!target || (target.x === x && target.y === y)) return doc
      const nodes = doc.nodes.map((n, i) => (nodeId(n, i) === id ? { ...n, x, y } : n))
      return withNodes(doc, nodes)
    })
  },

  renameNode: (id, newName) => {
    const activeDoc = get().rootDoc
    const target = activeDoc?.nodes.find((n, i) => nodeId(n, i) === id)
    if (!activeDoc || !target) return
    const oldName = target.name
    const sanitized = newName.replace(/[^a-zA-Z0-9_]/g, '_')
    if (!sanitized || sanitized === oldName) return
    const finalName = uniqueNodeName(activeDoc, sanitized, oldName)

    commitDoc(
      get,
      set,
      {
        extra: (s) => ({
          selectedNodeId: s.selectedNodeId === id ? finalName : s.selectedNodeId
        })
      },
      (doc) => {
        const nodes = doc.nodes.map((n, i) => (nodeId(n, i) === id ? { ...n, name: finalName } : n))
        const nets = doc.nets.map((net) => ({
          sources: net.sources.map((s) => (s.obj === oldName ? { ...s, obj: finalName } : s)),
          dests: net.dests.map((d) => (d.obj === oldName ? { ...d, obj: finalName } : d))
        }))
        return { ...doc, nodes, nets }
      }
    )
  },

  setCommentText: (id, text) => {
    const activeDoc = get().rootDoc
    const target = activeDoc?.nodes.find((n, i) => nodeId(n, i) === id)
    if (!target || target.kind !== 'comment' || target.text === text) return

    commitDoc(get, set, {}, (doc) => {
      const nodes = doc.nodes.map((n, i) =>
        nodeId(n, i) === id && n.kind === 'comment' ? { ...n, text } : n
      )
      return withNodes(doc, nodes)
    })
  },

  setNodeSample: (id, sample, rootNote) => {
    const activeDoc = get().rootDoc
    const target = activeDoc?.nodes.find((n, i) => nodeId(n, i) === id)
    if (!target || target.kind !== 'obj') return

    // Remount: the canvas badge for "no sample loaded" is derived at graph-build time.
    commitDoc(get, set, {}, (doc) => {
      const nodes = doc.nodes.map((n, i) => {
        if (nodeId(n, i) !== id || n.kind !== 'obj') return n
        if (rootNote === undefined) return { ...n, sample }
        const rootValue = { name: 'ROOT', value: String(rootNote) }
        const params = n.params.some((p) => p.name === 'ROOT')
          ? n.params.map((p) => (p.name === 'ROOT' ? { ...p, value: rootValue.value } : p))
          : [...n.params, rootValue]
        return { ...n, sample, params }
      })
      return withNodes(doc, nodes)
    })
  },

  setLogueParam: (id, paramName, value, logueParamIndex, label) => {
    const activeDoc = get().rootDoc
    const target = activeDoc?.nodes.find((n, i) => nodeId(n, i) === id)
    if (!target || target.kind !== 'obj') return
    const existing = target.params.find((p) => p.name === paramName)
    if (
      existing &&
      existing.value === value &&
      logueParamSlotsEqual(existing.logueParamIndex, logueParamIndex) &&
      existing.label === label
    ) {
      return
    }

    const apply = (doc: PatchDocument): PatchDocument =>
      withNodes(
        doc,
        doc.nodes.map((n, i) => {
          if (nodeId(n, i) !== id || n.kind !== 'obj') return n
          const existingIndex = n.params.findIndex((p) => p.name === paramName)
          const params =
            existingIndex === -1
              ? [...n.params, { name: paramName, value, logueParamIndex, label }]
              : n.params.map((p, pi) =>
                  pi === existingIndex ? { ...p, value, logueParamIndex, label } : p
                )
          return { ...n, params }
        })
      )
    // A dial is read live, but wire colours and warnings are projected per mount: remount only
    // when the edit changes one (clamp's LO crossing 0, a FADE that opens a knob dead zone).
    // Never mid-drag (it would unmount the dial being dragged); `endGesture` catches up.
    const remount =
      get().pendingUndo === null &&
      target.name !== undefined &&
      wiresChanged(activeDoc!, apply(activeDoc!), target.name)
    commitDoc(get, set, { remount }, apply)
  },

  setSubpatchExpose: (id, paramName, outerName) => {
    const activeDoc = get().rootDoc
    const target = activeDoc?.nodes.find((n, i) => nodeId(n, i) === id)
    if (!activeDoc?.settings.subpatch || !target || target.kind !== 'obj') return
    const trimmed = outerName?.trim()
    // Outer names key each instance's value and device slot, so two params can't share one --
    // a clash gets a numeric suffix rather than silently merging them.
    const taken = new Set(
      activeDoc.nodes.flatMap((n) =>
        n.kind === 'obj'
          ? n.params
              .filter((p) => !(n === target && p.name === paramName))
              .map((p) => p.subpatchExpose?.outerName)
              .filter((name): name is string => name !== undefined)
          : []
      )
    )
    let unique = trimmed
    for (let n = 2; unique && taken.has(unique); n++) unique = `${trimmed} ${n}`
    const next = unique ? { outerName: unique } : undefined
    const existing = target.params.find((p) => p.name === paramName)
    if (existing?.subpatchExpose?.outerName === next?.outerName) return
    const spec = resolveNodePrimitive(target.type)?.params?.find((p) => p.name === paramName)
    if (!existing && (!next || !spec)) return

    commitDoc(get, set, { remount: false }, (doc) => {
      const nodes = doc.nodes.map((n, i) => {
        if (nodeId(n, i) !== id || n.kind !== 'obj') return n
        const params = existing
          ? n.params.map((p) => (p.name === paramName ? { ...p, subpatchExpose: next } : p))
          : [...n.params, { name: paramName, value: String(spec!.default), subpatchExpose: next }]
        return { ...n, params }
      })
      return withNodes(doc, nodes)
    })
  },

  removeParamValue: (id, paramName) => {
    const target = get().rootDoc?.nodes.find((n, i) => nodeId(n, i) === id)
    if (!target || target.kind !== 'obj' || !target.params.some((p) => p.name === paramName)) {
      return
    }
    // The canvas badge is derived at projection time, so it needs a remount to clear.
    commitDoc(get, set, {}, (doc) =>
      dropOrphanedFollows(
        withNodes(
          doc,
          doc.nodes.map((n, i) =>
            nodeId(n, i) === id && n.kind === 'obj'
              ? { ...n, params: n.params.filter((p) => p.name !== paramName) }
              : n
          )
        )
      )
    )
  },

  removeNodeWires: (id, ports) => {
    const target = get().rootDoc?.nodes.find((n, i) => nodeId(n, i) === id)
    if (!target || target.kind !== 'obj' || target.name === undefined) return
    const name = target.name
    commitDoc(get, set, {}, (doc) => withoutNodeWires(doc, name, ports))
  },

  setEffectModule: (module) => {
    const activeDoc = get().rootDoc
    const current = activeDoc?.settings.logueTarget?.module
    if (!activeDoc || !current || !isEffectModule(current) || current === module) return []
    let doc: PatchDocument = {
      ...activeDoc,
      settings: { ...activeDoc.settings, logueTarget: { module } }
    }
    const removed: string[] = []
    for (const platform of ['nts1mkii', 'minilogue-xd'] as const) {
      const layout = deviceLayout(platform, module)
      if (!layout.buildable) continue
      const was = currentPlatformLayout(doc, platform)
      const knobs = was.knobs.filter((k) => {
        if (layout.knobs.includes(k.knob)) return true
        const node = doc.nodes.find((n, i) => nodeId(n, i) === k.nodeId)
        removed.push(`${node?.name ?? k.nodeId} · ${k.paramName}`)
        return false
      })
      const nodes = applyPlatformLayout(doc, platform, { ...was, knobs }, (count) =>
        slotsForOrder(platform, module, count)
      )
      if (nodes) doc = withNodes(doc, nodes)
    }
    commitDoc(get, set, { remount: false }, () => doc)
    return [...new Set(removed)]
  },

  setPlatformSlotOrder: (platform, order) => {
    const activeDoc = get().rootDoc
    if (!activeDoc) return
    const current = currentPlatformLayout(activeDoc, platform)
    const ordered = new Set(order.map((r) => `${r.nodeId}\u0000${r.paramName}`))
    const notOrdered = (r: { nodeId: string; paramName: string }): boolean =>
      !ordered.has(`${r.nodeId}\u0000${r.paramName}`)
    commitLayout(get, set, platform, {
      order,
      knobs: current.knobs.filter(notOrdered),
      follows: current.follows.filter(notOrdered)
    })
  },

  setKnobBinding: (platform, ref, knob) => {
    const activeDoc = get().rootDoc
    if (!activeDoc) return
    const current = currentPlatformLayout(activeDoc, platform)
    const other = (r: { nodeId: string; paramName: string }): boolean =>
      r.nodeId !== ref.nodeId || r.paramName !== ref.paramName
    commitLayout(get, set, platform, {
      order: current.order.filter(other),
      knobs: [...current.knobs.filter(other), ...(knob ? [{ ...ref, knob }] : [])],
      follows: current.follows.filter(other)
    })
  },

  setSlotFollow: (platform, ref, lead) => {
    const activeDoc = get().rootDoc
    if (!activeDoc) return
    const current = currentPlatformLayout(activeDoc, platform)
    const other = (r: { nodeId: string; paramName: string }): boolean =>
      r.nodeId !== ref.nodeId || r.paramName !== ref.paramName
    commitLayout(get, set, platform, {
      order: current.order.filter(other),
      knobs: current.knobs.filter(other),
      follows: [...current.follows.filter(other), ...(lead ? [{ ...ref, lead }] : [])]
    })
  },

  replaceNode: (id, newType) => {
    const activeDoc = get().rootDoc
    const target = activeDoc?.nodes.find((n, i) => nodeId(n, i) === id)
    if (!activeDoc || !target || target.kind !== 'obj') return
    if (target.type === newType || isFixedIoNodeType(target.type)) return
    const newPrimitive = resolveNodePrimitive(newType)
    if (!newPrimitive) return

    const outlets = newPrimitive.outlets ?? [{ name: 'out' }]
    const newOutletNames = new Set(outlets.map((o) => o.name))
    const firstOutletName = outlets[0].name

    commitDoc(get, set, {}, (doc) => {
      const nodes = doc.nodes.map((n, i) => {
        if (nodeId(n, i) !== id || n.kind !== 'obj') return n
        const params: ParamValue[] = (newPrimitive.params ?? []).map((spec) => {
          const existing = n.params.find((p) => p.name === spec.name)
          if (existing) {
            const numeric = Number(existing.value)
            const clamped = Number.isFinite(numeric)
              ? Math.min(spec.max, Math.max(spec.min, numeric))
              : spec.default
            return { ...existing, value: String(clamped) }
          }
          return spec.freeLabel
            ? initialFreeLabelParam(doc, newType, n.name ?? '', spec)
            : { name: spec.name, value: String(spec.default) }
        })
        return { ...n, type: newType, params }
      })

      const newInletNames = new Set((newPrimitive.inlets ?? []).map((i) => i.name))
      const nets = remapStereoMonoInlets(doc.nets, id, newInletNames).map((net) => ({
        ...net,
        sources: net.sources.map((s) =>
          s.obj === id && s.outlet !== undefined && !newOutletNames.has(s.outlet)
            ? { ...s, outlet: firstOutletName }
            : s
        )
      }))

      return dropOrphanedFollows({ ...doc, nodes, nets })
    })
  },

  autoArrangeCurrentDoc: (measuredSizes) => {
    commitDoc(get, set, {}, (doc) => withNodes(doc, autoArrangeNodes(doc, measuredSizes)))
  },

  arrangeCurrentDocByFlow: (measuredSizes) => {
    commitDoc(get, set, {}, (doc) => withNodes(doc, layoutByFlow(doc, measuredSizes)))
  },

  addNet: (source, dest) => {
    commitDoc(get, set, {}, (doc) => {
      // An inlet can be the dest of at most one net at a time -- verified against the real
      // Java PatchController.addConnection()'s own disconnect(il)-before-connect sequence
      // (an inlet already wired elsewhere is torn down first, never left with two live
      // sources). Evict `dest` from whichever net currently owns it before doing anything
      // else, same prune rule as removeNetEndpoint (a net left with an empty side is
      // dropped entirely), so a redrawn connection replaces the old one instead of stacking.
      const withoutDest = doc.nets
        .map((net) => ({
          ...net,
          dests: net.dests.filter((d) => !(d.obj === dest.obj && d.inlet === dest.inlet))
        }))
        .filter((net) => net.sources.length > 0 && net.dests.length > 0)

      const existingIndex = withoutDest.findIndex(
        (net) =>
          net.sources.length === 1 &&
          net.sources[0].obj === source.obj &&
          net.sources[0].outlet === source.outlet
      )
      let nets: Net[]
      if (existingIndex >= 0) {
        nets = withoutDest.map((net, i) =>
          i === existingIndex ? { ...net, dests: [...net.dests, dest] } : net
        )
      } else {
        nets = [...withoutDest, { sources: [source], dests: [dest] }]
      }
      return { ...doc, nets }
    })
  },

  removeNetDests: (pairs) => {
    if (pairs.length === 0) return
    commitDoc(get, set, {}, (doc) => {
      const destIndicesByNet = new Map<number, Set<number>>()
      for (const { netIndex, destIndex } of pairs) {
        const set = destIndicesByNet.get(netIndex) ?? new Set<number>()
        set.add(destIndex)
        destIndicesByNet.set(netIndex, set)
      }
      const nets = doc.nets
        .map((net, i) => {
          const toRemove = destIndicesByNet.get(i)
          if (!toRemove) return net
          return { ...net, dests: net.dests.filter((_, di) => !toRemove.has(di)) }
        })
        .filter((net) => net.dests.length > 0)
      return { ...doc, nets }
    })
  },

  deleteNodes: (ids) => {
    // The fixed `logue/io/audio-out` sink is never deletable (see `newDoc`'s own doc comment --
    // a logue document must always have exactly one) -- filtered out of the requested id set
    // before anything else runs, so every deletion entry point (context menu, Cmd/Ctrl+X,
    // React Flow's own Backspace/Delete handling) is covered by this one choke point rather than
    // needing its own guard. Bails out entirely (no undo entry pushed) when that leaves nothing
    // left to delete, matching `replaceNode`'s own no-op-for-audio-out precedent.
    const before = get().rootDoc
    const idSet = new Set(
      before
        ? ids.filter((id) => {
            const node = before.nodes.find((n, i) => nodeId(n, i) === id)
            return !(node?.kind === 'obj' && isFixedIoNodeType(node.type))
          })
        : ids
    )
    if (idSet.size === 0) return
    commitDoc(
      get,
      set,
      {
        extra: (s) => ({
          selectedNodeId: s.selectedNodeId && idSet.has(s.selectedNodeId) ? null : s.selectedNodeId
        })
      },
      (doc) => {
        const nodes = doc.nodes.filter((n, i) => !idSet.has(nodeId(n, i)))
        const nets = doc.nets
          .map((net) => ({
            sources: net.sources.filter((s) => !idSet.has(s.obj)),
            dests: net.dests.filter((d) => !idSet.has(d.obj))
          }))
          .filter((net) => net.sources.length > 0 && net.dests.length > 0)
        return dropOrphanedFollows({ ...doc, nodes, nets })
      }
    )
  },

  insertSpecialObject: (type, shortId, x, y, presetParams) => {
    let insertedName = ''
    commitDoc(
      get,
      set,
      {
        extra: () => ({
          selectedNodeId: insertedName
        })
      },
      (doc) => {
        const name = uniqueNodeName(doc, shortId)
        insertedName = name
        // A `freeLabel` param (logue/sense/control's VALUE) starts unassigned in a root patch and
        // promoted in a definition -- see `initialFreeLabelParam`.
        const insertedPrimitive = resolveNodePrimitive(type)
        const freeLabelSpec = insertedPrimitive?.params?.find((p) => p.freeLabel)
        const params: ParamValue[] = presetParams
          ? presetParams
          : freeLabelSpec && !isSubpatchInstanceType(type)
            ? [initialFreeLabelParam(doc, type, name, freeLabelSpec)]
            : []
        const newNode: ObjNode = { kind: 'obj', type, name, x, y, params }
        return withNodes(doc, [...doc.nodes, newNode])
      }
    )
  },

  insertComment: (x, y) => {
    let pendingEditId = ''
    commitDoc(
      get,
      set,
      {
        extra: () => ({
          selectedNodeId: pendingEditId,
          pendingEditNodeId: pendingEditId
        })
      },
      (doc) => {
        const newNode: CommentPatchNode = { kind: 'comment', type: 'patch/comment', x, y, text: '' }
        pendingEditId = nodeId(newNode, doc.nodes.length)
        return withNodes(doc, [...doc.nodes, newNode])
      }
    )
  },

  removeNetEndpoint: (netIndex, direction, obj, portName) => {
    commitDoc(get, set, {}, (doc) => {
      const net = doc.nets[netIndex]
      if (!net) return doc
      const updated: Net =
        direction === 'source'
          ? {
              ...net,
              sources: net.sources.filter((s) => !(s.obj === obj && s.outlet === portName))
            }
          : {
              ...net,
              dests: net.dests.filter((d) => !(d.obj === obj && d.inlet === portName))
            }
      const nets =
        updated.sources.length === 0 || updated.dests.length === 0
          ? doc.nets.filter((_, i) => i !== netIndex)
          : doc.nets.map((n, i) => (i === netIndex ? updated : n))
      return { ...doc, nets }
    })
  },

  deleteNetAt: (netIndex) => {
    commitDoc(get, set, {}, (doc) => ({
      ...doc,
      nets: doc.nets.filter((_, i) => i !== netIndex)
    }))
  },

  pasteFromClipboard: (text, cursorFlowPos) => {
    let parsed: PatchDocument
    try {
      parsed = normalizeRenamedFields(parsePatchFile(text))
    } catch {
      return
    }
    // Every logue document already has its one audio-out (and an effect its audio-in), and
    // neither can be deleted -- a pasted copy would be a second one stuck in the patch.
    const fixed = new Set(
      parsed.nodes.filter((n) => n.kind === 'obj' && isFixedIoNodeType(n.type)).map((n) => n.name)
    )
    if (fixed.size > 0) {
      parsed = {
        ...parsed,
        nodes: parsed.nodes.filter((n) => !(n.kind === 'obj' && isFixedIoNodeType(n.type))),
        nets: parsed.nets
          .map((net) => ({
            sources: net.sources.filter((src) => !fixed.has(src.obj)),
            dests: net.dests.filter((d) => !fixed.has(d.obj))
          }))
          .filter((net) => net.sources.length > 0 && net.dests.length > 0)
      }
    }
    if (parsed.nodes.length === 0) return
    // Pasted params start without a menu slot or a follow (user's call, 2026-10-02): a copy
    // pasted beside its original would otherwise claim the same "Param N" on the device. Knob
    // bindings stay -- any number of params may share a knob. Cut-and-paste loses them too.
    parsed = {
      ...parsed,
      nodes: parsed.nodes.map((n) =>
        n.kind === 'obj'
          ? {
              ...n,
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              params: n.params.map(({ logueParamIndex, logueFollow, ...rest }) => rest)
            }
          : n
      )
    }

    const activeDoc = get().rootDoc
    if (!activeDoc) return

    const claimed = new Set(
      activeDoc.nodes.map((n) => n.name).filter((n): n is string => n !== undefined)
    )
    const renameMap = new Map<string, string>()
    for (const node of parsed.nodes) {
      if (node.name === undefined) continue
      const newName = disambiguateName(node.name, claimed)
      claimed.add(newName)
      renameMap.set(node.name, newName)
    }

    const renamedNodes: PatchNode[] = parsed.nodes.map((node) => {
      if (node.name === undefined) return node
      const newName = renameMap.get(node.name)
      return newName !== undefined && newName !== node.name ? { ...node, name: newName } : node
    })
    const rewrittenNets: Net[] = parsed.nets.map((net) => ({
      sources: net.sources.map((s) => {
        const newName = renameMap.get(s.obj)
        return newName !== undefined ? { ...s, obj: newName } : s
      }),
      dests: net.dests.map((d) => {
        const newName = renameMap.get(d.obj)
        return newName !== undefined ? { ...d, obj: newName } : d
      })
    }))

    const minX = Math.min(...renamedNodes.map((n) => n.x))
    const minY = Math.min(...renamedNodes.map((n) => n.y))
    const offsetX = cursorFlowPos
      ? GRID_SIZE * Math.round((cursorFlowPos.x - minX) / GRID_SIZE)
      : GRID_SIZE
    const offsetY = cursorFlowPos
      ? GRID_SIZE * Math.round((cursorFlowPos.y - minY) / GRID_SIZE)
      : GRID_SIZE

    const occupied = new Set(activeDoc.nodes.map((n) => `${n.x},${n.y}`))
    const positionedNodes = renamedNodes.map((node) => {
      let x = node.x + offsetX
      let y = node.y + offsetY
      while (occupied.has(`${x},${y}`)) {
        x += GRID_SIZE
        y += GRID_SIZE
      }
      occupied.add(`${x},${y}`)
      return { ...node, x, y }
    })

    commitDoc(
      get,
      set,
      {
        extra: (_s, rootDoc) => ({
          selectedNodeId:
            positionedNodes.length === 1
              ? nodeId(positionedNodes[0], rootDoc.nodes.length - 1)
              : null
        })
      },
      (doc) => ({
        ...doc,
        nodes: [...doc.nodes, ...positionedNodes],
        nets: [...doc.nets, ...rewrittenNets]
      })
    )
  },

  duplicateNodes: (ids, at) => {
    const doc = get().rootDoc
    if (!doc) return
    get().pasteFromClipboard(serializeSelectionForClipboard(doc, ids), at)
  },

  setPatchSettings: (patch) => {
    commitDoc(get, set, {}, (doc) => ({
      ...doc,
      settings: { ...doc.settings, ...patch }
    }))
  },

  markSaved: (doc, filePath) =>
    set((s) => ({ savedDoc: doc, dirty: s.rootDoc !== doc, filePath: filePath ?? s.filePath }))
})

/**
 * Which open tab's store a component reading `usePatchStore`/`usePatchTabId` resolves against
 * -- provided once per active patch tab by `App.tsx` (see tabRegistry.ts for where `api` comes
 * from). No default: a component rendered outside a patch tab's Provider is a real bug, not a
 * case to silently no-op.
 */
export const PatchStoreContext = createContext<{
  tabId: string
  api: StoreApi<PatchStoreState>
} | null>(null)

export function usePatchStore<U>(selector: (state: PatchStoreState) => U): U {
  const ctx = useContext(PatchStoreContext)
  if (!ctx) throw new Error('usePatchStore must be used within a PatchStoreContext.Provider')
  return useStore(ctx.api, selector)
}

/** The active patch tab's id -- used as a canvas-session key (PatchWorkspace.tsx's rearrange, nodeMeasurements.ts) and a stable React key across the tab's own components. */
export function usePatchTabId(): string {
  const ctx = useContext(PatchStoreContext)
  if (!ctx) throw new Error('usePatchTabId must be used within a PatchStoreContext.Provider')
  return ctx.tabId
}

/** The active patch tab's raw vanilla store -- lets a handler (e.g. PatchWorkspace.tsx's undo/redo keyboard shortcut) read current state via `.getState()` without re-subscribing/re-rendering on every store change. */
export function usePatchStoreApi(): StoreApi<PatchStoreState> {
  const ctx = useContext(PatchStoreContext)
  if (!ctx) throw new Error('usePatchStoreApi must be used within a PatchStoreContext.Provider')
  return ctx.api
}

/**
 * A permanently-empty (`rootDoc: null`) vanilla store, created once -- exists purely so the
 * `useOptional*` hooks below always have a *real* store to pass to `useStore`, whether or not
 * a patch tab is currently active. Never wrapped in a Provider, so no action legitimately
 * targets it; every consumer's existing `!rootDoc`/`!doc` guard already treats that as "nothing
 * to show/act on", which is exactly the desired disabled/hidden state.
 */
const emptyPatchStore = createStore<PatchStoreState>(createPatchStoreState)

/**
 * Non-throwing counterparts to `usePatchStore`/`usePatchTabId`/`usePatchStoreApi`, for
 * components that must render regardless of whether a patch tab is active -- the always-visible
 * library and build/connect panels (see App.tsx). Falls back to `emptyPatchStore` instead of
 * throwing when no `PatchStoreContext.Provider` is present.
 */
export function useOptionalPatchStore<U>(selector: (state: PatchStoreState) => U): U {
  const ctx = useContext(PatchStoreContext)
  return useStore(ctx?.api ?? emptyPatchStore, selector)
}
