import type { LogueInletRole } from '@logue-codegen/primitives'
import { colorForCategory } from '../browser/loguePrimitiveCatalog'
import type { ResolvedWireBucket } from './wirePolarity'

/**
 * Port/wire colours. This is NOT Axoloti's per-data-type colouring coming back -- a logue
 * signal is still one plain float domain with no frac32/bool32/int32 distinction to paint.
 * It's a purely visual reading aid, because the registry has grown to where a node like
 * `logue/filter/comb` shows five identical dots (`in`/`cutoff`/`gain`/`damping`/`pitch`) and
 * only one of them carries the sound.
 *
 * Colours by SIGNAL SHAPE (`WirePolarityBucket`/`ResolvedWireBucket`, `wirePolarity.ts`), not by
 * the source node's category any more -- an earlier version tinted a control wire by which
 * category (env/lfo/sense/util) sat at its own start, but that duplicates information already
 * visible from the node itself (its titlebar/label already says "this is an LFO"); polarity
 * (does this wire carry 0..1, -1..1, or a discrete 0/1) is NOT otherwise visible anywhere on
 * canvas, and is exactly what determines correctness for an additive-inlet's own depth formula.
 *
 * Kept as named exports (rather than inlined at each call site) so ObjectNode.tsx's port dots
 * and toFlowGraph.ts's wire colour stay identical by construction.
 */

/**
 * The uniform "this carries sound" colour -- every audio inlet, every audio-producing node's
 * outlet, and every audio wire. Deliberately the CATEGORY swatch for `io`
 * (`logue/io/audio-out`'s own category) run through `brightenForWire`, not a colour of its own
 * to keep in sync -- the whole audio signal chain reads as one continuous colour regardless of
 * which primitive (osc/filter/gain/mix/shape) happens to sit at a given point in it, matching
 * `logue/io/audio-out`'s own role as the one place every audio path ultimately leads.
 */
export const PORT_COLOR_AUDIO = brightenForWire(colorForCategory('io'))

/** Blue -- a `unipolar` (`0..1`) signal: an envelope, or a `logue/sense/*` reading. A callback to
 *  the pre-fork Axoloti scheme's own `frac32` (control-rate) blue, and blue/orange is one of the
 *  safer hue pairs under the common forms of colour-vision deficiency. */
export const PORT_COLOR_UNIPOLAR = '#4f8fee'

/**
 * Amber -- a `bipolar` (`-1..1`) signal: an LFO, the multistage envelope, or
 * `logue/util/constant` (fixed bipolar by its own declared domain). Not an oscillator: every
 * `osc/*` outlet is fixed `audio`, also when it's wired into a control inlet. Also the "a param is
 * currently wired/overridden" accent `ParamDial.tsx` uses for its own Modulated/Overridden
 * badge -- picked for separation from two specific neighbours: `PORT_COLOR_AUDIO` above
 * (blue/orange-family hues survive the common colour-vision deficiencies that blue/green
 * wouldn't) and `--color-accent` (`#4fbac7`, base.css) -- TypedEdge.tsx strokes a selection
 * halo in that teal at 45% opacity UNDER the wire's own line, so a colour anywhere near it would
 * go mushy on exactly the wire the user just selected.
 */
export const PORT_COLOR_BIPOLAR = '#e0a33c'

/** Purple -- a `gate` signal: a discrete `0.f`/`1.f` from `logue/logic/*` or
 *  `logue/sense/gate`. A fresh hue rather than a reused category swatch, deliberately: a gate
 *  is categorically different (discrete, not continuous) from every other bucket here, so it
 *  should read as visually "other," not as a shade of an existing one. */
export const PORT_COLOR_GATE = '#9d5fd4'

/** Rose -- a buffer wire (`util/buffer`'s `buf`): not a signal at all but a reference to a
 *  recording ring, so a hue none of the signal buckets use. Its dots are rings
 *  (`patch-node__handle--buffer`), the other half of the cue. */
export const PORT_COLOR_BUFFER = '#e8617f'

/**
 * Neutral warm-gray -- reused for two distinct "nothing more specific to say" cases: (1) a
 * control inlet's own dot while unwired (it accepts modulation from ANY bucket, so it can't
 * commit to one colour until something actually lands on it -- the wire landing on it carries
 * its own real bucket colour instead, see `ObjectNodeData.inletColors`), and (2) a resolved
 * `'neutral'` outlet (`wirePolarity.ts` -- a combiner fed two disagreeing buckets, or a
 * resolution cycle). Reuses `--ev-c-gray-1`'s own literal (base.css) -- the app's existing
 * neutral warm-gray token -- rather than inventing a second one.
 */
export const PORT_COLOR_NEUTRAL = '#6f6559'

/** An absent role (any inlet resolved by wiring-inference) is treated as audio -- see PortInfo.role. */
export function colorForRole(role: LogueInletRole | undefined): string {
  if (role === 'buffer') return PORT_COLOR_BUFFER
  return role === 'control' ? PORT_COLOR_NEUTRAL : PORT_COLOR_AUDIO
}

/** An inlet dot's shape class by role: round audio, square control, a ring for a buffer. */
export function inletShapeClassForRole(role: LogueInletRole | undefined): string {
  if (role === 'buffer') return 'patch-node__handle--buffer'
  return role === 'control' ? 'patch-node__handle--control' : ''
}

/** Paints a resolved outlet/wire bucket (`wirePolarity.ts`) -- the one place all four fixed
 *  colours plus the neutral fallback are chosen from, so a dot and the wire leaving it can never
 *  disagree by construction. */
export function colorForBucket(bucket: ResolvedWireBucket): string {
  switch (bucket) {
    case 'unipolar':
      return PORT_COLOR_UNIPOLAR
    case 'bipolar':
      return PORT_COLOR_BIPOLAR
    case 'gate':
      return PORT_COLOR_GATE
    case 'buffer':
      return PORT_COLOR_BUFFER
    case 'neutral':
      return PORT_COLOR_NEUTRAL
    default:
      return PORT_COLOR_AUDIO
  }
}

/**
 * A shape cue independent of colour, for an OUTLET dot (`ObjectNode.tsx`) -- a small dot's
 * colour is the first thing to go at zoom-out and is unavailable entirely to a colour-blind
 * user, the same reasoning the pre-existing round/square inlet split (`colorForRole`) already
 * established. `'square'` covers both continuous control buckets (unipolar/bipolar -- colour is
 * what tells those two apart) and `'neutral'` (an indeterminate combiner reads as "some kind of
 * control", the honest amount of shape information available); `'diamond'` is reserved for
 * `gate` alone, since a discrete 0/1 signal is categorically different (not continuous) from
 * every other bucket here, not just a different flavour of the same thing.
 */
export function outletShapeClassForBucket(bucket: ResolvedWireBucket): string {
  if (bucket === 'gate') return 'patch-node__handle--gate'
  if (bucket === 'buffer') return 'patch-node__handle--buffer'
  if (bucket === 'audio') return ''
  return 'patch-node__handle--control'
}

/**
 * Any of the bucket colours above at reduced opacity, as `rgba(...)` -- for a dimmer callout
 * (e.g. ParamDial.tsx's own wired-param ring/badge, currently `PORT_COLOR_BIPOLAR`) that still
 * reads as "the same colour", never a second, unrelated one. Takes the plain 6-digit hex literal
 * rather than a CSS variable since none of the bucket colours are defined as one.
 */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  switch (max) {
    case rn:
      h = ((gn - bn) / d) % 6
      break
    case gn:
      h = (bn - rn) / d + 2
      break
    default:
      h = (rn - gn) / d + 4
  }
  h *= 60
  if (h < 0) h += 360
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let [r1, g1, b1] = [0, 0, 0]
  if (h < 60) [r1, g1, b1] = [c, x, 0]
  else if (h < 120) [r1, g1, b1] = [x, c, 0]
  else if (h < 180) [r1, g1, b1] = [0, c, x]
  else if (h < 240) [r1, g1, b1] = [0, x, c]
  else if (h < 300) [r1, g1, b1] = [x, 0, c]
  else [r1, g1, b1] = [c, 0, x]
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255]
}

/**
 * Category swatches (`loguePrimitiveCatalog.ts`'s `CATEGORY_COLORS`) are tuned to sit calmly as
 * a titlebar tint/palette dot; a cable painted at that same muted colour reads as washed-out
 * against the canvas background. Wires push the same hue's saturation and lightness up instead
 * of introducing a second, unrelated colour table to keep in sync with the category one.
 */
export function brightenForWire(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  const [h, s, l] = rgbToHsl(r, g, b)
  const ns = Math.min(1, s * 1.15 + 0.1)
  const nl = Math.min(0.72, l * 1.08 + 0.06)
  return rgbToHex(...hslToRgb(h, ns, nl))
}
