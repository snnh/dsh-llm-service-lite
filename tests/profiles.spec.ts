import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../src/config.ts'
import { assertServiceable, modelOf, registrationFacts, resolveProfiles, serviceableRoutes } from '../src/profiles.ts'
import type { Options } from '../src/config.ts'

/** One route declaration through the real schema, with the caller's fields layered on. */
const configured = (profile: Record<string, unknown>): Options['providers'] =>
  Config({
    providers: {
      gateway: {
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://gateway.test/v1',
        ...profile,
      },
    },
  }).providers.get() as unknown as Options['providers']

/** Resolve one route declaration and return it, failing the test when it is refused. */
const resolved = (profile: Record<string, unknown>) => {
  const profiles = resolveProfiles(configured(profile))
  const entry = profiles.get('gateway')
  if (entry === undefined) throw new Error('the route did not resolve')
  return entry
}

/**
 * Resolve a declaration that names no protocol of its own, which is what lets
 * a catalog supply one.
 */
const resolvedCatalog = (profile: Record<string, unknown>) => {
  const profiles = resolveProfiles(Config({ providers: { gateway: profile } }).providers.get() as unknown as Options['providers'])
  const entry = profiles.get('gateway')
  if (entry === undefined) throw new Error('the route did not resolve')
  return entry
}

/** The refusal message of a declaration that names no protocol of its own. */
const refusedCatalog = (profile: Record<string, unknown>): string => {
  try {
    resolvedCatalog(profile)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('the profile was accepted')
}

describe('profile resolution', () => {
  it('materializes route and model defaults', () => {
    const profile = resolved({ models: [{ id: 'm' }] })
    expect(profile).toMatchObject({
      provider: 'gateway',
      displayName: 'gateway',
      enabled: true,
      baseURL: 'https://gateway.test/v1',
      maxConcurrent: 3,
      includeUsage: false,
      promptCaching: false,
      diagnostic: undefined,
    })
    expect(profile.models[0]).toMatchObject({
      id: 'm',
      name: 'm',
      contextWindow: 256_000,
      maxTokens: 65_536,
      modalities: ['text'],
      effort: [],
      thinking: [],
      reasoningContent: false,
    })
  })

  it('applies the protocol endpoint default and the profile display name', () => {
    const profile = resolved({ displayName: 'Acme', baseURL: undefined })
    expect(profile.baseURL).toBe('https://api.openai.com/v1')
    expect(profile.displayName).toBe('Acme')
  })

  it('keeps a disabled route addressable without registering it', () => {
    const profiles = resolveProfiles(configured({ enabled: false, models: [{ id: 'm' }] }))
    expect(serviceableRoutes(profiles)).toEqual([])
    expect(registrationFacts(profiles)).toEqual([])
    expect(profiles.get('gateway')?.enabled).toBe(false)
  })

  it('resolves an unlisted model from the route defaults', () => {
    const profile = resolved({ defaultContextWindow: 4096, defaultMaxTokens: 512, models: [{ id: 'known', contextWindow: 8192 }] })
    // A declared model keeps its own capacity; the route default fills only
    // the models that declare none, including ids the profile never lists.
    expect(modelOf(profile, 'known').contextWindow).toBe(8192)
    expect(modelOf(profile, 'known').maxTokens).toBe(512)
    expect(modelOf(profile, 'unknown')).toMatchObject({ contextWindow: 4096, maxTokens: 512, modalities: ['text'] })
  })

  it('reports route facts that compare by value and ignore configuration order', () => {
    const first = registrationFacts(resolveProfiles({
      b: { interfaceType: 'openai-chat-completions', baseURL: 'https://b.test' },
      a: { interfaceType: 'openai-chat-completions', baseURL: 'https://a.test' },
    }))
    const reordered = registrationFacts(resolveProfiles({
      a: { interfaceType: 'openai-chat-completions', baseURL: 'https://a.test' },
      b: { interfaceType: 'openai-chat-completions', baseURL: 'https://b.test' },
    }))
    expect(first).toEqual(reordered)
  })
})

describe('profile validation', () => {
  const refused = (profile: Record<string, unknown>): string => {
    try {
      resolveProfiles(configured(profile))
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error('the profile was accepted')
  }

  it('refuses a profile that names no protocol', () => {
    expect(() => resolveProfiles({ gateway: {} })).toThrow(/interfaceType/)
  })

  it('refuses an array-shaped providers section', () => {
    expect(() => resolveProfiles([] as never)).toThrow(/dict keyed by provider route/)
  })

  it('refuses an empty or malformed endpoint', () => {
    expect(refused({ baseURL: '' })).toMatch(/empty baseURL/)
    expect(refused({ baseURL: 'ftp://gateway.test' })).toMatch(/http or https/)
  })

  it('refuses a route name the first-party DeepSeek channel owns', () => {
    // DeepSeek keeps its official modules; a profile under one of their route
    // names could never serve it, and would fail plugin loading instead.
    for (const [route, owner] of [
      ['deepseek-official', '@deepseek-ai/dsh-llm-deepseek-api-key'],
      ['deepseek-account', '@deepseek-ai/dsh-llm-deepseek-account'],
    ] as const) {
      expect(() => resolveProfiles({ [route]: { interfaceType: 'anthropic-messages' } }))
        .toThrow(new RegExp(`route "${route}" belongs to ${owner.replace(/[/@.]/gu, '\\$&')}`))
    }
    // A stored profile keeps its route addressable with the diagnostic; the
    // other routes in the same document still serve.
    const profiles = resolveProfiles({
      'deepseek-official': { interfaceType: 'openai-chat-completions' },
      gateway: { interfaceType: 'openai-chat-completions', models: [{ id: 'm' }] },
    }, 'deferred')
    expect(profiles.get('deepseek-official')?.diagnostic).toMatch(/belongs to @deepseek-ai\/dsh-llm-deepseek-api-key/)
    expect(serviceableRoutes(profiles)).toEqual(['gateway'])
    // The provider is not reserved — only the names its official channel owns.
    expect(resolveProfiles({ deepseek: { interfaceType: 'anthropic-messages', models: [{ id: 'm' }] } })
      .get('deepseek')?.diagnostic).toBeUndefined()
  })

  it('refuses a credential named twice', () => {
    expect(refused({ apiKeyEnv: 'KEY', apiKey: 'sk-live' })).toMatch(/both apiKeyEnv and apiKey/)
  })

  it('refuses a capability the named protocol cannot carry', () => {
    expect(refused({ promptCaching: true })).toMatch(/promptCaching on interfaceType/)
    expect(refused({ interfaceType: 'anthropic-messages', includeUsage: true })).toMatch(/includeUsage on interfaceType/)
  })

  it('refuses a mid-history capability on a protocol with no mid-history part', () => {
    // Both declarations are reads of a `system`-role message inside the
    // conversation, which only the Messages protocol has; the two OpenAI wires
    // restate the prompt and the tool list on every request.
    expect(refused({ models: [{ id: 'm', capabilities: { toolUpdate: 'addition-only' } }] }))
      .toMatch(/toolUpdate on interfaceType "openai-chat-completions"/)
    expect(refused({ models: [{ id: 'm', capabilities: { systemPromptUpdate: 'in-history' } }] }))
      .toMatch(/systemPromptUpdate on interfaceType "openai-chat-completions"/)
    expect(refused({ interfaceType: 'openai-responses', models: [{ id: 'm', capabilities: { toolUpdate: 'in-history' } }] }))
      .toMatch(/toolUpdate on interfaceType "openai-responses"/)
  })

  it('carries the mid-history declarations a Messages route makes', () => {
    const profile = resolved({
      interfaceType: 'anthropic-messages',
      models: [{
        id: 'm',
        capabilities: { systemPromptUpdate: 'in-history', toolUpdate: 'in-history' },
      }, { id: 'plain' }],
    })
    expect(profile.models.map(model => [model.systemPromptUpdate, model.toolUpdate]))
      .toEqual([['in-history', 'in-history'], [undefined, undefined]])
  })

  it('serves every protocol the vocabulary declares', () => {
    // A vocabulary entry without a transport would be a protocol a deployment
    // could declare and no request could carry; the transport table is typed
    // over these names, so each one resolves and reaches a wire.
    for (const interfaceType of ['openai-chat-completions', 'anthropic-messages', 'openai-responses'] as const) {
      const profile = resolveProfiles({
        gateway: { interfaceType, baseURL: 'https://gateway.test', models: [{ id: 'm' }] },
      }).get('gateway')
      expect(profile?.interfaceType).toBe(interfaceType)
      expect(profile?.diagnostic).toBeUndefined()
    }
  })

  it('refuses a reserved or non-JSON extra body field', () => {
    expect(refused({ extraBody: { messages: [] } })).toMatch(/reserved field "messages"/)
    // The schema refuses a function before resolution ever sees it; the
    // resolution-time rule covers a profile built by other means (an import,
    // or a test double), so it is exercised directly.
    expect(() => resolveProfiles({
      gateway: {
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://gateway.test',
        extraBody: { temperature: () => 0 },
      } as never,
    })).toThrow(/not a JSON value/)
    expect(() => resolveProfiles({
      gateway: { interfaceType: 'openai-chat-completions', baseURL: 'https://gateway.test', extraBody: { tools: [] } },
    })).toThrow(/reserved field "tools"/)
  })

  it('refuses a header Fetch cannot send', () => {
    expect(refused({ headers: { 'bad header': 'value' } })).toMatch(/not valid for Fetch/)
  })

  it('refuses duplicate and invalid model entries', () => {
    expect(refused({ models: [{ id: 'm' }, { id: 'm' }] })).toMatch(/declares model "m" twice/)
    expect(refused({ models: [{ id: '' }] })).toMatch(/empty id/)
    expect(refused({ models: [{ id: 'm', name: '' }] })).toMatch(/empty name/)
    // The schema owns the modality vocabulary; resolution re-checks it for a
    // profile that reached it another way.
    expect(() => resolveProfiles({
      gateway: {
        interfaceType: 'openai-chat-completions',
        baseURL: 'https://gateway.test',
        models: [{ id: 'm', capabilities: { modalities: ['audio'] } }],
      } as never,
    })).toThrow(/unknown modality/)
  })

  it('carries image input with the model pixel budget it declares', () => {
    const profile = resolved({ models: [{ id: 'm', capabilities: { modalities: ['text', 'image'] }, imagePixelBudget: 'low' }] })
    const model = modelOf(profile, 'm')
    expect(model.modalities).toEqual(['text', 'image'])
    expect(model.imagePixelBudget).toBe(512 * 512)
    expect(model.imageMaxBytes).toBeUndefined()
  })

  it('carries a numeric pixel budget and an explicit byte target unchanged', () => {
    const profile = resolved({
      models: [{ id: 'm', capabilities: { modalities: ['image'] }, imagePixelBudget: 1024 * 1024, imageMaxBytes: 1024 }],
    })
    const model = modelOf(profile, 'm')
    expect(model.imagePixelBudget).toBe(1024 * 1024)
    expect(model.imageMaxBytes).toBe(1024)
  })

  it('resolves the route image request budget with its published defaults', () => {
    const profile = resolved({})
    expect(profile.imageRequestBudget).toEqual({
      representation: 'base64',
      maxBytes: 20 * 1024 * 1024,
      maxImages: 600,
      byteQuantum: 10 * 1024 * 1024,
      countQuantum: 20,
    })
  })

  it('takes the route image request budget from the profile', () => {
    const profile = resolved({
      imageRequestMaxBytes: 4096, imageRequestMaxImages: 2, imageOffloadByteQuantum: 512, imageOffloadCountQuantum: 1,
    })
    expect(profile.imageRequestBudget).toMatchObject({ maxBytes: 4096, maxImages: 2, byteQuantum: 512, countQuantum: 1 })
  })

  it('refuses an image knob on a model that declares no image input', () => {
    expect(refused({ models: [{ id: 'm', imagePixelBudget: 512 * 512 }] })).toMatch(/without declaring image input/)
    expect(refused({ models: [{ id: 'm', imageMaxBytes: 1024 }] })).toMatch(/without declaring image input/)
  })

  it('refuses an image-token accounting that is incomplete or misplaced', () => {
    expect(refused({ models: [{ id: 'm', imageTokens: { kind: 'area', per: 750 } }] }))
      .toMatch(/imageTokens without declaring image input/)
    expect(refused({ models: [{
      id: 'm', capabilities: { modalities: ['text', 'image'] }, imageTokens: { kind: 'area' },
    }] })).toMatch(/needs a positive integer "per"/)
    expect(refused({ models: [{
      id: 'm', capabilities: { modalities: ['text', 'image'] }, imageTokens: { kind: 'tiles', perTile: 170 },
    }] })).toMatch(/needs a positive integer "tile"/)
    // Two accountings named at once state neither: the fields of the kind the
    // profile did not name are refused rather than ignored.
    expect(refused({ models: [{
      id: 'm', capabilities: { modalities: ['text', 'image'] }, imageTokens: { kind: 'area', per: 750, tile: 512 },
    }] })).toMatch(/also states the fields of "tiles"/)
  })

  it('refuses every incomplete spelling of a visual-token accounting', () => {
    const image = { modalities: ['text', 'image'] }
    const accounting = (imageTokens: Record<string, unknown>): Record<string, unknown> => ({
      models: [{ id: 'm', capabilities: image, imageTokens }],
    })
    expect(refused(accounting({ kind: 'area', per: 750, base: 85 }))).toMatch(/also states the fields of "tiles"/)
    expect(refused(accounting({ kind: 'tiles', tile: 512, perTile: 170, per: 750 })))
      .toMatch(/also states the field of "area"/)
    expect(refused(accounting({ kind: 'tiles', tile: 512, perTile: 170, base: 1.5 })))
      .toMatch(/"base" to be a non-negative integer/)
    expect(refused(accounting({ kind: 'tiles', tile: 512, base: 85 }))).toMatch(/positive integer "perTile"/)
    expect(refused(accounting({ kind: 'area', per: 0 }))).toMatch(/positive integer "per"/)
    // A declaration the schema already refused never reaches resolution; an
    // unknown kind written straight into a resolved document does, and is
    // refused by the same guard the schema-backed path uses.
    expect(() => resolveProfiles({
      gateway: {
        interfaceType: 'anthropic-messages',
        models: [{ id: 'm', capabilities: image, imageTokens: { kind: 'patches' } }],
      },
    } as never)).toThrow(/names unknown kind "patches"/)
    // The same holds for the two mid-history vocabulary values, which the
    // schema refuses before resolution ever sees them.
    expect(() => resolveProfiles({
      gateway: {
        interfaceType: 'anthropic-messages',
        models: [{ id: 'm', capabilities: { systemPromptUpdate: 'later' } }],
      },
    } as never)).toThrow(/declares unknown systemPromptUpdate "later"/)
    expect(() => resolveProfiles({
      gateway: {
        interfaceType: 'anthropic-messages',
        models: [{ id: 'm', capabilities: { toolUpdate: 'everywhere' } }],
      },
    } as never)).toThrow(/declares unknown toolUpdate "everywhere"/)
  })

  it('carries an image-token accounting in the form the pricing path reads', () => {
    const profile = resolved({ models: [{
      id: 'm', capabilities: { modalities: ['text', 'image'] }, imageTokens: { kind: 'tiles', tile: 512, perTile: 170 },
    }] })
    // A tile accounting without a base is one that charges nothing per image.
    expect(profile.models[0]?.imageTokens).toEqual({ kind: 'tiles', tile: 512, base: 0, perTile: 170 })
    expect(resolved({ models: [{ id: 'plain' }] }).models[0]?.imageTokens).toBeUndefined()
  })

  it('carries a video declaration as a file, and refuses a modality outside the vocabulary', () => {
    // Video travels as a file handle: no wire here has a video part and the
    // harness has no video content block, so the declaration states that the
    // route accepts video files rather than that it receives frames.
    expect(resolved({ models: [{ id: 'm', capabilities: { modalities: ['text', 'video'] } }] }).models[0]?.modalities)
      .toEqual(['text', 'video'])
    // A modality outside the vocabulary never reaches a profile: the schema
    // refuses it where it is written.
    expect(() => configured({ models: [{ id: 'm', capabilities: { modalities: ['audio'] } }] })).toThrow(/modalities/)
    expect(() => resolveProfiles({
      gateway: { interfaceType: 'openai-chat-completions', models: [{ id: 'm', capabilities: { modalities: ['audio'] } }] },
    } as never)).toThrow(/unknown modality/)
  })

  it('carries an image-output declaration, and refuses one the named protocol cannot serve', () => {
    expect(resolved({ models: [{ id: 'm', capabilities: { imageOutput: true } }] }).models[0]?.imageOutput).toBe(true)
    expect(resolved({ models: [{ id: 'm' }] }).models[0]?.imageOutput).toBe(false)
    expect(refused({
      interfaceType: 'anthropic-messages',
      models: [{ id: 'm', capabilities: { imageOutput: true } }],
    })).toMatch(/no assistant image part/)
  })

  it('materializes a model\'s declared request parameters, and leaves each one absent otherwise', () => {
    const declared = resolved({
      models: [{ id: 'm', defaults: { temperature: 0.4, topP: 0.9, topK: 40, maxTokens: 2048 } }],
    })
    expect(declared.models[0]?.defaults).toEqual({ temperature: 0.4, topP: 0.9, topK: 40, maxTokens: 2048 })
    // A model that declares none writes none: an absent default is what makes
    // the request path send only what the caller asked for.
    expect(resolved({ models: [{ id: 'm' }] }).models[0]?.defaults)
      .toEqual({ temperature: undefined, topP: undefined, topK: undefined, maxTokens: undefined })
  })

  it('refuses a top-k default on the protocol that has no top-k field', () => {
    expect(refused({
      interfaceType: 'openai-responses',
      models: [{ id: 'm', defaults: { topK: 20 } }],
    })).toMatch(/defaults\.topK.*openai-responses/)
  })

  it('refuses request parameters the schema or the protocol cannot accept', () => {
    // Ranges are the schema's: a value outside them never reaches a profile.
    expect(() => configured({ models: [{ id: 'm', defaults: { temperature: 3 } }] })).toThrow(/defaults/)
    expect(() => configured({ models: [{ id: 'm', defaults: { temperature: -1 } }] })).toThrow(/defaults/)
    expect(() => configured({ models: [{ id: 'm', defaults: { topP: 1.5 } }] })).toThrow(/defaults/)
    expect(() => configured({ models: [{ id: 'm', defaults: { topK: 0 } }] })).toThrow(/defaults/)
    expect(() => configured({ models: [{ id: 'm', defaults: { topK: 2.5 } }] })).toThrow(/defaults/)
    expect(() => configured({ models: [{ id: 'm', defaults: { maxTokens: 0 } }] })).toThrow(/defaults/)
    // A raw profile that skipped the schema still cannot send a value that is
    // not a number.
    expect(() => resolveProfiles({
      gateway: {
        interfaceType: 'openai-chat-completions',
        models: [{ id: 'm', defaults: { temperature: Number.NaN } }],
      },
    } as never)).toThrow(/finite number/)
  })

  it('materializes an official catalog into this adapter\'s own profile facts', () => {
    const profile = resolvedCatalog({
      catalog: {
        'anthropic-messages': {
          'chat:k3': {
            id: 'k3',
            name: 'Kimi K3',
            api: 'anthropic-messages',
            baseUrl: 'https://api.kimi.com/coding',
            input: ['text', 'image'],
            reasoning: true,
            thinkingLevelMap: { off: null, low: 'low', high: 'high' },
            contextWindow: 1048576,
            maxTokens: 131072,
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
          },
        },
      },
      apiKeyEnv: 'KIMI_CODING_API_KEY',
    })
    // The catalog supplies the protocol and the endpoint; the profile's own
    // credential stands beside them.
    expect(profile.interfaceType).toBe('anthropic-messages')
    expect(profile.baseURL).toBe('https://api.kimi.com/coding')
    expect(profile.apiKeyEnv).toBe('KIMI_CODING_API_KEY')
    expect(profile.models).toMatchObject([{
      id: 'k3',
      name: 'Kimi K3',
      contextWindow: 1048576,
      maxTokens: 131072,
      modalities: ['text', 'image'],
      effort: ['low', 'high'],
      thinking: ['enabled'],
    }])
    expect(profile.catalogDiagnostics).toEqual([
      'llm-service-lite: provider "gateway" catalog field "cost" is not carried',
    ])
  })

  it('lets the profile override the endpoint, the protocol, and the model list of its catalog', () => {
    const profile = resolvedCatalog({
      catalog: {
        'openai-completions': { 'chat:m': { id: 'm', name: 'Official M', contextWindow: 4096 } },
      },
      interfaceType: 'openai-responses',
      baseURL: 'https://override.test/v1',
      models: [{ id: 'mine', contextWindow: 8192 }],
    })
    expect(profile.interfaceType).toBe('openai-responses')
    expect(profile.baseURL).toBe('https://override.test/v1')
    expect(profile.models.map(model => model.id)).toEqual(['mine'])
    // A converted route with nothing left behind reports nothing.
    expect(profile.catalogDiagnostics).toEqual([])
  })

  it('reads a catalog file by path, and keeps a route whose file cannot be read addressable', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lite-catalog-')), 'official.json')
    writeFileSync(file, JSON.stringify({
      'openai-completions': { 'chat:file-model': { id: 'file-model', api: 'openai-completions' } },
    }))
    expect(resolvedCatalog({ catalog: file }).models.map(model => model.id)).toEqual(['file-model'])
    expect(() => resolvedCatalog({ catalog: join(file, 'missing.json') })).toThrow(/cannot be read/)
    const deferred = resolveProfiles(
      { gateway: { catalog: join(file, 'missing.json') } },
      'deferred',
    ).get('gateway')
    expect(deferred?.diagnostic).toMatch(/cannot be read/)
  })

  it('refuses a profile that names neither a protocol nor a catalog', () => {
    expect(refusedCatalog({ baseURL: 'https://gateway.test/v1' })).toMatch(/names no interfaceType/)
  })

  it('carries a signed-replay declaration, which the responses transport honours', () => {
    const profile = resolved({ models: [{ id: 'm', capabilities: { responsesEncryptedReplay: true } }] })
    expect(profile.models[0]?.encryptedReplay).toBe(true)
    expect(resolved({ models: [{ id: 'm' }] }).models[0]?.encryptedReplay).toBe(false)
  })

  it('defaults tool declarations on, and carries a model that turns them off', () => {
    const profile = resolved({ models: [{ id: 'plain', capabilities: { tools: false } }, { id: 'full' }] })
    expect(profile.models.map(model => model.tools)).toEqual([false, true])
  })

  it('accepts effort_only as the explicit spelling of a switchless endpoint', () => {
    const profile = resolved({ models: [{ id: 'm', capabilities: { thinkingStyle: 'effort_only' } }] })
    expect(profile.models[0]?.thinkingStyle).toBe('effort_only')
  })

  it('keeps an unserviceable stored route with a diagnostic instead of throwing', () => {
    const profiles = resolveProfiles({ gateway: { interfaceType: 'openai-chat-completions', baseURL: 'not a url' } }, 'deferred')
    const profile = profiles.get('gateway')
    expect(profile?.diagnostic).toMatch(/not a URL/)
    expect(serviceableRoutes(profiles)).toEqual([])
    expect(registrationFacts(profiles)).toEqual([])
  })

  it('re-validates only the profiles a write touches', () => {
    const previous: Options = { providers: { stored: { interfaceType: 'openai-chat-completions', baseURL: 'not a url' } } }
    expect(() => { assertServiceable({ providers: { ...previous.providers } }, previous) }).not.toThrow()
    expect(() => { assertServiceable({ providers: { ...previous.providers, added: { interfaceType: 'openai-chat-completions', baseURL: 'https://ok.test' } } }, previous) }).not.toThrow()
    expect(() => { assertServiceable({ providers: { ...previous.providers, changed: { interfaceType: 'openai-chat-completions', baseURL: '' } } }, previous) }).toThrow(/empty baseURL/)
  })
})
