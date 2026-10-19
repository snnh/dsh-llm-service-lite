/**
 * Shared presentation helpers for the provider-configuration page.
 *
 * The controls are native elements with one scoped stylesheet. The plugin
 * bundle cannot import the shell's CSS modules, so every class below carries
 * fallbacks for hosts that expose only part of the `--dsw-*` token set. Keeping
 * the vocabulary local also keeps the server-rendered tests free of CSS-module
 * loaders.
 *
 * @module @snnh/dsh-llm-service-lite/client/ui
 */

import { createContext, useContext, useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react'

/** Layout styles that do not need a stylesheet class. */
export const styles: Readonly<Record<string, CSSProperties>> = {
  inline: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  between: { display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 },
  field: { display: 'grid', gap: 4 },
  muted: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #888)' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
  grow: { flex: 1 },
}

/**
 * One scoped stylesheet rendered with the page. Multiple surfaces may render
 * it; identical rules are harmless.
 * @returns the style element.
 */
export function PageStyle(): ReactNode {
  return <style>{PAGE_CSS}</style>
}

const PAGE_CSS = `
.dsl-root {
  --dsl-border: var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.26));
  --dsl-border-soft: var(--dsw-alias-border-l4, rgba(127, 127, 127, 0.16));
  --dsl-bg: var(--dsw-alias-bg-layer-1, transparent);
  --dsl-bg-soft: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.06));
  --dsl-bg-hover: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.1));
  --dsl-text: var(--dsw-alias-label-primary, inherit);
  --dsl-muted: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
  --dsl-primary: var(--dsw-alias-button-primary-fill, #1a1a1a);
  --dsl-on-primary: var(--dsw-alias-label-primary-foreground, #fff);
  --dsl-accent: var(--dsw-alias-state-business-primary, #4d6bfe);
  --dsl-danger: var(--dsw-alias-state-error-primary, #d33);
  --dsl-success: var(--dsw-alias-state-success-primary, #178a50);
  display: grid;
  gap: 14px;
  color: var(--dsl-text);
  font-size: 13px;
  line-height: 1.5;
}
.dsl-root *, .dsl-root *::before, .dsl-root *::after { box-sizing: border-box; }
.dsl-root h2, .dsl-root h3, .dsl-root h4, .dsl-root h5, .dsl-root h6, .dsl-root p { margin: 0; }
.dsl-root button, .dsl-root input, .dsl-root select, .dsl-root textarea { font: inherit; }

.dsl-page-head { display: grid; gap: 5px; padding: 2px 0 4px; }
.dsl-page-title { font-size: 18px; font-weight: 650; letter-spacing: -0.01em; }
.dsl-page-lead { font-size: 13px; color: var(--dsl-muted); }
.dsl-page-note { font-size: 12px; color: var(--dsl-muted); }

.dsl-card {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--dsl-border);
  border-radius: 12px;
  background: var(--dsl-bg);
}
.dsl-card--flat { padding: 0; border: 0; background: transparent; }
.dsl-card-head { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; }
.dsl-card-title { font-size: 13px; font-weight: 650; }
.dsl-card-sub { margin-top: 2px; font-size: 12px; color: var(--dsl-muted); }
.dsl-card-body { display: grid; gap: 12px; }

.dsl-section-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dsl-section-title { font-size: 12px; font-weight: 650; letter-spacing: 0.01em; }
.dsl-section-hint { font-size: 12px; color: var(--dsl-muted); }

.dsl-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.dsl-grid--three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.dsl-span-2 { grid-column: 1 / -1; }
.dsl-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dsl-stack { display: grid; gap: 3px; }

.dsl-label { display: block; font-size: 12px; font-weight: 550; color: var(--dsl-text); }
.dsl-hint { display: block; font-size: 11.5px; line-height: 1.45; color: var(--dsl-muted); }
.dsl-error { display: block; font-size: 11.5px; color: var(--dsl-danger); }
.dsl-success { display: block; font-size: 11.5px; color: var(--dsl-success); }

.dsl-input, .dsl-select, .dsl-textarea {
  width: 100%;
  min-height: 34px;
  padding: 7px 10px;
  border: 1px solid var(--dsl-border);
  border-radius: 8px;
  outline: none;
  background: var(--dsl-bg);
  color: var(--dsl-text);
  font-size: 13px;
  line-height: 1.4;
  transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
}
.dsl-input:hover:not(:disabled), .dsl-select:hover:not(:disabled), .dsl-textarea:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.42));
}
.dsl-input:focus, .dsl-select:focus, .dsl-textarea:focus {
  border-color: var(--dsl-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsl-accent) 18%, transparent);
}
.dsl-input:disabled, .dsl-select:disabled, .dsl-textarea:disabled { opacity: 0.55; cursor: not-allowed; }
.dsl-input::placeholder, .dsl-textarea::placeholder { color: var(--dsw-alias-label-dimmed, rgba(127, 127, 127, 0.7)); }
.dsl-select { appearance: auto; cursor: pointer; }
.dsl-textarea { min-height: 112px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.55; }
.dsl-textarea[aria-invalid="true"] { border-color: var(--dsl-danger); }
.dsl-input[aria-invalid="true"] { border-color: var(--dsl-danger); }

.dsl-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--dsl-text);
  font-size: 12px;
  font-weight: 550;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.dsl-btn:hover:not(:disabled) { background: var(--dsl-bg-hover); }
.dsl-btn:focus-visible { outline: 2px solid var(--dsl-accent); outline-offset: 2px; }
.dsl-btn:disabled { opacity: 0.42; cursor: not-allowed; }
.dsl-btn--primary { background: var(--dsl-primary); color: var(--dsl-on-primary); }
.dsl-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #333); }
.dsl-btn--outline { border-color: var(--dsl-border); background: var(--dsl-bg); }
.dsl-btn--outline:hover:not(:disabled) { background: var(--dsl-bg-hover); }
.dsl-btn--danger { color: var(--dsl-danger); }
.dsl-btn--danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsl-danger) 10%, transparent); }
.dsl-btn--ghost { color: var(--dsl-muted); }
.dsl-btn--sm { height: 28px; padding: 0 9px; font-size: 11.5px; border-radius: 7px; }
.dsl-btn--icon { width: 30px; padding: 0; }

.dsl-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 22px;
  padding: 1px 7px;
  border: 1px solid var(--dsl-border-soft);
  border-radius: 999px;
  background: transparent;
  color: var(--dsl-muted);
  font-size: 10.5px;
  line-height: 1.3;
  white-space: nowrap;
}
.dsl-chip--on { border-color: color-mix(in srgb, var(--dsl-accent) 45%, transparent); background: color-mix(in srgb, var(--dsl-accent) 10%, transparent); color: var(--dsl-text); font-weight: 600; }
.dsl-chip--success { border-color: color-mix(in srgb, var(--dsl-success) 40%, transparent); background: color-mix(in srgb, var(--dsl-success) 10%, transparent); color: var(--dsl-success); }
.dsl-chip--danger { border-color: color-mix(in srgb, var(--dsl-danger) 40%, transparent); background: color-mix(in srgb, var(--dsl-danger) 8%, transparent); color: var(--dsl-danger); }
.dsl-chip--solid { border-color: transparent; background: var(--dsl-text); color: var(--dsl-bg); }

.dsl-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 27px;
  padding: 2px 10px;
  border: 1px solid var(--dsl-border);
  border-radius: 999px;
  background: transparent;
  color: var(--dsl-muted);
  font-size: 11.5px;
  font-weight: 550;
  line-height: 1;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.dsl-pill:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.5)); color: var(--dsl-text); }
.dsl-pill--active { border-color: transparent; background: var(--dsl-text); color: var(--dsl-bg); }
.dsl-pill:disabled { opacity: 0.45; cursor: not-allowed; }
.dsl-pill:focus-visible { outline: 2px solid var(--dsl-accent); outline-offset: 2px; }

.dsl-toggle {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 9px 10px;
  border: 1px solid var(--dsl-border-soft);
  border-radius: 9px;
  background: transparent;
  cursor: pointer;
}
.dsl-toggle:hover { background: var(--dsl-bg-hover); }
.dsl-toggle-copy { display: grid; gap: 2px; }
.dsl-toggle-label { font-size: 12px; font-weight: 550; }
.dsl-toggle-hint { font-size: 11.5px; color: var(--dsl-muted); }
.dsl-switch { position: relative; flex: 0 0 auto; width: 34px; height: 20px; margin-top: 1px; }
.dsl-switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
.dsl-switch-track { display: block; width: 34px; height: 20px; border-radius: 999px; background: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.35)); transition: background 140ms ease; pointer-events: none; }
.dsl-switch-track::after { content: ""; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--dsl-bg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18); transition: transform 140ms ease; }
.dsl-switch input:checked + .dsl-switch-track { background: var(--dsl-accent); }
.dsl-switch input:checked + .dsl-switch-track::after { transform: translateX(14px); }
.dsl-switch input:focus-visible + .dsl-switch-track { outline: 2px solid var(--dsl-accent); outline-offset: 2px; }
.dsl-switch input:disabled + .dsl-switch-track { opacity: 0.45; cursor: not-allowed; }

.dsl-provider {
  display: grid;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--dsl-border);
  border-radius: 12px;
  background: var(--dsl-bg);
}
.dsl-provider-head { display: flex; gap: 10px; align-items: flex-start; }
.dsl-provider-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: var(--dsl-bg-soft);
  color: var(--dsl-muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: -0.03em;
}
.dsl-provider-main { display: grid; gap: 4px; min-width: 0; flex: 1; }
.dsl-provider-title { font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
.dsl-provider-meta { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
.dsl-provider-actions { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.dsl-provider-body { display: grid; gap: 14px; padding-top: 12px; border-top: 1px solid var(--dsl-border-soft); }

.dsl-seat { display: grid; gap: 8px; }
.dsl-seat-head { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.dsl-seat-caption { font-size: 11.5px; font-weight: 650; color: var(--dsl-muted); }

.dsl-models { display: grid; gap: 8px; }
.dsl-model-list {
  max-height: 390px;
  overflow-y: auto;
  border: 1px solid var(--dsl-border);
  border-radius: 10px;
  background: var(--dsl-bg);
}
.dsl-model {
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 9px 11px;
  border: 0;
  border-bottom: 1px solid var(--dsl-border-soft);
  border-radius: 0;
  background: transparent;
  color: var(--dsl-text);
  text-align: left;
  cursor: pointer;
}
.dsl-model:last-child { border-bottom: 0; }
.dsl-model:hover { background: var(--dsl-bg-hover); }
.dsl-model[data-selected="true"] { background: color-mix(in srgb, var(--dsl-accent) 8%, transparent); box-shadow: inset 2px 0 0 var(--dsl-accent); }
.dsl-model:focus-visible { outline: 2px solid var(--dsl-accent); outline-offset: -2px; }
.dsl-model-main { display: grid; gap: 2px; min-width: 0; flex: 1; }
.dsl-model-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 600; }
.dsl-model-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--dsl-muted); }
.dsl-model-facts { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.dsl-chevron { flex: 0 0 auto; color: var(--dsl-muted); font-size: 11px; }

.dsl-editor { display: grid; gap: 14px; padding: 12px; border: 1px solid var(--dsl-border); border-radius: 10px; background: var(--dsl-bg-soft); }
.dsl-editor-head { display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; }
.dsl-editor-title { display: grid; gap: 2px; min-width: 0; }
.dsl-editor-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 650; overflow-wrap: anywhere; }
.dsl-cap { display: grid; gap: 7px; padding: 10px; border: 1px solid var(--dsl-border-soft); border-radius: 9px; background: var(--dsl-bg); }
.dsl-cap-title { font-size: 11.5px; font-weight: 650; }
.dsl-cap-hint { font-size: 11px; color: var(--dsl-muted); }
.dsl-cap-row { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; }
.dsl-cap-label { flex: 0 0 84px; padding-top: 4px; font-size: 11.5px; color: var(--dsl-muted); }
.dsl-cap-options { display: flex; gap: 5px; flex-wrap: wrap; flex: 1; min-width: 0; }

.dsl-note { display: flex; gap: 8px; align-items: flex-start; padding: 9px 10px; border: 1px solid var(--dsl-border-soft); border-radius: 9px; background: var(--dsl-bg-soft); font-size: 11.5px; color: var(--dsl-muted); }
.dsl-note--info { border-color: color-mix(in srgb, var(--dsl-accent) 30%, transparent); background: color-mix(in srgb, var(--dsl-accent) 7%, transparent); color: var(--dsl-text); }
.dsl-note--danger { border-color: color-mix(in srgb, var(--dsl-danger) 35%, transparent); background: color-mix(in srgb, var(--dsl-danger) 7%, transparent); color: var(--dsl-text); }
.dsl-note strong { color: var(--dsl-text); }

.dsl-empty { display: grid; gap: 4px; justify-items: center; padding: 20px 12px; border: 1px dashed var(--dsl-border); border-radius: 10px; text-align: center; }
.dsl-empty-title { font-size: 12px; font-weight: 600; }
.dsl-empty-hint { max-width: 360px; font-size: 11.5px; color: var(--dsl-muted); }

.dsl-discovery { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--dsl-border); border-radius: 10px; background: var(--dsl-bg); }
.dsl-candidates { display: grid; gap: 0; max-height: 220px; overflow-y: auto; border-top: 1px solid var(--dsl-border-soft); }
.dsl-candidate { display: flex; gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--dsl-border-soft); }
.dsl-candidate:last-child { border-bottom: 0; }
.dsl-candidate-id { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.dsl-candidate-meta { font-size: 11px; color: var(--dsl-muted); white-space: nowrap; }

.dsl-add { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 13px 14px; border: 1px dashed var(--dsl-border); border-radius: 12px; }
.dsl-add-copy { display: grid; gap: 2px; min-width: 0; }
.dsl-add-title { font-size: 13px; font-weight: 650; }
.dsl-add-hint { font-size: 11.5px; color: var(--dsl-muted); }

.dsl-footer { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding-top: 2px; }
.dsl-divider { height: 1px; background: var(--dsl-border-soft); }
.dsl-code { padding: 1px 5px; border-radius: 5px; background: var(--dsl-bg-soft); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; overflow-wrap: anywhere; }
.dsl-problems { display: grid; gap: 4px; margin: 0; padding-left: 18px; font-size: 11.5px; }

.dsl-details { border: 1px solid var(--dsl-border); border-radius: 10px; background: var(--dsl-bg); }
.dsl-details > summary { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; font-size: 12px; font-weight: 600; list-style: none; }
.dsl-details > summary::-webkit-details-marker { display: none; }
.dsl-details > summary::after { content: "›"; margin-left: auto; color: var(--dsl-muted); transform: rotate(90deg); transition: transform 120ms ease; }
.dsl-details[open] > summary::after { transform: rotate(-90deg); }
.dsl-details-body { display: grid; gap: 10px; padding: 0 12px 12px; }

@media (max-width: 560px) {
  .dsl-grid, .dsl-grid--three { grid-template-columns: minmax(0, 1fr); }
  .dsl-provider-head { flex-wrap: wrap; }
  .dsl-provider-actions { width: 100%; justify-content: flex-start; }
  .dsl-add { align-items: flex-start; flex-direction: column; }
  .dsl-cap-label { flex-basis: 100%; padding-top: 0; }
}
`

/** The id a wrapping {@link Field} assigns to its control. */
const FieldIdContext = createContext<string | undefined>(undefined)

/** One labeled control with optional hint and error line. */
export function Field(props: {
  /** Visible label. */
  readonly label: string
  /** Secondary explanation under the control. */
  readonly hint?: string | undefined
  /** Validation line replacing the hint when present. */
  readonly error?: string | undefined
  /** Explicit id of the control, when the field is not wrapping it in a label. */
  readonly htmlFor?: string | undefined
  /** Optional layout class. */
  readonly className?: string | undefined
  /** The control. */
  readonly children: ReactNode
}): ReactNode {
  const generated = useId()
  const id = props.htmlFor ?? generated
  return (
    <div className={props.className ?? 'dsl-stack'}>
      <label htmlFor={id} className="dsl-label">{props.label}</label>
      <FieldIdContext.Provider value={id}>{props.children}</FieldIdContext.Provider>
      {props.error !== undefined
        ? <span className="dsl-error" role="alert">{props.error}</span>
        : props.hint === undefined ? null : <span className="dsl-hint">{props.hint}</span>}
    </div>
  )
}

/** One headed group of related controls. */
export function FieldGroup(props: {
  /** Visible group heading. */
  readonly title: string
  /** Optional explanation under the heading. */
  readonly hint?: string | undefined
  /** The group's controls. */
  readonly children: ReactNode
}): ReactNode {
  const id = useId()
  return (
    <section aria-labelledby={id} className="dsl-card dsl-card--flat">
      <div className="dsl-section-head">
        <h5 id={id} className="dsl-section-title">{props.title}</h5>
        {props.hint === undefined ? null : <span className="dsl-section-hint">{props.hint}</span>}
      </div>
      <div className="dsl-card-body">{props.children}</div>
    </section>
  )
}

/** One titled section with an optional action in its header. */
export function SectionCard(props: {
  /** Section title. */
  readonly title: string
  /** Optional description under the title. */
  readonly hint?: string | undefined
  /** Optional action shown at the far edge. */
  readonly action?: ReactNode
  /** The section body. */
  readonly children: ReactNode
}): ReactNode {
  const id = useId()
  return (
    <section aria-labelledby={id} className="dsl-card">
      <div className="dsl-card-head">
        <div>
          <h4 id={id} className="dsl-card-title">{props.title}</h4>
          {props.hint === undefined ? null : <p className="dsl-card-sub">{props.hint}</p>}
        </div>
        {props.action}
      </div>
      <div className="dsl-card-body">{props.children}</div>
    </section>
  )
}

/** A text input that stages every keystroke. */
export function TextInput(props: {
  /** Current staged value. */
  readonly value: string
  /** Commit the next value. */
  readonly onChange: (value: string) => void
  /** Placeholder text. */
  readonly placeholder?: string | undefined
  /** Whether the control is read-only for the page. */
  readonly disabled?: boolean | undefined
  /** Accessible name when no visible {@link Field} labels the control. */
  readonly ariaLabel?: string | undefined
  /** Explicit control id, overriding the surrounding field's id. */
  readonly id?: string | undefined
  /** Focus the input when it mounts (a freshly added model row). */
  readonly autoFocus?: boolean | undefined
  /** Input type; `text` unless a password field or a URL is asked for. */
  readonly type?: 'text' | 'password' | 'url' | undefined
}): ReactNode {
  const fieldId = useContext(FieldIdContext)
  const ownId = useId()
  return (
    <input
      type={props.type ?? 'text'}
      id={props.id ?? fieldId ?? ownId}
      className="dsl-input"
      value={props.value}
      placeholder={props.placeholder ?? ''}
      disabled={props.disabled === true}
      aria-label={props.ariaLabel}
      autoFocus={props.autoFocus === true}
      autoComplete={props.type === 'password' ? 'new-password' : 'off'}
      onChange={(event) => { props.onChange(event.target.value) }}
    />
  )
}

/**
 * One integer input: the text is held locally while it is not a number, so a
 * half-typed value never round-trips through the draft as `NaN`. A cleared
 * field stages `undefined`, letting the schema default apply.
 */
export function IntegerField(props: {
  /** Visible label. */
  readonly label: string
  /** Current staged value. */
  readonly value: number | undefined
  /** Commit the parsed value (or undefined when cleared). */
  readonly onChange: (value: number | undefined) => void
  /** Secondary explanation. */
  readonly hint?: string | undefined
  /** Whether the control is read-only for the page. */
  readonly disabled?: boolean | undefined
  /** Placeholder text. */
  readonly placeholder?: string | undefined
}): ReactNode {
  const id = useId()
  const [text, setText] = useState(() => (props.value === undefined ? '' : String(props.value)))
  useEffect(() => {
    setText(props.value === undefined ? '' : String(props.value))
  }, [props.value])
  return (
    <Field label={props.label} hint={props.hint} htmlFor={id}>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        className="dsl-input"
        value={text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled === true}
        onChange={(event) => {
          const next = event.target.value
          setText(next)
          const value = next.trim().length === 0 ? undefined : Number(next.trim())
          if (value === undefined || (Number.isSafeInteger(value) && value > 0)) props.onChange(value)
        }}
      />
    </Field>
  )
}

/** A boolean setting rendered as a switch row. */
export function Toggle(props: {
  /** Visible label. */
  readonly label: string
  /** Current value. */
  readonly checked: boolean
  /** Commit the next value. */
  readonly onChange: (checked: boolean) => void
  /** Secondary explanation. */
  readonly hint?: string | undefined
  /** Whether the control is read-only for the page. */
  readonly disabled?: boolean | undefined
}): ReactNode {
  return (
    <label className="dsl-toggle">
      <span className="dsl-toggle-copy">
        <span className="dsl-toggle-label">{props.label}</span>
        {props.hint === undefined ? null : <span className="dsl-toggle-hint">{props.hint}</span>}
      </span>
      <span className="dsl-switch">
        <input
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled === true}
          onChange={(event) => { props.onChange(event.target.checked) }}
        />
        <span className="dsl-switch-track" aria-hidden="true" />
      </span>
    </label>
  )
}

/** A selectable pill used for small multi-select vocabularies. */
export function ChoiceChip(props: {
  /** Visible label. */
  readonly label: string
  /** Whether the value is selected. */
  readonly selected: boolean
  /** Commit the next selection. */
  readonly onToggle: () => void
  /** Whether the control is read-only for the page. */
  readonly disabled?: boolean | undefined
  /** Optional hover explanation. */
  readonly title?: string | undefined
}): ReactNode {
  return (
    <button
      type="button"
      className={props.selected ? 'dsl-pill dsl-pill--active' : 'dsl-pill'}
      aria-pressed={props.selected}
      disabled={props.disabled === true}
      title={props.title}
      onClick={props.onToggle}
    >
      {props.label}
    </button>
  )
}

/** One select control. */
export function SelectField<T extends string>(props: {
  /** Visible label. */
  readonly label: string
  /** Current value (empty string for "unset"). */
  readonly value: T | ''
  /** The choices. */
  readonly options: readonly { readonly value: T; readonly label: string }[]
  /** Commit the next value. */
  readonly onChange: (value: T | '') => void
  /** Optional unset choice label; omitted when the field is required. */
  readonly unsetLabel?: string | undefined
  /** Whether the control is read-only for the page. */
  readonly disabled?: boolean | undefined
  /** Secondary explanation. */
  readonly hint?: string | undefined
}): ReactNode {
  const id = useId()
  return (
    <Field label={props.label} htmlFor={id} hint={props.hint}>
      <select
        id={id}
        className="dsl-select"
        value={props.value}
        disabled={props.disabled === true}
        onChange={(event) => { props.onChange(event.target.value as T | '') }}
      >
        {props.unsetLabel === undefined ? null : <option value="">{props.unsetLabel}</option>}
        {props.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </Field>
  )
}

/** A small action button. */
export function ActionButton(props: {
  /** Button text. */
  readonly children: ReactNode
  /** Click handler. */
  readonly onClick: () => void
  /** Removes the button from the tab order while a request is in flight. */
  readonly disabled?: boolean | undefined
  /** Marks a destructive action. */
  readonly danger?: boolean | undefined
  /** Emphasizes the primary action. */
  readonly primary?: boolean | undefined
  /** An outlined action. */
  readonly outline?: boolean | undefined
  /** An especially quiet action. */
  readonly quiet?: boolean | undefined
  /** Compact 28px control. */
  readonly small?: boolean | undefined
  /** Accessible label override. */
  readonly ariaLabel?: string | undefined
  /** Id of the text that disambiguates a repeated action. */
  readonly ariaDescribedBy?: string | undefined
  /** Disclosure state, for an Edit/Done toggle. */
  readonly ariaExpanded?: boolean | undefined
  /** The region the disclosure controls. */
  readonly ariaControls?: string | undefined
}): ReactNode {
  const classes = ['dsl-btn']
  if (props.primary === true) classes.push('dsl-btn--primary')
  else if (props.danger === true) classes.push('dsl-btn--danger')
  else if (props.outline === true) classes.push('dsl-btn--outline')
  else if (props.quiet === true) classes.push('dsl-btn--ghost')
  if (props.small === true) classes.push('dsl-btn--sm')
  return (
    <button
      type="button"
      className={classes.join(' ')}
      disabled={props.disabled === true}
      aria-label={props.ariaLabel}
      aria-describedby={props.ariaDescribedBy}
      aria-expanded={props.ariaExpanded}
      aria-controls={props.ariaControls}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

/** A read-only chip. */
export function Chip(props: {
  /** Chip text. */
  readonly children: ReactNode
  /** Whether the chip reads as active. */
  readonly on?: boolean | undefined
  /** Optional tone override. */
  readonly tone?: 'neutral' | 'success' | 'danger' | 'solid' | undefined
  /** Optional title for the hover tooltip. */
  readonly title?: string | undefined
}): ReactNode {
  const classes = ['dsl-chip']
  if (props.tone === 'success') classes.push('dsl-chip--success')
  else if (props.tone === 'danger') classes.push('dsl-chip--danger')
  else if (props.tone === 'solid') classes.push('dsl-chip--solid')
  else if (props.on === true) classes.push('dsl-chip--on')
  return <span className={classes.join(' ')} title={props.title}>{props.children}</span>
}

/** The page's one section heading. */
export function SectionTitle(props: {
  /** Heading text. */
  readonly children: ReactNode
  /** Optional caption under it. */
  readonly hint?: string | undefined
}): ReactNode {
  return (
    <div className="dsl-stack">
      <h3 className="dsl-page-title">{props.children}</h3>
      {props.hint === undefined ? null : <p className="dsl-hint">{props.hint}</p>}
    </div>
  )
}
