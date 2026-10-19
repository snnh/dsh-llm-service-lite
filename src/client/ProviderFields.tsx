/**
 * One provider's editable fields: identity and connection, the credential
 * reference (and the credential literal itself), request behavior, and the
 * capacities a model inherits.
 *
 * @module @snnh/dsh-llm-service-lite/client/ProviderFields
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { ServiceLiteKey } from './locales.ts'
import { deriveKeyRef, extraBodyFailure, parseExtraBody, spellExtraBody } from './model.ts'
import type {
  ClientProvider,
  DiscoveryOutcome,
  DiscoveryRequest,
  InterfaceType,
  ProviderPatch,
  ServiceLiteTranslate,
} from './types.ts'
import {
  ActionButton,
  Chip,
  Field,
  IntegerField,
  PageStyle,
  SectionCard,
  SelectField,
  TextInput,
  Toggle,
  styles,
} from './ui.tsx'

/** The protocol choices this page offers. */
export const PROTOCOL_OPTIONS: readonly { value: InterfaceType; label: ServiceLiteKey }[] = [
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
  /** Ask the route's endpoint for its models, for the connection test. */
  readonly onDiscover?: ((request: DiscoveryRequest) => Promise<DiscoveryOutcome>) | undefined
  /** Report whether the extra-body text currently blocks a save. */
  readonly onExtraBodyValidity?: ((invalid: boolean) => void) | undefined
}

/** What the connection test last reported. */
type ConnectionReport =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'ok'; readonly count: number; readonly latencyMs: number }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Render one provider's fields.
 * @param props - the staged profile and its staging callbacks.
 * @returns the field groups.
 */
export function ProviderFields(props: ProviderFieldsProps): ReactNode {
  const { provider, t, disabled } = props
  const protocol = provider.interfaceType
  const keyRef = provider.apiKeyEnv ?? deriveKeyRef(props.route)
  const [extraBodyText, setExtraBodyText] = useState(() => spellExtraBody(provider.extraBody))
  const [advancedOpen, setAdvancedOpen] = useState(() => Object.keys(provider.extraBody ?? {}).length > 0)
  const [connection, setConnection] = useState<ConnectionReport>({ kind: 'idle' })
  const extraBodyId = useId()
  const validityRef = useRef(props.onExtraBodyValidity)
  validityRef.current = props.onExtraBodyValidity
  const extraBodyParse = parseExtraBody(extraBodyText)
  const extraBodyFailureKey = extraBodyFailure(extraBodyParse)
  useEffect(() => () => { validityRef.current?.(false) }, [])
  const editExtraBody = (text: string): void => {
    setExtraBodyText(text)
    const parsed = parseExtraBody(text)
    const invalid = extraBodyFailure(parsed) !== undefined
    props.onExtraBodyValidity?.(invalid)
    if (parsed.kind === 'object') props.onPatch({ extraBody: parsed.value })
    else if (parsed.kind === 'empty') props.onPatch({ extraBody: undefined })
  }
  const testConnection = async (): Promise<void> => {
    if (props.onDiscover === undefined) return
    setConnection({ kind: 'busy' })
    const started = Date.now()
    try {
      const answer = await props.onDiscover({
        provider: props.route,
        ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
        ...(provider.interfaceType === undefined ? {} : { api: provider.interfaceType }),
      })
      const latencyMs = Date.now() - started
      setConnection(answer.kind === 'found'
        ? { kind: 'ok', count: answer.models.length, latencyMs }
        : { kind: 'failed', message: answer.message })
    } catch (error) {
      setConnection({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }
  return (
    <div className="dsl-root">
      <PageStyle />
      <SectionCard title={t('sectionConnection')} hint={t('connectionSectionHint')}>
        <div className="dsl-grid">
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
            type="url"
            onChange={(value) => { props.onPatch({ baseURL: value === '' ? undefined : value }) }}
          />
        </Field>
        <div className="dsl-row">
          <ActionButton
            small
            outline
            disabled={disabled || connection.kind === 'busy' || props.onDiscover === undefined}
            onClick={() => { void testConnection() }}
          >
            {connection.kind === 'busy' ? t('connectionTesting') : t('connectionTest')}
          </ActionButton>
          {connection.kind === 'ok'
            ? (
              <>
                <Chip tone="success" title={t('connectionOk')}>
                  {t('connectionModels', { count: String(connection.count) })} · {t('connectionLatency', { ms: String(connection.latencyMs) })}
                </Chip>
              </>
            )
            : connection.kind === 'failed'
              ? <span role="alert" className="dsl-error">{t('connectionFailed', { message: connection.message })}</span>
              : <span className="dsl-hint">{t('connectionHint')}</span>}
        </div>
        <Toggle
          label={t('enabled')}
          hint={t('enabledHint')}
          checked={provider.enabled !== false}
          disabled={disabled}
          onChange={(checked) => { props.onPatch({ enabled: checked ? undefined : false }) }}
        />
      </SectionCard>

      <SectionCard title={t('sectionCredential')} hint={t('credentialSectionHint')}>
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
      </SectionCard>

      <SectionCard title={t('sectionBehavior')}>
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
        <div className="dsl-grid">
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
      </SectionCard>

      <details
        className="dsl-details"
        open={advancedOpen}
        onToggle={(event) => { setAdvancedOpen(event.currentTarget.open) }}
      >
        <summary>
          {t('advancedTitle')}
          <Chip>JSON</Chip>
        </summary>
        <div className="dsl-details-body">
          <Field
            label={t('extraBody')}
            hint={t('extraBodyHint')}
            error={extraBodyFailureKey === undefined ? undefined : t(extraBodyFailureKey)}
            htmlFor={extraBodyId}
          >
            <textarea
              id={extraBodyId}
              className="dsl-textarea"
              rows={6}
              value={extraBodyText}
              spellCheck={false}
              disabled={disabled}
              aria-invalid={extraBodyFailureKey !== undefined}
              onChange={(event) => { editExtraBody(event.target.value) }}
            />
          </Field>
          <p className="dsl-hint">{t('advancedHint')}</p>
        </div>
      </details>
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
      <div className="dsl-row" style={{ flexWrap: 'nowrap' }}>
        <div style={styles['grow']}>
          <input
            id={inputId}
            type="password"
            className="dsl-input"
            value={value}
            placeholder={props.t('secretPlaceholder')}
            disabled={props.disabled || busy}
            autoComplete="new-password"
            onChange={(event) => {
              setValue(event.target.value)
              if (notice !== undefined) setNotice(undefined)
            }}
          />
        </div>
        <ActionButton
          small
          outline
          disabled={props.disabled || busy || value.trim().length === 0}
          onClick={() => { void store() }}
        >
          {busy ? props.t('storingKey') : props.t('storeKey')}
        </ActionButton>
      </div>
      {notice === undefined
        ? null
        : (
          <span
            role="status"
            aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}
            className={notice.kind === 'error' ? 'dsl-error' : 'dsl-success'}
          >
            {notice.text}
          </span>
        )}
    </Field>
  )
}
