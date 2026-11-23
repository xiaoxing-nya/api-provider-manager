/**
 * DSH pi-ai schema constants, custom-provider presets, and profile validation.
 *
 * The constants mirror `@deepseek-ai/dsh-llm-pi-ai` 0.2.2-rc.3 so a profile the
 * manager writes is accepted by the installed adapter without a second
 * translation layer. The presets cover pure custom providers only: a deployment
 * that can name a built-in catalog route should do that instead.
 * @module @xiaoxing/api-provider-manager/presets
 */

import { ApiManagerError, messageOf } from './errors.js'
import { validateCredentialRef, validateCustomProviderId } from './reserved.js'

/** Wire protocols a custom provider may speak. */
export const SUPPORTED_PROTOCOLS = Object.freeze([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
])

/** Selectable reasoning levels, in pi-ai escalation order. */
export const THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Reasoning levels the Gemini API accepts; the adapter clamps everything else. */
export const GEMINI_THINKING_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high'])

/** Reasoning-dispatch wire formats a profile may name. */
export const SUPPORTED_THINKING_FORMATS = Object.freeze([
  'openai',
  'deepseek',
  'openrouter',
  'together',
  'baseten',
  'zai',
  'qwen',
  'chat-template',
  'qwen-chat-template',
  'string-thinking',
  'ant-ling',
])

/** Output-cap field spellings pi-ai accepts. */
export const MAX_TOKENS_FIELDS = Object.freeze(['max_completion_tokens', 'max_tokens'])

/** Reasoning-budget field spellings pi-ai accepts. */
export const THINKING_TOKEN_BUDGET_FIELDS = Object.freeze([
  'thinking_token_budget',
  'thinking_budget',
  'thinking_budget_tokens',
])

/** Prompt-cache marker conventions pi-ai accepts. */
export const CACHE_CONTROL_FORMATS = Object.freeze(['anthropic'])

/** Request modalities a model may declare. */
export const MODALITIES = Object.freeze(['text', 'image'])

/**
 * The pi-ai compat fields each supported protocol offers, in schema order.
 * A field outside its protocol's list is refused rather than silently dropped.
 */
export const COMPAT_FIELDS_BY_API = Object.freeze({
  'openai-completions': Object.freeze([
    'supportsStore',
    'supportsDeveloperRole',
    'supportsReasoningEffort',
    'supportsUsageInStreaming',
    'supportsFinishReason',
    'maxTokensField',
    'requiresToolResultName',
    'requiresAssistantAfterToolResult',
    'requiresThinkingAsText',
    'requiresReasoningContentOnAssistantMessages',
    'thinkingFormat',
    'chatTemplateKwargs',
    'chatTemplateArgs',
    'supportsThinkingTokenBudget',
    'thinkingTokenBudgetField',
    'vllmPriority',
    'supportsStrictMode',
    'cacheControlFormat',
    'supportsLongCacheRetention',
  ]),
  'openai-responses': Object.freeze([
    'supportsDeveloperRole',
    'supportsMaxOutputTokens',
    'supportsStrictMode',
    'supportsLongCacheRetention',
  ]),
  'anthropic-messages': Object.freeze([
    'supportsEagerToolInputStreaming',
    'supportsLongCacheRetention',
    'supportsCacheControlOnTools',
    'supportsTemperature',
    'forceAdaptiveThinking',
    'allowEmptySignature',
    'supportsStrictTools',
  ]),
  'google-generative-ai': Object.freeze([]),
})

/**
 * Custom-provider archetypes, in the order the settings page offers them.
 * Every preset describes a provider the deployment supplies itself, never a
 * built-in catalog route.
 */
export const CUSTOM_GATEWAY_PRESETS = Object.freeze([
  Object.freeze({
    id: 'custom-relay-openai',
    name: 'Custom aggregator / relay',
    description: 'OpenAI-compatible aggregator or relay such as New-API, One-API, CLIProxyAPI, or AnyRouter.',
    api: 'openai-completions',
    defaultContextWindow: 128000,
    defaultMaxTokens: 16384,
    recommendedCompat: Object.freeze({
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
    }),
    supportsProtocolSplit: true,
  }),
  Object.freeze({
    id: 'custom-openai-chat',
    name: 'Custom OpenAI Chat Completions',
    description: 'An OpenAI Chat Completions endpoint operated by the deployment.',
    api: 'openai-completions',
    defaultContextWindow: 128000,
    defaultMaxTokens: 16384,
    recommendedCompat: Object.freeze({ supportsStore: false }),
  }),
  Object.freeze({
    id: 'custom-openai-responses',
    name: 'Custom OpenAI Responses',
    description: 'An OpenAI Responses endpoint operated by the deployment.',
    api: 'openai-responses',
    defaultContextWindow: 128000,
    defaultMaxTokens: 16384,
    recommendedCompat: Object.freeze({}),
  }),
  Object.freeze({
    id: 'custom-anthropic',
    name: 'Custom Anthropic Messages',
    description: 'An Anthropic Messages endpoint operated by the deployment or a compatible gateway.',
    api: 'anthropic-messages',
    defaultContextWindow: 200000,
    defaultMaxTokens: 16384,
    recommendedCompat: Object.freeze({}),
  }),
  Object.freeze({
    id: 'custom-gemini',
    name: 'Custom Gemini API',
    description: 'A Gemini API endpoint operated by the deployment.',
    api: 'google-generative-ai',
    requiresApiKey: true,
    defaultContextWindow: 1048576,
    defaultMaxTokens: 65536,
    recommendedCompat: Object.freeze({}),
  }),
])

/** Compat fields carrying a boolean switch. */
const BOOLEAN_COMPAT_FIELDS = new Set([
  'supportsStore',
  'supportsDeveloperRole',
  'supportsReasoningEffort',
  'supportsUsageInStreaming',
  'supportsFinishReason',
  'requiresToolResultName',
  'requiresAssistantAfterToolResult',
  'requiresThinkingAsText',
  'requiresReasoningContentOnAssistantMessages',
  'supportsThinkingTokenBudget',
  'supportsStrictMode',
  'supportsLongCacheRetention',
  'supportsMaxOutputTokens',
  'supportsEagerToolInputStreaming',
  'supportsCacheControlOnTools',
  'supportsTemperature',
  'forceAdaptiveThinking',
  'allowEmptySignature',
  'supportsStrictTools',
])

/** Compat fields carrying one value from a closed set. */
const ENUM_COMPAT_FIELDS = new Map([
  ['maxTokensField', MAX_TOKENS_FIELDS],
  ['thinkingFormat', SUPPORTED_THINKING_FORMATS],
  ['thinkingTokenBudgetField', THINKING_TOKEN_BUDGET_FIELDS],
  ['cacheControlFormat', CACHE_CONTROL_FORMATS],
])

/** Compat fields carrying a request template dictionary. */
const OBJECT_COMPAT_FIELDS = new Set(['chatTemplateKwargs', 'chatTemplateArgs'])

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
 * Report an invalid model profile.
 * @param {string} message - actionable detail.
 * @param {Record<string, unknown>} [details] - structured context.
 * @returns {never} always throws.
 */
function invalidModelProfile(message, details) {
  throw new ApiManagerError('invalid-model-profile', message, details)
}

/**
 * Report an invalid provider profile.
 * @param {string} providerId - provider route key, for diagnostics.
 * @param {string} detail - actionable detail.
 * @returns {never} always throws.
 */
function invalidProviderProfile(providerId, detail) {
  throw new ApiManagerError('invalid-provider-profile', `provider "${providerId}" ${detail}`, { provider: providerId })
}

/**
 * List every preset.
 * @returns {object[]} shallow copies of the presets, in offer order.
 */
export function listPresets() {
  return CUSTOM_GATEWAY_PRESETS.map(preset => ({ ...preset }))
}

/**
 * Read one preset by id.
 * @param {string} id - preset id.
 * @returns {object | undefined} a shallow copy of the preset, or `undefined` when no preset has that id.
 */
export function getPreset(id) {
  const preset = CUSTOM_GATEWAY_PRESETS.find(candidate => candidate.id === id)
  return preset === undefined ? undefined : { ...preset }
}

/**
 * Keep only the compat fields one protocol offers and that carry a value.
 *
 * A `null` or `undefined` value states nothing, and so does an empty template
 * dictionary, so both are dropped rather than written as a configured switch.
 * @param {unknown} compat - configured compat switches.
 * @param {string} api - wire protocol.
 * @returns {Record<string, unknown>} the fields the protocol takes, in input order.
 */
export function filterCompatForApi(compat, api) {
  const offered = COMPAT_FIELDS_BY_API[api]
  if (offered === undefined || !isPlainObject(compat)) return {}
  const filtered = {}
  for (const [field, value] of Object.entries(compat)) {
    if (!offered.includes(field)) continue
    if (value === null || value === undefined) continue
    if (isPlainObject(value) && Object.keys(value).length === 0) continue
    filtered[field] = value
  }
  return filtered
}

/**
 * Normalize selectable reasoning efforts for one protocol.
 *
 * `false` declares a non-reasoning model and survives as `false`; an absent or
 * empty declaration becomes `undefined`; levels the protocol cannot dispatch
 * are dropped. The Gemini API takes only its four documented levels, while the
 * OpenAI-style protocols take the pi-ai levels and require at least one level
 * beyond `off`.
 * @param {unknown} efforts - declared efforts: `false`, an object, or nothing.
 * @param {string} api - wire protocol.
 * @returns {false | Record<string, string | null> | undefined} the normalized declaration.
 */
export function normalizeReasoningEffortsForApi(efforts, api) {
  if (efforts === false) return false
  if (efforts === undefined || efforts === null) return undefined
  if (!isPlainObject(efforts)) return undefined
  const entries = Object.entries(efforts)
  if (entries.length === 0) return undefined
  const normalized = {}
  if (api === 'google-generative-ai') {
    for (const level of GEMINI_THINKING_LEVELS) {
      const value = efforts[level]
      if (typeof value === 'string' && value.length > 0) normalized[level] = value
    }
    return Object.keys(normalized).length === 0 ? undefined : normalized
  }
  for (const level of THINKING_LEVELS) {
    if (!Object.hasOwn(efforts, level)) continue
    const value = efforts[level]
    if (level === 'off') {
      if (value === null) normalized.off = null
      else if (typeof value === 'string' && value.length > 0) normalized.off = value
      continue
    }
    if (typeof value === 'string' && value.length > 0) normalized[level] = value
  }
  const offersThinking = THINKING_LEVELS.some(level => level !== 'off' && Object.hasOwn(normalized, level))
  return offersThinking ? normalized : undefined
}

/**
 * Validate a model profile against one protocol.
 * @param {unknown} model - model profile to validate.
 * @param {string} api - wire protocol the model speaks.
 * @returns {object} the validated model profile.
 * @throws {ApiManagerError} `invalid-model-profile` when any field is invalid.
 */
export function validateModelProfile(model, api) {
  if (!isPlainObject(model)) invalidModelProfile('model profile must be an object', { model })
  const id = model.id
  if (typeof id !== 'string' || id.trim().length === 0) {
    invalidModelProfile('model profile needs a non-empty string id', { id })
  }
  if (id !== id.trim()) invalidModelProfile(`model id "${id}" must not start or end with whitespace`, { id })
  if (model.name !== undefined && (typeof model.name !== 'string' || model.name.trim().length === 0)) {
    invalidModelProfile(`model "${id}" name must be a non-empty string`, { id })
  }
  if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
    invalidModelProfile(`model "${id}" contextWindow must be a positive integer`, { id, contextWindow: model.contextWindow })
  }
  if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
    invalidModelProfile(`model "${id}" maxTokens must be a positive integer`, { id, maxTokens: model.maxTokens })
  }
  validateModelInput(id, model.input)
  validateModelReasoningEfforts(id, model.reasoningEfforts, api)
  validateModelCompat(id, model.compat, api)
  return model
}

/**
 * Validate a model's declared input modalities.
 * @param {string} id - model id, for diagnostics.
 * @param {unknown} input - declared modalities.
 * @returns {void}
 */
function validateModelInput(id, input) {
  if (input === undefined) return
  if (!Array.isArray(input) || input.length === 0) {
    invalidModelProfile(`model "${id}" input must be a non-empty array of ${MODALITIES.join(', ')}`, { id, input })
  }
  const seen = new Set()
  for (const modality of input) {
    if (!MODALITIES.includes(modality)) {
      invalidModelProfile(`model "${id}" input contains ${JSON.stringify(modality)}, which is not one of ${MODALITIES.join(', ')}`, { id, input })
    }
    if (seen.has(modality)) invalidModelProfile(`model "${id}" input lists "${modality}" more than once`, { id, input })
    seen.add(modality)
  }
}

/**
 * Validate a model's declared reasoning efforts.
 * @param {string} id - model id, for diagnostics.
 * @param {unknown} efforts - declared efforts.
 * @param {string} api - wire protocol.
 * @returns {void}
 */
function validateModelReasoningEfforts(id, efforts, api) {
  if (efforts === undefined || efforts === false) return
  if (!isPlainObject(efforts)) {
    invalidModelProfile(`model "${id}" reasoningEfforts must be false or an object of level to wire-value pairs`, { id, reasoningEfforts: efforts })
  }
  const levels = api === 'google-generative-ai' ? GEMINI_THINKING_LEVELS : THINKING_LEVELS
  const entries = Object.entries(efforts)
  if (entries.length === 0) {
    invalidModelProfile(`model "${id}" reasoningEfforts is empty; declare the offered levels, set false for a non-reasoning model, or omit the field`, { id })
  }
  for (const [level, value] of entries) {
    if (!levels.includes(level)) {
      invalidModelProfile(`model "${id}" reasoningEfforts.${level} is not offered by api "${api}"; the levels are ${levels.join(', ')}`, { id, level })
    }
    if (api === 'google-generative-ai') {
      if (typeof value !== 'string' || value.length === 0) {
        invalidModelProfile(`model "${id}" reasoningEfforts.${level} must be a non-empty string`, { id, level })
      }
    } else if (level === 'off') {
      if (value !== null && (typeof value !== 'string' || value.length === 0)) {
        invalidModelProfile(`model "${id}" reasoningEfforts.off may be null or a non-empty string`, { id, level })
      }
    } else if (typeof value !== 'string' || value.length === 0) {
      invalidModelProfile(`model "${id}" reasoningEfforts.${level} must be a non-empty string`, { id, level })
    }
  }
  if (api !== 'google-generative-ai' && !entries.some(([level]) => level !== 'off')) {
    invalidModelProfile(`model "${id}" reasoningEfforts offers no level beyond "off"; declare a thinking level, or set reasoningEfforts to false`, { id })
  }
}

/**
 * Validate a model's compat switches against its protocol.
 * @param {string} id - model id, for diagnostics.
 * @param {unknown} compat - configured compat switches.
 * @param {string} api - wire protocol.
 * @returns {void}
 */
function validateModelCompat(id, compat, api) {
  if (compat === undefined) return
  if (!isPlainObject(compat)) invalidModelProfile(`model "${id}" compat must be an object`, { id, compat })
  const offered = COMPAT_FIELDS_BY_API[api] ?? []
  for (const [field, value] of Object.entries(compat)) {
    if (!offered.includes(field)) {
      const switches = offered.length === 0 ? 'none' : offered.join(', ')
      invalidModelProfile(`model "${id}" compat sets "${field}", but api "${api}" does not take it; the configurable switches are ${switches}`, { id, field })
    }
    if (value === null || value === undefined) {
      invalidModelProfile(`model "${id}" compat "${field}" has no value; remove the key or give it one`, { id, field })
    }
    assertCompatValue(id, field, value)
  }
}

/**
 * Validate one compat value against the field's pi-ai type.
 * @param {string} id - model id, for diagnostics.
 * @param {string} field - compat field name.
 * @param {unknown} value - configured value.
 * @returns {void}
 */
function assertCompatValue(id, field, value) {
  if (BOOLEAN_COMPAT_FIELDS.has(field)) {
    if (typeof value !== 'boolean') invalidModelProfile(`model "${id}" compat "${field}" must be a boolean`, { id, field })
    return
  }
  const allowed = ENUM_COMPAT_FIELDS.get(field)
  if (allowed !== undefined) {
    if (!allowed.includes(value)) {
      invalidModelProfile(`model "${id}" compat "${field}" must be one of ${allowed.join(', ')}`, { id, field })
    }
    return
  }
  if (OBJECT_COMPAT_FIELDS.has(field)) {
    if (!isPlainObject(value)) invalidModelProfile(`model "${id}" compat "${field}" must be an object`, { id, field })
    return
  }
  if (field === 'vllmPriority' && (typeof value !== 'number' || !Number.isFinite(value))) {
    invalidModelProfile(`model "${id}" compat "vllmPriority" must be a finite number`, { id, field })
  }
}

/**
 * Validate a provider profile.
 * @param {unknown} providerId - custom provider route key.
 * @param {unknown} profile - provider profile to validate.
 * @param {readonly { provider?: string, declared?: boolean }[]} [configurableProviders] - provider entries the
 *   DSH configuration offers.
 * @returns {object} the validated provider profile.
 * @throws {ApiManagerError} `invalid-provider-id` or `reserved-native-provider` for the id,
 *   `invalid-provider-profile` for a provider field, `invalid-model-profile` for a model,
 *   `invalid-credential-ref` for `apiKeyEnv`.
 */
export function validateProviderProfile(providerId, profile, configurableProviders = []) {
  const id = validateCustomProviderId(providerId, configurableProviders)
  if (!isPlainObject(profile)) invalidProviderProfile(id, 'profile must be an object')
  validateBaseURL(id, profile.baseURL)
  if (!SUPPORTED_PROTOCOLS.includes(profile.api)) {
    invalidProviderProfile(id, `api must be one of ${SUPPORTED_PROTOCOLS.join(', ')}; got ${JSON.stringify(profile.api)}`)
  }
  validateModels(id, profile.models, profile.api)
  if (profile.apiKeyEnv !== undefined) validateCredentialRef(profile.apiKeyEnv)
  validateHeaders(id, profile.headers)
  if (profile.name !== undefined && (typeof profile.name !== 'string' || profile.name.trim().length === 0)) {
    invalidProviderProfile(id, 'name must be a non-empty string when present')
  }
  return profile
}

/**
 * Validate a provider base URL.
 * @param {string} providerId - provider route key, for diagnostics.
 * @param {unknown} baseURL - configured endpoint URL.
 * @returns {void}
 */
function validateBaseURL(providerId, baseURL) {
  if (typeof baseURL !== 'string' || baseURL.trim().length === 0) {
    invalidProviderProfile(providerId, 'baseURL must be a non-empty string')
  }
  if (baseURL !== baseURL.trim()) {
    invalidProviderProfile(providerId, `baseURL "${baseURL}" must not start or end with whitespace`)
  }
  let url
  try {
    url = new URL(baseURL)
  } catch {
    invalidProviderProfile(providerId, `baseURL "${baseURL}" is not a valid absolute URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    invalidProviderProfile(providerId, `baseURL "${baseURL}" must use http: or https:`)
  }
  if (url.username !== '' || url.password !== '') {
    invalidProviderProfile(providerId, `baseURL "${baseURL}" must not embed credentials`)
  }
  if (url.search !== '') {
    invalidProviderProfile(providerId, `baseURL "${baseURL}" must not carry a query string`)
  }
  if (url.hash !== '') {
    invalidProviderProfile(providerId, `baseURL "${baseURL}" must not carry a fragment`)
  }
  if (url.hostname === '') invalidProviderProfile(providerId, `baseURL "${baseURL}" needs a host`)
}

/**
 * Validate a provider's model list.
 * @param {string} providerId - provider route key, for diagnostics.
 * @param {unknown} models - configured models.
 * @param {string} api - wire protocol the models speak.
 * @returns {void}
 */
function validateModels(providerId, models, api) {
  if (!Array.isArray(models) || models.length === 0) {
    invalidProviderProfile(providerId, 'models must be a non-empty array')
  }
  const seen = new Set()
  for (const model of models) {
    validateModelProfile(model, api)
    if (seen.has(model.id)) invalidProviderProfile(providerId, `models lists "${model.id}" more than once`)
    seen.add(model.id)
  }
}

/**
 * Validate a provider's extra request headers.
 * @param {string} providerId - provider route key, for diagnostics.
 * @param {unknown} headers - configured headers.
 * @returns {void}
 */
function validateHeaders(providerId, headers) {
  if (headers === undefined) return
  if (!isPlainObject(headers)) invalidProviderProfile(providerId, 'headers must be an object of header name to string value')
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') invalidProviderProfile(providerId, `headers.${name} must be a string`)
  }
  try {
    new Headers(headers)
  } catch (error) {
    invalidProviderProfile(providerId, `headers are not valid for new Headers(): ${messageOf(error)}`)
  }
}
