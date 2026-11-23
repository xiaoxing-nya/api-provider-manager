/**
 * DSH configuration and credential synchronization for the provider manager.
 *
 * The manager never rewrites a profile file itself: custom pi-ai routes live in
 * the `llm-pi-ai` settings namespace, the agent default model in
 * `agent-default-model`, and the subagent allowlist in
 * `subagent-model-selection-settings`. Each write goes through the settings
 * seam (`describe`/`mutate`) so a concurrent editor is refused rather than
 * overwritten, with the configuration editor (`configuration`/`edit`) as the
 * fallback for compositions without the settings service.
 *
 * Credentials stay in the credential seam. A profile carries only an
 * `apiKeyEnv` reference; `setCredential` stores the value, `describeCredential`
 * returns presence and a mask, and `resolveCredential` exists solely for the
 * manager's own endpoint requests. No function here returns a secret.
 * @module @xiaoxing/api-provider-manager/config-sync
 */

import { ApiManagerError, messageOf, redactSecretText } from './errors.js'
import { maskSecret } from './importer.js'
import { validateProviderProfile } from './presets.js'
import { checkReservedProviderId, validateCredentialRef, validateCustomProviderId } from './reserved.js'

/** Settings namespace and package name of the pi-ai provider profile entry. */
export const LLM_PI_AI_ID = 'llm-pi-ai'
/** Package name that owns {@link LLM_PI_AI_ID}. */
export const LLM_PI_AI_PKG = '@deepseek-ai/dsh-llm-pi-ai'
/** Settings namespace and package name of the agent default model entry. */
export const DEFAULT_MODEL_ID = 'agent-default-model'
/** Package name that owns {@link DEFAULT_MODEL_ID}. */
export const DEFAULT_MODEL_PKG = '@deepseek-ai/dsh-agent-default-model'
/** Settings namespace and package name of the subagent model-selection entry. */
export const SUBAGENT_SETTINGS_ID = 'subagent-model-selection-settings'
/** Package name that owns {@link SUBAGENT_SETTINGS_ID}. */
export const SUBAGENT_SETTINGS_PKG = '@deepseek-ai/dsh-tool-subagent/model-selection-settings'

/** Printable ASCII without leading or trailing whitespace, usable in a header. */
const API_KEY_PATTERN = /^[\x20-\x7E]+$/u

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
 * Deep-copy one configuration value without cloning functions or symbols.
 * @param {unknown} value - value to copy.
 * @returns {unknown} the detached copy.
 */
function cloneConfigValue(value) {
  if (Array.isArray(value)) return value.map(cloneConfigValue)
  if (!isPlainObject(value)) return value
  const copy = {}
  for (const [key, child] of Object.entries(value)) copy[key] = cloneConfigValue(child)
  return copy
}

/**
 * Merge two configuration layers: plain objects merge recursively and every
 * other value replaces the lower layer wholesale.
 * @param {unknown} under - lower layer.
 * @param {unknown} over - higher layer.
 * @returns {Record<string, unknown>} the merged layer.
 */
function mergeConfigLayers(under, over) {
  const lower = isPlainObject(under) ? under : {}
  const higher = isPlainObject(over) ? over : {}
  const merged = cloneConfigValue(lower)
  for (const [key, value] of Object.entries(higher)) {
    const existing = merged[key]
    merged[key] = isPlainObject(existing) && isPlainObject(value)
      ? mergeConfigLayers(existing, value)
      : cloneConfigValue(value)
  }
  return merged
}

/**
 * Read one optional non-empty string field.
 * @param {unknown} value - candidate value.
 * @returns {string | undefined} the trimmed string, or `undefined`.
 */
function optionalString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Read one required non-empty string field.
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
 * Read the configurable-provider directory from the LLM seam.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @returns {object[]} declared configurable providers, or an empty array.
 */
function configurableProvidersOf(deps) {
  const llm = deps.getLlm?.()
  if (llm === undefined || llm === null || typeof llm.listConfigurableProviders !== 'function') return []
  try {
    const listed = llm.listConfigurableProviders()
    return Array.isArray(listed) ? listed : []
  } catch {
    // The directory is optional diagnostic input; a throwing seam must not
    // block reading the configured profiles themselves.
    return []
  }
}

/**
 * Match one settings descriptor or configuration row against a target entry.
 *
 * The settings descriptor names its entry in `ns`; a configuration row names it
 * in `entry.options`. Both spellings are accepted so one lookup serves either
 * seam and the package name can still identify a row whose id was overridden.
 * @param {unknown} entry - descriptor or configuration row.
 * @param {string} targetId - settings namespace id to match.
 * @param {string} packageName - owning package name to match.
 * @returns {boolean} whether the entry is the target.
 */
function entryMatches(entry, targetId, packageName) {
  if (!isPlainObject(entry)) return false
  if (isPlainObject(entry.entry)) return entryMatches(entry.entry, targetId, packageName)
  const options = isPlainObject(entry.options) ? entry.options : undefined
  const id = typeof options?.id === 'string' ? options.id : typeof entry.ns === 'string' ? entry.ns : undefined
  const name = typeof options?.name === 'string' ? options.name : undefined
  return id === targetId || name === packageName
}

/**
 * Find one configuration row in the configuration editor.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @param {string} targetId - settings namespace id to match.
 * @param {string} packageName - owning package name to match.
 * @returns {object | undefined} the matching `{ entry, inherited, override }` row.
 */
function findEditorRow(deps, targetId, packageName) {
  const editor = deps.getEditor?.()
  if (editor === undefined || editor === null || typeof editor.configuration !== 'function') return undefined
  let rows
  try {
    rows = editor.configuration()
  } catch {
    return undefined
  }
  if (!Array.isArray(rows)) return undefined
  for (const row of rows) {
    if (!isPlainObject(row) || !entryMatches(row.entry, targetId, packageName)) continue
    return row
  }
  return undefined
}

/**
 * Locate one settings namespace through the settings seam or the configuration editor.
 *
 * Settings descriptors are preferred because they carry the resolved value and
 * the revision a conflict-checked write needs. A deployment without the
 * settings service (or without a volatile form for the entry) falls back to the
 * configuration editor, whose rows carry the raw entry config.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @param {string} targetId - settings namespace id to match.
 * @param {string} packageName - owning package name to match.
 * @returns {{ source: 'settings' | 'editor', entry: object, row: object | null, ns: string,
 *   revision: number | undefined } | undefined} the located namespace, or `undefined`.
 */
export function findNamespaceEntry(deps, targetId, packageName) {
  const settings = deps.getSettings?.()
  if (settings !== undefined && settings !== null && typeof settings.describe === 'function') {
    let described
    try {
      described = settings.describe({ redactSecrets: false })
    } catch {
      described = undefined
    }
    const list = Array.isArray(described)
      ? described
      : isPlainObject(described) && Array.isArray(described.namespaces)
        ? described.namespaces
        : []
    for (const entry of list) {
      if (!entryMatches(entry, targetId, packageName)) continue
      if (isPlainObject(entry.entry)) {
        const rowOptions = isPlainObject(entry.entry.options) ? entry.entry.options : {}
        return {
          source: 'editor',
          entry: entry.entry,
          row: entry,
          ns: typeof rowOptions.id === 'string' ? rowOptions.id : targetId,
          revision: typeof entry.revision === 'number' ? entry.revision : undefined,
        }
      }
      const options = isPlainObject(entry.options) ? entry.options : undefined
      const ns = typeof options?.id === 'string' ? options.id : typeof entry.ns === 'string' ? entry.ns : targetId
      return {
        source: 'settings',
        entry,
        row: null,
        ns,
        revision: typeof entry.revision === 'number' ? entry.revision : undefined,
      }
    }
  }
  const row = findEditorRow(deps, targetId, packageName)
  if (row === undefined) return undefined
  const options = isPlainObject(row.entry?.options) ? row.entry.options : {}
  const ns = typeof options.id === 'string' ? options.id : targetId
  return {
    source: 'editor',
    entry: row.entry,
    row,
    ns,
    revision: typeof row.revision === 'number' ? row.revision : undefined,
  }
}

/**
 * Read one namespace's configured values as the manager should see them.
 *
 * A settings descriptor exposes the raw user layer beside the composed base
 * layer; those two are merged so schema defaults never leak into a profile the
 * manager writes back. Without those layers the resolved value is used.
 * @param {object} found - result of {@link findNamespaceEntry}.
 * @returns {Record<string, unknown>} the configured section.
 */
function readNamespaceConfig(found) {
  if (found.source === 'settings') {
    const entry = found.entry
    const base = isPlainObject(entry.base) ? entry.base : undefined
    const user = isPlainObject(entry.user) ? entry.user : undefined
    if (base !== undefined || user !== undefined) return mergeConfigLayers(base, user)
    return isPlainObject(entry.value) ? cloneConfigValue(entry.value) : {}
  }
  const row = found.row
  const own = isPlainObject(row?.entry?.options?.config) ? row.entry.options.config : {}
  const inherited = isPlainObject(row?.inherited) ? row.inherited : {}
  return mergeConfigLayers(inherited, own)
}

/**
 * Read one namespace's configured values with the resolved value as the lowest
 * layer, for small flat namespaces whose resolved view may carry a route the
 * raw profile layers do not (a home patch, for example).
 * @param {object} found - result of {@link findNamespaceEntry}.
 * @returns {Record<string, unknown>} the configured section.
 */
function readFlatNamespaceConfig(found) {
  const config = readNamespaceConfig(found)
  if (found.source !== 'settings' || !isPlainObject(found.entry.value)) return config
  return mergeConfigLayers(found.entry.value, config)
}

/**
 * Map one settings/editor write failure to the manager's failure taxonomy.
 * @param {unknown} error - thrown write failure.
 * @param {string} label - human-readable target, for diagnostics.
 * @returns {ApiManagerError} the mapped failure.
 */
function mapWriteError(error, label) {
  const code = isPlainObject(error) && typeof error.code === 'string' ? error.code : undefined
  if (code === 'SETTINGS_CONFLICT' || error?.name === 'SettingsConflictError') {
    const expected = typeof error?.expected === 'number' ? error.expected : undefined
    const actual = typeof error?.actual === 'number' ? error.actual : undefined
    return new ApiManagerError(
      'config-conflict',
      `${label} changed since it was read; reload the settings page and retry`,
      { expected: expected ?? null, actual: actual ?? null },
    )
  }
  return new ApiManagerError(
    'config-write-failed',
    `${label} could not be updated: ${redactSecretText(messageOf(error))}`,
  )
}

/**
 * Write one settings namespace through the settings seam, falling back to the
 * configuration editor when no writable settings service exists.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @param {object} found - result of {@link findNamespaceEntry}.
 * @param {object} write - the write recipe.
 * @param {string} write.packageName - owning package name, for the editor fallback.
 * @param {object[]} write.settingsOps - path operations for `settings.mutate`.
 * @param {(current: Record<string, unknown>) => Record<string, unknown>} write.editorApply - editor mutation.
 * @param {string} write.label - human-readable target, for diagnostics.
 * @param {number} [write.expectedRevision] - revision the caller read, when it must be enforced.
 * @returns {Promise<void>} fulfillment after the write commits.
 * @throws {ApiManagerError} `config-conflict` on a stale revision, `config-write-failed`
 *   on any other write failure, `config-unavailable` when neither seam is writable.
 */
async function writeNamespace(deps, found, write) {
  const settings = deps.getSettings?.()
  if (settings !== undefined && settings !== null && typeof settings.mutate === 'function') {
    const revision = write.expectedRevision === undefined ? found.revision : write.expectedRevision
    try {
      await settings.mutate(found.ns, write.settingsOps, revision)
    } catch (error) {
      throw mapWriteError(error, write.label)
    }
    return
  }
  const editor = deps.getEditor?.()
  if (editor === undefined || editor === null || typeof editor.edit !== 'function') {
    throw new ApiManagerError(
      'config-unavailable',
      `${write.label} cannot be written: neither the settings service nor the configuration editor is available`,
    )
  }
  const rowFound = found.source === 'editor'
    ? found
    : (() => {
        const row = findEditorRow(deps, found.ns, write.packageName)
        return row === undefined
          ? undefined
          : { source: 'editor', entry: row.entry, row, ns: found.ns, revision: undefined }
      })()
  if (rowFound === undefined) {
    throw new ApiManagerError('config-unavailable', `${write.label} is not exposed by the configuration editor`)
  }
  try {
    await editor.edit(rowFound.entry, current => write.editorApply(isPlainObject(current) ? current : {}))
  } catch (error) {
    throw mapWriteError(error, write.label)
  }
}

/**
 * Read the `providers` map out of an `llm-pi-ai` section.
 * @param {unknown} config - configured section.
 * @returns {Record<string, object>} provider profiles keyed by route id.
 */
function providersOf(config) {
  return isPlainObject(config) && isPlainObject(config.providers) ? config.providers : {}
}

/**
 * Read the configured provider profiles of one `llm-pi-ai` namespace.
 *
 * Raw layers are preferred so schema defaults never leak into a profile the
 * manager writes back, while a route that exists only in the resolved value
 * (for example one supplied by a home patch) is still visible and therefore
 * editable.
 * @param {object} found - result of {@link findNamespaceEntry}.
 * @returns {Record<string, object>} provider profiles keyed by route id.
 */
function readProviderProfiles(found) {
  const providers = cloneConfigValue(providersOf(readNamespaceConfig(found)))
  if (found.source === 'settings') {
    const effective = providersOf(found.entry.value)
    for (const [provider, profile] of Object.entries(effective)) {
      if (!Object.hasOwn(providers, provider) && isPlainObject(profile)) providers[provider] = cloneConfigValue(profile)
    }
  }
  return providers
}

/**
 * Read the manager's view of the `llm-pi-ai` provider configuration.
 *
 * The snapshot is intentionally soft: a deployment that has not enabled
 * `@deepseek-ai/dsh-llm-pi-ai` reports `available: false` instead of throwing,
 * so status and audit surfaces can explain what is missing.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @returns {{ available: boolean, ns: string, revision: number | null,
 *   providers: Record<string, object>, configurableProviders: object[], error?: string }}
 *   the provider snapshot and the configurable-provider directory.
 */
export function readPiAiSnapshot(deps) {
  const configurableProviders = configurableProvidersOf(deps)
  let found
  try {
    found = findNamespaceEntry(deps, LLM_PI_AI_ID, LLM_PI_AI_PKG)
  } catch (error) {
    return {
      available: false,
      ns: LLM_PI_AI_ID,
      revision: null,
      providers: {},
      configurableProviders,
      error: redactSecretText(`the llm-pi-ai configuration could not be read: ${messageOf(error)}`),
    }
  }
  if (found === undefined) {
    return {
      available: false,
      ns: LLM_PI_AI_ID,
      revision: null,
      providers: {},
      configurableProviders,
      error: `the "${LLM_PI_AI_ID}" settings namespace is not available; enable ${LLM_PI_AI_PKG} to manage custom providers`,
    }
  }
  return {
    available: true,
    ns: found.ns,
    revision: found.revision ?? null,
    providers: readProviderProfiles(found),
    configurableProviders,
  }
}

/**
 * Split configured providers into writable custom routes and read-only reserved routes.
 *
 * Native DSH providers, installed pi-ai catalog providers, and configuration
 * entries the deployment did not declare are reserved and never modified.
 * @param {{ providers?: Record<string, object>, configurableProviders?: object[] }} snapshot - provider snapshot.
 * @returns {{ customProviders: { provider: string, profile: object }[],
 *   reservedProviders: { provider: string, category: string | null, reason: string | null }[] }}
 *   the classified providers.
 */
export function classifyProviders(snapshot) {
  const configurableProviders = Array.isArray(snapshot?.configurableProviders) ? snapshot.configurableProviders : []
  const providers = isPlainObject(snapshot?.providers) ? snapshot.providers : {}
  const customProviders = []
  const reservedProviders = []
  for (const [provider, profile] of Object.entries(providers)) {
    const verdict = checkReservedProviderId(provider, configurableProviders)
    if (verdict.reserved) {
      reservedProviders.push({ provider, category: verdict.category, reason: verdict.reason })
      continue
    }
    if (!isPlainObject(profile)) continue
    customProviders.push({ provider, profile })
  }
  return { customProviders, reservedProviders }
}

/**
 * Insert or replace one custom provider profile in the `llm-pi-ai` section.
 *
 * The profile is validated against the reserved namespaces before the write, so
 * a request that would shadow a native or catalog provider is refused even when
 * it races a configuration change. A stale revision is reported as
 * `config-conflict`.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @param {{ providerId: string, profile: object, expectedRevision?: number | null }} request - the profile write.
 * @returns {Promise<{ provider: string, profile: object, revision: number | null, source: string }>}
 *   the committed route.
 * @throws {ApiManagerError} `invalid-provider-id`, `reserved-native-provider`,
 *   `invalid-provider-profile`, `invalid-model-profile`, `invalid-credential-ref`,
 *   `config-unavailable`, `config-conflict`, or `config-write-failed`.
 */
export async function mutatePiAiProvider(deps, request) {
  const providerId = request?.providerId
  const profile = request?.profile
  const snapshot = readPiAiSnapshot(deps)
  validateCustomProviderId(providerId, snapshot.configurableProviders)
  validateProviderProfile(providerId, profile, snapshot.configurableProviders)
  const found = findNamespaceEntry(deps, LLM_PI_AI_ID, LLM_PI_AI_PKG)
  if (found === undefined) {
    throw new ApiManagerError(
      'config-unavailable',
      `the "${LLM_PI_AI_ID}" settings namespace is not available; enable ${LLM_PI_AI_PKG} to save custom providers`,
    )
  }
  const expectedRevision = request.expectedRevision === undefined || request.expectedRevision === null
    ? undefined
    : request.expectedRevision
  await writeNamespace(deps, found, {
    packageName: LLM_PI_AI_PKG,
    settingsOps: [{ op: 'set', path: ['providers', providerId], value: cloneConfigValue(profile) }],
    editorApply: current => {
      const providers = { ...providersOf(current) }
      providers[providerId] = cloneConfigValue(profile)
      return { ...current, providers }
    },
    label: `provider "${providerId}"`,
    expectedRevision,
  })
  return {
    provider: providerId,
    profile: cloneConfigValue(profile),
    revision: (expectedRevision ?? found.revision) ?? null,
    source: found.source,
  }
}

/**
 * Remove one custom provider profile from the `llm-pi-ai` section.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @param {{ providerId: string, expectedRevision?: number | null }} request - the profile removal.
 * @returns {Promise<{ provider: string, removed: boolean, revision: number | null, source: string }>}
 *   the removed route.
 * @throws {ApiManagerError} `invalid-provider-id`, `reserved-native-provider`,
 *   `config-unavailable`, `config-conflict`, or `config-write-failed`.
 */
export async function removePiAiProvider(deps, request) {
  const providerId = request?.providerId
  const snapshot = readPiAiSnapshot(deps)
  validateCustomProviderId(providerId, snapshot.configurableProviders)
  const found = findNamespaceEntry(deps, LLM_PI_AI_ID, LLM_PI_AI_PKG)
  if (found === undefined) {
    throw new ApiManagerError(
      'config-unavailable',
      `the "${LLM_PI_AI_ID}" settings namespace is not available; enable ${LLM_PI_AI_PKG} to remove custom providers`,
    )
  }
  const expectedRevision = request.expectedRevision === undefined || request.expectedRevision === null
    ? undefined
    : request.expectedRevision
  await writeNamespace(deps, found, {
    packageName: LLM_PI_AI_PKG,
    settingsOps: [{ op: 'unset', path: ['providers', providerId] }],
    editorApply: current => {
      const providers = { ...providersOf(current) }
      delete providers[providerId]
      return { ...current, providers }
    },
    label: `provider "${providerId}"`,
    expectedRevision,
  })
  return {
    provider: providerId,
    removed: true,
    revision: (expectedRevision ?? found.revision) ?? null,
    source: found.source,
  }
}

/**
 * Read a credential from the launch environment or the process environment.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @param {string} ref - environment-variable name.
 * @returns {{ value: string, source: string } | undefined} the read-only value, when one is set.
 */
function readAmbientCredential(deps, ref) {
  const launch = deps.getLaunchEnvironment?.()
  if (launch !== undefined && launch !== null && typeof launch.get === 'function') {
    let entry
    try {
      entry = launch.get(ref)
    } catch {
      entry = undefined
    }
    if (isPlainObject(entry) && typeof entry.value === 'string' && entry.value.length > 0) {
      return { value: entry.value, source: typeof entry.source === 'string' ? entry.source : 'launch-environment' }
    }
  }
  const fromProcess = process.env[ref]
  if (typeof fromProcess === 'string' && fromProcess.length > 0) return { value: fromProcess, source: 'process' }
  return undefined
}

/**
 * Describe one credential reference without exposing its value.
 *
 * With the credential seam present the seam's presence facts and masked preview
 * are returned. Without it the launch/process environment is inspected
 * read-only, so a route whose key comes from the environment still reports as
 * configured (and not writable).
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @param {unknown} ref - environment-variable name.
 * @returns {Promise<{ available: boolean, configured: boolean, writable: boolean,
 *   source: string | null, masked: string | null }>} the credential facts.
 * @throws {ApiManagerError} `invalid-credential-ref` for a malformed reference,
 *   `credential-read-failed` when the credential seam fails.
 */
export async function describeCredential(deps, ref) {
  const validatedRef = validateCredentialRef(ref)
  const credentials = deps.getCredentials?.()
  if (credentials !== undefined && credentials !== null && typeof credentials.describe === 'function') {
    let info
    try {
      info = await credentials.describe(validatedRef)
    } catch (error) {
      throw new ApiManagerError(
        'credential-read-failed',
        `credential "${validatedRef}" could not be described: ${redactSecretText(messageOf(error))}`,
      )
    }
    const configured = isPlainObject(info) && info.configured === true
    return {
      available: configured,
      configured,
      writable: isPlainObject(info) && info.writable === true,
      source: isPlainObject(info) && typeof info.source === 'string' ? info.source : null,
      masked: isPlainObject(info) && typeof info.masked === 'string' && info.masked.length > 0
        ? info.masked
        : null,
    }
  }
  const ambient = readAmbientCredential(deps, validatedRef)
  return {
    available: ambient !== undefined,
    configured: ambient !== undefined,
    writable: false,
    source: ambient === undefined ? null : ambient.source,
    masked: ambient === undefined ? null : maskSecret(ambient.value),
  }
}

/**
 * Validate one credential value before it is handed to the credential seam.
 * @param {unknown} value - candidate secret.
 * @returns {string} the validated secret.
 * @throws {ApiManagerError} `invalid-api-key` when it cannot be sent in a request header.
 */
function validateCredentialValue(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiManagerError('invalid-api-key', 'apiKey must be a non-empty string')
  }
  if (value !== value.trim() || !API_KEY_PATTERN.test(value)) {
    throw new ApiManagerError(
      'invalid-api-key',
      'apiKey must be printable ASCII without leading or trailing whitespace',
    )
  }
  return value
}

/**
 * Store one credential value in the provider-managed credential store.
 *
 * The value is written through the credential seam and never returned. Absence
 * of the seam fails loud rather than silently discarding a key the user asked
 * to save.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @param {unknown} ref - environment-variable name.
 * @param {unknown} value - the secret value, write-only.
 * @returns {Promise<{ ref: string, stored: true }>} the stored reference.
 * @throws {ApiManagerError} `invalid-credential-ref`, `invalid-api-key`,
 *   `credentials-unavailable`, or `credential-write-failed`.
 */
export async function setCredential(deps, ref, value) {
  const validatedRef = validateCredentialRef(ref)
  const secret = validateCredentialValue(value)
  const credentials = deps.getCredentials?.()
  if (credentials === undefined || credentials === null || typeof credentials.set !== 'function') {
    throw new ApiManagerError(
      'credentials-unavailable',
      'the credentials service is not available; store the API key in the environment instead',
      { ref: validatedRef },
    )
  }
  try {
    await credentials.set(validatedRef, secret)
  } catch (error) {
    throw new ApiManagerError(
      'credential-write-failed',
      `credential "${validatedRef}" could not be stored: ${redactSecretText(messageOf(error), [secret])}`,
      { ref: validatedRef },
    )
  }
  return { ref: validatedRef, stored: true }
}

/**
 * Remove one credential value from the provider-managed credential store.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @param {unknown} ref - environment-variable name.
 * @returns {Promise<{ ref: string, removed: true }>} the removed reference.
 * @throws {ApiManagerError} `invalid-credential-ref`, `credentials-unavailable`,
 *   or `credential-write-failed`.
 */
export async function unsetCredential(deps, ref) {
  const validatedRef = validateCredentialRef(ref)
  const credentials = deps.getCredentials?.()
  if (credentials === undefined || credentials === null || typeof credentials.unset !== 'function') {
    throw new ApiManagerError(
      'credentials-unavailable',
      'the credentials service is not available; the credential cannot be removed here',
      { ref: validatedRef },
    )
  }
  try {
    await credentials.unset(validatedRef)
  } catch (error) {
    throw new ApiManagerError(
      'credential-write-failed',
      `credential "${validatedRef}" could not be removed: ${redactSecretText(messageOf(error))}`,
      { ref: validatedRef },
    )
  }
  return { ref: validatedRef, removed: true }
}

/**
 * Resolve one credential for the manager's own endpoint requests.
 *
 * The returned value is for a Host-side HTTP request only: it must never be
 * placed in a Remote result, a tool result, or a log. Resolution is per call,
 * matching the credential seam's contract that a changed credential reaches the
 * next operation without a restart.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @param {unknown} ref - environment-variable name.
 * @returns {Promise<{ value: string, source: string } | undefined>} the secret and its source, or `undefined`.
 * @throws {ApiManagerError} `invalid-credential-ref` for a malformed reference,
 *   `credential-read-failed` when the credential seam fails.
 */
export async function resolveCredential(deps, ref) {
  const validatedRef = validateCredentialRef(ref)
  const credentials = deps.getCredentials?.()
  if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
    let resolved
    try {
      resolved = await credentials.resolve(validatedRef)
    } catch (error) {
      throw new ApiManagerError(
        'credential-read-failed',
        `credential "${validatedRef}" could not be resolved: ${redactSecretText(messageOf(error))}`,
      )
    }
    if (isPlainObject(resolved) && typeof resolved.value === 'string' && resolved.value.length > 0) {
      return {
        value: resolved.value,
        source: typeof resolved.source === 'string' ? resolved.source : 'credentials',
      }
    }
    return undefined
  }
  return readAmbientCredential(deps, validatedRef)
}

/**
 * Read the configured agent default model selection.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @returns {{ available: boolean, namespace: string, revision: number | null,
 *   provider: string | null, model: string | null, reasoningEffort: string | null,
 *   source: 'agent-default-model' | 'settings' | null, error: string | null }}
 *   the current default selection.
 */
export function readDefaultSelection(deps) {
  let serviceError
  const service = deps.getAgentDefaultModel?.()
  if (service !== undefined && service !== null && typeof service.currentSelection === 'function') {
    try {
      const selection = service.currentSelection()
      return {
        available: true,
        namespace: DEFAULT_MODEL_ID,
        revision: null,
        provider: optionalString(selection?.provider) ?? null,
        model: optionalString(selection?.model) ?? null,
        reasoningEffort: optionalString(selection?.reasoningEffort) ?? null,
        source: 'agent-default-model',
        error: null,
      }
    } catch (error) {
      serviceError = redactSecretText(`the agent default model service could not be read: ${messageOf(error)}`)
    }
  }
  const found = findNamespaceEntry(deps, DEFAULT_MODEL_ID, DEFAULT_MODEL_PKG)
  if (found === undefined) {
    return {
      available: false,
      namespace: DEFAULT_MODEL_ID,
      revision: null,
      provider: null,
      model: null,
      reasoningEffort: null,
      source: null,
      error: serviceError ?? `the "${DEFAULT_MODEL_ID}" settings namespace is not available; enable ${DEFAULT_MODEL_PKG}`,
    }
  }
  const config = readFlatNamespaceConfig(found)
  return {
    available: true,
    namespace: found.ns,
    revision: found.revision ?? null,
    provider: optionalString(config.provider) ?? null,
    model: optionalString(config.model) ?? null,
    reasoningEffort: optionalString(config.reasoningEffort) ?? null,
    source: 'settings',
    error: null,
  }
}

/**
 * Save the agent default model selection.
 *
 * The `agentDefaultModel` service is preferred because it owns the selection's
 * write path; the settings namespace is updated directly only when that service
 * is not mounted.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @param {{ provider: unknown, model: unknown, reasoningEffort?: unknown }} request - the selection to save.
 * @returns {Promise<object>} the selection read back after the save.
 * @throws {ApiManagerError} `invalid-request`, `config-unavailable`,
 *   `config-conflict`, `config-write-failed`, or `default-selection-failed`.
 */
export async function saveDefaultSelection(deps, request) {
  const provider = requiredString(request?.provider, 'provider')
  const model = requiredString(request?.model, 'model')
  const reasoningEffort = request?.reasoningEffort === undefined || request.reasoningEffort === null
    ? undefined
    : requiredString(request.reasoningEffort, 'reasoningEffort')
  const service = deps.getAgentDefaultModel?.()
  if (service !== undefined && service !== null && typeof service.saveSelection === 'function') {
    try {
      await service.saveSelection({
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
    } catch (error) {
      const code = isPlainObject(error) && typeof error.code === 'string' ? error.code : undefined
      if (code === 'SETTINGS_CONFLICT' || error?.name === 'SettingsConflictError') {
        throw new ApiManagerError('config-conflict', 'the agent default model changed while it was being saved; retry')
      }
      throw new ApiManagerError(
        'default-selection-failed',
        `the agent default model could not be saved: ${redactSecretText(messageOf(error))}`,
      )
    }
    return readDefaultSelection(deps)
  }
  const found = findNamespaceEntry(deps, DEFAULT_MODEL_ID, DEFAULT_MODEL_PKG)
  if (found === undefined) {
    throw new ApiManagerError(
      'config-unavailable',
      `the "${DEFAULT_MODEL_ID}" settings namespace is not available; enable ${DEFAULT_MODEL_PKG}`,
    )
  }
  const settingsOps = [
    { op: 'set', path: ['provider'], value: provider },
    { op: 'set', path: ['model'], value: model },
    reasoningEffort === undefined
      ? { op: 'unset', path: ['reasoningEffort'] }
      : { op: 'set', path: ['reasoningEffort'], value: reasoningEffort },
  ]
  await writeNamespace(deps, found, {
    packageName: DEFAULT_MODEL_PKG,
    settingsOps,
    editorApply: current => {
      const next = { ...current, provider, model }
      if (reasoningEffort === undefined) delete next.reasoningEffort
      else next.reasoningEffort = reasoningEffort
      return next
    },
    label: 'the agent default model',
  })
  return {
    available: true,
    namespace: found.ns,
    revision: found.revision === undefined ? null : found.revision + 1,
    provider,
    model,
    reasoningEffort: reasoningEffort ?? null,
    source: 'settings',
    error: null,
  }
}

/**
 * Normalize one allowed-model route for the subagent selection.
 * @param {unknown} raw - route object, `provider/model` string, or bare model id with a default provider.
 * @param {string} [defaultProvider] - provider used by string and bare-model entries.
 * @returns {{ provider: string, model: string }} the normalized route.
 * @throws {ApiManagerError} `invalid-subagent-selection` when the route is incomplete.
 */
function normalizeAllowedRoute(raw, defaultProvider) {
  let provider
  let model
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text.length === 0) throw new ApiManagerError('invalid-subagent-selection', 'allowed model entries must not be empty')
    const separator = text.indexOf('/')
    if (separator > 0 && separator < text.length - 1 && defaultProvider === undefined) {
      provider = text.slice(0, separator)
      model = text.slice(separator + 1)
    } else {
      provider = defaultProvider
      model = text
    }
  } else if (isPlainObject(raw)) {
    provider = optionalString(raw.provider)
    model = optionalString(raw.model)
  }
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) {
    throw new ApiManagerError(
      'invalid-subagent-selection',
      'an allowed model needs a non-empty provider and model id',
      { route: raw },
    )
  }
  return { provider, model }
}

/**
 * Normalize a list of allowed-model routes, rejecting duplicates.
 * @param {unknown} routes - route objects or strings.
 * @param {string} [defaultProvider] - provider used by string entries.
 * @returns {{ provider: string, model: string }[]} deduplicated routes in input order.
 * @throws {ApiManagerError} `invalid-subagent-selection` for an incomplete or repeated route.
 */
function normalizeAllowedRoutes(routes, defaultProvider) {
  if (routes === undefined || routes === null) return []
  if (!Array.isArray(routes)) {
    throw new ApiManagerError('invalid-subagent-selection', 'allowedModels must be an array of routes')
  }
  const normalized = []
  const seen = new Set()
  for (const raw of routes) {
    const route = normalizeAllowedRoute(raw, defaultProvider)
    const key = `${route.provider}\u0000${route.model}`
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(route)
  }
  return normalized
}

/**
 * Read the subagent model-selection settings.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @returns {{ available: boolean, namespace: string, revision: number | null,
 *   enabled: boolean, allowedModels: { provider: string, model: string }[], error: string | null }}
 *   the current selection policy.
 */
export function readSubagentSelection(deps) {
  const found = findNamespaceEntry(deps, SUBAGENT_SETTINGS_ID, SUBAGENT_SETTINGS_PKG)
  if (found === undefined) {
    return {
      available: false,
      namespace: SUBAGENT_SETTINGS_ID,
      revision: null,
      enabled: false,
      allowedModels: [],
      error: `the "${SUBAGENT_SETTINGS_ID}" settings namespace is not available; enable ${SUBAGENT_SETTINGS_PKG}`,
    }
  }
  const config = readFlatNamespaceConfig(found)
  let allowedModels = []
  let error = null
  try {
    allowedModels = normalizeAllowedRoutes(config.allowedModels)
  } catch (failure) {
    error = redactSecretText(`the subagent allowed-model list is invalid: ${messageOf(failure)}`)
  }
  return {
    available: true,
    namespace: found.ns,
    revision: found.revision ?? null,
    enabled: config.enabled === true,
    allowedModels,
    error,
  }
}

/**
 * Update the subagent model-selection settings.
 *
 * Enabling selection requires at least one authorized route, matching the
 * Host setting's own invariant. Routes are addressed exactly as
 * `{ provider, model }`; string entries use `defaultProvider` when supplied.
 * @param {object} deps - service dependencies supplied by `apply()`.
 * @param {object} request - the desired change.
 * @param {boolean} [request.enabled] - next enabled state.
 * @param {unknown[]} [request.allowedModels] - complete replacement route list.
 * @param {unknown[]} [request.addModels] - routes to add.
 * @param {unknown[]} [request.removeModels] - routes to remove.
 * @param {string} [request.defaultProvider] - provider applied to string routes.
 * @param {number} [request.expectedRevision] - revision the caller read.
 * @returns {Promise<object>} the selection read back after the change.
 * @throws {ApiManagerError} `config-unavailable`, `invalid-subagent-selection`,
 *   `config-conflict`, or `config-write-failed`.
 */
export async function updateSubagentSelection(deps, request = {}) {
  const current = readSubagentSelection(deps)
  if (!current.available) {
    throw new ApiManagerError(
      'config-unavailable',
      `the "${SUBAGENT_SETTINGS_ID}" settings namespace is not available; enable ${SUBAGENT_SETTINGS_PKG}`,
    )
  }
  if (request.enabled !== undefined && typeof request.enabled !== 'boolean') {
    throw new ApiManagerError('invalid-subagent-selection', 'enabled must be a boolean')
  }
  const defaultProvider = optionalString(request.defaultProvider)
  let nextEnabled = typeof request.enabled === 'boolean' ? request.enabled : current.enabled
  let nextModels = request.allowedModels === undefined
    ? [...current.allowedModels]
    : normalizeAllowedRoutes(request.allowedModels, defaultProvider)
  for (const route of normalizeAllowedRoutes(request.addModels, defaultProvider)) {
    if (!nextModels.some(existing => existing.provider === route.provider && existing.model === route.model)) {
      nextModels.push(route)
    }
  }
  const removed = normalizeAllowedRoutes(request.removeModels, defaultProvider)
  if (removed.length > 0) {
    nextModels = nextModels.filter(existing => !removed.some(
      route => route.provider === existing.provider && route.model === existing.model,
    ))
  }
  if (nextEnabled && nextModels.length === 0) {
    throw new ApiManagerError(
      'invalid-subagent-selection',
      'enabling subagent model selection requires at least one allowed model',
      { enabled: nextEnabled, allowedModels: nextModels },
    )
  }
  const changed = nextEnabled !== current.enabled
    || nextModels.length !== current.allowedModels.length
    || nextModels.some((route, index) => route.provider !== current.allowedModels[index]?.provider
      || route.model !== current.allowedModels[index]?.model)
  if (!changed) return { ...current, changed: false }
  const found = findNamespaceEntry(deps, SUBAGENT_SETTINGS_ID, SUBAGENT_SETTINGS_PKG)
  if (found === undefined) {
    throw new ApiManagerError('config-unavailable', `the "${SUBAGENT_SETTINGS_ID}" settings namespace is not available`)
  }
  const expectedRevision = request.expectedRevision === undefined || request.expectedRevision === null
    ? undefined
    : request.expectedRevision
  await writeNamespace(deps, found, {
    packageName: SUBAGENT_SETTINGS_PKG,
    settingsOps: [
      { op: 'set', path: ['enabled'], value: nextEnabled },
      { op: 'set', path: ['allowedModels'], value: nextModels },
    ],
    editorApply: section => {
      const next = { ...section, enabled: nextEnabled, allowedModels: nextModels }
      if (nextModels.length === 0) delete next.allowedModels
      return next
    },
    label: 'the subagent model selection',
    expectedRevision,
  })
  return {
    available: true,
    namespace: found.ns,
    revision: found.revision === undefined ? null : found.revision + 1,
    enabled: nextEnabled,
    allowedModels: nextModels,
    error: null,
    changed: true,
  }
}
