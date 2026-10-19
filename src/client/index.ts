/**
 * Browser half of `@snnh/dsh-llm-service-lite`.
 *
 * Two surfaces edit the same Loader row config, both through the settings form
 * service the shell injects:
 *
 * - the Plugins page's row-configuration page (`plugins.row.config`) edits the
 *   whole `providers` document; and
 * - the Models page's adapter-family extension seats
 *   (`settings.models.provider-card` and `settings.models.footer`) put the
 *   per-provider editor and the add-provider builder on the page where an
 *   operator already manages providers.
 *
 * Both call the Host's credential and model-discovery remotes for the actions
 * that live outside the settings document, and both register only while the
 * Host serves this plugin's settings namespace.
 *
 * @module @snnh/dsh-llm-service-lite/client
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.configForms service and the slot declaration side.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.row.config' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: the Models page's SlotMap merge (its two extension seats).
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
// Type-only: the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote Context merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ServiceLitePageController } from './controller.ts'
import { ServiceLiteModelsController, type ServiceLiteModelsFace } from './models-controller.ts'
import { ModelsAddProvider } from './ModelsAddProvider.tsx'
import { ModelsProviderCard } from './ModelsProviderCard.tsx'
import { ServiceLitePage } from './ServiceLitePage.tsx'
import { en, zh, type ServiceLiteKey } from './locales.ts'
import {
  LOCALE_NS,
  ROW_CONFIG_KEY,
  SETTINGS_NS,
  type ClientConfig,
  type DiscoveryOutcome,
  type ServiceLitePageFace,
} from './types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Provider-configuration copy, shared by every surface this plugin adds. */
    'settings.llm-service-lite': ServiceLiteKey
  }
}

/** Required services (cordis fiber inject). */
export const inject = [
  'slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'configForms',
]

/**
 * Mount the provider-configuration surfaces while the Host serves the
 * `llm-service-lite` settings namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'llm-service-lite: dictionaries')
  const operations = {
    storeCredential: async (ref: string, value: string): Promise<string | undefined> => {
      const response = await ctx.remote.credentials.set(ref, value)
      return response.ok ? undefined : response.error.message
    },
    discover: async (request: unknown): Promise<DiscoveryOutcome> => {
      const response = await ctx.remote.llm.discoverModels(
        SETTINGS_NS,
        request as Parameters<typeof ctx.remote.llm.discoverModels>[1],
      )
      return response.ok
        ? { kind: 'found', models: response.value }
        : { kind: 'refused', message: response.error.message }
    },
  }

  const controller = new ServiceLitePageController(ctx.configForms.get<ClientConfig>(SETTINGS_NS), operations)
  ctx.effect(() => () => { controller.dispose() }, 'llm-service-lite: row page subscription')
  const face: ServiceLitePageFace = controller.inject()
  ctx.effect(
    () => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
      name: 'plugins.row.config',
      key: ROW_CONFIG_KEY,
      locale: LOCALE_NS,
      inject: () => face,
    }, ServiceLitePage))),
    'llm-service-lite: row configuration',
  )

  const modelsController = new ServiceLiteModelsController(ctx.configForms.get<ClientConfig>(SETTINGS_NS), operations)
  ctx.effect(() => () => { modelsController.dispose() }, 'llm-service-lite: models page subscription')
  const modelsFace: ServiceLiteModelsFace = modelsController.inject()
  // One registration per card of this family: the seat is keyed by the settings
  // namespace, so every llm-service-lite row the Models page draws dispatches it.
  ctx.effect(
    () => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
      name: 'settings.models.provider-card',
      key: SETTINGS_NS,
      locale: LOCALE_NS,
      inject: () => modelsFace,
    }, ModelsProviderCard))),
    'llm-service-lite: models provider card',
  )
  // The section-level add builder sits after the page's own add controls.
  ctx.effect(
    () => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
      name: 'settings.models.footer',
      id: 'llm-service-lite',
      order: 20,
      locale: LOCALE_NS,
      inject: () => modelsFace,
    }, ModelsAddProvider))),
    'llm-service-lite: models section footer',
  )
}
