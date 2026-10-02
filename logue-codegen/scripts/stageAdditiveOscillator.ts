/**
 * One-off verification script for v1 `logue/osc/additive`: writes
 * the generated minilogue xd `osc.cpp` (TIMBRE=100, so the aliasing clamp is actually exercised)
 * to `harness/minilogue-xd/osc_real.cpp` for a host-native run -- see that harness's own
 * `main.cpp` doc comment for how to compile/run it. Not staged into a real logue-sdk checkout
 * (no Docker build attempted this pass) -- a real Docker build and hardware test are still the
 * user's own next step.
 */
import { writeFileSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const doc: PatchDocument = {
  nodes: [
    {
      kind: 'obj',
      type: 'logue/osc/additive',
      name: 'add1',
      x: 0,
      y: 0,
      params: [{ name: 'TIMBRE', value: '100', logueParamIndex: { 'minilogue-xd': 0 } }]
    },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [{ sources: [{ obj: 'add1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
  settings: {},
  notes: ''
}

const result = generateOldGenOscUnit(doc, { name: 'additive harness' })
const harnessPath = join(__dirname, '..', 'harness', 'minilogue-xd', 'osc_real.cpp')
writeFileSync(harnessPath, result.oscCpp)
console.log(`Wrote ${harnessPath} (${result.oscCpp.length} bytes)`)
