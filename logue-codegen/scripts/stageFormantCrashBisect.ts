/**
 * Real-hardware bisect for a user-reported minilogue xd crash ("kind of crashes ... UI gets
 * unfunctional, changing patches doesn't work", reproduces even with a single voice) on a patch
 * combining `logue/filter/formant` with `logue/sense/shape`/`shift-shape`/`param` wired into its
 * vowel/shift/resonance inlets. Every math path in the generated code was traced by hand and
 * found sound (no NaN/div-by-zero/UB), and the exact patch compiles clean via a real Docker
 * build -- so this stages 3 minimal builds to isolate which single ingredient is responsible,
 * since `logue/sense/shift-shape` specifically has never been confirmed on real hardware before
 * (unlike `sense/shape`/`sense/pitch`, phase 30, and `sense/shape-alt`, phase 32) and is the one
 * genuinely unproven component in the original patch.
 *
 * 1. formant-alone: saw -> formant (all defaults, nothing wired to vowel/shift/resonance) ->
 *    audio-out. If THIS crashes, the bug is in formant's own baseline code/CPU cost, unrelated
 *    to any sense primitive.
 * 2. shiftshape-alone: saw -> vca(gain <- sense/shift-shape) -> audio-out. Isolates
 *    `sense/shift-shape` itself with zero formant involvement.
 * 3. formant-with-shape: saw -> formant(vowel <- sense/shape) -> audio-out. `sense/shape` is
 *    already hardware-proven, so this isolates "formant under live modulation" without involving
 *    the unproven shift-shape/param combination.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const targets: Array<{ dirName: string; unitName: string; doc: PatchDocument }> = [
  {
    dirName: 'axomodern-bisect-formant-alone',
    unitName: 'bisect formant alone',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/filter/formant', name: 'formant1', x: 0, y: 0, params: [] },
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
    dirName: 'axomodern-bisect-shiftshape-alone',
    unitName: 'bisect shiftshape alone',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/sense/shift-shape',
          name: 'shiftshape1',
          x: 0,
          y: 0,
          params: []
        },
        { kind: 'obj', type: 'logue/gain/vca', name: 'vca1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
        {
          sources: [{ obj: 'shiftshape1', outlet: 'out' }],
          dests: [{ obj: 'vca1', inlet: 'gain' }]
        },
        { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }
  },
  {
    dirName: 'axomodern-bisect-formant-with-shape',
    unitName: 'bisect formant with shape',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/sense/shape', name: 'shape1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/filter/formant', name: 'formant1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'formant1', inlet: 'in' }] },
        {
          sources: [{ obj: 'shape1', outlet: 'out' }],
          dests: [{ obj: 'formant1', inlet: 'vowel' }]
        },
        { sources: [{ obj: 'formant1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
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
