/**
 * Round 2 of the real-hardware bisect for the minilogue xd formant-patch crash. Round 1 (see
 * stageFormantCrashBisect.ts) tested formant alone, sense/shift-shape alone, and formant with
 * ONLY sense/shape wired -- all 3 confirmed working correctly on real hardware once retested
 * after a full device reboot (the original "noise"/"nothing changes" reports were stale state
 * from not rebooting between uploads, not real bugs). Two ingredients from the original crashing
 * patch were never individually isolated:
 *
 * 4. sense-param-alone: saw -> formant(resonance <- sense/param, VALUE=60 unexposed) -> out.
 *    The one sense primitive round 1 never tested at all.
 * 5. formant-triple-wired: saw -> formant(vowel <- sense/shape, shift <- sense/shift-shape,
 *    resonance <- sense/param) -> out, no VCA stage. Tests whether wiring THREE simultaneous
 *    sense-sourced control inlets into the SAME primitive at once (never tested -- round 1 only
 *    ever wired one modulation source at a time) is itself the trigger, independent of the VCA/
 *    GAIN=71 stage the original patch also had.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const targets: Array<{ dirName: string; unitName: string; doc: PatchDocument }> = [
  {
    dirName: 'axomodern-bisect-senseparam-alone',
    unitName: 'bisect senseparam alone',
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
        { kind: 'obj', type: 'logue/filter/formant', name: 'formant1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'formant1', inlet: 'in' }] },
        {
          sources: [{ obj: 'param1', outlet: 'out' }],
          dests: [{ obj: 'formant1', inlet: 'resonance' }]
        },
        { sources: [{ obj: 'formant1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
      ],
      settings: {},
      notes: ''
    }
  },
  {
    dirName: 'axomodern-bisect-formant-triple-wired',
    unitName: 'bisect formant triple wired',
    doc: {
      nodes: [
        { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/sense/shape', name: 'shape1', x: 0, y: 0, params: [] },
        {
          kind: 'obj',
          type: 'logue/sense/shift-shape',
          name: 'shiftshape1',
          x: 0,
          y: 0,
          params: []
        },
        {
          kind: 'obj',
          type: 'logue/sense/param',
          name: 'param1',
          x: 0,
          y: 0,
          params: [{ name: 'VALUE', value: '60' }]
        },
        { kind: 'obj', type: 'logue/filter/formant', name: 'formant1', x: 0, y: 0, params: [] },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [
        { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'formant1', inlet: 'in' }] },
        {
          sources: [{ obj: 'shape1', outlet: 'out' }],
          dests: [{ obj: 'formant1', inlet: 'vowel' }]
        },
        {
          sources: [{ obj: 'shiftshape1', outlet: 'out' }],
          dests: [{ obj: 'formant1', inlet: 'shift' }]
        },
        {
          sources: [{ obj: 'param1', outlet: 'out' }],
          dests: [{ obj: 'formant1', inlet: 'resonance' }]
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
