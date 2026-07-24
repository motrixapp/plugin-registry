import { describe, expect, it } from 'vitest'
import fixture from '../schema/registry.fixture.json'
import { RegistryFileSchema } from '../schema/registry.ts'
import { loadEntries, validateEntry } from '../scripts/lib.ts'

describe('contract fixture (lockstep)', () => {
  // The same fixture is vendored byte-identical into motrix-website and
  // motrix-turbo. A parse failure here means this repo drifted from its
  // consumers — land the change in all three repos in one PR cycle.
  it('parses unchanged', () => {
    const parsed = RegistryFileSchema.parse(fixture)
    expect(parsed.plugins).toHaveLength(3)
    // Guards that the vendored schema actually carries the Phase-2
    // signature field (Zod would otherwise silently strip it).
    const builtin = parsed.plugins.find((p) => p.id === 'motrix.url-resolver')
    expect(builtin?.package?.signature).toBe('c2lnbmF0dXJl')
  })
})

describe('published entries', () => {
  it('all plugins/ entries pass schema and policy checks', async () => {
    const { entries, problems } = await loadEntries()
    expect(problems).toEqual([])
    expect(entries.length).toBeGreaterThanOrEqual(3)
    expect(entries.map((e) => e.id)).toEqual(
      [...entries.map((e) => e.id)].sort()
    )
  })
})

describe('validateEntry policy', () => {
  const base = {
    id: 'acme.unzip',
    name: { en: 'Acme Unzip' },
    description: { en: 'Unzips things.' },
    version: '1.0.0',
    author: { name: 'Acme' },
    origin: 'community',
    categories: ['post-action'],
    engines: { motrix: '>=2.0.0' },
    package: {
      url: 'https://github.com/acme/unzip/releases/download/v1.0.0/unzip.zip',
      sha256: 'a'.repeat(64),
      size: 1234,
    },
    updatedAt: '2026-07-01',
  }

  it('accepts a valid community entry', () => {
    expect(validateEntry('acme.unzip.json', base).problems).toEqual([])
  })

  it('rejects filename/id mismatch', () => {
    const { problems } = validateEntry('other.json', base)
    expect(problems[0]?.message).toMatch(/filename must be/)
  })

  it('reserves the motrix.* namespace for builtins', () => {
    const { problems } = validateEntry('motrix.unzip.json', {
      ...base,
      id: 'motrix.unzip',
    })
    expect(problems.some((p) => /reserved for builtin/.test(p.message))).toBe(
      true
    )
  })

  it('requires a package pointer on community entries', () => {
    const { package: _omit, ...noPackage } = base
    const { problems } = validateEntry('acme.unzip.json', noPackage)
    expect(problems.some((p) => /package install pointer/.test(p.message))).toBe(
      true
    )
  })

  it('rejects package URLs outside the allowlist', () => {
    const { problems } = validateEntry('acme.unzip.json', {
      ...base,
      package: { ...base.package, url: 'https://evil.example.com/x.zip' },
    })
    expect(problems.some((p) => /allowlist|GitHub release/.test(p.message))).toBe(
      true
    )
  })

  it('rejects unregistered category slugs', () => {
    const { problems } = validateEntry('acme.unzip.json', {
      ...base,
      categories: ['brand-new'],
    })
    expect(problems.some((p) => /unregistered category/.test(p.message))).toBe(
      true
    )
  })

  it('pins assets to the per-plugin assets prefix', () => {
    const { problems } = validateEntry('acme.unzip.json', {
      ...base,
      icon: 'https://elsewhere.example.com/icon.png',
    })
    expect(problems.some((p) => /assets/.test(p.message))).toBe(true)

    const ok = validateEntry('acme.unzip.json', {
      ...base,
      icon: 'https://dl.motrix.app/registry/assets/acme.unzip/icon.png',
    })
    expect(ok.problems).toEqual([])
  })

  it('requires a signature on a builtin package', () => {
    const { problems } = validateEntry('motrix.demo.json', {
      ...base,
      id: 'motrix.demo',
      origin: 'builtin',
      package: {
        url: 'https://github.com/motrixapp/builtin-plugins/releases/download/x/x.moext',
        sha256: 'a'.repeat(64),
        size: 10,
      },
    })
    expect(
      problems.some((p) => /builtin package.*signature|signature/.test(p.message))
    ).toBe(true)
  })

  it('accepts a builtin package that carries a signature', () => {
    const { problems } = validateEntry('motrix.demo.json', {
      ...base,
      id: 'motrix.demo',
      origin: 'builtin',
      categories: ['integration'],
      package: {
        url: 'https://github.com/motrixapp/builtin-plugins/releases/download/x/x.moext',
        sha256: 'a'.repeat(64),
        size: 10,
        signature: 'c2ln',
      },
    })
    expect(problems).toEqual([])
  })
})
