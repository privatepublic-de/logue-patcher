import type { LogueModule, PatchDocument } from '../../../src/shared/domain/patch'
import { isEffectModule } from '../unitKinds'
import type { SubpatchDefinitions } from '../subpatches'
import { generateOldGenOscUnit } from './generateOscUnit'
import { generateOldGenFxUnit } from './generateFxUnit'

/** A document's whole minilogue xd project, whichever module it targets: what Export writes and
 *  Build stages. The scaffold is embedded, so these files alone build. */
export interface MinilogueXdProject {
  module: LogueModule
  /** Path relative to the project folder -> text. */
  files: Record<string, string>
  /** project.mk's `PROJECT`: the built unit is `<project>.mnlgxdunit`. */
  project: 'osc' | 'fx'
}

export function generateMinilogueXdProject(
  doc: PatchDocument,
  unitName: string,
  subpatches: SubpatchDefinitions = new Map()
): MinilogueXdProject {
  const module = doc.settings.logueTarget?.module ?? 'osc'
  if (isEffectModule(module)) {
    const fx = generateOldGenFxUnit(doc, { name: unitName }, subpatches)
    return {
      module,
      project: 'fx',
      files: {
        'manifest.json': fx.manifestJson,
        'project.mk': fx.projectMk,
        'fx.cpp': fx.fxCpp,
        Makefile: fx.makefile,
        'tpl/_unit.c': fx.unitC,
        'ld/rules.ld': fx.rulesLd,
        [`ld/user${fx.module}.ld`]: fx.moduleLd,
        'ld/main_api.syms': fx.mainApiSyms
      }
    }
  }
  const osc = generateOldGenOscUnit(doc, { name: unitName }, subpatches)
  return {
    module,
    project: 'osc',
    files: {
      'manifest.json': osc.manifestJson,
      'project.mk': osc.projectMk,
      'osc.cpp': osc.oscCpp,
      Makefile: osc.makefile,
      'tpl/_unit.c': osc.unitC,
      'ld/rules.ld': osc.rulesLd,
      'ld/userosc.ld': osc.useroscLd,
      'ld/osc_api.syms': osc.oscApiSyms
    }
  }
}
