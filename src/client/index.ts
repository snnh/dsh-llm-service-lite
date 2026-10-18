/**
 * Browser half of `@snnh/dsh-llm-service-lite`: the provider-configuration page
 * on the Plugins page's row configuration seat.
 *
 * The page edits the Loader row's own `providers` dictionary through the
 * settings form service the Plugins page injects, calls the Host's credential
 * and model-discovery remotes for the actions that live outside the settings
 * document, and registers only while the Host serves its namespace.
 *
 * @module @snnh/dsh-llm-service-lite/client
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.configForms service and the slot declaration side.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.row.config' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote Context merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ServiceLitePageController } from './controller.ts'
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
    /** Provider-configuration page copy. */
    'settings.llm-service-lite': ServiceLiteKey
  }
}

/** Required services (cordis fiber inject). */
export const inject = [
  'slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'configForms',
]

/**
 * Mount the provider-configuration page on the Plugins page while the Host
 * serves the `llm-service-lite` settings namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'llm-service-lite: dictionaries')
  const controller = new ServiceLitePageController(
    ctx.configForms.get<ClientConfig>(SETTINGS_NS),
    {
      storeCredential: async (ref, value) => {
        const response = await ctx.remote.credentials.set(ref, value)
        return response.ok ? undefined : response.error.message
      },
      discover: async (request): Promise<DiscoveryOutcome> => {
        const response = await ctx.remote.llm.discoverModels(SETTINGS_NS, request)
        return response.ok
          ? { kind: 'found', models: response.value }
          : { kind: 'refused', message: response.error.message }
      },
    },
  )
  ctx.effect(() => () => { controller.dispose() }, 'llm-service-lite: settings subscription')
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
}
