import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { translateResponsesStream } from '../src/responses-stream.ts'
import type { AdapterChunk } from '../src/image-output.ts'

/** Collect one translation of the given provider events. */
const translate = async (
  events: Array<Record<string, unknown>>,
  sawSentinel = false,
): Promise<AdapterChunk[]> => {
  const chunks: AdapterChunk[] = []
  for await (const chunk of translateResponsesStream((async function* generate() {
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

/** The terminal event of a turn. */
const completed = (
  output: Array<Record<string, unknown>> = [],
  usage?: Record<string, unknown>,
  status = 'completed',
): Record<string, unknown> => ({
  type: status === 'completed' ? 'response.completed' : 'response.incomplete',
  response: { id: 'resp_1', status, output, ...usage === undefined ? {} : { usage } },
})

/** One assistant message item. */
const messageItem = (id = 'msg_1'): Record<string, unknown> => ({ type: 'message', id, role: 'assistant', content: [] })

/** One function-call item. */
const callItem = (id = 'fc_1', callId = 'call_a'): Record<string, unknown> => (
  { type: 'function_call', id, call_id: callId, name: 'shell', arguments: '' }
)

/** One reasoning item. */
const reasoningItem = (id = 'rs_1'): Record<string, unknown> => ({ type: 'reasoning', id, summary: [] })

/** One PNG payload, and the image item this protocol returns it in. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const imageItem = (id = 'ig_1'): Record<string, unknown> => ({
  type: 'image_generation_call',
  id,
  result: Buffer.from(PNG_BYTES).toString('base64'),
})

describe('openai-responses stream translation', () => {
  it('reconstructs a streamed text turn and its accounting', async () => {
    const events = [
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_item.added', item: messageItem(), output_index: 0 },
      { type: 'response.output_text.delta', delta: 'hel', output_index: 0 },
      { type: 'response.output_text.delta', delta: 'lo', output_index: 0 },
      { type: 'response.output_item.done', item: { ...messageItem(), content: [{ type: 'output_text', text: 'hello' }] }, output_index: 0 },
      completed([], { input_tokens: 9, output_tokens: 3, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } }),
    ]
    expect(await translate(events)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 4, outputTokens: 3, totalTokens: 12, cacheReadTokens: 4, cacheWriteTokens: 1 } },
      {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: {
          response: { kind: 'llm-service-lite-responses', version: 1, stopReason: 'completed', responseId: 'resp_1' },
          blocks: [{ type: 'text', itemId: 'msg_1' }],
        },
      },
    ])
  })

  it('carries an image the endpoint generated as a block of its own', async () => {
    const chunks = await translate([
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_item.added', item: { type: 'image_generation_call', id: 'ig_1' }, output_index: 0 },
      { type: 'response.output_item.done', item: imageItem(), output_index: 0 },
      completed([imageItem()]),
    ])
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'image' })
    expect(chunks).toContainEqual({ type: 'generated-image', index: 0, mediaType: 'image/png', data: PNG_BYTES })
    // The terminal event restates the item it already closed: the image is not
    // carried twice.
    expect(chunks.filter(chunk => chunk.type === 'generated-image')).toHaveLength(1)
  })

  it('carries an image the terminal event alone reports, and refuses one it cannot read', async () => {
    const late = await translate([completed([imageItem('ig_2')])])
    expect(late.filter(chunk => chunk.type === 'generated-image')).toHaveLength(1)
    const broken = await failure([completed([{ type: 'image_generation_call', id: 'ig_3', result: '' }])])
    expect(broken.code).toBe('EMPTY_RESPONSE')
    const notAnImage = await failure([completed([{ type: 'image_generation_call', id: 'ig_4', result: 'AQID' }])])
    expect(notAnImage.message).toMatch(/are not image\/png/)
  })

  it('streams the text a closing item carries beyond the deltas', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'he', output_index: 0 },
      { type: 'response.output_item.done', item: { ...messageItem(), content: [{ type: 'output_text', text: 'hello' }] }, output_index: 0 },
      completed(),
    ]
    const chunks = await translate(events)
    expect(chunks.slice(0, -1)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'he' },
      { type: 'text-delta', index: 0, text: 'llo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('keeps the deltas when a closing item disagrees with them', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'streamed', output_index: 0 },
      { type: 'response.output_item.done', item: { ...messageItem(), content: [{ type: 'output_text', text: 'other' }] }, output_index: 0 },
      completed(),
    ]
    expect(await translate(events)).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'streamed' } })
  })

  it('translates a signed reasoning item, keeping it for replay', async () => {
    const item = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'first' }, { type: 'summary_text', text: 'second' }],
      encrypted_content: 'opaque',
    }
    const events = [
      { type: 'response.output_item.added', item: reasoningItem(), output_index: 0 },
      { type: 'response.reasoning_summary_text.delta', delta: 'first', output_index: 0 },
      { type: 'response.reasoning_summary_part.done', output_index: 0 },
      { type: 'response.reasoning_summary_text.delta', delta: 'second', output_index: 0 },
      { type: 'response.output_item.done', item, output_index: 0 },
      completed(),
    ]
    const chunks = await translate(events)
    expect(chunks.slice(0, 5)).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'first' },
      { type: 'reasoning-delta', index: 0, text: '\n\n' },
      { type: 'reasoning-delta', index: 0, text: 'second' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'first\n\nsecond' } },
    ])
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      replayState: { blocks: [{ type: 'reasoning', itemId: 'rs_1', item: JSON.stringify(item) }] },
    })
  })

  it('reads plain reasoning text as well as summaries', async () => {
    const events = [
      { type: 'response.reasoning_text.delta', delta: 'plain', output_index: 2 },
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_2', content: [{ type: 'reasoning_text', text: 'plain' }] }, output_index: 2 },
      completed(),
    ]
    const chunks = await translate(events)
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'plain' } })
    expect(chunks.at(-1)).toMatchObject({ replayState: { blocks: [{ type: 'reasoning', itemId: 'rs_2' }] } })
  })

  it('writes the authoritative output of an endpoint that never streamed', async () => {
    const text = { ...messageItem('msg_9'), content: [{ type: 'output_text', text: 'answer' }] }
    const reasoning = { type: 'reasoning', id: 'rs_9', summary: [{ text: 'weighed' }] }
    const call = { ...callItem('fc_9'), arguments: '{"cmd":"ls"}' }
    const events = [completed([reasoning, text, call, { type: 'function_call_output', call_id: 'call_a', output: 'listed' }])]
    const chunks = await translate(events)
    expect(chunks.slice(0, -1)).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'weighed' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'weighed' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call_a', name: 'shell', arguments: '{"cmd":"ls"}' } },
    ])
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: {
        blocks: [
          { type: 'reasoning', itemId: 'rs_9', item: JSON.stringify(reasoning) },
          { type: 'text', itemId: 'msg_9' },
          { type: 'tool-call', itemId: 'fc_9' },
        ],
      },
    })
  })

  it('assembles a tool call from its fragments and stops for it', async () => {
    const events = [
      { type: 'response.output_item.added', item: callItem(), item_id: 'fc_1', output_index: 0 },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"cmd"' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: ':"ls"}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"cmd":"ls"}' },
      { type: 'response.output_item.done', item: { ...callItem(), arguments: '{"cmd":"ls"}' }, item_id: 'fc_1', output_index: 0 },
      completed([], undefined),
    ]
    const chunks = await translate(events)
    expect(chunks.slice(0, -1)).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_a', name: 'shell', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 0, id: 'call_a', argumentsDelta: '{"cmd"' },
      { type: 'tool-call-delta', index: 0, id: 'call_a', argumentsDelta: ':"ls"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_a', name: 'shell', arguments: '{"cmd":"ls"}' } },
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('opens a call from its argument fragments when the item announcement never came', async () => {
    const events = [
      { type: 'response.function_call_arguments.delta', item_id: 'fc_7', delta: '{}' },
      { type: 'response.output_item.done', item: { ...callItem('fc_7', 'fc_7'), arguments: '{}' }, item_id: 'fc_7', output_index: 0 },
      completed(),
    ]
    expect(await translate(events)).toContainEqual({
      type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fc_7', name: 'shell', arguments: '{}' },
    })
  })

  it('ignores events naming nothing this build can address', async () => {
    const events = [
      { type: 'response.future_event' },
      { type: 'response.output_item.added', item: messageItem('msg_1') },
      { type: 'response.output_item.added', item: { type: 'function_call', id: '' }, output_index: 0 },
      { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1' }, output_index: 1 },
      { type: 'response.output_text.delta', delta: '', output_index: 0 },
      { type: 'response.reasoning_summary_text.delta', delta: '', output_index: 0 },
      { type: 'response.reasoning_summary_part.done', output_index: 7 },
      { type: 'response.function_call_arguments.delta', item_id: '', delta: '{}' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_missing', arguments: '{}' },
      { type: 'response.output_item.done', item: { type: 'web_search_call', id: 'ws_1' }, output_index: 0 },
      { type: 'response.output_item.done', item: { type: 'function_call' }, output_index: 0 },
      { type: 'response.output_text.delta', delta: 'built', output_index: 0 },
      completed(),
    ]
    expect(await translate(events)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'built' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'built' } },
      expect.objectContaining({ type: 'finish' }),
    ])
  })

  it('closes a block the terminal event never closed', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'half', output_index: 0 },
      completed(),
    ]
    expect(await translate(events)).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'half' } })
  })

  it('keeps the item identities announced by the opening event', async () => {
    const events = [
      { type: 'response.output_item.added', item: messageItem('msg_5'), output_index: 0 },
      { type: 'response.output_text.delta', delta: 'hi', output_index: 0 },
      completed(),
    ]
    const finish = (await translate(events)).at(-1)
    if (finish?.type !== 'finish') throw new Error('the stream did not finish')
    expect(finish.replayState?.blocks).toEqual([{ type: 'text', itemId: 'msg_5' }])
  })

  it('maps the statuses this protocol reports', async () => {
    const turn = async (events: Array<Record<string, unknown>>, sawSentinel = false): Promise<AdapterChunk | undefined> =>
      (await translate(events, sawSentinel)).at(-1)
    const text = { type: 'response.output_text.delta', delta: 'hi', output_index: 0 }

    expect(await turn([
      { type: 'response.output_text.delta', delta: 'hi', output_index: 0 },
      { type: 'response.incomplete', response: { id: 'resp_1', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } },
    ])).toMatchObject({ reason: { kind: 'max-tokens' } })
    expect(await turn([text, { type: 'response.incomplete', response: { status: 'incomplete', output: [] } }]))
      .toMatchObject({ reason: { kind: 'stop' } })
    expect(await turn([{ type: 'response.refusal.delta', delta: 'no', output_index: 0 }, completed()]))
      .toMatchObject({ reason: { kind: 'stop' } })
    // A gateway that appends a sentinel instead of a terminal event still ends its turn.
    expect(await turn([text], true)).toMatchObject({ reason: { kind: 'stop' } })
    expect(await turn([{ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{}' }], true))
      .toMatchObject({ reason: { kind: 'tool-calls' } })
  })

  it('refuses a stream that was cut off', async () => {
    const events = [{ type: 'response.output_text.delta', delta: 'half', output_index: 0 }]
    const error = await failure(events)
    expect(error.code).toBe('TRANSPORT')
    expect(error.message).toMatch(/before a terminal event/u)
  })

  it('refuses a response that carried no content', async () => {
    expect((await failure([completed()])).code).toBe('EMPTY_RESPONSE')
  })

  it('refuses a turn that ended without an outcome', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'hi', output_index: 0 },
      { type: 'response.completed', response: { id: 'resp_1', output: [] } },
    ]
    const error = await failure(events)
    expect(error.code).toBe('TRANSPORT')
    expect(error.message).toMatch(/without an outcome/u)
  })

  it('classifies an in-band provider failure', async () => {
    expect((await failure([{ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }])).code)
      .toBe('RATE_LIMIT')
    const failed = await failure([{ type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } }])
    expect(failed.code).toBe('SERVER')
    expect(failed.message).toBe('boom')
    // A failure without a payload of its own still reports something readable.
    expect((await failure([{ type: 'response.failed' }])).message).toMatch(/stream error/u)
  })

  it('reports the accounting this protocol splits out', async () => {
    const withUsage = async (usage: Record<string, unknown>): Promise<StreamChunk | undefined> =>
      (await translate([
        { type: 'response.output_text.delta', delta: 'hi', output_index: 0 },
        completed([], usage),
      ])).find(chunk => chunk.type === 'usage')
    expect(await withUsage({ input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } }))
      .toEqual({ type: 'usage', usage: { inputTokens: 6, outputTokens: 2, totalTokens: 12, cacheReadTokens: 4, cacheWriteTokens: 0 } })
    // A provider that reports more cached tokens than input leaves no uncached input.
    expect(await withUsage({ input_tokens: 2, output_tokens: 1, input_tokens_details: { cached_tokens: 5 } }))
      .toMatchObject({ usage: { inputTokens: 0, totalTokens: 3, cacheReadTokens: 5 } })
    // An unusable count is a malformed response, not a zero.
    expect((await failure([
      { type: 'response.output_text.delta', delta: 'hi', output_index: 0 },
      completed([], { input_tokens: 1.5, output_tokens: 1 }),
    ])).code).toBe('MALFORMED_RESPONSE')
    // A report that never reached both counts ships nothing.
    const partial = await translate([
      { type: 'response.output_text.delta', delta: 'hi', output_index: 0 },
      completed([], { input_tokens: 4 }),
    ])
    expect(partial.some(chunk => chunk.type === 'usage')).toBe(false)
  })

  it('keeps a reasoning item this build cannot replay out of the envelope', async () => {
    const events = [
      { type: 'response.reasoning_text.delta', delta: 'plain', output_index: 0 },
      { type: 'response.output_item.done', item: { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'plain' }] }, output_index: 0 },
      completed(),
    ]
    const finish = (await translate(events)).at(-1)
    if (finish?.type !== 'finish') throw new Error('the stream did not finish')
    expect(finish.replayState?.blocks).toEqual([{ type: 'reasoning' }])
  })
})

describe('openai-responses stream edges', () => {
  it('reads a refusal and skips parts it cannot read', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'streamed', output_index: 0 },
      {
        type: 'response.output_item.done',
        item: { type: 'message', id: 'msg_1', output_index: 0, content: [{ type: 'unknown' }, { type: 'refusal', refusal: 'no' }] },
        output_index: 0,
      },
      completed(),
    ]
    expect(await translate(events)).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'streamed' } })
    // A refusal part is the authoritative text when the deltas never arrived.
    const refusalOnly = [
      { type: 'response.output_item.done', item: { type: 'message', id: 'msg_2', content: [{ type: 'refusal', refusal: 'no' }, { type: 'unknown' }] }, output_index: 0 },
      completed(),
    ]
    expect(await translate(refusalOnly)).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'no' } })
  })

  it('reads reasoning parts that carry no text', async () => {
    const events = [
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_1', summary: [{ text: 'summarized' }, {}] },
        output_index: 0,
      },
      completed(),
    ]
    expect(await translate(events)).toContainEqual({
      type: 'block-end', index: 0, block: { type: 'reasoning', text: 'summarized\n\n' },
    })
    // A reasoning item whose parts carry no text closes nothing: there is no
    // block for it, and the turn's text stands on its own.
    const contentForm = [
      { type: 'response.output_text.delta', delta: 'answer', output_index: 1 },
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_2', content: [{ type: 'reasoning_text' }] }, output_index: 0 },
      completed(),
    ]
    expect(await translate(contentForm)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'answer' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } },
      expect.objectContaining({ type: 'finish' }),
    ])
  })

  it('reports accounting that never split out a cache count', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'hi', output_index: 0 },
      completed([], { input_tokens: 5, output_tokens: 1 }),
    ]
    expect(await translate(events)).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  it('writes a call twice reported without rewriting it', async () => {
    const events = [
      { type: 'response.output_item.added', item: callItem(), item_id: 'fc_1', output_index: 0 },
      { type: 'response.output_item.done', item: { ...callItem(), arguments: '{}' }, item_id: 'fc_1', output_index: 0 },
      { type: 'response.output_item.done', item: { ...callItem(), arguments: '{}' }, item_id: 'fc_1', output_index: 0 },
      completed([{ type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'shell', arguments: '{}' }]),
    ]
    const chunks = await translate(events)
    expect(chunks.filter(chunk => chunk.type === 'block-end')).toHaveLength(1)
    expect(chunks.filter(chunk => chunk.type === 'block-start')).toHaveLength(1)
  })

  it('writes a call the terminal event names without any of its own fields', async () => {
    const events = [completed([{ type: 'function_call', id: 'fc_bare' }])]
    expect(await translate(events)).toContainEqual({
      type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fc_bare', name: '', arguments: '' },
    })
    // A call item the terminal event does not identify is not addressable.
    expect(await failure([completed([{ type: 'function_call' }])])).toBeDefined()
  })

  it('closes a text item the stream already carried once, by identity and by index', async () => {
    const events = [
      { type: 'response.output_item.added', item: messageItem('msg_1'), output_index: 0 },
      { type: 'response.output_text.delta', delta: 'hi', output_index: 0 },
      { type: 'response.output_item.done', item: { ...messageItem('msg_1'), content: [{ type: 'output_text', text: 'hi' }] } },
      completed([{ type: 'message', id: 'msg_1', output_index: 0, content: [{ type: 'output_text', text: 'hi' }] }]),
    ]
    const chunks = await translate(events)
    expect(chunks.filter(chunk => chunk.type === 'block-end')).toHaveLength(1)
    // A second `done` for the same item closes nothing new either.
    const twice = [
      { type: 'response.output_text.delta', delta: 'hi', output_index: 0 },
      { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', output_index: 0, content: [{ type: 'output_text', text: 'hi' }] }, output_index: 0 },
      { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', output_index: 0, content: [{ type: 'output_text', text: 'hi' }] }, output_index: 0 },
      completed(),
    ]
    expect((await translate(twice)).filter(chunk => chunk.type === 'block-end')).toHaveLength(1)
  })

  it('writes nothing for an empty item it never saw', async () => {
    const events = [
      { type: 'response.output_item.done', item: { type: 'message', id: 'msg_empty', content: [] } },
      { type: 'response.output_text.delta', delta: 'hi', output_index: 0 },
      completed(),
    ]
    expect(await translate(events)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
      expect.objectContaining({ type: 'finish' }),
    ])
  })

  it('streams a reasoning suffix the closing item owed', async () => {
    const events = [
      { type: 'response.reasoning_summary_text.delta', delta: 'we', output_index: 0 },
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [{ text: 'weighing' }] }, output_index: 0 },
      completed(),
    ]
    expect(await translate(events)).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'ighing' })
  })

  it('accepts events that name no index, item, or field', async () => {
    const events = [
      { type: 'response.created' },
      { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' }, output_index: 0 },
      { type: 'response.output_text.delta', delta: 'first', output_index: 0 },
      { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' }, output_index: 0 },
      { type: 'response.output_item.added', item: { type: 'message' }, output_index: 1 },
      { type: 'response.output_text.delta', delta: 'loose' },
      { type: 'response.reasoning_text.delta', delta: 'loose' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_9' },
      { type: 'response.function_call_arguments.done' },
      completed(),
    ]
    const chunks = await translate(events)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 1, text: 'loose' })
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 2, text: 'loose' })
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish') throw new Error('the stream did not finish')
    // The stream opened without naming the response; the terminal event did.
    expect(finish.replayState?.response).toEqual({
      kind: 'llm-service-lite-responses', version: 1, stopReason: 'completed', responseId: 'resp_1',
    })
  })
  it('reads a message whose parts carry no text of their own', async () => {
    const events = [
      { type: 'response.output_text.delta', delta: 'streamed', output_index: 0 },
      {
        type: 'response.output_item.done',
        item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text' }, { type: 'refusal' }] },
        output_index: 0,
      },
      completed(),
    ]
    expect(await translate(events)).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'streamed' } })
  })

  it('reads a reasoning item whose content is not reasoning text', async () => {
    const events = [
      { type: 'response.reasoning_text.delta', delta: 'streamed', output_index: 0 },
      {
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_1', content: [{ type: 'output_text', text: 'ignored' }] },
        output_index: 0,
      },
      completed(),
    ]
    expect(await translate(events)).toContainEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'streamed' } })
  })

  it('writes an item that names neither itself nor its index', async () => {
    const events = [
      { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'loose' }] } },
      completed(),
    ]
    expect(await translate(events)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'loose' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'loose' } },
      expect.objectContaining({ type: 'finish' }),
    ])
  })

  it('announces a call that arrived with nothing but its identity', async () => {
    const events = [
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_bare' }, output_index: 0 },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_bare' }, output_index: 0 },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_bare', delta: '{"cmd":"ls"}' },
      completed(),
    ]
    const chunks = await translate(events)
    expect(chunks.slice(0, -1)).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'fc_bare', name: '', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 0, id: 'fc_bare', name: '', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 0, id: 'fc_bare', argumentsDelta: '{"cmd":"ls"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fc_bare', name: '', arguments: '{"cmd":"ls"}' } },
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('writes a terminal item the stream never opened, indexed as the provider named it', async () => {
    const events = [
      completed([{ type: 'message', id: 'msg_new', output_index: 3, content: [{ type: 'output_text', text: 'late' }] }]),
    ]
    const chunks = await translate(events)
    expect(chunks.slice(0, -1)).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'late' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'late' } },
    ])
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: { blocks: [{ type: 'text', itemId: 'msg_new' }] },
    })
  })
})
