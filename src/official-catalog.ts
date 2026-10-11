/**
 * Conversion of an official model-configuration file into this adapter's own
 * profile vocabulary.
 *
 * An official file — the catalog an official deployment ships as
 * `providers/data/<provider>.json` — groups its entries by API and keys each
 * model by `<type>:<id>`; this adapter serves one protocol per route and names
 * every model by its bare id. The conversion therefore materializes a route
 * profile: the API becomes `interfaceType`, `baseUrl` becomes `baseURL`, each
 * chat entry becomes a model with its capacities, input modalities, and
 * thinking levels, and a model's sampling parameters become its request
 * defaults. A field this adapter has no counterpart for is reported one by
 * one instead of guessed, so a converted profile states exactly what the
 * official file stated and nothing more.
 *
 * @module dsh-llm-service-lite/official-catalog
 */

import type { EffortLevel, InterfaceType, Modality, OwcModelDefaults, OwcModelProfile, ThinkingMode } from './config.ts'

/** Official API names this adapter serves, and the protocol each becomes. */
const OFFICIAL_APIS: Readonly<Record<string, InterfaceType>> = {
  'openai-completions': 'openai-chat-completions',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
}

/** Official model types this adapter serves; every other type is reported. */
const OFFICIAL_CHAT_TYPE = 'chat'

/** Effort levels an official thinking map may name, in this adapter's order. */
const LEVELS_FROM_OFFICIAL: readonly EffortLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Sampling parameters that become request defaults, and the field each feeds. */
const SAMPLING_DEFAULTS: Readonly<Record<string, keyof OwcModelDefaults>> = {
  temperature: 'temperature',
  top_p: 'topP',
  top_k: 'topK',
}

/** Official compat flags that state a mid-history capability this adapter declares. */
const COMPAT_CAPABILITIES: Readonly<Record<string, 'systemPromptUpdate' | 'toolUpdate'>> = {
  supportsMidConvoSystemMessages: 'systemPromptUpdate',
  supportsMidConvoToolAdditions: 'toolUpdate',
}

/** Entry fields the conversion reads; every other field is reported as not carried. */
const KNOWN_ENTRY_FIELDS = new Set([
  'id', 'name', 'api', 'provider', 'baseUrl', 'type', 'input', 'reasoning', 'thinkingLevelMap',
  'contextWindow', 'maxTokens', 'headers', 'samplingParams', 'compat',
])

/** One official entry as the conversion reads it; unlisted keys are reported, never guessed. */
interface OfficialEntry {
  readonly [field: string]: unknown
}

/** The profile facts one official file states, in this adapter's own vocabulary. */
export interface OfficialCatalogProfile {
  /** Protocol every converted model speaks. */
  readonly interfaceType: InterfaceType
  /** Endpoint every converted model shares, when the file names one. */
  readonly baseURL?: string
  /** Request headers every converted model shares, when the file names one set. */
  readonly headers?: Record<string, string>
  /** One entry per official chat model. */
  readonly models: OwcModelProfile[]
}

/** One conversion: the profile facts, and every official field left behind. */
export interface OfficialCatalogConversion {
  /** The route profile the file converts into. */
  readonly profile: OfficialCatalogProfile
  /** One line per official field this adapter has no counterpart for. */
  readonly diagnostics: readonly string[]
}

/** Whether a value is a plain object, which is what every official node must be. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one string field of an official entry, or undefined when it states none. */
function officialString(entry: OfficialEntry, field: string): string | undefined {
  const value = entry[field]
  return typeof value === 'string' ? value : undefined
}

/** Read one finite number field of an official entry, or undefined when it states none. */
function officialNumber(entry: OfficialEntry, field: string): number | undefined {
  const value = entry[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The input modalities one official entry declares, with every value this
 * adapter does not carry reported by name.
 * @param entry - official entry.
 * @param report - diagnostic sink.
 * @returns declared modalities, empty when the entry states none this adapter carries.
 */
function officialModalities(entry: OfficialEntry, report: (message: string) => void): Modality[] {
  const declared = entry['input']
  if (declared === undefined) return []
  if (!Array.isArray(declared)) return []
  const modalities: Modality[] = []
  for (const value of declared as unknown[]) {
    // The official vocabulary names text and image; anything else is a
    // modality this adapter has no part for and does not silently drop.
    if (value === 'text' || value === 'image') {
      if (!modalities.includes(value)) modalities.push(value)
      continue
    }
    report(`input modality "${String(value)}" is not carried`)
  }
  return modalities
}

/**
 * The reasoning selector one official entry declares: the levels its thinking
 * map spells, and whether its endpoint can turn thinking off.
 * @param entry - official entry.
 * @returns declared effort levels and accepted thinking modes.
 */
function officialThinking(entry: OfficialEntry): { effort: EffortLevel[]; thinking: ThinkingMode[] } {
  if (entry['reasoning'] !== true) return { effort: [], thinking: [] }
  const map = entry['thinkingLevelMap']
  const levels = isPlainObject(map) ? map : {}
  const effort = LEVELS_FROM_OFFICIAL.filter(level => typeof levels[level] === 'string')
  // `off` spelled as a value means the endpoint has a switch; `off` spelled as
  // null means it thinks unconditionally, which is the one case this adapter
  // publishes no disabling mode for.
  const thinking: ThinkingMode[] = levels['off'] === null ? ['enabled'] : ['enabled', 'disabled']
  return { effort, thinking }
}

/**
 * The request defaults one official entry declares, from the sampling
 * parameters the two OpenAI-compatible protocols merge into their body.
 * @param entry - official entry.
 * @param report - diagnostic sink.
 * @returns declared defaults, absent fields omitted.
 */
function officialDefaults(entry: OfficialEntry, report: (message: string) => void): OwcModelDefaults | undefined {
  const sampling = entry['samplingParams']
  if (sampling === undefined) return undefined
  if (!isPlainObject(sampling)) return undefined
  const defaults: OwcModelDefaults = {}
  for (const [key, value] of Object.entries(sampling)) {
    const field = SAMPLING_DEFAULTS[key]
    if (field === undefined || typeof value !== 'number' || !Number.isFinite(value)) {
      report(`sampling parameter "${key}" is not carried; only temperature, top_p, and top_k map onto a model's defaults`)
      continue
    }
    defaults[field] = value
  }
  return Object.keys(defaults).length === 0 ? undefined : defaults
}

/**
 * One official chat entry as this adapter's model profile.
 * @param entry - official entry.
 * @param id - model id, from the entry or its catalog key.
 * @param interfaceType - protocol the converted route speaks.
 * @param report - diagnostic sink.
 * @returns the model profile the entry converts into.
 * @throws Error when the entry names no usable model id.
 */
function officialModel(
  entry: OfficialEntry,
  id: string,
  interfaceType: InterfaceType,
  report: (message: string) => void,
): OwcModelProfile {
  if (id.length === 0) throw new Error('an official chat entry names no model id')
  const anthropic = interfaceType === 'anthropic-messages'
  const { effort, thinking } = officialThinking(entry)
  const modalities = officialModalities(entry, report)
  const defaults = anthropic ? undefined : officialDefaults(entry, report)
  if (anthropic && entry['samplingParams'] !== undefined) {
    report('sampling parameters are not carried on anthropic-messages; that protocol ignores them')
  }
  // The two mid-history reads are this adapter's Messages-only declarations,
  // so a flag stating one on another protocol is reported rather than written
  // into a declaration resolution would then refuse.
  const compat = entry['compat']
  let systemPromptUpdate: 'in-history' | undefined
  let toolUpdate: 'addition-only' | undefined
  if (isPlainObject(compat)) {
    for (const [flag, value] of Object.entries(compat)) {
      const capability = COMPAT_CAPABILITIES[flag]
      // A flag this adapter has no counterpart for can still change request
      // semantics, so it is reported whenever the file states something about
      // it; a flag turned off states nothing to carry.
      if (capability === undefined) {
        if (value === false || value === undefined) continue
        report(`compat flag "${flag}" is not carried; declare the capability on the profile`)
        continue
      }
      if (value !== true) continue
      if (!anthropic) {
        report(`compat flag "${flag}" is not carried; declare the capability on the profile`)
        continue
      }
      if (capability === 'systemPromptUpdate') systemPromptUpdate = 'in-history'
      if (capability === 'toolUpdate') toolUpdate = 'addition-only'
    }
  }
  const name = officialString(entry, 'name')
  const contextWindow = officialNumber(entry, 'contextWindow')
  const maxTokens = officialNumber(entry, 'maxTokens')
  const capabilities = {
    ...modalities.length === 0 ? {} : { modalities },
    ...effort.length === 0 ? {} : { effort },
    ...thinking.length === 0 ? {} : { thinking },
    ...systemPromptUpdate === undefined ? {} : { systemPromptUpdate },
    ...toolUpdate === undefined ? {} : { toolUpdate },
  }
  return {
    id,
    ...name === undefined ? {} : { name },
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...Object.keys(capabilities).length === 0 ? {} : { capabilities },
    ...defaults === undefined ? {} : { defaults },
  }
}

/**
 * Convert one official provider file into this adapter's own profile facts.
 *
 * The conversion is total for the fields it understands and explicit about
 * the rest: it returns the profile plus one diagnostic line per official
 * field it could not carry, and it throws only when the file describes
 * something no single route can be — an unknown protocol, entries that
 * disagree about the protocol or the endpoint, or no chat model at all.
 *
 * @param source - parsed official file content, one provider's catalog.
 * @param route - route name the profile will serve under, for diagnostics.
 * @returns the converted profile facts and the conversion's diagnostics.
 * @throws Error when the file cannot become one route profile.
 */
export function convertOfficialProvider(source: unknown, route: string): OfficialCatalogConversion {
  const prefix = `llm-service-lite: provider "${route}" catalog`
  if (!isPlainObject(source)) throw new Error(`${prefix} is not an object; an official provider file is one API-keyed map`)
  // One line per distinct loss, counted: a 44-model file reports each missing
  // companion field once instead of once per model.
  const counted = new Map<string, number>()
  const report = (message: string): void => { counted.set(message, (counted.get(message) ?? 0) + 1) }

  const models: OwcModelProfile[] = []
  const apis = new Set<string>()
  const baseURLs = new Set<string>()
  const headerSets = new Set<string>()
  for (const [api, group] of Object.entries(source)) {
    if (!isPlainObject(group)) throw new Error(`${prefix} group "${api}" is not an object`)
    for (const [key, raw] of Object.entries(group)) {
      if (!isPlainObject(raw)) throw new Error(`${prefix} entry "${key}" is not an object`)
      const entry = raw as OfficialEntry
      const type = officialString(entry, 'type') ?? key.split(':', 1)[0]
      if (type !== OFFICIAL_CHAT_TYPE) {
        report(`entry "${key}" is a ${type} model, which this adapter does not serve`)
        continue
      }
      const officialApi = officialString(entry, 'api') ?? api
      const interfaceType = OFFICIAL_APIS[officialApi]
      if (interfaceType === undefined) {
        throw new Error(
          `${prefix} names api "${officialApi}", which this adapter does not serve;`
          + ` it serves ${Object.keys(OFFICIAL_APIS).join(', ')}`,
        )
      }
      apis.add(officialApi)
      const baseUrl = officialString(entry, 'baseUrl')
      if (baseUrl !== undefined) baseURLs.add(baseUrl)
      const headers = entry['headers']
      if (isPlainObject(headers)) headerSets.add(JSON.stringify(headers))
      for (const field of Object.keys(entry)) {
        if (!KNOWN_ENTRY_FIELDS.has(field)) report(`field "${field}" is not carried`)
      }
      const id = officialString(entry, 'id') ?? key.slice(key.indexOf(':') + 1)
      models.push(officialModel(entry, id, OFFICIAL_APIS[officialApi] as InterfaceType, report))
    }
  }

  if (apis.size > 1) {
    throw new Error(
      `${prefix} mixes apis ${[...apis].sort().join(' and ')};`
      + ' one route serves one protocol, so convert it into one profile per protocol',
    )
  }
  const [onlyApi] = [...apis]
  if (onlyApi === undefined || models.length === 0) {
    throw new Error(`${prefix} carries no chat model this adapter serves`)
  }
  if (baseURLs.size > 1) {
    throw new Error(
      `${prefix} names ${baseURLs.size} endpoints across its models; one route serves one baseURL`,
    )
  }
  if (headerSets.size > 1) report('models declare different headers, which one route cannot carry')
  const headers = headerSets.size === 1 ? JSON.parse([...headerSets][0] as string) as Record<string, string> : undefined
  return {
    profile: {
      interfaceType: OFFICIAL_APIS[onlyApi] as InterfaceType,
      ...baseURLs.size === 0 ? {} : { baseURL: [...baseURLs][0] as string },
      ...headers === undefined ? {} : { headers },
      models,
    },
    diagnostics: [...counted].map(([message, count]) => (
      count === 1 ? `${prefix} ${message}` : `${prefix} ${message} (${count} models)`
    )),
  }
}
