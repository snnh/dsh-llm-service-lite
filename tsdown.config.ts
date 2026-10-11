import { defineConfig } from 'tsdown'

/**
 * Bundles the tsc-emitted ESM (`lib/types`) into the published runtime entry.
 * Every harness package is a peer/dev dependency and stays external: the
 * profile that loads this plugin owns the single runtime copy of the harness,
 * and a second bundled copy would break the module singletons Cordis relies on.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { neverBundle: [/^@deepseek-ai\//, /^eventsource-parser/] },
})
