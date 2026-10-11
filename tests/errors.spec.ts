import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { classifyFailure, classifyTransport, errorDetail, errorMessage } from '../src/errors.ts'

/** Response headers carrying the provider's retry and identity hints. */
const headers = (values: Record<string, string>): Headers => new Headers(values)

describe('provider failure classification', () => {
  it('reads the provider detail and message from either envelope shape', () => {
    expect(errorDetail({ error: { code: 'invalid_api_key', message: 'nope' } })).toBe('invalid_api_key nope')
    expect(errorDetail({ type: 'rate_limit_error', message: 'slow down' })).toBe('rate_limit_error slow down')
    expect(errorDetail('plain text')).toBe('')
    expect(errorMessage({ error: { message: 'nope' } }, 401)).toBe('nope')
    expect(errorMessage({ message: 'top level' }, 500)).toBe('top level')
    expect(errorMessage({}, 503)).toMatch(/failed \(503\)/)
    expect(errorMessage({}, undefined)).toMatch(/stream error/)
  })

  it('classifies the statuses OWC separates and keeps the provider facts', () => {
    const retryAfter = classifyFailure({ error: { message: 'later' } }, 429, headers({
      'retry-after': '2',
      'x-request-id': 'req-1',
    }))
    expect(retryAfter).toMatchObject({ code: 'RATE_LIMIT', failure: { status: 429, providerRetryAfterMs: 2000, requestId: 'req-1' } })

    expect(classifyFailure({}, 401).code).toBe('AUTH')
    expect(classifyFailure({}, 403).code).toBe('AUTH')
    expect(classifyFailure({ error: { message: 'insufficient balance' } }, 400).code).toBe('QUOTA')
    expect(classifyFailure({}, 402).code).toBe('QUOTA')
    expect(classifyFailure({ error: { message: 'prompt is too long for this model' } }, 400).code)
      .toBe('CONTEXT_WINDOW_EXCEEDED')
    expect(classifyFailure({}, 408).code).toBe('TRANSPORT')
    expect(classifyFailure({}, 502).code).toBe('TRANSPORT')
    expect(classifyFailure({}, 529).code).toBe('SERVER')
    expect(classifyFailure({}, 500).code).toBe('SERVER')
    expect(classifyFailure({}, 404).code).toBe('INVALID_REQUEST')
    expect(classifyFailure({}, 422).code).toBe('INVALID_REQUEST')
    expect(classifyFailure({}, 418).code).toBe('HTTP_418')
    expect(classifyFailure({}, undefined).code).toBe('SERVER')
  })

  it('accepts a retry delay only when it lies in the future', () => {
    expect(classifyFailure({}, 429, headers({ 'retry-after': '0' })).failure.providerRetryAfterMs).toBeUndefined()
    expect(classifyFailure({}, 429, headers({ 'retry-after': 'nonsense' })).failure.providerRetryAfterMs).toBeUndefined()
    const dated = new Date(Date.now() + 60_000).toUTCString()
    expect(classifyFailure({}, 429, headers({ 'retry-after': dated })).failure.providerRetryAfterMs).toBeGreaterThan(0)
    expect(classifyFailure({}, 429, headers({}))).toMatchObject({ code: 'RATE_LIMIT' })
  })

  it('passes an already-classified failure through and separates cancellation', () => {
    const failure = new LlmError('provider said no', 'INVALID_REQUEST')
    expect(classifyTransport(failure, false)).toBe(failure)
    expect(classifyTransport(new Error('boom'), true)).toMatchObject({ code: 'ABORTED' })
  })

  it('treats network shapes as retryable and everything else as unknown', () => {
    expect(classifyTransport(Object.assign(new Error('socket'), { code: 'ECONNRESET' }), false).code).toBe('TRANSPORT')
    expect(classifyTransport(new TypeError('fetch failed'), false).code).toBe('TRANSPORT')
    expect(classifyTransport(new RangeError('bad'), false).code).toBe('UNKNOWN')
    expect(classifyTransport('thrown string', false).code).toBe('UNKNOWN')
  })
})
