/**
 * Lifecycle coverage for the plugin's live-configuration paths.
 *
 * The plugin mounts through the real Loader and real LLM runtime, so an entry
 * config update takes the Loader's volatile-commit path — the same path a
 * settings write produces — and the plugin's `internal/config` guard and
 * `loader/volatile-update` handler run for real. A real
 * `@deepseek-ai/dsh-settings` instance is mounted over stub config-editor and
 * profile-context services, which exercises the plugin's
 * `ctx.inject(['settings'])` policy registration.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, { type StreamChunk } from '@deepseek-ai/dsh-llm'
import Settings from '@deepseek-ai/dsh-settings'
import * as LlmServiceLite from '../src/index.ts'
import type { DeclaredModelDefault, ModelDefaultsRequest } from '../src/model-defaults.ts'

/** Module specifier the Loader resolves to this package. */
const PLUGIN_SPECIFIER = '@snnh/dsh-llm-service-lite'
/** Entry id the bundle layer (and every test here) mounts the plugin under. */
const ENTRY_ID = 'llm-service-lite'
/** Route used by most tests; no shipped catalog declares it. */
const ROUTE = 'lifecycle-gateway'

/** Contexts started by a test, disposed after it. */
const contexts: Context[] = []
/** Temporary directories created by a boot, removed after the test. */
const tempDirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** One plugin instance mounted through the real Loader. */
interface Mounted {
  /** Root context of the composition. */
  readonly ctx: Context
  /** How many times the plugin's `apply()` ran (a remount would increase it). */
  readonly applyCount: () => number
  /** Warnings logged through the root logger after the composition was booted. */
  readonly warnings: string[]
  /** Performs one Loader entry-config update and waits for the tree to settle. */
  readonly update: (providers: Record<string, unknown>) => Promise<void>
}

/** One provider profile the Loader resolves; tests replace its endpoint. */
const profile = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  interfaceType: 'openai-chat-completions',
  baseURL: 'https://gateway.test/v1',
  models: [{ id: 'm' }],
  ...overrides,
})

/**
 * Boot the composition: LLM runtime, real Loader, real Settings over stub
 * backing services, then the plugin row with the given `providers` dict.
 * @param providers - initial plugin `providers` config.
 * @param options - `settings: false` skips the settings service.
 * @returns the mounted composition.
 */
async function boot(
  providers: Record<string, unknown> = {},
  options: { settings?: boolean } = {},
): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  const warnings: string[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Loader)
  if (options.settings !== false) {
    // The real Settings service needs only these two host services to activate
    // in a composition this small; its legacy-document import finds no file.
    const documentDir = mkdtempSync(join(tmpdir(), 'lite-lifecycle-'))
    const homeDir = mkdtempSync(join(tmpdir(), 'lite-home-'))
    tempDirs.push(documentDir, homeDir)
    ctx.provide('configEditor', {
      configuration: () => [],
      documentPath: join(documentDir, 'cordis.patch.yml'),
    })
    ctx.provide('profileContext', { name: 'test', home: homeDir })
    await ctx.plugin(Settings)
  }
  let applied = 0
  // Wrapper around the real module: counting apply() proves a volatile config
  // update never remounts the plugin instance.
  const pluginModule = {
    ...LlmServiceLite,
    apply(ctx: Context, config: LlmServiceLite.Config): void {
      applied += 1
      LlmServiceLite.apply(ctx, config)
    },
  }
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === PLUGIN_SPECIFIER) return pluginModule
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  // The Loader's public `create` type omits `id` because it normally generates
  // one; the runtime honours an explicit id, and the bundle row relies on that
  // (the id is also the plugin's settings namespace).
  const row = { id: ENTRY_ID, name: PLUGIN_SPECIFIER, config: { providers } }
  await ctx.loader.create(row as unknown as Omit<typeof row, 'id'>)
  await ctx.loader.await()
  return {
    ctx,
    warnings,
    applyCount: () => applied,
    update: async (next) => {
      await ctx.loader.update(ENTRY_ID, { config: { providers: next } })
      await ctx.loader.await()
    },
  }
}

/** Collect one LLM stream. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Terminal failure code of a stream the runtime normalized, if it failed. */
function failureCode(chunks: readonly StreamChunk[]): string | undefined {
  const last = chunks.at(-1)
  if (last?.type !== 'finish' || last.reason.kind !== 'error') return undefined
  return last.reason.failure.code
}

/**
 * Stream one request through a route and return the runtime's terminal failure
 * code. A transport failure (no HTTP endpoint behind the test URL) still proves
 * the credential stage ran: `MISSING_CREDENTIAL`/`INVALID_CREDENTIAL` never
 * reach the socket.
 * @param ctx - composition context.
 * @param provider - route to call.
 * @returns the normalized failure code.
 */
async function streamFailure(ctx: Context, provider: string): Promise<string | undefined> {
  const chunks = await collect(ctx.llm.stream({
    provider,
    model: 'm',
    messages: [{ id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }],
  }))
  return failureCode(chunks)
}

describe('plugin lifecycle on a live Loader', () => {
  it('adds a route on a volatile config update and withdraws routes and directory when every profile is removed', async () => {
    const mounted = await boot()
    expect(mounted.applyCount()).toBe(1)
    expect(mounted.ctx.llm.listProviders()).toEqual([])
    expect(mounted.ctx.llm.listConfigurableProviders()).toEqual([])

    await mounted.update({ [ROUTE]: profile() })
    expect(mounted.ctx.llm.listProviders()).toMatchObject([{ id: ROUTE, name: ROUTE }])
    expect(mounted.ctx.llm.listConfigurableProviders()).toMatchObject([
      { provider: ROUTE, displayName: ROUTE, declared: true, settingsNs: ENTRY_ID, settingsPath: ['providers', ROUTE] },
    ])

    await mounted.update({})
    // An empty replacement withdraws the routes while the same instance keeps
    // its registration handle; the directory is withdrawn too.
    expect(mounted.ctx.llm.listProviders()).toEqual([])
    expect(mounted.ctx.llm.listConfigurableProviders()).toEqual([])

    await mounted.update({ [ROUTE]: profile() })
    expect(mounted.ctx.llm.listProviders()).toMatchObject([{ id: ROUTE }])
    // Every step was a config update; the plugin applied exactly once.
    expect(mounted.applyCount()).toBe(1)
  })

  it('refuses an invalid volatile candidate and keeps the serving routes', async () => {
    const mounted = await boot({ [ROUTE]: profile() })
    expect(mounted.ctx.llm.listProviders()).toMatchObject([{ id: ROUTE }])

    await mounted.update({
      [ROUTE]: profile(),
      broken: { interfaceType: 'openai-chat-completions', baseURL: 'not a url' },
    })
    // The internal/config guard rejected the candidate: nothing was committed,
    // the old route still serves, and the rejection is logged.
    expect(mounted.ctx.llm.listProviders()).toMatchObject([{ id: ROUTE }])
    expect(mounted.ctx.llm.listConfigurableProviders().map(entry => entry.provider)).toEqual([ROUTE])
    expect(mounted.warnings.some(warning => warning.includes('volatile config update failed'))).toBe(true)

    // A later valid candidate can still be committed, dropping the refused one.
    await mounted.update({ [ROUTE]: profile(), second: profile({ displayName: 'Second' }) })
    expect(mounted.ctx.llm.listProviders().map(entry => entry.id).sort()).toEqual([ROUTE, 'second'])
    expect(mounted.ctx.llm.listConfigurableProviders().map(entry => entry.provider).sort())
      .toEqual([ROUTE, 'second'])
    expect(mounted.applyCount()).toBe(1)
  })

  it('resolves a named credential through the credentials service and reports a missing or unusable one', async () => {
    const resolve = vi.fn(async (reference: string) => reference === 'SERVICE_KEY' ? { value: 'sk-from-service' } : undefined)
    const mounted = await boot({ [ROUTE]: profile({ baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'SERVICE_KEY' }) })
    mounted.ctx.provide('credentials', { resolve })

    // The mock endpoint does not exist: reaching a transport failure proves the
    // credential stage succeeded, and the fake service was asked for the ref.
    expect(await streamFailure(mounted.ctx, ROUTE)).toBe('TRANSPORT')
    expect(resolve).toHaveBeenCalledWith('SERVICE_KEY')

    // A named reference that resolves to nothing fails by name, before the socket.
    resolve.mockResolvedValue(undefined)
    expect(await streamFailure(mounted.ctx, ROUTE)).toBe('MISSING_CREDENTIAL')

    // A resolved value no HTTP header can carry is refused with its own code.
    resolve.mockResolvedValue({ value: 'has spaces and\nnewlines' })
    expect(await streamFailure(mounted.ctx, ROUTE)).toBe('INVALID_CREDENTIAL')
  })

  it('reports catalog conversion losses through the logger once per distinct set', async () => {
    const catalog = {
      'openai-completions': {
        'chat:m': { id: 'm', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
        'embed:e': { id: 'e', type: 'embedding' },
      },
    }
    const mounted = await boot({ gateway: { catalog } })
    // The route serves from the converted facts...
    expect(mounted.ctx.llm.listProviders()).toMatchObject([{ id: 'gateway' }])
    expect(await mounted.ctx.llm.listModels('gateway')).toMatchObject([{ id: 'm' }])
    // ...and the converter's losses are reported through the plugin's own logger.
    const notes = (): string[] => mounted.warnings.filter(warning => warning.includes('catalog'))
    expect(notes()).toHaveLength(2)
    expect(notes().join('\n')).toContain('cost')
    expect(notes().join('\n')).toContain('embedding')
    // Re-resolving the same catalog does not repeat the notes.
    await mounted.update({ gateway: { catalog }, other: profile() })
    expect(notes()).toHaveLength(2)
  })

  it('registers its settings presentation through the real settings service', async () => {
    const configure = vi.spyOn(Settings.prototype, 'configure')
    const mounted = await boot()
    expect(configure).toHaveBeenCalledTimes(1)
    expect(configure.mock.calls[0]?.[0]).toEqual({ auto: false })
    expect(configure.mock.calls[0]?.[1]).toBeDefined()
    expect(mounted.ctx.get('settings')).toBeDefined()
  })
})

describe('optional model-defaults seam', () => {
  it('registers a describe callback for its settings namespace and answers profile vocabulary', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    const registrations: Array<{
      namespace: string
      describe: (request: ModelDefaultsRequest) => Promise<readonly DeclaredModelDefault[]>
    }> = []
    // The upstream runtime has no such seam; prototype-inject the dsh-lite one
    // so the plugin's optional registration path runs.
    const prototype = LlmRuntime.prototype as unknown as Record<string, unknown>
    prototype['registerModelDefaults'] = function registerModelDefaults(
      namespace: string,
      describe: (request: ModelDefaultsRequest) => Promise<readonly DeclaredModelDefault[]>,
    ): () => void {
      registrations.push({ namespace, describe })
      return () => {}
    }
    try {
      await ctx.plugin(LlmServiceLite, { providers: { [ROUTE]: profile({ models: [{ id: 'deepseek-v4-flash' }] }) } })
      expect(registrations).toHaveLength(1)
      expect(registrations[0]?.namespace).toBe('llm-service-lite')
      const entries = await registrations[0]?.describe({
        api: 'openai-chat-completions',
        models: ['deepseek-v4-flash', 'unknown-model'],
      }) ?? []
      expect(entries).toMatchObject([{ id: 'deepseek-v4-flash', capabilities: { effort: ['low', 'high', 'max'] } }])
      expect(entries[0]?.note).toContain('DeepSeek')
      expect(entries).toHaveLength(1)
    } finally {
      delete prototype['registerModelDefaults']
    }
  })
})
