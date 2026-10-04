import type {
  BooleanParamWidget,
  ParamModulation,
  ParamTrackGate,
  ParamUnit,
  ParamUnitDependency,
  SelectParam
} from '../paramPresentation'
import type { LogueModule, LoguePlatform, SampleAsset } from '../../../src/shared/domain/patch'
import type { ParamValue } from '../../../src/shared/domain/paramValueTypes'

/**
 * One named signal inlet a primitive declares -- consumed as an upstream active instance's own
 * computed per-sample value (see `oscInstances.ts`'s `resolveAudioGraph`/`oscBody.ts`'s
 * `computeStatements`), or left unwired, in which case `renderExpr` decides its own fallback
 * (typically a `params`-backed default). Deliberately the SAME mechanism for what would be an
 * "audio" input (a filter's `in`) and a "control" input (a filter's `cutoff`, fed by an
 * envelope/LFO) -- every active instance computes one plain per-sample float value regardless
 * of its role, so there is no separate audio-rate/control-rate type to model -- `role` below
 * is EDITOR PRESENTATION ONLY and does not change that -- except `buffer`, which isn't a signal
 * at all (a reference to a `util/buffer` ring) and is the one role the resolver and `oscBody.ts`
 * read (`isBufferInlet`).
 */
export interface PrimitiveInletSpec {
  name: string
  /**
   * Which of the two things this inlet is FOR, purely so the canvas can colour/shape its port
   * dot and the cable landing on it (`portColors.ts`, `ports.ts`) -- a four-inlet node like
   * `logue/filter/comb` is otherwise four identical dots, only one of which carries the sound.
   * NOT a resurrected Axoloti-style data-type domain (frac32/bool32/...): both roles are the
   * same plain per-sample float through the same mechanism, and generated code is byte-identical
   * whichever of the two this says. `buffer` (a buffer wire, not a signal) is the exception and
   * does change codegen -- see `LogueInletRole`.
   *
   * `audio` is exactly the inlets expecting a full-scale signal to pass through or combine:
   * `in`/`in1`/`in2`, plus every oscillator's `fm` (its modulator IS an audio-rate oscillator,
   * a call made deliberately -- classified by what it carries, not by what it's used for).
   * Everything else -- `pitch`, `fmDepth`, `width`, `cutoff`, `gain`, `rate`, `drive`, `delay`,
   * `feedback` -- is `control`.
   *
   * Required rather than optional so a new primitive's author gets a compile error until they
   * decide; an optional field with a default would silently mis-colour the next inlet added.
   */
  role: LogueInletRole
  /** What the canvas shows instead of `name` (`mix2`'s `thru` reads "in thru"). Display only:
   *  nets, files and codegen use `name`, so a label can change without a rename alias. */
  label?: string
  /** When this inlet is only read with its primitive's `TRACK`/`SYNC` in one position -- shown
   *  as a badge on the canvas port (`paramPresentation.ts`). */
  trackGate?: ParamTrackGate
}

/**
 * See `PrimitiveInletSpec.role`. `buffer` is the exception to "display only": it takes a
 * `util/buffer`'s `buf` outlet, a reference to the writer's SDRAM ring rather than a
 * per-sample value (`isBufferInlet`, read by the resolver and `oscBody.ts`).
 */
export type LogueInletRole = 'audio' | 'control' | 'buffer'

/** Re-exported so the registry's own consumers keep one import path; `patch.ts` is the one definition. */
export type { LoguePlatform }

/**
 * The four wire/dot colours `portColors.ts` actually paints -- a signal's SHAPE, not its
 * category: `audio` (a full-scale signal meant to reach `logue/io/audio-out`), `unipolar`
 * (`0..1`, e.g. an envelope or a `logue/sense/*` reading), `bipolar` (`-1..1`, e.g. an LFO or
 * oscillator used as a modulator), `gate` (a discrete `0.f`/`1.f`, e.g. `logue/logic/*` or
 * `logue/sense/gate`). Deliberately not a revived Axoloti data-type domain -- every one of these
 * is still the same plain per-sample float through the same mechanism; this is purely which
 * READING AID colour a wire gets, nothing here is consulted by codegen -- except `buffer`, a buffer
 * wire's bucket (`isBufferOutlet`), which marks a reference rather than a signal.
 */
export type WirePolarityBucket = 'audio' | 'unipolar' | 'bipolar' | 'gate' | 'buffer'

/**
 * See `LoguePrimitive.outletPolarity`. `'inherit'` marks a genuine pass-through/combiner
 * primitive (a filter, VCA, mixer, math/mux node) whose own outlet colour is only as meaningful
 * as whatever's actually wired into its `audio`-role inlet(s) -- resolved recursively, backward
 * through `doc.nets`, by `wirePolarity.ts`. Every other value is a FIXED bucket this primitive's
 * own DSP always produces regardless of wiring (an oscillator's output is always `'audio'` even
 * though its `fm` inlet is itself `audio`-role).
 */
export type PrimitiveOutletPolarity = WirePolarityBucket | 'inherit'

/** `WirePolarityBucket` plus the resolver-only `'neutral'`: inputs that disagree, or a cycle. */
export type ResolvedWireBucket = WirePolarityBucket | 'neutral'

/** What `LoguePrimitive.refinePolarity` reads about one node. */
export interface PolarityRefineContext {
  /** The bucket arriving at an inlet, `undefined` while it's unwired (it reads 0). */
  inlet: (name: string) => ResolvedWireBucket | undefined
  /** A param's stored value, or its spec default. */
  param: (name: string) => number
}

/**
 * One named signal outlet a primitive exposes -- omitted (a primitive's own `outlets` field left
 * `undefined`) for the implicit single `'out'` outlet every primitive before `logue/filter/svf`
 * has. No `role` here (unlike `PrimitiveInletSpec`) and no `polarity` either -- `toFlowGraph.ts`
 * colours a wire from the SOURCE primitive's own `outletPolarity` (see `LoguePrimitive`), which
 * covers a multi-outlet primitive uniformly except `logue/sense/*`'s `unipolar`/`bipolar` pair,
 * the one case that varies by outlet NAME rather than by primitive -- see `outletPolarity`'s own
 * doc comment for how that's expressed without a per-`PrimitiveOutletSpec` field.
 */
export interface PrimitiveOutletSpec {
  name: string
}

/**
 * Resolves a net's raw `NetSource.outlet` field against a primitive's OWN current declared
 * outlets -- the one shared decision `oscInstances.ts`'s `resolveSourceOutlet` (codegen, throws
 * a named error on a genuinely unrecognized name) and `toFlowGraph.ts` (canvas edge validity/
 * handle id, never throws -- an unresolvable net just renders as an invalid/dashed edge) both
 * need, kept in exactly one place so the two can never quietly disagree about which nets are
 * actually fine. A primitive declaring 0 or 1 outlets has only one possible value to read, so the
 * raw field is ignored entirely (`'out'` by default). A primitive declaring 2+ outlets is
 * addressed by one of those real names, `rawOutlet` absent falls back to the FIRST declared one,
 * and a raw name of literally `'out'` that isn't itself declared ALSO falls back to the first
 * declared one -- `'out'` is the implicit name `ports.ts` stamps on every single-outlet
 * primitive's one handle, so it's what an already-authored net reliably carries from BEFORE its
 * source primitive grew multiple outlets (the `logue/sense/*` `unipolar`/`bipolar` split is the
 * first real case -- see `sensePitchPrimitive`'s own doc comment), not an arbitrary stale name.
 * Returns `undefined` only for a name that's neither declared nor that one legacy fallback -- a
 * genuinely broken reference.
 */
/**
 * The one source wired into `nodeName`'s `inletName`, ignoring a net with several sources (a
 * fan-in conflict is the edge-validity check's job, not a colour/polarity walk's). Structural net
 * shape, so this leaf module stays free of `shared/domain` imports.
 */
export function findSingleWiredSource<S extends { obj: string; outlet?: string }>(
  nets: readonly { sources: readonly S[]; dests: readonly { obj: string; inlet?: string }[] }[],
  nodeName: string,
  inletName: string
): S | undefined {
  for (const net of nets) {
    if (net.sources.length !== 1) continue
    if (net.dests.some((d) => d.obj === nodeName && d.inlet === inletName)) return net.sources[0]
  }
  return undefined
}

/** `outletName`'s declared polarity, plus -- for `'inherit'` -- which inlets it inherits from:
 *  a subpatch stand-in's own `inheritFrom`, else every `audio`-role inlet. */
export function outletPolarityOf(
  primitive: Pick<LoguePrimitive, 'outletPolarity' | 'inheritFrom' | 'inlets'>,
  outletName: string
): { declared: PrimitiveOutletPolarity; inheritInlets: string[] } {
  const declared =
    typeof primitive.outletPolarity === 'string'
      ? primitive.outletPolarity
      : (primitive.outletPolarity[outletName] ?? 'inherit')
  const inheritInlets =
    primitive.inheritFrom?.[outletName] ??
    (primitive.inlets ?? []).filter((i) => i.role === 'audio').map((i) => i.name)
  return { declared, inheritInlets }
}

/**
 * A buffer wire: an outlet declared `'buffer'` carries a reference to a ring buffer (the
 * writer's SDRAM line), not a value, and may only go to a `buffer`-role inlet. The one
 * polarity bucket codegen reads -- the reference is what the reader's code is generated against.
 */
export function isBufferOutlet(
  primitive: Pick<LoguePrimitive, 'outletPolarity' | 'inheritFrom' | 'inlets'>,
  outletName: string
): boolean {
  return outletPolarityOf(primitive, outletName).declared === 'buffer'
}

export function isBufferInlet(
  primitive: Pick<LoguePrimitive, 'inlets'>,
  inletName: string
): boolean {
  return primitive.inlets?.some((i) => i.name === inletName && i.role === 'buffer') ?? false
}

/** The current spec a stored param name resolves to -- directly, or via a value-preserving
 *  `renamedParams` alias (see `FieldAlias`). */
export function findParamSpec(
  primitive: Pick<LoguePrimitive, 'params' | 'renamedParams'>,
  storedName: string
): PrimitiveParamSpec | undefined {
  const direct = primitive.params?.find((spec) => spec.name === storedName)
  if (direct) return direct
  const alias = primitive.renamedParams?.find((a) => a.from === storedName && a.valuePreserving)
  return alias ? primitive.params?.find((spec) => spec.name === alias.to) : undefined
}

export function resolveDeclaredOutletName(
  primitive: Pick<LoguePrimitive, 'outlets'>,
  rawOutlet: string | undefined
): string | undefined {
  const declaredOutlets = primitive.outlets ?? [{ name: 'out' }]
  // A node that only takes input (a bus send, a subpatch's outlet port) answers to no name.
  if (declaredOutlets.length === 0) return undefined
  if (declaredOutlets.length === 1) return declaredOutlets[0].name
  const name = rawOutlet ?? declaredOutlets[0].name
  if (name === 'out' && !declaredOutlets.some((o) => o.name === 'out')) {
    return declaredOutlets[0].name
  }
  return declaredOutlets.some((o) => o.name === name) ? name : undefined
}

/**
 * One field-level rename recorded on the primitive whose param/inlet it belongs to -- added
 * after a real, twice-repeated incident (2026-09-20/21): `logue/filter/comb`'s own `FEEDBACK`/
 * `DELAY` params and `feedback`/`delay` inlets were renamed to `GAIN`/`CUTOFF`/`gain`/`cutoff`
 * (phase 33) with no migration, and a user's own already-authored `.loguepatch` file silently
 * stopped working (an old-named `ParamValue` just falls back to `spec.default`; an old-named net
 * endpoint just stops resolving to any port at all -- no error either way, see
 * `unresolvedReferences.ts`'s own doc comment for the full incident writeup). `valuePreserving`
 * is the load-bearing field: `true` means the OLD name's stored value means EXACTLY the same
 * thing as the new name's (a pure rename, safe to silently carry the value across -- e.g.
 * `FEEDBACK`->`GAIN`, identical formula/scale, only the label changed) and is auto-applied by
 * `findAliasedFieldValue` wherever a param/inlet is resolved by name. `false` means the rename
 * ALSO changed what the value means (e.g. `DELAY`->`CUTOFF`'s direction inversion -- an old
 * `DELAY=20` is a SHORT delay, but `CUTOFF=20` under the identical-looking new name is a LONG
 * one) -- carrying the raw number across automatically would silently produce a musically wrong
 * result with no error, which is worse than the current stale-reference bug it would "fix", so
 * these are surfaced as an unresolved reference instead (`findUnresolvedReferences`) and left for
 * the user to re-tune by ear, same as `comb.loguepatch`/`combnew.loguepatch` were actually fixed
 * by hand earlier in this incident. `note` is shown alongside that surfaced warning to explain
 * WHY it wasn't auto-migrated -- required whenever `valuePreserving` is `false` (an unexplained
 * "can't auto-fix this" warning would be as unhelpful as no warning at all).
 */
export interface FieldAlias {
  /** The old, stale name a `.loguepatch` file authored before this primitive's own rename may
   *  still carry -- never the CURRENT name (that's `to`, or implicit from context). */
  from: string
  /** The current param/inlet name this old name was renamed to. */
  to: string
  valuePreserving: boolean
  /** Required when `valuePreserving` is `false` -- see this interface's own doc comment. */
  note?: string
}

export interface LoguePrimitive {
  /** The canonical node `type` id a `PatchDocument`'s `ObjNode` must carry to match. */
  id: string
  /**
   * One brief, plain-language sentence describing what this primitive does musically/
   * functionally -- shown at the bottom of Inspector.tsx when an instance is selected. Required
   * (not optional) for the same reason `PrimitiveInletSpec.role` is: a new primitive's author
   * should decide this deliberately, not silently ship with no help text. User-facing, so it
   * avoids this file's own internal jargon (`renderExpr`, `instanceSuffix`, member names) in
   * favor of what a patcher actually hears/controls.
   */
  description: string
  /**
   * Platforms this primitive's own `renderExpr`/state genuinely works on -- omit for "both"
   * (every primitive before phase 7 reads/writes nothing platform-specific, so both is the
   * correct default). The `logue/sense/*` primitives are the
   * first to break that: they decode raw fields from one platform's own hardware-input shape
   * (minilogue xd's `user_osc_param_t`/`OSC_PARAM`, or -- once researched, phase 30/32 --
   * NTS-1 mkII's `unit_runtime_osc_context_t`/fixed param slots), with no equivalent on the
   * other platform -- rather than silently emit meaningless code there, they declare their own
   * single supported platform and get rejected with a clear, named error at export time if
   * placed in a document targeting the other one (`oscInstances.ts`'s
   * `assertPrimitivesSupportPlatform`), and filtered out of that target's own palette
   * (`LoguePrimitivePalette.tsx`) before a user can even place one.
   */
  platforms?: LoguePlatform[]
  /**
   * The unit types this primitive works in; omit = all of them. Set to `['osc']` on a primitive
   * that reads what only an oscillator gets (the played note, velocity, the oscillator's Shape
   * or filter knobs). Checked like `platforms` (`assertPrimitivesSupportModule`).
   */
  modules?: LogueModule[]
  /**
   * Set on a primitive kept only so older documents still build: the palette no longer offers
   * it, and opening or pasting a document rewrites it to this id (`renamedFields.ts`). Unlike a
   * `RENAMED_PRIMITIVE_IDS` entry the old id still resolves to its own implementation, because the
   * rewrite also sets fields (a knob binding) a plain id swap can't express, and subpatch
   * definitions read at Export/Build time are never rewritten.
   */
  supersededBy?: string
  /**
   * What a bus node becomes once `resolveBuses` (`buses.ts`) has chained it: never offered in the
   * palette, never placed by hand. The user places the bus nodes, which aren't registry entries.
   */
  internal?: true
  /**
   * Extra words palette search matches, for a word people use for this primitive that isn't
   * its name or a former id: "invert" means -x to some and 1-x to others, so both `negate` and
   * `one-minus` list it.
   */
  searchTerms?: string[]
  /**
   * What a node's header shows instead of the id (`uni→bi` for `util/unipolar-to-bipolar`), for
   * a small helper whose id is long next to what it does. Display only; the id stays the
   * tooltip.
   */
  shortLabel?: string
  /**
   * The name a newly placed instance gets instead of the id's last segment (`u2b`). Plain
   * `[a-zA-Z0-9_]`, since a node name becomes part of generated member names.
   */
  defaultName?: string
  /**
   * Ordered named signal inlets this primitive accepts -- omit/empty for a pure source (every
   * oscillator). A primitive with inlets reads them from `renderExpr`'s second parameter, never
   * from `doc.nets` itself (graph wiring is `oscInstances.ts`'s job, not a primitive's).
   */
  inlets?: PrimitiveInletSpec[]
  /**
   * Inlets read only in `advanceStatement`, i.e. after every compute statement of the sample, so
   * the value used is always the previous sample's. A wire into one doesn't order the graph --
   * the one way `resolveAudioGraph` allows a feedback loop (`logue/util/sample-delay`). A
   * primitive listing an inlet here must never read it from `renderExpr`/`renderOutletStatements`
   * (pinned by `logue-feedback.spec.ts`).
   */
  delayedInlets?: string[]
  /**
   * Values computed once per block, before the sample loop, as `const float` locals -- for an
   * expression that only reads per-block state (params, the played note) while its inputs are
   * unwired, e.g. `svf`'s `svf_tan` of the tracked note. Built with `blockValue` (shared.ts) from
   * the same call `renderExpr` uses, so the declaration and the reference can't disagree.
   * Locals, not members: no RAM cost.
   */
  blockConstants?(
    instanceSuffix: string,
    inlets: Record<string, string | undefined>
  ): Array<{ name: string; expr: string }>
  /**
   * Ordered named signal outlets this primitive exposes -- omit for the implicit single `'out'`
   * outlet every primitive before `logue/filter/svf` has (unnamed in `doc.nets`, matched by
   * `oscInstances.ts`'s `resolveSourceOutlet` regardless of whatever a net's own `NetSource.outlet`
   * says -- a single-outlet primitive has only one possible value to read, so a stale/legacy net
   * field naming something else is harmlessly ignored). Declare 2+ when a primitive's own
   * per-sample state computation genuinely produces more than one usable tap at once (e.g. an SVF
   * filter's simultaneous lowpass/bandpass/highpass) -- see `renderOutletStatements` below, the
   * codegen hook a multi-outlet primitive uses INSTEAD of `renderExpr`.
   */
  outlets?: PrimitiveOutletSpec[]
  /**
   * How this primitive's own outlet(s) should be classified for wire/dot colour (`portColors.ts`,
   * via `wirePolarity.ts`) -- see `PrimitiveOutletPolarity`/`WirePolarityBucket`'s own doc
   * comments for the four fixed buckets plus `'inherit'`. A plain value applies to every outlet
   * this primitive has (correct for every multi-outlet primitive today except one); a primitive
   * whose outlets genuinely differ by NAME -- currently only `logue/sense/*`'s own `unipolar`/
   * `bipolar` pair -- supplies `Record<outletName, PrimitiveOutletPolarity>` instead. Required,
   * not optional with a default, for the same "a new primitive won't compile until its author
   * decides" reason `PrimitiveInletSpec.role` already established -- an inheriting default would
   * silently mis-colour the next primitive added (a plain source with no inlets to inherit from
   * would need to be an explicit, deliberate choice, not a fallback).
   */
  outletPolarity: PrimitiveOutletPolarity | Record<string, PrimitiveOutletPolarity>
  /**
   * Only set on a primitive SYNTHESIZED for a subpatch instance (`subpatches.ts`): for an
   * `'inherit'` outlet, exactly which inlets it's actually wired through to inside the
   * definition. `wirePolarity.ts` walks these instead of every `audio`-role inlet, so a subpatch
   * that passes one inlet through and uses another only as modulation colours its outlet from the
   * right one. Hand-written primitives never need it.
   */
  inheritFrom?: Record<string, string[]>
  /**
   * Display-only, for an `'inherit'` outlet: corrects the inherited bucket from what the node
   * does to its inputs' RANGE -- `max(env, 0)` can't go negative, `env - env` can. `undefined`
   * keeps the inherited one. Wire warnings (`InletExpectation.warnFrom`) read the result, so a
   * wrong `inherit` here is a false warning or a missing one. A param edit that changes the result
   * remounts the canvas (`setLogueParam`).
   */
  refinePolarity?: (ctx: PolarityRefineContext) => WirePolarityBucket | undefined
  /**
   * Exact per-instance RAM footprint of `memberDecls` below, in bytes -- hand-counted from that
   * same method's own declared fields (every scalar `float`/`int`/`uint32_t` member is 4 bytes on
   * the real ARM target, no padding; an array like `logue/filter/comb`'s `buf_[512]` adds its
   * full `4 * length`), not measured or estimated. Required, not derived by parsing
   * `memberDecls`'s own template-string output at runtime -- parsing generated C++ text to count
   * its own declarations back out would be far more fragile than a primitive's author just
   * writing the number down next to the fields it describes, the same "required so a side table
   * can't rot" argument `PrimitiveInletSpec.role` already established. Backs
   * `estimateOscStateCost.ts`'s real-not-fabricated RAM estimate -- deliberately the ONLY cost
   * dimension exposed here: an equivalent per-primitive CODE-size number would need calibration
   * against real Docker builds, and the ~14 measured builds on record
   * are whole-graph totals across wildly different graphs, not
   * controlled single-primitive deltas -- nowhere near enough to fit 37 primitives' worth of
   * coefficients without just inventing them (see `project_cost_estimator_deferred` memory's own
   * account of why a CPU number was declined for the identical reason).
   */
  stateBytesPerInstance: number
  /**
   * Stateless: the outputs depend only on params and inlets (no init, no advance, no note hooks,
   * no members but params). A pure instance whose wired inlets all come from other such
   * instances is computed once per block instead of per sample (`oscBody.ts`' `hoistedSuffixes`):
   * knob-only math chains then cost nothing per sample. Set it only on a primitive that really is.
   */
  pure?: true
  /** Per-instance member variable declarations, one instance suffix substituted per placed node. */
  memberDecls(instanceSuffix: string): string
  /**
   * Per-instance `init()` body (e.g. zeroing a phase accumulator) -- optional, omit for a
   * stateless primitive (e.g. a mixer) that declares no member vars needing a reset value.
   */
  initStatement?(instanceSuffix: string, node?: InstanceNodeData): string
  /**
   * Helpers that depend on the placed NODE's own data, not just the primitive -- the one case
   * today is `logue/osc/granular`'s baked sample table, keyed by content hash so two instances
   * playing the same sample still emit (and pay for) it once. Every reader of `helpers`
   * (`oscBody.ts`, `estimateOscStateCost.ts`) must also read this, or codegen and the RAM
   * estimate drift apart.
   */
  instanceHelpers?(node: InstanceNodeData): HelperBlock[]
  /**
   * Reads `ObjNode.sample`, imported the way named: `granular` (mu-law, resampled to fit a size,
   * `importWavSample`), `plain` (linear 8-bit at the source's rate, `importPlainSample`) or
   * `wavetable` (`wt8` single-cycle frames, `importWavetable`).
   * The Inspector's sample section and every test that places a node-aware primitive read it.
   */
  sampleImport?: 'granular' | 'plain' | 'wavetable'
  /**
   * A reason this placed node can't generate code yet (e.g. no sample loaded), or undefined.
   * Checked for active instances only (`resolveAudioGraph`), so an unwired, incomplete node
   * doesn't block an Export; also surfaced on canvas by `findUnresolvedReferences`.
   */
  instanceProblem?(node: InstanceNodeData): string | undefined
  /**
   * Floats of SDRAM this instance needs, from its own node (e.g. a structural RANGE param); only
   * an effect unit has SDRAM, so a primitive setting this is limited to effect `modules`. The
   * generator declares `float *sdram_<suffix>` pointing at that many floats, zeroed in `init()`
   * (the device hands SDRAM over dirty), and keeps every instance's share inside the unit's
   * budget (`unitKinds.ts`' `sdramBytes`).
   */
  sdramFloats?(node: InstanceNodeData): number
  /**
   * Per-sample expression yielding this instance's own contribution (a `float`, range roughly
   * [-1,1]) -- `inlets` maps each declared inlet name (see `PrimitiveInletSpec` above) to the
   * upstream instance's own computed variable name, or is absent for an inlet left unwired.
   * Required (even on a multi-outlet primitive, which never actually calls it -- `oscBody.ts`
   * branches on `renderOutletStatements` being present first) rather than optional: this project's
   * `noImplicitAny: false` tsconfig means an optional field that's actually missing resolves
   * silently to `undefined` calling code can still "call" under `any`-flavored typing elsewhere,
   * not a compile error -- there's a real launch-crash precedent
   * for exactly this class of mistake. A multi-outlet primitive gives this a throwing stub.
   */
  renderExpr(instanceSuffix: string, inlets: Record<string, string | undefined>): string
  /**
   * Only for a primitive declaring 2+ `outlets` -- emits the FULL per-sample statement block,
   * including every declared outlet's own `float y_<suffix>_<outletName> = ...;` line itself
   * (unlike single-outlet `renderExpr`, which returns just the expression and lets `oscBody.ts`
   * emit the `float y_<suffix> = ...;` wrapper around it). Needed because a multi-outlet
   * primitive's shared per-sample state update (e.g. one SVF step producing lp/bp/hp together)
   * must run exactly ONCE regardless of how many of its outlets are actually wired anywhere --
   * three independent `renderExpr`-shaped calls would either recompute (wasteful) or double-mutate
   * (wrong) that shared state. `oscBody.ts`'s `computeStatements` builder checks for this field
   * first, falling back to the ordinary single-outlet `renderExpr` path when it's absent.
   *
   * Every declared outlet's own `y_<suffix>_<name>` local should be `(void)`-cast right after
   * it's computed (see `svfFilterPrimitive`'s own implementation) -- a real placed instance often
   * only wires SOME of its outlets downstream, and an unwired one would otherwise be a genuine
   * unused-local-variable compiler warning; the cast is harmless on a tap that IS used too.
   */
  renderOutletStatements?(
    instanceSuffix: string,
    inlets: Record<string, string | undefined>
  ): string
  /**
   * Per-sample phase/state advance, emitted after `renderExpr` reads the pre-advance state.
   * `inlets` has the SAME shape/resolution as `renderExpr`'s own -- needed by any primitive
   * whose ADVANCE (not render) depends on a wired inlet (e.g. an oscillator's `pitch` inlet
   * affects its phase INCREMENT, not the current sample's value; `sine-lfo`'s `rate` inlet is
   * the same shape). Every primitive that doesn't need this simply omits the parameter --
   * TypeScript accepts a callback with fewer declared params than the interface expects.
   */
  advanceStatement(instanceSuffix: string, inlets: Record<string, string | undefined>): string
  /**
   * Shared static helper method(s) this primitive's `renderExpr`/`params` call into, keyed so
   * two primitives needing the SAME helper (e.g. saw and square both need `polyblep`) emit it
   * once regardless of how many instances of either are placed -- see `generateOscH`'s dedup.
   * An array for a primitive needing more than one genuinely independent top-level helper (e.g.
   * `logue/env/ad` needs its own step function, a rate-conversion helper AND `clampf`, none a
   * real dependency of the other) -- most primitives still only need one.
   */
  helpers?: HelperBlock | HelperBlock[]
  /**
   * Param(s) this primitive supports exposing to the logue unit host -- a node's own
   * `ParamValue` binds to one of these by matching `name`, and only takes effect once that
   * `ParamValue` also carries a `logueParamIndex` (see `generateOscUnit.ts`'s
   * `resolveExposedParams`). A primitive with no real params (every oscillator added before
   * this one) simply omits this.
   */
  params?: PrimitiveParamSpec[]
  /**
   * Old `PrimitiveParamSpec.name`s this primitive's own params were renamed from -- see
   * `FieldAlias`'s own doc comment for the full mechanism/rationale. Omit for a primitive that's
   * never renamed a param (the vast majority); `resolveExposedParams`/`resolveParamDefaultValue`
   * (`oscParams.ts`) and `findUnresolvedReferences` are the only readers.
   */
  renamedParams?: FieldAlias[]
  /**
   * Old `PrimitiveInletSpec.name`s this primitive's own inlets were renamed from -- same
   * mechanism as `renamedParams`, for wireable inlets instead of params. `oscInstances.ts`'s
   * `resolveAudioGraph` and `findUnresolvedReferences` are the only readers.
   */
  renamedInlets?: FieldAlias[]
  /**
   * Per-instance code run when the platform's real note-on event fires -- a real, always-emitted
   * `Osc::noteOn`/`OSC_NOTEON` hook on both platforms
   * (harmless empty body when no active instance needs it). Optional; only an envelope-shaped
   * primitive needs this -- an oscillator/filter/mixer has no note-triggered state of its own.
   * `note.velocity` is a C expression for the raw 0..127 note-on velocity, set only on a platform
   * that delivers one (NTS-1 mkII; the minilogue xd's oscillator API carries none).
   */
  noteOnStatement?(instanceSuffix: string, note: { velocity?: string }): string
  /** Reads `note.velocity` in `noteOnStatement` -- the generator only names its velocity
   *  parameter when an active primitive sets this, so other units' source doesn't change. */
  readsVelocity?: boolean
  /**
   * The note-off counterpart (phase 29, added for `logue/env/ahd`) -- same "always emitted,
   * harmlessly empty" shape as `noteOnStatement`, wired into a real `Osc::noteOff`/`OSC_NOTEOFF`
   * override on both platforms. Didn't exist before phase 29 because nothing needed it: a plain
   * AD envelope (`logue/env/ad`) deliberately ignores note-off entirely (see its own doc comment
   * on why), and every other primitive is either stateless or note-pitch-driven with no
   * note-off-shaped event to react to. Add more uses only once a primitive actually needs one,
   * matching this project's "grow only as needed" discipline.
   */
  noteOffStatement?(instanceSuffix: string): string
}

/** The slice of a placed `ObjNode` a node-aware hook may read -- structural, so this file keeps
 *  importing nothing at runtime. */
export interface InstanceNodeData {
  name?: string
  sample?: SampleAsset
  params?: readonly ParamValue[]
}

export interface HelperBlock {
  key: string
  code: string
  /** Other helper keys this one calls into -- transitively resolved by `resolveHelperChain`. */
  dependsOn?: string[]
  /**
   * Exact size, in bytes, of any `static const` table this helper's own `code` embeds (e.g.
   * `logue/osc/additive`'s baked `kAdditiveFrames[6][512]` wavetable bank) -- omit for the vast
   * majority of helpers, which are pure code with no embedded data. This is a genuinely
   * DIFFERENT kind of cost than `LoguePrimitive.stateBytesPerInstance`: a `static const` table
   * inside a helper function is emitted exactly ONCE regardless of how many active instances
   * reference it (the same dedup `resolveHelperChain`/`HELPER_REGISTRY` already give the
   * helper's own CODE), not once per instance -- `estimateOscStateCost.ts` sums this over the
   * deduped active helper set, not per instance, for exactly that reason. Added after a real,
   * user-caught gap: `logue/osc/additive` shipped with a real 12KB+ wavetable bank and the RAM
   * estimator's own `stateBytesPerInstance`-only model (which only ever looks at `memberDecls`,
   * per-instance members) had no way to see it at all, silently under-reporting a single additive
   * oscillator's real footprint by more than a third of minilogue xd's entire 32K budget.
   * `test/logue-helperSharedBytes.spec.ts` closes the same "hand-counted but unenforced" gap
   * `test/logue-stateBytesPerInstance.spec.ts` already closes for `stateBytesPerInstance` -- a
   * small parser re-derives this number from the helper's own `code` string and pins it.
   */
  sharedBytes?: number
}

export interface PrimitiveParamSpec {
  /** Must match a node's own `ParamValue.name` for that param to bind to this spec -- a fixed
   * internal binding key, not necessarily what's shown/exported (see `freeLabel`). */
  name: string
  /**
   * Fixed when the unit is built (it sizes something, like `logue/util/long-delay`'s RANGE its
   * SDRAM buffer), so no device control may move it: exposing it, binding it to a knob or making
   * it follow a slot is an export error (`oscParams.ts`).
   */
  structural?: true
  /** Raw on-device UI range -- matches the plain 0..1023 10-bit knob convention every real NTS-1 mkII example (`dummy-osc`, phase 1's `axomodern-poc1`) uses for its own custom params. */
  min: number
  max: number
  default: number
  /**
   * When true, this param's EXPORTED manifest/param-table name comes from the placed
   * instance's own authored `ParamValue.label`, not this spec's fixed `name` -- only
   * `logue/sense/param` sets this: a generic, freely-labeled
   * multi-engine param slot has no inherent semantic name the way `CUTOFF`/`GAIN` do.
   * `resolveExposedParams` (`oscParams.ts`) requires a non-empty label whenever this is true
   * AND the param is exposed (`logueParamIndex` set) -- an unexposed instance needs no label.
   */
  freeLabel?: boolean
  /**
   * When set, this param's raw value is only ever meaningful at multiples of `step` (e.g.
   * `COARSE`'s whole semitones -- there's no such thing as half a semitone of coarse tuning) --
   * the UI editors (`ParamDial.tsx`'s drag/keyboard/type-to-edit, `Inspector.tsx`'s field) snap
   * every commit to the nearest multiple via `snapToStep` below, so a dragged or typed value can
   * never land on a fractional in-between number. Undefined (most params) means any raw value in
   * `[min,max]` is valid, unchanged from before this field existed.
   */
  step?: number
  /** Only on a stand-in's param -- a subpatch's promoted param (`subpatches.ts`) or a placed bus
   *  send's GAIN (`buses.ts`): the real primitive param it ultimately edits, through any number
   *  of nesting levels -- what presentation lookups (units, checkbox widgets) resolve instead of
   *  the stand-in's own spec. */
  promotedFrom?: { primitiveId: string; paramName: string }
  // Presentation only (canvas and device menus) -- see paramPresentation.ts for each type. None of
  // these reach the generated DSP; `booleanWidget`/`select`/`nts1mkiiType` do shape the
  // manifest/header param entry.
  /** A real-world display unit for the raw value. */
  unit?: ParamUnit
  /** The unit follows another param of the node; `unit` is the one at that param's default. */
  unitDependsOn?: ParamUnitDependency
  /** The inlet that changes this param's effective value when wired, and how. */
  modulatedBy?: ParamModulation
  /** Rendered as a checkbox; also a two-step device param. */
  booleanWidget?: BooleanParamWidget
  /** Inert while its primitive's `TRACK`/`SYNC` is in one position. */
  trackGate?: ParamTrackGate
  /** NTS-1 mkII `k_unit_param_type_*` suffix (`semi`, `cents`, `percent`); unset means `none`. */
  nts1mkiiType?: string
  /** A hard select shown on the device as discrete choices. */
  select?: SelectParam
  /** NTS-1 mkII: a `strings` row over the spec's own range, one label per integer value from
   *  `min` -- names for a continuous param (`logue/env/one-knob-adsr`'s SHAPE). */
  nts1mkiiStrings?: readonly string[]
  /** The per-instance member assignment converting the raw 0..1023 int into this primitive's own internal representation, e.g. `duty_${suffix} = param_10bit_to_f32(value);`. */
  setStatement(instanceSuffix: string, valueExpr: string): string
}

/** The primitive id + param name a param's presentation (unit, widget) is keyed by: its own, or
 *  for a promoted subpatch param the leaf primitive param it edits. */
export function presentationKeyOf(
  primitiveId: string,
  spec: Pick<PrimitiveParamSpec, 'name' | 'promotedFrom'>
): { primitiveId: string; paramName: string } {
  return spec.promotedFrom ?? { primitiveId, paramName: spec.name }
}

/** Rounds `value` to the nearest multiple of `step` -- a no-op (returns `value` unchanged) when
 *  `step` is undefined, so every caller can apply this unconditionally regardless of whether the
 *  param it's editing actually declares one. See `PrimitiveParamSpec.step`'s own doc comment. */
export function snapToStep(value: number, step: number | undefined): number {
  return step ? Math.round(value / step) * step : value
}
