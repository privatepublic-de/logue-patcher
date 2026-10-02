/**
 * Post-fix verification for a real minilogue xd `-Os`-specific crash a user hit on real
 * hardware with `logue/filter/formant` (2026-09-19): "kind of crashes... UI gets unfunctional".
 * See `formant_step`'s own doc comment in `primitives.ts` for the full bisect story -- short
 * version: an 11-build real-hardware bisect ruled out every DSP/numeric/logic explanation and
 * isolated it to a real GCC `-Os` codegen issue that only manifests when `formant`'s own two
 * helpers (and, for a more heavily-wired graph, the shared `note_w0` LUT call too) stay as real,
 * separate function calls rather than being inlined -- confirmed by a `-O2` rebuild of the exact
 * crashing source NOT crashing. Fixed by force-inlining `formant_bp_step`/`formant_g_from_note`
 * plus a formant-only force-inlined duplicate of `note_w0` (`formant_note_w0`), eliminating every
 * real function call from formant's own per-sample hot path -- confirmed via disassembly
 * (`formant_step` has zero `bl` instructions) and, on real hardware, no longer crashing.
 *
 * Two targets, both confirmed fixed on real hardware:
 * 1. senseparam-single-wired: the minimal original repro (`stageFormantCrashBisect2.ts`'s
 *    `senseparam-alone` target) -- a single wired `resonance` inlet.
 * 2. triple-wired: `vowel`/`shift`/`resonance` all wired at once (the shape the user's own
 *    original, more heavily-wired patch actually needed) -- the case that exposed the FIRST fix
 *    attempt (force-inlining just the two formant-specific helpers) as only a partial fix.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { generateOldGenOscUnit } from '../src/minilogue-xd/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const platformDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/minilogue-xd'

const targets: Array<{ dirName: string; unitName: string; doc: PatchDocument }> = [
  {
    dirName: 'axomodern-formant-fix-verify-single-wired',
    unitName: 'formant fix verify single wired',
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
    dirName: 'axomodern-formant-fix-verify-triple-wired',
    unitName: 'formant fix verify triple wired',
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
