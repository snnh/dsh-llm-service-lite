/**
 * The family table, read through the resolution chain and the wires.
 *
 * `model-defaults.spec.ts` proves the table's own contents; this file proves
 * what the adapter does with them: filling a bare profile, letting a profile
 * overrule a family, refusing a declaration a family contradicts, and writing
 * the family's default effort where the caller named none.
 */
import { describe, expect, it } from 'vitest'
import { chatRequest } from '../src/chat-completions.ts'
import { anthropicRequest } from '../src/anthropic-messages.ts'
import { modelOf, resolveProfiles, type ResolvedOwcProviderProfile } from '../src/profiles.ts'
import { replaysReasoning } from '../src/models.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** One chat-completions route whose models the caller declares. */
const chatRoute = (models: Array<{ id: string } & Record<string, unknown>>): ResolvedOwcProviderProfile => {
  const profile = resolveProfiles({
    gateway: { interfaceType: 'openai-chat-completions', baseURL: 'https://gateway.test/v1', models },
  }).get('gateway')
  if (profile === undefined) throw new Error('the route did not resolve')
  return profile
}

/** One anthropic-messages route whose models the caller declares. */
const anthropicRoute = (models: Array<{ id: string } & Record<string, unknown>>): ResolvedOwcProviderProfile => {
  const profile = resolveProfiles({
    gateway: { interfaceType: 'anthropic-messages', baseURL: 'https://gateway.test/v1', models },
  }).get('gateway')
  if (profile === undefined) throw new Error('the route did not resolve')
  return profile
}

/** The body one chat request would send. */
const chatBody = (
  profile: ResolvedOwcProviderProfile,
  options: Partial<GenerateOptions> = {},
  id = 'm',
): Record<string, unknown> => JSON.parse(
  chatRequest(profile, modelOf(profile, id), {
    model: id,
    provider: 'gateway',
    messages: [],
    ...options,
  }, undefined).body,
) as Record<string, unknown>

describe('family defaults in resolution', () => {
  it('fills a bare profile with what the model family documents', () => {
    const model = modelOf(chatRoute([{ id: 'deepseek-v4-flash' }]), 'deepseek-v4-flash')
    expect(model).toMatchObject({
      family: 'deepseek-v4-vision',
      modalities: ['text', 'image'],
      reasoningContent: true,
      replayReasoning: true,
      replayRequired: true,
      thinkingStyle: 'thinking',
      effort: ['low', 'high', 'max'],
      effortDefault: 'high',
    })
  })

  it('lets a profile overrule the family, field by field', () => {
    const model = modelOf(chatRoute([{
      id: 'deepseek-v4-flash',
      capabilities: { modalities: ['text'], effort: ['high'], reasoningContent: false },
    }]), 'deepseek-v4-flash')
    // The declared modality list and ladder win, and a declared ladder means
    // the family's default level no longer applies to it.
    expect(model).toMatchObject({ modalities: ['text'], effort: ['high'], reasoningContent: false })
    expect(model.effortDefault).toBeUndefined()
    // A family's mandatory replay is not overruled by a declaration that only
    // says the endpoint returns no reasoning content.
    expect(model.replayReasoning).toBe(true)
  })

  it('refuses turning off a replay the family requires', () => {
    expect(() => chatRoute([{ id: 'deepseek-v4-flash', capabilities: { replayReasoning: false } }]))
      .toThrow(/family "deepseek-v4-vision" requires it/)
    expect(() => chatRoute([{ id: 'qwen3.8-max', capabilities: { replayReasoning: false } }]))
      .toThrow(/requires it/)
  })

  it('honours turning off a replay the family only declares', () => {
    const model = modelOf(chatRoute([{ id: 'qwen3.8-flash', capabilities: { replayReasoning: false } }]), 'qwen3.8-flash')
    expect(model.replayReasoning).toBe(false)
    expect(replaysReasoning(model)).toBe(false)
    // The family's own answer stays on when nothing overrides it.
    expect(replaysReasoning(modelOf(chatRoute([{ id: 'qwen3.8-flash' }]), 'qwen3.8-flash'))).toBe(true)
  })

  it('gives an id the route never enumerated its family facts too', () => {
    const profile = chatRoute([])
    expect(modelOf(profile, 'glm-5.3-flash')).toMatchObject({
      family: 'glm-5.3-vision',
      modalities: ['text', 'image'],
      effortDefault: 'max',
    })
    expect(modelOf(profile, 'acme-7b')).toMatchObject({ family: undefined, modalities: ['text'], effort: [] })
  })
})

describe('family defaults on the wires', () => {
  it('writes the family default effort where the caller named none', () => {
    const profile = chatRoute([{ id: 'deepseek-v4-flash' }])
    expect(chatBody(profile, {}, 'deepseek-v4-flash')).toMatchObject({
      reasoning_effort: 'high',
      thinking: { type: 'enabled' },
    })
    // A caller's own level still wins over the family default.
    expect(chatBody(profile, { reasoningEffort: 'max' as never }, 'deepseek-v4-flash'))
      .toMatchObject({ reasoning_effort: 'max' })
  })

  it('sends no effort for a model whose family declares neither a ladder nor a default', () => {
    const profile = chatRoute([{ id: 'acme-7b', capabilities: { effort: ['low', 'high'] } }])
    expect(chatBody(profile, {}, 'acme-7b')).not.toHaveProperty('reasoning_effort')
    expect(chatBody(profile, { reasoningEffort: 'high' as never }, 'acme-7b'))
      .toMatchObject({ reasoning_effort: 'high' })
  })

  it('does not put a max_tokens on a chat request the caller left open', () => {
    const profile = chatRoute([{ id: 'deepseek-v4-flash', maxTokens: 4096 }])
    expect(chatBody(profile, {}, 'deepseek-v4-flash')).not.toHaveProperty('max_tokens')
  })

  it('sends the family cap on the Anthropic wire, and the caller wins over it', () => {
    const profile = anthropicRoute([])
    const body = (id: string, options: Partial<GenerateOptions> = {}): Record<string, unknown> => JSON.parse(
      anthropicRequest(profile, modelOf(profile, id), {
        model: id,
        provider: 'gateway',
        messages: [],
        ...options,
      }, undefined).body,
    ) as Record<string, unknown>
    expect(body('claude-opus-5-5')).toMatchObject({ max_tokens: 128 * 1024, output_config: { effort: 'medium' } })
    expect(body('claude-opus-5-5', { maxTokens: 1024 })).toMatchObject({ max_tokens: 1024 })
    expect(body('acme-7b')).toMatchObject({ max_tokens: 64 * 1024 })
  })
})
