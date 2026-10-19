/**
 * The Models page seats' controller: one read model over the
 * `llm-service-lite` settings form, plus the single-provider writes the
 * provider card and the footer's add form perform.
 *
 * The Models page owns its provider rows; this plugin contributes the
 * adapter-family extension seats. Every write here is therefore the minimal
 * path operation that moves one route's profile — never a rebuilt document —
 * and the credential literal continues to travel through the credentials
 * remote instead of the settings section.
 *
 * @module @snnh/dsh-llm-service-lite/client/models-controller
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'
import { providersOf } from './model.ts'
import { providerOps, removeProviderOps } from './provider-ops.ts'
import type { ClientConfig, ClientProvider, DiscoveryOutcome, DiscoveryRequest } from './types.ts'

/** What one settings write settled as. */
export type ModelsWriteOutcome =
  | { readonly kind: 'written' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'refused' }

/** The settings reads the Models page seats render from. */
export interface ServiceLiteSettingsSnapshot {
  /** `ready` while the Host serves this namespace to the browser. */
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** The resolved section value, once accepted. */
  readonly value: ClientConfig | undefined
  /** Composition layer the value resolves over. */
  readonly base: unknown
  /** Raw user layer as stored; presence marks an override. */
  readonly user: unknown
  /** Whether the Host document accepts writes. */
  readonly writable: boolean
  /** Revision the snapshot was read at. */
  readonly revision: number | undefined
}

/** Host operations the seats invoke outside the settings write. */
export interface ServiceLiteModelsHostOperations {
  /** Store one credential literal; resolves to the refusal message. */
  storeCredential: (ref: string, value: string) => Promise<string | undefined>
  /** Ask an endpoint for the models it serves. */
  discover: (request: DiscoveryRequest) => Promise<DiscoveryOutcome>
}

/** Actions and hooks the two Models page seats bind. */
export interface ServiceLiteModelsFace {
  hooks: {
    /** Settings mirror bound by the renderer as useServiceLiteSettings. */
    serviceLiteSettings: SnapshotStore<ServiceLiteSettingsSnapshot>
  }
  /** Apply one edited provider profile. */
  writeProvider: (route: string, draft: ClientProvider, expectedRevision?: number) => Promise<ModelsWriteOutcome>
  /** Drop one user-layer-only route. */
  removeProvider: (route: string, expectedRevision?: number) => Promise<ModelsWriteOutcome>
  /** Declare one new route in the user layer. */
  addProvider: (route: string, provider: ClientProvider, expectedRevision?: number) => Promise<ModelsWriteOutcome>
  /** Store one credential literal for a reference. */
  storeKey: (ref: string, value: string) => Promise<string | undefined>
  /** Ask an endpoint for its models. */
  discover: (request: DiscoveryRequest) => Promise<DiscoveryOutcome>
}

/** The controller behind the Models page's provider card and footer seats. */
export class ServiceLiteModelsController {
  private readonly store: SnapshotStore<ServiceLiteSettingsSnapshot>
  private readonly unsubscribe: () => void
  private disposed = false

  /**
   * @param scope - the bound `llm-service-lite` settings form.
   * @param operations - Host calls made outside the settings write.
   */
  constructor(
    private readonly scope: SettingsFormScope<ClientConfig>,
    private readonly operations: ServiceLiteModelsHostOperations,
  ) {
    this.store = createSnapshotStore(this.project())
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  /** Stop observing settings and suppress late settlements. */
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }

  /** The renderer face for both Models page seats. */
  inject(): ServiceLiteModelsFace {
    return {
      hooks: { serviceLiteSettings: this.store },
      writeProvider: (route, draft, expectedRevision) => this.writeProvider(route, draft, expectedRevision),
      removeProvider: (route, expectedRevision) => this.removeProvider(route, expectedRevision),
      addProvider: (route, provider, expectedRevision) => this.addProvider(route, provider, expectedRevision),
      storeKey: (ref, value) => this.operations.storeCredential(ref, value),
      discover: (request) => this.operations.discover(request),
    }
  }

  private project(): ServiceLiteSettingsSnapshot {
    const snapshot = this.scope.getSnapshot()
    return {
      status: snapshot.status,
      value: snapshot.value,
      base: snapshot.base,
      user: snapshot.user,
      writable: snapshot.writable,
      revision: snapshot.revision,
    }
  }

  private publish(): void {
    if (this.disposed) return
    this.store.update((state) => { Object.assign(state, this.project()) })
  }

  /**
   * Write one provider's profile as path operations against the stored layers.
   * The draft compares against the user layer first, then the composition
   * layer, then the schema default, so an inherited field is never frozen into
   * the user layer by an edit that did not change it.
   * @param route - the route id.
   * @param draft - the edited profile.
   * @param expectedRevision - the revision the draft was seeded from; omitted uses the latest read.
   * @returns how the write settled.
   */
  private async writeProvider(
    route: string,
    draft: ClientProvider,
    expectedRevision?: number,
  ): Promise<ModelsWriteOutcome> {
    const snapshot = this.scope.getSnapshot()
    const ops = providerOps(
      route,
      snapshot.value?.providers[route],
      providersOf(snapshot.base)[route],
      providersOf(snapshot.user)[route],
      draft,
    )
    return this.write(ops, expectedRevision)
  }

  /**
   * Drop a route declared only by the user layer.
   * @param route - the route id.
   * @param expectedRevision - the revision the card was read at.
   * @returns how the write settled.
   */
  private async removeProvider(route: string, expectedRevision?: number): Promise<ModelsWriteOutcome> {
    const snapshot = this.scope.getSnapshot()
    return this.write(removeProviderOps(route, snapshot.base, snapshot.user), expectedRevision)
  }

  /**
   * Declare one new route; the whole profile is written because the schema
   * materializes the defaults it leaves open.
   * @param route - the route id.
   * @param provider - the starting profile.
   * @param expectedRevision - the revision the form was read at.
   * @returns how the write settled.
   */
  private async addProvider(
    route: string,
    provider: ClientProvider,
    expectedRevision?: number,
  ): Promise<ModelsWriteOutcome> {
    const snapshot = this.scope.getSnapshot()
    const ops = providerOps(
      route,
      snapshot.value?.providers[route],
      providersOf(snapshot.base)[route],
      providersOf(snapshot.user)[route],
      provider,
    )
    return this.write(ops, expectedRevision)
  }

  /** Apply one fenced settings write, mapping its settlement onto the seats' vocabulary. */
  private async write(
    ops: Parameters<SettingsFormScope<ClientConfig>['mutate']>[0],
    expectedRevision: number | undefined,
  ): Promise<ModelsWriteOutcome> {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable) return { kind: 'refused' }
    if (ops.length === 0) return { kind: 'written' }
    const revision = expectedRevision ?? snapshot.revision
    const ok = await this.scope.mutate(ops, revision)
    if (ok) return { kind: 'written' }
    const after = this.scope.getSnapshot()
    return after.revision !== revision ? { kind: 'conflict' } : { kind: 'refused' }
  }
}
