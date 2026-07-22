import { mkdir, writeFile } from 'node:fs/promises'
import { type RegistryFile, RegistryFileSchema } from '../schema/registry.ts'
import { loadEntries } from './lib.ts'

const { entries, problems } = await loadEntries()

if (problems.length > 0) {
  console.error('✗ refusing to aggregate with invalid entries; run validate')
  for (const problem of problems) {
    console.error(`  ${problem.file}: ${problem.message}`)
  }
  process.exit(1)
}

const file: RegistryFile = {
  version: 1,
  generatedAt: new Date().toISOString(),
  plugins: entries,
}
// Round-trip through the schema so the published artifact is exactly what
// consumers will parse (defaults materialized, nothing extra).
const output = RegistryFileSchema.parse(file)

const outUrl = new URL('../dist/', import.meta.url)
await mkdir(outUrl, { recursive: true })
await writeFile(
  new URL('plugins.json', outUrl),
  `${JSON.stringify(output, null, 2)}\n`
)

console.log(
  `✓ dist/plugins.json — ${output.plugins.length} plugin(s), generatedAt ${output.generatedAt}`
)
