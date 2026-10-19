/**
 * The Models page seats as the settings section renders them: the per-provider
 * card's collapsed facts and disclosure, the expanded editor with its gated
 * apply, and the section footer's add control.
 *
 * Server rendering keeps the test away from a browser: the seats render only
 * native elements and the plugin's own controls (no client primitive imports),
 * so static markup is enough to check their content.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ModelsProviderCard,
  ProviderSeatEditor,
  type ModelsProviderCardProps,
  type ProviderSeatEditorProps,
} from '../src/client/ModelsProviderCard.tsx'
import { ModelsAddProvider, type ModelsAddProviderProps } from '../src/client/ModelsAddProvider.tsx'
import { en } from '../src/client/locales.ts'
import type { ServiceLiteSettingsSnapshot } from '../src/client/models-controller.ts'
import type { ClientProvider } from '../src/client/types.ts'

/** The English dictionary with its `{placeholder}` interpolation applied. */
function translate(key: string, params?: Record<string, unknown>): string {
  const template = (en as unknown as Record<string, string>)[key] ?? key
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? `{${name}}`))
}

/** One provider profile with a protocol so drafts differ only where a test says so. */
function profile(overrides: ClientProvider = {}): ClientProvider {
  return { interfaceType: 'openai-chat-completions', ...overrides }
}

/** A ready settings read over the given layers. */
function snapshot(overrides: Partial<ServiceLiteSettingsSnapshot> = {}): ServiceLiteSettingsSnapshot {
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

/** The stale-proof Host face every render receives. */
const hostFace = {
  writeProvider: async () => ({ kind: 'written' as const }),
  removeProvider: async () => ({ kind: 'written' as const }),
  addProvider: async () => ({ kind: 'written' as const }),
  storeKey: async () => undefined,
  discover: async () => ({ kind: 'found' as const, models: [] }),
}

/** Props the Models page would inject into the provider-card seat. */
function cardProps(
  settings: ServiceLiteSettingsSnapshot,
  overrides: Partial<ModelsProviderCardProps> = {},
): ModelsProviderCardProps {
  return {
    provider: {
      provider: 'alpha',
      displayName: 'Alpha',
      settingsNs: 'llm-service-lite',
      settingsPath: ['providers', 'alpha'],
      active: true,
    },
    configured: true,
    keyConfigured: true,
    t: translate,
    useServiceLiteSettings: (selector: (state: ServiceLiteSettingsSnapshot) => unknown) => selector(settings),
    ...hostFace,
    ...overrides,
  } as unknown as ModelsProviderCardProps
}

/** Props the Models page would inject into the footer seat. */
function footerProps(settings: ServiceLiteSettingsSnapshot): ModelsAddProviderProps {
  return {
    t: translate,
    useServiceLiteSettings: (selector: (state: ServiceLiteSettingsSnapshot) => unknown) => selector(settings),
    ...hostFace,
  } as unknown as ModelsAddProviderProps
}

/** Props an expanded editor would receive from its card. */
function editorProps(overrides: Partial<ProviderSeatEditorProps> = {}): ProviderSeatEditorProps {
  return {
    id: 'alpha-editor',
    route: 'alpha',
    draft: profile(),
    t: translate,
    disabled: false,
    busy: false,
    problems: [],
    onPatch: () => {},
    onStoreKey: async () => undefined,
    onDiscover: async () => ({ kind: 'found', models: [] }),
    onApply: () => {},
    onDiscard: () => {},
    ...overrides,
  }
}

describe('ModelsProviderCard', () => {
  it('states what the route is and offers the configure disclosure', () => {
    const draft = profile({
      interfaceType: 'anthropic-messages',
      displayName: 'Gateway',
      models: [{ id: 'one' }, { id: 'two' }],
    })
    const html = renderToStaticMarkup(
      <ModelsProviderCard {...cardProps(snapshot({ value: { providers: { alpha: draft } } }))} />,
    )
    expect(html).toContain('LLM Service Lite')
    expect(html).toContain('Anthropic Messages')
    expect(html).toContain('Models: 2')
    expect(html).toContain('Key configured')
    expect(html).toContain('Configure provider')
    // The editor stays closed until the disclosure is used.
    expect(html).not.toContain('Apply')
    expect(html).not.toContain('Request behavior')
  })

  it('reports a missing key and the read-only document', () => {
    const html = renderToStaticMarkup(
      <ModelsProviderCard {...cardProps(
        snapshot({ value: { providers: { alpha: profile() } }, writable: false }),
        { keyConfigured: false },
      )} />,
    )
    expect(html).toContain('No key configured')
    expect(html).toContain('This deployment stores settings read-only')
  })

  it('offers removal only for a route the user layer alone declares', () => {
    const onlyUser = renderToStaticMarkup(
      <ModelsProviderCard {...cardProps(snapshot({
        value: { providers: { alpha: profile() } },
        user: { providers: { alpha: profile() } },
      }))} />,
    )
    expect(onlyUser).toContain('Remove from settings')
    const composed = renderToStaticMarkup(
      <ModelsProviderCard {...cardProps(snapshot({
        value: { providers: { alpha: profile() } },
        base: { providers: { alpha: profile() } },
      }))} />,
    )
    expect(composed).not.toContain('Remove from settings')
  })

  it('renders nothing until the settings form is ready or the route resolves', () => {
    expect(renderToStaticMarkup(<ModelsProviderCard {...cardProps(snapshot({ status: 'loading' }))} />)).toBe('')
    expect(renderToStaticMarkup(<ModelsProviderCard {...cardProps(snapshot())} />)).toBe('')
  })
})

describe('ProviderSeatEditor', () => {
  it('renders the staged profile fields, its model catalog, and the apply footer', () => {
    const html = renderToStaticMarkup(
      <ProviderSeatEditor {...editorProps({
        draft: profile({
          displayName: 'Gateway',
          interfaceType: 'anthropic-messages',
          baseURL: 'https://gateway.example.com/v1',
          promptCaching: true,
          models: [{ id: 'claude-test', contextWindow: 200_000 }],
        }),
      })} />,
    )
    expect(html).toContain('Gateway')
    expect(html).toContain('https://gateway.example.com/v1')
    expect(html).toContain('claude-test')
    expect(html).toContain('Anthropic Messages')
    expect(html).toContain('Apply')
    expect(html).toContain('Cancel')
  })

  it('lists the findings that block an apply', () => {
    const html = renderToStaticMarkup(
      <ProviderSeatEditor {...editorProps({
        draft: profile({ models: [{ id: '' }] }),
        problems: [{ path: 'providers.alpha.models.0', key: 'modelIdRequired' }],
      })} />,
    )
    expect(html).toContain('providers.alpha.models.0')
    expect(html).toContain('A model id is required.')
  })

  it('shows the in-flight copy while an apply crosses the wire', () => {
    const html = renderToStaticMarkup(<ProviderSeatEditor {...editorProps({ busy: true })} />)
    expect(html).toContain('Applying…')
  })
})

describe('ModelsAddProvider', () => {
  it('renders the section title, the hint, and the add control', () => {
    const html = renderToStaticMarkup(
      <ModelsAddProvider {...footerProps(snapshot({ value: { providers: { alpha: profile() } } }))} />,
    )
    expect(html).toContain('LLM Service Lite providers')
    expect(html).toContain('A new route is written to this deployment')
    expect(html).toContain('Add provider')
  })

  it('renders nothing until the settings form is ready', () => {
    expect(renderToStaticMarkup(<ModelsAddProvider {...footerProps(snapshot({ status: 'unavailable' }))} />)).toBe('')
    expect(renderToStaticMarkup(<ModelsAddProvider {...footerProps(snapshot({ value: undefined }))} />)).toBe('')
  })
})
