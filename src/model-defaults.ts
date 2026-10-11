/**
 * Per-family model defaults.
 *
 * A profile that names a model the user adopted by hand — no catalog to read
 * — otherwise gets an adapter's most conservative guess about what that
 * endpoint accepts. This table fills the gap with researched facts about the
 * mainstream families, so a bare `models: [{ id: deepseek-v4-flash }]` is
 * usable without restating what the family already implies.
 *
 * Three rules govern every entry:
 *
 * 1. **A profile always wins.** These are defaults, not capabilities: a
 *    profile field that states an answer keeps it, and the table only fills
 *    what the profile left open. Editing this file never changes a model the
 *    user described.
 * 2. **Nothing is invented.** Every entry records where it came from — the
 *    model owner's own API documentation, or the official catalog snapshot of
 *    2026-10-10 that the harness ships. A family whose wire spelling is
 *    unconfirmed carries no entry rather than a guess.
 * 3. **Only the owner's deployment counts.** An open-weight model's parameters
 *    are the ones the model's own platform documents; what a reseller,
 *    aggregator, or gateway requires of the same model id is never a source,
 *    and a family whose owner documents nothing is left without an entry.
 * 4. **Sampling is never defaulted.** `temperature` / `top_p` / `top_k` stay
 *    unset: vendors disagree about their reachable ranges under thinking, and
 *    an invented value is worse than the endpoint's own default.
 *
 * Editing: append or reorder {@link MODEL_DEFAULT_RULES}. Rules are matched
 * top-down against the lowercased model id and the first hit wins, so a
 * specific rule must precede the general rule of its family.
 *
 * @module dsh-llm-service-lite/model-defaults
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { EffortLevel, Modality, ThinkingMode, ThinkingStyle } from './config.ts'

/**
 * One model's declarations in the vocabulary a configuration surface writes
 * into a profile.
 *
 * Declared here rather than imported: the harness seam that accepts these
 * ({@link ModelDefaultsSeam}) is an addition of the dsh-lite harness, and an
 * upstream harness has neither the type nor the remote. The shape is the
 * profile's own `capabilities` / `defaults` objects, so a surface that
 * understands the profile understands every entry.
 */
export interface DeclaredModelDefault {
  /** Model id these declarations are for. */
  readonly id: string
  /** Documented context capacity, when a rule documents one. */
  readonly contextWindow?: number
  /** Documented output capacity, when a rule documents one. */
  readonly maxTokens?: number
  /** Capability declarations, keyed as the profile's `capabilities` object. */
  readonly capabilities?: Record<string, JsonValue>
  /** Request parameters, keyed as the profile's `defaults` object. */
  readonly defaults?: Record<string, JsonValue>
  /** The vendor document or catalog the declarations were read from. */
  readonly note?: string
}

/**
 * The model-defaults registration seam of the dsh-lite harness.
 *
 * Optional by design: the plugin registers with it when the running harness
 * has it, and keeps its table to itself when it does not, so the same package
 * serves both runtimes.
 */
export interface ModelDefaultsSeam {
  /**
   * Register what this adapter declares about the model ids a surface is
   * editing.
   * @param settingsNs - namespace whose adapter answers.
   * @param describe - one request in, one entry per id the adapter can describe.
   * @returns disposer that removes the registration.
   */
  registerModelDefaults?: (
    settingsNs: string,
    describe: (request: ModelDefaultsRequest) => Promise<readonly DeclaredModelDefault[]>,
  ) => () => void
}

/** The ids a configuration surface is drafting, and the protocol it named. */
export interface ModelDefaultsRequest {
  /** Wire protocol the declarations are for, when the surface names one. */
  readonly api?: string
  /** Model ids to describe, in the caller's order. */
  readonly models: readonly string[]
}

/** One family's researched defaults, keyed by model-id patterns. */
export interface ModelDefaultRule {
  /** Stable family slug, surfaced in diagnostics when a default is applied. */
  readonly family: string
  /** Model-id patterns this rule claims; the first matching rule wins. */
  readonly match: readonly RegExp[]
  /** Request modalities the family accepts; omitted leaves the profile's answer. */
  readonly modalities?: readonly Modality[]
  /** Whether the family returns its reasoning in a `reasoning_content`-style field. */
  readonly reasoningContent?: boolean
  /**
   * Whether prior reasoning may be sent back to the endpoint. `false` pins it
   * off (the family returns no replayable reasoning), `true` turns it on, and
   * omitted leaves it at the profile's answer.
   */
  readonly replayReasoning?: boolean
  /**
   * Whether the family *requires* prior reasoning to be replayed — the
   * endpoint rejects a follow-up turn without it. A required replay is not a
   * user choice, and a capability flag that contradicts it is refused.
   */
  readonly replayRequired?: boolean
  /** How the family spells its thinking switch on a chat-completions wire. */
  readonly thinkingStyle?: ThinkingStyle
  /**
   * Context capacity the family's own platform documents, in tokens. A
   * generated profile carries it so a user reads the number instead of
   * inheriting an unstated one.
   */
  readonly contextWindow?: number
  /**
   * Output capacity the family's own platform documents, in tokens. It stays a
   * capacity: a request asks for a cap through `defaults.maxTokens`, never
   * through this.
   */
  readonly maxTokens?: number
  /** Selectable reasoning-effort levels the family publishes, in escalation order. */
  readonly effort?: readonly EffortLevel[]
  /**
   * The effort level the family applies when a request names none. Absent
   * leaves the choice to the endpoint, which is the honest answer while a
   * vendor documents no default. A declared default must be one of
   * {@link effort}.
   */
  readonly effortDefault?: EffortLevel
  /** Selectable thinking modes the family publishes. */
  readonly thinking?: readonly ThinkingMode[]
  /**
   * Output-token default for the Anthropic Messages wire, whose protocol
   * requires `max_tokens` on every request. Unmatched models fall back to
   * {@link ANTHROPIC_FALLBACK_MAX_TOKENS}.
   */
  readonly anthropicMaxTokens?: number
  /** Where the entry's facts came from, with the date they were read. */
  readonly note: string
}

/**
 * Output cap sent on the Anthropic Messages wire for a model no rule matches.
 * The protocol requires the field, so silence is not an option; 64k is the
 * largest value every current Anthropic-compatible endpoint accepts.
 */
export const ANTHROPIC_FALLBACK_MAX_TOKENS = 64 * 1024

/**
 * The researched family table. Order matters: the first rule whose pattern
 * matches the lowercased model id wins, so keep specific rules above the
 * general rule of the same family.
 */
export const MODEL_DEFAULT_RULES: readonly ModelDefaultRule[] = [
  // ——— Anthropic Messages wire: `max_tokens` is required, so every family
  // reachable through it carries a researched cap. ———

  // The Claude 5 generation caps at 128k. Anthropic's own model table names the
  // effort each model runs at, so those become the defaults.
  {
    family: 'claude-5-reasoning',
    match: [/^claude-(fable-5|sonnet-5)/],
    contextWindow: 1000000,
    maxTokens: 128000,
    modalities: ['text', 'image'],
    effort: ['low', 'medium', 'high', 'xhigh', 'max'],
    effortDefault: 'high',
    anthropicMaxTokens: 128 * 1024,
    note: 'Anthropic models overview: Fable 5.1 / Sonnet 5 adaptive thinking with effort high, max output 128K, read 2026-10-10',
  },
  {
    family: 'claude-opus-5',
    match: [/^claude-opus-5/],
    contextWindow: 1000000,
    maxTokens: 128000,
    modalities: ['text', 'image'],
    effort: ['low', 'medium', 'high', 'xhigh', 'max'],
    effortDefault: 'medium',
    anthropicMaxTokens: 128 * 1024,
    note: 'Anthropic models overview: Opus 5.5 adaptive thinking with effort medium, max output 128K, read 2026-10-10',
  },
  {
    family: 'claude-5',
    match: [/^claude-(opus-5|sonnet-5|haiku-5|fable-5)/],
    contextWindow: 1000000,
    maxTokens: 128000,
    modalities: ['text', 'image'],
    effort: ['low', 'medium', 'high', 'xhigh', 'max'],
    anthropicMaxTokens: 128 * 1024,
    note: 'Official catalog (models.dev anthropic: output 128000, effort low..max), read 2026-10-10',
  },
  // Claude Opus 4.6-4.8 / Sonnet 4.6 cap at 128k.
  {
    family: 'claude-128k',
    match: [/^claude-(opus-4-[678]|sonnet-4-6)/],
    contextWindow: 1000000,
    maxTokens: 128000,
    modalities: ['text', 'image'],
    effort: ['low', 'medium', 'high', 'xhigh', 'max'],
    anthropicMaxTokens: 128 * 1024,
    note: 'Official catalog (pi-ai 1.0.2: max output 128000), no vendor doc read, 2026-10-10',
  },
  // Claude Opus 4.5 / Sonnet 4.5 / Haiku 4.5 cap at 64k — the same value the
  // unmatched fallback uses, stated so the family is visible in diagnostics.
  {
    family: 'claude-64k',
    match: [/^claude-(opus-4-5|sonnet-4-5|haiku-4-5)/],
    contextWindow: 200000,
    maxTokens: 64000,
    modalities: ['text', 'image'],
    anthropicMaxTokens: 64 * 1024,
    note: 'Anthropic models overview (Haiku 4.5 max output 64K) + official catalog, read 2026-10-10',
  },
  // Any other Claude on an Anthropic-compatible gateways.
  {
    family: 'claude-other',
    match: [/^claude-/],
    modalities: ['text', 'image'],
    anthropicMaxTokens: 64 * 1024,
    note: 'Conservative Claude default, pi-ai catalog 1.0.2, read 2026-10-10',
  },
  // Kimi's Anthropic-compatible coding route.
  {
    family: 'kimi-coding-k3',
    match: [/^k3(-256k)?$/],
    contextWindow: 1048576,
    maxTokens: 131072,
    modalities: ['text', 'image'],
    effort: ['low', 'high', 'max'],
    effortDefault: 'max',
    anthropicMaxTokens: 128 * 1024,
    note: 'Moonshot K3 docs (default effort max) + models.dev kimi-code-plan-cn output 131072, read 2026-10-10',
  },
  {
    family: 'kimi-coding',
    match: [/^kimi-for-coding/],
    contextWindow: 1048576,
    maxTokens: 32768,
    modalities: ['text', 'image'],
    effort: ['low', 'high', 'max'],
    effortDefault: 'max',
    anthropicMaxTokens: 32 * 1024,
    note: 'Kimi Code docs: `kimi-for-coding` now serves K2.8 Preview with effort low/high/max default max over 1M context; official catalog records output 32768, read 2026-10-10',
  },
  // MiniMax serves its Messages-compatible endpoint for both generations.
  // Effort tuning is documented for the M3.1 preview only, so the plain M3
  // keeps the toggle alone rather than claiming levels it may not take.
  {
    family: 'minimax-m3.1',
    match: [/^minimax-m3\.1/],
    contextWindow: 1000000,
    maxTokens: 512000,
    modalities: ['text', 'image'],
    effort: ['low', 'medium', 'high', 'xhigh', 'max'],
    effortDefault: 'max',
    anthropicMaxTokens: 512 * 1024,
    note: 'MiniMax Anthropic API docs: M3.1-Flash-Preview output_config.effort low..max, default max, read 2026-10-10',
  },
  {
    family: 'minimax-m3',
    match: [/^minimax-m3/],
    contextWindow: 1000000,
    maxTokens: 512000,
    modalities: ['text', 'image'],
    thinking: ['adaptive', 'disabled'],
    anthropicMaxTokens: 512 * 1024,
    note: 'MiniMax docs: M3 thinking off by default, adaptive enables it; models.dev output 512000, read 2026-10-10',
  },
  {
    family: 'minimax-m2',
    match: [/^minimax-m2/],
    contextWindow: 204800,
    maxTokens: 131072,
    modalities: ['text'],
    anthropicMaxTokens: 128 * 1024,
    note: 'MiniMax Anthropic API docs + models.dev: output 131072, read 2026-10-10',
  },

  // ——— DeepSeek (chat-completions) ———
  // V4 requires `reasoning_content` back on any follow-up that carries tools:
  // dropping it is a hard 400, not a preference.
  {
    family: 'deepseek-v4-vision',
    match: [/^deepseek-(v4-flash|v4\.1|flash)/],
    contextWindow: 1000000,
    maxTokens: 393216,
    modalities: ['text', 'image'],
    reasoningContent: true,
    replayReasoning: true,
    replayRequired: true,
    thinkingStyle: 'thinking',
    effort: ['low', 'high', 'max'],
    effortDefault: 'high',
    note: 'DeepSeek thinking-mode docs: effort low/high/max, default high (minimal→low, medium/xhigh→high, ultra→max); reasoning_content must be replayed, read 2026-10-10',
  },
  {
    family: 'deepseek-v4',
    match: [/^deepseek-v4/],
    contextWindow: 1000000,
    maxTokens: 393216,
    modalities: ['text'],
    reasoningContent: true,
    replayReasoning: true,
    replayRequired: true,
    thinkingStyle: 'thinking',
    effort: ['low', 'high', 'max'],
    effortDefault: 'high',
    note: 'DeepSeek thinking-mode docs: effort low/high/max, default high; thinking defaults enabled, read 2026-10-10',
  },
  {
    family: 'deepseek',
    match: [/^deepseek-/],
    reasoningContent: true,
    thinkingStyle: 'thinking',
    note: 'DeepSeek family default, read 2026-10-10',
  },

  // ——— Kimi / Moonshot (chat-completions) ———
  // K3 drops the `thinking` object for a top-level `reasoning_effort`.
  {
    family: 'kimi-k3',
    match: [/^kimi-k3/],
    contextWindow: 1048576,
    maxTokens: 1048576,
    modalities: ['text', 'image'],
    reasoningContent: true,
    replayReasoning: true,
    replayRequired: true,
    thinkingStyle: 'effort_only',
    effort: ['low', 'high', 'max'],
    effortDefault: 'max',
    note: 'Moonshot K3 docs (top-level reasoning_effort, default max; assistant message must be replayed intact), read 2026-10-10',
  },
  // K2.7 coding models always think and always keep reasoning.
  {
    family: 'kimi-k2.7',
    match: [/^kimi-k2\.7/],
    contextWindow: 262144,
    maxTokens: 262144,
    modalities: ['text', 'image'],
    reasoningContent: true,
    replayReasoning: true,
    replayRequired: true,
    thinking: ['enabled'],
    note: 'Moonshot docs: kimi-k2.7-code cannot disable thinking, preserved thinking always on, read 2026-10-10',
  },
  {
    family: 'kimi-k2.6',
    match: [/^kimi-k2\.6/],
    contextWindow: 262144,
    maxTokens: 262144,
    modalities: ['text', 'image'],
    reasoningContent: true,
    thinking: ['enabled', 'disabled'],
    note: 'Moonshot docs: kimi-k2.6 toggle + optional thinking.keep, read 2026-10-10',
  },
  {
    family: 'kimi',
    match: [/^kimi-/, /^moonshot/],
    modalities: ['text', 'image'],
    reasoningContent: true,
    note: 'Moonshot family default, read 2026-10-10',
  },

  // ——— GLM (Z.ai / Zhipu) ———
  // GLM-5.3-Flash is the vision sibling of GLM-5.3: same forced thinking and
  // same effort ladder, plus image input.
  {
    family: 'glm-5.3-vision',
    match: [/^glm-5\.3-flash/],
    contextWindow: 1000000,
    maxTokens: 131072,
    modalities: ['text', 'image'],
    reasoningContent: true,
    thinkingStyle: 'thinking',
    thinking: ['enabled'],
    effort: ['low', 'high', 'max'],
    effortDefault: 'max',
    anthropicMaxTokens: 128 * 1024,
    note: 'Zhipu docs: GLM-5.3-Flash forces thinking (only enabled), effort low/high/max default max, 1M context / 128K output, image+video input, read 2026-10-10',
  },
  // The earlier vision models keep the dynamic thinking toggle and no ladder.
  {
    family: 'glm-vision',
    match: [/^glm-5v/, /^glm-4\.6v/],
    contextWindow: 200000,
    maxTokens: 131072,
    modalities: ['text', 'image'],
    reasoningContent: true,
    thinkingStyle: 'thinking',
    note: 'Zhipu docs: glm-5v-turbo / glm-4.6v accept images and choose thinking dynamically, read 2026-10-10',
  },
  {
    family: 'glm-5.3',
    match: [/^glm-5\.3/],
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoningContent: true,
    thinkingStyle: 'thinking',
    thinking: ['enabled'],
    effort: ['low', 'high', 'max'],
    effortDefault: 'max',
    anthropicMaxTokens: 128 * 1024,
    note: 'Zhipu docs: glm-5.3 cannot disable thinking, effort low/high/max default max, 1M context / 128K output, read 2026-10-10',
  },
  {
    family: 'glm-5.2',
    match: [/^glm-5\.2/],
    contextWindow: 1000000,
    maxTokens: 131072,
    reasoningContent: true,
    thinkingStyle: 'thinking',
    effort: ['high', 'max'],
    effortDefault: 'max',
    note: 'Zhipu docs: glm-5.2 effort high/max with max as the default, read 2026-10-10',
  },
  {
    family: 'glm',
    match: [/^glm-/],
    reasoningContent: true,
    thinkingStyle: 'thinking',
    note: 'Zhipu family default: thinking {type, clear_thinking}, read 2026-10-10',
  },

  // ——— Qwen (Alibaba Model Studio / Qwen AI platform) ———
  // qwen3.8-max is the one Qwen whose documented `preserve_thinking` default
  // is on, which makes the replay mandatory for it. Its effort and the
  // series' share the same three levels and the same xhigh default.
  {
    family: 'qwen3.8-max',
    match: [/^qwen3\.8-max/],
    contextWindow: 1000000,
    maxTokens: 131072,
    modalities: ['text', 'image'],
    reasoningContent: true,
    replayReasoning: true,
    replayRequired: true,
    thinkingStyle: 'enable_thinking',
    thinking: ['enabled', 'disabled'],
    effort: ['low', 'medium', 'xhigh'],
    effortDefault: 'xhigh',
    note: 'Alibaba Model Studio: qwen3.8-max effort low/medium/xhigh, default xhigh (cannot combine with thinking_budget); preserve_thinking defaults true, read 2026-10-10',
  },
  {
    family: 'qwen3.8',
    match: [/^qwen3\.8/],
    contextWindow: 1000000,
    maxTokens: 131072,
    modalities: ['text', 'image'],
    reasoningContent: true,
    thinkingStyle: 'enable_thinking',
    thinking: ['enabled', 'disabled'],
    effort: ['low', 'medium', 'xhigh'],
    effortDefault: 'xhigh',
    note: 'Qwen AI platform API reference: Qwen3.8 series effort low/medium/xhigh, default xhigh, read 2026-10-10',
  },
  {
    family: 'qwen3.7-max',
    match: [/^qwen3\.7-max/],
    contextWindow: 1000000,
    maxTokens: 131072,
    modalities: ['text'],
    reasoningContent: true,
    thinkingStyle: 'enable_thinking',
    thinking: ['enabled', 'disabled'],
    note: 'Alibaba Model Studio: qwen3.7-max text-only, read 2026-10-10',
  },
  {
    family: 'qwen3.5+',
    match: [/^qwen3\.[5-8]/],
    contextWindow: 1000000,
    maxTokens: 65536,
    modalities: ['text', 'image'],
    reasoningContent: true,
    thinkingStyle: 'enable_thinking',
    thinking: ['enabled', 'disabled'],
    note: 'Alibaba Model Studio deep-thinking docs (enable_thinking, default on for 3.5+), read 2026-10-10',
  },
  {
    family: 'qwen',
    match: [/^qwen/, /^qwq/, /^qvq/],
    reasoningContent: true,
    thinkingStyle: 'enable_thinking',
    note: 'Qwen family default (Qwen AI platform ignores reasoning_effort), read 2026-10-10',
  },

  // ——— Doubao / Volcengine Ark ———
  // Ark documents a per-generation default: the 2.1 generation defaults to
  // high, the 2.0 generation to medium.
  {
    family: 'doubao-seed-2.0',
    match: [/^doubao-seed-2-0/, /^doubao-seed-character/],
    contextWindow: 256000,
    maxTokens: 128000,
    modalities: ['text', 'image'],
    reasoningContent: true,
    thinkingStyle: 'thinking',
    effort: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    effortDefault: 'medium',
    note: 'Volcengine Ark deep-thinking docs: seed-2.0/character default effort medium (minimal disables thinking), read 2026-10-10',
  },
  {
    family: 'doubao-seed',
    match: [/^doubao-/, /^seed-/, /\/seed-/],
    contextWindow: 256000,
    maxTokens: 256000,
    modalities: ['text', 'image'],
    reasoningContent: true,
    thinkingStyle: 'thinking',
    effort: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    effortDefault: 'high',
    note: 'Volcengine Ark deep-thinking docs (thinking.type enabled/disabled/auto; seed-2.1/evolving default effort high), read 2026-10-10',
  },

  // ——— Hunyuan (Tencent) ———
  {
    family: 'hunyuan-hy4',
    match: [/^hy4/, /^hunyuan-4/],
    contextWindow: 1024000,
    maxTokens: 64000,
    reasoningContent: true,
    thinkingStyle: 'thinking',
    effort: ['low', 'medium', 'high'],
    effortDefault: 'high',
    note: 'Tencent Hunyuan docs: hy4-preview/hy3 default reasoning_effort high; low maps to high when tools are present, read 2026-10-10',
  },
  {
    family: 'hunyuan',
    match: [/^hy\d/, /^hunyuan/],
    contextWindow: 256000,
    maxTokens: 128000,
    reasoningContent: true,
    thinkingStyle: 'thinking',
    effort: ['low', 'medium', 'high'],
    effortDefault: 'high',
    note: 'Tencent Hunyuan deep-thinking docs: thinking {type} plus reasoning_effort, default high, read 2026-10-10',
  },

  // ——— ERNIE (Baidu Qianfan) ———
  // ERNIE 5.0 is the omni-modal generation; 5.1 is its text sibling, so only
  // the 5.0 rule may claim images.
  {
    family: 'ernie-5.0',
    match: [/^ernie-5\.0/],
    contextWindow: 131072,
    maxTokens: 65536,
    modalities: ['text', 'image'],
    reasoningContent: true,
    thinkingStyle: 'enable_thinking',
    thinking: ['enabled', 'disabled'],
    note: 'Baidu Qianfan model list (ERNIE 5.0 listed under 视觉理解) + deep-thinking docs, read 2026-10-10',
  },
  {
    family: 'ernie-5.1',
    match: [/^ernie-5\.1/],
    contextWindow: 131072,
    maxTokens: 65536,
    modalities: ['text'],
    reasoningContent: true,
    thinkingStyle: 'enable_thinking',
    thinking: ['enabled', 'disabled'],
    note: 'Baidu Qianfan model list (text only; thinking_budget supported) + enable_thinking family spelling, read 2026-10-10',
  },
  {
    family: 'ernie-x1',
    match: [/^ernie-x1/],
    contextWindow: 65536,
    maxTokens: 65536,
    reasoningContent: true,
    thinking: ['enabled'],
    note: 'Baidu Qianfan deep-thinking docs: ERNIE X1 is thinking-only, read 2026-10-10',
  },
  {
    family: 'ernie-vl',
    match: [/^ernie-.*-vl/],
    contextWindow: 131072,
    maxTokens: 16384,
    modalities: ['text', 'image'],
    note: 'Baidu Qianfan vision model list (ernie-4.5-turbo-vl, ernie-4.5-vl-28b-a3b), read 2026-10-10',
  },

  // StepFun's reasoning arrives in a `reasoning` field, and its three effort
  // levels are documented as low/medium/high with medium the recommended
  // default.
  {
    family: 'step-5',
    match: [/^step-5/],
    contextWindow: 1000000,
    maxTokens: 65536,
    modalities: ['text', 'image'],
    effort: ['low', 'medium', 'high'],
    effortDefault: 'medium',
    note: 'StepFun docs: step-5-preview carries a 1M context; reasoning_effort low/medium/high, medium recommended, read 2026-10-10',
  },
  {
    family: 'step',
    match: [/^step-\d/],
    contextWindow: 256000,
    maxTokens: 256000,
    modalities: ['text', 'image'],
    effort: ['low', 'medium', 'high'],
    effortDefault: 'medium',
    note: 'StepFun reasoning docs: reasoning_effort low/medium/high with medium the recommended default; reasoning arrives in a `reasoning` field, read 2026-10-10',
  },

  // ——— Xiaomi MiMo ———
  // Thinking is on by default for every current MiMo, and a follow-up turn
  // that carries tool calls must replay `reasoning_content` or the endpoint
  // answers 400.
  {
    family: 'mimo',
    match: [/^mimo-/],
    contextWindow: 1048576,
    maxTokens: 131072,
    modalities: ['text', 'image'],
    reasoningContent: true,
    replayReasoning: true,
    replayRequired: true,
    thinkingStyle: 'thinking',
    thinking: ['enabled', 'disabled'],
    note: 'Xiaomi MiMo docs (thinking default on; reasoning_content must be replayed with tool calls, else 400), read 2026-10-10',
  },

  // ——— SenseNova ———
  // SenseNova documents thinking on by default, reasoning_effort
  // low/medium/high/max with high as the default (none disables thinking), and
  // reports reasoning in a non-standard `reasoning` field it advises against
  // replaying — so no replay claim is made here.
  {
    family: 'sensenova',
    match: [/^sensenova-/],
    contextWindow: 262144,
    maxTokens: 65536,
    modalities: ['text', 'image'],
    effort: ['low', 'medium', 'high', 'max'],
    effortDefault: 'high',
    note: 'SenseNova platform docs: thinking on by default, reasoning_effort low/medium/high/max default high, `reasoning` field not replayed, read 2026-10-10',
  },

  // ——— LongCat (Meituan) ———
  // Both models serve an Anthropic-compatible Messages endpoint as well as the
  // OpenAI one, so the protocol-required cap matters here too.
  {
    family: 'longcat',
    match: [/^longcat/],
    contextWindow: 1000000,
    maxTokens: 131072,
    modalities: ['text'],
    thinkingStyle: 'thinking',
    thinking: ['enabled', 'disabled'],
    anthropicMaxTokens: 128 * 1024,
    note: 'LongCat API docs: thinking {type: enabled|disabled}; LongCat-2.5-Preview/2.0 max output 131072 over 1M context on both OpenAI and Anthropic endpoints, read 2026-10-10',
  },
  // GPT-5/o-series never return plaintext reasoning; the encrypted items the
  // Responses wire replays are declared separately by
  // `responsesEncryptedReplay`, so plain replay is off here.
  // gpt-5.1 is the generation that made `none` — no reasoning — its default,
  // so it carries no effort default and the endpoint's own choice stands.
  {
    family: 'openai-reasoning-nodefault',
    match: [/^gpt-5\.1/],
    contextWindow: 400000,
    maxTokens: 128000,
    modalities: ['text', 'image'],
    replayReasoning: false,
    effort: ['low', 'medium', 'high'],
    note: 'OpenAI docs: gpt-5.1 defaults reasoning_effort to none, read 2026-10-10',
  },
  {
    family: 'openai-reasoning',
    match: [/^gpt-5/, /^gpt-6/, /^o[1-4]/],
    contextWindow: 400000,
    maxTokens: 128000,
    modalities: ['text', 'image'],
    replayReasoning: false,
    effort: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    effortDefault: 'medium',
    note: 'OpenAI reasoning docs: reasoning_effort defaults to medium (gpt-5.5/5.6/6.x), encrypted replay only, read 2026-10-10',
  },
]

/**
 * Every spelling of one model id a rule may be written against.
 *
 * Providers name their models in more than one shape: the vendor's own id
 * (`claude-haiku-5.5`), a gateway's namespaced form
 * (`anthropic/claude-haiku-5.5`), and the router form that marks a normalized
 * id with a leading `~` (`~anthropic/claude-opus-latest`). A rule is written
 * once against the model's own name, and every spelling is offered to it, so a
 * namespaced id resolves to the same family as the bare one.
 * @param modelId - the model id as the profile spells it.
 * @returns the lowercased id and every suffix after a leading `vendor/` or `~`.
 */
function idSpellingsOf(modelId: string): string[] {
  const id = modelId.toLowerCase()
  const spellings = [id]
  let rest = id.startsWith('~') ? id.slice(1) : id
  spellings.push(rest)
  while (rest.includes('/')) {
    rest = rest.slice(rest.indexOf('/') + 1)
    spellings.push(rest)
  }
  return spellings
}

/**
 * The rule that speaks for one model, or nothing when no family matches.
 * @param modelId - the model id as the profile spells it, in any provider naming.
 * @returns the first matching rule in table order.
 */
export function modelDefaultRuleOf(modelId: string): ModelDefaultRule | undefined {
  const spellings = idSpellingsOf(modelId)
  return MODEL_DEFAULT_RULES.find(rule => rule.match.some(pattern => spellings.some(id => pattern.test(id))))
}

/**
 * One model's researched defaults, spelled as a profile would state them.
 *
 * This is what a configuration surface writes into a document when a user asks
 * to see the defaults rather than inherit them: every field is the same
 * vocabulary the profile schema accepts, so the reply can be written through
 * unchanged and edited afterwards like anything else the user typed.
 * @param modelId - the model id as the profile spells it.
 * @param interfaceType - the route's protocol, which decides whether a cap is stated.
 * @returns the declarations, or nothing when no family speaks for this id.
 */
export function declaredDefaultsOf(
  modelId: string,
  interfaceType?: string,
): DeclaredModelDefault | undefined {
  const rule = modelDefaultRuleOf(modelId)
  if (rule === undefined) return undefined
  const capabilities: Record<string, JsonValue> = {}
  if (rule.modalities !== undefined) capabilities['modalities'] = [...rule.modalities]
  if (rule.effort !== undefined) capabilities['effort'] = [...rule.effort]
  if (rule.thinking !== undefined) capabilities['thinking'] = [...rule.thinking]
  if (rule.thinkingStyle !== undefined) capabilities['thinkingStyle'] = rule.thinkingStyle
  if (rule.reasoningContent !== undefined) capabilities['reasoningContent'] = rule.reasoningContent
  if (rule.replayReasoning !== undefined) capabilities['replayReasoning'] = rule.replayReasoning
  // The Anthropic protocol requires a cap, so the family's own value becomes a
  // configured request default there; the OpenAI wires send none unless the
  // user asks, and this writes nothing they would have to undo.
  const defaults: Record<string, JsonValue> =
    interfaceType === 'anthropic-messages' && rule.anthropicMaxTokens !== undefined
      ? { maxTokens: rule.anthropicMaxTokens }
      : {}
  return {
    id: modelId,
    ...rule.contextWindow === undefined ? {} : { contextWindow: rule.contextWindow },
    ...rule.maxTokens === undefined ? {} : { maxTokens: rule.maxTokens },
    capabilities,
    defaults,
    note: rule.note,
  }
}

/**
 * The output cap an Anthropic Messages request declares for one model, absent
 * a profile or caller override.
 * @param modelId - the model id as the profile spells it.
 * @returns the family's cap, else {@link ANTHROPIC_FALLBACK_MAX_TOKENS}.
 */
export function anthropicMaxTokensOf(modelId: string): number {
  return modelDefaultRuleOf(modelId)?.anthropicMaxTokens ?? ANTHROPIC_FALLBACK_MAX_TOKENS
}
