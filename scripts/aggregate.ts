import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { type RegistryFile, RegistryFileSchema } from '../schema/registry.ts'
import { loadEntries } from './lib.ts'

export const MAX_REGISTRY_BYTES = 4 * 1024 * 1024
export const REGISTRY_OUTPUT_FILENAME = 'plugins.json'

export function assertRegistryArtifactSize(serialized: string): void {
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > MAX_REGISTRY_BYTES) {
    throw new Error(
      `registry artifact exceeds 4 MiB (${bytes} > ${MAX_REGISTRY_BYTES} UTF-8 bytes)`
    )
  }
}

export function serializeRegistry(file: RegistryFile): string {
  const output = RegistryFileSchema.parse(file)
  const serialized = `${JSON.stringify(output, null, 2)}\n`
  assertRegistryArtifactSize(serialized)
  return serialized
}

export async function aggregateRegistry(): Promise<void> {
  const { entries, problems } = await loadEntries()
  if (problems.length > 0) {
    console.error('✗ refusing to aggregate with invalid entries; run validate')
    for (const problem of problems) {
      console.error(`  ${problem.file}: ${problem.message}`)
    }
    process.exitCode = 1
    return
  }

  const file: RegistryFile = {
    version: 2,
    generatedAt: new Date().toISOString(),
    plugins: entries,
  }
  const serialized = serializeRegistry(file)
  const outUrl = new URL('../dist/', import.meta.url)
  await mkdir(outUrl, { recursive: true })
  await writeFile(new URL(REGISTRY_OUTPUT_FILENAME, outUrl), serialized)

  console.log(
    `✓ dist/${REGISTRY_OUTPUT_FILENAME} — ${entries.length} plugin(s), ${Buffer.byteLength(serialized)} UTF-8 bytes, generatedAt ${file.generatedAt}`
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await aggregateRegistry()
}
