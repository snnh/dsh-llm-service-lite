import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_FALLBACK_MAX_TOKENS,
  declaredDefaultsOf,
  MODEL_DEFAULT_RULES,
  anthropicMaxTokensOf,
  modelDefaultRuleOf,
} from '../src/model-defaults.ts'

/** The family slug that speaks for one id, or `undefined` when none matches. */
const familyOf = (id: string): string | undefined => modelDefaultRuleOf(id)?.family

describe('model family defaults', () => {
  it('speaks for the researched families, most specific rule first', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      // Anthropic wire caps.
      ['claude-opus-5', 'claude-opus-5'],
      ['claude-opus-5-5', 'claude-opus-5'],
      ['claude-haiku-5-5', 'claude-5'],
      ['claude-fable-5-1', 'claude-5-reasoning'],
      ['claude-sonnet-5', 'claude-5-reasoning'],
      ['claude-opus-4-7', 'claude-128k'],
      ['claude-sonnet-4-6', 'claude-128k'],
      ['claude-opus-4-5', 'claude-64k'],
      ['claude-haiku-4-5-20251001', 'claude-64k'],
      ['claude-sonnet-4-5-20250929', 'claude-64k'],
      ['claude-legacy-thing', 'claude-other'],
      ['k3', 'kimi-coding-k3'],
      ['k3-256k', 'kimi-coding-k3'],
      ['kimi-for-coding', 'kimi-coding'],
      ['kimi-for-coding-highspeed', 'kimi-coding'],
      ['MiniMax-M3', 'minimax-m3'],
      ['MiniMax-M2.7-highspeed', 'minimax-m2'],
      // DeepSeek: V4 is the generation whose replay is mandatory.
      ['deepseek-v4-flash', 'deepseek-v4-vision'],
      ['deepseek-v4.1-flash', 'deepseek-v4-vision'],
      ['deepseek-flash', 'deepseek-v4-vision'],
      ['deepseek-v4-pro', 'deepseek-v4'],
      ['deepseek-r1', 'deepseek'],
      // Kimi.
      ['kimi-k3', 'kimi-k3'],
      ['kimi-k2.7-code-highspeed', 'kimi-k2.7'],
      ['kimi-k2.6', 'kimi-k2.6'],
      ['kimi-k2.5', 'kimi'],
      // GLM: the vision sibling is claimed before the text family.
      ['glm-5.3-flash', 'glm-5.3-vision'],
      ['glm-5.3-flashx', 'glm-5.3-vision'],
      ['glm-5v-turbo', 'glm-vision'],
      ['glm-4.6v', 'glm-vision'],
      ['glm-5.3', 'glm-5.3'],
      ['glm-5.2', 'glm-5.2'],
      ['glm-4.7', 'glm'],
      // Qwen.
      ['qwen3.8-max', 'qwen3.8-max'],
      ['qwen3.8-flash', 'qwen3.8'],
      ['qwen3.7-max', 'qwen3.7-max'],
      ['qwen3.5-397b-a17b', 'qwen3.5+'],
      ['qwq-plus', 'qwen'],
      // Volcengine: the 2.0 generation is claimed before the general rule.
      ['doubao-seed-2-1-pro-260628', 'doubao-seed'],
      ['doubao-seed-2-0-mini-260428', 'doubao-seed-2.0'],
      ['bytedance-seed/seed-2.0-code', 'doubao-seed'],
      // Tencent.
      ['hy4-preview', 'hunyuan-hy4'],
      ['hy3', 'hunyuan'],
      ['hunyuan-t1', 'hunyuan'],
      // Baidu.
      ['ernie-5.0-thinking-preview', 'ernie-5.0'],
      ['ernie-5.1', 'ernie-5.1'],
      ['ernie-x1.1-preview', 'ernie-x1'],
      ['ernie-4.5-turbo-vl', 'ernie-vl'],
      // Others.
      ['step-3.7-flash', 'step'],
      ['mimo-v2.6-pro', 'mimo'],
      ['sensenova-6.8-flash-lite', 'sensenova'],
      ['LongCat-2.0', 'longcat'],
      ['LongCat-2.5-Preview', 'longcat'],
      ['gpt-5.4', 'openai-reasoning'],
      ['gpt-6-sol', 'openai-reasoning'],
      ['o3-mini', 'openai-reasoning'],
    ]
    for (const [id, family] of cases) expect([id, familyOf(id)]).toEqual([id, family])
  })

  it('matches ids case-insensitively', () => {
    expect(familyOf('GLM-5.3')).toBe('glm-5.3')
    expect(familyOf('DeepSeek-V4-Flash')).toBe('deepseek-v4-vision')
  })

  it('matches a namespaced id as the model its gateway names', () => {
    // Gateways and routers spell the same model with a vendor prefix, and the
    // router form that marks a normalized id with a leading `~`.
    expect(familyOf('anthropic/claude-haiku-5.5')).toBe('claude-5')
    expect(familyOf('anthropic/claude-opus-4-5')).toBe('claude-64k')
    expect(familyOf('openai/gpt-5.4')).toBe('openai-reasoning')
    expect(familyOf('deepseek/deepseek-v4-pro')).toBe('deepseek-v4')
    expect(familyOf('z-ai/glm-5.3')).toBe('glm-5.3')
    expect(familyOf('moonshotai/kimi-k2.6')).toBe('kimi-k2.6')
    expect(familyOf('bytedance-seed/seed-2.0-code')).toBe('doubao-seed')
    expect(familyOf('~anthropic/claude-fable-5-latest')).toBe('claude-5-reasoning')
    // A prefixless id and its namespaced form answer alike.
    expect(familyOf('anthropic/claude-opus-5-5')).toBe(familyOf('claude-opus-5-5'))
    expect(anthropicMaxTokensOf('anthropic/claude-opus-4-5')).toBe(64 * 1024)
  })

  it('leaves an unknown model without family facts, which is not an error', () => {
    expect(modelDefaultRuleOf('acme-internal-7b')).toBeUndefined()
  })

  it('carries the researched facts a bare profile cannot know', () => {
    // DeepSeek V4 rejects a follow-up turn without its reasoning content.
    expect(modelDefaultRuleOf('deepseek-v4-pro')).toMatchObject({
      family: 'deepseek-v4',
      modalities: ['text'],
      reasoningContent: true,
      replayReasoning: true,
      replayRequired: true,
      thinkingStyle: 'thinking',
    })
    // K3 spells the effort at the top level, without a thinking object.
    expect(modelDefaultRuleOf('kimi-k3')).toMatchObject({
      thinkingStyle: 'effort_only',
      effort: ['low', 'high', 'max'],
      replayRequired: true,
    })
    // K2.7 cannot stop thinking.
    expect(modelDefaultRuleOf('kimi-k2.7-code')).toMatchObject({
      thinking: ['enabled'],
      replayRequired: true,
    })
    // qwen3.8-max is the Qwen whose preserved thinking is on by default.
    expect(modelDefaultRuleOf('qwen3.8-max')).toMatchObject({
      thinkingStyle: 'enable_thinking',
      replayRequired: true,
      effort: ['low', 'medium', 'xhigh'],
    })
    // GPT returns no plaintext reasoning, so nothing of it is replayed.
    expect(modelDefaultRuleOf('gpt-5.5')).toMatchObject({ replayReasoning: false })
  })

  it('gives the Anthropic wire a cap for every model', () => {
    expect(anthropicMaxTokensOf('claude-opus-5')).toBe(128 * 1024)
    expect(anthropicMaxTokensOf('claude-opus-4-5')).toBe(64 * 1024)
    expect(anthropicMaxTokensOf('k3')).toBe(128 * 1024)
    expect(anthropicMaxTokensOf('kimi-for-coding')).toBe(32 * 1024)
    expect(anthropicMaxTokensOf('MiniMax-M3')).toBe(512 * 1024)
    expect(anthropicMaxTokensOf('MiniMax-M2.7')).toBe(128 * 1024)
    // LongCat serves an Anthropic endpoint too, so its 128K cap is recorded.
    expect(anthropicMaxTokensOf('LongCat-2.5-Preview')).toBe(128 * 1024)
    expect(modelDefaultRuleOf('LongCat-2.0')).toMatchObject({
      thinkingStyle: 'thinking',
      thinking: ['enabled', 'disabled'],
    })
    // Unmatched models still need the protocol-required field.
    expect(anthropicMaxTokensOf('acme-internal-7b')).toBe(ANTHROPIC_FALLBACK_MAX_TOKENS)
    expect(ANTHROPIC_FALLBACK_MAX_TOKENS).toBe(64 * 1024)
  })

  it('carries the effort levels and the default level of each family', () => {
    // qwen3.8-max: low/medium/xhigh, default xhigh.
    expect(modelDefaultRuleOf('qwen3.8-max')).toMatchObject({
      effort: ['low', 'medium', 'xhigh'],
      effortDefault: 'xhigh',
    })
    // GLM 5.2/5.3, its vision sibling, and Kimi Code's K2.8 all default to max.
    expect(modelDefaultRuleOf('glm-5.3')).toMatchObject({ effort: ['low', 'high', 'max'], effortDefault: 'max' })
    expect(modelDefaultRuleOf('glm-5.3-flash')).toMatchObject({
      family: 'glm-5.3-vision',
      modalities: ['text', 'image'],
      effortDefault: 'max',
      thinking: ['enabled'],
    })
    expect(modelDefaultRuleOf('glm-5.2')).toMatchObject({ effort: ['high', 'max'], effortDefault: 'max' })
    expect(modelDefaultRuleOf('kimi-k3')).toMatchObject({ effort: ['low', 'high', 'max'], effortDefault: 'max' })
    expect(modelDefaultRuleOf('kimi-for-coding')).toMatchObject({ effort: ['low', 'high', 'max'], effortDefault: 'max' })
    // MiniMax M3.1 preview tunes depth through output_config.effort, default max.
    expect(modelDefaultRuleOf('MiniMax-M3.1-Flash-Preview')).toMatchObject({
      family: 'minimax-m3.1',
      effortDefault: 'max',
    })
    // Plain M3 documents only the thinking toggle, so no effort levels.
    expect(modelDefaultRuleOf('MiniMax-M3')).toMatchObject({
      family: 'minimax-m3',
      thinking: ['adaptive', 'disabled'],
    })
    expect(modelDefaultRuleOf('MiniMax-M3')?.effort).toBeUndefined()
    // OpenAI defaults to medium, except gpt-5.1 whose default is no reasoning.
    expect(modelDefaultRuleOf('gpt-5.5')).toMatchObject({ effortDefault: 'medium' })
    expect(modelDefaultRuleOf('gpt-5.1')).toMatchObject({ family: 'openai-reasoning-nodefault' })
    expect(modelDefaultRuleOf('gpt-5.1')?.effortDefault).toBeUndefined()
    // DeepSeek documents high as its default, and the alias mapping around it.
    expect(modelDefaultRuleOf('deepseek-v4-pro')).toMatchObject({ effort: ['low', 'high', 'max'], effortDefault: 'high' })
    expect(modelDefaultRuleOf('deepseek-v4-flash')?.effortDefault).toBe('high')
    // Volcengine documents a default per generation: 2.1 high, 2.0 medium.
    expect(modelDefaultRuleOf('doubao-seed-2-1-pro-260628')).toMatchObject({ effortDefault: 'high' })
    expect(modelDefaultRuleOf('doubao-seed-2-0-mini-260428')).toMatchObject({ family: 'doubao-seed-2.0', effortDefault: 'medium' })
    // Tencent: hy4-preview/hy3 default to high.
    expect(modelDefaultRuleOf('hy4-preview')).toMatchObject({ effortDefault: 'high' })
    // Qwen3.8 (beyond max) shares the series default.
    expect(modelDefaultRuleOf('qwen3.8-flash')).toMatchObject({ family: 'qwen3.8', effortDefault: 'xhigh' })
    // StepFun recommends medium and reports reasoning in a `reasoning` field,
    // which this wire does not read — so nothing is claimed about replay.
    expect(modelDefaultRuleOf('step-3.7-flash')).toMatchObject({ effortDefault: 'medium' })
    expect(modelDefaultRuleOf('step-3.7-flash')?.reasoningContent).toBeUndefined()
    // SenseNova documents high as the default effort.
    expect(modelDefaultRuleOf('sensenova-6.8-flash-lite')).toMatchObject({
      effort: ['low', 'medium', 'high', 'max'],
      effortDefault: 'high',
    })
    // Anthropic names the effort its own models run at.
    expect(modelDefaultRuleOf('claude-opus-5-5')).toMatchObject({ effortDefault: 'medium' })
    expect(modelDefaultRuleOf('claude-sonnet-5')).toMatchObject({ family: 'claude-5-reasoning', effortDefault: 'high' })
    expect(modelDefaultRuleOf('claude-fable-5-1')).toMatchObject({ effortDefault: 'high' })
    // Families that publish no effort list keep the endpoint's own default.
    expect(modelDefaultRuleOf('mimo-v2.6-pro')?.effortDefault).toBeUndefined()
    expect(modelDefaultRuleOf('glm-4.7')?.effortDefault).toBeUndefined()
  })

  it('keeps every rule sourced, matchable, and free of sampling parameters', () => {
    const allowed = new Set([
      'family', 'match', 'contextWindow', 'maxTokens', 'modalities', 'reasoningContent',
      'replayReasoning', 'replayRequired', 'thinkingStyle', 'effort', 'effortDefault', 'thinking',
      'anthropicMaxTokens', 'note',
    ])
    for (const rule of MODEL_DEFAULT_RULES) {
      expect(rule.match.length).toBeGreaterThan(0)
      expect(rule.note.length).toBeGreaterThan(0)
      for (const key of Object.keys(rule)) expect([rule.family, key, allowed.has(key)]).toEqual([rule.family, key, true])
      if (rule.anthropicMaxTokens !== undefined) {
        expect(Number.isInteger(rule.anthropicMaxTokens)).toBe(true)
        expect(rule.anthropicMaxTokens).toBeGreaterThan(0)
      }
      // A mandatory replay that is also declared off would contradict itself.
      if (rule.replayRequired === true) expect([rule.family, rule.replayReasoning]).toEqual([rule.family, true])
      // A capacity is a token count, never a guess with a fractional part.
      for (const capacity of [rule.contextWindow, rule.maxTokens]) {
        if (capacity === undefined) continue
        expect([rule.family, Number.isInteger(capacity) && capacity > 0]).toEqual([rule.family, true])
      }
      // A default effort the family does not publish is a typo, not a default.
      if (rule.effortDefault !== undefined) expect([rule.family, rule.effort?.includes(rule.effortDefault)]).toEqual([rule.family, true])
    }
    const families = MODEL_DEFAULT_RULES.map(rule => rule.family)
    expect(new Set(families).size).toBe(families.length)
  })
})

describe('declared defaults for a configuration surface', () => {
  it('spells a family as a profile could state it', () => {
    expect(declaredDefaultsOf('deepseek-v4-flash')).toMatchObject({
      id: 'deepseek-v4-flash',
      contextWindow: 1_000_000,
      maxTokens: 393_216,
      capabilities: {
        modalities: ['text', 'image'],
        effort: ['low', 'high', 'max'],
        thinkingStyle: 'thinking',
        reasoningContent: true,
        replayReasoning: true,
      },
      defaults: {},
    })
    // The Messages protocol needs a cap, so the family's own becomes a
    // configured default there and nowhere else.
    expect(declaredDefaultsOf('claude-opus-5-5', 'anthropic-messages')?.defaults).toEqual({ maxTokens: 128 * 1024 })
    expect(declaredDefaultsOf('claude-opus-5-5')?.defaults).toEqual({})
    // A namespaced id is described like the bare one; the entry stays keyed by
    // the id the caller asked about.
    const bare = declaredDefaultsOf('claude-opus-5-5')
    const namespaced = declaredDefaultsOf('anthropic/claude-opus-5-5')
    expect(namespaced?.id).toBe('anthropic/claude-opus-5-5')
    expect({ ...namespaced, id: bare?.id }).toEqual(bare)
    // Nothing to declare is not an error: the surface says so instead.
    expect(declaredDefaultsOf('acme-7b')).toBeUndefined()
  })
})
