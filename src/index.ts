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
 *       deepseek-direct:
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
import { Config, type Options, type OwcProviderProfile } from './config.ts'
import { discoverEndpointModels, type DiscoverEndpointModelsOptions } from './discovery.ts'
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
export {
  DISCOVERY_MAX_RESPONSE_BYTES,
  discoverEndpointModels,
  LISTABLE_INTERFACE_TYPES,
} from './discovery.ts'
export type { DiscoverEndpointModelsOptions } from './discovery.ts'

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
    const next = resolveProfiles(
      structuredClone(raw) as Readonly<Record<string, OwcProviderProfile>>,
      'deferred',
    )
    lastRaw = raw
    memoized = next
    return next
  }
  profiles()

  /** Route names this instance currently owns, tracked across registration swaps. */
  const ownRoutes = new Set<string>()
  /**
   * Provider names another mounted adapter family currently owns, mapped to a
   * label for the owner. A route or directory entry belongs to another family
   * when it comes from a different settings namespace, or when it is registered
   * by an adapter other than this one: both registries are keyed globally by
   * the route name, so a second claim on one name is refused.
   */
  const foreignClaims = (): ReadonlyMap<string, string> => {
    const claims = new Map<string, string>()
    for (const entry of ctx.llm.listConfigurableProviders()) {
      if (entry.settingsNs === settingsNs) continue
      claims.set(entry.provider, `the "${entry.settingsNs}" configuration namespace`)
    }
    for (const provider of ctx.llm.listProviders()) {
      if (claims.has(provider.id) || ownRoutes.has(provider.id)) continue
      claims.set(provider.id, 'another mounted adapter')
    }
    return claims
  }
  /**
   * A stable signature of the foreign claims: the topology listener compares it
   * against the last reconciled snapshot so this instance's own commits (which
   * fire the same event) cannot re-enter the reconcile in a loop.
   */
  const claimSignature = (claims: ReadonlyMap<string, string>): string =>
    [...claims].map(([provider, owner]) => `${provider}\u0000${owner}`).sort().join('\u0001')

  ctx.on('internal/config', function (this: import('@deepseek-ai/cordis').Fiber, _raw, next) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    const candidate = Config(raw as Options)
    const previousProviders = structuredClone(config.providers.get()) as Readonly<Record<string, OwcProviderProfile>>
    assertServiceable(
      { providers: structuredClone(candidate.providers.get()) } as Options,
      { providers: previousProviders } as Options,
    )
    // A route name another adapter family already owns can never be mounted by
    // this instance — both registries refuse a second claim — so refusing the
    // write here keeps a document that cannot load out of the profile. Existing
    // entries are exempt: a profile stored before this guard existed must stay
    // editable, and renaming its route is the repair.
    const claims = foreignClaims()
    const existing = new Set(Object.keys(previousProviders))
    for (const provider of Object.keys(structuredClone(candidate.providers.get()))) {
      if (existing.has(provider)) continue
      const owner = claims.get(provider)
      if (owner !== undefined) {
        throw new Error(
          `llm-service-lite: provider route "${provider}" is already declared by ${owner};`
          + ' choose a different route name',
        )
      }
    }
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
   * One admission limiter per route. The limiter is re-tuned in place rather
   * than replaced: it carries the FIFO queue of requests already waiting, so
   * rebuilding it would split that queue across two instances and let the old
   * and new ceilings admit at the same time.
   */
  const limiters = new Map<string, ConcurrencyLimiter>()
  const limiterFor = (provider: string): ConcurrencyLimiter => {
    const maxConcurrent = profiles().get(provider)?.maxConcurrent ?? 1
    const current = limiters.get(provider)
    if (current !== undefined) {
      current.setMaxConcurrent(maxConcurrent)
      return current
    }
    const limiter = new ConcurrencyLimiter(maxConcurrent)
    limiters.set(provider, limiter)
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
  let reportedConflicts: unknown
  /**
   * Report what a catalog conversion could not carry, once per distinct set.
   * The route still serves; these lines are what keeps a lossy conversion from
   * looking whole.
   */
  const reportCatalogDiagnostics = (): void => {
    const notes = [...profiles().values()].flatMap(profile => profile.catalogDiagnostics)
    if (deepEqualJson(notes, reportedCatalogDiagnostics)) return
    reportedCatalogDiagnostics = notes
    for (const note of notes) ctx.logger.warn(note)
  }
  /**
   * Report one actionable warning per route name another adapter family owns,
   * once per distinct conflict set. The profile is skipped, not mounted: one
   * collision must not abort the whole mount, because a stock upstream profile
   * always mounts `llm-pi-ai`, whose shipped catalog declares common route
   * names such as `deepseek` and `openai`. Renaming the route is the fix, and a
   * later topology change re-attempts the profile (see the listener below).
   */
  const reportConflicts = (claims: ReadonlyMap<string, string>): void => {
    const conflicts = [...profiles().values()]
      .filter(profile => claims.has(profile.provider))
      .map(profile => ({ provider: profile.provider, owner: claims.get(profile.provider) as string }))
      .sort((left, right) => left.provider.localeCompare(right.provider))
    if (deepEqualJson(conflicts, reportedConflicts)) return
    reportedConflicts = conflicts
    for (const conflict of conflicts) {
      ctx.logger.warn(
        `llm-service-lite: provider route "${conflict.provider}" is already declared by ${conflict.owner};`
        + ' this profile is skipped — rename its route to mount it',
      )
    }
  }
  const ensureDirectory = (claims: ReadonlyMap<string, string>): void => {
    const entries: LlmConfigurableProvider[] = [...profiles().values()]
      .filter(profile => !claims.has(profile.provider))
      .map(profile => ({
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
    // The draft wins over the stored profile: a surface interrogates what the
    // user is editing, and the stored profile supplies only what a draft cannot
    // state — the protocol fallback, the route's configured headers, and the
    // stored credential.
    const baseURL = request.baseURL ?? stored?.baseURL
    if (baseURL === undefined) {
      throw new LlmError('llm-service-lite: model discovery needs a baseURL', 'INVALID_CONFIG')
    }
    const api = request.api ?? stored?.interfaceType
    const options: DiscoverEndpointModelsOptions = {
      ...api === undefined ? {} : { api },
      ...stored === undefined ? {} : { headers: stored.headers },
    }
    const discover = (apiKey: string | undefined): ReturnType<typeof discoverEndpointModels> =>
      discoverEndpointModels(baseURL, apiKey, signal, options)
    if (request.apiKey !== undefined) {
      // A one-shot key wins over the stored credential, and it is validated here
      // so a pasted value with surrounding whitespace never reaches a header.
      return discover(assertUsableApiKey(request.apiKey, name, 'request.apiKey'))
    }
    if (stored === undefined) return discover(undefined)
    return resolveApiKey(stored).then(discover)
  })

  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistration = (claims: ReadonlyMap<string, string>): void => {
    // The mountable route set is part of the compared facts: a name freed or
    // taken by its foreign owner changes what this instance can mount even when
    // no profile field changed. The compared set is order-insensitive, and its
    // registration facts cover only mounted profiles, so reordering the dict or
    // editing a skipped profile replaces nothing.
    const routes = serviceableRoutes(profiles()).filter(provider => !claims.has(provider))
    const mounted = new Map<string, ResolvedOwcProviderProfile>()
    for (const provider of routes) {
      const profile = profiles().get(provider)
      if (profile !== undefined) mounted.set(provider, profile)
    }
    const facts = { routes: [...routes].sort(), registration: registrationFacts(mounted) }
    if (deepEqualJson(facts, registeredFacts)) return
    const previousOwnRoutes = new Set(ownRoutes)
    ownRoutes.clear()
    for (const provider of routes) ownRoutes.add(provider)
    try {
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
    } catch (error) {
      ownRoutes.clear()
      for (const provider of previousOwnRoutes) ownRoutes.add(provider)
      throw error
    }
    registeredFacts = facts
  }

  /** A registry refusal that a foreign adapter claiming a name after the claims snapshot explains. */
  const isRegistrationConflict = (error: unknown): boolean =>
    error instanceof LlmError && (error.code === 'DUPLICATE_DIRECTORY' || error.code === 'DUPLICATE_ADAPTER')

  /** The foreign-claims snapshot the last reconcile observed; '' until the first pass. */
  let observedClaims = ''
  /**
   * Reconcile the configurable-provider directory and this instance's routes
   * with the current configuration and with the names other mounted adapters
   * own. Idempotent: a pass that changes nothing commits nothing.
   */
  const reconcile = (): void => {
    let retried = false
    for (;;) {
      const claims = foreignClaims()
      observedClaims = claimSignature(claims)
      try {
        reportCatalogDiagnostics()
        reportConflicts(claims)
        ensureDirectory(claims)
        ensureRegistration(claims)
        return
      } catch (error) {
        // A sibling may claim a name between the claims snapshot and our
        // registry commit; one retry against a fresh snapshot keeps that race
        // from aborting the mount.
        if (retried || !isRegistrationConflict(error)) throw error
        retried = true
      }
    }
  }

  let syncing = false
  let resyncQueued = false
  /** Run a full reconcile, coalescing a request that arrives while one is in flight. */
  const sync = (): void => {
    if (syncing) {
      resyncQueued = true
      return
    }
    syncing = true
    try {
      let passes = 0
      do {
        resyncQueued = false
        reconcile()
        passes += 1
      } while (resyncQueued && passes < 4)
    } finally {
      syncing = false
    }
  }

  sync()

  // Topology is the only signal that another adapter family claimed or dropped
  // a route name, and a dropped name is exactly when a skipped profile becomes
  // mountable. The claim signature keeps this instance's own commits (which
  // fire the same event) from re-entering the reconcile.
  ctx.on('llm/adapters-updated', () => {
    try {
      if (claimSignature(foreignClaims()) === observedClaims) return
      sync()
    } catch (error) {
      ctx.logger.error('llm-service-lite: reconciling with the provider registry failed')
      ctx.logger.error(error)
    }
  })

  ctx.on('loader/volatile-update', () => {
    try {
      sync()
    } catch (error) {
      ctx.logger.error('llm-service-lite: configuration conflicts with an existing provider route')
      ctx.logger.error(error)
    }
  })
}
