/**
 * Provider-failure classification.
 *
 * OWC classifies a failure by HTTP status and provider error text before it
 * decides whether to retry; the harness classifies by a stable error code and
 * lets the agent's recovery layer decide. The translation keeps OWC's
 * judgement about which failures are worth repeating and adds the two
 * provider-neutral codes the harness can act on beyond retrying: an exhausted
 * quota is terminal rather than a rate limit, and an oversized request is what
 * triggers a forced compaction instead of a doomed retry.
 *
 * @module dsh-llm-service-lite/errors
 */

import {
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  ProviderRequestId,
} from '@deepseek-ai/dsh-llm'

/** Response headers a provider uses to name a request across support tickets. */
const REQUEST_ID_HEADERS = ['request-id', 'x-request-id', 'x-deepseek-request-id'] as const

/**
 * Joined provider error code, type, and message text used by the classifiers.
 * @param raw - the provider's error body or error object, as received.
 * @returns the distinct non-empty text parts, joined by one space.
 */
export function errorDetail(raw: unknown): string {
  const envelope = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const error = typeof envelope.error === 'object' && envelope.error !== null
    ? envelope.error as Record<string, unknown>
    : envelope
  const parts = [error.code, error.type, error.message, envelope.message]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  return [...new Set(parts)].join(' ')
}

/**
 * Human-readable message from a provider error body, with a status-based fallback.
 * @param raw - the provider's error body or error object, as received.
 * @param status - HTTP status when the failure carried one.
 * @returns the provider's own message, or a status-based diagnostic.
 */
export function errorMessage(raw: unknown, status: number | undefined): string {
  const envelope = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const error = typeof envelope.error === 'object' && envelope.error !== null
    ? envelope.error as Record<string, unknown>
    : envelope
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  if (typeof envelope.message === 'string' && envelope.message.length > 0) return envelope.message
  return `llm-service-lite: provider request failed (${status === undefined ? 'stream error' : status})`
}

/**
 * Provider-requested retry delay, in milliseconds.
 * `Retry-After` is either a delay in seconds or an HTTP date; both spellings
 * appear in the wild, and a date already in the past yields no delay.
 */
function retryAfterMs(headers: Headers | undefined): number | undefined {
  const value = headers?.get('retry-after')
  if (value === null || value === undefined) return undefined
  const delay = /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

/** Provider request id when the response names one. */
function requestIdOf(headers: Headers | undefined): string | undefined {
  for (const header of REQUEST_ID_HEADERS) {
    const value = headers?.get(header)
    if (value !== null && value !== undefined && value.length > 0) return value
  }
  return undefined
}

/** Structured provider facts every classified failure carries when the transport observed them. */
function providerFacts(
  status: number | undefined,
  headers: Headers | undefined,
): { status?: number; providerRetryAfterMs?: number; requestId?: ProviderRequestId } {
  const retryAfter = retryAfterMs(headers)
  const requestId = requestIdOf(headers)
  return {
    ...status === undefined ? {} : { status },
    ...retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter },
    ...requestId === undefined ? {} : { requestId: ProviderRequestId(requestId) },
  }
}

/**
 * Classify one provider failure into the harness's stable error vocabulary.
 *
 * @param raw - decoded error body, or an in-band error event.
 * @param status - HTTP status when the failure preceded streaming.
 * @param headers - response headers, for `Retry-After` and the request id.
 * @returns the classified failure, carrying any provider-requested delay.
 */
export function classifyFailure(raw: unknown, status: number | undefined, headers?: Headers): LlmError {
  const detail = errorDetail(raw)
  const message = errorMessage(raw, status)
  const facts = providerFacts(status, headers)
  if (status === 401 || status === 403) return new LlmError(message, 'AUTH', facts)
  if (isQuotaExceededError(detail) || status === 402) return new LlmError(message, 'QUOTA', facts)
  if (isContextWindowExceededError(detail)) return new LlmError(message, 'CONTEXT_WINDOW_EXCEEDED', facts)
  if (status === 408 || status === 502 || status === 504) return new LlmError(message, 'TRANSPORT', facts)
  if (status === 429) return new LlmError(message, 'RATE_LIMIT', facts)
  if (status === 529 || (status !== undefined && status >= 500)) return new LlmError(message, 'SERVER', facts)
  if (status === 404 || status === 400 || status === 409 || status === 413 || status === 422) {
    return new LlmError(message, 'INVALID_REQUEST', facts)
  }
  if (status !== undefined) return new LlmError(message, `HTTP_${status}`, facts)
  // An in-band error event carries no status, so the provider's own error type
  // is the only classification available — the same signal OWC reads.
  if (/rate[_-]?limit/iu.test(detail)) return new LlmError(message, 'RATE_LIMIT', facts)
  if (/authentication|permission|unauthor/iu.test(detail)) return new LlmError(message, 'AUTH', facts)
  if (/invalid[_-]?request/iu.test(detail)) return new LlmError(message, 'INVALID_REQUEST', facts)
  return new LlmError(message, 'SERVER', facts)
}

/**
 * Classify a transport-level throw that never produced an HTTP status: the
 * shapes OWC treats as retryable network failures, an upstream cancellation,
 * and everything else as a failure the recovery layer will not repeat.
 *
 * @param error - the thrown value.
 * @param aborted - the caller's own signal, to distinguish cancellation from failure.
 * @returns the classified failure.
 */
export function classifyTransport(error: unknown, aborted: boolean): LlmError {
  if (error instanceof LlmError) return error
  if (aborted) return new LlmError('llm-service-lite: request aborted', 'ABORTED', { cause: error })
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error).code)
    : ''
  const transient = error instanceof TypeError
    || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
  return transient
    ? new LlmError('llm-service-lite: provider transport failed', 'TRANSPORT', { cause: error })
    : new LlmError('llm-service-lite: provider request failed', 'UNKNOWN', { cause: error })
}
