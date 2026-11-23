/**
 * Validate the standalone package contract without loading a live DSH profile.
 *
 * Everything except the Client bundle check runs in-process: JSON documents are
 * parsed, every `lib/*.js` module is imported to prove its syntax and relative
 * imports resolve, and every relative Markdown link is resolved. `client.js` is
 * a DSH module-loader bundle rather than an importable ES module, so it is
 * syntax-checked with `node --check` in a child process whose stdio is
 * inherited; the script never captures a child's output through a pipe.
 *
 * Run with `node scripts/check-package.mjs` from the package root. The script
 * exits non-zero when a contract or documentation link is broken, and it names
 * a missing `client.js` explicitly instead of reporting an unrelated failure.
 */
import { spawnSync } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const note = message => problems.push(message)

/** Test whether a repository-relative path is a regular file. */
async function isFile(path) {
  try {
    return (await stat(resolve(root, path))).isFile()
  } catch {
    return false
  }
}

/** Test whether a repository-relative path is a directory. */
async function isDirectory(path) {
  try {
    return (await stat(resolve(root, path))).isDirectory()
  } catch {
    return false
  }
}

/** Record a failed invariant with a human-readable explanation. */
function expect(condition, message) {
  if (!condition) note(message)
}

/** Read one shipped text file, recording a missing file instead of throwing. */
async function readShipped(path) {
  try {
    return await readFile(resolve(root, path), 'utf8')
  } catch (error) {
    note(`cannot read ${path}: ${error.message}`)
    return undefined
  }
}

const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
expect(manifest.name === '@xiaoxing/api-provider-manager', 'package name must stay @xiaoxing/api-provider-manager')
expect(manifest.version === '0.1.0', 'package version must stay 0.1.0 until a release is authorized')
expect(manifest.type === 'module', 'package must stay an ES module package')
expect(manifest.private === true, 'publishing stays disabled until explicitly authorized')
expect(manifest.license === 'MIT', 'package must declare the MIT license')
expect(typeof manifest.description === 'string' && manifest.description.trim().length > 0, 'package needs a description')
expect(manifest.author?.name === 'xiaoxing-nya', 'author name must stay xiaoxing-nya')
expect(manifest.author?.email === 'xiaoxing_bot@luoli.my', 'author email must stay xiaoxing_bot@luoli.my')
expect(manifest.engines?.node === '>=22.0.0', 'Node engine floor must stay >=22.0.0')
expect(typeof manifest.engines?.dsh === 'string' && manifest.engines.dsh.includes('0.2.2-rc.1'), 'DSH compatibility range must stay declared')
expect(manifest.dsh?.manifestVersion === 1, 'dsh.manifestVersion must be 1')
expect(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must point at cordis.patch.yml')
expect(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform must stay web')
for (const dependency of ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-locale']) {
  expect(manifest.dsh?.client?.inject?.includes(dependency), `dsh.client.inject must include ${dependency}`)
}
expect(Array.isArray(manifest.keywords) && manifest.keywords.includes('dsh'), 'keywords must identify the DSH plugin')

const requiredFiles = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'LICENSE',
  'docs/api-provider-manager-design.md',
  'docs/release-check.md',
  'locale/en.json',
  'locale/zh.json',
  'data/model-catalog.json',
  'data/family-rules.json',
]
const missingFiles = []
for (const name of requiredFiles) {
  if (!(await isFile(name))) {
    missingFiles.push(name)
    note(`missing shipped file: ${name}`)
  }
}
for (const directory of ['lib', 'data', 'docs', 'locale', 'tests', 'scripts']) {
  expect(await isDirectory(directory), `missing source directory: ${directory}`)
}

const requiredEntrypoints = [
  'index.js',
  'client.js',
  'lib',
  'data',
  'cordis.patch.yml',
  'locale/*.json',
  'icon.svg',
  'README.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'docs',
  'LICENSE',
]
expect(Array.isArray(manifest.files), 'package files must be an array')
for (const entry of requiredEntrypoints) {
  expect(manifest.files?.includes(entry), `package files must distribute ${entry}`)
}

expect(manifest.exports && typeof manifest.exports === 'object', 'package must declare exports')
for (const [name, target] of Object.entries(manifest.exports ?? {})) {
  if (typeof target !== 'string') {
    note(`export ${name} must map to a path string`)
    continue
  }
  if (name.includes('*') || target.includes('*')) continue
  if (!(await isFile(target.replace(/^\.\//u, '')))) note(`export ${name} points at a missing file: ${target}`)
}

const patch = await readShipped('cordis.patch.yml')
if (patch !== undefined) {
  expect(!patch.includes('\r'), 'cordis.patch.yml must use LF line endings')
  expect(patch.endsWith('\n') && !patch.endsWith('\n\n'), 'cordis.patch.yml needs exactly one trailing newline')
  for (const fragment of [
    'id: xiaoxing-api-provider-manager',
    "name: '@xiaoxing/api-provider-manager'",
    "dataDir: !!js dshHomePath('xiaoxing', 'api-manager')",
  ]) {
    expect(patch.includes(fragment), `cordis.patch.yml must contain ${fragment}`)
  }
}

const localeNames = ['locale/en.json', 'locale/zh.json']
const locales = {}
for (const name of localeNames) {
  const text = await readShipped(name)
  if (text === undefined) continue
  try {
    locales[name] = JSON.parse(text)
  } catch (error) {
    note(`${name} is not valid JSON: ${error.message}`)
  }
}
if (locales['locale/en.json'] && locales['locale/zh.json']) {
  const en = locales['locale/en.json']
  const zh = locales['locale/zh.json']
  expect(en.meta && zh.meta, 'locale files must carry a meta object')
  expect(
    JSON.stringify(Object.keys(en.meta ?? {}).sort()) === JSON.stringify(Object.keys(zh.meta ?? {}).sort()),
    'locale en/zh meta keys must match',
  )
  for (const [name, meta] of [['locale/en.json', en.meta], ['locale/zh.json', zh.meta]]) {
    expect(typeof meta?.title === 'string' && meta.title.trim().length > 0, `${name} needs a non-empty meta.title`)
    expect(typeof meta?.description === 'string' && meta.description.trim().length > 0, `${name} needs a non-empty meta.description`)
  }
}

const icon = await readShipped('icon.svg')
if (icon !== undefined) {
  expect(Buffer.byteLength(icon, 'utf8') <= 256 * 1024, 'icon.svg must stay at or below 256 KiB')
  expect(icon.trimStart().startsWith('<svg'), 'icon.svg must start with an <svg root element')
  expect(icon.trimEnd().endsWith('</svg>'), 'icon.svg must close its <svg root element')
  expect(icon.includes('xmlns='), 'icon.svg must declare the SVG namespace')
  for (const forbidden of ['script', 'style', 'text', 'foreignObject']) {
    expect(!new RegExp(`<${forbidden}\\b`, 'iu').test(icon), `icon.svg must not contain <${forbidden}>`)
  }
}

let catalogCounts = null
const catalogText = await readShipped('data/model-catalog.json')
if (catalogText !== undefined) {
  try {
    const catalog = JSON.parse(catalogText)
    expect(catalog.schemaVersion === 1, 'data/model-catalog.json schemaVersion must be 1')
    expect(typeof catalog.generatedAt === 'string' && !Number.isNaN(Date.parse(catalog.generatedAt)), 'model catalog needs a valid generatedAt')
    const models = catalog.models
    expect(models && typeof models === 'object' && !Array.isArray(models), 'model catalog needs a models object')
    const aliases = catalog.aliases
    expect(aliases && typeof aliases === 'object' && !Array.isArray(aliases), 'model catalog needs an aliases object')
    const modelIds = Object.keys(models ?? {})
    const aliasIds = Object.keys(aliases ?? {})
    expect(modelIds.length >= 100 && modelIds.length <= 250, 'model catalog must carry the curated mainstream offline catalog, not a stub')
    expect(aliasIds.length > 0, 'model catalog must carry aliases for alternate model spellings')
    for (const id of modelIds) {
      const entry = models[id]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        note(`model catalog entry ${id} must be an object`)
        continue
      }
      expect(entry.id === id, `model catalog entry ${id} must carry its own id`)
      expect(typeof entry.name === 'string' && entry.name.trim().length > 0, `model catalog entry ${id} needs a name`)
      expect(entry.contextWindow === null || (Number.isInteger(entry.contextWindow) && entry.contextWindow > 0), `model catalog entry ${id} has an invalid contextWindow`)
      expect(entry.maxTokens === null || (Number.isInteger(entry.maxTokens) && entry.maxTokens > 0), `model catalog entry ${id} has an invalid maxTokens`)
      expect(Array.isArray(entry.input) && entry.input.length > 0, `model catalog entry ${id} needs an input array`)
      expect(typeof entry.reasoning === 'boolean', `model catalog entry ${id} needs a reasoning flag`)
      expect(typeof entry.allowOff === 'boolean', `model catalog entry ${id} needs an allowOff flag`)
      expect(Array.isArray(entry.efforts), `model catalog entry ${id} needs an efforts array`)
      expect(typeof entry.source === 'string' && entry.source.length > 0, `model catalog entry ${id} needs a source`)
      expect(entry.interleavedField === null || typeof entry.interleavedField === 'string', `model catalog entry ${id} has an invalid interleavedField`)
    }
    for (const [alias, target] of Object.entries(aliases ?? {})) {
      expect(typeof target === 'string' && Object.hasOwn(models ?? {}, target), `model catalog alias ${alias} must point at a bundled model`)
    }
    catalogCounts = { models: modelIds.length, aliases: aliasIds.length }
  } catch (error) {
    note(`data/model-catalog.json is not valid JSON: ${error.message}`)
  }
}

let ruleCount = null
const rulesText = await readShipped('data/family-rules.json')
if (rulesText !== undefined) {
  try {
    const rulesDoc = JSON.parse(rulesText)
    expect(rulesDoc.schemaVersion === 1, 'data/family-rules.json schemaVersion must be 1')
    expect(Array.isArray(rulesDoc.rules) && rulesDoc.rules.length > 0, 'family rules must be a non-empty array')
    const seenRules = new Set()
    for (const rule of rulesDoc.rules ?? []) {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        note('every family rule must be an object')
        continue
      }
      expect(typeof rule.id === 'string' && rule.id.trim().length > 0, 'every family rule needs a non-empty id')
      expect(!seenRules.has(rule.id), `family rule id ${JSON.stringify(rule.id)} must be unique`)
      seenRules.add(rule.id)
      expect(typeof rule.match === 'string' && rule.match.length > 0, `family rule ${rule.id} needs a match pattern`)
      if (typeof rule.match === 'string' && rule.match.length > 0) {
        try {
          new RegExp(rule.match, 'iu')
        } catch (error) {
          note(`family rule ${rule.id} has an invalid match pattern: ${error.message}`)
        }
      }
      expect(typeof rule.family === 'string' && rule.family.trim().length > 0, `family rule ${rule.id} needs a family`)
      expect(typeof rule.vendorGroup === 'string' && rule.vendorGroup.trim().length > 0, `family rule ${rule.id} needs a vendorGroup`)
      if (rule.contextWindow !== undefined) {
        expect(Number.isInteger(rule.contextWindow) && rule.contextWindow > 0, `family rule ${rule.id} has an invalid contextWindow`)
      }
      if (rule.maxTokens !== undefined) {
        expect(Number.isInteger(rule.maxTokens) && rule.maxTokens > 0, `family rule ${rule.id} has an invalid maxTokens`)
      }
      if (rule.input !== undefined) expect(Array.isArray(rule.input), `family rule ${rule.id} input must be an array`)
      if (rule.efforts !== undefined) expect(Array.isArray(rule.efforts), `family rule ${rule.id} efforts must be an array`)
      if (rule.allowOff !== undefined) expect(typeof rule.allowOff === 'boolean', `family rule ${rule.id} allowOff must be a boolean`)
      if (rule.compat !== undefined) {
        expect(rule.compat && typeof rule.compat === 'object' && !Array.isArray(rule.compat), `family rule ${rule.id} compat must be an object`)
      }
    }
    ruleCount = seenRules.size
  } catch (error) {
    note(`data/family-rules.json is not valid JSON: ${error.message}`)
  }
}

const libNames = (await readdir(resolve(root, 'lib')).catch(() => [])).filter(name => name.endsWith('.js')).sort()
expect(libNames.length >= 10, 'lib must ship every Host module, not a stub')
for (const name of libNames) {
  try {
    await import(pathToFileURL(resolve(root, 'lib', name)).href)
  } catch (error) {
    note(`lib/${name} failed to import: ${error.message}`)
  }
}
try {
  await import(pathToFileURL(resolve(root, 'index.js')).href)
} catch (error) {
  note(`index.js failed to import: ${error.message}`)
}
const clientAvailable = await isFile('client.js')
if (clientAvailable) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, 'client.js')], {
    stdio: 'inherit',
    timeout: 30_000,
  })
  if (result.error) note(`client.js could not be syntax-checked: ${result.error.message}`)
  else if (result.status !== 0) note(`client.js failed node --check (exit ${result.status ?? 'unknown'})`)
}

const documents = ['README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'docs/api-provider-manager-design.md', 'docs/release-check.md']
let linkCount = 0
for (const name of documents) {
  const text = await readShipped(name)
  if (text === undefined) continue
  expect(!text.includes('\r'), `${name} must use LF line endings`)
  expect(text.endsWith('\n') && !text.endsWith('\n\n'), `${name} needs exactly one trailing newline`)
  for (const match of text.matchAll(/\]\(<([^>]+)>\)/gu)) {
    linkCount += 1
    const target = match[1].split('#')[0].trim()
    if (target.length === 0) continue
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith('//')) continue
    const resolved = resolve(dirname(resolve(root, name)), target)
    const inside = relative(root, resolved)
    if (inside === '..' || inside.startsWith('../') || inside.startsWith('..\\')) {
      note(`${name} links outside the repository: ${target}`)
      continue
    }
    try {
      if (!(await stat(resolved)).isFile()) note(`${name} has a broken relative link: ${target}`)
    } catch {
      note(`${name} has a broken relative link: ${target}`)
    }
  }
}
for (const name of ['scripts/check-package.mjs', 'tests/run.mjs']) {
  const text = await readShipped(name)
  if (text === undefined) continue
  expect(!text.includes('\r'), `${name} must use LF line endings`)
  expect(text.endsWith('\n') && !text.endsWith('\n\n'), `${name} needs exactly one trailing newline`)
}

if (problems.length > 0) {
  console.error(`Package check failed with ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`- ${problem}`)
  if (missingFiles.includes('client.js')) {
    console.error('NOTE: client.js is the Web settings half and is still being built; the package cannot be packed or installed until it exists.')
  }
  process.exitCode = 1
} else {
  console.log(
    `Package contract, cordis patch, exports, shipped files, locale metadata, icon, ` +
      `data catalog (${catalogCounts?.models ?? 0} models, ${catalogCounts?.aliases ?? 0} aliases), ` +
      `family rules (${ruleCount ?? 0}), lib imports (${libNames.length + 1}), ` +
      `client syntax and ${linkCount} document links: OK`,
  )
}
