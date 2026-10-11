/**
 * The `openai-chat-completions` wire: request assembly and stream translation.
 *
 * The request body follows OWC's field order and its two deliberate silences:
 * `max_tokens` is sent only when a request configured one, and the thinking
 * switch is sent only for a model whose catalog declares how this endpoint
 * spells it. Everything else about the endpoint — its extra body fields, its
 * usage report, its reasoning dialect — is a profile declaration, so a gateway
 * reaches the same path as a first-party endpoint with no code change.
 *
 * The translator reconstructs the harness's block stream from the provider's
 * delta stream, which means it owns three things the provider does not: block
 * identity and ordering, tool-call assembly across fragments, and the
 * distinction between a stream that ended and one that was cut off.
 *
 * @module dsh-llm-service-lite/chat-completions
 */

import { attributionHeaders, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, RequestMessage, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { imageDataUrl, offloadedImageText } from './images.ts'
import { decodeGeneratedImage, type AdapterChunk } from './image-output.ts'
import type { ResolvedOwcModel, ResolvedOwcProviderProfile } from './profiles.ts'
import { reasoningLevelFor, reasoningLevelOf, replaysReasoning } from './models.ts'
import { classifyFailure } from './errors.ts'

/** One assembled request, ready for `fetch`. */
export interface ChatHttpRequest {
  /** Absolute endpoint for this protocol. */
  readonly url: string
  /** Request headers, attribution and profile headers included. */
  readonly headers: Record<string, string>
  /** Serialized JSON body. */
  readonly body: string
}

/** One tool call accumulated from streamed fragments, with its allocated block index. */
interface ToolAccumulator {
  id: string
  name: string
  arguments: string
  /** Block index once the call was announced; -1 while its id has not arrived. */
  index: number
}

/** A block currently being streamed, and the index it owns. */
interface OpenBlock {
  readonly index: number
  text: string
}

/** Tool-call fragments one choice delta may carry. */
interface WireToolCall {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

/** The subset of one streamed choice this protocol reads. */
interface WireDelta {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: WireToolCall[]
  /**
   * Image parts a model that returns pictures sends beside its text. The
   * protocol documents them on the delta and on a whole message, so both are
   * read; anything else on these fields is ignored.
   */
  images?: unknown
}

/** One image part as this protocol spells it. */
interface WireImagePart {
  image_url?: { url?: string }
}

/** The image URLs one choice states, from the delta or a whole message. */
function imageUrls(choice: WireChoice): string[] {
  const urls: string[] = []
  for (const container of [choice.delta, choice.message]) {
    if (!Array.isArray(container?.images)) continue
    for (const part of container.images) {
      const url = (part as WireImagePart | null)?.image_url?.url
      if (typeof url === 'string') urls.push(url)
    }
  }
  return urls
}

/** The subset of one choice this protocol reads, streamed or whole. */
interface WireChoice {
  finish_reason?: string | null
  delta?: WireDelta
  message?: WireDelta
}

/** The subset of one streamed chunk this protocol reads. */
interface WireChunk {
  choices?: WireChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

/** Content parts of one translated message. */
type WireContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/** One message as the chat-completions protocol spells it. */
interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | WireContentPart[] | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
  reasoning_content?: string
}

/** Concatenated text of the blocks a message role contributes as text. */
function textOf(message: { readonly content: readonly ContentBlock[] }): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/**
 * The thinking switch OWC's catalog declares for this endpoint, if it has one.
 * A model that declares no style sends only its effort level, which is what
 * lets an OpenAI-compatible gateway with an unusual dialect take the same code
 * path as a first-party endpoint.
 */
function thinkingSwitch(model: ResolvedOwcModel, thinking: boolean | undefined): Record<string, unknown> {
  // `effort_only` is the explicit spelling of "this endpoint has no switch",
  // which is the same request an omitted style produces.
  if (model.thinkingStyle === undefined || model.thinkingStyle === 'effort_only' || thinking === undefined) return {}
  if (model.thinkingStyle === 'enable_thinking') return { enable_thinking: thinking }
  return { thinking: { type: thinking ? 'enabled' : 'disabled' } }
}

/**
 * Replay rules for tool calls, mirroring OWC's pairing repair.
 *
 * A chat-completions endpoint rejects a request whose `tool_calls` have no
 * matching tool message, and rejects a tool message whose call it never saw.
 * A durable history after an interrupted turn can contain both shapes, so the
 * translation pairs what it can, drops orphan results, and answers a call
 * whose result never landed with a placeholder.
 */
function toolPairings(messages: readonly RequestMessage[]): {
  results: Map<string, { text: string; isError: boolean }>
} {
  const results = new Map<string, { text: string; isError: boolean }>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    results.set(String(message.toolCallId), { text: textOf(message), isError: message.isError === true })
  }
  return { results }
}

/**
 * Translate the durable history into chat-completions messages.
 *
 * @param options - the assembled request.
 * @param model - the route's declared facts for this model.
 * @param versions - prepared request images, keyed by durable attachment id.
 * @returns protocol messages in conversation order.
 */
export function toWireMessages(
  options: GenerateOptions,
  model: ResolvedOwcModel,
  versions: ReadonlyMap<string, RequestImageAttachment>,
): WireMessage[] {
  const messages = options.messages
  const { results } = toolPairings(messages)
  const emittedCalls = new Set<string>()
  const out: WireMessage[] = []
  if (options.system !== undefined && options.system.length > 0) {
    out.push({ role: 'system', content: options.system })
  }
  for (const message of messages) {
    switch (message.role) {
      case 'system':
      case 'developer': {
        const text = textOf(message)
        if (text.length > 0) out.push({ role: 'system', content: text })
        break
      }
      case 'user': {
        const parts: WireContentPart[] = message.content.flatMap((block): WireContentPart[] => {
          if (block.type === 'text') return block.text.length > 0 ? [{ type: 'text', text: block.text }] : []
          if (block.type !== 'image') return []
          if (block.offloaded === true) return [{ type: 'text', text: offloadedImageText(block) }]
          const version = versions.get(block.attachment.attachmentId)
          if (version === undefined) {
            throw new LlmError(
              'llm-service-lite: a retained image occurrence reached the wire without a prepared request version',
              'INVALID_CONFIG',
            )
          }
          return [{ type: 'image_url', image_url: { url: imageDataUrl(version) } }]
        })
        if (parts.length === 0) break
        // A text-only turn stays a plain string: some gateways reject the
        // parts array outright, and nothing is gained by sending one part.
        const text = parts.map(part => part.type === 'text' ? part.text : '').join('')
        out.push({ role: 'user', content: parts.every(part => part.type === 'text') ? text : parts })
        break
      }
      case 'assistant': {
        // One declaration per call id, counting the ids already answered in
        // this request: the protocol pairs a single tool message with each
        // call, so a history that repeats an id collapses to its first
        // occurrence instead of a request the endpoint rejects.
        const declared = new Set<string>()
        const calls = message.content.flatMap((block) => {
          if (block.type !== 'tool-call') return []
          const id = String(block.id)
          if (emittedCalls.has(id) || declared.has(id)) return []
          declared.add(id)
          return [block]
        })
        const replay = replaysReasoning(model) && message.source.provider === options.provider
        const reasoning = message.content.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join('\n')
        const text = textOf(message)
        // A turn whose calls were all emitted already, and that carries no
        // text or reasoning, contributes nothing: sending it would be an
        // assistant message with neither content nor calls, which endpoints refuse.
        if (text.length === 0 && calls.length === 0 && !(replay && reasoning.length > 0)) break
        const wire: WireMessage = {
          role: 'assistant',
          content: text.length > 0 ? text : calls.length > 0 ? null : '',
          ...calls.length === 0 ? {} : {
            tool_calls: calls.map(block => ({
              id: String(block.id),
              type: 'function' as const,
              function: { name: block.name, arguments: block.arguments },
            })),
          },
          ...replay && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
        }
        out.push(wire)
        for (const call of calls) {
          emittedCalls.add(String(call.id))
          const result = results.get(String(call.id))
          // Answered immediately after its call: the protocol requires the
          // tool message to follow the assistant turn that requested it.
          out.push({
            role: 'tool',
            tool_call_id: String(call.id),
            content: result?.text ?? 'Tool result missing: this call did not complete.',
          })
        }
        break
      }
      // Results are inlined with their calls above; a standalone one is an
      // orphan the endpoint would reject, so it is dropped.
      case 'tool': break
      default: break
    }
  }
  return out
}

/**
 * Assemble the HTTP request for one chat-completions call.
 *
 * @param profile - resolved route.
 * @param model - the route's declared facts for this model.
 * @param options - the assembled request.
 * @param apiKey - resolved credential, when the route authenticates.
 * @param versions - prepared request images, keyed by durable attachment id.
 * @returns endpoint, headers, and serialized body.
 */
export function chatRequest(
  profile: ResolvedOwcProviderProfile,
  model: ResolvedOwcModel,
  options: GenerateOptions,
  apiKey: string | undefined,
  versions: ReadonlyMap<string, RequestImageAttachment> = new Map(),
): ChatHttpRequest {
  const level = reasoningLevelOf(model, reasoningLevelFor(model, options.reasoningEffort))
  const messages = toWireMessages(options, model, versions)
  // A caller's own value always wins. The model's declared default is written
  // only where the caller stated none, so a profile setting can never override
  // a choice a request made explicitly.
  const temperature = options.temperature ?? model.defaults.temperature
  const body: Record<string, unknown> = {
    ...profile.extraBody,
    model: options.model,
    stream: true,
    ...profile.includeUsage ? { stream_options: { include_usage: true } } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...temperature === undefined ? {} : { temperature },
    ...model.defaults.topP === undefined ? {} : { top_p: model.defaults.topP },
    ...model.defaults.topK === undefined ? {} : { top_k: model.defaults.topK },
    ...level.effort === undefined ? {} : { reasoning_effort: level.effort },
    ...thinkingSwitch(model, level.thinking),
    messages,
  }
  // A model that declares `tools: false` is one whose endpoint has no tool
  // protocol; the request carries no declarations rather than a list the
  // endpoint would reject or silently ignore.
  if (model.tools && options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }
  if (options.stop !== undefined && options.stop.length > 0) body.stop = [...options.stop]
  return {
    url: `${profile.baseURL.replace(/\/+$/u, '')}/chat/completions`,
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

/**
 * Map the provider's finish reason onto the harness vocabulary.
 *
 * A stream that closed without a terminal reason is only a clean stop when it
 * both delivered its sentinel and produced output; otherwise it was cut off
 * mid-turn, which the caller must treat as a transport failure rather than as
 * a completed message.
 */
function finishReasonOf(reason: string | undefined, sawDone: boolean, sawOutput: boolean, hasToolCalls: boolean): FinishReason | undefined {
  if (reason === 'tool_calls' || reason === 'function_call') return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  if (reason === 'content_filter') return { kind: 'stop' }
  if (reason === 'stop') return { kind: 'stop' }
  if (sawDone && sawOutput) return hasToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' }
  return undefined
}

/** Validated token accounting from one provider usage report. */
function usageOf(chunk: WireChunk): TokenUsage | undefined {
  const usage = chunk.usage
  if (usage === undefined || typeof usage.prompt_tokens !== 'number' || typeof usage.completion_tokens !== 'number') {
    return undefined
  }
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  if (!Number.isSafeInteger(cached) || cached < 0 || cached > usage.prompt_tokens) {
    throw new LlmError('llm-service-lite: provider returned invalid cached token usage', 'MALFORMED_RESPONSE')
  }
  return {
    inputTokens: usage.prompt_tokens - cached,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.prompt_tokens + usage.completion_tokens,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  }
}

/**
 * Translate one chat-completions event stream into harness chunks.
 *
 * @param events - decoded JSON events in arrival order.
 * @param sawDone - reports whether the stream delivered its sentinel.
 * @returns the chunk stream, ending with exactly one terminal `finish`.
 * @throws LlmError when the stream carries an in-band provider error, or when it was cut off.
 */
export async function* translateChatStream(
  events: AsyncIterable<Record<string, unknown>>,
  sawDone: () => boolean,
): AsyncGenerator<AdapterChunk> {
  const open = new Map<'text' | 'reasoning', OpenBlock>()
  const tools = new Map<number, ToolAccumulator>()
  let nextIndex = 0
  let stopReason: string | undefined
  let sawOutput = false
  let pendingUsage: TokenUsage | undefined

  const startBlock = (kind: 'text' | 'reasoning'): OpenBlock => {
    const block: OpenBlock = { index: nextIndex, text: '' }
    nextIndex += 1
    open.set(kind, block)
    return block
  }

  const closeBlock = (kind: 'text' | 'reasoning'): StreamChunk | undefined => {
    const block = open.get(kind)
    if (block === undefined) return undefined
    open.delete(kind)
    const content: ContentBlock = kind === 'text' ? { type: 'text', text: block.text } : { type: 'reasoning', text: block.text }
    return { type: 'block-end', index: block.index, block: content }
  }

  /** Chunks that end whichever block is open before a different kind begins. */
  const endOpenBlocks = (): StreamChunk[] => {
    const closing: StreamChunk[] = []
    for (const kind of ['text', 'reasoning'] as const) {
      const end = closeBlock(kind)
      if (end !== undefined) closing.push(end)
    }
    return closing
  }

  for await (const raw of events) {
    if (raw.error !== undefined) throw classifyFailure(raw, undefined)
    const chunk = raw as WireChunk
    const usage = usageOf(chunk)
    if (usage !== undefined) pendingUsage = usage
    for (const choice of chunk.choices ?? []) {
      if (typeof choice.finish_reason === 'string') stopReason = choice.finish_reason
      // Images may arrive on a whole message rather than on a delta, so they
      // are read before the delta is required to exist.
      for (const url of imageUrls(choice)) {
        // An image is a block of its own: text or reasoning still streaming
        // ends here rather than wrapping around it.
        for (const end of endOpenBlocks()) yield end
        const index = nextIndex
        nextIndex += 1
        const image = decodeGeneratedImage(url, 'the chat-completions endpoint')
        sawOutput = true
        yield { type: 'block-start', index, blockType: 'image' }
        yield { type: 'generated-image', index, ...image }
      }
      const delta = choice.delta
      if (delta === undefined) continue
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        sawOutput = true
        if (!open.has('text')) {
          for (const end of endOpenBlocks()) yield end
        }
        const block = open.get('text') ?? startBlock('text')
        if (block.text.length === 0) yield { type: 'block-start', index: block.index, blockType: 'text' }
        block.text += delta.content
        yield { type: 'text-delta', index: block.index, text: delta.content }
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        sawOutput = true
        if (!open.has('reasoning')) {
          for (const end of endOpenBlocks()) yield end
        }
        const block = open.get('reasoning') ?? startBlock('reasoning')
        if (block.text.length === 0) yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
        block.text += delta.reasoning_content
        yield { type: 'reasoning-delta', index: block.index, text: delta.reasoning_content }
      }
      for (const call of delta.tool_calls ?? []) {
        const key = typeof call.index === 'number' ? call.index : tools.size
        const current = tools.get(key) ?? { id: '', name: '', arguments: '', index: -1 }
        if (typeof call.id === 'string' && call.id.length > 0) current.id = call.id
        if (typeof call.function?.name === 'string') current.name += call.function.name
        const fragment = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
        current.arguments += fragment
        tools.set(key, current)
        // A call is announced only once its id is known: the harness
        // correlates every later fragment and the eventual tool result by it.
        if (current.id.length === 0) continue
        sawOutput = true
        if (current.index < 0) {
          current.index = nextIndex
          nextIndex += 1
          // A tool call is a new block: any text or reasoning block that was
          // still streaming ends here rather than wrapping around it.
          for (const end of endOpenBlocks()) yield end
          yield { type: 'block-start', index: current.index, blockType: 'tool-call' }
          // Whatever arguments arrived before the id are emitted here, so no
          // fragment is lost by the late announcement.
          yield {
            type: 'tool-call-delta',
            index: current.index,
            id: ToolCallId(current.id),
            ...current.name.length === 0 ? {} : { name: current.name },
            argumentsDelta: current.arguments,
          }
          continue
        }
        yield {
          type: 'tool-call-delta',
          index: current.index,
          id: ToolCallId(current.id),
          argumentsDelta: fragment,
        }
      }
    }
  }

  const textEnd = closeBlock('text')
  if (textEnd !== undefined) yield textEnd
  const reasoningEnd = closeBlock('reasoning')
  if (reasoningEnd !== undefined) yield reasoningEnd
  const calls = [...tools.values()].filter(call => call.index >= 0).sort((left, right) => left.index - right.index)
  for (const call of calls) {
    yield {
      type: 'block-end',
      index: call.index,
      block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: call.arguments },
    }
  }
  const hasToolCalls = calls.length > 0
  const finish = finishReasonOf(stopReason, sawDone(), sawOutput, hasToolCalls)
  if (finish === undefined) {
    throw new LlmError('llm-service-lite: chat-completions stream ended before a terminal event', 'TRANSPORT')
  }
  if (!sawOutput) throw new LlmError('llm-service-lite: chat-completions response carried no content', 'EMPTY_RESPONSE')
  if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
  yield { type: 'finish', reason: finish }
}
