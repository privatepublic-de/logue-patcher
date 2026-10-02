import { describe, it, expect } from 'vitest'
import { generateOscUnit } from '../logue-codegen/src/nts1mkii/generateOscUnit'
import {
  CHOICE_NAME_MAX_LEN,
  KNOB_ENV_SHAPE,
  KNOB_ENV_SHAPE_DEVICE_STRINGS,
  KNOB_ENV_SHAPE_NAMES
} from '../logue-codegen/src/paramPresentation'
import {
  resolveMinilogueXdDeviceParam,
  resolveNts1mkiiDeviceParam
} from '../logue-codegen/src/paramDeviceType'
import { findLoguePrimitive } from '../logue-codegen/src/primitives'
import type { PatchDocument } from '../src/shared/domain/patch'

const SHAPE = { name: 'SHAPE', min: 0, max: 100 }

describe('logue/env/one-knob-adsr SHAPE', () => {
  it('names every station at its own value, and a blend in between', () => {
    KNOB_ENV_SHAPE_NAMES.forEach((name, k) => {
      const value = Math.round((k * 100) / (KNOB_ENV_SHAPE_NAMES.length - 1))
      expect(KNOB_ENV_SHAPE.toDisplay(value)).toBe(name)
      expect(KNOB_ENV_SHAPE_DEVICE_STRINGS[value]).toBe(name)
      expect(KNOB_ENV_SHAPE.parseInput(name.toUpperCase())).toBe(value)
    })
    expect(KNOB_ENV_SHAPE.toDisplay(4)).toBe('Blip–Pluck')
    expect(KNOB_ENV_SHAPE_DEVICE_STRINGS[4]).toBe('Blp-Plk')
  })

  it('has one NTS-1 mkII label per value, each short enough for the display', () => {
    expect(KNOB_ENV_SHAPE_DEVICE_STRINGS).toHaveLength(101)
    for (const s of KNOB_ENV_SHAPE_DEVICE_STRINGS) {
      expect(s.length).toBeLessThanOrEqual(CHOICE_NAME_MAX_LEN)
      expect(s).not.toContain('#')
    }
  })

  it('is a strings row on NTS-1 mkII over its own range, and a plain percent on the xd', () => {
    const id = 'logue/env/one-knob-adsr'
    expect(resolveNts1mkiiDeviceParam(id, SHAPE)).toMatchObject({
      min: 0,
      max: 100,
      type: 'strings',
      scale: 1
    })
    expect(resolveMinilogueXdDeviceParam(id, SHAPE)).toEqual({
      min: 0,
      max: 100,
      type: '%',
      scale: 1
    })
  })

  it('the generated unit labels SHAPE through unit_get_param_str_value', () => {
    const doc: PatchDocument = {
      nodes: [
        {
          kind: 'obj',
          type: 'logue/env/one-knob-adsr',
          name: 'env1',
          x: 0,
          y: 0,
          params: [{ name: 'SHAPE', value: '17', logueParamIndex: { nts1mkii: 2 } }]
        },
        { kind: 'obj', type: 'logue/io/audio-out', name: 'out', x: 0, y: 0, params: [] }
      ],
      nets: [{ sources: [{ obj: 'env1', outlet: 'out' }], dests: [{ obj: 'out', inlet: 'in' }] }],
      settings: {},
      notes: ''
    }
    const unit = generateOscUnit(doc, { name: 'test' })
    expect(unit.headerC).toContain('{0, 100, 0, 17, k_unit_param_type_strings')
    expect(unit.unitCc).toContain('"Mallet"')
    expect(unit.unitCc).toContain('return strs[value - 0];')
  })

  it('the C mapping uses the same station spacing and plateau as the labels', () => {
    const code = [findLoguePrimitive('logue/env/one-knob-adsr')!.helpers ?? []]
      .flat()
      .map((h) => h.code)
      .join('')
    expect(code).toContain(`* ${((KNOB_ENV_SHAPE_NAMES.length - 1) / 100).toFixed(2)}f;`)
    expect(code).toContain('- 0.2f) * (1.f / 0.6f)')
    expect(code).toContain(`knob_env_table[${KNOB_ENV_SHAPE_NAMES.length * 4}]`)
  })
})
