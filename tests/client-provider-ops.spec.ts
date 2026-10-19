/**
 * The per-provider settings writes shared by the row page and the Models page
 * card seat: a new route is written whole, an inherited field stays inherited,
 * a touched field is stored as a minimal override, and only a user-layer-only
 * route can be removed.
 */
import { describe, expect, it } from 'vitest'
import {
  providerOps,
  providerRemovable,
  removeProviderOps,
} from '../src/client/provider-ops.ts'
import type { ClientProvider } from '../src/client/types.ts'

/** One profile with a baseline protocol so drafts differ only where a test says so. */
function profile(overrides: ClientProvider = {}): ClientProvider {
  return { interfaceType: 'openai-chat-completions', ...overrides }
}

describe('providerOps', () => {
  it('writes a newly declared route whole, cleaning the empty placeholders a form leaves', () => {
    const next = providerOps('alpha', undefined, undefined, undefined, profile({
      displayName: '',
      baseURL: '',
      models: [],
    }))
    expect(next).toEqual([{
      op: 'set',
      path: ['providers', 'alpha'],
      value: { interfaceType: 'openai-chat-completions' },
    }])
  })

  it('stores an edit of a composition-layer field in the user layer only', () => {
    const base = profile({ baseURL: 'https://base.example.com/v1' })
    const ops = providerOps('alpha', base, { alpha: base }.alpha, undefined, profile({
      baseURL: 'https://draft.example.com/v1',
    }))
    expect(ops).toEqual([{
      op: 'set',
      path: ['providers', 'alpha', 'baseURL'],
      value: 'https://draft.example.com/v1',
    }])
  })

  it('puts a field back to the composition value by unsetting the redundant override', () => {
    const base = profile({ baseURL: 'https://base.example.com/v1' })
    const user = profile({ baseURL: 'https://user.example.com/v1' })
    const resolved = profile({ baseURL: 'https://base.example.com/v1' })
    const ops = providerOps('alpha', resolved, base, user, resolved)
    expect(ops).toEqual([{ op: 'unset', path: ['providers', 'alpha', 'baseURL'] }])
  })

  it('leaves an untouched user-layer override alone', () => {
    const user = profile({ maxConcurrent: 1 })
    const resolved = profile({ maxConcurrent: 1, streamIdleTimeoutMs: 300_000 })
    expect(providerOps('alpha', resolved, undefined, user, resolved)).toEqual([])
  })

  it('does not freeze a schema default that no layer stored', () => {
    const resolved = profile({
      enabled: true,
      promptCaching: false,
      includeUsage: false,
      maxConcurrent: 3,
      streamIdleTimeoutMs: 300_000,
      defaultContextWindow: 256_000,
      defaultMaxTokens: 65_536,
    })
    expect(providerOps('alpha', resolved, undefined, undefined, resolved)).toEqual([])
  })

  it('needs no operation when a field the card cleared is only inherited', () => {
    const base = profile({ includeUsage: true })
    const resolved = profile({ includeUsage: true })
    const ops = providerOps('alpha', resolved, base, undefined, profile({}))
    expect(ops).toEqual([])
  })

  it('unsets a user override the card cleared', () => {
    const user = profile({ includeUsage: true })
    const resolved = profile({ includeUsage: true })
    const ops = providerOps('alpha', resolved, undefined, user, profile({}))
    expect(ops).toEqual([{ op: 'unset', path: ['providers', 'alpha', 'includeUsage'] }])
  })

  it('cleans an emptied model list into an unset instead of storing an empty array', () => {
    const user = profile({ models: [{ id: 'kept-model' }] })
    const resolved = profile({ models: [{ id: 'kept-model' }] })
    const ops = providerOps('alpha', resolved, undefined, user, profile({ models: [] }))
    expect(ops).toEqual([{ op: 'unset', path: ['providers', 'alpha', 'models'] }])
  })

  it('names no field the card cannot see, so hand-written advanced fields stay stored', () => {
    const user = profile({
      headers: { 'x-tenant': 'one' },
      extraBody: { verbosity: 'low' },
      retryPolicy: { attempts: 4 },
    })
    const resolved = profile({
      headers: { 'x-tenant': 'one' },
      extraBody: { verbosity: 'low' },
      retryPolicy: { attempts: 4 },
      displayName: 'Gateway',
    })
    // Only the display name changed; the advanced fields never appear in an op.
    expect(providerOps('alpha', resolved, undefined, user, resolved)).toEqual([
      { op: 'set', path: ['providers', 'alpha', 'displayName'], value: 'Gateway' },
    ])
  })

  it('stores a field equal to the schema default when it overrides an inherited different value', () => {
    const base = profile({ maxConcurrent: 1 })
    const resolved = profile({ maxConcurrent: 1 })
    const ops = providerOps('alpha', resolved, base, undefined, profile({ maxConcurrent: 3 }))
    expect(ops).toEqual([{ op: 'set', path: ['providers', 'alpha', 'maxConcurrent'], value: 3 }])
  })
})

describe('providerRemovable', () => {
  it('removes a route whose only declaration is the user layer', () => {
    expect(providerRemovable('alpha', undefined, { providers: { alpha: profile() } })).toBe(true)
  })

  it('keeps a route the composition layer declares', () => {
    expect(providerRemovable('alpha', { alpha: profile() }, { alpha: profile() })).toBe(false)
  })

  it('keeps a route no layer declares', () => {
    expect(providerRemovable('alpha', undefined, undefined)).toBe(false)
  })
})

describe('removeProviderOps', () => {
  it('unsets the whole profile of a user-layer-only route', () => {
    expect(removeProviderOps('alpha', undefined, { providers: { alpha: profile() } })).toEqual([
      { op: 'unset', path: ['providers', 'alpha'] },
    ])
  })

  it('refuses to remove a composition-declared route', () => {
    expect(removeProviderOps('alpha', { alpha: profile() }, undefined)).toEqual([])
  })
})
