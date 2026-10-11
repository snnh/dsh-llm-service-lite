/**
 * Translation of one Messages event stream into the harness's chunk
 * vocabulary.
 *
 * The provider streams an event protocol rather than a list of deltas: a
 * content block opens with its identity and closes with an explicit stop, a
 * tool call's arguments arrive as fragments of a JSON string, and the terminal
 * events carry the stop reason and the token accounting. The translator owns
 * three things the provider does not: block identity and ordering, tool-call
 * assembly across fragments, and the difference between a stream that ended and
 * one that was cut off.
 *
 * It also owns the replay metadata this protocol needs and the harness has no
 * field for: signed thinking blocks must be returned unchanged on the next
 * request, so their signatures ride along as adapter-private state on the
 * assistant message and are read back by the request path.
 *
 * @module dsh-llm-service-lite/anthropic-stream
 */

import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { classifyFailure } from './errors.ts'
import { REPLAY_KIND, REPLAY_VERSION } from './anthropic-messages.ts'
import type { AnthropicReplayBlock, AnthropicReplayState } from './anthropic-messages.ts'

/** Content blocks this protocol streams and this adapter carries. */
type BlockKind = 'text' | 'thinking' | 'redacted_thinking' | 'tool_use'

/** One content block as it accumulates, with the block index it owns. */
interface OpenBlock {
  /** Block index in this adapter's own numbering. */
  readonly index: number
  readonly kind: BlockKind
  text: string
  arguments: string
  id: string
  name: string
  signature: string
  data: string
}

/** Token counts as this protocol reports them across the stream. */
interface UsageCounters {
  input: number | undefined
  output: number | undefined
  cacheRead: number | undefined
  cacheWrite: number | undefined
}

/** A JSON object field, or an empty one when the provider sent something else. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** The block index of a stream event, which every block-scoped event carries. */
function blockIndexOf(event: Record<string, unknown>): number {
  const index = event['index']
  if (typeof index !== 'number' || !Number.isSafeInteger(index)) {
    throw new LlmError('llm-service-lite: anthropic-messages stream event carries no block index', 'MALFORMED_RESPONSE')
  }
  return index
}

/** One counter of a usage report; a present but unusable value is a malformed response, not a zero. */
function countOf(usage: Record<string, unknown>, field: string): number | undefined {
  const value = usage[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LlmError(`llm-service-lite: anthropic-messages stream reported an invalid ${field}`, 'MALFORMED_RESPONSE')
  }
  return value
}

/**
 * Merge one usage report into the counters so far: this protocol reports input
 * tokens when the message starts and the final output count when it ends, so
 * each report contributes only the fields it carries.
 * @param usage - the report's usage object.
 * @param previous - counters from earlier reports.
 * @returns the merged counters.
 */
function mergeUsage(usage: Record<string, unknown>, previous: UsageCounters | undefined): UsageCounters {
  return {
    input: countOf(usage, 'input_tokens') ?? previous?.input,
    output: countOf(usage, 'output_tokens') ?? previous?.output,
    cacheRead: countOf(usage, 'cache_read_input_tokens') ?? previous?.cacheRead,
    cacheWrite: countOf(usage, 'cache_creation_input_tokens') ?? previous?.cacheWrite,
  }
}

/**
 * The harness's disjoint token accounting for one completed stream.
 *
 * This protocol's `input_tokens` counts uncached input only, with cache reads
 * and cache writes reported beside it, which is exactly the harness's split; a
 * report that never reached both counts is omitted rather than half-filled.
 * @param counters - merged counters, when the stream reported any.
 * @returns token usage, or undefined when the stream reported none.
 */
function usageOf(counters: UsageCounters | undefined): TokenUsage | undefined {
  if (counters?.input === undefined || counters.output === undefined) return undefined
  const cacheRead = counters.cacheRead ?? 0
  const cacheWrite = counters.cacheWrite ?? 0
  return {
    inputTokens: counters.input,
    outputTokens: counters.output,
    totalTokens: counters.input + counters.output + cacheRead + cacheWrite,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}

/**
 * The harness finish reason for one provider stop reason.
 *
 * This protocol names more reasons than the harness has kinds, and a reason
 * this build does not know is still a finished turn: the calls it made decide
 * whether it stopped for them, which is what the harness routes on.
 * @param stopReason - provider reason the stream reported.
 * @param hasToolCalls - whether the response carried a tool call.
 * @returns the finish reason.
 */
function finishReasonOf(stopReason: string, hasToolCalls: boolean): FinishReason {
  if (stopReason === 'tool_use') return { kind: 'tool-calls' }
  if (stopReason === 'max_tokens') return { kind: 'max-tokens' }
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence' || stopReason === 'refusal' || stopReason === 'pause_turn') {
    return { kind: 'stop' }
  }
  return hasToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' }
}

/** The assembled block one closed stream block contributes. */
function blockOf(block: OpenBlock): ContentBlock {
  if (block.kind === 'tool_use') {
    return { type: 'tool-call', id: ToolCallId(block.id), name: block.name, arguments: block.arguments }
  }
  if (block.kind === 'text') return { type: 'text', text: block.text }
  // A redacted block carries its payload in the replay metadata, never in the
  // text: the model's own thinking is what the provider withheld.
  return { type: 'reasoning', text: block.kind === 'redacted_thinking' ? '' : block.text }
}

/**
 * Translate one Messages event stream into harness chunks.
 *
 * @param events - decoded JSON events in arrival order.
 * @param sawSentinel - reports whether the transport delivered an end-of-stream
 *   sentinel; a gateway may append one this protocol does not define, and the
 *   stream's own `message_stop` is the terminal event either way.
 * @returns the chunk stream, ending with exactly one terminal `finish`.
 * @throws LlmError when the stream carries an in-band provider error, when it
 *   was cut off, or when it ended without a stop reason.
 */
export async function* translateAnthropicStream(
  events: AsyncIterable<Record<string, unknown>>,
  sawSentinel: () => boolean,
): AsyncGenerator<StreamChunk> {
  const open = new Map<number, OpenBlock>()
  const replay: AnthropicReplayBlock[] = []
  let nextIndex = 0
  let stopReason: string | undefined
  let responseId: string | undefined
  let sawMessageStop = false
  let sawOutput = false
  let counters: UsageCounters | undefined

  for await (const event of events) {
    const type = event['type']
    if (type === 'error') throw classifyFailure(event, undefined)
    if (type === 'message_start') {
      const message = asRecord(event['message'])
      const id = message['id']
      if (typeof id === 'string' && id.length > 0) responseId = id
      const usage = message['usage']
      if (usage !== undefined) counters = mergeUsage(asRecord(usage), counters)
      continue
    }
    if (type === 'content_block_start') {
      const block = asRecord(event['content_block'])
      const kind = block['type']
      if (kind !== 'text' && kind !== 'thinking' && kind !== 'redacted_thinking' && kind !== 'tool_use') {
        // A block this build cannot carry — a server-side tool call, or a kind
        // added after it — is skipped whole rather than half-translated.
        continue
      }
      const id = typeof block['id'] === 'string' ? block['id'] : ''
      if (kind === 'tool_use' && id.length === 0) {
        // Without an id the call cannot be correlated with its result, which
        // is the one thing this protocol's pairing rules are made of.
        throw new LlmError('llm-service-lite: anthropic-messages stream opened a tool call without an id', 'MALFORMED_RESPONSE')
      }
      const opened: OpenBlock = {
        index: nextIndex,
        kind,
        text: '',
        arguments: '',
        id,
        name: typeof block['name'] === 'string' ? block['name'] : '',
        signature: '',
        data: typeof block['data'] === 'string' ? block['data'] : '',
      }
      nextIndex += 1
      open.set(blockIndexOf(event), opened)
      replay.push(
        kind === 'tool_use'
          ? { type: 'tool-call' }
          : kind === 'text' ? { type: 'text' } : { type: 'reasoning' },
      )
      yield {
        type: 'block-start',
        index: opened.index,
        blockType: kind === 'tool_use' ? 'tool-call' : kind === 'text' ? 'text' : 'reasoning',
      }
      if (kind !== 'tool_use') {
        if (kind === 'redacted_thinking') sawOutput = true
        continue
      }
      // The call is announced as soon as its identity is known; the arguments
      // follow as fragments, exactly as the harness correlates them.
      sawOutput = true
      yield {
        type: 'tool-call-delta',
        index: opened.index,
        id: ToolCallId(opened.id),
        name: opened.name,
        argumentsDelta: '',
      }
      continue
    }
    if (type === 'content_block_delta') {
      const opened = open.get(blockIndexOf(event))
      const delta = asRecord(event['delta'])
      const deltaType = delta['type']
      if (opened === undefined) continue
      if (deltaType === 'signature_delta') {
        if (typeof delta['signature'] === 'string') opened.signature += delta['signature']
        continue
      }
      if (opened.kind === 'text' && deltaType === 'text_delta' && typeof delta['text'] === 'string' && delta['text'].length > 0) {
        sawOutput = true
        opened.text += delta['text']
        yield { type: 'text-delta', index: opened.index, text: delta['text'] }
        continue
      }
      if (opened.kind === 'thinking' && deltaType === 'thinking_delta' && typeof delta['thinking'] === 'string' && delta['thinking'].length > 0) {
        sawOutput = true
        opened.text += delta['thinking']
        yield { type: 'reasoning-delta', index: opened.index, text: delta['thinking'] }
        continue
      }
      if (opened.kind === 'tool_use' && deltaType === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
        opened.arguments += delta['partial_json']
        yield { type: 'tool-call-delta', index: opened.index, id: ToolCallId(opened.id), argumentsDelta: delta['partial_json'] }
      }
      continue
    }
    if (type === 'content_block_stop') {
      const providerIndex = blockIndexOf(event)
      const opened = open.get(providerIndex)
      if (opened === undefined) continue
      open.delete(providerIndex)
      const entry = replay[opened.index]
      if (entry?.type === 'reasoning' && opened.kind === 'thinking' && opened.signature.length > 0) {
        entry.signature = opened.signature
      }
      if (entry?.type === 'reasoning' && opened.kind === 'redacted_thinking') entry.redacted = opened.data
      yield { type: 'block-end', index: opened.index, block: blockOf(opened) }
      continue
    }
    if (type === 'message_delta') {
      const reason = asRecord(event['delta'])['stop_reason']
      if (typeof reason === 'string' && reason.length > 0) stopReason = reason
      const usage = event['usage']
      if (usage !== undefined) counters = mergeUsage(asRecord(usage), counters)
      continue
    }
    if (type === 'message_stop') {
      sawMessageStop = true
      break
    }
  }

  // Blocks still open mean the connection ended inside a turn: the caller must
  // see a transport failure rather than a message that reads as complete.
  if (open.size > 0) {
    throw new LlmError('llm-service-lite: anthropic-messages stream ended inside a content block', 'TRANSPORT')
  }
  if (!sawMessageStop && !sawSentinel()) {
    throw new LlmError('llm-service-lite: anthropic-messages stream ended before a terminal event', 'TRANSPORT')
  }
  if (!sawOutput) throw new LlmError('llm-service-lite: anthropic-messages response carried no content', 'EMPTY_RESPONSE')
  // A turn the provider never gave a reason for is not a turn this adapter can
  // report as finished: the caller must see a transport failure instead of a
  // completion whose outcome nobody stated.
  if (stopReason === undefined) {
    throw new LlmError('llm-service-lite: anthropic-messages stream ended without a stop reason', 'TRANSPORT')
  }
  const finish = finishReasonOf(stopReason, replay.some(entry => entry.type === 'tool-call'))
  const usage = usageOf(counters)
  if (usage !== undefined) yield { type: 'usage', usage }
  const response: AnthropicReplayState['response'] = {
    kind: REPLAY_KIND,
    version: REPLAY_VERSION,
    stopReason,
    ...responseId === undefined ? {} : { responseId },
  }
  yield { type: 'finish', reason: finish, replayState: { response, blocks: replay } }
}
