/**
 * The RAM estimate (`estimateOscStateCost`, with `codeSizeTable.ts`) against whole real builds:
 * the example effects and a few oscillator patches, on both platforms. Prints the error per
 * patch and the band -- the number the Build panel's tooltip and CLAUDE.md quote.
 *
 * Usage: npx tsx logue-codegen/scripts/checkCodeSizeEstimate.ts
 */
import { readFileSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { build, platformRoot } from './codeSizeBuild'
import { estimateOscStateCost } from '../src/estimateOscStateCost'
import { parsePatchFile } from '../../src/shared/json/patchCodec'
import { LOGUE_AUDIO_IN_TYPE, LOGUE_AUDIO_OUT_TYPE } from '../src/oscInstances'
import { bytesToBase64 } from '../src/sample/base64'
import { mulawEncode } from '../src/sample/mulaw'
import type {
  LogueModule,
  LoguePlatform,
  Net,
  ObjNode,
  PatchDocument
} from '../../src/shared/domain/patch'

const here = dirname(new URL(import.meta.url).pathname)
const examples = join(here, '..', '..', 'examples', 'effects')

function obj(name: string, type: string, params: ObjNode['params'] = []): ObjNode {
  return { kind: 'obj', type, name, x: 0, y: 0, params }
}
function wire(from: string, outlet: string, to: string, inlet: string): Net {
  return { sources: [{ obj: from, outlet }], dests: [{ obj: to, inlet }] }
}
function doc(module: LogueModule, nodes: ObjNode[], nets: Net[]): PatchDocument {
  return { nodes, nets, settings: { logueTarget: { module } }, notes: '' }
}
const OUT = obj('out', LOGUE_AUDIO_OUT_TYPE)
const IN = obj('in', LOGUE_AUDIO_IN_TYPE)

function sample(): ObjNode['sample'] {
  const bytes = new Uint8Array(8192)
  let seed = 7
  for (let i = 0; i < bytes.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    bytes[i] = mulawEncode(Math.sin(i / 7) * 0.7 + (seed / 0x7fffffff - 0.5) * 0.1)
  }
  return { sourceName: 'tone', rate: 16000, encoding: 'mulaw8', data: bytesToBase64(bytes) }
}

/** Oscillators through a tree of mix2s: the polyBLEP helpers several of them share. */
const SUPERSAW = doc(
  'osc',
  [
    obj('saw', 'logue/osc/saw'),
    obj('sq', 'logue/osc/square'),
    obj('pulse', 'logue/osc/pulse'),
    obj('sync', 'logue/osc/sync'),
    obj('m1', 'logue/mix/mix2'),
    obj('m2', 'logue/mix/mix2'),
    obj('m3', 'logue/mix/mix2'),
    OUT
  ],
  [
    wire('saw', 'out', 'm1', 'in1'),
    wire('sq', 'out', 'm1', 'in2'),
    wire('pulse', 'out', 'm2', 'in1'),
    wire('sync', 'out', 'm2', 'in2'),
    wire('m1', 'out', 'm3', 'in1'),
    wire('m2', 'out', 'm3', 'in2'),
    wire('m3', 'out', 'out', 'in')
  ]
)
const PLUCK = doc(
  'osc',
  [
    obj('ex', 'logue/osc/exciter'),
    obj('str', 'logue/filter/string'),
    obj('env', 'logue/env/ad'),
    obj('lp', 'logue/filter/svf', [{ name: 'CUTOFF', value: '0' }]),
    obj('vca', 'logue/gain/vca'),
    OUT
  ],
  [
    wire('ex', 'out', 'str', 'in'),
    wire('str', 'out', 'lp', 'in'),
    wire('env', 'out', 'lp', 'cutoff'),
    wire('lp', 'lp', 'vca', 'in'),
    wire('env', 'out', 'vca', 'gain'),
    wire('vca', 'out', 'out', 'in')
  ]
)
const granularNode = obj('g', 'logue/osc/granular')
granularNode.sample = sample()
const GRAINS = doc(
  'osc',
  [
    granularNode,
    obj('lfo', 'logue/lfo/sine-lfo'),
    obj('lfo2', 'logue/lfo/triangle-lfo'),
    obj('mux', 'logue/mux/mux2'),
    OUT
  ],
  [
    wire('lfo', 'out', 'g', 'position'),
    wire('g', 'out', 'mux', 'i1'),
    wire('lfo2', 'out', 'mux', 'sel'),
    wire('mux', 'out', 'out', 'in')
  ]
)
const VOICE = doc(
  'osc',
  [
    obj('saw', 'logue/osc/saw'),
    obj('f', 'logue/filter/formant'),
    obj('lfo', 'logue/lfo/sine-lfo'),
    obj('steps', 'logue/lfo/random-steps'),
    obj('q', 'logue/util/quantize'),
    OUT
  ],
  [
    wire('steps', 'out', 'q', 'in'),
    wire('q', 'pitch', 'saw', 'pitch'),
    wire('saw', 'out', 'f', 'in'),
    wire('lfo', 'out', 'f', 'vowel'),
    wire('f', 'out', 'out', 'in')
  ]
)
const ECHO = doc(
  'delfx',
  [
    IN,
    obj('a', 'logue/util/long-delay', [{ name: 'RANGE', value: '2' }]),
    obj('b', 'logue/util/long-delay', [{ name: 'RANGE', value: '2' }]),
    OUT
  ],
  [
    wire('in', 'l', 'a', 'in'),
    wire('in', 'r', 'b', 'in'),
    wire('a', 'out', 'out', 'l'),
    wire('b', 'out', 'out', 'r')
  ]
)
const RING = doc(
  'modfx',
  [
    IN,
    obj('s', 'logue/osc/sine'),
    obj('m', 'logue/math/multiply'),
    obj('x', 'logue/mix/crossfader'),
    OUT
  ],
  [
    wire('in', 'mono', 'm', 'in1'),
    wire('s', 'out', 'm', 'in2'),
    wire('in', 'mono', 'x', 'in1'),
    wire('m', 'out', 'x', 'in2'),
    wire('x', 'out', 'out', 'l')
  ]
)
const CHORUS = doc(
  'modfx',
  [
    IN,
    obj('lfo', 'logue/lfo/sine-lfo'),
    obj('dl', 'logue/util/delay'),
    obj('dr', 'logue/util/delay'),
    OUT
  ],
  [
    wire('lfo', 'out', 'dl', 'time'),
    wire('lfo', 'out', 'dr', 'time'),
    wire('in', 'l', 'dl', 'in'),
    wire('in', 'r', 'dr', 'in'),
    wire('dl', 'out', 'out', 'l'),
    wire('dr', 'out', 'out', 'r')
  ]
)

const patches: Array<[string, PatchDocument]> = [
  ['supersaw (osc)', SUPERSAW],
  ['pluck (osc)', PLUCK],
  ['grains (osc)', GRAINS],
  ['voice (osc)', VOICE],
  ['echo (delfx)', ECHO],
  ['ring (modfx)', RING],
  ['chorus (modfx)', CHORUS],
  ...(['stereo-reverb', 'auto-wah', 'tempo-swell'] as const).map(
    (name): [string, PatchDocument] => [
      `${name} (example)`,
      parsePatchFile(readFileSync(join(examples, `${name}.loguepatch`), 'utf-8'))
    ]
  )
]

async function main(): Promise<void> {
  const errors: number[] = []
  for (const platform of ['minilogue-xd', 'nts1mkii'] as LoguePlatform[]) {
    const dir = join(
      platformRoot,
      platform === 'nts1mkii' ? 'nts-1_mkii' : 'minilogue-xd',
      'lp-check-code'
    )
    console.log(`\n${platform}`)
    for (const [label, d] of patches) {
      const est = estimateOscStateCost(d, platform)
      if (est.status !== 'ok') {
        console.log(`  skip ${label}: ${est.reason}`)
        continue
      }
      // A miswired test patch would prune nodes from both sides alike and prove nothing.
      const placed = d.nodes.filter(
        (n) => n.kind === 'obj' && n.type !== LOGUE_AUDIO_OUT_TYPE && n.type !== LOGUE_AUDIO_IN_TYPE
      ).length
      if (est.estimate.perInstance.length !== placed) {
        throw new Error(
          `${label}: only ${est.estimate.perInstance.length} of ${placed} nodes reach the output`
        )
      }
      const size = await build(dir, platform, d)
      const real = size.code + size.bss
      const estimated = est.estimate.totalBytes
      const error = (estimated - real) / real
      errors.push(error)
      console.log(
        `  ${label.padEnd(24)} real ${String(real).padStart(6)} B  estimated ${String(estimated).padStart(6)} B  ${(error * 100).toFixed(1).padStart(6)}%  of ${est.estimate.budgetBytes}`
      )
    }
    rmSync(dir, { recursive: true, force: true })
  }
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`
  console.log(`\nband: ${pct(Math.min(...errors))} .. +${pct(Math.max(...errors))}`)
}

void main()
