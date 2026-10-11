/**
 * Translation of one Responses event stream into the harness's chunk
 * vocabulary.
 *
 * This protocol streams the *items* it is building rather than a sequence of
 * deltas: `response.output_item.added` names an item, `done` closes it with the
 * authoritative copy, and the deltas in between are fragments of it. The
 * translator therefore owns block identity and ordering, tool-call assembly
 * across argument fragments, and the difference between a stream that ended and
 * one that was cut off, exactly as this adapter's other transports do — with
 * one addition this protocol needs: the item that closes a block also carries
 * the identity a later request must hand back (`msg_`/`rs_`/`fc_` id, and the
 * encrypted reasoning payload), so it is written into the adapter-private
 * replay metadata as the block closes.
 *
 * A provider that streams nothing but its terminal event is still served: the
 * authoritative output it carries is written as a block of its own, so a
 * non-streaming endpoint produces the same message as a streaming one.
 *
 * @module dsh-llm-service-lite/responses-stream
 */

import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { classifyFailure } from './errors.ts'
import { encodedImage, type AdapterChunk } from './image-output.ts'
import { RESPONSES_REPLAY_KIND, RESPONSES_REPLAY_VERSION } from './openai-responses.ts'
import type { ResponsesReplayBlock, ResponsesReplayState } from './openai-responses.ts'

/** A JSON object field, or an empty one when the provider sent something else. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** A JSON array field, or an empty one when the provider sent something else. */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** A text field, or nothing when the provider sent something else. */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** One block this stream is building, with the block index it owns. */
interface Slot {
  /** Block index in this adapter's own numbering. */
  readonly index: number
  readonly kind: 'text' | 'reasoning' | 'tool-call'
  /** Replay entry this block owns, index-aligned with the emitted blocks. */
  readonly entry: ResponsesReplayBlock
  text: string
  arguments: string
  id: string
  name: string
  closed: boolean
}

/** The authoritative text of one assistant message item: `output_text` parts plus a refusal. */
function messageItemText(item: Record<string, unknown>): string {
  return asArray(item['content']).flatMap((part) => {
    const record = asRecord(part)
    const type = record['type']
    if (type === 'output_text') return [asText(record['text']) ?? '']
    if (type === 'refusal') return [asText(record['refusal']) ?? '']
    return []
  }).join('')
}

/** The authoritative text of one reasoning item: its summary, else its plain-text reasoning. */
function reasoningItemText(item: Record<string, unknown>): string {
  const summary = asArray(item['summary']).flatMap(part => [asText(asRecord(part)['text']) ?? ''])
  if (summary.length > 0) return summary.join('\n\n')
  return asArray(item['content']).flatMap((part) => {
    const record = asRecord(part)
    return record['type'] === 'reasoning_text' ? [asText(record['text']) ?? ''] : []
  }).join('\n\n')
}

/** One counter of a usage report; a present but unusable value is a malformed response, not a zero. */
function countOf(usage: Record<string, unknown>, field: string): number | undefined {
  const value = usage[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LlmError(`llm-service-lite: openai-responses stream reported an invalid ${field}`, 'MALFORMED_RESPONSE')
  }
  return value
}

/**
 * The harness's disjoint token accounting for one terminal event.
 *
 * This API reports a prompt total with the cached and cache-written parts
 * inside it, so those are subtracted out to reach the uncached input count the
 * harness contracts for; the total stays the provider's own arithmetic.
 * @param usage - the terminal event's usage object, when it carried one.
 * @returns token usage, or undefined when the stream reported none.
 */
function usageOf(usage: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined
  const input = countOf(usage, 'input_tokens')
  const output = countOf(usage, 'output_tokens')
  if (input === undefined || output === undefined) return undefined
  const details = asRecord(usage['input_tokens_details'])
  const cacheRead = countOf(details, 'cached_tokens') ?? 0
  const cacheWrite = countOf(details, 'cache_write_tokens') ?? 0
  return {
    inputTokens: Math.max(0, input - cacheRead - cacheWrite),
    outputTokens: output,
    totalTokens: input + output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}

/**
 * The harness finish reason for one terminal event.
 *
 * This protocol reports a status rather than a reason, and a stream that ended
 * on an explicit end-of-stream sentinel without one is still finished: the
 * content decides whether it stopped for a call, which is what the harness
 * routes on.
 * @param status - provider status of the terminal event, when one arrived.
 * @param incompleteReason - why an incomplete response stopped, when stated.
 * @param sawRefusal - whether the response refused the request.
 * @param hasToolCalls - whether the response carried a tool call.
 * @param sawEnd - whether an end-of-stream sentinel stood in for the status.
 * @returns the finish reason, or undefined when the stream never terminated.
 */
function finishReasonOf(
  status: string | undefined,
  incompleteReason: string | undefined,
  sawRefusal: boolean,
  hasToolCalls: boolean,
  sawEnd: boolean,
): FinishReason | undefined {
  if (status === 'incomplete' && incompleteReason === 'max_output_tokens') return { kind: 'max-tokens' }
  if (sawRefusal) return { kind: 'stop' }
  if (hasToolCalls) return { kind: 'tool-calls' }
  if (status === 'completed' || status === 'incomplete') return { kind: 'stop' }
  if (sawEnd) return { kind: 'stop' }
  return undefined
}

/**
 * Translate one Responses event stream into harness chunks.
 *
 * @param events - decoded JSON events in arrival order.
 * @param sawSentinel - reports whether the transport delivered an end-of-stream
 *   sentinel; a gateway may end the turn with one instead of a terminal event.
 * @returns the chunk stream, ending with exactly one terminal `finish`.
 * @throws LlmError when the stream carries an in-band failure, when it was cut
 *   off, or when it ended without stating an outcome.
 */
export async function* translateResponsesStream(
  events: AsyncIterable<Record<string, unknown>>,
  sawSentinel: () => boolean,
): AsyncGenerator<AdapterChunk> {
  /** Blocks by the provider identity they were opened under. */
  const slots = new Map<string, Slot>()
  /** Blocks by the provider's item id, which `output_item.done` may arrive without an index for. */
  const byItemId = new Map<string, Slot>()
  /** The item id one output index belongs to, announced before its deltas arrive. */
  const itemIdByIndex = new Map<number, string>()
  const replay: ResponsesReplayBlock[] = []
  let nextIndex = 0
  let responseId: string | undefined
  let status: string | undefined
  let incompleteReason: string | undefined
  let usage: Record<string, unknown> | undefined
  let sawRefusal = false
  let sawOutput = false
  let terminal = false

  /** Open the block for one provider identity, reporting whether it is new. */
  const ensure = (key: string, kind: Slot['kind']): { slot: Slot; started: boolean } => {
    const existing = slots.get(key)
    if (existing !== undefined) return { slot: existing, started: false }
    const entry: ResponsesReplayBlock = kind === 'tool-call'
      ? { type: 'tool-call' }
      : kind === 'text' ? { type: 'text' } : { type: 'reasoning' }
    const slot: Slot = { index: nextIndex, kind, entry, text: '', arguments: '', id: '', name: '', closed: false }
    nextIndex += 1
    slots.set(key, slot)
    replay.push(entry)
    return { slot, started: true }
  }
  /** Image items already written, so a terminal event does not repeat one. */
  const writtenImages = new Set<string>()
  /**
   * Chunks one image-generation item contributes: this protocol returns the
   * finished picture inside the item, so the image is one whole block rather
   * than a stream of fragments.
   */
  const writeImage = (item: Record<string, unknown>): AdapterChunk[] => {
    const result = asText(item['result'])
    if (result === undefined || result.length === 0) return []
    const index = nextIndex
    nextIndex += 1
    sawOutput = true
    return [
      { type: 'block-start', index, blockType: 'image' },
      { type: 'generated-image', index, ...encodedImage(result, 'the Responses endpoint') },
    ]
  }
  const announce = (slot: Slot): StreamChunk => ({
    type: 'block-start',
    index: slot.index,
    blockType: slot.kind,
  })
  const close = (slot: Slot): StreamChunk => {
    slot.closed = true
    return slot.kind === 'tool-call'
      ? { type: 'block-end', index: slot.index, block: { type: 'tool-call', id: ToolCallId(slot.id), name: slot.name, arguments: slot.arguments } }
      : { type: 'block-end', index: slot.index, block: { type: slot.kind, text: slot.text } }
  }
  /** Remember which item a block came from, so the terminal event can address it. */
  const identify = (slot: Slot, itemId: string | undefined): void => {
    if (itemId === undefined || itemId.length === 0) return
    byItemId.set(itemId, slot)
    slot.entry.itemId = itemId
  }
  /**
   * Keep the provider's own reasoning item with its block, which is what a
   * model declaring encrypted replay hands back verbatim on the next request.
   */
  const keepItem = (slot: Slot, item: Record<string, unknown>): void => {
    const id = asText(item['id'])
    if (slot.entry.type !== 'reasoning' || item['type'] !== 'reasoning') return
    if (id === undefined || id.length === 0) return
    slot.entry.item = JSON.stringify(item)
  }

  /**
   * Write the block one authoritative call item stands for: a call whose
   * fragments already streamed is completed, and one that never announced
   * itself — an endpoint that only reports it at the end — is written whole.
   * @param item - the authoritative call item.
   * @param itemId - the provider's id for the item.
   * @returns chunks that open and close the block.
   */
  function* writeCall(item: Record<string, unknown>, itemId: string): Generator<StreamChunk> {
    const existing = slots.get(`call:${itemId}`)
    if (existing?.closed === true) return
    const { slot, started } = ensure(`call:${itemId}`, 'tool-call')
    if (slot.id.length === 0) slot.id = asText(item['call_id']) ?? itemId
    slot.name = asText(item['name']) ?? slot.name
    slot.arguments = asText(item['arguments']) ?? slot.arguments
    identify(slot, itemId)
    sawOutput = true
    if (started) yield { type: 'block-start', index: slot.index, blockType: 'tool-call' }
    yield close(slot)
  }

  /**
   * Write the block one authoritative text or reasoning item stands for.
   *
   * A block the deltas already carried is closed with the longer of the two —
   * an endpoint that sends the rest of its text only in the closing item would
   * otherwise lose it — while a block that never opened is written here in
   * full, so a provider that does not stream still produces its message.
   * @param item - the authoritative item.
   * @param kind - which block the item stands for.
   * @param key - the provider identity its deltas used, when there was one.
   * @param itemId - the provider's id for the item, when it named one.
   * @returns chunks that open and close the block.
   */
  function* writeItem(
    item: Record<string, unknown>,
    kind: 'text' | 'reasoning',
    key: string | undefined,
    itemId: string | undefined,
  ): Generator<StreamChunk> {
    const authoritative = kind === 'text' ? messageItemText(item) : reasoningItemText(item)
    const existing = (key === undefined ? undefined : slots.get(key))
      ?? (itemId === undefined ? undefined : byItemId.get(itemId))
    if (existing === undefined) {
      if (authoritative.length === 0) return
      const { slot } = ensure(key ?? `item:${kind}:${String(nextIndex)}`, kind)
      sawOutput = true
      slot.text = authoritative
      identify(slot, itemId)
      keepItem(slot, item)
      yield announce(slot)
      yield kind === 'text'
        ? { type: 'text-delta', index: slot.index, text: authoritative }
        : { type: 'reasoning-delta', index: slot.index, text: authoritative }
      yield close(slot)
      return
    }
    if (existing.closed) return
    identify(existing, itemId)
    keepItem(existing, item)
    if (authoritative.startsWith(existing.text) && authoritative.length > existing.text.length) {
      // The closing item carries the rest of the block: the missing suffix is
      // streamed as the delta the provider owed, so the assembled block matches.
      const suffix = authoritative.slice(existing.text.length)
      existing.text = authoritative
      yield kind === 'text'
        ? { type: 'text-delta', index: existing.index, text: suffix }
        : { type: 'reasoning-delta', index: existing.index, text: suffix }
    }
    yield close(existing)
  }

  for await (const event of events) {
    const type = event['type']
    if (type === 'error') throw classifyFailure(event, undefined)
    if (type === 'response.failed') throw classifyFailure(asRecord(event['response'])['error'] ?? event, undefined)
    if (type === 'response.created') {
      const id = asText(asRecord(event['response'])['id'])
      if (id !== undefined && id.length > 0) responseId = id
      continue
    }
    if (type === 'response.output_item.added') {
      const item = asRecord(event['item'])
      const itemId = asText(item['id'])
      const outputIndex = event['output_index']
      if (item['type'] === 'function_call' && itemId !== undefined && itemId.length > 0) {
        // A call is announced as soon as its identity is known; its arguments
        // follow as fragments, exactly as the harness correlates them.
        const { slot, started } = ensure(`call:${itemId}`, 'tool-call')
        slot.id = asText(item['call_id']) ?? itemId
        slot.name = asText(item['name']) ?? ''
        slot.arguments = asText(item['arguments']) ?? ''
        identify(slot, itemId)
        sawOutput = true
        if (started) yield announce(slot)
        yield { type: 'tool-call-delta', index: slot.index, id: ToolCallId(slot.id), name: slot.name, argumentsDelta: '' }
        continue
      }
      if ((item['type'] === 'message' || item['type'] === 'reasoning') && typeof outputIndex === 'number') {
        if (itemId !== undefined && itemId.length > 0) itemIdByIndex.set(outputIndex, itemId)
        const key = `${item['type'] === 'message' ? 'text' : 'reasoning'}:${String(outputIndex)}`
        const slot = slots.get(key)
        if (slot !== undefined) identify(slot, itemId)
      }
      continue
    }
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      const delta = asText(event['delta'])
      if (delta === undefined || delta.length === 0) continue
      if (type === 'response.refusal.delta') sawRefusal = true
      const outputIndex = event['output_index']
      const { slot, started } = ensure(`text:${String(outputIndex)}`, 'text')
      if (typeof outputIndex === 'number') identify(slot, itemIdByIndex.get(outputIndex))
      sawOutput = true
      if (started) yield announce(slot)
      slot.text += delta
      yield { type: 'text-delta', index: slot.index, text: delta }
      continue
    }
    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      const delta = asText(event['delta'])
      if (delta === undefined || delta.length === 0) continue
      const outputIndex = event['output_index']
      const { slot, started } = ensure(`reasoning:${String(outputIndex)}`, 'reasoning')
      if (typeof outputIndex === 'number') identify(slot, itemIdByIndex.get(outputIndex))
      sawOutput = true
      if (started) yield announce(slot)
      slot.text += delta
      yield { type: 'reasoning-delta', index: slot.index, text: delta }
      continue
    }
    if (type === 'response.reasoning_summary_part.done') {
      // The provider separates summary parts; a blank line is what keeps two
      // paragraphs from reading as one sentence.
      const slot = slots.get(`reasoning:${String(event['output_index'])}`)
      if (slot === undefined) continue
      slot.text += '\n\n'
      yield { type: 'reasoning-delta', index: slot.index, text: '\n\n' }
      continue
    }
    if (type === 'response.function_call_arguments.delta') {
      const itemId = asText(event['item_id'])
      if (itemId === undefined || itemId.length === 0) continue
      const delta = asText(event['delta']) ?? ''
      const { slot, started } = ensure(`call:${itemId}`, 'tool-call')
      if (slot.id.length === 0) slot.id = itemId
      identify(slot, itemId)
      sawOutput = true
      if (started) yield announce(slot)
      slot.arguments += delta
      yield { type: 'tool-call-delta', index: slot.index, id: ToolCallId(slot.id), argumentsDelta: delta }
      continue
    }
    if (type === 'response.function_call_arguments.done') {
      const itemId = asText(event['item_id'])
      const slot = itemId === undefined ? undefined : slots.get(`call:${itemId}`)
      const arguments_ = asText(event['arguments'])
      if (slot !== undefined && arguments_ !== undefined) slot.arguments = arguments_
      continue
    }
    if (type === 'response.output_item.done' || type === 'response.completed' || type === 'response.incomplete') {
      const response = asRecord(event['response'])
      if (type === 'response.output_item.done') {
        const item = asRecord(event['item'])
        const itemId = asText(item['id'])
        const outputIndex = event['output_index']
        if (item['type'] === 'function_call') {
          if (itemId === undefined) continue
          for (const chunk of writeCall(item, itemId)) yield chunk
          continue
        }
        if (item['type'] === 'image_generation_call') {
          if (itemId !== undefined) writtenImages.add(itemId)
          for (const chunk of writeImage(item)) yield chunk
          continue
        }
        if (item['type'] === 'message' || item['type'] === 'reasoning') {
          const kind = item['type'] === 'message' ? 'text' : 'reasoning'
          const key = typeof outputIndex === 'number' ? `${kind}:${String(outputIndex)}` : undefined
          for (const chunk of writeItem(item, kind, key, itemId)) yield chunk
        }
        continue
      }
      const id = asText(response['id'])
      if (id !== undefined && id.length > 0) responseId = id
      const responseStatus = asText(response['status'])
      if (responseStatus !== undefined) status = responseStatus
      const reason = asText(asRecord(response['incomplete_details'])['reason'])
      if (reason !== undefined) incompleteReason = reason
      usage = asRecord(response['usage'])
      terminal = true
      // The terminal event carries the authoritative output: a block an
      // endpoint closed only here, or never opened, is written from it.
      for (const item of asArray(response['output'])) {
        const record = asRecord(item)
        const itemId = asText(record['id'])
        const outputIndex = record['output_index']
        if (record['type'] === 'function_call') {
          if (itemId === undefined) continue
          for (const chunk of writeCall(record, itemId)) yield chunk
          continue
        }
        if (record['type'] === 'image_generation_call') {
          // An image the stream already carried is skipped for the same reason.
          if (itemId !== undefined && writtenImages.has(itemId)) continue
          for (const chunk of writeImage(record)) yield chunk
          continue
        }
        if (record['type'] === 'message' || record['type'] === 'reasoning') {
          // An item the stream already carried is skipped: its block exists.
          if (itemId !== undefined && byItemId.has(itemId)) continue
          const kind = record['type'] === 'message' ? 'text' : 'reasoning'
          const key = typeof outputIndex === 'number' ? `${kind}:${String(outputIndex)}` : undefined
          for (const chunk of writeItem(record, kind, key, itemId)) yield chunk
        }
      }
      continue
    }
  }

  // A stream that never said it finished is a cut connection unless the
  // transport saw the sentinel an endpoint appends instead of a terminal event.
  if (!terminal && !sawSentinel()) {
    throw new LlmError('llm-service-lite: openai-responses stream ended before a terminal event', 'TRANSPORT')
  }
  // Whatever the terminal event left open is finished here: a block that
  // streamed content and never met its `done` is still that content.
  for (const slot of slots.values()) {
    if (!slot.closed) yield close(slot)
  }
  if (!sawOutput) throw new LlmError('llm-service-lite: openai-responses response carried no content', 'EMPTY_RESPONSE')
  const hasToolCalls = [...slots.values()].some(slot => slot.kind === 'tool-call')
  const finish = finishReasonOf(status, incompleteReason, sawRefusal, hasToolCalls, sawSentinel())
  if (finish === undefined) {
    throw new LlmError('llm-service-lite: openai-responses stream ended without an outcome', 'TRANSPORT')
  }
  const tokens = usageOf(usage)
  if (tokens !== undefined) yield { type: 'usage', usage: tokens }
  const response: ResponsesReplayState['response'] = {
    kind: RESPONSES_REPLAY_KIND,
    version: RESPONSES_REPLAY_VERSION,
    ...status === undefined ? {} : { stopReason: status },
    ...responseId === undefined ? {} : { responseId },
  }
  yield { type: 'finish', reason: finish, replayState: { response, blocks: replay } }
}
