/**
 * Follow-up to stageSensePitchShape.ts: that first test graph
 * wired logue/sense/pitch and logue/sense/shape directly into a mixer and out to audio-out --
 * proving the num_params/build/upload path worked (it did, confirmed on real hardware), but
 * producing no audible sound, since neither sense primitive is an audio-rate source -- they're
 * control-rate values meant to feed another primitive's OWN control inlet, same as phase 7's own
 * flagship minilogue xd example (saw -> filter, cutoff <- sense/pitch), never wired straight to
 * output on their own.
 *
 * This graph actually produces continuous sound and exercises both sensed values audibly:
 *  - saw -> filter (cutoff <- sense/pitch): the filter's brightness should track the played
 *    note -- same mechanism already proven working via the pre-existing setPitch/context->pitch
 *    read every other primitive in this registry already relies on.
 *  - filter -> vca (gain <- sense/shape): gain is FULL-REPLACE (not additive), so the output
 *    starts SILENT until the physical SHAPE knob is turned up from its default (this is expected,
 *    not a bug -- shapeParam01_ inits to 0). Turning the knob should raise the volume; routing
 *    the device's own Mod-LFO to Shape should then modulate the volume over time even without
 *    touching the knob (proves the context->shape_lfo read).
 */
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import { generateOscUnit } from '../src/nts1mkii/generateOscUnit'
import type { PatchDocument } from '../../src/shared/domain/patch'

const templateDir = '/Users/peter/Documents/GitHub/logue-sdk/platform/nts-1_mkii/dummy-osc'
const nts1Dir = '/Users/peter/Documents/GitHub/logue-sdk/platform/nts-1_mkii'

const projectName = 'axomodern_poc_nts1_sense_demo'
const dirName = 'axomodern-poc-nts1-sense-demo'

const doc: PatchDocument = {
  nodes: [
    { kind: 'obj', type: 'logue/osc/saw', name: 'saw1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/sense/pitch', name: 'pitch1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/sense/shape', name: 'shape1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/filter/lowpass-cheap', name: 'filt1', x: 0, y: 0, params: [{ name: 'CUTOFF', value: '0' }] },
    { kind: 'obj', type: 'logue/gain/vca', name: 'vca1', x: 0, y: 0, params: [] },
    { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
  ],
  nets: [
    { sources: [{ obj: 'saw1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'in' }] },
    { sources: [{ obj: 'pitch1', outlet: 'out' }], dests: [{ obj: 'filt1', inlet: 'cutoff' }] },
    { sources: [{ obj: 'filt1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'in' }] },
    { sources: [{ obj: 'shape1', outlet: 'out' }], dests: [{ obj: 'vca1', inlet: 'gain' }] },
    { sources: [{ obj: 'vca1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }
  ],
  settings: {},
  notes: ''
}

const result = generateOscUnit(doc, { name: 'poc nts1 sense2' })
const projectDir = join(nts1Dir, dirName)
if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true })

writeFileSync(join(projectDir, 'header.c'), result.headerC)
writeFileSync(join(projectDir, 'osc.h'), result.oscH)
writeFileSync(join(projectDir, 'unit.cc'), result.unitCc)
copyFileSync(join(templateDir, 'Makefile'), join(projectDir, 'Makefile'))
copyFileSync(join(templateDir, 'wasm.cc'), join(projectDir, 'wasm.cc'))
writeFileSync(
  join(projectDir, 'config.mk'),
  `PROJECT := ${projectName}\nPROJECT_TYPE := osc\nUCSRC = header.c\nUCXXSRC = unit.cc\nUASMSRC =\nUASMXSRC =\nUINCDIR  =\nULIBDIR =\nULIBS  = -lm\nUDEFS =\n`
)
console.log(`Staged saw -> filter(cutoff<-pitch) -> vca(gain<-shape) into ${projectDir}`)
