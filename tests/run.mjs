/** Run each Node test file in an isolated process without piped child stdio. */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const testFile = name => fileURLToPath(new URL(name, import.meta.url))

const required = [
  'phase1-rules.test.mjs',
  'registry-cache.test.mjs',
  'discovery-enricher.test.mjs',
  'storage-prober-importer.test.mjs',
  'service-tool.test.mjs',
]
const optional = ['client-registration.test.mjs']

for (const name of [...required, ...optional.filter(name => existsSync(testFile(name)))]) {
  const file = testFile(name)
  if (!existsSync(file)) {
    console.error(`${name}: test file is missing`)
    process.exit(1)
  }
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit', timeout: 30_000 })
  if (result.error) {
    console.error(`${name}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}
