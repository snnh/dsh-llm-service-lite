/**
 * OWC-style provider profiles for the DeepSeek Harness LLM seam.
 *
 * One plugin instance owns a dict of provider profiles; every enabled profile
 * registers one route on `ctx.llm`, and the route serves the models its
 * profile declares. This is the shape OpenWebCode gives a provider — a
 * self-contained endpoint plus the catalog it serves — carried onto the
 * harness seam, so a deployment configures providers once, in one place, and a
 * gateway reaches the same code path as a first-party endpoint.
 *
 * The package is also its own bundle: `cordis.patch.yml` inserts the plugin row
 * below, so installing it into a profile mounts it without a hand-written
 * entry. A composition that mounts the row itself — as this example does —
 * declares no bundle layer and uses the row's own `id` and `name`.
 *
 * ```yaml
 * - id: llm-service-lite
 *   name: '@snnh/dsh-llm-service-lite'
 *   config:
 *     providers:
 *       deepseek:
 *         displayName: DeepSeek
 *         interfaceType: openai-chat-completions
 *         baseURL: https://api.deepseek.com/v1
 *         apiKeyEnv: DEEPSEEK_API_KEY
 *         includeUsage: true
 *         models:
 *           - id: deepseek-chat
 *             contextWindow: 131072
 *             maxTokens: 8192
 *             capabilities:
 *               modalities: [text]
 *           - id: deepseek-reasoner
 *             contextWindow: 131072
 *             maxTokens: 65536
 *             capabilities:
 *               modalities: [text]
 *               effort: [low, medium, high]
 *               thinking: [enabled, disabled]
 *               reasoningContent: true
 * ```
 *
 * @module @snnh/dsh-llm-service-lite
 */

import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'

import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { OwcProfilesAdapter } from './adapter.ts'
import { Config, type Options } from './config.ts'
import { discoverEndpointModels } from './discovery.ts'
import { declaredDefaultsOf, type ModelDefaultsSeam } from './model-defaults.ts'
import { ConcurrencyLimiter } from './limiter.ts'
import {
  assertServiceable,
  registrationFacts,
  resolveProfiles,
  serviceableRoutes,
  type ResolvedOwcProviderProfile,
} from './profiles.ts'

export { OwcProfilesAdapter } from './adapter.ts'
export type { OwcProfilesAdapterOptions } from './adapter.ts'
export { Config } from './config.ts'
export type {
  EffortLevel,
  InterfaceType,
  Modality,
  Options,
  OwcModelCapabilities,
  OwcModelProfile,
  OwcProviderProfile,
  ThinkingMode,
  ThinkingStyle,
} from './config.ts'
export { ConcurrencyLimiter } from './limiter.ts'
export type { Lease } from './limiter.ts'
export { resolveProfiles, modelOf } from './profiles.ts'
export type { ResolvedOwcModel, ResolvedOwcProviderProfile } from './profiles.ts'
export { convertOfficialProvider } from './official-catalog.ts'
export type { OfficialCatalogConversion, OfficialCatalogProfile } from './official-catalog.ts'
export { discoverEndpointModels } from './discovery.ts'

/**
 * Plugin name, and the settings namespace this instance owns when its mounting
 * row declares the same id — which `cordis.patch.yml` does.
 */
export const name = 'llm-service-lite'

/** The LLM service this plugin registers provider routes on. */
export const inject = ['llm']

const NS = 'llm-service-lite'

/**
 * Register every configured provider profile as a route on the LLM service.
 * @param ctx - plugin lifetime with the LLM registry injected.
 * @param config - the `providers` dict of profiles.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const settingsNs = ctx.fiber.entry?.options.id ?? NS
  // The raw snapshot type comes from the schema, not the interface: the
  // configuration object the loader hands over is deeply readonly, and the
  // interface describes what a caller may write.
  let lastRaw: ReturnType<Config['providers']['get']> | undefined
  let memoized: ReadonlyMap<string, ResolvedOwcProviderProfile> | undefined
  /** Resolved profiles for the current configuration, memoized by raw snapshot identity. */
  const profiles = (): ReadonlyMap<string, ResolvedOwcProviderProfile> => {
    const raw = config.providers.get()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveProfiles(structuredClone(raw) as Options['providers'], 'deferred')
    lastRaw = raw
    memoized = next
    return next
  }
  profiles()
  ctx.on('internal/config', function (this: import('@deepseek-ai/cordis').Fiber, _raw, next) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    const candidate = Config(raw as Options)
    assertServiceable(
      { providers: structuredClone(candidate.providers.get()) } as Options,
      { providers: structuredClone(config.providers.get()) } as Options,
    )
    return raw
  })

  /**
   * Resolve one route's credential. A profile that names no credential at all
   * is deliberately unauthenticated — some gateways in front of a local model
   * want no key — while a named reference that resolves to nothing fails the
   * request, because silently sending it unauthenticated would bill or blame
   * the wrong tenant.
   */
  const resolveApiKey = async (profile: ResolvedOwcProviderProfile): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv
    if (ref === undefined) return profile.apiKey
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, name, ref)
    throw new LlmError(
      `llm-service-lite: no credential for provider route "${profile.provider}"; its profile resolves ${ref},`
      + ` which is not set — store ${ref} through the credentials service or export it`,
      'MISSING_CREDENTIAL',
    )
  }

  /**
   * One limiter per route, rebuilt only when its concurrency changes: a
   * limiter carries the queue of requests already waiting, so reusing it
   * across unrelated configuration edits is what keeps a queue from being
   * silently dropped.
   */
  const limiters = new Map<string, { maxConcurrent: number; limiter: ConcurrencyLimiter }>()
  const limiterFor = (provider: string): ConcurrencyLimiter => {
    const profile = profiles().get(provider)
    const maxConcurrent = profile?.maxConcurrent ?? 1
    const current = limiters.get(provider)
    if (current !== undefined && current.maxConcurrent === maxConcurrent) return current.limiter
    const limiter = new ConcurrencyLimiter(maxConcurrent)
    limiters.set(provider, { maxConcurrent, limiter })
    return limiter
  }

  const adapter = new OwcProfilesAdapter({
    profiles,
    limiter: limiterFor,
    resolveApiKey,
    // The attachment provider arrives with the profile that needs it; a
    // deployment serving text-only routes never mounts one.
    resolveAttachments: () => ctx.get('attachments'),
  })
  let directory: DirectoryRegistrationHandle | undefined
  let registeredDirectory: unknown
  let reportedCatalogDiagnostics: unknown
  /**
   * Report what a catalog conversion could not carry, once per distinct set.
   * The route still serves; these lines are what keeps a lossy conversion from
   * looking whole.
   */
  const reportCatalogDiagnostics = (): void => {
    const notes = [...profiles().values()].flatMap(profile => profile.catalogDiagnostics)
    if (deepEqualJson(notes, reportedCatalogDiagnostics)) return
    reportedCatalogDiagnostics = notes
    for (const note of notes) ctx.logger.warn('%s', note)
  }
  const ensureDirectory = (): void => {
    reportCatalogDiagnostics()
    const entries: LlmConfigurableProvider[] = [...profiles().values()].map(profile => ({
      provider: profile.provider,
      displayName: profile.displayName,
      settingsNs,
      settingsPath: ['providers', profile.provider],
      // Every route here is declared by this configuration; none comes from an
      // installed catalog, so all of them are editable through their profile.
      declared: true,
      ...profile.diagnostic === undefined ? {} : { error: profile.diagnostic },
    }))
    if (deepEqualJson(entries, registeredDirectory)) return
    if (entries.length === 0) {
      // An empty directory is not a registration: the registry refuses one,
      // so withdrawing the previous entries is what leaves no stale address.
      directory?.()
      directory = undefined
      registeredDirectory = entries
      return
    }
    if (directory === undefined) directory = ctx.llm.registerConfigurableProviders(entries)
    else directory.replace(entries)
    registeredDirectory = entries
  }
  ensureDirectory()

  // A configuration surface asks what this adapter would declare about the ids
  // it is editing; the answer is profile vocabulary, so the surface can write
  // it into the user's document and the user can edit it there. The seam is an
  // addition of the dsh-lite harness: an upstream harness carries no such
  // remote, and this adapter then keeps its table to the request path, where
  // the same defaults still fill the fields a profile left open.
  const defaultsSeam = ctx.llm as typeof ctx.llm & ModelDefaultsSeam
  defaultsSeam.registerModelDefaults?.(settingsNs, request => Promise.resolve(
    request.models.flatMap((id) => {
      const declared = declaredDefaultsOf(id, request.api)
      return declared === undefined ? [] : [declared]
    })))

  ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => {
    const stored = request.provider === undefined ? undefined : profiles().get(request.provider)
    const baseURL = stored?.baseURL ?? request.baseURL
    if (baseURL === undefined) {
      throw new LlmError('llm-service-lite: model discovery needs a baseURL', 'INVALID_CONFIG')
    }
    const apiKey = request.apiKey ?? (stored === undefined ? undefined : stored.apiKey)
    if (request.apiKey !== undefined || stored === undefined) return discoverEndpointModels(baseURL, apiKey, signal)
    return resolveApiKey(stored).then(resolved => discoverEndpointModels(baseURL, resolved, signal))
  })

  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistration = (): void => {
    const facts = registrationFacts(profiles())
    if (deepEqualJson(facts, registeredFacts)) return
    const routes = serviceableRoutes(profiles())
    if (registration === undefined) {
      // A dormant bare mount: the registry refuses an empty route set, so
      // nothing registers until a profile supplies one.
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      // An empty replacement withdraws every route while keeping the handle,
      // which is what lets a later profile re-register without a new mount.
      registration.replace(routes)
    }
    registeredFacts = facts
  }
  ensureRegistration()

  ctx.on('loader/volatile-update', () => {
    try {
      ensureRegistration()
      ensureDirectory()
    } catch (error) {
      ctx.logger.error('llm-service-lite: configuration conflicts with an existing provider route')
      ctx.logger.error(error)
    }
  })
}
