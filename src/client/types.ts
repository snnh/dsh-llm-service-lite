/**
 * Browser-side vocabulary for the provider-configuration page.
 *
 * The page edits the `llm-service-lite` Loader row's `providers` dictionary
 * through the shared settings form, so the shapes here mirror the Host
 * profile schema in `src/config.ts`. Every profile object is edited as a
 * detached draft: unknown or advanced fields a hand-written profile may carry
 * (`headers`, `extraBody`, `catalog`, `retryPolicy`, ...) are preserved by the
 * draft round-trip and simply not rendered by this first version of the page.
 *
 * @module @snnh/dsh-llm-service-lite/client/types
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ServiceLiteKey } from './locales.ts'

/** This package's npm name; the `plugins.row.config` key is derived from it. */
export const PACKAGE_NAME = '@snnh/dsh-llm-service-lite'

/** Loader row id this bundle's patch mounts, which is also the settings namespace. */
export const ROW_ID = 'llm-service-lite'

/** Settings namespace the Host plugin serves (the Loader entry id). */
export const SETTINGS_NS = ROW_ID

/** Client locale namespace owned by this page. */
export const LOCALE_NS = 'settings.llm-service-lite'

/** `plugins.row.config` key: `<package name>#<row id>`. */
export const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ROW_ID}`

/** Wire protocols this adapter serves. */
export const INTERFACE_TYPES = ['openai-chat-completions', 'anthropic-messages', 'openai-responses'] as const
/** One wire protocol this page can declare. */
export type InterfaceType = (typeof INTERFACE_TYPES)[number]

/** Reasoning-effort levels a model may declare, least to most expensive. */
export const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
/** One selectable effort level. */
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** Thinking modes a model may accept. */
export const THINKING_MODES = ['adaptive', 'enabled', 'disabled'] as const
/** One thinking mode. */
export type ThinkingMode = (typeof THINKING_MODES)[number]

/** How a chat-completions endpoint spells its thinking switch. */
export const THINKING_STYLES = ['thinking', 'fixed', 'enable_thinking', 'effort_only'] as const
/** One thinking-switch spelling. */
export type ThinkingStyle = (typeof THINKING_STYLES)[number]

/** Input modalities a model may declare. */
export const MODALITIES = ['text', 'image', 'video'] as const
/** One input modality. */
export type Modality = (typeof MODALITIES)[number]

/** Route names the first-party DeepSeek channel already owns. */
export const RESERVED_ROUTES: Readonly<Record<string, string>> = {
  'deepseek-official': '@deepseek-ai/dsh-llm-deepseek-api-key',
  'deepseek-account': '@deepseek-ai/dsh-llm-deepseek-account',
}

/** Visual-token accounting one model may declare. */
export interface ImageTokenAccounting {
  /** Which accounting the endpoint charges. */
  kind?: 'area' | 'tiles'
  /** `area`: pixels one visual token covers. */
  per?: number
  /** `tiles`: side of the square tile, in pixels. */
  tile?: number
  /** `tiles`: tokens charged once per image. */
  base?: number
  /** `tiles`: tokens charged per tile covered. */
  perTile?: number
}

/** One model's declared endpoint capabilities. */
export interface ModelCapabilities {
  /** Accepted input modalities; omission means text only. */
  modalities?: Modality[]
  /** Accepted reasoning-effort levels. */
  effort?: EffortLevel[]
  /** Accepted thinking modes. */
  thinking?: ThinkingMode[]
  /** How the endpoint spells the thinking switch. */
  thinkingStyle?: ThinkingStyle
  /** Whether the endpoint returns its reasoning in `reasoning_content`. */
  reasoningContent?: boolean
  /** Whether prior reasoning is replayed; absent defers to the model family. */
  replayReasoning?: boolean
  /** Whether tool declarations may be sent. */
  tools?: boolean
  /** Whether the model answers with images of its own. */
  imageOutput?: boolean
  /** Whether the endpoint replays signed reasoning items. */
  responsesEncryptedReplay?: boolean
  /** Whether a mid-conversation system message is the effective prompt. */
  systemPromptUpdate?: 'in-history'
  /** Whether tools activate and deactivate through mid-history messages. */
  toolUpdate?: 'addition-only' | 'in-history'
}

/** Request parameters one model writes when the caller states none. */
export interface ModelDefaults {
  /** Sampling temperature. */
  temperature?: number
  /** Nucleus cutoff. */
  topP?: number
  /** Top-k cutoff. */
  topK?: number
  /** Output cap asked for when the caller states none. */
  maxTokens?: number
}

/** One model a route serves. */
export interface ModelProfile {
  /** Exact model id sent on the wire. */
  id: string
  /** Display name; defaults to the id. */
  name?: string
  /** Context capacity in tokens. */
  contextWindow?: number
  /** Output capability in tokens. */
  maxTokens?: number
  /** Declared endpoint capabilities. */
  capabilities?: ModelCapabilities
  /** Pixel budget request images are projected into, or `low`. */
  imagePixelBudget?: number | 'low'
  /** Encoded-byte target for one request image. */
  imageMaxBytes?: number
  /** Visual-token accounting the endpoint charges. */
  imageTokens?: ImageTokenAccounting
  /** Request parameters this model writes when the caller states none. */
  defaults?: ModelDefaults
}

/** One provider endpoint; the dict key is the route a request selects. */
export interface ProviderProfile {
  /** Label shown by selection surfaces; defaults to the route key. */
  displayName?: string
  /** Whether the route registers at all. */
  enabled?: boolean
  /** Wire protocol every model on this route speaks. */
  interfaceType?: InterfaceType
  /** Endpoint of every model on the route. */
  baseURL?: string
  /** Credential reference resolved per request through the credentials seam. */
  apiKeyEnv?: string
  /** Inline credential; prefer `apiKeyEnv` on a managed deployment. */
  apiKey?: string
  /** Static request headers. */
  headers?: Record<string, string>
  /** Whether the route may use prompt caching (Messages only). */
  promptCaching?: boolean
  /** Whether a chat-completions request asks for a streamed usage report. */
  includeUsage?: boolean
  /** Extra top-level request-body fields. */
  extraBody?: Record<string, unknown>
  /** Concurrent requests this route serves before calls queue. */
  maxConcurrent?: number
  /** Maximum idle interval between two stream events, in milliseconds. */
  streamIdleTimeoutMs?: number
  /** Models this route serves. */
  models?: ModelProfile[]
  /** Context capacity for a model that declares none. */
  defaultContextWindow?: number
  /** Output capability for a model that declares none. */
  defaultMaxTokens?: number
  /** Image request budgets and offload quanta. */
  imageRequestMaxBytes?: number
  /** Image occurrences one request carries. */
  imageRequestMaxImages?: number
  /** Payload removed as one deterministic offload step. */
  imageOffloadByteQuantum?: number
  /** Occurrences removed as one deterministic offload step. */
  imageOffloadCountQuantum?: number
  /** Official-format catalog this route starts from (advanced; preserved). */
  catalog?: string | Record<string, unknown>
  /** Provider-owned retry policy (advanced; preserved). */
  retryPolicy?: Record<string, unknown>
}

/** One provider as the page edits it (unknown fields are preserved by the draft round-trip). */
export type ClientProvider = ProviderProfile

/** One model as the page edits it (unknown fields are preserved by the draft round-trip). */
export type ClientModel = ModelProfile

/** A staged provider patch: `undefined` clears a field. */
export type ProviderPatch = { readonly [K in keyof ClientProvider]?: ClientProvider[K] | undefined }

/** A staged model patch: `undefined` clears a field. */
export type ModelPatch = { readonly [K in keyof ClientModel]?: ClientModel[K] | undefined }

/** A staged capability patch: `undefined` clears a declaration. */
export type CapabilitiesPatch = { readonly [K in keyof ModelCapabilities]?: ModelCapabilities[K] | undefined }

/** The page's bound dictionary lookup. */
export type ServiceLiteTranslate = (key: ServiceLiteKey, params?: Record<string, unknown>) => string

/** The empty document the page starts from before the Host value arrives. */
export function emptyConfig(): ClientConfig {
  return { providers: {} }
}

/** The settings section this page edits. */
export interface ClientConfig {
  /** Provider profiles keyed by the route name a request selects. */
  providers: Record<string, ClientProvider>
}

/** One pre-save validation finding, localized by the page. */
export interface ProfileProblem {
  /** Dotted path of the offending field, for the problem list. */
  path: string
  /** Locale dictionary key naming the problem. */
  key: string
  /** Values the message interpolates. */
  params?: Record<string, string>
}

/** One model an endpoint disclosed to the discovery action. */
export interface DiscoveredModel {
  /** Endpoint-facing model id. */
  id: string
  /** Display name, when the endpoint stated one. */
  name?: string
  /** Context capacity, when the endpoint stated one. */
  contextWindow?: number
  /** Output capability, when the endpoint stated one. */
  maxTokens?: number
}

/** What one endpoint interrogation answered. */
export type DiscoveryOutcome =
  | { readonly kind: 'found'; readonly models: readonly DiscoveredModel[] }
  | { readonly kind: 'refused'; readonly message: string }

/** The endpoint facts a discovery request carries. */
export interface DiscoveryRequest {
  /** Route being edited, when it is already stored. */
  provider?: string
  /** Endpoint to interrogate. */
  baseURL?: string
  /** Protocol the endpoint speaks, in this adapter's vocabulary. */
  api?: string
  /** One-shot credential typed into the draft. */
  apiKey?: string
}

/** Page snapshot: the shared form state plus the staged provider document. */
export interface ServiceLitePageSnapshot extends SettingsFormShell {
  /** The staged providers document, or the stored one when nothing is staged. */
  draft: ClientConfig
  /** Pre-save validation findings; non-empty blocks the save. */
  problems: readonly ProfileProblem[]
  /** Whether a host revision invalidated the staged draft. */
  conflicted: boolean
}

/** Actions and hooks the page binds. */
export interface ServiceLitePageFace {
  hooks: {
    /** Page snapshot bound by the renderer as useServiceLitePage. */
    serviceLitePage: SnapshotStore<ServiceLitePageSnapshot>
  }
  /** Stage one whole-document edit. */
  edit: (update: (draft: ClientConfig) => ClientConfig) => void
  /** Persist the staged document. */
  save: () => void
  /** Drop the staged document. */
  discard: () => void
  /** Store one credential literal for a reference; resolves to the refusal message. */
  storeKey: (ref: string, value: string) => Promise<string | undefined>
  /** Ask an endpoint for the models it serves. */
  discover: (request: DiscoveryRequest) => Promise<DiscoveryOutcome>
}
