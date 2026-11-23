/**
 * Safe, atomic JSON state files for the provider manager's data directory.
 *
 * The manager persists four small JSON documents in the plugin data directory:
 * `overrides.json`, `sync-state.json`, `custom-presets.json`, and
 * `registry-settings.json`. Each one holds state a user cannot cheaply recreate,
 * so the store never treats a damaged document as "no state": a corrupt file
 * raises `invalid-state` and is left untouched on disk for inspection, while a
 * symlink or a non-regular file raises `unsafe-file` and is never followed.
 *
 * Writes go through a private temporary file created in the same directory with
 * mode `0600` and are then renamed over the target, so a crash never leaves a
 * half-written document behind. Every read and write of one store runs through
 * a serialized queue, which makes `update(mutator)` a safe read-modify-write even
 * when several settings calls or background syncs overlap.
 * @module @xiaoxing/api-provider-manager/storage
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { ApiManagerError, messageOf } from './errors.js'

/** Version shared by every state document this module writes. */
export const PLUGIN_SCHEMA_VERSION = 1

/** Sync modes a provider policy may select, in offer order. */
export const SYNC_MODES = Object.freeze(['manual', 'add-new', 'mirror'])

/** Default cooldown between two live syncs of one provider. */
export const DEFAULT_SYNC_COOLDOWN_MS = 30_000

/** Default registry-cache lifetime (24 hours). */
export const DEFAULT_REGISTRY_TTL_MS = 24 * 60 * 60 * 1000

/** File names inside the manager's data directory. */
export const PLUGIN_STORE_FILES = Object.freeze({
  overrides: 'overrides.json',
  syncState: 'sync-state.json',
  customPresets: 'custom-presets.json',
  registrySettings: 'registry-settings.json',
})

/**
 * Whether a value is a plain JSON object rather than an array or class instance.
 * @param {unknown} value - value to inspect.
 * @returns {boolean} whether it is a plain object.
 */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Report invalid persisted state.
 * @param {string} message - actionable detail.
 * @param {Record<string, unknown>} [details] - structured context.
 * @returns {never} always throws.
 */
function stateError(message, details) {
  throw new ApiManagerError('invalid-state', message, details)
}

/**
 * Assert one provider-override document is structurally valid.
 *
 * The shape is `{ version: 1, providers: { [id]: { models: { [modelId]: delta } } } }`.
 * A model delta stays sparse: any object is accepted so a later phase can add
 * fields without a storage migration.
 * @param {unknown} data - parsed document to validate.
 * @returns {void}
 * @throws {ApiManagerError} `invalid-state` when the document is malformed.
 */
export function validateOverridesState(data) {
  if (!isPlainObject(data)) stateError('overrides state must be an object')
  if (data.version !== PLUGIN_SCHEMA_VERSION) {
    stateError(`overrides state version must be ${PLUGIN_SCHEMA_VERSION}`, { version: data.version })
  }
  if (!isPlainObject(data.providers)) stateError('overrides state needs a "providers" object')
  for (const [providerId, provider] of Object.entries(data.providers)) {
    if (!isPlainObject(provider)) stateError(`overrides provider "${providerId}" must be an object`, { providerId })
    if (!isPlainObject(provider.models)) {
      stateError(`overrides provider "${providerId}" needs a "models" object`, { providerId })
    }
    for (const [modelId, delta] of Object.entries(provider.models)) {
      if (!isPlainObject(delta)) {
        stateError(`overrides provider "${providerId}" model "${modelId}" must be an object`, { providerId, modelId })
      }
    }
  }
}

/**
 * Assert one sync-state document is structurally valid.
 *
 * The shape is `{ version: 1, providers: { [id]: policy } }`; every policy field
 * is optional so a partially written policy remains loadable, but a present field
 * must carry the documented type.
 * @param {unknown} data - parsed document to validate.
 * @returns {void}
 * @throws {ApiManagerError} `invalid-state` when the document is malformed.
 */
export function validateSyncState(data) {
  if (!isPlainObject(data)) stateError('sync state must be an object')
  if (data.version !== PLUGIN_SCHEMA_VERSION) {
    stateError(`sync state version must be ${PLUGIN_SCHEMA_VERSION}`, { version: data.version })
  }
  if (!isPlainObject(data.providers)) stateError('sync state needs a "providers" object')
  for (const [providerId, policy] of Object.entries(data.providers)) {
    assertSyncPolicy(providerId, policy)
  }
}

/**
 * Assert one provider sync policy.
 * @param {string} providerId - provider route key, for diagnostics.
 * @param {unknown} policy - policy to validate.
 * @returns {void}
 */
function assertSyncPolicy(providerId, policy) {
  if (!isPlainObject(policy)) stateError(`sync policy for "${providerId}" must be an object`, { providerId })
  if (policy.syncMode !== undefined && !SYNC_MODES.includes(policy.syncMode)) {
    stateError(`sync policy for "${providerId}" has syncMode ${JSON.stringify(policy.syncMode)}; expected one of ${SYNC_MODES.join(', ')}`, { providerId })
  }
  if (policy.syncCooldownMs !== undefined && (!Number.isInteger(policy.syncCooldownMs) || policy.syncCooldownMs < 0)) {
    stateError(`sync policy for "${providerId}" has a non-negative integer syncCooldownMs`, { providerId })
  }
  for (const field of ['includePatterns', 'excludePatterns', 'ignoredModels']) {
    const value = policy[field]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
      stateError(`sync policy for "${providerId}" has "${field}" as an array of strings`, { providerId, field })
    }
  }
  for (const field of ['includeNonChat', 'syncToSubagentAllowed']) {
    const value = policy[field]
    if (value !== undefined && typeof value !== 'boolean') {
      stateError(`sync policy for "${providerId}" has "${field}" as a boolean`, { providerId, field })
    }
  }
  for (const field of ['lastSyncedAt', 'lastStatus', 'lastError']) {
    const value = policy[field]
    if (value !== undefined && value !== null && typeof value !== 'string') {
      stateError(`sync policy for "${providerId}" has "${field}" as a string or null`, { providerId, field })
    }
  }
  if (policy.lastDiff !== undefined && policy.lastDiff !== null && !isPlainObject(policy.lastDiff)) {
    stateError(`sync policy for "${providerId}" has "lastDiff" as an object or null`, { providerId })
  }
}

/**
 * Assert one custom-preset document is structurally valid.
 * @param {unknown} data - parsed document to validate.
 * @returns {void}
 * @throws {ApiManagerError} `invalid-state` when the document is malformed.
 */
export function validateCustomPresetsState(data) {
  if (!isPlainObject(data)) stateError('custom presets state must be an object')
  if (data.version !== PLUGIN_SCHEMA_VERSION) {
    stateError(`custom presets state version must be ${PLUGIN_SCHEMA_VERSION}`, { version: data.version })
  }
  if (!Array.isArray(data.presets)) stateError('custom presets state needs a "presets" array')
  for (const preset of data.presets) {
    if (!isPlainObject(preset)) stateError('every custom preset must be an object')
    if (typeof preset.id !== 'string' || preset.id.trim() === '') {
      stateError('every custom preset needs a non-empty string id')
    }
  }
}

/**
 * Assert one registry-settings document is structurally valid.
 * @param {unknown} data - parsed document to validate.
 * @returns {void}
 * @throws {ApiManagerError} `invalid-state` when the document is malformed.
 */
export function validateRegistrySettingsState(data) {
  if (!isPlainObject(data)) stateError('registry settings must be an object')
  if (data.version !== PLUGIN_SCHEMA_VERSION) {
    stateError(`registry settings version must be ${PLUGIN_SCHEMA_VERSION}`, { version: data.version })
  }
  if (typeof data.offlineOnly !== 'boolean') stateError('registry settings "offlineOnly" must be a boolean')
  if (!Number.isFinite(data.ttlMs) || data.ttlMs <= 0) {
    stateError('registry settings "ttlMs" must be a positive finite number')
  }
  for (const field of ['modelsDevUrl', 'openRouterUrl']) {
    const value = data[field]
    if (value !== null && (typeof value !== 'string' || value.trim() === '')) {
      stateError(`registry settings "${field}" must be a non-empty string or null`, { field })
    }
  }
}

/**
 * Default provider sync policy.
 *
 * A route syncs automatically unless its owner turned that off: `add-new`
 * only ever appends models the endpoint newly lists, so it is safe as the
 * default for a route that never stored a policy.
 * @param {Record<string, unknown>} [overrides] - fields to replace.
 * @returns {Record<string, unknown>} a fresh policy object.
 */
export function createDefaultSyncPolicy(overrides = {}) {
  return {
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
    ...(isPlainObject(overrides) ? overrides : {}),
  }
}

/**
 * One JSON document on disk, read and written safely.
 *
 * Reads are cloned, so a caller may mutate the returned value without corrupting
 * the store, and a missing file yields a fresh clone of `defaultData()`. Writes
 * are serialized, validated, and atomic. A corrupt or unsafe file is reported as
 * an error instead of being silently replaced, which keeps a user's overrides
 * recoverable.
 * @example
 * const store = new SafeJsonStore({
 *   filePath: join(dataDir, 'overrides.json'),
 *   defaultData: () => ({ version: 1, providers: {} }),
 *   validate: validateOverridesState,
 * })
 * await store.update(data => { data.providers['my-relay'] = { models: {} } })
 */
export class SafeJsonStore {
  /**
   * @param {object} options - store configuration.
   * @param {string} options.filePath - absolute path of the JSON document.
   * @param {() => unknown} options.defaultData - returns a fresh default document for a missing file.
   * @param {(data: unknown) => (boolean | void)} [options.validate] - throws (or returns `false`) for invalid data.
   */
  constructor({ filePath, defaultData, validate } = {}) {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new TypeError('SafeJsonStore filePath must be a non-empty string')
    }
    if (typeof defaultData !== 'function') {
      throw new TypeError('SafeJsonStore defaultData must be a function returning a fresh default document')
    }
    if (validate !== undefined && typeof validate !== 'function') {
      throw new TypeError('SafeJsonStore validate must be a function when provided')
    }
    this.filePath = filePath
    this.defaultData = defaultData
    this.validate = validate
    this._tail = Promise.resolve()
  }

  /**
   * Read the document, or a clone of the default when the file is missing.
   * @returns {Promise<unknown>} a private clone of the current document.
   * @throws {ApiManagerError} `unsafe-file` for a symlink or non-regular file;
   *   `invalid-state` for corrupt JSON or a document the validator rejects.
   */
  read() {
    return this._enqueue(() => this._readUnsafe())
  }

  /**
   * Validate and atomically replace the document.
   * @param {unknown} nextData - complete document to persist.
   * @returns {Promise<unknown>} a clone of the document that was written.
   * @throws {ApiManagerError} `invalid-state` when `nextData` is rejected;
   *   `state-write-failed` when the file cannot be written.
   */
  write(nextData) {
    return this._enqueue(() => this._writeUnsafe(nextData))
  }

  /**
   * Read-modify-write the document under the store's serialized queue.
   *
   * The mutator receives a private copy and may either mutate it in place or
   * return a replacement document; `undefined` keeps the mutated copy.
   * @param {(current: any) => (unknown | Promise<unknown>)} mutator - update callback.
   * @returns {Promise<unknown>} a clone of the document that was written.
   * @throws {ApiManagerError} `invalid-state` when the result is rejected; any
   *   error the mutator throws is propagated unchanged.
   */
  update(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('SafeJsonStore update(mutator) needs a function')
    return this._enqueue(async () => {
      const current = await this._readUnsafe()
      const produced = await mutator(current)
      return this._writeUnsafe(produced === undefined ? current : produced)
    })
  }

  /** Run one task after every previously queued task, keeping the queue alive on failure. */
  _enqueue(task) {
    const result = this._tail.then(task)
    this._tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Build a fresh, private default document. */
  _defaultState() {
    let created
    try {
      created = this.defaultData()
    } catch (error) {
      throw new ApiManagerError('invalid-state', `default state for "${this.filePath}" could not be created: ${messageOf(error)}`, {
        filePath: this.filePath,
      })
    }
    return this._clone(created, 'default state')
  }

  /** Deep-clone one state document, reporting non-JSON values as invalid state. */
  _clone(value, label) {
    try {
      return structuredClone(value)
    } catch (error) {
      throw new ApiManagerError('invalid-state', `${label} for "${this.filePath}" is not JSON-serialisable: ${messageOf(error)}`, {
        filePath: this.filePath,
      })
    }
  }

  /** Validate one document, always naming the file and the failing rule. */
  _assertValid(data) {
    if (typeof this.validate !== 'function') return
    let verdict
    try {
      verdict = this.validate(data)
    } catch (error) {
      const detail = error instanceof ApiManagerError ? error.message : messageOf(error)
      throw new ApiManagerError('invalid-state', `state file "${this.filePath}" is invalid: ${detail}`, {
        filePath: this.filePath,
      })
    }
    if (verdict === false) {
      throw new ApiManagerError('invalid-state', `state file "${this.filePath}" is invalid`, { filePath: this.filePath })
    }
  }

  /** Read the document without queueing; callers already hold the queue. */
  async _readUnsafe() {
    let stats
    try {
      stats = await lstat(this.filePath)
    } catch (error) {
      if (error?.code === 'ENOENT') return this._defaultState()
      throw new ApiManagerError('unsafe-file', `state file "${this.filePath}" could not be inspected: ${messageOf(error)}`, {
        filePath: this.filePath,
      })
    }
    if (stats.isSymbolicLink()) {
      throw new ApiManagerError('unsafe-file', `state file "${this.filePath}" is a symbolic link; refusing to read it`, {
        filePath: this.filePath,
      })
    }
    if (!stats.isFile()) {
      throw new ApiManagerError('unsafe-file', `state file "${this.filePath}" is not a regular file; refusing to read it`, {
        filePath: this.filePath,
      })
    }

    let raw
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      throw new ApiManagerError('unsafe-file', `state file "${this.filePath}" could not be read: ${messageOf(error)}`, {
        filePath: this.filePath,
      })
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new ApiManagerError(
        'invalid-state',
        `state file "${this.filePath}" is not valid JSON; it was left untouched for recovery`,
        { filePath: this.filePath },
      )
    }
    this._assertValid(parsed)
    return this._clone(parsed, 'on-disk state')
  }

  /** Serialize one validated state document, reporting non-JSON values as invalid state. */
  _serialize(snapshot) {
    let json
    try {
      json = JSON.stringify(snapshot, null, 2)
    } catch (error) {
      throw new ApiManagerError('invalid-state', `state file "${this.filePath}" is not JSON-serialisable: ${messageOf(error)}`, {
        filePath: this.filePath,
      })
    }
    if (json === undefined) {
      throw new ApiManagerError('invalid-state', `state file "${this.filePath}" has no JSON representation`, {
        filePath: this.filePath,
      })
    }
    return `${json}\n`
  }

  /** Write the document without queueing; callers already hold the queue. */
  async _writeUnsafe(nextData) {
    const snapshot = this._clone(nextData, 'next state')
    this._assertValid(snapshot)

    const directory = dirname(this.filePath)
    const payload = this._serialize(snapshot)
    const temporaryPath = join(directory, `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`)

    try {
      await mkdir(directory, { recursive: true })
    } catch (error) {
      throw new ApiManagerError('state-write-failed', `state directory "${directory}" could not be created: ${messageOf(error)}`, {
        filePath: this.filePath,
      })
    }

    let handle
    try {
      handle = await open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(payload, { encoding: 'utf8' })
      await handle.close()
      handle = undefined
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => {})
      await rm(temporaryPath, { force: true }).catch(() => {})
      throw new ApiManagerError('state-write-failed', `state file "${this.filePath}" could not be written: ${messageOf(error)}`, {
        filePath: this.filePath,
      })
    }
    return this._clone(snapshot, 'written state')
  }
}

/**
 * Create the four state stores of one plugin data directory.
 * @param {string} dataDir - directory that holds the plugin's JSON documents.
 * @returns {{ overrides: SafeJsonStore, syncState: SafeJsonStore, customPresets: SafeJsonStore, registrySettings: SafeJsonStore }}
 *   the stores, each with its own serialized queue.
 * @throws {TypeError} when `dataDir` is not a non-empty string.
 */
export function createPluginStores(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new TypeError('createPluginStores dataDir must be a non-empty string')
  }
  return {
    overrides: new SafeJsonStore({
      filePath: join(dataDir, PLUGIN_STORE_FILES.overrides),
      defaultData: () => ({ version: PLUGIN_SCHEMA_VERSION, providers: {} }),
      validate: validateOverridesState,
    }),
    syncState: new SafeJsonStore({
      filePath: join(dataDir, PLUGIN_STORE_FILES.syncState),
      defaultData: () => ({ version: PLUGIN_SCHEMA_VERSION, providers: {} }),
      validate: validateSyncState,
    }),
    customPresets: new SafeJsonStore({
      filePath: join(dataDir, PLUGIN_STORE_FILES.customPresets),
      defaultData: () => ({ version: PLUGIN_SCHEMA_VERSION, presets: [] }),
      validate: validateCustomPresetsState,
    }),
    registrySettings: new SafeJsonStore({
      filePath: join(dataDir, PLUGIN_STORE_FILES.registrySettings),
      defaultData: () => ({
        version: PLUGIN_SCHEMA_VERSION,
        offlineOnly: false,
        ttlMs: DEFAULT_REGISTRY_TTL_MS,
        modelsDevUrl: null,
        openRouterUrl: null,
      }),
      validate: validateRegistrySettingsState,
    }),
  }
}
