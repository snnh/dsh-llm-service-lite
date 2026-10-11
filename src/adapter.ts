/**
 * The OWC-style adapter: one instance serving every configured route.
 *
 * A call captures its route's profile before its first await — the endpoint,
 * the credential reference, the protocol, and the model's declared facts all
 * come from one immutable resolution. A configuration change during the call
 * therefore cannot swap the endpoint or the capabilities under a request that
 * already started, which is the same guarantee the seam's per-step call freeze
 * gives every adapter.
 *
 * @module dsh-llm-service-lite/adapter
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmImageRequestPricing,
  LlmModelInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { anthropicRequest } from './anthropic-messages.ts'
import { translateAnthropicStream } from './anthropic-stream.ts'
import { chatRequest, translateChatStream } from './chat-completions.ts'
import { responsesRequest } from './openai-responses.ts'
import { translateResponsesStream } from './responses-stream.ts'
import { imageRequestPricing, prepareRequestImages } from './images.ts'
import { generatedImageBlock, isGeneratedImage, type AdapterChunk } from './image-output.ts'
import { classifyFailure, classifyTransport } from './errors.ts'
import { ConcurrencyLimiter } from './limiter.ts'
import { catalogModels, resolvedModelInfo } from './models.ts'
import { modelOf, type ResolvedOwcModel, type ResolvedOwcProviderProfile } from './profiles.ts'
import { SseReader } from './sse.ts'
import type { ServedInterfaceType } from './config.ts'

/** Timeout code stamped on this adapter's idle watchdog. */
const IDLE_CODE = 'OWC_STREAM_IDLE'

/** One protocol's transport: the request it assembles and the stream it translates. */
interface Transport {
  readonly request: typeof chatRequest
  readonly translate: typeof translateChatStream
}

/** Every protocol this adapter serves, by the name a profile declares. */
const TRANSPORTS: Readonly<Record<ServedInterfaceType, Transport>> = {
  'openai-chat-completions': { request: chatRequest, translate: translateChatStream },
  'anthropic-messages': { request: anthropicRequest, translate: translateAnthropicStream },
  'openai-responses': { request: responsesRequest, translate: translateResponsesStream },
}

/** What the adapter needs from its plugin, all read per operation. */
export interface OwcProfilesAdapterOptions {
  /** Current resolved profiles, by route name. */
  readonly profiles: () => ReadonlyMap<string, ResolvedOwcProviderProfile>
  /** The stable admission limiter for one route. */
  readonly limiter: (provider: string) => ConcurrencyLimiter
  /** Resolve one route's credential, or nothing for an unauthenticated route. */
  readonly resolveApiKey: (profile: ResolvedOwcProviderProfile) => Promise<string | undefined>
  /** The mounted attachment provider, read per request; absent refuses image input. */
  readonly resolveAttachments?: () => AttachmentStore | undefined
}

/** One route's facts, or a refusal naming the route a configuration no longer declares. */
function requireProfile(
  profiles: ReadonlyMap<string, ResolvedOwcProviderProfile>,
  provider: string,
): ResolvedOwcProviderProfile {
  const profile = profiles.get(provider)
  if (profile === undefined) {
    throw new LlmError(
      `llm-service-lite: provider route "${provider}" is not configured`,
      'INVALID_CONFIG',
    )
  }
  return profile
}

/** One adapter instance for every configured provider route. */
export class OwcProfilesAdapter extends LlmAdapter {
  /**
   * @param dependencies - live profile, limiter, and credential resolution.
   */
  constructor(private readonly dependencies: OwcProfilesAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    const profile = this.dependencies.profiles().get(provider)
    return { id: provider, name: profile?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.dependencies.profiles().get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const profile = this.dependencies.profiles().get(provider)
    return Promise.resolve(profile === undefined ? [] : catalogModels(profile))
  }

  /**
   * Price one model's surface images the way its endpoint charges for them.
   *
   * The token meter asks synchronously, so this reads only the resolved profile
   * and the request target the adapter would ask the attachment provider for.
   * A route that declared no accounting answers `undefined`, which keeps the
   * meter's structural heuristic: a price this adapter made up would be worse
   * than an estimate the meter already labels as one.
   */
  override imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined {
    const profile = this.dependencies.profiles().get(provider)
    if (profile === undefined) return undefined
    return imageRequestPricing(modelOf(profile, model))
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // The refusal is a rejection rather than a synchronous throw: a route a
    // configuration no longer declares fails the caller's promise, which is
    // what every other adapter failure looks like on this seam.
    return Promise.resolve().then(() => resolvedModelInfo(requireProfile(this.dependencies.profiles(), provider), model))
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return Promise.resolve().then(() => {
      const profile = requireProfile(this.dependencies.profiles(), provider)
      return {
        model: resolvedModelInfo(profile, model),
        stream: options => this.generate(options, profile),
      }
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.generate(options)
  }

  /**
   * Run one request under its route's admission slot and idle watchdog.
   * The route resolution happens inside the generator, so an unconfigured
   * route surfaces as a stream failure the runtime normalizes rather than as
   * a synchronous throw from `stream()`.
   */
  private async * generate(
    options: GenerateOptions,
    captured?: ResolvedOwcProviderProfile,
  ): AsyncGenerator<StreamChunk> {
    const profile = captured ?? requireProfile(this.dependencies.profiles(), options.provider)
    const consumer = new AbortController()
    const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal])
    using watchdog = idleWatchdog(signal, profile.streamIdleTimeoutMs, IDLE_CODE)
    let iterator: AsyncGenerator<StreamChunk> | undefined
    let lease: Awaited<ReturnType<ConcurrencyLimiter['acquire']>> | undefined
    try {
      lease = await this.dependencies.limiter(profile.provider).acquire(signal)
      iterator = this.request(options, profile, watchdog.signal, () => { watchdog.pulse() })
      while (true) {
        const next = await watchdog.next(iterator)
        if (next.done) return
        yield next.value
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, IDLE_CODE) !== undefined) {
        throw new LlmError(
          `llm-service-lite: provider "${profile.provider}" stream idle timeout`,
          'TIMEOUT',
          { cause: error },
        )
      }
      throw classifyTransport(error, options.signal?.aborted === true)
    } finally {
      lease?.release()
      consumer.abort()
      if (iterator !== undefined) {
        try {
          await iterator.return(undefined)
        } catch (_abortedRequestCleanup) {
          // The request already settled; aborting its reader cannot replace that outcome.
        }
      }
    }
  }

  /** Issue the HTTP request and translate its event stream. */
  private async * request(
    options: GenerateOptions,
    profile: ResolvedOwcProviderProfile,
    signal: AbortSignal,
    activity: () => void,
  ): AsyncGenerator<StreamChunk> {
    signal.throwIfAborted()
    const model = modelOf(profile, options.model)
    const apiKey = await this.dependencies.resolveApiKey(profile)
    // Images are read and sized before the credential is used: an unserviceable
    // image request must fail without the endpoint seeing a partial call.
    const versions = await prepareRequestImages(
      model, options.messages, this.dependencies.resolveAttachments?.(), profile.imageRequestBudget, signal,
    )
    signal.throwIfAborted()
    const transport = TRANSPORTS[profile.interfaceType]
    const request = transport.request(profile, model, options, apiKey, versions)
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal,
      redirect: 'error',
    })
    if (!response.ok) {
      const text = await response.text()
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch (_nonJsonGatewayError) {
        raw = { message: text.slice(0, 2_000) }
      }
      throw classifyFailure(raw, response.status, response.headers)
    }
    if (response.body === null) {
      throw new LlmError(`llm-service-lite: provider "${profile.provider}" returned no response body`, 'EMPTY_RESPONSE')
    }
    const reader = new SseReader(response.body, activity)
    yield* this.materializeImages(model, transport.translate(reader.events(), () => reader.sawDone))
  }

  /**
   * Commit every image the endpoint returned and republish it as a durable
   * block.
   *
   * The wire translators carry bytes, not attachments: this is the one place
   * that knows the route, so it is where a route that never declared image
   * output fails by name, where a deployment without an attachment provider
   * fails rather than losing the picture, and where the session ends up
   * holding a reference instead of base64.
   *
   * @param model - the route's declared facts for this model.
   * @param chunks - the transport's chunk stream.
   * @yields harness chunks, with each generated image replaced by its block.
   */
  private async * materializeImages(
    model: ResolvedOwcModel,
    chunks: AsyncIterable<AdapterChunk>,
  ): AsyncGenerator<StreamChunk> {
    for await (const chunk of chunks) {
      if (!isGeneratedImage(chunk)) {
        yield chunk
        continue
      }
      if (!model.imageOutput) {
        throw new LlmError(
          `llm-service-lite: model "${model.id}" returned an image without declaring image output;`
          + ' declare capabilities.imageOutput on the model so the route states what it serves',
          'UNSUPPORTED_CONTENT',
        )
      }
      const attachments = this.dependencies.resolveAttachments?.()
      if (attachments === undefined) {
        throw new LlmError(
          `llm-service-lite: model "${model.id}" returned an image and no attachment provider is mounted;`
          + ' load @deepseek-ai/dsh-attachment-local (or another provider) to store it',
          'INVALID_CONFIG',
        )
      }
      const [attachment] = await attachments.saveImages([{ data: chunk.data, mediaType: chunk.mediaType }])
      if (attachment === undefined) {
        throw new LlmError(
          `llm-service-lite: the attachment provider returned no reference for an image from "${model.id}"`,
          'EMPTY_RESPONSE',
        )
      }
      yield { type: 'block-end', index: chunk.index, block: generatedImageBlock(attachment) }
    }
  }
}
