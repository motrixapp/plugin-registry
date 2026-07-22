import { loadEntries } from './lib.ts'

const { entries, problems } = await loadEntries()

if (problems.length > 0) {
  console.error(`✗ ${problems.length} problem(s):`)
  for (const problem of problems) {
    console.error(`  ${problem.file}: ${problem.message}`)
  }
  process.exit(1)
}

console.log(`✓ ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} valid`)
