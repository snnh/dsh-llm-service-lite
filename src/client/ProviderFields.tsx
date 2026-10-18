/**
 * One provider's editable fields: identity and connection, the credential
 * reference (and the credential literal itself), request behavior, and the
 * capacities a model inherits.
 *
 * @module @snnh/dsh-llm-service-lite/client/ProviderFields
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { ServiceLiteKey } from './locales.ts'
import type { ServiceLiteTranslate } from './types.ts'
import { deriveKeyRef } from './model.ts'
import type { ClientProvider, InterfaceType, ProviderPatch } from './types.ts'
import { ActionButton, Field, FieldGroup, IntegerField, SelectField, TextInput, Toggle, styles } from './ui.tsx'

/** The protocol choices this page offers. */
const PROTOCOL_OPTIONS: readonly { value: InterfaceType; label: ServiceLiteKey }[] = [
  { value: 'openai-chat-completions', label: 'protocolChat' },
  { value: 'anthropic-messages', label: 'protocolAnthropic' },
  { value: 'openai-responses', label: 'protocolResponses' },
]

/** Props one provider's field editor receives. */
export interface ProviderFieldsProps {
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
  /** Store one credential literal; resolves to the refusal message. */
  readonly onStoreKey: (ref: string, value: string) => Promise<string | undefined>
}

/**
 * Render one provider's fields.
 * @param props - the staged profile and its staging callbacks.
 * @returns the field groups.
 */
export function ProviderFields(props: ProviderFieldsProps): ReactNode {
  const { provider, t, disabled } = props
  const protocol = provider.interfaceType
  const keyRef = provider.apiKeyEnv ?? deriveKeyRef(props.route)
  return (
    <div style={styles['cardBody']}>
      <FieldGroup title={t('sectionConnection')}>
        <div style={styles['grid2']}>
          <Field label={t('displayName')}>
            <TextInput
              value={provider.displayName ?? ''}
              placeholder={props.route}
              disabled={disabled}
              onChange={(value) => { props.onPatch({ displayName: value === '' ? undefined : value }) }}
            />
          </Field>
          <SelectField
            label={t('protocol')}
            value={protocol ?? ''}
            options={PROTOCOL_OPTIONS.map(option => ({ value: option.value, label: t(option.label) }))}
            unsetLabel={t('protocolUnset')}
            disabled={disabled}
            onChange={(value) => { props.onPatch({ interfaceType: value === '' ? undefined : value }) }}
          />
        </div>
        <Field label={t('baseURL')} hint={t('baseURLHint')}>
          <TextInput
            value={provider.baseURL ?? ''}
            placeholder={t('baseURLPlaceholder')}
            disabled={disabled}
            onChange={(value) => { props.onPatch({ baseURL: value === '' ? undefined : value }) }}
          />
        </Field>
        <Toggle
          label={t('enabled')}
          hint={t('enabledHint')}
          checked={provider.enabled !== false}
          disabled={disabled}
          onChange={(checked) => { props.onPatch({ enabled: checked ? undefined : false }) }}
        />
      </FieldGroup>

      <FieldGroup title={t('sectionCredential')} hint={t('credentialSectionHint')}>
        <Field label={t('apiKeyRef')} hint={t('apiKeyRefHint')}>
          <TextInput
            value={provider.apiKeyEnv ?? ''}
            placeholder={keyRef}
            disabled={disabled}
            onChange={(value) => { props.onPatch({ apiKeyEnv: value === '' ? undefined : value }) }}
          />
        </Field>
        <CredentialInput
          t={t}
          refName={keyRef}
          disabled={disabled}
          onStoreKey={props.onStoreKey}
          onAdoptRef={(ref) => { props.onPatch({ apiKeyEnv: ref }) }}
        />
      </FieldGroup>

      <FieldGroup title={t('sectionBehavior')}>
        {/* A value staged under another protocol stays switchable-off instead of hiding with the control. */}
        {protocol === 'openai-chat-completions' || provider.includeUsage === true
          ? (
            <Toggle
              label={t('labelIncludeUsage')}
              hint={t('includeUsageHint')}
              checked={provider.includeUsage === true}
              disabled={disabled}
              onChange={(checked) => { props.onPatch({ includeUsage: checked ? true : undefined }) }}
            />
          )
          : null}
        {protocol === 'anthropic-messages' || provider.promptCaching === true
          ? (
            <Toggle
              label={t('labelPromptCaching')}
              hint={t('promptCachingHint')}
              checked={provider.promptCaching === true}
              disabled={disabled}
              onChange={(checked) => { props.onPatch({ promptCaching: checked ? true : undefined }) }}
            />
          )
          : null}
        <div style={styles['grid2']}>
          <IntegerField
            label={t('concurrency')}
            hint={t('concurrencyHint')}
            value={provider.maxConcurrent}
            disabled={disabled}
            onChange={(value) => { props.onPatch({ maxConcurrent: value }) }}
          />
          <IntegerField
            label={t('idleTimeout')}
            hint={t('idleTimeoutHint')}
            value={provider.streamIdleTimeoutMs}
            disabled={disabled}
            onChange={(value) => { props.onPatch({ streamIdleTimeoutMs: value }) }}
          />
          <IntegerField
            label={t('defaultContext')}
            hint={t('defaultCapacityHint')}
            value={provider.defaultContextWindow}
            disabled={disabled}
            onChange={(value) => { props.onPatch({ defaultContextWindow: value }) }}
          />
          <IntegerField
            label={t('defaultMaxTokens')}
            hint={t('defaultCapacityHint')}
            value={provider.defaultMaxTokens}
            disabled={disabled}
            onChange={(value) => { props.onPatch({ defaultMaxTokens: value }) }}
          />
        </div>
      </FieldGroup>

      <aside style={styles['note']}>
        <strong style={styles['subhead']}>{t('advancedTitle')}</strong>
        <span style={styles['hint']}>{t('advancedHint')}</span>
      </aside>
    </div>
  )
}

/** The write-only credential literal input and its one action. */
function CredentialInput(props: {
  readonly t: ServiceLiteTranslate
  readonly refName: string
  readonly disabled: boolean
  readonly onStoreKey: (ref: string, value: string) => Promise<string | undefined>
  readonly onAdoptRef: (ref: string) => void
}): ReactNode {
  const inputId = useId()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ readonly kind: 'ok' | 'error'; readonly text: string } | undefined>(undefined)
  // A reference change retargets the write-only control; never leave a typed secret in front of the new reference.
  useEffect(() => {
    setValue('')
    setNotice(undefined)
  }, [props.refName])
  const store = async (): Promise<void> => {
    const secret = value.trim()
    if (secret.length === 0) return
    setBusy(true)
    setNotice(undefined)
    try {
      const failure = await props.onStoreKey(props.refName, secret)
      if (failure === undefined) {
        setValue('')
        setNotice({ kind: 'ok', text: props.t('keyStored') })
        props.onAdoptRef(props.refName)
      } else {
        setNotice({ kind: 'error', text: props.t('keyStoreFailed', { message: failure }) })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setNotice({ kind: 'error', text: props.t('keyStoreFailed', { message }) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Field label={props.t('secret')} hint={props.t('keyHelp')} htmlFor={inputId}>
      <div style={styles['inline']}>
        <input
          id={inputId}
          type="password"
          style={{ ...styles['input'], flex: 1 }}
          value={value}
          placeholder={props.t('secretPlaceholder')}
          disabled={props.disabled || busy}
          autoComplete="off"
          onChange={(event) => {
            setValue(event.target.value)
            if (notice !== undefined) setNotice(undefined)
          }}
        />
        <ActionButton disabled={props.disabled || busy || value.trim().length === 0} onClick={() => { void store() }}>
          {busy ? props.t('storingKey') : props.t('storeKey')}
        </ActionButton>
      </div>
      {notice === undefined
        ? null
        : (
          <span
            role="status"
            aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}
            style={notice.kind === 'error' ? styles['error'] : styles['success']}
          >
            {notice.text}
          </span>
        )}
    </Field>
  )
}
