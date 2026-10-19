/**
 * The provider-configuration page: every third-party endpoint this plugin
 * serves, the profile each request resolves, and the models it advertises.
 *
 * @module @snnh/dsh-llm-service-lite/client/ServiceLitePage
 */

import { useId, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import { applyPatch, configCounts, problemText } from './model.ts'
import type { ClientConfig, ClientProvider, ProviderPatch, ServiceLitePageFace, ServiceLiteTranslate } from './types.ts'
import { AddProviderForm } from './AddProviderForm.tsx'
import { ProviderCard } from './ProviderCard.tsx'
import { Chip, PageStyle } from './ui.tsx'

/** Props the Plugins page injects into this page. */
export type ServiceLitePageProps = PropsRuntime<'plugins.row.config'>
  & PropsLocale<'settings.llm-service-lite'>
  & InjectFace<ServiceLitePageFace>

/** The summary slot one-liner. */
function summaryLine(t: ServiceLiteTranslate, draft: ClientConfig): string {
  const counts = configCounts(draft)
  if (counts.providers === 0) return t('summaryEmpty')
  const providers = counts.providers === 1
    ? t('summaryProviderOne')
    : t('summaryProviderMany', { count: String(counts.providers) })
  if (counts.models === 0) return t('summaryNoModels', { providers })
  const models = counts.models === 1
    ? t('summaryModelOne')
    : t('summaryModelMany', { count: String(counts.models) })
  return t('summary', { providers, models })
}

/**
 * Render the provider-configuration page.
 * @param props - locale copy, the page snapshot, and its actions.
 * @returns the summary line or the editable document.
 */
export function ServiceLitePage(props: ServiceLitePageProps): ReactNode {
  const { t } = props
  const state = props.useServiceLitePage(snapshot => snapshot)
  const headingId = useId()
  const [extraBodyInvalid, setExtraBodyInvalid] = useState<ReadonlySet<string>>(new Set())
  if (props.view === 'summary') return summaryLine(t, state.draft)
  const reportExtraBody = (route: string, invalid: boolean): void => {
    setExtraBodyInvalid((current) => {
      const next = new Set(current)
      if (invalid) next.add(route)
      else next.delete(route)
      return next
    })
  }
  const blocked = state.invalid || extraBodyInvalid.size > 0
  const formState = blocked === state.invalid ? state : { ...state, invalid: blocked }
  const patch = (route: string, next: ProviderPatch): void => {
    props.edit((draft) => {
      const current = draft.providers[route]
      if (current === undefined) return draft
      return {
        providers: { ...draft.providers, [route]: applyPatch(current, next) },
      }
    })
  }
  const disabled = !state.writable || state.saving
  const providers = Object.entries(state.draft.providers)
  const counts = configCounts(state.draft)
  return (
    <SettingsForm
      labels={{
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }}
      state={formState}
      onSave={() => { if (!blocked) props.save() }}
      onDiscard={() => {
        setExtraBodyInvalid(new Set())
        props.discard()
      }}
    >
      <div className="dsl-root">
        <PageStyle />
        <header className="dsl-page-head">
          <h2 className="dsl-page-title">{t('title')}</h2>
          <p className="dsl-page-lead">{t('description')}</p>
          <p className="dsl-page-note">{t('appliesHint')}</p>
        </header>

        {state.conflicted ? <p className="dsl-error" role="alert">{t('conflict')}</p> : null}

        {state.problems.length === 0
          ? null
          : (
            <section aria-labelledby={`${headingId}-problems`} role="alert" className="dsl-note dsl-note--danger">
              <div className="dsl-stack">
                <strong id={`${headingId}-problems`}>{t('problemsTitle')}</strong>
                <span className="dsl-hint">{t('problemsHint')}</span>
                <ul className="dsl-problems">
                  {state.problems.map((problem, index) => (
                    <li key={`${problem.path}:${problem.key}:${String(index)}`}>
                      <code className="dsl-code">{problem.path}</code> — {problemText(problem, t)}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

        <section aria-labelledby={`${headingId}-providers`} className="dsl-stack" style={{ gap: 10 }}>
          <div className="dsl-section-head">
            <h3 id={`${headingId}-providers`} className="dsl-section-title">{t('providersTitle')}</h3>
            <Chip>{counts.providers === 1 ? t('summaryProviderOne') : t('summaryProviderMany', { count: String(counts.providers) })}</Chip>
            <Chip>{counts.models === 1 ? t('summaryModelOne') : t('summaryModelMany', { count: String(counts.models) })}</Chip>
          </div>
          {providers.length === 0
            ? (
              <div className="dsl-empty">
                <span className="dsl-empty-title">{t('providersEmpty')}</span>
                <span className="dsl-empty-hint">{t('providersEmptyHint')}</span>
              </div>
            )
            : providers.map(([route, provider]) => (
              <ProviderCard
                key={route}
                route={route}
                provider={provider}
                t={t}
                disabled={disabled}
                onPatch={(next) => { patch(route, next) }}
                onRemove={() => { removeProvider(props, route) }}
                onRename={(nextRoute) => { renameProvider(props, state.draft, route, nextRoute) }}
                siblingRoutes={Object.keys(state.draft.providers).filter(entry => entry !== route)}
                onStoreKey={props.storeKey}
                onDiscover={props.discover}
                onExtraBodyValidity={(invalid) => { reportExtraBody(route, invalid) }}
              />
            ))}
        </section>

        <AddProviderForm
          t={t}
          providers={state.draft.providers}
          disabled={disabled}
          onAdd={(route, provider) => {
            props.edit((draft) => ({ providers: { ...draft.providers, [route]: provider } }))
          }}
          onStoreKey={props.storeKey}
          onDiscover={props.discover}
        />
      </div>
    </SettingsForm>
  )
}

/** Drop one provider from the staged document. */
function removeProvider(props: ServiceLitePageProps, route: string): void {
  props.edit((current) => {
    const providers = { ...current.providers }
    if (providers[route] === undefined) return current
    delete providers[route]
    return { providers }
  })
}

/** Move one provider to a different route key, keeping its profile. */
function renameProvider(props: ServiceLitePageProps, draft: ClientConfig, route: string, nextRoute: string): void {
  if (nextRoute === route || draft.providers[nextRoute] !== undefined) return
  props.edit((current) => {
    const provider = current.providers[route]
    if (provider === undefined) return current
    const providers: Record<string, ClientProvider> = {}
    for (const [key, value] of Object.entries(current.providers)) {
      if (key === route) providers[nextRoute] = value
      else providers[key] = value
    }
    return { providers }
  })
}
