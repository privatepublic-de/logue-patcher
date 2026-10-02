/**
 * One-off verification script for the wireable ATTACK/DECAY on `logue/env/ad`. Stages one real
 * minilogue xd project: a saw through a VCA whose gain is the
 * envelope, with a `logue/util/constant` wired into the envelope's own `attack` inlet -- the
 * deterministic probe shape phase 19's constant exists for, so the resulting attack time is an
 * exactly-predictable number rather than something to estimate from a spectrum.
 *
 * Also writes the generated `osc.cpp` to `harness/minilogue-xd/osc_real.cpp` for the
 * host-native ASan/UBSan run that actually MEASURES the attack length (a clean Docker compile
 * alone never proves the DSP is right -- CLAUDE.md's own verification convention).
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const target = {
  dirName: 'axomodern-poc-mxd-envinlets',
  unitName: 'poc mxd envinlets',
  doc: {
    nodes: [
      { kind: 'obj', type: 'logue/osc/saw', name: 'osc1', x: 0, y: 0, params: [] },
      {
        kind: 'obj',
        // VALUE=50 -> +0.5 signal -> +0.5*50 = +25 percentage points onto ATTACK's own dialed
        // value, the exact additive/+-50 shape every other percent-domain inlet uses.
        type: 'logue/util/constant',
        name: 'attackOffset',
        x: 0,
        y: 0,
        params: [{ name: 'VALUE', value: '50' }]
      },
      {
        kind: 'obj',
        type: 'logue/env/ad',
        name: 'env1',
        x: 0,
        y: 0,
        params: [
          { name: 'ATTACK', value: '25' },
          { name: 'DECAY', value: '50' }
        ]
      },
      { kind: 'obj', type: 'logue/gain/vca', name: 'vca1', x: 0, y: 0, params: [] },
      { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
    ],
    nets: [
      {
        sources: [{ obj: 'attackOffset', outlet: 'out' }],
        dests: [{ obj: 'env1', inlet: 'attack' }]
      },
      { sources: [{ obj: 'osc1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
      { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'gain' }] },
      { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
    ],
    settings: {},
    notes: ''
  } as PatchDocument
}

const result = generateOldGenOscUnit(target.doc, { name: target.unitName })
const projectDir = join(platformDir, target.dirName)
mkdirSync(join(projectDir, 'ld'), { recursive: true })
mkdirSync(join(projectDir, 'tpl'), { recursive: true })

writeFileSync(join(projectDir, 'manifest.json'), result.manifestJson)
writeFileSync(join(projectDir, 'project.mk'), result.projectMk)
writeFileSync(join(projectDir, 'osc.cpp'), result.oscCpp)
writeFileSync(join(projectDir, 'Makefile'), result.makefile)
writeFileSync(join(projectDir, 'tpl', '_unit.c'), result.unitC)
writeFileSync(join(projectDir, 'ld', 'rules.ld'), result.rulesLd)
writeFileSync(join(projectDir, 'ld', 'userosc.ld'), result.useroscLd)
writeFileSync(join(projectDir, 'ld', 'osc_api.syms'), result.oscApiSyms)

// The harness renders the ENVELOPE ITSELF, not the VCA's output -- an attack ramp is only
// measurable directly, not through a saw whose own sign flips every cycle. Same graph
// otherwise, so the two share every envelope/constant line of generated code.
const harnessDoc: PatchDocument = {
  ...target.doc,
  nodes: target.doc.nodes.filter((n) => n.kind !== 'obj' || n.name !== 'osc1'),
  nets: [
    {
      sources: [{ obj: 'attackOffset', outlet: 'out' }],
      dests: [{ obj: 'env1', inlet: 'attack' }]
    },
    { sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ]
}
const harnessResult = generateOldGenOscUnit(harnessDoc, { name: 'envinlets harness' })
writeFileSync(
  join(__dirname, '..', 'harness', 'minilogue-xd', 'osc_real.cpp'),
  harnessResult.oscCpp
)

console.log(`Staged ${target.dirName} into ${projectDir}`)
console.log('Wrote harness/minilogue-xd/osc_real.cpp (envelope rendered directly)')
