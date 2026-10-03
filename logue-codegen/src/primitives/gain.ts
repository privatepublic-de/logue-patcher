import { VCA_GAIN_DB } from '../paramPresentation'
import type { LoguePrimitive } from './types'

/**
 * A VCA: `in * gain`. A wired `gain` fully replaces the `GAIN` param and is used as is (not
 * scaled by the param's `* 0.04f`).
 *
 * `GAIN` maps 0-100 to 0-4x (`* 0.04f`, default 25 = unity) so it can make up the level of quiet
 * sources such as `logue/filter/formant` at high RESONANCE. Why here: automatic gain compensation
 * in formant would bring back clipping on harmonically tuned sources (its bands are unity peak
 * gain), a separate boost primitive would duplicate `vca`, and a LEVEL param on formant would
 * cost one of the xd's 6 slots. The scale widened rather than the manifest range because the xd
 * rejects a custom param range much beyond +-100. Disclosed silent change: in an existing
 * document, `GAIN=100` was unity and is now +12 dB. History: docs/HISTORY.md.
 */
export const vcaPrimitive: LoguePrimitive = {
  id: 'logue/gain/vca',
  outletPolarity: 'inherit',
  stateBytesPerInstance: 4, // gain_, 1 float
  description: "A voltage-controlled amplifier -- scales an audio signal's level, up to +12 dB.",
  inlets: [
    { name: 'in', role: 'audio' },
    { name: 'gain', role: 'control' }
  ],
  memberDecls: (suffix) => `  float gain_${suffix};\n`,
  renderExpr: (suffix, inlets) =>
    `((${inlets.in ?? '0.f'}) * (${inlets.gain ?? `gain_${suffix}`}))`,
  advanceStatement: () => '',
  params: [
    {
      name: 'GAIN',
      unit: VCA_GAIN_DB,
      modulatedBy: {
        inlet: 'gain',
        shape: 'replace',
        expects: {
          range: 'a 0..1 level, 1 = unity, used as is',
          warnFrom: ['bipolar'],
          warning:
            'A −1..1 signal here turns the sound upside down for its negative half (ring modulation), so it never fades out. For a tremolo, put a bipolar to unipolar in between; to keep only the positive half (an envelope that dips below 0), a max with b unwired.'
        }
      },
      min: 0,
      max: 100,
      default: 25,
      // The `* 0.04f` here is mirrored in `paramUnits.ts`'s `VCA_GAIN_DB` (for the canvas dial's
      // dB display) -- changing it without updating that mirror silently breaks the display.
      setStatement: (suffix, valueExpr) => `gain_${suffix} = ${valueExpr} * 0.04f;`
    }
  ]
}
