import { describe, expect, it } from 'vitest'
import { anthropicRequest, replayBlocksOf, toAnthropicMessages } from '../src/anthropic-messages.ts'
import type { ContentBlock, GenerateOptions, ModelMessageSource } from '@deepseek-ai/dsh-llm'
import type { ResolvedOwcModel, ResolvedOwcProviderProfile } from '../src/profiles.ts'
import { resolveProfiles } from '../src/profiles.ts'
import {
  assistant, developer, developerWith, image, request, requestImage, system, text, toolAddition, toolCall, toolRemoval,
  toolResult, toolResultWith, toolSchema, user,
} from './messages.ts'

/** One resolved route from the real schema. */
const route = (overrides: Record<string, unknown> = {}): ResolvedOwcProviderProfile => {
  const profile = resolveProfiles({
    gateway: {
      interfaceType: 'anthropic-messages',
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

/** One request over the default route. */
const options = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => request({ model: 'm', ...overrides })

/** Parse the body a request builder produced. */
const bodyOf = (
  profile: ResolvedOwcProviderProfile,
  overrides: Partial<GenerateOptions> = {},
  versions: Parameters<typeof anthropicRequest>[4] = new Map(),
  id = 'm',
): Record<string, unknown> => JSON.parse(
  anthropicRequest(profile, modelOf(profile, id), options(overrides), undefined, versions).body,
) as Record<string, unknown>

/** One wire message of a translated body. */
interface WireMessage {
  role: string
  content: Array<Record<string, unknown>>
}

/** The translated messages of one request. */
const messagesOf = (
  profile: ResolvedOwcProviderProfile,
  overrides: Partial<GenerateOptions> = {},
  versions: Parameters<typeof anthropicRequest>[4] = new Map(),
): WireMessage[] => bodyOf(profile, overrides, versions)['messages'] as WireMessage[]

describe('anthropic-messages request', () => {
  it('addresses the protocol default endpoint and its own path', () => {
    expect(anthropicRequest(route(), modelOf(route()), options(), undefined).url)
      .toBe('https://gateway.test/v1/messages')
    const fallback = resolveProfiles({ g: { interfaceType: 'anthropic-messages' } }).get('g')
    if (fallback === undefined) throw new Error('the default route did not resolve')
    expect(anthropicRequest(fallback, modelOf(route()), options(), undefined).url)
      .toBe('https://api.anthropic.com/v1/messages')
  })

  it('authenticates with both spellings a Messages endpoint may read', () => {
    const profile = route({ headers: { 'x-gateway': 'one' } })
    const request = anthropicRequest(profile, modelOf(profile), options(), 'sk-key')
    expect(request.headers).toMatchObject({
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'sk-key',
      authorization: 'Bearer sk-key',
      'x-gateway': 'one',
    })
    // An unauthenticated route sends neither credential header.
    const anonymous = anthropicRequest(profile, modelOf(profile), options(), undefined)
    expect(anonymous.headers).not.toHaveProperty('x-api-key')
    expect(anonymous.headers).not.toHaveProperty('authorization')
    expect(anthropicRequest(profile, modelOf(profile), options(), '').headers).not.toHaveProperty('x-api-key')
  })

  it('always sends the output cap this protocol requires', () => {
    const profile = route()
    // A model no family speaks for takes the conservative unmatched cap: the
    // field is required, so silence is not an option.
    expect(bodyOf(profile)).toMatchObject({ max_tokens: 64 * 1024, stream: true })
    expect(bodyOf(profile, { maxTokens: 64 })).toMatchObject({ max_tokens: 64 })
    // A profile-level override stands in for the model default.
    expect(bodyOf(route({ extraBody: { max_tokens: 256 } }))).toMatchObject({ max_tokens: 256 })
    // A configured request default is the model's own answer.
    expect(bodyOf(route({ models: [{ id: 'm', defaults: { maxTokens: 1024 } }] })))
      .toMatchObject({ max_tokens: 1024 })
    // A model its family speaks for takes the documented cap instead.
    expect(bodyOf(route({ models: [{ id: 'claude-opus-4-5' }] }), {}, undefined, 'claude-opus-4-5'))
      .toMatchObject({ max_tokens: 64 * 1024 })
    expect(bodyOf(route({ models: [{ id: 'claude-opus-5-5' }] }), {}, undefined, 'claude-opus-5-5'))
      .toMatchObject({ max_tokens: 128 * 1024 })
  })

  it('sends sampling and stop fields only when the request configured them', () => {
    expect(bodyOf(route())).not.toHaveProperty('temperature')
    expect(bodyOf(route(), { temperature: 0.4 })).toMatchObject({ temperature: 0.4 })
    expect(bodyOf(route())).not.toHaveProperty('stop_sequences')
    expect(bodyOf(route(), { stop: ['</end>'] })).toMatchObject({ stop_sequences: ['</end>'] })
    expect(bodyOf(route(), { stop: [] })).not.toHaveProperty('stop_sequences')
  })

  it('writes a model\'s declared request parameters where the caller stated none', () => {
    const profile = route({
      models: [{ id: 'm', contextWindow: 8192, maxTokens: 1024, defaults: { temperature: 0.3, topP: 0.7, topK: 32, maxTokens: 256 } }],
    })
    expect(bodyOf(profile)).toMatchObject({ temperature: 0.3, top_p: 0.7, top_k: 32, max_tokens: 256 })
    expect(bodyOf(profile, { temperature: 1, maxTokens: 64 })).toMatchObject({ temperature: 1, max_tokens: 64 })
  })

  it('writes no sampling parameter a model did not declare', () => {
    const body = bodyOf(route())
    expect(body).not.toHaveProperty('top_p')
    expect(body).not.toHaveProperty('top_k')
  })

  it('lays profile extra body fields under the fields the adapter owns', () => {
    const profile = route({ extraBody: { top_k: 40, max_tokens: 128 } })
    expect(bodyOf(profile, { maxTokens: 64 })).toMatchObject({ top_k: 40, max_tokens: 64 })
  })

  it('reads the prompt from the request, else from the leading system message', () => {
    expect(bodyOf(route())).not.toHaveProperty('system')
    expect(bodyOf(route(), { system: 'be brief' })).toMatchObject({ system: 'be brief' })
    expect(bodyOf(route(), { system: '' })).not.toHaveProperty('system')
    const leading = { messages: [system('from history'), user([text('hi')])] }
    expect(bodyOf(route(), leading)).toMatchObject({ system: 'from history' })
    // The leading system message is consumed by the prompt, never left as a turn.
    expect(messagesOf(route(), leading)).toHaveLength(1)
    // An empty leading system message supplies no prompt and leaves no turn.
    expect(bodyOf(route(), { messages: [system(''), user([text('hi')])] })).not.toHaveProperty('system')
  })

  it('marks cache breakpoints when the route declares prompt caching', () => {
    const overrides = {
      system: 'be brief',
      messages: [user([text('hi')])],
      tools: [toolSchema('shell'), toolSchema('read')],
    }
    const body = bodyOf(route({ promptCaching: true }), overrides)
    expect(body['system']).toEqual([{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }])
    const tools = body['tools'] as Array<Record<string, unknown>>
    expect(tools[0]).not.toHaveProperty('cache_control')
    expect(tools[1]).toMatchObject({ cache_control: { type: 'ephemeral' } })
    // Without the declaration every breakpoint is absent.
    expect(bodyOf(route(), overrides)['system']).toBe('be brief')
  })

  it('sends tool declarations unless the model refuses them', () => {
    const tools = { tools: [toolSchema('shell')] }
    expect(bodyOf(route(), tools)['tools']).toEqual([{
      name: 'shell',
      description: 'run shell',
      input_schema: { type: 'object', properties: {} },
    }])
    expect(bodyOf(route())).not.toHaveProperty('tools')
    expect(bodyOf(route(), { tools: [] })).not.toHaveProperty('tools')
    const noTools = route({ models: [{ id: 'm', capabilities: { tools: false } }] })
    expect(bodyOf(noTools, tools)).not.toHaveProperty('tools')
  })

  it('spells the selected reasoning level the way this protocol does', () => {
    const efforts = route({ models: [{ id: 'm', capabilities: { effort: ['low', 'high'] } }] })
    expect(bodyOf(efforts)).not.toHaveProperty('output_config')
    expect(bodyOf(efforts, { reasoningEffort: 'high' as never })).toMatchObject({ output_config: { effort: 'high' } })
    // An effort with no declared mode carries no thinking block: the endpoint's
    // own default decides how it thinks.
    expect(bodyOf(efforts, { reasoningEffort: 'high' as never })).not.toHaveProperty('thinking')

    const adaptive = route({ models: [{ id: 'm', capabilities: { thinking: ['adaptive', 'disabled'] } }] })
    expect(bodyOf(adaptive, { reasoningEffort: 'adaptive' as never })).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' },
    })
    expect(bodyOf(adaptive, { reasoningEffort: 'disabled' as never })).not.toHaveProperty('thinking')
    // A level the model never declared sends nothing rather than a guess.
    expect(bodyOf(adaptive, { reasoningEffort: 'ultra' as never })).not.toHaveProperty('thinking')

    const extended = route({ models: [{ id: 'm', defaults: { maxTokens: 4096 }, capabilities: { thinking: ['enabled'] } }] })
    expect(bodyOf(extended, { reasoningEffort: 'enabled' as never })).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 3072 },
    })
    // A cap too small for the documented floor asks for the largest budget
    // below it, which the endpoint rejects by name rather than truncating.
    const tiny = route({ models: [{ id: 'm', defaults: { maxTokens: 512 }, capabilities: { thinking: ['enabled'] } }] })
    expect(bodyOf(tiny, { reasoningEffort: 'enabled' as never })).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 511 },
    })
  })

  it('combines an effort with the mode the model declares beside it', () => {
    const adaptive = route({ models: [{ id: 'm', capabilities: { effort: ['high'], thinking: ['adaptive'] } }] })
    expect(bodyOf(adaptive, { reasoningEffort: 'high' as never })).toMatchObject({
      output_config: { effort: 'high' },
      thinking: { type: 'adaptive', display: 'summarized' },
    })
    const extendedOnly = route({
      models: [{ id: 'm', defaults: { maxTokens: 4096 }, capabilities: { effort: ['high'], thinking: ['enabled'] } }],
    })
    expect(bodyOf(extendedOnly, { reasoningEffort: 'high' as never })).toMatchObject({
      output_config: { effort: 'high' },
      thinking: { type: 'enabled', budget_tokens: 3072 },
    })
  })
})

describe('anthropic-messages pairing repair', () => {
  const profile = route()

  it('drops a result whose call the history never declared', () => {
    const messages = messagesOf(profile, { messages: [user([text('hi')]), toolResult('toolu_orphan', 'stray')] })
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages)).not.toContain('toolu_orphan')
  })

  it('takes the first of two results a batch carries for one call', () => {
    const messages = messagesOf(profile, {
      messages: [
        assistant([toolCall('toolu_a', 'shell', '{}')]),
        toolResult('toolu_a', 'first'),
        toolResult('toolu_a', 'second'),
      ],
    })
    expect(messages[1]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'first' }])
  })

  it('declares a repeated call id once, in its first turn', () => {
    const messages = messagesOf(profile, {
      messages: [
        assistant([toolCall('toolu_a', 'shell', '{"cmd":"ls"}'), toolCall('toolu_a', 'shell', '{"cmd":"rm"}')], {}, 'a1'),
        toolResult('toolu_a', 'listed'),
        assistant([toolCall('toolu_a', 'read', '{}')], {}, 'a2'),
      ],
    })
    expect(messages[0]?.content).toEqual([{ type: 'tool_use', id: 'toolu_a', name: 'shell', input: { cmd: 'ls' } }])
    expect(messages[1]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'listed' }])
    // The later turn's repeat is dropped, and the turn keeps only a placeholder.
    expect(messages[2]?.content).toEqual([{ type: 'text', text: '[context trimmed]' }])
  })

  it('answers a call the history never answered, before the next turn', () => {
    const messages = messagesOf(profile, {
      messages: [assistant([toolCall('toolu_a', 'shell', '{}')]), user([text('still there?')])],
    })
    expect(messages).toHaveLength(3)
    expect(messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'Tool result missing: this call did not complete.' }],
    })
    expect(messages[2]).toMatchObject({ role: 'user' })
  })

  it('answers a call left dangling at the end of the history', () => {
    const messages = messagesOf(profile, { messages: [assistant([toolCall('toolu_a', 'shell', '{}')])] })
    expect(messages).toHaveLength(2)
    expect(messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'Tool result missing: this call did not complete.' }],
    })
  })

  it('merges one batch of results into the single user turn this protocol requires', () => {
    const messages = messagesOf(profile, {
      messages: [
        assistant([toolCall('toolu_a', 'shell', '{}'), toolCall('toolu_b', 'read', '{}')]),
        toolResult('toolu_a', 'first'),
        toolResult('toolu_b', 'second'),
        user([text('next')]),
      ],
    })
    expect(messages).toHaveLength(3)
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: 'first' },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: 'second' },
      ],
    })
  })

  it('answers only the calls a batch left open, in the batch turn', () => {
    const messages = messagesOf(profile, {
      messages: [
        assistant([toolCall('toolu_a', 'shell', '{}'), toolCall('toolu_b', 'read', '{}')]),
        toolResult('toolu_a', 'first'),
      ],
    })
    expect(messages[1]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_a', content: 'first' },
      { type: 'tool_result', tool_use_id: 'toolu_b', content: 'Tool result missing: this call did not complete.' },
    ])
  })

  it('skips a batch whose every result is an orphan, keeping the history seamless', () => {
    const messages = messagesOf(profile, {
      messages: [user([text('hi')]), toolResult('toolu_orphan', 'stray'), user([text('there')])],
    })
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'there' }] },
    ])
  })

  it('carries a result outcome and its text', () => {
    const messages = messagesOf(profile, {
      messages: [
        assistant([toolCall('toolu_a', 'shell', '{}')]),
        toolResultWith('toolu_a', [text('failed')], { isError: true }),
      ],
    })
    expect(messages[1]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_a', content: 'failed', is_error: true },
    ])
  })

  it('replays a call with no usable arguments as an empty input', () => {
    const messages = messagesOf(profile, {
      messages: [assistant([toolCall('toolu_a', 'shell', 'not json')]), toolResult('toolu_a', 'done')],
    })
    expect(messages[0]?.content).toEqual([{ type: 'tool_use', id: 'toolu_a', name: 'shell', input: {} }])
  })

  it('folds a later developer message into a user turn where it stands', () => {
    const messages = messagesOf(profile, {
      messages: [user([text('hi')]), developer('tool X is available'), system('late notice')],
    })
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'tool X is available' }] },
      { role: 'user', content: [{ type: 'text', text: 'late notice' }] },
    ])
  })

  it('skips a turn with nothing this protocol can carry', () => {
    expect(messagesOf(profile, { messages: [user([]), user([text('')]), system('')] })).toEqual([])
    // A block that is neither text nor image contributes nothing to a user turn.
    expect(messagesOf(profile, { messages: [user([{ type: 'tool-addition', toolName: 'shell' }])] })).toEqual([])
  })

  it('reads a result whose text block arrived without text', () => {
    const messages = messagesOf(profile, {
      messages: [
        assistant([toolCall('toolu_a', 'shell', '{}')]),
        toolResultWith('toolu_a', [{ type: 'text' } as ContentBlock]),
      ],
    })
    expect(messages[1]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_a', content: '' }])
  })

  it('resolves an image occurrence to its prepared bytes, and an offloaded one to text', () => {
    const messages = messagesOf(profile, {
      messages: [user([text('look'), image('sha256:x')]), user([image('sha256:x', {}, true)])],
    }, new Map([['sha256:x', requestImage('abc')]]))
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
    ])
    expect(messages[1]?.content[0]).toMatchObject({ type: 'text' })
  })

  it('refuses a retained image that reached the wire without a request version', () => {
    expect(() => messagesOf(profile, { messages: [user([image('sha256:x')])] }))
      .toThrow(/without a prepared request version/)
  })

  it('inlines the media a tool result carried beside its text', () => {
    const messages = messagesOf(profile, {
      messages: [
        assistant([toolCall('toolu_a', 'read_media', '{}')]),
        toolResultWith('toolu_a', [text('the picture'), image('sha256:x')]),
      ],
    }, new Map([['sha256:x', requestImage('abc')]]))
    expect(messages[1]?.content).toEqual([{
      type: 'tool_result',
      tool_use_id: 'toolu_a',
      content: [
        { type: 'text', text: 'the picture' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
      ],
    }])
  })

  it('keeps the caller\'s turn roles and order', () => {
    expect(toAnthropicMessages(
      options({ messages: [user([text('hi')]), assistant([text('hello')])] }), 'gateway', modelOf(route(), 'm'), new Map(),
    ).map(message => message.role)).toEqual(['user', 'assistant'])
  })
})

/** One assistant message source carrying adapter-private replay metadata. */
const modelSource = (blocks: unknown[], provider = 'gateway', model = 'm'): ModelMessageSource => ({
  kind: 'model',
  provider,
  model,
  replayState: { response: { kind: 'llm-service-lite-anthropic', version: 1 }, blocks },
})

describe('anthropic-messages reasoning replay', () => {
  const profile = route()

  /** The assistant content one replayed turn produces. */
  const replayed = (content: ContentBlock[], source: ModelMessageSource): unknown =>
    messagesOf(profile, { messages: [assistant(content, source)] })[0]?.content

  it('returns a signed thinking block unchanged', () => {
    expect(replayed(
      [{ type: 'reasoning', text: 'weighing' }, text('answer')],
      modelSource([{ type: 'reasoning', signature: 'sig-1' }, { type: 'text' }]),
    )).toEqual([{ type: 'thinking', thinking: 'weighing', signature: 'sig-1' }, { type: 'text', text: 'answer' }])
  })

  it('returns a redacted block as the provider issued it', () => {
    expect(replayed([{ type: 'reasoning', text: '' }], modelSource([{ type: 'reasoning', redacted: 'opaque' }])))
      .toEqual([{ type: 'redacted_thinking', data: 'opaque' }])
  })

  it('leaves out reasoning no signature covers', () => {
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'unsigned' }, text('answer')]
    for (const source of [
      { kind: 'model', provider: 'gateway', model: 'm' } as ModelMessageSource,
      modelSource([{ type: 'reasoning' }, { type: 'text' }]),
      modelSource([{ type: 'reasoning', signature: '' }, { type: 'text' }]),
    ]) {
      expect(replayed(content, source)).toEqual([{ type: 'text', text: 'answer' }])
    }
  })

  it('degrades replay metadata it cannot align with the content', () => {
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'x' }, text('answer')]
    for (const blocks of [
      [{ type: 'text' }],
      [{ type: 'reasoning', signature: 'a' }, { type: 'reasoning' }],
      [{ type: 'tool-call' }, { type: 'text' }],
      [{ type: 'reasoning', signature: 42 }, { type: 'text' }],
      [null, { type: 'text' }],
    ]) {
      expect(replayed(content, modelSource(blocks))).toEqual([{ type: 'text', text: 'answer' }])
    }
  })

  it('ignores metadata another provider, model, or adapter wrote', () => {
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'x' }]
    expect(replayed(content, modelSource([{ type: 'reasoning', signature: 'a' }], 'elsewhere')))
      .toEqual([{ type: 'text', text: '[context trimmed]' }])
    expect(replayed(content, modelSource([{ type: 'reasoning', signature: 'a' }], 'gateway', 'other')))
      .toEqual([{ type: 'text', text: '[context trimmed]' }])
    const foreign: ModelMessageSource = {
      kind: 'model',
      provider: 'gateway',
      model: 'm',
      replayState: { response: { kind: 'pi-ai', version: 2 }, blocks: [] },
    }
    expect(replayed(content, foreign)).toEqual([{ type: 'text', text: '[context trimmed]' }])
  })

  it('reads an envelope only through its own vocabulary', () => {
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'x' }]
    const aligned = assistant(content, {
      replayState: { response: { kind: 'llm-service-lite-anthropic', version: 1 }, blocks: [{ type: 'reasoning', signature: 's' }] },
    })
    expect(replayBlocksOf(aligned, 'gateway', 'm')).toEqual([{ type: 'reasoning', signature: 's' }])
    const wrongVersion = assistant(content, {
      replayState: { response: { kind: 'llm-service-lite-anthropic', version: 2 }, blocks: [{ type: 'reasoning', signature: 's' }] },
    })
    expect(replayBlocksOf(wrongVersion, 'gateway', 'm')).toBeUndefined()
    expect(replayBlocksOf(assistant(content, { replayState: 'not an envelope' }), 'gateway', 'm'))
      .toBeUndefined()
    // A response half that is not an object, and an envelope without one, are
    // both unusable rather than partially trusted.
    for (const response of [[], null, 'anthropic', 7]) {
      const malformed = assistant(content, {
        replayState: { response, blocks: [{ type: 'reasoning', signature: 's' }] },
      })
      expect(replayBlocksOf(malformed, 'gateway', 'm')).toBeUndefined()
    }
    expect(replayBlocksOf(assistant(content, { replayState: { blocks: [] } }), 'gateway', 'm'))
      .toBeUndefined()
    expect(replayBlocksOf(assistant(content, {}), 'gateway', 'm')).toBeUndefined()
  })

  it('skips the blocks of an assistant turn this protocol cannot carry', () => {
    expect(replayed(
      [text(''), image('sha256:x'), text('answer')],
      modelSource([{ type: 'text' }, { type: 'text' }, { type: 'text' }]),
    )).toEqual([{ type: 'text', text: 'answer' }])
  })
})

describe('anthropic-messages mid-history changes', () => {
  /** One resolved route whose single model declares the given capabilities. */
  const routeWith = (capabilities: Record<string, unknown>): ResolvedOwcProviderProfile => route({
    models: [{ id: 'm', contextWindow: 8192, maxTokens: 1024, capabilities }],
  })

  it('carries a declared tool change as the system message this protocol reserves', () => {
    const profile = routeWith({ toolUpdate: 'in-history' })
    expect(messagesOf(profile, {
      messages: [
        user([text('hi')]),
        developerWith([text('two tools changed'), toolAddition('shell'), toolRemoval('browser')]),
        assistant([text('ok')]),
      ],
    })).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'system',
        content: [
          { type: 'text', text: 'two tools changed' },
          { type: 'tool_addition', tool: { type: 'tool_reference', name: 'shell' } },
          { type: 'tool_removal', tool: { type: 'tool_reference', name: 'browser' } },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ])
  })

  it('places a prompt snapshot after the user turn it instructs', () => {
    const profile = routeWith({ systemPromptUpdate: 'in-history' })
    const messages = messagesOf(profile, {
      messages: [
        user([text('hi')]), assistant([text('a')]), system('new instructions'), user([text('next')]),
      ],
    })
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'system'])
    expect(messages[3]?.content).toEqual([{ type: 'text', text: 'new instructions' }])
  })

  it('keeps the leading system message in the top-level prompt field', () => {
    const profile = routeWith({ systemPromptUpdate: 'in-history' })
    const body = bodyOf(profile, { messages: [system('base'), user([text('hi')])] })
    expect(body['system']).toBe('base')
    expect(body['messages']).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('queues nothing for a mid-history message that carries nothing', () => {
    const profile = routeWith({ toolUpdate: 'addition-only' })
    expect(messagesOf(profile, {
      messages: [user([text('hi')]), developerWith([text('')])],
    })).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('refuses a mid-history change with no user turn to follow', () => {
    const profile = routeWith({ toolUpdate: 'in-history' })
    expect(() => messagesOf(profile, {
      messages: [user([text('hi')]), assistant([text('a')]), developerWith([toolAddition('shell')])],
    })).toThrow(/no preceding user turn/)
  })

  it('refuses a tool change on a role this protocol has no part for', () => {
    const profile = routeWith({ toolUpdate: 'addition-only' })
    expect(() => messagesOf(profile, {
      messages: [user([text('hi')]), user([toolAddition('shell')])],
    })).toThrow(/belong to developer messages/)
  })

  it('refuses a mid-history block the system role cannot carry', () => {
    const profile = routeWith({ systemPromptUpdate: 'in-history' })
    expect(() => messagesOf(profile, {
      messages: [user([text('hi')]), developerWith([image('sha256:x')])],
    })).toThrow(/reads only as prompt text or a tool reference/)
  })

  it('defers a declaration the harness marked, and leaves the rest immediate', () => {
    const profile = routeWith({ toolUpdate: 'addition-only' })
    const body = bodyOf(profile, {
      tools: [{ ...toolSchema('shell'), deferLoading: true }, toolSchema('read')],
    })
    expect(body['tools']).toEqual([
      { name: 'shell', description: 'run shell', input_schema: { type: 'object', properties: {} }, defer_loading: true },
      { name: 'read', description: 'run read', input_schema: { type: 'object', properties: {} } },
    ])
  })
})
