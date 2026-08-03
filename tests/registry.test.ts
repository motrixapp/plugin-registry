import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import conformance from '../schema/registry.conformance.json'
import fixture from '../schema/registry.fixture.json'
import {
  isCanonicalPublisherLocale,
  isMotrixLocaleTag,
  RegistryFileAuthoringSchema,
  RegistryFileSchema,
  RegistryPluginAuthoringSchema,
  resolveRegistryListing,
} from '../schema/registry.ts'
import {
  assertRegistryArtifactSize,
  MAX_REGISTRY_BYTES,
  REGISTRY_OUTPUT_FILENAME,
  serializeRegistry,
} from '../scripts/aggregate.ts'
import {
  compareCodeUnitStrings,
  loadEntries,
  validateEntry,
} from '../scripts/lib.ts'

const baseEntry = {
  id: 'acme.unzip',
  listing: {
    defaultLocale: 'en-US',
    localizations: {
      'en-US': {
        name: 'Acme Unzip',
        description: 'Unzips things.',
        features: ['Extract archives'],
        keywords: ['archive'],
      },
      'zh-CN': { name: 'Acme 解压' },
    },
  },
  version: '1.0.0',
  author: { name: 'Acme' },
  origin: 'community' as const,
  categories: ['post-action'],
  engines: { motrix: '>=2.0.0' },
  package: {
    url: 'https://github.com/acme/unzip/releases/download/v1.0.0/unzip.zip',
    sha256: 'a'.repeat(64),
    size: 1234,
  },
  updatedAt: '2026-07-01',
}

describe('contract fixture (lockstep)', () => {
  it('parses the registry v2 fixture without field loss', () => {
    const parsed = RegistryFileSchema.parse(fixture)
    expect(parsed.plugins).toHaveLength(3)
    expect(parsed.plugins[0]?.listing.localizations['ja-JP']).toEqual({
      name: 'サンプル・アーカイブ展開',
      features: [],
    })
    const builtin = parsed.plugins.find((p) => p.id === 'motrix.url-resolver')
    expect(builtin?.package?.signature).toBe('c2lnbmF0dXJl')
  })
})

describe('Motrix BCP 47 profile', () => {
  it.each([
    'en-US',
    'zh-Hant',
    'ja',
    'sl-1994-biske',
    'iw-IL',
    'und',
    'abcd',
  ])('accepts safe wire tag %s', (tag) => {
    expect(isMotrixLocaleTag(tag)).toBe(true)
  })

  it.each([
    'zh_cn',
    'zh-cn',
    'en-US-u-ca-gregory',
    'de-DE-x-phonebk',
    'e',
    `en-${'a'.repeat(256)}`,
  ])('rejects malformed wire tag %s', (tag) => {
    expect(isMotrixLocaleTag(tag)).toBe(false)
  })

  it.each(['en-US', 'zh-Hant', 'ja', 'sl-1994-biske'])(
    'accepts canonical publisher tag %s',
    (tag) => {
      expect(isCanonicalPublisherLocale(tag)).toBe(true)
    }
  )

  it.each(['zh-cn', 'iw-IL', 'und', 'abcd', 'en-US-u-ca-gregory'])(
    'rejects noncanonical publisher tag %s',
    (tag) => {
      expect(isCanonicalPublisherLocale(tag)).toBe(false)
    }
  )
})

describe('tolerant wire and strict authoring contracts', () => {
  it('rejects legacy-only and mixed old/new entries in both contracts', () => {
    const removedEditorialFields = {
      name: Object.fromEntries([['en', 'Legacy name']]),
      description: Object.fromEntries([['en', 'Legacy description']]),
      features: Object.fromEntries([['en', ['Legacy feature']]]),
    }
    const legacyOnly = {
      ...baseEntry,
      ...removedEditorialFields,
    } as Record<string, unknown>
    delete legacyOnly.listing
    expect(RegistryPluginAuthoringSchema.safeParse(legacyOnly).success).toBe(
      false
    )

    const mixed = { ...baseEntry, ...removedEditorialFields }
    expect(RegistryPluginAuthoringSchema.safeParse(mixed).success).toBe(false)
    expect(
      RegistryFileSchema.safeParse({
        version: 2,
        generatedAt: '2026-08-02T00:00:00.000Z',
        plugins: [mixed],
      }).success
    ).toBe(false)
  })

  it('preserves unrelated future plugin-root fields in the tolerant wire schema', () => {
    const raw = {
      ...baseEntry,
      futureMetadata: { tagline: 'Future metadata' },
    }
    expect(
      RegistryFileSchema.parse({
        version: 2,
        generatedAt: '2026-08-02T00:00:00.000Z',
        plugins: [raw],
      }).plugins[0]?.futureMetadata
    ).toEqual({ tagline: 'Future metadata' })
    expect(RegistryPluginAuthoringSchema.safeParse(raw).success).toBe(false)
  })

  it('preserves a future-only localization while strict authoring rejects it', () => {
    const raw = structuredClone(baseEntry) as Record<string, any>
    raw.listing.localizations.fr = { tagline: 'Future field' }
    const wire = RegistryPluginAuthoringSchema.safeParse(raw)
    expect(RegistryFileSchema.parse({
      version: 2,
      generatedAt: '2026-08-02T00:00:00.000Z',
      plugins: [raw],
    }).plugins[0]?.listing.localizations.fr).toEqual({ tagline: 'Future field' })
    expect(wire.success).toBe(false)
  })

  it.each([
    ['plugin', { future: true }],
    ['author', { author: { ...baseEntry.author, future: true } }],
    ['engines', { engines: { ...baseEntry.engines, future: true } }],
    ['package', { package: { ...baseEntry.package, future: true } }],
    ['listing', { listing: { ...baseEntry.listing, future: true } }],
  ])('rejects unknown authoring fields at the %s layer', (_layer, patch) => {
    expect(
      RegistryPluginAuthoringSchema.safeParse({ ...baseEntry, ...patch }).success
    ).toBe(false)
  })

  it('rejects a localized typo even beside a valid field', () => {
    const raw = structuredClone(baseEntry) as Record<string, any>
    raw.listing.localizations['zh-CN'] = {
      name: '合法名称',
      descripton: '拼错字段',
    }
    expect(RegistryPluginAuthoringSchema.safeParse(raw).success).toBe(false)
    expect(
      RegistryFileSchema.parse({
        version: 2,
        generatedAt: '2026-08-02T00:00:00.000Z',
        plugins: [raw],
      }).plugins[0]?.listing.localizations['zh-CN']?.descripton
    ).toBe('拼错字段')
  })

  it('requires a complete default and rejects empty sparse records', () => {
    const incomplete = structuredClone(baseEntry) as Record<string, any>
    delete incomplete.listing.localizations['en-US'].description
    expect(RegistryPluginAuthoringSchema.safeParse(incomplete).success).toBe(false)

    const empty = structuredClone(baseEntry) as Record<string, any>
    empty.listing.localizations.fr = {}
    expect(RegistryPluginAuthoringSchema.safeParse(empty).success).toBe(false)
    expect(
      RegistryFileSchema.safeParse({
        version: 2,
        generatedAt: '2026-08-02T00:00:00.000Z',
        plugins: [empty],
      }).success
    ).toBe(false)
  })

  it('rejects non-trimmed, non-NFC, control-bearing, duplicate and oversized text', () => {
    const values = [
      ' padded',
      'e\u0301',
      'bad\u0000text',
      'x'.repeat(81),
    ]
    for (const name of values) {
      const raw = structuredClone(baseEntry) as Record<string, any>
      raw.listing.localizations['en-US'].name = name
      expect(RegistryPluginAuthoringSchema.safeParse(raw).success).toBe(false)
      expect(
        RegistryFileSchema.safeParse({
          version: 2,
          generatedAt: '2026-08-02T00:00:00.000Z',
          plugins: [raw],
        }).success
      ).toBe(false)
    }

    const duplicate = structuredClone(baseEntry) as Record<string, any>
    duplicate.listing.localizations['en-US'].features = ['same', 'same']
    expect(RegistryPluginAuthoringSchema.safeParse(duplicate).success).toBe(false)
  })

  it('keeps the 32-locale cap in authoring policy, not the wire schema', () => {
    const raw = structuredClone(baseEntry) as Record<string, any>
    for (let i = 0; i < 31; i += 1) {
      raw.listing.localizations[`en-v${String(i).padStart(4, '0')}`] = {
        name: `N${i}`,
      }
    }
    expect(RegistryPluginAuthoringSchema.safeParse(raw).success).toBe(false)
    expect(
      RegistryFileSchema.safeParse({
        version: 2,
        generatedAt: '2026-08-02T00:00:00.000Z',
        plugins: [raw],
      }).success
    ).toBe(true)
  })

  it('rejects duplicate plugin ids at the file level', () => {
    const input = {
      version: 2,
      generatedAt: '2026-08-02T00:00:00.000Z',
      plugins: [baseEntry, structuredClone(baseEntry)],
    }
    expect(RegistryFileSchema.safeParse(input).success).toBe(false)
    expect(RegistryFileAuthoringSchema.safeParse(input).success).toBe(false)
  })
})

describe('exact listing resolver', () => {
  const listing = {
    defaultLocale: 'en-US',
    localizations: {
      'en-US': {
        name: 'Default name',
        description: 'Default description',
        features: ['default feature'],
        keywords: ['default keyword'],
      },
      'zh-CN': { name: '简体名称' },
      'zh-Hant': { description: '繁體說明', features: [] },
      'sl-1994-biske': { name: 'Biske name' },
      fr: { name: 'Nom français', keywords: [] },
    },
  }

  it.each([
    ['fr-FR', 'Nom français', 'Default description'],
    ['zh-TW', 'Default name', '繁體說明'],
    ['zh-CN', '简体名称', 'Default description'],
    ['zh-TW-u-ca-chinese', 'Default name', '繁體說明'],
    ['sl-1994-biske-rozaj', 'Biske name', 'Default description'],
  ])('resolves %s field-by-field', (requested, name, description) => {
    expect(resolveRegistryListing(listing, requested)).toMatchObject({
      name,
      description,
    })
  })

  it.each(['invalid_locale', 'und', 'und-Latn', 'und-Cyrl'])(
    'uses only default for %s',
    (requested) => {
      expect(resolveRegistryListing(listing, requested)).toEqual({
        name: 'Default name',
        description: 'Default description',
        features: ['default feature'],
        keywords: ['default keyword'],
      })
    }
  )

  it('does not choose an arbitrary sibling region', () => {
    const onlySimplified = {
      defaultLocale: 'en-US',
      localizations: {
        'en-US': { name: 'English', description: 'English description' },
        'zh-CN': { name: '简体中文', description: '简体说明' },
      },
    }
    expect(resolveRegistryListing(onlySimplified, 'zh-TW').name).toBe('English')
  })

  it('treats explicit empty arrays as overrides', () => {
    const resolved = resolveRegistryListing(listing, 'zh-Hant-TW')
    expect(resolved.features).toEqual([])
    expect(resolveRegistryListing(listing, 'fr-FR').keywords).toEqual([])
  })

  it('is independent of locale-map insertion order', () => {
    const reversed = {
      ...listing,
      localizations: Object.fromEntries(
        Object.entries(listing.localizations).reverse()
      ),
    }
    expect(resolveRegistryListing(reversed, 'zh-TW')).toEqual(
      resolveRegistryListing(listing, 'zh-TW')
    )
  })
})

type PathPart = string | number
type CorpusOperation = {
  op: 'set' | 'delete' | 'appendCopy'
  path: PathPart[]
  from?: PathPart[]
  value?: unknown
}

function atPath(root: any, parts: PathPart[]): any {
  return parts.reduce((value, part) => value[part], root)
}

function materializeCase(operations: CorpusOperation[]): any {
  const result = structuredClone(conformance.baseFile)
  for (const operation of operations) {
    if (operation.op === 'appendCopy') {
      atPath(result, operation.path).push(
        structuredClone(atPath(result, operation.from ?? []))
      )
      continue
    }
    const parent = atPath(result, operation.path.slice(0, -1))
    const key = operation.path.at(-1) as string | number
    if (operation.op === 'delete') delete parent[key]
    else parent[key] = structuredClone(operation.value)
  }
  return result
}

function authoringAccepts(input: any): boolean {
  if (!RegistryFileAuthoringSchema.safeParse(input).success) return false
  return input.plugins.every(
    (entry: Record<string, unknown>) =>
      validateEntry(`${String(entry.id)}.json`, entry).problems.length === 0
  )
}

describe('shared three-channel conformance corpus', () => {
  for (const corpusCase of conformance.cases) {
    it(corpusCase.id, () => {
      const input = materializeCase(
        corpusCase.operations as CorpusOperation[]
      )
      const wire = RegistryFileSchema.safeParse(input)
      expect(wire.success).toBe(corpusCase.wireExpected.accepted)
      if (wire.success) {
        for (const preserved of corpusCase.wireExpected.preservedPaths ?? []) {
          expect(atPath(wire.data, preserved as PathPart[])).toEqual(
            atPath(input, preserved as PathPart[])
          )
        }
      }
      if (corpusCase.authoringExpected) {
        expect(authoringAccepts(input)).toBe(
          corpusCase.authoringExpected.accepted
        )
      }
      if (corpusCase.resolverExpected && wire.success) {
        const plugin = wire.data.plugins.find(
          (entry) => entry.id === corpusCase.resolverExpected?.pluginId
        )
        expect(plugin).toBeDefined()
        expect(
          resolveRegistryListing(
            plugin!.listing,
            corpusCase.resolverExpected.requestedLocale
          )
        ).toEqual(corpusCase.resolverExpected.resolved)
      }
    })
  }
})

describe('published entries and policy', () => {
  it('sorts protocol ids independently of the host locale', () => {
    const ids = ['a.cz', 'a.ch']
    expect([...ids].sort(compareCodeUnitStrings)).toEqual(['a.ch', 'a.cz'])
    expect([...ids].sort(new Intl.Collator('cs-CZ').compare)).toEqual([
      'a.cz',
      'a.ch',
    ])
  })

  it('all plugins/ entries pass schema and policy checks in id order', async () => {
    const { entries, problems } = await loadEntries()
    expect(problems).toEqual([])
    expect(entries).toHaveLength(3)
    expect(entries.map((entry) => entry.id)).toEqual(
      [...entries.map((entry) => entry.id)].sort(compareCodeUnitStrings)
    )
    expect(entries.every((entry) => entry.listing.defaultLocale === 'en-US')).toBe(
      true
    )
  })

  it('rejects a filename mismatch, unregistered category and bad asset', () => {
    expect(validateEntry('other.json', baseEntry).problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: expect.stringMatching(/filename/) })])
    )
    expect(
      validateEntry('acme.unzip.json', {
        ...baseEntry,
        categories: ['brand-new'],
        icon: 'https://elsewhere.example/icon.png',
      }).problems.map((problem) => problem.message).join('\n')
    ).toMatch(/unregistered category[\s\S]*assets/)
  })

  it('rejects malformed UTF-8 before JSON parsing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'registry-invalid-utf8-'))
    try {
      await writeFile(
        path.join(dir, 'bad.json'),
        Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])
      )
      const { problems } = await loadEntries(dir)
      expect(problems[0]?.message).toMatch(/UTF-8/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('artifact byte gate', () => {
  it('serializes the stable registry-v2 filename, root, order and shape', async () => {
    const { entries, problems } = await loadEntries()
    expect(problems).toEqual([])
    const serialized = serializeRegistry({
      version: 2,
      generatedAt: '2026-08-02T00:00:00.000Z',
      plugins: entries,
    })
    const output = JSON.parse(serialized) as Record<string, any>

    expect(REGISTRY_OUTPUT_FILENAME).toBe('plugins.json')
    expect(output.version).toBe(2)
    expect(serialized.endsWith('\n')).toBe(true)
    expect(output.plugins.map((plugin: any) => plugin.id)).toEqual(
      [...output.plugins.map((plugin: any) => plugin.id)].sort(
        compareCodeUnitStrings
      )
    )
    for (const plugin of output.plugins) {
      expect(Object.hasOwn(plugin, 'name')).toBe(false)
      expect(Object.hasOwn(plugin, 'description')).toBe(false)
      expect(Object.hasOwn(plugin, 'features')).toBe(false)
      expect(plugin.listing.defaultLocale).toBe('en-US')
    }
  })

  it('includes the final newline and accepts exactly 4 MiB', () => {
    const exact = `${'a'.repeat(MAX_REGISTRY_BYTES - 1)}\n`
    expect(() => assertRegistryArtifactSize(exact)).not.toThrow()
  })

  it('rejects one UTF-8 byte over 4 MiB', () => {
    const over = `${'a'.repeat(MAX_REGISTRY_BYTES - 1)}é\n`
    expect(() => assertRegistryArtifactSize(over)).toThrow(/4 MiB|4194304/)
  })
})
