/**
 * The add-provider builder as the two settings surfaces render it: the
 * collapsed add bar and the open card with the archived design's preset,
 * protocol, endpoint, key, and connection-test controls.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AddProviderForm, type AddProviderFormProps } from '../src/client/AddProviderForm.tsx'
import { en } from '../src/client/locales.ts'

/** The English dictionary with its `{placeholder}` interpolation applied. */
function translate(key: string, params?: Record<string, unknown>): string {
  const template = (en as unknown as Record<string, string>)[key] ?? key
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? `{${name}}`))
}

/** Props either surface would inject, with the builder forced open. */
function props(overrides: Partial<AddProviderFormProps> = {}): AddProviderFormProps {
  return {
    t: translate,
    providers: {},
    disabled: false,
    onAdd: () => {},
    onStoreKey: async () => undefined,
    onDiscover: async () => ({ kind: 'found', models: [] }),
    initialOpen: true,
    ...overrides,
  }
}

describe('AddProviderForm', () => {
  it('renders the collapsed add control by default', () => {
    const html = renderToStaticMarkup(<AddProviderForm {...props({ initialOpen: false })} />)
    expect(html).toContain(en.addProvider)
    expect(html).not.toContain(en.connectionTest)
  })

  it('renders the archived builder fields when open', () => {
    const html = renderToStaticMarkup(<AddProviderForm {...props()} />)
    expect(html).toContain(en.preset)
    expect(html).toContain(en.presetDashscope)
    expect(html).toContain(en.presetOpenrouter)
    expect(html).toContain(en.route)
    expect(html).toContain(en.protocol)
    expect(html).toContain(en.baseURL)
    expect(html).toContain(en.secret)
    expect(html).toContain(en.connectionTest)
    expect(html).toContain('PROVIDER_API_KEY')
    expect(html).toContain(en.create)
  })

  it('offers the route suggestion for the default custom preset', () => {
    const html = renderToStaticMarkup(<AddProviderForm {...props()} />)
    expect(html).toContain('my-provider')
  })
})
