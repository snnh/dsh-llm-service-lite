/**
 * Request-image preparation for the chat-completions wire.
 *
 * One retained occurrence becomes one deterministic request version, read from
 * the attachment provider and encoded per attachment id, so two occurrences of
 * the same image cost one read. The wire carries it as a base64 data URL: an
 * OpenAI-compatible `image_url` part accepts a URL, and a data URL is the only
 * form that needs no reachable host and no upload step.
 *
 * The route's accumulated size is checked against the shared budget vocabulary
 * before anything is encoded. An over-budget request fails with
 * `IMAGE_OFFLOAD_REQUIRED` naming the count of oldest occurrences to offload,
 * which the session layer then performs and retries — the adapter never drops
 * an image on its own, because a silently missing image reads to the model as a
 * turn where the user attached nothing.
 *
 * @module dsh-llm-service-lite/images
 */

import {
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  offloadedImageText as offloadedPlaceholderText,
  requiredImageOffload,
  textOnlyImageText,
} from '@deepseek-ai/dsh-llm'
import type {
  ImageBlock,
  LlmImageRequestBudget,
  LlmImageRequestPrice,
  LlmImageRequestPricing,
  RequestMessage,
} from '@deepseek-ai/dsh-llm'
import { longEdgeDimensions, requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type {
  AttachmentStore,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { ResolvedImageTokens, ResolvedOwcModel } from './profiles.ts'

/** Encoded-byte ceiling for one request image unless the model states its own. */
export const DEFAULT_IMAGE_MAX_BYTES = 2 * 1024 * 1024

/** Long-edge ceiling for one request image; a larger source is scaled down, never up. */
export const IMAGE_MAX_DIMENSION = 4096

/**
 * Pixel budget a model declaring `imagePixelBudget: 'low'` selects. Both the
 * value and the name come from the official adapter's published low-detail
 * grid, so a profile imported from OWC keeps meaning the same request.
 */
export const LOW_DETAIL_IMAGE_PIXEL_BUDGET = 512 * 512

/**
 * Route-level image request budgets, the values this adapter applies to every
 * request a route serves.
 */
export interface ImageRequestBudget extends LlmImageRequestBudget {
  /** Bytes of accumulated base64 payload one request carries. */
  maxBytes: number
  /** Image occurrences one request carries. */
  maxImages: number
}

/**
 * The deterministic request version one model route asks the attachment
 * provider for: the model's pixel budget when it declares one, the source
 * dimensions otherwise, always capped at {@link IMAGE_MAX_DIMENSION} on the
 * long edge, with the model's encoded-byte target.
 * @param model - the route's declared facts for this model.
 * @param source - intrinsic dimensions of the normalized attachment.
 * @returns target dimensions and encoded-byte ceiling.
 */
export function requestImageTarget(
  model: ResolvedOwcModel,
  source: Pick<ImageAttachmentRef, 'width' | 'height'>,
): ImageRequestTarget {
  const budget = model.imagePixelBudget
  const projected = budget === undefined
    ? { width: source.width, height: source.height }
    : requestImageDimensions(source.width, source.height, budget)
  const capped = Math.max(projected.width, projected.height) > IMAGE_MAX_DIMENSION
    ? longEdgeDimensions(source.width, source.height, IMAGE_MAX_DIMENSION)
    : projected
  return { ...capped, maxBytes: model.imageMaxBytes ?? DEFAULT_IMAGE_MAX_BYTES }
}

/** Visit every image block of one request, in conversation order. */
function visitImageBlocks(messages: readonly RequestMessage[], visit: (block: ImageBlock) => void): void {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'image') visit(block)
    }
  }
}

/**
 * The base64 data URL one request version is carried as.
 * @param version - request bytes read from the attachment provider.
 * @returns `data:` URL naming the encoded media type.
 */
export function imageDataUrl(version: RequestImageAttachment): string {
  return `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`
}

/**
 * The text one offloaded occurrence contributes: the placeholder the durable
 * offload decision left for it, naming the attachment and the read-only path a
 * model tool can open instead of the bytes.
 * @param block - an occurrence already marked offloaded.
 * @returns deterministic placeholder text.
 */
export function offloadedImageText(block: ImageBlock): string {
  return offloadedPlaceholderText(block.attachment)
}

/**
 * Read one request version per retained attachment id.
 * @param model - the route's declared facts for this model.
 * @param messages - complete request inputs.
 * @param attachments - mounted attachment provider; absence is a configuration error, not an omission.
 * @param budget - route budgets the accumulated request must fit.
 * @param signal - optional cancellation for provider reads.
 * @returns request versions keyed by durable attachment id.
 * @throws LlmError `INVALID_CONFIG` when no attachment provider is mounted, or
 *   `IMAGE_OFFLOAD_REQUIRED` when the request exceeds the route budget.
 */
export async function prepareRequestImages(
  model: ResolvedOwcModel,
  messages: readonly RequestMessage[],
  attachments: AttachmentStore | undefined,
  budget: ImageRequestBudget,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, RequestImageAttachment>> {
  const versions = new Map<string, RequestImageAttachment>()
  const references: ImageBlock[] = []
  visitImageBlocks(messages, (block) => {
    if (block.offloaded === true) return
    references.push(block)
  })
  if (references.length === 0) return versions
  if (attachments === undefined) {
    throw new LlmError(
      'llm-service-lite: this model declares image input, but no attachment provider is mounted',
      'INVALID_CONFIG',
    )
  }
  const bytesById = new Map<string, number>()
  for (const block of references) {
    const ref = block.attachment
    let version = versions.get(ref.attachmentId)
    if (version === undefined) {
      version = await attachments.readImageRequest(ref, requestImageTarget(model, ref), signal)
      versions.set(ref.attachmentId, version)
    }
    bytesById.set(ref.attachmentId, version.bytes)
  }
  // Vendors a request that the route derives and does not fit it: the failure
  // reports how many occurrences the caller must offload. Byte accounting
  // matches what this adapter sends (inline base64, not raw file bytes).
  //
  // The walk visits exactly the occurrences read above, so every lookup hits;
  // the assertion states that invariant instead of defaulting to zero bytes,
  // which would under-count and let a request exceed the route's limit.
  const overBudget = requiredImageOffload(messages, budget,
    block => bytesById.get(block.attachment.attachmentId) as number)
  if (overBudget > 0) {
    throw new LlmError(
      `llm-service-lite: provider image request exceeds the route budget; ${String(overBudget)} more oldest occurrence(s) must be offloaded.`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages: overBudget },
    )
  }
  return versions
}

/**
 * The visual tokens one request image of these dimensions costs under a
 * declared accounting. Both spellings are published provider accountings rather
 * than inventions: `area` charges a flat pixel grid (Claude bills one token per
 * 750 pixels), and `tiles` charges a base plus one price per square tile the
 * image covers, which is how the OpenAI vision documentation describes an
 * image at full detail. A declaration the profile omitted prices nothing here —
 * the token meter then keeps its own structural heuristic rather than a number
 * this adapter guessed.
 * @param accounting - the route's declared accounting.
 * @param width - request-image width in pixels.
 * @param height - request-image height in pixels.
 * @returns provider visual tokens for one occurrence.
 */
export function imageTokens(accounting: ResolvedImageTokens, width: number, height: number): number {
  if (accounting.kind === 'area') return Math.ceil((width * height) / accounting.per)
  return accounting.base
    + accounting.perTile * Math.ceil(width / accounting.tile) * Math.ceil(height / accounting.tile)
}

/**
 * Price every surface image occurrence the way this route's request carries it.
 *
 * The token meter asks for one price per occurrence of the session surface, in
 * model-visible order, and adds the returned text under its own text estimator.
 * A retained occurrence is therefore priced at the very dimensions
 * {@link requestImageTarget} will ask the attachment provider for — the one
 * number that decides the endpoint's own charge — and contributes no text,
 * because this adapter sends none beside the bytes. An offloaded occurrence
 * contributes exactly the placeholder the request will carry, and a route
 * without the image modality prices the deterministic substitution text the
 * runtime puts in the image's place.
 *
 * @param model - the route's declared facts for this model.
 * @returns synchronous per-occurrence pricing, or undefined when a route that
 *   carries images declared no visual-token accounting.
 */
export function imageRequestPricing(model: ResolvedOwcModel): LlmImageRequestPricing | undefined {
  if (!model.modalities.includes('image')) {
    return { priceImages: images => images.map(block => ({ visualTokens: 0, text: textOnlyImageText(block.attachment) })) }
  }
  const accounting = model.imageTokens
  if (accounting === undefined) return undefined
  return {
    priceImages: (images): readonly LlmImageRequestPrice[] => images.map((block) => {
      if (block.offloaded === true) return { visualTokens: 0, text: offloadedImageText(block) }
      const target = requestImageTarget(model, block.attachment)
      return { visualTokens: imageTokens(accounting, target.width, target.height), text: '' }
    }),
  }
}
