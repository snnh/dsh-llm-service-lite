import { describe, expect, it } from 'vitest'
import { convertOfficialProvider } from '../src/official-catalog.ts'

/** One official provider file: two chat models under one protocol. */
const official = (entries: Record<string, unknown>, api = 'openai-completions'): Record<string, unknown> => ({
  [api]: entries,
})

describe('official catalog conversion', () => {
  it('converts the protocol, endpoint, headers, and chat models of an official file', () => {
    const { profile, diagnostics } = convertOfficialProvider(official({
      'chat:m': {
        id: 'm',
        name: 'Model M',
        api: 'openai-completions',
        baseUrl: 'https://official.test/v1',
        headers: { 'user-agent': 'OfficialCLI/1.0' },
        input: ['text', 'image'],
        reasoning: true,
        thinkingLevelMap: { off: null, low: 'low', medium: null, high: 'high' },
        contextWindow: 131072,
        maxTokens: 8192,
      },
    }), 'route')
    expect(profile).toEqual({
      interfaceType: 'openai-chat-completions',
      baseURL: 'https://official.test/v1',
      headers: { 'user-agent': 'OfficialCLI/1.0' },
      models: [{
        id: 'm',
        name: 'Model M',
        contextWindow: 131072,
        maxTokens: 8192,
        capabilities: { modalities: ['text', 'image'], effort: ['low', 'high'], thinking: ['enabled'] },
      }],
    })
    expect(diagnostics).toEqual([])
  })

  it('maps each served protocol, and refuses one this adapter does not serve', () => {
    const responses = convertOfficialProvider(official({ 'chat:m': { id: 'm', api: 'openai-responses' } }, 'openai-responses'), 'route')
    expect(responses.profile.interfaceType).toBe('openai-responses')
    const messages = convertOfficialProvider(official({ 'chat:m': { id: 'm', api: 'anthropic-messages' } }, 'anthropic-messages'), 'route')
    expect(messages.profile.interfaceType).toBe('anthropic-messages')
    expect(() => convertOfficialProvider(official({ 'chat:m': { id: 'm', api: 'mistral-conversations' } }, 'mistral-conversations'), 'route'))
      .toThrow(/names api "mistral-conversations"/)
  })

  it('reads the model id from the catalog key when the entry states none', () => {
    const { profile } = convertOfficialProvider(official({ 'chat:key-only': { name: 'Key Only' } }), 'route')
    expect(profile.models).toEqual([{ id: 'key-only', name: 'Key Only' }])
  })

  it('reports every model type this adapter does not serve, and keeps the chat models', () => {
    const { profile, diagnostics } = convertOfficialProvider(official({
      'chat:m': { id: 'm' },
      'image:gpt-image': { id: 'gpt-image', type: 'image' },
      'classifier:guard': { id: 'guard', type: 'classifier' },
    }), 'route')
    expect(profile.models.map(model => model.id)).toEqual(['m'])
    expect(diagnostics).toEqual([
      'llm-service-lite: provider "route" catalog entry "image:gpt-image" is a image model, which this adapter does not serve',
      'llm-service-lite: provider "route" catalog entry "classifier:guard" is a classifier model, which this adapter does not serve',
    ])
  })

  it('refuses a file that is not one API-keyed map, or that mixes protocols', () => {
    expect(() => convertOfficialProvider([], 'route')).toThrow(/is not an object/)
    expect(() => convertOfficialProvider({ 'openai-completions': 'nope' }, 'route')).toThrow(/group "openai-completions" is not an object/)
    expect(() => convertOfficialProvider({ ...official({ 'chat:m': { id: 'm' } }), ...official({ 'chat:n': { id: 'n' } }, 'openai-responses') }, 'route'))
      .toThrow(/mixes apis openai-completions and openai-responses/)
    expect(() => convertOfficialProvider({ 'openai-completions': {} }, 'route')).toThrow(/carries no chat model/)
  })

  it('refuses entries that disagree about the endpoint, and reports headers one route cannot carry', () => {
    expect(() => convertOfficialProvider(official({
      'chat:a': { id: 'a', baseUrl: 'https://one.test/v1' },
      'chat:b': { id: 'b', baseUrl: 'https://two.test/v1' },
    }), 'route')).toThrow(/names 2 endpoints/)
    const { diagnostics } = convertOfficialProvider(official({
      'chat:a': { id: 'a', headers: { 'x-tenant': 'one' } },
      'chat:b': { id: 'b', headers: { 'x-tenant': 'two' } },
    }), 'route')
    expect(diagnostics).toContain('llm-service-lite: provider "route" catalog models declare different headers, which one route cannot carry')
  })

  it('reports the input modalities this adapter has no part for', () => {
    const { profile, diagnostics } = convertOfficialProvider(official({
      'chat:m': { id: 'm', input: ['text', 'video', 'audio'] },
    }), 'route')
    expect(profile.models[0]?.capabilities).toEqual({ modalities: ['text'] })
    expect(diagnostics.filter(line => line.includes('modality'))).toEqual([
      'llm-service-lite: provider "route" catalog input modality "video" is not carried',
      'llm-service-lite: provider "route" catalog input modality "audio" is not carried',
    ])
  })

  it('turns sampling parameters into request defaults, and reports the ones that do not map', () => {
    const { profile, diagnostics } = convertOfficialProvider(official({
      'chat:m': { id: 'm', samplingParams: { temperature: 0.2, top_p: 0.9, top_k: 40, min_p: 0.05 } },
    }), 'route')
    expect(profile.models[0]?.defaults).toEqual({ temperature: 0.2, topP: 0.9, topK: 40 })
    expect(diagnostics).toContain(
      'llm-service-lite: provider "route" catalog sampling parameter "min_p" is not carried;'
      + " only temperature, top_p, and top_k map onto a model's defaults",
    )
  })

  it('reports sampling parameters on the protocol that ignores them', () => {
    const { profile, diagnostics } = convertOfficialProvider(official({
      'chat:m': { id: 'm', api: 'anthropic-messages', samplingParams: { temperature: 0.2 } },
    }, 'anthropic-messages'), 'route')
    expect(profile.models[0]?.defaults).toBeUndefined()
    expect(diagnostics).toContain(
      'llm-service-lite: provider "route" catalog sampling parameters are not carried on anthropic-messages;'
      + ' that protocol ignores them',
    )
  })

  it('carries the mid-history compat flags the Messages protocol declares, and reports the rest', () => {
    const anthropic = convertOfficialProvider(official({
      'chat:m': {
        id: 'm',
        api: 'anthropic-messages',
        compat: {
          supportsMidConvoSystemMessages: true,
          supportsMidConvoToolAdditions: true,
          thinkingFormat: 'anthropic',
          maxTokensField: 'max_tokens',
          supportsStore: false,
        },
      },
    }, 'anthropic-messages'), 'route')
    expect(anthropic.profile.models[0]?.capabilities).toEqual({
      systemPromptUpdate: 'in-history',
      toolUpdate: 'addition-only',
    })
    expect(anthropic.diagnostics).toEqual([
      'llm-service-lite: provider "route" catalog compat flag "thinkingFormat" is not carried;'
      + ' declare the capability on the profile',
      'llm-service-lite: provider "route" catalog compat flag "maxTokensField" is not carried;'
      + ' declare the capability on the profile',
    ])
    // The same flag on another protocol is reported rather than written: only
    // the Messages wire carries a mid-history message.
    const chat = convertOfficialProvider(official({
      'chat:m': { id: 'm', compat: { supportsMidConvoSystemMessages: true } },
    }), 'route')
    expect(chat.profile.models[0]?.capabilities).toBeUndefined()
    expect(chat.diagnostics).toContain(
      'llm-service-lite: provider "route" catalog compat flag "supportsMidConvoSystemMessages" is not carried;'
      + ' declare the capability on the profile',
    )
  })

  it('reports every official field this adapter has no counterpart for', () => {
    const { profile, diagnostics } = convertOfficialProvider(official({
      'chat:a': {
        id: 'a',
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
        inputLimits: { images: { resize: { maxWidth: 2000 } } },
        promptCache: { retention: 'short' },
        samplingParamsByThinkingLevel: { high: { temperature: 0.7 } },
        unknownVendorField: true,
      },
    }), 'route')
    expect(profile.models[0]).toEqual({ id: 'a' })
    expect(diagnostics).toEqual([
      'llm-service-lite: provider "route" catalog field "cost" is not carried',
      'llm-service-lite: provider "route" catalog field "inputLimits" is not carried',
      'llm-service-lite: provider "route" catalog field "promptCache" is not carried',
      'llm-service-lite: provider "route" catalog field "samplingParamsByThinkingLevel" is not carried',
      'llm-service-lite: provider "route" catalog field "unknownVendorField" is not carried',
    ])
  })

  it('reads the fields an official file may state in a shape this adapter cannot use', () => {
    const { profile, diagnostics } = convertOfficialProvider(official({
      'chat:loose': {
        id: 'loose',
        input: 'text',
        reasoning: true,
        thinkingLevelMap: 'high',
        samplingParams: 'temperature=0.2',
      },
    }), 'route')
    expect(profile.models).toEqual([{ id: 'loose', capabilities: { thinking: ['enabled', 'disabled'] } }])
    expect(diagnostics).toEqual([])
  })

  it('keeps one modality once, and reports a repeated one as declared', () => {
    const { profile } = convertOfficialProvider(official({
      'chat:m': { id: 'm', input: ['text', 'text', 'image'] },
    }), 'route')
    expect(profile.models[0]?.capabilities).toEqual({ modalities: ['text', 'image'] })
  })

  it('carries no defaults when every sampling parameter is one it cannot map', () => {
    const { profile } = convertOfficialProvider(official({
      'chat:m': { id: 'm', samplingParams: { min_p: 0.05 } },
    }), 'route')
    expect(profile.models[0]?.defaults).toBeUndefined()
  })

  it('leaves headers off a route whose official file states none, and off one that disagrees', () => {
    const bare = convertOfficialProvider(official({ 'chat:m': { id: 'm' } }), 'route')
    expect(bare.profile.headers).toBeUndefined()
    const mixed = convertOfficialProvider(official({
      'chat:m': { id: 'm', headers: { 'x-tenant': 'one' } },
      'chat:n': { id: 'n', headers: { 'x-tenant': 'two' } },
    }), 'route')
    expect(mixed.profile.headers).toBeUndefined()
  })

  it('counts one loss once, naming how many models carry it', () => {
    const { diagnostics } = convertOfficialProvider(official({
      'chat:a': { id: 'a', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      'chat:b': { id: 'b', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    }), 'route')
    expect(diagnostics).toEqual([
      'llm-service-lite: provider "route" catalog field "cost" is not carried (2 models)',
    ])
  })

  it('reads a compat flag a model turns off as nothing to carry', () => {
    const { profile, diagnostics } = convertOfficialProvider(official({
      'chat:m': {
        id: 'm',
        api: 'anthropic-messages',
        compat: { supportsStore: false, untouched: undefined, supportsMidConvoToolAdditions: false },
      },
    }, 'anthropic-messages'), 'route')
    expect(profile.models[0]?.capabilities).toBeUndefined()
    expect(diagnostics).toEqual([])
  })

  it('reports an official chat entry that names no model id', () => {
    expect(() => convertOfficialProvider({ 'openai-completions': { 'chat:': { name: 'nameless' } } }, 'route'))
      .toThrow(/names no model id/)
    expect(() => convertOfficialProvider({ 'openai-completions': { 'chat:m': 'nope' } }, 'route'))
      .toThrow(/entry "chat:m" is not an object/)
  })

  it('keeps a model that declares an explicit thinking switch, and one that thinks unconditionally', () => {
    const { profile } = convertOfficialProvider(official({
      'chat:switchable': { id: 'switchable', reasoning: true, thinkingLevelMap: { off: 'none', low: 'low' } },
      'chat:always': { id: 'always', reasoning: true, thinkingLevelMap: { off: null, high: 'high' } },
      'chat:plain': { id: 'plain', reasoning: false },
    }), 'route')
    expect(profile.models).toEqual([
      { id: 'switchable', capabilities: { effort: ['low'], thinking: ['enabled', 'disabled'] } },
      { id: 'always', capabilities: { effort: ['high'], thinking: ['enabled'] } },
      { id: 'plain' },
    ])
  })
})
