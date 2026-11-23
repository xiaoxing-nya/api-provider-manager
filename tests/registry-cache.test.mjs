/**
 * Offline tests for `lib/registry-cache.js` and the bundled `data/model-catalog.json`.
 *
 * No network access is performed: every registry request goes through a mock
 * `fetchImpl`, and every cache file lives in a fresh `mkdtemp` directory under
 * the OS temp root that is removed in `t.after()`.
 *
 * Run with: `node tests/registry-cache.test.mjs`
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CACHE_SCHEMA_VERSION,
  RegistryCacheManager,
  canonicalizeModelId,
  collectIdVariants,
  mergeRegistrySnapshots,
  modelMatchKey,
  parseModelsDevPayload,
  parseOpenRouterPayload,
  stripSnapshotSuffix,
} from '../lib/registry-cache.js'

const TESTS_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(TESTS_DIR, '..')
const CATALOG_PATH = join(PLUGIN_ROOT, 'data', 'model-catalog.json')
const BUILD_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'build-catalog.mjs')

const MODELS_DEV_URL = 'https://registry.test/models-dev/api.json'
const OPEN_ROUTER_URL = 'https://registry.test/openrouter/api/v1/models'

/* ------------------------------------------------------------------------- */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------- */

/** Minimal models.dev snapshot covering toggle/effort options and metadata. */
const MODELS_DEV_PAYLOAD = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    models: {
      'deepseek-v4.1-flash': {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
        interleaved: { field: 'reasoning_content' },
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1048576, output: 393216 },
        canonical_model_id: 'deepseek/deepseek-v4.1-flash',
      },
      'deepseek-chat': {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        reasoning: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 131072, output: 8192 },
      },
    },
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-sonnet-4-5': {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5 (latest)',
        reasoning: true,
        reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limit: { context: 200000, output: 64000 },
        canonical_model_id: 'anthropic/claude-sonnet-4-5',
      },
      'claude-opus-4-6': {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1000000, output: 128000 },
      },
    },
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    models: {
      'anthropic/claude-sonnet-4.5': {
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high'] }],
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1000000, output: 64000 },
        canonical_model_id: 'anthropic/claude-sonnet-4-5',
      },
    },
  },
}

/** Minimal OpenRouter snapshot covering mandatory reasoning and endpoints. */
const OPEN_ROUTER_PAYLOAD = {
  data: [
    {
      id: 'deepseek/deepseek-v4.1-flash',
      canonical_slug: 'deepseek/deepseek-v4.1-flash-20260910',
      name: 'DeepSeek: DeepSeek V4.1 Flash',
      context_length: 1048576,
      top_provider: { context_length: 1048576, max_completion_tokens: 393216 },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['reasoning', 'reasoning_effort', 'tools'],
      endpoints: ['/api/v1/chat/completions', '/api/v1/responses'],
      reasoning: {
        mandatory: false,
        default_enabled: true,
        supported_efforts: ['max', 'high', 'low', 'none'],
        default_effort: 'high',
      },
    },
    {
      id: 'google/gemini-4-argon',
      canonical_slug: 'google/gemini-4-argon-20261013',
      name: 'Google: Gemini 4 Argon',
      context_length: 1048576,
      top_provider: { context_length: 1048576, max_completion_tokens: 943718 },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['reasoning'],
      endpoints: ['/api/v1/chat/completions'],
      reasoning: { mandatory: true, supported_efforts: ['high', 'medium', 'low'], default_effort: 'medium' },
    },
    {
      id: 'z-ai/glm-5.3',
      canonical_slug: 'z-ai/glm-5.3-20261001',
      name: 'Z.ai: GLM 5.3',
      context_length: 1000000,
      top_provider: { context_length: 1000000, max_completion_tokens: 131072 },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['reasoning_effort'],
      endpoints: ['/api/v1/chat/completions'],
    },
    {
      id: 'z-ai/glm-5.3:free',
      canonical_slug: 'z-ai/glm-5.3-20261001',
      name: 'Z.ai: GLM 5.3 (free)',
      context_length: 1000000,
      top_provider: { context_length: 1000000, max_completion_tokens: 131072 },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['reasoning_effort'],
      endpoints: ['/api/v1/chat/completions'],
    },
    {
      id: 'deepseek/deepseek-flash',
      canonical_slug: 'deepseek/deepseek-flash-1017',
      name: 'DeepSeek: DeepSeek Flash',
      context_length: 1048576,
      top_provider: { context_length: 1048576, max_completion_tokens: 393216 },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: [],
      endpoints: ['/api/v1/chat/completions'],
    },
    {
      id: '~deepseek/deepseek-flash-latest',
      name: 'DeepSeek: DeepSeek Flash (latest)',
      context_length: 1048576,
      top_provider: { context_length: 1048576, max_completion_tokens: 393216 },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: [],
      endpoints: ['/api/v1/chat/completions'],
    },
  ],
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

function assertTempDir(dir) {
  const resolved = resolve(dir)
  assert.ok(
    resolved === resolve(tmpdir()) || resolved.startsWith(`${resolve(tmpdir())}${sep}`),
    `temporary directory must live under ${tmpdir()}, got ${resolved}`,
  )
}

async function makeTempDir(t, prefix = 'xiaoxing-registry-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  assertTempDir(dir)
  t.after(async () => {
    assertTempDir(dir)
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

async function makeManager(t, options = {}) {
  const dir = await makeTempDir(t)
  const cacheFilePath = join(dir, 'registry-cache.json')
  const manager = new RegistryCacheManager({
    cacheFilePath,
    modelsDevUrl: MODELS_DEV_URL,
    openRouterUrl: OPEN_ROUTER_URL,
    ...options,
  })
  return { dir, cacheFilePath, manager }
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => JSON.stringify(payload),
  }
}

function notModifiedResponse() {
  return { ok: false, status: 304, headers: {}, text: async () => '' }
}

/**
 * Build a mock fetch implementation from a route table keyed by URL. Each route
 * is either a response or a function receiving `init` and returning a response.
 */
function createFetchMock(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const key = String(url)
    calls.push({ url: key, init })
    const route = routes[key]
    if (!route) throw new Error(`unexpected fetch: ${key}`)
    return typeof route === 'function' ? route(init) : route
  }
  return { fetchImpl, calls }
}

function healthyRoutes(overrides = {}) {
  return {
    [MODELS_DEV_URL]: () => jsonResponse(MODELS_DEV_PAYLOAD, { headers: { etag: '"models-dev-v1"' } }),
    [OPEN_ROUTER_URL]: () => jsonResponse(OPEN_ROUTER_PAYLOAD, { headers: { etag: '"openrouter-v1"' } }),
    ...overrides,
  }
}

function resolveCatalogEntry(catalog, id) {
  if (Object.prototype.hasOwnProperty.call(catalog.models, id)) return catalog.models[id]
  const target = catalog.aliases[id]
  if (typeof target === 'string' && Object.prototype.hasOwnProperty.call(catalog.models, target)) {
    return catalog.models[target]
  }
  return null
}

/* ------------------------------------------------------------------------- */
/* Canonicalization                                                          */
/* ------------------------------------------------------------------------- */

test('canonical ids strip vendor prefixes, variants, and normalize separators', () => {
  assert.equal(canonicalizeModelId('anthropic/claude-sonnet-4.5'), 'claude-sonnet-4.5')
  assert.equal(canonicalizeModelId('openai/gpt-5.4'), 'gpt-5.4')
  assert.equal(canonicalizeModelId('thinkingmachines/moonshotai/Kimi-K2.6:peft:131072'), 'kimi-k2.6')
  assert.equal(canonicalizeModelId('~deepseek/deepseek-flash-latest'), 'deepseek-flash-latest')
  assert.equal(canonicalizeModelId('z-ai/glm-5.3:free'), 'glm-5.3')
  assert.equal(canonicalizeModelId('  Qwen/Qwen3.5-27B  '), 'qwen3.5-27b')

  // Dot/hyphen spellings collapse onto one match key.
  assert.equal(modelMatchKey('claude-sonnet-4.5'), 'claude-sonnet-4-5')
  assert.equal(modelMatchKey('claude-sonnet-4-5'), 'claude-sonnet-4-5')
  assert.equal(modelMatchKey('gpt-5.4'), modelMatchKey('gpt-5-4'))

  // Dated snapshots peel back to their base id.
  assert.equal(stripSnapshotSuffix('claude-opus-4-5-20251101'), 'claude-opus-4-5')
  assert.equal(stripSnapshotSuffix('deepseek-v4.1-flash-1017'), 'deepseek-v4.1-flash')
  assert.equal(stripSnapshotSuffix('gpt-5.4-20260305'), 'gpt-5.4')
  assert.equal(stripSnapshotSuffix('mistral-large-4-0'), 'mistral-large-4-0')

  // Alternate spellings include dot/hyphen variants and dated bases.
  const variants = collectIdVariants('claude-sonnet-4-5')
  assert(variants.includes('claude-sonnet-4.5'))
  assert(collectIdVariants('deepseek-v4.1-flash-1017').includes('deepseek-v4.1-flash'))
})

/* ------------------------------------------------------------------------- */
/* models.dev parsing                                                        */
/* ------------------------------------------------------------------------- */

test('parseModelsDevPayload normalizes reasoning options, interleaved fields, and limits', () => {
  const snapshot = parseModelsDevPayload(MODELS_DEV_PAYLOAD)
  const flash = snapshot.models['deepseek-v4.1-flash']

  assert(flash, 'deepseek-v4.1-flash should be indexed')
  assert.equal(flash.id, 'deepseek-v4.1-flash')
  assert.equal(flash.name, 'DeepSeek V4.1 Flash')
  assert.equal(flash.contextWindow, 1048576)
  assert.equal(flash.maxTokens, 393216)
  assert.deepEqual(flash.input, ['text', 'image'])
  assert.equal(flash.reasoning, true)
  assert.equal(flash.allowOff, true, 'a toggle option means reasoning can be disabled')
  assert.deepEqual(flash.efforts, ['off', 'low', 'high', 'max'])
  assert.equal(flash.interleavedField, 'reasoning_content')
  assert.deepEqual(flash.endpoints, [])
  assert.equal(flash.source, 'models.dev')

  const chat = snapshot.models['deepseek-chat']
  assert.equal(chat.reasoning, false)
  assert.equal(chat.allowOff, true)
  assert.deepEqual(chat.efforts, [])

  // A reasoning model without explicit effort values gets the default ladder.
  const opus = snapshot.models['claude-opus-4-6']
  assert.equal(opus.reasoning, true)
  assert.equal(opus.allowOff, true)
  assert.deepEqual(opus.efforts, ['off', 'low', 'medium', 'high'])
  assert.equal(opus.interleavedField, null)
})

test('parseModelsDevPayload prefers the vendor record and aliases the other spelling', () => {
  const snapshot = parseModelsDevPayload(JSON.stringify(MODELS_DEV_PAYLOAD))
  const sonnet = snapshot.models['claude-sonnet-4-5']

  assert(sonnet, 'claude-sonnet-4-5 should be the stored id (models.dev spelling)')
  assert.equal(sonnet.name, 'Claude Sonnet 4.5', 'trailing " (latest)" is cleaned')
  assert.equal(sonnet.contextWindow, 200000, 'the vendor record wins over the mirror')
  assert.equal(snapshot.aliases['claude-sonnet-4.5'], 'claude-sonnet-4-5')
  assert.equal(snapshot.models['claude-sonnet-4.5'], undefined)
})

test('parseModelsDevPayload rejects malformed payloads', () => {
  assert.throws(() => parseModelsDevPayload('[]'), TypeError)
  assert.throws(() => parseModelsDevPayload('not json'), TypeError)
})

/* ------------------------------------------------------------------------- */
/* OpenRouter parsing                                                        */
/* ------------------------------------------------------------------------- */

test('parseOpenRouterPayload maps mandatory reasoning and supported efforts', () => {
  const snapshot = parseOpenRouterPayload(OPEN_ROUTER_PAYLOAD)

  const flash = snapshot.models['deepseek-v4.1-flash']
  assert(flash)
  assert.equal(flash.name, 'DeepSeek V4.1 Flash', 'vendor prefix is stripped from the name')
  assert.equal(flash.contextWindow, 1048576)
  assert.equal(flash.maxTokens, 393216)
  assert.deepEqual(flash.input, ['text', 'image'])
  assert.equal(flash.reasoning, true)
  assert.equal(flash.allowOff, true, 'mandatory === false means reasoning can be turned off')
  assert.deepEqual(flash.efforts, ['off', 'low', 'high', 'max'])
  assert.deepEqual(flash.endpoints, ['/api/v1/chat/completions', '/api/v1/responses'])
  assert.equal(flash.source, 'openrouter')

  const argon = snapshot.models['gemini-4-argon']
  assert.equal(argon.reasoning, true)
  assert.equal(argon.allowOff, false, 'mandatory === true must never be softened')
  assert.deepEqual(argon.efforts, ['low', 'medium', 'high'], 'off must not be injected when mandatory')
  assert.deepEqual(argon.endpoints, ['/api/v1/chat/completions'])

  // `reasoning_effort` in supported_parameters implies a reasoning model.
  const glm = snapshot.models['glm-5.3']
  assert.equal(glm.reasoning, true)
  assert.equal(glm.allowOff, true)
  assert.deepEqual(glm.efforts, ['off', 'low', 'medium', 'high'])
  assert.equal(glm.name, 'GLM 5.3')

  // `:free` variants collapse onto the base model.
  assert.equal(Object.keys(snapshot.models).filter((id) => id === 'glm-5.3').length, 1)

  // `~vendor/...-latest` pointers become aliases of the concrete model.
  assert.equal(snapshot.aliases['deepseek-flash-latest'], 'deepseek-flash')
  assert.equal(snapshot.models['deepseek-flash'].reasoning, false)
  assert.deepEqual(snapshot.models['deepseek-flash'].efforts, [])
  assert.equal(snapshot.aliases['deepseek-flash-1017'], 'deepseek-flash')
})

test('parseOpenRouterPayload rejects malformed payloads', () => {
  assert.throws(() => parseOpenRouterPayload('{}'), TypeError)
  assert.throws(() => parseOpenRouterPayload('null'), TypeError)
})

/* ------------------------------------------------------------------------- */
/* Snapshot merging                                                          */
/* ------------------------------------------------------------------------- */

test('mergeRegistrySnapshots combines both sources and keeps either spelling resolvable', () => {
  const modelsDev = parseModelsDevPayload(MODELS_DEV_PAYLOAD)
  const openRouter = parseOpenRouterPayload(OPEN_ROUTER_PAYLOAD)
  const merged = mergeRegistrySnapshots(modelsDev, openRouter)

  const flash = merged.models['deepseek-v4.1-flash']
  assert.equal(flash.source, 'models.dev+openrouter')
  assert.equal(flash.contextWindow, 1048576)
  assert.equal(flash.maxTokens, 393216)
  assert.equal(flash.interleavedField, 'reasoning_content', 'models.dev contributes the interleaved field')
  assert.deepEqual(flash.endpoints, ['/api/v1/chat/completions', '/api/v1/responses'])
  assert.deepEqual(flash.efforts, ['off', 'low', 'high', 'max'])

  assert.equal(merged.models['claude-sonnet-4-5'].source, 'models.dev')
  assert.equal(merged.models['gemini-4-argon'].source, 'openrouter')
  assert.equal(merged.aliases['claude-sonnet-4.5'], 'claude-sonnet-4-5')

  // The merge is deterministic.
  const again = mergeRegistrySnapshots(
    parseModelsDevPayload(MODELS_DEV_PAYLOAD),
    parseOpenRouterPayload(OPEN_ROUTER_PAYLOAD),
  )
  assert.deepEqual(again, merged)
})

test('mergeRegistrySnapshots accepts bare id maps and empty snapshots', () => {
  const merged = mergeRegistrySnapshots(
    { 'claude-sonnet-4-5': { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', reasoning: false } },
    null,
  )
  assert.equal(merged.models['claude-sonnet-4-5'].source, 'models.dev')
  assert.deepEqual(mergeRegistrySnapshots(null, null), { models: {}, aliases: {} })
})

/* ------------------------------------------------------------------------- */
/* RegistryCacheManager: load                                                */
/* ------------------------------------------------------------------------- */

test('load treats a missing cache file as an empty cache', async (t) => {
  const { manager } = await makeManager(t, { fetchImpl: async () => assert.fail('no network expected') })
  await manager.load()

  assert.equal(manager.modelCount, 0)
  assert.equal(manager.isStale(), true)
  assert.deepEqual(manager.warnings, [])
  assert.deepEqual(manager.lookup(['deepseek-v4.1-flash']), null)

  const status = manager.getStatus()
  assert.equal(status.modelCount, 0)
  assert.equal(status.ttlMs, 24 * 60 * 60 * 1000)
  assert.equal(status.stale, true)
  assert.equal(status.offlineOnly, false)
  assert.equal(status.sources.modelsDev.modelCount, 0)
  assert.equal(status.sources.openRouter.modelCount, 0)
})

test('load ignores corrupt JSON and unsupported schemas without throwing', async (t) => {
  const dir = await makeTempDir(t)
  const cacheFilePath = join(dir, 'registry-cache.json')

  await writeFile(cacheFilePath, 'not json{', 'utf8')
  const corrupt = new RegistryCacheManager({ cacheFilePath, fetchImpl: async () => assert.fail('no network') })
  await corrupt.load()
  assert.equal(corrupt.modelCount, 0)
  assert(corrupt.warnings.some((warning) => warning.includes('corrupt JSON')))

  await writeFile(cacheFilePath, JSON.stringify({ schemaVersion: 99 }), 'utf8')
  const unsupported = new RegistryCacheManager({ cacheFilePath, fetchImpl: async () => assert.fail('no network') })
  await unsupported.load()
  assert.equal(unsupported.modelCount, 0)
  assert(unsupported.warnings.some((warning) => warning.includes('unsupported')))
})

test('load refuses a symlinked cache file', async (t) => {
  const dir = await makeTempDir(t)
  const target = join(dir, 'target.json')
  const link = join(dir, 'registry-cache.json')
  await writeFile(target, JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION }), 'utf8')
  try {
    await symlink(target, link, 'file')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code)) {
      t.skip(`file symlinks unavailable in this environment: ${error.code}`)
      return
    }
    throw error
  }

  const manager = new RegistryCacheManager({ cacheFilePath: link, fetchImpl: async () => assert.fail('no network') })
  await manager.load()
  assert.equal(manager.modelCount, 0)
  assert(manager.warnings.some((warning) => warning.includes('symbolic link')))
})

/* ------------------------------------------------------------------------- */
/* RegistryCacheManager: refresh                                             */
/* ------------------------------------------------------------------------- */

test('refresh fetches both sources, writes an atomic cache, and supports lookups', async (t) => {
  const { dir, cacheFilePath, manager } = await makeManager(t, {
    fetchImpl: createFetchMock(healthyRoutes()).fetchImpl,
  })

  const result = await manager.refresh({ force: true })
  assert.equal(result.ok, true)
  assert.equal(result.updated, true)
  assert.equal(result.sourceStatus.modelsDev.status, 'updated')
  assert.equal(result.sourceStatus.openRouter.status, 'updated')
  assert.equal(result.sourceStatus.modelsDev.modelCount, 4)
  assert.equal(result.sourceStatus.openRouter.modelCount, 4)
  assert(result.modelCount >= 6)
  assert(Number.isFinite(Date.parse(result.checkedAt)))
  assert.deepEqual(result.warnings, [])

  // Lookups resolve vendor prefixes and dot/hyphen spellings.
  assert.equal(manager.lookup('deepseek-v4.1-flash').id, 'deepseek-v4.1-flash')
  assert.equal(manager.lookup('deepseek/deepseek-v4.1-flash').id, 'deepseek-v4.1-flash')
  assert.equal(manager.lookup('claude-sonnet-4.5').id, 'claude-sonnet-4-5')
  assert.equal(manager.lookup(['missing-model', 'claude-sonnet-4-5']).id, 'claude-sonnet-4-5')
  assert.equal(manager.lookup('gemini-4-argon').allowOff, false)
  assert.equal(manager.lookup('nope'), null)

  // The cache file is valid JSON with per-source snapshots and no temp leftovers.
  const written = JSON.parse(await readFile(cacheFilePath, 'utf8'))
  assert.equal(written.schemaVersion, CACHE_SCHEMA_VERSION)
  assert(Number.isFinite(Date.parse(written.checkedAt)))
  assert(Object.keys(written.sources.modelsDev.models).length > 0)
  assert(Object.keys(written.sources.openRouter.models).length > 0)
  assert.equal(written.sources.modelsDev.etag, '"models-dev-v1"')
  const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])

  // A fresh manager loads the same state back from disk.
  const reloaded = new RegistryCacheManager({ cacheFilePath, fetchImpl: async () => assert.fail('no network') })
  await reloaded.load()
  assert.equal(reloaded.modelCount, manager.modelCount)
  assert.equal(reloaded.lookup('claude-sonnet-4.5').id, 'claude-sonnet-4-5')
  assert.equal(reloaded.getStatus().sources.modelsDev.etag, '"models-dev-v1"')
  assert.equal(reloaded.isStale(), false)
})

test('refresh sends conditional headers and handles 304 Not Modified', async (t) => {
  const requests = []
  const routes = healthyRoutes()
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), headers: { ...init.headers } })
    if (requests.length <= 2) return routes[String(url)]()
    return notModifiedResponse()
  }
  const { manager } = await makeManager(t, { fetchImpl })

  const first = await manager.refresh({ force: true })
  assert.equal(first.updated, true)
  assert.equal(requests[0].headers['if-none-match'], undefined, 'no conditional header on the first fetch')

  const second = await manager.refresh({ force: true })
  assert.equal(second.updated, false)
  assert.equal(second.sourceStatus.modelsDev.status, 'not-modified')
  assert.equal(second.sourceStatus.openRouter.status, 'not-modified')
  assert.equal(second.modelCount, first.modelCount)
  assert(second.checkedAt >= first.checkedAt)
  assert.equal(requests[2].headers['if-none-match'], '"models-dev-v1"')
  assert.equal(requests[3].headers['if-none-match'], '"openrouter-v1"')
  assert.equal(manager.lookup('deepseek-v4.1-flash').id, 'deepseek-v4.1-flash')
})

test('refresh never lets an empty upstream response wipe a valid cache', async (t) => {
  const routes = healthyRoutes()
  const { cacheFilePath, manager } = await makeManager(t, {
    fetchImpl: (url) => routes[String(url)](),
  })

  const first = await manager.refresh({ force: true })
  assert(first.modelCount > 0)

  // Both upstreams suddenly return empty snapshots.
  manager.fetchImpl = createFetchMock({
    [MODELS_DEV_URL]: () => jsonResponse({}),
    [OPEN_ROUTER_URL]: () => jsonResponse({ data: [] }),
  }).fetchImpl
  const second = await manager.refresh({ force: true })

  assert.equal(second.updated, false)
  assert.equal(second.modelCount, first.modelCount, 'cached models must be preserved')
  assert.equal(second.sourceStatus.modelsDev.status, 'empty-protected')
  assert.equal(second.sourceStatus.openRouter.status, 'empty-protected')
  assert(second.warnings.some((warning) => warning.includes('keeping cached snapshot')))
  assert.equal(manager.lookup('deepseek-v4.1-flash').id, 'deepseek-v4.1-flash')

  const written = JSON.parse(await readFile(cacheFilePath, 'utf8'))
  assert(Object.keys(written.sources.modelsDev.models).length > 0)
  assert(Object.keys(written.sources.openRouter.models).length > 0)
})

test('refresh times out hung requests and opens a circuit breaker', async (t) => {
  const calls = []
  const fetchImpl = (url) => {
    calls.push(String(url))
    return new Promise(() => {}) // never settles, ignores AbortSignal
  }
  const { manager } = await makeManager(t, { fetchImpl, timeoutMs: 25 })

  const started = Date.now()
  const first = await manager.refresh({ force: true })
  assert(Date.now() - started < 5000, 'refresh must not hang on a stuck upstream')
  assert.equal(first.ok, false)
  assert.equal(first.sourceStatus.modelsDev.status, 'error')
  assert.equal(first.sourceStatus.openRouter.status, 'error')
  assert(first.warnings.some((warning) => warning.toLowerCase().includes('timed out')))
  assert.equal(calls.length, 2)

  // The next non-forced refresh is short-circuited instead of retrying.
  const second = await manager.refresh()
  assert.equal(second.sourceStatus.modelsDev.status, 'circuit-open')
  assert.equal(second.sourceStatus.openRouter.status, 'circuit-open')
  assert.equal(calls.length, 2, 'circuit breaker must suppress the retry')

  // A forced refresh bypasses the breaker and retries.
  const forced = await manager.refresh({ force: true })
  assert.equal(forced.sourceStatus.modelsDev.status, 'error')
  assert.equal(calls.length, 4)
})

test('offlineOnly mode never touches the network', async (t) => {
  const { manager } = await makeManager(t, {
    offlineOnly: true,
    fetchImpl: async () => assert.fail('offline manager must not fetch'),
  })
  const result = await manager.refresh({ force: true })
  assert.equal(result.ok, true)
  assert.equal(result.updated, false)
  assert.equal(result.sourceStatus.modelsDev.status, 'skipped-offline')
  assert.equal(result.sourceStatus.openRouter.status, 'skipped-offline')
  assert.equal(manager.getStatus().offlineOnly, true)

  // A per-call override also skips the network.
  const online = await makeManager(t, { fetchImpl: async () => assert.fail('offline refresh must not fetch') })
  const overridden = await online.manager.refresh({ force: true, offlineOnly: true })
  assert.equal(overridden.sourceStatus.modelsDev.status, 'skipped-offline')
})

test('refresh is singleflight: concurrent calls share one in-flight promise', async (t) => {
  const calls = []
  let release
  const gate = new Promise((resolveGate) => {
    release = resolveGate
  })
  const fetchImpl = async (url) => {
    calls.push(String(url))
    await gate
    return String(url) === MODELS_DEV_URL ? jsonResponse(MODELS_DEV_PAYLOAD) : jsonResponse(OPEN_ROUTER_PAYLOAD)
  }
  const { manager } = await makeManager(t, { fetchImpl })

  const first = manager.refresh({ force: true })
  const second = manager.refresh({ force: true })
  assert.equal(first, second, 'concurrent refreshes must return the same promise')
  release()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult, secondResult)
  assert.equal(calls.length, 2, 'each source is fetched exactly once')
})

test('TTL staleness gates non-forced refreshes and can be clock-injected', async (t) => {
  let clock = 1_000_000
  const { fetchImpl, calls } = createFetchMock(healthyRoutes())
  const { manager } = await makeManager(t, { fetchImpl, ttlMs: 1000, now: () => clock })

  assert.equal(manager.isStale(), true)
  await manager.refresh({ force: true })
  assert.equal(manager.isStale(), false)
  const fetched = calls.length

  const fresh = await manager.refresh()
  assert.equal(fresh.sourceStatus.modelsDev.status, 'fresh')
  assert.equal(calls.length, fetched, 'a fresh cache must not be refetched')

  clock += 1500
  assert.equal(manager.isStale(), true)
  const refreshed = await manager.refresh()
  assert.equal(refreshed.sourceStatus.modelsDev.status, 'updated')
  assert.equal(calls.length, fetched + 2)
})

/* ------------------------------------------------------------------------- */
/* Bundled catalog                                                           */
/* ------------------------------------------------------------------------- */

test('bundled data/model-catalog.json is valid, compact, and contains real models', async () => {
  const raw = await readFile(CATALOG_PATH, 'utf8')
  assert(!raw.includes('\r'), 'catalog must use LF line endings')
  assert(raw.endsWith('\n'), 'catalog must end with a newline')
  assert(!raw.endsWith('\n\n'), 'catalog must have a single trailing newline')

  const bytes = Buffer.byteLength(raw)
  assert(bytes >= 30 * 1024, `catalog should be at least ~30KB, got ${bytes}`)
  assert(bytes <= 150 * 1024, `catalog should stay under ~150KB, got ${bytes}`)

  const catalog = JSON.parse(raw)
  assert.equal(catalog.schemaVersion, 1)
  assert(Number.isFinite(Date.parse(catalog.generatedAt)))
  assert.deepEqual(
    Object.keys(catalog.sourceCounts).sort(),
    ['aliases', 'catalog', 'merged', 'modelsDev', 'openRouter'],
  )
  assert.equal(catalog.sourceCounts.catalog, Object.keys(catalog.models).length)
  assert.equal(catalog.sourceCounts.aliases, Object.keys(catalog.aliases).length)

  const modelKeys = Object.keys(catalog.models)
  assert(modelKeys.length >= 100 && modelKeys.length <= 250, `expected a curated mainstream catalog (100-250 models), got ${modelKeys.length}`)
  assert(
    modelKeys.every((key, index) => index === 0 || modelKeys[index - 1] < key),
    'catalog model keys must be sorted',
  )

  for (const key of modelKeys) {
    const entry = catalog.models[key]
    assert.equal(entry.id, key)
    assert.equal(typeof entry.name, 'string')
    assert(entry.name.length > 0)
    assert(entry.contextWindow === null || (Number.isFinite(entry.contextWindow) && entry.contextWindow > 0))
    assert(entry.maxTokens === null || (Number.isFinite(entry.maxTokens) && entry.maxTokens > 0))
    assert(Array.isArray(entry.input))
    assert.equal(typeof entry.reasoning, 'boolean')
    assert.equal(typeof entry.allowOff, 'boolean')
    assert(Array.isArray(entry.efforts))
    assert(entry.interleavedField === null || typeof entry.interleavedField === 'string')
    assert(Array.isArray(entry.endpoints))
    assert(['models.dev', 'openrouter', 'models.dev+openrouter'].includes(entry.source))
    if (entry.reasoning) {
      if (entry.allowOff) assert(entry.efforts.includes('off'), `${key}: allowOff requires an off effort`)
      else assert(!entry.efforts.includes('off'), `${key}: mandatory reasoning must not offer off`)
    } else {
      assert.deepEqual(entry.efforts, [], `${key}: non-reasoning models have no efforts`)
    }
  }

  for (const [alias, target] of Object.entries(catalog.aliases)) {
    assert(catalog.models[target], `alias ${alias} points at unknown model ${target}`)
    assert(!catalog.models[alias], `alias ${alias} shadows a catalog model`)
  }

  // Real 2025-2026 models from every major family are present.
  assert(resolveCatalogEntry(catalog, 'deepseek-flash'), 'deepseek-flash must resolve')
  assert(resolveCatalogEntry(catalog, 'deepseek-v4.1-flash'), 'deepseek-v4.1-flash must resolve')
  for (const prefix of ['claude-', 'gpt-', 'gemini-']) {
    const count = modelKeys.filter((key) => key.startsWith(prefix)).length
    assert(count >= 3, `expected several ${prefix}* models, got ${count}`)
  }
  assert.equal(resolveCatalogEntry(catalog, 'claude-sonnet-4-5').id, 'claude-sonnet-4-5')
  assert.equal(catalog.aliases['claude-sonnet-4.5'], 'claude-sonnet-4-5')
  assert(resolveCatalogEntry(catalog, 'gpt-5.4'))
  assert(resolveCatalogEntry(catalog, 'gemini-2.5-pro'))
  assert(resolveCatalogEntry(catalog, 'gemini-2.5-flash'))

  // The documented seed models are all resolvable (effort-qualified seeds map
  // onto their real base model as aliases rather than fabricated entries).
  const seeds = [
    'deepseek-v4.1-flash',
    'deepseek-v4-pro',
    'deepseek-flash',
    'claude-sonnet-5-5',
    'claude-sonnet-4-5',
    'claude-opus-4-6',
    'gpt-5.4',
    'gpt-6-astra',
    'gpt-6.1-sol',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-4-argon-high',
    'gemini-4-hydrogen-xhigh',
    'glm-5.3-flash',
    'glm-5.3',
    'glm-5.2',
    'mistral-large-4-0',
    'qwen3-max',
    'kimi-k2.5',
  ]
  for (const seed of seeds) {
    const entry = resolveCatalogEntry(catalog, seed)
    assert(entry, `seed ${seed} must resolve from the catalog`)
    assert(Number.isFinite(entry.contextWindow) || entry.contextWindow === null)
  }
  assert.equal(catalog.aliases['gemini-4-argon-high'], 'gemini-4-argon')
  assert.equal(catalog.aliases['gemini-4-hydrogen-xhigh'], 'gemini-4-hydrogen')
})

/* ------------------------------------------------------------------------- */
/* Build script                                                              */
/* ------------------------------------------------------------------------- */

test('scripts/build-catalog.mjs produces deterministic offline catalogs', async (t) => {
  const dir = await makeTempDir(t, 'xiaoxing-build-catalog-test-')
  const modelsDevPath = join(dir, 'models-dev.json')
  const openRouterPath = join(dir, 'openrouter.json')
  await writeFile(modelsDevPath, JSON.stringify(MODELS_DEV_PAYLOAD), 'utf8')
  await writeFile(openRouterPath, JSON.stringify(OPEN_ROUTER_PAYLOAD), 'utf8')

  const outputs = [join(dir, 'catalog-a.json'), join(dir, 'catalog-b.json')]
  for (const out of outputs) {
    const result = spawnSync(
      process.execPath,
      [
        BUILD_SCRIPT,
        '--models-dev',
        modelsDevPath,
        '--openrouter',
        openRouterPath,
        '--out',
        out,
        '--now',
        '2026-11-16T00:00:00.000Z',
      ],
      { stdio: 'inherit', timeout: 60_000 },
    )
    assert.equal(result.status, 0, `build-catalog failed: ${result.error?.message ?? ''}`)
  }

  const [first, second] = await Promise.all(outputs.map((out) => readFile(out, 'utf8')))
  assert.equal(first, second, 'identical inputs and --now must produce identical bytes')
  assert(first.endsWith('\n'))
  assert(!first.includes('\r'))

  const catalog = JSON.parse(first)
  assert.equal(catalog.schemaVersion, 1)
  assert.equal(catalog.generatedAt, '2026-11-16T00:00:00.000Z')
  assert.equal(catalog.models['deepseek-v4.1-flash'].source, 'models.dev+openrouter')
  assert.equal(catalog.models['deepseek-v4.1-flash'].interleavedField, 'reasoning_content')
  assert.equal(catalog.aliases['claude-sonnet-4.5'], 'claude-sonnet-4-5')
  assert.equal(catalog.aliases['deepseek-flash-latest'], 'deepseek-flash')
  assert.equal(catalog.models['deepseek-v4.1-flash'].efforts.includes('off'), true)
  assert.equal(catalog.models['gemini-4-argon'].allowOff, false)
  assert.deepEqual(
    Object.keys(catalog.models),
    Object.keys(catalog.models).slice().sort(),
    'catalog model keys must be sorted',
  )
})
