/**
 * The Models page's section footer seat for this adapter family.
 *
 * The stock add controls only cover the families the page ships with, so a new
 * llm-service-lite route has no way to start life on the Models page. This
 * seat contributes the same preset builder the plugin's own page offers and
 * writes the created profile straight through the settings form; the Host
 * mounts the route from there.
 *
 * @module @snnh/dsh-llm-service-lite/client/ModelsAddProvider
 */

import { useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ServiceLiteModelsFace } from './models-controller.ts'
import { AddProviderForm } from './AddProviderForm.tsx'
import { PageStyle } from './ui.tsx'

/** Props the Models page injects into the footer seat. */
export type ModelsAddProviderProps = PropsRuntime<'settings.models.footer'>
  & PropsLocale<'settings.llm-service-lite'>
  & InjectFace<ServiceLiteModelsFace>

/**
 * Render the section-level add-provider control for this adapter family.
 * @param props - the dictionary and the settings face.
 * @returns the footer block, or nothing while the settings form is unavailable.
 */
export function ModelsAddProvider(props: ModelsAddProviderProps): ReactNode {
  const { t } = props
  const settings = props.useServiceLiteSettings(snapshot => snapshot)
  const [saved, setSaved] = useState<string | undefined>(undefined)
  if (settings.status !== 'ready' || settings.value === undefined) return null
  const disabled = !settings.writable
  return (
    <section className="dsl-root" aria-label={t('modelsFooterTitle')}>
      <PageStyle />
      <div className="dsl-section-head">
        <strong className="dsl-section-title">{t('modelsFooterTitle')}</strong>
        <span className="dsl-section-hint">{t('modelsFooterHint')}</span>
      </div>
      <AddProviderForm
        t={t}
        providers={settings.value.providers}
        disabled={disabled}
        onAdd={async (route, provider) => {
          const outcome = await props.addProvider(route, provider, settings.revision)
          if (outcome.kind === 'written') {
            setSaved(t('modelsFooterAdded', { route }))
            return undefined
          }
          return outcome.kind === 'conflict' ? t('conflict') : t('saveFailed')
        }}
        onStoreKey={props.storeKey}
        onDiscover={props.discover}
      />
      {saved === undefined
        ? null
        : <p role="status" className="dsl-success">{saved}</p>}
    </section>
  )
}
