/** A local chat-completions provider the adapter's specs talk to over real HTTP. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** One running mock provider. */
export interface MockProvider {
  /** Endpoint root a profile's `baseURL` should name. */
  url: string
  /** Stop the provider and release its port. */
  close: () => Promise<void>
  /** Request bodies the provider received, in arrival order. */
  readonly bodies: Record<string, unknown>[]
}

/** Start a mock that answers every request with the handler's frames. */
export async function mockProvider(
  handler: (response: ServerResponse, body: Record<string, unknown>) => void,
): Promise<MockProvider> {
  const bodies: Record<string, unknown>[] = []
  const server: Server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      // A listing GET carries no body; a model call always does.
      const text = Buffer.concat(chunks).toString('utf8')
      const body = text.length === 0 ? {} : JSON.parse(text) as Record<string, unknown>
      bodies.push(body)
      handler(outgoing, body)
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the mock provider did not bind a port')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    }),
  }
}

/** Write one server-sent-event frame. */
export function frame(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
}

/** Answer with one complete text turn. */
export function textTurn(response: ServerResponse, content = 'hello'): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  frame(response, { choices: [{ finish_reason: null, delta: { content } }] })
  frame(response, { choices: [{ finish_reason: 'stop', delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 1 } })
  frame(response, '[DONE]')
  response.end()
}

/** Answer a model-listing request. */
export function listing(response: ServerResponse, models: Array<Record<string, unknown>>): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ data: models }))
}
