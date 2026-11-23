/**
 * Storage, prober, and importer tests: atomic JSON state, corrupt-state
 * recovery, the serialized store queue, symlink refusal, live-endpoint probes
 * for every compatibility check, credential redaction, probing timeouts and
 * cancellation, sanitized export, the four supported import formats, YAML
 * subset parsing with line-numbered failures, and `!!js` tags that are never
 * evaluated.
 *
 * Run with `node tests/storage-prober-importer.test.mjs` from the package root.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { ApiManagerError } from '../lib/errors.js'
import {
  DEFAULT_REGISTRY_TTL_MS,
  DEFAULT_SYNC_COOLDOWN_MS,
  PLUGIN_SCHEMA_VERSION,
  PLUGIN_STORE_FILES,
  SYNC_MODES,
  SafeJsonStore,
  createDefaultSyncPolicy,
  createPluginStores,
  validateCustomPresetsState,
  validateOverridesState,
  validateRegistrySettingsState,
  validateSyncState,
} from '../lib/storage.js'
import { DEFAULT_PROBE_TIMEOUT_MS, PROBE_CHECKS, probeEndpoint } from '../lib/prober.js'
import {
  EXPORT_FORMAT,
  IMPORT_FORMATS,
  exportSanitizedProviders,
  importThirdPartyConfig,
  maskSecret,
  parseYamlSubset,
} from '../lib/importer.js'

/* ------------------------------------------------------------------------- */
/* Shared helpers                                                            */
/* ------------------------------------------------------------------------- */

/** Temporary directories created by this test run, removed afterwards. */
const temporaryDirs = []

/** Create a fresh temporary directory that is removed after the run. */
async function makeTempDir(prefix = 'apm-phase2-') {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirs.push(directory)
  return directory
}

after(async () => {
  await Promise.all(temporaryDirs.map(directory => rm(directory, { recursive: true, force: true })))
})

/** Build an overrides store at one file path. */
function createOverridesStore(filePath) {
  return new SafeJsonStore({
    filePath,
    defaultData: () => ({ version: PLUGIN_SCHEMA_VERSION, providers: {} }),
    validate: validateOverridesState,
  })
}

/** Build a store with a minimal, unvalidated document for queue tests. */
function createCounterStore(filePath) {
  return new SafeJsonStore({ filePath, defaultData: () => ({ count: 0 }) })
}

/** Resolve with the rejection reason of one promise. */
async function captureRejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

/** Assert one promise rejects with an `ApiManagerError` carrying `code`. */
async function expectApiCode(promise, code) {
  const error = await captureRejection(promise)
  assert.ok(error instanceof ApiManagerError, `expected ApiManagerError, received ${error?.name}: ${error?.message}`)
  assert.equal(error.code, code)
  return error
}

/** Assert one callback throws synchronously with an `ApiManagerError` carrying `code`. */
function expectSyncCode(callback, code) {
  assert.throws(callback, error => error instanceof ApiManagerError && error.code === code)
}

/* Prober helpers. */

/** Base URL used by every probe test. */
const PROBE_BASE = 'https://relay.example.test/v1'

/** Build a JSON response double. */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Build a plain-text response double. */
function textResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } })
}

/** Build a fetch double that records every request. */
function mockFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
    }
    calls.push(call)
    return handler(call, calls.length - 1)
  }
  return { calls, fetchImpl }
}

/** Parse the JSON request body of one recorded call. */
function bodyOf(call) {
  return JSON.parse(call.body)
}

/* ------------------------------------------------------------------------- */
/* Storage: factory, defaults, and validation                                */
/* ------------------------------------------------------------------------- */

describe('storage: createPluginStores', () => {
  test('returns the four stores with the documented file names', async () => {
    const directory = await makeTempDir()
    const stores = createPluginStores(directory)
    assert.deepEqual(Object.keys(stores).sort(), ['customPresets', 'overrides', 'registrySettings', 'syncState'])
    for (const [storeName, fileName] of Object.entries(PLUGIN_STORE_FILES)) {
      assert.ok(stores[storeName] instanceof SafeJsonStore, storeName)
      assert.equal(stores[storeName].filePath, join(directory, fileName))
    }
  })

  test('missing files resolve to fresh, isolated defaults without writing anything', async () => {
    const directory = await makeTempDir()
    const stores = createPluginStores(directory)

    assert.deepEqual(await stores.overrides.read(), { version: PLUGIN_SCHEMA_VERSION, providers: {} })
    assert.deepEqual(await stores.syncState.read(), { version: PLUGIN_SCHEMA_VERSION, providers: {} })
    assert.deepEqual(await stores.customPresets.read(), { version: PLUGIN_SCHEMA_VERSION, presets: [] })
    assert.deepEqual(await stores.registrySettings.read(), {
      version: PLUGIN_SCHEMA_VERSION,
      offlineOnly: false,
      ttlMs: DEFAULT_REGISTRY_TTL_MS,
      modelsDevUrl: null,
      openRouterUrl: null,
    })

    assert.deepEqual(await readdir(directory), [], 'reading must not create state files')

    const first = await stores.customPresets.read()
    first.presets.push({ id: 'mutated' })
    assert.deepEqual((await stores.customPresets.read()).presets, [], 'each read returns a private clone')
  })

  test('every default document satisfies its exported validator', async () => {
    const directory = await makeTempDir()
    const stores = createPluginStores(directory)
    validateOverridesState(await stores.overrides.read())
    validateSyncState(await stores.syncState.read())
    validateCustomPresetsState(await stores.customPresets.read())
    validateRegistrySettingsState(await stores.registrySettings.read())
  })

  test('rejects a non-string or empty dataDir', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
      assert.throws(() => createPluginStores(bad), TypeError, String(bad))
    }
  })
})

describe('storage: SafeJsonStore construction and atomic writes', () => {
  test('rejects invalid constructor options', () => {
    assert.throws(() => new SafeJsonStore(), TypeError)
    assert.throws(() => new SafeJsonStore({ defaultData: () => ({}) }), TypeError)
    assert.throws(() => new SafeJsonStore({ filePath: '', defaultData: () => ({}) }), TypeError)
    assert.throws(() => new SafeJsonStore({ filePath: '  ', defaultData: () => ({}) }), TypeError)
    assert.throws(() => new SafeJsonStore({ filePath: '/tmp/x.json' }), TypeError)
    assert.throws(() => new SafeJsonStore({ filePath: '/tmp/x.json', defaultData: () => ({}), validate: 'nope' }), TypeError)
  })

  test('write persists JSON atomically with one trailing newline and no temp files', async () => {
    const directory = await makeTempDir()
    const filePath = join(directory, 'overrides.json')
    const store = createOverridesStore(filePath)
    const document = {
      version: PLUGIN_SCHEMA_VERSION,
      providers: { relay: { models: { 'gpt-4o': { reasoningEffort: 'low' } } } },
    }

    const written = await store.write(document)
    assert.deepEqual(written, document)

    const raw = await readFile(filePath, 'utf8')
    assert.ok(raw.endsWith('\n'), 'the payload ends with a newline')
    assert.ok(!raw.endsWith('\n\n'), 'the payload ends with exactly one newline')
    assert.deepEqual(JSON.parse(raw), document)
    assert.deepEqual(await readdir(directory), ['overrides.json'], 'the temporary file was renamed away')

    if (process.platform !== 'win32') {
      const stats = await stat(filePath)
      assert.equal(stats.mode & 0o777, 0o600, 'state files are private')
    }

    written.providers.relay.models['gpt-4o'].reasoningEffort = 'high'
    document.providers.relay.models['gpt-4o'].reasoningEffort = 'max'
    assert.equal((await store.read()).providers.relay.models['gpt-4o'].reasoningEffort, 'low')
  })

  test('write creates a nested data directory', async () => {
    const directory = await makeTempDir()
    const stores = createPluginStores(join(directory, 'nested', 'data'))
    await stores.customPresets.write({ version: PLUGIN_SCHEMA_VERSION, presets: [{ id: 'p1' }] })
    const raw = await readFile(join(directory, 'nested', 'data', 'custom-presets.json'), 'utf8')
    assert.deepEqual(JSON.parse(raw), { version: PLUGIN_SCHEMA_VERSION, presets: [{ id: 'p1' }] })
  })

  test('a rejected write leaves the previous document untouched', async () => {
    const directory = await makeTempDir()
    const filePath = join(directory, 'overrides.json')
    const store = createOverridesStore(filePath)
    const original = { version: PLUGIN_SCHEMA_VERSION, providers: { relay: { models: {} } } }
    await store.write(original)

    await expectApiCode(store.write({ version: 2, providers: {} }), 'invalid-state')
    await expectApiCode(store.write({ version: PLUGIN_SCHEMA_VERSION }), 'invalid-state')
    await expectApiCode(store.write({ version: PLUGIN_SCHEMA_VERSION, providers: [] }), 'invalid-state')

    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), original)
    assert.deepEqual(await readdir(directory), ['overrides.json'])
  })

  test('a failed write never creates a file or temporary artefact', async () => {
    const directory = await makeTempDir()
    const filePath = join(directory, 'overrides.json')
    const store = createOverridesStore(filePath)
    await expectApiCode(store.write({ version: 2, providers: {} }), 'invalid-state')
    assert.deepEqual(await readdir(directory), [])
    assert.deepEqual(await store.read(), { version: PLUGIN_SCHEMA_VERSION, providers: {} })
  })

  test('non-JSON-serialisable state is rejected as invalid-state', async () => {
    const directory = await makeTempDir()
    const filePath = join(directory, 'overrides.json')
    const store = createOverridesStore(filePath)
    const original = { version: PLUGIN_SCHEMA_VERSION, providers: {} }
    await store.write(original)

    const circular = { version: PLUGIN_SCHEMA_VERSION, providers: {} }
    circular.self = circular
    const bigintError = await expectApiCode(
      store.write({ version: PLUGIN_SCHEMA_VERSION, providers: {}, huge: 1n }),
      'invalid-state',
    )
    assert.match(bigintError.message, /JSON-serialisable/)
    const circularError = await expectApiCode(store.write(circular), 'invalid-state')
    assert.match(circularError.message, /JSON-serialisable/)
    const functionError = await expectApiCode(
      store.write({ version: PLUGIN_SCHEMA_VERSION, providers: {}, callback: () => {} }),
      'invalid-state',
    )
    assert.match(functionError.message, /JSON-serialisable/)

    const loosePath = join(directory, 'loose.json')
    const looseStore = new SafeJsonStore({ filePath: loosePath, defaultData: () => ({ ok: true }) })
    const undefinedError = await expectApiCode(looseStore.write(undefined), 'invalid-state')
    assert.match(undefinedError.message, /no JSON representation/)
    assert.deepEqual(await readdir(directory), ['overrides.json'], 'no non-JSON document was written')

    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), original)
    assert.deepEqual(await readdir(directory), ['overrides.json'])
  })

  test('update type-checks its mutator and read-modify-writes under the queue', async () => {
    const directory = await makeTempDir()
    const store = createOverridesStore(join(directory, 'overrides.json'))
    assert.throws(() => store.update(null), TypeError)
    assert.throws(() => store.update('nope'), TypeError)

    await store.update(data => {
      data.providers.relay = { models: { 'gpt-4o': {} } }
    })
    assert.deepEqual(await store.read(), {
      version: PLUGIN_SCHEMA_VERSION,
      providers: { relay: { models: { 'gpt-4o': {} } } },
    })

    await store.update(() => ({ version: PLUGIN_SCHEMA_VERSION, providers: {} }))
    assert.deepEqual((await store.read()).providers, {})
  })
})

/* ------------------------------------------------------------------------- */
/* Storage: corrupt state and unsafe files                                   */
/* ------------------------------------------------------------------------- */

describe('storage: corrupt and unsafe state', () => {
  test('corrupt JSON raises invalid-state and is never wiped', async () => {
    const directory = await makeTempDir()
    const filePath = join(directory, 'overrides.json')
    const store = createOverridesStore(filePath)
    const corrupt = '{ "version": 1, "providers": '
    await writeFile(filePath, corrupt, 'utf8')

    const readError = await expectApiCode(store.read(), 'invalid-state')
    assert.match(readError.message, /not valid JSON/)
    assert.match(readError.message, /left untouched/)
    await expectApiCode(store.update(data => data), 'invalid-state')
    await expectApiCode(store.read(), 'invalid-state')

    assert.equal(await readFile(filePath, 'utf8'), corrupt, 'the damaged document is preserved for recovery')
    assert.deepEqual(await readdir(directory), ['overrides.json'])
  })

  test('valid JSON with an invalid shape raises invalid-state and is preserved', async () => {
    const directory = await makeTempDir()
    const filePath = join(directory, 'overrides.json')
    const store = createOverridesStore(filePath)
    const documents = [
      { version: 2, providers: {} },
      { version: PLUGIN_SCHEMA_VERSION },
      { version: PLUGIN_SCHEMA_VERSION, providers: [] },
      { version: PLUGIN_SCHEMA_VERSION, providers: { relay: { models: [] } } },
      { version: PLUGIN_SCHEMA_VERSION, providers: { relay: { models: { m: 5 } } } },
    ]
    for (const document of documents) {
      const text = JSON.stringify(document)
      await writeFile(filePath, text, 'utf8')
      const error = await expectApiCode(store.read(), 'invalid-state')
      assert.match(error.message, /state file .* is invalid/)
      assert.equal(await readFile(filePath, 'utf8'), text)
    }
  })

  test('a validator that returns false also reports invalid-state', async () => {
    const directory = await makeTempDir()
    const filePath = join(directory, 'custom.json')
    await writeFile(filePath, '{"ok":false}', 'utf8')
    const store = new SafeJsonStore({
      filePath,
      defaultData: () => ({ ok: true }),
      validate: data => data.ok === true,
    })
    await expectApiCode(store.read(), 'invalid-state')
    await expectApiCode(store.write({ ok: false }), 'invalid-state')
    assert.equal(await readFile(filePath, 'utf8'), '{"ok":false}')
  })

  test('a non-regular state file is refused', async () => {
    const directory = await makeTempDir()
    const filePath = join(directory, 'overrides.json')
    await mkdir(filePath)
    const store = createOverridesStore(filePath)
    const error = await expectApiCode(store.read(), 'unsafe-file')
    assert.match(error.message, /not a regular file/)
  })

  test('a symlinked state file is refused instead of followed', async t => {
    const directory = await makeTempDir()
    const targetPath = join(directory, 'outside.json')
    const filePath = join(directory, 'overrides.json')
    const targetText = JSON.stringify({ version: PLUGIN_SCHEMA_VERSION, providers: { leaked: { models: {} } } })
    await writeFile(targetPath, targetText, 'utf8')

    try {
      await symlink(targetPath, filePath, 'file')
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOSYS') {
        t.skip(`symlink creation is unavailable on this platform: ${error.code}`)
        return
      }
      throw error
    }

    assert.equal((await lstat(filePath)).isSymbolicLink(), true)
    const store = createOverridesStore(filePath)
    const error = await expectApiCode(store.read(), 'unsafe-file')
    assert.match(error.message, /symbolic link/)
    assert.equal(await readFile(targetPath, 'utf8'), targetText, 'the symlink target must not be read or modified')
    assert.equal((await lstat(filePath)).isSymbolicLink(), true, 'the symlink must not be replaced by a read')
  })
})

/* ------------------------------------------------------------------------- */
/* Storage: serialized queue                                                 */
/* ------------------------------------------------------------------------- */

describe('storage: serialized queue', () => {
  test('concurrent updates never lose a mutation', async () => {
    const directory = await makeTempDir()
    const store = createCounterStore(join(directory, 'state.json'))
    await store.write({ count: 0 })

    await Promise.all(
      Array.from({ length: 40 }, () =>
        store.update(data => {
          data.count += 1
        }),
      ),
    )

    assert.equal((await store.read()).count, 40)
  })

  test('reads, writes, and updates run in call order', async () => {
    const directory = await makeTempDir()
    const filePath = join(directory, 'state.json')
    const store = createCounterStore(filePath)
    await store.write({ count: 0 })

    const observed = []
    const events = [
      store.read().then(value => observed.push(['read', value.count])),
      store.write({ count: 5 }).then(value => observed.push(['write', value.count])),
      store.update(data => {
        data.count += 1
      }).then(value => observed.push(['update', value.count])),
      store.read().then(value => observed.push(['read', value.count])),
    ]
    await Promise.all(events)

    assert.deepEqual(observed, [
      ['read', 0],
      ['write', 5],
      ['update', 6],
      ['read', 6],
    ])
  })

  test('async mutators and replacement documents stay serialized', async () => {
    const directory = await makeTempDir()
    const store = createCounterStore(join(directory, 'state.json'))
    await store.write({ count: 0 })

    const order = []
    const first = store.update(async data => {
      order.push('first')
      await new Promise(resolve => setTimeout(resolve, 5))
      data.count += 1
    })
    const second = store.update(data => {
      order.push('second')
      data.count += 1
      return { count: data.count + 10 }
    })
    const third = store.update(() => ({ count: 99 }))
    await Promise.all([first, second, third])

    assert.deepEqual(order, ['first', 'second'])
    assert.equal((await store.read()).count, 99)
  })

  test('a failing task does not break the queue for later tasks', async () => {
    const directory = await makeTempDir()
    const store = createCounterStore(join(directory, 'state.json'))
    await store.write({ count: 0 })

    const order = []
    const one = store.update(data => {
      order.push('one')
      data.count = 1
    })
    const failing = store.update(() => {
      order.push('two')
      throw new Error('mutator exploded')
    })
    const three = store.update(data => {
      order.push('three')
      data.count = 3
    })

    await one
    const error = await captureRejection(failing)
    assert.equal(error.message, 'mutator exploded')
    await three

    assert.deepEqual(order, ['one', 'two', 'three'])
    assert.equal((await store.read()).count, 3)
  })

  test('a mutator result rejected by the validator keeps the queue alive', async () => {
    const directory = await makeTempDir()
    const store = createOverridesStore(join(directory, 'overrides.json'))
    await store.write({ version: PLUGIN_SCHEMA_VERSION, providers: {} })

    const invalid = store.update(() => ({ version: 2, providers: {} }))
    const valid = store.update(data => {
      data.providers.relay = { models: {} }
    })
    await expectApiCode(invalid, 'invalid-state')
    await valid
    assert.deepEqual(Object.keys((await store.read()).providers), ['relay'])
  })

  test('read results are independent clones', async () => {
    const directory = await makeTempDir()
    const store = createCounterStore(join(directory, 'state.json'))
    await store.write({ count: 1, nested: { flag: true } })

    const first = await store.read()
    first.nested.flag = false
    first.count = 42
    assert.deepEqual(await store.read(), { count: 1, nested: { flag: true } })
  })
})

/* ------------------------------------------------------------------------- */
/* Storage: validators, defaults, and constants                              */
/* ------------------------------------------------------------------------- */

describe('storage: validators and defaults', () => {
  test('validateOverridesState accepts sparse deltas and rejects malformed documents', () => {
    validateOverridesState({ version: PLUGIN_SCHEMA_VERSION, providers: {} })
    validateOverridesState({
      version: PLUGIN_SCHEMA_VERSION,
      providers: { relay: { models: { 'gpt-4o': { reasoningEffort: 'low', futureField: { nested: true } } } } },
    })
    for (const bad of [
      null,
      [],
      {},
      { version: 2, providers: {} },
      { version: PLUGIN_SCHEMA_VERSION },
      { version: PLUGIN_SCHEMA_VERSION, providers: [] },
      { version: PLUGIN_SCHEMA_VERSION, providers: { relay: null } },
      { version: PLUGIN_SCHEMA_VERSION, providers: { relay: {} } },
      { version: PLUGIN_SCHEMA_VERSION, providers: { relay: { models: [] } } },
      { version: PLUGIN_SCHEMA_VERSION, providers: { relay: { models: { m: 'delta' } } } },
    ]) {
      expectSyncCode(() => validateOverridesState(bad), 'invalid-state')
    }
  })

  test('validateSyncState accepts every documented policy field and rejects bad values', () => {
    validateSyncState({
      version: PLUGIN_SCHEMA_VERSION,
      providers: {
        relay: {
          syncMode: 'mirror',
          syncCooldownMs: 1_000,
          includePatterns: ['gpt-*'],
          excludePatterns: [],
          includeNonChat: true,
          syncToSubagentAllowed: true,
          lastSyncedAt: '2026-01-01T00:00:00.000Z',
          lastStatus: 'ok',
          lastError: null,
          lastDiff: { added: ['m'], removed: [] },
        },
        empty: {},
      },
    })
    const invalidPolicies = [
      null,
      [],
      { syncMode: 'sometimes' },
      { syncCooldownMs: -1 },
      { syncCooldownMs: 1.5 },
      { includePatterns: 'gpt-*' },
      { includePatterns: [1] },
      { includeNonChat: 'yes' },
      { lastStatus: 5 },
      { lastDiff: [] },
    ]
    for (const policy of invalidPolicies) {
      expectSyncCode(
        () => validateSyncState({ version: PLUGIN_SCHEMA_VERSION, providers: { relay: policy } }),
        'invalid-state',
      )
    }
    expectSyncCode(() => validateSyncState({ version: 1, providers: [] }), 'invalid-state')
    expectSyncCode(() => validateSyncState({ version: 2, providers: {} }), 'invalid-state')
  })

  test('validateCustomPresetsState accepts presets and rejects malformed entries', () => {
    validateCustomPresetsState({ version: PLUGIN_SCHEMA_VERSION, presets: [] })
    validateCustomPresetsState({ version: PLUGIN_SCHEMA_VERSION, presets: [{ id: 'custom-one', name: 'Custom' }] })
    for (const bad of [
      null,
      { version: 2, presets: [] },
      { version: PLUGIN_SCHEMA_VERSION },
      { version: PLUGIN_SCHEMA_VERSION, presets: {} },
      { version: PLUGIN_SCHEMA_VERSION, presets: ['custom-one'] },
      { version: PLUGIN_SCHEMA_VERSION, presets: [{ id: '' }] },
      { version: PLUGIN_SCHEMA_VERSION, presets: [{ id: 5 }] },
    ]) {
      expectSyncCode(() => validateCustomPresetsState(bad), 'invalid-state')
    }
  })

  test('validateRegistrySettingsState accepts the documented shape and rejects bad values', () => {
    validateRegistrySettingsState({
      version: PLUGIN_SCHEMA_VERSION,
      offlineOnly: true,
      ttlMs: 5_000,
      modelsDevUrl: 'https://models.example.test/v1',
      openRouterUrl: null,
    })
    for (const bad of [
      null,
      { version: 2, offlineOnly: false, ttlMs: 1 },
      { version: PLUGIN_SCHEMA_VERSION, offlineOnly: 'no', ttlMs: 1 },
      { version: PLUGIN_SCHEMA_VERSION, offlineOnly: false, ttlMs: 0 },
      { version: PLUGIN_SCHEMA_VERSION, offlineOnly: false, ttlMs: -5 },
      { version: PLUGIN_SCHEMA_VERSION, offlineOnly: false, ttlMs: Number.POSITIVE_INFINITY },
      { version: PLUGIN_SCHEMA_VERSION, offlineOnly: false, ttlMs: 1, modelsDevUrl: '' },
      { version: PLUGIN_SCHEMA_VERSION, offlineOnly: false, ttlMs: 1, openRouterUrl: 5 },
    ]) {
      expectSyncCode(() => validateRegistrySettingsState(bad), 'invalid-state')
    }
  })

  test('createDefaultSyncPolicy returns fresh documented defaults and merges overrides', () => {
    const defaults = {
      syncMode: 'add-new',
      syncCooldownMs: DEFAULT_SYNC_COOLDOWN_MS,
      includePatterns: [],
      excludePatterns: [],
      ignoredModels: [],
      includeNonChat: false,
      syncToSubagentAllowed: false,
      lastSyncedAt: null,
      lastStatus: null,
      lastError: null,
      lastDiff: null,
    }
    assert.deepEqual(createDefaultSyncPolicy(), defaults)
    assert.deepEqual(createDefaultSyncPolicy({ syncMode: 'mirror', includePatterns: ['gpt-*'] }), {
      ...defaults,
      syncMode: 'mirror',
      includePatterns: ['gpt-*'],
    })
    assert.deepEqual(createDefaultSyncPolicy(null), defaults)
    assert.deepEqual(createDefaultSyncPolicy('nope'), defaults)

    const mutated = createDefaultSyncPolicy()
    mutated.includePatterns.push('*')
    assert.deepEqual(createDefaultSyncPolicy().includePatterns, [])
  })

  test('module constants expose the documented contract', () => {
    assert.equal(PLUGIN_SCHEMA_VERSION, 1)
    assert.deepEqual([...SYNC_MODES], ['manual', 'add-new', 'mirror'])
    assert.deepEqual(PLUGIN_STORE_FILES, {
      overrides: 'overrides.json',
      syncState: 'sync-state.json',
      customPresets: 'custom-presets.json',
      registrySettings: 'registry-settings.json',
    })
    assert.equal(DEFAULT_SYNC_COOLDOWN_MS, 30_000)
    assert.equal(DEFAULT_REGISTRY_TTL_MS, 24 * 60 * 60 * 1000)
  })
})

/* ------------------------------------------------------------------------- */
/* Prober: connectivity and chat                                             */
/* ------------------------------------------------------------------------- */

describe('prober: connectivity', () => {
  test('lists models through GET /models with the protocol credential header', async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse({
        data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'gpt-4o' }, 7, { object: 'model', owned_by: 'relay' }],
      }),
    )
    const report = await probeEndpoint({
      baseURL: `${PROBE_BASE}/`,
      api: 'openai-completions',
      apiKey: 'probe-test-key',
      checks: ['connectivity'],
      fetchImpl,
    })

    assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 15_000)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].url, 'https://relay.example.test/v1/models')
    assert.equal(calls[0].headers.authorization, 'Bearer probe-test-key')

    assert.equal(report.ok, true)
    assert.equal(report.api, 'openai-completions')
    assert.equal(report.baseURL, `${PROBE_BASE}/`)
    assert.equal(report.modelId, null)
    assert.equal(typeof report.checkedAt, 'string')
    assert.ok(Number.isFinite(Date.parse(report.checkedAt)))
    assert.ok(Number.isFinite(report.durationMs) && report.durationMs >= 0)
    assert.deepEqual(report.recommendedCompat, {})
    assert.deepEqual(report.warnings, [])
    assert.deepEqual(Object.keys(report.checks), ['connectivity'])

    const connectivity = report.checks.connectivity
    assert.equal(connectivity.ok, true)
    assert.equal(connectivity.status, 200)
    assert.equal(connectivity.modelCount, 2)
    assert.deepEqual(connectivity.models, ['gpt-4o', 'gpt-4o-mini'])
    assert.ok(Number.isFinite(connectivity.latencyMs) && connectivity.latencyMs >= 0)
  })

  test('a failed listing marks the probe failed and reports the gateway detail', async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ error: { message: 'upstream gateway rejected the request' } }, 502))
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      apiKey: 'probe-test-key',
      checks: ['connectivity'],
      fetchImpl,
    })

    assert.equal(report.ok, false)
    assert.equal(report.checks.connectivity.ok, false)
    assert.equal(report.checks.connectivity.status, 502)
    assert.match(report.checks.connectivity.error, /upstream gateway rejected the request/)
    assert.equal(report.warnings.length, 1)
    assert.match(report.warnings[0], /^connectivity check failed:/)
  })

  test('an empty model list is a warning, not a probe failure', async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ data: [] }))
    const report = await probeEndpoint({ baseURL: PROBE_BASE, checks: ['connectivity'], fetchImpl })
    assert.equal(report.ok, true)
    assert.equal(report.checks.connectivity.ok, true)
    assert.equal(report.checks.connectivity.modelCount, 0)
    assert.equal('models' in report.checks.connectivity, false)
    assert.match(report.warnings.join('\n'), /returned no models/)
  })

  test('a successful response with a non-JSON body yields no models', async () => {
    const { fetchImpl } = mockFetch(() => textResponse('not json at all'))
    const report = await probeEndpoint({ baseURL: PROBE_BASE, checks: ['connectivity'], fetchImpl })
    assert.equal(report.ok, true)
    assert.equal(report.checks.connectivity.modelCount, 0)
    assert.match(report.warnings.join('\n'), /returned no models/)
  })
})

describe('prober: chat', () => {
  test('sends a minimal chat request when a model id is supplied', async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'OK' } }] }))
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-completions',
      apiKey: 'probe-test-key',
      modelId: 'gpt-4o',
      checks: ['chat'],
      fetchImpl,
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].url, 'https://relay.example.test/v1/chat/completions')
    const requestBody = bodyOf(calls[0])
    assert.equal(requestBody.model, 'gpt-4o')
    assert.equal(requestBody.max_tokens, 16)
    assert.equal(requestBody.stream, false)
    assert.deepEqual(requestBody.messages, [{ role: 'user', content: 'Reply OK.' }])

    assert.equal(report.ok, true)
    assert.equal(report.modelId, 'gpt-4o')
    assert.equal(report.checks.chat.ok, true)
    assert.equal(report.checks.chat.status, 200)
  })

  test('is skipped without a model id and a rejection marks the probe failed', async () => {
    const skipped = await probeEndpoint({
      baseURL: PROBE_BASE,
      checks: ['chat'],
      fetchImpl: async () => jsonResponse({ data: [] }),
    })
    assert.equal(skipped.ok, true)
    assert.deepEqual(skipped.checks.chat, { skipped: true, reason: 'a model id is required' })
    assert.match(skipped.warnings.join('\n'), /chat probe skipped/)

    const { fetchImpl } = mockFetch(() => jsonResponse({ error: { message: 'invalid api key' } }, 401))
    const failed = await probeEndpoint({
      baseURL: PROBE_BASE,
      modelId: 'gpt-4o',
      checks: ['chat'],
      fetchImpl,
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.checks.chat.ok, false)
    assert.equal(failed.checks.chat.status, 401)
    assert.match(failed.checks.chat.error, /invalid api key/)
    assert.match(failed.warnings.join('\n'), /chat probe failed/)
  })
})

/* ------------------------------------------------------------------------- */
/* Prober: compatibility checks                                              */
/* ------------------------------------------------------------------------- */

describe('prober: developerRole', () => {
  test('an HTTP 400 developer-role rejection recommends supportsDeveloperRole false', async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse({ error: { message: 'Unsupported role: developer' } }, 400))
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-completions',
      modelId: 'gpt-4o',
      checks: ['developerRole'],
      fetchImpl,
    })

    assert.equal(report.ok, true, 'a rejected compatibility control does not fail the probe')
    const check = report.checks.developerRole
    assert.equal(check.ok, false)
    assert.equal(check.status, 400)
    assert.equal(check.supported, false)
    assert.deepEqual(check.recommendation, { supportsDeveloperRole: false })
    assert.equal(report.recommendedCompat.supportsDeveloperRole, false)
    assert.match(report.warnings.join('\n'), /developer role/)
    assert.deepEqual(bodyOf(calls[0]).messages[0], { role: 'developer', content: 'Follow instructions.' })
  })

  test('an HTTP 422 role rejection is treated as a rejection too', async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({ error: { message: "Invalid value for 'role': 'developer'" } }, 422),
    )
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-completions',
      modelId: 'gpt-4o',
      checks: ['developerRole'],
      fetchImpl,
    })
    assert.equal(report.checks.developerRole.status, 422)
    assert.equal(report.checks.developerRole.supported, false)
    assert.equal(report.recommendedCompat.supportsDeveloperRole, false)
  })

  test('acceptance reports support and a non-400 failure stays inconclusive', async () => {
    const accepted = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-responses',
      modelId: 'gpt-5',
      checks: ['developerRole'],
      fetchImpl: async () => jsonResponse({ output: [] }),
    })
    assert.equal(accepted.checks.developerRole.ok, true)
    assert.equal(accepted.checks.developerRole.supported, true)
    assert.equal('supportsDeveloperRole' in accepted.recommendedCompat, false)

    const inconclusive = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-completions',
      modelId: 'gpt-4o',
      checks: ['developerRole'],
      fetchImpl: async () => jsonResponse({ error: { message: 'server exploded' } }, 500),
    })
    assert.equal(inconclusive.checks.developerRole.ok, false)
    assert.equal(inconclusive.checks.developerRole.supported, null)
    assert.equal('recommendation' in inconclusive.checks.developerRole, false)
    assert.equal('supportsDeveloperRole' in inconclusive.recommendedCompat, false)
    assert.match(inconclusive.warnings.join('\n'), /inconclusive/)
  })

  test('is skipped for protocols without a developer role and without a model id', async () => {
    const anthropic = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'anthropic-messages',
      modelId: 'claude-sonnet-4',
      checks: ['developerRole'],
      fetchImpl: async () => jsonResponse({ data: [] }),
    })
    assert.deepEqual(anthropic.checks.developerRole, {
      skipped: true,
      reason: 'the anthropic-messages protocol has no developer role',
    })
    assert.deepEqual(anthropic.warnings, [])

    const noModel = await probeEndpoint({
      baseURL: PROBE_BASE,
      checks: ['developerRole'],
      fetchImpl: async () => jsonResponse({ data: [] }),
    })
    assert.equal(noModel.checks.developerRole.skipped, true)
    assert.match(noModel.warnings.join('\n'), /developer role probe skipped/)
  })
})

describe('prober: maxTokensField', () => {
  test('an HTTP 400 max_completion_tokens rejection recommends max_tokens', async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse({ error: { message: "Unsupported parameter: 'max_completion_tokens'" } }, 400),
    )
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-completions',
      modelId: 'gpt-4o',
      checks: ['maxTokensField'],
      fetchImpl,
    })

    assert.equal(report.ok, true)
    const check = report.checks.maxTokensField
    assert.equal(check.ok, false)
    assert.equal(check.field, 'max_completion_tokens')
    assert.equal(check.supported, false)
    assert.deepEqual(check.recommendation, { maxTokensField: 'max_tokens' })
    assert.equal(report.recommendedCompat.maxTokensField, 'max_tokens')
    assert.match(report.warnings.join('\n'), /max_completion_tokens/)
    assert.equal(bodyOf(calls[0]).max_completion_tokens, 16)
    assert.equal('max_tokens' in bodyOf(calls[0]), false)
  })

  test('an accepted max_completion_tokens request recommends that field', async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ choices: [] }))
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-completions',
      modelId: 'gpt-4o',
      checks: ['maxTokensField'],
      fetchImpl,
    })
    assert.equal(report.checks.maxTokensField.supported, true)
    assert.equal(report.recommendedCompat.maxTokensField, 'max_completion_tokens')
    assert.deepEqual(report.warnings, [])
  })

  test('is skipped for protocols and requests without a usable target', async () => {
    const responses = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-responses',
      modelId: 'gpt-5',
      checks: ['maxTokensField'],
      fetchImpl: async () => jsonResponse({ data: [] }),
    })
    assert.equal(responses.checks.maxTokensField.skipped, true)
    assert.match(responses.checks.maxTokensField.reason, /does not take max_completion_tokens/)

    const noModel = await probeEndpoint({
      baseURL: PROBE_BASE,
      checks: ['maxTokensField'],
      fetchImpl: async () => jsonResponse({ data: [] }),
    })
    assert.equal(noModel.checks.maxTokensField.skipped, true)
    assert.match(noModel.warnings.join('\n'), /max tokens field probe skipped/)
  })
})

describe('prober: reasoning', () => {
  test('an HTTP 400 reasoning_effort rejection recommends supportsReasoningEffort false', async () => {
    const { calls, fetchImpl } = mockFetch(() =>
      jsonResponse({ error: { message: 'reasoning_effort is not supported' } }, 400),
    )
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-completions',
      modelId: 'gpt-4o',
      checks: ['reasoning'],
      fetchImpl,
    })

    assert.equal(report.ok, true)
    const check = report.checks.reasoning
    assert.equal(check.ok, false)
    assert.equal(check.field, 'reasoning_effort')
    assert.equal(check.accepted, false)
    assert.deepEqual(check.recommendation, { supportsReasoningEffort: false })
    assert.equal(report.recommendedCompat.supportsReasoningEffort, false)
    assert.match(report.warnings.join('\n'), /supportsReasoningEffort/)
    assert.equal(bodyOf(calls[0]).reasoning_effort, 'low')
  })

  test('acceptance reports supportsReasoningEffort true for OpenAI completions', async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ choices: [] }))
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-completions',
      modelId: 'gpt-4o',
      checks: ['reasoning'],
      fetchImpl,
    })
    assert.equal(report.checks.reasoning.accepted, true)
    assert.equal(report.recommendedCompat.supportsReasoningEffort, true)
  })

  test('a rejected Anthropic thinking block is reported without a compat claim', async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse({ error: { message: 'thinking is not supported' } }, 400))
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'anthropic-messages',
      modelId: 'claude-sonnet-4',
      checks: ['reasoning'],
      fetchImpl,
    })
    assert.equal(report.checks.reasoning.field, 'thinking')
    assert.equal(report.checks.reasoning.accepted, false)
    assert.equal('supportsReasoningEffort' in report.recommendedCompat, false)
    assert.match(report.warnings.join('\n'), /extended thinking/)
    assert.deepEqual(bodyOf(calls[0]).thinking, { type: 'enabled', budget_tokens: 1024 })
  })

  test('is skipped without a model id', async () => {
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      checks: ['reasoning'],
      fetchImpl: async () => jsonResponse({ data: [] }),
    })
    assert.equal(report.checks.reasoning.skipped, true)
    assert.match(report.warnings.join('\n'), /reasoning probe skipped/)
  })
})

describe('prober: tools', () => {
  test('acceptance reports the minimal tool schema was accepted', async () => {
    const { calls, fetchImpl } = mockFetch(() => jsonResponse({ choices: [] }))
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-completions',
      modelId: 'gpt-4o',
      checks: ['tools'],
      fetchImpl,
    })
    assert.equal(report.checks.tools.ok, true)
    assert.equal(report.checks.tools.tool, 'ping')
    assert.equal(report.checks.tools.accepted, true)
    assert.equal('supportsStrictMode' in report.recommendedCompat, false)
    const tool = bodyOf(calls[0]).tools[0]
    assert.equal(tool.type, 'function')
    assert.equal(tool.function.name, 'ping')
  })

  test('a strict-mode rejection recommends supportsStrictMode false', async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ error: { message: 'strict mode is not supported' } }, 422))
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-completions',
      modelId: 'gpt-4o',
      checks: ['tools'],
      fetchImpl,
    })
    assert.equal(report.checks.tools.accepted, false)
    assert.deepEqual(report.checks.tools.recommendation, { supportsStrictMode: false })
    assert.equal(report.recommendedCompat.supportsStrictMode, false)
    assert.match(report.warnings.join('\n'), /strict mode/)
  })

  test('a plain tool-schema rejection makes no compat claim, and 500 stays inconclusive', async () => {
    const rejected = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-completions',
      modelId: 'gpt-4o',
      checks: ['tools'],
      fetchImpl: async () => jsonResponse({ error: { message: 'tools are not supported' } }, 400),
    })
    assert.equal(rejected.checks.tools.accepted, false)
    assert.equal('supportsStrictMode' in rejected.recommendedCompat, false)
    assert.match(rejected.warnings.join('\n'), /minimal tool schema/)

    const inconclusive = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-completions',
      modelId: 'gpt-4o',
      checks: ['tools'],
      fetchImpl: async () => jsonResponse({ error: { message: 'server exploded' } }, 500),
    })
    assert.equal(inconclusive.checks.tools.accepted, null)
    assert.equal('supportsStrictMode' in inconclusive.recommendedCompat, false)
    assert.match(inconclusive.warnings.join('\n'), /inconclusive/)
  })

  test('is skipped without a model id', async () => {
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      checks: ['tools'],
      fetchImpl: async () => jsonResponse({ data: [] }),
    })
    assert.equal(report.checks.tools.skipped, true)
    assert.match(report.warnings.join('\n'), /tool schema probe skipped/)
  })
})

/* ------------------------------------------------------------------------- */
/* Prober: redaction, looks, timeouts, and validation                        */
/* ------------------------------------------------------------------------- */

describe('prober: credential redaction', () => {
  test('a failed request never echoes the api key or a sensitive header value', async () => {
    const apiKey = 'relay-probe-plain-secret'
    const cookie = 'session=probe-secret-cookie'
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      apiKey,
      headers: { cookie },
      modelId: 'gpt-4o',
      checks: ['connectivity', 'chat'],
      timeoutMs: 1_000,
      fetchImpl: async () => {
        throw new Error(`upstream rejected auth=${apiKey} cookie=${cookie} bearer Bearer ${apiKey}`)
      },
    })

    const serialized = JSON.stringify(report)
    assert.equal(serialized.includes(apiKey), false)
    assert.equal(serialized.includes('probe-secret-cookie'), false)
    assert.match(report.checks.connectivity.error, /\*\*\*/)
    assert.match(report.checks.chat.error, /\*\*\*/)
    assert.equal(report.warnings.some(warning => warning.includes(apiKey)), false)
  })

  test('error details echoed from a JSON or text response body are redacted', async () => {
    const apiKey = 'relay-probe-plain-secret'
    const cookie = 'probe-secret-cookie'
    const bodyLeak = await probeEndpoint({
      baseURL: PROBE_BASE,
      apiKey,
      headers: { cookie },
      checks: ['connectivity'],
      fetchImpl: async () =>
        jsonResponse({ error: { message: `bad key ${apiKey}; cookie ${cookie}; sk-live-abcdef123456` } }, 401),
    })
    const bodySerialized = JSON.stringify(bodyLeak)
    assert.equal(bodySerialized.includes(apiKey), false)
    assert.equal(bodySerialized.includes(cookie), false)
    assert.equal(bodySerialized.includes('sk-live-abcdef123456'), false)
    assert.match(bodyLeak.checks.connectivity.error, /\*\*\*/)

    const textLeak = await probeEndpoint({
      baseURL: PROBE_BASE,
      apiKey,
      headers: { cookie },
      checks: ['connectivity'],
      fetchImpl: async () => textResponse(`proxy failure: key=${apiKey} cookie=${cookie}`, 502),
    })
    const textSerialized = JSON.stringify(textLeak)
    assert.equal(textSerialized.includes(apiKey), false)
    assert.equal(textSerialized.includes(cookie), false)
    assert.match(textLeak.checks.connectivity.error, /\*\*\*/)
  })

  test('a successful report never carries the credential', async () => {
    const apiKey = 'relay-probe-plain-secret'
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      apiKey,
      checks: ['connectivity'],
      fetchImpl: async () => jsonResponse({ data: [{ id: 'gpt-4o' }] }),
    })
    assert.equal(JSON.stringify(report).includes(apiKey), false)
  })
})

describe('prober: timeout and cancellation', () => {
  test('a hung endpoint is stopped by the per-request deadline', async () => {
    const timeoutMs = 30
    const keepAlive = setTimeout(() => {}, 2_000)
    let settled = false
    const fetchImpl = (url, init) =>
      new Promise((resolve, reject) => {
        const abort = () => {
          if (settled) return
          settled = true
          clearTimeout(keepAlive)
          const error = new Error('the request was aborted')
          error.name = 'AbortError'
          reject(error)
        }
        if (init.signal.aborted) abort()
        else init.signal.addEventListener('abort', abort, { once: true })
      })

    const startedAt = Date.now()
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      apiKey: 'probe-test-key',
      checks: ['connectivity'],
      timeoutMs,
      fetchImpl,
    })
    const elapsed = Date.now() - startedAt
    clearTimeout(keepAlive)

    assert.equal(report.ok, false)
    assert.match(report.checks.connectivity.error, new RegExp(`request timed out after ${timeoutMs}ms`))
    assert.ok(elapsed >= timeoutMs - 5, `timed out too early (${elapsed}ms)`)
    assert.ok(elapsed < 2_000, `timed out too late (${elapsed}ms)`)
  })

  test('caller cancellation is reported as an abort instead of a timeout', async () => {
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), 10)
    const fetchImpl = (url, init) =>
      new Promise((resolve, reject) => {
        const completion = setTimeout(() => resolve(jsonResponse({ data: [{ id: 'late' }] })), 1_000)
        init.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(completion)
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          },
          { once: true },
        )
      })

    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      checks: ['connectivity'],
      timeoutMs: 5_000,
      signal: controller.signal,
      fetchImpl,
    })
    clearTimeout(abortTimer)

    assert.equal(report.ok, false)
    assert.equal(report.checks.connectivity.error, 'probe aborted by the caller')
    assert.match(report.warnings.join('\n'), /probe aborted by the caller/)
  })

  test('an already-aborted signal is reported as an abort', async () => {
    const controller = new AbortController()
    controller.abort()
    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      checks: ['connectivity'],
      timeoutMs: 5_000,
      signal: controller.signal,
      fetchImpl: async () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      },
    })
    assert.equal(report.ok, false)
    assert.equal(report.checks.connectivity.error, 'probe aborted by the caller')
  })
})

describe('prober: options, headers, and every check', () => {
  test('validates its options', async () => {
    await assert.rejects(probeEndpoint(null), TypeError)
    await assert.rejects(probeEndpoint({}), error => error.code === 'invalid-probe-target')
    await assert.rejects(probeEndpoint({ baseURL: '   ' }), error => error.code === 'invalid-probe-target')
    for (const baseURL of [
      'not a url',
      'ftp://relay.example.test/v1',
      'https://user:pass@relay.example.test/v1',
      'https://relay.example.test/v1?query=1',
      'https://relay.example.test/v1#frag',
      ' https://relay.example.test/v1',
    ]) {
      await expectApiCode(probeEndpoint({ baseURL }), 'invalid-probe-target')
    }
    await expectApiCode(probeEndpoint({ baseURL: PROBE_BASE, api: 'cohere' }), 'unsupported-api')
    await expectApiCode(probeEndpoint({ baseURL: PROBE_BASE, checks: 'connectivity' }), 'invalid-probe-check')
    await expectApiCode(probeEndpoint({ baseURL: PROBE_BASE, checks: ['connectivity', 'bogus'] }), 'invalid-probe-check')

    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1000']) {
      await assert.rejects(probeEndpoint({ baseURL: PROBE_BASE, timeoutMs }), TypeError, String(timeoutMs))
    }
    await assert.rejects(probeEndpoint({ baseURL: PROBE_BASE, fetchImpl: 1 }), TypeError)
    await assert.rejects(probeEndpoint({ baseURL: PROBE_BASE, fetchImpl: null }), TypeError)
    await assert.rejects(probeEndpoint({ baseURL: PROBE_BASE, headers: 'nope' }), TypeError)
    await assert.rejects(probeEndpoint({ baseURL: PROBE_BASE, headers: { 'x-tag': 1 } }), TypeError)
    await expectApiCode(probeEndpoint({ baseURL: PROBE_BASE, headers: { 'bad header': 'x' } }), 'invalid-probe-target')
    await assert.rejects(probeEndpoint({ baseURL: PROBE_BASE, apiKey: 5 }), TypeError)
    await assert.rejects(probeEndpoint({ baseURL: PROBE_BASE, signal: {} }), TypeError)
  })

  test('each wire protocol carries its own credential header and merges extra headers', async () => {
    const cases = [
      ['openai-completions', headers => assert.equal(headers.authorization, 'Bearer protocol-key')],
      ['openai-responses', headers => assert.equal(headers.authorization, 'Bearer protocol-key')],
      [
        'anthropic-messages',
        headers => {
          assert.equal(headers['x-api-key'], 'protocol-key')
          assert.equal(headers['anthropic-version'], '2023-06-01')
          assert.equal(headers.authorization, undefined)
        },
      ],
      ['google-generative-ai', headers => assert.equal(headers['x-goog-api-key'], 'protocol-key')],
    ]
    for (const [api, checkHeaders] of cases) {
      const { calls, fetchImpl } = mockFetch(() => jsonResponse({ data: [] }))
      await probeEndpoint({
        baseURL: PROBE_BASE,
        api,
        apiKey: 'protocol-key',
        headers: { 'X-Extra': 'yes' },
        checks: ['connectivity'],
        fetchImpl,
      })
      assert.equal(calls.length, 1, api)
      checkHeaders(calls[0].headers)
      assert.equal(calls[0].headers['x-extra'], 'yes', api)
      assert.equal(calls[0].headers['user-agent'], '@xiaoxing/api-provider-manager prober', api)
    }
  })

  test('runs every requested check and collects every recommendation', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: init.body })
      if (init.method === 'GET') return jsonResponse({ data: [{ id: 'gpt-4o' }] })
      const body = JSON.parse(init.body)
      if (body.messages?.[0]?.role === 'developer') {
        return jsonResponse({ error: { message: 'unsupported role: developer' } }, 400)
      }
      if ('max_completion_tokens' in body) {
        return jsonResponse({ error: { message: 'unknown max_completion_tokens' } }, 400)
      }
      if ('reasoning_effort' in body) {
        return jsonResponse({ error: { message: 'reasoning_effort unsupported' } }, 400)
      }
      if ('tools' in body) return jsonResponse({ error: { message: 'strict tools unsupported' } }, 422)
      return jsonResponse({ choices: [] })
    }

    const report = await probeEndpoint({
      baseURL: PROBE_BASE,
      api: 'openai-completions',
      modelId: 'gpt-4o',
      checks: [...PROBE_CHECKS],
      fetchImpl,
    })

    assert.deepEqual(Object.keys(report.checks), [...PROBE_CHECKS])
    assert.equal(calls.length, 6, 'one model listing plus five chat-shaped requests')
    assert.equal(report.ok, true)
    assert.deepEqual(report.recommendedCompat, {
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      supportsReasoningEffort: false,
      supportsStrictMode: false,
    })
    assert.equal(report.warnings.length, 4)
  })
})

/* ------------------------------------------------------------------------- */
/* Importer: sanitized export                                                */
/* ------------------------------------------------------------------------- */

/** Build one valid provider profile for export and import fixtures. */
function providerProfile(overrides = {}) {
  return {
    name: 'Relay',
    baseURL: 'https://relay.example/v1',
    api: 'openai-completions',
    apiKeyEnv: 'RELAY_API_KEY',
    models: [{ id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000, maxTokens: 16_384 }],
    ...overrides,
  }
}

/** Build one xiaoxing export-shaped document around one provider. */
function xiaoxingDocument(profileOverrides = {}, providerId = 'relay') {
  return {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    providers: { [providerId]: providerProfile(profileOverrides) },
  }
}

describe('importer: exportSanitizedProviders', () => {
  test('strips credential headers and keeps harmless headers', () => {
    const exported = exportSanitizedProviders({
      relay: providerProfile({
        headers: {
          Authorization: 'Bearer abcdef123456',
          'X-Api-Key': 'x-api-key-secret',
          'x-goog-api-key': 'google-api-key-secret',
          Cookie: 'session=private',
          'x-request-tag': 'alpha',
          'x-auth-copy': 'Bearer another-secret',
        },
      }),
    })

    assert.equal(exported.format, EXPORT_FORMAT)
    assert.equal(typeof exported.exportedAt, 'string')
    assert.ok(Number.isFinite(Date.parse(exported.exportedAt)))
    assert.deepEqual(Object.keys(exported.providers), ['relay'])
    assert.deepEqual(exported.providers.relay.headers, { 'x-request-tag': 'alpha' })
    assert.equal(exported.providers.relay.apiKeyEnv, 'RELAY_API_KEY')
  })

  test('drops the whole header map when only credentials remain', () => {
    const exported = exportSanitizedProviders({
      relay: providerProfile({ headers: { authorization: 'Bearer x', 'x-api-key': 'k', cookie: 'c=1' } }),
    })
    assert.equal('headers' in exported.providers.relay, false)
  })

  test('omits plaintext secrets at every depth and keeps the apiKeyEnv reference', () => {
    const secret = 'sk-export-plaintext-secret-123'
    const exported = exportSanitizedProviders({
      relay: providerProfile({
        apiKey: secret,
        api_key: secret,
        apiKeyValue: secret,
        api_key_value: secret,
        secret: 'another-secret-value',
        token: 'token-value',
        accessToken: 'access-token-value',
        access_token: 'access-token-value',
        metadata: { apiKey: secret, nested: [{ secret: 'nested-secret-value' }] },
        models: [{ id: 'gpt-4o', name: 'GPT-4o', apiKey: secret, contextWindow: 128_000 }],
      }),
    })

    const profile = exported.providers.relay
    const serialized = JSON.stringify(profile)
    for (const forbidden of [
      secret,
      'another-secret-value',
      'token-value',
      'access-token-value',
      'nested-secret-value',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden)
    }
    for (const key of [
      'apiKey',
      'api_key',
      'apiKeyValue',
      'api_key_value',
      'secret',
      'token',
      'accessToken',
      'access_token',
    ]) {
      assert.equal(key in profile, false, key)
    }
    assert.deepEqual(profile.metadata, { nested: [{}] })
    assert.equal('apiKey' in profile.models[0], false)
    assert.equal(profile.apiKeyEnv, 'RELAY_API_KEY')
  })

  test('exports an array of profiles without their id and sanitizes wrapper profiles', () => {
    const arrayExport = exportSanitizedProviders([{ id: 'array-relay', ...providerProfile() }])
    assert.deepEqual(Object.keys(arrayExport.providers), ['array-relay'])
    assert.equal('id' in arrayExport.providers['array-relay'], false)
    assert.equal(arrayExport.providers['array-relay'].baseURL, 'https://relay.example/v1')

    const wrapperExport = exportSanitizedProviders({
      relay: { profile: providerProfile({ apiKey: 'wrapped-plaintext-secret' }), apiKey: 'wrapper-plaintext-secret' },
    })
    const serialized = JSON.stringify(wrapperExport)
    assert.equal(serialized.includes('wrapped-plaintext-secret'), false)
    assert.equal(serialized.includes('wrapper-plaintext-secret'), false)
    assert.equal(wrapperExport.providers.relay.baseURL, 'https://relay.example/v1')
  })

  test('honors providerIds and sanitized sync policies', () => {
    const providers = {
      alpha: providerProfile(),
      beta: providerProfile({ baseURL: 'https://beta.example/v1' }),
    }
    const filtered = exportSanitizedProviders(providers, { providerIds: ['beta', 42] })
    assert.deepEqual(Object.keys(filtered.providers), ['beta'])

    const withPolicy = exportSanitizedProviders(providers, {
      includeSyncPolicy: true,
      syncPolicies: {
        alpha: {
          providerId: 'alpha',
          syncMode: 'mirror',
          syncCooldownMs: 5_000,
          includePatterns: ['gpt-*'],
          lastError: null,
          ignored: 'nope',
        },
      },
    })
    assert.deepEqual(withPolicy.providers.alpha.syncPolicy, {
      syncMode: 'mirror',
      syncCooldownMs: 5_000,
      includePatterns: ['gpt-*'],
      lastError: null,
    })
    assert.equal('syncPolicy' in withPolicy.providers.beta, false)

    const arrayPolicies = exportSanitizedProviders(providers, {
      includeSyncPolicy: true,
      syncPolicies: [{ providerId: 'beta', syncMode: 'add-new' }],
    })
    assert.deepEqual(arrayPolicies.providers.beta.syncPolicy, { syncMode: 'add-new' })
  })
})

/* ------------------------------------------------------------------------- */
/* Importer: YAML subset parser                                              */
/* ------------------------------------------------------------------------- */

describe('importer: parseYamlSubset', () => {
  test('parses nested mappings, block sequences, and inline collections', () => {
    const source = [
      '# leading comment',
      '---',
      'providers:',
      '  relay:',
      '    baseUrl: "https://relay.example/v1"   # trailing comment',
      '    api: openai-completions',
      "    headers: { x-tag: alpha, \"quoted:key\": 'v # literal' }",
      '    models:',
      '      - id: gpt-4o',
      '        name: GPT-4o',
      '        input: [text, image]',
      '        limit: {context: 128000, output: 16384}',
      '      - id: gpt-4o-mini',
      '    enabled: true',
      '    disabled: false',
      '    empty:',
      '    note: null',
      '',
    ].join('\n')

    assert.deepEqual(parseYamlSubset(source), {
      providers: {
        relay: {
          baseUrl: 'https://relay.example/v1',
          api: 'openai-completions',
          headers: { 'x-tag': 'alpha', 'quoted:key': 'v # literal' },
          models: [
            {
              id: 'gpt-4o',
              name: 'GPT-4o',
              input: ['text', 'image'],
              limit: { context: 128_000, output: 16_384 },
            },
            { id: 'gpt-4o-mini' },
          ],
          enabled: true,
          disabled: false,
          empty: null,
          note: null,
        },
      },
    })
  })

  test('strips comments without eating hashes inside quotes, URLs, or plain scalars', () => {
    const parsed = parseYamlSubset(
      [
        "name: O'Brien # trailing comment",
        'size: 5" # trailing comment',
        'url: https://relay.example/v1#fragment',
        "quoted: 'a # b' # trailing comment",
        'double: "d # e" # trailing comment',
        'plain: value#suffix',
        '',
      ].join('\n'),
    )
    assert.deepEqual(parsed, {
      name: "O'Brien",
      size: '5"',
      url: 'https://relay.example/v1#fragment',
      quoted: 'a # b',
      double: 'd # e',
      plain: 'value#suffix',
    })
  })

  test('parses quoted scalars, escapes, document markers, and end markers', () => {
    const parsed = parseYamlSubset(
      ['a: "line\\nnext"', "b: 'it''s'", 'c: "\\u0041"', 'd: "tab\\there"', ''].join('\n'),
    )
    assert.deepEqual(parsed, { a: 'line\nnext', b: "it's", c: 'A', d: 'tab\there' })

    assert.deepEqual(parseYamlSubset('---\na: 1\n'), { a: 1 })
    assert.deepEqual(parseYamlSubset('--- a: 1\nb: 2\n'), { a: 1, b: 2 })
    assert.deepEqual(parseYamlSubset('a: 1\n...\n'), { a: 1 })
    assert.deepEqual(parseYamlSubset('\uFEFFa: 1\r\nb: 2\r\n'), { a: 1, b: 2 })
    assert.equal(parseYamlSubset(''), null)
    assert.equal(parseYamlSubset('   \n'), null)
    assert.equal(parseYamlSubset('# only a comment\n'), null)
    assert.equal(parseYamlSubset('---\n'), null)
  })

  test('reports syntax errors with their source line', () => {
    const cases = [
      ['tab indentation', 'providers:\n\trelay: x\n', 2, /tab indentation is not supported/],
      ['block scalar', 'providers:\n  relay:\n    baseUrl: |\n      text\n', 3, /block scalars/],
      ['folded block scalar', 'providers:\n  relay:\n    baseUrl: >\n      text\n', 3, /block scalars/],
      ['multiple documents', 'a: 1\n---\nb: 2\n', 2, /multiple YAML documents/],
      ['unterminated quoted string', 'a: ["x]\n', 1, /unterminated double-quoted string/],
      ['bad inline sequence', 'a: [1, 2\n', 1, /expected a comma or closing bracket/],
      ['bad inline mapping', 'a: {x}\n', 1, /expected a colon in an inline mapping/],
      ['unexpected content', 'providers:\n  a: 1\n    b: 2\n', 3, /unexpected content/],
      ['non-mapping root', 'just a scalar\n', 1, /expected a "key: value" mapping entry/],
      ['empty mapping key', 'providers:\n  : value\n', 2, /mapping entry needs a key/],
    ]
    for (const [name, source, line, pattern] of cases) {
      const error = (() => {
        try {
          parseYamlSubset(source)
        } catch (error_) {
          return error_
        }
        throw new Error(`${name}: expected parseYamlSubset to reject`)
      })()
      assert.ok(error instanceof ApiManagerError, name)
      assert.equal(error.code, 'invalid-import', name)
      assert.equal(error.details.line, line, name)
      assert.match(error.message, new RegExp(`^YAML line ${line}: `), name)
      assert.match(error.message, pattern, name)
    }
  })

  test('returns !!js tags as opaque markers and never evaluates them', () => {
    globalThis.__apmImporterEvaluated = false
    try {
      const parsed = parseYamlSubset(
        [
          'config:',
          '  dataDir: !!js dshHomePath("xiaoxing")',
          '  apiKey: !!js "process.env.RELAY_KEY"',
          '  list:',
          '    - !!js eval("globalThis.__apmImporterEvaluated = true")',
          '',
        ].join('\n'),
      )
      assert.deepEqual(parsed.config.dataDir, { __jsExpr: 'dshHomePath("xiaoxing")' })
      assert.deepEqual(parsed.config.apiKey, { __jsExpr: 'process.env.RELAY_KEY' })
      assert.deepEqual(parsed.config.list, [
        { __jsExpr: 'eval("globalThis.__apmImporterEvaluated = true")' },
      ])
      assert.equal(globalThis.__apmImporterEvaluated, false, 'a !!js tag must never be evaluated')
    } finally {
      delete globalThis.__apmImporterEvaluated
    }
  })
})

/* ------------------------------------------------------------------------- */
/* Importer: format detection and all four import formats                    */
/* ------------------------------------------------------------------------- */

describe('importer: format detection', () => {
  test('exposes the documented import formats', () => {
    assert.deepEqual([...IMPORT_FORMATS], ['xiaoxing-json', 'omp-yaml', 'cherry-json', 'dsh-cordis-yaml'])
    assert.equal(EXPORT_FORMAT, 'xiaoxing-api-manager-v1')
  })

  test('auto-detects and re-imports a sanitized xiaoxing export', () => {
    const exported = exportSanitizedProviders({
      'relay-one': providerProfile({
        headers: { 'x-tag': 'alpha' },
        models: [{ id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000, maxTokens: 16_384 }],
      }),
    })

    const result = importThirdPartyConfig(JSON.stringify(exported))
    assert.equal(result.format, 'xiaoxing-json')
    assert.deepEqual(Object.keys(result.providers), ['relay-one'])
    assert.deepEqual(result.providers['relay-one'], {
      name: 'Relay',
      baseURL: 'https://relay.example/v1',
      api: 'openai-completions',
      models: [{ id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128_000, maxTokens: 16_384 }],
      apiKeyEnv: 'RELAY_API_KEY',
      headers: { 'x-tag': 'alpha' },
    })
    assert.deepEqual(result.pendingSecrets, [])
    assert.deepEqual(result.skippedReserved, [])
    assert.deepEqual(result.warnings, [])
  })

  test('auto-detects omp-yaml and applies OMP model defaults', () => {
    const source = [
      'providers:',
      '  omp-relay:',
      '    baseUrl: https://relay.example/v1',
      '    api: openai-completions',
      '    apiKey: $OMP_RELAY_KEY',
      '    models:',
      '      - id: gpt-4o',
      '        name: GPT-4o',
      '',
    ].join('\n')

    const result = importThirdPartyConfig(source)
    assert.equal(result.format, 'omp-yaml')
    assert.deepEqual(Object.keys(result.providers), ['omp-relay'])
    assert.deepEqual(result.providers['omp-relay'], {
      name: 'omp-relay',
      baseURL: 'https://relay.example/v1',
      api: 'openai-completions',
      models: [
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          contextWindow: 128_000,
          maxTokens: 16_384,
          input: ['text'],
          reasoningEfforts: false,
        },
      ],
      apiKeyEnv: 'OMP_RELAY_KEY',
    })
    assert.deepEqual(result.pendingSecrets, [])
  })

  test('auto-detects cherry-json and skips reserved ids', () => {
    const payload = [
      {
        id: 'cherry-relay',
        name: 'Cherry Relay',
        type: 'openai',
        apiHost: 'https://cherry.example/v1',
        apiKey: 'cherry-literal-secret-123',
        models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
      },
      {
        id: 'openai',
        name: 'OpenAI',
        type: 'openai',
        apiHost: 'https://api.openai.com/v1',
        models: [{ id: 'gpt-4o' }],
      },
      {
        id: 'deepseek-official',
        name: 'DeepSeek',
        type: 'openai',
        apiHost: 'https://api.deepseek.com/v1',
        models: [{ id: 'deepseek-chat' }],
      },
    ]

    const result = importThirdPartyConfig(JSON.stringify(payload))
    assert.equal(result.format, 'cherry-json')
    assert.deepEqual(Object.keys(result.providers), ['cherry-relay'])
    const profile = result.providers['cherry-relay']
    assert.equal(profile.baseURL, 'https://cherry.example/v1')
    assert.equal(profile.api, 'openai-completions')
    assert.equal(profile.apiKeyEnv, 'CHERRY_RELAY_API_KEY')
    assert.equal('apiKey' in profile, false)
    assert.deepEqual(
      profile.models.map(model => model.id),
      ['gpt-4o', 'gpt-4o-mini'],
    )
    assert.deepEqual(result.pendingSecrets, [
      {
        providerId: 'cherry-relay',
        apiKeyEnv: 'CHERRY_RELAY_API_KEY',
        secret: 'cherry-literal-secret-123',
      },
    ])
    assert.deepEqual(
      result.skippedReserved.map(entry => [entry.providerId, entry.category]),
      [
        ['openai', 'builtin-catalog'],
        ['deepseek-official', 'native'],
      ],
    )
    assert.match(result.skippedReserved[0].reason, /built-in pi-ai catalog provider/)
    assert.match(result.skippedReserved[1].reason, /native DSH provider/)
  })

  test('auto-detects dsh-cordis-yaml patch arrays', () => {
    const source = [
      '- insert:',
      '    - id: llm-pi-ai',
      "      name: '@deepseek-ai/dsh-llm-pi-ai'",
      '      config:',
      '        providers:',
      '          cordis-relay:',
      '            baseURL: https://cordis.example/v1',
      '            api: openai-responses',
      '            apiKey: cordis-literal-secret-456',
      '            models:',
      '              - id: gpt-5',
      '',
    ].join('\n')

    const result = importThirdPartyConfig(source)
    assert.equal(result.format, 'dsh-cordis-yaml')
    assert.deepEqual(Object.keys(result.providers), ['cordis-relay'])
    assert.deepEqual(result.providers['cordis-relay'], {
      name: 'cordis-relay',
      baseURL: 'https://cordis.example/v1',
      api: 'openai-responses',
      models: [{ id: 'gpt-5', name: 'gpt-5' }],
      apiKeyEnv: 'CORDIS_RELAY_API_KEY',
    })
    assert.deepEqual(result.pendingSecrets, [
      {
        providerId: 'cordis-relay',
        apiKeyEnv: 'CORDIS_RELAY_API_KEY',
        secret: 'cordis-literal-secret-456',
      },
    ])
  })

  test('auto-detects every shape a Cherry payload may arrive in', () => {
    const cherryProvider = {
      id: 'wrapped-cherry',
      name: 'Wrapped Cherry',
      type: 'openai',
      apiHost: 'https://wrapped.example/v1',
      models: [{ id: 'gpt-4o' }],
    }
    for (const payload of [
      { data: [cherryProvider] },
      { providers: [cherryProvider] },
      { providers: { 'wrapped-cherry': cherryProvider } },
      cherryProvider,
    ]) {
      const result = importThirdPartyConfig(payload)
      assert.equal(result.format, 'cherry-json')
      assert.deepEqual(Object.keys(result.providers), ['wrapped-cherry'])
      assert.equal(result.providers['wrapped-cherry'].baseURL, 'https://wrapped.example/v1')
    }
  })

  test('accepts explicit formats and rejects invalid or empty input', () => {
    const explicit = importThirdPartyConfig(xiaoxingDocument(), { format: 'xiaoxing-json' })
    assert.equal(explicit.format, 'xiaoxing-json')
    assert.deepEqual(Object.keys(explicit.providers), ['relay'])

    const explicitYaml = importThirdPartyConfig(
      ['providers:', '  relay:', '    baseUrl: https://relay.example/v1', '    api: openai-completions', '    models:', '      - id: m', ''].join('\n'),
      { format: 'omp-yaml' },
    )
    assert.equal(explicitYaml.format, 'omp-yaml')
    assert.deepEqual(Object.keys(explicitYaml.providers), ['relay'])

    expectSyncCode(() => importThirdPartyConfig('a: 1\n', { format: 'nope' }), 'unsupported-import-format')
    expectSyncCode(() => importThirdPartyConfig('   '), 'invalid-import')
    expectSyncCode(() => importThirdPartyConfig(null), 'invalid-import')
    expectSyncCode(() => importThirdPartyConfig(undefined), 'invalid-import')
    assert.throws(() => importThirdPartyConfig(42), TypeError)
    expectSyncCode(() => importThirdPartyConfig('relay: 1\n'), 'unsupported-import-format')
    expectSyncCode(() => importThirdPartyConfig('relay: 1\n', { format: 'omp-yaml' }), 'invalid-import')
    assert.throws(
      () => importThirdPartyConfig(xiaoxingDocument(), { configurableProviders: 'nope' }),
      TypeError,
    )
  })

  test('reports YAML syntax errors from the import entry point with their line', () => {
    const error = (() => {
      try {
        importThirdPartyConfig('providers:\n\trelay:\n\t\tbaseUrl: https://relay.example/v1\n')
      } catch (error_) {
        return error_
      }
      throw new Error('expected importThirdPartyConfig to reject')
    })()
    assert.ok(error instanceof ApiManagerError)
    assert.equal(error.code, 'invalid-import')
    assert.equal(error.details.line, 2)
    assert.match(error.message, /^YAML line 2: tab indentation/)
  })

  test('configurableProviders decides which ids are reserved', () => {
    const payload = xiaoxingDocument({}, 'relay-live')
    const declared = importThirdPartyConfig(payload, {
      configurableProviders: [{ provider: 'relay-live', declared: true }],
    })
    assert.deepEqual(Object.keys(declared.providers), ['relay-live'])

    const owned = importThirdPartyConfig(payload, { configurableProviders: [{ provider: 'relay-live' }] })
    assert.deepEqual(owned.providers, {})
    assert.deepEqual(owned.skippedReserved.map(entry => [entry.providerId, entry.category]), [['relay-live', null]])
    assert.match(owned.skippedReserved[0].reason, /already offered by the DSH configuration/)

    assert.throws(
      () => importThirdPartyConfig(payload, { configurableProviders: 'nope' }),
      TypeError,
    )
  })
})

/* ------------------------------------------------------------------------- */
/* Importer: credentials, headers, and normalization                         */
/* ------------------------------------------------------------------------- */

describe('importer: credentials and pending secrets', () => {
  test('moves a literal apiKey into pendingSecrets and keeps only a reference', () => {
    const secret = 'literal-relay-secret-123'
    const result = importThirdPartyConfig(xiaoxingDocument({ apiKey: secret, apiKeyEnv: undefined }))
    const profile = result.providers.relay
    assert.equal(profile.apiKeyEnv, 'RELAY_API_KEY')
    assert.equal('apiKey' in profile, false)
    assert.deepEqual(result.pendingSecrets, [{ providerId: 'relay', apiKeyEnv: 'RELAY_API_KEY', secret }])
    assert.equal(JSON.stringify(profile).includes(secret), false)
  })

  test('honors a declared apiKeyEnv for the pending secret', () => {
    const secret = 'literal-relay-secret-456'
    const result = importThirdPartyConfig(
      xiaoxingDocument({ apiKeyEnv: 'RELAY_DECLARED_KEY', apiKey: secret }),
    )
    assert.equal(result.providers.relay.apiKeyEnv, 'RELAY_DECLARED_KEY')
    assert.deepEqual(result.pendingSecrets, [
      { providerId: 'relay', apiKeyEnv: 'RELAY_DECLARED_KEY', secret },
    ])
  })

  test('ignores an invalid declared apiKeyEnv and derives a fresh reference', () => {
    const result = importThirdPartyConfig(
      xiaoxingDocument({ apiKeyEnv: '9bad', apiKey: 'literal-relay-secret-789' }),
    )
    assert.equal(result.providers.relay.apiKeyEnv, 'RELAY_API_KEY')
    assert.match(result.warnings.join('\n'), /invalid apiKeyEnv/)
    assert.equal(result.pendingSecrets.length, 1)
  })

  test('reads environment references without storing a secret', () => {
    const cases = [
      ['$RELAY_KEY', 'RELAY_KEY'],
      ['${RELAY_KEY}', 'RELAY_KEY'],
      ['RELAY_KEY_2', 'RELAY_KEY_2'],
    ]
    for (const [apiKey, expectedEnv] of cases) {
      const result = importThirdPartyConfig(xiaoxingDocument({ apiKey, apiKeyEnv: undefined }))
      assert.equal(result.providers.relay.apiKeyEnv, expectedEnv, apiKey)
      assert.deepEqual(result.pendingSecrets, [], apiKey)
      assert.deepEqual(result.warnings, [], apiKey)
    }
  })

  test('never executes shell-command or !!js credential references', () => {
    const command = importThirdPartyConfig(
      xiaoxingDocument({ apiKey: '!secret-tool read relay', apiKeyEnv: undefined }),
    )
    assert.equal('apiKeyEnv' in command.providers.relay, false)
    assert.deepEqual(command.pendingSecrets, [])
    assert.match(command.warnings.join('\n'), /commands are never executed/)

    globalThis.__apmImporterEvaluated = false
    try {
      const jsTagged = importThirdPartyConfig(
        [
          'providers:',
          '  js-relay:',
          '    baseUrl: https://relay.example/v1',
          '    api: openai-completions',
          '    apiKey: !!js globalThis.__apmImporterEvaluated = true',
          '    models:',
          '      - id: m',
          '',
        ].join('\n'),
      )
      assert.equal(jsTagged.format, 'omp-yaml')
      assert.equal('apiKeyEnv' in jsTagged.providers['js-relay'], false)
      assert.deepEqual(jsTagged.pendingSecrets, [])
      assert.match(jsTagged.warnings.join('\n'), /!!js expression/)
      assert.equal(globalThis.__apmImporterEvaluated, false)
    } finally {
      delete globalThis.__apmImporterEvaluated
    }
  })

  test('sanitizes imported headers and reports each dropped credential', () => {
    const result = importThirdPartyConfig(
      xiaoxingDocument({
        headers: {
          authorization: 'Bearer abcdef123456',
          'x-api-key': 'header-secret',
          'x-goog-api-key': 'google-header-secret',
          cookie: 'session=private',
          'x-cred-copy': 'Bearer copied-secret',
          'x-env': '$RELAY_TOKEN',
          'x-command': '!op read relay',
          'x-request-tag': 'alpha',
        },
      }),
    )
    assert.deepEqual(result.providers.relay.headers, { 'x-request-tag': 'alpha' })
    const warningText = result.warnings.join('\n')
    for (const header of ['authorization', 'x-api-key', 'x-goog-api-key', 'cookie', 'x-cred-copy', 'x-env', 'x-command']) {
      assert.match(warningText, new RegExp(header), header)
    }
    assert.equal(warningText.includes('header-secret'), false)
  })

  test('diagnostics never expose a literal secret', () => {
    const secret = 'diagnostic-leak-secret-999'
    const result = importThirdPartyConfig({
      format: EXPORT_FORMAT,
      exportedAt: new Date().toISOString(),
      providers: {
        relay: providerProfile({
          apiKey: secret,
          headers: { authorization: `Bearer ${secret}` },
        }),
        'bad-provider': {
          baseURL: 'https://bad.example/v1',
          api: 'cohere',
          models: [{ id: 'm' }],
        },
      },
    })
    const diagnostics = JSON.stringify({
      providers: result.providers,
      warnings: result.warnings,
      skippedReserved: result.skippedReserved,
      format: result.format,
    })
    assert.equal(diagnostics.includes(secret), false)
    assert.deepEqual(result.pendingSecrets, [{ providerId: 'relay', apiKeyEnv: 'RELAY_API_KEY', secret }])
    assert.match(result.warnings.join('\n'), /cannot configure/)
  })
})

describe('importer: provider and model normalization', () => {
  test('normalizes provider ids and reports duplicates', () => {
    const result = importThirdPartyConfig({
      format: EXPORT_FORMAT,
      exportedAt: new Date().toISOString(),
      providers: {
        'My Relay': providerProfile({ baseURL: 'https://first.example/v1' }),
        'my relay': providerProfile({ baseURL: 'https://second.example/v1' }),
        '123': {
          baseURL: 'https://invalid.example/v1',
          api: 'openai-completions',
          models: [{ id: 'm' }],
        },
      },
    })
    assert.deepEqual(Object.keys(result.providers), ['my-relay'])
    assert.equal(result.providers['my-relay'].baseURL, 'https://first.example/v1')
    assert.match(result.warnings.join('\n'), /appears more than once/)
    assert.match(result.warnings.join('\n'), /no id that can be mapped/)
  })

  test('skips providers and models that cannot be represented', () => {
    const result = importThirdPartyConfig({
      format: EXPORT_FORMAT,
      exportedAt: new Date().toISOString(),
      providers: {
        'no-endpoint': { api: 'openai-completions', models: [{ id: 'm' }] },
        'no-models': { baseURL: 'https://valid.example/v1', api: 'openai-completions', models: [] },
        'bad-url': { baseURL: 'ftp://invalid.example/v1', api: 'openai-completions', models: [{ id: 'm' }] },
        'bad-api': { baseURL: 'https://valid.example/v1', api: 'cohere', models: [{ id: 'm' }] },
        'model-api': {
          baseURL: 'https://valid.example/v1',
          api: 'openai-completions',
          models: [{ id: 'm', api: 'anthropic-messages' }],
        },
        'duplicate-models': {
          baseURL: 'https://valid.example/v1',
          api: 'openai-completions',
          models: [{ id: 'm', name: 'first' }, { id: 'm', name: 'second' }],
        },
      },
    })
    assert.deepEqual(Object.keys(result.providers), ['duplicate-models'])
    const warningText = result.warnings.join('\n')
    assert.match(warningText, /has no endpoint URL/)
    assert.match(warningText, /has no usable models/)
    assert.match(warningText, /must use http:/)
    assert.match(warningText, /cannot configure/)
    assert.match(warningText, /cannot be represented under provider api/)
    assert.match(warningText, /lists model "m" more than once/)
    assert.equal(result.providers['duplicate-models'].models[0].name, 'first')
  })

  test('normalizes model metadata from every documented spelling', () => {
    const result = importThirdPartyConfig(
      xiaoxingDocument({
        models: [
          {
            id: 'vision-model',
            displayName: 'Vision Model',
            contextWindow: '200000',
            maxTokens: '32000',
            input: ['text', 'image'],
            reasoning: true,
          },
          { id: 'limited-model', limit: { context: 1_000, output: 100 } },
          { id: 'no-thinking', thinking: false },
        ],
      }),
    )
    assert.deepEqual(result.providers.relay.models, [
      {
        id: 'vision-model',
        name: 'Vision Model',
        contextWindow: 200_000,
        maxTokens: 32_000,
        input: ['text', 'image'],
        reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
      },
      { id: 'limited-model', name: 'limited-model', contextWindow: 1_000, maxTokens: 100 },
      { id: 'no-thinking', name: 'no-thinking', reasoningEfforts: false },
    ])
  })

  test('maskSecret never renders the full secret', () => {
    assert.equal(maskSecret(''), '')
    assert.equal(maskSecret(null), '')
    assert.equal(maskSecret(42), '')
    assert.equal(maskSecret('short'), '*****')
    const secret = 'abcdefghijklmnopqrstuvwxyz'
    const masked = maskSecret(secret)
    assert.notEqual(masked, secret)
    assert.ok(masked.startsWith('abcd'))
    assert.ok(masked.endsWith('wxyz'))
    assert.equal(masked.length, 20)
    assert.ok(masked.includes('*'))
  })
})

/* ------------------------------------------------------------------------- */
/* Files                                                                     */
/* ------------------------------------------------------------------------- */

test('files: LF line endings and exactly one trailing newline', () => {
  const source = readFileSync(new URL(import.meta.url), 'utf8')
  assert.ok(!source.includes('\r'), 'the test file must use LF line endings')
  assert.ok(source.endsWith('\n'), 'the test file must end with a newline')
  assert.ok(!source.endsWith('\n\n'), 'the test file must end with exactly one newline')
})
