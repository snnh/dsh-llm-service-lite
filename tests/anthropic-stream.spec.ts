import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { translateAnthropicStream } from '../src/anthropic-stream.ts'

/** Collect one translation of the given provider events. */
const translate = async (
  events: Array<Record<string, unknown>>,
  sawSentinel = false,
): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = []
  for await (const chunk of translateAnthropicStream((async function* generate() {
    yield* events
  })(), () => sawSentinel)) {
    chunks.push(chunk)
  }
  return chunks
}

/** The failure one translation reports. */
const failure = async (events: Array<Record<string, unknown>>, sawSentinel = false): Promise<LlmError> => {
  try {
    await translate(events, sawSentinel)
  } catch (error) {
    if (error instanceof LlmError) return error
    throw error
  }
  throw new Error('the translation did not fail')
}

/** The opening event every stream starts with. */
const messageStart = (usage: Record<string, unknown> = { input_tokens: 7, output_tokens: 1 }): Record<string, unknown> => ({
  type: 'message_start',
  message: { id: 'msg_1', role: 'assistant', usage },
})

/** The event that carries the stop reason and the final token counts. */
const messageDelta = (stopReason: string | null, usage?: Record<string, unknown>): Record<string, unknown> => ({
  type: 'message_delta',
  delta: { stop_reason: stopReason },
  ...usage === undefined ? {} : { usage },
})

/** One complete text turn. */
const textTurn = (value = 'hello'): Array<Record<string, unknown>> => [
  messageStart(),
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } },
  { type: 'content_block_stop', index: 0 },
  messageDelta('end_turn', { output_tokens: 3 }),
  { type: 'message_stop' },
]

describe('anthropic-messages stream translation', async () => {
  it('reconstructs one text block and its accounting', async () => {
    expect(await translate(textTurn())).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      {
        type: 'usage',
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: {
          response: { kind: 'llm-service-lite-anthropic', version: 1, stopReason: 'end_turn', responseId: 'msg_1' },
          blocks: [{ type: 'text' }],
        },
      },
    ])
  })

  it('carries cache accounting beside the uncached input count', async () => {
    const events = [
      messageStart({ input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 9 }),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      messageDelta('end_turn', { output_tokens: 2 }),
      { type: 'message_stop' },
    ]
    expect(await translate(events)).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 46, cacheReadTokens: 30, cacheWriteTokens: 9 },
    })
  })

  it('reports no usage when the stream never counted both halves', async () => {
    const partial = [
      messageStart({ input_tokens: 7 }),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      messageDelta('end_turn'),
      { type: 'message_stop' },
    ]
    expect((await translate(partial)).some(chunk => chunk.type === 'usage')).toBe(false)
    const uncounted = textTurn().filter(event => event['type'] !== 'message_start')
    expect((await translate(uncounted)).some(chunk => chunk.type === 'usage')).toBe(false)
  })

  it('refuses a usage report that is not a count', async () => {
    const events = [messageStart({ input_tokens: -1, output_tokens: 1, cache_read_input_tokens: 'many' })]
    expect((await failure(events)).code).toBe('MALFORMED_RESPONSE')
    expect((await failure([messageStart({ output_tokens: 1.5 })])).code).toBe('MALFORMED_RESPONSE')
  })

  it('replays a signed thinking block and a redacted one', async () => {
    const events = [
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque' } },
      { type: 'content_block_stop', index: 1 },
      messageDelta('end_turn', { output_tokens: 4 }),
      { type: 'message_stop' },
    ]
    const chunks = await translate(events)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'weighing' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'weighing' } },
      { type: 'block-start', index: 1, blockType: 'reasoning' },
      { type: 'block-end', index: 1, block: { type: 'reasoning', text: '' } },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: {
          response: { kind: 'llm-service-lite-anthropic', version: 1, stopReason: 'end_turn', responseId: 'msg_1' },
          blocks: [{ type: 'reasoning', signature: 'sig-1' }, { type: 'reasoning', redacted: 'opaque' }],
        },
      },
    ])
  })

  it('assembles a tool call from its fragments and stops for it', async () => {
    const events = [
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'looking' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_a', name: 'shell', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd"' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"ls"}' } },
      { type: 'content_block_stop', index: 1 },
      messageDelta('tool_use', { output_tokens: 9 }),
      { type: 'message_stop' },
    ]
    const chunks = await translate(events)
    expect(chunks).toContainEqual({ type: 'tool-call-delta', index: 1, id: 'toolu_a', name: 'shell', argumentsDelta: '' })
    expect(chunks).toContainEqual({ type: 'tool-call-delta', index: 1, id: 'toolu_a', argumentsDelta: '{"cmd"' })
    expect(chunks).toContainEqual({
      type: 'block-end', index: 1, block: { type: 'tool-call', id: 'toolu_a', name: 'shell', arguments: '{"cmd":"ls"}' },
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('skips a block this build cannot carry, keeping the indexes it does carry', async () => {
    const events = [
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'after' } },
      { type: 'content_block_stop', index: 1 },
      messageDelta('end_turn', { output_tokens: 2 }),
      { type: 'message_stop' },
    ]
    const chunks = await translate(events)
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'after' })
    expect(chunks.at(-1)).toMatchObject({ replayState: { blocks: [{ type: 'text' }] } })
  })

  it('ignores deltas no open block can receive', async () => {
    const events = [
      messageStart(),
      { type: 'content_block_delta', index: 9, delta: { type: 'text_delta', text: 'lost' } },
      { type: 'content_block_stop', index: 9 },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'kept' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'wrong block' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'ignored' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'unknown_delta', text: 'ignored' } },
      { type: 'content_block_stop', index: 0 },
      messageDelta('end_turn', { output_tokens: 2 }),
      { type: 'message_stop' },
    ]
    expect(await translate(events)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'kept' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'kept' } },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      expect.objectContaining({ type: 'finish' }),
    ])
  })

  it('fails an event that carries no block index', async () => {
    const events = [messageStart(), { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }]
    expect((await failure(events)).code).toBe('MALFORMED_RESPONSE')
  })

  it('fails a tool call opened without an id', async () => {
    const events = [
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'shell' } },
    ]
    expect((await failure(events)).code).toBe('MALFORMED_RESPONSE')
  })

  it('classifies an in-band provider error', async () => {
    const rateLimited = await failure([{ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }])
    expect(rateLimited.code).toBe('RATE_LIMIT')
    expect(rateLimited.message).toBe('slow down')
  })

  it('maps every stop reason this build knows', async () => {
    const reasonOf = async (stopReason: string, withCall = false): Promise<StreamChunk | undefined> => {
      const events = [
        messageStart(),
        ...withCall
          ? [
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'shell' } },
            { type: 'content_block_stop', index: 0 },
          ]
          : [
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
            { type: 'content_block_stop', index: 0 },
          ],
        messageDelta(stopReason, { output_tokens: 1 }),
        { type: 'message_stop' },
      ]
      return (await translate(events)).at(-1)
    }
    expect(await reasonOf('end_turn')).toMatchObject({ reason: { kind: 'stop' } })
    expect(await reasonOf('stop_sequence')).toMatchObject({ reason: { kind: 'stop' } })
    expect(await reasonOf('refusal')).toMatchObject({ reason: { kind: 'stop' } })
    expect(await reasonOf('pause_turn')).toMatchObject({ reason: { kind: 'stop' } })
    expect(await reasonOf('max_tokens')).toMatchObject({ reason: { kind: 'max-tokens' } })
    expect(await reasonOf('tool_use', true)).toMatchObject({ reason: { kind: 'tool-calls' } })
    // A reason this build does not know is still a finished turn.
    expect(await reasonOf('model_context_window_exceeded')).toMatchObject({ reason: { kind: 'stop' } })
    expect(await reasonOf('something_new', true)).toMatchObject({ reason: { kind: 'tool-calls' } })
  })

  it('refuses a stream that ended without a stop reason', async () => {
    const events = [
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ]
    expect((await failure(events)).code).toBe('TRANSPORT')
  })

  it('refuses a stream cut off inside a content block', async () => {
    const events = [
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } },
    ]
    const error = await failure(events)
    expect(error.code).toBe('TRANSPORT')
    expect(error.message).toMatch(/inside a content block/u)
  })

  it('refuses a stream cut off between blocks, and accepts a sentinel instead', async () => {
    const events = [
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      messageDelta('end_turn', { output_tokens: 1 }),
    ]
    expect((await failure(events)).message).toMatch(/before a terminal event/u)
    expect((await translate(events, true)).at(-1)).toMatchObject({ type: 'finish' })
  })

  it('refuses a response that carried no content', async () => {
    const events = [messageStart(), messageDelta('end_turn', { output_tokens: 0 }), { type: 'message_stop' }]
    expect((await failure(events)).code).toBe('EMPTY_RESPONSE')
  })

  it('accepts an event the protocol does not define', async () => {
    const events = [
      { type: 'ping' },
      ...textTurn(),
      { type: 'future_event', payload: 1 },
    ]
    expect((await translate(events)).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('tolerates fields the provider spelled as something other than an object', async () => {
    const events = [
      { type: 'message_start', message: 'not a message' },
      { type: 'content_block_start', index: 0, content_block: ['not', 'a', 'block'] },
      { type: 'content_block_delta', index: 0, delta: 'not a delta' },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: [] },
      { type: 'message_stop' },
    ]
    // Nothing this stream carried was a block or a count, so it is both empty
    // and without a reason — and an empty response reports that first.
    expect((await failure(events)).code).toBe('EMPTY_RESPONSE')
  })

  it('keeps an envelope without the response id this stream never gave', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      messageDelta('end_turn', { output_tokens: 1 }),
      { type: 'message_stop' },
    ]
    // The turn opened without a response id, so its envelope carries none.
    expect(await translate(events)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      expect.objectContaining({
        type: 'finish',
        replayState: { response: { kind: 'llm-service-lite-anthropic', version: 1, stopReason: 'end_turn' }, blocks: [{ type: 'text' }] },
      }),
    ])
  })

  it('keeps a thinking block whose signature never arrived', async () => {
    const events = [
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plain' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta' } },
      { type: 'content_block_stop', index: 0 },
      messageDelta('end_turn', { output_tokens: 1 }),
      { type: 'message_stop' },
    ]
    const finish = (await translate(events)).at(-1)
    if (finish?.type !== 'finish') throw new Error('the stream did not finish')
    expect(finish.replayState?.blocks).toEqual([{ type: 'reasoning' }])
  })

  it('refuses a turn whose stop reason never came', async () => {
    const events = [
      messageStart(),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    const error = await failure(events)
    expect(error.code).toBe('TRANSPORT')
    expect(error.message).toMatch(/without a stop reason/u)
  })
})
