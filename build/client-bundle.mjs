#!/usr/bin/env node
/**
 * Bundle the browser half into the client module system's factory format.
 *
 * The dsh web client loads a package's `./client` export as one script that
 * registers a closure: `window.__ModuleLoader__.load({ id, factory })`, where
 * the injected `require` answers exactly the frozen module table (React,
 * Cordis, and the shared UI packages) and everything else is inlined. This
 * script reproduces that contract from the JavaScript `tsc` already emitted so
 * the package can be built without a dsh checkout.
 *
 * Input: `lib/types/client/index.js` (tsc output beside the declarations).
 * Output: `lib/client.js`, the file the package's `./client` export names.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

/**
 * The shell's frozen module table (harness 0.2.1-rc.2, `packages/client/web/src/platform.ts`).
 * Every entry here is answered by the page's `require`; anything else must be
 * declared in `dsh.client.external` or bundled.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const declaredExternals = manifest.dsh?.client?.external ?? []
const externals = new Set([...PLATFORM_MODULES, ...declaredExternals])

let rolldown
try {
  ({ rolldown } = await import('rolldown'))
} catch (error) {
  console.error('client-bundle: rolldown is required to build the browser half')
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const bundle = await rolldown({
  input: resolve(root, 'lib/types/client/index.js'),
  external: (source) => externals.has(source) || source.startsWith('node:'),
  platform: 'browser',
  resolve: { conditionNames: ['browser', 'import', 'module', 'default'] },
})

const { output } = await bundle.generate({
  format: 'cjs',
  sourcemap: true,
  // One entry, one artifact: the package publishes `lib/client.js` exactly.
  codeSplitting: false,
  entryFileNames: 'client.js',
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {`,
  intro: 'var module = { exports: {} }; var exports = module.exports;',
  footer: 'return module.exports; } });',
})

let wrote = 0
for (const chunk of output) {
  if (chunk.type === 'chunk' && chunk.fileName === 'client.js') {
    await mkdir(resolve(root, 'lib'), { recursive: true })
    await writeFile(resolve(root, 'lib/client.js'), chunk.code, 'utf8')
    if (typeof chunk.map === 'string') {
      await writeFile(resolve(root, 'lib/client.js.map'), chunk.map, 'utf8')
    }
    wrote += 1
  }
}
if (wrote === 0) {
  console.error('client-bundle: rolldown produced no client.js chunk')
  process.exit(1)
}
console.log(`client-bundle: wrote lib/client.js (${String(externals.size)} external modules)`)
