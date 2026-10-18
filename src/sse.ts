/**
 * Server-sent-event framing shared by this adapter's transports.
 *
 * The idle pulse is raised on data frames only. A gateway that keeps a stalled
 * connection alive with `: ping` comments would otherwise renew the watchdog
 * forever, which is exactly the half-open connection the watchdog exists to
 * catch.
 *
 * The parser dispatches an event only when a blank line terminates it. A
 * gateway that closes the connection right after its last event's single
 * newline — observed with endpoints that end on `[DONE]` or `message_stop`
 * without the conventional trailing blank line — would otherwise lose that
 * frame and turn a complete response into an apparent cut-off. The reader
 * therefore appends the missing terminator at end of stream.
 *
 * @module dsh-llm-service-lite/sse
 */

import { EventSourceParserStream, ParseError } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** The protocol's end-of-stream sentinel; it carries no JSON payload. */
const DONE_SENTINEL = '[DONE]'

/**
 * Ceiling on one buffered SSE event. An endpoint that streams bytes without
 * ever emitting an event boundary would otherwise grow the parser buffer
 * without bound; exceeding the ceiling is a deterministic protocol failure.
 * (Matches the reference transport's 8 MiB guard.)
 */
const MAX_SSE_EVENT_CHARS = 8 * 1024 * 1024

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
   * @throws LlmError `MALFORMED_RESPONSE` when a frame is invalid JSON or
   *   exceeds the buffer ceiling, and `TRANSPORT` when the connection ended
   *   inside a frame whose remainder never arrived.
   */
  async * events(): AsyncGenerator<Record<string, unknown>> {
    // Appending a blank line at end of stream dispatches whatever the parser
    // still holds: an event that was complete but lacked its terminator, or a
    // partial tail a closed connection left behind.
    let flushed = false
    const terminate = new TransformStream<string, string>({
      flush(controller) {
        flushed = true
        controller.enqueue('\n\n')
      },
    })
    const frames = this.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(terminate)
      .pipeThrough(new EventSourceParserStream({ maxBufferSize: MAX_SSE_EVENT_CHARS }))
    const reader = frames.getReader()
    try {
      while (true) {
        let next: ReadableStreamReadResult<{ data: string }>
        try {
          next = await reader.read()
        } catch (error) {
          throw this.framingFailure(error)
        }
        if (next.done) return
        const frame = next.value
        if (frame.data === DONE_SENTINEL) {
          this.done = true
          return
        }
        // An event whose only data line was empty is a keepalive, not JSON. It
        // still proves the connection is alive, so it renews the watchdog.
        if (frame.data.length === 0) {
          this.activity()
          continue
        }
        this.activity()
        let raw: unknown
        try {
          raw = JSON.parse(frame.data)
        } catch (_invalidSseJson) {
          throw new LlmError(
            flushed
              ? 'llm-service-lite: provider stream ended inside an incomplete frame'
              : 'llm-service-lite: provider stream contains invalid JSON',
            flushed ? 'TRANSPORT' : 'MALFORMED_RESPONSE',
          )
        }
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
        yield raw as Record<string, unknown>
      }
    } finally {
      // Early exit ([DONE]) leaves the body unread; cancel it so the
      // connection is released instead of waiting for the server to finish.
      await reader.cancel().catch(() => {})
    }
  }

  /** Classify one failure raised by the framing pipeline itself. */
  private framingFailure(error: unknown): LlmError {
    if (error instanceof ParseError) {
      return new LlmError(
        `llm-service-lite: provider stream exceeded ${String(MAX_SSE_EVENT_CHARS)} buffered characters without an event boundary`,
        'MALFORMED_RESPONSE',
        { cause: error },
      )
    }
    return error instanceof LlmError
      ? error
      : new LlmError('llm-service-lite: provider stream framing failed', 'TRANSPORT', { cause: error })
  }
}
