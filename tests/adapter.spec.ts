import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { OwcProfilesAdapter } from '../src/adapter.ts'
import { ConcurrencyLimiter } from '../src/limiter.ts'
import { resolveProfiles, type ResolvedOwcProviderProfile } from '../src/profiles.ts'
import type { AttachmentStore, ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { assistant, image, request, requestImage, system, text, toolCall, toolResult, user } from './messages.ts'

/** One running mock provider. */
interface Provider {
  url: string
  close: () => Promise<void>
  /** Bodies the provider received, in arrival order. */
  readonly bodies: Record<string, unknown>[]
  /** Request paths the provider received, in arrival order. */
  readonly paths: string[]
}

/** Start a chat-completions mock that answers every request with the handler's frames. */
async function provider(
  handler: (response: ServerResponse, body: Record<string, unknown>) => void,
): Promise<Provider> {
  const bodies: Record<string, unknown>[] = []
  const paths: string[] = []
  const server: Server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      paths.push(incoming.url ?? '')
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      handler(outgoing, bodies[bodies.length - 1] ?? {})
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the mock provider did not bind a port')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    bodies,
    paths,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    }),
  }
}

/** Write one SSE frame. */
function frame(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
}

/** Answer with a complete text turn. */
function textTurn(response: ServerResponse, content = 'hello'): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  frame(response, { choices: [{ finish_reason: null, delta: { content } }] })
  frame(response, { choices: [{ finish_reason: 'stop', delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 1 } })
  frame(response, '[DONE]')
  response.end()
}

/** Answer a model call with one complete Messages text turn. */
function messagesTurn(response: ServerResponse, content = 'hello'): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  frame(response, { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 3, output_tokens: 1 } } })
  frame(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  frame(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } })
  frame(response, { type: 'content_block_stop', index: 0 })
  frame(response, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })
  frame(response, { type: 'message_stop' })
  response.end()
}

/** Answer a model call with one complete Responses turn. */
function responsesTurn(response: ServerResponse, content = 'hello'): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  frame(response, { type: 'response.created', response: { id: 'resp_1' } })
  frame(response, { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' }, output_index: 0 })
  frame(response, { type: 'response.output_text.delta', delta: content, output_index: 0 })
  frame(response, {
    type: 'response.output_item.done',
    item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: content }] },
    output_index: 0,
  })
  frame(response, {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      status: 'completed',
      output: [],
      usage: { input_tokens: 3, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } },
    },
  })
  response.end()
}

/** One resolved route pointing at the mock provider. */
const routeFor = (url: string, overrides: Record<string, unknown> = {}): ResolvedOwcProviderProfile => {
  const profile = resolveProfiles({
    gateway: { interfaceType: 'openai-chat-completions', baseURL: url, models: [{ id: 'm' }], ...overrides },
  }).get('gateway')
  if (profile === undefined) throw new Error('the route did not resolve')
  return profile
}

/** An adapter over one fixed route, with credential resolution the caller controls. */
const adapterFor = (
  profile: ResolvedOwcProviderProfile | (() => ResolvedOwcProviderProfile),
  resolveApiKey: () => Promise<string | undefined> = () => Promise.resolve('sk-test'),
  resolveAttachments?: () => AttachmentStore | undefined,
): OwcProfilesAdapter => {
  const profiles = (): ReadonlyMap<string, ResolvedOwcProviderProfile> => {
    const current = typeof profile === 'function' ? profile() : profile
    return new Map([[current.provider, current]])
  }
  return new OwcProfilesAdapter({
    profiles,
    limiter: () => new ConcurrencyLimiter(3),
    resolveApiKey: () => resolveApiKey(),
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
  })
}

/** One PNG payload, and the inline part an endpoint returns it in. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const generatedImagePart = (): Record<string, unknown> => ({
  type: 'image_url',
  image_url: { url: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}` },
})

/** An attachment provider answering with one PNG request version over the given bytes. */
const attachmentStore = (bytes = 4): AttachmentStore => ({
  readImageRequest: (ref: ImageAttachmentRef, target: ImageRequestTarget) => Promise.resolve({
    ...requestImage(Buffer.alloc(bytes).toString('latin1')),
    attachment: ref,
    bytes,
    width: target.width,
    height: target.height,
  }),
} as never)

/** Collect one stream. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const running: Provider[] = []
afterEach(async () => {
  await Promise.all(running.splice(0).map(entry => entry.close()))
})

describe('owc profiles adapter', () => {
  it('carries a declared image to the endpoint as a base64 data URL', async () => {
    const upstream = await provider((response) => { textTurn(response) })
    running.push(upstream)
    const adapter = adapterFor(
      routeFor(upstream.url, { models: [{ id: 'm', capabilities: { modalities: ['text', 'image'] } }] }),
      () => Promise.resolve('sk-test'),
      () => attachmentStore(),
    )
    await collect(adapter.stream(request({ messages: [user([text('what is this?'), image('sha256:a')], 'u1')] })))
    expect(upstream.bodies[0]?.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.alloc(4).toString('base64')}` } },
      ],
    }])
  })

  it('stores an image the endpoint returned and publishes a durable block', async () => {
    const upstream = await provider((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(response, { choices: [{ finish_reason: null, delta: { content: 'here: ' } }] })
      frame(response, { choices: [{ finish_reason: null, delta: { images: [generatedImagePart()] } }] })
      frame(response, { choices: [{ finish_reason: 'stop', delta: {} }] })
      frame(response, '[DONE]')
      response.end()
    })
    running.push(upstream)
    const attachment = { attachmentId: 'sha256:pic', mediaType: 'image/png', bytes: 8, width: 1, height: 1 }
    const saved: unknown[] = []
    const adapter = adapterFor(
      routeFor(upstream.url, { models: [{ id: 'm', capabilities: { imageOutput: true } }] }),
      () => Promise.resolve('sk-test'),
      () => ({ saveImages: (inputs: unknown) => { saved.push(inputs); return Promise.resolve([attachment]) } } as never),
    )
    const chunks = await collect(adapter.stream(request()))
    expect(saved).toEqual([[{ data: PNG_BYTES, mediaType: 'image/png' }]])
    expect(chunks).toContainEqual({ type: 'block-end', index: 1, block: { type: 'image', attachment } })
  })

  it('fails an image from a model that never declared image output', async () => {
    const upstream = await provider((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(response, { choices: [{ finish_reason: null, delta: { images: [generatedImagePart()] } }] })
      frame(response, { choices: [{ finish_reason: 'stop', delta: {} }] })
      frame(response, '[DONE]')
      response.end()
    })
    running.push(upstream)
    const adapter = adapterFor(routeFor(upstream.url), () => Promise.resolve('sk-test'), () => attachmentStore())
    const failure = await collect(adapter.stream(request())).catch((error: unknown) => error)
    expect(String(failure)).toContain('without declaring image output')
  })

  it('fails an image the endpoint returned when no attachment provider is mounted', async () => {
    const upstream = await provider((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(response, { choices: [{ finish_reason: null, delta: { images: [generatedImagePart()] } }] })
      frame(response, { choices: [{ finish_reason: 'stop', delta: {} }] })
      frame(response, '[DONE]')
      response.end()
    })
    running.push(upstream)
    const adapter = adapterFor(routeFor(upstream.url, { models: [{ id: 'm', capabilities: { imageOutput: true } }] }))
    const failure = await collect(adapter.stream(request())).catch((error: unknown) => error)
    expect(String(failure)).toContain('no attachment provider is mounted')
  })

  it('fails an image request without a mounted attachment provider, before the endpoint sees it', async () => {
    const upstream = await provider((response) => { textTurn(response) })
    running.push(upstream)
    const adapter = adapterFor(routeFor(upstream.url, { models: [{ id: 'm', capabilities: { modalities: ['image'] } }] }))
    const failure = await collect(adapter.stream(request({ messages: [user([image('sha256:a')], 'u1')] })))
      .catch((error: unknown) => error)
    expect(String(failure)).toContain('no attachment provider is mounted')
    expect(upstream.bodies).toHaveLength(0)
  })

  it('streams a text turn through the configured endpoint', async () => {
    const upstream = await provider((response) => { textTurn(response) })
    running.push(upstream)
    const adapter = adapterFor(routeFor(upstream.url))
    const chunks = await collect(adapter.stream(request({ messages: [system('be brief'), user([text('hi')])] })))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(upstream.bodies[0]).toMatchObject({
      model: 'm',
      stream: true,
      messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }],
    })
  })

  it('streams a text turn through an anthropic-messages route', async () => {
    const upstream = await provider((response) => { messagesTurn(response) })
    running.push(upstream)
    const adapter = adapterFor(routeFor(upstream.url, {
      interfaceType: 'anthropic-messages',
      models: [{ id: 'm', defaults: { maxTokens: 512 } }],
    }))
    const chunks = await collect(adapter.stream(request({
      messages: [system('be brief'), user([text('hi')])],
    })))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: {
          response: { kind: 'llm-service-lite-anthropic', version: 1, stopReason: 'end_turn', responseId: 'msg_1' },
          blocks: [{ type: 'text' }],
        },
      },
    ])
    // This protocol has its own path, its own required cap, and its own headers.
    expect(upstream.paths[0]).toBe('/v1/messages')
    expect(upstream.bodies[0]).toEqual({
      model: 'm',
      max_tokens: 512,
      stream: true,
      system: 'be brief',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
  })

  it('answers a Messages call whose result never landed, so the endpoint accepts it', async () => {
    const upstream = await provider((response) => { messagesTurn(response) })
    running.push(upstream)
    const adapter = adapterFor(routeFor(upstream.url, { interfaceType: 'anthropic-messages' }))
    await collect(adapter.stream(request({
      messages: [assistant([toolCall('toolu_a', 'shell', '{}')]), toolResult('toolu_b', 'stray')],
    })))
    expect(upstream.bodies[0]?.messages).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'shell', input: {} }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_a',
          content: 'Tool result missing: this call did not complete.',
        }],
      },
    ])
  })

  it('streams a text turn through an openai-responses route', async () => {
    const upstream = await provider((response) => { responsesTurn(response) })
    running.push(upstream)
    const adapter = adapterFor(routeFor(upstream.url, {
      interfaceType: 'openai-responses',
      models: [{ id: 'm', maxTokens: 512 }],
    }))
    const chunks = await collect(adapter.stream(request({ messages: [system('be brief'), user([text('hi')])] })))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0 } },
      {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: {
          response: { kind: 'llm-service-lite-responses', version: 1, stopReason: 'completed', responseId: 'resp_1' },
          blocks: [{ type: 'text', itemId: 'msg_1' }],
        },
      },
    ])
    expect(upstream.paths[0]).toBe('/v1/responses')
    expect(upstream.bodies[0]).toEqual({
      model: 'm',
      stream: true,
      instructions: 'be brief',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      max_output_tokens: 512,
    })
  })

  it('drops a Responses call whose result never landed, so the endpoint accepts it', async () => {
    const upstream = await provider((response) => { responsesTurn(response) })
    running.push(upstream)
    const adapter = adapterFor(routeFor(upstream.url, { interfaceType: 'openai-responses' }))
    await collect(adapter.stream(request({
      messages: [assistant([toolCall('call_a', 'shell', '{}')]), toolResult('call_b', 'stray')],
    })))
    expect(upstream.bodies[0]?.input).toEqual([])
  })

  it('describes routes and models from the profile alone', async () => {
    const upstream = await provider((response) => { textTurn(response) })
    running.push(upstream)
    const adapter = adapterFor(routeFor(upstream.url, {
      displayName: 'Acme Gateway',
      models: [{ id: 'm', name: 'Acme One', contextWindow: 4096, maxTokens: 512, capabilities: { effort: ['low', 'high'] } }],
    }))
    expect(adapter.providerInfo('gateway')).toEqual({ id: 'gateway', name: 'Acme Gateway' })
    expect(await adapter.listModels('gateway')).toEqual([
      { provider: 'gateway', id: 'm', name: 'Acme One', inputModalities: ['text'], outputModalities: ['text'] },
    ])
    expect(await adapter.resolveModel('gateway', 'm')).toMatchObject({
      provider: 'gateway',
      id: 'm',
      context: { contextWindow: 4096 },
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
    })
    // A model's own capacity is what it can answer, not what every request asks
    // for: only a configured request default is materialized for the caller.
    expect(await adapter.resolveModel('gateway', 'm')).not.toHaveProperty('defaultMaxTokens')
    const defaulting = adapterFor(routeFor('http://127.0.0.1:1/v1', {
      models: [{ id: 'm', contextWindow: 4096, maxTokens: 512, defaults: { maxTokens: 256 } }],
    }))
    expect(await defaulting.resolveModel('gateway', 'm')).toMatchObject({ defaultMaxTokens: 256 })
    // A model the family table speaks for publishes the family's default level.
    expect(await adapter.resolveModel('gateway', 'claude-opus-5-5')).toMatchObject({
      reasoning: { defaultEffort: 'medium' },
    })
    expect(await adapter.resolveModel('gateway', 'unlisted')).toMatchObject({ id: 'unlisted', context: { contextWindow: 256_000 } })
    // Every route states what its answers may carry; a model that declared
    // image output states images as well as text.
    expect(await adapter.resolveModel('gateway', 'm')).toMatchObject({ outputModalities: ['text'] })
    const drawing = adapterFor(routeFor('http://127.0.0.1:1/v1', {
      models: [{ id: 'm', capabilities: { imageOutput: true } }],
    }))
    expect(await drawing.resolveModel('gateway', 'm')).toMatchObject({ outputModalities: ['text', 'image'] })
    expect(await drawing.listModels('gateway')).toMatchObject([{ id: 'm', outputModalities: ['text', 'image'] }])
    // Mid-history capabilities are declared only where they were declared: a
    // route that named none keeps the harness restating prompt and tools.
    expect(await adapter.resolveModel('gateway', 'm')).not.toHaveProperty('systemPromptUpdate')
    expect(await adapter.resolveModel('gateway', 'm')).not.toHaveProperty('toolUpdate')
    expect(adapter.providerInfo('elsewhere')).toEqual({ id: 'elsewhere', name: 'elsewhere' })
    expect(await adapter.listModels('elsewhere')).toEqual([])
    expect(adapter.providerRetryPolicy('gateway')).toMatchObject({ mode: 'normal' })
    expect(adapter.providerRetryPolicy('elsewhere')).toBeUndefined()
  })

  it('declares the mid-history capabilities a Messages route named', async () => {
    const adapter = adapterFor(routeFor('http://127.0.0.1:1/v1', {
      interfaceType: 'anthropic-messages',
      models: [{
        id: 'm',
        capabilities: { systemPromptUpdate: 'in-history', toolUpdate: 'addition-only' },
      }],
    }))
    expect(await adapter.resolveModel('gateway', 'm')).toMatchObject({
      systemPromptUpdate: 'in-history',
      toolUpdate: 'addition-only',
    })
  })

  it('prices surface images for a route that declared its accounting', () => {
    const adapter = adapterFor(routeFor('http://127.0.0.1:1/v1', {
      models: [{
        id: 'm',
        capabilities: { modalities: ['text', 'image'] },
        imageTokens: { kind: 'area', per: 750 },
      }, { id: 'plain' }, { id: 'undeclared', capabilities: { modalities: ['text', 'image'] } }],
    }))
    const occurrence = image('sha256:a', { width: 1500, height: 750 }) as ImageBlock
    expect(adapter.imageRequestPricing('gateway', 'm')?.priceImages([occurrence]))
      .toEqual([{ visualTokens: 1500, text: '' }])
    // A text-only route prices the substitution the runtime performs, an
    // image route that declared no accounting answers nothing — which leaves
    // the meter's own heuristic in place — and an unknown route answers
    // nothing at all.
    expect(adapter.imageRequestPricing('gateway', 'plain')?.priceImages([occurrence])
      .map(price => price.visualTokens)).toEqual([0])
    expect(adapter.imageRequestPricing('gateway', 'undeclared')).toBeUndefined()
    expect(adapter.imageRequestPricing('gone', 'm')).toBeUndefined()
  })

  it('serves a route that stops being configured with a named refusal', async () => {
    const adapter = adapterFor(routeFor('http://127.0.0.1:1/v1'))
    await expect(collect(adapter.stream(request({ provider: 'gone' })))).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    await expect(adapter.resolveModel('gone', 'm')).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    await expect(adapter.prepareCall('gone', 'm')).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  })

  it('dispatches a prepared call against the endpoint its preparation captured', async () => {
    const first = await provider((response) => { textTurn(response, 'first') })
    const second = await provider((response) => { textTurn(response, 'second') })
    running.push(first, second)
    let current = routeFor(first.url)
    const adapter = adapterFor(() => current)
    const prepared = await adapter.prepareCall('gateway', 'm')
    current = routeFor(second.url)
    const chunks = []
    for await (const chunk of prepared.stream(request({ messages: [user([text('hi')])] }))) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'first' })
    expect(first.bodies).toHaveLength(1)
    expect(second.bodies).toHaveLength(0)
  })

  it('classifies a provider HTTP failure and keeps its retry hint', async () => {
    const upstream = await provider((response) => {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' })
      response.end(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error' } }))
    })
    running.push(upstream)
    const adapter = adapterFor(routeFor(upstream.url))
    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      failure: { status: 429, providerRetryAfterMs: 3000 },
    })
  })

  it('reports a non-JSON gateway failure with the status and the body text', async () => {
    const upstream = await provider((response) => {
      response.writeHead(502, { 'content-type': 'text/plain' })
      response.end('bad gateway')
    })
    running.push(upstream)
    const adapter = adapterFor(routeFor(upstream.url))
    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('ends a stalled stream with a timeout instead of holding the turn open', async () => {
    const upstream = await provider((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(response, { choices: [{ finish_reason: null, delta: { content: 'partial' } }] })
      // Heartbeat comments keep the socket alive without carrying progress.
      const beat = setInterval(() => { response.write(': ping\n\n') }, 5)
      response.on('close', () => { clearInterval(beat) })
    })
    running.push(upstream)
    const adapter = adapterFor(routeFor(upstream.url, { streamIdleTimeoutMs: 60 }))
    await expect(collect(adapter.stream(request()))).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('reports caller cancellation as an aborted request', async () => {
    const upstream = await provider((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      frame(response, { choices: [{ finish_reason: null, delta: { content: 'partial' } }] })
    })
    running.push(upstream)
    const adapter = adapterFor(routeFor(upstream.url))
    const controller = new AbortController()
    const stream = adapter.stream(request({ signal: controller.signal }))
    const pending = collect(stream)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('serves a route whose profile names no credential', async () => {
    const upstream = await provider((response, body) => { void body; textTurn(response, 'anonymous') })
    running.push(upstream)
    const adapter = adapterFor(routeFor(upstream.url), () => Promise.resolve(undefined))
    const chunks = await collect(adapter.stream(request()))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'anonymous' })
  })
})
