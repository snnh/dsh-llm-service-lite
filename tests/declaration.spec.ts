/**
 * Guards the package's own declarations: the bundle layer that mounts the
 * plugin, the display resources a plugin inventory reads without loading it, and
 * the manifest fields that make both reachable from a packed installation.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
  description?: string
  sideEffects?: boolean
  exports: Record<string, unknown>
  files: string[]
  dsh?: { bundle?: { patch?: string | string[] } }
}

/** Language ids the harness accepts as locale filenames. */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/
/** Raw icon size the harness admits to plugin metadata. */
const MAX_ICON_BYTES = 256 * 1024

const patchFiles = (): string[] => {
  const patch = manifest.dsh?.bundle?.patch
  return typeof patch === 'string' ? [patch] : patch ?? []
}

const localeFiles = (): string[] => readdirSync(new URL('../locale/', import.meta.url))

describe('bundle declaration', () => {
  it('declares one bundle patch that exists and inserts this plugin row', () => {
    expect(patchFiles()).toEqual(['./cordis.patch.yml'])
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    // Exactly one inserted row, mounting this package by its published name.
    expect(patch).toMatch(new RegExp(
      `- insert:\\n {4}- id: llm-service-lite\\n {6}name: '${manifest.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}'`,
      'u',
    ))
    expect(patch.split('- insert:')).toHaveLength(2)
  })

  it('ships the patch file in the packed installation', () => {
    expect(manifest.files).toContain('cordis.patch.yml')
  })
})

describe('display metadata', () => {
  it('resolves an English locale with a title and description', () => {
    const english = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8')) as {
      meta?: { title?: unknown; description?: unknown }
    }
    expect(typeof english.meta?.title).toBe('string')
    expect(typeof english.meta?.description).toBe('string')
  })

  it('names every locale file with a language id and fills both display fields', () => {
    const files = localeFiles()
    expect(files).toContain('en.json')
    for (const file of files) {
      const language = file.replace(/\.json$/u, '')
      if (language === file) throw new Error(`locale/${file} must be JSON named after a language id`)
      expect(LANGUAGE_ID.test(language)).toBe(true)
      const parsed = JSON.parse(readFileSync(new URL(`../locale/${file}`, import.meta.url), 'utf8')) as {
        meta?: { title?: unknown; description?: unknown }
      }
      expect(typeof parsed.meta?.title, `locale/${file}: meta.title`).toBe('string')
      expect(typeof parsed.meta?.description, `locale/${file}: meta.description`).toBe('string')
    }
  })

  it('exports the locale directory and an icon inside the size limit', () => {
    expect(manifest.exports['./locale/*.json']).toBe('./locale/*.json')
    expect(manifest.exports['./icon']).toBe('./icon.svg')
    expect(manifest.files).toContain('locale/*.json')
    expect(manifest.files).toContain('icon.svg')
    const icon = readFileSync(new URL('../icon.svg', import.meta.url))
    expect(icon.length).toBeLessThanOrEqual(MAX_ICON_BYTES)
    expect(icon.length).toBeGreaterThan(0)
    const text = icon.toString('utf8')
    expect(text).toMatch(/^<svg[\s>]/u)
    expect(text).toContain('xmlns="http://www.w3.org/2000/svg"')
  })
})

describe('package identity', () => {
  it('names the package and its runtime entry for the harness to resolve', () => {
    expect(manifest.name).toBe('@snnh/dsh-llm-service-lite')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
    expect(manifest.description?.trim()).not.toBe('')
    expect(manifest.exports['.']).toMatchObject({ default: './lib/index.js' })
    expect(manifest.files).toContain('lib/index.js')
    // Module evaluation only declares exports; registration happens in apply().
    expect(manifest.sideEffects).toBe(false)
  })
})
