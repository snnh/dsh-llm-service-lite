/**
 * Validation and resolution of configured provider profiles.
 *
 * Resolution is the one place that turns declarative profiles into the facts
 * a request needs, so every default a deployment did not state is materialized
 * here and nowhere else. Two validation modes exist because the two callers
 * want opposite things from a bad profile: a write must be refused where it is
 * written, while a stored read must keep serving the routes that still work —
 * so a deferred resolution records a diagnostic on the offending route instead
 * of throwing.
 *
 * @module dsh-llm-service-lite/profiles
 */

import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { readFileSync } from 'node:fs'
import { resolveRetryPolicy, type ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { ImageRequestBudget } from './images.ts'
import { LOW_DETAIL_IMAGE_PIXEL_BUDGET } from './images.ts'
import { convertOfficialProvider } from './official-catalog.ts'
import { modelDefaultRuleOf } from './model-defaults.ts'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_IMAGE_REQUEST_MAX_BYTES,
  DEFAULT_IMAGE_REQUEST_MAX_IMAGES,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  IMAGE_TOKEN_KINDS,
  INTERFACE_TYPES,
  MODALITIES,
  SYSTEM_PROMPT_UPDATES,
  TOOL_UPDATES,
  type EffortLevel,
  type InterfaceType,
  type Modality,
  type Options,
  type OwcImageTokenAccounting,
  type OwcModelCapabilities,
  type OwcModelDefaults,
  type OwcModelProfile,
  type OwcProviderProfile,
  type ServedInterfaceType,
  type SystemPromptUpdate,
  type ThinkingMode,
  type ThinkingStyle,
  type ToolUpdate,
} from './config.ts'

/** Protocol defaults OWC applies when a profile names no endpoint. */
const ENDPOINT_DEFAULTS: Readonly<Record<InterfaceType, string>> = {
  'openai-chat-completions': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
}

/**
 * Request-body keys a profile may not set through `extraBody`. The adapter
 * owns each of them for a semantic reason — the conversation, the streaming
 * contract, the tool declarations, or the usage report — so a silent overwrite
 * would make a configured knob look applied while the adapter's value won.
 */
const RESERVED_BODY_KEYS: readonly string[] = ['model', 'messages', 'stream', 'stream_options', 'tools', 'system']

/** One model as the request path sees it: every capacity and capability materialized. */
export interface ResolvedOwcModel {
  /** Exact model id. */
  readonly id: string
  /** Display name for selection surfaces. */
  readonly name: string
  /** Context capacity in tokens. */
  readonly contextWindow: number
  /** Per-request output cap in tokens. */
  readonly maxTokens: number
  /** Family whose researched defaults filled what the profile left open. */
  readonly family: string | undefined
  /** Accepted input modalities. */
  readonly modalities: readonly Modality[]
  /** Selectable reasoning-effort levels in declaration order. */
  readonly effort: readonly EffortLevel[]
  /** Level written when the caller picks none, from the family; absent leaves it to the endpoint. */
  readonly effortDefault: EffortLevel | undefined
  /** Accepted thinking modes. */
  readonly thinking: readonly ThinkingMode[]
  /** How the endpoint spells the thinking switch, when it has one. */
  readonly thinkingStyle: ThinkingStyle | undefined
  /** Whether prior reasoning may be replayed through `reasoning_content`. */
  readonly reasoningContent: boolean
  /** Whether prior reasoning is actually sent back on a later request. */
  readonly replayReasoning: boolean
  /** Whether the family rejects a follow-up turn that omits the reasoning; not a user choice. */
  readonly replayRequired: boolean
  /**
   * Whether prior reasoning must be replayed as the provider's own encrypted
   * item, which the Responses protocol hands back verbatim.
   */
  readonly encryptedReplay: boolean
  /** Whether the endpoint reads a mid-conversation system message as the effective prompt. */
  readonly systemPromptUpdate: SystemPromptUpdate | undefined
  /** How the endpoint accepts tool declarations that change mid-conversation. */
  readonly toolUpdate: ToolUpdate | undefined
  /** Whether tool declarations may be sent to this model. */
  readonly tools: boolean
  /** Pixel budget request images of this model are projected into; absent keeps source dimensions. */
  readonly imagePixelBudget: number | undefined
  /** Encoded-byte target for one request image of this model; absent uses the adapter default. */
  readonly imageMaxBytes: number | undefined
  /** Visual-token accounting this model's endpoint charges; absent keeps the meter's heuristic. */
  readonly imageTokens: ResolvedImageTokens | undefined
  /** Whether the model may answer with images of its own. */
  readonly imageOutput: boolean
  /** Request parameters the model writes when the caller states none. */
  readonly defaults: ResolvedOwcModelDefaults
}

/**
 * One model's request defaults, with the protocol that carries them already
 * checked: the request path writes each declared value exactly when the
 * caller's own request left it unstated.
 */
export interface ResolvedOwcModelDefaults {
  /** Sampling temperature written when the caller names none. */
  readonly temperature: number | undefined
  /** Nucleus cutoff written when the caller names none. */
  readonly topP: number | undefined
  /** Top-k cutoff written when the caller names none. */
  readonly topK: number | undefined
  /** Output cap the request asks for when the caller states none; absent keeps the declared `maxTokens`. */
  readonly maxTokens: number | undefined
}

/**
 * One validated visual-token accounting, in the form the pricing path reads:
 * the declared kind's own fields are materialized, and the other kind's are
 * already gone.
 */
export type ResolvedImageTokens =
  | { kind: 'area'; per: number }
  | { kind: 'tiles'; tile: number; base: number; perTile: number }

/**
 * Materialize one declared visual-token accounting, refusing a declaration
 * that does not state the whole of the accounting it named.
 * @param provider - route name, for the diagnostic.
 * @param model - model id, for the diagnostic.
 * @param declared - the accounting the profile states.
 * @returns the accounting in the form the pricing path reads.
 * @throws Error naming the route, the model, and the field that is missing.
 */
function resolveImageTokens(
  provider: string,
  model: string,
  declared: OwcImageTokenAccounting,
): ResolvedImageTokens {
  const at = `llm-service-lite: provider "${provider}" model "${model}" imageTokens`
  if (!IMAGE_TOKEN_KINDS.includes(declared.kind)) {
    throw new Error(`${at} names unknown kind "${declared.kind}"`)
  }
  const positive = (value: number | undefined): value is number =>
    value !== undefined && Number.isSafeInteger(value) && value >= 1
  if (declared.kind === 'area') {
    if (declared.tile !== undefined || declared.base !== undefined || declared.perTile !== undefined) {
      throw new Error(`${at} of kind "area" also states the fields of "tiles"`)
    }
    if (!positive(declared.per)) throw new Error(`${at} of kind "area" needs a positive integer "per"`)
    return { kind: 'area', per: declared.per }
  }
  if (declared.per !== undefined) throw new Error(`${at} of kind "tiles" also states the field of "area"`)
  if (declared.base !== undefined && !(Number.isSafeInteger(declared.base) && declared.base >= 0)) {
    throw new Error(`${at} of kind "tiles" needs "base" to be a non-negative integer`)
  }
  if (!positive(declared.perTile)) throw new Error(`${at} of kind "tiles" needs a positive integer "perTile"`)
  if (!positive(declared.tile)) throw new Error(`${at} of kind "tiles" needs a positive integer "tile"`)
  return { kind: 'tiles', tile: declared.tile, base: declared.base ?? 0, perTile: declared.perTile }
}

/** One provider profile with every route-level default materialized. */
export interface ResolvedOwcProviderProfile {
  /** Route name; also the `GenerateOptions.provider` value that selects it. */
  readonly provider: string
  /** Label shown by selection surfaces. */
  readonly displayName: string
  /** Whether the route registers. */
  readonly enabled: boolean
  /** Wire protocol every model on the route speaks, from the ones this adapter serves. */
  readonly interfaceType: ServedInterfaceType
  /** Endpoint of every model on the route. */
  readonly baseURL: string
  /** Credential reference resolved per request, when the profile names one. */
  readonly apiKeyEnv: CredentialRef | undefined
  /** Inline credential, when the profile carries one. */
  readonly apiKey: string | undefined
  /** Static request headers. */
  readonly headers: Readonly<Record<string, string>>
  /** Whether the route may use prompt caching. */
  readonly promptCaching: boolean
  /** Whether a chat-completions request asks for a streamed usage report. */
  readonly includeUsage: boolean
  /** Extra top-level request-body fields. */
  readonly extraBody: Readonly<Record<string, unknown>>
  /** Concurrent requests this route serves before calls queue. */
  readonly maxConcurrent: number
  /** Maximum idle interval between two stream events. */
  readonly streamIdleTimeoutMs: number
  /** Provider-owned retry policy captured at registration. */
  readonly retryPolicy: ResolvedRetryPolicy
  /** Declared models in configuration order. */
  readonly models: readonly ResolvedOwcModel[]
  /** Context capacity for a model this route does not describe. */
  readonly defaultContextWindow: number
  /** Output capability for a model this route does not describe. */
  readonly defaultMaxTokens: number
  /** Image request budgets this route applies to every request it serves. */
  readonly imageRequestBudget: ImageRequestBudget
  /** Why this route cannot serve, when it cannot; a store keeps such a route editable rather than dropping it. */
  readonly diagnostic: string | undefined
  /**
   * One line per official field a `catalog` conversion could not carry. Empty
   * for a profile that declares no catalog and for one whose catalog converted
   * whole.
   */
  readonly catalogDiagnostics: readonly string[]
}

/** How a caller wants an unserviceable profile handled. */
export type ValidationMode = 'strict' | 'deferred'

/**
 * Route names the first-party DeepSeek channel owns, and the package that owns
 * each. DeepSeek keeps its official modules: the API-key and account routes are
 * registered by `@deepseek-ai/dsh-llm-deepseek-*`, they authenticate through
 * credentials this adapter has no part in, and they serve a request shape of
 * their own. A profile that claimed one of these names could never serve it —
 * registering a route another adapter already owns fails plugin loading — so
 * the name is refused where it is written, with the owner named, instead of
 * surfacing later as a registration failure that reads like a bug in this
 * plugin. Any other route name remains available: a deployment that reaches a
 * DeepSeek-compatible endpoint through this adapter names its own route and
 * declares that endpoint's own capabilities.
 */
export const RESERVED_ROUTE_OWNERS: Readonly<Record<string, string>> = {
  'deepseek-official': '@deepseek-ai/dsh-llm-deepseek-api-key',
  'deepseek-account': '@deepseek-ai/dsh-llm-deepseek-account',
}

/**
 * Reject a route name the first-party channel owns.
 * @param provider - route name a profile claimed.
 * @throws Error naming the owner of the route.
 */
function assertRouteName(provider: string): void {
  const owner = RESERVED_ROUTE_OWNERS[provider]
  if (owner === undefined) return
  throw new Error(
    `llm-service-lite: provider route "${provider}" belongs to ${owner};`
    + ' DeepSeek keeps the first-party channel, so describe another endpoint under a route name of your own',
  )
}

/**
 * Reject a profile that names neither a usable protocol nor a usable endpoint.
 * @param provider - route name, for the diagnostic.
 * @param source - configured profile.
 * @returns the protocol this adapter serves for the profile.
 * @throws Error naming the route and the field that cannot be served.
 */
function assertAddressable(provider: string, source: OwcProviderProfile): ServedInterfaceType {
  assertRouteName(provider)
  if (source.interfaceType === undefined) {
    throw new Error(
      `llm-service-lite: provider "${provider}" names no interfaceType;`
      + ` state one of ${INTERFACE_TYPES.join(', ')} or point "catalog" at an official provider file`,
    )
  }
  if (!INTERFACE_TYPES.includes(source.interfaceType)) {
    throw new Error(
      `llm-service-lite: provider "${provider}" names interfaceType "${source.interfaceType}",`
      + ` which is not one of ${INTERFACE_TYPES.join(', ')}`,
    )
  }
  if (source.baseURL !== undefined) {
    if (source.baseURL.length === 0) throw new Error(`llm-service-lite: provider "${provider}" has an empty baseURL`)
    let parsed: URL
    try {
      parsed = new URL(source.baseURL)
    } catch (_invalidUrl) {
      throw new Error(`llm-service-lite: provider "${provider}" baseURL is not a URL`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`llm-service-lite: provider "${provider}" baseURL must use http or https`)
    }
  }
  if (source.displayName !== undefined && source.displayName.length === 0) {
    throw new Error(`llm-service-lite: provider "${provider}" has an empty displayName`)
  }
  if (source.apiKeyEnv !== undefined && source.apiKey !== undefined) {
    throw new Error(
      `llm-service-lite: provider "${provider}" sets both apiKeyEnv and apiKey;`
      + ' name the credential once so the request cannot authenticate with an unintended one',
    )
  }
  assertRouteCapabilities(provider, source)
  assertExtraBody(provider, source.extraBody)
  for (const [name, value] of Object.entries(source.headers ?? {})) {
    try {
      new Headers([[name, value]])
    } catch (_invalidHeader) {
      throw new Error(
        `llm-service-lite: provider "${provider}" header "${name}" is not valid for Fetch;`
        + ' use a valid HTTP field name and a single-line value representable as bytes',
      )
    }
  }
  return source.interfaceType
}

/** Reject route-level capability switches the named protocol cannot carry. */
function assertRouteCapabilities(provider: string, source: OwcProviderProfile): void {
  if (source.promptCaching === true && source.interfaceType !== 'anthropic-messages') {
    throw new Error(
      `llm-service-lite: provider "${provider}" sets promptCaching on interfaceType "${source.interfaceType}";`
      + ' only anthropic-messages marks cache breakpoints through the request body',
    )
  }
  if (source.includeUsage === true && source.interfaceType !== 'openai-chat-completions') {
    throw new Error(
      `llm-service-lite: provider "${provider}" sets includeUsage on interfaceType "${source.interfaceType}";`
      + ' only openai-chat-completions reports usage through stream_options',
    )
  }
}

/** Reject extra body fields that are not JSON, or that the adapter owns. */
function assertExtraBody(provider: string, extraBody: Readonly<Record<string, unknown>> | undefined): void {
  for (const [key, value] of Object.entries(extraBody ?? {})) {
    if (RESERVED_BODY_KEYS.includes(key)) {
      throw new Error(
        `llm-service-lite: provider "${provider}" extraBody sets reserved field "${key}";`
        + ` the adapter owns ${RESERVED_BODY_KEYS.join(', ')}`,
      )
    }
    if (!isJsonValue(value)) {
      throw new Error(`llm-service-lite: provider "${provider}" extraBody field "${key}" is not a JSON value`)
    }
  }
}

/** The request parameters a model may declare a default for. */
const DEFAULT_PARAM_FIELDS = ['temperature', 'topP', 'topK', 'maxTokens'] as const

/**
 * Validate one model's declared request parameters against the protocol that
 * would carry them. Ranges are the schema's work; this refuses what a raw
 * profile could still state — a value no request can send, and a knob the
 * named protocol has no field for.
 * @param provider - route name, for the diagnostic.
 * @param modelId - model id, for the diagnostic.
 * @param declared - configured request defaults, if any.
 * @param interfaceType - protocol every request on this route speaks.
 * @returns the defaults the request path writes, each absent unless declared.
 * @throws Error naming the field a request could not carry.
 */
function resolveModelDefaults(
  provider: string,
  modelId: string,
  declared: OwcModelDefaults | undefined,
  interfaceType: ServedInterfaceType,
): ResolvedOwcModelDefaults {
  const source = declared ?? {}
  // A knob the named protocol has no field for is refused where it is written,
  // the same way a route-level switch is: a request that silently dropped it
  // would make a configured setting look applied.
  if (source.topK !== undefined && interfaceType === 'openai-responses') {
    throw new Error(
      `llm-service-lite: provider "${provider}" model "${modelId}" declares defaults.topK`
      + ' on interfaceType "openai-responses"; that protocol has no top-k field',
    )
  }
  for (const field of DEFAULT_PARAM_FIELDS) {
    const value = source[field]
    if (value === undefined || Number.isFinite(value)) continue
    throw new Error(
      `llm-service-lite: provider "${provider}" model "${modelId}" declares defaults.${field}`
      + ` "${String(value)}"; a request parameter must be a finite number`,
    )
  }
  return {
    temperature: source.temperature,
    topP: source.topP,
    topK: source.topK,
    maxTokens: source.maxTokens,
  }
}

/**
 * Materialize one declared model's capacities and capabilities.
 * @param provider - route name, for the diagnostic.
 * @param model - configured model entry.
 * @param fallbackContextWindow - route context capacity for an unsized model.
 * @param fallbackMaxTokens - route output capability for an unsized model.
 * @returns the model as the request path reads it.
 */
function resolveModel(
  provider: string,
  model: OwcModelProfile,
  interfaceType: ServedInterfaceType,
  fallbackContextWindow: number,
  fallbackMaxTokens: number,
): ResolvedOwcModel {
  if (model.id.length === 0) throw new Error(`llm-service-lite: provider "${provider}" has a model with an empty id`)
  if (model.name !== undefined && model.name.length === 0) {
    throw new Error(`llm-service-lite: provider "${provider}" model "${model.id}" has an empty name`)
  }
  const capabilities: OwcModelCapabilities = model.capabilities ?? {}
  const modalities = capabilities.modalities ?? []
  const maxTokens = model.maxTokens ?? fallbackMaxTokens
  for (const modality of modalities) {
    if (!MODALITIES.includes(modality)) {
      throw new Error(`llm-service-lite: provider "${provider}" model "${model.id}" declares unknown modality "${modality}"`)
    }
    // Video is accepted as a declaration and carried as a file: a video
    // occurrence reaches the model as the same handle text any file
    // contributes, and the harness's own video content block is what a native
    // part will need before this adapter can send pixels of it.
  }
  const carriesImages = modalities.includes('image')
  if (model.imagePixelBudget !== undefined && !carriesImages) {
    throw new Error(
      `llm-service-lite: provider "${provider}" model "${model.id}" sets imagePixelBudget`
      + ' without declaring image input',
    )
  }
  if (model.imageMaxBytes !== undefined && !carriesImages) {
    throw new Error(
      `llm-service-lite: provider "${provider}" model "${model.id}" sets imageMaxBytes`
      + ' without declaring image input',
    )
  }
  // An accounting is a claim about how this endpoint charges for the images it
  // receives, so it describes a route that receives some.
  if (model.imageTokens !== undefined && !carriesImages) {
    throw new Error(
      `llm-service-lite: provider "${provider}" model "${model.id}" sets imageTokens`
      + ' without declaring image input',
    )
  }
  // Image output is carried as an assistant image block, which the two
  // OpenAI-compatible protocols have a part for and the Messages protocol does
  // not: declaring it there would name a capability no request could act on.
  if (capabilities.imageOutput === true && interfaceType === 'anthropic-messages') {
    throw new Error(
      `llm-service-lite: provider "${provider}" model "${model.id}" declares image output`
      + ' on interfaceType "anthropic-messages"; that protocol has no assistant image part',
    )
  }
  // Mid-conversation prompt and tool changes are carried as `system`-role
  // history, which only the Messages protocol has a part for. The other two
  // wires declare the complete prompt and tool list on every request, so a
  // declaration there would be a capability no request could act on.
  if (capabilities.systemPromptUpdate !== undefined || capabilities.toolUpdate !== undefined) {
    const declared = capabilities.systemPromptUpdate !== undefined ? 'systemPromptUpdate' : 'toolUpdate'
    if (interfaceType !== 'anthropic-messages') {
      throw new Error(
        `llm-service-lite: provider "${provider}" model "${model.id}" declares ${declared}`
        + ` on interfaceType "${interfaceType}"; only anthropic-messages carries a mid-history system message`,
      )
    }
    if (capabilities.systemPromptUpdate !== undefined
      && !SYSTEM_PROMPT_UPDATES.includes(capabilities.systemPromptUpdate)) {
      throw new Error(
        `llm-service-lite: provider "${provider}" model "${model.id}" declares unknown`
        + ` systemPromptUpdate "${capabilities.systemPromptUpdate}"`,
      )
    }
    if (capabilities.toolUpdate !== undefined && !TOOL_UPDATES.includes(capabilities.toolUpdate)) {
      throw new Error(
        `llm-service-lite: provider "${provider}" model "${model.id}" declares unknown`
        + ` toolUpdate "${capabilities.toolUpdate}"`,
      )
    }
  }
  // The model's family supplies what the profile left open — modalities, the
  // reasoning ladder, the thinking switch, and whether prior reasoning travels
  // back. A profile always wins: these fill gaps, they do not overrule.
  const family = familyFactsOf(model.id)
  // An endpoint that rejects a follow-up turn without its reasoning is not a
  // preference, so a declaration that contradicts the family is refused here
  // rather than discovered as a 400 mid-conversation.
  if (family.replayRequired && capabilities.replayReasoning === false) {
    throw new Error(
      `llm-service-lite: provider "${provider}" model "${model.id}" turns off reasoning replay,`
      + ` but family "${family.family}" requires it on every follow-up turn`,
    )
  }
  // A profile that says the endpoint returns reasoning is also saying the
  // replay is available, which is the reading every profile written before this
  // switch existed already relied on; a family that wants it off says so.
  const replayReasoning = family.replayRequired
    ? true
    : capabilities.replayReasoning
      ?? capabilities.reasoningContent
      ?? family.replayReasoning
  return {
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: model.contextWindow ?? fallbackContextWindow,
    maxTokens,
    defaults: resolveModelDefaults(provider, model.id, model.defaults, interfaceType),
    family: family.family,
    modalities: modalities.length === 0 ? [...family.modalities] : [...modalities],
    effort: [...capabilities.effort ?? family.effort],
    effortDefault: capabilities.effort === undefined ? family.effortDefault : undefined,
    thinking: [...capabilities.thinking ?? family.thinking],
    thinkingStyle: capabilities.thinkingStyle ?? family.thinkingStyle,
    reasoningContent: capabilities.reasoningContent ?? family.reasoningContent,
    replayReasoning,
    replayRequired: family.replayRequired,
    encryptedReplay: capabilities.responsesEncryptedReplay ?? false,
    systemPromptUpdate: capabilities.systemPromptUpdate,
    toolUpdate: capabilities.toolUpdate,
    tools: capabilities.tools ?? true,
    imagePixelBudget: model.imagePixelBudget === 'low'
      ? LOW_DETAIL_IMAGE_PIXEL_BUDGET
      : model.imagePixelBudget,
    imageMaxBytes: model.imageMaxBytes,
    imageTokens: model.imageTokens === undefined
      ? undefined
      : resolveImageTokens(provider, model.id, model.imageTokens),
    imageOutput: capabilities.imageOutput ?? false,
  }
}

/**
 * Resolve every configured profile into the facts the adapter serves.
 *
 * A disabled profile resolves like any other and is reported with
 * `enabled: false`: the route does not register, but configuration surfaces
 * still address it by name, which is what lets a deployment switch a provider
 * off without losing what it had configured.
 *
 * @param providers - configured profiles keyed by route name.
 * @param validation - `strict` refuses an unserviceable profile; `deferred` keeps it with a diagnostic.
 * @returns resolved profiles in configuration order, keyed by route name.
 * @throws Error in `strict` mode naming the route and field that cannot be served.
 */
export function resolveProfiles(
  providers: Readonly<Record<string, OwcProviderProfile>> | undefined,
  validation: ValidationMode = 'strict',
): Map<string, ResolvedOwcProviderProfile> {
  if (Array.isArray(providers)) {
    throw new Error('llm-service-lite: providers is a dict keyed by provider route, not an array of profiles')
  }
  const resolved = new Map<string, ResolvedOwcProviderProfile>()
  for (const [provider, rawSource] of Object.entries(providers ?? {})) {
    if (provider.length === 0) throw new Error('llm-service-lite: provider route names must be non-empty')
    if (resolved.has(provider)) throw new Error(`llm-service-lite: duplicate provider route "${provider}"`)
    let source: OwcProviderProfile
    let catalogDiagnostics: readonly string[]
    try {
      ({ profile: source, diagnostics: catalogDiagnostics } = materializeCatalog(provider, rawSource))
    } catch (error) {
      if (validation === 'strict') throw error
      resolved.set(provider, unserviceable(provider, rawSource, error))
      continue
    }
    let interfaceType: ServedInterfaceType
    try {
      interfaceType = assertAddressable(provider, source)
    } catch (error) {
      if (validation === 'strict') throw error
      resolved.set(provider, unserviceable(provider, source, error))
      continue
    }
    const defaultContextWindow = source.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
    const defaultMaxTokens = source.defaultMaxTokens ?? DEFAULT_MAX_TOKENS
    let models: readonly ResolvedOwcModel[]
    try {
      models = (source.models ?? [])
        .map(model => resolveModel(provider, model, interfaceType, defaultContextWindow, defaultMaxTokens))
      const ids = new Set<string>()
      for (const model of models) {
        if (ids.has(model.id)) throw new Error(`llm-service-lite: provider "${provider}" declares model "${model.id}" twice`)
        ids.add(model.id)
      }
    } catch (error) {
      if (validation === 'strict') throw error
      resolved.set(provider, unserviceable(provider, source, error))
      continue
    }
    resolved.set(provider, {
      provider,
      displayName: source.displayName ?? provider,
      enabled: source.enabled ?? true,
      interfaceType,
      baseURL: source.baseURL ?? ENDPOINT_DEFAULTS[interfaceType],
      apiKeyEnv: source.apiKeyEnv === undefined ? undefined : credentialRef(source.apiKeyEnv),
      apiKey: source.apiKey,
      headers: { ...source.headers },
      promptCaching: source.promptCaching ?? false,
      includeUsage: source.includeUsage ?? false,
      extraBody: { ...source.extraBody },
      maxConcurrent: source.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      streamIdleTimeoutMs: source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy(
        source.retryPolicy,
        `llm-service-lite: provider "${provider}" retryPolicy`,
      ),
      models,
      defaultContextWindow,
      defaultMaxTokens,
      imageRequestBudget: {
        representation: 'base64',
        maxBytes: source.imageRequestMaxBytes ?? DEFAULT_IMAGE_REQUEST_MAX_BYTES,
        maxImages: source.imageRequestMaxImages ?? DEFAULT_IMAGE_REQUEST_MAX_IMAGES,
        byteQuantum: source.imageOffloadByteQuantum ?? DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
        countQuantum: source.imageOffloadCountQuantum ?? DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
      },
      diagnostic: undefined,
      catalogDiagnostics,
    })
  }
  return resolved
}

/**
 * Materialize one profile's official-format catalog, when it names one.
 *
 * The conversion supplies the profile's protocol, endpoint, headers, and
 * models; every field the profile states itself wins over the converted value,
 * which is what lets one file describe a route while the deployment overrides
 * its credential, its endpoint, or its model list. The catalog field itself is
 * spent: what the route serves is the converted facts.
 *
 * @param provider - route name, for diagnostics.
 * @param source - configured profile.
 * @returns the profile the request path reads, and the conversion's diagnostics.
 * @throws Error when the catalog cannot be read or cannot become one route profile.
 */
function materializeCatalog(
  provider: string,
  source: OwcProviderProfile,
): { profile: OwcProviderProfile; diagnostics: readonly string[] } {
  const catalog = source.catalog
  if (catalog === undefined) return { profile: source, diagnostics: [] }
  let content: unknown
  if (typeof catalog === 'string') {
    try {
      content = JSON.parse(readFileSync(catalog, 'utf8')) as unknown
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`llm-service-lite: provider "${provider}" catalog "${catalog}" cannot be read: ${detail}`)
    }
  } else {
    content = catalog
  }
  const { profile, diagnostics } = convertOfficialProvider(content, provider)
  // The profile's own fields win over the converted ones, which is what lets
  // one file describe a route while the deployment overrides its credential,
  // its endpoint, or its model list. `interfaceType` is optional precisely so
  // the catalog can supply it, so an absent declaration must not erase it; and
  // an absent or empty model list keeps the catalog's models, which is the
  // official rule — a list replaces the catalog only when it names one.
  const declaredModels = source.models ?? []
  return {
    profile: {
      ...profile,
      ...source,
      interfaceType: source.interfaceType ?? profile.interfaceType,
      models: declaredModels.length === 0 ? profile.models : declaredModels,
    },
    diagnostics,
  }
}

/**
 * One profile that cannot serve, kept addressable by configuration surfaces.
 * @param provider - route name.
 * @param source - configured profile.
 * @param error - the failure that made it unserviceable.
 * @returns a resolved profile carrying the diagnostic and safe placeholder facts.
 */
function unserviceable(provider: string, source: OwcProviderProfile, error: unknown): ResolvedOwcProviderProfile {
  const message = error instanceof Error ? error.message : String(error)
  return {
    provider,
    displayName: source.displayName ?? provider,
    enabled: source.enabled ?? true,
    interfaceType: (INTERFACE_TYPES as readonly string[]).includes(source.interfaceType ?? '')
      ? source.interfaceType as ServedInterfaceType
      : 'openai-chat-completions',
    baseURL: source.baseURL ?? ENDPOINT_DEFAULTS['openai-chat-completions'],
    apiKeyEnv: undefined,
    apiKey: undefined,
    headers: {},
    promptCaching: false,
    includeUsage: false,
    extraBody: {},
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'llm-service-lite: unserviceable provider'),
    models: [],
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    imageRequestBudget: {
      representation: 'base64',
      maxBytes: DEFAULT_IMAGE_REQUEST_MAX_BYTES,
      maxImages: DEFAULT_IMAGE_REQUEST_MAX_IMAGES,
      byteQuantum: DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
      countQuantum: DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
    },
    diagnostic: message,
    catalogDiagnostics: [],
  }
}

/**
 * The facts the LLM registry captures when a route is registered, in a form
 * that compares by value: a change here must re-register, and merely reordering
 * the configuration must not.
 * @param profiles - resolved profiles.
 * @returns route facts sorted by route name.
 */
export function registrationFacts(profiles: ReadonlyMap<string, ResolvedOwcProviderProfile>): unknown {
  return [...profiles.values()]
    .filter(profile => profile.enabled && profile.diagnostic === undefined)
    .map(profile => ({
      provider: profile.provider,
      displayName: profile.displayName,
      retryPolicy: profile.retryPolicy,
      maxConcurrent: profile.maxConcurrent,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * The routes a resolution should register: enabled profiles that can serve.
 * @param profiles - resolved profiles.
 * @returns route names in configuration order.
 */
export function serviceableRoutes(profiles: ReadonlyMap<string, ResolvedOwcProviderProfile>): string[] {
  return [...profiles.values()]
    .filter(profile => profile.enabled && profile.diagnostic === undefined)
    .map(profile => profile.provider)
}

/**
 * The declared model, or the route's own defaults for an id it does not list.
 * Core routing accepts any model id, so an unlisted one is served from the
 * route's declared capacities rather than refused.
 * @param profile - resolved route.
 * @param model - exact model id from the request.
 * @returns the model facts a request uses.
 */
export function modelOf(profile: ResolvedOwcProviderProfile, model: string): ResolvedOwcModel {
  const listed = profile.models.find(entry => entry.id === model)
  if (listed !== undefined) return listed
  // An id the route does not list still gets its family's researched facts:
  // that is what makes a bare `models: []` route usable for a model the profile
  // never enumerated.
  const family = familyFactsOf(model)
  return {
    id: model,
    name: model,
    contextWindow: profile.defaultContextWindow,
    maxTokens: profile.defaultMaxTokens,
    defaults: {
      temperature: undefined,
      topP: undefined,
      topK: undefined,
      maxTokens: undefined,
    },
    ...family,
    modalities: [...family.modalities],
    effort: [...family.effort],
    thinking: [...family.thinking],
    imagePixelBudget: undefined,
    imageMaxBytes: undefined,
    imageTokens: undefined,
    imageOutput: false,
    encryptedReplay: false,
    systemPromptUpdate: undefined,
    toolUpdate: undefined,
    tools: true,
  }
}

/**
 * The facts one model id's family supplies, or the empty answer when no family
 * speaks for it. Both entry points read them the same way, so a listed model
 * and an id the route never enumerated cannot drift apart.
 * @param model - exact model id from the request.
 * @returns family-derived facts, already in resolved form.
 */
function familyFactsOf(model: string): {
  family: string | undefined
  modalities: readonly Modality[]
  effort: readonly EffortLevel[]
  effortDefault: EffortLevel | undefined
  thinking: readonly ThinkingMode[]
  thinkingStyle: ThinkingStyle | undefined
  reasoningContent: boolean
  replayReasoning: boolean
  replayRequired: boolean
} {
  const rule = modelDefaultRuleOf(model)
  const replayRequired = rule?.replayRequired === true
  return {
    family: rule?.family,
    modalities: rule?.modalities ?? ['text'],
    effort: rule?.effort ?? [],
    effortDefault: rule?.effortDefault,
    thinking: rule?.thinking ?? [],
    thinkingStyle: rule?.thinkingStyle,
    reasoningContent: rule?.reasoningContent ?? false,
    replayReasoning: replayRequired || (rule?.replayReasoning ?? rule?.reasoningContent ?? false),
    replayRequired,
  }
}

/**
 * Reject profiles that cannot be served, while letting an unchanged stored
 * profile through: a configuration that already worked must stay editable
 * after this adapter's own rules tighten, and only the entries an operation
 * actually touches are re-validated.
 * @param config - the resolved section to check.
 * @param previous - the section already in force; omission checks every provider.
 * @throws Error naming the route and field that cannot be served.
 */
export function assertServiceable(config: Options, previous?: Options): void {
  const changed = Object.fromEntries(Object.entries(config.providers ?? {}).filter(([provider, profile]) =>
    previous?.providers?.[provider] === undefined || !deepEqualJson(profile, previous.providers[provider])))
  resolveProfiles(changed)
}
