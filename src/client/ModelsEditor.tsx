/**
 * One provider's model catalog: a compact filterable list, one expanded model
 * editor, endpoint discovery, and the documented family defaults that make a
 * bare model id usable without hand-writing capability declarations.
 *
 * @module @snnh/dsh-llm-service-lite/client/ModelsEditor
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { ServiceLiteKey } from './locales.ts'
import type { ServiceLiteTranslate } from './types.ts'
import { applyModelDefaults } from './family-defaults.ts'
import { declaredDefaultsOf } from '../model-defaults.ts'
import { applyPatch, capabilitiesOf, modelsOf, toggleListValue } from './model.ts'
import {
  EFFORT_LEVELS,
  MODALITIES,
  THINKING_MODES,
  THINKING_STYLES,
  type CapabilitiesPatch,
  type ClientModel,
  type ClientProvider,
  type DiscoveryOutcome,
  type DiscoveryRequest,
  type EffortLevel,
  type InterfaceType,
  type ModelCapabilities,
  type ModelPatch,
  type Modality,
  type ProviderPatch,
  type ThinkingMode,
  type ThinkingStyle,
} from './types.ts'
import {
  ActionButton,
  Chip,
  ChoiceChip,
  Field,
  IntegerField,
  PageStyle,
  TextInput,
  Toggle,
} from './ui.tsx'

/** The label each effort level is shown under. */
const EFFORT_LABEL: Readonly<Record<EffortLevel, ServiceLiteKey>> = {
  minimal: 'effortMinimal',
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
  xhigh: 'effortXhigh',
  max: 'effortMax',
  ultra: 'effortUltra',
}

/** The label each thinking mode is shown under. */
const THINKING_LABEL: Readonly<Record<ThinkingMode, 'thinkingAdaptive' | 'thinkingEnabled' | 'thinkingDisabled'>> = {
  adaptive: 'thinkingAdaptive',
  enabled: 'thinkingEnabled',
  disabled: 'thinkingDisabled',
}

/** The label each thinking-switch spelling is shown under. */
const THINKING_STYLE_LABEL: Readonly<Record<ThinkingStyle, ServiceLiteKey>> = {
  thinking: 'thinkingStyleThinking',
  fixed: 'thinkingStyleFixed',
  enable_thinking: 'thinkingStyleEnableThinking',
  effort_only: 'thinkingStyleEffortOnly',
}

/** Props one provider's model editor receives. */
export interface ModelsEditorProps {
  /** Route id the models belong to. */
  readonly route: string
  /** The staged profile. */
  readonly provider: ClientProvider
  /** Page dictionary. */
  readonly t: ServiceLiteTranslate
  /** Whether the form accepts edits. */
  readonly disabled: boolean
  /** Stage a patch onto this profile. */
  readonly onPatch: (patch: ProviderPatch) => void
  /** Ask the endpoint for its models, with the draft's endpoint facts. */
  readonly onDiscover: (request: DiscoveryRequest) => Promise<DiscoveryOutcome>
}

/** Format a token capacity compactly for a summary chip. */
function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${String(Number((value / 1_000_000).toFixed(1)))}M`
  if (value >= 1_000) return `${String(Math.round(value / 1_000))}K`
  return String(value)
}

/** The documented capabilities for one model id, when the family table knows it. */
function suggestedCapabilities(id: string, protocol: InterfaceType | undefined): ModelCapabilities | undefined {
  const trimmed = id.trim()
  if (trimmed.length === 0) return undefined
  const declared = declaredDefaultsOf(trimmed, protocol)
  return declared?.capabilities as unknown as ModelCapabilities | undefined
}

/** Whether a profile field is absent, including a schema-materialized empty list. */
function isUnset(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0)
}

/** Whether any documented capability is still absent from the model. */
function hasMissingSuggestion(current: ModelCapabilities, suggested: ModelCapabilities | undefined): boolean {
  if (suggested === undefined) return false
  return (['modalities', 'effort', 'thinking', 'thinkingStyle', 'reasoningContent', 'replayReasoning'] as const)
    .some(key => isUnset(current[key]) && suggested[key] !== undefined)
}

/**
 * Render one provider's model catalog.
 * @param props - the staged profile and its staging callbacks.
 * @returns the catalog, discovery panel, and selected model editor.
 */
export function ModelsEditor(props: ModelsEditorProps): ReactNode {
  const { provider, t, disabled } = props
  const models = modelsOf(provider)
  const protocol = provider.interfaceType
  const headingId = useId()
  const searchId = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<number | undefined>(undefined)
  const [discovered, setDiscovered] = useState<readonly ClientModel[] | undefined>(undefined)
  const [message, setMessage] = useState<{ readonly kind: 'status' | 'error'; readonly text: string } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [defaultsNotice, setDefaultsNotice] = useState<string | undefined>(undefined)
  const detailRef = useRef<HTMLDivElement>(null)
  const write = (next: ClientModel[]): void => { props.onPatch({ models: next }) }
  const patchModel = (index: number, patch: ModelPatch): void => {
    write(models.map((model, position) => (position === index ? applyPatch(model, patch) : model)))
  }
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visible = models
    .map((model, index) => ({ model, index }))
    .filter(({ model }) => normalizedQuery.length === 0
      || model.id.toLocaleLowerCase().includes(normalizedQuery)
      || (model.name ?? '').toLocaleLowerCase().includes(normalizedQuery))
  const selectedModel = selected === undefined ? undefined : models[selected]
  const selectedSuggested = selectedModel === undefined
    ? undefined
    : suggestedCapabilities(selectedModel.id, protocol)
  const pendingDefaults = models.filter(model => hasMissingSuggestion(
    capabilitiesOf(model),
    suggestedCapabilities(model.id, protocol),
  )).length
  // A row below the fold would otherwise require a manual scroll to the editor
  // it just opened.
  useEffect(() => {
    if (selected !== undefined) detailRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  const candidates = (discovered ?? []).filter(candidate => !models.some(model => model.id === candidate.id))
  const discover = async (): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    setDiscovered(undefined)
    try {
      const request: DiscoveryRequest = {
        provider: props.route,
        ...provider.baseURL === undefined ? {} : { baseURL: provider.baseURL },
        ...provider.interfaceType === undefined ? {} : { api: provider.interfaceType },
      }
      const outcome = await props.onDiscover(request)
      if (outcome.kind === 'refused') {
        setMessage({ kind: 'error', text: t('discoveryRefused', { message: outcome.message }) })
      } else if (outcome.models.length === 0) {
        setMessage({ kind: 'status', text: t('discoveryEmpty') })
      } else {
        setDiscovered(outcome.models.map(model => ({
          id: model.id,
          ...model.name === undefined ? {} : { name: model.name },
          ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
          ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
        })))
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setMessage({ kind: 'error', text: t('discoveryRefused', { message: detail }) })
    } finally {
      setBusy(false)
    }
  }
  const add = (candidate: ClientModel): void => {
    setSelected(models.length)
    write([...models, candidate])
  }
  const addBlank = (): void => {
    setSelected(models.length)
    write([...models, { id: '' }])
  }
  const applyDefaults = (): void => {
    const outcome = applyModelDefaults(provider)
    const filled = outcome.applied.filter(item => item.fields.length > 0).length
    if (filled === 0) {
      setDefaultsNotice(t('modelDefaultsNone'))
      return
    }
    props.onPatch({ models: outcome.models })
    setDefaultsNotice(outcome.unmatched.length === 0
      ? t('modelDefaultsApplied', { count: String(filled) })
      : t('modelDefaultsAppliedSome', { count: String(filled), unmatched: String(outcome.unmatched.length) }))
  }
  const remove = (index: number): void => {
    write(models.filter((_entry, position) => position !== index))
    if (selected === index) setSelected(undefined)
    else if (selected !== undefined && selected > index) setSelected(selected - 1)
  }
  return (
    <div className="dsl-root dsl-models">
      <PageStyle />
      <div className="dsl-card-head">
        <div>
          <div className="dsl-section-head">
            <h5 id={headingId} className="dsl-section-title">{t('modelsTitle')}</h5>
            <Chip>{t('modelCount', { count: String(models.length) })}</Chip>
            {pendingDefaults === 0
              ? null
              : <Chip tone="danger">{t('modelDefaultsPending', { count: String(pendingDefaults) })}</Chip>}
          </div>
          <p className="dsl-card-sub">{t('modelsHint')}</p>
        </div>
        <div className="dsl-row">
          <ActionButton small outline disabled={disabled} onClick={addBlank}>{t('addModel')}</ActionButton>
          <ActionButton small outline disabled={disabled || busy} onClick={() => { void discover() }}>
            {busy ? t('discoveryFetching') : t('discoveryTitle')}
          </ActionButton>
        </div>
      </div>

      <div className="dsl-row">
        <label htmlFor={searchId} className="dsl-hint" style={{ flex: '0 0 auto' }}>{t('searchModels')}</label>
        <div style={{ flex: '1 1 150px', minWidth: 0 }}>
          <input
            id={searchId}
            className="dsl-input"
            value={query}
            placeholder={t('searchModelsPlaceholder')}
            disabled={disabled}
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </div>
        <ActionButton small outline disabled={disabled} onClick={applyDefaults}>
          {t('modelDefaults')}
        </ActionButton>
      </div>
      <p className="dsl-hint">{t('modelDefaultsHint')}</p>
      {defaultsNotice === undefined ? null : <div className="dsl-note dsl-note--info" role="status">{defaultsNotice}</div>}
      {pendingDefaults === 0
        ? null
        : (
          <div className="dsl-note dsl-note--info">
            <div>
              <strong>{t('modelDefaultsPending', { count: String(pendingDefaults) })}</strong>
              <span className="dsl-hint">{t('modelDefaultsHint')}</span>
            </div>
          </div>
        )}

      {models.length === 0
        ? (
          <div className="dsl-empty">
            <span className="dsl-empty-title">{t('modelsEmptyTitle')}</span>
            <span className="dsl-empty-hint">{t('modelsEmpty')}</span>
            <div className="dsl-row">
              <ActionButton small primary disabled={disabled} onClick={addBlank}>{t('addModel')}</ActionButton>
              <ActionButton small outline disabled={disabled || busy} onClick={() => { void discover() }}>
                {t('discoveryFetch')}
              </ActionButton>
            </div>
          </div>
        )
        : visible.length === 0
          ? <div className="dsl-note">{t('modelsFilteredEmpty')}</div>
          : (
            <div className="dsl-model-list" aria-labelledby={headingId}>
              {visible.map(({ model, index }) => {
                const capabilities = capabilitiesOf(model)
                return (
                  <button
                    key={index}
                    type="button"
                    className="dsl-model"
                    data-selected={selected === index}
                    aria-expanded={selected === index}
                    onClick={() => { setSelected(selected === index ? undefined : index) }}
                  >
                    <span className="dsl-model-main">
                      <span className="dsl-model-id">{model.id.trim().length === 0 ? t('modelUntitled') : model.id}</span>
                      {model.name === undefined || model.name.trim().length === 0
                        ? null
                        : <span className="dsl-model-name">{model.name}</span>}
                    </span>
                    <span className="dsl-model-facts">
                      {model.contextWindow === undefined ? null : <Chip>{compactTokens(model.contextWindow)}</Chip>}
                      {(capabilities.effort ?? []).length === 0
                        ? null
                        : <Chip on>{t('reasoningCount', { count: String(capabilities.effort?.length ?? 0) })}</Chip>}
                      {capabilities.tools === false ? <Chip>{t('toolsOff')}</Chip> : null}
                      {(capabilities.effort ?? []).length === 0 && suggestedCapabilities(model.id, protocol)?.effort === undefined
                        ? <Chip>{t('effortUnsetShort')}</Chip>
                        : null}
                      {capabilities.imageOutput === true ? <Chip>{t('modelImageShort')}</Chip> : null}
                    </span>
                    <span className="dsl-chevron" aria-hidden="true">{selected === index ? '−' : '›'}</span>
                  </button>
                )
              })}
            </div>
          )}

      {discovered === undefined
        ? null
        : (
          <section className="dsl-discovery" aria-busy={busy}>
            <div className="dsl-card-head">
              <div>
                <strong className="dsl-section-title">{t('discoveryFound', { count: String(discovered.length) })}</strong>
                <p className="dsl-card-sub">{t('discoveryHint')}</p>
              </div>
              <div className="dsl-row">
                {candidates.length === 0
                  ? null
                  : (
                    <ActionButton
                      small
                      primary
                      disabled={disabled || busy}
                      onClick={() => { write([...models, ...candidates]) }}
                    >
                      {t('discoveryAddAll')}
                    </ActionButton>
                  )}
                <ActionButton small quiet onClick={() => { setDiscovered(undefined); setMessage(undefined) }}>
                  {t('close')}
                </ActionButton>
              </div>
            </div>
            {message === undefined ? null : (
              <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'dsl-error' : 'dsl-hint'}>
                {message.text}
              </p>
            )}
            {candidates.length === 0
              ? <p className="dsl-hint" role="status">{t('discoveryAllAdded')}</p>
              : (
                <div className="dsl-candidates">
                  {candidates.map((candidate, position) => (
                    <div key={`${candidate.id}:${String(position)}`} className="dsl-candidate">
                      <span className="dsl-candidate-id">{candidate.id}</span>
                      {candidate.contextWindow === undefined
                        ? null
                        : <span className="dsl-candidate-meta">{compactTokens(candidate.contextWindow)}</span>}
                      <ActionButton small outline disabled={disabled || busy} onClick={() => { add(candidate) }}>
                        {t('discoveryAdd')}
                      </ActionButton>
                    </div>
                  ))}
                </div>
              )}
          </section>
        )}

      {message !== undefined && discovered === undefined
        ? <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'dsl-error' : 'dsl-hint'}>{message.text}</p>
        : null}

      <div ref={detailRef}>
        {selectedModel === undefined
          ? null
          : (
            <ModelDetail
              model={selectedModel}
              models={models}
              index={selected ?? 0}
              protocol={protocol}
              suggested={selectedSuggested}
              t={t}
              disabled={disabled}
              onPatch={(patch) => { patchModel(selected ?? 0, patch) }}
              onRemove={() => { remove(selected ?? 0) }}
              onClose={() => { setSelected(undefined) }}
            />
          )}
      </div>
    </div>
  )
}

/** One selected model's full editor. */
function ModelDetail(props: {
  readonly model: ClientModel
  readonly models: readonly ClientModel[]
  readonly index: number
  readonly protocol: InterfaceType | undefined
  readonly suggested: ModelCapabilities | undefined
  readonly t: ServiceLiteTranslate
  readonly disabled: boolean
  readonly onPatch: (patch: ModelPatch) => void
  readonly onRemove: () => void
  readonly onClose: () => void
}): ReactNode {
  const { model, t, disabled, suggested } = props
  const capabilities = capabilitiesOf(model)
  const duplicate = model.id.length > 0
    && props.models.some((other, position) => position !== props.index && other.id === model.id)
  const idError = model.id.length === 0
    ? t('modelIdRequired')
    : duplicate ? t('modelDuplicate', { model: model.id }) : undefined
  const setCapabilities = (patch: CapabilitiesPatch): void => {
    const next = applyPatch(capabilities, patch)
    for (const key of ['modalities', 'effort', 'thinking'] as const) {
      if (next[key] !== undefined && next[key]?.length === 0) delete next[key]
    }
    props.onPatch({ capabilities: next })
  }
  const fillSuggested = (): void => {
    if (suggested === undefined) return
    const next: ModelCapabilities = { ...capabilities }
    if (isUnset(next.modalities) && suggested.modalities !== undefined) next.modalities = [...suggested.modalities]
    if (isUnset(next.effort) && suggested.effort !== undefined) next.effort = [...suggested.effort]
    if (isUnset(next.thinking) && suggested.thinking !== undefined) next.thinking = [...suggested.thinking]
    if (isUnset(next.thinkingStyle) && suggested.thinkingStyle !== undefined) next.thinkingStyle = suggested.thinkingStyle
    if (isUnset(next.reasoningContent) && suggested.reasoningContent !== undefined) next.reasoningContent = suggested.reasoningContent
    if (isUnset(next.replayReasoning) && suggested.replayReasoning !== undefined) next.replayReasoning = suggested.replayReasoning
    props.onPatch({ capabilities: next })
  }
  return (
    <section className="dsl-editor" aria-label={t('editModel')}>
      <div className="dsl-editor-head">
        <div className="dsl-editor-title">
          <strong className="dsl-editor-id">{model.id.trim().length === 0 ? t('modelUntitled') : model.id}</strong>
          <span className="dsl-hint">{t('editModel')}</span>
        </div>
        <div className="dsl-row">
          <ActionButton small quiet disabled={disabled} onClick={props.onClose}>{t('close')}</ActionButton>
          <ActionButton small danger disabled={disabled} onClick={props.onRemove}>{t('removeModel')}</ActionButton>
        </div>
      </div>

      <div className="dsl-grid">
        <Field label={t('modelId')} error={idError}>
          <TextInput
            value={model.id}
            placeholder={t('modelIdPlaceholder')}
            disabled={disabled}
            onChange={(value) => { props.onPatch({ id: value }) }}
          />
        </Field>
        <Field label={t('modelName')}>
          <TextInput
            value={model.name ?? ''}
            disabled={disabled}
            onChange={(value) => { props.onPatch({ name: value === '' ? undefined : value }) }}
          />
        </Field>
        <IntegerField
          label={t('contextWindow')}
          value={model.contextWindow}
          hint={t('modelBudgetHint')}
          disabled={disabled}
          onChange={(value) => { props.onPatch({ contextWindow: value }) }}
        />
        <IntegerField
          label={t('maxTokens')}
          value={model.maxTokens}
          disabled={disabled}
          onChange={(value) => { props.onPatch({ maxTokens: value }) }}
        />
      </div>

      <div className="dsl-cap">
        <div className="dsl-row" style={{ justifyContent: 'space-between' }}>
          <strong className="dsl-cap-title">{t('capabilities')}</strong>
          {suggested !== undefined && hasMissingSuggestion(capabilities, suggested)
            ? <ActionButton small quiet disabled={disabled} onClick={fillSuggested}>{t('useRecommended')}</ActionButton>
            : null}
        </div>

        <div className="dsl-cap-row">
          <span className="dsl-cap-label">{t('modalities')}</span>
          <div className="dsl-cap-options">
            {MODALITIES.map((modality: Modality) => (
              <ChoiceChip
                key={modality}
                label={t(modality === 'text' ? 'modalityText' : modality === 'image' ? 'modalityImage' : 'modalityVideo')}
                selected={(capabilities.modalities ?? []).includes(modality)}
                disabled={disabled}
                onToggle={() => { setCapabilities({ modalities: toggleListValue(capabilities.modalities, modality, MODALITIES) }) }}
              />
            ))}
          </div>
        </div>

        <div className="dsl-cap-row">
          <span className="dsl-cap-label">{t('effort')}</span>
          <div className="dsl-cap-options">
            {EFFORT_LEVELS.map((level: EffortLevel) => (
              <ChoiceChip
                key={level}
                label={t(EFFORT_LABEL[level])}
                selected={(capabilities.effort ?? []).includes(level)}
                disabled={disabled}
                title={level}
                onToggle={() => { setCapabilities({ effort: toggleListValue(capabilities.effort, level, EFFORT_LEVELS) }) }}
              />
            ))}
          </div>
        </div>
        <span className="dsl-cap-hint">{t('effortHint')}</span>
        {(capabilities.effort ?? []).length === 0
          ? (
            <span className="dsl-hint">
              {suggested?.effort === undefined
                ? t('effortEmptyHint')
                : t('effortRecommendation', { levels: suggested.effort.map(level => t(EFFORT_LABEL[level])).join(' / ') })}
            </span>
          )
          : null}

        <div className="dsl-cap-row">
          <span className="dsl-cap-label">{t('thinking')}</span>
          <div className="dsl-cap-options">
            {THINKING_MODES.map((mode: ThinkingMode) => (
              <ChoiceChip
                key={mode}
                label={t(THINKING_LABEL[mode])}
                selected={(capabilities.thinking ?? []).includes(mode)}
                disabled={disabled}
                onToggle={() => { setCapabilities({ thinking: toggleListValue(capabilities.thinking, mode, THINKING_MODES) }) }}
              />
            ))}
          </div>
        </div>
        <span className="dsl-cap-hint">{t('thinkingHint')}</span>

        <div className="dsl-cap-row">
          <span className="dsl-cap-label">{t('thinkingStyle')}</span>
          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
            <select
              className="dsl-select"
              aria-label={t('thinkingStyle')}
              value={capabilities.thinkingStyle ?? ''}
              disabled={disabled}
              onChange={(event) => {
                const value = event.target.value
                setCapabilities({ thinkingStyle: value === '' ? undefined : (value as ThinkingStyle) })
              }}
            >
              <option value="">{t('thinkingStyleDefault')}</option>
              {THINKING_STYLES.map(style => (
                <option key={style} value={style}>{t(THINKING_STYLE_LABEL[style])}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="dsl-stack" style={{ gap: 8 }}>
          <Toggle
            label={t('reasoningContent')}
            checked={capabilities.reasoningContent === true}
            disabled={disabled}
            onChange={(checked) => { setCapabilities({ reasoningContent: checked ? true : undefined }) }}
          />
          <Toggle
            label={t('tools')}
            checked={capabilities.tools !== false}
            disabled={disabled}
            onChange={(checked) => { setCapabilities({ tools: checked ? undefined : false }) }}
          />
          {props.protocol === 'anthropic-messages'
            ? null
            : (
              <Toggle
                label={t('imageOutput')}
                checked={capabilities.imageOutput === true}
                hint={t('imageOutputHint')}
                disabled={disabled}
                onChange={(checked) => { setCapabilities({ imageOutput: checked ? true : undefined }) }}
              />
            )}
          {props.protocol === 'openai-responses'
            ? (
              <Toggle
                label={t('responsesEncryptedReplay')}
                checked={capabilities.responsesEncryptedReplay === true}
                disabled={disabled}
                onChange={(checked) => { setCapabilities({ responsesEncryptedReplay: checked ? true : undefined }) }}
              />
            )
            : null}
        </div>
        {suggested === undefined || !hasMissingSuggestion(capabilities, suggested)
          ? null
          : (
            <div className="dsl-note">
              <strong>{t('recommendedCapabilities')}</strong>
              <span>{suggested.effort === undefined ? t('noRecommendation') : suggested.effort.map(level => t(EFFORT_LABEL[level])).join(' / ')}</span>
            </div>
          )}
      </div>
    </section>
  )
}
