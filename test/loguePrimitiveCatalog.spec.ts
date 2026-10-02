import { describe, expect, it } from 'vitest'
import {
  type PrimitiveCatalogEntry,
  CATEGORY_COLORS,
  COMMENT_ENTRY,
  controlPresetEntries,
  insertArgsFor,
  categoryForPrimitiveId,
  colorForCategory,
  compareCategories,
  LOCAL_SUBPATCH_CATEGORY,
  groupByCategory,
  listInsertablePrimitives,
  restrictedPlatforms,
  stripLoguePrefix,
  supportsPlatform,
  matchesFilter,
  unsupportedPlatforms
} from '../src/renderer/src/browser/loguePrimitiveCatalog'

describe('colorForCategory', () => {
  it('gives every category the registry actually produces its own fixed color', () => {
    const categories = new Set(
      listInsertablePrimitives().map((entry) => categoryForPrimitiveId(entry.id))
    )
    for (const category of categories) {
      expect(CATEGORY_COLORS[category], category).toBeDefined()
    }
  })

  it('never gives two different categories the same color', () => {
    const colors = Object.values(CATEGORY_COLORS)
    expect(new Set(colors).size).toBe(colors.length)
  })

  it('falls back to a fixed neutral color for an id shaped without a category', () => {
    expect(colorForCategory('other')).toBe('#8a8a8a')
  })
})

// No longer used to FILTER what's insertable (every
// primitive is always insertable now), only to compute ObjectNode.tsx's own advisory badge.
describe('supportsPlatform / unsupportedPlatforms', () => {
  it('a platform-agnostic primitive supports both platforms, with nothing unsupported', () => {
    expect(supportsPlatform('logue/osc/sine', 'nts1mkii')).toBe(true)
    expect(supportsPlatform('logue/osc/sine', 'minilogue-xd')).toBe(true)
    expect(unsupportedPlatforms('logue/osc/sine')).toEqual([])
  })

  it('a minilogue-xd-only primitive is unsupported on nts1mkii specifically', () => {
    expect(supportsPlatform('logue/sense/param', 'minilogue-xd')).toBe(true)
    expect(supportsPlatform('logue/sense/param', 'nts1mkii')).toBe(false)
    expect(unsupportedPlatforms('logue/sense/param')).toEqual(['nts1mkii'])
  })

  it('an unrecognized id supports every platform (nothing to restrict against)', () => {
    expect(supportsPlatform('logue/bogus/id', 'nts1mkii')).toBe(true)
    expect(unsupportedPlatforms('logue/bogus/id')).toEqual([])
  })
})

// ObjectNode.tsx's own "Only on X" badge, the positive-framing counterpart to
// unsupportedPlatforms' "Not on Y" above.
describe('restrictedPlatforms', () => {
  it('is empty for a platform-agnostic primitive', () => {
    expect(restrictedPlatforms('logue/osc/sine')).toEqual([])
  })

  it('lists exactly the platform(s) a restricted primitive is supported on', () => {
    expect(restrictedPlatforms('logue/sense/param')).toEqual(['minilogue-xd'])
  })

  it('is empty for an unrecognized id', () => {
    expect(restrictedPlatforms('logue/bogus/id')).toEqual([])
  })
})

describe('groupByCategory', () => {
  it('sorts each category alphabetically by label, not registry order', () => {
    const groups = groupByCategory(listInsertablePrimitives())
    const oscLabels = groups.get('osc')!.map((e) => e.label)
    expect(oscLabels).toEqual([...oscLabels].sort((a, b) => a.localeCompare(b)))
    // A real, meaningful reorder against the registry's own declaration order (sine is declared
    // first in primitives.ts, but "noise" sorts before it) -- not a coincidentally-already-sorted
    // list that a bug wouldn't have caught.
    expect(oscLabels.indexOf('noise')).toBeLessThan(oscLabels.indexOf('sine'))
  })

  it('sorts every category, not just one', () => {
    const groups = groupByCategory(listInsertablePrimitives())
    for (const [category, entries] of groups) {
      const labels = entries.map((e) => e.label)
      expect(labels, category).toEqual([...labels].sort((a, b) => a.localeCompare(b)))
    }
  })
})

describe('compareCategories', () => {
  it('sorts native categories A-Z, then every subpatch group after them', () => {
    const sorted = ['util', 'subpatch/bass', 'annotate', 'subpatch', 'osc', 'subpatch/a'].sort(
      compareCategories
    )
    expect(sorted).toEqual(['annotate', 'osc', 'util', 'subpatch', 'subpatch/a', 'subpatch/bass'])
  })

  it("puts the patch folder's own subpatches first among the subpatch groups", () => {
    const sorted = ['subpatch/bass', 'osc', LOCAL_SUBPATCH_CATEGORY, 'subpatch'].sort(
      compareCategories
    )
    expect(sorted).toEqual(['osc', LOCAL_SUBPATCH_CATEGORY, 'subpatch', 'subpatch/bass'])
  })
})

describe('stripLoguePrefix', () => {
  it('discards the leading "logue/" root', () => {
    expect(stripLoguePrefix('logue/osc/sine')).toBe('osc/sine')
    expect(stripLoguePrefix('logue/io/audio-out')).toBe('io/audio-out')
  })

  it('leaves a type with no such prefix untouched', () => {
    expect(stripLoguePrefix('env/adsr')).toBe('env/adsr')
  })
})

describe('catalog descriptions', () => {
  it('every insertable entry, the comment included, carries a non-empty description', () => {
    for (const entry of [COMMENT_ENTRY, ...listInsertablePrimitives()]) {
      expect(entry.description.trim(), entry.id).not.toBe('')
    }
  })
})

describe('COMMENT_ENTRY', () => {
  it('sits in its own colored annotate group, not among any primitive category', () => {
    const primitiveCategories = new Set(listInsertablePrimitives().map((entry) => entry.category))
    expect(primitiveCategories.has(COMMENT_ENTRY.category)).toBe(false)
    expect(CATEGORY_COLORS[COMMENT_ENTRY.category]).toBeDefined()
  })

  it('is found by typing part of "comment" or the group name', () => {
    expect(matchesFilter(COMMENT_ENTRY, 'comm')).toBe(true)
    expect(matchesFilter(COMMENT_ENTRY, 'annot')).toBe(true)
    expect(matchesFilter(COMMENT_ENTRY, 'osc')).toBe(false)
  })
})

describe('renamed primitives in search', () => {
  const multiply = (): PrimitiveCatalogEntry =>
    listInsertablePrimitives().find((e) => e.id === 'logue/math/multiply')!

  it('logue/math/multiply is still found by its former name "ringmod"', () => {
    expect(matchesFilter(multiply(), 'ringmod')).toBe(true)
    expect(matchesFilter(multiply(), 'multiply')).toBe(true)
  })

  it('its former category doesn\'t match, so typing "mix" doesn\'t list it', () => {
    expect(matchesFilter(multiply(), 'mix')).toBe(false)
  })
})

describe('"invert" names two different operations', () => {
  const entry = (id: string): PrimitiveCatalogEntry =>
    listInsertablePrimitives().find((e) => e.id === id)!

  it('lists both negate (-x) and one-minus (1-x)', () => {
    const hits = listInsertablePrimitives()
      .filter((e) => matchesFilter(e, 'invert'))
      .map((e) => e.id)
    expect(hits).toEqual(expect.arrayContaining(['logue/math/negate', 'logue/math/one-minus']))
  })

  it('a search term matches by part, like a name', () => {
    expect(matchesFilter(entry('logue/math/one-minus'), 'inv')).toBe(true)
    expect(matchesFilter(entry('logue/math/one-minus'), 'negate')).toBe(false)
  })
})

describe('device-control presets', () => {
  it('insert a sense/control already on the knob, on both devices', () => {
    expect(controlPresetEntries('osc').map((e) => e.label)).toEqual([
      'control · shape knob',
      'control · 2nd shape knob'
    ])
    expect(insertArgsFor('logue/sense/control@shape-2')).toEqual({
      type: 'logue/sense/control',
      shortId: 'shape2',
      params: [
        {
          name: 'VALUE',
          value: '50',
          logueKnob: { nts1mkii: 'shape-2', 'minilogue-xd': 'shape-2' }
        }
      ]
    })
  })

  it('leave every other id as a plain insert', () => {
    expect(insertArgsFor('logue/osc/saw')).toEqual({ type: 'logue/osc/saw', shortId: 'saw' })
    expect(insertArgsFor('logue/sense/control')).toEqual({
      type: 'logue/sense/control',
      shortId: 'control'
    })
  })

  it("offer an effect's own knobs, MIX only where the unit has one", () => {
    expect(controlPresetEntries('modfx').map((e) => e.label)).toEqual([
      'control · time knob',
      'control · depth knob'
    ])
    expect(controlPresetEntries('delfx').map((e) => e.label)).toEqual([
      'control · time knob',
      'control · depth knob',
      'control · mix'
    ])
    expect(insertArgsFor('logue/sense/control@mix').params?.[0].logueKnob).toEqual({
      nts1mkii: 'mix',
      'minilogue-xd': 'mix'
    })
  })

  it('are found by "shape" and filed under sense', () => {
    for (const entry of controlPresetEntries('osc')) {
      expect(entry.category).toBe('sense')
      expect(matchesFilter(entry, 'shape')).toBe(true)
    }
  })
})

describe('module filtering', () => {
  const ids = (module?: 'osc' | 'delfx'): string[] =>
    listInsertablePrimitives(module).map((e) => e.id)

  it('hides what can never build in that kind of patch', () => {
    expect(ids('osc')).not.toContain('logue/util/long-delay')
    expect(ids('osc')).toContain('logue/sense/gate')
    expect(ids('delfx')).toContain('logue/util/long-delay')
    expect(ids('delfx')).not.toContain('logue/sense/gate')
    expect(ids('delfx')).not.toContain('logue/env/ahd')
    expect(ids('delfx')).toContain('logue/sense/control')
  })

  it('offers everything without a module (a subpatch definition)', () => {
    expect(ids()).toContain('logue/util/long-delay')
    expect(ids()).toContain('logue/sense/gate')
  })
})
