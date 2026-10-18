/**
 * Shared presentation helpers for the provider-configuration page.
 *
 * Controls are native elements with inline styles on purpose: the page ships
 * inside a plugin bundle, and every extra shared dependency is a module
 * request the client module table has to answer. The form frame itself is the
 * shared `SettingsForm` primitive, so save/read-only/unavailable chrome still
 * matches every other plugin settings page.
 *
 * @module @snnh/dsh-llm-service-lite/client/ui
 */

import { createContext, useContext, useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react'

/** Shared inline styles. */
export const styles: Readonly<Record<string, CSSProperties>> = {
  section: { display: 'grid', gap: 10, marginBottom: 22 },
  row: { display: 'grid', gap: 8, padding: '10px 0', borderTop: '1px solid rgba(127,127,127,0.2)' },
  card: { display: 'grid', gap: 8, padding: 12, border: '1px solid rgba(127,127,127,0.25)', borderRadius: 8 },
  cardHead: { display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' },
  cardIdentity: { display: 'grid', gap: 3, flex: '1 1 240px', minWidth: 0 },
  cardActions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginLeft: 'auto' },
  cardTitle: { fontWeight: 600, margin: 0, fontSize: 14, overflowWrap: 'anywhere' },
  cardBody: { display: 'grid', gap: 12 },
  inline: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
  field: { display: 'grid', gap: 3 },
  label: { display: 'block', fontSize: 12, opacity: 0.75 },
  hint: { fontSize: 12, opacity: 0.65 },
  error: { fontSize: 12, color: 'var(--dsh-color-danger, #d33)' },
  success: { fontSize: 12, fontWeight: 600 },
  input: { width: '100%', boxSizing: 'border-box' },
  textarea: { width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace, monospace', fontSize: 12 },
  button: { cursor: 'pointer' },
  primary: { cursor: 'pointer', fontWeight: 600 },
  danger: { cursor: 'pointer', color: 'var(--dsh-color-danger, #d33)' },
  muted: { fontSize: 12, opacity: 0.7 },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: 12 },
  routeCode: { fontFamily: 'ui-monospace, monospace', fontSize: 12, padding: '1px 5px', borderRadius: 4, background: 'rgba(127,127,127,0.14)' },
  chip: { fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid rgba(127,127,127,0.35)', opacity: 0.85 },
  chipOn: { fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid currentColor', fontWeight: 600 },
  problems: { display: 'grid', gap: 4, margin: 0, paddingLeft: 18, fontSize: 12 },
  problemsPanel: { display: 'grid', gap: 6, padding: 10, border: '1px solid var(--dsh-color-danger, #d33)', borderRadius: 6 },
  result: { display: 'grid', gap: 4, padding: 8, border: '1px dashed rgba(127,127,127,0.35)', borderRadius: 6 },
  pageHeader: { display: 'grid', gap: 4, marginBottom: 16 },
  pageTitle: { margin: 0, fontSize: 18 },
  pageLead: { margin: 0, fontSize: 13, opacity: 0.8 },
  sectionHeading: { margin: 0, fontSize: 15 },
  group: { display: 'grid', gap: 8, paddingTop: 12, borderTop: '1px solid rgba(127,127,127,0.18)' },
  groupTitle: { margin: 0, fontSize: 13, fontWeight: 600 },
  groupBody: { display: 'grid', gap: 10 },
  subhead: { margin: 0, fontSize: 12, fontWeight: 600, opacity: 0.8 },
  note: { display: 'grid', gap: 4, padding: '8px 10px', border: '1px solid rgba(127,127,127,0.2)', borderRadius: 6 },
  emptyState: { display: 'grid', gap: 4, padding: 16, textAlign: 'center', border: '1px dashed rgba(127,127,127,0.4)', borderRadius: 8 },
  addBar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: 12, border: '1px dashed rgba(127,127,127,0.35)', borderRadius: 8 },
  confirm: { display: 'grid', gap: 6, padding: 10, border: '1px solid rgba(127,127,127,0.3)', borderRadius: 6 },
  modelCard: { display: 'grid', gap: 10, padding: 10, border: '1px solid rgba(127,127,127,0.2)', borderRadius: 6 },
  modelHead: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  modelTitle: { margin: 0, fontSize: 13, fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' },
  capabilities: { display: 'grid', gap: 8, padding: 8, borderRadius: 6, background: 'rgba(127,127,127,0.06)' },
  candidateList: { display: 'grid', gap: 0, margin: 0, padding: 0, listStyle: 'none' },
  candidateRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderTop: '1px solid rgba(127,127,127,0.14)' },
  checkboxLabel: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12 },
  toggle: { display: 'grid', gap: 2 },
  disabled: { opacity: 0.45, cursor: 'not-allowed' },
}

/**
 * The id a wrapping {@link Field} assigns to its control. Controls read it so
 * the visible label's `htmlFor` lands on the actual input, and so a field may
 * hold more than one control (an input plus its action) without nesting a
 * button inside the `<label>`.
 */
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
  /** The control. */
  readonly children: ReactNode
}): ReactNode {
  const generated = useId()
  const id = props.htmlFor ?? generated
  return (
    <div style={styles['field']}>
      <label htmlFor={id} style={styles['label']}>{props.label}</label>
      <FieldIdContext.Provider value={id}>{props.children}</FieldIdContext.Provider>
      {props.error !== undefined
        ? <span style={styles['error']} role="alert">{props.error}</span>
        : props.hint === undefined ? null : <span style={styles['hint']}>{props.hint}</span>}
    </div>
  )
}

/**
 * One headed group of related controls. The heading level sits under a
 * provider card's title, keeping the document outline stable.
 */
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
    <section aria-labelledby={id} style={styles['group']}>
      <h5 id={id} style={styles['groupTitle']}>{props.title}</h5>
      {props.hint === undefined ? null : <p style={styles['hint']}>{props.hint}</p>}
      <div style={styles['groupBody']}>{props.children}</div>
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
}): ReactNode {
  const fieldId = useContext(FieldIdContext)
  const ownId = useId()
  return (
    <input
      type="text"
      id={props.id ?? fieldId ?? ownId}
      style={styles['input']}
      value={props.value}
      placeholder={props.placeholder ?? ''}
      disabled={props.disabled === true}
      aria-label={props.ariaLabel}
      autoFocus={props.autoFocus === true}
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
}): ReactNode {
  const id = useId()
  const [text, setText] = useState(() => (props.value === undefined ? '' : String(props.value)))
  useEffect(() => {
    setText(props.value === undefined ? '' : String(props.value))
  }, [props.value])
  return (
    <Field
      label={props.label}
      hint={props.hint}
      htmlFor={id}
    >
      <input
        id={id}
        type="text"
        inputMode="numeric"
        style={styles['input']}
        value={text}
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

/** A boolean toggle. The hint sits outside the label so it is not part of the control's name. */
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
    <div style={styles['toggle']}>
      <label style={styles['inline']}>
        <input
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled === true}
          onChange={(event) => { props.onChange(event.target.checked) }}
        />
        <span>{props.label}</span>
      </label>
      {props.hint === undefined ? null : <span style={styles['hint']}>{props.hint}</span>}
    </div>
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
}): ReactNode {
  const id = useId()
  return (
    <Field label={props.label} htmlFor={id}>
      <select
        id={id}
        style={styles['input']}
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

/** A small action button styled like the surrounding page. */
export function ActionButton(props: {
  /** Button text. */
  readonly children: ReactNode
  /** Click handler. */
  readonly onClick: () => void
  /** Removes the button from the tab order while a request is in flight. */
  readonly disabled?: boolean | undefined
  /** Marks a destructive action. */
  readonly danger?: boolean | undefined
  /** Emphasizes the control pair's primary action. */
  readonly primary?: boolean | undefined
  /** Accessible label override. */
  readonly ariaLabel?: string | undefined
  /** Id of the text that disambiguates a repeated action. */
  readonly ariaDescribedBy?: string | undefined
  /** Disclosure state, for an Edit/Done toggle. */
  readonly ariaExpanded?: boolean | undefined
  /** The region the disclosure controls. */
  readonly ariaControls?: string | undefined
}): ReactNode {
  const base = props.danger === true
    ? styles['danger']
    : props.primary === true ? styles['primary'] : styles['button']
  return (
    <button
      type="button"
      style={props.disabled === true ? { ...base, ...styles['disabled'] } : base}
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

/** A three-state chip: on, off, and unknown (`undefined` hides the chip). */
export function Chip(props: {
  /** Chip text. */
  readonly children: ReactNode
  /** Whether the chip reads as active. */
  readonly on?: boolean | undefined
  /** Optional title for the hover tooltip. */
  readonly title?: string | undefined
}): ReactNode {
  return <span style={props.on === true ? styles['chipOn'] : styles['chip']} title={props.title}>{props.children}</span>
}

/** The page's one section heading. */
export function SectionTitle(props: {
  /** Heading text. */
  readonly children: ReactNode
  /** Optional caption under it. */
  readonly hint?: string | undefined
}): ReactNode {
  return (
    <div style={styles['field']}>
      <h3 style={{ margin: 0 }}>{props.children}</h3>
      {props.hint === undefined ? null : <p style={styles['hint']}>{props.hint}</p>}
    </div>
  )
}
