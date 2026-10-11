import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  decodeGeneratedImage,
  encodedImage,
  generatedImageBlock,
  isGeneratedImage,
  sniffImageMediaType,
} from '../src/image-output.ts'

/** One PNG payload, from its magic bytes onward. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

/** The base64 one payload is carried as. */
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

describe('generated images', () => {
  it('sniffs the raster type from the bytes themselves', () => {
    const bytes = (text: string): number[] => Array.from(text, character => character.charCodeAt(0))
    expect(sniffImageMediaType(PNG)).toBe('image/png')
    expect(sniffImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMediaType(new Uint8Array(bytes('GIF89a')))).toBe('image/gif')
    expect(sniffImageMediaType(new Uint8Array([...bytes('RIFF'), 0, 0, 0, 0, ...bytes('WEBP')]))).toBe('image/webp')
    expect(sniffImageMediaType(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })

  it('decodes an inline data URL, and lets the bytes decide their own type', () => {
    const decoded = decodeGeneratedImage(`data:image/png;base64,${base64(PNG)}`, 'the endpoint')
    expect(decoded.mediaType).toBe('image/png')
    expect([...decoded.data]).toEqual([...PNG])
    // A declared type the payload contradicts is corrected, not trusted: the
    // attachment provider validates the stored bytes against the type it is
    // saved as.
    expect(decodeGeneratedImage(`data:image/jpeg;base64,${base64(PNG)}`, 'the endpoint').mediaType).toBe('image/png')
  })

  it('refuses a URL it would have to fetch, and a payload that is not a raster image', () => {
    expect(() => decodeGeneratedImage('https://cdn.test/picture.png', 'the endpoint'))
      .toThrow(/does not fetch/)
    expect(() => decodeGeneratedImage('data:image/svg+xml;base64,PHN2Zz4=', 'the endpoint'))
      .toThrow(/does not carry/)
    expect(() => encodedImage(base64(new Uint8Array([1, 2, 3])), 'the endpoint'))
      .toThrow(/are not image\/png/)
    expect(() => encodedImage('', 'the endpoint')).toThrow(/are not image\/png/)
  })

  it('reads the declared type of an encoded payload, and builds its durable block', () => {
    expect(encodedImage(base64(PNG), 'the endpoint').mediaType).toBe('image/png')
    const chunk = { type: 'generated-image' as const, index: 2, mediaType: 'image/png' as const, data: PNG }
    expect(isGeneratedImage(chunk)).toBe(true)
    expect(isGeneratedImage({ type: 'block-start', index: 0, blockType: 'image' })).toBe(false)
    const attachment: ImageAttachmentRef = {
      attachmentId: 'sha256:a' as ImageAttachmentRef['attachmentId'],
      mediaType: 'image/png',
      bytes: 11,
      width: 1,
      height: 1,
    }
    expect(generatedImageBlock(attachment)).toEqual({ type: 'image', attachment })
  })
})
