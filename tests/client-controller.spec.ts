/**
 * The provider page's controller: a projection that starts empty and becomes
 * available when the Host value lands, edits that stage only over a loaded
 * writable form, validation that blocks a save, and the minimal settings write
 * a save performs — including the revision conflict the Host fences it with.
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
  ServiceLitePageController,
  diffConfigOps,
  type ServiceLiteHostOperations,
} from '../src/client/controller.ts'
import { cleanConfig } from '../src/client/model.ts'
import { emptyConfig } from '../src/client/types.ts'
import type {
  ClientConfig,
  ClientProvider,
  DiscoveryOutcome,
  DiscoveryRequest,
  ServiceLitePageSnapshot,
} from '../src/client/types.ts'

/** The document the fake Host serves until a test says otherwise. */
const STORED: ClientConfig = {
  providers: {
    alpha: {
      displayName: 'Alpha',
      interfaceType: 'openai-chat-completions',
      baseURL: 'https://alpha.example.com/v1',
      models: [{ id: 'alpha-chat' }],
    },
  },
}

/** What one fake write was asked to mutate. */
interface WriteRecord {
  readonly ops: readonly SettingsFormPathOp[]
  readonly revision: number | undefined
}

interface FakeForm {
  readonly scope: SettingsFormScope<ClientConfig>
  readonly writes: WriteRecord[]
  /** Deliver a ready Host value and revision, notifying the controller. */
  deliver(value: ClientConfig, options?: {
    readonly revision?: number
    readonly base?: unknown
    readonly writable?: boolean
  }): void
  /** Choose what the next `mutate` answers. */
  setMutateResult(result: boolean): void
}

/**
 * A settings form that starts unloaded and is delivered values later, copied
 * from the pattern `/share/work/dsh-role-config/tests/controller.spec.ts` uses.
 */
function fakeForm(options: { writable?: boolean } = {}): FakeForm {
  const listeners = new Set<() => void>()
  const writes: WriteRecord[] = []
  let mutateResult = true
  let snapshot: SettingsFormScopeSnapshot<ClientConfig> = {
    status: 'loading',
    value: undefined,
    base: undefined,
    user: undefined,
    writable: options.writable ?? true,
    revision: undefined,
  }
  const publish = (): void => { for (const listener of listeners) listener() }
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      mutate: (ops: readonly SettingsFormPathOp[], expectedRevision?: number) => {
        writes.push({ ops, revision: expectedRevision })
        return Promise.resolve(mutateResult)
      },
    },
    writes,
    deliver: (value, deliverOptions = {}) => {
      snapshot = {
        status: 'ready',
        value,
        base: deliverOptions.base ?? {},
        user: undefined,
        writable: deliverOptions.writable ?? true,
        revision: deliverOptions.revision ?? 0,
      }
      publish()
    },
    setMutateResult: (result) => { mutateResult = result },
  }
}

/** Host operations the page delegates to. */
function operations(overrides: Partial<ServiceLiteHostOperations> = {}): ServiceLiteHostOperations {
  return {
    storeCredential: async () => undefined,
    discover: async () => ({ kind: 'found', models: [] }),
    ...overrides,
  }
}

/** A page under test: its fake form, controller, face, and snapshot reader. */
function page(form: FakeForm = fakeForm(), host = operations()): {
  readonly form: FakeForm
  readonly controller: ServiceLitePageController
  readonly face: ReturnType<ServiceLitePageController['inject']>
  readonly state: () => ServiceLitePageSnapshot
} {
  const controller = new ServiceLitePageController(form.scope, host)
  const face = controller.inject()
  return {
    form,
    controller,
    face,
    state: () => face.hooks.serviceLitePage.getSnapshot(),
  }
}

/** Stage one extra route on the draft. */
function addRoute(route: string, provider: ClientProvider): (draft: ClientConfig) => ClientConfig {
  return draft => ({ providers: { ...draft.providers, [route]: provider } })
}

describe('ServiceLitePageController', () => {
  it('projects an empty, unavailable page before the Host value arrives', () => {
    const subject = page()
    const before = subject.state()
    expect(before.available).toBe(false)
    expect(before.draft).toEqual(emptyConfig())
    expect(before.dirty).toBe(false)
    expect(before.problems).toEqual([])

    subject.form.deliver(STORED, { revision: 4 })
    const after = subject.state()
    expect(after.available).toBe(true)
    expect(after.draft).toEqual(STORED)
    expect(after.dirty).toBe(false)
    subject.controller.dispose()
  })

  it('refuses to stage an edit before the form loads, then stages once it does', () => {
    const subject = page()
    subject.face.edit(addRoute('staged', { interfaceType: 'openai-chat-completions' }))
    expect(subject.state().draft).toEqual(emptyConfig())

    subject.form.deliver(STORED, { revision: 2 })
    subject.face.edit(addRoute('staged', { interfaceType: 'openai-chat-completions' }))
    const state = subject.state()
    expect(state.draft.providers['staged']).toEqual({ interfaceType: 'openai-chat-completions' })
    expect(state.draft.providers['alpha']).toEqual(STORED.providers['alpha'])
    expect(state.dirty).toBe(true)
    subject.controller.dispose()
  })

  it('refuses to stage an edit while the Host document is read-only', () => {
    const subject = page(fakeForm({ writable: false }))
    subject.form.deliver(STORED, { revision: 0, writable: false })
    subject.face.edit(addRoute('staged', { interfaceType: 'openai-chat-completions' }))
    const state = subject.state()
    expect(state.writable).toBe(false)
    expect(state.draft).toEqual(STORED)
    expect(state.dirty).toBe(false)
    subject.controller.dispose()
  })

  it('surfaces validation problems and refuses to save them', async () => {
    const subject = page()
    // No wire protocol: the page explains the refusal before asking the Host.
    subject.form.deliver({ providers: { alpha: { baseURL: 'https://alpha.example.com/v1' } } }, { revision: 1 })
    expect(subject.state().invalid).toBe(true)
    expect(subject.state().problems).toEqual([{ path: 'providers.alpha', key: 'protocolRequired' }])

    subject.face.edit(draft => ({
      providers: {
        ...draft.providers,
        alpha: { ...(draft.providers['alpha'] ?? {}), displayName: 'Alpha' },
      },
    }))
    subject.face.save()
    await Promise.resolve()
    expect(subject.form.writes).toHaveLength(0)
    expect(subject.state().dirty).toBe(true)
    expect(subject.state().problems.map(problem => problem.key)).toContain('protocolRequired')
    subject.controller.dispose()
  })

  it('sends the minimal path operation for the edited field', async () => {
    const start: ClientConfig = {
      providers: { alpha: { interfaceType: 'openai-chat-completions' } },
    }
    const subject = page()
    subject.form.deliver(start, { revision: 7, base: {} })
    subject.face.edit(draft => ({
      providers: {
        ...draft.providers,
        alpha: { ...(draft.providers['alpha'] ?? {}), interfaceType: 'anthropic-messages' },
      },
    }))
    expect(subject.state().dirty).toBe(true)

    subject.face.save()
    await vi.waitFor(() => { expect(subject.state().saving).toBe(false) })
    expect(subject.form.writes).toEqual([{
      ops: [{ op: 'set', path: ['providers', 'alpha', 'interfaceType'], value: 'anthropic-messages' }],
      revision: 7,
    }])
    expect(subject.state().dirty).toBe(false)
    expect(subject.state().draft).toEqual(start)
    subject.controller.dispose()
  })

  it('refuses a save whose draft revision the Host moved past', async () => {
    const subject = page()
    subject.form.deliver(STORED, { revision: 0 })
    subject.face.edit(addRoute('beta', {
      interfaceType: 'openai-chat-completions',
      baseURL: 'https://beta.example.com/v1',
    }))
    subject.form.deliver({
      providers: { alpha: { interfaceType: 'anthropic-messages' } },
    }, { revision: 1 })
    expect(subject.state().conflicted).toBe(true)

    subject.face.save()
    await Promise.resolve()
    expect(subject.form.writes).toHaveLength(0)
    expect(subject.state().conflicted).toBe(true)
    expect(subject.state().draft.providers['beta']).toBeDefined()
    subject.controller.dispose()
  })

  it('keeps the draft and reports failure when the Host refuses the write', async () => {
    const subject = page()
    subject.form.deliver(STORED, { revision: 3, base: {} })
    subject.face.edit(draft => ({
      providers: {
        ...draft.providers,
        alpha: { ...(draft.providers['alpha'] ?? {}), displayName: 'Renamed' },
      },
    }))
    subject.form.setMutateResult(false)
    subject.face.save()
    await vi.waitFor(() => { expect(subject.state().failed).toBe(true) })
    expect(subject.state().saving).toBe(false)
    expect(subject.state().dirty).toBe(true)
    expect(subject.state().draft.providers['alpha']?.displayName).toBe('Renamed')
    expect(subject.form.writes).toHaveLength(1)
    subject.controller.dispose()
  })

  it('does not write when the staged draft produces no operations', async () => {
    const subject = page()
    subject.form.deliver(emptyConfig(), { revision: 2, base: {} })
    subject.face.edit(draft => draft)
    expect(subject.state().dirty).toBe(false)
    subject.face.save()
    await vi.waitFor(() => { expect(subject.state().saving).toBe(false) })
    expect(subject.form.writes).toHaveLength(0)
    subject.controller.dispose()
  })

  it('delegates credential storage and model discovery to the Host operations', async () => {
    const storeCredential = vi.fn(async (_ref: string, _value: string): Promise<string | undefined> => 'refused')
    const discover = vi.fn(async (_request: DiscoveryRequest): Promise<DiscoveryOutcome> => ({
      kind: 'refused',
      message: 'no answer',
    }))
    const subject = page(fakeForm(), { storeCredential, discover })

    await expect(subject.face.storeKey('GATEWAY_API_KEY', 'sk-secret')).resolves.toBe('refused')
    expect(storeCredential).toHaveBeenCalledWith('GATEWAY_API_KEY', 'sk-secret')

    const request: DiscoveryRequest = {
      provider: 'alpha',
      baseURL: 'https://alpha.example.com/v1',
      api: 'openai-chat-completions',
    }
    await expect(subject.face.discover(request)).resolves.toEqual({ kind: 'refused', message: 'no answer' })
    expect(discover).toHaveBeenCalledWith(request)
    subject.controller.dispose()
  })
})

describe('diffConfigOps', () => {
  it('writes a newly declared route whole, cleaned of schema defaults', () => {
    const provider: ClientProvider = {
      displayName: 'Alpha',
      enabled: true,
      interfaceType: 'openai-chat-completions',
      baseURL: 'https://alpha.example.com/v1',
      maxConcurrent: 3,
      models: [{ id: 'alpha-chat' }],
    }
    const draft: ClientConfig = { providers: { alpha: provider } }
    const expected = cleanConfig(draft).providers['alpha']
    expect(diffConfigOps(emptyConfig(), {}, draft)).toEqual([{
      op: 'set',
      path: ['providers', 'alpha'],
      value: expected,
    }])
    expect(expected).not.toHaveProperty('enabled')
    expect(expected).not.toHaveProperty('maxConcurrent')
  })

  it('clears a route the draft no longer carries', () => {
    const preserved: ClientProvider = { retryPolicy: { attempts: 1 } }
    const current: ClientConfig = { providers: { kept: preserved, gone: preserved } }
    const draft: ClientConfig = { providers: { kept: preserved } }
    expect(diffConfigOps(current, {}, draft)).toEqual([
      { op: 'unset', path: ['providers', 'gone'] },
    ])
  })

  it('sets a field whose draft value differs from the composition layer', () => {
    const current: ClientConfig = {
      providers: { alpha: { interfaceType: 'openai-chat-completions' } },
    }
    const draft: ClientConfig = {
      providers: { alpha: { interfaceType: 'anthropic-messages' } },
    }
    expect(diffConfigOps(current, {}, draft)).toEqual([
      { op: 'set', path: ['providers', 'alpha', 'interfaceType'], value: 'anthropic-messages' },
    ])
  })

  it('clears a field the draft puts back to the composition value', () => {
    const base = { providers: { alpha: { displayName: 'Inherited' } } }
    const current: ClientConfig = { providers: { alpha: { displayName: 'Inherited' } } }
    const draft: ClientConfig = { providers: { alpha: { displayName: 'Inherited' } } }
    expect(diffConfigOps(current, base, draft)).toEqual([
      { op: 'unset', path: ['providers', 'alpha', 'displayName'] },
    ])
  })

  it('emits nothing for an untouched document', () => {
    expect(diffConfigOps(emptyConfig(), {}, emptyConfig())).toEqual([])
    // Advanced fields the page does not edit are preserved without a write.
    const preserved: ClientConfig = { providers: { alpha: { retryPolicy: { attempts: 2 } } } }
    expect(diffConfigOps(preserved, {}, structuredClone(preserved))).toEqual([])
  })

  it('skips a schema-default value the composition layer does not supply', () => {
    const current: ClientConfig = { providers: { alpha: {} } }
    const draft: ClientConfig = { providers: { alpha: { maxConcurrent: 3 } } }
    expect(diffConfigOps(current, {}, draft)).toEqual([])
  })
})
