/**
 * Host half of the Xiaoxing API provider manager bundle.
 *
 * The `xiaoxingApiManager` service owns every operation: custom pi-ai route
 * onboarding, five-layer model enrichment, live model synchronization, endpoint
 * probing, route auditing, sanitized import/export, and default/subagent model
 * selection. The `xiaoxing_api_manager` tool and the Web settings page call the
 * same Remote methods. Mutating methods run through one serialized write queue
 * and every failure is returned in a stable envelope, so a Remote caller never
 * receives a thrown Error or a credential.
 *
 * Live sync is built for an IM model picker: a concurrent call for one provider
 * is deduplicated, a cooldown serves the previously synced list, and an
 * endpoint failure or an empty listing keeps the configured models instead of
 * wiping the route.
 * @module @xiaoxing/api-provider-manager
 */

import { join, resolve } from 'node:path'

import { classifyProviders, describeCredential, mutatePiAiProvider, readDefaultSelection, readPiAiSnapshot, readSubagentSelection, removePiAiProvider, resolveCredential, saveDefaultSelection, setCredential, unsetCredential, updateSubagentSelection } from './lib/config-sync.js'
import { discoverEndpointModels } from './lib/discovery.js'
import { auditProvider, enrichModel, planProtocolSplit, searchCatalogModels } from './lib/enricher.js'
import { ApiManagerError, messageOf, redactSecretText } from './lib/errors.js'
import { exportSanitizedProviders, importThirdPartyConfig, IMPORT_FORMATS } from './lib/importer.js'
import {
  COMPAT_FIELDS_BY_API,
  MODALITIES,
  SUPPORTED_PROTOCOLS,
  THINKING_LEVELS,
  getPreset,
  listPresets,
  validateModelProfile,
  validateProviderProfile,
} from './lib/presets.js'
import { PROBE_CHECKS, probeEndpoint } from './lib/prober.js'
import {
  DEFAULT_MODELS_DEV_URL,
  DEFAULT_OPEN_ROUTER_URL,
  RegistryCacheManager,
} from './lib/registry-cache.js'
import { deriveCredentialRef, validateCredentialRef, validateCustomProviderId } from './lib/reserved.js'
import {
  DEFAULT_REGISTRY_TTL_MS,
  DEFAULT_SYNC_COOLDOWN_MS,
  PLUGIN_SCHEMA_VERSION,
  SYNC_MODES,
  createDefaultSyncPolicy,
  createPluginStores,
} from './lib/storage.js'

export { ApiManagerError }

/** Cordis service key of the provider manager. */
export const SERVICE_KEY = 'xiaoxingApiManager'
/** Remote namespace exposed to the Web client. */
export const REMOTE_NAMESPACE = 'xiaoxingApiManager'
/** Prototype property carrying the Remote method markers. */
export const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
/** Remote methods in declaration order. */
export const REMOTE_METHODS = Object.freeze([
  'status',
  'presets',
  'listCustomProviders',
  'discover',
  'enrich',
  'audit',
  'probe',
  'upsertProvider',
  'removeProvider',
  'syncProviderModels',
  'syncAllCustomProviders',
  'setSyncPolicy',
  'setDefaults',
  'saveOverride',
  'resetOverride',
  'getRegistryStatus',
  'refreshRegistry',
  'importConfig',
  'exportConfig',
])

/** Default per-request network timeout. */
const DEFAULT_TIMEOUT_MS = 15_000
/** Default interval between background maintenance runs; `0` disables them. */
const DEFAULT_AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Default delay before the first background maintenance run after startup. */
const DEFAULT_AUTO_SYNC_INITIAL_DELAY_MS = 60_000
/** Largest delay a Node timer accepts without overflowing to an immediate fire. */
const MAX_TIMER_DELAY_MS = 2_147_483_647
/** Registry cache file inside the plugin data directory. */
const REGISTRY_CACHE_FILE = 'registry-cache.json'
/** Maximum providers one `syncAllCustomProviders` call processes concurrently. */
const MAX_SYNC_CONCURRENCY = 3
/** Gateway preset offered for each protocol during enrichment. */
const PRESET_ID_BY_API = Object.freeze({
  'openai-completions': 'custom-relay-openai',
  'openai-responses': 'custom-openai-responses',
  'anthropic-messages': 'custom-anthropic',
  'google-generative-ai': 'custom-gemini',
})
/** Fields enrichment resolves and that a model entry may set explicitly. */
const MANAGED_MODEL_FIELDS = Object.freeze(['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat'])
/** Input fields a live discovery entry contributes. */
const DISCOVERY_FIELDS = Object.freeze(['name', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'reasoningDeclared', 'allowOff', 'efforts', 'supportedEndpointTypes', 'nonChat'])
/** Optional profile fields preserved from an existing route on update. */
const PRESERVED_PROFILE_FIELDS = Object.freeze([
  'compat',
  'reasoning',
  'thinkingBudgets',
  'cacheRetention',
  'transport',
  'timeoutMs',
  'websocketConnectTimeoutMs',
  'streamIdleTimeoutMs',
  'maxRequestImageBytes',
  'maxRequestImages',
  'imageOffloadCountQuantum',
  'requestImagePixelBudget',
  'requestImageMaxBytes',
  'retryPolicy',
  'defaultContextWindow',
  'defaultMaxTokens',
  'defaultInput',
  'modelOverrides',
])
/** Sync-policy fields a caller may set. */
const SYNC_POLICY_FIELDS = Object.freeze(['syncMode', 'syncCooldownMs', 'includePatterns', 'excludePatterns', 'ignoredModels', 'includeNonChat', 'syncToSubagentAllowed'])
/** Header names whose values are credentials and must never be echoed. */
const SENSITIVE_HEADER_NAMES = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'proxy-authorization', 'cookie'])
/** Profile keys whose values are credentials and must never be echoed. */
const SENSITIVE_KEY_PATTERN = /api[-_]?key|secret|token|password/iu

/**
 * Whether a value is a plain object rather than an array or class instance.
 * @param {unknown} value - value to inspect.
 * @returns {boolean} whether it is a plain object.
 */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Deep-copy one JSON-shaped value.
 * @param {unknown} value - value to copy.
 * @returns {unknown} the detached copy.
 */
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (!isPlainObject(value)) return value
  const copy = {}
  for (const [key, child] of Object.entries(value)) copy[key] = cloneValue(child)
  return copy
}

/**
 * Normalize any Remote or tool request into a plain object.
 * @param {unknown} request - incoming request.
 * @returns {Record<string, unknown>} the request, or an empty object.
 */
function asRequest(request) {
  return isPlainObject(request) ? request : {}
}

/**
 * Read one optional non-empty trimmed string.
 * @param {unknown} value - candidate value.
 * @returns {string | undefined} the trimmed string, or `undefined`.
 */
function optionalString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Read one required non-empty trimmed string.
 * @param {unknown} value - candidate value.
 * @param {string} field - field name for the diagnostic.
 * @returns {string} the trimmed string.
 * @throws {ApiManagerError} `invalid-request` when the value is not a non-empty string.
 */
function requiredString(value, field) {
  const text = optionalString(value)
  if (text === undefined) throw new ApiManagerError('invalid-request', `${field} must be a non-empty string`)
  return text
}

/**
 * Read one non-negative integer option.
 * @param {unknown} value - candidate value.
 * @param {number} fallback - value used when the option is absent.
 * @param {string} field - field name for the diagnostic.
 * @returns {number} the accepted value.
 * @throws {ApiManagerError} `invalid-config` when the value is not a non-negative integer.
 */
function nonNegativeInteger(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ApiManagerError('invalid-config', `${field} must be a non-negative integer`)
  }
  return value
}

/**
 * Read one positive integer option.
 * @param {unknown} value - candidate value.
 * @param {number} fallback - value used when the option is absent.
 * @param {string} field - field name for the diagnostic.
 * @returns {number} the accepted value.
 * @throws {ApiManagerError} `invalid-config` when the value is not a positive integer.
 */
function positiveInteger(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ApiManagerError('invalid-config', `${field} must be a positive integer`)
  }
  return value
}

/**
 * Render a model profile as a JSON-safe summary for a Remote result.
 * @param {unknown} model - model profile.
 * @returns {object} the summary.
 */
function summarizeModel(model) {
  if (!isPlainObject(model)) return { id: null }
  const summary = { id: typeof model.id === 'string' ? model.id : null }
  for (const field of ['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat']) {
    if (model[field] !== undefined) summary[field] = cloneValue(model[field])
  }
  return summary
}

/**
 * Summarize a model list.
 * @param {unknown} models - model profiles.
 * @returns {object[]} the summaries.
 */
function summarizeModels(models) {
  return (Array.isArray(models) ? models : []).map(summarizeModel)
}

/**
 * Whether a header value or profile value looks like credential material.
 * @param {string} value - candidate value.
 * @returns {boolean} whether it must not be echoed.
 */
function looksLikeSecret(value) {
  return /^Bearer\s/iu.test(value) || /^sk-[A-Za-z0-9_-]{8,}$/u.test(value) || /^[A-Za-z0-9_-]{32,}$/u.test(value)
}

/**
 * Filter a headers object down to non-sensitive, non-secret string headers.
 * @param {unknown} rawHeaders - configured headers map.
 * @returns {Record<string, string> | undefined} sanitized headers, or undefined when empty.
 */
function sanitizeHeadersForOutput(rawHeaders) {
  if (!isPlainObject(rawHeaders)) return undefined
  const headers = {}
  for (const [name, headerValue] of Object.entries(rawHeaders)) {
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) continue
    if (typeof headerValue !== 'string' || looksLikeSecret(headerValue)) continue
    headers[name] = headerValue
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

/**
 * Build a profile safe to return through a Remote or tool result.
 * @param {unknown} profile - configured provider profile.
 * @returns {object} the sanitized profile.
 */
function sanitizeProfileForOutput(profile) {
  const sanitized = isPlainObject(profile) ? cloneValue(profile) : {}
  for (const [key, value] of Object.entries(sanitized)) {
    if (key === 'apiKeyEnv') continue
    if (SENSITIVE_KEY_PATTERN.test(key)) delete sanitized[key]
    else if (key === 'headers') {
      const headers = sanitizeHeadersForOutput(value)
      if (headers !== undefined) sanitized.headers = headers
      else delete sanitized.headers
    }
  }
  return sanitized
}

/**
 * Build the resulting model list for one sync run (`add-new` or `mirror`).
 * @param {{ existingModels: object[], existingIds: Set<string>, enriched: Array<{ profile: object }>, mode: string }} input
 * @returns {object[]} the merged model list.
 */
function buildSyncedModelList({ existingModels, existingIds, enriched, mode }) {
  if (mode === 'add-new') {
    return [
      ...existingModels.map(model => cloneValue(model)),
      ...enriched.filter(result => !existingIds.has(result.profile.id)).map(result => result.profile),
    ]
  }
  const enrichedById = new Map(enriched.map(result => [result.profile.id, result.profile]))
  const nextModels = []
  for (const model of existingModels) {
    const matched = enrichedById.get(model.id)
    if (matched !== undefined) nextModels.push(matched)
  }
  for (const result of enriched) {
    if (!existingIds.has(result.profile.id)) nextModels.push(result.profile)
  }
  return nextModels
}

/**
 * Build the non-secret public view of one model entry.
 * @param {unknown} entry - requested model entry.
 * @returns {Record<string, unknown>} a detached entry with an `id`.
 * @throws {ApiManagerError} `invalid-request` when the entry is unusable.
 */
function normalizeModelEntries(entryList) {
  if (entryList === undefined || entryList === null) return []
  if (!Array.isArray(entryList)) {
    throw new ApiManagerError('invalid-request', 'models must be an array of model entries')
  }
  return entryList.map(entry => {
    if (typeof entry === 'string') {
      const id = optionalString(entry)
      if (id === undefined) throw new ApiManagerError('invalid-request', 'model ids must be non-empty strings')
      return { id }
    }
    if (!isPlainObject(entry)) {
      throw new ApiManagerError('invalid-request', 'every model entry must be an object or an id string')
    }
    const id = optionalString(entry.id)
    if (id === undefined) throw new ApiManagerError('invalid-request', 'every model entry needs a non-empty id')
    return { ...cloneValue(entry), id }
  })
}

/**
 * Pick the managed fields a caller set explicitly on a model entry.
 * @param {Record<string, unknown>} entry - requested model entry.
 * @returns {Record<string, unknown>} sparse manual override claims.
 */
function explicitManagedFields(entry) {
  const claims = {}
  const editorFields = isPlainObject(entry.manualFields) ? entry.manualFields : null
  for (const field of [...MANAGED_MODEL_FIELDS, 'allowOff']) {
    if (Object.hasOwn(entry, field) && (editorFields === null || editorFields[field] === true)) {
      claims[field] = cloneValue(entry[field])
    }
  }
  return claims
}

/**
 * Read the live-discovery fields a model entry carries, when it looks like a discovery result.
 * @param {Record<string, unknown>} entry - requested model entry.
 * @returns {Record<string, unknown> | undefined} the discovery claims, or `undefined`.
 */
function discoveryFieldsOf(entry) {
  if (isPlainObject(entry.discovered)) return entry.discovered
  if (isPlainObject(entry.manualFields)) return undefined
  if (!DISCOVERY_FIELDS.some(field => Object.hasOwn(entry, field))) return undefined
  return entry
}

/**
 * Gateway preset id used for one protocol.
 * @param {unknown} api - wire protocol.
 * @returns {string | undefined} the preset id, or `undefined` for an unknown protocol.
 */
function presetIdForApi(api) {
  return typeof api === 'string' && Object.hasOwn(PRESET_ID_BY_API, api) ? PRESET_ID_BY_API[api] : undefined
}

/**
 * Whether one model id matches a sync filter pattern.
 *
 * A `/body/flags` pattern is a regular expression; a pattern containing `*` or
 * `?` is a case-insensitive glob matched against the whole id; anything else is
 * a case-insensitive substring match.
 * @param {string} id - model id.
 * @param {unknown} pattern - configured pattern.
 * @returns {boolean} whether the id matches.
 */
function modelMatchesPattern(id, pattern) {
  if (typeof pattern !== 'string') return false
  const text = pattern.trim()
  if (text.length === 0) return false
  if (text.length >= 3 && text.startsWith('/') && text.lastIndexOf('/') > 0) {
    const separator = text.lastIndexOf('/')
    try {
      return new RegExp(text.slice(1, separator), text.slice(separator + 1)).test(id)
    } catch {
      return id.toLowerCase().includes(text.toLowerCase())
    }
  }
  if (text.includes('*') || text.includes('?')) {
    const escaped = text.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*').replace(/\?/gu, '.')
    try {
      return new RegExp(`^${escaped}$`, 'iu').test(id)
    } catch {
      return false
    }
  }
  return id.toLowerCase().includes(text.toLowerCase())
}

/**
 * Filter a discovered model list with one sync policy.
 * @param {object[]} models - discovered models.
 * @param {object} policy - normalized sync policy.
 * @returns {object[]} the models kept by the policy.
 */
function filterDiscoveredModels(models, policy) {
  const include = Array.isArray(policy.includePatterns) ? policy.includePatterns : []
  const exclude = Array.isArray(policy.excludePatterns) ? policy.excludePatterns : []
  // Exact ids the route's owner left out; unlike a pattern they never match a
  // neighbouring id, so dropping `gpt-5` keeps `gpt-5-codex` syncing.
  const ignored = new Set(Array.isArray(policy.ignoredModels) ? policy.ignoredModels : [])
  return models.filter(model => {
    if (typeof model?.id !== 'string' || model.id.length === 0) return false
    if (ignored.has(model.id)) return false
    if (include.length > 0 && !include.some(pattern => modelMatchesPattern(model.id, pattern))) return false
    if (exclude.some(pattern => modelMatchesPattern(model.id, pattern))) return false
    return true
  })
}

/**
 * Merge sparse manual override claims, with later claims replacing earlier ones.
 * @param {unknown} existing - stored L1 override delta.
 * @param {Record<string, unknown>} explicit - claims from the current request.
 * @returns {Record<string, unknown>} the merged manual override.
 */
function mergeManualOverride(existing, explicit) {
  const merged = { ...(isPlainObject(existing) ? existing : {}), ...explicit }
  return merged
}

/**
 * Validate one stored L1 override delta before it is persisted.
 *
 * A `null` value is an explicit reset and survives. Every other value must be
 * valid for the field so a broken override never reaches a saved profile.
 * @param {unknown} override - requested override delta.
 * @returns {Record<string, unknown>} the validated delta.
 * @throws {ApiManagerError} `invalid-override` for an unknown field or invalid value.
 */
function validateOverrideDelta(override) {
  if (!isPlainObject(override)) throw new ApiManagerError('invalid-override', 'override must be an object')
  const delta = {}
  for (const [field, value] of Object.entries(override)) {
    if (!MANAGED_MODEL_FIELDS.includes(field) && field !== 'allowOff' && field !== 'upstreamModel') {
      throw new ApiManagerError(
        'invalid-override',
        `override field "${field}" is not supported; the fields are ${[...MANAGED_MODEL_FIELDS, 'allowOff', 'upstreamModel'].join(', ')}`,
        { field },
      )
    }
    if (value === null) {
      delta[field] = null
      continue
    }
    switch (field) {
      case 'name':
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new ApiManagerError('invalid-override', 'override "name" must be a non-empty string or null', { field })
        }
        delta[field] = value.trim()
        break
      case 'upstreamModel':
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new ApiManagerError('invalid-override', 'override "upstreamModel" must be a non-empty string or null', { field })
        }
        delta[field] = value.trim()
        break
      case 'contextWindow':
      case 'maxTokens':
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          throw new ApiManagerError('invalid-override', `override "${field}" must be a positive integer or null`, { field })
        }
        delta[field] = value
        break
      case 'input': {
        if (!Array.isArray(value) || value.length === 0) {
          throw new ApiManagerError('invalid-override', 'override "input" must be a non-empty modality array or null', { field })
        }
        const input = []
        for (const modality of value) {
          if (!MODALITIES.includes(modality)) {
            throw new ApiManagerError('invalid-override', `override "input" contains ${JSON.stringify(modality)}; expected ${MODALITIES.join(', ')}`, { field })
          }
          if (!input.includes(modality)) input.push(modality)
        }
        delta[field] = input
        break
      }
      case 'reasoningEfforts':
        if (value !== false && !isPlainObject(value) && !(Array.isArray(value) && value.every(level => typeof level === 'string'))) {
          throw new ApiManagerError('invalid-override', 'override "reasoningEfforts" must be false, an object, a level array, or null', { field })
        }
        delta[field] = cloneValue(value)
        break
      case 'compat':
        if (!isPlainObject(value) || Object.keys(value).length === 0) {
          throw new ApiManagerError('invalid-override', 'override "compat" must be a non-empty object or null', { field })
        }
        delta[field] = cloneValue(value)
        break
      case 'allowOff':
        if (typeof value !== 'boolean') {
          throw new ApiManagerError('invalid-override', 'override "allowOff" must be a boolean or null', { field })
        }
        delta[field] = value
        break
      /* v8 ignore next 2 -- the field set is exhausted by MANAGED_MODEL_FIELDS plus allowOff */
      default:
        break
    }
  }
  if (Object.keys(delta).length === 0) {
    throw new ApiManagerError('invalid-override', 'override must set at least one field')
  }
  return delta
}

/**
 * Validate one sync-policy patch.
 * @param {unknown} input - requested policy fields.
 * @returns {Record<string, unknown>} the validated patch.
 * @throws {ApiManagerError} `invalid-sync-policy` for an unknown field or invalid value.
 */
function validateSyncPolicyInput(input) {
  if (!isPlainObject(input)) throw new ApiManagerError('invalid-sync-policy', 'syncPolicy must be an object')
  const policy = {}
  for (const [field, value] of Object.entries(input)) {
    if (!SYNC_POLICY_FIELDS.includes(field)) {
      throw new ApiManagerError(
        'invalid-sync-policy',
        `sync policy field "${field}" is not supported; the fields are ${SYNC_POLICY_FIELDS.join(', ')}`,
        { field },
      )
    }
    if (field === 'syncMode') {
      if (!SYNC_MODES.includes(value)) {
        throw new ApiManagerError('invalid-sync-policy', `syncMode must be one of ${SYNC_MODES.join(', ')}`, { field })
      }
      policy[field] = value
      continue
    }
    if (field === 'syncCooldownMs') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new ApiManagerError('invalid-sync-policy', 'syncCooldownMs must be a non-negative integer', { field })
      }
      policy[field] = value
      continue
    }
    if (field === 'includePatterns' || field === 'excludePatterns' || field === 'ignoredModels') {
      if (!Array.isArray(value) || value.some(pattern => typeof pattern !== 'string' || pattern.trim().length === 0)) {
        throw new ApiManagerError('invalid-sync-policy', `${field} must be an array of non-empty strings`, { field })
      }
      policy[field] = [...new Set(value.map(pattern => pattern.trim()))]
      continue
    }
    if (typeof value !== 'boolean') {
      throw new ApiManagerError('invalid-sync-policy', `${field} must be a boolean`, { field })
    }
    policy[field] = value
  }
  if (Object.keys(policy).length === 0) {
    throw new ApiManagerError('invalid-sync-policy', 'syncPolicy must set at least one field')
  }
  return policy
}

/**
 * Clamp a requested concurrency to the supported range.
 * @param {unknown} value - requested concurrency.
 * @returns {number} a concurrency between one and {@link MAX_SYNC_CONCURRENCY}.
 */
function clampConcurrency(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MAX_SYNC_CONCURRENCY
  return Math.min(Math.max(Math.trunc(value), 1), MAX_SYNC_CONCURRENCY)
}

/**
 * Host service behind the `xiaoxingApiManager` Remote namespace and the
 * `xiaoxing_api_manager` tool.
 *
 * Every business failure is returned as `{ ok: false, code, message, details? }`;
 * methods never throw for an expected failure. Mutating methods serialize
 * through one queue and profile writes additionally serialize per pi-ai
 * namespace, so concurrent syncs cannot race the configuration.
 */
export class ApiManagerService {
  /**
   * @param {object} options - service configuration.
   * @param {string} options.dataDir - plugin data directory for state files.
   * @param {object} [options.deps] - lazily resolved Host service accessors.
   * @param {Function} [options.fetchImpl] - fetch implementation (tests inject a double).
   * @param {() => number} [options.now] - injectable clock.
   * @param {number} [options.timeoutMs] - per-request network timeout.
   * @param {number} [options.syncCooldownMs] - default sync cooldown.
   */
  constructor(options = {}) {
    const dataDir = requiredString(options.dataDir, 'dataDir')
    this.dataDir = resolve(dataDir)
    this.deps = isPlainObject(options.deps) ? options.deps : {}
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
    this.syncCooldownMs = nonNegativeInteger(options.syncCooldownMs, DEFAULT_SYNC_COOLDOWN_MS, 'syncCooldownMs')
    this.fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.stores = createPluginStores(this.dataDir)
    this.registryCache = null
    this.registrySettings = null
    this.readyPromise = null
    this.queue = Promise.resolve()
    this.piAiTail = Promise.resolve()
    this.singleflight = new Map()
    this.controllers = new Set()
    this.closed = false
    this.warnings = []
    this.secretValues = []
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: SERVICE_KEY,
      namespace: REMOTE_NAMESPACE,
    })
  }

  /**
   * Load the registry cache and prepare the data directory.
   * @returns {Promise<this>} this service.
   */
  async initialize() {
    await this._ensureReady()
    return this
  }

  /**
   * Stop in-flight work and refuse further operations.
   * @returns {void}
   */
  dispose() {
    this.closed = true
    for (const controller of this.controllers) {
      try {
        controller.abort()
      } catch {
        // An already-aborted or detached controller needs no cleanup.
      }
    }
    this.controllers.clear()
    this.singleflight.clear()
  }

  /* --------------------------------------------------------------------- */
  /* Remote methods                                                        */
  /* --------------------------------------------------------------------- */

  /**
   * Report configuration availability, default selections, and registry state.
   * @param {unknown} [request] - unused request.
   * @returns {Promise<object>} the manager status envelope.
   */
  async status(request) {
    void request
    return this._guard('status', async () => {
      const snapshot = readPiAiSnapshot(this.deps)
      const { customProviders, reservedProviders } = classifyProviders(snapshot)
      const defaultSelection = readDefaultSelection(this.deps)
      const subagentSelection = readSubagentSelection(this.deps)
      try {
        await this._ensureReady()
      } catch (error) {
        this._warn(`registry cache could not be initialized: ${this._redact(messageOf(error))}`)
      }
      const registry = this.registryCache === null ? null : this._registryStatus()
      return {
        ok: true,
        available: snapshot.available,
        namespace: snapshot.ns,
        revision: snapshot.revision,
        error: snapshot.error === undefined ? null : this._redact(snapshot.error),
        customProviders: customProviders.map(entry => entry.provider),
        reservedProviders,
        customProviderCount: customProviders.length,
        reservedProviderCount: reservedProviders.length,
        defaultSelection,
        subagentSelection,
        registry,
        credentialsAvailable: this.deps.getCredentials?.() !== undefined && this.deps.getCredentials?.() !== null,
        warnings: [...this.warnings],
      }
    })
  }

  /**
   * List the gateway presets and protocol vocabulary the settings page offers.
   * @param {unknown} [request] - unused request.
   * @returns {Promise<object>} the preset catalog envelope.
   */
  async presets(request) {
    void request
    return this._guard('presets', async () => {
      let customPresets = []
      try {
        const state = await this.stores.customPresets.read()
        if (isPlainObject(state) && Array.isArray(state.presets)) customPresets = state.presets
      } catch (error) {
        this._warn(`custom presets could not be read: ${this._redact(messageOf(error))}`)
      }
      return {
        ok: true,
        presets: [...listPresets(), ...customPresets],
        customPresets,
        protocols: [...SUPPORTED_PROTOCOLS],
        thinkingLevels: [...THINKING_LEVELS],
        compatFields: COMPAT_FIELDS_BY_API,
        probeChecks: [...PROBE_CHECKS],
      }
    })
  }

  /**
   * List every custom provider with its models, credential facts, sync policy,
   * and audit summary.
   * @param {unknown} [request] - unused request.
   * @returns {Promise<object>} the custom-provider list envelope.
   */
  async listCustomProviders(request) {
    void request
    return this._guard('listCustomProviders', async () => {
      await this._ensureReady()
      const snapshot = readPiAiSnapshot(this.deps)
      const { customProviders, reservedProviders } = classifyProviders(snapshot)
      const policies = await this._readSyncState()
      const overrides = await this._readOverrides()
      const providers = []
      for (const { provider, profile } of customProviders) {
        let audit
        const unmatchedModels = []
        const modelMatchInfo = new Map()
        const upstreamBindings = {}
        const providerOverrides = isPlainObject(overrides[provider]?.models) ? overrides[provider].models : {}
        try {
          const result = auditProvider({
            providerId: provider,
            profile,
            registryCache: this.registryCache,
            overrides: isPlainObject(overrides[provider]) ? overrides[provider] : undefined,
          })
          for (const suggestion of result.suggestions) {
            const modelId = suggestion?.profile?.id
            const meta = suggestion?.meta
            if (typeof modelId !== 'string' || !isPlainObject(meta)) continue
            const ambiguousModelIds = Array.isArray(meta.ambiguousModelIds) ? meta.ambiguousModelIds : []
            const matchedSource = ambiguousModelIds.length > 0
              ? null
              : meta.matchedRegistryId !== null
                ? 'registry'
                : meta.matchedCatalogId !== null
                  ? 'catalog'
                  : null
            modelMatchInfo.set(modelId, meta)
            // Keep rule-only and ambiguous models available for upstream binding.
            if (matchedSource === null) unmatchedModels.push(modelId)
            const boundUpstream = typeof meta.upstreamModel === 'string' && meta.upstreamModel.length > 0
              ? meta.upstreamModel
              : (typeof providerOverrides[modelId]?.upstreamModel === 'string' && providerOverrides[modelId].upstreamModel.trim().length > 0
                ? providerOverrides[modelId].upstreamModel.trim()
                : null)
            if (boundUpstream !== null) {
              upstreamBindings[modelId] = {
                upstreamModel: boundUpstream,
                matched: matchedSource !== null,
                matchedSource,
              }
            }
          }
          audit = {
            modelCount: result.modelCount,
            issueCount: result.issueCount,
            missingFieldCount: result.summary.missingFieldCount,
            summary: result.summary.message,
            issues: result.issues.slice(0, 20),
          }
        } catch (error) {
          audit = { error: this._redact(messageOf(error)) }
        }
        const credential = typeof profile.apiKeyEnv === 'string'
          ? await describeCredential(this.deps, profile.apiKeyEnv).catch(error => ({
              available: false,
              configured: false,
              writable: false,
              source: null,
              masked: null,
              error: this._redact(messageOf(error)),
            }))
          : null
        const headers = sanitizeHeadersForOutput(profile.headers)
        providers.push({
          provider,
          displayName: optionalString(profile.displayName) ?? optionalString(profile.name) ?? provider,
          api: optionalString(profile.api) ?? null,
          baseURL: optionalString(profile.baseURL) ?? null,
          apiKeyEnv: optionalString(profile.apiKeyEnv) ?? null,
          ...(isPlainObject(profile.compat) ? { compat: cloneValue(profile.compat) } : {}),
          ...(headers !== undefined ? { headers } : {}),
          modelCount: Array.isArray(profile.models) ? profile.models.length : 0,
          models: summarizeModels(profile.models).map(model => ({
            ...model,
            match: modelMatchInfo.get(model.id) ?? null,
          })),
          unmatchedModels,
          upstreamBindings,
          credential,
          syncPolicy: this._publicPolicy(this._normalizePolicy(isPlainObject(policies[provider]) ? policies[provider] : {})),
          audit,
        })
      }
      return {
        ok: true,
        available: snapshot.available,
        error: snapshot.error === undefined ? null : this._redact(snapshot.error),
        providers,
        reservedProviders,
        customProviderCount: providers.length,
        reservedProviderCount: reservedProviders.length,
      }
    })
  }

  /**
   * Discover the model list one endpoint publishes.
   * @param {object} [request] - discovery request.
   * @param {string} [request.provider] - configured provider whose profile supplies defaults.
   * @param {string} [request.baseURL] - endpoint root, required without `provider`.
   * @param {string} [request.api] - wire protocol.
   * @param {string} [request.apiKey] - write-only credential for this request.
   * @param {string} [request.apiKeyEnv] - credential reference resolved instead.
   * @param {object} [request.headers] - extra request headers.
   * @param {boolean} [request.includeNonChat] - keep non-chat models.
   * @returns {Promise<object>} the discovery envelope; the key is never echoed.
   */
  async discover(request) {
    return this._guard('discover', async () => {
      const req = asRequest(request)
      const snapshot = readPiAiSnapshot(this.deps)
      const providerId = optionalString(req.provider)
      let profile = {}
      if (providerId !== undefined) {
        validateCustomProviderId(providerId, snapshot.configurableProviders)
        profile = isPlainObject(snapshot.providers[providerId]) ? snapshot.providers[providerId] : {}
        if (Object.keys(profile).length === 0) {
          throw new ApiManagerError('provider-not-found', `provider "${providerId}" is not configured`, { provider: providerId })
        }
      }
      const baseURL = optionalString(req.baseURL) ?? optionalString(profile.baseURL)
      if (baseURL === undefined) {
        throw new ApiManagerError('invalid-request', 'discover needs a baseURL or a configured provider')
      }
      const api = optionalString(req.api) ?? optionalString(profile.api) ?? 'openai-completions'
      const headers = isPlainObject(req.headers) ? req.headers : profile.headers
      const apiKeyEnv = optionalString(req.apiKeyEnv) ?? optionalString(profile.apiKeyEnv)
      let apiKey = optionalString(req.apiKey)
      if (apiKey !== undefined) this._rememberSecret(apiKey)
      else if (apiKeyEnv !== undefined) {
        const resolved = await resolveCredential(this.deps, apiKeyEnv)
        if (resolved !== undefined) {
          apiKey = resolved.value
          this._rememberSecret(apiKey)
        }
      }
      const result = await this._withSignal(req.signal, signal => discoverEndpointModels({
        baseURL,
        api,
        apiKey,
        headers: isPlainObject(headers) ? headers : undefined,
        signal,
        timeoutMs: this.timeoutMs,
        includeNonChat: req.includeNonChat === true,
        fetchImpl: this.fetchImpl,
      }))
      return {
        ok: true,
        provider: providerId ?? null,
        url: result.url,
        api: result.api,
        latencyMs: result.latencyMs,
        rawCount: result.rawCount,
        nonChatSkipped: result.nonChatSkipped,
        models: result.models,
        ...(result.suggestedBaseURL === undefined ? {} : { suggestedBaseURL: result.suggestedBaseURL }),
      }
    })
  }

  /**
   * Preview the enriched profile of one or more models without writing config.
   * @param {object} [request] - enrichment request.
   * @param {string} [request.provider] - configured provider supplying api, preset, and compat defaults.
   * @param {unknown[]} [request.models] - model entries to enrich.
   * @param {string} [request.modelId] - single model id alternative.
   * @param {string} [request.api] - wire protocol.
   * @param {string} [request.presetId] - gateway preset id.
   * @returns {Promise<object>} the enrichment envelope.
   */
  async enrich(request) {
    return this._guard('enrich', async () => {
      await this._ensureReady()
      const req = asRequest(request)
      await this._warmRegistryIfEmpty(req.signal)
      const snapshot = readPiAiSnapshot(this.deps)
      const providerId = optionalString(req.provider)
      let profile = {}
      if (providerId !== undefined) {
        validateCustomProviderId(providerId, snapshot.configurableProviders)
        profile = isPlainObject(snapshot.providers[providerId]) ? snapshot.providers[providerId] : {}
        if (Object.keys(profile).length === 0) {
          throw new ApiManagerError('provider-not-found', `provider "${providerId}" is not configured`, { provider: providerId })
        }
      }
      const api = optionalString(req.api) ?? optionalString(profile.api) ?? 'openai-completions'
      if (!SUPPORTED_PROTOCOLS.includes(api)) {
        throw new ApiManagerError('invalid-api', `api must be one of ${SUPPORTED_PROTOCOLS.join(', ')}; got ${JSON.stringify(api)}`, { api })
      }
      const presetId = optionalString(req.presetId) ?? presetIdForApi(api)
      const overrides = providerId === undefined ? {} : await this._readProviderOverrideModels(providerId)
      let entries = normalizeModelEntries(req.models)
      if (entries.length === 0 && req.modelId !== undefined) {
        entries = [{ id: requiredString(req.modelId, 'modelId') }]
      }
      if (entries.length === 0 && Array.isArray(profile.models)) {
        entries = profile.models.map(model => ({ id: model.id }))
      }
      if (entries.length === 0) {
        throw new ApiManagerError('invalid-request', 'enrich needs models, a modelId, or a configured provider with models')
      }
      const configuredById = new Map(
        (Array.isArray(profile.models) ? profile.models : []).map(model => [model.id, model]),
      )
      const routeCompat = isPlainObject(profile.compat) ? profile.compat : undefined
      const ignoreConfigured = req.refresh === true
      const models = entries.map(entry => {
        const result = enrichModel({
          id: entry.id,
          discovered: discoveryFieldsOf(entry),
          configured: ignoreConfigured ? undefined : configuredById.get(entry.id),
          manualOverride: mergeManualOverride(overrides[entry.id], explicitManagedFields(entry)),
          api,
          presetId,
          routeCompat,
          registryCache: this.registryCache,
        })
        return {
          id: entry.id,
          profile: result.profile,
          provenance: result.provenance,
          warnings: result.warnings,
          meta: result.meta,
        }
      })
      return { ok: true, provider: providerId ?? null, api, presetId, models }
    })
  }

  /**
   * Audit one configured custom route and return its suggested model list.
   * @param {object} [request] - audit request.
   * @param {string} [request.provider] - custom provider id, required.
   * @returns {Promise<object>} the audit envelope.
   */
  async audit(request) {
    return this._guard('audit', async () => {
      await this._ensureReady()
      const req = asRequest(request)
      const snapshot = readPiAiSnapshot(this.deps)
      const providerId = requiredString(req.provider, 'provider')
      validateCustomProviderId(providerId, snapshot.configurableProviders)
      const profile = snapshot.providers[providerId]
      if (!isPlainObject(profile)) {
        throw new ApiManagerError('provider-not-found', `provider "${providerId}" is not configured`, { provider: providerId })
      }
      const overrides = await this._readProviderOverrideModels(providerId)
      const result = auditProvider({
        providerId,
        profile,
        registryCache: this.registryCache,
        overrides: { models: overrides },
      })
      return { ok: true, ...result }
    })
  }

  /**
   * Probe one endpoint over the network for wire-compatibility facts.
   * @param {object} [request] - probe request.
   * @param {string} [request.provider] - configured provider supplying defaults.
   * @param {string} [request.baseURL] - endpoint root.
   * @param {string} [request.api] - wire protocol.
   * @param {string} [request.apiKey] - write-only credential for this request.
   * @param {string} [request.apiKeyEnv] - credential reference resolved instead.
   * @param {object} [request.headers] - extra request headers.
   * @param {string} [request.modelId] - model exercised by model-dependent checks.
   * @param {string[]} [request.checks] - checks to run.
   * @returns {Promise<object>} the probe envelope; `healthy` is the endpoint verdict.
   */
  async probe(request) {
    return this._guard('probe', async () => {
      const req = asRequest(request)
      const snapshot = readPiAiSnapshot(this.deps)
      const providerId = optionalString(req.provider)
      let profile = {}
      if (providerId !== undefined) {
        validateCustomProviderId(providerId, snapshot.configurableProviders)
        profile = isPlainObject(snapshot.providers[providerId]) ? snapshot.providers[providerId] : {}
        if (Object.keys(profile).length === 0) {
          throw new ApiManagerError('provider-not-found', `provider "${providerId}" is not configured`, { provider: providerId })
        }
      }
      const baseURL = optionalString(req.baseURL) ?? optionalString(profile.baseURL)
      if (baseURL === undefined) {
        throw new ApiManagerError('invalid-request', 'probe needs a baseURL or a configured provider')
      }
      const api = optionalString(req.api) ?? optionalString(profile.api) ?? 'openai-completions'
      const headers = isPlainObject(req.headers) ? req.headers : profile.headers
      const apiKeyEnv = optionalString(req.apiKeyEnv) ?? optionalString(profile.apiKeyEnv)
      let apiKey = optionalString(req.apiKey)
      if (apiKey !== undefined) this._rememberSecret(apiKey)
      else if (apiKeyEnv !== undefined) {
        const resolved = await resolveCredential(this.deps, apiKeyEnv)
        if (resolved !== undefined) {
          apiKey = resolved.value
          this._rememberSecret(apiKey)
        }
      }
      const modelId = optionalString(req.modelId)
        ?? (Array.isArray(profile.models) && typeof profile.models[0]?.id === 'string' ? profile.models[0].id : undefined)
      let checks
      if (req.checks !== undefined) {
        if (!Array.isArray(req.checks)) throw new ApiManagerError('invalid-request', 'checks must be an array')
        for (const check of req.checks) {
          if (!PROBE_CHECKS.includes(check)) {
            throw new ApiManagerError('invalid-request', `unknown probe check ${JSON.stringify(check)}; the checks are ${PROBE_CHECKS.join(', ')}`)
          }
        }
        checks = [...req.checks]
      }
      const report = await this._withSignal(req.signal, signal => probeEndpoint({
        baseURL,
        api,
        apiKey,
        headers: isPlainObject(headers) ? headers : undefined,
        modelId,
        checks,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        signal,
      }))
      return {
        ok: true,
        healthy: report.ok,
        provider: providerId ?? null,
        api: report.api,
        baseURL: report.baseURL,
        modelId: report.modelId,
        checks: report.checks,
        recommendedCompat: report.recommendedCompat,
        warnings: report.warnings,
        checkedAt: report.checkedAt,
        durationMs: report.durationMs,
      }
    })
  }

  /**
   * Create or update one custom pi-ai provider, optionally splitting a
   * mixed-protocol relay into one route per protocol.
   *
   * The request may carry a write-only `apiKey`, which is stored in the
   * credential seam and replaced by an `apiKeyEnv` reference in the profile.
   * @param {object} [request] - provider write request.
   * @returns {Promise<object>} the provider write envelope; no secret is returned.
   */
  async upsertProvider(request) {
    return this._guard('upsertProvider', () => this._serialize(() => this._upsertProvider(asRequest(request))))
  }

  /**
   * Remove one custom provider and the manager state that references it.
   * @param {object} [request] - removal request.
   * @param {string} [request.provider] - custom provider id.
   * @param {boolean} [request.removeCredential] - also delete the stored key.
   * @returns {Promise<object>} the removal envelope.
   */
  async removeProvider(request) {
    return this._guard('removeProvider', () => this._serialize(() => this._removeProvider(asRequest(request))))
  }

  /**
   * Synchronize one provider's model list from its live endpoint.
   *
   * Concurrent calls for the same provider share one execution. Without
   * `force`, a sync inside the provider's cooldown returns the cached list.
   * A discovery failure or an empty listing never removes configured models.
   * @param {object} [request] - sync request.
   * @param {string} [request.provider] - custom provider id.
   * @param {boolean} [request.force] - bypass the cooldown.
   * @param {'manual' | 'add-new' | 'mirror'} [request.mode] - override the stored sync mode.
   * @param {boolean} [request.autoApply] - apply a result instead of previewing it; defaults to true.
   * @param {AbortSignal} [request.signal] - internal cancellation signal.
   * @returns {Promise<object>} the sync envelope.
   */
  async syncProviderModels(request) {
    const providerId = optionalString(asRequest(request).provider)
    if (providerId !== undefined) {
      const inFlight = this.singleflight.get(providerId)
      if (inFlight !== undefined) return inFlight
    }
    const task = this._guard('syncProviderModels', () => this._serialize(
      () => this._syncProviderModelsOrdered(asRequest(request)),
    ))
    if (providerId !== undefined) {
      this.singleflight.set(providerId, task)
      task.then(
        () => {
          if (this.singleflight.get(providerId) === task) this.singleflight.delete(providerId)
        },
        () => {
          if (this.singleflight.get(providerId) === task) this.singleflight.delete(providerId)
        },
      )
    }
    return task
  }

  /**
   * Synchronize every custom provider with bounded concurrency.
   * @param {object} [request] - batch sync request.
   * @param {boolean} [request.force] - bypass each provider's cooldown.
   * @param {boolean} [request.onlyAutoEnabled] - skip providers whose mode is `manual`.
   * @param {boolean} [request.autoApply] - apply results instead of previewing them.
   * @param {number} [request.concurrency] - bounded worker count (at most three).
   * @returns {Promise<object>} the batch envelope.
   */
  async syncAllCustomProviders(request) {
    return this._guard('syncAllCustomProviders', () => this._serialize(
      () => this._syncAllCustomProviders(asRequest(request)),
    ))
  }

  /**
   * Keep model metadata and model lists current without anyone asking.
   *
   * The registry cache is refreshed only when it is past its TTL and never in
   * offline mode; routes whose owner turned automatic sync off are skipped, and
   * each remaining route still honours its own cooldown. Every failure stays
   * inside the returned envelopes: a relay being down must never surface as an
   * error nobody triggered.
   * @returns {Promise<{ ok: boolean, registry: object, sync: object }>} both outcomes.
   */
  async runBackgroundMaintenance() {
    const registry = await this.refreshRegistry({})
    const sync = await this.syncAllCustomProviders({ onlyAutoEnabled: true })
    return {
      ok: registry.ok === true && sync.ok === true,
      registry: registry.ok === true
        ? { ok: true, updated: registry.updated === true, modelCount: registry.modelCount }
        : { ok: false, code: registry.code, message: registry.message },
      sync: sync.ok === true
        ? { ok: true, syncedCount: sync.syncedCount, updatedCount: sync.updatedCount, failureCount: sync.failureCount }
        : { ok: false, code: sync.code, message: sync.message },
    }
  }

  /**
   * Read or update one provider's live-sync policy.
   * @param {object} [request] - policy request.
   * @param {string} [request.provider] - custom provider id.
   * @param {object} [request.policy] - policy fields (`syncMode`, `syncCooldownMs`, patterns, flags).
   * @returns {Promise<object>} the policy envelope.
   */
  async setSyncPolicy(request) {
    return this._guard('setSyncPolicy', () => this._serialize(() => this._setSyncPolicy(asRequest(request))))
  }

  /**
   * Set the agent default model and/or the subagent model-selection policy.
   * @param {object} [request] - defaults request.
   * @param {string} [request.provider] - provider of the default model.
   * @param {string} [request.model] - default model id.
   * @param {string} [request.reasoningEffort] - reasoning effort saved with the default.
   * @param {boolean} [request.enableSubagent] - next subagent selection enabled state.
   * @param {unknown[]} [request.addToSubagent] - routes to authorize for subagents.
   * @param {unknown[]} [request.removeFromSubagent] - routes to remove from the subagent allowlist.
   * @param {unknown[]} [request.subagentAllowedModels] - complete replacement allowlist.
   * @returns {Promise<object>} the defaults envelope.
   */
  async setDefaults(request) {
    return this._guard('setDefaults', () => this._serialize(() => this._setDefaults(asRequest(request))))
  }

  /**
   * Save one sparse L1 model override and re-enrich the live profile.
   * @param {object} [request] - override request.
   * @param {string} [request.provider] - custom provider id.
   * @param {string} [request.model] - model id.
   * @param {object} [request.override] - sparse override delta; `null` resets a field.
   * @param {string[]} [request.reset] - field names to reset instead of setting.
   * @returns {Promise<object>} the override envelope.
   */
  async saveOverride(request) {
    return this._guard('saveOverride', () => this._serialize(() => this._saveOverride(asRequest(request))))
  }

  /**
   * Remove one model's stored override and re-enrich the live profile.
   * @param {object} [request] - reset request.
   * @param {string} [request.provider] - custom provider id.
   * @param {string} [request.model] - model id.
   * @returns {Promise<object>} the reset envelope.
   */
  async resetOverride(request) {
    return this._guard('resetOverride', () => this._serialize(() => this._resetOverride(asRequest(request))))
  }

  /**
   * Report the registry cache state and its configured feeds.
   * @param {unknown} [request] - unused request.
   * @returns {Promise<object>} the registry status envelope.
   */
  async getRegistryStatus(request) {
    return this._guard('getRegistryStatus', async () => {
      await this._ensureReady()
      const req = asRequest(request)
      const includeCatalog = req.includeCatalog === true || typeof req.query === 'string'
      if (includeCatalog) await this._warmRegistryIfEmpty(req.signal)
      const catalogSearch = includeCatalog
        ? searchCatalogModels({
            query: typeof req.query === 'string' ? req.query : '',
            limit: Number.isInteger(req.limit) && req.limit > 0 ? Math.min(req.limit, 100) : 40,
            registryCache: this.registryCache,
          })
        : null
      return {
        ok: true,
        ...this._registryStatus(),
        settings: {
          offlineOnly: this.registrySettings?.offlineOnly === true,
          ttlMs: this.registrySettings?.ttlMs ?? null,
          modelsDevUrl: this.registrySettings?.modelsDevUrl ?? null,
          openRouterUrl: this.registrySettings?.openRouterUrl ?? null,
        },
        ...(catalogSearch === null ? {} : { catalogModels: catalogSearch.models, catalogTotal: catalogSearch.total }),
      }
    })
  }

  /**
   * Refresh the registry cache from its feeds.
   * @param {object} [request] - refresh request.
   * @param {boolean} [request.force] - ignore the cache TTL.
   * @param {boolean} [request.offlineOnly] - skip network access.
   * @param {string} [request.modelsDevUrl] - override the models.dev feed URL.
   * @param {string} [request.openRouterUrl] - override the OpenRouter feed URL.
   * @returns {Promise<object>} the refresh envelope.
   */
  async refreshRegistry(request) {
    return this._guard('refreshRegistry', () => this._serialize(async () => {
      await this._ensureReady()
      const req = asRequest(request)
      const nextSettings = {
        version: PLUGIN_SCHEMA_VERSION,
        offlineOnly: typeof req.offlineOnly === 'boolean' ? req.offlineOnly : this.registrySettings.offlineOnly === true,
        ttlMs: this.registrySettings.ttlMs,
        modelsDevUrl: req.modelsDevUrl === null ? DEFAULT_MODELS_DEV_URL : (optionalString(req.modelsDevUrl) ?? this.registrySettings.modelsDevUrl),
        openRouterUrl: req.openRouterUrl === null ? DEFAULT_OPEN_ROUTER_URL : (optionalString(req.openRouterUrl) ?? this.registrySettings.openRouterUrl),
      }
      if (typeof req.offlineOnly === 'boolean' || req.modelsDevUrl !== undefined || req.openRouterUrl !== undefined) {
        await this.stores.registrySettings.write(nextSettings)
        this.registrySettings = nextSettings
        this.registryCache.offlineOnly = nextSettings.offlineOnly
        this.registryCache.modelsDevUrl = nextSettings.modelsDevUrl
        this.registryCache.openRouterUrl = nextSettings.openRouterUrl
      }
      const result = await this._withSignal(req.signal, signal => this.registryCache.refresh({
        force: req.force === true,
        offlineOnly: nextSettings.offlineOnly,
        modelsDevUrl: nextSettings.modelsDevUrl,
        openRouterUrl: nextSettings.openRouterUrl,
        timeoutMs: this.timeoutMs,
        signal,
      }))
      return {
        ok: true,
        updated: result.updated,
        modelCount: result.modelCount,
        checkedAt: result.checkedAt,
        sourceStatus: result.sourceStatus,
        warnings: result.warnings,
        status: this._registryStatus(),
        settings: { ...nextSettings },
      }
    }))
  }

  /**
   * Import provider definitions from a third-party or DSH configuration.
   *
   * Literal keys carried by the source are moved into the credential seam; the
   * import result never contains a secret.
   * @param {object} [request] - import request.
   * @param {unknown} [request.payload] - config text or parsed payload.
   * @param {string} [request.format] - `auto` or one of {@link IMPORT_FORMATS}.
   * @returns {Promise<object>} the import envelope.
   */
  async importConfig(request) {
    return this._guard('importConfig', () => this._serialize(() => this._importConfig(asRequest(request))))
  }

  /**
   * Export custom provider definitions with every credential removed.
   * @param {object} [request] - export request.
   * @param {string[]} [request.providerIds] - restrict the export to these providers.
   * @param {string} [request.provider] - restrict the export to one provider.
   * @param {boolean} [request.includeSyncPolicy] - attach each provider's sync policy.
   * @returns {Promise<object>} the sanitized export envelope.
   */
  async exportConfig(request) {
    return this._guard('exportConfig', async () => {
      const req = asRequest(request)
      const snapshot = readPiAiSnapshot(this.deps)
      const { customProviders } = classifyProviders(snapshot)
      const policies = await this._readSyncState()
      const providerIds = Array.isArray(req.providerIds)
        ? req.providerIds.filter(id => typeof id === 'string' && id.length > 0)
        : optionalString(req.provider) === undefined ? undefined : [optionalString(req.provider)]
      const providers = {}
      for (const { provider, profile } of customProviders) providers[provider] = profile
      const document = exportSanitizedProviders(providers, {
        providerIds,
        includeSyncPolicy: req.includeSyncPolicy !== false,
        syncPolicies: policies,
      })
      return {
        ok: true,
        ...document,
        count: Object.keys(document.providers).length,
      }
    })
  }

  /* --------------------------------------------------------------------- */
  /* Internals                                                             */
  /* --------------------------------------------------------------------- */

  /** Push one non-fatal diagnostic to the service log. */
  _warn(message) {
    const text = String(message)
    this.warnings.push(text)
    if (this.warnings.length > 64) this.warnings.shift()
    try {
      this.deps.log?.(text)
    } catch {
      // A Host logger that rejects a diagnostic must not fail the operation.
    }
  }

  /** Remember one secret value so every later diagnostic can redact it. */
  _rememberSecret(value) {
    if (typeof value !== 'string' || value.length === 0) return
    if (this.secretValues.includes(value)) return
    this.secretValues.push(value)
    if (this.secretValues.length > 32) this.secretValues.shift()
  }

  /** Mask every known secret in one diagnostic string. */
  _redact(text) {
    return redactSecretText(text, this.secretValues)
  }

  /** Make one JSON-shaped details value safe for a Remote result. */
  _sanitizeDetails(details) {
    if (Array.isArray(details)) return details.map(value => this._sanitizeDetails(value))
    if (!isPlainObject(details)) return typeof details === 'string' ? this._redact(details) : details
    const sanitized = {}
    for (const [key, value] of Object.entries(details)) {
      if (value === undefined) continue
      sanitized[key] = this._sanitizeDetails(value)
    }
    return sanitized
  }

  /**
   * Run one operation and map its outcome to the Remote result envelope.
   * @param {string} name - operation name, for internal diagnostics.
   * @param {() => Promise<object>} run - the operation.
   * @returns {Promise<object>} the success payload or the failure envelope.
   */
  async _guard(name, run) {
    try {
      return await run()
    } catch (error) {
      if (error instanceof ApiManagerError) {
        return {
          ok: false,
          code: error.code,
          message: this._redact(error.message),
          ...(error.details === undefined ? {} : { details: this._sanitizeDetails(error.details) }),
        }
      }
      return {
        ok: false,
        code: 'internal',
        message: this._redact(`xiaoxing api manager ${name} failed: ${messageOf(error)}`),
      }
    }
  }

  /**
   * Run one mutating operation behind the service's serialized write queue.
   * @param {() => Promise<object>} task - the operation.
   * @returns {Promise<object>} the operation result.
   */
  _serialize(task) {
    const run = this.queue.then(async () => {
      if (this.closed) {
        throw new ApiManagerError('disposed', 'the API provider manager was unloaded; reopen the settings page after reload')
      }
      return task()
    })
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Run one profile write after every previously queued pi-ai write.
   * @param {() => Promise<object>} task - the write.
   * @returns {Promise<object>} the write result.
   */
  _withPiAiWrite(task) {
    const run = this.piAiTail.then(task)
    this.piAiTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Run one network operation with the caller's signal combined with disposal.
   * @param {AbortSignal | undefined} external - caller cancellation signal.
   * @param {(signal: AbortSignal) => Promise<object>} task - the operation.
   * @returns {Promise<object>} the operation result.
   */
  async _withSignal(external, task) {
    const controller = new AbortController()
    const forward = () => controller.abort(external?.reason)
    if (external !== undefined && external !== null) {
      if (external.aborted) controller.abort(external.reason)
      else external.addEventListener('abort', forward, { once: true })
    }
    this.controllers.add(controller)
    try {
      return await task(controller.signal)
    } finally {
      this.controllers.delete(controller)
      external?.removeEventListener?.('abort', forward)
    }
  }

  /** Build the ISO timestamp for the injected clock. */
  _isoNow() {
    return new Date(this.now()).toISOString()
  }

  /** Load registry settings and the on-disk cache once. */
  _ensureReady() {
    if (this.readyPromise === null) this.readyPromise = this._bootstrapRegistry()
    return this.readyPromise
  }

  /** Read registry settings and construct the registry cache manager. */
  async _bootstrapRegistry() {
    let stored = {}
    try {
      const read = await this.stores.registrySettings.read()
      if (isPlainObject(read)) stored = read
    } catch (error) {
      this._warn(`registry settings could not be read: ${this._redact(messageOf(error))}`)
    }
    this.registrySettings = {
      version: PLUGIN_SCHEMA_VERSION,
      offlineOnly: stored.offlineOnly === true,
      ttlMs: typeof stored.ttlMs === 'number' && stored.ttlMs > 0 ? stored.ttlMs : DEFAULT_REGISTRY_TTL_MS,
      modelsDevUrl: optionalString(stored.modelsDevUrl) ?? DEFAULT_MODELS_DEV_URL,
      openRouterUrl: optionalString(stored.openRouterUrl) ?? DEFAULT_OPEN_ROUTER_URL,
    }
    this.registryCache = new RegistryCacheManager({
      cacheFilePath: join(this.dataDir, REGISTRY_CACHE_FILE),
      modelsDevUrl: this.registrySettings.modelsDevUrl,
      openRouterUrl: this.registrySettings.openRouterUrl,
      ttlMs: this.registrySettings.ttlMs,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      offlineOnly: this.registrySettings.offlineOnly,
      now: this.now,
    })
    try {
      await this.registryCache.load()
    } catch (error) {
      this._warn(`registry cache could not be loaded: ${this._redact(messageOf(error))}`)
    }
    // Reading each store validates its on-disk document; a corrupt file stays
    // untouched on disk and is reported as a warning so the settings page can
    // show it without the plugin failing to load.
    for (const [label, store] of Object.entries({
      overrides: this.stores.overrides,
      syncState: this.stores.syncState,
      customPresets: this.stores.customPresets,
    })) {
      try {
        await store.read()
      } catch (error) {
        this._warn(`${label} state could not be loaded: ${this._redact(messageOf(error))}`)
      }
    }
  }

  /**
   * Best-effort on-demand warm-up when the online registry cache has never been
   * populated yet (`checkedAt === null`) and offline mode is not enabled.
   *
   * Failures are swallowed so offline or air-gapped environments immediately
   * fall back to the bundled mainstream catalog (`data/model-catalog.json`).
   * @param {AbortSignal} [signal] - optional caller abort signal.
   */
  async _warmRegistryIfEmpty(signal) {
    if (this.registryCache === null || this.registrySettings?.offlineOnly === true) return
    const status = this.registryCache.getStatus()
    if (status.checkedAt !== null || status.modelCount > 0) return
    try {
      await this._withSignal(signal, activeSignal => this.registryCache.refresh({
        force: false,
        offlineOnly: false,
        modelsDevUrl: this.registrySettings.modelsDevUrl,
        openRouterUrl: this.registrySettings.openRouterUrl,
        timeoutMs: Math.min(this.timeoutMs, 5_000),
        signal: activeSignal,
      }))
    } catch {
      // Fall back to the bundled mainstream catalog without blocking the caller.
    }
  }

  /** Build the non-secret registry status payload. */
  _registryStatus() {
    if (this.registryCache === null) return null
    const status = this.registryCache.getStatus()
    return {
      modelCount: status.modelCount,
      checkedAt: status.checkedAt,
      ttlMs: status.ttlMs,
      stale: status.stale,
      offlineOnly: status.offlineOnly,
      sources: status.sources,
      warnings: status.warnings.map(warning => this._redact(warning)),
      cacheFilePath: join(this.dataDir, REGISTRY_CACHE_FILE),
    }
  }

  /** Read the stored sync-policy map. */
  async _readSyncState() {
    const data = await this.stores.syncState.read()
    return isPlainObject(data) && isPlainObject(data.providers) ? data.providers : {}
  }

  /** Build one normalized sync policy. */
  _normalizePolicy(stored) {
    return createDefaultSyncPolicy({
      syncCooldownMs: this.syncCooldownMs,
      ...(isPlainObject(stored) ? stored : {}),
    })
  }

  /** Read one provider's normalized sync policy. */
  async _policyFor(providerId) {
    const providers = await this._readSyncState()
    return this._normalizePolicy(providers[providerId])
  }

  /** Store one partial sync-policy update for a provider. */
  async _writePolicy(providerId, patch) {
    await this.stores.syncState.update(data => {
      const providers = isPlainObject(data.providers) ? data.providers : (data.providers = {})
      const current = isPlainObject(providers[providerId]) ? providers[providerId] : {}
      providers[providerId] = { ...current, ...cloneValue(patch) }
      return data
    })
  }

  /** Build the public view of one sync policy. */
  _publicPolicy(policy) {
    return {
      syncMode: policy.syncMode,
      syncCooldownMs: policy.syncCooldownMs,
      includePatterns: Array.isArray(policy.includePatterns) ? [...policy.includePatterns] : [],
      excludePatterns: Array.isArray(policy.excludePatterns) ? [...policy.excludePatterns] : [],
      ignoredModels: Array.isArray(policy.ignoredModels) ? [...policy.ignoredModels] : [],
      includeNonChat: policy.includeNonChat === true,
      syncToSubagentAllowed: policy.syncToSubagentAllowed === true,
      lastSyncedAt: policy.lastSyncedAt ?? null,
      lastStatus: policy.lastStatus ?? null,
      lastError: policy.lastError === null || policy.lastError === undefined ? null : this._redact(String(policy.lastError)),
      lastDiff: isPlainObject(policy.lastDiff) ? cloneValue(policy.lastDiff) : null,
    }
  }

  /** Read the stored override map. */
  async _readOverrides() {
    const data = await this.stores.overrides.read()
    return isPlainObject(data) && isPlainObject(data.providers) ? data.providers : {}
  }

  /** Read one provider's stored per-model override deltas. */
  async _readProviderOverrideModels(providerId) {
    const providers = await this._readOverrides()
    const provider = providers[providerId]
    return isPlainObject(provider) && isPlainObject(provider.models) ? cloneValue(provider.models) : {}
  }

  /** Apply sparse model deltas in one store write and return the previous values. */
  async _writeOverrideDeltas(providerId, changes) {
    const previous = new Map()
    await this.stores.overrides.update(data => {
      const models = Object.entries(data.providers[providerId]?.models ?? {})
      const next = new Map(models)
      for (const [modelId, delta] of changes) {
        previous.set(modelId, next.get(modelId))
        if (delta === undefined) next.delete(modelId)
        else next.set(modelId, cloneValue(delta))
      }
      if (next.size === 0) delete data.providers[providerId]
      else data.providers[providerId] = { ...data.providers[providerId], models: Object.fromEntries(next) }
      return data
    })
    return previous
  }

  /** Persist or delete one stored model override delta. */
  _writeOverrideDelta(providerId, modelId, delta) {
    return this._writeOverrideDeltas(providerId, [[modelId, delta]])
  }

  /** Persist one provider model list with conflict retry. */
  async _commitPiAiProfile(providerId, profile) {
    return this._withPiAiWrite(async () => {
      for (let attempt = 1; ; attempt += 1) {
        const snapshot = readPiAiSnapshot(this.deps)
        if (!snapshot.available) {
          throw new ApiManagerError('config-unavailable', snapshot.error ?? 'the llm-pi-ai configuration is not available')
        }
        try {
          await mutatePiAiProvider(this.deps, {
            providerId,
            profile: cloneValue(profile),
            expectedRevision: snapshot.revision,
          })
          return { provider: providerId, revision: snapshot.revision === null ? null : snapshot.revision + 1 }
        } catch (error) {
          if (error instanceof ApiManagerError && error.code === 'config-conflict' && attempt === 1) continue
          throw error
        }
      }
    })
  }

  /** Remove one provider profile with conflict retry. */
  async _removePiAiProfile(providerId) {
    return this._withPiAiWrite(async () => {
      for (let attempt = 1; ; attempt += 1) {
        const snapshot = readPiAiSnapshot(this.deps)
        if (!snapshot.available) {
          throw new ApiManagerError('config-unavailable', snapshot.error ?? 'the llm-pi-ai configuration is not available')
        }
        try {
          await removePiAiProvider(this.deps, { providerId, expectedRevision: snapshot.revision })
          return { provider: providerId, revision: snapshot.revision === null ? null : snapshot.revision + 1 }
        } catch (error) {
          if (error instanceof ApiManagerError && error.code === 'config-conflict' && attempt === 1) continue
          throw error
        }
      }
    })
  }

  /** Prepare one model entry for persistence through the enrichment precedence. */
  _prepareModelForSave({ entry, api, presetId, existingModel, override, autoEnrich, routeCompat }) {
    const editing = isPlainObject(entry.manualFields)
    const rematch = entry.rematch === true
    const explicit = explicitManagedFields(entry)
    let editorDelta
    if (editing) {
      // Keep generated reasoning refreshable. Older configured effort maps
      // without an override retain their existing precedence unless rematched.
      const canAddReasoning = autoEnrich || Object.hasOwn(entry, 'reasoningEfforts')
      const refreshableReasoning = existingModel?.reasoningEfforts === undefined
        || existingModel?.reasoningEfforts === false
        || rematch
      if (canAddReasoning && refreshableReasoning
        && !Object.hasOwn(explicit, 'reasoningEfforts') && !Object.hasOwn(override ?? {}, 'reasoningEfforts')) {
        explicit.reasoningEfforts = null
      }
      if (Object.keys(explicit).length > 0) {
        editorDelta = mergeManualOverride(override, validateOverrideDelta(explicit))
      }
    }
    if (autoEnrich === false) {
      const profile = editing ? { ...cloneValue(existingModel ?? {}), ...cloneValue(entry) } : cloneValue(entry)
      for (const field of ['discovered', 'manualFields', 'rematch', 'description', 'type', ...DISCOVERY_FIELDS]) {
        if (!editing || !MANAGED_MODEL_FIELDS.includes(field)) delete profile[field]
      }
      if (editing) {
        for (const field of MANAGED_MODEL_FIELDS) if (profile[field] === null) delete profile[field]
      }
      validateModelProfile(profile, api)
      return { profile, meta: {}, warnings: [], manualOverride: {}, editorDelta }
    }
    const manualOverride = editorDelta ?? mergeManualOverride(override, explicit)
    const result = enrichModel({
      id: entry.id,
      discovered: discoveryFieldsOf(entry),
      configured: rematch ? undefined : existingModel,
      manualOverride,
      api,
      presetId,
      routeCompat,
      registryCache: this.registryCache,
    })
    return { profile: result.profile, meta: result.meta, warnings: result.warnings, manualOverride, editorDelta }
  }

  /** Enrich one discovered model with the stored manual overrides. */
  _enrichDiscovered({ model, api, presetId, existingModel, override, routeCompat }) {
    const result = enrichModel({
      id: model.id,
      discovered: model,
      configured: existingModel,
      manualOverride: override,
      api,
      presetId,
      routeCompat,
      registryCache: this.registryCache,
    })
    return result
  }

  /** Check whether two model lists differ by id and content. */
  _modelsChanged(existingModels, nextModels) {
    if (existingModels.length !== nextModels.length) return true
    const nextById = new Map(nextModels.map(model => [model.id, model]))
    for (const model of existingModels) {
      const next = nextById.get(model.id)
      if (next === undefined) return true
      if (JSON.stringify(model) !== JSON.stringify(next)) return true
    }
    return false
  }

  /** Record one best-effort sync outcome, returning a warning when it fails. */
  async _recordSyncOutcome(providerId, patch) {
    try {
      await this._writePolicy(providerId, patch)
      return null
    } catch (error) {
      const message = this._redact(`sync state for "${providerId}" could not be recorded: ${messageOf(error)}`)
      this._warn(message)
      return message
    }
  }

  /** Build the protected result for a failed or empty discovery. */
  _syncFallback({ providerId, displayName, profile, policy, warning, syncedAt, warnings = [] }) {
    const existing = Array.isArray(profile.models) ? profile.models : []
    return {
      ok: true,
      provider: providerId,
      displayName,
      source: 'fallback-configured',
      applied: false,
      warning,
      diff: { added: [], removed: [], unchanged: existing.length },
      models: summarizeModels(existing),
      syncedAt: syncedAt ?? policy.lastSyncedAt ?? null,
      syncPolicy: this._publicPolicy(policy),
      warnings,
    }
  }

  /** Create or update one provider profile. */
  async _upsertProvider(req) {
    await this._ensureReady()
    const snapshot = readPiAiSnapshot(this.deps)
    if (!snapshot.available) {
      throw new ApiManagerError('config-unavailable', snapshot.error ?? 'the llm-pi-ai configuration is not available')
    }
    const configurableProviders = snapshot.configurableProviders
    const providerId = requiredString(req.provider, 'provider')
    validateCustomProviderId(providerId, configurableProviders)
    const existing = isPlainObject(snapshot.providers[providerId]) ? snapshot.providers[providerId] : undefined
    const presetId = req.presetId === undefined ? undefined : requiredString(req.presetId, 'presetId')
    const preset = presetId === undefined ? undefined : getPreset(presetId)
    if (presetId !== undefined && preset === undefined) {
      throw new ApiManagerError('unknown-preset', `gateway preset "${presetId}" does not exist`, { presetId })
    }
    const api = optionalString(req.api) ?? optionalString(existing?.api) ?? preset?.api ?? 'openai-completions'
    if (!SUPPORTED_PROTOCOLS.includes(api)) {
      throw new ApiManagerError('invalid-api', `api must be one of ${SUPPORTED_PROTOCOLS.join(', ')}; got ${JSON.stringify(api)}`, { api })
    }
    const baseURL = optionalString(req.baseURL) ?? optionalString(existing?.baseURL)
    if (baseURL === undefined) {
      throw new ApiManagerError('invalid-provider-profile', `provider "${providerId}" needs a baseURL`, { provider: providerId })
    }
    const displayName = optionalString(req.displayName) ?? optionalString(existing?.displayName) ?? optionalString(existing?.name) ?? providerId
    const warnings = []

    let credentialRef = optionalString(existing?.apiKeyEnv)
    if (req.apiKeyEnv !== undefined) credentialRef = validateCredentialRef(requiredString(req.apiKeyEnv, 'apiKeyEnv'))
    let pendingApiKey
    if (req.apiKey !== undefined && req.apiKey !== null) {
      if (typeof req.apiKey !== 'string') throw new ApiManagerError('invalid-request', 'apiKey must be a string')
      pendingApiKey = req.apiKey
      this._rememberSecret(pendingApiKey)
      if (credentialRef === undefined) credentialRef = deriveCredentialRef(providerId)
    }
    let credentialToRemove
    if (req.removeCredential === true && pendingApiKey === undefined) {
      credentialToRemove = credentialRef
      credentialRef = undefined
    }

    let headers = isPlainObject(existing?.headers) ? existing.headers : undefined
    if (req.headers !== undefined) {
      if (req.headers === null) headers = undefined
      else if (!isPlainObject(req.headers)) throw new ApiManagerError('invalid-request', 'headers must be an object of header name to string value')
      else {
        const nextHeaders = cloneValue(req.headers)
        const nextLower = new Set(Object.keys(nextHeaders).map(name => name.toLowerCase()))
        if (isPlainObject(existing?.headers)) {
          for (const [name, value] of Object.entries(existing.headers)) {
            if (!nextLower.has(name.toLowerCase()) && (SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) || (typeof value === 'string' && looksLikeSecret(value)))) {
              nextHeaders[name] = value
            }
          }
        }
        headers = nextHeaders
      }
    }

    const requestedModels = normalizeModelEntries(req.models)
    const sourceModels = requestedModels.length > 0
      ? requestedModels
      : (Array.isArray(existing?.models) ? existing.models.map(model => cloneValue(model)) : [])
    if (sourceModels.length === 0) {
      throw new ApiManagerError('invalid-provider-profile', `provider "${providerId}" needs at least one model`, { provider: providerId })
    }
    const existingById = new Map(
      (Array.isArray(existing?.models) ? existing.models : []).map(model => [model.id, model]),
    )
    const storedOverrides = await this._readProviderOverrideModels(providerId)
    const autoEnrich = req.autoEnrich !== false
    let routeCompat = isPlainObject(existing?.compat) ? existing.compat : undefined
    if (req.compat !== undefined) {
      if (req.compat === null) routeCompat = undefined
      else if (!isPlainObject(req.compat)) throw new ApiManagerError('invalid-request', 'compat must be an object or null')
      else routeCompat = cloneValue(req.compat)
    }
    const prepared = sourceModels.map(entry => this._prepareModelForSave({
      entry,
      api,
      presetId: presetId ?? presetIdForApi(api),
      existingModel: existingById.get(entry.id),
      override: storedOverrides[entry.id],
      autoEnrich,
      routeCompat,
    }))
    for (const item of prepared) warnings.push(...item.warnings)
    const baseProfile = {
      displayName,
      api,
      baseURL,
      models: prepared.map(item => item.profile),
      ...(credentialRef === undefined ? {} : { apiKeyEnv: credentialRef }),
      ...(headers === undefined ? {} : { headers: cloneValue(headers) }),
      ...(routeCompat === undefined || Object.keys(routeCompat).length === 0 ? {} : { compat: cloneValue(routeCompat) }),
    }
    for (const field of PRESERVED_PROFILE_FIELDS) {
      if (field === 'compat' && req.compat !== undefined) continue
      if (existing !== undefined && Object.hasOwn(existing, field) && !Object.hasOwn(baseProfile, field)) {
        baseProfile[field] = cloneValue(existing[field])
      }
    }
    validateProviderProfile(providerId, baseProfile, configurableProviders)

    let groups = [{ provider: providerId, profile: baseProfile }]
    if (req.splitByProtocol === true) {
      const enrichedModels = prepared.map(item => ({
        profile: item.profile,
        meta: { supportedEndpointTypes: Array.isArray(item.meta?.supportedEndpointTypes) ? item.meta.supportedEndpointTypes : [] },
      }))
      const plan = planProtocolSplit({
        providerId,
        displayName,
        baseURL,
        apiKeyEnv: credentialRef,
        enrichedModels,
        existingProviders: snapshot.providers,
        configurableProviders,
      })
      warnings.push(...plan.warnings.map(warning => this._redact(warning.message)))
      const manualById = new Map(prepared.map(item => [item.profile.id, item.manualOverride]))
      groups = plan.groups.map(group => {
        const models = group.models.map(model => {
          const result = enrichModel({
            id: model.id,
            configured: model,
            manualOverride: manualById.get(model.id),
            api: group.api,
            presetId: presetIdForApi(group.api),
            registryCache: this.registryCache,
          })
          warnings.push(...result.warnings.map(warning => this._redact(warning.message)))
          return result.profile
        })
        const profile = {
          displayName: group.displayName,
          api: group.api,
          baseURL: group.baseURL ?? baseURL,
          models,
          ...(credentialRef === undefined ? {} : { apiKeyEnv: credentialRef }),
          ...(headers === undefined ? {} : { headers: cloneValue(headers) }),
        }
        validateProviderProfile(group.id, profile, configurableProviders)
        return { provider: group.id, profile }
      })
      // One protocol is not a split: keep the requested route id and label.
      if (groups.length === 1) {
        groups = [{ provider: providerId, profile: { ...groups[0].profile, displayName } }]
      }
    }

    // Validated before anything is written, so a bad policy cannot leave a
    // committed route behind with only half of the request applied.
    const policyPatch = req.syncPolicy === undefined ? {} : validateSyncPolicyInput(req.syncPolicy)

    let credentialStored = false
    let credentialRemoved = false
    if (pendingApiKey !== undefined) {
      await setCredential(this.deps, credentialRef, pendingApiKey)
      credentialStored = true
    }
    const editorDeltas = new Map(prepared.filter(item => item.editorDelta !== undefined)
      .map(item => [item.profile.id, item.editorDelta]))
    const written = []
    for (const group of groups) {
      const changes = group.profile.models.filter(model => editorDeltas.has(model.id))
        .map(model => [model.id, editorDeltas.get(model.id)])
      const previous = changes.length > 0 ? await this._writeOverrideDeltas(group.provider, changes) : null
      try {
        await this._commitPiAiProfile(group.provider, group.profile)
      } catch (error) {
        if (previous !== null) {
          try {
            await this._writeOverrideDeltas(group.provider, previous)
          } catch (restoreError) {
            this._warn(this._redact(`model overrides could not be restored: ${messageOf(restoreError)}`))
          }
        }
        throw error
      }
      written.push(group)
    }
    const primary = written[0]
    if (credentialToRemove !== undefined) {
      try {
        await unsetCredential(this.deps, credentialToRemove)
        credentialRemoved = true
      } catch (error) {
        warnings.push(this._redact(`the stored credential could not be removed: ${messageOf(error)}`))
      }
    }

    let syncPolicy = null
    try {
      if (written.length > 1) {
        // One endpoint listing cannot be attributed to a single protocol, so an
        // automatic sync would pour every model into every split route.
        for (const group of written) {
          await this._writePolicy(group.provider, group === primary ? { ...policyPatch, syncMode: 'manual' } : { syncMode: 'manual' })
        }
        warnings.push('automatic model sync is off for the split routes, because one endpoint listing cannot be attributed to a single protocol')
        syncPolicy = this._publicPolicy(await this._policyFor(primary.provider))
      } else {
        // `ignoredModels` are ids the route's owner declined; automatic sync
        // never adds them back. A model the route now carries is by definition
        // wanted, so it leaves the list whichever way it got here.
        const keptIds = new Set(primary.profile.models.map(model => model.id))
        const current = policyPatch.ignoredModels ?? (await this._policyFor(primary.provider)).ignoredModels
        const declined = Array.isArray(current) ? current : []
        if (policyPatch.ignoredModels !== undefined || declined.some(id => keptIds.has(id))) {
          policyPatch.ignoredModels = declined.filter(id => !keptIds.has(id))
        }
        if (Object.keys(policyPatch).length > 0) {
          await this._writePolicy(primary.provider, policyPatch)
          syncPolicy = this._publicPolicy(await this._policyFor(primary.provider))
        }
      }
    } catch (error) {
      // The route itself is saved; an explicitly requested policy must still
      // fail loudly, while bookkeeping the caller never asked for only warns.
      if (req.syncPolicy !== undefined) throw error
      warnings.push(this._redact(`the sync policy could not be updated: ${messageOf(error)}`))
    }

    let defaultSelection = readDefaultSelection(this.deps)
    if (req.setAsDefault !== undefined && req.setAsDefault !== false) {
      let targetModel
      let reasoningEffort = optionalString(req.reasoningEffort)
      if (req.setAsDefault === true) {
        targetModel = primary.profile.models[0]?.id
      } else if (isPlainObject(req.setAsDefault)) {
        targetModel = requiredString(req.setAsDefault.model ?? req.modelId, 'setAsDefault.model')
        reasoningEffort = optionalString(req.setAsDefault.reasoningEffort) ?? reasoningEffort
      } else {
        throw new ApiManagerError('invalid-request', 'setAsDefault must be true or an object with a model')
      }
      if (typeof targetModel !== 'string' || !primary.profile.models.some(model => model.id === targetModel)) {
        throw new ApiManagerError('model-not-found', `model ${JSON.stringify(targetModel)} is not part of provider "${primary.provider}"`)
      }
      defaultSelection = await saveDefaultSelection(this.deps, {
        provider: primary.provider,
        model: targetModel,
        reasoningEffort,
      })
    }

    let subagentSelection = readSubagentSelection(this.deps)
    const requestedAdds = req.addToSubagent === true
      ? primary.profile.models.map(model => model.id)
      : Array.isArray(req.addToSubagent)
        ? req.addToSubagent.map(entry => optionalString(entry) ?? requiredString(entry?.model, 'addToSubagent model'))
        : []
    if (requestedAdds.length > 0 || req.enableSubagent !== undefined) {
      for (const modelId of requestedAdds) {
        if (!primary.profile.models.some(model => model.id === modelId)) {
          throw new ApiManagerError('model-not-found', `model "${modelId}" is not part of provider "${primary.provider}"`)
        }
      }
      try {
        subagentSelection = await updateSubagentSelection(this.deps, {
          enabled: typeof req.enableSubagent === 'boolean' ? req.enableSubagent : undefined,
          addModels: requestedAdds.map(model => ({ provider: primary.provider, model })),
          defaultProvider: primary.provider,
        })
      } catch (error) {
        warnings.push(this._redact(`subagent model selection was not updated: ${messageOf(error)}`))
      }
    }

    const credential = credentialRef === undefined
      ? null
      : await describeCredential(this.deps, credentialRef).catch(error => ({
          available: false,
          configured: false,
          writable: false,
          source: null,
          masked: null,
          error: this._redact(messageOf(error)),
        }))

    return {
      ok: true,
      provider: providerId,
      displayName,
      created: existing === undefined,
      updated: existing !== undefined,
      split: written.length > 1,
      groups: written.map(group => ({
        provider: group.provider,
        api: group.profile.api,
        displayName: group.profile.displayName,
        modelCount: group.profile.models.length,
      })),
      modelCount: written.reduce((total, group) => total + group.profile.models.length, 0),
      profile: sanitizeProfileForOutput(primary.profile),
      credential,
      credentialStored,
      credentialRemoved,
      syncPolicy,
      defaultSelection,
      subagentSelection,
      warnings,
    }
  }

  /** Remove one provider and the manager state that references it. */
  async _removeProvider(req) {
    await this._ensureReady()
    const snapshot = readPiAiSnapshot(this.deps)
    if (!snapshot.available) {
      throw new ApiManagerError('config-unavailable', snapshot.error ?? 'the llm-pi-ai configuration is not available')
    }
    const providerId = requiredString(req.provider, 'provider')
    validateCustomProviderId(providerId, snapshot.configurableProviders)
    const profile = snapshot.providers[providerId]
    if (!isPlainObject(profile)) {
      throw new ApiManagerError('provider-not-found', `provider "${providerId}" is not configured`, { provider: providerId })
    }
    await this._removePiAiProfile(providerId)
    const warnings = []

    // The provider is gone; the derived state is best-effort cleanup, so a
    // damaged store file is reported without failing the removal.
    try {
      await this.stores.overrides.update(data => {
        if (isPlainObject(data.providers)) delete data.providers[providerId]
        return data
      })
    } catch (error) {
      warnings.push(this._redact(`stored overrides could not be cleared: ${messageOf(error)}`))
    }
    try {
      await this.stores.syncState.update(data => {
        if (isPlainObject(data.providers)) delete data.providers[providerId]
        return data
      })
    } catch (error) {
      warnings.push(this._redact(`the sync policy could not be cleared: ${messageOf(error)}`))
    }

    const selection = readSubagentSelection(this.deps)
    if (selection.available && selection.allowedModels.some(route => route.provider === providerId)) {
      const remaining = selection.allowedModels.filter(route => route.provider !== providerId)
      try {
        await updateSubagentSelection(this.deps, {
          enabled: remaining.length === 0 ? false : selection.enabled,
          allowedModels: remaining,
        })
      } catch (error) {
        warnings.push(this._redact(`subagent model selection was not updated: ${messageOf(error)}`))
      }
    }

    let credentialRemoved = false
    if (req.removeCredential === true && typeof profile.apiKeyEnv === 'string') {
      try {
        await unsetCredential(this.deps, profile.apiKeyEnv)
        credentialRemoved = true
      } catch (error) {
        warnings.push(this._redact(`the stored credential could not be removed: ${messageOf(error)}`))
      }
    }
    return {
      ok: true,
      provider: providerId,
      removed: true,
      credentialRemoved,
      warnings,
    }
  }

  /** Run one provider sync inside the serialized queue. */
  async _syncProviderModelsOrdered(req) {
    const providerId = requiredString(req.provider, 'provider')
    return this._syncProviderModelsUnsafe({ ...req, provider: providerId })
  }

  /** Synchronize one provider from its live endpoint. */
  async _syncProviderModelsUnsafe(req) {
    const providerId = requiredString(req.provider, 'provider')
    const snapshot = readPiAiSnapshot(this.deps)
    if (!snapshot.available) {
      throw new ApiManagerError('config-unavailable', snapshot.error ?? 'the llm-pi-ai configuration is not available')
    }
    validateCustomProviderId(providerId, snapshot.configurableProviders)
    const profile = snapshot.providers[providerId]
    if (!isPlainObject(profile)) {
      throw new ApiManagerError('provider-not-found', `provider "${providerId}" is not configured`, { provider: providerId })
    }
    const displayName = optionalString(profile.displayName) ?? optionalString(profile.name) ?? providerId
    await this._ensureReady()
    const policy = await this._policyFor(providerId)
    const warnings = []
    const nowMs = this.now()
    const lastMs = typeof policy.lastSyncedAt === 'string' ? Date.parse(policy.lastSyncedAt) : Number.NaN
    if (req.force !== true && Number.isFinite(lastMs) && nowMs - lastMs < policy.syncCooldownMs) {
      const existing = Array.isArray(profile.models) ? profile.models : []
      return {
        ok: true,
        provider: providerId,
        displayName,
        source: 'cooldown-cache',
        applied: false,
        diff: { added: [], removed: [], unchanged: existing.length },
        models: summarizeModels(existing),
        syncedAt: policy.lastSyncedAt,
        syncPolicy: this._publicPolicy(policy),
        warnings,
      }
    }

    let apiKey
    const apiKeyEnv = optionalString(profile.apiKeyEnv)
    if (apiKeyEnv !== undefined) {
      const resolved = await resolveCredential(this.deps, apiKeyEnv)
      if (resolved !== undefined) {
        apiKey = resolved.value
        this._rememberSecret(apiKey)
      }
    }

    let discovery
    try {
      discovery = await this._withSignal(req.signal, signal => discoverEndpointModels({
        baseURL: profile.baseURL,
        api: profile.api,
        apiKey,
        headers: isPlainObject(profile.headers) ? profile.headers : undefined,
        signal,
        timeoutMs: this.timeoutMs,
        includeNonChat: policy.includeNonChat === true,
        fetchImpl: this.fetchImpl,
      }))
    } catch (error) {
      const warning = this._redact(`live sync was skipped to protect the configured models: ${messageOf(error)}`)
      const recordWarning = await this._recordSyncOutcome(providerId, { lastStatus: 'error', lastError: warning })
      if (recordWarning !== null) warnings.push(recordWarning)
      return this._syncFallback({ providerId, displayName, profile, policy, warning, syncedAt: policy.lastSyncedAt, warnings })
    }

    const discovered = filterDiscoveredModels(discovery.models, policy)
    if (discovered.length === 0) {
      const warning = 'the endpoint returned no usable models; the configured model list was kept'
      const recordWarning = await this._recordSyncOutcome(providerId, { lastStatus: 'empty', lastError: null })
      if (recordWarning !== null) warnings.push(recordWarning)
      return this._syncFallback({ providerId, displayName, profile, policy, warning, syncedAt: policy.lastSyncedAt, warnings })
    }

    const storedOverrides = await this._readProviderOverrideModels(providerId)
    const existingModels = Array.isArray(profile.models) ? profile.models : []
    const existingById = new Map(existingModels.map(model => [model.id, model]))
    const presetId = presetIdForApi(profile.api)
    const routeCompat = isPlainObject(profile.compat) ? profile.compat : undefined
    const enriched = []
    for (const model of discovered) {
      try {
        const result = this._enrichDiscovered({
          model,
          api: profile.api,
          presetId,
          existingModel: existingById.get(model.id),
          override: storedOverrides[model.id],
          routeCompat,
        })
        enriched.push(result)
      } catch (error) {
        warnings.push(this._redact(`model "${model.id}" could not be enriched: ${messageOf(error)}`))
      }
    }
    if (enriched.length === 0) {
      const warning = 'no discovered model could be enriched; the configured model list was kept'
      const recordWarning = await this._recordSyncOutcome(providerId, { lastStatus: 'error', lastError: warning })
      if (recordWarning !== null) warnings.push(recordWarning)
      return this._syncFallback({ providerId, displayName, profile, policy, warning, syncedAt: policy.lastSyncedAt, warnings })
    }

    const requestedMode = optionalString(req.mode)
    const mode = requestedMode ?? policy.syncMode
    if (!SYNC_MODES.includes(mode)) {
      throw new ApiManagerError('invalid-sync-mode', `sync mode must be one of ${SYNC_MODES.join(', ')}; got ${JSON.stringify(mode)}`)
    }
    const autoApply = req.autoApply !== false
    const existingIds = new Set(existingModels.map(model => model.id))
    const discoveredIds = enriched.map(result => result.profile.id)
    const discoveredIdSet = new Set(discoveredIds)
    const added = discoveredIds.filter(id => !existingIds.has(id))
    const removed = [...existingIds].filter(id => !discoveredIdSet.has(id))
    // A manual sync previews additions; when the caller explicitly asks to
    // apply, additions are the only safe default, so it behaves like add-new.
    const applyMode = mode === 'manual' ? 'add-new' : mode
    const nextModels = buildSyncedModelList({ existingModels, existingIds, enriched, mode: applyMode })
    const applyDiff = {
      added,
      removed: applyMode === 'mirror' ? removed : [],
      unchanged: applyMode === 'add-new' ? existingModels.length : nextModels.length - added.length,
    }
    if (!autoApply) {
      return {
        ok: true,
        provider: providerId,
        displayName,
        source: 'preview',
        applied: false,
        mode,
        diff: mode === 'manual'
          ? { added, removed, unchanged: existingModels.length - removed.length }
          : applyDiff,
        models: summarizeModels(nextModels),
        syncedAt: policy.lastSyncedAt,
        syncPolicy: this._publicPolicy(policy),
        warnings,
      }
    }
    const diff = applyDiff
    if (!this._modelsChanged(existingModels, nextModels)) {
      const syncedAt = this._isoNow()
      const recordWarning = await this._recordSyncOutcome(providerId, {
        lastSyncedAt: syncedAt,
        lastStatus: 'unchanged',
        lastError: null,
        lastDiff: diff,
      })
      if (recordWarning !== null) warnings.push(recordWarning)
      return {
        ok: true,
        provider: providerId,
        displayName,
        source: 'unchanged',
        applied: false,
        mode: applyMode,
        diff,
        models: summarizeModels(nextModels),
        syncedAt,
        syncPolicy: this._publicPolicy(await this._policyFor(providerId)),
        warnings,
      }
    }

    const committed = await this._commitSyncModels({ providerId, mode: applyMode, enriched })
    const syncedAt = this._isoNow()
    const recordWarning = await this._recordSyncOutcome(providerId, {
      lastSyncedAt: syncedAt,
      lastStatus: 'success',
      lastError: null,
      lastDiff: diff,
    })
    if (recordWarning !== null) warnings.push(recordWarning)

    if (policy.syncToSubagentAllowed === true && added.length > 0) {
      try {
        await updateSubagentSelection(this.deps, {
          addModels: added.map(model => ({ provider: providerId, model })),
          defaultProvider: providerId,
        })
      } catch (error) {
        warnings.push(this._redact(`subagent model selection was not updated: ${messageOf(error)}`))
      }
    }

    try {
      this.deps.emitSynced?.({
        provider: providerId,
        displayName,
        mode: applyMode,
        added,
        removed: diff.removed,
        unchanged: diff.unchanged,
        syncedAt,
      })
    } catch (error) {
      warnings.push(this._redact(`the models-synced notification failed: ${messageOf(error)}`))
    }

    return {
      ok: true,
      provider: providerId,
      displayName,
      source: 'live',
      applied: true,
      mode: applyMode,
      diff,
      models: summarizeModels(committed.models),
      syncedAt,
      syncPolicy: this._publicPolicy(await this._policyFor(providerId)),
      warnings,
    }
  }

  /** Commit one sync result with conflict retry against a fresh snapshot. */
  _commitSyncModels({ providerId, mode, enriched }) {
    return this._withPiAiWrite(async () => {
      for (let attempt = 1; ; attempt += 1) {
        const snapshot = readPiAiSnapshot(this.deps)
        if (!snapshot.available) {
          throw new ApiManagerError('config-unavailable', snapshot.error ?? 'the llm-pi-ai configuration is not available')
        }
        const profile = snapshot.providers[providerId]
        if (!isPlainObject(profile)) {
          throw new ApiManagerError('provider-not-found', `provider "${providerId}" is no longer configured`, { provider: providerId })
        }
        const existingModels = Array.isArray(profile.models) ? profile.models : []
        const existingIds = new Set(existingModels.map(model => model.id))
        const nextModels = buildSyncedModelList({ existingModels, existingIds, enriched, mode })
        try {
          await mutatePiAiProvider(this.deps, {
            providerId,
            profile: { ...cloneValue(profile), models: nextModels },
            expectedRevision: snapshot.revision,
          })
          return { provider: providerId, models: nextModels }
        } catch (error) {
          if (error instanceof ApiManagerError && error.code === 'config-conflict' && attempt === 1) continue
          throw error
        }
      }
    })
  }

  /** Synchronize every custom provider with bounded concurrency. */
  async _syncAllCustomProviders(req) {
    await this._ensureReady()
    const snapshot = readPiAiSnapshot(this.deps)
    if (!snapshot.available) {
      throw new ApiManagerError('config-unavailable', snapshot.error ?? 'the llm-pi-ai configuration is not available')
    }
    const { customProviders } = classifyProviders(snapshot)
    let providerIds = customProviders.map(entry => entry.provider)
    if (req.onlyAutoEnabled === true) {
      const policies = await this._readSyncState()
      providerIds = providerIds.filter(providerId => {
        const policy = this._normalizePolicy(policies[providerId])
        return policy.syncMode !== 'manual'
      })
    }
    const results = new Array(providerIds.length)
    let cursor = 0
    const workerCount = Math.min(clampConcurrency(req.concurrency), providerIds.length)
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= providerIds.length) return
        results[index] = await this._guard('syncProviderModels', () => this._syncProviderModelsUnsafe({
          provider: providerIds[index],
          force: req.force === true,
          autoApply: req.autoApply !== false,
          ...(req.mode === undefined ? {} : { mode: req.mode }),
        }))
      }
    })
    await Promise.all(workers)
    const syncedCount = results.length
    const updatedCount = results.filter(result => result.ok === true && result.applied === true).length
    const failureCount = results.filter(result => result.ok !== true).length
    const warningCount = results.reduce((total, result) => {
      if (Array.isArray(result.warnings)) return total + result.warnings.length
      return total + (result.warning === undefined ? 0 : 1)
    }, 0)
    return {
      ok: true,
      providers: results,
      syncedCount,
      updatedCount,
      failureCount,
      warningCount,
    }
  }

  /** Read or update one sync policy. */
  async _setSyncPolicy(req) {
    const snapshot = readPiAiSnapshot(this.deps)
    if (!snapshot.available) {
      throw new ApiManagerError('config-unavailable', snapshot.error ?? 'the llm-pi-ai configuration is not available')
    }
    const providerId = requiredString(req.provider, 'provider')
    validateCustomProviderId(providerId, snapshot.configurableProviders)
    let input
    if (isPlainObject(req.policy)) {
      input = req.policy
    } else {
      input = {}
      for (const field of SYNC_POLICY_FIELDS) {
        if (req[field] !== undefined) input[field] = req[field]
      }
    }
    const patch = validateSyncPolicyInput(input)
    await this._writePolicy(providerId, patch)
    const policy = await this._policyFor(providerId)
    return { ok: true, provider: providerId, syncPolicy: this._publicPolicy(policy) }
  }

  /** Set the agent default model and/or the subagent selection. */
  async _setDefaults(req) {
    const snapshot = readPiAiSnapshot(this.deps)
    const providerId = optionalString(req.provider)
    const modelId = optionalString(req.model)
    const selectionProvided = providerId !== undefined || modelId !== undefined
    const wantsSubagent = req.enableSubagent !== undefined
      || req.addToSubagent !== undefined
      || req.removeFromSubagent !== undefined
      || req.subagentAllowedModels !== undefined
    if (!selectionProvided && !wantsSubagent) {
      throw new ApiManagerError('invalid-request', 'setDefaults needs a provider/model selection or a subagent selection change')
    }
    let defaultSelection = readDefaultSelection(this.deps)
    if (providerId !== undefined && modelId !== undefined) {
      if (!snapshot.available) {
        throw new ApiManagerError('config-unavailable', snapshot.error ?? 'the llm-pi-ai configuration is not available')
      }
      defaultSelection = await saveDefaultSelection(this.deps, {
        provider: providerId,
        model: modelId,
        reasoningEffort: req.reasoningEffort,
      })
    } else if (selectionProvided && !wantsSubagent) {
      throw new ApiManagerError('invalid-request', 'setting the default model needs both provider and model')
    }
    let subagentSelection = readSubagentSelection(this.deps)
    if (wantsSubagent) {
      const addModels = req.addToSubagent === true
        ? (providerId !== undefined && Array.isArray(snapshot.providers[providerId]?.models)
            ? snapshot.providers[providerId].models.map(model => ({ provider: providerId, model: model.id }))
            : [])
        : req.addToSubagent
      subagentSelection = await updateSubagentSelection(this.deps, {
        enabled: typeof req.enableSubagent === 'boolean' ? req.enableSubagent : undefined,
        allowedModels: req.subagentAllowedModels,
        addModels,
        removeModels: req.removeFromSubagent,
        ...(providerId === undefined ? {} : { defaultProvider: providerId }),
      })
    }
    return { ok: true, defaultSelection, subagentSelection }
  }

  /** Save one sparse model override and re-enrich the live profile. */
  async _saveOverride(req) {
    await this._ensureReady()
    const snapshot = readPiAiSnapshot(this.deps)
    if (!snapshot.available) {
      throw new ApiManagerError('config-unavailable', snapshot.error ?? 'the llm-pi-ai configuration is not available')
    }
    const providerId = requiredString(req.provider, 'provider')
    validateCustomProviderId(providerId, snapshot.configurableProviders)
    const profile = snapshot.providers[providerId]
    if (!isPlainObject(profile)) {
      throw new ApiManagerError('provider-not-found', `provider "${providerId}" is not configured`, { provider: providerId })
    }
    const modelId = requiredString(req.model ?? req.modelId, 'model')
    const existingModel = (Array.isArray(profile.models) ? profile.models : []).find(model => model.id === modelId)
    if (!isPlainObject(existingModel)) {
      throw new ApiManagerError('model-not-found', `model "${modelId}" is not configured on provider "${providerId}"`, { provider: providerId, model: modelId })
    }
    const requested = isPlainObject(req.override) ? cloneValue(req.override) : {}
    if (Array.isArray(req.reset)) {
      for (const field of req.reset) {
        if (typeof field === 'string' && field.length > 0) requested[field] = null
      }
    }
    const delta = validateOverrideDelta(requested)
    const stored = await this._readProviderOverrideModels(providerId)
    const storedDelta = isPlainObject(stored[modelId]) ? stored[modelId] : {}
    const merged = { ...storedDelta, ...delta }
    const upstreamChanged = Object.hasOwn(delta, 'upstreamModel')
    if (merged.upstreamModel === null) delete merged.upstreamModel
    // An explicit null clears the stored field from the configured layer before
    // re-enriching; changing or clearing an upstream model binding drops
    // non-manual capability fields so the newly bound upstream model (or
    // default) answers.
    const configured = { ...cloneValue(existingModel) }
    for (const [field, value] of Object.entries(merged)) {
      if (value === null) delete configured[field]
    }
    if (upstreamChanged) {
      for (const field of ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat']) {
        if (!Object.hasOwn(merged, field) || merged[field] === null) delete configured[field]
      }
    }
    const enriched = enrichModel({
      id: modelId,
      configured,
      manualOverride: merged,
      api: profile.api,
      presetId: presetIdForApi(profile.api),
      routeCompat: isPlainObject(profile.compat) ? profile.compat : undefined,
      registryCache: this.registryCache,
    })
    await this._writeOverrideDelta(providerId, modelId, Object.keys(merged).length === 0 ? undefined : merged)
    const nextProfile = {
      ...cloneValue(profile),
      models: (Array.isArray(profile.models) ? profile.models : []).map(model => (model.id === modelId ? enriched.profile : model)),
    }
    await this._commitPiAiProfile(providerId, nextProfile)
    return {
      ok: true,
      provider: providerId,
      model: modelId,
      override: merged,
      profile: enriched.profile,
      provenance: enriched.provenance,
      meta: enriched.meta,
      warnings: enriched.warnings,
    }
  }

  /** Remove one stored override and re-enrich the live profile. */
  async _resetOverride(req) {
    await this._ensureReady()
    const snapshot = readPiAiSnapshot(this.deps)
    if (!snapshot.available) {
      throw new ApiManagerError('config-unavailable', snapshot.error ?? 'the llm-pi-ai configuration is not available')
    }
    const providerId = requiredString(req.provider, 'provider')
    validateCustomProviderId(providerId, snapshot.configurableProviders)
    const profile = snapshot.providers[providerId]
    if (!isPlainObject(profile)) {
      throw new ApiManagerError('provider-not-found', `provider "${providerId}" is not configured`, { provider: providerId })
    }
    const modelId = requiredString(req.model ?? req.modelId, 'model')
    const existingModel = (Array.isArray(profile.models) ? profile.models : []).find(model => model.id === modelId)
    if (!isPlainObject(existingModel)) {
      throw new ApiManagerError('model-not-found', `model "${modelId}" is not configured on provider "${providerId}"`, { provider: providerId, model: modelId })
    }
    const stored = await this._readProviderOverrideModels(providerId)
    const storedDelta = isPlainObject(stored[modelId]) ? stored[modelId] : {}
    const hadOverride = Object.keys(storedDelta).length > 0
    let enriched = null
    if (hadOverride) {
      await this._writeOverrideDelta(providerId, modelId, undefined)
      // The configured profile still carries the values the removed override
      // wrote; dropping those managed fields lets metadata and defaults answer.
      const configured = { ...cloneValue(existingModel) }
      const hadUpstream = typeof storedDelta.upstreamModel === 'string' && storedDelta.upstreamModel.trim().length > 0
      for (const field of MANAGED_MODEL_FIELDS) {
        if (Object.hasOwn(storedDelta, field) || (hadUpstream && field !== 'name')) delete configured[field]
      }
      enriched = enrichModel({
        id: modelId,
        configured,
        api: profile.api,
        presetId: presetIdForApi(profile.api),
        routeCompat: isPlainObject(profile.compat) ? profile.compat : undefined,
        registryCache: this.registryCache,
      })
      const nextProfile = {
        ...cloneValue(profile),
        models: (Array.isArray(profile.models) ? profile.models : []).map(model => (model.id === modelId ? enriched.profile : model)),
      }
      await this._commitPiAiProfile(providerId, nextProfile)
    }
    return {
      ok: true,
      provider: providerId,
      model: modelId,
      removed: hadOverride,
      profile: enriched === null ? existingModel : enriched.profile,
      provenance: enriched === null ? null : enriched.provenance,
      meta: enriched === null ? null : enriched.meta,
      warnings: enriched === null ? [] : enriched.warnings,
    }
  }

  /** Import provider definitions and move literal keys into the credential seam. */
  async _importConfig(req) {
    await this._ensureReady()
    const snapshot = readPiAiSnapshot(this.deps)
    if (!snapshot.available) {
      throw new ApiManagerError('config-unavailable', snapshot.error ?? 'the llm-pi-ai configuration is not available')
    }
    if (req.payload === undefined || req.payload === null) {
      throw new ApiManagerError('invalid-request', 'importConfig needs a payload')
    }
    const format = optionalString(req.format) ?? 'auto'
    if (format !== 'auto' && !IMPORT_FORMATS.includes(format)) {
      throw new ApiManagerError('unsupported-import-format', `format must be "auto" or one of ${IMPORT_FORMATS.join(', ')}`, { format })
    }
    const imported = importThirdPartyConfig(req.payload, {
      format,
      configurableProviders: snapshot.configurableProviders,
    })
    const warnings = imported.warnings.map(warning => this._redact(warning))
    const credentialsStored = []
    for (const pending of imported.pendingSecrets) {
      try {
        this._rememberSecret(pending.secret)
        await setCredential(this.deps, pending.apiKeyEnv, pending.secret)
        credentialsStored.push({ providerId: pending.providerId, apiKeyEnv: pending.apiKeyEnv })
      } catch (error) {
        warnings.push(this._redact(`the credential for "${pending.providerId}" was not stored: ${messageOf(error)}`))
      }
    }
    const providers = []
    const failed = []
    for (const [providerId, rawProfile] of Object.entries(imported.providers)) {
      try {
        const profile = cloneValue(rawProfile)
        if (typeof profile.name === 'string' && profile.displayName === undefined) profile.displayName = profile.name
        delete profile.name
        if (profile.displayName === undefined) profile.displayName = providerId
        validateProviderProfile(providerId, profile, snapshot.configurableProviders)
        await this._commitPiAiProfile(providerId, profile)
        providers.push({ provider: providerId, modelCount: profile.models.length })
      } catch (error) {
        failed.push({
          provider: providerId,
          code: error instanceof ApiManagerError ? error.code : 'import-failed',
          message: this._redact(messageOf(error)),
        })
      }
    }
    return {
      ok: true,
      format: imported.format,
      importedCount: providers.length,
      providers,
      failed,
      skippedReserved: imported.skippedReserved,
      credentialsStored,
      warnings,
    }
  }
}

Object.defineProperty(ApiManagerService.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze(REMOTE_METHODS.map(method => Object.freeze({
      method,
      invocation: Object.freeze({ kind: 'direct' }),
    }))),
  }),
})

/** Tool result envelope: `data` is omitted when the action produced none. */
function toolResult(ok, summary, data) {
  return data === undefined ? { ok, summary } : { ok, summary, data }
}

/** Map one service failure envelope to a tool result. */
function toolFailure(result) {
  return toolResult(false, `xiaoxing_api_manager: ${result.code}: ${result.message}`)
}

/** Whether a service answer is its failure envelope. */
function isFailure(result) {
  return isPlainObject(result) && result.ok === false
}

/** Build the sync policy object a tool call carries. */
function toolSyncPolicy(args) {
  const policy = {}
  for (const field of SYNC_POLICY_FIELDS) {
    if (args[field] !== undefined) policy[field] = args[field]
  }
  return Object.keys(policy).length === 0 ? undefined : policy
}

/** Build the `xiaoxing_api_manager` tool definition. */
function createApiManagerTool(service) {
  return {
    name: 'xiaoxing_api_manager',
    description: 'Manage custom API providers for DeepSeek Harness: onboard and edit routes, enrich model metadata, audit and probe endpoints, sync models live, choose defaults, and import/export sanitized configuration. API keys are stored in the credential store and never returned.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [...REMOTE_METHODS],
          description: 'Operation to perform.',
        },
        provider: { type: 'string', description: 'Custom provider route id (lowercase letters, digits, hyphens).' },
        displayName: { type: 'string', description: 'Provider label shown in model pickers.' },
        baseURL: { type: 'string', description: 'Provider endpoint root, for example https://relay.example/v1.' },
        api: { type: 'string', enum: [...SUPPORTED_PROTOCOLS], description: 'Wire protocol the route speaks.' },
        presetId: { type: 'string', description: 'Gateway preset supplying conservative defaults; see the presets action.' },
        apiKey: { type: 'string', description: 'Write-only API key stored in the credential store; it is never written to configuration or returned.' },
        apiKeyEnv: { type: 'string', description: 'Environment-variable name holding the key; a name is derived from the provider id when omitted.' },
        headers: { type: 'object', description: 'Extra non-secret request headers.' },
        compat: { type: 'object', description: 'Optional route-level pi-ai wire compatibility switches (e.g. supportsDeveloperRole, maxTokensField, thinkingFormat).' },
        models: {
          type: 'array',
          description: 'Model entries to save or enrich: objects with an id plus optional capability fields, or bare ids.',
          items: { oneOf: [{ type: 'string' }, { type: 'object' }] },
        },
        modelId: { type: 'string', description: 'Model id for probe, setDefaults, saveOverride, or resetOverride.' },
        override: { type: 'object', description: 'Sparse per-model override layered above discovery and catalog metadata (also accepts upstreamModel to bind an unmatched model to a reference upstream model id).' },
        reset: { type: 'array', items: { type: 'string' }, description: 'Override field names to clear when saving; omit to keep the stored delta.' },
        syncMode: {
          type: 'string',
          enum: [...SYNC_MODES],
          description: 'Automatic sync mode of the route: add-new (default) appends models the endpoint newly lists, mirror also removes models it no longer lists, manual turns automatic sync off. A direct syncProviderModels call still applies additions under manual unless autoApply is false.',
        },
        syncCooldownMs: { type: 'integer', description: 'Minimum interval between live syncs of one provider.' },
        includePatterns: { type: 'array', items: { type: 'string' }, description: 'Model-id patterns to keep on sync: substring, glob, or /regex/.' },
        excludePatterns: { type: 'array', items: { type: 'string' }, description: 'Model-id patterns to skip on sync.' },
        ignoredModels: { type: 'array', items: { type: 'string' }, description: 'Exact model ids sync must never add back; saving a route that carries one of them removes it from this list.' },
        includeNonChat: { type: 'boolean', description: 'Keep embedding, rerank, and media models during discovery.' },
        syncToSubagentAllowed: { type: 'boolean', description: 'Authorize newly synced models for subagent delegation.' },
        force: { type: 'boolean', description: 'Bypass the sync cooldown.' },
        autoApply: { type: 'boolean', description: 'Apply a sync result instead of only previewing it; defaults to true.' },
        splitByProtocol: { type: 'boolean', description: 'Split a mixed-protocol relay into one route per protocol.' },
        setAsDefault: {
          oneOf: [
            { type: 'boolean' },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                model: { type: 'string', description: 'Model id to make the default.' },
                reasoningEffort: { type: 'string', description: 'Reasoning effort saved with the default.' },
              },
              required: ['model'],
            },
          ],
          description: 'Make a saved model the agent default; true picks the first model.',
        },
        reasoningEffort: { type: 'string', description: 'Reasoning effort saved with the default selection.' },
        addToSubagent: {
          oneOf: [
            { type: 'boolean' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Model ids to authorize for subagent delegation; true authorizes every saved model.',
        },
        enableSubagent: { type: 'boolean', description: 'Enable subagent model selection after authorizing routes.' },
        removeCredential: { type: 'boolean', description: 'Delete the stored API key of the provider.' },
        format: {
          type: 'string',
          enum: ['auto', ...IMPORT_FORMATS],
          description: 'Config document format; auto-detected when omitted.',
        },
        payload: {
          oneOf: [{ type: 'string' }, { type: 'object' }],
          description: 'Config document or JSON/YAML text to import.',
        },
        offlineOnly: { type: 'boolean', description: 'Refresh registry data without network access.' },
        modelsDevUrl: { type: 'string', description: 'Override the models.dev registry feed URL.' },
        openRouterUrl: { type: 'string', description: 'Override the OpenRouter registry feed URL.' },
        checks: {
          type: 'array',
          items: { type: 'string', enum: [...PROBE_CHECKS] },
          description: 'Endpoint checks to run; defaults to every check.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          data: { type: 'object' },
        },
        required: ['ok', 'summary'],
      },
      render: (args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const request = asRequest(args)
      const action = typeof request.action === 'string' ? request.action : ''
      const signal = exec?.signal
      try {
        switch (action) {
          case 'status': {
            const result = await service.status({})
            if (isFailure(result)) return toolFailure(result)
            const selection = result.defaultSelection
            return toolResult(
              true,
              `API provider manager: llm-pi-ai ${result.available ? 'available' : 'unavailable'}; ${result.customProviderCount} custom route(s), ${result.reservedProviderCount} reserved; default ${selection.provider ?? '(none)'}/${selection.model ?? '(none)'}; subagent selection ${result.subagentSelection.enabled ? 'enabled' : 'disabled'}; registry ${result.registry === null ? 'unavailable' : `${result.registry.modelCount} model(s)`}.`,
              result,
            )
          }
          case 'presets': {
            const result = await service.presets({})
            if (isFailure(result)) return toolFailure(result)
            return toolResult(true, `${result.presets.length} provider preset(s); protocols: ${result.protocols.join(', ')}.`, result)
          }
          case 'listCustomProviders': {
            const result = await service.listCustomProviders({})
            if (isFailure(result)) return toolFailure(result)
            const rows = result.providers.map(entry => {
              const credential = entry.credential === null
                ? 'no credential'
                : entry.credential.configured ? 'credential configured' : 'credential missing'
              return `${entry.provider} (${entry.api ?? 'unset'}, ${entry.modelCount} model(s), ${credential})`
            })
            return toolResult(true, `${result.providers.length} custom route(s)${rows.length === 0 ? '' : `: ${rows.join('; ')}`}; ${result.reservedProviders.length} reserved route(s) ignored.`, result)
          }
          case 'discover': {
            const result = await service.discover({
              provider: request.provider,
              baseURL: request.baseURL,
              api: request.api,
              apiKey: request.apiKey,
              apiKeyEnv: request.apiKeyEnv,
              headers: request.headers,
              includeNonChat: request.includeNonChat,
              signal,
            })
            if (isFailure(result)) return toolFailure(result)
            const suggested = result.suggestedBaseURL === undefined ? '' : `; suggested base URL ${result.suggestedBaseURL}`
            return toolResult(true, `Discovered ${result.models.length} model(s) via ${result.api} at ${result.url} in ${result.latencyMs} ms${suggested}.`, result)
          }
          case 'enrich': {
            const result = await service.enrich({
              provider: request.provider,
              models: request.models,
              modelId: request.modelId,
              api: request.api,
              presetId: request.presetId,
            })
            if (isFailure(result)) return toolFailure(result)
            const warnings = result.models.reduce((total, model) => total + model.warnings.length, 0)
            return toolResult(true, `Enriched ${result.models.length} model(s) for api ${result.api} with preset ${result.presetId}; ${warnings} warning(s).`, result)
          }
          case 'audit': {
            const result = await service.audit({ provider: request.provider })
            if (isFailure(result)) return toolFailure(result)
            return toolResult(true, result.summary.message, result)
          }
          case 'probe': {
            const result = await service.probe({
              provider: request.provider,
              baseURL: request.baseURL,
              api: request.api,
              apiKey: request.apiKey,
              apiKeyEnv: request.apiKeyEnv,
              headers: request.headers,
              modelId: request.modelId,
              checks: request.checks,
              signal,
            })
            if (isFailure(result)) return toolFailure(result)
            const recommendations = Object.keys(result.recommendedCompat).length
            const checked = result.checks === undefined ? 0 : Object.keys(result.checks).length
            return toolResult(true, `Probe ${result.healthy ? 'passed' : 'failed'} for ${result.provider ?? result.baseURL}: ${checked} check(s), ${recommendations} recommendation(s), ${result.warnings.length} warning(s).`, result)
          }
          case 'upsertProvider': {
            const result = await service.upsertProvider({
              provider: request.provider,
              displayName: request.displayName,
              baseURL: request.baseURL,
              api: request.api,
              presetId: request.presetId,
              apiKey: request.apiKey,
              apiKeyEnv: request.apiKeyEnv,
              headers: request.headers,
              compat: request.compat,
              models: request.models,
              splitByProtocol: request.splitByProtocol,
              syncPolicy: toolSyncPolicy(request),
              setAsDefault: request.setAsDefault,
              reasoningEffort: request.reasoningEffort,
              addToSubagent: request.addToSubagent,
              enableSubagent: request.enableSubagent,
              removeCredential: request.removeCredential,
            })
            if (isFailure(result)) return toolFailure(result)
            const split = result.split ? ` as ${result.groups.length} protocol routes` : ''
            const stored = result.credentialStored ? '; API key stored in the credential store' : ''
            const removed = result.credentialRemoved ? '; stored API key removed' : ''
            return toolResult(true, `Saved provider "${result.provider}" (${result.created ? 'created' : 'updated'}) with ${result.modelCount} model(s)${split}${stored}${removed}.`, result)
          }
          case 'removeProvider': {
            const result = await service.removeProvider({ provider: request.provider, removeCredential: request.removeCredential })
            if (isFailure(result)) return toolFailure(result)
            return toolResult(true, `Removed provider "${result.provider}"${result.credentialRemoved ? ' and its stored API key' : ''}.`, result)
          }
          case 'syncProviderModels': {
            const result = await service.syncProviderModels({
              provider: request.provider,
              force: request.force,
              mode: request.syncMode,
              autoApply: request.autoApply,
              signal,
            })
            if (isFailure(result)) return toolFailure(result)
            const summary = result.source === 'cooldown-cache'
              ? `Provider "${result.provider}" was synced recently; ${result.models.length} configured model(s) kept.`
              : result.source === 'fallback-configured'
                ? `Provider "${result.provider}" sync skipped: ${result.warning}`
                : result.source === 'preview'
                  ? `Sync preview for "${result.provider}" (manual): +${result.diff.added.length} added, -${result.diff.removed.length} removed, ${result.diff.unchanged} unchanged.`
                  : result.applied
                    ? `Synced provider "${result.provider}" (${result.mode}): +${result.diff.added.length} added, -${result.diff.removed.length} removed, ${result.diff.unchanged} unchanged; ${result.models.length} model(s).`
                    : `Provider "${result.provider}" is unchanged; ${result.models.length} model(s).`
            return toolResult(true, summary, result)
          }
          case 'syncAllCustomProviders': {
            const result = await service.syncAllCustomProviders({
              force: request.force,
              autoApply: request.autoApply,
            })
            if (isFailure(result)) return toolFailure(result)
            return toolResult(true, `Synced ${result.syncedCount} provider(s): ${result.updatedCount} updated, ${result.failureCount} failed, ${result.warningCount} warning(s).`, result)
          }
          case 'setSyncPolicy': {
            const result = await service.setSyncPolicy({
              provider: request.provider,
              policy: toolSyncPolicy(request),
            })
            if (isFailure(result)) return toolFailure(result)
            const policy = result.syncPolicy
            return toolResult(true, `Sync policy for "${result.provider}": ${policy.syncMode}, cooldown ${policy.syncCooldownMs} ms, subagent sync ${policy.syncToSubagentAllowed ? 'on' : 'off'}.`, result)
          }
          case 'setDefaults': {
            const result = await service.setDefaults({
              provider: request.provider,
              model: request.modelId,
              reasoningEffort: request.reasoningEffort,
              enableSubagent: request.enableSubagent,
              addToSubagent: request.addToSubagent,
            })
            if (isFailure(result)) return toolFailure(result)
            const selection = result.defaultSelection
            const subagent = result.subagentSelection
            return toolResult(true, `Default model ${selection.provider ?? '(none)'}/${selection.model ?? '(none)'}${selection.reasoningEffort === null ? '' : ` (effort ${selection.reasoningEffort})`}; subagent selection ${subagent.enabled ? 'enabled' : 'disabled'} with ${subagent.allowedModels.length} route(s).`, result)
          }
          case 'saveOverride': {
            const result = await service.saveOverride({
              provider: request.provider,
              model: request.modelId,
              override: request.override,
              reset: request.reset,
            })
            if (isFailure(result)) return toolFailure(result)
            return toolResult(true, `Saved override for "${result.provider}/${result.model}": ${Object.keys(result.override).join(', ')}; the live route was re-enriched.`, result)
          }
          case 'resetOverride': {
            const result = await service.resetOverride({ provider: request.provider, model: request.modelId })
            if (isFailure(result)) return toolFailure(result)
            return toolResult(true, `Reset overrides for "${result.provider}/${result.model}"${result.removed ? '' : ' (none were stored)'}.`, result)
          }
          case 'getRegistryStatus': {
            const result = await service.getRegistryStatus({})
            if (isFailure(result)) return toolFailure(result)
            return toolResult(true, `Registry cache: ${result.modelCount} model(s), checked ${result.checkedAt ?? '(never)'}${result.stale ? ', stale' : ''}; offline-only ${result.offlineOnly}.`, result)
          }
          case 'refreshRegistry': {
            const result = await service.refreshRegistry({
              force: request.force,
              offlineOnly: request.offlineOnly,
              modelsDevUrl: request.modelsDevUrl,
              openRouterUrl: request.openRouterUrl,
            })
            if (isFailure(result)) return toolFailure(result)
            return toolResult(true, `Registry refreshed: ${result.modelCount} model(s), ${result.updated ? 'updated' : 'unchanged'}, ${result.warnings.length} warning(s).`, result)
          }
          case 'importConfig': {
            const result = await service.importConfig({ payload: request.payload, format: request.format })
            if (isFailure(result)) return toolFailure(result)
            return toolResult(true, `Imported ${result.importedCount} provider(s) from ${result.format}; ${result.credentialsStored.length} credential(s) stored, ${result.skippedReserved.length} reserved skipped, ${result.failed.length} failed, ${result.warnings.length} warning(s).`, result)
          }
          case 'exportConfig': {
            const result = await service.exportConfig({
              providerIds: request.provider === undefined ? undefined : [request.provider],
              includeSyncPolicy: true,
            })
            if (isFailure(result)) return toolFailure(result)
            return toolResult(true, `Exported ${result.count} provider(s) as ${result.format} with credentials removed.`, result)
          }
          default:
            return toolResult(false, `xiaoxing_api_manager: invalid-action: unknown action ${JSON.stringify(action)}`)
        }
      } catch (error) {
        if (error instanceof ApiManagerError) return toolFailure(error)
        return toolResult(false, `xiaoxing_api_manager failed: ${redactSecretText(messageOf(error))}`)
      }
    },
  }
}

/**
 * Resolve the plugin data directory from config, then the profile home.
 * @param {Record<string, unknown>} config - plugin row config.
 * @param {object} ctx - owning plugin context.
 * @returns {string} the absolute data directory.
 * @throws {ApiManagerError} `invalid-config` when no directory can be resolved.
 */
function resolveDataDir(config, ctx) {
  const configured = optionalString(config.dataDir)
  if (configured !== undefined) return resolve(configured)
  const home = optionalString(ctx.get?.('profileContext')?.home) ?? optionalString(process.env.DSH_HOME)
  if (home === undefined) {
    throw new ApiManagerError('invalid-config', 'dataDir is required when DSH_HOME is unavailable')
  }
  return join(resolve(home), 'xiaoxing', 'api-manager')
}

/**
 * Read the plugin row config defensively; the bundle declares no Config schema.
 * @param {unknown} config - plugin row config.
 * @param {object} ctx - owning plugin context.
 * @returns {{ dataDir: string, timeoutMs: number, syncCooldownMs: number, autoSyncIntervalMs: number,
 *   autoSyncInitialDelayMs: number }} the validated settings.
 * @throws {ApiManagerError} `invalid-config` for an invalid field or missing data directory.
 */
function readConfig(config, ctx) {
  const raw = isPlainObject(config) ? config : {}
  return {
    dataDir: resolveDataDir(raw, ctx),
    timeoutMs: positiveInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs'),
    syncCooldownMs: nonNegativeInteger(raw.syncCooldownMs, DEFAULT_SYNC_COOLDOWN_MS, 'syncCooldownMs'),
    autoSyncIntervalMs: Math.min(
      nonNegativeInteger(raw.autoSyncIntervalMs, DEFAULT_AUTO_SYNC_INTERVAL_MS, 'autoSyncIntervalMs'),
      MAX_TIMER_DELAY_MS,
    ),
    autoSyncInitialDelayMs: Math.min(
      nonNegativeInteger(raw.autoSyncInitialDelayMs, DEFAULT_AUTO_SYNC_INITIAL_DELAY_MS, 'autoSyncInitialDelayMs'),
      MAX_TIMER_DELAY_MS,
    ),
  }
}

/** Required services. */
export const inject = ['tools']

/**
 * Register the provider manager service and the `xiaoxing_api_manager` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context.
 * @param {unknown} config - plugin row config, read defensively.
 */
export function apply(ctx, config) {
  const settings = readConfig(config, ctx)
  const service = new ApiManagerService({
    dataDir: settings.dataDir,
    timeoutMs: settings.timeoutMs,
    syncCooldownMs: settings.syncCooldownMs,
    deps: {
      getSettings: () => ctx.get('settings'),
      getEditor: () => ctx.get('configEditor'),
      getCredentials: () => ctx.get('credentials'),
      getLlm: () => ctx.get('llm'),
      getAgentDefaultModel: () => ctx.get('agentDefaultModel'),
      getLaunchEnvironment: () => ctx.get('launchEnvironment'),
      emitSynced: payload => ctx.emit('xiaoxing-api-manager/models-synced', payload),
      log: message => ctx.logger?.warn?.(message),
    },
  })
  ctx.effect(() => ctx.provide(SERVICE_KEY, service), 'xiaoxing-api-manager.provide')
  const tool = createApiManagerTool(service)
  ctx.effect(() => ctx.tools.register(tool), 'xiaoxing-api-manager.tool')
  ctx.effect(() => {
    void service.initialize().catch(error => {
      ctx.logger?.warn?.(`xiaoxing-api-manager initialization failed: ${redactSecretText(messageOf(error))}`)
    })
    return () => service.dispose()
  }, 'xiaoxing-api-manager.lifecycle')
  ctx.effect(() => {
    // Automatic sync is a background duty of the Host, not a button: one run
    // shortly after startup, then one per interval. `autoSyncIntervalMs: 0`
    // turns the whole schedule off.
    if (settings.autoSyncIntervalMs === 0) return undefined
    let running = false
    const tick = () => {
      if (running) return
      running = true
      service.runBackgroundMaintenance()
        .catch(error => {
          ctx.logger?.warn?.(`xiaoxing-api-manager background sync failed: ${redactSecretText(messageOf(error))}`)
        })
        .finally(() => { running = false })
    }
    // Unreferenced timers never keep the Host process alive on their own.
    const first = setTimeout(tick, settings.autoSyncInitialDelayMs)
    first.unref?.()
    const interval = setInterval(tick, settings.autoSyncIntervalMs)
    interval.unref?.()
    return () => {
      clearTimeout(first)
      clearInterval(interval)
    }
  }, 'xiaoxing-api-manager.auto-sync')
}
