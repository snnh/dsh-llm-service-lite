/**
 * Configuration schema and provider-profile vocabulary for the OWC-style
 * adapter.
 *
 * The shape follows OpenWebCode's model-provider layer rather than pi-ai's
 * catalog: a profile is a self-contained endpoint declaration — protocol,
 * endpoint, credential, and the models it serves — and the `providers` dict
 * key is the route a request selects. Nothing here assumes an installed
 * catalog knows the provider, so a gateway reaches the same code path as a
 * first-party endpoint.
 *
 * One deliberate departure: a credential may be named as a harness reference
 * (`apiKeyEnv`) instead of being written into the configuration, which is how
 * a deployment keeps secrets out of a file that may be committed. An inline
 * `apiKey` remains available for a profile imported verbatim from OWC.
 *
 * @module dsh-llm-service-lite/config
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/**
 * Wire protocols a provider profile may name, spelled the way OWC spells
 * them. `openai-chat-completions` is the broadest by far: DeepSeek, Qwen,
 * GLM, Kimi, and every self-hosted vLLM or SGLang server speak it, which is
 * why it is the default a configuration surface should offer first.
 */
export const INTERFACE_TYPES = ['openai-chat-completions', 'anthropic-messages', 'openai-responses'] as const

/** One wire protocol name from {@link INTERFACE_TYPES}. */
export type InterfaceType = (typeof INTERFACE_TYPES)[number]

/**
 * The protocols this adapter's transports implement. Every declared protocol
 * has one, so this list and {@link INTERFACE_TYPES} name the same set: a
 * vocabulary entry without a transport would be a protocol a deployment could
 * declare and no request could carry.
 */
export const SERVED_INTERFACE_TYPES: readonly InterfaceType[] = INTERFACE_TYPES

/** One protocol this adapter serves. */
export type ServedInterfaceType = InterfaceType

/**
 * Reasoning-effort levels a model may offer, ordered least to most expensive.
 * The level id is also its wire spelling for `openai-chat-completions`: OWC
 * sends exactly the level the user picked, so a gateway with its own
 * vocabulary declares that vocabulary as its levels.
 */
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

/** One selectable reasoning-effort level from {@link EFFORT_LEVELS}. */
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * Thinking modes a model may accept. `disabled` is a capability that means
 * the endpoint can be told to stop thinking; a model offering only that mode
 * publishes no selectable reasoning levels.
 */
export const THINKING_MODES = ['adaptive', 'enabled', 'disabled'] as const

/** One thinking mode from {@link THINKING_MODES}. */
export type ThinkingMode = (typeof THINKING_MODES)[number]

/**
 * How a chat-completions endpoint spells the thinking switch, mirroring OWC's
 * `thinkingStyle`: `thinking` and `fixed` send `thinking: { type }`,
 * `enable_thinking` sends a top-level boolean, and `effort_only` — like an
 * unset style — sends only the effort level. The explicit spelling of "no
 * switch" exists so an OWC-format document carries over without editing: it
 * declares the same behaviour the omitted style already gives.
 */
export const THINKING_STYLES = ['thinking', 'fixed', 'enable_thinking', 'effort_only'] as const

/** One thinking wire style from {@link THINKING_STYLES}. */
export type ThinkingStyle = (typeof THINKING_STYLES)[number]

/**
 * How a model applies a system prompt that changes mid-conversation, spelled
 * exactly as the harness spells it. `in-history` declares that the endpoint
 * reads a `system`-role message at any position of the conversation as the
 * complete effective prompt, so a changed prompt follows the cached history
 * instead of rewriting the first message — the same declaration the first-party
 * DeepSeek catalog makes, and one only a Messages endpoint can be asked for.
 */
export const SYSTEM_PROMPT_UPDATES = ['in-history'] as const

/** One system-prompt update mode from {@link SYSTEM_PROMPT_UPDATES}. */
export type SystemPromptUpdate = (typeof SYSTEM_PROMPT_UPDATES)[number]

/**
 * How a model accepts tool declarations that change mid-conversation.
 * `addition-only` declares that the endpoint activates a deferred tool when a
 * later `system` message names it, so an added tool follows the cached history
 * instead of rewriting the declaration list; `in-history` adds that a removed
 * tool keeps its declaration and is deactivated the same way. Omission means
 * every request declares the complete current list.
 */
export const TOOL_UPDATES = ['addition-only', 'in-history'] as const

/** One tool-update mode from {@link TOOL_UPDATES}. */
export type ToolUpdate = (typeof TOOL_UPDATES)[number]

/**
 * Which published visual-token accounting an endpoint charges for one request
 * image. The vocabulary exists because the number decides how much of the
 * context window an image occupies, and the token meter can only price an image
 * against the accounting of the route that will carry it: `area` charges a flat
 * pixel grid (Claude bills one token per 750 pixels) and `tiles` charges a base
 * plus a price per square tile covered (the OpenAI vision documentation). A
 * route that declares neither keeps the meter's own structural heuristic.
 */
export const IMAGE_TOKEN_KINDS = ['area', 'tiles'] as const

/** One visual-token accounting from {@link IMAGE_TOKEN_KINDS}. */
export type ImageTokenKind = (typeof IMAGE_TOKEN_KINDS)[number]

/**
 * The visual-token accounting one model declares. Only the fields of the
 * declared kind apply; resolution refuses a declaration that states the other
 * kind's fields, because a profile that names two accountings states neither.
 */
export interface OwcImageTokenAccounting {
  /** Which accounting this endpoint charges. */
  kind: ImageTokenKind
  /** `area`: pixels one visual token covers. */
  per?: number
  /** `tiles`: side of the square tile the image is charged in, in pixels. */
  tile?: number
  /** `tiles`: tokens charged once per image, whatever it covers. */
  base?: number
  /** `tiles`: tokens charged for each tile the image covers. */
  perTile?: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface ModelModalityMap {
    /**
     * Video input. This adapter carries a video occurrence as a file handle
     * rather than as a native part: the harness has no video content block yet,
     * so declaring it states that the route accepts video files, not that their
     * moving pictures reach the model.
     */
    video: 'video'
  }
}

/**
 * Input modalities a model accepts; text is the assumption when none is
 * declared. The vocabulary mirrors OWC's; `image` is carried as an inline
 * base64 `image_url` part, and `video` is carried as a file handle until the
 * harness has a video content block for a native part.
 */
export const MODALITIES = ['text', 'image', 'video'] as const

/** One input modality from {@link MODALITIES}. */
export type Modality = (typeof MODALITIES)[number]

/**
 * Concurrent requests one route serves before further calls queue. OWC fixes
 * this at three per provider: enough to let a swarm overlap, few enough that a
 * rate-limited endpoint sees a plateau instead of a spike.
 */
export const DEFAULT_MAX_CONCURRENT = 3

/**
 * Default maximum idle interval between two stream events, in milliseconds.
 * A gateway that stalls mid-response without closing the socket would
 * otherwise hold a turn open forever.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Context capacity assumed for a model the profile does not size. The guess
 * is deliberately generous rather than conservative: an oversized window costs
 * a compaction that would have been unnecessary, while an undersized one
 * refuses a request the endpoint would have accepted.
 */
export const DEFAULT_CONTEXT_WINDOW = 256_000

/** Output capability assumed for a model the profile does not size. */
/**
 * Output capacity a model the profile sizes nowhere falls back to, and the
 * number a blank capacity field shows as inherited. It matches the cap the
 * Anthropic Messages wire sends for a model no family speaks for, so the
 * displayed default and the sent one are the same number.
 */
export const DEFAULT_MAX_TOKENS = 64 * 1024

/**
 * Accumulated base64 image payload one request may carry. The default matches
 * the official adapter's inline ceiling: beyond it a gateway that accepts the
 * request at all tends to answer slowly or truncate, and the caller can do
 * better by offloading the oldest occurrence.
 */
export const DEFAULT_IMAGE_REQUEST_MAX_BYTES = 20 * 1024 * 1024

/** Image occurrences one request may carry. */
export const DEFAULT_IMAGE_REQUEST_MAX_IMAGES = 600

/** Payload removed as one deterministic offload step. */
export const DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024

/** Occurrences removed as one deterministic offload step. */
export const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 20

/**
 * What one model on a route can do. Every field is a declaration about the
 * endpoint, not a guess: a capability left out is one this adapter does not
 * claim, and the request path omits rather than invents.
 */
export interface OwcModelCapabilities {
  /** Accepted input modalities; omission means text only. */
  modalities?: Modality[]
  /** Accepted reasoning-effort levels; empty or absent publishes no effort selector. */
  effort?: EffortLevel[]
  /** Accepted thinking modes; `disabled` alone means the switch exists but thinking is off. */
  thinking?: ThinkingMode[]
  /** How this model's endpoint spells the thinking switch; omission sends only the effort level. */
  thinkingStyle?: ThinkingStyle
  /**
   * Whether the endpoint returns its reasoning in `reasoning_content`, so a
   * later request may replay prior thinking the way DeepSeek's own API does.
   */
  reasoningContent?: boolean
  /**
   * Whether prior reasoning is sent back to the endpoint on a later request.
   * Absent defers to the model's family (see `model-defaults.ts`), which is
   * what makes a bare profile work; `true` turns the replay on where a family
   * would leave it off, and only an endpoint that does not mind the field may
   * be turned off — a family whose follow-up turns are rejected outright
   * without it refuses `false`.
   */
  replayReasoning?: boolean
  /**
   * Whether tool declarations may be sent to this model; omission means they
   * may. A model declaring `false` is one whose endpoint rejects or mishandles
   * a `tools` array, so the request carries none and the model answers as plain
   * chat — the same declaration OWC's catalog makes.
   */
  tools?: boolean
  /**
   * Whether the model answers with images of its own. A declared model's
   * answers are published as image blocks — this adapter reads the inline
   * picture the endpoint returns, stores it through the attachment provider,
   * and republishes a durable reference — and an image from a model that never
   * declared one fails by name rather than being carried unclaimed. Declaring
   * it is refused on `anthropic-messages`, whose assistant turn has no image
   * part.
   */
  imageOutput?: boolean
  /**
   * Whether the endpoint replays signed reasoning items: the Responses
   * transport then requests `reasoning.encrypted_content` and hands each
   * reasoning item back verbatim, which is what a stateless turn needs to
   * resume a provider that will not accept its reasoning as plain text.
   */
  responsesEncryptedReplay?: boolean
  /**
   * Whether the endpoint reads a mid-conversation `system` message as the
   * complete effective system prompt. Declaring it is refused on any protocol
   * but `anthropic-messages`, whose `system` role this adapter can place in the
   * history; the other two transports have no such part.
   */
  systemPromptUpdate?: SystemPromptUpdate
  /**
   * Whether the endpoint activates and deactivates tools through mid-history
   * messages instead of a rewritten declaration list. Declaring it is refused
   * on any protocol but `anthropic-messages`, and it is what makes the harness
   * hand this route `tool-addition` and `tool-removal` blocks — with the
   * declaration list then carrying `defer_loading` for the tools it defers.
   */
  toolUpdate?: ToolUpdate
}

/**
 * Request parameters one model sends when the caller states none. These are
 * the endpoint's own settings, not capabilities: a field left out is one this
 * adapter never writes, and a field declared is written exactly when the
 * caller's own request left it unstated — a caller that names a value always
 * wins, so a default can never override an explicit choice.
 */
export interface OwcModelDefaults {
  /** Sampling temperature written when the caller names none. */
  temperature?: number
  /** Nucleus cutoff written when the caller names none. */
  topP?: number
  /**
   * Top-k cutoff written when the caller names none. Only the two protocols
   * with a top-k field carry it, so declaring it on `openai-responses` is
   * refused at resolution rather than silently dropped.
   */
  topK?: number
  /**
   * Output cap this model asks for when the caller states none; defaults to
   * the model's own `maxTokens`, which stays the capability a configuration
   * surface reads.
   */
  maxTokens?: number
}

/** One model a route serves, with the endpoint facts a request needs. */
export interface OwcModelProfile {
  /** Exact model id sent on the wire and named by `GenerateOptions.model`. */
  id: string
  /** Display name for selection surfaces; defaults to the id. */
  name?: string
  /** Context capacity in tokens; defaults to the route's `defaultContextWindow`. */
  contextWindow?: number
  /** Per-request output cap in tokens; defaults to the route's `defaultMaxTokens`. */
  maxTokens?: number
  /** Declared endpoint capabilities. */
  capabilities?: OwcModelCapabilities
  /**
   * Pixel budget every request image of this model is projected into, capping
   * `width * height`; `low` selects the published low-detail grid. Omission
   * keeps the source dimensions, still capped on the long edge.
   */
  imagePixelBudget?: number | 'low'
  /**
   * Encoded-byte target for one request image of this model. The encoder keeps
   * the smallest output of its quality ladder when no step fits.
   */
  imageMaxBytes?: number
  /**
   * Visual-token accounting this model's endpoint charges, which is what lets
   * the token meter price an image-bearing context instead of guessing.
   */
  imageTokens?: OwcImageTokenAccounting
  /**
   * Request parameters this model sends when the caller states none, so one
   * endpoint's sampling settings are configuration rather than a caller
   * concern.
   */
  defaults?: OwcModelDefaults
}

/**
 * One provider endpoint. The `providers` dict key is the route name a request
 * selects with `GenerateOptions.provider`, and it is also what every
 * configuration surface shows unless `displayName` overrides the label.
 */
export interface OwcProviderProfile {
  /** Label shown by selection surfaces; defaults to the route key. */
  displayName?: string
  /** Whether the route registers at all; a disabled profile keeps its configuration but serves nothing. */
  enabled?: boolean
  /**
   * Wire protocol every model on this route speaks; every entry in
   * {@link INTERFACE_TYPES} is served. Required unless `catalog` supplies one.
   */
  interfaceType?: InterfaceType
  /**
   * Official-format model configuration this route starts from: the path of an
   * official provider file, or its parsed content. Every field it states —
   * protocol, endpoint, headers, models with their capacities, modalities,
   * thinking levels, and request defaults — is converted into this adapter's
   * own vocabulary, and the profile's own fields override the conversion. A
   * field the conversion cannot carry is reported rather than guessed.
   */
  catalog?: string | Record<string, unknown>
  /** Endpoint of every model on the route; the protocol's usual host and version apply when omitted. */
  baseURL?: string
  /** Credential reference resolved per request through the harness credential seam. */
  apiKeyEnv?: string
  /** Inline credential, for a profile imported verbatim from OWC; prefer `apiKeyEnv` on a managed deployment. */
  apiKey?: string
  /** Static request headers, for a gateway that routes by header. */
  headers?: Record<string, string>
  /** Whether the route may use prompt caching, where the protocol supports it. */
  promptCaching?: boolean
  /** Whether a chat-completions request asks the endpoint to report usage in the stream. */
  includeUsage?: boolean
  /** Extra top-level request-body fields, for endpoint-specific knobs. */
  extraBody?: Record<string, unknown>
  /** Concurrent requests this route serves before calls queue. */
  maxConcurrent?: number
  /** Maximum idle interval between two stream events for this route, in milliseconds. */
  streamIdleTimeoutMs?: number
  /** Provider-owned retry policy executed by an agent-recovery plugin such as `dsh-llm-retry`. */
  retryPolicy?: RetryPolicyConfig
  /** Models this route serves; an empty list advertises nothing and serves only explicitly named ids. */
  models?: OwcModelProfile[]
  /** Context capacity for a route model that declares none. */
  defaultContextWindow?: number
  /** Output capability for a route model that declares none. */
  defaultMaxTokens?: number
  /**
   * Accumulated base64 image payload one request on this route carries before
   * the oldest occurrences must be offloaded. Default 20 MiB.
   */
  imageRequestMaxBytes?: number
  /** Image occurrences one request on this route carries. Default 600. */
  imageRequestMaxImages?: number
  /** Payload removed as one deterministic offload step. Default 10 MiB. */
  imageOffloadByteQuantum?: number
  /** Occurrences removed as one deterministic offload step. Default 20. */
  imageOffloadCountQuantum?: number
}

/**
 * Plugin configuration: the provider routes this instance owns. One document
 * describes every third-party endpoint this deployment reaches — which is the
 * whole of what the plugin does.
 */
export interface Config {
  /**
   * Provider profiles keyed by the route name a request selects. An empty or
   * omitted dict is the dormant posture: the adapter mounts with no routes and
   * registers them the moment a profile appears.
   */
  providers: Volatile<Record<string, OwcProviderProfile>>
}

/** Plain options accepted by the profile resolver. */
export type Options = { [K in keyof Config]?: Config[K] extends Volatile<infer T> ? T : never }

const capabilities: z<OwcModelCapabilities> = z.object({
  /** Accepted input modalities; omission means text only. */
  modalities: z.array(z.union(MODALITIES)),
  /** Accepted reasoning-effort levels. */
  effort: z.array(z.union(EFFORT_LEVELS)),
  /** Accepted thinking modes. */
  thinking: z.array(z.union(THINKING_MODES)),
  /** How this model's endpoint spells the thinking switch. */
  thinkingStyle: z.union(THINKING_STYLES),
  /** Whether prior reasoning may be replayed through `reasoning_content`. */
  reasoningContent: z.boolean(),
  /** Whether prior reasoning is sent back; absent defers to the model's family. */
  replayReasoning: z.boolean(),
  /** Whether tool declarations may be sent to this model. */
  tools: z.boolean(),
  /** Whether the model answers with images of its own; refused on the protocol with no assistant image part. */
  imageOutput: z.boolean(),
  /** Whether the endpoint replays signed reasoning; refused until the responses transport exists. */
  responsesEncryptedReplay: z.boolean(),
  /** Whether the endpoint reads a mid-conversation system message as the effective prompt. */
  systemPromptUpdate: z.union(SYSTEM_PROMPT_UPDATES),
  /** Whether the endpoint activates and deactivates tools through mid-history messages. */
  toolUpdate: z.union(TOOL_UPDATES),
})

const modelDefaults: z<OwcModelDefaults> = z.object({
  /** Sampling temperature written when the caller names none. */
  temperature: z.number().min(0).max(2),
  /** Nucleus cutoff written when the caller names none. */
  topP: z.number().min(0).max(1),
  /** Top-k cutoff written when the caller names none. */
  topK: z.number().step(1).min(1),
  /** Output cap asked for when the caller states none. */
  maxTokens: z.number().step(1).min(1),
})

const modelProfile: z<OwcModelProfile> = z.object({
  /** Exact model id sent on the wire. */
  id: z.string().required(),
  /** Display name for selection surfaces; defaults to the id. */
  name: z.string(),
  /** Context capacity in tokens; defaults to the route's `defaultContextWindow`. */
  contextWindow: z.number().step(1).min(1),
  /** Per-request output cap in tokens; defaults to the route's `defaultMaxTokens`. */
  maxTokens: z.number().step(1).min(1),
  /** Declared endpoint capabilities. */
  capabilities,
  /** Pixel budget request images are projected into; `low` selects the low-detail grid. */
  imagePixelBudget: z.union([z.number().step(1).min(1), z.const('low')]),
  /** Encoded-byte target for one request image. */
  imageMaxBytes: z.number().step(1).min(1),
  /**
   * Visual-token accounting this endpoint charges. The single-branch union is
   * what keeps the field absent when a profile omits it: a bare nested object
   * is materialized as `{}` and would then fail its own required `kind`.
   */
  imageTokens: z.union([z.object({
    kind: z.union(IMAGE_TOKEN_KINDS).required(),
    per: z.number(),
    tile: z.number(),
    base: z.number(),
    perTile: z.number(),
  })]),
  /** Request parameters this model sends when the caller states none. */
  defaults: modelDefaults,
})

const providerProfile: z<OwcProviderProfile> = z.object({
  /** Label shown by selection surfaces; defaults to the route key. */
  displayName: z.string(),
  /** Whether the route registers at all. */
  enabled: z.boolean().default(true),
  /** Wire protocol every model on this route speaks. */
  interfaceType: z.union(INTERFACE_TYPES),
  /** Official-format model configuration this route starts from. */
  catalog: z.union([z.string(), z.dict(z.any())]),
  /** Endpoint of every model on the route. */
  baseURL: z.string(),
  /** Credential reference resolved per request through the harness credential seam. */
  apiKeyEnv: z.string().role('credential-ref'),
  /** Inline credential; prefer `apiKeyEnv` on a managed deployment. */
  apiKey: z.string().role('secret'),
  /** Static request headers. */
  headers: z.dict(z.string()),
  /** Whether the route may use prompt caching. */
  promptCaching: z.boolean(),
  /** Whether a chat-completions request asks the endpoint to report usage in the stream. */
  includeUsage: z.boolean(),
  /** Extra top-level request-body fields. */
  extraBody: z.dict(z.any()),
  /** Concurrent requests this route serves before calls queue. */
  maxConcurrent: z.number().step(1).min(1).default(DEFAULT_MAX_CONCURRENT),
  /** Maximum idle interval between two stream events for this route, in milliseconds. */
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  /** Provider-owned retry policy executed by the agent's recovery layer. */
  retryPolicy: RetryPolicySchema,
  /** Models this route serves. */
  models: z.array(modelProfile),
  /** Context capacity for a route model that declares none. */
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  /** Output capability for a route model that declares none. */
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  /** Accumulated base64 image payload one request carries before the oldest occurrences offload. */
  imageRequestMaxBytes: z.number().step(1).min(1),
  /** Image occurrences one request carries. */
  imageRequestMaxImages: z.number().step(1).min(1),
  /** Payload removed as one deterministic offload step. */
  imageOffloadByteQuantum: z.number().step(1).min(1),
  /** Occurrences removed as one deterministic offload step. */
  imageOffloadCountQuantum: z.number().step(1).min(1),
})

/**
 * Runtime schema for {@link Options}. The DeepSeek channel's fields sit beside
 * the profiles because the built-in entry mounts this plugin under its own id:
 * one deployment may fill either, and the entry decides which channel answers.
 */
export const Config = z.object({
  /** Provider profiles keyed by the route name a request selects. */
  providers: z.dict(providerProfile).default({}).volatile(),
})
