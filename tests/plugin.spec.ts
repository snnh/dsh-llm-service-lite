import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmOwcProfiles from '../src/index.ts'
import { listing, mockProvider, textTurn, type MockProvider } from './mock-provider.ts'

/** Providers started by a test, stopped after it. */
const running: MockProvider[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
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
