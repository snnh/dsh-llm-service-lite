/**
 * The client-side family-defaults application: what the "Apply model defaults"
 * action writes into a staged catalog.
 *
 * The table mirrors the Host's request-path defaults, and the rule it follows
 * here is the same one: a field the profile already states keeps its answer,
 * only what the catalog left open is filled, and sampling parameters are never
 * invented.
 */
import { describe, expect, it } from 'vitest'
import { applyModelDefaults } from '../src/client/family-defaults.ts'
import type { ClientModel, ClientProvider } from '../src/client/types.ts'

/** One staged profile with a chat-completions wire unless a test says otherwise. */
function provider(overrides: ClientProvider = {}): ClientProvider {
  return { interfaceType: 'openai-chat-completions', ...overrides }
}

describe('applyModelDefaults', () => {
  it('fills the researched capacity and capability declarations for a matched model', () => {
    const outcome = applyModelDefaults(provider({ models: [{ id: 'deepseek-v4-pro' }] }))
    const model = outcome.models[0]
    expect(model?.contextWindow).toBe(1_000_000)
    expect(model?.maxTokens).toBe(393_216)
    expect(model?.capabilities).toMatchObject({
      modalities: ['text'],
      effort: ['low', 'high', 'max'],
      thinkingStyle: 'thinking',
      reasoningContent: true,
      replayReasoning: true,
    })
    expect(outcome.unmatched).toEqual([])
    expect(outcome.applied).toHaveLength(1)
    expect(outcome.applied[0]?.id).toBe('deepseek-v4-pro')
    expect(outcome.applied[0]?.fields).toContain('contextWindow')
    expect(outcome.applied[0]?.fields).toContain('maxTokens')
    expect(outcome.applied[0]?.fields).toContain('capabilities.reasoningContent')
    expect(outcome.applied[0]?.note).toMatch(/DeepSeek/)
  })

  it('keeps every value the profile already states', () => {
    const staged = provider({
      models: [{
        id: 'deepseek-v4-pro',
        contextWindow: 1234,
        maxTokens: 42,
        capabilities: { modalities: ['image'] },
      }],
    })
    const outcome = applyModelDefaults(staged)
    const model = outcome.models[0]
    expect(model?.contextWindow).toBe(1234)
    expect(model?.maxTokens).toBe(42)
    expect(model?.capabilities?.modalities).toEqual(['image'])
    // Capabilities the profile did not state are still filled.
    expect(model?.capabilities?.reasoningContent).toBe(true)
    expect(outcome.applied[0]?.fields).not.toContain('contextWindow')
    expect(outcome.applied[0]?.fields).not.toContain('maxTokens')
    expect(outcome.applied[0]?.fields).not.toContain('capabilities.modalities')
  })

  it('fills lists a resolved schema materialized as empty', () => {
    const outcome = applyModelDefaults(provider({
      models: [{
        id: 'glm-5.2-qf',
        capabilities: { modalities: [], effort: [], thinking: [], thinkingStyle: 'thinking' },
      }],
    }))
    const capabilities = outcome.models[0]?.capabilities
    expect(capabilities?.effort).toEqual(['high', 'max'])
    expect(capabilities?.modalities).toEqual([])
    expect(capabilities?.thinkingStyle).toBe('thinking')
    expect(outcome.applied[0]?.fields).toContain('capabilities.effort')
    expect(outcome.applied[0]?.fields).not.toContain('capabilities.thinkingStyle')
  })

  it('leaves ids no family speaks for untouched and reports them', () => {
    const staged = provider({ models: [{ id: 'my-private-gateway-model' }, { id: '' }] })
    const outcome = applyModelDefaults(staged)
    expect(outcome.models).toEqual([{ id: 'my-private-gateway-model' }, { id: '' }])
    expect(outcome.unmatched).toEqual(['my-private-gateway-model'])
    expect(outcome.applied).toEqual([])
  })

  it('resolves a gateway-namespaced id through its model-name spelling', () => {
    const outcome = applyModelDefaults(provider({
      models: [{ id: 'anthropic/claude-sonnet-4-5' }],
    }))
    expect(outcome.models[0]?.contextWindow).toBe(200_000)
    expect(outcome.applied[0]?.id).toBe('anthropic/claude-sonnet-4-5')
  })

  it('carries the Anthropic request cap only on the Messages wire', () => {
    const messages = applyModelDefaults(provider({
      interfaceType: 'anthropic-messages',
      models: [{ id: 'claude-sonnet-4-5' }],
    }))
    expect(messages.models[0]?.defaults).toEqual({ maxTokens: 65_536 })
    const chat = applyModelDefaults(provider({ models: [{ id: 'claude-sonnet-4-5' }] }))
    expect(chat.models[0]?.defaults).toBeUndefined()
  })

  it('never fills sampling parameters even for a fully matched family', () => {
    const outcome = applyModelDefaults(provider({
      models: [{ id: 'deepseek-v4-pro' }],
    }))
    const defaults = outcome.models[0]?.defaults as Record<string, unknown> | undefined
    expect(defaults?.['temperature']).toBeUndefined()
    expect(defaults?.['topP']).toBeUndefined()
    expect(defaults?.['topK']).toBeUndefined()
  })

  it('does not mutate the staged catalog it was handed', () => {
    const staged = provider({ models: [{ id: 'deepseek-v4-pro' }] })
    const outcome = applyModelDefaults(staged)
    expect(staged.models).toEqual([{ id: 'deepseek-v4-pro' }])
    expect(outcome.models).not.toBe(staged.models)
    expect(outcome.models[0]).not.toBe(staged.models?.[0] as ClientModel)
  })

  it('reports nothing to fill when the catalog already states the covered fields', () => {
    const outcome = applyModelDefaults(provider({
      models: [{
        id: 'deepseek-v4-pro',
        contextWindow: 1_000_000,
        maxTokens: 393_216,
        capabilities: {
          modalities: ['text'],
          effort: ['low', 'high', 'max'],
          thinkingStyle: 'thinking',
          reasoningContent: true,
          replayReasoning: true,
        },
      }],
    }))
    expect(outcome.applied[0]?.fields).toEqual([])
  })
})
