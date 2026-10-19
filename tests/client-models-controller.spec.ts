/**
 * The Models page seats' controller: the settings mirror the provider card and
 * the footer render from, and the single-provider writes — minimal path
 * operations fenced by the revision the card was read at, with the conflict,
 * refusal, and no-op settlements the seats report.
 */
import { describe, expect, it, vi } from 'vitest'

/*
 * The published `@deepseek-ai/dsh-client-store` runtime imports zustand and
 * immer, which its manifest does not declare and this Node test installation
 * therefore lacks; the browser bundle receives that module from the harness
 * module table instead. The controller only needs a snapshot store, so stand in
 * the same read/update contract rather than installing browser-only packages.
 */
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: <T>(init: T) => {
    let state = init
    const listeners = new Set<() => void>()
    const notify = (): void => { for (const listener of [...listeners]) listener() }
    return {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      update: (mutator: (draft: T) => void) => {
        const draft = structuredClone(state)
        mutator(draft)
        state = draft
        notify()
      },
      set: (next: T) => {
        state = next
        notify()
      },
    }
  },
}))

import type {
  SettingsFormPathOp,
  SettingsFormScope,
  SettingsFormScopeSnapshot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ServiceLiteModelsController,
  type ServiceLiteModelsHostOperations,
  type ServiceLiteSettingsSnapshot,
} from '../src/client/models-controller.ts'
import type { ClientConfig, ClientProvider } from '../src/client/types.ts'

/** One provider profile with a protocol so drafts differ only where a test says so. */
function profile(overrides: ClientProvider = {}): ClientProvider {
  return { interfaceType: 'openai-chat-completions', ...overrides }
}

/** A ready settings read over the given layers. */
function settings(
  overrides: Partial<SettingsFormScopeSnapshot<ClientConfig>> = {},
): SettingsFormScopeSnapshot<ClientConfig> {
  return {
    status: 'ready',
    value: { providers: {} },
    base: undefined,
    user: undefined,
    writable: true,
    revision: 1,
    ...overrides,
  }
}

/** A scripted settings form scope recording every write it is handed. */
function makeScope(initial: SettingsFormScopeSnapshot<ClientConfig>): {
  readonly scope: SettingsFormScope<ClientConfig>
  readonly calls: { ops: SettingsFormPathOp[]; revision: number | undefined }[]
  setSnapshot: (next: SettingsFormScopeSnapshot<ClientConfig>) => void
  reply: (result: boolean, after?: SettingsFormScopeSnapshot<ClientConfig>) => void
} {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const calls: { ops: SettingsFormPathOp[]; revision: number | undefined }[] = []
  let result: boolean = true
  const notify = (): void => { for (const listener of [...listeners]) listener() }
  const scope: SettingsFormScope<ClientConfig> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate: async (ops, revision) => {
      calls.push({ ops: structuredClone([...ops]), revision })
      if (after !== undefined) { snapshot = after; notify() }
      return result
    },
  }
  let after: SettingsFormScopeSnapshot<ClientConfig> | undefined
  return {
    scope,
    calls,
    setSnapshot: (next) => {
      snapshot = next
      notify()
    },
    reply: (next, afterSnapshot) => {
      result = next
      after = afterSnapshot
    },
  }
}

const NO_HOST_SIDE_EFFECTS: ServiceLiteModelsHostOperations = {
  storeCredential: async () => undefined,
  discover: async () => ({ kind: 'found', models: [] }),
}

describe('ServiceLiteModelsController', () => {
  it('projects the settings scope into the store the seats render from', () => {
    const value: ClientConfig = { providers: { alpha: profile() } }
    const harness = makeScope(settings({ value, revision: 7 }))
    const controller = new ServiceLiteModelsController(harness.scope, NO_HOST_SIDE_EFFECTS)
    expect(controller.inject().hooks.serviceLiteSettings.getSnapshot()).toEqual<ServiceLiteSettingsSnapshot>({
      status: 'ready',
      value,
      base: undefined,
      user: undefined,
      writable: true,
      revision: 7,
    })
    controller.dispose()
  })

  it('republishes the projection after a pushed settings change', () => {
    const harness = makeScope(settings())
    const controller = new ServiceLiteModelsController(harness.scope, NO_HOST_SIDE_EFFECTS)
    const store = controller.inject().hooks.serviceLiteSettings
    const seen: ServiceLiteSettingsSnapshot[] = []
    store.subscribe(() => { seen.push(store.getSnapshot()) })
    harness.setSnapshot(settings({ value: { providers: { beta: profile() } }, revision: 2 }))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.revision).toBe(2)
    expect(seen[0]!.value?.providers['beta']).toEqual(profile())
    controller.dispose()
  })

  it('writes one provider as the minimal path operation with the latest revision', async () => {
    const base = profile({ baseURL: 'https://base.example.com/v1' })
    const harness = makeScope(settings({
      value: { providers: { alpha: base } },
      base: { providers: { alpha: base } },
      revision: 5,
    }))
    const controller = new ServiceLiteModelsController(harness.scope, NO_HOST_SIDE_EFFECTS)
    const outcome = await controller.inject().writeProvider('alpha', profile({
      baseURL: 'https://draft.example.com/v1',
    }))
    expect(outcome).toEqual({ kind: 'written' })
    expect(harness.calls).toEqual([{
      ops: [{ op: 'set', path: ['providers', 'alpha', 'baseURL'], value: 'https://draft.example.com/v1' }],
      revision: 5,
    }])
    controller.dispose()
  })

  it('fences the write with the revision the card was read at', async () => {
    const harness = makeScope(settings({ revision: 9, value: { providers: { alpha: profile() } } }))
    const controller = new ServiceLiteModelsController(harness.scope, NO_HOST_SIDE_EFFECTS)
    await controller.inject().writeProvider('alpha', profile({ displayName: 'Gateway' }), 3)
    expect(harness.calls[0]!.revision).toBe(3)
    controller.dispose()
  })

  it('reports a conflict when the refused write was fenced by a stale revision', async () => {
    const harness = makeScope(settings({ revision: 4 }))
    const controller = new ServiceLiteModelsController(harness.scope, NO_HOST_SIDE_EFFECTS)
    harness.reply(false, settings({ revision: 5 }))
    const outcome = await controller.inject().writeProvider('alpha', profile({ displayName: 'Gateway' }), 4)
    expect(outcome).toEqual({ kind: 'conflict' })
    controller.dispose()
  })

  it('reports a refusal when the write failed at the current revision', async () => {
    const harness = makeScope(settings({ revision: 4 }))
    const controller = new ServiceLiteModelsController(harness.scope, NO_HOST_SIDE_EFFECTS)
    harness.reply(false, settings({ revision: 4 }))
    const outcome = await controller.inject().writeProvider('alpha', profile({ displayName: 'Gateway' }))
    expect(outcome).toEqual({ kind: 'refused' })
    controller.dispose()
  })

  it('refuses to write while the settings document is read-only', async () => {
    const harness = makeScope(settings({ writable: false }))
    const controller = new ServiceLiteModelsController(harness.scope, NO_HOST_SIDE_EFFECTS)
    expect(await controller.inject().writeProvider('alpha', profile())).toEqual({ kind: 'refused' })
    expect(harness.calls).toEqual([])
    controller.dispose()
  })

  it('treats an unchanged profile as written without a settings mutation', async () => {
    const base = profile({ baseURL: 'https://base.example.com/v1' })
    const harness = makeScope(settings({
      value: { providers: { alpha: base } },
      base: { providers: { alpha: base } },
    }))
    const controller = new ServiceLiteModelsController(harness.scope, NO_HOST_SIDE_EFFECTS)
    expect(await controller.inject().writeProvider('alpha', structuredClone(base))).toEqual({ kind: 'written' })
    expect(harness.calls).toEqual([])
    controller.dispose()
  })

  it('declares a new route as one whole-profile operation', async () => {
    const harness = makeScope(settings({ revision: 2 }))
    const controller = new ServiceLiteModelsController(harness.scope, NO_HOST_SIDE_EFFECTS)
    const outcome = await controller.inject().addProvider('gamma', profile({
      displayName: 'Gamma',
      models: [{ id: 'gamma-chat' }],
    }))
    expect(outcome).toEqual({ kind: 'written' })
    expect(harness.calls[0]!.ops).toEqual([{
      op: 'set',
      path: ['providers', 'gamma'],
      value: {
        interfaceType: 'openai-chat-completions',
        displayName: 'Gamma',
        models: [{ id: 'gamma-chat' }],
      },
    }])
    controller.dispose()
  })

  it('removes a user-layer-only route with one unset', async () => {
    const user = { providers: { alpha: profile() } }
    const harness = makeScope(settings({ value: { providers: { alpha: profile() } }, user }))
    const controller = new ServiceLiteModelsController(harness.scope, NO_HOST_SIDE_EFFECTS)
    expect(await controller.inject().removeProvider('alpha')).toEqual({ kind: 'written' })
    expect(harness.calls[0]!.ops).toEqual([{ op: 'unset', path: ['providers', 'alpha'] }])
    controller.dispose()
  })

  it('does not remove a composition-declared route', async () => {
    const base = { providers: { alpha: profile() } }
    const harness = makeScope(settings({ value: { providers: { alpha: profile() } }, base }))
    const controller = new ServiceLiteModelsController(harness.scope, NO_HOST_SIDE_EFFECTS)
    expect(await controller.inject().removeProvider('alpha')).toEqual({ kind: 'written' })
    expect(harness.calls).toEqual([])
    controller.dispose()
  })

  it('delegates credential and discovery calls to the Host operations', async () => {
    const harness = makeScope(settings())
    const operations: ServiceLiteModelsHostOperations = {
      storeCredential: async (ref, value) => `${ref}:${value}`,
      discover: async () => ({ kind: 'found', models: [{ id: 'model-a' }] }),
    }
    const controller = new ServiceLiteModelsController(harness.scope, operations)
    const face = controller.inject()
    expect(await face.storeKey('ALPHA_API_KEY', 'secret')).toBe('ALPHA_API_KEY:secret')
    expect(await face.discover({ provider: 'alpha' })).toEqual({
      kind: 'found',
      models: [{ id: 'model-a' }],
    })
    controller.dispose()
  })

  it('stops publishing after disposal', () => {
    const harness = makeScope(settings())
    const controller = new ServiceLiteModelsController(harness.scope, NO_HOST_SIDE_EFFECTS)
    const store = controller.inject().hooks.serviceLiteSettings
    const before = store.getSnapshot()
    controller.dispose()
    harness.setSnapshot(settings({ revision: 99 }))
    expect(store.getSnapshot()).toBe(before)
  })
})
