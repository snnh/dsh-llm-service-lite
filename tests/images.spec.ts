import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_IMAGE_MAX_BYTES,
  IMAGE_MAX_DIMENSION,
  imageDataUrl,
  imageRequestPricing,
  imageTokens,
  prepareRequestImages,
  requestImageTarget,
} from '../src/images.ts'
import { resolveProfiles, modelOf } from '../src/profiles.ts'
import { image, requestImage, user, text } from './messages.ts'

/** A route whose model declares image input, with optional overrides. */
const modelFor = (model: Record<string, unknown> = {}) => {
  const profile = resolveProfiles({
    gateway: {
      interfaceType: 'openai-chat-completions',
      baseURL: 'https://gateway.test/v1',
      models: [{ id: 'm', capabilities: { modalities: ['text', 'image'] }, ...model }],
    },
  }).get('gateway')
  if (profile === undefined) throw new Error('the route did not resolve')
  return modelOf(profile, 'm')
}

/** An attachment provider that answers with one deterministic request version. */
const store = (bytes = 3, onRead?: (ref: ImageAttachmentRef) => void) => ({
  readImageRequest: (ref: ImageAttachmentRef) => {
    onRead?.(ref)
    return Promise.resolve({
      ...requestImage('abc'),
      bytes,
      attachment: ref,
    } satisfies RequestImageAttachment)
  },
} as never)

describe('request image targets', () => {
  it('keeps the source dimensions when the model declares no pixel budget', () => {
    expect(requestImageTarget(modelFor(), { width: 800, height: 600 }))
      .toEqual({ width: 800, height: 600, maxBytes: DEFAULT_IMAGE_MAX_BYTES })
  })

  it('projects into the declared pixel budget without enlarging small sources', () => {
    expect(requestImageTarget(modelFor({ imagePixelBudget: 'low' }), { width: 1200, height: 800 }))
      .toMatchObject({ maxBytes: DEFAULT_IMAGE_MAX_BYTES })
    expect(requestImageTarget(modelFor({ imagePixelBudget: 'low' }), { width: 100, height: 100 }))
      .toMatchObject({ width: 100, height: 100 })
  })

  it('caps a source beyond the long-edge ceiling and takes the model byte target', () => {
    const target = requestImageTarget(modelFor({ imageMaxBytes: 4096 }), { width: 6000, height: 4000 })
    expect(Math.max(target.width, target.height)).toBe(IMAGE_MAX_DIMENSION)
    expect(target.maxBytes).toBe(4096)
  })
})

describe('request image preparation', () => {
  it('reads one version per retained attachment id', async () => {
    const seen: string[] = []
    const versions = await prepareRequestImages(
      modelFor(),
      [user([image('sha256:a'), image('sha256:a')], 'u1')],
      store(3, ref => seen.push(String(ref.attachmentId))),
      { representation: 'base64', maxBytes: 1_000, maxImages: 10 },
    )
    expect(seen).toEqual(['sha256:a'])
    expect(versions.size).toBe(1)
  })

  it('leaves a text-only request off the attachment path entirely', async () => {
    const versions = await prepareRequestImages(
      modelFor(),
      [user([text('hello')], 'u1')],
      undefined,
      { representation: 'base64', maxBytes: 1_000, maxImages: 10 },
    )
    expect(versions.size).toBe(0)
  })

  it('refuses image input when no attachment provider is mounted', async () => {
    await expect(prepareRequestImages(
      modelFor(),
      [user([image('sha256:a')], 'u1')],
      undefined,
      { representation: 'base64', maxBytes: 1_000, maxImages: 10 },
    )).rejects.toThrow(/no attachment provider is mounted/)
  })

  it('names the offload count when the request exceeds the route budget', async () => {
    const failure = await prepareRequestImages(
      modelFor(),
      [user([image('sha256:a'), image('sha256:b')], 'u1')],
      store(4),
      { representation: 'base64', maxBytes: 4, maxImages: 10, byteQuantum: 1 },
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmError)
    expect((failure as LlmError).code).toBe('IMAGE_OFFLOAD_REQUIRED')
    // Two 4-byte versions are 8 base64 bytes each; a 4-byte route budget needs
    // both oldest occurrences offloaded before the request fits.
    expect(String(failure)).toContain('2 more oldest occurrence(s)')
  })

  it('ignores offloaded occurrences for both versions and bytes', async () => {
    const versions = await prepareRequestImages(
      modelFor(),
      [user([image('sha256:a', {}, true), image('sha256:b')], 'u1')],
      store(4),
      { representation: 'base64', maxBytes: 8, maxImages: 1 },
    )
    expect([...versions.keys()]).toEqual(['sha256:b'])
  })
})

describe('wire encoding', () => {
  it('encodes request bytes as a base64 data URL naming the media type', () => {
    expect(imageDataUrl(requestImage('abc', 'image/webp'))).toBe('data:image/webp;base64,YWJj')
  })
})

describe('request image pricing', () => {
  /** One durable image occurrence, as the pricing path receives the surface. */
  const occurrence = (overrides: Partial<ImageAttachmentRef> = {}, offloaded = false): ImageBlock =>
    image('sha256:a', overrides, offloaded) as ImageBlock


  it('charges the pixel grid a profile declared', () => {
    const model = modelFor({ imageTokens: { kind: 'area', per: 750 } })
    const pricing = imageRequestPricing(model)
    expect(pricing?.priceImages([occurrence({ width: 1500, height: 750 })]))
      .toEqual([{ visualTokens: 1500, text: '' }])
    // A pixel of overflow pays a whole token: the accounting rounds up.
    expect(imageTokens({ kind: 'area', per: 750 }, 100, 100)).toBe(14)
  })

  it('charges a base plus the tiles an image covers', () => {
    const model = modelFor({ imageTokens: { kind: 'tiles', tile: 512, base: 85, perTile: 170 } })
    const pricing = imageRequestPricing(model)
    expect(pricing?.priceImages([occurrence({ width: 1024, height: 513 })]))
      .toEqual([{ visualTokens: 85 + 170 * 2 * 2, text: '' }])
  })

  it('prices a retained occurrence at the dimensions the request will ask for', () => {
    const model = modelFor({ imagePixelBudget: 512 * 512, imageTokens: { kind: 'area', per: 750 } })
    const pricing = imageRequestPricing(model)
    const target = requestImageTarget(model, { width: 2048, height: 1536 })
    expect(pricing?.priceImages([occurrence({ width: 2048, height: 1536 })]))
      .toEqual([{ visualTokens: imageTokens({ kind: 'area', per: 750 }, target.width, target.height), text: '' }])
  })

  it('prices an offloaded occurrence as the placeholder the request carries', () => {
    const model = modelFor({ imageTokens: { kind: 'area', per: 750 } })
    const pricing = imageRequestPricing(model)
    const prices = pricing?.priceImages([occurrence({}, true)])
    expect(prices?.[0]?.visualTokens).toBe(0)
    expect(prices?.[0]?.text).toContain('image omitted to fit request image limits')
  })

  it('prices a text-only route as the substitution the runtime performs', () => {
    const profile = resolveProfiles({
      gateway: {
        interfaceType: 'openai-chat-completions',
        models: [{ id: 'm' }],
      },
    }).get('gateway')
    if (profile === undefined) throw new Error('the route did not resolve')
    expect(imageRequestPricing(modelOf(profile, 'm'))?.priceImages([occurrence({ attachmentId: 'sha256:abcdef1234567890' as ImageAttachmentRef['attachmentId'] })]))
      .toEqual([{ visualTokens: 0, text: expect.stringContaining('image omitted because this model accepts text only') as unknown as string }])
  })

  it('leaves an undeclared accounting to the meter heuristic', () => {
    expect(imageRequestPricing(modelFor())).toBeUndefined()
  })
})
