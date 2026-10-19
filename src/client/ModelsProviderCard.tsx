/**
 * The Models page's per-provider configuration seat for this adapter family.
 *
 * The seat is the sanctioned extension point on the stock Models page: it is
 * handed every card of this family and renders the real provider editor —
 * protocol, endpoint, credential reference, request behavior, and the model
 * catalog — inside the page's own provider card.
 *
 * @module @snnh/dsh-llm-service-lite/client/ModelsProviderCard
 */

import { useId, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  applyPatch,
  interfaceTypeOf,
  modelsOf,
  problemText,
  protocolLabelKey,
  validateConfig,
} from './model.ts'
import { providerRemovable } from './provider-ops.ts'
import type { ServiceLiteModelsFace } from './models-controller.ts'
import type {
  ClientProvider,
  DiscoveryOutcome,
  DiscoveryRequest,
  ProfileProblem,
  ProviderPatch,
} from './types.ts'
import type { ServiceLiteTranslate } from './types.ts'
import { ModelsEditor } from './ModelsEditor.tsx'
import { ProviderFields } from './ProviderFields.tsx'
import { ActionButton, Chip, PageStyle, styles } from './ui.tsx'

/** Props the Models page injects into the provider-card seat. */
export type ModelsProviderCardProps = PropsRuntime<'settings.models.provider-card'>
  & PropsLocale<'settings.llm-service-lite'>
  & InjectFace<ServiceLiteModelsFace>

/** Props the expanded per-provider editor renders from. */
export interface ProviderSeatEditorProps {
  /** The region id the card's disclosure button controls. */
  readonly id: string
  /** Route id this profile is filed under. */
  readonly route: string
  /** The staged profile. */
  readonly draft: ClientProvider
  /** Page dictionary. */
  readonly t: ServiceLiteTranslate
  /** Whether the editor accepts edits. */
  readonly disabled: boolean
  /** Whether an apply is crossing the wire. */
  readonly busy: boolean
  /** Pre-save validation findings; a non-empty list blocks the apply. */
  readonly problems: readonly ProfileProblem[]
  /** Stage a patch onto the staged profile. */
  readonly onPatch: (patch: ProviderPatch) => void
  /** Store one credential literal; resolves to the refusal message. */
  readonly onStoreKey: (ref: string, value: string) => Promise<string | undefined>
  /** Ask the endpoint for its models. */
  readonly onDiscover: (request: DiscoveryRequest) => Promise<DiscoveryOutcome>
  /** Write the staged profile. */
  readonly onApply: () => void
  /** Drop the staged profile. */
  readonly onDiscard: () => void
}

/**
 * The expanded per-provider editor, presentational so it can be rendered (and
 * tested) without the seat's state machine.
 * @param props - the staged profile and its actions.
 * @returns the field groups, the model catalog, and the apply footer.
 */
export function ProviderSeatEditor(props: ProviderSeatEditorProps): ReactNode {
  const { t, draft } = props
  const [extraBodyInvalid, setExtraBodyInvalid] = useState(false)
  return (
    <div id={props.id} className="dsl-root dsl-seat">
      <PageStyle />
      <ProviderFields
        route={props.route}
        provider={draft}
        t={t}
        disabled={props.disabled}
        onPatch={props.onPatch}
        onStoreKey={props.onStoreKey}
        onDiscover={props.onDiscover}
        onExtraBodyValidity={setExtraBodyInvalid}
      />
      <ModelsEditor
        route={props.route}
        provider={draft}
        t={t}
        disabled={props.disabled}
        onPatch={props.onPatch}
        onDiscover={props.onDiscover}
      />
      {props.problems.length === 0
        ? null
        : (
          <div className="dsl-note dsl-note--danger" role="alert">
            <div className="dsl-stack">
              {props.problems.map((problem, index) => (
                <span key={`${problem.path}:${problem.key}:${String(index)}`}>
                  <code className="dsl-code">{problem.path}</code> — {problemText(problem, t)}
                </span>
              ))}
            </div>
          </div>
        )}
      <div className="dsl-footer">
        <ActionButton
          primary
          disabled={props.disabled || props.busy || props.problems.length > 0 || extraBodyInvalid}
          onClick={props.onApply}
        >
          {props.busy ? t('applying') : t('apply')}
        </ActionButton>
        <ActionButton outline disabled={props.busy} onClick={props.onDiscard}>{t('cancel')}</ActionButton>
      </div>
    </div>
  )
}

/**
 * Render one card's configuration seat: what the route is at a glance, the
 * configure disclosure, and the expanded editor.
 * @param props - the Models page owner props, dictionary, and settings face.
 * @returns the seat, or nothing while the settings form is unavailable.
 */
export function ModelsProviderCard(props: ModelsProviderCardProps): ReactNode {
  const { t, provider } = props
  const route = provider.provider
  const settings = props.useServiceLiteSettings(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ClientProvider | undefined>(undefined)
  const [stagedRevision, setStagedRevision] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const bodyId = useId()
  const resolved = settings.value?.providers[route]
  if (settings.status !== 'ready' || resolved === undefined) return null
  const disabled = !settings.writable || busy
  const removable = providerRemovable(route, settings.base, settings.user)
  const models = modelsOf(resolved)
  const protocol = interfaceTypeOf(resolved)
  const problems = draft === undefined ? [] : validateConfig({ providers: { [route]: draft } })
  const start = (): void => {
    setFailure(undefined)
    setSaved(false)
    setConfirmRemove(false)
    setStagedRevision(settings.revision)
    setDraft(structuredClone(resolved))
    setOpen(true)
  }
  const close = (): void => {
    if (busy) return
    setOpen(false)
    setDraft(undefined)
    setFailure(undefined)
    setConfirmRemove(false)
  }
  const edit = (patch: ProviderPatch): void => {
    setDraft(current => current === undefined ? current : applyPatch(current, patch))
  }
  const apply = async (): Promise<void> => {
    if (draft === undefined || problems.length > 0) return
    setBusy(true)
    setFailure(undefined)
    try {
      const outcome = await props.writeProvider(route, draft, stagedRevision)
      if (outcome.kind === 'written') {
        setSaved(true)
        setOpen(false)
        setDraft(undefined)
        setStagedRevision(undefined)
      } else {
        setFailure(outcome.kind === 'conflict' ? t('conflict') : t('saveFailed'))
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const outcome = await props.removeProvider(route, settings.revision)
      if (outcome.kind === 'written') {
        setConfirmRemove(false)
        close()
      } else {
        setFailure(outcome.kind === 'conflict' ? t('conflict') : t('saveFailed'))
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="dsl-root dsl-seat" aria-label={t('modelsCardCaption')}>
      <PageStyle />
      <div className="dsl-seat-head">
        <span className="dsl-seat-caption">{t('modelsCardCaption')}</span>
        {protocol === undefined ? null : <Chip>{t(protocolLabelKey(protocol))}</Chip>}
        <Chip>{t('modelCount', { count: String(models.length) })}</Chip>
        <Chip tone={props.keyConfigured ? 'success' : 'danger'}>
          {props.keyConfigured ? t('modelsCardKeyConfigured') : t('modelsCardKeyMissing')}
        </Chip>
        <span style={styles['grow']} />
        <ActionButton
          small
          primary={!open}
          outline={open}
          disabled={disabled}
          ariaExpanded={open}
          ariaControls={bodyId}
          onClick={open ? close : start}
        >
          {open ? t('close') : t('modelsCardConfigure')}
        </ActionButton>
        {removable && !open
          ? (
            <ActionButton small danger disabled={disabled} onClick={() => { setConfirmRemove(true) }}>
              {t('modelsCardRemove')}
            </ActionButton>
          )
          : null}
      </div>
      <p className="dsl-hint">{t('modelsCardHint')}</p>
      {settings.writable ? null : <p className="dsl-hint">{t('readOnly')}</p>}
      {saved ? <p role="status" className="dsl-success">{t('modelsCardApplied')}</p> : null}
      {failure === undefined ? null : <p role="alert" className="dsl-error">{failure}</p>}
      {confirmRemove
        ? (
          <div className="dsl-note dsl-note--danger" role="alert">
            <div className="dsl-stack" style={styles['grow']}>
              <strong>{t('modelsCardRemoveConfirm', { route })}</strong>
              <span>{t('modelsCardRemoveHint')}</span>
            </div>
            <div className="dsl-row">
              <ActionButton small danger disabled={busy} onClick={() => { void remove() }}>{t('modelsCardRemove')}</ActionButton>
              <ActionButton small quiet disabled={busy} onClick={() => { setConfirmRemove(false) }}>{t('cancel')}</ActionButton>
            </div>
          </div>
        )
        : null}
      {open && draft !== undefined
        ? (
          <ProviderSeatEditor
            id={bodyId}
            route={route}
            draft={draft}
            t={t}
            disabled={disabled}
            busy={busy}
            problems={problems}
            onPatch={edit}
            onStoreKey={props.storeKey}
            onDiscover={props.discover}
            onApply={() => { void apply() }}
            onDiscard={close}
          />
        )
        : null}
    </section>
  )
}
