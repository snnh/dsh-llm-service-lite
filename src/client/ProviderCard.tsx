/**
 * One provider card: what the route is at a glance, and the expanded editor
 * for its profile fields and models.
 *
 * @module @snnh/dsh-llm-service-lite/client/ProviderCard
 */

import { useId, useState, type ReactNode } from 'react'
import type { ServiceLiteTranslate } from './types.ts'
import {
  interfaceTypeOf,
  modelsOf,
  problemText,
  protocolLabelKey,
  routeFormatProblem,
} from './model.ts'
import type { ClientProvider, DiscoveryOutcome, DiscoveryRequest, ProfileProblem, ProviderPatch } from './types.ts'
import { ModelsEditor } from './ModelsEditor.tsx'
import { ProviderFields } from './ProviderFields.tsx'
import { ActionButton, Chip, Field, PageStyle, SectionCard, TextInput, styles } from './ui.tsx'

/** Props one provider card receives. */
export interface ProviderCardProps {
  /** Route id this profile is filed under. */
  readonly route: string
  /** The staged profile. */
  readonly provider: ClientProvider
  /** Page dictionary. */
  readonly t: ServiceLiteTranslate
  /** Whether the form accepts edits. */
  readonly disabled: boolean
  /** Stage a patch onto this profile. */
  readonly onPatch: (patch: ProviderPatch) => void
  /** Remove this provider from the staged document. */
  readonly onRemove: () => void
  /** Rename this provider's route key. */
  readonly onRename: (route: string) => void
  /** The other routes in the document, for rename validation. */
  readonly siblingRoutes: readonly string[]
  /** Store one credential literal; resolves to the refusal message. */
  readonly onStoreKey: (ref: string, value: string) => Promise<string | undefined>
  /** Ask the endpoint for its models. */
  readonly onDiscover: (request: DiscoveryRequest) => Promise<DiscoveryOutcome>
  /** Report whether the extra-body text currently blocks a save. */
  readonly onExtraBodyValidity?: ((invalid: boolean) => void) | undefined
}

/**
 * Render one provider card.
 * @param props - the staged profile and its staging callbacks.
 * @returns the collapsed card or its editor.
 */
export function ProviderCard(props: ProviderCardProps): ReactNode {
  const { route, provider, t, disabled } = props
  const [open, setOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [renameText, setRenameText] = useState(route)
  const titleId = useId()
  const bodyId = useId()
  const routeInputId = useId()
  const models = modelsOf(provider)
  const protocol = interfaceTypeOf(provider)
  const enabled = provider.enabled !== false
  const title = provider.displayName?.trim() || route
  const candidate = renameText.trim()
  const renameProblem: ProfileProblem | undefined = candidate === route
    ? undefined
    : routeFormatProblem(candidate) ?? (props.siblingRoutes.includes(candidate)
      ? { path: 'route', key: 'routeTaken', params: { route: candidate } }
      : undefined)
  const renameError = renameProblem === undefined ? undefined : problemText(renameProblem, t)
  const toggleOpen = (): void => {
    if (open) {
      setOpen(false)
      setConfirmRemove(false)
      setRenameText(route)
    } else {
      setOpen(true)
    }
  }
  const applyRename = (): void => {
    if (renameProblem !== undefined || candidate === route) return
    props.onRename(candidate)
  }
  return (
    <section className="dsl-provider" aria-labelledby={titleId}>
      <PageStyle />
      <div className="dsl-provider-head">
        <div className="dsl-provider-mark" aria-hidden="true">{route.slice(0, 2).toUpperCase()}</div>
        <div className="dsl-provider-main">
          <h4 id={titleId} className="dsl-provider-title">{title}</h4>
          <div className="dsl-provider-meta">
            <code className="dsl-code">{route}</code>
            {protocol === undefined ? null : <Chip>{t(protocolLabelKey(protocol))}</Chip>}
            <Chip tone={enabled ? 'success' : 'neutral'} title={enabled ? t('stateEnabled') : t('stateDisabled')}>
              {enabled ? t('stateEnabled') : t('stateDisabled')}
            </Chip>
            <Chip>{t('modelCount', { count: String(models.length) })}</Chip>
          </div>
        </div>
        <div className="dsl-provider-actions">
          <ActionButton
            small
            primary={!open}
            outline={open}
            disabled={disabled}
            ariaExpanded={open}
            ariaControls={bodyId}
            onClick={toggleOpen}
          >
            {open ? t('close') : t('edit')}
          </ActionButton>
          {confirmRemove
            ? null
            : (
              <ActionButton
                small
                danger
                disabled={disabled}
                ariaLabel={t('remove')}
                onClick={() => { setConfirmRemove(true) }}
              >
                {t('remove')}
              </ActionButton>
            )}
        </div>
      </div>

      {confirmRemove
        ? (
          <div className="dsl-note dsl-note--danger" role="alert">
            <div className="dsl-stack" style={styles['grow']}>
              <strong>{t('removeConfirm', { route })}</strong>
              <span>{t('removeConfirmDetail')}</span>
            </div>
            <div className="dsl-row">
              <ActionButton small danger disabled={disabled} onClick={props.onRemove}>{t('remove')}</ActionButton>
              <ActionButton small quiet onClick={() => { setConfirmRemove(false) }}>{t('cancel')}</ActionButton>
            </div>
          </div>
        )
        : null}

      {open
        ? (
          <div id={bodyId} className="dsl-provider-body">
            <SectionCard title={t('renameTitle')} hint={t('renameHint')}>
              <Field label={t('route')} error={renameError} htmlFor={routeInputId}>
                <div className="dsl-row" style={{ flexWrap: 'nowrap' }}>
                  <div style={styles['grow']}>
                    <TextInput
                      id={routeInputId}
                      value={renameText}
                      disabled={disabled}
                      onChange={setRenameText}
                    />
                  </div>
                  <ActionButton
                    small
                    outline
                    disabled={disabled || candidate === route || renameProblem !== undefined}
                    onClick={applyRename}
                  >
                    {t('rename')}
                  </ActionButton>
                </div>
              </Field>
            </SectionCard>
            <ProviderFields
              route={route}
              provider={provider}
              t={t}
              disabled={disabled}
              onPatch={props.onPatch}
              onStoreKey={props.onStoreKey}
              onDiscover={props.onDiscover}
              onExtraBodyValidity={props.onExtraBodyValidity}
            />
            <ModelsEditor
              route={route}
              provider={provider}
              t={t}
              disabled={disabled}
              onPatch={props.onPatch}
              onDiscover={props.onDiscover}
            />
            <div className="dsl-footer">
              <ActionButton outline onClick={toggleOpen}>{t('close')}</ActionButton>
            </div>
          </div>
        )
        : null}
      {models.length === 0 && !open ? <p className="dsl-hint">{t('modelsEmpty')}</p> : null}
    </section>
  )
}
