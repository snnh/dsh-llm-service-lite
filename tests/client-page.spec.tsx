/**
 * The provider page as the Plugins page renders it: the collapsed summary line
 * and the editable page body.
 *
 * Server rendering keeps the test away from a browser: `SettingsForm` is
 * replaced with a pass-through because the real primitive loads a CSS module,
 * while every other client primitive import in the component graph is type-only.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  SettingsForm: (props: { readonly children?: unknown }) => props.children,
}))

import { ServiceLitePage, type ServiceLitePageProps } from '../src/client/ServiceLitePage.tsx'
import { en } from '../src/client/locales.ts'
import type { ClientConfig, ServiceLitePageSnapshot } from '../src/client/types.ts'

/** A ready page snapshot with the given overrides. */
function pageState(overrides: Partial<ServiceLitePageSnapshot> = {}): ServiceLitePageSnapshot {
  return {
    available: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    draft: { providers: {} },
    problems: [],
    conflicted: false,
    ...overrides,
  }
}

/** The English dictionary with its `{placeholder}` interpolation applied. */
function translate(key: string, params?: Record<string, unknown>): string {
  const template = (en as unknown as Record<string, string>)[key] ?? key
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? `{${name}}`))
}

/** Props the Plugins page would inject, with the page snapshot bound as the hook. */
function pageProps(state: ServiceLitePageSnapshot, view: 'summary' | 'page'): ServiceLitePageProps {
  return {
    view,
    t: translate,
    useServiceLitePage: selector => selector(state),
    edit: () => {},
    save: () => {},
    discard: () => {},
    storeKey: async () => undefined,
    discover: async () => ({ kind: 'found', models: [] }),
  }
}

/** Render the page through the mocked `SettingsForm` frame. */
function render(state: ServiceLitePageSnapshot, view: 'summary' | 'page'): string {
  return renderToStaticMarkup(<ServiceLitePage {...pageProps(state, view)} />)
}

describe('ServiceLitePage', () => {
  it('summarizes the configured provider and model totals for two providers and three models', () => {
    const config: ClientConfig = {
      providers: {
        alpha: { models: [{ id: 'alpha-chat' }, { id: 'alpha-reasoner' }] },
        beta: { models: [{ id: 'beta-chat' }] },
      },
    }
    const html = render(pageState({ draft: config }), 'summary')
    expect(html).toContain('2 providers')
    expect(html).toContain('3 models')
  })

  it('renders each provider route, its display name, and the add-provider control', () => {
    const config: ClientConfig = {
      providers: {
        'alpha-route': {
          displayName: 'Alpha Gateway',
          interfaceType: 'openai-chat-completions',
          baseURL: 'https://alpha.example.com/v1',
          models: [{ id: 'alpha-chat' }],
        },
      },
    }
    const html = render(pageState({ draft: config }), 'page')
    expect(html).toContain('alpha-route')
    expect(html).toContain('Alpha Gateway')
    expect(html).toContain(en.addProvider)
    expect(html).toContain(en.providersTitle)
  })

  it('lists a validation problem with its path and message before a save', () => {
    const html = render(pageState({
      invalid: true,
      draft: { providers: { alpha: {} } },
      problems: [{ path: 'providers.alpha.interfaceType', key: 'protocolRequired' }],
    }), 'page')
    expect(html).toContain(en.problemsTitle)
    expect(html).toContain('providers.alpha.interfaceType')
    expect(html).toContain(en.protocolRequired)
  })
})
