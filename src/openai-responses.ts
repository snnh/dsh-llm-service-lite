/**
 * The `openai-responses` wire: request assembly and the input mapping every
 * durable history needs before it crosses this protocol.
 *
 * The Responses API does not take a conversation of roles but a flat list of
 * *items*: an assistant turn is a `message` item, a call is a `function_call`
 * item, its result is a `function_call_output` item carrying the same
 * `call_id`, and reasoning is its own item that must precede the message it
 * belongs to. That vocabulary has its own pairing rules and its own failure
 * modes — a call whose output is missing, a duplicated call, or an output no
 * call ever declared — and a durable session can hold all of them after an
 * interrupted turn. The mapping therefore repairs the input the way this
 * plugin's other transports repair theirs, with one difference the protocol
 * forces: a call nothing answered is *dropped* rather than answered with a
 * placeholder, because this API validates that every `function_call` has an
 * output and strict gateways reject a fabricated one. Parallel calls are
 * grouped — every `function_call` of a turn, then every output — because the
 * API folds consecutive items into the assistant turn they belong to, and
 * interleaving pairs would split one turn into several.
 *
 * Reasoning replay follows the model's declaration: `reasoningContent` replays
 * the thinking text as `reasoning_text` parts, and `responsesEncryptedReplay`
 * replays the provider's own reasoning item verbatim — id and encrypted
 * payload included, which is what lets a stateless request resume a turn whose
 * reasoning the provider refuses to accept as plain text.
 *
 * @module dsh-llm-service-lite/openai-responses
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { offloadedImageText } from './images.ts'
import { reasoningLevelFor, reasoningLevelOf } from './models.ts'
import type { ResolvedOwcModel, ResolvedOwcProviderProfile } from './profiles.ts'

/** This API rejects an output cap below this value. */
const MIN_OUTPUT_TOKENS = 16

/** One assembled request, ready for `fetch`. */
export interface ResponsesHttpRequest {
  /** Absolute endpoint for this protocol. */
  readonly url: string
  /** Request headers, attribution and profile headers included. */
  readonly headers: Record<string, string>
  /** Serialized JSON body. */
  readonly body: string
}

/** One content part of a message item. */
type ResponsesPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; detail: 'auto'; image_url: string }
  | { type: 'output_text'; text: string; annotations: unknown[] }

/** One assistant message item. */
interface ResponsesMessageItem {
  type: 'message'
  role: 'user' | 'assistant'
  content: ResponsesPart[]
  id?: string
}

/** One call item. */
interface ResponsesCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
  id?: string
}

/** One call result item. */
interface ResponsesOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

/**
 * One reasoning item. The plain-text form this adapter writes is typed; a
 * provider item replayed verbatim keeps whatever fields it carried.
 */
type ResponsesReasoningItem = { type: 'reasoning' } & Record<string, unknown>

/** One input item as this protocol spells it. */
type ResponsesItem = ResponsesMessageItem | ResponsesCallItem | ResponsesOutputItem | ResponsesReasoningItem

/** Replay-metadata kinds this transport writes and reads. */
export const RESPONSES_REPLAY_KIND = 'llm-service-lite-responses'
/** Schema version of this transport's replay metadata. */
export const RESPONSES_REPLAY_VERSION = 1

/** Per-block half of this transport's replay metadata, one entry per durable block. */
export type ResponsesReplayBlock =
  | { type: 'text'; itemId?: string }
  | { type: 'reasoning'; itemId?: string; item?: string }
  | { type: 'tool-call'; itemId?: string }

/** Response-level half of this transport's replay metadata. */
export interface ResponsesReplayResponse {
  kind: typeof RESPONSES_REPLAY_KIND
  version: typeof RESPONSES_REPLAY_VERSION
  /** Provider response id (`resp_...`), when the stream reported one. */
  responseId?: string
  /** Provider status the stream ended on, for diagnostics. */
  stopReason?: string
}

/** One replay envelope as this transport writes and reads it. */
export interface ResponsesReplayState {
  response: ResponsesReplayResponse
  blocks: readonly ResponsesReplayBlock[]
}

/** Joined text of the blocks a message contributes as text. */
function textOf(message: { readonly content: readonly ContentBlock[] }): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/**
 * The replay metadata of one assistant message, when this route may use it.
 *
 * Every mismatch degrades the message to provider-neutral input instead of
 * failing the request: another adapter's metadata means nothing here, another
 * version cannot be read, and an envelope that no longer aligns with the
 * content cannot be trusted. A degraded turn still carries its text and its
 * calls; it loses the reasoning the provider would have accepted back.
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
): readonly ResponsesReplayBlock[] | undefined {
  const source = message.source
  if (source.provider !== provider || source.model !== model) return undefined
  const envelope = source.replayState
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return undefined
  const record = envelope as Record<string, unknown>
  const response = record['response']
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return undefined
  const facts = response as Record<string, unknown>
  if (facts['kind'] !== RESPONSES_REPLAY_KIND || facts['version'] !== RESPONSES_REPLAY_VERSION) return undefined
  const blocks = record['blocks']
  if (!Array.isArray(blocks) || blocks.length !== message.content.length) return undefined
  const entries: readonly unknown[] = blocks
  for (const [position, block] of message.content.entries()) {
    const entry = entries[position]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const replay = entry as Record<string, unknown>
    if (replay['type'] !== block.type) return undefined
    for (const field of ['itemId', 'item'] as const) {
      const value = replay[field]
      if (value !== undefined && typeof value !== 'string') return undefined
    }
  }
  return entries as readonly ResponsesReplayBlock[]
}

/** One call whose result the mapping will pair. */
interface PairedOutput {
  /** Text the result carried. */
  readonly text: string
  /** Image occurrences the result carried, in order. */
  readonly media: readonly ImageBlock[]
}

/** What one history tells the mapping about its calls and results. */
interface Pairings {
  /** First result per call id; a repeat is a duplicate this API would reject. */
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
 * One image occurrence as an input part: its bytes, or the placeholder text an
 * offloaded occurrence left in its place.
 * @param block - durable image occurrence.
 * @param versions - prepared request versions, keyed by durable attachment id.
 * @returns the protocol part.
 * @throws LlmError `INVALID_CONFIG` when a retained occurrence has no prepared version.
 */
function imagePart(block: ImageBlock, versions: ReadonlyMap<string, RequestImageAttachment>): ResponsesPart {
  if (block.offloaded === true) return { type: 'input_text', text: offloadedImageText(block) }
  const version = versions.get(block.attachment.attachmentId)
  if (version === undefined) {
    throw new LlmError(
      'llm-service-lite: a retained image occurrence reached the wire without a prepared request version',
      'INVALID_CONFIG',
    )
  }
  const data = Buffer.from(version.data).toString('base64')
  return { type: 'input_image', detail: 'auto', image_url: `data:${version.mediaType};base64,${data}` }
}

/** One user turn's parts, with every image resolved and unknown blocks skipped. */
function userParts(
  content: readonly ContentBlock[],
  versions: ReadonlyMap<string, RequestImageAttachment>,
): ResponsesPart[] {
  const parts: ResponsesPart[] = []
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'input_text', text: block.text })
      continue
    }
    if (block.type === 'image') parts.push(imagePart(block, versions))
  }
  return parts
}

/**
 * The item that answers one batch: a synthesized user turn carrying the media
 * the batch's results produced. Tool results cannot hold images here, and this
 * API pairs calls with their outputs by id, so the media follows the outputs
 * as one user item.
 */
function mediaItem(media: readonly ImageBlock[], versions: ReadonlyMap<string, RequestImageAttachment>): ResponsesItem | undefined {
  if (media.length === 0) return undefined
  return {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'Attached media from tool result:' },
      ...media.map(block => imagePart(block, versions)),
    ],
  }
}

/** One reasoning item replayed as plain text, in the shape a thinking-mode endpoint expects. */
function reasoningTextItem(text: string): ResponsesReasoningItem {
  return { type: 'reasoning', content: [{ type: 'reasoning_text', text }] }
}

/**
 * The provider's own reasoning item, when this route may replay it verbatim.
 * Only a model that declares encrypted replay may send it back, and only an
 * item this transport wrote is trusted: the payload is opaque, so any
 * malformation degrades the one block rather than failing the request.
 * @param entry - the block's replay metadata.
 * @returns the item, or undefined when it cannot be replayed.
 */
function encryptedReasoningItem(entry: ResponsesReplayBlock | undefined): ResponsesReasoningItem | undefined {
  if (entry === undefined || entry.type !== 'reasoning' || entry.item === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(entry.item)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>)['type'] === 'reasoning') {
      return parsed as ResponsesReasoningItem
    }
  } catch (_malformedReplayItem) {
    // Unreadable metadata degrades the block to nothing: this API rejects a
    // reasoning item it cannot parse, and the text form may still follow.
  }
  return undefined
}

/** The reasoning pre-items one assistant turn contributes, in block order. */
function reasoningItems(
  message: Extract<RequestMessage, { role: 'assistant' }>,
  replayed: readonly ResponsesReplayBlock[] | undefined,
  plainText: boolean,
  encrypted: boolean,
): ResponsesReasoningItem[] {
  const items: ResponsesReasoningItem[] = []
  for (const [position, block] of message.content.entries()) {
    if (block.type !== 'reasoning') continue
    const entry = replayed?.[position]
    if (encrypted) {
      const verbatim = encryptedReasoningItem(entry)
      if (verbatim !== undefined) {
        items.push(verbatim)
        continue
      }
    }
    // The plain-text form is what a thinking-mode endpoint accepts when there
    // is no encrypted payload to hand back.
    if (plainText && block.text.length > 0) items.push(reasoningTextItem(block.text))
  }
  return items
}

/**
 * Translate the durable history into Responses input items.
 *
 * @param options - the assembled request.
 * @param provider - route this request is addressed to, for replay matching.
 * @param model - the route's declared facts for this model.
 * @param versions - prepared request images, keyed by durable attachment id.
 * @returns protocol input items in conversation order.
 */
export function toResponsesInput(
  options: GenerateOptions,
  provider: string,
  model: ResolvedOwcModel,
  versions: ReadonlyMap<string, RequestImageAttachment>,
): ResponsesItem[] {
  const messages = options.messages
  const { outputs } = scanPairings(messages)
  const declared = new Set<string>()
  const out: ResponsesItem[] = []
  // A leading system message supplies `instructions`; every later system and
  // developer message has no slot of its own in this protocol and folds into a
  // user item where it stands, so a mid-conversation instruction keeps its
  // position instead of being hoisted to the top.
  const leading = usesLeadingSystem(options)

  for (const [index, message] of messages.entries()) {
    if (leading && index === 0) continue
    if (message.role === 'user') {
      const content = userParts(message.content, versions)
      if (content.length > 0) out.push({ type: 'message', role: 'user', content })
      continue
    }
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message)
      if (text.length > 0) out.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
      continue
    }
    if (message.role === 'tool') continue
    const replayed = replayBlocksOf(message, provider, model.id)
    out.push(...reasoningItems(message, replayed, model.reasoningContent, model.encryptedReplay))
    const text = textOf(message)
    if (text.length > 0) {
      const itemId = replayed?.find(entry => entry.type === 'text')?.itemId
      out.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
        ...itemId === undefined ? {} : { id: itemId },
      })
    }
    // Only calls the log can answer are replayed: a `function_call` without its
    // output is rejected outright, and a fabricated output is one strict
    // gateways refuse. A repeat of an id declared in an earlier turn is
    // dropped too, because this API pairs one output with one call.
    const calls: Array<{ call: ResponsesCallItem; output: PairedOutput }> = []
    for (const [position, block] of message.content.entries()) {
      if (block.type !== 'tool-call') continue
      const id = String(block.id)
      const output = outputs.get(id)
      if (output === undefined || declared.has(id)) continue
      declared.add(id)
      const itemId = replayed?.[position]?.type === 'tool-call' ? replayed[position].itemId : undefined
      calls.push({
        call: {
          type: 'function_call',
          call_id: id,
          name: block.name,
          arguments: block.arguments,
          ...itemId === undefined ? {} : { id: itemId },
        },
        output,
      })
    }
    // Every call of one turn precedes every output: the API folds consecutive
    // items into the assistant turn they belong to, and an interleaved pair
    // would split one parallel batch into several turns.
    out.push(...calls.map(entry => entry.call))
    const media: ImageBlock[] = []
    for (const entry of calls) {
      out.push({ type: 'function_call_output', call_id: entry.call.call_id, output: entry.output.text })
      media.push(...entry.output.media)
    }
    const attached = mediaItem(media, versions)
    if (attached !== undefined) out.push(attached)
  }
  return out
}

/**
 * Whether the leading system message supplies the instructions — which is also
 * what removes it from the input, because this protocol reads instructions in a
 * top-level field rather than as an item.
 * @param options - the assembled request.
 * @returns whether the first history message is that system message.
 */
function usesLeadingSystem(options: GenerateOptions): boolean {
  if (options.system !== undefined && options.system.length > 0) return false
  return options.messages[0]?.role === 'system'
}

/** The instructions field: the request's own prompt, else the leading system message. */
function instructionsOf(options: GenerateOptions): string | undefined {
  const [first] = options.messages
  const text = usesLeadingSystem(options) && first !== undefined ? textOf(first) : options.system
  return text === undefined || text.length === 0 ? undefined : text
}

/**
 * The reasoning fields this request declares, and whether the encrypted-replay
 * include belongs with them.
 *
 * This protocol spells reasoning as an effort and a summary request; it has no
 * switch for turning thinking on, so a mode-only selection sends nothing and
 * the endpoint's own default applies. Disabling thinking is expressible for a
 * model whose profile declares a switch this protocol can spell.
 * @param model - the route's declared facts for this model.
 * @param level - the wire meaning of the selected level.
 * @returns fields to merge into the body, and whether the request asks for encrypted reasoning.
 */
function reasoningFields(
  model: ResolvedOwcModel,
  level: ReturnType<typeof reasoningLevelOf>,
): { reasoning?: Record<string, unknown>; includeEncrypted: boolean } {
  if (level.thinking === false) {
    const spellable = model.thinkingStyle === 'thinking' || model.thinkingStyle === 'fixed'
    return { ...spellable ? { reasoning: { effort: 'none' } } : {}, includeEncrypted: false }
  }
  if (level.effort === undefined) return { includeEncrypted: false }
  return {
    reasoning: { effort: level.effort, summary: 'auto' },
    includeEncrypted: model.encryptedReplay,
  }
}

/**
 * Assemble the HTTP request for one Responses call.
 *
 * @param profile - resolved route.
 * @param model - the route's declared facts for this model.
 * @param options - the assembled request.
 * @param apiKey - resolved credential, when the route authenticates.
 * @param versions - prepared request images, keyed by durable attachment id.
 * @returns endpoint, headers, and serialized body.
 */
export function responsesRequest(
  profile: ResolvedOwcProviderProfile,
  model: ResolvedOwcModel,
  options: GenerateOptions,
  apiKey: string | undefined,
  versions: ReadonlyMap<string, RequestImageAttachment> = new Map(),
): ResponsesHttpRequest {
  const level = reasoningLevelOf(model, reasoningLevelFor(model, options.reasoningEffort))
  const reasoning = reasoningFields(model, level)
  const maxTokens = options.maxTokens ?? model.defaults.maxTokens ?? model.maxTokens
  const tools = options.tools === undefined || options.tools.length === 0 || !model.tools ? [] : options.tools
  // A caller's own value always wins; the model's declared default is written
  // only where the caller stated none.
  const temperature = options.temperature ?? model.defaults.temperature
  const topP = model.defaults.topP
  const body: Record<string, unknown> = {
    ...profile.extraBody,
    model: options.model,
    stream: true,
    ...instructionsOf(options) === undefined ? {} : { instructions: instructionsOf(options) },
    input: toResponsesInput(options, profile.provider, model, versions),
    // This API rejects a cap below its own floor; the profile's cap is raised
    // to it rather than refused.
    max_output_tokens: Math.max(maxTokens, MIN_OUTPUT_TOKENS),
    // Reasoning rejects sampling: an endpoint that reads `reasoning.effort`
    // answers a temperature with a 400, so it is sent only without one.
    ...level.effort === undefined && temperature !== undefined ? { temperature } : {},
    ...level.effort === undefined && topP !== undefined ? { top_p: topP } : {},
    ...tools.length === 0 ? {} : {
      tools: tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
    ...reasoning.reasoning === undefined ? {} : { reasoning: reasoning.reasoning },
    ...reasoning.includeEncrypted ? { include: ['reasoning.encrypted_content'] } : {},
  }
  return {
    url: `${profile.baseURL.replace(/\/+$/u, '')}/responses`,
    headers: {
      ...attributionHeaders(),
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...profile.headers,
      ...apiKey === undefined || apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` },
    },
    body: JSON.stringify(body),
  }
}
