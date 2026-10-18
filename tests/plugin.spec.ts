import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmOwcProfiles from '../src/index.ts'
import { registrationFacts, resolveProfiles } from '../src/profiles.ts'
import { listing, mockProvider, textTurn, type MockProvider } from './mock-provider.ts'

/** Providers started by a test, stopped after it. */
const running: MockProvider[] = []
/** Extra raw servers (holding providers) closed after every test, even a failing one. */
const extraServers: Array<{ close: () => Promise<void> }> = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(extraServers.splice(0).map(server => server.close().catch(() => {})))
  await Promise.all(running.splice(0).map(entry => entry.close()))
  vi.unstubAllEnvs()
})

/** Boot the plugin over the real LLM service. */
async function harness(providers: Record<string, LlmOwcProfiles.OwcProviderProfile> = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmOwcProfiles, { providers })
  return ctx
}

/** An adapter for the routes a simulated sibling plugin owns; these tests never stream through it. */
class ForeignAdapter extends LlmAdapter {
  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* (): AsyncGenerator<StreamChunk> {})()
  }
}

/** A sibling adapter plugin that declares configurable providers and live routes, as `llm-pi-ai` does on a stock profile. */
function foreignAdapterPlugin(routes: readonly string[], settingsNs = 'llm-pi-ai') {
  return {
    name: 'foreign-adapter',
    inject: ['llm'],
    apply(ctx: Context): void {
      ctx.llm.registerConfigurableProviders(routes.map(provider => ({
        provider,
        displayName: provider,
        settingsNs,
        settingsPath: ['providers', provider],
        declared: false,
      })))
      ctx.llm.registerAdapter([...routes], new ForeignAdapter())
    },
  }
}

/** Commit a next providers dict through the plugin fiber's volatile reference, as a loader profile edit does. */
function setProviders(mounted: Fiber, providers: Record<string, LlmOwcProfiles.OwcProviderProfile>): void {
  const reference = (mounted.config as { providers: object }).providers
  const [write] = Object.getOwnPropertySymbols(reference)
  const commit = write === undefined
    ? undefined
    : (reference as unknown as Record<symbol, ((value: unknown) => void) | undefined>)[write]
  if (commit === undefined) throw new Error('the resolved config carries no volatile providers reference')
  commit(structuredClone(providers))
  mounted.ctx.emit('loader/volatile-update', [['providers']])
}

/** Answer the holding provider's open requests, in arrival order. */
function releaseHeld(held: ServerResponse[]): void {
  for (const response of held.splice(0)) textTurn(response, 'held')
}

/** A chat-completions provider that holds every request open, so admission concurrency is observable. */
async function holdingProvider(): Promise<{ url: string; held: ServerResponse[]; close: () => Promise<void> }> {
  const held: ServerResponse[] = []
  const server = createServer((incoming, outgoing) => {
    incoming.on('data', () => {})
    incoming.on('end', () => { held.push(outgoing) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the holding provider did not bind a port')
  const entry = {
    url: `http://127.0.0.1:${address.port}/v1`,
    held,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    }),
  }
  extraServers.push(entry)
  return entry
}

describe('owc profiles plugin', () => {
  it('mounts dormant and registers nothing until a profile appears', async () => {
    const ctx = await harness()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('registers one route per enabled profile and serves its catalog', async () => {
    const ctx = await harness({
      gateway: {
        displayName: 'Acme Gateway',
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://gateway.test/v1',
        apiKeyEnv: 'OWC_TEST_KEY',
        enabled: false,
        models: [{ id: 'acme-one', contextWindow: 4096 }],
      },
    })
    // A disabled profile stays addressable without serving.
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toMatchObject([
      { provider: 'gateway', displayName: 'Acme Gateway', declared: true, settingsPath: ['providers', 'gateway'] },
    ])
  })

  it('reports what an official catalog conversion could not carry', async () => {
    const ctx = await harness({
      gateway: {
        catalog: {
          'openai-completions': {
            'chat:m': { id: 'm', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
          },
        },
      },
    })
    // The route serves from the converted facts; the loss is reported rather
    // than hidden, and the profile behind it stays addressable.
    expect(ctx.llm.listProviders()).toEqual([{ id: 'gateway', name: 'gateway' }])
    expect(await ctx.llm.listModels('gateway')).toEqual([
      { provider: 'gateway', id: 'm', name: 'm', inputModalities: ['text'] },
    ])
    expect(ctx.llm.listConfigurableProviders()).toMatchObject([
      { provider: 'gateway', declared: true, settingsPath: ['providers', 'gateway'] },
    ])
  })

  it('serves a configured route end to end through the credential seam', async () => {
    vi.stubEnv('OWC_TEST_KEY', 'key-from-environment')
    const upstream = await mockProvider((response) => { textTurn(response, 'from-gateway') })
    running.push(upstream)
    const ctx = await harness({
      gateway: {
        interfaceType: 'openai-chat-completions',
        baseURL: upstream.url,
        apiKeyEnv: 'OWC_TEST_KEY',
        models: [{ id: 'm' }],
      },
    })
    expect(ctx.llm.listProviders()).toMatchObject([{ id: 'gateway', name: 'gateway' }])
    expect(await ctx.llm.listModels('gateway')).toEqual([
      { provider: 'gateway', id: 'm', name: 'm', inputModalities: ['text'] },
    ])
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'gateway',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      chunks.push(chunk)
    }
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'from-gateway' })
    expect(upstream.bodies).toHaveLength(1)
    expect(upstream.bodies[0]?.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('fails a request whose named credential resolves to nothing', async () => {
    const upstream = await mockProvider((response) => { textTurn(response) })
    running.push(upstream)
    const ctx = await harness({
      gateway: {
        interfaceType: 'openai-chat-completions',
        baseURL: upstream.url,
        apiKeyEnv: 'OWC_ABSENT_KEY',
        models: [{ id: 'm' }],
      },
    })
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'gateway',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      chunks.push(chunk)
    }
    // The runtime normalizes a thrown adapter failure into a terminal finish.
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } },
    })
    expect(upstream.bodies).toEqual([])
  })

  it('answers model discovery for a configured route from its endpoint', async () => {
    const upstream = await mockProvider((response, body) => {
      if (body.model === undefined) {
        listing(response, [{ id: 'listed', name: 'Listed', context_length: 8192 }])
        return
      }
      textTurn(response)
    })
    running.push(upstream)
    const ctx = await harness({
      gateway: { interfaceType: 'openai-chat-completions', baseURL: upstream.url, models: [] },
    })
    const settingsNs = ctx.llm.listConfigurableProviders()[0]?.settingsNs
    expect(settingsNs).toBeDefined()
    expect(await ctx.llm.discoverModels(settingsNs as string, { provider: 'gateway' })).toEqual([
      { id: 'listed', name: 'Listed', contextWindow: 8192 },
    ])
  })

  it('refuses discovery for an unknown route and reports an endpoint failure', async () => {
    const upstream = await mockProvider((response) => {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end('boom')
    })
    running.push(upstream)
    const ctx = await harness({
      gateway: { interfaceType: 'openai-chat-completions', baseURL: upstream.url, models: [] },
    })
    const settingsNs = (ctx.llm.listConfigurableProviders()[0]?.settingsNs ?? '')
    // A draft naming a route this plugin does not configure has no endpoint.
    await expect(ctx.llm.discoverModels(settingsNs, { provider: 'elsewhere' }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    await expect(ctx.llm.discoverModels(settingsNs, { provider: 'gateway' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('keeps a route whose profile cannot be served editable with its diagnostic', async () => {
    const ctx = await harness({
      broken: { interfaceType: 'openai-chat-completions', baseURL: 'not a url', models: [{ id: 'm' }] },
    })
    expect(ctx.llm.listProviders()).toEqual([])
    const entry = ctx.llm.listConfigurableProviders()[0]
    expect(entry?.provider).toBe('broken')
    expect(entry?.error).toMatch(/not a URL/)
  })

  it('registers several routes and their declared retry policies together', async () => {
    const upstream = await mockProvider((response) => { textTurn(response) })
    running.push(upstream)
    const ctx = await harness({
      alpha: { interfaceType: 'openai-chat-completions', baseURL: upstream.url, models: [{ id: 'a' }] },
      beta: { interfaceType: 'openai-chat-completions', baseURL: upstream.url, models: [{ id: 'b' }] },
    })
    expect(ctx.llm.listProviders().map(entry => entry.id).sort()).toEqual(['alpha', 'beta'])
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider).sort()).toEqual(['alpha', 'beta'])
  })

})

describe('foreign route-name ownership', () => {
  it('skips only the profiles another mounted adapter already owns', async () => {
    const upstream = await mockProvider((response) => { textTurn(response, 'from-gateway') })
    running.push(upstream)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await ctx.plugin(foreignAdapterPlugin(['deepseek']))
    await ctx.plugin(LlmOwcProfiles, {
      providers: {
        // The stock `llm-pi-ai` catalog declares this name, so this profile is skipped.
        deepseek: { interfaceType: 'openai-chat-completions', baseURL: 'https://api.deepseek.example/v1' },
        gateway: { interfaceType: 'openai-chat-completions', baseURL: upstream.url, models: [{ id: 'm' }] },
      },
    })
    // The foreign route still serves; our non-conflicting route mounted.
    expect(ctx.llm.listProviders().map(entry => entry.id).sort()).toEqual(['deepseek', 'gateway'])
    // The conflicting name stays foreign in the directory; ours is addressable.
    const directory = ctx.llm.listConfigurableProviders()
    expect(directory.filter(entry => entry.provider === 'deepseek').map(entry => entry.settingsNs)).toEqual(['llm-pi-ai'])
    expect(directory.some(entry => entry.provider === 'gateway')).toBe(true)
    // One actionable warning names the route and its foreign owner.
    expect(warn.mock.calls.some((call: unknown[]) => String(call[0]).includes(
      'provider route "deepseek" is already declared by the "llm-pi-ai" configuration namespace',
    ))).toBe(true)
    // The profiles that did mount serve end to end.
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'gateway',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'from-gateway' })
  })

  it('mounts a skipped profile once its foreign owner releases the name', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const foreign = await ctx.plugin(foreignAdapterPlugin(['deepseek']))
    await ctx.plugin(LlmOwcProfiles, {
      providers: {
        deepseek: { interfaceType: 'openai-chat-completions', baseURL: 'https://api.deepseek.example/v1' },
        gateway: { interfaceType: 'openai-chat-completions', baseURL: 'https://gateway.test/v1' },
      },
    })
    expect(ctx.llm.listProviders().map(entry => entry.id).sort()).toEqual(['deepseek', 'gateway'])
    const ours = ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'gateway')?.settingsNs
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'deepseek')?.settingsNs).toBe('llm-pi-ai')
    // A sibling dropping the name is a topology change, and the skipped profile mounts without a new mount call.
    await foreign.dispose()
    expect(ctx.llm.listConfigurableProviders().filter(entry => entry.provider === 'deepseek').map(entry => entry.settingsNs))
      .toEqual([ours])
    expect(ctx.llm.listProviders().map(entry => entry.id).sort()).toEqual(['deepseek', 'gateway'])
  })

  it('refuses a write that claims a foreign route name while allowing a rename', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await ctx.plugin(foreignAdapterPlugin(['deepseek']))
    const mounted = await ctx.plugin(LlmOwcProfiles, {
      providers: { gateway: { interfaceType: 'openai-chat-completions', baseURL: 'https://gateway.test/v1' } },
    })
    const write = (providers: Record<string, unknown>): unknown => {
      const candidate = { providers }
      return mounted.ctx.waterfall(mounted, 'internal/config', candidate, () => candidate)
    }
    expect(() => write({
      gateway: { interfaceType: 'openai-chat-completions', baseURL: 'https://gateway.test/v1' },
      deepseek: { interfaceType: 'openai-chat-completions', baseURL: 'https://api.deepseek.example/v1' },
    })).toThrow(/provider route "deepseek" is already declared by the "llm-pi-ai" configuration namespace/)
    expect(() => write({
      gateway: { interfaceType: 'openai-chat-completions', baseURL: 'https://gateway.test/v1' },
      'deepseek-direct': { interfaceType: 'openai-chat-completions', baseURL: 'https://api.deepseek.example/v1' },
    })).not.toThrow()
  })
})

describe('concurrency edits', () => {
  it('keeps a maxConcurrent edit out of the registration facts', () => {
    const one = resolveProfiles({ gateway: { interfaceType: 'openai-chat-completions', maxConcurrent: 1 } })
    const two = resolveProfiles({ gateway: { interfaceType: 'openai-chat-completions', maxConcurrent: 2 } })
    expect(registrationFacts(one)).toEqual(registrationFacts(two))
    // A registry-captured fact still re-registers: the label is captured with the route.
    const renamed = resolveProfiles({ gateway: { interfaceType: 'openai-chat-completions', displayName: 'Renamed' } })
    expect(registrationFacts(renamed)).not.toEqual(registrationFacts(one))
  })

  it('retunes admission without replacing the adapter', async () => {
    const upstream = await holdingProvider()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    let replaces = 0
    const register = ctx.llm.registerAdapter.bind(ctx.llm)
    vi.spyOn(ctx.llm, 'registerAdapter').mockImplementation((providers: string[], adapter: LlmAdapter) => {
      const handle = register(providers, adapter)
      const replace = handle.replace.bind(handle)
      handle.replace = (next) => { replaces += 1; replace(next) }
      return handle
    })
    const mounted = await ctx.plugin(LlmOwcProfiles, {
      providers: {
        gateway: {
          interfaceType: 'openai-chat-completions',
          baseURL: upstream.url,
          maxConcurrent: 1,
          models: [{ id: 'm' }],
        },
      },
    })
    const consume = async (): Promise<void> => {
      for await (const _chunk of ctx.llm.stream({
        provider: 'gateway',
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })) { /* drain */ }
    }
    // The first request is admitted; the second waits behind the ceiling of one.
    const first = consume()
    await vi.waitFor(() => { expect(upstream.held).toHaveLength(1) })
    const second = consume()
    await new Promise((resolve) => { setTimeout(resolve, 25) })
    expect(upstream.held).toHaveLength(1)
    // A concurrency edit re-tunes the one limiter; the adapter registration does not move.
    setProviders(mounted, {
      gateway: {
        interfaceType: 'openai-chat-completions',
        baseURL: upstream.url,
        maxConcurrent: 2,
        models: [{ id: 'm' }],
      },
    })
    expect(replaces).toBe(0)
    releaseHeld(upstream.held)
    await first
    await vi.waitFor(() => { expect(upstream.held).toHaveLength(1) })
    releaseHeld(upstream.held)
    await second
    // With the raised ceiling the next two requests run at the same time.
    const third = consume()
    const fourth = consume()
    await vi.waitFor(() => { expect(upstream.held).toHaveLength(2) })
    releaseHeld(upstream.held)
    await Promise.all([third, fourth])
    expect(replaces).toBe(0)
    // A captured fact is a different matter: renaming the route re-registers it.
    setProviders(mounted, {
      gateway: {
        displayName: 'Renamed',
        interfaceType: 'openai-chat-completions',
        baseURL: upstream.url,
        maxConcurrent: 2,
        models: [{ id: 'm' }],
      },
    })
    expect(replaces).toBe(1)
    await upstream.close()
  })

  it('does not replace routes for a provider reorder or a skipped profile edit', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    // A sibling family owns `deepseek`, exactly as the shipped pi-ai catalog
    // does on a stock upstream profile.
    await ctx.plugin(foreignAdapterPlugin(['deepseek']))
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    let replaces = 0
    const register = ctx.llm.registerAdapter.bind(ctx.llm)
    vi.spyOn(ctx.llm, 'registerAdapter').mockImplementation((providers: string[], adapter: LlmAdapter) => {
      const handle = register(providers, adapter)
      const replace = handle.replace.bind(handle)
      handle.replace = (next) => { replaces += 1; replace(next) }
      return handle
    })
    const profile = (baseURL: string): LlmOwcProfiles.OwcProviderProfile => ({
      interfaceType: 'openai-chat-completions',
      baseURL,
      models: [],
    })
    const alpha = profile('https://alpha.test/v1')
    const claimed = profile('https://deepseek.test/v1')
    const mounted = await ctx.plugin(LlmOwcProfiles, { providers: { alpha, deepseek: claimed } })
    const ours = (): string[] => ctx.llm
      .listConfigurableProviders()
      .filter(entry => entry.settingsNs === 'llm-service-lite')
      .map(entry => entry.provider)
      .sort()
    // Only the unclaimed route is declared by this instance; the claimed one is
    // skipped with a warning and stays the foreign family's entry.
    expect(ours()).toEqual(['alpha'])
    expect(replaces).toBe(0)
    // Reordering the provider dict is not a registry change.
    setProviders(mounted, { deepseek: claimed, alpha })
    expect(replaces).toBe(0)
    // Editing the skipped profile is not a mounted-route change either.
    setProviders(mounted, { alpha, deepseek: { ...claimed, displayName: 'Renamed while skipped' } })
    expect(replaces).toBe(0)
    // Renaming it out of the claimed name mounts it and replaces the route set once.
    setProviders(mounted, {
      alpha,
      'deepseek-direct': { ...claimed, displayName: 'Direct' },
    })
    expect(replaces).toBe(1)
    expect(ours()).toEqual(['alpha', 'deepseek-direct'])
  })
})
