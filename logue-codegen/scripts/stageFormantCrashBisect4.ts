/**
 * Round 4, the decisive fork: round 3 proved `sense/param` alone is fine (into vca.gain, #7) and
 * `formant` with a STATIC RESONANCE=90 is fine (#6) -- yet `sense/param` wired into
 * `formant.resonance` crashes (#4). Disassembly comparison of #4 vs #6's `process()` found
 * nothing suspicious: identical helper call pattern (3x formant_bp_step, 3x
 * formant_g_from_note, 2x note_w0), ~15 extra instructions for the wired clamp/multiply (the
 * expected, negligible cost of the additive-inlet expression) -- ruling out both a compiler
 * miscompilation and a CPU-cost explanation.
 *
 * 8. senseparam-into-vowel: saw -> formant(vowel <- sense/param) -> out. Same `sense/param`
 *    node, same STATIC (unexposed, never-updating) source, same `formant` primitive -- the ONLY
 *    change from crashing target #4 is which inlet the wire lands on (vowel instead of
 *    resonance). If this crashes too, the bug is "sense/param -> formant via ANY inlet" (since
 *    `sense/shape` -> `formant.vowel` was already proven fine in #3, that would mean it's
 *    specific to `sense/param` as a SOURCE feeding formant, not to `resonance` as a
 *    DESTINATION -- worth then looking at `sense/param`'s own per-instance member declaration
 *    order in `resolveAudioGraph`, since it's the only sense primitive with real per-instance
 *    state). If this does NOT crash, the bug is specific to formant's `resonance` inlet.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const doc: PatchDocument = {
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
      dests: [{ obj: 'formant1', inlet: 'vowel' }]
    },
    { sources: [{ obj: 'formant1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

const result = generateOldGenOscUnit(doc, { name: 'bisect senseparam into vowel' })
const projectDir = join(platformDir, 'axomodern-bisect-senseparam-into-vowel')
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
console.log(`Staged into ${projectDir}`)
