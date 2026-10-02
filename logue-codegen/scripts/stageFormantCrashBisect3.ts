/**
 * Round 3 of the real-hardware bisect. Round 2 found: formant(resonance <- sense/param) crashes
 * ALONE (target #4), even though formant-alone (#1, RESONANCE default 60) and formant(vowel <-
 * sense/shape) (#3) both work. A rigorous single-precision-emulated 10M-sample numerical test
 * found ZERO divergence in formant_bp_step's own state across the entire k range including well
 * below #4's actual k (~0.052) -- ruling out numerical instability as the cause. Two remaining,
 * mutually exclusive hypotheses to separate:
 *
 * 6. formant-static-resonance-90: saw -> formant(RESONANCE=90, a plain STATIC param, no wiring,
 *    no sense/param at all) -> out. If THIS crashes too, resonance=90 itself is the trigger,
 *    completely unrelated to sense/param or wiring -- something real-hardware-specific about
 *    that resonance value/k, not caught by the numerical model.
 * 7. senseparam-into-vca: saw -> vca(gain <- sense/param, VALUE=60 unexposed) -> out. Isolates
 *    `sense/param` completely away from `formant` -- if THIS crashes, `sense/param` itself (or
 *    the codegen path for an unexposed freeLabel param feeding a wired inlet) is the trigger,
 *    regardless of what it feeds into.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const targets: Array<{ dirName: string; unitName: string; doc: PatchDocument }> = [
  {
    dirName: 'axomodern-bisect-formant-static-resonance90',
    unitName: 'bisect formant static res90',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/filter/formant',
          name: 'formant1',
          x: 0,
          y: 0,
          params: [{ name: 'RESONANCE', value: '90' }]
        },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'formant1', inlet: 'in' }] },
        { sources: [{ obj: 'formant1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }
  },
  {
    dirName: 'axomodern-bisect-senseparam-into-vca',
    unitName: 'bisect senseparam into vca',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/sense/param',
          name: 'param1',
          x: 0,
          y: 0,
          params: [{ name: 'VALUE', value: '60' }]
        },
        { kind: 'obj', type: 'logue/gain/vca', name: 'vca1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
        { sources: [{ obj: 'param1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'gain' }] },
        { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }
  }
]

for (const target of targets) {
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
  console.log(`Staged ${target.dirName} into ${projectDir}`)
}
