import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SseReader } from '../src/sse.ts'
import { translateChatStream } from '../src/chat-completions.ts'
import { translateAnthropicStream } from '../src/anthropic-stream.ts'
import { translateResponsesStream } from '../src/responses-stream.ts'
import type { AdapterChunk } from '../src/image-output.ts'

/** Build a byte stream that emits the given string chunks in order. */
function byteStream(chunks: string[]): ReadableStream<BufferSource> {
  const encoder = new TextEncoder()
  return new ReadableStream<BufferSource>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** Collect one reader's events, or the failure it threw. */
async function readAll(reader: SseReader): Promise<{ events: Record<string, unknown>[]; error: unknown }> {
  const events: Record<string, unknown>[] = []
  try {
    for await (const event of reader.events()) events.push(event)
    return { events, error: undefined }
  } catch (error) {
    return { events, error }
  }
}

/** Collect one translator's chunks, or the failure it threw. */
async function collect<T>(chunks: AsyncIterable<T>): Promise<{ chunks: T[]; error: unknown }> {
  const collected: T[] = []
  try {
    for await (const chunk of chunks) collected.push(chunk)
    return { chunks: collected, error: undefined }
  } catch (error) {
    return { chunks: collected, error }
  }
}

describe('SSE framing', () => {
  it('delivers a final frame the connection closed without a trailing blank line', async () => {
    // `data: …\n` (one newline) then EOF: the parser dispatches an event only
    // on a blank line, so the reader appends the missing terminator instead of
    // silently dropping the frame.
    const reader = new SseReader(byteStream(['data: {"choices":[{"finish_reason":"stop","delta":{"content":"hi"}}]}\n\n', 'data: [DONE]']), () => {})
    const { events, error } = await readAll(reader)
    expect(error).toBeUndefined()
    expect(events).toHaveLength(1)
    expect(reader.sawDone).toBe(true)
  })

  it('pulses the watchdog for data frames and empty keepalives, never for comments', async () => {
    let pulses = 0
    const reader = new SseReader(byteStream([
      ': ping\n\n',
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data:\n\n',
      'data: [DONE]\n\n',
    ]), () => { pulses += 1 })
    const { events, error } = await readAll(reader)
    expect(error).toBeUndefined()
    expect(events).toHaveLength(1)
    expect(pulses).toBe(2)
  })

  it('refuses an event that never reaches a boundary within the buffer ceiling', async () => {
    const oversized = `data: ${'a'.repeat(8 * 1024 * 1024 + 16)}`
    const reader = new SseReader(byteStream([oversized]), () => {})
    const { error } = await readAll(reader)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('MALFORMED_RESPONSE')
    expect((error as LlmError).message).toMatch(/buffered characters/u)
  })

  it('reports a connection that ended inside a frame as a retryable transport failure', async () => {
    const reader = new SseReader(byteStream([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"delta":',
    ]), () => {})
    const { error } = await readAll(reader)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('TRANSPORT')
    expect((error as LlmError).message).toMatch(/incomplete frame/u)
  })

  it('keeps an invalid terminated frame a malformed response', async () => {
    const reader = new SseReader(byteStream(['data: not json\n\n']), () => {})
    const { error } = await readAll(reader)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('MALFORMED_RESPONSE')
  })
})

describe('a complete turn whose terminal frame lacks the final blank line', () => {
  it('finishes chat-completions on an unterminated [DONE]', async () => {
    const reader = new SseReader(byteStream([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: [DONE]',
    ]), () => {})
    const { chunks, error } = await collect(translateChatStream(reader.events(), () => reader.sawDone))
    expect(error).toBeUndefined()
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('finishes anthropic-messages on an unterminated message_stop', async () => {
    const reader = new SseReader(byteStream([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]), () => {})
    const { chunks, error } = await collect(translateAnthropicStream(reader.events(), () => reader.sawDone))
    expect(error).toBeUndefined()
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } })
    expect((chunks as StreamChunk[]).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('finishes openai-responses on an unterminated response.completed', async () => {
    const reader = new SseReader(byteStream([
      'data: {"type":"response.output_text.delta","delta":"hi","output_index":0}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}',
    ]), () => {})
    const { chunks, error } = await collect<AdapterChunk>(translateResponsesStream(reader.events(), () => reader.sawDone))
    expect(error).toBeUndefined()
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })
})
