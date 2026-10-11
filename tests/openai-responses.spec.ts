import { describe, expect, it } from 'vitest'
import { replayBlocksOf, responsesRequest, toResponsesInput } from '../src/openai-responses.ts'
import type { ContentBlock, GenerateOptions, ModelMessageSource } from '@deepseek-ai/dsh-llm'
import type { ResolvedOwcModel, ResolvedOwcProviderProfile } from '../src/profiles.ts'
import { resolveProfiles } from '../src/profiles.ts'
import {
  assistant, developer, image, request, requestImage, system, text, toolCall, toolResult, toolResultWith, toolSchema, user,
} from './messages.ts'

/** One resolved route from the real schema. */
const route = (overrides: Record<string, unknown> = {}): ResolvedOwcProviderProfile => {
  const profile = resolveProfiles({
    gateway: {
      interfaceType: 'openai-responses',
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
  versions: Parameters<typeof responsesRequest>[4] = new Map(),
): Record<string, unknown> => JSON.parse(
  responsesRequest(profile, modelOf(profile), options(overrides), undefined, versions).body,
) as Record<string, unknown>

/** One input item of a translated body. */
interface InputItem {
  type?: string
  role?: string
  content?: Array<Record<string, unknown>>
  call_id?: string
  name?: string
  arguments?: string
  output?: string
  id?: string
}

/** The translated input items of one request. */
const inputOf = (
  profile: ResolvedOwcProviderProfile,
  overrides: Partial<GenerateOptions> = {},
  versions: Parameters<typeof responsesRequest>[4] = new Map(),
): InputItem[] => bodyOf(profile, overrides, versions)['input'] as InputItem[]

describe('openai-responses request', () => {
  it('addresses the protocol default endpoint and its own path', () => {
    expect(responsesRequest(route(), modelOf(route()), options(), undefined).url)
      .toBe('https://gateway.test/v1/responses')
    const fallback = resolveProfiles({ g: { interfaceType: 'openai-responses' } }).get('g')
    if (fallback === undefined) throw new Error('the default route did not resolve')
    expect(responsesRequest(fallback, modelOf(route()), options(), undefined).url)
      .toBe('https://api.openai.com/v1/responses')
  })

  it('authenticates with the bearer header this protocol reads', () => {
    const profile = route({ headers: { 'x-gateway': 'one' } })
    expect(responsesRequest(profile, modelOf(profile), options(), 'sk-key').headers).toMatchObject({
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: 'Bearer sk-key',
      'x-gateway': 'one',
    })
    for (const key of [undefined, '']) {
      expect(responsesRequest(profile, modelOf(profile), options(), key).headers).not.toHaveProperty('authorization')
    }
  })

  it('always streams, and raises the cap to the floor this API enforces', () => {
    expect(bodyOf(route())).toMatchObject({ model: 'm', stream: true, max_output_tokens: 1024 })
    expect(bodyOf(route({ models: [{ id: 'm', maxTokens: 4 }] }))).toMatchObject({ max_output_tokens: 16 })
    expect(bodyOf(route(), { maxTokens: 64 })).toMatchObject({ max_output_tokens: 64 })
    // A cap below the floor is raised rather than refused, even from the request.
    expect(bodyOf(route(), { maxTokens: 8 })).toMatchObject({ max_output_tokens: 16 })
  })

  it('sends sampling only where reasoning does not reject it', () => {
    expect(bodyOf(route(), { temperature: 0.4 })).toMatchObject({ temperature: 0.4 })
    const reasoningRoute = route({ models: [{ id: 'm', capabilities: { effort: ['high'] } }] })
    expect(bodyOf(reasoningRoute, { temperature: 0.4, reasoningEffort: 'high' as never }))
      .not.toHaveProperty('temperature')
  })

  it('writes a model\'s declared request parameters where the caller stated none', () => {
    const profile = route({
      models: [{ id: 'm', contextWindow: 8192, maxTokens: 1024, defaults: { temperature: 0.2, topP: 0.6, maxTokens: 256 } }],
    })
    expect(bodyOf(profile)).toMatchObject({ temperature: 0.2, top_p: 0.6, max_output_tokens: 256 })
    expect(bodyOf(profile, { temperature: 0.9, maxTokens: 64 })).toMatchObject({
      temperature: 0.9,
      top_p: 0.6,
      max_output_tokens: 64,
    })
    // Reasoning still owns the sampling decision: a declared default is not
    // written where this API answers a temperature with a 400.
    const reasoning = route({ models: [{ id: 'm', capabilities: { effort: ['high'] }, defaults: { temperature: 0.2, topP: 0.6 } }] })
    expect(bodyOf(reasoning, { reasoningEffort: 'high' as never }))
      .not.toHaveProperty('temperature')
    expect(bodyOf(reasoning, { reasoningEffort: 'high' as never })).not.toHaveProperty('top_p')
  })

  it('reads the instructions from the request, else from the leading system message', () => {
    expect(bodyOf(route())).not.toHaveProperty('instructions')
    expect(bodyOf(route(), { system: 'be brief' })).toMatchObject({ instructions: 'be brief' })
    expect(bodyOf(route(), { system: '' })).not.toHaveProperty('instructions')
    const leading = { messages: [system('from history'), user([text('hi')])] }
    expect(bodyOf(route(), leading)).toMatchObject({
      instructions: 'from history',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    })
    expect(bodyOf(route(), { messages: [system(''), user([text('hi')])] })).not.toHaveProperty('instructions')
  })

  it('sends tool declarations in this protocol flat shape, unless the model refuses them', () => {
    const tools = { tools: [toolSchema('shell')] }
    expect(bodyOf(route(), tools)['tools']).toEqual([{
      type: 'function',
      name: 'shell',
      description: 'run shell',
      parameters: { type: 'object', properties: {} },
    }])
    expect(bodyOf(route())).not.toHaveProperty('tools')
    expect(bodyOf(route(), { tools: [] })).not.toHaveProperty('tools')
    const noTools = route({ models: [{ id: 'm', capabilities: { tools: false } }] })
    expect(bodyOf(noTools, tools)).not.toHaveProperty('tools')
  })

  it('spells the selected reasoning level as this protocol does', () => {
    const efforts = route({ models: [{ id: 'm', capabilities: { effort: ['low', 'high'] } }] })
    expect(bodyOf(efforts)).not.toHaveProperty('reasoning')
    expect(bodyOf(efforts, { reasoningEffort: 'high' as never })).toMatchObject({
      reasoning: { effort: 'high', summary: 'auto' },
    })
    // A mode-only selection has no spelling here: the endpoint's own default applies.
    const modes = route({ models: [{ id: 'm', capabilities: { thinking: ['adaptive', 'disabled'] } }] })
    expect(bodyOf(modes, { reasoningEffort: 'adaptive' as never })).not.toHaveProperty('reasoning')
    // Disabling thinking is expressible for a model that declares a spellable switch.
    const switchable = route({ models: [{ id: 'm', capabilities: { thinking: ['disabled'], thinkingStyle: 'thinking' } }] })
    expect(bodyOf(switchable, { reasoningEffort: 'disabled' as never })).toMatchObject({ reasoning: { effort: 'none' } })
    const styleless = route({ models: [{ id: 'm', capabilities: { thinking: ['disabled'] } }] })
    expect(bodyOf(styleless, { reasoningEffort: 'disabled' as never })).not.toHaveProperty('reasoning')
    expect(bodyOf(route({ models: [{ id: 'm', capabilities: { effort: ['ultra'] } }] }), { reasoningEffort: 'nope' as never }))
      .not.toHaveProperty('reasoning')
  })

  it('asks for encrypted reasoning only where the model declares it', () => {
    const encrypted = route({
      models: [{ id: 'm', capabilities: { effort: ['high'], responsesEncryptedReplay: true } }],
    })
    expect(bodyOf(encrypted, { reasoningEffort: 'high' as never })).toMatchObject({
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    })
    const plain = route({ models: [{ id: 'm', capabilities: { effort: ['high'] } }] })
    expect(bodyOf(plain, { reasoningEffort: 'high' as never })).not.toHaveProperty('include')
    // No reasoning request means nothing to ask an encrypted payload for.
    expect(bodyOf(encrypted)).not.toHaveProperty('include')
  })

  it('lays profile extra body fields under the fields the adapter owns', () => {
    const profile = route({ extraBody: { store: false, max_output_tokens: 512 } })
    expect(bodyOf(profile, { maxTokens: 64 })).toMatchObject({ store: false, max_output_tokens: 64 })
  })
})

describe('openai-responses input mapping', () => {
  const profile = route()

  it('maps a user turn to one message item and skips what it cannot carry', () => {
    expect(inputOf(profile, { messages: [user([text('hi')]), user([]), user([text('')])] })).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ])
    expect(inputOf(profile, { messages: [user([{ type: 'tool-addition', toolName: 'shell' }])] })).toEqual([])
  })

  it('folds a later system or developer message into a user item where it stands', () => {
    expect(inputOf(profile, { messages: [user([text('hi')]), developer('tool X is available'), system('late notice')] }))
      .toEqual([
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tool X is available' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'late notice' }] },
      ])
    expect(inputOf(profile, { messages: [developer(''), system('')] })).toEqual([])
  })

  it('resolves an image to its prepared bytes, and an offloaded one to text', () => {
    const items = inputOf(profile, { messages: [user([text('look'), image('sha256:x'), image('sha256:x', {}, true)])] },
      new Map([['sha256:x', requestImage('abc')]]))
    expect(items[0]?.content?.slice(0, 2)).toEqual([
      { type: 'input_text', text: 'look' },
      { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,YWJj' },
    ])
    expect(items[0]?.content?.[2]?.text).toContain('sha256:x')
  })

  it('refuses a retained image with no prepared request version', () => {
    expect(() => inputOf(profile, { messages: [user([image('sha256:x')])] }))
      .toThrow(/without a prepared request version/)
  })

  it('drops a result whose call the history never declared', () => {
    expect(inputOf(profile, { messages: [user([text('hi')]), toolResult('call_orphan', 'stray')] }))
      .toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
  })

  it('pairs a call with its result and drops a call nothing answered', () => {
    expect(inputOf(profile, {
      messages: [
        assistant([toolCall('call_a', 'shell', '{"cmd":"ls"}'), toolCall('call_b', 'read', '{}')], {}, 'a1'),
        toolResult('call_a', 'listed'),
      ],
    })).toEqual([
      { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'listed' },
    ])
  })

  it('declares a repeated call id once, in its first turn', () => {
    expect(inputOf(profile, {
      messages: [
        assistant([toolCall('call_a', 'shell', '{}'), toolCall('call_a', 'shell', '{}')], {}, 'a1'),
        toolResult('call_a', 'first'),
        toolResult('call_a', 'second'),
        assistant([toolCall('call_a', 'read', '{}')], {}, 'a2'),
      ],
    })).toEqual([
      { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'first' },
    ])
  })

  it('groups one batch as every call, then every result', () => {
    expect(inputOf(profile, {
      messages: [
        assistant([toolCall('call_a', 'shell', '{}'), toolCall('call_b', 'read', '{}')]),
        toolResult('call_a', 'first'),
        toolResult('call_b', 'second'),
      ],
    })).toEqual([
      { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{}' },
      { type: 'function_call', call_id: 'call_b', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'first' },
      { type: 'function_call_output', call_id: 'call_b', output: 'second' },
    ])
  })

  it('carries the media a tool result produced as one user item after its batch', () => {
    expect(inputOf(profile, {
      messages: [
        assistant([toolCall('call_a', 'read_media', '{}')]),
        toolResultWith('call_a', [text('the picture'), image('sha256:x')]),
      ],
    }, new Map([['sha256:x', requestImage('abc')]]))).toEqual([
      { type: 'function_call', call_id: 'call_a', name: 'read_media', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'the picture' },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Attached media from tool result:' },
          { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,YWJj' },
        ],
      },
    ])
  })

  it('maps an assistant turn that declared only text', () => {
    expect(inputOf(profile, { messages: [assistant([text('hello')], {}, 'a1')] }))
      .toEqual([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }])
  })
})

/** One assistant message source carrying adapter-private replay metadata. */
const modelSource = (
  blocks: unknown[],
  extra: { provider?: string; model?: string; content?: ContentBlock[] } = {},
): ModelMessageSource => ({
  kind: 'model',
  provider: extra.provider ?? 'gateway',
  model: extra.model ?? 'm',
  replayState: { response: { kind: 'llm-service-lite-responses', version: 1 }, blocks },
})

describe('openai-responses replay', () => {
  const profile = route({ models: [{ id: 'm', capabilities: { reasoningContent: true } }] })

  it('replays reasoning text ahead of the message it belongs to', () => {
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'weighing' }, text('answer')]
    expect(inputOf(profile, { messages: [assistant(content, modelSource([{ type: 'reasoning' }, { type: 'text' }]))] }))
      .toEqual([
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'weighing' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [] }] },
      ])
  })

  it('hands back the item identities it was given', () => {
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'weighing' }, text('answer'), toolCall('call_a', 'shell', '{}')]
    expect(inputOf(profile, {
      messages: [
        assistant(content, modelSource([
          { type: 'reasoning', itemId: 'rs_1' },
          { type: 'text', itemId: 'msg_1' },
          { type: 'tool-call', itemId: 'fc_1' },
        ])),
        toolResult('call_a', 'done'),
      ],
    })).toEqual([
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'weighing' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [] }], id: 'msg_1' },
      { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{}', id: 'fc_1' },
      { type: 'function_call_output', call_id: 'call_a', output: 'done' },
    ])
  })

  it('replays a provider reasoning item verbatim where the model declares encrypted replay', () => {
    const encrypted = route({
      models: [{ id: 'm', capabilities: { reasoningContent: true, responsesEncryptedReplay: true } }],
    })
    const original = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] }
    expect(inputOf(encrypted, {
      messages: [assistant([{ type: 'reasoning', text: 'weighing' }, text('answer')], modelSource([
        { type: 'reasoning', itemId: 'rs_1', item: JSON.stringify(original) },
        { type: 'text' },
      ]))],
    })[0]).toEqual(original)
  })

  it('falls back to the text form when an encrypted item cannot be read', () => {
    const encrypted = route({
      models: [{ id: 'm', capabilities: { reasoningContent: true, responsesEncryptedReplay: true } }],
    })
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'weighing' }]
    for (const item of ['not json', '[]', '{"type":"message"}', '{"type":"reasoning"}']) {
      expect(inputOf(encrypted, {
        messages: [assistant(content, modelSource([{ type: 'reasoning', item }]))],
      })[0]).toEqual(item === '{"type":"reasoning"}'
        ? { type: 'reasoning' }
        : { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'weighing' }] })
    }
  })

  it('leaves reasoning out where the model declares no replay at all', () => {
    const silent = route({ models: [{ id: 'm' }] })
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'weighing' }, text('answer')]
    expect(inputOf(silent, { messages: [assistant(content, modelSource([{ type: 'reasoning' }, { type: 'text' }]))] }))
      .toEqual([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [] }] }])
    // Empty reasoning text contributes no item either.
    expect(inputOf(profile, { messages: [assistant([{ type: 'reasoning', text: '' }], modelSource([{ type: 'reasoning' }]))] }))
      .toEqual([])
  })

  it('takes no identity from metadata another provider, model, or adapter wrote', () => {
    // The text form needs no metadata at all — this protocol replays reasoning
    // text as plain text — so an unusable envelope costs the identity, never
    // the reasoning itself.
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'weighing' }]
    for (const source of [
      modelSource([{ type: 'reasoning', itemId: 'rs_1' }], { provider: 'elsewhere' }),
      modelSource([{ type: 'reasoning', itemId: 'rs_1' }], { model: 'other' }),
      { kind: 'model', provider: 'gateway', model: 'm' } as ModelMessageSource,
      { kind: 'model', provider: 'gateway', model: 'm', replayState: 'not an envelope' } as ModelMessageSource,
      modelSource([{ type: 'text' }]),
      modelSource([{ type: 'reasoning', itemId: 7 }]),
      modelSource([null]),
    ]) {
      expect(inputOf(profile, { messages: [assistant(content, source)] }))
        .toEqual([{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'weighing' }] }])
    }
  })

  it('reads an envelope only through its own vocabulary', () => {
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'x' }]
    const aligned = assistant(content, modelSource([{ type: 'reasoning', itemId: 'rs_1' }]))
    expect(replayBlocksOf(aligned, 'gateway', 'm')).toEqual([{ type: 'reasoning', itemId: 'rs_1' }])
    const wrongVersion = assistant(content, {
      replayState: { response: { kind: 'llm-service-lite-responses', version: 2 }, blocks: [{ type: 'reasoning' }] },
    })
    expect(replayBlocksOf(wrongVersion, 'gateway', 'm')).toBeUndefined()
    for (const response of [undefined, [], 'x']) {
      const malformed = assistant(content, { replayState: { response, blocks: [{ type: 'reasoning' }] } })
      expect(replayBlocksOf(malformed, 'gateway', 'm')).toBeUndefined()
    }
    const noBlocks = assistant(content, { replayState: { response: { kind: 'llm-service-lite-responses', version: 1 } } })
    expect(replayBlocksOf(noBlocks, 'gateway', 'm')).toBeUndefined()
  })

  it('replays a call whose arguments the model never finished writing', () => {
    const content: ContentBlock[] = [toolCall('call_a', 'shell', 'not json'), { type: 'text', text: '' }]
    expect(inputOf(profile, {
      messages: [
        assistant(content, modelSource([{ type: 'tool-call' }, { type: 'text' }]), 'a1'),
        toolResult('call_a', 'done'),
      ],
    })[0]).toMatchObject({ arguments: 'not json' })
  })
})

describe('openai-responses item mapping', () => {
  it('keeps the caller\'s turn order across roles', () => {
    expect(toResponsesInput(
      options({ messages: [user([text('hi')]), assistant([text('hello')])] }), 'gateway', modelOf(route()), new Map(),
    ).map(item => item.type)).toEqual(['message', 'message'])
  })
  it('falls back to the text form when there is no item to hand back', () => {
    const encrypted = route({
      models: [{ id: 'm', capabilities: { reasoningContent: true, responsesEncryptedReplay: true } }],
    })
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'weighing' }]
    // An entry without an item, an entry of another kind, and a message with no
    // usable metadata all degrade to the plain-text form.
    for (const source of [
      modelSource([{ type: 'reasoning' }]),
      modelSource([{ type: 'text' }]),
      { kind: 'model', provider: 'gateway', model: 'm' } as ModelMessageSource,
    ]) {
      expect(inputOf(encrypted, { messages: [assistant(content, source)] }))
        .toEqual([{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'weighing' }] }])
    }
  })
})
