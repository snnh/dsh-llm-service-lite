/**
 * Images an endpoint returns, carried back into the session.
 *
 * A model that generates or edits pictures answers with image content, and
 * every wire spells it differently: the chat-completions protocol returns
 * image parts beside the text, and the Responses protocol returns an
 * image-generation item whose result is the encoded picture. A wire translator
 * therefore emits {@link GeneratedImageChunk} — bytes and their declared media
 * type, not yet durable — and the adapter commits them through the attachment
 * provider and republishes them as the harness's own `block-end` image block,
 * so the session stores a reference rather than base64 in the durable log.
 *
 * @module dsh-llm-service-lite/image-output
 */

import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Image media types this adapter carries from an endpoint back into a session. */
const OUTPUT_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * One image an endpoint returned, before it becomes a durable attachment. The
 * adapter replaces it with a `block-end` chunk carrying the durable reference.
 */
export interface GeneratedImageChunk {
  /** Discriminator of this adapter's own chunk vocabulary. */
  type: 'generated-image'
  /** Block index the materialized image block keeps. */
  index: number
  /** Media type the endpoint declared for the bytes. */
  mediaType: ImageMediaType
  /** Encoded image bytes, exactly as the endpoint returned them. */
  data: Uint8Array
}

/** What one wire translator yields: the harness vocabulary plus this adapter's own chunk. */
export type AdapterChunk = StreamChunk | GeneratedImageChunk

/** Whether one chunk is an image this adapter still has to commit. */
export function isGeneratedImage(chunk: AdapterChunk): chunk is GeneratedImageChunk {
  return chunk.type === 'generated-image'
}

/**
 * Decode one image an endpoint returned inline.
 *
 * Only an inline `data:` URL is carried: the adapter never fetches a URL an
 * endpoint names, because that fetch would leave the request path and the
 * session would store a reference to content the deployment never received.
 *
 * @param url - the `url` of an image part the endpoint returned.
 * @param at - brief description of where the image came from, for the diagnostic.
 * @returns the decoded bytes and the media type they were declared as.
 * @throws LlmError `UNSUPPORTED_CONTENT` when the URL is not an inline image this adapter carries.
 */
export function decodeGeneratedImage(url: string, at: string): { mediaType: ImageMediaType; data: Uint8Array } {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/u.exec(url)
  const mediaType = match?.[1]
  if (match === null || mediaType === undefined) {
    throw new LlmError(
      `llm-service-lite: ${at} returned an image as a URL this adapter does not fetch;`
      + ' only an inline data: URL is carried',
      'UNSUPPORTED_CONTENT',
    )
  }
  if (!OUTPUT_MEDIA_TYPES.includes(mediaType)) {
    throw new LlmError(
      `llm-service-lite: ${at} returned an image of type "${mediaType}", which this adapter does not carry;`
      + ` it carries ${OUTPUT_MEDIA_TYPES.join(', ')}`,
      'UNSUPPORTED_CONTENT',
    )
  }
  return encodedImage(match[2] ?? '', at)
}

/**
 * Read encoded bytes as one durable image.
 *
 * The bytes decide: an endpoint's own declaration is a hint, and the
 * attachment provider validates the stored payload against the type it is
 * saved as.
 *
 * @param base64 - encoded image payload, without its data-URL prefix.
 * @param at - brief description of where the image came from, for the diagnostic.
 * @returns the decoded bytes and the media type the bytes themselves state.
 * @throws LlmError `UNSUPPORTED_CONTENT` when the payload is not an image this adapter carries.
 */
export function encodedImage(base64: string, at: string): { mediaType: ImageMediaType; data: Uint8Array } {
  const data = new Uint8Array(Buffer.from(base64, 'base64'))
  const sniffed = sniffImageMediaType(data)
  if (sniffed === undefined) {
    throw new LlmError(
      `llm-service-lite: ${at} returned image bytes that are not ${OUTPUT_MEDIA_TYPES.join(', ')};`
      + ' this adapter carries those four raster types',
      'UNSUPPORTED_CONTENT',
    )
  }
  return { mediaType: sniffed, data }
}

/**
 * The raster type a byte payload states through its magic bytes.
 * @param data - encoded image bytes.
 * @returns the media type, or undefined when the bytes name none of them.
 */
export function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  const ascii = (offset: number, text: string): boolean => {
    for (let index = 0; index < text.length; index += 1) {
      if (data[offset + index] !== text.charCodeAt(index)) return false
    }
    return true
  }
  if (data[0] === 0x89 && ascii(1, 'PNG')) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 'GIF8')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return undefined
}

/**
 * The durable image block one committed attachment becomes.
 * @param attachment - the reference the attachment provider returned.
 * @returns the block the harness session stores.
 */
export function generatedImageBlock(attachment: ImageAttachmentRef): ContentBlock {
  return { type: 'image', attachment }
}
