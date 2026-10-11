/**
 * Server-sent-event framing shared by this adapter's transports.
 *
 * The idle pulse is raised on data frames only. A gateway that keeps a stalled
 * connection alive with `: ping` comments would otherwise renew the watchdog
 * forever, which is exactly the half-open connection the watchdog exists to
 * catch.
 *
 * @module dsh-llm-service-lite/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** The protocol's end-of-stream sentinel; it carries no JSON payload. */
const DONE_SENTINEL = '[DONE]'

/**
 * One provider event stream, decoded frame by frame.
 *
 * `[DONE]` terminates the stream and is remembered rather than yielded, so a
 * caller can tell a clean shutdown from a connection that simply stopped. It is
 * the chat-completions sentinel; a protocol whose terminal event is in-band (a
 * Messages `message_stop`) never sees it, and a gateway that appends one anyway
 * is treated as having terminated the stream.
 */
export class SseReader {
  private done = false
  private readonly body: ReadableStream<BufferSource>
  private readonly activity: () => void

  /**
   * @param body - response bytes to decode.
   * @param activity - pulse raised for every data frame, never for a comment.
   */
  constructor(body: ReadableStream<BufferSource>, activity: () => void) {
    this.body = body
    this.activity = activity
  }

  /** Whether the stream delivered its `[DONE]` sentinel. */
  get sawDone(): boolean {
    return this.done
  }

  /**
   * Decode the stream into JSON events until the sentinel or the last frame.
   * @returns the parsed events in arrival order.
   */
  async * events(): AsyncGenerator<Record<string, unknown>> {
    const frames = this.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())
    for await (const frame of frames) {
      if (frame.data === DONE_SENTINEL) {
        this.done = true
        return
      }
      this.activity()
      let raw: unknown
      try {
        raw = JSON.parse(frame.data)
      } catch (_invalidSseJson) {
        throw new LlmError('llm-service-lite: provider stream contains invalid JSON', 'MALFORMED_RESPONSE')
      }
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
      yield raw as Record<string, unknown>
    }
  }
}
