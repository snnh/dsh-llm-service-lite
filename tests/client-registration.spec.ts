/**
 * The browser entry's registration wiring: one locale dictionary, the Plugins
 * page's row-configuration page, and the Models page's provider-card and footer
 * seats — all gated on the Host serving the `llm-service-lite` settings
 * namespace, and all sharing the same Host remotes.
 */
import { describe, expect, it, vi } from 'vitest'

/*
 * The published `@deepseek-ai/dsh-client-store` runtime imports zustand and
 * immer, which its manifest does not declare and this Node test installation
 * therefore lacks; the browser bundle receives that module from the harness
 * module table instead. The controllers only need a snapshot store, so stand in
 * the same read/update contract rather than installing browser-only packages.
 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  SettingsForm: (props: { readonly children?: unknown }) => props.children,
}))

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

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { SETTINGS_NS } from '../src/client/types.ts'

/** One recorded registration, reduced to what this test asserts. */
interface RecordedRegistration {
  readonly options: Record<string, unknown>
  readonly component: unknown
}

/** The browser context the entry receives, reduced to the services it injects. */
function makeContext(): {
  ctx: ClientContext
  dictionaries: [string, { en: Record<string, string>; zh: Record<string, string> }][]
  registrations: RecordedRegistration[]
  served: string[][]
  credentialWrites: { ref: string; value: string }[]
  discoveries: { namespace: string; request: unknown }[]
  effects: string[]
} {
  const dictionaries: [string, { en: Record<string, string>; zh: Record<string, string> }][] = []
  const registrations: RecordedRegistration[] = []
  const served: string[][] = []
  const credentialWrites: { ref: string; value: string }[] = []
  const discoveries: { namespace: string; request: unknown }[] = []
  const effects: string[] = []
  const noop = (): void => {}
  const form = {
    getSnapshot: () => ({
      status: 'ready' as const,
      value: { providers: {} },
      base: undefined,
      user: undefined,
      writable: true,
      revision: 1,
    }),
    subscribe: () => noop,
    mutate: async () => true,
  }
  const ctx = {
    effect: (run: () => unknown, label: string) => {
      effects.push(label)
      const disposer = run()
      return typeof disposer === 'function' ? disposer : noop
    },
    locale: {
      register: (namespace: string, dicts: { en: Record<string, string>; zh: Record<string, string> }) => {
        dictionaries.push([namespace, dicts])
        return noop
      },
    },
    configForms: {
      get: () => form,
      whileServed: (namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void) => {
        served.push([...namespaces])
        return register(new Set(namespaces))
      },
    },
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ options, component })
        return noop
      },
    },
    remote: {
      credentials: {
        set: async (ref: string, value: string) => {
          credentialWrites.push({ ref, value })
          return { ok: true }
        },
      },
      llm: {
        discoverModels: async (namespace: string, request: unknown) => {
          discoveries.push({ namespace, request })
          return { ok: true, value: [] }
        },
      },
    },
  } as unknown as ClientContext
  return { ctx, dictionaries, registrations, served, credentialWrites, discoveries, effects }
}

/** The face one registration injects into its slot component. */
function faceOf(registration: RecordedRegistration): Record<string, unknown> {
  const injectFace = registration.options['inject'] as (() => Record<string, unknown>) | undefined
  expect(typeof injectFace).toBe('function')
  return injectFace!()
}

describe('client entry', () => {
  it('injects the services the page and the Models seats share', () => {
    expect(inject).toContain('slots')
    expect(inject).toContain('locale')
    expect(inject).toContain('remote.credentials')
    expect(inject).toContain('remote.llm')
    expect(inject).toContain('configForms')
  })

  it('registers one symmetric dictionary under the page namespace', () => {
    const { ctx, dictionaries } = makeContext()
    apply(ctx)
    expect(dictionaries).toHaveLength(1)
    expect(dictionaries[0]![0]).toBe('settings.llm-service-lite')
    expect(Object.keys(dictionaries[0]![1].en).sort()).toEqual(Object.keys(dictionaries[0]![1].zh).sort())
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('registers the row page and both Models seats while the namespace is served', () => {
    const { ctx, registrations, served } = makeContext()
    apply(ctx)
    expect(registrations.map(entry => entry.options['name'])).toEqual([
      'plugins.row.config',
      'settings.models.provider-card',
      'settings.models.footer',
    ])
    expect(served).toEqual([
      [SETTINGS_NS],
      [SETTINGS_NS],
      [SETTINGS_NS],
    ])
    expect(registrations.every(entry => entry.options['locale'] === 'settings.llm-service-lite')).toBe(true)
    expect(registrations.every(entry => typeof entry.component === 'function')).toBe(true)
  })

  it('keys the row page and provider card by their dispatch cells and orders the footer', () => {
    const { ctx, registrations } = makeContext()
    apply(ctx)
    const [row, card, footer] = registrations
    expect(row!.options['key']).toBe('@snnh/dsh-llm-service-lite#llm-service-lite')
    expect(card!.options['key']).toBe(SETTINGS_NS)
    expect(footer!.options['id']).toBe(SETTINGS_NS)
    expect(footer!.options['order']).toBe(20)
  })

  it('exposes the settings mirror and the Host writes through the injected face', async () => {
    const { ctx, registrations, credentialWrites, discoveries } = makeContext()
    apply(ctx)
    const face = faceOf(registrations[1]!)
    const hooks = face['hooks'] as { serviceLiteSettings: { getSnapshot: () => { status: string } } }
    expect(hooks.serviceLiteSettings.getSnapshot().status).toBe('ready')
    expect(typeof face['writeProvider']).toBe('function')
    expect(typeof face['addProvider']).toBe('function')
    expect(typeof face['removeProvider']).toBe('function')
    await (face['storeKey'] as (ref: string, value: string) => Promise<string | undefined>)('ALPHA_API_KEY', 'secret')
    expect(credentialWrites).toEqual([{ ref: 'ALPHA_API_KEY', value: 'secret' }])
    const outcome = await (face['discover'] as (request: unknown) => Promise<unknown>)({ provider: 'alpha' })
    expect(outcome).toEqual({ kind: 'found', models: [] })
    expect(discoveries).toEqual([{ namespace: SETTINGS_NS, request: { provider: 'alpha' } }])
  })

  it('disposes both controllers through the registered effects', () => {
    const { ctx, effects } = makeContext()
    apply(ctx)
    expect(effects).toEqual(expect.arrayContaining([
      'llm-service-lite: dictionaries',
      'llm-service-lite: row page subscription',
      'llm-service-lite: row configuration',
      'llm-service-lite: models page subscription',
      'llm-service-lite: models provider card',
      'llm-service-lite: models section footer',
    ]))
  })
})
