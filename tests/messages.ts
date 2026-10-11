/** Message and request builders shared by the adapter's specs. */

import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ContentBlock, GenerateOptions, Message, ModelMessageSource, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, ImageMediaType, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

/** One system-prompt message carrying the given text. */
export function system(text: string, id = 'system'): Message {
  return { id: MessageId(id), role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] }
}

/** One user message with the given blocks. */
export function user(content: ContentBlock[], id = 'user'): Message {
  return { id: MessageId(id), role: 'user', source: { kind: 'user' }, content }
}

/** One assistant message produced by the given route. */
export function assistant(
  content: ContentBlock[],
  source: Partial<ModelMessageSource> = {},
  id = 'assistant',
): AssistantMessage {
  return {
    id: MessageId(id),
    role: 'assistant',
    source: { kind: 'model', provider: 'gateway', model: 'm', ...source },
    content,
  }
}

/** One developer message, as the tool-update producers publish them. */
export function developer(text: string, id = 'developer'): Message {
  return { id: MessageId(id), role: 'developer', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] }
}

/** One developer message carrying the caller's own blocks, tool changes included. */
export function developerWith(content: ContentBlock[], id = 'developer'): Message {
  return { id: MessageId(id), role: 'developer', source: { kind: 'system-prompt' }, content }
}

/** One tool-addition block, naming a tool a historical declaration describes. */
export function toolAddition(toolName: string): ContentBlock {
  return { type: 'tool-addition', toolName }
}

/** One tool-removal block, naming a tool the route declared earlier. */
export function toolRemoval(toolName: string): ContentBlock {
  return { type: 'tool-removal', toolName }
}

/** One tool-result message answering the given call. */
export function toolResult(callId: string, text: string, id = `result-${callId}`): Message {
  return {
    id: MessageId(id),
    role: 'tool',
    source: { kind: 'tool', callId: ToolCallId(callId) },
    toolCallId: ToolCallId(callId),
    content: [{ type: 'text', text }],
  }
}

/** One tool-result message with the caller's own content blocks and outcome. */
export function toolResultWith(
  callId: string,
  content: ContentBlock[],
  { isError = false, id = `result-${callId}` }: { isError?: boolean; id?: string } = {},
): Message {
  return {
    id: MessageId(id),
    role: 'tool',
    source: { kind: 'tool', callId: ToolCallId(callId) },
    toolCallId: ToolCallId(callId),
    content,
    isError,
  }
}

/** One tool call the model requested. */
export function toolCall(id: string, name: string, args: string): ContentBlock {
  return { type: 'tool-call', id: ToolCallId(id), name, arguments: args }
}

/** One durable image block, as the session layer hands it to a request. */
export function image(
  attachmentId: string,
  overrides: Partial<ImageAttachmentRef> = {},
  offloaded = false,
): ContentBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: attachmentId as ImageAttachmentRef['attachmentId'],
      mediaType: 'image/png',
      bytes: 3,
      width: 2,
      height: 2,
      ...overrides,
    },
    ...offloaded ? { offloaded: true as const } : {},
  }
}

/** One prepared request version carrying the given bytes. */
export function requestImage(data = 'abc', mediaType: ImageMediaType = 'image/png'): RequestImageAttachment {
  return {
    variantId: 'v' as RequestImageAttachment['variantId'],
    attachment: { attachmentId: 'sha256:x' as ImageAttachmentRef['attachmentId'], mediaType, bytes: data.length, width: 2, height: 2 },
    data: new TextEncoder().encode(data),
    mediaType,
    bytes: data.length,
    width: 2,
    height: 2,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
  }
}

/** Plain text block. */
export function text(value: string): ContentBlock {
  return { type: 'text', text: value }
}

/** One assembled request with the caller's fields layered onto a minimal call. */
export function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'gateway', model: 'm', messages: [], ...overrides }
}

/** One tool schema. */
export function toolSchema(name = 'shell'): ToolSchema {
  return { name, description: `run ${name}`, parameters: { type: 'object', properties: {} } }
}
