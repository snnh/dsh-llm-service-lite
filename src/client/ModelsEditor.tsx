/**
 * One provider's model list: the declared ids and capacities, the capability
 * declarations a request path reads, and the endpoint's own model listing.
 *
 * @module @snnh/dsh-llm-service-lite/client/ModelsEditor
 */

import { useId, useState, type ReactNode } from 'react'
import type { ServiceLiteTranslate } from './types.ts'
import { applyPatch, capabilitiesOf, modelsOf, splitList, toggleListValue } from './model.ts'
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
  type ModelPatch,
  type Modality,
  type ProviderPatch,
  type ThinkingMode,
  type ThinkingStyle,
} from './types.ts'
import { ActionButton, Chip, Field, IntegerField, SelectField, TextInput, Toggle, styles } from './ui.tsx'

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

/**
 * Render one provider's model list.
 * @param props - the staged profile and its staging callbacks.
 * @returns the model editor.
 */
export function ModelsEditor(props: ModelsEditorProps): ReactNode {
  const { provider, t, disabled } = props
  const models = modelsOf(provider)
  const protocol = provider.interfaceType
  const headingId = useId()
  const discoveryId = useId()
  const write = (next: ClientModel[]): void => { props.onPatch({ models: next }) }
  const patchModel = (index: number, patch: ModelPatch): void => {
    write(models.map((model, position) => (position === index ? applyPatch(model, patch) : model)))
  }
  const [discovered, setDiscovered] = useState<readonly ClientModel[] | undefined>(undefined)
  const [message, setMessage] = useState<{ readonly kind: 'status' | 'error'; readonly text: string } | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // The row a click just created gets the focus once it mounts; index-based keys keep the input mounted while its id is typed.
  const [focusIndex, setFocusIndex] = useState<number | undefined>(undefined)
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
  const candidates = (discovered ?? []).filter(candidate => !models.some(model => model.id === candidate.id))
  const add = (candidate: ClientModel): void => { write([...models, candidate]) }
  const addBlank = (): void => {
    setFocusIndex(models.length)
    write([...models, { id: '' }])
  }
  return (
    <section aria-labelledby={headingId} style={styles['cardBody']}>
      <div style={styles['inline']}>
        <h5 id={headingId} style={styles['groupTitle']}>{t('modelsTitle')}</h5>
        <Chip>{t('modelCount', { count: String(models.length) })}</Chip>
      </div>
      {models.length === 0 ? <p style={styles['muted']}>{t('modelsEmpty')}</p> : null}
      {models.map((model, index) => (
        <ModelCard
          key={index}
          model={model}
          models={models}
          index={index}
          protocol={protocol}
          t={t}
          disabled={disabled}
          autoFocus={focusIndex === index}
          onPatch={(patch) => { patchModel(index, patch) }}
          onRemove={() => { write(models.filter((_entry, position) => position !== index)) }}
        />
      ))}
      <div style={styles['inline']}>
        <ActionButton disabled={disabled} onClick={addBlank}>{t('addModel')}</ActionButton>
      </div>

      <section aria-labelledby={discoveryId} aria-busy={busy} style={styles['result']}>
        <div style={styles['inline']}>
          <h6 id={discoveryId} style={styles['subhead']}>{t('discoveryTitle')}</h6>
          <ActionButton disabled={disabled || busy} onClick={() => { void discover() }}>
            {busy ? t('discoveryFetching') : t('discoveryFetch')}
          </ActionButton>
        </div>
        <p style={styles['hint']}>{t('discoveryHint')}</p>
        {message === undefined
          ? null
          : (
            <p
              role={message.kind === 'error' ? 'alert' : 'status'}
              style={message.kind === 'error' ? styles['error'] : styles['muted']}
            >
              {message.text}
            </p>
          )}
        {discovered === undefined
          ? null
          : candidates.length === 0
            ? <p style={styles['muted']} role="status">{t('discoveryAllAdded')}</p>
            : (
              <div style={styles['result']}>
                <div style={styles['inline']}>
                  <strong style={styles['subhead']}>{t('discoveryFound', { count: String(discovered.length) })}</strong>
                  <span style={{ flex: 1 }} />
                  <ActionButton
                    disabled={disabled || busy}
                    onClick={() => { write([...models, ...candidates]) }}
                  >
                    {t('discoveryAddAll')}
                  </ActionButton>
                </div>
                <ul style={styles['candidateList']}>
                  {candidates.map((candidate, position) => (
                    <li key={`${candidate.id}:${String(position)}`} style={styles['candidateRow']}>
                      <span id={`${discoveryId}-candidate-${String(position)}`} style={styles['mono']}>{candidate.id}</span>
                      {candidate.name === undefined ? null : <span style={styles['muted']}>{candidate.name}</span>}
                      {candidate.contextWindow === undefined
                        ? null
                        : <span style={styles['muted']}>{String(candidate.contextWindow)}</span>}
                      <span style={{ flex: 1 }} />
                      <ActionButton
                        disabled={disabled || busy}
                        ariaDescribedBy={`${discoveryId}-candidate-${String(position)}`}
                        onClick={() => { add(candidate) }}
                      >
                        {t('discoveryAdd')}
                      </ActionButton>
                    </li>
                  ))}
                </ul>
              </div>
            )}
      </section>
    </section>
  )
}

/** One model card: identity, capacities, and the capability declarations the request path reads. */
function ModelCard(props: {
  readonly model: ClientModel
  readonly models: readonly ClientModel[]
  readonly index: number
  readonly protocol: InterfaceType | undefined
  readonly t: ServiceLiteTranslate
  readonly disabled: boolean
  readonly autoFocus: boolean
  readonly onPatch: (patch: ModelPatch) => void
  readonly onRemove: () => void
}): ReactNode {
  const { model, t, disabled, protocol } = props
  const capabilities = capabilitiesOf(model)
  const modalities = capabilities.modalities ?? []
  const modalitiesId = useId()
  const titleId = useId()
  const duplicate = model.id.length > 0
    && props.models.some((other, position) => position !== props.index && other.id === model.id)
  const idError = model.id.length === 0
    ? t('modelIdRequired')
    : duplicate ? t('modelDuplicate', { model: model.id }) : undefined
  const title = model.id.trim().length === 0 ? t('modelUntitled') : model.id
  const setCapabilities = (patch: CapabilitiesPatch): void => {
    const next = applyPatch(capabilities, patch)
    for (const key of ['modalities', 'effort', 'thinking'] as const) {
      if (next[key] !== undefined && next[key]?.length === 0) delete next[key]
    }
    props.onPatch({ capabilities: next })
  }
  return (
    <div style={styles['modelCard']}>
      <div style={styles['modelHead']}>
        <h6 id={titleId} style={styles['modelTitle']}>{title}</h6>
        <span style={{ flex: 1 }} />
        <ActionButton
          danger
          disabled={disabled}
          ariaDescribedBy={titleId}
          onClick={props.onRemove}
        >
          {t('removeModel')}
        </ActionButton>
      </div>
      <div style={styles['grid2']}>
        <Field label={t('modelId')} error={idError}>
          <TextInput
            value={model.id}
            placeholder={t('modelIdPlaceholder')}
            disabled={disabled}
            autoFocus={props.autoFocus}
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
      <div style={styles['capabilities']}>
        <p style={styles['subhead']}>{t('capabilities')}</p>
        <div role="group" aria-labelledby={modalitiesId} style={styles['inline']}>
          <span id={modalitiesId} style={styles['label']}>{t('modalities')}</span>
          {MODALITIES.map((modality: Modality) => (
            <label key={modality} style={styles['checkboxLabel']}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={modalities.includes(modality)}
                onChange={() => {
                  setCapabilities({ modalities: toggleListValue(modalities, modality, MODALITIES) })
                }}
              />
              {t(modality === 'text' ? 'modalityText' : modality === 'image' ? 'modalityImage' : 'modalityVideo')}
            </label>
          ))}
        </div>
        <div style={styles['grid2']}>
          <Field label={t('effort')} hint={t('effortHint')}>
            <TextInput
              value={(capabilities.effort ?? []).join(', ')}
              disabled={disabled}
              onChange={(value) => {
                const next = splitList(value).filter((entry): entry is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(entry))
                setCapabilities({ effort: next.length === 0 ? undefined : next })
              }}
            />
          </Field>
          <Field label={t('thinking')} hint={t('thinkingHint')}>
            <TextInput
              value={(capabilities.thinking ?? []).join(', ')}
              disabled={disabled}
              onChange={(value) => {
                const next = splitList(value).filter((entry): entry is ThinkingMode => (THINKING_MODES as readonly string[]).includes(entry))
                setCapabilities({ thinking: next.length === 0 ? undefined : next })
              }}
            />
          </Field>
          <SelectField
            label={t('thinkingStyle')}
            value={capabilities.thinkingStyle ?? ''}
            unsetLabel={t('thinkingStyleDefault')}
            options={THINKING_STYLES.map(style => ({ value: style, label: style }))}
            disabled={disabled}
            onChange={(value) => { setCapabilities({ thinkingStyle: value === '' ? undefined : (value as ThinkingStyle) }) }}
          />
        </div>
        <div style={styles['grid2']}>
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
          {/* The Anthropic Messages wire has no assistant image part. */}
          {protocol === 'anthropic-messages'
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
          {/* Only the Responses wire replays signed reasoning items. */}
          {protocol === 'openai-responses'
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
      </div>
    </div>
  )
}
