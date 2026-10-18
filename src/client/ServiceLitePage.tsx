/**
 * The provider-configuration page: every third-party endpoint this plugin
 * serves, the profile each request resolves, and the models it advertises.
 *
 * Shown on the Plugins page under the bundle's `llm-service-lite` row
 * (`plugins.row.config`), so the document edited here is the same Loader entry
 * config the Host loads instead of a parallel settings store.
 *
 * @module @snnh/dsh-llm-service-lite/client/ServiceLitePage
 */

import { useId, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ServiceLiteKey } from './locales.ts'
import {
  PRESET_IDS,
  applyPatch,
  configCounts,
  presetProfile,
  problemText,
  routeIdProblem,
  suggestedRoute,
  type PresetId,
} from './model.ts'
import type { ClientConfig, ClientProvider, ProviderPatch, ServiceLitePageFace, ServiceLiteTranslate } from './types.ts'
import { ProviderCard } from './ProviderCard.tsx'
import { ActionButton, Field, SelectField, TextInput, styles } from './ui.tsx'

/** Props the Plugins page injects into this page. */
export type ServiceLitePageProps = PropsRuntime<'plugins.row.config'>
  & PropsLocale<'settings.llm-service-lite'>
  & InjectFace<ServiceLitePageFace>

/** The preset label key for one builder preset. */
const PRESET_LABEL: Readonly<Record<PresetId, ServiceLiteKey>> = {
  deepseek: 'presetDeepseek',
  openai: 'presetOpenai',
  anthropic: 'presetAnthropic',
  local: 'presetLocal',
  custom: 'presetCustom',
}

/** The one-line description shown under the preset select. */
const PRESET_DESCRIPTION: Readonly<Record<PresetId, ServiceLiteKey>> = {
  deepseek: 'presetDeepseekHint',
  openai: 'presetOpenaiHint',
  anthropic: 'presetAnthropicHint',
  local: 'presetLocalHint',
  custom: 'presetCustomHint',
}

/**
 * The summary slot one-liner. Count nouns are translated separately so the
 * English sentence can inflect and the Chinese measure words stay natural.
 */
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
  if (props.view === 'summary') return summaryLine(t, state.draft)
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
  return (
    <SettingsForm
      labels={{
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <header style={styles['pageHeader']}>
        <h2 style={styles['pageTitle']}>{t('title')}</h2>
        <p style={styles['pageLead']}>{t('description')}</p>
        <p style={styles['muted']}>{t('appliesHint')}</p>
      </header>

      {state.conflicted ? <p style={styles['error']} role="alert">{t('conflict')}</p> : null}

      {state.problems.length === 0
        ? null
        : (
          <section aria-labelledby={`${headingId}-problems`} role="alert" style={styles['problemsPanel']}>
            <h3 id={`${headingId}-problems`} style={styles['sectionHeading']}>{t('problemsTitle')}</h3>
            <p style={styles['hint']}>{t('problemsHint')}</p>
            <ul style={styles['problems']}>
              {state.problems.map((problem, index) => (
                <li key={`${problem.path}:${problem.key}:${String(index)}`}>
                  <code style={styles['mono']}>{problem.path}</code> — {problemText(problem, t)}
                </li>
              ))}
            </ul>
          </section>
        )}

      <section aria-labelledby={`${headingId}-providers`} style={styles['section']}>
        <h3 id={`${headingId}-providers`} style={styles['sectionHeading']}>{t('providersTitle')}</h3>
        {providers.length === 0
          ? (
            <div style={styles['emptyState']}>
              <strong>{t('providersEmpty')}</strong>
              <span style={styles['hint']}>{t('providersEmptyHint')}</span>
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
      />

      <aside style={styles['note']}>
        <strong style={styles['subhead']}>{t('advancedTitle')}</strong>
        <span style={styles['hint']}>{t('advancedHint')}</span>
      </aside>
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

/** The inline add-provider card: a preset with a description, a prefilled route, and one action. */
function AddProviderForm(props: {
  readonly t: ServiceLiteTranslate
  readonly providers: Readonly<Record<string, ClientProvider>>
  readonly disabled: boolean
  readonly onAdd: (route: string, provider: ClientProvider) => void
}): ReactNode {
  const { t, disabled } = props
  const [open, setOpen] = useState(false)
  const [preset, setPreset] = useState<PresetId>('custom')
  const [route, setRoute] = useState('')
  // A route the person typed survives a preset change; only the untouched suggestion follows the preset.
  const [routeTouched, setRouteTouched] = useState(false)
  const titleId = useId()
  const candidate = route.trim()
  const problem = routeIdProblem(candidate, props.providers)
  const suggested = suggestedRoute(preset, props.providers)
  const reset = (): void => {
    setPreset('custom')
    setRoute('')
    setRouteTouched(false)
    setOpen(false)
  }
  const start = (): void => {
    setPreset('custom')
    setRoute(suggestedRoute('custom', props.providers))
    setRouteTouched(false)
    setOpen(true)
  }
  const choose = (next: PresetId): void => {
    setPreset(next)
    if (!routeTouched) setRoute(suggestedRoute(next, props.providers))
  }
  const create = (): void => {
    if (candidate.length === 0 || problem !== undefined) return
    props.onAdd(candidate, presetProfile(preset))
    reset()
  }
  if (!open) {
    return (
      <div style={styles['addBar']}>
        <ActionButton primary disabled={disabled} onClick={start}>{t('addProvider')}</ActionButton>
        <span style={styles['hint']}>{t('addProviderHint')}</span>
      </div>
    )
  }
  return (
    <section aria-labelledby={titleId} style={styles['card']}>
      <h3 id={titleId} style={styles['sectionHeading']}>{t('addProvider')}</h3>
      <div style={styles['grid2']}>
        <div style={styles['field']}>
          <SelectField
            label={t('preset')}
            value={preset}
            options={PRESET_IDS.map(id => ({ value: id, label: t(PRESET_LABEL[id]) }))}
            disabled={disabled}
            onChange={(value) => { choose((value === '' ? 'custom' : value) as PresetId) }}
          />
          <span style={styles['hint']}>{t(PRESET_DESCRIPTION[preset])}</span>
        </div>
        <Field
          label={t('route')}
          hint={t('routeHint')}
          error={problem === undefined ? undefined : problemText(problem, t)}
        >
          <TextInput
            value={route}
            placeholder={suggested}
            disabled={disabled}
            onChange={(value) => {
              setRoute(value)
              setRouteTouched(true)
            }}
          />
        </Field>
      </div>
      <div style={styles['inline']}>
        <ActionButton primary disabled={disabled || problem !== undefined} onClick={create}>
          {t('create')}
        </ActionButton>
        <ActionButton onClick={reset}>{t('cancel')}</ActionButton>
      </div>
    </section>
  )
}
