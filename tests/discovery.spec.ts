/**
 * Endpoint interrogation: the listing shapes, the protocol-specific endpoint
 * and credentials, the bounded read, and the discovery handler's draft-over-
 * stored precedence.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmOwcProfiles from '../src/index.ts'
import { DISCOVERY_MAX_RESPONSE_BYTES, discoverEndpointModels } from '../src/discovery.ts'

/** One request an interrogation endpoint received. */
interface RecordedRequest {
  readonly method: string
  readonly path: string
  readonly headers: IncomingMessage['headers']
}

/** One local endpoint that records the listing requests it receives. */
interface Endpoint {
  readonly url: string
  readonly requests: RecordedRequest[]
  close: () => Promise<void>
}

/** Start one local endpoint answering through the handler. */
async function startEndpoint(handler: (response: ServerResponse, request: RecordedRequest) => void): Promise<Endpoint> {
  const requests: RecordedRequest[] = []
  const server = createServer((incoming, outgoing) => {
    const recorded: RecordedRequest = {
      method: incoming.method ?? '',
      path: incoming.url ?? '',
      headers: incoming.headers,
    }
    requests.push(recorded)
    incoming.on('data', () => {})
    incoming.on('end', () => { handler(outgoing, recorded) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the endpoint did not bind a port')
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    }),
  }
}

const running: Endpoint[] = []
const contexts: Context[] = []

/** Start one endpoint the test's cleanup owns. */
async function serving(handler: (response: ServerResponse, request: RecordedRequest) => void): Promise<Endpoint> {
  const endpoint = await startEndpoint(handler)
  running.push(endpoint)
  return endpoint
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(running.splice(0).map(endpoint => endpoint.close()))
  vi.unstubAllEnvs()
})

/** Answer one listing request with a JSON body. */
function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** Mount the plugin over the real LLM service with one provider profile. */
async function pluginWith(providers: Record<string, LlmOwcProfiles.OwcProviderProfile>): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmOwcProfiles, { providers })
  return ctx
}

/** The settings namespace the mounted plugin registered its discovery under. */
function namespaceOf(ctx: Context): string {
  const namespace = ctx.llm.listConfigurableProviders()[0]?.settingsNs
  if (namespace === undefined) throw new Error('the plugin declared no configurable provider')
  return namespace
}

describe('listing shapes', () => {
  it('reads the standard data-array listing in endpoint order', async () => {
    const upstream = await serving(response => json(response, {
      data: [
        { id: 'alpha', name: 'Alpha', context_length: 8192, max_tokens: 1024 },
        { id: 'beta', display_name: 'Beta', context_window: 4096, max_output_tokens: 512 },
      ],
    }))
    await expect(discoverEndpointModels(upstream.url)).resolves.toEqual([
      { id: 'alpha', name: 'Alpha', contextWindow: 8192, maxTokens: 1024 },
      { id: 'beta', name: 'Beta', contextWindow: 4096, maxTokens: 512 },
    ])
    expect(upstream.requests[0]).toMatchObject({ method: 'GET', path: '/models' })
  })

  it('reads the models-map listing, falling back to the key and dropping unusable entries', async () => {
    const upstream = await serving(response => json(response, {
      models: {
        alpha: { id: 'alpha' },
        beta: { model: 'beta', name: 'Beta' },
        gamma: {},
        broken: 'not-an-object',
        duplicate: { id: 'alpha' },
      },
    }))
    await expect(discoverEndpointModels(upstream.url)).resolves.toEqual([
      { id: 'alpha' },
      { id: 'beta', name: 'Beta' },
      { id: 'gamma' },
    ])
  })

  it('accepts every published capacity spelling and ignores unusable numbers', async () => {
    const upstream = await serving(response => json(response, {
      data: [
        { id: 'a', context_length: 1, max_tokens: 2 },
        { id: 'b', context_window: 3, max_output_tokens: 4 },
        { id: 'c', contextWindow: 5, maxTokens: 6 },
        { id: 'd', max_input_tokens: 7, maxOutputTokens: 8 },
        { id: 'e', context_length: 0, max_tokens: -1 },
        { id: 'f', context_length: 1.5, max_tokens: '9' },
        { id: 'g', max_input_tokens: Number.MAX_SAFE_INTEGER + 1, max_tokens: 10 },
      ],
    }))
    await expect(discoverEndpointModels(upstream.url)).resolves.toEqual([
      { id: 'a', contextWindow: 1, maxTokens: 2 },
      { id: 'b', contextWindow: 3, maxTokens: 4 },
      { id: 'c', contextWindow: 5, maxTokens: 6 },
      { id: 'd', contextWindow: 7, maxTokens: 8 },
      { id: 'e' },
      { id: 'f' },
      { id: 'g', maxTokens: 10 },
    ])
  })

  it('answers an empty listing with no models', async () => {
    const upstream = await serving(response => json(response, { data: [] }))
    await expect(discoverEndpointModels(upstream.url)).resolves.toEqual([])
  })
})

describe('protocol-specific requests', () => {
  it('sends bearer auth for the OpenAI-compatible protocols', async () => {
    const upstream = await serving(response => json(response, { data: [] }))
    await discoverEndpointModels(upstream.url, 'sk-test')
    await discoverEndpointModels(upstream.url, 'sk-responses', undefined, { api: 'openai-responses' })
    expect(upstream.requests.map(request => request.path)).toEqual(['/models', '/models'])
    expect(upstream.requests[0]?.headers.authorization).toBe('Bearer sk-test')
    expect(upstream.requests[1]?.headers.authorization).toBe('Bearer sk-responses')
  })

  it('interrogates the Anthropic native listing with its own endpoint and headers', async () => {
    const upstream = await serving(response => json(response, {
      data: [{ id: 'claude-x', display_name: 'Claude X' }],
    }))
    await expect(discoverEndpointModels(upstream.url, 'sk-ant', undefined, { api: 'anthropic-messages' }))
      .resolves.toEqual([{ id: 'claude-x', name: 'Claude X' }])
    // A base that already names /v1 folds into the same listing URL.
    await discoverEndpointModels(`${upstream.url}/v1`, 'sk-ant', undefined, { api: 'anthropic-messages' })
    expect(upstream.requests.map(request => request.path)).toEqual([
      '/v1/models?limit=1000',
      '/v1/models?limit=1000',
    ])
    expect(upstream.requests[0]?.headers['x-api-key']).toBe('sk-ant')
    expect(upstream.requests[0]?.headers['anthropic-version']).toBe('2023-06-01')
    expect(upstream.requests[0]?.headers.authorization).toBeUndefined()
  })

  it("carries the route's own headers and keeps harness attribution", async () => {
    const upstream = await serving(response => json(response, { data: [] }))
    await discoverEndpointModels(upstream.url, undefined, undefined, { headers: { 'x-tenant': 'acme' } })
    expect(upstream.requests[0]?.headers['x-tenant']).toBe('acme')
    expect(upstream.requests[0]?.headers['user-agent']).toMatch(/deepseek-harness\//u)
  })

  it('refuses a protocol whose listing this build cannot read', async () => {
    await expect(discoverEndpointModels('http://127.0.0.1:1', undefined, undefined, { api: 'gemini-generate-content' }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    await expect(discoverEndpointModels('http://127.0.0.1:1', undefined, undefined, { api: 'gemini-generate-content' }))
      .rejects.toThrow(/openai-chat-completions/u)
  })
})

describe('failure reporting', () => {
  it('reports a non-2xx answer with its status and body', async () => {
    const upstream = await serving((response) => {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end('boom')
    })
    await expect(discoverEndpointModels(upstream.url)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      failure: { status: 500 },
    })
    await expect(discoverEndpointModels(upstream.url)).rejects.toThrow(/model listing failed \(500\): boom/u)
  })

  it('reports a non-JSON answer as a discovery failure', async () => {
    const upstream = await serving((response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html>not a listing</html>')
    })
    await expect(discoverEndpointModels(upstream.url)).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    await expect(discoverEndpointModels(upstream.url)).rejects.toThrow(/did not answer with JSON/u)
  })

  it('refuses a body over the byte ceiling, declared or streamed', async () => {
    const declared = await serving((response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(DISCOVERY_MAX_RESPONSE_BYTES + 1),
      })
      response.end()
    })
    await expect(discoverEndpointModels(declared.url)).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    const streamed = await serving((response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write(Buffer.alloc(DISCOVERY_MAX_RESPONSE_BYTES + 1, 0x20))
      response.end()
    })
    await expect(discoverEndpointModels(streamed.url)).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })

  it('reports caller cancellation as aborted', async () => {
    const upstream = await serving(() => { /* never answers within this test */ })
    const controller = new AbortController()
    controller.abort()
    await expect(discoverEndpointModels(upstream.url, undefined, controller.signal))
      .rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('reports a cancellation that lands while the listing body is being read', async () => {
    // Headers arrive, then the body stays open: the abort surfaces inside the
    // bounded body read rather than in `fetch`, and must still be ABORTED.
    const upstream = await serving((response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"data":[')
    })
    const controller = new AbortController()
    const pending = discoverEndpointModels(upstream.url, undefined, controller.signal)
    await vi.waitFor(() => { expect(upstream.requests).toHaveLength(1) })
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })
})

describe('the plugin discovery handler', () => {
  it("interrogates the drafted endpoint, carrying the stored route's headers", async () => {
    const stored = await serving(response => json(response, { data: [{ id: 'stored' }] }))
    const draft = await serving(response => json(response, { data: [{ id: 'draft' }] }))
    const ctx = await pluginWith({
      gateway: {
        interfaceType: 'openai-chat-completions',
        baseURL: stored.url,
        headers: { 'x-tenant': 'acme' },
        models: [],
      },
    })
    await expect(ctx.llm.discoverModels(namespaceOf(ctx), { provider: 'gateway', baseURL: draft.url }))
      .resolves.toEqual([{ id: 'draft' }])
    expect(stored.requests).toHaveLength(0)
    expect(draft.requests[0]?.headers['x-tenant']).toBe('acme')
  })

  it('honours a drafted protocol over the stored one', async () => {
    const upstream = await serving(response => json(response, { data: [] }))
    const ctx = await pluginWith({
      gateway: { interfaceType: 'openai-chat-completions', baseURL: upstream.url, models: [] },
    })
    await ctx.llm.discoverModels(namespaceOf(ctx), { provider: 'gateway', api: 'anthropic-messages' })
    expect(upstream.requests[0]?.path).toBe('/v1/models?limit=1000')
    expect(upstream.requests[0]?.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('lets a one-shot key win over the stored credential and trims it', async () => {
    const upstream = await serving(response => json(response, { data: [{ id: 'm' }] }))
    const ctx = await pluginWith({
      gateway: {
        interfaceType: 'openai-chat-completions',
        baseURL: upstream.url,
        apiKey: 'stored-key',
        models: [],
      },
    })
    await ctx.llm.discoverModels(namespaceOf(ctx), { provider: 'gateway', apiKey: '  typed-key  ' })
    expect(upstream.requests[0]?.headers.authorization).toBe('Bearer typed-key')
    await expect(ctx.llm.discoverModels(namespaceOf(ctx), { provider: 'gateway', apiKey: '   ' }))
      .rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  })

  it('routes a stored Anthropic profile to its native listing', async () => {
    const upstream = await serving(response => json(response, { data: [{ id: 'claude-x', display_name: 'Claude X' }] }))
    const ctx = await pluginWith({
      gateway: { interfaceType: 'anthropic-messages', baseURL: `${upstream.url}/v1`, apiKey: 'sk-ant', models: [] },
    })
    await expect(ctx.llm.discoverModels(namespaceOf(ctx), { provider: 'gateway' }))
      .resolves.toEqual([{ id: 'claude-x', name: 'Claude X' }])
    expect(upstream.requests[0]?.path).toBe('/v1/models?limit=1000')
    expect(upstream.requests[0]?.headers['x-api-key']).toBe('sk-ant')
  })

  it('resolves a stored credential reference through the launch environment', async () => {
    vi.stubEnv('OWC_DISCOVERY_KEY', 'env-key')
    const upstream = await serving(response => json(response, { data: [] }))
    const ctx = await pluginWith({
      gateway: {
        interfaceType: 'openai-chat-completions',
        baseURL: upstream.url,
        apiKeyEnv: 'OWC_DISCOVERY_KEY',
        models: [],
      },
    })
    await ctx.llm.discoverModels(namespaceOf(ctx), { provider: 'gateway' })
    expect(upstream.requests[0]?.headers.authorization).toBe('Bearer env-key')
  })

  it('probes a draft endpoint for a route no profile declares, and refuses one without an endpoint', async () => {
    const upstream = await serving(response => json(response, { data: [{ id: 'candidate' }] }))
    const ctx = await pluginWith({
      gateway: { interfaceType: 'openai-chat-completions', baseURL: upstream.url, models: [] },
    })
    const namespace = namespaceOf(ctx)
    await expect(ctx.llm.discoverModels(namespace, { provider: 'elsewhere', baseURL: upstream.url }))
      .resolves.toEqual([{ id: 'candidate' }])
    await expect(ctx.llm.discoverModels(namespace, { provider: 'elsewhere' }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  })
})
