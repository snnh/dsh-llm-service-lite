/**
 * Draft model for the provider-configuration page: presets, validation, and
 * the conversions between what the page stages and what the settings document
 * stores.
 *
 * The Host validates every write against the same schema it loads, so this
 * module keeps its checks to what makes a save deserve to be attempted: it
 * never replaces the Host's refusal, it explains the draft before one.
 *
 * @module @snnh/dsh-llm-service-lite/client/model
 */

import {
  EFFORT_LEVELS,
  INTERFACE_TYPES,
  MODALITIES,
  RESERVED_ROUTES,
  THINKING_MODES,
  THINKING_STYLES,
  type ClientConfig,
  type ClientModel,
  type ClientProvider,
  type InterfaceType,
  type ModelCapabilities,
  type ProfileProblem,
  type ProviderProfile,
  type ServiceLiteTranslate,
} from './types.ts'
import type { ServiceLiteKey } from './locales.ts'

/** Route ids a configuration surface may create: the settings path and the derived credential reference read cleanly. */
const ROUTE_ID = /^[a-z][a-z0-9._-]*$/u

/** The builder presets the add form offers. */
export type PresetId =
  | 'deepseek'
  | 'openai'
  | 'anthropic'
  | 'dashscope'
  | 'qianfan'
  | 'glm'
  | 'zhipu'
  | 'kimi'
  | 'moonshot'
  | 'openrouter'
  | 'ollama'
  | 'tencent'
  | 'local'
  | 'custom'

/** Every builder preset, in offer order: the vendors first, then the local/custom entries. */
export const PRESET_IDS: readonly PresetId[] = [
  'deepseek',
  'openai',
  'anthropic',
  'dashscope',
  'qianfan',
  'glm',
  'zhipu',
  'kimi',
  'moonshot',
  'openrouter',
  'ollama',
  'tencent',
  'local',
  'custom',
]

/** The route id each preset suggests when it is free. */
const PRESET_ROUTE: Readonly<Record<PresetId, string>> = {
  deepseek: 'deepseek-direct',
  openai: 'openai-direct',
  anthropic: 'anthropic-direct',
  dashscope: 'dashscope',
  qianfan: 'qianfan',
  glm: 'glm-coding',
  zhipu: 'glm',
  kimi: 'kimi-coding',
  moonshot: 'moonshot',
  openrouter: 'openrouter',
  ollama: 'ollama',
  tencent: 'tencent',
  local: 'local-vllm',
  custom: 'my-provider',
}

/**
 * One builder preset's starting profile. The endpoint and model ids are the
 * vendor's published values; the user still owns the credential reference and
 * everything the page leaves blank.
 * @param preset - the preset the add form selected.
 * @returns a fresh profile the page may stage.
 */
export function presetProfile(preset: PresetId): ClientProvider {
  switch (preset) {
    case 'deepseek':
      return {
        displayName: 'DeepSeek',
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        includeUsage: true,
        models: [
          { id: 'deepseek-chat', contextWindow: 131_072, maxTokens: 8192 },
          {
            id: 'deepseek-reasoner',
            contextWindow: 131_072,
            maxTokens: 65_536,
            capabilities: {
              effort: ['low', 'medium', 'high'],
              thinking: ['enabled', 'disabled'],
              reasoningContent: true,
            },
          },
        ],
      }
    case 'openai':
      return {
        displayName: 'OpenAI',
        interfaceType: 'openai-responses',
        baseURL: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        models: [{
          id: 'gpt-5',
          contextWindow: 400_000,
          maxTokens: 128_000,
          capabilities: {
            effort: ['minimal', 'low', 'medium', 'high'],
            thinking: ['disabled'],
            responsesEncryptedReplay: true,
          },
        }],
      }
    case 'anthropic':
      return {
        displayName: 'Anthropic',
        interfaceType: 'anthropic-messages',
        baseURL: 'https://api.anthropic.com/v1',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        promptCaching: true,
        models: [{
          id: 'claude-sonnet-4-5-20250929',
          contextWindow: 200_000,
          maxTokens: 64_000,
          capabilities: { thinking: ['enabled', 'disabled'] },
        }],
      }
    case 'dashscope':
      return {
        displayName: 'Alibaba DashScope',
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        includeUsage: true,
        models: [],
      }
    case 'qianfan':
      return {
        displayName: 'Baidu Qianfan',
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://qianfan.baidubce.com/v2',
        includeUsage: true,
        models: [],
      }
    case 'glm':
      return {
        displayName: 'GLM Coding Plan',
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
        includeUsage: true,
        models: [],
      }
    case 'zhipu':
      return {
        displayName: 'GLM',
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://open.bigmodel.cn/api/paas/v4',
        includeUsage: true,
        models: [],
      }
    case 'kimi':
      return {
        displayName: 'Kimi Coding Plan',
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://api.kimi.com/coding/v1',
        includeUsage: true,
        models: [],
      }
    case 'moonshot':
      return {
        displayName: 'Moonshot',
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://api.moonshot.cn/v1',
        includeUsage: true,
        models: [],
      }
    case 'openrouter':
      return {
        displayName: 'OpenRouter',
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://openrouter.ai/api/v1',
        includeUsage: true,
        models: [],
      }
    case 'ollama':
      return {
        displayName: 'Ollama (local)',
        interfaceType: 'openai-chat-completions',
        baseURL: 'http://localhost:11434/v1',
        includeUsage: true,
        models: [],
      }
    case 'tencent':
      return {
        displayName: 'Tencent Cloud',
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://tokenhub.tencentmaas.com/v1',
        includeUsage: true,
        models: [],
      }
    case 'local':
      return {
        displayName: 'Local vLLM',
        interfaceType: 'openai-chat-completions',
        baseURL: 'http://127.0.0.1:8000/v1',
        maxConcurrent: 1,
        models: [{
          id: 'Qwen3-32B',
          contextWindow: 32_768,
          maxTokens: 8192,
          capabilities: { effort: ['low', 'high'], thinkingStyle: 'enable_thinking' },
        }],
      }
    case 'custom':
      return {
        interfaceType: 'openai-chat-completions',
        models: [],
      }
  }
}

/**
 * A free route id based on the preset's suggestion.
 * @param preset - the preset the add form selected.
 * @param providers - the routes the draft already holds.
 * @returns the suggestion, suffixed until it does not collide.
 */
export function suggestedRoute(preset: PresetId, providers: Readonly<Record<string, unknown>>): string {
  const base = PRESET_ROUTE[preset]
  if (providers[base] === undefined) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`
    if (providers[candidate] === undefined) return candidate
  }
}

/**
 * The refusal a route id's syntax earns, ignoring whether it is already taken.
 * @param route - the candidate route id.
 * @returns the localizable problem, or undefined when the name is well formed.
 */
export function routeFormatProblem(route: string): ProfileProblem | undefined {
  if (route.length === 0) return { path: 'route', key: 'routeRequired' }
  const owner = RESERVED_ROUTES[route]
  if (owner !== undefined) return { path: 'route', key: 'routeReserved', params: { owner } }
  if (!ROUTE_ID.test(route)) return { path: 'route', key: 'routePattern' }
  return undefined
}

/** The refusal one user-typed route id earns, when it earns one.
 * @param route - the candidate route id.
 * @param providers - the routes the draft already holds.
 * @returns the locale key and params of the problem, or undefined when usable.
 */
export function routeIdProblem(
  route: string,
  providers: Readonly<Record<string, unknown>>,
): ProfileProblem | undefined {
  if (route.length === 0) return { path: 'route', key: 'routeRequired' }
  const owner = RESERVED_ROUTES[route]
  if (owner !== undefined) return { path: 'route', key: 'routeReserved', params: { owner } }
  if (providers[route] !== undefined) return { path: 'route', key: 'routeTaken', params: { route } }
  if (!ROUTE_ID.test(route)) return { path: 'route', key: 'routePattern' }
  return undefined
}

/**
 * The credential reference the page derives when a profile names none, the
 * same rule the Models page uses.
 * @param route - provider route id.
 * @returns the conventional environment-variable name.
 */
export function deriveKeyRef(route: string): string {
  return `${route.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_API_KEY`
}

/**
 * Route-level defaults the Host schema materializes into the resolved value.
 * A save drops a field equal to its default so the stored user layer stays the
 * document the person actually wrote, and a later base-layer change still wins.
 */
export const ROUTE_DEFAULTS = {
  maxConcurrent: 3,
  streamIdleTimeoutMs: 300_000,
  defaultContextWindow: 256_000,
  defaultMaxTokens: 65_536,
  imageRequestMaxBytes: 20 * 1024 * 1024,
  imageRequestMaxImages: 600,
  imageOffloadByteQuantum: 10 * 1024 * 1024,
  imageOffloadCountQuantum: 20,
} as const

/** Editable provider fields, in save order; everything else is preserved as written. */
export const EDITABLE_PROVIDER_FIELDS = [
  'displayName',
  'enabled',
  'interfaceType',
  'baseURL',
  'includeUsage',
  'promptCaching',
  'apiKeyEnv',
  'apiKey',
  'extraBody',
  'models',
  'maxConcurrent',
  'streamIdleTimeoutMs',
  'defaultContextWindow',
  'defaultMaxTokens',
] as const

/** The route's models as a typed list (a profile may carry none). */
export function modelsOf(provider: ClientProvider): ClientModel[] {
  return Array.isArray(provider.models) ? provider.models as ClientModel[] : []
}

/** One provider's capabilities, or an empty object. */
export function capabilitiesOf(model: ClientModel): ModelCapabilities {
  return model.capabilities ?? {}
}

/**
 * Apply a staged patch to a detached object: a key present with `undefined`
 * removes the field (the schema default applies again), every other key wins.
 * @param base - the object to copy.
 * @param patch - the staged patch.
 * @returns a new object with the patch applied.
 */
export function applyPatch<T extends object>(
  base: T,
  patch: { readonly [K in keyof T]?: T[K] | undefined },
): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete out[key]
    else out[key] = value
  }
  return out as T
}

/**
 * The translated message one problem renders as.
 * @param problem - the validation finding.
 * @param translate - the page's dictionary lookup.
 * @returns the localized message.
 */
export function problemText(problem: ProfileProblem, translate: ServiceLiteTranslate): string {
  return translate(problem.key as ServiceLiteKey, problem.params)
}

/** A non-negative-safe-integer check shared by the numeric fields. */
function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** A finite-positive-number check. */
function positiveNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** One URL-shaped endpoint, when it is one. */
function webUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch (_invalidUrl) {
    return false
  }
}

/**
 * Validate the staged document against the rules the Host enforces at write
 * time, so the page can explain a refusal before one is sent.
 * @param config - the staged providers document.
 * @returns every finding, in document order; empty means saveable.
 */
export function validateConfig(config: ClientConfig): ProfileProblem[] {
  const problems: ProfileProblem[] = []
  const at = (route: string, suffix?: string, index?: number): string =>
    `providers.${route}${index === undefined ? '' : `.models.${String(index)}`}${suffix === undefined ? '' : `.${suffix}`}`
  for (const [route, provider] of Object.entries(config.providers)) {
    const path = at(route)
    if (route.length === 0) problems.push({ path, key: 'routeRequired' })
    const owner = RESERVED_ROUTES[route]
    if (owner !== undefined) problems.push({ path, key: 'routeReserved', params: { owner } })
    const protocol = provider.interfaceType
    if (protocol === undefined) {
      problems.push({ path, key: 'protocolRequired' })
    } else if (!(INTERFACE_TYPES as readonly string[]).includes(protocol)) {
      problems.push({ path: at(route, 'interfaceType'), key: 'protocolRequired' })
    }
    if (provider.baseURL !== undefined && provider.baseURL.length > 0 && !webUrl(provider.baseURL)) {
      problems.push({ path: at(route, 'baseURL'), key: 'baseURLInvalid' })
    }
    if (provider.apiKeyEnv !== undefined && provider.apiKey !== undefined) {
      problems.push({ path: at(route, 'apiKeyEnv'), key: 'credentialConflict' })
    }
    if (provider.promptCaching === true && protocol !== 'anthropic-messages') {
      problems.push({ path: at(route, 'promptCaching'), key: 'promptCachingProtocol' })
    }
    if (provider.includeUsage === true && protocol !== 'openai-chat-completions') {
      problems.push({ path: at(route, 'includeUsage'), key: 'includeUsageProtocol' })
    }
    if (provider.maxConcurrent !== undefined && !positiveInteger(provider.maxConcurrent)) {
      problems.push({ path: at(route, 'maxConcurrent'), key: 'maxConcurrentInvalid' })
    }
    if (provider.streamIdleTimeoutMs !== undefined && !positiveNumber(provider.streamIdleTimeoutMs)) {
      problems.push({ path: at(route, 'streamIdleTimeoutMs'), key: 'streamIdleTimeoutInvalid' })
    }
    if (provider.defaultContextWindow !== undefined && !positiveInteger(provider.defaultContextWindow)) {
      problems.push({ path: at(route, 'defaultContextWindow'), key: 'defaultContextWindowInvalid' })
    }
    if (provider.defaultMaxTokens !== undefined && !positiveInteger(provider.defaultMaxTokens)) {
      problems.push({ path: at(route, 'defaultMaxTokens'), key: 'defaultMaxTokensInvalid' })
    }
    const ids = new Set<string>()
    modelsOf(provider).forEach((model, index) => {
      const modelPath = at(route, undefined, index)
      if (typeof model.id !== 'string' || model.id.length === 0) {
        problems.push({ path: modelPath, key: 'modelIdRequired' })
      } else if (ids.has(model.id)) {
        problems.push({ path: modelPath, key: 'modelDuplicate', params: { model: model.id } })
      } else {
        ids.add(model.id)
      }
      if (model.contextWindow !== undefined && !positiveInteger(model.contextWindow)) {
        problems.push({ path: `${modelPath}.contextWindow`, key: 'modelContextInvalid' })
      }
      if (model.maxTokens !== undefined && !positiveInteger(model.maxTokens)) {
        problems.push({ path: `${modelPath}.maxTokens`, key: 'modelMaxTokensInvalid' })
      }
      const capabilities = model.capabilities ?? {}
      const declaredModalities = capabilities.modalities ?? []
      for (const modality of declaredModalities) {
        if (!(MODALITIES as readonly string[]).includes(modality)) {
          problems.push({ path: `${modelPath}.capabilities.modalities`, key: 'modalityUnknown', params: { value: String(modality) } })
        }
      }
      for (const effort of capabilities.effort ?? []) {
        if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) {
          problems.push({ path: `${modelPath}.capabilities.effort`, key: 'effortUnknown', params: { value: String(effort) } })
        }
      }
      for (const thinking of capabilities.thinking ?? []) {
        if (!(THINKING_MODES as readonly string[]).includes(thinking)) {
          problems.push({ path: `${modelPath}.capabilities.thinking`, key: 'thinkingUnknown', params: { value: String(thinking) } })
        }
      }
      if (capabilities.thinkingStyle !== undefined
        && !(THINKING_STYLES as readonly string[]).includes(capabilities.thinkingStyle)) {
        problems.push({ path: `${modelPath}.capabilities.thinkingStyle`, key: 'thinkingStyleUnknown' })
      }
      if (capabilities.imageOutput === true && protocol === 'anthropic-messages') {
        problems.push({ path: `${modelPath}.capabilities.imageOutput`, key: 'imageOutputProtocol' })
      }
      const carriesImages = declaredModalities.includes('image')
      if (!carriesImages && (model.imagePixelBudget !== undefined
        || model.imageMaxBytes !== undefined
        || model.imageTokens !== undefined)) {
        problems.push({ path: `${modelPath}.imagePixelBudget`, key: 'imageAccountingWithoutImage' })
      }
      if (model.imagePixelBudget !== undefined && model.imagePixelBudget !== 'low'
        && !positiveInteger(model.imagePixelBudget)) {
        problems.push({ path: `${modelPath}.imagePixelBudget`, key: 'imageBudgetInvalid' })
      }
      if (model.imageMaxBytes !== undefined && !positiveInteger(model.imageMaxBytes)) {
        problems.push({ path: `${modelPath}.imageMaxBytes`, key: 'imageBudgetInvalid' })
      }
      const defaults = model.defaults ?? {}
      if (defaults.temperature !== undefined
        && !(typeof defaults.temperature === 'number' && defaults.temperature >= 0 && defaults.temperature <= 2)) {
        problems.push({ path: `${modelPath}.defaults.temperature`, key: 'temperatureInvalid' })
      }
      if (defaults.topP !== undefined
        && !(typeof defaults.topP === 'number' && defaults.topP >= 0 && defaults.topP <= 1)) {
        problems.push({ path: `${modelPath}.defaults.topP`, key: 'topPInvalid' })
      }
      if (defaults.topK !== undefined) {
        if (!positiveInteger(defaults.topK)) {
          problems.push({ path: `${modelPath}.defaults.topK`, key: 'topKInvalid' })
        } else if (protocol === 'openai-responses') {
          problems.push({ path: `${modelPath}.defaults.topK`, key: 'topKProtocol' })
        }
      }
      if (defaults.maxTokens !== undefined && !positiveInteger(defaults.maxTokens)) {
        problems.push({ path: `${modelPath}.defaults.maxTokens`, key: 'modelMaxTokensInvalid' })
      }
    })
  }
  return problems
}

/** Remove empty helpers/objects a staged default left behind, keeping unknown fields intact. */
function cleanCapabilities(capabilities: ModelCapabilities): ModelCapabilities | undefined {
  const out: ModelCapabilities = { ...capabilities }
  if (out.modalities !== undefined && out.modalities.length === 0) delete out.modalities
  if (out.effort !== undefined && out.effort.length === 0) delete out.effort
  if (out.thinking !== undefined && out.thinking.length === 0) delete out.thinking
  return Object.keys(out).length === 0 ? undefined : out
}

/** Clean one model before it is stored. */
function cleanModel(model: ClientModel): ClientModel {
  const out: ClientModel = structuredClone(model)
  if (out.name === '') delete out.name
  if (out.capabilities !== undefined) {
    const cleaned = cleanCapabilities(out.capabilities)
    if (cleaned === undefined) delete out.capabilities
    else out.capabilities = cleaned
  }
  if (out.defaults !== undefined) {
    const defaults = out.defaults
    for (const field of ['temperature', 'topP', 'topK', 'maxTokens'] as const) {
      if (defaults[field] === undefined) delete defaults[field]
    }
    if (Object.keys(defaults).length === 0) delete out.defaults
  }
  if (out.imagePixelBudget === undefined) delete out.imagePixelBudget
  return out
}

/** Clean one provider before it is stored. */
function cleanProvider(provider: ClientProvider): ClientProvider {
  const out: ClientProvider = structuredClone(provider)
  for (const field of ['displayName', 'baseURL', 'apiKeyEnv', 'apiKey'] as const) {
    if (out[field] === '') delete out[field]
  }
  if (out.headers !== undefined && Object.keys(out.headers).length === 0) delete out.headers
  if (out.extraBody !== undefined && Object.keys(out.extraBody).length === 0) delete out.extraBody
  if (out.models !== undefined) {
    out.models = (out.models as ClientModel[]).map(cleanModel)
    // An empty list and an absent list both advertise nothing; keep it absent.
    if (out.models.length === 0) delete out.models
  }
  // A resolved value carries schema defaults; storing them would freeze the
  // document against a later default change, so drop the ones equal to them.
  if (out.enabled === true) delete out.enabled
  if (out.promptCaching === false) delete out.promptCaching
  if (out.includeUsage === false) delete out.includeUsage
  if (out.maxConcurrent === ROUTE_DEFAULTS.maxConcurrent) delete out.maxConcurrent
  if (out.streamIdleTimeoutMs === ROUTE_DEFAULTS.streamIdleTimeoutMs) delete out.streamIdleTimeoutMs
  if (out.defaultContextWindow === ROUTE_DEFAULTS.defaultContextWindow) delete out.defaultContextWindow
  if (out.defaultMaxTokens === ROUTE_DEFAULTS.defaultMaxTokens) delete out.defaultMaxTokens
  if (out.imageRequestMaxBytes === ROUTE_DEFAULTS.imageRequestMaxBytes) delete out.imageRequestMaxBytes
  if (out.imageRequestMaxImages === ROUTE_DEFAULTS.imageRequestMaxImages) delete out.imageRequestMaxImages
  if (out.imageOffloadByteQuantum === ROUTE_DEFAULTS.imageOffloadByteQuantum) delete out.imageOffloadByteQuantum
  if (out.imageOffloadCountQuantum === ROUTE_DEFAULTS.imageOffloadCountQuantum) delete out.imageOffloadCountQuantum
  return out
}

/**
 * The document a save stores: the staged draft minus the empty placeholders a
 * form leaves when a field is unset. Unknown fields are preserved untouched.
 * @param config - the staged document.
 * @returns a detached document ready for the settings write.
 */
export function cleanConfig(config: ClientConfig): ClientConfig {
  const providers: Record<string, ClientProvider> = {}
  for (const [route, provider] of Object.entries(config.providers)) {
    providers[route] = cleanProvider(provider)
  }
  return { providers }
}

/**
 * The value equality a staged draft is compared with.
 * @param left - one value.
 * @param right - the other value.
 * @returns whether both serialize identically.
 */
export function sameConfig(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Fields whose resolved-section default equals "not stated": a saved value
 * equal to one of them needs no user-layer entry, so the override is dropped
 * and a later default change still reaches the route.
 */
export const FIELD_DEFAULTS: Readonly<Record<string, unknown>> = {
  enabled: true,
  promptCaching: false,
  includeUsage: false,
  maxConcurrent: 3,
  streamIdleTimeoutMs: 300_000,
  defaultContextWindow: 256_000,
  defaultMaxTokens: 65_536,
}

/**
 * Read a providers dict out of one unknown layer, when it is one.
 * @param layer - a resolved value, a composition layer, or a user layer.
 * @returns the providers dictionary, or an empty one when the layer carries none.
 */
export function providersOf(layer: unknown): Record<string, ClientProvider> {
  if (typeof layer !== 'object' || layer === null) return {}
  const providers = (layer as { providers?: unknown }).providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return {}
  return providers as Record<string, ClientProvider>
}

/**
 * Strip the empty placeholders a form leaves for one provider field before it
 * is compared with a layer or stored.
 * @param field - provider field name.
 * @param value - the staged value.
 * @returns the value a write would store, or undefined when it stores nothing.
 */
export function storedField(field: string, value: unknown): unknown {
  if (value === undefined || value === '') return undefined
  if (Array.isArray(value) && value.length === 0) return undefined
  if (typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === 0) return undefined
  if (field === 'models') {
    const cleaned = cleanConfig({ providers: { route: { models: value } as ClientProvider } })
      .providers['route']?.models
    return cleaned
  }
  return value
}

/**
 * The one-line summary a collapsed row shows.
 * @param config - the document to summarize.
 * @returns provider count and the total model count.
 */
export function configCounts(config: ClientConfig): { providers: number; models: number } {
  let providers = 0
  let models = 0
  for (const provider of Object.values(config.providers)) {
    providers += 1
    models += modelsOf(provider).length
  }
  return { providers, models }
}

/** The empty document the page starts from before the Host value arrives. */
export function emptyConfig(): ClientConfig {
  return { providers: {} }
}

/** Request-body fields the harness owns for every call. */
const RESERVED_BODY_FIELDS: readonly string[] = ['model', 'messages', 'stream', 'stream_options', 'tools', 'system']

/** What one `extraBody` text edit resolved to. */
export type ExtraBodyParse =
  | { readonly kind: 'empty' }
  | { readonly kind: 'object'; readonly value: Record<string, unknown> }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'reserved' }

/** Whether a value is a plain JSON object rather than an array or a scalar. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Spell a stored `extraBody` as the textarea shows it.
 * @param value - the stored value, when the profile has one.
 * @returns pretty-printed JSON, or empty text when nothing is stored.
 */
export function spellExtraBody(value: unknown): string {
  return isRecord(value) ? JSON.stringify(value, null, 2) : ''
}

/**
 * Read the textarea's text.
 * @param text - the text as typed.
 * @returns what the form may store, or why it cannot store it.
 */
export function parseExtraBody(text: string): ExtraBodyParse {
  if (text.trim().length === 0) return { kind: 'empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (_invalidJson) {
    return { kind: 'invalid' }
  }
  if (!isRecord(parsed)) return { kind: 'invalid' }
  return Object.keys(parsed).some(key => RESERVED_BODY_FIELDS.includes(key))
    ? { kind: 'reserved' }
    : { kind: 'object', value: parsed }
}

/**
 * The copy key explaining why one `extraBody` edit cannot be stored.
 * @param parse - the parse of the textarea's current text.
 * @returns the message key, or `undefined` when the text is storable.
 */
export function extraBodyFailure(parse: ExtraBodyParse): ServiceLiteKey | undefined {
  if (parse.kind === 'invalid') return 'extraBodyInvalid'
  if (parse.kind === 'reserved') return 'extraBodyReserved'
  return undefined
}

/** Flip one list value in or out, preserving the canonical order of its vocabulary. */
export function toggleListValue<T extends string>(values: readonly T[] | undefined, value: T, vocabulary: readonly T[]): T[] {
  const current = values ?? []
  if (current.includes(value)) return current.filter(entry => entry !== value)
  const next = new Set([...current, value])
  return vocabulary.filter(entry => next.has(entry))
}

/** Parse a comma-separated list into trimmed non-empty values. */
export function splitList(text: string): string[] {
  return text.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
}

/** The protocol label key the page translates an interface type with. */
export function protocolLabelKey(protocol: InterfaceType | undefined): 'protocolAnthropic' | 'protocolResponses' | 'protocolChat' {
  switch (protocol) {
    case 'anthropic-messages': return 'protocolAnthropic'
    case 'openai-responses': return 'protocolResponses'
    default: return 'protocolChat'
  }
}

/** The provider's interface type, defaulted for a hand-written profile that names none. */
export function interfaceTypeOf(provider: ProviderProfile): InterfaceType | undefined {
  return provider.interfaceType
}
