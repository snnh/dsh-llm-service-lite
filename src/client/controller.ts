/**
 * The provider-configuration page's controller: one staged draft over the
 * `llm-service-lite` settings section, the derived validation findings, and
 * the write the save control performs.
 *
 * Only a save writes. The draft is seeded from the Host's accepted value, every
 * edit stages detachably, and the save sends the minimal path operations that
 * move the stored user layer from what the page read to what it shows — so a
 * profile declared in a `cordis.patch.yml` layer stays inherited where the
 * person did not override it.
 *
 * @module @snnh/dsh-llm-service-lite/client/controller
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormPathOp, SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  EDITABLE_PROVIDER_FIELDS,
  cleanConfig,
  sameConfig,
  validateConfig,
} from './model.ts'
import { emptyConfig } from './types.ts'
import {
  type ClientConfig,
  type ClientProvider,
  type DiscoveryOutcome,
  type DiscoveryRequest,
  type ProfileProblem,
  type ServiceLitePageFace,
  type ServiceLitePageSnapshot,
} from './types.ts'

/** Host operations the page invokes outside the settings write. */
export interface ServiceLiteHostOperations {
  /** Store one credential literal; resolves to the refusal message. */
  storeCredential: (ref: string, value: string) => Promise<string | undefined>
  /** Ask an endpoint for the models it serves. */
  discover: (request: DiscoveryRequest) => Promise<DiscoveryOutcome>
}

/** The snapshot one settings read reports. */
interface ConfigSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: ClientConfig | undefined
  readonly base: unknown
  readonly user: unknown
  readonly writable: boolean
  readonly revision: number | undefined
}

/** Fields whose resolved-section default equals "not stated"; a saved value equal to it needs no user-layer entry. */
const FIELD_DEFAULTS: Readonly<Record<string, unknown>> = {
  enabled: true,
  promptCaching: false,
  includeUsage: false,
  maxConcurrent: 3,
  streamIdleTimeoutMs: 300_000,
  defaultContextWindow: 256_000,
  defaultMaxTokens: 65_536,
}

/** Read a providers dict out of one unknown layer, when it is one. */
function providersOf(layer: unknown): Record<string, ClientProvider> {
  if (typeof layer !== 'object' || layer === null) return {}
  const providers = (layer as { providers?: unknown }).providers
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return {}
  return providers as Record<string, ClientProvider>
}

/** Strip the empty placeholders a form leaves for one provider field. */
function storedField(field: string, value: unknown): unknown {
  if (value === undefined || value === '' ) return undefined
  if (Array.isArray(value) && value.length === 0) return undefined
  if (typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === 0) return undefined
  if (field === 'models') {
    const cleaned = cleanConfig({ providers: { route: { models: value } as ClientProvider } })
      .providers['route']?.models
    return cleaned
  }
  return value
}

/**
 * The minimal path operations moving the stored user layer from what the page
 * read to what it stages.
 *
 * The comparison is against the USER layer, not the resolved value: a field
 * the person never touched already stores what it stored, so it needs no
 * operation at all. A field a person clears falls back to the composition
 * layer (`cordis.patch.yml`) when that layer states it, and a field the page
 * never shows (headers, extraBody, catalog, ...) is left exactly as stored.
 * @param current - resolved section value the draft was seeded from.
 * @param base - composition layer under the user layer.
 * @param user - raw user layer, whose presence marks what is already stored.
 * @param draft - the staged document.
 * @returns ordered path operations; empty when the draft stores what is stored.
 */
export function diffConfigOps(
  current: ClientConfig,
  base: unknown,
  user: unknown,
  draft: ClientConfig,
): SettingsFormPathOp[] {
  const ops: SettingsFormPathOp[] = []
  const baseProviders = providersOf(base)
  const userProviders = providersOf(user)
  const routes = new Set([...Object.keys(current.providers), ...Object.keys(draft.providers)])
  for (const route of routes) {
    const next = draft.providers[route]
    const baseProfile = baseProviders[route]
    const userProfile = userProviders[route]
    if (next === undefined) {
      // Only a user-layer entry can be removed from here; a profile the
      // composition declares stays until the patch that declares it changes.
      if (userProfile !== undefined) ops.push({ op: 'unset', path: ['providers', route] })
      continue
    }
    if (current.providers[route] === undefined) {
      // A newly declared route is written whole; the schema fills its defaults.
      const cleaned = cleanConfig({ providers: { [route]: next } }).providers[route]
      if (cleaned !== undefined) ops.push({ op: 'set', path: ['providers', route], value: cleaned })
      continue
    }
    for (const field of EDITABLE_PROVIDER_FIELDS) {
      const nextValue = storedField(field, next[field])
      const baseValue = storedField(field, baseProfile?.[field])
      const userValue = storedField(field, userProfile?.[field])
      if (nextValue === undefined) {
        if (userValue !== undefined) ops.push({ op: 'unset', path: ['providers', route, field] })
        continue
      }
      // A field the draft puts back to the composition value drops any
      // redundant user-layer entry, even when that entry already holds it.
      if (baseValue !== undefined && sameConfig(nextValue, baseValue)) {
        if (userValue !== undefined) ops.push({ op: 'unset', path: ['providers', route, field] })
        continue
      }
      if (sameConfig(nextValue, userValue)) continue
      // A composition-layer value differs from the draft, so the user layer has
      // to override it; otherwise a value equal to the schema default with
      // nothing beneath it needs no user-layer entry.
      if (baseValue !== undefined) {
        ops.push({ op: 'set', path: ['providers', route, field], value: nextValue })
        continue
      }
      if (userValue !== undefined || !sameConfig(nextValue, FIELD_DEFAULTS[field])) {
        ops.push({ op: 'set', path: ['providers', route, field], value: nextValue })
      }
    }
  }
  return ops
}

/** The controller behind the Plugins page row configuration. */
export class ServiceLitePageController {
  private draft: ClientConfig | undefined
  private draftRevision: number | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private disposed = false
  private saveGeneration = 0
  private readonly store: SnapshotStore<ServiceLitePageSnapshot>
  private readonly unsubscribe: () => void

  /**
   * @param scope - the bound `llm-service-lite` settings form.
   * @param operations - Host calls made outside the settings write.
   */
  constructor(
    private readonly scope: SettingsFormScope<ClientConfig>,
    private readonly operations: ServiceLiteHostOperations,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      const snapshot = this.snapshot()
      if (!this.saving && this.draft !== undefined && snapshot.revision !== this.draftRevision) {
        if (snapshot.value !== undefined && sameConfig(snapshot.value, this.draft)) {
          this.draft = undefined
          this.draftRevision = undefined
          this.conflicted = false
        } else {
          this.conflicted = true
        }
      }
      this.publish()
    })
  }

  /** Stop observing settings and suppress late settlements. */
  dispose(): void {
    this.disposed = true
    this.saveGeneration += 1
    this.unsubscribe()
  }

  /** The renderer face for this page. */
  inject(): ServiceLitePageFace {
    return {
      hooks: { serviceLitePage: this.store },
      edit: (update) => { this.edit(update) },
      save: () => { void this.save() },
      discard: () => { this.discard() },
      storeKey: (ref, value) => this.operations.storeCredential(ref, value),
      discover: (request) => this.operations.discover(request),
    }
  }

  private snapshot(): ConfigSnapshot {
    return this.scope.getSnapshot() as ConfigSnapshot
  }

  private current(): ClientConfig {
    return this.snapshot().value ?? emptyConfig()
  }

  private staged(): ClientConfig {
    this.draft ??= structuredClone(this.current())
    this.draftRevision ??= this.snapshot().revision
    return this.draft
  }

  private edit(update: (draft: ClientConfig) => ClientConfig): void {
    const snapshot = this.snapshot()
    if (this.disposed || !snapshot.writable || this.saving) return
    // Staging needs a value to stage over: seeding from a form that has not
    // loaded yet would freeze the page on a draft the Host never sent.
    if (snapshot.value === undefined) return
    this.failed = false
    this.draft = update(structuredClone(this.staged()))
    this.publish()
  }

  private discard(): void {
    if (this.saving) return
    this.draft = undefined
    this.draftRevision = undefined
    this.conflicted = false
    this.failed = false
    this.publish()
  }

  private async save(): Promise<void> {
    const snapshot = this.snapshot()
    if (this.disposed || this.draft === undefined || !snapshot.writable || this.saving) return
    if (this.conflicted) return
    const draft = this.draft
    const problems = validateConfig(draft)
    if (problems.length > 0) {
      this.publish()
      return
    }
    if (snapshot.revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return
    }
    const generation = ++this.saveGeneration
    this.saving = true
    this.failed = false
    this.publish()
    const ops = diffConfigOps(this.current(), snapshot.base, snapshot.user, draft)
    try {
      if (ops.length === 0) {
        this.draft = undefined
        this.draftRevision = undefined
        return
      }
      const ok = await this.scope.mutate(ops, this.draftRevision)
      if (this.disposed || generation !== this.saveGeneration) return
      if (ok) {
        this.draft = undefined
        this.draftRevision = undefined
        this.conflicted = false
      } else {
        const after = this.snapshot()
        this.failed = true
        this.conflicted = after.revision !== this.draftRevision
      }
    } finally {
      if (!this.disposed && generation === this.saveGeneration) {
        this.saving = false
        this.publish()
      }
    }
  }

  private projection(): ServiceLitePageSnapshot {
    const snapshot = this.snapshot()
    const draft = this.draft ?? snapshot.value ?? emptyConfig()
    const problems: readonly ProfileProblem[] = validateConfig(draft)
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.draft !== undefined && !sameConfig(this.draft, snapshot.value),
      invalid: problems.length > 0,
      saving: this.saving,
      failed: this.failed,
      draft,
      problems,
      conflicted: this.conflicted,
    }
  }

  private publish(): void {
    if (this.disposed) return
    this.store.update((state) => { Object.assign(state, this.projection()) })
  }
}
