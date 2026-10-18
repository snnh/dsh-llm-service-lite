/**
 * The browser draft model: the presets the page offers, the refusals it explains
 * before a save, the document a save stores, and the values the mirror in
 * `src/client/types.ts` shares with the Host schema in `src/config.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_IMAGE_REQUEST_MAX_BYTES,
  DEFAULT_IMAGE_REQUEST_MAX_IMAGES,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  EFFORT_LEVELS as HOST_EFFORT_LEVELS,
  INTERFACE_TYPES as HOST_INTERFACE_TYPES,
  MODALITIES as HOST_MODALITIES,
  THINKING_MODES as HOST_THINKING_MODES,
  THINKING_STYLES as HOST_THINKING_STYLES,
} from '../src/config.ts'
import {
  PRESET_IDS,
  ROUTE_DEFAULTS,
  applyPatch,
  cleanConfig,
  configCounts,
  deriveKeyRef,
  routeIdProblem,
  presetProfile,
  splitList,
  toggleListValue,
  validateConfig,
} from '../src/client/model.ts'
import {
  EFFORT_LEVELS,
  INTERFACE_TYPES,
  MODALITIES,
  THINKING_MODES,
  THINKING_STYLES,
  emptyConfig,
} from '../src/client/types.ts'
import type {
  ClientConfig,
  ClientProvider,
  EffortLevel,
  InterfaceType,
  Modality,
  ProfileProblem,
  ThinkingMode,
  ThinkingStyle,
} from '../src/client/types.ts'

/** A one-route document around the given profile. */
function configOf(provider: ClientProvider, route = 'alpha'): ClientConfig {
  return { providers: { [route]: provider } }
}

/** Every finding the profile earns, as locale keys. */
function problemKeys(provider: ClientProvider): string[] {
  return validateConfig(configOf(provider)).map(problem => problem.key)
}

/** The single finding the profile earns, failing when it earns none or several. */
function onlyProblem(provider: ClientProvider): ProfileProblem {
  const problems = validateConfig(configOf(provider))
  expect(problems).toHaveLength(1)
  const [problem] = problems
  if (problem === undefined) throw new Error('expected one validation problem')
  return problem
}

/** A protocol every refusal test can start from. */
const CHAT = 'openai-chat-completions' as const

describe('builder presets', () => {
  it('turns every offered preset into a profile the Host rules accept', () => {
    for (const preset of PRESET_IDS) {
      const config: ClientConfig = { providers: { [preset]: presetProfile(preset) } }
      expect(validateConfig(config), `preset ${preset}`).toEqual([])
    }
  })
})

describe('route ids', () => {
  it('refuses an empty, reserved, malformed, or taken route id', () => {
    expect(routeIdProblem('', {})).toEqual({ path: 'route', key: 'routeRequired' })
    expect(routeIdProblem('deepseek-official', {})).toEqual({
      path: 'route',
      key: 'routeReserved',
      params: { owner: '@deepseek-ai/dsh-llm-deepseek-api-key' },
    })
    expect(routeIdProblem('deepseek-account', {})).toEqual({
      path: 'route',
      key: 'routeReserved',
      params: { owner: '@deepseek-ai/dsh-llm-deepseek-account' },
    })
    expect(routeIdProblem('Bad Route', {})).toEqual({ path: 'route', key: 'routePattern' })
    expect(routeIdProblem('1alpha', {})).toEqual({ path: 'route', key: 'routePattern' })
    expect(routeIdProblem('alpha', { alpha: {} })).toEqual({
      path: 'route',
      key: 'routeTaken',
      params: { route: 'alpha' },
    })
  })

  it('accepts a free, well-formed route id', () => {
    expect(routeIdProblem('my-gateway.v2', {})).toBeUndefined()
    expect(routeIdProblem('alpha', { beta: {} })).toBeUndefined()
  })
})

describe('validateConfig', () => {
  it('refuses a route with no wire protocol', () => {
    const config = configOf({ baseURL: 'https://api.example.com/v1' })
    expect(validateConfig(config)).toEqual([{ path: 'providers.alpha', key: 'protocolRequired' }])
  })

  it('refuses a wire protocol this adapter does not serve', () => {
    const provider = { interfaceType: 'openai' as unknown as InterfaceType }
    expect(onlyProblem(provider)).toEqual({ path: 'providers.alpha.interfaceType', key: 'protocolRequired' })
  })

  it('refuses a non-http endpoint and accepts an empty one', () => {
    expect(onlyProblem({ interfaceType: CHAT, baseURL: 'ftp://api.example.com/v1' })).toEqual({
      path: 'providers.alpha.baseURL',
      key: 'baseURLInvalid',
    })
    expect(onlyProblem({ interfaceType: CHAT, baseURL: 'not a url' })).toEqual({
      path: 'providers.alpha.baseURL',
      key: 'baseURLInvalid',
    })
    expect(problemKeys({ interfaceType: CHAT, baseURL: '' })).toEqual([])
  })

  it('refuses naming both a credential reference and an inline key', () => {
    expect(onlyProblem({
      interfaceType: CHAT,
      apiKeyEnv: 'GATEWAY_API_KEY',
      apiKey: 'sk-inline',
    })).toEqual({ path: 'providers.alpha.apiKeyEnv', key: 'credentialConflict' })
  })

  it('refuses protocol-gated options on the wrong protocol', () => {
    expect(problemKeys({ interfaceType: CHAT, promptCaching: true })).toEqual(['promptCachingProtocol'])
    expect(problemKeys({ interfaceType: 'anthropic-messages', includeUsage: true })).toEqual(['includeUsageProtocol'])
    expect(problemKeys({ interfaceType: 'openai-responses', promptCaching: true, includeUsage: true }))
      .toEqual(['promptCachingProtocol', 'includeUsageProtocol'])
    expect(problemKeys({ interfaceType: 'anthropic-messages', promptCaching: true })).toEqual([])
    expect(problemKeys({ interfaceType: CHAT, includeUsage: true })).toEqual([])
  })

  it('refuses invalid route-level numbers', () => {
    expect(problemKeys({ interfaceType: CHAT, maxConcurrent: 0 })).toEqual(['maxConcurrentInvalid'])
    expect(problemKeys({ interfaceType: CHAT, maxConcurrent: 1.5 })).toEqual(['maxConcurrentInvalid'])
    expect(problemKeys({ interfaceType: CHAT, streamIdleTimeoutMs: 0 })).toEqual(['streamIdleTimeoutInvalid'])
    expect(problemKeys({ interfaceType: CHAT, streamIdleTimeoutMs: Number.POSITIVE_INFINITY }))
      .toEqual(['streamIdleTimeoutInvalid'])
    expect(problemKeys({ interfaceType: CHAT, defaultContextWindow: -1 })).toEqual(['defaultContextWindowInvalid'])
    expect(problemKeys({ interfaceType: CHAT, defaultMaxTokens: 0 })).toEqual(['defaultMaxTokensInvalid'])
    expect(problemKeys({
      interfaceType: CHAT,
      maxConcurrent: 3,
      streamIdleTimeoutMs: 1_000,
      defaultContextWindow: 128_000,
      defaultMaxTokens: 4096,
    })).toEqual([])
  })

  it('refuses a missing or duplicate model id', () => {
    const problems = validateConfig(configOf({
      interfaceType: CHAT,
      models: [{ id: '' }, { id: 'chat' }, { id: 'chat' }],
    }))
    expect(problems).toEqual([
      { path: 'providers.alpha.models.0', key: 'modelIdRequired' },
      { path: 'providers.alpha.models.2', key: 'modelDuplicate', params: { model: 'chat' } },
    ])
  })

  it('refuses a model capacity that is not a positive whole number', () => {
    expect(problemKeys({
      interfaceType: CHAT,
      models: [{ id: 'chat', contextWindow: 0, maxTokens: -1 }],
    })).toEqual(['modelContextInvalid', 'modelMaxTokensInvalid'])
  })

  it('refuses a modality outside the shared vocabulary', () => {
    const problem = onlyProblem({
      interfaceType: CHAT,
      models: [{ id: 'chat', capabilities: { modalities: ['audio' as unknown as Modality] } }],
    })
    expect(problem).toEqual({
      path: 'providers.alpha.models.0.capabilities.modalities',
      key: 'modalityUnknown',
      params: { value: 'audio' },
    })
  })

  it('refuses an effort level outside the shared vocabulary', () => {
    const problem = onlyProblem({
      interfaceType: CHAT,
      models: [{ id: 'chat', capabilities: { effort: ['extreme' as unknown as EffortLevel] } }],
    })
    expect(problem).toEqual({
      path: 'providers.alpha.models.0.capabilities.effort',
      key: 'effortUnknown',
      params: { value: 'extreme' },
    })
  })

  it('refuses a thinking mode outside the shared vocabulary', () => {
    const problem = onlyProblem({
      interfaceType: CHAT,
      models: [{ id: 'chat', capabilities: { thinking: ['always' as unknown as ThinkingMode] } }],
    })
    expect(problem).toEqual({
      path: 'providers.alpha.models.0.capabilities.thinking',
      key: 'thinkingUnknown',
      params: { value: 'always' },
    })
  })

  it('refuses a thinking-switch spelling outside the shared vocabulary', () => {
    const problem = onlyProblem({
      interfaceType: CHAT,
      models: [{
        id: 'chat',
        capabilities: { thinkingStyle: 'sometimes' as unknown as ThinkingStyle },
      }],
    })
    expect(problem).toEqual({
      path: 'providers.alpha.models.0.capabilities.thinkingStyle',
      key: 'thinkingStyleUnknown',
    })
  })

  it('refuses image output on the protocol with no assistant image part', () => {
    const problem = onlyProblem({
      interfaceType: 'anthropic-messages',
      models: [{ id: 'claude', capabilities: { imageOutput: true } }],
    })
    expect(problem).toEqual({
      path: 'providers.alpha.models.0.capabilities.imageOutput',
      key: 'imageOutputProtocol',
    })
  })

  it('refuses image accounting on a model that does not declare image input', () => {
    for (const imageFields of [
      { imagePixelBudget: 768 },
      { imageMaxBytes: 4_000_000 },
      { imageTokens: { kind: 'area' as const, per: 750 } },
    ]) {
      const problem = onlyProblem({
        interfaceType: CHAT,
        models: [{ id: 'chat', ...imageFields }],
      })
      expect(problem).toEqual({
        path: 'providers.alpha.models.0.imagePixelBudget',
        key: 'imageAccountingWithoutImage',
      })
    }
    expect(problemKeys({
      interfaceType: CHAT,
      models: [{ id: 'chat', capabilities: { modalities: ['image'] }, imagePixelBudget: 768 }],
    })).toEqual([])
  })

  it('refuses an invalid image budget', () => {
    expect(problemKeys({
      interfaceType: CHAT,
      models: [{ id: 'chat', capabilities: { modalities: ['image'] }, imagePixelBudget: 0 }],
    })).toEqual(['imageBudgetInvalid'])
    expect(problemKeys({
      interfaceType: CHAT,
      models: [{ id: 'chat', capabilities: { modalities: ['image'] }, imageMaxBytes: 1.5 }],
    })).toEqual(['imageBudgetInvalid'])
    expect(problemKeys({
      interfaceType: CHAT,
      models: [{ id: 'chat', capabilities: { modalities: ['image'] }, imagePixelBudget: 'low' }],
    })).toEqual([])
  })

  it('refuses defaults outside their ranges, including top-k on Responses', () => {
    expect(problemKeys({
      interfaceType: CHAT,
      models: [{ id: 'chat', defaults: { temperature: 3, topP: 1.5, topK: 0, maxTokens: 0 } }],
    })).toEqual(['temperatureInvalid', 'topPInvalid', 'topKInvalid', 'modelMaxTokensInvalid'])
    expect(problemKeys({
      interfaceType: 'openai-responses',
      models: [{ id: 'gpt', defaults: { topK: 40 } }],
    })).toEqual(['topKProtocol'])
    expect(problemKeys({
      interfaceType: CHAT,
      models: [{ id: 'chat', defaults: { temperature: 0, topP: 1, topK: 1, maxTokens: 1 } }],
    })).toEqual([])
  })

  it('accepts a fully declared profile', () => {
    const config: ClientConfig = {
      providers: {
        gateway: {
          displayName: 'Gateway',
          interfaceType: 'anthropic-messages',
          baseURL: 'https://gateway.example.com/v1',
          apiKeyEnv: 'GATEWAY_API_KEY',
          promptCaching: true,
          maxConcurrent: 4,
          streamIdleTimeoutMs: 120_000,
          defaultContextWindow: 100_000,
          defaultMaxTokens: 4096,
          models: [{
            id: 'claude-sonnet',
            name: 'Claude Sonnet',
            contextWindow: 200_000,
            maxTokens: 8000,
            capabilities: {
              modalities: ['text', 'image'],
              effort: ['low', 'high'],
              thinking: ['enabled', 'disabled'],
              thinkingStyle: 'thinking',
              reasoningContent: true,
              tools: true,
            },
            imagePixelBudget: 'low',
            imageMaxBytes: 5_000_000,
            imageTokens: { kind: 'area', per: 750 },
            defaults: { temperature: 0.7, topP: 0.9, topK: 40, maxTokens: 2048 },
          }],
        },
      },
    }
    expect(validateConfig(config)).toEqual([])
  })
})

describe('cleanConfig', () => {
  /** A draft carrying every placeholder a form can leave behind. */
  const draft: ClientConfig = {
    providers: {
      alpha: {
        displayName: '',
        enabled: true,
        interfaceType: CHAT,
        baseURL: '',
        apiKeyEnv: '',
        apiKey: '',
        headers: {},
        extraBody: {},
        promptCaching: false,
        includeUsage: false,
        maxConcurrent: ROUTE_DEFAULTS.maxConcurrent,
        streamIdleTimeoutMs: ROUTE_DEFAULTS.streamIdleTimeoutMs,
        defaultContextWindow: ROUTE_DEFAULTS.defaultContextWindow,
        defaultMaxTokens: ROUTE_DEFAULTS.defaultMaxTokens,
        imageRequestMaxBytes: ROUTE_DEFAULTS.imageRequestMaxBytes,
        imageRequestMaxImages: ROUTE_DEFAULTS.imageRequestMaxImages,
        imageOffloadByteQuantum: ROUTE_DEFAULTS.imageOffloadByteQuantum,
        imageOffloadCountQuantum: ROUTE_DEFAULTS.imageOffloadCountQuantum,
        models: [],
        catalog: 'official.json',
        retryPolicy: { attempts: 2 },
      },
      beta: {
        interfaceType: 'anthropic-messages',
        models: [{
          id: 'claude',
          name: '',
          capabilities: { modalities: [], effort: [], thinking: [] },
          defaults: {},
        }],
      },
    },
  }

  it('stores only what the person wrote, dropping schema defaults and empty placeholders', () => {
    expect(cleanConfig(draft)).toEqual({
      providers: {
        alpha: {
          interfaceType: CHAT,
          catalog: 'official.json',
          retryPolicy: { attempts: 2 },
        },
        beta: {
          interfaceType: 'anthropic-messages',
          models: [{ id: 'claude' }],
        },
      },
    })
  })

  it('does not mutate the staged draft', () => {
    cleanConfig(draft)
    expect(draft.providers['alpha']?.models).toEqual([])
    expect(draft.providers['alpha']?.displayName).toBe('')
    expect(draft.providers['beta']?.models?.[0]?.capabilities).toEqual({ modalities: [], effort: [], thinking: [] })
  })
})

describe('draft helpers', () => {
  it('applies a patch and drops fields staged as undefined', () => {
    const base = { alpha: 1, beta: 'two', gamma: true }
    const patched = applyPatch(base, { beta: undefined, gamma: false })
    expect(patched).toEqual({ alpha: 1, gamma: false })
    expect('beta' in patched).toBe(false)
    expect(base).toEqual({ alpha: 1, beta: 'two', gamma: true })
  })

  it('derives the conventional credential reference from a route', () => {
    expect(deriveKeyRef('deepseek-direct')).toBe('DEEPSEEK_DIRECT_API_KEY')
    expect(deriveKeyRef('my-provider.v2')).toBe('MY_PROVIDER_V2_API_KEY')
    expect(deriveKeyRef('local_vllm')).toBe('LOCAL_VLLM_API_KEY')
  })

  it('splits a comma-separated list into trimmed non-empty entries', () => {
    expect(splitList('low, high ,,medium, ')).toEqual(['low', 'high', 'medium'])
    expect(splitList('')).toEqual([])
    expect(splitList('   ')).toEqual([])
  })

  it('toggles a vocabulary value in canonical order', () => {
    expect(toggleListValue<EffortLevel>(undefined, 'high', EFFORT_LEVELS)).toEqual(['high'])
    expect(toggleListValue<EffortLevel>(['high'], 'low', EFFORT_LEVELS)).toEqual(['low', 'high'])
    expect(toggleListValue<EffortLevel>(['low', 'high'], 'low', EFFORT_LEVELS)).toEqual(['high'])
    expect(toggleListValue<EffortLevel>(['high'], 'max', EFFORT_LEVELS)).toEqual(['high', 'max'])
  })

  it('counts providers and the models they declare', () => {
    expect(configCounts(emptyConfig())).toEqual({ providers: 0, models: 0 })
    expect(configCounts({
      providers: {
        alpha: { models: [{ id: 'a' }, { id: 'b' }] },
        beta: { models: [{ id: 'c' }] },
        gamma: {},
      },
    })).toEqual({ providers: 3, models: 3 })
  })

  it('starts every page from a fresh empty document', () => {
    const first = emptyConfig()
    expect(first).toEqual({ providers: {} })
    first.providers['alpha'] = { interfaceType: CHAT }
    expect(emptyConfig()).toEqual({ providers: {} })
  })
})

describe('browser mirror parity', () => {
  it('keeps every shared vocabulary identical to the Host schema', () => {
    expect(INTERFACE_TYPES).toEqual(HOST_INTERFACE_TYPES)
    expect(EFFORT_LEVELS).toEqual(HOST_EFFORT_LEVELS)
    expect(THINKING_MODES).toEqual(HOST_THINKING_MODES)
    expect(THINKING_STYLES).toEqual(HOST_THINKING_STYLES)
    expect(MODALITIES).toEqual(HOST_MODALITIES)
  })

  it('keeps every route default identical to the Host schema', () => {
    expect(ROUTE_DEFAULTS).toEqual({
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      imageRequestMaxBytes: DEFAULT_IMAGE_REQUEST_MAX_BYTES,
      imageRequestMaxImages: DEFAULT_IMAGE_REQUEST_MAX_IMAGES,
      imageOffloadByteQuantum: DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
      imageOffloadCountQuantum: DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
    })
  })
})
