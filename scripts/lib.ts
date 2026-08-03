import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ASSETS_BASE_URL,
  REGISTERED_CATEGORIES,
  type RegistryPlugin,
  RegistryPluginAuthoringSchema,
} from '../schema/registry.ts'

export const PLUGINS_DIR = new URL('../plugins/', import.meta.url).pathname

/** Hosts a community package may be downloaded from (spec §9). */
const PACKAGE_URL_ALLOWLIST = [
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//,
  /^https:\/\/dl\.motrix\.app\//,
]

export interface EntryProblem {
  file: string
  message: string
}

/** Locale-independent UTF-16 code-unit order for ASCII protocol identifiers. */
export function compareCodeUnitStrings(a: string, b: string): number {
  if (a === b) return 0
  const commonLength = Math.min(a.length, b.length)
  for (let index = 0; index < commonLength; index += 1) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index)
    if (difference !== 0) return difference
  }
  return a.length - b.length
}

/**
 * Repo-level policy checks layered on top of the wire schema. The wire
 * schema stays identical across the three vendored copies; these rules
 * only gate what may be merged into THIS repo.
 */
export function validateEntry(
  file: string,
  raw: unknown
): { entry?: RegistryPlugin; problems: EntryProblem[] } {
  const problems: EntryProblem[] = []
  const parsed = RegistryPluginAuthoringSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map((issue) => ({
        file,
        message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      })),
    }
  }
  const entry = parsed.data

  if (entry.listing.defaultLocale !== 'en-US') {
    problems.push({
      file,
      message: 'publisher policy requires listing.defaultLocale to be "en-US"',
    })
  }

  if (path.basename(file) !== `${entry.id}.json`) {
    problems.push({
      file,
      message: `filename must be "${entry.id}.json" (one entry per plugin id)`,
    })
  }

  if (entry.id.startsWith('motrix.') && entry.origin !== 'builtin') {
    problems.push({
      file,
      message: 'the "motrix.*" id namespace is reserved for builtin plugins',
    })
  }

  if (entry.origin === 'community' && !entry.package) {
    problems.push({
      file,
      message: 'community entries must carry a package install pointer',
    })
  }

  if (
    entry.origin === 'builtin' &&
    entry.package &&
    !entry.package.signature
  ) {
    problems.push({
      file,
      message:
        'a builtin package must carry an ed25519 signature (hot-update trust root)',
    })
  }

  if (
    entry.package &&
    !PACKAGE_URL_ALLOWLIST.some((re) => re.test(entry.package?.url ?? ''))
  ) {
    problems.push({
      file,
      message:
        'package.url must be a GitHub release asset or a dl.motrix.app URL',
    })
  }

  for (const category of entry.categories) {
    if (!(REGISTERED_CATEGORIES as readonly string[]).includes(category)) {
      problems.push({
        file,
        message: `unregistered category "${category}" (register it in schema/registry.ts first)`,
      })
    }
  }

  const assetPrefix = `${ASSETS_BASE_URL}/${entry.id}/`
  for (const url of [entry.icon, ...entry.screenshots]) {
    if (url !== undefined && !url.startsWith(assetPrefix)) {
      problems.push({
        file,
        message: `asset "${url}" must live under ${assetPrefix} (spec §3.3)`,
      })
    }
  }

  return { entry, problems }
}

export async function loadEntries(dir = PLUGINS_DIR): Promise<{
  entries: RegistryPlugin[]
  problems: EntryProblem[]
}> {
  const entries: RegistryPlugin[] = []
  const problems: EntryProblem[] = []
  const seen = new Map<string, string>()

  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  for (const file of files) {
    let raw: unknown
    try {
      const bytes = await readFile(path.join(dir, file))
      const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      raw = JSON.parse(source)
    } catch (error) {
      const message =
        error instanceof TypeError
          ? `invalid UTF-8: ${error.message}`
          : `invalid JSON: ${String(error)}`
      problems.push({ file, message })
      continue
    }
    const result = validateEntry(file, raw)
    problems.push(...result.problems)
    if (!result.entry) continue

    const existing = seen.get(result.entry.id)
    if (existing) {
      problems.push({
        file,
        message: `duplicate id "${result.entry.id}" (already in ${existing})`,
      })
      continue
    }
    seen.set(result.entry.id, file)
    entries.push(result.entry)
  }

  entries.sort((a, b) => compareCodeUnitStrings(a.id, b.id))
  return { entries, problems }
}
