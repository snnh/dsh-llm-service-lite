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
import { ActionButton, Chip, Field, FieldGroup, TextInput, styles } from './ui.tsx'

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
  const routeCodeId = useId()
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
      // An unapplied route rename is a draft local to the open editor.
      setRenameText(route)
    } else {
      setOpen(true)
    }
  }
  const applyRename = (): void => {
    if (renameProblem !== undefined || candidate === route) return
    // The page files providers by route, so this re-keys (and remounts) the card.
    props.onRename(candidate)
  }
  return (
    <section style={styles['card']} aria-labelledby={titleId}>
      <div style={styles['cardHead']}>
        <div style={styles['cardIdentity']}>
          <h4 id={titleId} style={styles['cardTitle']}>{title}</h4>
          <div style={styles['inline']}>
            <code id={routeCodeId} style={styles['routeCode']}>{route}</code>
            {protocol === undefined ? null : <Chip>{t(protocolLabelKey(protocol))}</Chip>}
            <Chip on={enabled} title={enabled ? t('stateEnabled') : t('stateDisabled')}>
              {enabled ? t('stateEnabled') : t('stateDisabled')}
            </Chip>
            <Chip>{t('modelCount', { count: String(models.length) })}</Chip>
          </div>
        </div>
        <div style={styles['cardActions']}>
          <ActionButton
            primary
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
                danger
                disabled={disabled}
                ariaDescribedBy={routeCodeId}
                onClick={() => { setConfirmRemove(true) }}
              >
                {t('remove')}
              </ActionButton>
            )}
        </div>
      </div>

      {confirmRemove
        ? (
          <div style={styles['confirm']} role="alert">
            <strong style={styles['error']}>{t('removeConfirm', { route })}</strong>
            <span style={styles['hint']}>{t('removeConfirmDetail')}</span>
            <div style={styles['inline']}>
              <ActionButton danger disabled={disabled} onClick={props.onRemove}>{t('remove')}</ActionButton>
              <ActionButton onClick={() => { setConfirmRemove(false) }}>{t('cancel')}</ActionButton>
            </div>
          </div>
        )
        : null}

      {open
        ? (
          <div id={bodyId} style={styles['cardBody']}>
            <FieldGroup title={t('renameTitle')} hint={t('renameHint')}>
              <Field label={t('route')} error={renameError} htmlFor={routeInputId}>
                <div style={styles['inline']}>
                  <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                    <TextInput
                      id={routeInputId}
                      value={renameText}
                      disabled={disabled}
                      onChange={setRenameText}
                    />
                  </div>
                  <ActionButton
                    disabled={disabled || candidate === route || renameProblem !== undefined}
                    onClick={applyRename}
                  >
                    {t('rename')}
                  </ActionButton>
                </div>
              </Field>
            </FieldGroup>
            <ProviderFields
              route={route}
              provider={provider}
              t={t}
              disabled={disabled}
              onPatch={props.onPatch}
              onStoreKey={props.onStoreKey}
            />
            <ModelsEditor
              route={route}
              provider={provider}
              t={t}
              disabled={disabled}
              onPatch={(patch) => { props.onPatch(patch) }}
              onDiscover={props.onDiscover}
            />
            <div style={styles['inline']}>
              <ActionButton onClick={toggleOpen}>{t('close')}</ActionButton>
            </div>
          </div>
        )
        : null}
      {models.length === 0 && !open ? <p style={styles['muted']}>{t('modelsEmpty')}</p> : null}
    </section>
  )
}
