import type { LogueModule, PatchDocument } from '../../../src/shared/domain/patch'
import { isEffectModule } from '../unitKinds'
import { withSubpatchPaths, type SubpatchDefinitions } from '../subpatches'
import { generateOscUnit } from './generateOscUnit'
import { generateFxUnit } from './generateFxUnit'

/** A document's NTS-1 mkII unit source, whichever module it targets, for Export and Build (the
 *  minilogue xd counterpart is `minilogue-xd/projectFiles.ts`). */
export interface Nts1MkiiProject {
  module: LogueModule
  /** File name -> text, as the Korg template for `module` lays its project out. */
  files: Record<string, string>
  /** The Makefile's `PROJECT`: the built unit is `<project>.nts1mkiiunit`. */
  project: 'osc' | 'fx'
}

export function generateNts1MkiiProject(
  doc: PatchDocument,
  unitName: string,
  subpatches: SubpatchDefinitions = new Map(),
  ids: { devId?: number; unitId?: number } = {}
): Nts1MkiiProject {
  const module = doc.settings.logueTarget?.module ?? 'osc'
  if (isEffectModule(module)) {
    const fx = withSubpatchPaths(doc, subpatches, () =>
      generateFxUnit(doc, { name: unitName, ...ids }, subpatches)
    )
    return {
      module,
      files: { 'header.c': fx.headerC, 'fx.h': fx.fxH, 'unit.cc': fx.unitCc },
      project: 'fx'
    }
  }
  const osc = withSubpatchPaths(doc, subpatches, () =>
    generateOscUnit(doc, { name: unitName, ...ids }, subpatches)
  )
  return {
    module,
    files: { 'header.c': osc.headerC, 'osc.h': osc.oscH, 'unit.cc': osc.unitCc },
    project: 'osc'
  }
}

/**
 * The `config.mk` a build stages next to the generated files. The rest of the project (its
 * `Makefile`, `wasm.cc`) is Korg's `dummy-<module>` template, copied as it is: the generator
 * never writes a build scaffold for this platform.
 */
export function nts1mkiiConfigMk(project: Nts1MkiiProject): string {
  return `PROJECT := ${project.project}\nPROJECT_TYPE := ${project.module}\nUCSRC = header.c\nUCXXSRC = unit.cc\nUASMSRC =\nUASMXSRC =\nUINCDIR  =\nULIBDIR =\nULIBS  = -lm\nUDEFS =\n`
}
