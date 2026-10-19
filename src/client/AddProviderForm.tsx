/**
 * The builder card that starts a new provider profile from a preset.
 *
 * Two settings surfaces offer it: the Plugins page's row-configuration page
 * stages the created profile into its document, while the Models page footer
 * writes it straight through the settings form. The component therefore only
 * collects the endpoint facts a create cannot default — the preset, the route
 * name, the wire protocol, the endpoint, and an optional key — and hands the
 * new profile to its owner.
 *
 * @module @snnh/dsh-llm-service-lite/client/AddProviderForm
 */

import { useId, useState, type ReactNode } from 'react'
import type { ServiceLiteKey } from './locales.ts'
import {
  PRESET_IDS,
  deriveKeyRef,
  presetProfile,
  problemText,
  routeIdProblem,
  suggestedRoute,
  type PresetId,
} from './model.ts'
import type {
  ClientProvider,
  DiscoveryOutcome,
  DiscoveryRequest,
  InterfaceType,
  ServiceLiteTranslate,
} from './types.ts'
import { PROTOCOL_OPTIONS } from './ProviderFields.tsx'
import { ActionButton, Chip, Field, PageStyle, SelectField, TextInput } from './ui.tsx'

/** The preset label key for one builder preset. */
const PRESET_LABEL: Readonly<Record<PresetId, ServiceLiteKey>> = {
  deepseek: 'presetDeepseek',
  openai: 'presetOpenai',
  anthropic: 'presetAnthropic',
  dashscope: 'presetDashscope',
  qianfan: 'presetQianfan',
  glm: 'presetGlm',
  zhipu: 'presetZhipu',
  kimi: 'presetKimi',
  moonshot: 'presetMoonshot',
  openrouter: 'presetOpenrouter',
  ollama: 'presetOllama',
  tencent: 'presetTencent',
  local: 'presetLocal',
  custom: 'presetCustom',
}

/** The presets offered as one-click starting points above the full list. */
const QUICK_PRESETS: readonly PresetId[] = [
  'deepseek',
  'openai',
  'anthropic',
  'dashscope',
  'openrouter',
  'custom',
]

/** The one-line description shown under the preset select. */
const PRESET_DESCRIPTION: Readonly<Record<PresetId, ServiceLiteKey>> = {
  deepseek: 'presetDeepseekHint',
  openai: 'presetOpenaiHint',
  anthropic: 'presetAnthropicHint',
  dashscope: 'presetDashscopeHint',
  qianfan: 'presetQianfanHint',
  glm: 'presetGlmHint',
  zhipu: 'presetZhipuHint',
  kimi: 'presetKimiHint',
  moonshot: 'presetMoonshotHint',
  openrouter: 'presetOpenrouterHint',
  ollama: 'presetOllamaHint',
  tencent: 'presetTencentHint',
  local: 'presetLocalHint',
  custom: 'presetCustomHint',
}

/** What the last connection test learned about the draft. */
type ProbeReport =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'ok'; readonly count: number; readonly latencyMs: number }
  | { readonly kind: 'failed'; readonly message: string }

/** Props the add-provider card receives. */
export interface AddProviderFormProps {
  /** Page dictionary. */
  readonly t: ServiceLiteTranslate
  /** Routes the document already holds, for the duplicate check. */
  readonly providers: Readonly<Record<string, ClientProvider>>
  /** Whether the form accepts edits. */
  readonly disabled: boolean
  /**
   * Stage or write the new route. A promise reports the refusal message the
   * card should show and keeps the draft open for a correction.
   */
  readonly onAdd: (route: string, provider: ClientProvider) => void | Promise<string | undefined>
  /** Store the typed key after the profile write lands. */
  readonly onStoreKey?: ((ref: string, value: string) => Promise<string | undefined>) | undefined
  /** Ask a drafted endpoint for the models it serves. */
  readonly onDiscover?: ((request: DiscoveryRequest) => Promise<DiscoveryOutcome>) | undefined
  /** Open the builder immediately instead of showing its collapsed add bar. */
  readonly initialOpen?: boolean | undefined
}

/** A promise-returning `onAdd`, without relying on `instanceof Promise`. */
function isAsyncAdd(
  outcome: void | Promise<string | undefined>,
): outcome is Promise<string | undefined> {
  return typeof (outcome as { then?: unknown } | undefined)?.then === 'function'
}

/** Whether a typed endpoint is one the adapter may be pointed at. */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch (_invalidUrl) {
    return false
  }
}

/**
 * Render the collapsed add button or the open builder card.
 * @param props - the dictionary, the taken routes, and the create callback.
 * @returns the add control.
 */
export function AddProviderForm(props: AddProviderFormProps): ReactNode {
  const { t, disabled } = props
  const [open, setOpen] = useState(props.initialOpen === true)
  const [preset, setPreset] = useState<PresetId>('custom')
  const [route, setRoute] = useState('')
  const [routeTouched, setRouteTouched] = useState(false)
  const [interfaceType, setInterfaceType] = useState<InterfaceType>('openai-chat-completions')
  const [baseURL, setBaseURL] = useState('')
  const [keyDraft, setKeyDraft] = useState('')
  const [probe, setProbe] = useState<ProbeReport>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [committed, setCommitted] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const titleId = useId()
  const candidate = route.trim()
  const problem = routeIdProblem(candidate, props.providers)
  const suggested = suggestedRoute(preset, props.providers)
  const normalizedBaseURL = baseURL.trim()
  const baseUrlInvalid = normalizedBaseURL.length > 0 && !isHttpUrl(normalizedBaseURL)
  const keyValue = keyDraft.trim()
  const keyRef = deriveKeyRef(candidate.length === 0 ? 'provider' : candidate)
  const ready = candidate.length > 0 && problem === undefined && !baseUrlInvalid
    && interfaceType.length > 0

  const reset = (): void => {
    setPreset('custom')
    setRoute('')
    setRouteTouched(false)
    setInterfaceType('openai-chat-completions')
    setBaseURL('')
    setKeyDraft('')
    setProbe({ kind: 'idle' })
    setFailure(undefined)
    setBusy(false)
    setCommitted(false)
    setOpen(false)
  }
  const start = (): void => {
    setPreset('custom')
    setRoute(suggestedRoute('custom', props.providers))
    setRouteTouched(false)
    setInterfaceType('openai-chat-completions')
    setBaseURL('')
    setKeyDraft('')
    setProbe({ kind: 'idle' })
    setFailure(undefined)
    setCommitted(false)
    setOpen(true)
  }
  const choose = (next: PresetId): void => {
    setPreset(next)
    const profile = presetProfile(next)
    if (!routeTouched) setRoute(suggestedRoute(next, props.providers))
    setInterfaceType(profile.interfaceType ?? 'openai-chat-completions')
    setBaseURL(profile.baseURL ?? '')
    setProbe({ kind: 'idle' })
    setFailure(undefined)
  }
  const probeEndpoint = async (): Promise<void> => {
    if (props.onDiscover === undefined || normalizedBaseURL.length === 0) return
    setProbe({ kind: 'busy' })
    const started = Date.now()
    try {
      const answer = await props.onDiscover({
        baseURL: normalizedBaseURL,
        api: interfaceType,
        ...(keyValue.length === 0 ? {} : { apiKey: keyValue }),
      })
      const latencyMs = Date.now() - started
      setProbe(answer.kind === 'found'
        ? { kind: 'ok', count: answer.models.length, latencyMs }
        : { kind: 'failed', message: answer.message })
    } catch (error) {
      setProbe({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }
  const create = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setFailure(undefined)
    try {
      const base = presetProfile(preset)
      const provider: ClientProvider = {
        ...base,
        interfaceType,
      }
      if (base.interfaceType !== interfaceType) delete provider.models
      if (interfaceType !== 'openai-chat-completions') delete provider.includeUsage
      if (interfaceType !== 'anthropic-messages') delete provider.promptCaching
      if (normalizedBaseURL.length === 0) delete provider.baseURL
      else provider.baseURL = normalizedBaseURL
      if (keyValue.length > 0) provider.apiKeyEnv = keyRef
      if (!committed) {
        const outcome = props.onAdd(candidate, provider)
        const refusal = isAsyncAdd(outcome) ? await outcome : undefined
        if (refusal !== undefined) {
          setFailure(refusal)
          return
        }
        setCommitted(true)
      }
      if (keyValue.length > 0 && props.onStoreKey !== undefined) {
        const refusal = await props.onStoreKey(keyRef, keyValue)
        if (refusal !== undefined) {
          setFailure(t('keyStoreFailed', { message: refusal }))
          return
        }
      }
      reset()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  if (!open) {
    return (
      <div className="dsl-root">
        <PageStyle />
        <div className="dsl-add">
          <div className="dsl-add-copy">
            <span className="dsl-add-title">{t('addProvider')}</span>
            <span className="dsl-add-hint">{t('addProviderHint')}</span>
          </div>
          <ActionButton primary disabled={disabled} onClick={start}>{t('addProvider')}</ActionButton>
        </div>
      </div>
    )
  }
  const blocked = disabled || busy
  const profileDisabled = blocked || committed
  return (
    <section aria-labelledby={titleId} className="dsl-root dsl-card">
      <PageStyle />
      <div className="dsl-card-head">
        <div>
          <h3 id={titleId} className="dsl-card-title">{t('addProvider')}</h3>
          <p className="dsl-card-sub">{t('addProviderHint')}</p>
        </div>
        <ActionButton small quiet disabled={busy} onClick={reset}>{t('cancel')}</ActionButton>
      </div>

      <div className="dsl-stack">
        <span className="dsl-label">{t('quickPreset')}</span>
        <div className="dsl-row">
          {QUICK_PRESETS.map(id => (
            <button
              key={id}
              type="button"
              className={preset === id ? 'dsl-pill dsl-pill--active' : 'dsl-pill'}
              aria-pressed={preset === id}
              disabled={profileDisabled}
              onClick={() => { choose(id) }}
            >
              {t(PRESET_LABEL[id])}
            </button>
          ))}
        </div>
        <div className="dsl-grid">
          <SelectField
            label={t('preset')}
            value={preset}
            options={PRESET_IDS.map(id => ({ value: id, label: t(PRESET_LABEL[id]) }))}
            disabled={profileDisabled}
            onChange={(value) => { choose((value === '' ? 'custom' : value) as PresetId) }}
          />
          <Field
            label={t('route')}
            hint={t('routeHint')}
            error={problem === undefined ? undefined : problemText(problem, t)}
          >
            <TextInput
              value={route}
              placeholder={suggested}
              disabled={profileDisabled}
              onChange={(value) => {
                setRoute(value)
                setRouteTouched(true)
                setFailure(undefined)
              }}
            />
          </Field>
        </div>
        <span className="dsl-hint">{t(PRESET_DESCRIPTION[preset])}</span>
      </div>

      <div className="dsl-grid">
        <SelectField<InterfaceType>
          label={t('protocol')}
          value={interfaceType}
          options={PROTOCOL_OPTIONS.map(option => ({ value: option.value, label: t(option.label) }))}
          disabled={profileDisabled}
          onChange={(value) => {
            setInterfaceType(value === '' ? 'openai-chat-completions' : value)
            setProbe({ kind: 'idle' })
          }}
        />
        <Field label={t('baseURL')} hint={t('baseURLHint')} error={baseUrlInvalid ? t('baseURLInvalid') : undefined}>
          <TextInput
            value={baseURL}
            placeholder={t('baseURLPlaceholder')}
            disabled={profileDisabled}
            type="url"
            onChange={(value) => {
              setBaseURL(value)
              setProbe({ kind: 'idle' })
            }}
          />
        </Field>
      </div>

      <Field
        label={t('secret')}
        hint={keyValue.length === 0 ? t('keyOptionalHint') : t('keyHelp')}
      >
        <TextInput
          type="password"
          value={keyDraft}
          placeholder={t('secretPlaceholder')}
          disabled={blocked}
          onChange={(value) => {
            setKeyDraft(value)
            setProbe({ kind: 'idle' })
          }}
        />
      </Field>
      <p className="dsl-hint">{t('apiKeyRefHint')} <code className="dsl-code">{keyRef}</code></p>

      <div className="dsl-row">
        <ActionButton
          small
          outline
          disabled={blocked || committed || probe.kind === 'busy'
            || normalizedBaseURL.length === 0 || baseUrlInvalid || props.onDiscover === undefined}
          onClick={() => { void probeEndpoint() }}
        >
          {probe.kind === 'busy' ? t('connectionTesting') : t('connectionTest')}
        </ActionButton>
        {probe.kind === 'ok'
          ? (
            <Chip tone="success">
              {t('connectionModels', { count: String(probe.count) })} · {t('connectionLatency', { ms: String(probe.latencyMs) })}
            </Chip>
          )
          : probe.kind === 'failed'
            ? <span role="alert" className="dsl-error">{t('connectionFailed', { message: probe.message })}</span>
            : <span className="dsl-hint">{t('connectionHint')}</span>}
      </div>
      {failure === undefined ? null : <p role="alert" className="dsl-error">{failure}</p>}
      <div className="dsl-footer">
        <ActionButton primary disabled={blocked || !ready} onClick={() => { void create() }}>
          {busy ? t('saving') : t('create')}
        </ActionButton>
        <ActionButton outline disabled={busy} onClick={reset}>{t('cancel')}</ActionButton>
      </div>
    </section>
  )
}
