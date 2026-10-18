/**
 * Endpoint interrogation for configuration surfaces.
 *
 * Asking a provider what it serves is a configuration-time action over a
 * draft, so the answer is advisory: nothing is stored and nothing is
 * registered — the profile a user saves decides what a route serves.
 *
 * The listing is protocol-aware, mirroring the harness's own discovery seam:
 * OpenAI-compatible endpoints list at `{baseURL}/models` with a bearer token,
 * while an Anthropic Messages endpoint lists at `{root}/v1/models` with
 * `x-api-key` and `anthropic-version`. The request is bounded because the
 * endpoint is whatever URL the user typed, and an oversized or unreadable reply
 * is reported as a discovery failure rather than as a JSON or header TypeError
 * from deeper in the runtime.
 *
 * @module dsh-llm-service-lite/discovery
 */

import { attributionHeaders, LlmError, type LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'

/** How long an endpoint interrogation may take before it is abandoned. */
const DISCOVERY_TIMEOUT_MS = 10_000

/** Largest listing body accepted from an endpoint the caller typed. */
export const DISCOVERY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Stable API version required by Anthropic's model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Largest page accepted by Anthropic's public listing; discovery reads one page. */
const ANTHROPIC_MODEL_LIMIT = 1000

/**
 * Wire protocols whose model listing this module can read. The vocabulary is
 * this adapter's own `interfaceType`, so a caller that names a protocol is not
 * left guessing how the plugin spells it.
 */
export const LISTABLE_INTERFACE_TYPES = [
  'openai-chat-completions',
  'anthropic-messages',
  'openai-responses',
] as const

/** Options a configuration surface attaches to one endpoint interrogation. */
export interface DiscoverEndpointModelsOptions {
  /** Wire protocol the endpoint speaks; the OpenAI-compatible listing is assumed when absent. */
  readonly api?: string
  /** Static headers configured on the route; they may authenticate or route the listing request. */
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * The URL one protocol lists its models at.
 *
 * The base is treated as a prefix rather than a URL to resolve against, so a
 * deployment path such as `https://gateway.example/openai/v1` keeps its
 * segments. Anthropic publishes both `{root}/v1` and `{root}` spellings of its
 * base, so one trailing `/v1` is folded into the listing path. Only the
 * listing URL normalizes that segment; model requests receive the configured
 * `baseURL` unchanged.
 * @param baseURL - the route's endpoint.
 * @param interfaceType - protocol the endpoint speaks.
 * @returns the listing URL.
 */
function listingUrl(baseURL: string, interfaceType: string): string {
  const base = baseURL.replace(/\/+$/u, '')
  if (interfaceType !== 'anthropic-messages') return `${base}/models`
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`
}

/**
 * Headers for one listing request: the route's own configured headers first,
 * then the protocol's credential spelling, then the harness attribution. A
 * configured header can authenticate or route the request when the profile
 * names no key; attribution is written last so a configured map cannot drop it.
 * @param interfaceType - protocol the endpoint speaks.
 * @param apiKey - resolved credential, when one exists.
 * @param configured - static headers configured on the route.
 * @returns the request headers.
 */
function listingHeaders(
  interfaceType: string,
  apiKey: string | undefined,
  configured: Readonly<Record<string, string>> | undefined,
): Headers {
  const headers = new Headers(configured === undefined ? undefined : Object.entries(configured))
  headers.set('accept', 'application/json')
  if (interfaceType === 'anthropic-messages') {
    headers.set('anthropic-version', ANTHROPIC_VERSION)
    if (apiKey !== undefined && apiKey.length > 0) headers.set('x-api-key', apiKey)
  } else if (apiKey !== undefined && apiKey.length > 0) {
    headers.set('authorization', `Bearer ${apiKey}`)
  }
  for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
  return headers
}

/** The refusal for a listing body that outgrows the ceiling. */
function oversizedBody(url: string): LlmError {
  return new LlmError(
    `llm-service-lite: ${url} answered with more than ${String(DISCOVERY_MAX_RESPONSE_BYTES)} bytes`,
    'DISCOVERY_FAILED',
  )
}

/**
 * Read one listing body under the byte ceiling.
 *
 * The caller-supplied endpoint decides how much it sends, so the bound holds on
 * the bytes actually read rather than on the length the server claims: a
 * declared length is checked first (an honest server is turned away without
 * transferring anything), then the running total enforces the same ceiling for
 * a server that under-declares or streams.
 * @param response - the listing response.
 * @param url - the listing URL, for diagnostics.
 * @returns the decoded body.
 * @throws LlmError `DISCOVERY_FAILED` when the body exceeds the ceiling.
 */
async function readListingBody(response: Response, url: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > DISCOVERY_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw oversizedBody(url)
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > DISCOVERY_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw oversizedBody(url)
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

/**
 * Interrogate an endpoint for the models it serves.
 *
 * Both published OpenAI-compatible listing shapes are accepted: the standard
 * `data` array and the enriched `models` map some gateways return. An
 * Anthropic Messages endpoint is read through its native listing shape, which
 * is a `data` array with a `display_name` field. Every field except the id is
 * optional, because a gateway that lists only ids is answering the question.
 *
 * @param baseURL - the route's endpoint.
 * @param apiKey - resolved credential, when the route authenticates.
 * @param signal - caller cancellation, fused with the interrogation timeout.
 * @param options - protocol and configured headers the route states.
 * @returns discovered models, in the order the endpoint listed them.
 * @throws LlmError `INVALID_CONFIG` for a protocol no listing can be read for,
 *   `ABORTED` when the caller cancels, `INVALID_REQUEST` when the endpoint
 *   answers with an error status, and `DISCOVERY_FAILED` when it cannot be
 *   reached or answers with an unreadable or oversized body.
 */
export async function discoverEndpointModels(
  baseURL: string,
  apiKey?: string | undefined,
  signal?: AbortSignal,
  options: DiscoverEndpointModelsOptions = {},
): Promise<LlmDiscoveredModel[]> {
  const interfaceType = options.api ?? 'openai-chat-completions'
  if (!(LISTABLE_INTERFACE_TYPES as readonly string[]).includes(interfaceType)) {
    throw new LlmError(
      `llm-service-lite: model discovery cannot read a "${interfaceType}" listing;`
      + ` it reads ${LISTABLE_INTERFACE_TYPES.join(', ')} — enter this provider's models by hand`,
      'INVALID_CONFIG',
    )
  }
  const url = listingUrl(baseURL, interfaceType)
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const fused = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: listingHeaders(interfaceType, apiKey, options.headers),
      signal: fused,
      redirect: 'error',
    })
  } catch (error: unknown) {
    if (signal?.aborted === true) {
      throw new LlmError('llm-service-lite: model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`llm-service-lite: could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    let text = ''
    try {
      text = await readListingBody(response, url)
    } catch (error: unknown) {
      // The status is the diagnostic that matters, but a caller that cancelled
      // mid-body is not a refusal to report as the endpoint's.
      if (signal?.aborted === true) {
        throw new LlmError('llm-service-lite: model discovery aborted by caller', 'ABORTED', { cause: error })
      }
    }
    throw new LlmError(
      `llm-service-lite: model listing failed (${String(response.status)}): ${text.slice(0, 500)}`,
      'INVALID_REQUEST',
      { status: response.status },
    )
  }
  let text: string
  try {
    text = await readListingBody(response, url)
  } catch (error: unknown) {
    // Cancelling after the headers arrived surfaces inside the body read, not
    // in `fetch`, so the caller-abort contract is checked here too.
    if (signal?.aborted === true) {
      throw new LlmError('llm-service-lite: model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    if (error instanceof LlmError) throw error
    throw new LlmError(`llm-service-lite: could not read the model listing from ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`llm-service-lite: ${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return parseListing(raw)
}

/** One entry of a supported listing, with the key it was filed under. */
type ListingEntry = readonly [key: string | undefined, value: unknown]

/** Every entry of either supported listing shape, in endpoint order. */
function listingEntries(raw: unknown): ListingEntry[] {
  const envelope = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  if (Array.isArray(envelope.data)) return envelope.data.map(value => [undefined, value] as const)
  if (typeof envelope.models === 'object' && envelope.models !== null && !Array.isArray(envelope.models)) {
    return Object.entries(envelope.models as Record<string, unknown>)
  }
  return []
}

/** The first non-empty string among the candidates. */
function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/** The first candidate that is a positive safe integer. */
function firstPositiveInteger(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/**
 * Read either listing shape into discovered models, dropping unusable entries
 * and repeated ids while preserving endpoint order.
 * @param raw - the decoded listing.
 * @returns the discovered models.
 */
function parseListing(raw: unknown): LlmDiscoveredModel[] {
  const models: LlmDiscoveredModel[] = []
  const seen = new Set<string>()
  for (const [key, value] of listingEntries(raw)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    // A `models`-map key is the model id when the entry names none; a `data`
    // array's index is not an id, so an entry that names none is dropped.
    const id = firstString(entry.id, entry.model) ?? (key === '' ? undefined : key)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const name = firstString(entry.name, entry.display_name, entry.displayName)
    const contextWindow = firstPositiveInteger(
      entry.context_length,
      entry.context_window,
      entry.contextWindow,
      entry.max_input_tokens,
    )
    const maxTokens = firstPositiveInteger(
      entry.max_tokens,
      entry.max_output_tokens,
      entry.maxTokens,
      entry.maxOutputTokens,
    )
    models.push({
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}
