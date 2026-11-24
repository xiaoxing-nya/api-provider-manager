/**
 * Five-layer model metadata enrichment for custom API providers.
 *
 * DSH needs more than a model id for a custom route: a display name, a context
 * window, an output cap, input modalities, reasoning efforts, and pi-ai compat
 * switches. This module resolves each field from a strict precedence of sources
 * so a live endpoint answer outranks a bundled snapshot, a curated family rule
 * fills the gaps, and an existing user configuration is only replaced when a
 * higher layer actually knows better.
 *
 * Layer precedence (per field, highest first):
 *   1. `manual`          - a sparse `manualOverride` delta; `null` resets the field.
 *   2. `endpoint`        - extended fields from live model discovery.
 *   3. `remote-registry` - the models.dev / OpenRouter online registry cache.
 *   4. `local-snapshot`  - the bundled curated `data/model-catalog.json`.
 *   5. `configured`      - untouched fields of an existing profile.
 *   6. `heuristic`       - the bundled `data/family-rules.json` regex rules,
 *                          then conservative defaults (128k context, 16k
 *                          output, text). Reasoning efforts and compat give
 *                          `configured` higher precedence than metadata so a
 *                          deliberate user edit survives an upgrade.
 *
 * Reasoning efforts are protocol-aware: the Gemini API only takes
 * minimal/low/medium/high, so levels it cannot express are dropped with a
 * warning. Compat switches are filtered to the protocol's schema and a gateway
 * preset never overrides an explicit model capability.
 *
 * Pure Node >= 22 ESM, no external dependencies.
 * @module @xiaoxing/api-provider-manager/enricher
 */

import { readFileSync } from 'node:fs'

import { candidateLookupKeys, canonModelId, deriveVendorGroup, isLikelyNonChatModel } from './canon.js'
import { ApiManagerError, messageOf, redactSecretText } from './errors.js'
import {
  filterCompatForApi,
  getPreset,
  normalizeReasoningEffortsForApi,
  SUPPORTED_PROTOCOLS,
  THINKING_LEVELS,
  validateModelProfile,
} from './presets.js'
import { validateCustomProviderId } from './reserved.js'

/** Conservative context window used when nothing else knows the model. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** Conservative output cap used when nothing else knows the model. */
export const DEFAULT_MAX_TOKENS = 16_384

/** Headroom `dsh-compaction-basic` reserves on top of `maxTokens`. */
export const COMPACTION_HEADROOM = 65_536

/** Fields enrichment resolves and tracks in `provenance`. */
const MANAGED_FIELDS = Object.freeze([
  'name',
  'contextWindow',
  'maxTokens',
  'input',
  'reasoningEfforts',
  'compat',
])

/**
 * Per-field layer precedence, highest first. Reasoning efforts favour an
 * explicit existing configuration over live or snapshot metadata because the
 * effort names a user deliberately chose are local truth; the same holds for
 * capacities: a curated family rule is only a guess, so an existing
 * configuration survives ahead of it. Metadata that positively knows the model
 * still outranks both.
 */
const FIELD_LAYER_ORDER = Object.freeze({
  name: Object.freeze(['manual', 'endpoint', 'remote-registry', 'local-snapshot', 'configured']),
  contextWindow: Object.freeze([
    'manual',
    'endpoint',
    'remote-registry',
    'local-snapshot',
    'configured',
    'heuristic',
  ]),
  maxTokens: Object.freeze(['manual', 'endpoint', 'remote-registry', 'local-snapshot', 'configured', 'heuristic']),
  input: Object.freeze(['manual', 'endpoint', 'remote-registry', 'local-snapshot', 'configured', 'heuristic']),
  reasoningEfforts: Object.freeze([
    'manual',
    'configured',
    'endpoint',
    'remote-registry',
    'local-snapshot',
    'heuristic',
  ]),
})

/**
 * Fallback reasoning precedence when the configured entry only carries bare
 * `reasoningEfforts: false` (no custom effort mapping and no manual override):
 * positive endpoint, registry, or catalog facts outrank it, while it still
 * prevents a pure family-rule guess from overriding it.
 */
const REASONING_ORDER_WITHOUT_CUSTOM_CONFIG = Object.freeze([
  'manual',
  'endpoint',
  'remote-registry',
  'local-snapshot',
  'configured',
  'heuristic',
])

/** Precedence used to describe the strongest compat contributor. */
const COMPAT_PRECEDENCE = Object.freeze([
  'manual',
  'configured',
  'heuristic',
  'remote-registry',
  'local-snapshot',
  'fallback',
])

/** Compat field a `reasoning_content` interleaved feed needs. */
const REASONING_CONTENT_COMPAT = Object.freeze({ requiresReasoningContentOnAssistantMessages: true })

/** Preset offered for each protocol when auditing an existing route. */
const PRESET_ID_BY_API = Object.freeze({
  'openai-completions': 'custom-relay-openai',
  'openai-responses': 'custom-openai-responses',
  'anthropic-messages': 'custom-anthropic',
  'google-generative-ai': 'custom-gemini',
})

/** Human-readable protocol labels used when naming split routes. */
const PROTOCOL_LABELS = Object.freeze({
  'openai-completions': 'Chat Completions',
  'openai-responses': 'Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Gemini',
})

/** Provider-id suffix each non-default protocol route receives. */
const PROTOCOL_ID_SUFFIX = Object.freeze({
  'openai-completions': '',
  'openai-responses': '-responses',
  'anthropic-messages': '-anthropic',
  'google-generative-ai': '-gemini',
})

/** Lazily loaded bundled catalog. */
let bundledCatalog
/** Lazily loaded bundled family rules. */
let bundledRules
/** A registry refresh replaces the maps and invalidates its cached index. */
const catalogIndexCache = new WeakMap()
const EMPTY_ALIASES = Object.freeze({})

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
 * Return a value when it is a positive integer.
 * @param {unknown} value - candidate value.
 * @returns {number | undefined} the positive integer, or `undefined`.
 */
function positiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Normalize a catalog into the `{ models, aliases }` shape this module indexes.
 *
 * A bare `{ [id]: entry }` map is accepted for hand-written test catalogs;
 * already-normalized catalogs are returned as-is so the index stays cached.
 * @param {unknown} catalog - catalog value.
 * @returns {{ models: Record<string, object>, aliases: Record<string, string> }} the normalized catalog.
 * @throws {ApiManagerError} `invalid-catalog` when the value is not a catalog.
 */
function normalizeCatalog(catalog) {
  if (catalog === undefined || catalog === null) return { models: {}, aliases: {} }
  if (!isPlainObject(catalog)) {
    throw new ApiManagerError('invalid-catalog', 'offlineCatalog must be a model catalog object', {
      type: typeof catalog,
    })
  }
  if (isPlainObject(catalog.models) && isPlainObject(catalog.aliases)) return catalog
  if (isPlainObject(catalog.models)) {
    return { models: catalog.models, aliases: EMPTY_ALIASES }
  }
  return { models: catalog, aliases: EMPTY_ALIASES }
}

/**
 * Normalize the bundled family rules into an array of rule objects.
 * @param {unknown} rules - `{ rules: [...] }` wrapper or a bare array.
 * @returns {object[]} the rule objects.
 * @throws {ApiManagerError} `invalid-rules` when the value is not a rule list.
 */
function normalizeRules(rules) {
  const value = Array.isArray(rules) ? rules : isPlainObject(rules) && Array.isArray(rules.rules) ? rules.rules : null
  if (value === null) {
    throw new ApiManagerError('invalid-rules', 'familyRules must be an array or an object with a rules array')
  }
  return value.filter(rule => isPlainObject(rule))
}

/**
 * Load and cache the bundled offline model catalog.
 * @returns {{ models: Record<string, object>, aliases: Record<string, string> }} the bundled catalog.
 * @throws {ApiManagerError} `invalid-catalog` when the bundled file cannot be read or parsed.
 */
function loadBundledCatalog() {
  if (bundledCatalog !== undefined) return bundledCatalog
  try {
    const text = readFileSync(new URL('../data/model-catalog.json', import.meta.url), 'utf8')
    bundledCatalog = normalizeCatalog(JSON.parse(text))
  } catch (error) {
    throw new ApiManagerError(
      'invalid-catalog',
      `bundled model catalog could not be loaded: ${redactSecretText(messageOf(error))}`,
    )
  }
  return bundledCatalog
}

/**
 * Load and cache the bundled family rules.
 * @returns {{ rules: object[] }} the bundled rules wrapper.
 * @throws {ApiManagerError} `invalid-rules` when the bundled file cannot be read or parsed.
 */
function loadBundledRules() {
  if (bundledRules !== undefined) return bundledRules
  try {
    const text = readFileSync(new URL('../data/family-rules.json', import.meta.url), 'utf8')
    bundledRules = { rules: normalizeRules(JSON.parse(text)) }
  } catch (error) {
    throw new ApiManagerError(
      'invalid-rules',
      `bundled family rules could not be loaded: ${redactSecretText(messageOf(error))}`,
    )
  }
  return bundledRules
}

/**
 * Normalize spelling while retaining the model's namespace, snapshot, and variant.
 */
function spellingKey(id) {
  return id.toLowerCase().replace(/(\d)p(?=\d)/gu, '$1.').replace(/(?<=\d)\.(?=\d)|[_\s]+/gu, '-')
}

/** Strip variant suffixes only at the weakest matching tiers. */
function variantKey(canon) {
  return spellingKey(canon.withoutDate.split(':')[0].replace(/-latest$/iu, ''))
}

/** Index literal IDs, declared aliases, and progressively weaker spellings separately. */
function catalogIndex(models, aliases) {
  const cached = catalogIndexCache.get(models)
  if (cached !== undefined && cached.aliases === aliases) return cached.index
  const index = { exact: new Map(), alias: new Map(), spelling: new Map(), vendor: new Map(), variant: new Map(), tail: new Map() }
  const add = (map, key, model) => {
    if (!key) return
    if (!map.has(key)) map.set(key, new Map())
    map.get(key).set(model.id, model)
  }
  const addSpellings = (id, model) => {
    const canon = canonModelId(id)
    add(index.spelling, spellingKey(canon.raw), model)
    add(index.vendor, spellingKey(canon.strippedVendor), model)
    const variant = variantKey(canon)
    add(index.variant, variant, model)
    add(index.tail, variant.slice(variant.lastIndexOf('/') + 1), model)
  }
  for (const [key, entry] of Object.entries(models)) {
    if (!isPlainObject(entry)) continue
    const model = { id: typeof entry.id === 'string' && entry.id ? entry.id : key, entry }
    add(index.exact, key, model)
    add(index.exact, model.id, model)
    addSpellings(key, model)
    if (model.id !== key) addSpellings(model.id, model)
  }
  for (const [alias, target] of Object.entries(aliases ?? {})) {
    if (typeof target !== 'string') continue
    for (const model of index.exact.get(target)?.values() ?? []) {
      add(index.alias, alias, model)
      addSpellings(alias, model)
    }
  }
  catalogIndexCache.set(models, { aliases, index })
  return index
}

/** Pick the strongest shared evidence from both snapshots, retaining collisions. */
function matchReferenceModels(id, catalog, registryCache) {
  const canon = canonModelId(id)
  const empty = { catalog: null, registry: null, ids: [] }
  if (!canon.raw) return empty
  const indexes = [['catalog', catalogIndex(catalog.models, catalog.aliases)]]
  const models = registryCache?.models
  if (isPlainObject(models)) indexes.unshift(['registry', catalogIndex(models, registryCache.aliases)])
  const variant = variantKey(canon)
  const tail = variant.slice(variant.lastIndexOf('/') + 1)
  for (const [kind, key] of [
    ['exact', canon.raw],
    ['alias', canon.raw],
    ['spelling', spellingKey(canon.raw)],
    ['vendor', spellingKey(canon.strippedVendor)],
    ['variant', variant],
    ['tail', tail],
  ]) {
    if (!key) continue
    const hits = indexes.map(([source, index]) => [source, [...(index[kind].get(key)?.values() ?? [])]])
    const ids = [...new Set(hits.flatMap(([, records]) => records.map(model => model.id)))].sort()
    if (ids.length === 0) continue
    if (ids.length > 1) return { ...empty, ids }
    const selected = { ...empty, ids }
    for (const [source, index] of indexes) {
      const match = hits.find(([name]) => name === source)?.[1][0] ?? index.exact.get(ids[0])?.get(ids[0])
      if (match !== undefined) selected[source] = match.entry
    }
    return selected
  }
  return empty
}

/** Look up one unambiguous model in the supplied or bundled offline catalog. */
export function lookupOfflineCatalog(rawId, catalog) {
  if (typeof rawId !== 'string' || rawId.trim() === '') return null
  return matchReferenceModels(rawId, normalizeCatalog(catalog === undefined ? loadBundledCatalog() : catalog)).catalog
}

/**
 * Match one model id against the declarative family rules.
 *
 * Each rule regex is tested against both the normalized id and its
 * dot/hyphen-normalized spelling so `claude-sonnet-5.5` and
 * `claude-sonnet-5-5` match the same rule. The first matching rule wins, so the
 * rules file orders specific generations before family fallbacks.
 * @param {unknown} rawId - model id as a provider spells it.
 * @param {object | object[]} [rules] - rules wrapper or bare rule array; defaults to the bundled rules.
 * @returns {object | null} the first matching rule, or `null`.
 * @throws {ApiManagerError} `invalid-rules` when a custom rules value is malformed.
 */
export function matchFamilyRule(rawId, rules) {
  const list = normalizeRules(rules === undefined ? loadBundledRules() : rules)
  if (typeof rawId !== 'string' || rawId.trim().length === 0) return null
  const canon = canonModelId(rawId)
  for (const rule of list) {
    if (typeof rule.match !== 'string' || rule.match.length === 0) continue
    let pattern
    try {
      pattern = new RegExp(rule.match, 'iu')
    } catch {
      continue
    }
    if (pattern.test(canon.normalized) || pattern.test(canon.dotHyphenNormalized)) return rule
  }
  return null
}

/**
 * Normalize declared modalities to the pi-ai `['text', 'image']` subset.
 * @param {unknown} value - declared modalities.
 * @returns {('text' | 'image')[] | undefined} the supported subset, or `undefined`.
 */
function normalizeInputClaim(value) {
  if (!Array.isArray(value)) return undefined
  const declared = new Set()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const modality = item.trim().toLowerCase()
    if (modality === 'text') declared.add('text')
    else if (modality === 'image' || modality === 'vision' || modality === 'image_url') declared.add('image')
  }
  const subset = ['text', 'image'].filter(modality => declared.has(modality))
  return subset.length === 0 ? undefined : subset
}

/**
 * Canonicalize declared reasoning level names.
 * @param {unknown} levels - declared level spellings.
 * @returns {string[]} known thinking levels in pi-ai order, without `off`.
 */
function canonicalThinkingLevels(levels) {
  if (!Array.isArray(levels)) return []
  const declared = new Set()
  for (const level of levels) {
    if (typeof level !== 'string') continue
    const normalized = level.trim().toLowerCase()
    if (normalized.length === 0 || normalized === 'none' || normalized === 'off' || normalized === 'disabled') {
      continue
    }
    if (THINKING_LEVELS.includes(normalized)) declared.add(normalized)
  }
  return THINKING_LEVELS.filter(level => level !== 'off' && declared.has(level))
}

/**
 * Build a pi-ai reasoning-efforts map from a layer's level list.
 * @param {unknown} levels - declared level spellings.
 * @param {unknown} allowOff - whether the layer says reasoning can be disabled.
 * @returns {Record<string, string | null> | undefined} the efforts map, or `undefined` when it declares no level.
 */
function effortsToReasoningEfforts(levels, allowOff) {
  const thinking = canonicalThinkingLevels(levels)
  const efforts = {}
  if (allowOff !== false) efforts.off = null
  for (const level of thinking) efforts[level] = level
  return Object.keys(efforts).length === 0 ? undefined : efforts
}

/**
 * Build the claim map for one normalized metadata entry (catalog, registry, or configured profile).
 * @param {unknown} entry - entry to read.
 * @returns {Record<string, unknown> | null} the claims, or `null` when there is no entry.
 */
function claimsFromEntry(entry) {
  if (!isPlainObject(entry)) return null
  const claims = {}
  if (typeof entry.name === 'string' && entry.name.trim().length > 0) claims.name = entry.name.trim()
  const contextWindow = positiveInteger(entry.contextWindow)
  if (contextWindow !== undefined) claims.contextWindow = contextWindow
  const maxTokens = positiveInteger(entry.maxTokens)
  if (maxTokens !== undefined) claims.maxTokens = maxTokens
  const input = normalizeInputClaim(entry.input)
  if (input !== undefined) claims.input = input
  if (entry.reasoningEfforts === false) {
    claims.reasoningEfforts = false
  } else if (isPlainObject(entry.reasoningEfforts)) {
    claims.reasoningEfforts = { ...entry.reasoningEfforts }
  } else if (Array.isArray(entry.efforts) && entry.efforts.length > 0) {
    const efforts = effortsToReasoningEfforts(entry.efforts, entry.allowOff)
    if (efforts !== undefined) claims.reasoningEfforts = efforts
  } else if (entry.reasoning === false) {
    claims.reasoningEfforts = false
  }
  if (isPlainObject(entry.compat)) claims.compat = { ...entry.compat }
  if (typeof entry.interleavedField === 'string' && entry.interleavedField.length > 0) {
    claims.interleavedField = entry.interleavedField
  }
  return claims
}

/**
 * Build the claim map for a live discovery entry.
 * @param {unknown} discovered - discovered model.
 * @returns {Record<string, unknown> | null} the claims, or `null` when absent.
 */
function claimsFromDiscovered(discovered) {
  if (!isPlainObject(discovered)) return null
  const claims = {}
  if (typeof discovered.name === 'string' && discovered.name.trim().length > 0) {
    claims.name = discovered.name.trim()
  }
  const contextWindow = positiveInteger(discovered.contextWindow)
  if (contextWindow !== undefined) claims.contextWindow = contextWindow
  const maxTokens = positiveInteger(discovered.maxTokens)
  if (maxTokens !== undefined) claims.maxTokens = maxTokens
  const input = normalizeInputClaim(discovered.input)
  if (input !== undefined) claims.input = input
  if (Array.isArray(discovered.efforts) && discovered.efforts.length > 0) {
    const efforts = effortsToReasoningEfforts(discovered.efforts, discovered.allowOff)
    if (efforts !== undefined) claims.reasoningEfforts = efforts
  }
  // Only treat `reasoning: false` as an endpoint claim when the endpoint
  // explicitly declared non-reasoning (`reasoningDeclared !== false`). Standard
  // `/v1/models` entries omit reasoning metadata (`reasoningDeclared: false`)
  // and must fall through to local-snapshot / remote-registry / family rules.
  if (
    claims.reasoningEfforts === undefined &&
    discovered.reasoning === false &&
    discovered.reasoningDeclared !== false
  ) {
    claims.reasoningEfforts = false
  }
  if (isPlainObject(discovered.compat)) claims.compat = { ...discovered.compat }
  return claims
}

/**
 * Build the claim map for a curated family rule.
 * @param {unknown} rule - family rule.
 * @returns {Record<string, unknown> | null} the claims, or `null` when absent.
 */
function claimsFromRule(rule) {
  if (!isPlainObject(rule)) return null
  const claims = {}
  const contextWindow = positiveInteger(rule.contextWindow)
  if (contextWindow !== undefined) claims.contextWindow = contextWindow
  const maxTokens = positiveInteger(rule.maxTokens)
  if (maxTokens !== undefined) claims.maxTokens = maxTokens
  const input = normalizeInputClaim(rule.input)
  if (input !== undefined) claims.input = input
  if (Array.isArray(rule.efforts) && rule.efforts.length > 0) {
    const efforts = effortsToReasoningEfforts(rule.efforts, rule.allowOff)
    if (efforts !== undefined) claims.reasoningEfforts = efforts
  } else if (rule.reasoning === false) {
    claims.reasoningEfforts = false
  }
  const compat = {}
  if (isPlainObject(rule.capabilities)) Object.assign(compat, rule.capabilities)
  if (isPlainObject(rule.compat)) Object.assign(compat, rule.compat)
  if (Object.keys(compat).length > 0) claims.compat = compat
  return claims
}

/**
 * Build the claim map for a sparse manual override.
 *
 * A `null` value is an explicit reset: the field falls through to the lower
 * layers instead of being overwritten with `null`.
 * @param {unknown} manualOverride - sparse delta of user-set fields.
 * @returns {Record<string, unknown> | null} the claims, or `null` when absent.
 */
function claimsFromManual(manualOverride) {
  if (!isPlainObject(manualOverride)) return null
  const claims = {}
  if (Object.hasOwn(manualOverride, 'name') && manualOverride.name !== null) {
    claims.name = manualOverride.name
  }
  for (const field of ['contextWindow', 'maxTokens']) {
    if (!Object.hasOwn(manualOverride, field)) continue
    const value = manualOverride[field]
    if (value === null) continue
    claims[field] = value
  }
  if (Object.hasOwn(manualOverride, 'input') && manualOverride.input !== null) {
    claims.input = Array.isArray(manualOverride.input) ? [...manualOverride.input] : manualOverride.input
  }
  if (Object.hasOwn(manualOverride, 'reasoningEfforts') && manualOverride.reasoningEfforts !== null) {
    const value = manualOverride.reasoningEfforts
    if (value === false) {
      claims.reasoningEfforts = false
    } else if (Array.isArray(value)) {
      const efforts = effortsToReasoningEfforts(value, manualOverride.allowOff)
      if (efforts !== undefined) claims.reasoningEfforts = efforts
    } else {
      claims.reasoningEfforts = isPlainObject(value) ? { ...value } : value
    }
  }
  if (Object.hasOwn(manualOverride, 'compat') && manualOverride.compat !== null) {
    if (isPlainObject(manualOverride.compat)) claims.compat = { ...manualOverride.compat }
    else claims.invalidCompat = manualOverride.compat
  }
  return claims
}

/**
 * Resolve one field through the per-field layer precedence.
 * @param {Map<string, { claims: Record<string, unknown> | null }>} layers - claims by layer id.
 * @param {string} field - managed field name.
 * @returns {{ value: unknown, source: string } | undefined} the winning value and its layer.
 */
function resolveClaim(layers, field) {
  let order = FIELD_LAYER_ORDER[field] ?? []
  if (field === 'reasoningEfforts' && layers.get('configured')?.claims?.reasoningEfforts === false) {
    order = REASONING_ORDER_WITHOUT_CUSTOM_CONFIG
  }
  for (const layerId of order) {
    const claims = layers.get(layerId)?.claims
    if (!claims || !Object.hasOwn(claims, field)) continue
    const value = claims[field]
    if (value === undefined) continue
    return { value, source: layerId }
  }
  return undefined
}

/**
 * Compare two compat values structurally.
 * @param {unknown} left - first value.
 * @param {unknown} right - second value.
 * @returns {boolean} whether the values are identical JSON values.
 */
function compatValuesEqual(left, right) {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => compatValuesEqual(value, right[index]))
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every(key => Object.hasOwn(right, key) && compatValuesEqual(left[key], right[key]))
  }
  return false
}

/**
 * Normalize discovered endpoint type strings to unique values.
 * @param {unknown} types - declared endpoint types.
 * @returns {string[]} the normalized types.
 */
function normalizeEndpointTypes(types) {
  if (!Array.isArray(types)) return []
  const result = []
  const seen = new Set()
  for (const type of types) {
    if (typeof type !== 'string') continue
    const value = type.trim()
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/**
 * Map an upstream endpoint type or path to a supported DSH protocol.
 * @param {unknown} type - endpoint type or endpoint path.
 * @returns {string | null} the protocol, or `null` when it names no known protocol.
 */
function protocolFromEndpointType(type) {
  if (typeof type !== 'string') return null
  const normalized = type.trim().toLowerCase()
  if (normalized.length === 0) return null
  if (normalized.includes('responses')) return 'openai-responses'
  if (normalized.includes('anthropic') || normalized.includes('messages')) return 'anthropic-messages'
  if (
    normalized.includes('gemini') ||
    normalized.includes('generative') ||
    normalized.includes('vertex') ||
    normalized.includes('google')
  ) {
    return 'google-generative-ai'
  }
  if (
    normalized.includes('openai') ||
    normalized.includes('chat') ||
    normalized.includes('completion')
  ) {
    return 'openai-completions'
  }
  return null
}

/**
 * Guess a model family's native protocol from its vendor group.
 * @param {string} id - model id.
 * @returns {string} one of the supported protocols.
 */
function familyProtocolHint(id) {
  const group = deriveVendorGroup(id)
  if (group === 'Anthropic') return 'anthropic-messages'
  if (group === 'Google') return 'google-generative-ai'
  return 'openai-completions'
}

/**
 * Choose the protocol a model should be routed on, preferring its native
 * protocol when the endpoint advertises it.
 * @param {Set<string>} available - protocols the endpoint advertises.
 * @param {string} id - model id.
 * @returns {string} the preferred protocol.
 */
function preferredProtocol(available, id) {
  const hint = familyProtocolHint(id)
  if (available.has(hint)) return hint
  for (const protocol of SUPPORTED_PROTOCOLS) {
    if (available.has(protocol)) return protocol
  }
  return 'openai-completions'
}

/**
 * Enrich one model profile through the five-layer metadata precedence.
 * @param {object} options - enrichment inputs.
 * @param {string} options.id - model id as the provider spells it.
 * @param {object} [options.discovered] - live discovery entry for the model.
 * @param {object} [options.configured] - existing model profile being upgraded.
 * @param {object} [options.manualOverride] - sparse delta of user-set fields; `null` resets a field.
 * @param {string} [options.api] - wire protocol the model speaks.
 * @param {string} [options.presetId] - gateway preset id supplying fallback capacities and compat.
 * @param {object} [options.routeCompat] - provider-level compat; identical model-level fields are omitted.
 * @param {{ lookup: (keys: string[]) => object | null }} [options.registryCache] - live registry cache.
 * @param {object} [options.offlineCatalog] - custom catalog instead of the bundled one.
 * @param {object | object[]} [options.familyRules] - custom family rules instead of the bundled ones.
 * @returns {{ profile: object, provenance: Record<string, string>, warnings: object[],
 *   meta: { vendorGroup: string, supportedEndpointTypes: string[], matchedCatalogId: string | null,
 *   matchedRegistryId: string | null, matchedRuleId: string | null,
 *   ambiguousModelIds: string[], isNonChat: boolean } }} the enriched profile and diagnostics.
 * @throws {ApiManagerError} `invalid-model-profile` when the resolved profile is not valid for the protocol,
 *   `invalid-catalog` or `invalid-rules` for malformed custom data.
 */
export function enrichModel({
  id,
  discovered,
  configured,
  manualOverride,
  api = 'openai-completions',
  presetId,
  routeCompat,
  registryCache,
  offlineCatalog,
  familyRules,
} = {}) {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new ApiManagerError('invalid-model-id', 'model id must be a non-empty string', { id })
  }
  if (!SUPPORTED_PROTOCOLS.includes(api)) {
    throw new ApiManagerError(
      'invalid-api',
      `api must be one of ${SUPPORTED_PROTOCOLS.join(', ')}; got ${JSON.stringify(api)}`,
      { api },
    )
  }
  const warnings = []
  const catalog = normalizeCatalog(offlineCatalog === undefined ? loadBundledCatalog() : offlineCatalog)
  const rules = normalizeRules(familyRules === undefined ? loadBundledRules() : familyRules)
  const rawUpstream = isPlainObject(manualOverride) && typeof manualOverride.upstreamModel === 'string'
    ? manualOverride.upstreamModel.trim()
    : ''
  const upstreamModel = rawUpstream.length > 0 ? rawUpstream : null
  const lookupId = upstreamModel ?? id
  const referenceMatches = matchReferenceModels(lookupId, catalog, registryCache)
  const ambiguousModelIds = referenceMatches.ids.length > 1 ? referenceMatches.ids : []
  const catalogEntry = referenceMatches.catalog
  let registryEntry = referenceMatches.registry
  // Keep the lookup-only registry interface used by callers that do not expose a snapshot.
  if (!isPlainObject(registryCache?.models) && typeof registryCache?.lookup === 'function' && ambiguousModelIds.length === 0) {
    try {
      const entry = registryCache.lookup(candidateLookupKeys(lookupId))
      if (catalogEntry === null || entry?.id === catalogEntry.id) registryEntry = entry
    } catch (error) {
      warnings.push({ code: 'registry-lookup-failed', field: null, message: `registry lookup failed: ${redactSecretText(messageOf(error))}` })
    }
  }
  if (ambiguousModelIds.length > 0) {
    warnings.push({
      code: 'ambiguous-model-match',
      field: null,
      candidates: ambiguousModelIds,
      message: `model ${JSON.stringify(lookupId)} matches multiple reference models; bind a specific model id`,
    })
  }
  const referenceId = registryEntry?.id ?? catalogEntry?.id ?? lookupId
  const rule = matchFamilyRule(referenceId, rules)
  const preset = presetId === undefined ? undefined : getPreset(presetId)
  if (presetId !== undefined && preset === undefined) {
    warnings.push({
      code: 'unknown-preset',
      field: null,
      message: `gateway preset "${presetId}" does not exist; using conservative defaults`,
    })
  }

  const snapshotClaims = claimsFromEntry(catalogEntry)
  const registryClaims = claimsFromEntry(registryEntry)
  // When a model is manually bound to an upstream reference model, inherit
  // capabilities without overwriting the custom model's own display name.
  if (upstreamModel !== null) {
    if (snapshotClaims !== null) delete snapshotClaims.name
    if (registryClaims !== null) delete registryClaims.name
  }

  const configuredClaims = claimsFromEntry(configured)
  if (configuredClaims !== null && isPlainObject(manualOverride)) {
    for (const field of MANAGED_FIELDS) {
      if (manualOverride[field] === null) delete configuredClaims[field]
    }
    if (manualOverride.compat === null) delete configuredClaims.interleavedField
  }
  const layers = new Map([
    ['manual', { claims: claimsFromManual(manualOverride) }],
    ['endpoint', { claims: claimsFromDiscovered(discovered) }],
    ['remote-registry', { claims: registryClaims }],
    ['local-snapshot', { claims: snapshotClaims }],
    ['heuristic', { claims: claimsFromRule(rule) }],
    ['configured', { claims: configuredClaims }],
  ])
  const manualClaims = layers.get('manual')?.claims
  if (manualClaims && Object.hasOwn(manualClaims, 'invalidCompat')) {
    throw new ApiManagerError(
      'invalid-model-profile',
      `model "${id}" manual compat override must be an object`,
      { id, compat: manualClaims.invalidCompat },
    )
  }

  const resolvedName = resolveClaim(layers, 'name')
  const resolvedContextWindow = resolveClaim(layers, 'contextWindow')
  const resolvedMaxTokens = resolveClaim(layers, 'maxTokens')
  const resolvedInput = resolveClaim(layers, 'input')
  const resolvedEfforts = resolveClaim(layers, 'reasoningEfforts')

  let reasoningEfforts
  let reasoningProvenance = 'fallback'
  if (resolvedEfforts !== undefined) {
    if (resolvedEfforts.value === false) {
      reasoningEfforts = false
      reasoningProvenance = resolvedEfforts.source
    } else if (isPlainObject(resolvedEfforts.value)) {
      const declared = { ...resolvedEfforts.value }
      const normalized = normalizeReasoningEffortsForApi(declared, api)
      if (api === 'google-generative-ai') {
        const kept = new Set(normalized === undefined ? [] : Object.keys(normalized))
        const dropped = Object.keys(declared).filter(level => !kept.has(level))
        const clampable = dropped.filter(level => level === 'off' || level === 'xhigh' || level === 'max')
        if (clampable.length > 0) {
          warnings.push({
            code: 'reasoning-efforts-clamped',
            field: 'reasoningEfforts',
            levels: dropped,
            message: `google-generative-ai accepts only ${THINKING_LEVELS.filter(level => level !== 'off' && level !== 'xhigh' && level !== 'max').join(', ')}; dropped ${dropped.join(', ')}`,
          })
        }
      }
      if (normalized !== undefined) {
        reasoningEfforts = normalized
        reasoningProvenance = resolvedEfforts.source
      }
    }
  }

  const mergedCompat = {}
  const compatSources = new Map()
  const mergeCompat = (source, compat) => {
    if (!isPlainObject(compat)) return
    for (const [field, value] of Object.entries(compat)) {
      if (value === undefined || value === null) continue
      mergedCompat[field] = value
      compatSources.set(field, source)
    }
  }
  mergeCompat('fallback', preset?.recommendedCompat)
  if (layers.get('local-snapshot')?.claims?.interleavedField === 'reasoning_content') {
    mergeCompat('local-snapshot', REASONING_CONTENT_COMPAT)
  }
  if (layers.get('remote-registry')?.claims?.interleavedField === 'reasoning_content') {
    mergeCompat('remote-registry', REASONING_CONTENT_COMPAT)
  }
  mergeCompat('heuristic', layers.get('heuristic')?.claims?.compat)
  mergeCompat('configured', layers.get('configured')?.claims?.compat)
  mergeCompat('manual', manualClaims?.compat)

  const filteredCompat = filterCompatForApi(mergedCompat, api)
  const routeOnlyCompat = isPlainObject(routeCompat) ? filterCompatForApi(routeCompat, api) : {}
  for (const [field, value] of Object.entries(routeOnlyCompat)) {
    if (Object.hasOwn(filteredCompat, field) && compatValuesEqual(filteredCompat[field], value)) {
      delete filteredCompat[field]
      compatSources.delete(field)
    }
  }
  let compatProvenance = 'fallback'
  for (const source of COMPAT_PRECEDENCE) {
    if (Object.keys(filteredCompat).some(field => compatSources.get(field) === source)) {
      compatProvenance = source
      break
    }
  }

  const fallbackContextWindow =
    positiveInteger(preset?.defaultContextWindow) ?? DEFAULT_CONTEXT_WINDOW
  const fallbackMaxTokens = positiveInteger(preset?.defaultMaxTokens) ?? DEFAULT_MAX_TOKENS
  const profile = { id }
  if (isPlainObject(configured)) {
    for (const [field, value] of Object.entries(configured)) {
      if (field === 'id' || MANAGED_FIELDS.includes(field)) continue
      profile[field] = value
    }
  }
  profile.name = resolvedName === undefined ? id : resolvedName.value
  profile.contextWindow =
    resolvedContextWindow === undefined ? fallbackContextWindow : resolvedContextWindow.value
  profile.maxTokens = resolvedMaxTokens === undefined ? fallbackMaxTokens : resolvedMaxTokens.value
  profile.input = resolvedInput === undefined ? ['text'] : resolvedInput.value
  if (reasoningEfforts !== undefined) profile.reasoningEfforts = reasoningEfforts
  if (Object.keys(filteredCompat).length > 0) profile.compat = filteredCompat

  validateModelProfile(profile, api)

  if (profile.contextWindow <= profile.maxTokens + COMPACTION_HEADROOM) {
    warnings.push({
      code: 'compaction-headroom-tight',
      field: 'contextWindow',
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens,
      reserved: profile.maxTokens + COMPACTION_HEADROOM,
      message:
        `model "${id}" declares contextWindow ${profile.contextWindow} and maxTokens ${profile.maxTokens}; ` +
        `dsh-compaction-basic reserves maxTokens + ${COMPACTION_HEADROOM} tokens of headroom ` +
        `(${profile.maxTokens + COMPACTION_HEADROOM}), so compaction may leave no room for a reply; ` +
        'lower maxTokens or raise contextWindow',
    })
  }

  const discoveredEndpoints = normalizeEndpointTypes(discovered?.supportedEndpointTypes)
  const registryEndpoints = discoveredEndpoints.length > 0 ? [] : normalizeEndpointTypes(registryEntry?.endpoints)
  const endpointTypes =
    discoveredEndpoints.length > 0
      ? discoveredEndpoints
      : registryEndpoints.length > 0
        ? registryEndpoints
        : normalizeEndpointTypes(catalogEntry?.endpoints)

  const provenance = {
    name: resolvedName === undefined ? 'fallback' : resolvedName.source,
    contextWindow: resolvedContextWindow === undefined ? 'fallback' : resolvedContextWindow.source,
    maxTokens: resolvedMaxTokens === undefined ? 'fallback' : resolvedMaxTokens.source,
    input: resolvedInput === undefined ? 'fallback' : resolvedInput.source,
    reasoningEfforts: reasoningProvenance,
    compat: compatProvenance,
  }
  const meta = {
    vendorGroup: typeof rule?.vendorGroup === 'string' ? rule.vendorGroup : deriveVendorGroup(lookupId),
    supportedEndpointTypes: endpointTypes,
    matchedCatalogId: typeof catalogEntry?.id === 'string' ? catalogEntry.id : null,
    matchedRegistryId: typeof registryEntry?.id === 'string' ? registryEntry.id : null,
    matchedRuleId: typeof rule?.id === 'string' ? rule.id : null,
    ambiguousModelIds,
    upstreamModel,
    isNonChat: isLikelyNonChatModel(lookupId).nonChat || discovered?.nonChat === true,
  }
  return { profile, provenance, warnings, meta }
}

/**
 * Collect the provider ids already in use.
 * @param {unknown} existingProviders - provider map, provider array, or provider-id array.
 * @returns {Set<string>} the provider ids.
 */
function collectExistingProviderIds(existingProviders) {
  const ids = new Set()
  if (isPlainObject(existingProviders)) {
    for (const key of Object.keys(existingProviders)) ids.add(key)
    return ids
  }
  if (Array.isArray(existingProviders)) {
    for (const entry of existingProviders) {
      if (typeof entry === 'string' && entry.length > 0) ids.add(entry)
      else if (isPlainObject(entry) && typeof entry.provider === 'string' && entry.provider.length > 0) {
        ids.add(entry.provider)
      }
    }
  }
  return ids
}

/**
 * Turn an arbitrary seed into a syntactically valid provider id stem.
 * @param {unknown} raw - candidate provider id or display name.
 * @returns {string} a lowercase provider id stem.
 */
function providerIdSeed(raw) {
  let seed = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (seed.length === 0) seed = 'provider'
  if (!/^[a-z]/u.test(seed)) seed = `p-${seed}`
  seed = seed.slice(0, 64).replace(/-+$/u, '')
  return seed.length === 0 ? 'provider' : seed
}

/**
 * Fit a provider id into the 64-character schema limit around a suffix.
 * @param {string} stem - provider id stem.
 * @param {string} suffix - suffix including its leading hyphen.
 * @returns {string} the candidate provider id.
 */
function fitProviderId(stem, suffix) {
  const room = 64 - suffix.length
  const trimmed = stem.slice(0, Math.max(room, 1)).replace(/-+$/u, '')
  return `${trimmed}${suffix}`
}

/**
 * Allocate the first unused, valid provider id for a protocol group.
 * @param {string} stem - provider id stem.
 * @param {string} suffix - suffix including its leading hyphen.
 * @param {Set<string>} usedIds - ids already allocated or configured.
 * @param {readonly object[]} configurableProviders - provider entries the DSH configuration offers.
 * @returns {string} the allocated provider id.
 * @throws {ApiManagerError} `invalid-provider-id` when no candidate is usable.
 */
function allocateProviderId(stem, suffix, usedIds, configurableProviders) {
  for (let attempt = 1; attempt <= 99; attempt += 1) {
    const tail = attempt === 1 ? suffix : `${suffix}-${attempt}`
    const candidate = fitProviderId(stem, tail)
    if (usedIds.has(candidate)) continue
    try {
      validateCustomProviderId(candidate, configurableProviders)
    } catch {
      continue
    }
    return candidate
  }
  throw new ApiManagerError(
    'invalid-provider-id',
    `cannot derive an unused provider id from "${stem}${suffix}"; rename the provider`,
    { stem, suffix },
  )
}

/**
 * Recommend how to split one mixed-protocol relay into per-protocol DSH routes.
 *
 * Each enriched model is assigned to its native protocol when the endpoint
 * advertises it (an Anthropic model on a relay that speaks Anthropic Messages
 * goes to the Anthropic route; a Gemini model to the Gemini route; everything
 * else stays on the OpenAI-compatible route). Routes share `apiKeyEnv`, only
 * non-empty groups are emitted, and every derived provider id is validated and
 * deduplicated against the existing configuration.
 * @param {object} options - split inputs.
 * @param {string} options.providerId - provider id of the source relay.
 * @param {string} [options.displayName] - display name of the source relay.
 * @param {string} [options.baseURL] - base URL shared by every recommended route.
 * @param {string} [options.apiKeyEnv] - credential reference shared by every recommended route.
 * @param {object[]} [options.enrichedModels] - `enrichModel()` results or bare model profiles.
 * @param {object | string[]} [options.existingProviders] - providers already configured, by id.
 * @param {readonly { provider?: string, declared?: boolean }[]} [options.configurableProviders] - DSH provider entries.
 * @returns {{ providerId: string, baseURL: string | undefined, apiKeyEnv: string | undefined, split: boolean,
 *   groups: { id: string, api: string, displayName: string, baseURL: string | undefined,
 *   apiKeyEnv: string | undefined, models: object[], modelCount: number }[], warnings: object[] }} the split plan.
 * @throws {ApiManagerError} `invalid-provider-id` when the source provider id is malformed or reserved.
 */
export function planProtocolSplit({
  providerId,
  displayName,
  baseURL,
  apiKeyEnv,
  enrichedModels = [],
  existingProviders = {},
  configurableProviders = [],
} = {}) {
  const ownId = validateCustomProviderId(providerId, configurableProviders)
  const usedIds = collectExistingProviderIds(existingProviders)
  usedIds.delete(ownId)
  const groupsByProtocol = new Map()
  for (const item of Array.isArray(enrichedModels) ? enrichedModels : []) {
    const profile = isPlainObject(item?.profile) ? item.profile : isPlainObject(item) ? item : null
    if (profile === null || typeof profile.id !== 'string' || profile.id.trim().length === 0) continue
    const available = new Set()
    const endpointTypes = isPlainObject(item?.meta) ? item.meta.supportedEndpointTypes : undefined
    for (const type of Array.isArray(endpointTypes) ? endpointTypes : []) {
      const protocol = protocolFromEndpointType(type)
      if (protocol !== null) available.add(protocol)
    }
    if (available.size === 0) available.add(familyProtocolHint(profile.id))
    const protocol = preferredProtocol(available, profile.id)
    if (!groupsByProtocol.has(protocol)) groupsByProtocol.set(protocol, [])
    groupsByProtocol.get(protocol).push(profile)
  }

  const baseDisplayName = typeof displayName === 'string' && displayName.trim().length > 0 ? displayName.trim() : ownId
  const stem = providerIdSeed(ownId)
  const groups = []
  const warnings = []
  const orderedProtocols = SUPPORTED_PROTOCOLS.filter(
    protocol => (groupsByProtocol.get(protocol)?.length ?? 0) > 0,
  )
  for (const protocol of orderedProtocols) {
    const models = groupsByProtocol.get(protocol)
    const suffix = PROTOCOL_ID_SUFFIX[protocol]
    const id = suffix === '' ? ownId : allocateProviderId(stem, suffix, usedIds, configurableProviders)
    usedIds.add(id)
    groups.push({
      id,
      api: protocol,
      displayName: suffix === '' ? baseDisplayName : `${baseDisplayName} (${PROTOCOL_LABELS[protocol]})`,
      baseURL,
      apiKeyEnv,
      models,
      modelCount: models.length,
    })
  }
  if (groups.length === 0) {
    warnings.push({ code: 'no-models', message: 'no enriched models were supplied, so no provider group was planned' })
  }
  return {
    providerId: ownId,
    baseURL,
    apiKeyEnv,
    split: groups.length > 1,
    groups,
    warnings,
  }
}

/**
 * Read one model's sparse override from the audit overrides map.
 * @param {unknown} overrides - overrides value.
 * @param {string} modelId - model id.
 * @returns {object | undefined} the sparse override, or `undefined`.
 */
function resolveModelOverride(overrides, modelId) {
  if (!isPlainObject(overrides)) return undefined
  if (isPlainObject(overrides.models) && isPlainObject(overrides.models[modelId])) {
    return overrides.models[modelId]
  }
  if (isPlainObject(overrides[modelId])) return overrides[modelId]
  return undefined
}

/**
 * Push one audit issue with stable default fields.
 * @param {object[]} issues - issue list.
 * @param {object} issue - issue fields.
 * @returns {void}
 */
function pushIssue(issues, issue) {
  issues.push({ modelId: null, field: null, severity: 'warning', ...issue })
}

/**
 * Audit an existing custom provider route.
 *
 * Every configured model is re-enriched with its current profile as the
 * `configured` layer and any sparse `overrides` as the manual layer. The audit
 * reports missing capacities, modalities, reasoning efforts, and compat
 * switches, enrichment warnings such as tight compaction headroom, and models
 * that no metadata source knows, and returns the enriched models as the
 * suggested replacement profile.
 * @param {object} options - audit inputs.
 * @param {string} options.providerId - custom provider id.
 * @param {object} options.profile - existing provider profile (`api`, `models`, ...).
 * @param {{ lookup: (keys: string[]) => object | null }} [options.registryCache] - live registry cache.
 * @param {object} [options.offlineCatalog] - custom catalog instead of the bundled one.
 * @param {object | object[]} [options.familyRules] - custom family rules instead of the bundled ones.
 * @param {object} [options.overrides] - sparse per-model overrides, keyed by model id or `{ models: {...} }`.
 * @returns {{ providerId: string, api: string, modelCount: number, issueCount: number,
 *   issues: object[], suggestions: object[], summary: object }} the audit result.
 * @throws {ApiManagerError} `invalid-provider-profile` when `profile` is not an object.
 */
export function auditProvider({
  providerId,
  profile,
  registryCache,
  offlineCatalog,
  familyRules,
  overrides,
} = {}) {
  if (!isPlainObject(profile)) {
    throw new ApiManagerError('invalid-provider-profile', 'profile must be an object', { provider: providerId })
  }
  const api = typeof profile.api === 'string' ? profile.api : ''
  const models = Array.isArray(profile.models) ? profile.models : []
  const issues = []
  const suggestions = []
  const presetId = PRESET_ID_BY_API[api]
  const routeCompat = isPlainObject(profile.compat) ? profile.compat : {}
  const apiSupported = SUPPORTED_PROTOCOLS.includes(api)
  if (!apiSupported) {
    pushIssue(issues, {
      code: 'invalid-api',
      severity: 'error',
      message: `provider "${providerId}" declares api ${JSON.stringify(profile.api)}; expected one of ${SUPPORTED_PROTOCOLS.join(', ')}`,
    })
  }
  let failedModelCount = 0
  for (const model of models) {
    if (!isPlainObject(model) || typeof model.id !== 'string' || model.id.trim().length === 0) {
      failedModelCount += 1
      pushIssue(issues, {
        code: 'invalid-model',
        severity: 'error',
        message: 'a model entry has no non-empty string id and cannot be enriched',
      })
      continue
    }
    if (!apiSupported) continue
    const manualOverride = resolveModelOverride(overrides, model.id)
    let enriched
    try {
      enriched = enrichModel({
        id: model.id,
        configured: model,
        manualOverride,
        api,
        presetId,
        routeCompat,
        registryCache,
        offlineCatalog,
        familyRules,
      })
    } catch (error) {
      failedModelCount += 1
      pushIssue(issues, {
        code: error instanceof ApiManagerError ? error.code : 'model-enrichment-failed',
        severity: 'error',
        modelId: model.id,
        message: redactSecretText(messageOf(error)),
      })
      continue
    }
    suggestions.push(enriched)
    const suggested = enriched.profile
    const provenance = enriched.provenance
    const missing = (field, code) => {
      if (model[field] !== undefined || suggested[field] === undefined) return
      // A manual override is a requested change; its value is not a missing field.
      if (provenance[field] === 'manual') return
      pushIssue(issues, {
        code,
        modelId: model.id,
        field,
        severity: 'warning',
        suggested: suggested[field],
        source: provenance[field],
        message: `model "${model.id}" does not configure ${field}; the ${provenance[field]} layer suggests ${JSON.stringify(suggested[field])}`,
      })
    }
    missing('contextWindow', 'missing-context-window')
    missing('maxTokens', 'missing-max-tokens')
    missing('input', 'missing-input-modalities')
    missing('reasoningEfforts', 'missing-reasoning-efforts')

    const configuredCompat = isPlainObject(model.compat) ? model.compat : {}
    const suggestedCompat = isPlainObject(suggested.compat) ? suggested.compat : {}
    const missingCompatFields = Object.keys(suggestedCompat).filter(field => configuredCompat[field] === undefined)
    if (missingCompatFields.length > 0) {
      pushIssue(issues, {
        code: 'missing-compat',
        modelId: model.id,
        field: 'compat',
        severity: 'warning',
        fields: missingCompatFields,
        message: `model "${model.id}" omits compat ${missingCompatFields.join(', ')}; add ${missingCompatFields.length === 1 ? 'it' : 'them'} or the route may misbehave`,
      })
    }
    for (const warning of enriched.warnings) {
      pushIssue(issues, {
        code: warning.code,
        modelId: model.id,
        field: warning.field ?? null,
        severity: 'warning',
        message: warning.message,
        details: warning,
      })
    }
    if (enriched.meta.isNonChat) {
      pushIssue(issues, {
        code: 'non-chat-model',
        modelId: model.id,
        field: null,
        severity: 'warning',
        message: `model "${model.id}" looks like a non-chat model; a chat route will not use it meaningfully`,
      })
    }
    if (
      enriched.meta.matchedCatalogId === null
      && enriched.meta.matchedRegistryId === null
      && enriched.meta.matchedRuleId === null
      && enriched.meta.ambiguousModelIds.length === 0
    ) {
      pushIssue(issues, {
        code: 'unknown-model',
        modelId: model.id,
        field: null,
        severity: 'info',
        message: `model "${model.id}" matched no offline catalog entry, online registry entry, or family rule; only configured and conservative defaults apply`,
      })
    }
  }

  const issueCount = issues.length
  const warningCount = issues.filter(issue => issue.severity === 'warning').length
  const infoCount = issues.filter(issue => issue.severity === 'info').length
  const errorCount = issues.filter(issue => issue.severity === 'error').length
  const missingFieldCount = issues.filter(issue => String(issue.code).startsWith('missing-')).length
  const summary = {
    modelCount: models.length,
    suggestionCount: suggestions.length,
    failedModelCount,
    issueCount,
    warningCount,
    infoCount,
    errorCount,
    missingFieldCount,
    message:
      issueCount === 0
        ? `provider "${providerId}" looks complete across ${suggestions.length} audited model(s)`
        : `provider "${providerId}" has ${issueCount} issue(s) across ${suggestions.length} audited model(s)`,
  }
  return {
    providerId,
    api,
    modelCount: models.length,
    issueCount,
    issues,
    suggestions,
    summary,
  }
}

/**
 * Search available upstream reference models across the online registry cache
 * and the bundled offline catalog.
 *
 * Results are deduplicated by model id (preferring the live registry cache
 * entry when both sources carry the same id), filtered to chat-capable models
 * unless a query explicitly matches a non-chat id, and ranked by match quality.
 * @param {object} [options] - search options.
 * @param {string} [options.query] - optional search string.
 * @param {number} [options.limit] - maximum models to return (default 40).
 * @param {{ listModels?: () => object[] }} [options.registryCache] - live registry cache.
 * @param {object} [options.offlineCatalog] - custom catalog instead of the bundled one.
 * @returns {{ models: object[], total: number }} matching reference models and total matches before limiting.
 */
export function searchCatalogModels({ query = '', limit = 40, registryCache, offlineCatalog } = {}) {
  const catalog = normalizeCatalog(offlineCatalog === undefined ? loadBundledCatalog() : offlineCatalog)
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 40
  const byId = new Map()
  const record = (entry, sourceLabel, key) => {
    if (!isPlainObject(entry)) return
    const id = typeof entry.id === 'string' ? entry.id.trim() : key
    if (!id || byId.has(id)) return
    byId.set(id, {
      id,
      name: typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : id,
      contextWindow: positiveInteger(entry.contextWindow) ?? null,
      maxTokens: positiveInteger(entry.maxTokens) ?? null,
      input: normalizeInputClaim(entry.input) ?? ['text'],
      reasoning: entry.reasoning === true || (Array.isArray(entry.efforts) && entry.efforts.length > 0),
      source: typeof entry.source === 'string' && entry.source.length > 0 ? entry.source : sourceLabel,
    })
  }
  const registryModels = registryCache?.models
  if (isPlainObject(registryModels)) {
    for (const [key, entry] of Object.entries(registryModels)) record(entry, 'registry', key)
  } else if (typeof registryCache?.listModels === 'function') {
    for (const entry of registryCache.listModels()) record(entry, 'registry')
  }
  for (const [key, entry] of Object.entries(catalog.models)) record(entry, 'catalog', key)

  const text = typeof query === 'string' ? query.trim() : ''
  const rawQuery = text.toLowerCase()
  const referenceIds = new Set(matchReferenceModels(text, catalog, registryCache).ids)
  const tokens = rawQuery === '' ? [] : rawQuery.split(/\s+/u).filter(Boolean)
  const scored = []
  for (const entry of byId.values()) {
    const nonChat = isLikelyNonChatModel(entry.id).nonChat
    if (tokens.length === 0) {
      if (nonChat) continue
      const group = deriveVendorGroup(entry.id)
      const featured = group === 'Anthropic' || group === 'OpenAI' || group === 'Google' || group === 'DeepSeek'
        || group === 'Qwen' || group === 'Zhipu GLM' || group === 'Moonshot' || group === 'MiniMax' || group === 'xAI'
      const score = (featured ? 100 : 10) + (entry.reasoning ? 20 : 0) + (entry.input.includes('image') ? 10 : 0)
      scored.push({ entry, score })
      continue
    }
    const idLower = entry.id.toLowerCase()
    const nameLower = entry.name.toLowerCase()
    const dotHyphen = canonModelId(entry.id).dotHyphenNormalized
    const referenceMatch = referenceIds.has(entry.id)
    const haystack = `${idLower} ${dotHyphen} ${nameLower}`
    if (!referenceMatch && !tokens.every(token => haystack.includes(token))) continue
    let score = 50
    if (referenceMatch) score = 1250
    else if (idLower === rawQuery || dotHyphen === rawQuery) score = 1000
    else if (idLower.startsWith(rawQuery) || dotHyphen.startsWith(rawQuery)) score = 500
    else if (idLower.includes(rawQuery) || dotHyphen.includes(rawQuery)) score = 250
    else if (nameLower.includes(rawQuery)) score = 120
    if (nonChat) score -= 40
    scored.push({ entry, score })
  }
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    if (left.entry.id.length !== right.entry.id.length) return left.entry.id.length - right.entry.id.length
    return left.entry.id.localeCompare(right.entry.id)
  })
  return {
    models: scored.slice(0, cap).map(item => item.entry),
    total: scored.length,
  }
}
