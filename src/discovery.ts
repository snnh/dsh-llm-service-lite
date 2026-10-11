/**
 * Endpoint interrogation for configuration surfaces.
 *
 * Asking a provider what it serves is a configuration-time action over a
 * draft, so the answer is advisory: nothing is stored and nothing is
 * registered — the profile a user saves decides what a route serves.
 *
 * @module dsh-llm-service-lite/discovery
 */

import { LlmError, type LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'

/** How long an endpoint interrogation may take before it is abandoned. */
const DISCOVERY_TIMEOUT_MS = 10_000

/**
 * Interrogate an OpenAI-compatible endpoint for the models it serves.
 *
 * Both published listing shapes are accepted: the standard `data` array and
 * the enriched `models` map some gateways return. Every field except the id is
 * optional, because a gateway that lists only ids is answering the question.
 *
 * @param baseURL - the route's endpoint.
 * @param apiKey - resolved credential, when the route authenticates.
 * @param signal - caller cancellation, fused with the interrogation timeout.
 * @returns discovered models, in the order the endpoint listed them.
 * @throws LlmError when the endpoint cannot be reached or answers with an error.
 */
export async function discoverEndpointModels(
  baseURL: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<LlmDiscoveredModel[]> {
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const fused = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(`${baseURL.replace(/\/+$/u, '')}/models`, {
    method: 'GET',
    headers: {
      ...attributionHeaders(),
      accept: 'application/json',
      ...apiKey === undefined || apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` },
    },
    signal: fused,
    redirect: 'error',
  })
  if (!response.ok) {
    const text = await response.text()
    throw new LlmError(
      `llm-service-lite: model listing failed (${response.status}): ${text.slice(0, 500)}`,
      'INVALID_REQUEST',
      { status: response.status },
    )
  }
  const raw: unknown = await response.json()
  return parseListing(raw)
}

/** Read either listing shape into discovered models, dropping unusable entries. */
function parseListing(raw: unknown): LlmDiscoveredModel[] {
  const envelope = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const entries: Array<[string, unknown]> = Array.isArray(envelope.data)
    ? envelope.data.map((entry, index) => [String(index), entry])
    : typeof envelope.models === 'object' && envelope.models !== null && !Array.isArray(envelope.models)
      ? Object.entries(envelope.models as Record<string, unknown>)
      : []
  const models: LlmDiscoveredModel[] = []
  const seen = new Set<string>()
  for (const [key, entry] of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' && record.id.length > 0
      ? record.id
      : typeof record.model === 'string' && record.model.length > 0 ? record.model : key
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const name = typeof record.name === 'string' && record.name.length > 0
      ? record.name
      : typeof record.display_name === 'string' && record.display_name.length > 0 ? record.display_name : undefined
    const contextWindow = firstPositiveInteger(record.context_length, record.context_window, record.max_input_tokens)
    const maxTokens = firstPositiveInteger(record.max_tokens, record.max_output_tokens)
    models.push({
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

/** The first candidate that is a positive integer. */
function firstPositiveInteger(...candidates: unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}
