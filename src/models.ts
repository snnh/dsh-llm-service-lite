/**
 * Projection of resolved profiles onto the LLM seam's model vocabulary.
 *
 * OWC describes a model's thinking in two independent knobs — a mode
 * (`adaptive` / `enabled` / `disabled`) and a reasoning-effort level — while
 * the harness exposes one selector, `GenerateOptions.reasoningEffort`. The
 * mapping keeps both knobs reachable without inventing a second selector: a
 * model that declares effort levels offers those levels, and a model that
 * declares only thinking modes offers the modes themselves. A request then
 * carries whatever the chosen level means on that endpoint, which is exactly
 * what {@link reasoningLevelOf} answers.
 *
 * @module dsh-llm-service-lite/models
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, ModelModality } from '@deepseek-ai/dsh-llm'
import type { EffortLevel, ThinkingMode } from './config.ts'
import { modelOf, type ResolvedOwcModel, type ResolvedOwcProviderProfile } from './profiles.ts'

/** One selectable reasoning level: either a declared effort or a declared thinking mode. */
export type ReasoningLevel = EffortLevel | ThinkingMode

/** Human-readable labels for the levels the adapter offers. */
const LEVEL_LABELS: Readonly<Record<string, string>> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
  adaptive: 'Adaptive',
  enabled: 'Enabled',
  disabled: 'Disabled',
}

/**
 * Reasoning levels one model offers, in declaration order.
 *
 * Effort levels win when both are declared: they are the finer control, and a
 * model that publishes them almost always accepts the mode toggle implicitly
 * (an effort is sent for a thinking request, nothing is sent for a plain one).
 * @param model - resolved model facts.
 * @returns selectable levels, empty when the model exposes no reasoning control.
 */
export function reasoningLevels(model: ResolvedOwcModel): readonly ReasoningLevel[] {
  if (model.effort.length > 0) return model.effort
  return model.thinking
}

/**
 * The wire meaning of one selected level.
 *
 * @param model - resolved model facts.
 * @param level - the selected level, or undefined when the caller named none.
 * @returns the effort spelling for `reasoning_effort`, the thinking mode the
 * request should declare, and whether thinking is on; every field is omitted
 * when the level means "send nothing".
 */
export function reasoningLevelOf(
  model: ResolvedOwcModel,
  level: string | undefined,
): { effort?: string; mode?: ThinkingMode; thinking?: boolean } {
  if (level === undefined) return {}
  if (model.effort.includes(level as EffortLevel)) return { effort: level, thinking: true }
  if (model.thinking.includes(level as ThinkingMode)) {
    return level === 'disabled' ? { mode: 'disabled', thinking: false } : { mode: level as ThinkingMode, thinking: true }
  }
  return {}
}

/**
 * Whether a model's route can replay prior reasoning for the next request.
 * @param model - resolved route.
 * @returns true when the route carries reasoning content and sends it back.
 */
export function replaysReasoning(model: ResolvedOwcModel): boolean {
  return model.replayReasoning && model.reasoningContent
}

/**
 * The reasoning level one request should act on: the caller's own when it
 * named one, else the level the model's family applies by default.
 * @param model - resolved route.
 * @param requested - the level the caller named, when any.
 * @returns the level to interpret, or undefined to send nothing.
 */
export function reasoningLevelFor(model: ResolvedOwcModel, requested: string | undefined): string | undefined {
  return requested ?? model.effortDefault
}

/**
 * The advisory catalog entry for one model.
 * @param profile - resolved route.
 * @param model - resolved model facts.
 * @returns the seam's model info.
 */
export function outputModalitiesOf(model: ResolvedOwcModel): readonly ModelModality[] {
  return model.imageOutput ? ['text', 'image'] : ['text']
}

/**
 * The seam's model info plus the response modalities a model declares.
 *
 * The extra field is an addition of the dsh-lite harness: an upstream
 * `LlmModelInfo` has no such member, and an upstream consumer ignores the
 * property rather than reading a text-only model as multimodal.
 */
export type ModelInfoWithOutput = LlmModelInfo & {
  readonly outputModalities?: readonly ModelModality[]
}

/** The resolved-model counterpart of {@link ModelInfoWithOutput}. */
export type ResolvedModelInfoWithOutput = LlmResolvedModelInfo & {
  readonly outputModalities?: readonly ModelModality[]
}

/**
 * The modalities one model's answers may carry. A model that declared image
 * output answers with text and images; every other model is declared text-only
 * rather than left unknown, so an image block from a route that never claimed
 * one is a failure a caller can see.
 * @param profile - resolved route.
 * @param model - resolved model facts.
 * @returns the seam's model info.
 */
export function catalogInfo(profile: ResolvedOwcProviderProfile, model: ResolvedOwcModel): ModelInfoWithOutput {
  return {
    provider: profile.provider,
    id: model.id,
    name: model.name,
    inputModalities: [...model.modalities],
    outputModalities: [...outputModalitiesOf(model)],
  }
}

/**
 * Every model a route advertises, in configuration order.
 * @param profile - resolved route.
 * @returns catalog entries for the route's declared models.
 */
export function catalogModels(profile: ResolvedOwcProviderProfile): LlmModelInfo[] {
  return profile.models.map(model => catalogInfo(profile, model))
}

/**
 * Complete metadata for one exact model, including the capacities and the
 * reasoning selector the request path reads before a call is prepared.
 * @param profile - resolved route.
 * @param model - exact model id from the request.
 * @returns the seam's resolved model info.
 */
export function resolvedModelInfo(profile: ResolvedOwcProviderProfile, model: string): ResolvedModelInfoWithOutput {
  const facts = modelOf(profile, model)
  const levels = reasoningLevels(facts)
  return {
    provider: profile.provider,
    id: facts.id,
    name: facts.name,
    inputModalities: [...facts.modalities],
    outputModalities: [...outputModalitiesOf(facts)],
    context: { contextWindow: facts.contextWindow },
    // Only a profile-declared default becomes a request cap: a model's own
    // capacity is what it *can* answer, not what every request should ask for,
    // and writing it here would put a `max_tokens` on calls that never asked
    // for one.
    ...facts.defaults.maxTokens === undefined ? {} : { defaultMaxTokens: facts.defaults.maxTokens },
    // Declared only when the profile declares them: an absent capability is
    // what makes the harness rewrite the prompt and the tool list every turn,
    // which is the honest reading of a route that never said it reads either
    // mid-history.
    ...facts.systemPromptUpdate === undefined ? {} : { systemPromptUpdate: facts.systemPromptUpdate },
    ...facts.toolUpdate === undefined ? {} : { toolUpdate: facts.toolUpdate },
    ...levels.length === 0 ? {} : {
      reasoning: {
        efforts: levels.map(level => ({
          id: ReasoningEffortId(level),
          name: LEVEL_LABELS[level] ?? level,
        })),
        // A family's own default is materialized into requests when the caller
        // names none, which is what keeps a bare profile on the vendor's
        // documented level instead of the endpoint's undocumented one.
        ...facts.effortDefault === undefined ? {} : { defaultEffort: ReasoningEffortId(facts.effortDefault) },
      },
    },
  }
}
