/**
 * Minimal settings writes for one provider profile.
 *
 * Two surfaces edit the same `llm-service-lite` settings section: the Plugins
 * page's row-configuration page stages a whole document and saves once, while
 * the Models page's per-provider card seat applies one provider at a time. Both
 * must produce the same shape of write — path operations that name only what
 * the edited card can see, compare against the stored user layer first, and
 * leave every hand-written advanced field untouched — so the per-route logic
 * lives here and both callers share it.
 *
 * @module @snnh/dsh-llm-service-lite/client/provider-ops
 */

import type { SettingsFormPathOp } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  EDITABLE_PROVIDER_FIELDS,
  FIELD_DEFAULTS,
  cleanConfig,
  providersOf,
  sameConfig,
  storedField,
} from './model.ts'
import type { ClientProvider } from './types.ts'

/**
 * The operations that move one route's profile from what is stored to what the
 * card shows.
 *
 * The comparison is against the USER layer, not the resolved value: a field
 * the person never touched already stores what it stored, so it needs no
 * operation at all. A field a person clears falls back to the composition
 * layer when that layer states it, and a field the card does not show (headers,
 * extraBody, catalog, ...) is left exactly as stored.
 * @param route - the route id the profile is filed under.
 * @param resolved - the effective profile the draft was seeded from, or undefined for a new route.
 * @param baseProfile - the same route in the composition layer, when it states one.
 * @param userProfile - the same route in the raw user layer, when it stores one.
 * @param next - the edited profile.
 * @returns ordered path operations; empty when the draft stores what is stored.
 */
export function providerOps(
  route: string,
  resolved: ClientProvider | undefined,
  baseProfile: ClientProvider | undefined,
  userProfile: ClientProvider | undefined,
  next: ClientProvider,
): SettingsFormPathOp[] {
  if (resolved === undefined) {
    // A newly declared route is written whole; the schema fills its defaults.
    const cleaned = cleanConfig({ providers: { [route]: next } }).providers[route]
    return cleaned === undefined ? [] : [{ op: 'set', path: ['providers', route], value: cleaned }]
  }
  const ops: SettingsFormPathOp[] = []
  for (const field of EDITABLE_PROVIDER_FIELDS) {
    const nextValue = storedField(field, next[field])
    const baseValue = storedField(field, baseProfile?.[field])
    const userValue = storedField(field, userProfile?.[field])
    if (nextValue === undefined) {
      if (userValue !== undefined) ops.push({ op: 'unset', path: ['providers', route, field] })
      continue
    }
    // A draft that puts the field back to the composition value drops any
    // redundant user-layer entry, even when that entry already holds it.
    if (baseValue !== undefined && sameConfig(nextValue, baseValue)) {
      // Only a changed draft drops the override; an untouched user-layer entry
      // that happens to repeat the composition value stays as it was stored.
      if (userValue !== undefined && !sameConfig(nextValue, userValue)) {
        ops.push({ op: 'unset', path: ['providers', route, field] })
      }
      continue
    }
    if (sameConfig(nextValue, userValue)) continue
    // A field the draft inherited from the resolved value and that no layer
    // stores needs no user-layer entry of its own.
    if (baseValue === undefined && userValue === undefined && userProfile === undefined
      && sameConfig(nextValue, resolved[field])) continue
    // A composition-layer value differs from the draft, so the user layer has
    // to override it; otherwise a value equal to the schema default with
    // nothing beneath it needs no user-layer entry.
    if (baseValue !== undefined) {
      ops.push({ op: 'set', path: ['providers', route, field], value: nextValue })
      continue
    }
    if (userValue !== undefined || !sameConfig(nextValue, FIELD_DEFAULTS[field])) {
      ops.push({ op: 'set', path: ['providers', route, field], value: nextValue })
    }
  }
  return ops
}

/**
 * Whether a route may be dropped from the Models page: only a route whose sole
 * declaration is the user layer can be removed here, because a route the
 * composition declares stays until the patch that declares it changes.
 * @param route - the route id.
 * @param base - the composition layer, as the settings form reports it.
 * @param user - the raw user layer, as the settings form reports it.
 * @returns whether the card offers removal.
 */
export function providerRemovable(route: string, base: unknown, user: unknown): boolean {
  return providersOf(user)[route] !== undefined && providersOf(base)[route] === undefined
}

/**
 * The operation that drops a user-layer-only route.
 * @param route - the route id.
 * @param base - the composition layer.
 * @param user - the raw user layer.
 * @returns the unset operation, or an empty list when the route is not removable here.
 */
export function removeProviderOps(route: string, base: unknown, user: unknown): SettingsFormPathOp[] {
  if (!providerRemovable(route, base, user)) return []
  return [{ op: 'unset', path: ['providers', route] }]
}
