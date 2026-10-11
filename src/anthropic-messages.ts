/**
 * The `anthropic-messages` wire: request assembly and the pairing repair every
 * durable history needs before it crosses this protocol.
 *
 * Two rules of the Messages API are not properties of the conversation but of
 * the request, and a durable session can violate both: every `tool_use` block
 * must be answered by exactly one `tool_result`, and that result must arrive in
 * the user turn that immediately follows its call. A history written across an
 * interrupted turn, a crash, or a compaction boundary can carry a result whose
 * call is gone, two results for one call, or a call nothing ever answered —
 * and the endpoint answers any of them with a 400 rather than a completion.
 * The translation therefore repairs the pairing on the way out: orphan results
 * are dropped, a repeated call id or result id collapses to its first
 * occurrence, an unanswered call is answered with a placeholder, and the
 * results of one parallel batch merge into the single user turn the protocol
 * requires. The endpoint then reads a request it would have accepted from a
 * well-formed conversation, without the durable log being rewritten.
 *
 * The other half of the port is replay fidelity: this protocol returns signed
 * thinking blocks, and returning a turn without its signature is itself a 400.
 * A signature is kept as adapter-private replay metadata on the assistant
 * message — the one place the harness reserves for exactly this — and is read
 * back only for the provider and model that produced it.
 *
 * @module dsh-llm-service-lite/anthropic-messages
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { offloadedImageText } from './images.ts'
import { reasoningLevelFor, reasoningLevelOf } from './models.ts'
import { anthropicMaxTokensOf } from './model-defaults.ts'
import type { ResolvedOwcModel, ResolvedOwcProviderProfile } from './profiles.ts'

/** `anthropic-version` this transport speaks; the API requires the header. */
const ANTHROPIC_VERSION = '2023-06-01'

/** What one unanswered call is answered with, so the protocol's pairing holds. */
const MISSING_RESULT_TEXT = 'Tool result missing: this call did not complete.'

/**
 * What one assistant turn contributes when nothing else survives translation —
 * a turn whose reasoning had no usable signature and whose calls were already
 * declared earlier. The protocol refuses an empty content array, and this
 * states the omission to the model instead of inventing a sentence for it.
 */
const TRIMMED_TURN_TEXT = '[context trimmed]'

/** One assembled request, ready for `fetch`. */
export interface AnthropicHttpRequest {
  /** Absolute endpoint for this protocol. */
  readonly url: string
  /** Request headers, attribution and profile headers included. */
  readonly headers: Record<string, string>
  /** Serialized JSON body. */
  readonly body: string
}

/** One content part as the Messages protocol spells it. */
type AnthropicPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | AnthropicPart[]; is_error?: true }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

/** One message as the Messages protocol spells it. */
interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system'
  content: (AnthropicPart | AnthropicSystemPart)[]
}

/**
 * A part only a `system`-role history message carries: the mid-conversation
 * prompt snapshot itself, and the two references that activate or deactivate a
 * declared tool. They are separate from {@link AnthropicPart} because the
 * protocol admits them on no other role, and a route that declared neither
 * capability never produces one.
 */
type AnthropicSystemPart =
  | { type: 'text'; text: string }
  | { type: 'tool_addition'; tool: { type: 'tool_reference'; name: string } }
  | { type: 'tool_removal'; tool: { type: 'tool_reference'; name: string } }

/** Replay-metadata kinds this transport writes and reads. */
export const REPLAY_KIND = 'llm-service-lite-anthropic'
/** Schema version of this transport's replay metadata. */
export const REPLAY_VERSION = 1

/** Per-block half of this transport's replay metadata, one entry per durable block. */
export type AnthropicReplayBlock =
  | { type: 'text' }
  | { type: 'reasoning'; signature?: string; redacted?: string }
  | { type: 'tool-call' }

/** Response-level half of this transport's replay metadata. */
export interface AnthropicReplayResponse {
  kind: typeof REPLAY_KIND
  version: typeof REPLAY_VERSION
  /** Provider stop reason, for diagnostics when a replayed turn is inspected. */
  stopReason?: string
  /** Provider response id (`msg_...`), when the stream reported one. */
  responseId?: string
}

/** One replay envelope as this transport writes and reads it. */
export interface AnthropicReplayState {
  response: AnthropicReplayResponse
  blocks: readonly AnthropicReplayBlock[]
}

/** Joined text of the blocks a message contributes as text. */
function textOf(message: { readonly content: readonly { type: string; text?: string }[] }): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('')
}

/**
 * The replay metadata of one assistant message, when this route may use it.
 *
 * Every mismatch degrades the message to provider-neutral history instead of
 * failing the request: a signature is bound to both the provider and the model
 * that issued it, another adapter's metadata means nothing here, and a
 * truncated envelope cannot be aligned with the content it decorated. The
 * degradation costs the thinking text of that one turn — an unsigned thinking
 * block is rejected outright — while the text and the calls survive.
 *
 * @param message - durable assistant message with optional adapter-private replay metadata.
 * @param provider - route this request is addressed to.
 * @param model - exact model this request is addressed to.
 * @returns one entry per durable content block, or undefined when none applies.
 */
export function replayBlocksOf(
  message: Extract<RequestMessage, { role: 'assistant' }>,
  provider: string,
  model: string,
): readonly AnthropicReplayBlock[] | undefined {
  const source = message.source
  if (source.provider !== provider || source.model !== model) return undefined
  const envelope = source.replayState
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return undefined
  const record = envelope as Record<string, unknown>
  const response = record['response']
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return undefined
  const facts = response as Record<string, unknown>
  if (facts['kind'] !== REPLAY_KIND || facts['version'] !== REPLAY_VERSION) return undefined
  const blocks = record['blocks']
  if (!Array.isArray(blocks) || blocks.length !== message.content.length) return undefined
  const entries: readonly unknown[] = blocks
  for (const [position, block] of message.content.entries()) {
    const entry = entries[position]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const replay = entry as Record<string, unknown>
    if (replay['type'] !== block.type) return undefined
    if (block.type !== 'reasoning') continue
    for (const signature of ['signature', 'redacted'] as const) {
      const value = replay[signature]
      if (value !== undefined && typeof value !== 'string') return undefined
    }
  }
  return entries as readonly AnthropicReplayBlock[]
}

/** One call whose result the repair will answer. */
interface PairedOutput {
  /** Text the result carried. */
  readonly text: string
  /** Whether the invocation failed. */
  readonly isError: boolean
  /** Image occurrences the result carried, in order. */
  readonly media: readonly ImageBlock[]
}

/** What one history tells the repair about its calls and results. */
interface Pairings {
  /** First result per call id; a repeat is a duplicate the protocol would reject. */
  readonly outputs: ReadonlyMap<string, PairedOutput>
  /** Every call id some assistant turn declares, so an orphan result is recognizable. */
  readonly calls: ReadonlySet<string>
}

/**
 * Read the calls and the results of one history.
 * @param messages - complete request inputs.
 * @returns the first result per call id, and every declared call id.
 */
function scanPairings(messages: readonly RequestMessage[]): Pairings {
  const outputs = new Map<string, PairedOutput>()
  const calls = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool') {
      const id = String(message.toolCallId)
      if (outputs.has(id)) continue
      outputs.set(id, {
        text: textOf(message),
        isError: message.isError === true,
        media: message.content.flatMap(block => block.type === 'image' ? [block] : []),
      })
      continue
    }
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool-call') calls.add(String(block.id))
    }
  }
  return { outputs, calls }
}

/**
 * The `source` one retained image travels as: base64 inline, because a
 * gateway-reachable URL is not something this adapter can assume.
 * @param version - request bytes read from the attachment provider.
 * @returns the protocol's base64 source object.
 */
function imageSource(version: RequestImageAttachment): { type: 'base64'; media_type: string; data: string } {
  return { type: 'base64', media_type: version.mediaType, data: Buffer.from(version.data).toString('base64') }
}

/**
 * One image occurrence as a part: its bytes, or the placeholder text an
 * offloaded occurrence left in its place.
 * @param block - durable image occurrence.
 * @param versions - prepared request versions, keyed by durable attachment id.
 * @returns the protocol part.
 * @throws LlmError `INVALID_CONFIG` when a retained occurrence has no prepared version.
 */
function imagePart(block: ImageBlock, versions: ReadonlyMap<string, RequestImageAttachment>): AnthropicPart {
  if (block.offloaded === true) return { type: 'text', text: offloadedImageText(block) }
  const version = versions.get(block.attachment.attachmentId)
  if (version === undefined) {
    throw new LlmError(
      'llm-service-lite: a retained image occurrence reached the wire without a prepared request version',
      'INVALID_CONFIG',
    )
  }
  return { type: 'image', source: imageSource(version) }
}

/** One user turn's parts, with every image resolved and unknown blocks skipped. */
function userParts(
  content: readonly ContentBlock[],
  versions: ReadonlyMap<string, RequestImageAttachment>,
): AnthropicPart[] {
  const parts: AnthropicPart[] = []
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') parts.push(imagePart(block, versions))
  }
  return parts
}

/** Tool arguments as the protocol's `input` object; a malformed payload sends `{}` rather than an invalid request. */
function toolInput(argumentsText: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsText)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch (_malformedArguments) {
    // The call is replayed with no arguments rather than dropped: its id still
    // pairs with the result the durable log holds for it.
  }
  return {}
}

/**
 * One tool result, with the media the result carried inlined beside its text.
 * @param id - call id this result answers.
 * @param output - the result as the durable log holds it, when it holds one.
 * @param versions - prepared request versions, keyed by durable attachment id.
 * @returns the protocol part.
 */
function toolResultPart(
  id: string,
  output: PairedOutput | undefined,
  versions: ReadonlyMap<string, RequestImageAttachment>,
): AnthropicPart {
  if (output === undefined) {
    return { type: 'tool_result', tool_use_id: id, content: MISSING_RESULT_TEXT }
  }
  return {
    type: 'tool_result',
    tool_use_id: id,
    // A result without media stays a plain string, which is what every
    // endpoint in the wild accepts; media needs the block array.
    content: output.media.length === 0
      ? output.text
      : [{ type: 'text', text: output.text }, ...output.media.map(block => imagePart(block, versions))],
    ...output.isError ? { is_error: true as const } : {},
  }
}

/** One reasoning block as it goes back on the wire, or nothing when it cannot be signed. */
function reasoningPart(text: string, replay: AnthropicReplayBlock | undefined): AnthropicPart | undefined {
  if (replay === undefined || replay.type !== 'reasoning') return undefined
  if (replay.redacted !== undefined) return { type: 'redacted_thinking', data: replay.redacted }
  if (replay.signature === undefined || replay.signature.length === 0) return undefined
  return { type: 'thinking', thinking: text, signature: replay.signature }
}

/**
 * Translate the durable history into Messages wire messages.
 *
 * A route that declared `systemPromptUpdate` or `toolUpdate` gets those
 * changes on the wire this protocol spells them: a `system`-role message at
 * the position the change belongs to, carrying the prompt snapshot and the
 * tool references that activate or deactivate a declared tool. The message is
 * held back until the turn it follows is a user turn, because this protocol
 * reads a system message as an instruction between turns rather than as a
 * sibling of one. Every other route keeps the folding rule below.
 *
 * @param options - the assembled request.
 * @param provider - route this request is addressed to, for replay matching.
 * @param model - the route's declared facts for this model, including replay identity and the two mid-history capabilities.
 * @param versions - prepared request images, keyed by durable attachment id.
 * @returns protocol messages in conversation order, always ending on a user turn
 *   once a call has been made in them.
 */
export function toAnthropicMessages(
  options: GenerateOptions,
  provider: string,
  model: ResolvedOwcModel,
  versions: ReadonlyMap<string, RequestImageAttachment>,
): AnthropicMessage[] {
  const messages = options.messages
  const { outputs, calls } = scanPairings(messages)
  const declared = new Set<string>()
  const answered = new Set<string>()
  let pending: string[] = []
  let batch: AnthropicPart[] = []
  const out: AnthropicMessage[] = []

  /** Whether a mid-history change travels as the `system` message this protocol reserves for it. */
  const inHistory = model.systemPromptUpdate === 'in-history' || model.toolUpdate !== undefined
  let updates: AnthropicSystemPart[] = []
  /**
   * Place the queued mid-history changes. They belong between the user turn
   * they instruct and the assistant turn that answers it, which is also the
   * only position this protocol accepts them in — a change that would land
   * before any turn is a request the endpoint rejects, so it is refused here
   * with the reason instead.
   */
  const flushUpdates = (): void => {
    if (updates.length === 0) return
    if (out.at(-1)?.role !== 'user') {
      throw new LlmError(
        'llm-service-lite: a mid-history system update has no preceding user turn to follow;'
        + ' this route declared systemPromptUpdate or toolUpdate, which needs one',
        'UNSUPPORTED_CONTENT',
      )
    }
    out.push({ role: 'system', content: updates })
    updates = []
  }

  /**
   * The one exit for a call the durable log never answered: it is answered with
   * what it did produce, or with a placeholder. Registering the id here is what
   * makes a later real result a duplicate the repair drops rather than a second
   * result for one call.
   */
  const answers = (ids: readonly string[]): AnthropicPart[] => {
    const parts: AnthropicPart[] = []
    for (const id of ids) {
      if (answered.has(id)) continue
      answered.add(id)
      parts.push(toolResultPart(id, outputs.get(id), versions))
    }
    return parts
  }
  // Placeholders are produced only when a batch closes: a sibling's result that
  // arrives later in the same batch is a real answer, and answering early would
  // put two results for one call in the same request. A non-empty batch always
  // contributes content, so closing one never emits an empty user turn.
  const flushBatch = (): void => {
    if (batch.length === 0) return
    const content = [...batch, ...answers(pending)]
    batch = []
    pending = []
    out.push({ role: 'user', content })
  }
  // Reached only when no result arrived for a pending call at all, which is why
  // every id here is still unanswered and the turn it produces is never empty.
  const flushPending = (): void => {
    if (pending.length === 0) return
    const content = answers(pending)
    pending = []
    out.push({ role: 'user', content })
  }
  // A leading system message supplies the top-level system prompt; every later
  // system and developer message has no slot of its own in this protocol and
  // folds into a user turn where it stands, so a mid-conversation instruction
  // keeps its position instead of being hoisted to the top.
  const leading = usesLeadingSystem(options)

  for (const [index, message] of messages.entries()) {
    if (leading && index === 0) continue
    if (message.role === 'tool') {
      const id = String(message.toolCallId)
      // Orphan results are dropped (the endpoint has no call to attach them
      // to) and a repeat is dropped too; both are shapes a durable log can hold
      // after an interrupted turn and neither is one this protocol accepts.
      if (calls.has(id) && declared.has(id) && !answered.has(id)) {
        answered.add(id)
        batch.push(toolResultPart(id, outputs.get(id), versions))
      }
      if (messages[index + 1]?.role !== 'tool') flushBatch()
      continue
    }
    // A turn that is not a result closes whatever batch preceded it, in the
    // order the protocol requires: assistant call, user results, next turn.
    flushBatch()
    flushPending()
    // A route that reads tool changes must not silently drop one that arrived
    // on another role: this protocol has no part for it there, and a lost
    // activation is a request that disagrees with the session about which
    // tools exist. A route that declared neither capability keeps skipping the
    // block, which is the same reading it gives every other unknown block.
    if (inHistory && message.role !== 'system' && message.role !== 'developer'
      && message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')) {
      throw new LlmError(
        `llm-service-lite: a ${message.role} message carries a tool-addition or tool-removal block;`
        + ' both belong to developer messages, and this protocol has no part for them on another role',
        'UNSUPPORTED_CONTENT',
      )
    }
    if (message.role === 'user') {
      const content = userParts(message.content, versions)
      if (content.length > 0) out.push({ role: 'user', content })
      continue
    }
    if (message.role === 'system' || message.role === 'developer') {
      // A route that declared mid-history changes keeps the role this
      // protocol reserves for them: the update is queued and lands between
      // the user turn it instructs and the answer to it.
      if (inHistory && (message.role === 'developer' || model.systemPromptUpdate === 'in-history')) {
        updates.push(...systemParts(message))
        continue
      }
      const text = textOf(message)
      if (text.length > 0) out.push({ role: 'user', content: [{ type: 'text', text }] })
      continue
    }
    flushUpdates()
    const replayed = replayBlocksOf(message, provider, model.id)
    const content: AnthropicPart[] = []
    for (const [position, block] of message.content.entries()) {
      if (block.type === 'text') {
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        continue
      }
      if (block.type === 'tool-call') {
        const id = String(block.id)
        // One declaration per call id: a history that repeats an id collapses
        // to its first occurrence instead of a request the endpoint rejects.
        if (declared.has(id)) continue
        declared.add(id)
        pending.push(id)
        content.push({ type: 'tool_use', id, name: block.name, input: toolInput(block.arguments) })
        continue
      }
      if (block.type === 'reasoning') {
        const part = reasoningPart(block.text, replayed?.[position])
        if (part !== undefined) content.push(part)
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: TRIMMED_TURN_TEXT })
    out.push({ role: 'assistant', content })
  }
  flushBatch()
  flushPending()
  flushUpdates()
  return out
}

/**
 * The parts one mid-history message contributes when the route declared
 * mid-history changes: prompt text as itself, and each tool change as the
 * reference this protocol spells. Any other block is refused by name rather
 * than dropped — a message the endpoint cannot read in full must not look like
 * a request that carried it.
 * @param message - developer or system message from the durable history.
 * @returns the parts to queue, empty when the message carried nothing.
 * @throws LlmError `UNSUPPORTED_CONTENT` naming a block this role cannot carry.
 */
function systemParts(message: RequestMessage): AnthropicSystemPart[] {
  const parts: AnthropicSystemPart[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'tool-addition') {
      parts.push({ type: 'tool_addition', tool: { type: 'tool_reference', name: block.toolName } })
      continue
    }
    if (block.type === 'tool-removal') {
      parts.push({ type: 'tool_removal', tool: { type: 'tool_reference', name: block.toolName } })
      continue
    }
    throw new LlmError(
      `llm-service-lite: a mid-history system message carries a ${block.type} block,`
      + ' which this protocol reads only as prompt text or a tool reference',
      'UNSUPPORTED_CONTENT',
    )
  }
  return parts
}

/**
 * The effective output cap: the request's own, else the profile's override,
 * else the model's configured default, else the cap its family documents.
 * This protocol requires the field, so it is always sent — and a model no
 * family speaks for falls back to the conservative unmatched default.
 */
function effectiveMaxTokens(profile: ResolvedOwcProviderProfile, model: ResolvedOwcModel, options: GenerateOptions): number {
  if (options.maxTokens !== undefined) return options.maxTokens
  const override = profile.extraBody['max_tokens']
  if (typeof override === 'number') return override
  return model.defaults.maxTokens ?? anthropicMaxTokensOf(model.id)
}

/** Extended thinking's documented floor; a smaller budget is rejected outright. */
const MIN_THINKING_BUDGET = 1_024

/**
 * Extended-thinking budget for the given output cap: thinking and answer share
 * `max_tokens`, so the budget leaves the answer room — an eighth of the cap, at
 * least the floor — instead of asking for a budget that leaves none. A cap too
 * small for the floor asks for the largest budget below it, which the endpoint
 * rejects by name rather than silently truncating the answer.
 * @param maxTokens - effective output cap of this request.
 * @returns the budget to declare.
 */
export function extendedThinkingBudget(maxTokens: number): number {
  const headroom = Math.max(MIN_THINKING_BUDGET, Math.floor(maxTokens / 8))
  const budget = maxTokens - headroom
  if (budget >= MIN_THINKING_BUDGET) return budget
  return Math.min(MIN_THINKING_BUDGET, Math.max(1, maxTokens - 1))
}

/**
 * The reasoning fields this request declares.
 *
 * The harness exposes one selector, so the level the caller picked decides
 * both spellings: an effort level becomes `output_config.effort`, and a
 * thinking mode becomes the `thinking` block. A model that declares efforts but
 * no mode sends only the effort — the endpoint's own default then applies — and
 * a request that selected nothing sends neither field, because a capability the
 * profile did not declare is not one this adapter invents.
 * @param model - the route's declared facts for this model.
 * @param level - the wire meaning of the selected level.
 * @param maxTokens - effective output cap, which bounds an extended budget.
 * @returns fields to merge into the request body.
 */
function thinkingFields(
  model: ResolvedOwcModel,
  level: ReturnType<typeof reasoningLevelOf>,
  maxTokens: number,
): Record<string, unknown> {
  if (level.thinking !== true) return {}
  const mode = level.mode ?? (model.thinking.includes('adaptive')
    ? 'adaptive'
    : model.thinking.includes('enabled') ? 'enabled' : undefined)
  return {
    ...level.effort === undefined ? {} : { output_config: { effort: level.effort } },
    ...mode === undefined ? {} : {
      thinking: mode === 'adaptive'
        ? { type: 'adaptive', display: 'summarized' }
        : { type: 'enabled', budget_tokens: extendedThinkingBudget(maxTokens) },
    },
  }
}

/**
 * Whether the leading system message supplies the prompt — which is also what
 * removes it from the conversation, because this protocol reads its prompt in a
 * top-level field rather than as a turn.
 * @param options - the assembled request.
 * @returns whether the first history message is that system message.
 */
function usesLeadingSystem(options: GenerateOptions): boolean {
  if (options.system !== undefined && options.system.length > 0) return false
  return options.messages[0]?.role === 'system'
}

/**
 * The top-level `system` field: the request's own prompt, else the leading
 * system message. Cache breakpoints are marked on it when the route declares
 * prompt caching, which is what pins the stable prefix of every later request.
 */
function systemField(options: GenerateOptions, caching: boolean): Record<string, unknown> {
  const [first] = options.messages
  const text = usesLeadingSystem(options) && first !== undefined ? textOf(first) : options.system
  if (text === undefined || text.length === 0) return {}
  if (!caching) return { system: text }
  return { system: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] }
}

/**
 * Assemble the HTTP request for one Messages call.
 *
 * @param profile - resolved route.
 * @param model - the route's declared facts for this model.
 * @param options - the assembled request.
 * @param apiKey - resolved credential, when the route authenticates.
 * @param versions - prepared request images, keyed by durable attachment id.
 * @returns endpoint, headers, and serialized body.
 */
export function anthropicRequest(
  profile: ResolvedOwcProviderProfile,
  model: ResolvedOwcModel,
  options: GenerateOptions,
  apiKey: string | undefined,
  versions: ReadonlyMap<string, RequestImageAttachment> = new Map(),
): AnthropicHttpRequest {
  const caching = profile.promptCaching
  const level = reasoningLevelOf(model, reasoningLevelFor(model, options.reasoningEffort))
  const maxTokens = effectiveMaxTokens(profile, model, options)
  const tools = options.tools === undefined || options.tools.length === 0 || !model.tools ? [] : options.tools
  // A caller's own value always wins; the model's declared default is written
  // only where the caller stated none.
  const temperature = options.temperature ?? model.defaults.temperature
  const body: Record<string, unknown> = {
    ...profile.extraBody,
    model: options.model,
    // This protocol requires the output cap, and streaming is opt-in on it.
    max_tokens: maxTokens,
    stream: true,
    ...temperature === undefined ? {} : { temperature },
    ...model.defaults.topP === undefined ? {} : { top_p: model.defaults.topP },
    ...model.defaults.topK === undefined ? {} : { top_k: model.defaults.topK },
    ...options.stop === undefined || options.stop.length === 0 ? {} : { stop_sequences: [...options.stop] },
    ...systemField(options, caching),
    messages: toAnthropicMessages(options, profile.provider, model, versions),
    ...thinkingFields(model, level, maxTokens),
    // The last declaration carries the breakpoint: caching the tools prefix
    // then covers the whole list for every later request.
    ...tools.length === 0 ? {} : {
      tools: tools.map((tool, index) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
        // A deferred declaration stays in the list but is not read until a
        // later system message activates it; the harness only marks a tool this
        // way for a route that declared it accepts mid-conversation changes.
        ...tool.deferLoading === true ? { defer_loading: true } : {},
        ...caching && index === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {},
      })),
    },
  }
  return {
    url: `${profile.baseURL.replace(/\/+$/u, '')}/messages`,
    headers: {
      ...attributionHeaders(),
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': ANTHROPIC_VERSION,
      ...profile.headers,
      // The official API authenticates with `x-api-key`, while an
      // Anthropic-compatible gateway may expect `Authorization: Bearer` — both
      // spellings travel so either endpoint resolves the same credential.
      ...apiKey === undefined || apiKey.length === 0
        ? {}
        : { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}` },
    },
    body: JSON.stringify(body),
  }
}
