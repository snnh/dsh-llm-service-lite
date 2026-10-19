/**
 * Apply the adapter's researched family defaults to a provider's model catalog.
 *
 * The Host keeps the same table for the request path; this browser-side helper
 * exists because the model-defaults registration seam is a dsh-lite addition
 * that upstream harnesses do not carry, so the configuration surface cannot ask
 * the Host over a remote. The table is bundled and applied here instead, with
 * the same rule the request path follows: a profile field always wins, and only
 * what the catalog left open is filled.
 *
 * @module @snnh/dsh-llm-service-lite/client/family-defaults
 */

import { declaredDefaultsOf } from '../model-defaults.ts'
import { modelsOf } from './model.ts'
import type {
  ClientModel,
  ClientProvider,
  ModelCapabilities,
  ModelDefaults,
} from './types.ts'

/** One model the action filled, with the fields it wrote and the table's source note. */
export interface AppliedModelDefault {
  /** Model id as the profile spells it. */
  readonly id: string
  /** Fields the action filled on this model, in write order. */
  readonly fields: readonly string[]
  /** The vendor documentation the declarations were read from. */
  readonly note?: string
}

/** What one catalog-wide application changed. */
export interface ModelDefaultsApplication {
  /** The catalog after the application; unrelated fields are untouched. */
  readonly models: ClientModel[]
  /** Every matched model, in catalog order, with the fields that were filled. */
  readonly applied: readonly AppliedModelDefault[]
  /** Model ids no table entry speaks for; those models are unchanged. */
  readonly unmatched: readonly string[]
}

/**
 * Fill the family defaults into the fields a model catalog left open.
 *
 * Context capacity, output capacity, capability declarations, and request
 * defaults are filled only where the model states nothing, so a profile that
 * already answered keeps its answer; sampling parameters are never filled,
 * because the table deliberately declares none.
 * @param provider - the staged provider profile (its protocol selects the Anthropic cap rule).
 * @returns the catalog to stage, plus what matched and what did not.
 */
export function applyModelDefaults(provider: ClientProvider): ModelDefaultsApplication {
  const applied: AppliedModelDefault[] = []
  const unmatched: string[] = []
  const models = modelsOf(provider).map((model) => {
    const id = model.id.trim()
    if (id.length === 0) return model
    const declared = declaredDefaultsOf(id, provider.interfaceType)
    if (declared === undefined) {
      unmatched.push(id)
      return model
    }
    const fields: string[] = []
    const next: ClientModel = { ...model }
    if (next.contextWindow === undefined && declared.contextWindow !== undefined) {
      next.contextWindow = declared.contextWindow
      fields.push('contextWindow')
    }
    if (next.maxTokens === undefined && declared.maxTokens !== undefined) {
      next.maxTokens = declared.maxTokens
      fields.push('maxTokens')
    }
    const declaredCapabilities = declared.capabilities ?? {}
    const capabilities = { ...(next.capabilities ?? {}) } as Record<string, unknown>
    for (const [key, value] of Object.entries(declaredCapabilities)) {
      // A resolved schema may materialize an unset list as `[]`; an empty
      // list says as little as an absent one and must not block a default.
      const current = capabilities[key]
      if (current !== undefined && !(Array.isArray(current) && current.length === 0)) continue
      capabilities[key] = value
      fields.push(`capabilities.${key}`)
    }
    if (fields.some(field => field.startsWith('capabilities.'))) {
      next.capabilities = capabilities as ModelCapabilities
    }
    const declaredDefaults = declared.defaults ?? {}
    const defaults = { ...(next.defaults ?? {}) } as Record<string, unknown>
    for (const [key, value] of Object.entries(declaredDefaults)) {
      if (defaults[key] !== undefined) continue
      defaults[key] = value
      fields.push(`defaults.${key}`)
    }
    if (fields.some(field => field.startsWith('defaults.'))) {
      next.defaults = defaults as ModelDefaults
    }
    applied.push({
      id: model.id,
      fields,
      ...declared.note === undefined ? {} : { note: declared.note },
    })
    return next
  })
  return { models, applied, unmatched }
}
