import { describe, expect, it } from 'vitest'
import { chatRequest, toWireMessages, translateChatStream } from '../src/chat-completions.ts'
import type { AdapterChunk } from '../src/image-output.ts'
import type { ResolvedOwcModel, ResolvedOwcProviderProfile } from '../src/profiles.ts'
import { resolveProfiles } from '../src/profiles.ts'
import { assistant, image, request, requestImage, system, text, toolCall, toolResult, toolSchema, user } from './messages.ts'

/** One resolved route from the real schema. */
const route = (overrides: Record<string, unknown> = {}): ResolvedOwcProviderProfile => {
  const profile = resolveProfiles({
    gateway: {
      interfaceType: 'openai-chat-completions',
      baseURL: 'https://gateway.test/v1/',
      models: [{ id: 'm', contextWindow: 8192, maxTokens: 1024 }],
      ...overrides,
    },
  }).get('gateway')
  if (profile === undefined) throw new Error('the route did not resolve')
  return profile
}

/** The model entry of a resolved route. */
const modelOf = (profile: ResolvedOwcProviderProfile, id = 'm'): ResolvedOwcModel => {
  const model = profile.models.find(entry => entry.id === id)
  if (model === undefined) throw new Error(`no model ${id}`)
  return model
}

/** Parse the body a request builder produced. */
const bodyOf = (profile: ResolvedOwcProviderProfile, options = request()): Record<string, unknown> =>
  JSON.parse(chatRequest(profile, modelOf(profile), options, undefined).body) as Record<string, unknown>

/** Collect one translation of the given provider events. */
const translate = async (
  events: Array<Record<string, unknown>>,
  sawDone = true,
): Promise<AdapterChunk[]> => {
  const chunks: AdapterChunk[] = []
  for await (const chunk of translateChatStream((async function* generate() {
    yield* events
  })(), () => sawDone)) {
    chunks.push(chunk)
  }
  return chunks
}

/** One PNG payload, and the inline part an endpoint returns it in. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const imagePart = (): Record<string, unknown> => ({
  type: 'image_url',
  image_url: { url: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}` },
})

/** One provider chunk with a content delta. */
const delta = (fields: Record<string, unknown>, finish: string | null = null): Record<string, unknown> => ({
  choices: [{ finish_reason: finish, delta: fields }],
})

describe('chat-completions request', () => {
  it('lays profile extra body fields under the fields the adapter owns', () => {
    const profile = route({ extraBody: { top_k: 40, temperature: 0.1 } })
    const overridden = bodyOf(profile, request({ temperature: 0.9 }))
    expect(overridden).toMatchObject({ top_k: 40, model: 'm', stream: true, temperature: 0.9 })
    // With no request-level value, the profile's own field survives.
    expect(bodyOf(profile)).toMatchObject({ top_k: 40, temperature: 0.1 })
  })

  it('carries an image the endpoint returned as a block of its own', async () => {
    const chunks = await translate([
      { choices: [{ finish_reason: null, delta: { content: 'here: ' } }] },
      { choices: [{ finish_reason: null, delta: { images: [imagePart()] } }] },
      { choices: [{ finish_reason: 'stop', delta: {} }] },
    ])
    // The text block closes before the image opens, so the message reads in
    // the order the endpoint answered.
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'here: ' } })
    expect(chunks).toContainEqual({ type: 'block-start', index: 1, blockType: 'image' })
    expect(chunks).toContainEqual({ type: 'generated-image', index: 1, mediaType: 'image/png', data: PNG_BYTES })
  })

  it('reads an image from a whole message as well as from a delta', async () => {
    const chunks = await translate([
      { choices: [{ finish_reason: 'stop', message: { images: [imagePart()] } }] },
    ])
    expect(chunks.filter(chunk => chunk.type === 'generated-image')).toHaveLength(1)
  })

  it('refuses an image URL it would have to fetch, and one that is not a raster image', async () => {
    const remote = [{ choices: [{ delta: { images: [{ type: 'image_url', image_url: { url: 'https://cdn.test/a.png' } }] } }] }]
    await expect(translate(remote)).rejects.toThrow(/does not fetch/)
    const vector = [{ choices: [{ delta: { images: [{ image_url: { url: 'data:image/svg+xml;base64,PHN2Zz4=' } }] } }] }]
    await expect(translate(vector)).rejects.toThrow(/does not carry/)
  })

  it('asks for a streamed usage report only when the profile does', () => {
    expect(bodyOf(route())).not.toHaveProperty('stream_options')
    expect(bodyOf(route({ includeUsage: true }))).toMatchObject({ stream_options: { include_usage: true } })
  })

  it('sends max_tokens only when the request configured one', () => {
    expect(bodyOf(route())).not.toHaveProperty('max_tokens')
    expect(bodyOf(route(), request({ maxTokens: 64 }))).toMatchObject({ max_tokens: 64 })
  })

  it('writes a model\'s declared request parameters where the caller stated none', () => {
    const profile = route({
      models: [{ id: 'm', contextWindow: 8192, maxTokens: 1024, defaults: { temperature: 0.3, topP: 0.8, topK: 20 } }],
    })
    expect(bodyOf(profile)).toMatchObject({ temperature: 0.3, top_p: 0.8, top_k: 20 })
    // The caller's own value always wins over the declared default; the fields
    // it did not restate still come from the model.
    expect(bodyOf(profile, request({ temperature: 1.1 }))).toMatchObject({
      temperature: 1.1,
      top_p: 0.8,
      top_k: 20,
    })
  })

  it('writes no sampling parameter a model did not declare', () => {
    const body = bodyOf(route())
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('top_p')
    expect(body).not.toHaveProperty('top_k')
  })

  it('sends the effort level the model declares', () => {
    const profile = route({ models: [{ id: 'm', capabilities: { effort: ['low', 'high'] } }] })
    expect(bodyOf(profile, request({ reasoningEffort: 'high' as never }))).toMatchObject({ reasoning_effort: 'high' })
    expect(bodyOf(profile)).not.toHaveProperty('reasoning_effort')
    // A level the model never declared sends nothing rather than a guess.
    expect(bodyOf(profile, request({ reasoningEffort: 'ultra' as never }))).not.toHaveProperty('reasoning_effort')
  })

  it('spells the thinking switch the way the catalog declares', () => {
    const withStyle = (thinkingStyle: string): Record<string, unknown> => bodyOf(
      route({ models: [{ id: 'm', capabilities: { effort: ['high'], thinking: ['enabled', 'disabled'], thinkingStyle } }] }),
      request({ reasoningEffort: 'high' as never }),
    )
    expect(withStyle('thinking')).toMatchObject({ thinking: { type: 'enabled' } })
    expect(withStyle('fixed')).toMatchObject({ thinking: { type: 'enabled' } })
    expect(withStyle('enable_thinking')).toMatchObject({ enable_thinking: true })
    // Without a declared style only the effort level travels.
    const plain = bodyOf(
      route({ models: [{ id: 'm', capabilities: { effort: ['high'] } }] }),
      request({ reasoningEffort: 'high' as never }),
    )
    expect(plain).not.toHaveProperty('thinking')
  })

  it('sends a declared thinking mode as the mode itself', () => {
    const profile = route({ models: [{ id: 'm', capabilities: { thinking: ['adaptive', 'disabled'], thinkingStyle: 'thinking' } }] })
    expect(bodyOf(profile, request({ reasoningEffort: 'adaptive' as never }))).toMatchObject({ thinking: { type: 'enabled' } })
    expect(bodyOf(profile, request({ reasoningEffort: 'disabled' as never }))).toMatchObject({ thinking: { type: 'disabled' } })
  })

  it('maps tool schemas, stop sequences, and the endpoint', () => {
    const profile = route()
    const built = chatRequest(profile, modelOf(profile), request({
      tools: [toolSchema()],
      stop: ['END'],
      system: 'be brief',
    }), 'sk-test')
    const body = JSON.parse(built.body) as Record<string, unknown>
    expect(built.url).toBe('https://gateway.test/v1/chat/completions')
    expect(built.headers.authorization).toBe('Bearer sk-test')
    expect(body.tools).toEqual([{
      type: 'function',
      function: { name: 'shell', description: 'run shell', parameters: { type: 'object', properties: {} } },
    }])
    expect(body.stop).toEqual(['END'])
    expect(body.messages).toEqual([{ role: 'system', content: 'be brief' }])
  })

  it('sends no tool declarations to a model that turns tools off', () => {
    // The declaration says this endpoint has no tool protocol, so the request
    // carries none rather than a list it would reject or quietly ignore.
    const profile = route({ models: [{ id: 'plain', capabilities: { tools: false } }] })
    const body = JSON.parse(chatRequest(profile, modelOf(profile, 'plain'), request({
      tools: [toolSchema()],
      model: 'plain',
    }), undefined).body) as Record<string, unknown>
    expect(body).not.toHaveProperty('tools')
  })

  it('lets a profile header stand beside the credential, which wins', () => {
    const profile = route({ headers: { 'x-tenant': 'acme', authorization: 'Bearer profile' } })
    const built = chatRequest(profile, modelOf(profile), request(), 'sk-test')
    expect(built.headers['x-tenant']).toBe('acme')
    expect(built.headers.authorization).toBe('Bearer sk-test')
    expect(built.headers.accept).toBe('text/event-stream')
  })
})

describe('chat-completions message translation', () => {
  it('keeps text-only turns as plain strings and splits multimodal turns into parts', () => {
    const messages = toWireMessages(request({
      messages: [system('prompt'), user([text('one'), text('two')], 'u1')],
    }), modelOf(route()), new Map())
    expect(messages).toEqual([
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'onetwo' },
    ])
  })

  it('carries a developer turn as a system message and drops empty ones', () => {
    const messages = toWireMessages(request({
      messages: [
        { id: 'd1', role: 'developer', source: { kind: 'user' }, content: [text('tools changed')] } as never,
        { id: 'd2', role: 'developer', source: { kind: 'user' }, content: [] } as never,
      ],
    }), modelOf(route()), new Map())
    expect(messages).toEqual([{ role: 'system', content: 'tools changed' }])
  })

  it('inlines each tool result with its call and answers a missing one with a placeholder', () => {
    const messages = toWireMessages(request({
      messages: [
        assistant([
          toolCall('call-1', 'shell', '{"cmd":"ls"}'),
          toolCall('call-2', 'shell', '{"cmd":"pwd"}'),
        ]),
        toolResult('call-1', 'file.txt'),
      ],
    }), modelOf(route()), new Map())
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
          { id: 'call-2', type: 'function', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'file.txt' },
      { role: 'tool', tool_call_id: 'call-2', content: 'Tool result missing: this call did not complete.' },
    ])
  })

  it('drops an orphan result and never repeats a call id', () => {
    const call = toolCall('call-1', 'shell', '{}')
    const messages = toWireMessages(request({
      messages: [
        toolResult('orphan', 'nothing asked for this'),
        assistant([call], {}, 'a1'),
        assistant([call], {}, 'a2'),
      ],
    }), modelOf(route()), new Map())
    expect(messages.map(message => message.role)).toEqual(['assistant', 'tool'])
    expect(messages[0]?.tool_calls).toHaveLength(1)
  })

  it('collapses a call id one assistant turn declares twice into one call and one result', () => {
    const messages = toWireMessages(request({
      messages: [
        assistant([toolCall('call-1', 'shell', '{}'), toolCall('call-1', 'shell', '{}')]),
        toolResult('call-1', 'file.txt'),
      ],
    }), modelOf(route()), new Map())
    expect(messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'file.txt' },
    ])
  })

  it('carries a retained image as a base64 image_url part beside its text', () => {
    const version = requestImage('abc')
    const messages = toWireMessages(
      request({ messages: [user([text('look at '), image('sha256:a'), text('this')], 'u1')] }),
      modelOf(route({ models: [{ id: 'm', capabilities: { modalities: ['text', 'image'] } }] })),
      new Map([['sha256:a', version]]),
    )
    expect(messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'look at ' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } },
        { type: 'text', text: 'this' },
      ],
    }])
  })

  it('answers an offloaded occurrence with its placeholder instead of bytes', () => {
    const messages = toWireMessages(
      request({ messages: [user([image('sha256:b', { name: 'shot.png' }, true)], 'u1')] }),
      modelOf(route({ models: [{ id: 'm', capabilities: { modalities: ['image'] } }] })),
      new Map(),
    )
    // One placeholder is text, so the turn stays the plain-string form an
    // endpoint with no part array accepts.
    const content = messages[0]?.content
    expect(typeof content).toBe('string')
    expect(content).toContain('image omitted to fit request image limits')
    expect(content).toContain('shot.png')
  })

  it('drops a user-turn block that is neither text nor image', () => {
    const messages = toWireMessages(
      request({ messages: [user([text('kept'), toolCall('call-1', 'shell', '{}')], 'u1')] }),
      modelOf(route()),
      new Map(),
    )
    expect(messages).toEqual([{ role: 'user', content: 'kept' }])
  })

  it('refuses a retained occurrence that reached the wire without a request version', () => {
    expect(() => toWireMessages(
      request({ messages: [user([image('sha256:c')], 'u1')] }),
      modelOf(route({ models: [{ id: 'm', capabilities: { modalities: ['image'] } }] })),
      new Map(),
    )).toThrow(/without a prepared request version/)
  })

  it('replays reasoning only for a route that declares it and only from the same provider', () => {
    const profile = route({ models: [{ id: 'm', capabilities: { reasoningContent: true } }] })
    const reasoning = { type: 'reasoning', text: 'thinking' } as const
    const sameProvider = toWireMessages(request({
      provider: 'gateway',
      messages: [assistant([reasoning, text('answer')], { provider: 'gateway' })],
    }), modelOf(profile), new Map())
    expect(sameProvider[0]).toMatchObject({ reasoning_content: 'thinking', content: 'answer' })
    const otherProvider = toWireMessages(request({
      provider: 'gateway',
      messages: [assistant([reasoning, text('answer')], { provider: 'elsewhere' })],
    }), modelOf(profile), new Map())
    expect(otherProvider[0]).not.toHaveProperty('reasoning_content')
    const undeclared = toWireMessages(request({
      provider: 'gateway',
      messages: [assistant([reasoning, text('answer')], { provider: 'gateway' })],
    }), modelOf(route()), new Map())
    expect(undeclared[0]).not.toHaveProperty('reasoning_content')
  })
})

describe('chat-completions stream translation', () => {
  it('frames text, reasoning, tool calls, usage, and the terminal reason in order', async () => {
    const chunks = await translate([
      delta({ content: 'Hel' }),
      delta({ content: 'lo' }),
      delta({ reasoning_content: 'why' }),
      delta({ tool_calls: [{ index: 0, id: 'call-1', function: { name: 'shell', arguments: '{"cmd"' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
      { choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } },
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'block-start', index: 1, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 1, text: 'why' },
      { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'why' } },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'shell', argumentsDelta: '{"cmd"' },
      { type: 'tool-call-delta', index: 2, id: 'call-1', argumentsDelta: ':1}' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call-1', name: 'shell', arguments: '{"cmd":1}' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 16, cacheReadTokens: 2, cacheWriteTokens: 0 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('announces a tool call only once its id arrives, keeping earlier fragments', async () => {
    const chunks = await translate([
      delta({ tool_calls: [{ index: 0, function: { name: 'shell', arguments: '{"a"' } }] }),
      delta({ tool_calls: [{ index: 0, id: 'call-9', function: { arguments: ':1}' } }] }),
      delta({}, 'tool_calls'),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call-9', name: 'shell', argumentsDelta: '{"a":1}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-9', name: 'shell', arguments: '{"a":1}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('accepts a stream that closes with output but no explicit reason', async () => {
    const chunks = await translate([delta({ content: 'done' })])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('maps a length stop and a filtered stop', async () => {
    expect((await translate([delta({ content: 'x' }, 'length')])).at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect((await translate([delta({ content: 'x' }, 'content_filter')])).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('refuses a truncated stream and an empty completion', async () => {
    await expect(translate([delta({ content: 'cut' })], false)).rejects.toMatchObject({ code: 'TRANSPORT' })
    await expect(translate([delta({}, 'stop')])).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })

  it('classifies an in-band provider error and an invalid usage report', async () => {
    await expect(translate([{ error: { message: 'rate limited', type: 'rate_limit_error' } }]))
      .rejects.toMatchObject({ code: 'RATE_LIMIT' })
    await expect(translate([{ choices: [{ finish_reason: 'stop', delta: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 5 } } }]))
      .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})
