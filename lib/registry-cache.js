/**
 * Offline-first model registry cache for `@xiaoxing/api-provider-manager`.
 *
 * The module owns the single normalized "model entry" contract used by both the
 * bundled catalog (`data/model-catalog.json`) and the live registry cache written
 * by `RegistryCacheManager`:
 *
 *   {
 *     id: string,                    // canonical model id (vendor prefix stripped)
 *     name: string,
 *     contextWindow: number | null,
 *     maxTokens: number | null,
 *     input: string[],               // e.g. ['text', 'image']
 *     reasoning: boolean,
 *     allowOff: boolean,             // reasoning can be disabled
 *     efforts: string[],             // e.g. ['off', 'low', 'high', 'max']
 *     interleavedField: string | null, // e.g. 'reasoning_content'
 *     endpoints: string[],           // e.g. ['/api/v1/chat/completions']
 *     source: string                 // 'models.dev' | 'openrouter' | 'models.dev+openrouter'
 *   }
 *
 * Upstream schemas handled here (verified against the 2026-11 live endpoints):
 *   - https://models.dev/api.json
 *       { [providerId]: { id, name, models: { [modelId]: { id, name, family,
 *         reasoning, reasoning_options: [{ type: 'toggle' } | { type: 'effort',
 *         values: [...] }], interleaved: { field }, modalities: { input, output },
 *         limit: { context, input, output }, canonical_model_id } } } }
 *   - https://openrouter.ai/api/v1/models
 *       { data: [{ id, canonical_slug, name, context_length,
 *         architecture: { input_modalities }, top_provider: { context_length,
 *         max_completion_tokens }, supported_parameters, endpoints,
 *         reasoning: { mandatory, default_enabled, supported_efforts,
 *         default_effort } }] }
 *
 * Pure Node >= 22 ESM. No external dependencies.
 */

import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Version of the on-disk cache schema. */
export const CACHE_SCHEMA_VERSION = 1

/** Default upstream endpoints. */
export const DEFAULT_MODELS_DEV_URL = 'https://models.dev/api.json'
export const DEFAULT_OPEN_ROUTER_URL = 'https://openrouter.ai/api/v1/models'

/** Default cache freshness window (24 hours). */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/** Default per-request network timeout. */
export const DEFAULT_TIMEOUT_MS = 8000

/** How long a failing upstream is skipped before it is retried again. */
export const CIRCUIT_COOLDOWN_MS = 60 * 1000

/** Canonical effort ordering; unknown levels are appended alphabetically. */
export const EFFORT_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Canonical input-modality ordering. */
export const INPUT_MODALITIES = Object.freeze(['text', 'image', 'audio', 'video', 'pdf', 'file'])

/**
 * Vendor prefixes stripped from upstream model ids. The first eleven entries are
 * the documented contract; the rest keep cross-provider ids canonical so that
 * e.g. `zhipuai/glm-5.3` and `z-ai/glm-5.3` collapse onto one entry.
 */
export const VENDOR_PREFIXES = Object.freeze([
  'deepseek',
  'anthropic',
  'openai',
  'google',
  'z-ai',
  'qwen',
  'moonshotai',
  'minimax',
  'mistralai',
  'meta-llama',
  'x-ai',
  'zhipuai',
  'zai-org',
  'deepseek-ai',
  'meta',
  'xai',
  'alibaba',
  'nvidia',
  'thinkingmachines',
  'moonshot',
  'mistral',
  'cohere',
  'amazon',
  'microsoft',
  'bytedance',
  'tencent',
  'baidu',
  'inclusionai',
  'stepfun',
  'arcee-ai',
  'sakana',
  'liquid',
  'upstage',
  'inception',
  'ai21',
  'ibm',
  'nousresearch',
  'openrouter',
  'vercel',
  'groq',
  'cerebras',
  'fireworks',
  'togetherai',
  'deepinfra',
  'sambanova',
  'perplexity',
  'huggingface',
  'ollama',
  'lmstudio',
  'vertex',
  'google-vertex',
  'bedrock',
  'amazon-bedrock',
  'azure',
])

/** Default effort list when a reasoning model exposes no explicit levels. */
const DEFAULT_EFFORTS = Object.freeze(['off', 'low', 'medium', 'high'])
/** Default effort list when upstream explicitly marks reasoning as mandatory. */
const DEFAULT_EFFORTS_MANDATORY = Object.freeze(['low', 'medium', 'high'])

/** User agent sent with registry requests. */
const USER_AGENT = '@xiaoxing/api-provider-manager registry-cache'

/** First-party model vendors: authoritative for their own models. */
const FIRST_PARTY_PROVIDERS = Object.freeze([
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'moonshotai',
  'zhipuai',
  'zai',
  'alibaba',
  'alibaba-cn',
  'mistral',
  'meta',
  'xai',
  'minimax',
  'minimax-cn',
  'cohere',
  'ai21',
  'stepfun',
  'stepfun-ai',
  'arcee',
  'inception',
  'sakana',
  'upstage',
  'liquid',
  'bailing',
  'xiaomi',
  'tencent-tokenhub',
  'byteplus',
  'huawei-maas',
  'sensenova',
  'longcat',
  'thinkingmachines',
  'nvidia',
])

/** Official cloud mirrors: useful, but never preferred over the model vendor. */
const OFFICIAL_MIRRORS = Object.freeze([
  'amazon-bedrock',
  'azure',
  'azure-cognitive-services',
  'google-vertex',
  'google-vertex-anthropic',
  'github-copilot',
])

/** Gateways and resellers: only used when nothing more authoritative exists. */
const GATEWAY_PROVIDERS = Object.freeze([
  'vercel',
  'nano-gpt',
  'groq',
  'cerebras',
  'fireworks-ai',
  'togetherai',
  'deepinfra',
  'sambanova',
  'perplexity',
  'huggingface',
])

/** Vendor names whose first-party provider id does not share a prefix. */
const VENDOR_PROVIDER_ALIASES = Object.freeze({
  zhipuai: ['zai'],
  zai: ['zhipuai'],
  qwen: ['alibaba', 'alibaba-cn'],
  bytedance: ['byteplus'],
})

/**
 * Model-id prefixes owned by each first-party provider. models.dev records
 * without a `canonical_model_id` (e.g. Anthropic's own `claude-opus-4-6`) are
 * attributed to their vendor through this table; a provider reselling someone
 * else's model (Alibaba serving `kimi-k2.5`) does not claim ownership.
 */
const PROVIDER_MODEL_PREFIXES = Object.freeze({
  anthropic: ['claude'],
  openai: ['gpt', 'o1', 'o3', 'o4', 'chatgpt', 'codex', 'text-embedding', 'dall-e', 'sora', 'whisper', 'tts'],
  google: ['gemini', 'gemma', 'palm', 'imagen', 'veo', 'lyria', 'deep-research'],
  deepseek: ['deepseek'],
  moonshotai: ['kimi', 'moonshot'],
  zhipuai: ['glm', 'chatglm'],
  zai: ['glm', 'chatglm'],
  alibaba: ['qwen', 'qwq', 'qvq'],
  'alibaba-cn': ['qwen', 'qwq', 'qvq'],
  mistral: ['mistral', 'mixtral', 'magistral', 'devstral', 'codestral', 'pixtral', 'ministral', 'voxtral', 'labs-'],
  meta: ['muse', 'llama'],
  xai: ['grok'],
  minimax: ['minimax'],
  'minimax-cn': ['minimax'],
  cohere: ['command', 'c4ai', 'aya', 'north'],
  ai21: ['jamba'],
  stepfun: ['step'],
  'stepfun-ai': ['step'],
  arcee: ['trinity'],
  inception: ['mercury'],
  sakana: ['fugu', 'sakana'],
  upstage: ['solar'],
  liquid: ['lfm', 'liquid'],
  bailing: ['ling'],
  xiaomi: ['mimo'],
  'tencent-tokenhub': ['hy'],
  byteplus: ['seed', 'dola'],
  'huawei-maas': ['openpangu'],
  sensenova: ['sensenova'],
  longcat: ['longcat'],
  thinkingmachines: ['inkling'],
  nvidia: ['nemotron'],
})

/**
 * models.dev provider tie-break order: first-party vendors, then the curated
 * `openrouter` mirror, then official cloud mirrors, then gateways. Unknown
 * providers follow alphabetically.
 */
const PROVIDER_PRIORITY = Object.freeze([
  ...FIRST_PARTY_PROVIDERS,
  'openrouter',
  ...OFFICIAL_MIRRORS,
  ...GATEWAY_PROVIDERS,
])

/* ------------------------------------------------------------------------- */
/* Small generic helpers                                                     */
/* ------------------------------------------------------------------------- */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareStrings(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** Deterministically sort an object's keys (insertion order for JSON output). */
function sortObject(object) {
  const sorted = {}
  for (const key of Object.keys(object).sort(compareStrings)) sorted[key] = object[key]
  return sorted
}

/** Keep only positive finite numbers; upstream sometimes reports `0` for unknown. */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

function parseJsonInput(payload, label) {
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload)
    } catch (error) {
      throw new TypeError(`${label} payload is not valid JSON: ${messageOf(error)}`)
    }
  }
  return payload
}

function sortByOrder(values, order) {
  const rank = (value) => {
    const index = order.indexOf(value)
    return index === -1 ? order.length : index
  }
  return values.slice().sort((a, b) => rank(a) - rank(b) || compareStrings(a, b))
}

/* ------------------------------------------------------------------------- */
/* Canonicalization                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Strip a leading `~` and any number of known vendor prefixes from a raw model
 * id. `thinkingmachines/moonshotai/Kimi-K2.6:peft:131072` becomes `kimi-k2.6`.
 *
 * @param {string} rawId
 * @returns {string}
 */
export function stripVendorPrefix(rawId) {
  let value = String(rawId ?? '').trim()
  while (value.startsWith('~')) value = value.slice(1).trim()
  for (let round = 0; round < 4; round += 1) {
    const slash = value.indexOf('/')
    if (slash <= 0) break
    const prefix = value.slice(0, slash).toLowerCase()
    if (!VENDOR_PREFIXES.includes(prefix)) break
    value = value.slice(slash + 1)
  }
  return value
}

/**
 * Canonicalize a raw upstream model id: strip `~`/vendor prefixes, drop a
 * `:<variant>` suffix (`:free`, `:batch`, `:peft:...`), lowercase, and normalize
 * whitespace/dashes. Dots and underscores are preserved so that ids such as
 * `gpt-5.4` and `deepseek-v4.1-flash` keep their upstream spelling.
 *
 * @param {string} rawId
 * @returns {string}
 */
export function canonicalizeModelId(rawId) {
  let value = stripVendorPrefix(rawId)
  const variantIndex = value.indexOf(':')
  if (variantIndex >= 0) value = value.slice(0, variantIndex)
  value = value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return value
}

/**
 * Dedupe key for a canonical id: numeric dots are normalized to dashes so that
 * `claude-sonnet-4.5` (OpenRouter spelling) and `claude-sonnet-4-5` (models.dev
 * spelling) collapse onto the same entry.
 *
 * @param {string} rawId
 * @returns {string}
 */
export function modelMatchKey(rawId) {
  return canonicalizeModelId(rawId).replace(/(?<=\d)\.(?=\d)/g, '-')
}

/** Snapshot/date suffixes that can be peeled off to derive a base model id. */
const SNAPSHOT_SUFFIX_PATTERN = /-(?:20\d{2}-\d{2}-\d{2}|\d{8}|\d{4}|\d{3})$/

/**
 * Derive the base id of a dated snapshot: `claude-opus-4-5-20251101` becomes
 * `claude-opus-4-5`, `deepseek-v4.1-flash-1017` becomes `deepseek-v4.1-flash`.
 *
 * @param {string} id
 * @returns {string}
 */
export function stripSnapshotSuffix(id) {
  const value = String(id ?? '')
  const match = SNAPSHOT_SUFFIX_PATTERN.exec(value)
  return match ? value.slice(0, match.index) : value
}

/**
 * Alternate spellings that should resolve to the same model: dot/hyphen version
 * variants, dated snapshot bases, and `-latest` aliases.
 *
 * @param {string} id canonical model id
 * @returns {string[]}
 */
export function collectIdVariants(id) {
  const value = String(id ?? '')
  if (!value) return []
  const variants = new Set()
  const dotToDash = value.replace(/(?<=\d)\.(?=\d)/g, '-')
  if (dotToDash !== value) variants.add(dotToDash)
  const dashToDot = value.replace(/(?<=-\d)-(?=\d(?!\d))/g, '.')
  if (dashToDot !== value) variants.add(dashToDot)
  const base = stripSnapshotSuffix(value)
  if (base && base !== value) variants.add(base)
  if (value.endsWith('-latest')) {
    const withoutLatest = value.slice(0, -'-latest'.length)
    if (withoutLatest) variants.add(withoutLatest)
  }
  return [...variants]
}

/* ------------------------------------------------------------------------- */
/* Field normalization                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Normalize a list of upstream effort values into the canonical effort list.
 * `none` maps to `off`; `default` is dropped; `off` is added when reasoning can
 * be disabled and removed when it is mandatory.
 *
 * @param {Iterable<string>} values
 * @param {boolean} allowOff
 * @returns {string[]}
 */
export function normalizeEfforts(values, allowOff) {
  const levels = new Set()
  for (const value of values ?? []) {
    if (typeof value !== 'string') continue
    const level = value.trim().toLowerCase()
    if (!level) continue
    if (level === 'none' || level === 'off' || level === 'disabled') {
      if (allowOff) levels.add('off')
      continue
    }
    if (level === 'default') continue
    if (EFFORT_LEVELS.includes(level)) levels.add(level)
  }
  if (allowOff) levels.add('off')
  else levels.delete('off')
  return sortByOrder([...levels], EFFORT_LEVELS)
}

function normalizeInputs(values) {
  const modalities = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') continue
    const modality = value.trim().toLowerCase()
    if (modality) modalities.add(modality)
  }
  return sortByOrder([...modalities], INPUT_MODALITIES)
}

function normalizeEndpoints(values) {
  const endpoints = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') continue
    const endpoint = value.trim()
    if (endpoint) endpoints.add(endpoint)
  }
  return [...endpoints]
}

function unionInputs(...lists) {
  return normalizeInputs(lists.flatMap((list) => (Array.isArray(list) ? list : [])))
}

function unionEndpoints(...lists) {
  return normalizeEndpoints(lists.flatMap((list) => (Array.isArray(list) ? list : [])))
}

/** Strip noise such as a trailing ` (latest)` from an upstream display name. */
function cleanModelName(name) {
  if (typeof name !== 'string') return ''
  return name
    .replace(/\s*\((?:latest|stable|current)\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeToken(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function vendorMatches(prefix, vendor) {
  const left = normalizeToken(prefix)
  const right = normalizeToken(vendor)
  if (!left || !right) return false
  return left === right || left.startsWith(right) || right.startsWith(left)
}

/**
 * OpenRouter names look like `DeepSeek: DeepSeek V4.1 Flash`. Strip the vendor
 * prefix only when it actually corresponds to the model id's vendor segment.
 */
function cleanOpenRouterName(name, rawId) {
  const text = typeof name === 'string' ? name.trim() : ''
  if (!text) return ''
  const slash = rawId.indexOf('/')
  const vendor = slash > 0 ? rawId.slice(0, slash) : ''
  const match = /^([^:]{1,48}):\s+(.+)$/.exec(text)
  if (match && match[2].trim() && vendorMatches(match[1], vendor)) return match[2].trim()
  return text
}

/* ------------------------------------------------------------------------- */
/* Per-source entry normalization                                            */
/* ------------------------------------------------------------------------- */

/**
 * Normalize one models.dev model record into the shared model entry shape.
 *
 * Reasoning rules (models.dev):
 *   - `reasoning === true` and a `toggle` option -> reasoning can be disabled.
 *   - `effort` option values are normalized to `['off'?, ...levels]`.
 *   - `reasoning === true` without explicit levels -> default four-level list.
 *   - models.dev has no "mandatory" marker, so `allowOff` defaults to true.
 *
 * @param {Record<string, unknown>} model
 * @returns {object}
 */
function normalizeModelsDevModel(model) {
  const id = canonicalizeModelId(model.id)
  const reasoning = model.reasoning === true
  let allowOff = true
  let efforts = []

  if (reasoning) {
    const options = Array.isArray(model.reasoning_options) ? model.reasoning_options : []
    let hasToggle = false
    const effortValues = []
    for (const option of options) {
      if (!isPlainObject(option)) continue
      if (option.type === 'toggle') hasToggle = true
      else if (option.type === 'effort' && Array.isArray(option.values)) {
        for (const value of option.values) if (typeof value === 'string') effortValues.push(value)
      }
    }
    // models.dev never marks reasoning as mandatory; a toggle (or any effort
    // list) means the user can turn reasoning off.
    allowOff = true
    if (effortValues.length > 0) {
      efforts = normalizeEfforts(effortValues, allowOff)
    } else {
      efforts = allowOff ? [...DEFAULT_EFFORTS] : [...DEFAULT_EFFORTS_MANDATORY]
    }
    if (hasToggle) allowOff = true
  }

  return {
    id,
    name: cleanModelName(model.name) || id,
    contextWindow: finiteOrNull(model.limit?.context),
    maxTokens: finiteOrNull(model.limit?.output),
    input: normalizeInputs(model.modalities?.input),
    reasoning,
    allowOff,
    efforts,
    interleavedField:
      isPlainObject(model.interleaved) && typeof model.interleaved.field === 'string' && model.interleaved.field
        ? model.interleaved.field
        : null,
    endpoints: [],
    source: 'models.dev',
  }
}

/**
 * Normalize one OpenRouter model record into the shared model entry shape.
 *
 * Reasoning rules (OpenRouter):
 *   - `reasoning.mandatory === true` -> `allowOff: false`, never inject `off`.
 *   - `reasoning.mandatory === false` -> `allowOff: true`, ensure `off` exists.
 *   - `none` in `supported_efforts` maps to `off`.
 *   - `supported_parameters` containing `reasoning`/`reasoning_effort` implies a
 *     reasoning model even when the `reasoning` object is absent.
 *   - `allowOff` defaults to true unless upstream explicitly says mandatory.
 *
 * @param {Record<string, unknown>} model
 * @returns {object}
 */
function normalizeOpenRouterModel(model) {
  const rawId = typeof model.id === 'string' ? model.id : ''
  const id = canonicalizeModelId(rawId)
  const reasoningInfo = isPlainObject(model.reasoning) ? model.reasoning : null
  const supportedParameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : []
  const supportsReasoningParameter =
    supportedParameters.includes('reasoning') || supportedParameters.includes('reasoning_effort')

  let reasoning = false
  let allowOff = true
  let efforts = []

  if (reasoningInfo) {
    reasoning = true
    const mandatory = reasoningInfo.mandatory === true
    const supportedEfforts = Array.isArray(reasoningInfo.supported_efforts) ? reasoningInfo.supported_efforts : []
    const mapped = supportedEfforts
      .filter((value) => typeof value === 'string')
      .map((value) => (value.trim().toLowerCase() === 'none' ? 'off' : value.trim().toLowerCase()))
    if (mandatory) {
      // Explicit upstream evidence: reasoning cannot be disabled.
      allowOff = false
      efforts = normalizeEfforts(mapped.filter((level) => level !== 'off'), allowOff)
      if (efforts.length === 0) efforts = [...DEFAULT_EFFORTS_MANDATORY]
    } else {
      allowOff = true
      efforts = normalizeEfforts(mapped, allowOff)
      if (efforts.length === 0) efforts = [...DEFAULT_EFFORTS]
    }
  } else if (supportsReasoningParameter) {
    reasoning = true
    allowOff = true
    efforts = [...DEFAULT_EFFORTS]
  }

  return {
    id,
    name: cleanOpenRouterName(model.name, rawId) || id,
    contextWindow: finiteOrNull(model.top_provider?.context_length) ?? finiteOrNull(model.context_length),
    maxTokens: finiteOrNull(model.top_provider?.max_completion_tokens),
    input: normalizeInputs(model.architecture?.input_modalities),
    reasoning,
    allowOff,
    efforts,
    interleavedField: null,
    endpoints: normalizeEndpoints(model.endpoints),
    source: 'openrouter',
  }
}

/* ------------------------------------------------------------------------- */
/* Entry merging                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Resolve the reasoning fields of two entries. `allowOff` is only false when an
 * upstream source explicitly marks reasoning as mandatory; `off` is injected
 * into `efforts` when reasoning can be disabled and removed when it cannot.
 */
function resolveReasoning(left, right) {
  const reasoning = Boolean(left?.reasoning || right?.reasoning)
  if (!reasoning) return { reasoning: false, allowOff: true, efforts: [] }
  const allowOff = (left?.allowOff ?? true) && (right?.allowOff ?? true)
  const levels = new Set()
  for (const list of [left?.efforts, right?.efforts]) {
    for (const level of Array.isArray(list) ? list : []) {
      if (typeof level !== 'string') continue
      const normalized = level.trim().toLowerCase()
      if (!normalized) continue
      if (normalized === 'none' || normalized === 'off' || normalized === 'disabled') {
        if (allowOff) levels.add('off')
        continue
      }
      if (normalized === 'default') continue
      if (EFFORT_LEVELS.includes(normalized)) levels.add(normalized)
    }
  }
  if (allowOff) levels.add('off')
  else levels.delete('off')
  let efforts = sortByOrder([...levels], EFFORT_LEVELS)
  if (efforts.length === 0) efforts = allowOff ? [...DEFAULT_EFFORTS] : [...DEFAULT_EFFORTS_MANDATORY]
  return { reasoning: true, allowOff, efforts }
}

/**
 * Merge another entry produced by the same upstream source into `target`
 * (models.dev has many providers exposing the same model; OpenRouter has
 * `:free`/`:batch` variants of the same model).
 *
 * models.dev providers are visited in `PROVIDER_PRIORITY` order, so the first
 * entry is the most authoritative one: it keeps its id, name, limits, and input
 * modalities. Reasoning is additive (any provider that exposes reasoning wins),
 * and the first non-null interleaved field is kept.
 */
function mergeEntryInto(target, incoming) {
  if (!isPlainObject(target) || !isPlainObject(incoming)) return target
  if (!target.name && incoming.name) target.name = incoming.name
  if (target.contextWindow === null) target.contextWindow = incoming.contextWindow
  if (target.maxTokens === null) target.maxTokens = incoming.maxTokens
  if (!Array.isArray(target.input) || target.input.length === 0) target.input = incoming.input

  const reasoning = Boolean(target.reasoning || incoming.reasoning)
  if (!reasoning) {
    target.reasoning = false
    target.allowOff = true
    target.efforts = []
  } else {
    target.reasoning = true
    target.allowOff = (target.allowOff ?? true) && (incoming.allowOff ?? true)
    if ((!target.efforts || target.efforts.length === 0) && Array.isArray(incoming.efforts) && incoming.efforts.length) {
      target.efforts = incoming.efforts
    }
    target.efforts = normalizeEfforts(target.efforts, target.allowOff)
  }

  if (!target.interleavedField && incoming.interleavedField) target.interleavedField = incoming.interleavedField
  target.endpoints = unionEndpoints(target.endpoints, incoming.endpoints)
  return target
}

/**
 * Merge the models.dev and OpenRouter views of one model into a single entry.
 * The stored id keeps the models.dev spelling when available (e.g.
 * `claude-sonnet-4-5`), the OpenRouter spelling becomes an alias. models.dev is
 * authoritative for capability numbers (its provider priority already picked the
 * best first-party record); OpenRouter fills gaps and contributes endpoints.
 */
function mergeEntries(modelsDevEntry, openRouterEntry, storedId) {
  const reasoning = resolveReasoning(modelsDevEntry, openRouterEntry)
  return {
    id: storedId,
    name: openRouterEntry?.name || modelsDevEntry?.name || storedId,
    contextWindow: modelsDevEntry?.contextWindow ?? openRouterEntry?.contextWindow ?? null,
    maxTokens: modelsDevEntry?.maxTokens ?? openRouterEntry?.maxTokens ?? null,
    input: unionInputs(modelsDevEntry?.input, openRouterEntry?.input),
    reasoning: reasoning.reasoning,
    allowOff: reasoning.allowOff,
    efforts: reasoning.efforts,
    interleavedField: modelsDevEntry?.interleavedField ?? openRouterEntry?.interleavedField ?? null,
    endpoints: unionEndpoints(openRouterEntry?.endpoints, modelsDevEntry?.endpoints),
    source:
      modelsDevEntry && openRouterEntry
        ? 'models.dev+openrouter'
        : modelsDevEntry
          ? 'models.dev'
          : 'openrouter',
  }
}

/* ------------------------------------------------------------------------- */
/* Snapshot parsing                                                          */
/* ------------------------------------------------------------------------- */

function providerRank(providerId) {
  const index = PROVIDER_PRIORITY.indexOf(providerId)
  return index === -1 ? PROVIDER_PRIORITY.length : index
}

/** Vendor segment of a models.dev record (`deepseek/deepseek-v4.1-flash` -> `deepseek`). */
function modelVendor(model, providerId) {
  const canonical = typeof model.canonical_model_id === 'string' ? model.canonical_model_id : ''
  const source = canonical || (typeof model.id === 'string' ? model.id : '')
  const slash = source.indexOf('/')
  if (slash > 0) return source.slice(0, slash)
  // A first-party provider's own record has no vendor prefix: attribute it to
  // the provider only when the model id belongs to that provider's family.
  const prefixes = PROVIDER_MODEL_PREFIXES[providerId]
  if (!prefixes) return ''
  const id = canonicalizeModelId(model.id)
  return prefixes.some((prefix) => id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(prefix))
    ? providerId
    : ''
}

/** True when `providerId` is the first-party provider for `vendor`. */
function providerMatchesVendor(providerId, vendor) {
  if (!vendor || OFFICIAL_MIRRORS.includes(providerId)) return false
  const provider = normalizeToken(providerId)
  const target = normalizeToken(vendor)
  if (!provider || !target) return false
  if (provider === target || provider.startsWith(target) || target.startsWith(provider)) return true
  const aliases = VENDOR_PROVIDER_ALIASES[target] ?? []
  return aliases.some((alias) => normalizeToken(alias) === provider)
}

/**
 * Rank a models.dev candidate record for one model. Lower is better:
 *   0 - the model vendor's own provider (authoritative limits/name),
 *   1 - the curated `openrouter` mirror,
 *   2 - official cloud mirrors (Bedrock, Azure, Vertex, ...),
 *   3+ - gateways/resellers in `PROVIDER_PRIORITY` order.
 */
function candidateRank(candidate) {
  if (providerMatchesVendor(candidate.providerId, candidate.vendor)) return 0
  if (candidate.providerId === 'openrouter') return 1
  if (OFFICIAL_MIRRORS.includes(candidate.providerId)) return 2
  return 3 + providerRank(candidate.providerId)
}

/**
 * Turn a parsed snapshot map plus alias candidates into the public
 * `{ models, aliases }` shape with deterministic ordering.
 */
function finalizeSnapshot(byMatch, aliasTargets) {
  const models = {}
  const keyToStored = new Map()
  for (const [matchKey, entry] of byMatch) {
    models[entry.id] = entry
    keyToStored.set(matchKey, entry.id)
  }
  const aliases = {}
  for (const [form, matchKey] of aliasTargets) {
    const target = keyToStored.get(matchKey)
    if (!target || form === target) continue
    if (Object.prototype.hasOwnProperty.call(models, form)) continue
    aliases[form] = target
  }
  return { models: sortObject(models), aliases: sortObject(aliases) }
}

/**
 * Parse a `models.dev/api.json` payload into normalized model entries.
 *
 * Every provider is parsed, but for a model exposed by many providers the
 * vendor's own record wins, then the curated `openrouter` mirror, then official
 * cloud mirrors, then gateways. The remaining records only fill gaps (reasoning
 * support, interleaved field, endpoints). The returned map is keyed by canonical
 * model id, and `aliases` maps alternate spellings (vendor-prefixed ids,
 * `canonical_model_id` values) onto those keys.
 *
 * @param {string | Record<string, unknown>} payload JSON text or parsed payload
 * @returns {{ models: Record<string, object>, aliases: Record<string, string> }}
 */
export function parseModelsDevPayload(payload) {
  const data = parseJsonInput(payload, 'models.dev')
  if (!isPlainObject(data)) throw new TypeError('models.dev payload must be an object keyed by provider id')

  const providerIds = Object.keys(data)
    .filter((providerId) => isPlainObject(data[providerId]))
    .sort((a, b) => providerRank(a) - providerRank(b) || compareStrings(a, b))

  const candidatesByMatch = new Map()
  const aliasTargets = new Map()

  for (const providerId of providerIds) {
    const providerModels = data[providerId].models
    if (!isPlainObject(providerModels)) continue
    for (const modelId of Object.keys(providerModels).sort(compareStrings)) {
      const model = providerModels[modelId]
      if (!isPlainObject(model)) continue
      const entry = normalizeModelsDevModel(model)
      if (!entry.id) continue
      const matchKey = modelMatchKey(entry.id)
      let candidates = candidatesByMatch.get(matchKey)
      if (!candidates) {
        candidates = []
        candidatesByMatch.set(matchKey, candidates)
      }
      candidates.push({ providerId, vendor: modelVendor(model, providerId), entry })

      if (typeof model.canonical_model_id === 'string' && model.canonical_model_id) {
        const form = canonicalizeModelId(model.canonical_model_id)
        if (form) aliasTargets.set(form, matchKey)
      }
      // Record the raw spelling even when this candidate loses the priority
      // contest: it is still a valid alias for the winning entry.
      const rawForm = canonicalizeModelId(modelId)
      if (rawForm) aliasTargets.set(rawForm, matchKey)
    }
  }

  const byMatch = new Map()
  for (const [matchKey, candidates] of candidatesByMatch) {
    candidates.sort(
      (a, b) => candidateRank(a) - candidateRank(b) || compareStrings(a.providerId, b.providerId),
    )
    const [best, ...rest] = candidates
    for (const candidate of rest) mergeEntryInto(best.entry, candidate.entry)
    byMatch.set(matchKey, best.entry)
  }

  return finalizeSnapshot(byMatch, aliasTargets)
}

/**
 * Parse an `openrouter.ai/api/v1/models` payload into normalized model entries.
 *
 * `:free`/`:batch` variants collapse onto their base model, and `~vendor/...`
 * "latest" pointer ids are recorded as aliases instead of standalone entries.
 *
 * @param {string | Record<string, unknown>} payload JSON text or parsed payload
 * @returns {{ models: Record<string, object>, aliases: Record<string, string> }}
 */
export function parseOpenRouterPayload(payload) {
  const data = parseJsonInput(payload, 'OpenRouter')
  const list = Array.isArray(data) ? data : isPlainObject(data) && Array.isArray(data.data) ? data.data : null
  if (!list) throw new TypeError('OpenRouter payload must be an object with a `data` array')

  const models = list.filter((model) => isPlainObject(model))
  models.sort((a, b) => compareStrings(String(a.id ?? ''), String(b.id ?? '')))

  const byMatch = new Map()
  const aliasTargets = new Map()

  for (const model of models) {
    const rawId = typeof model.id === 'string' ? model.id : ''
    if (!rawId) continue

    if (rawId.startsWith('~')) {
      // OpenRouter "latest" pointer: alias it onto the concrete model id if one
      // exists in this snapshot (`~deepseek/deepseek-flash-latest` ->
      // `deepseek-flash-latest` -> `deepseek-flash`).
      const form = canonicalizeModelId(rawId)
      const base = form.endsWith('-latest') ? form.slice(0, -'-latest'.length) : form
      if (form && base) aliasTargets.set(form, modelMatchKey(base))
      continue
    }

    const entry = normalizeOpenRouterModel(model)
    if (!entry.id) continue
    const matchKey = modelMatchKey(entry.id)
    const existing = byMatch.get(matchKey)
    if (existing) mergeEntryInto(existing, entry)
    else byMatch.set(matchKey, entry)

    if (typeof model.canonical_slug === 'string' && model.canonical_slug) {
      const form = canonicalizeModelId(model.canonical_slug)
      if (form) aliasTargets.set(form, matchKey)
    }
  }

  return finalizeSnapshot(byMatch, aliasTargets)
}

/* ------------------------------------------------------------------------- */
/* Snapshot merging                                                          */
/* ------------------------------------------------------------------------- */

function normalizeSnapshotInput(snapshot) {
  if (!isPlainObject(snapshot)) return { models: {}, aliases: {} }
  if (isPlainObject(snapshot.models)) {
    return {
      models: snapshot.models,
      aliases: isPlainObject(snapshot.aliases) ? snapshot.aliases : {},
    }
  }
  // Allow a bare `{ [id]: entry }` map for convenience.
  return { models: snapshot, aliases: {} }
}

function indexSnapshot(snapshot) {
  const index = new Map()
  for (const key of Object.keys(snapshot.models).sort(compareStrings)) {
    const entry = snapshot.models[key]
    if (!isPlainObject(entry)) continue
    const id = typeof entry.id === 'string' && entry.id ? entry.id : key
    const matchKey = modelMatchKey(id)
    if (!matchKey || index.has(matchKey)) continue
    index.set(matchKey, { key: id, entry })
  }
  return index
}

/**
 * Merge the models.dev and OpenRouter snapshots into the final normalized map.
 *
 * The stored key is the models.dev spelling when the model exists there and the
 * OpenRouter spelling otherwise; the other spelling (plus dated snapshots and
 * dot/hyphen variants) is exposed through `aliases`, so lookups succeed for
 * either form.
 *
 * @param {{ models: Record<string, object>, aliases?: Record<string, string> } | Record<string, object> | null} modelsDevSnapshot
 * @param {{ models: Record<string, object>, aliases?: Record<string, string> } | Record<string, object> | null} openRouterSnapshot
 * @returns {{ models: Record<string, object>, aliases: Record<string, string> }}
 */
export function mergeRegistrySnapshots(modelsDevSnapshot, openRouterSnapshot) {
  const modelsDev = normalizeSnapshotInput(modelsDevSnapshot)
  const openRouter = normalizeSnapshotInput(openRouterSnapshot)
  const modelsDevIndex = indexSnapshot(modelsDev)
  const openRouterIndex = indexSnapshot(openRouter)

  const matchKeys = [...new Set([...modelsDevIndex.keys(), ...openRouterIndex.keys()])].sort(compareStrings)
  const models = {}
  const keyToStored = new Map()
  const aliasTargets = new Map()

  for (const matchKey of matchKeys) {
    const modelsDevItem = modelsDevIndex.get(matchKey)
    const openRouterItem = openRouterIndex.get(matchKey)
    const storedId = modelsDevItem ? modelsDevItem.entry.id : openRouterItem.entry.id
    if (!storedId) continue
    models[storedId] = mergeEntries(modelsDevItem?.entry ?? null, openRouterItem?.entry ?? null, storedId)
    keyToStored.set(matchKey, storedId)
    for (const candidate of [modelsDevItem?.key, openRouterItem?.key]) {
      if (candidate && candidate !== storedId) aliasTargets.set(candidate, storedId)
    }
  }

  // Carry over aliases recorded while parsing each source. Alias values are
  // stored ids of that source snapshot, so resolve them through the match key.
  for (const [form, target] of [...Object.entries(modelsDev.aliases), ...Object.entries(openRouter.aliases)]) {
    const storedId = keyToStored.get(modelMatchKey(target))
    if (storedId && form !== storedId) aliasTargets.set(form, storedId)
  }

  // Derive alternate spellings (dot/hyphen variants, dated bases, `-latest`).
  for (const storedId of Object.keys(models).sort(compareStrings)) {
    for (const variant of collectIdVariants(storedId)) {
      if (variant === storedId) continue
      const target = keyToStored.get(modelMatchKey(variant))
      if (target === storedId) aliasTargets.set(variant, storedId)
    }
  }

  const aliases = {}
  for (const [form, target] of [...aliasTargets.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
    if (!target || form === target) continue
    if (Object.prototype.hasOwnProperty.call(models, form)) continue
    aliases[form] = target
  }

  return { models: sortObject(models), aliases: sortObject(aliases) }
}

/* ------------------------------------------------------------------------- */
/* Cache state helpers                                                       */
/* ------------------------------------------------------------------------- */

function createEmptySource(url) {
  return { url, etag: null, lastModified: null, checkedAt: null, modelCount: 0, models: {}, aliases: {} }
}

function createEmptyState() {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    checkedAt: null,
    sources: {
      modelsDev: createEmptySource(DEFAULT_MODELS_DEV_URL),
      openRouter: createEmptySource(DEFAULT_OPEN_ROUTER_URL),
    },
    models: {},
    aliases: {},
  }
}

function sanitizeEntry(raw, fallbackId) {
  if (!isPlainObject(raw)) return null
  const id = typeof raw.id === 'string' && raw.id ? raw.id : fallbackId
  if (!id) return null
  const reasoning = raw.reasoning === true
  const allowOff = raw.allowOff === false ? false : true
  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    contextWindow: finiteOrNull(raw.contextWindow),
    maxTokens: finiteOrNull(raw.maxTokens),
    input: normalizeInputs(raw.input),
    reasoning,
    allowOff,
    efforts: reasoning ? normalizeEfforts(Array.isArray(raw.efforts) ? raw.efforts : [], allowOff) : [],
    interleavedField:
      typeof raw.interleavedField === 'string' && raw.interleavedField ? raw.interleavedField : null,
    endpoints: normalizeEndpoints(raw.endpoints),
    source: typeof raw.source === 'string' && raw.source ? raw.source : 'cache',
  }
}

function sanitizeModelsMap(raw) {
  const models = {}
  if (!isPlainObject(raw)) return models
  for (const key of Object.keys(raw).sort(compareStrings)) {
    const entry = sanitizeEntry(raw[key], key)
    if (entry) models[key] = entry
  }
  return models
}

function sanitizeAliasesMap(raw, models) {
  const aliases = {}
  if (!isPlainObject(raw)) return aliases
  for (const key of Object.keys(raw).sort(compareStrings)) {
    const target = raw[key]
    if (typeof target !== 'string' || !target) continue
    if (!Object.prototype.hasOwnProperty.call(models, target)) continue
    if (Object.prototype.hasOwnProperty.call(models, key)) continue
    aliases[key] = target
  }
  return aliases
}

function sanitizeSourceSnapshot(raw, fallbackUrl) {
  const source = createEmptySource(fallbackUrl)
  if (!isPlainObject(raw)) return source
  if (typeof raw.url === 'string' && raw.url) source.url = raw.url
  if (typeof raw.etag === 'string' && raw.etag) source.etag = raw.etag
  if (typeof raw.lastModified === 'string' && raw.lastModified) source.lastModified = raw.lastModified
  if (typeof raw.checkedAt === 'string' && raw.checkedAt) source.checkedAt = raw.checkedAt
  source.models = sanitizeModelsMap(raw.models)
  source.aliases = sanitizeAliasesMap(raw.aliases, source.models)
  source.modelCount = Object.keys(source.models).length
  return source
}

/**
 * Validate and rebuild an on-disk cache state. Returns `null` when the payload is
 * not a cache file this module understands.
 */
function sanitizeCacheState(parsed) {
  if (!isPlainObject(parsed)) return null
  if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return null
  const rawSources = isPlainObject(parsed.sources) ? parsed.sources : {}
  const sources = {
    modelsDev: sanitizeSourceSnapshot(rawSources.modelsDev, DEFAULT_MODELS_DEV_URL),
    openRouter: sanitizeSourceSnapshot(rawSources.openRouter, DEFAULT_OPEN_ROUTER_URL),
  }
  const merged = mergeRegistrySnapshots(sources.modelsDev, sources.openRouter)
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    checkedAt: typeof parsed.checkedAt === 'string' && parsed.checkedAt ? parsed.checkedAt : null,
    sources,
    models: merged.models,
    aliases: merged.aliases,
  }
}

function serializeSource(source) {
  return {
    url: source.url,
    etag: source.etag,
    lastModified: source.lastModified,
    checkedAt: source.checkedAt,
    modelCount: Object.keys(source.models).length,
    models: sortObject(source.models),
    aliases: sortObject(source.aliases),
  }
}

function serializeState(state) {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    checkedAt: state.checkedAt,
    sources: {
      modelsDev: serializeSource(state.sources.modelsDev),
      openRouter: serializeSource(state.sources.openRouter),
    },
  }
}

function buildMatchIndex(models) {
  const index = new Map()
  for (const key of Object.keys(models).sort(compareStrings)) {
    const matchKey = modelMatchKey(key)
    if (matchKey && !index.has(matchKey)) index.set(matchKey, key)
  }
  return index
}

function readHeader(response, name) {
  const headers = response && response.headers
  if (!headers) return null
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return typeof value === 'string' && value ? value : null
  }
  if (isPlainObject(headers)) {
    const lower = name.toLowerCase()
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== lower) continue
      const value = headers[key]
      if (typeof value === 'string' && value) return value
    }
  }
  return null
}

/* ------------------------------------------------------------------------- */
/* RegistryCacheManager                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Manages the on-disk registry cache: safe load, TTL staleness checks, a
 * singleflight refresh with conditional requests (ETag / Last-Modified),
 * empty-response protection, atomic writes, and model lookups.
 *
 * @example
 * const cache = new RegistryCacheManager({ cacheFilePath: '/tmp/registry.json' })
 * await cache.load()
 * if (cache.isStale()) await cache.refresh()
 * const model = cache.lookup(['claude-sonnet-4.5', 'claude-sonnet-4-5'])
 */
export class RegistryCacheManager {
  /**
   * @param {object} options
   * @param {string} options.cacheFilePath path of the JSON cache file
   * @param {string} [options.modelsDevUrl]
   * @param {string} [options.openRouterUrl]
   * @param {number} [options.ttlMs]
   * @param {number} [options.timeoutMs]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {boolean} [options.offlineOnly]
   * @param {() => number} [options.now] injectable clock (tests)
   */
  constructor(options = {}) {
    if (!isPlainObject(options)) throw new TypeError('RegistryCacheManager options must be an object')
    const {
      cacheFilePath,
      modelsDevUrl = DEFAULT_MODELS_DEV_URL,
      openRouterUrl = DEFAULT_OPEN_ROUTER_URL,
      ttlMs = DEFAULT_TTL_MS,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      fetchImpl = globalThis.fetch,
      offlineOnly = false,
      now = () => Date.now(),
    } = options

    if (typeof cacheFilePath !== 'string' || cacheFilePath.trim() === '') {
      throw new TypeError('cacheFilePath must be a non-empty string')
    }
    if (typeof modelsDevUrl !== 'string' || !modelsDevUrl) throw new TypeError('modelsDevUrl must be a non-empty string')
    if (typeof openRouterUrl !== 'string' || !openRouterUrl) {
      throw new TypeError('openRouterUrl must be a non-empty string')
    }
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError('ttlMs must be a positive finite number')
    }
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('timeoutMs must be a positive finite number')
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
    if (typeof now !== 'function') throw new TypeError('now must be a function')

    this.cacheFilePath = cacheFilePath
    this.modelsDevUrl = modelsDevUrl
    this.openRouterUrl = openRouterUrl
    this.ttlMs = ttlMs
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl
    this.offlineOnly = Boolean(offlineOnly)

    /** Non-fatal load/refresh diagnostics. */
    this.warnings = []

    this._now = now
    this._loaded = false
    this._refreshPromise = null
    this._circuits = {
      modelsDev: { openUntil: 0, lastError: null },
      openRouter: { openUntil: 0, lastError: null },
    }
    this._state = createEmptyState()
    this._matchIndex = new Map()
  }

  /** Normalized model entries keyed by canonical id. */
  get models() {
    return this._state.models
  }

  /** Alias map: alternate id -> canonical id. */
  get aliases() {
    return this._state.aliases
  }

  /** Number of canonical model entries currently held in memory. */
  get modelCount() {
    return Object.keys(this._state.models).length
  }

  /**
   * Safely read the cache file. Missing files are treated as an empty cache;
   * symlinks, non-regular files, corrupt JSON, and unknown schemas are ignored
   * with a warning instead of throwing.
   *
   * @returns {Promise<this>}
   */
  async load() {
    if (this._loaded) return this
    this._loaded = true

    let stats
    try {
      stats = await lstat(this.cacheFilePath)
    } catch (error) {
      if (error?.code !== 'ENOENT') this._warn(`cache file could not be inspected: ${messageOf(error)}`)
      this._applyState(createEmptyState())
      return this
    }

    if (stats.isSymbolicLink()) {
      this._warn('cache file is a symbolic link; refusing to read it')
      this._applyState(createEmptyState())
      return this
    }
    if (!stats.isFile()) {
      this._warn('cache file is not a regular file; refusing to read it')
      this._applyState(createEmptyState())
      return this
    }

    let raw
    try {
      raw = await readFile(this.cacheFilePath, 'utf8')
    } catch (error) {
      this._warn(`cache file could not be read: ${messageOf(error)}`)
      this._applyState(createEmptyState())
      return this
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this._warn(`cache file contains corrupt JSON (${messageOf(error)}); ignoring it`)
      this._applyState(createEmptyState())
      return this
    }

    const state = sanitizeCacheState(parsed)
    if (!state) {
      this._warn('cache file has an unsupported or invalid shape; ignoring it')
      this._applyState(createEmptyState())
      return this
    }

    this._applyState(state)
    return this
  }

  /**
   * @param {number} [now] timestamp in milliseconds
   * @returns {boolean} true when the cache is missing or older than `ttlMs`
   */
  isStale(now = this._now()) {
    const checkedAt = this._state.checkedAt
    if (!checkedAt) return true
    const timestamp = Date.parse(checkedAt)
    if (!Number.isFinite(timestamp)) return true
    return now - timestamp >= this.ttlMs
  }

  /**
   * Refresh the cache from both upstream registries.
   *
   * Concurrent calls share one in-flight refresh (singleflight). Conditional
   * requests are sent when the cache holds ETag / Last-Modified metadata, HTTP
   * 304 responses only bump `checkedAt`, and an upstream that suddenly returns
   * zero models never wipes a non-empty cached snapshot.
   *
   * @param {object} [options]
   * @param {boolean} [options.force] ignore TTL and circuit breakers
   * @param {boolean} [options.offlineOnly] skip all network access
   * @param {string} [options.modelsDevUrl]
   * @param {string} [options.openRouterUrl]
   * @param {number} [options.timeoutMs]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ ok: boolean, updated: boolean, sourceStatus: object, modelCount: number, checkedAt: string | null, warnings: string[] }>}
   */
  refresh(options = {}) {
    if (this._refreshPromise) return this._refreshPromise
    const promise = this._runRefresh(isPlainObject(options) ? options : {})
    this._refreshPromise = promise.finally(() => {
      this._refreshPromise = null
    })
    return this._refreshPromise
  }

  /**
   * Look up model metadata by candidate ids. Candidates are tried in order and
   * each one is canonicalized (vendor prefix stripped, `:variant` dropped,
   * dot/hyphen variants and dated snapshots resolved).
   *
   * @param {string | string[]} candidateKeys
   * @returns {object | null}
   */
  lookup(candidateKeys) {
    const candidates = Array.isArray(candidateKeys) ? candidateKeys : [candidateKeys]
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate.trim() === '') continue
      const entry = this._lookupOne(candidate.trim())
      if (entry) return entry
    }
    return null
  }

  /**
   * Return every normalized model entry currently held in the registry cache.
   *
   * @returns {object[]}
   */
  listModels() {
    return Object.values(this._state.models)
  }

  /**
   * @returns {{ modelCount: number, checkedAt: string | null, ttlMs: number, stale: boolean, offlineOnly: boolean, sources: object, warnings: string[] }}
   */
  getStatus() {
    return {
      modelCount: this.modelCount,
      checkedAt: this._state.checkedAt,
      ttlMs: this.ttlMs,
      stale: this.isStale(),
      offlineOnly: this.offlineOnly,
      sources: {
        modelsDev: describeSource(this._state.sources.modelsDev),
        openRouter: describeSource(this._state.sources.openRouter),
      },
      warnings: [...this.warnings],
    }
  }

  /* -- internals ---------------------------------------------------------- */

  _warn(message) {
    this.warnings.push(String(message))
  }

  _applyState(state) {
    this._state = state
    this._matchIndex = buildMatchIndex(state.models)
  }

  _lookupOne(raw) {
    const models = this._state.models
    const aliases = this._state.aliases
    const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

    if (has(models, raw)) return models[raw]

    const canonical = canonicalizeModelId(raw)
    if (!canonical) return null
    if (has(models, canonical)) return models[canonical]
    if (has(aliases, canonical) && has(models, aliases[canonical])) return models[aliases[canonical]]

    const storedKey = this._matchIndex.get(modelMatchKey(canonical))
    if (storedKey && has(models, storedKey)) return models[storedKey]

    for (const variant of collectIdVariants(canonical)) {
      if (has(models, variant)) return models[variant]
      if (has(aliases, variant) && has(models, aliases[variant])) return models[aliases[variant]]
      const variantKey = this._matchIndex.get(modelMatchKey(variant))
      if (variantKey && has(models, variantKey)) return models[variantKey]
    }
    return null
  }

  async _runRefresh({ force = false, offlineOnly, modelsDevUrl, openRouterUrl, timeoutMs, signal } = {}) {
    await this.load()
    const warnings = []
    const offline = offlineOnly === undefined ? this.offlineOnly : Boolean(offlineOnly)
    const effectiveTimeout =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.timeoutMs
    const currentCheckedAt = this._state.checkedAt

    if (offline) {
      return {
        ok: true,
        updated: false,
        sourceStatus: {
          modelsDev: { status: 'skipped-offline' },
          openRouter: { status: 'skipped-offline' },
        },
        modelCount: this.modelCount,
        checkedAt: currentCheckedAt,
        warnings,
      }
    }

    if (!force && !this.isStale(this._now())) {
      return {
        ok: true,
        updated: false,
        sourceStatus: {
          modelsDev: { status: 'fresh' },
          openRouter: { status: 'fresh' },
        },
        modelCount: this.modelCount,
        checkedAt: currentCheckedAt,
        warnings,
      }
    }

    const plans = [
      {
        name: 'modelsDev',
        url: typeof modelsDevUrl === 'string' && modelsDevUrl ? modelsDevUrl : this.modelsDevUrl,
        cached: this._state.sources.modelsDev,
        circuit: this._circuits.modelsDev,
        parser: parseModelsDevPayload,
      },
      {
        name: 'openRouter',
        url: typeof openRouterUrl === 'string' && openRouterUrl ? openRouterUrl : this.openRouterUrl,
        cached: this._state.sources.openRouter,
        circuit: this._circuits.openRouter,
        parser: parseOpenRouterPayload,
      },
    ]

    const results = await Promise.all(
      plans.map((plan) =>
        this._refreshSource(plan, { force: Boolean(force), timeoutMs: effectiveTimeout, signal }),
      ),
    )

    const sourceStatus = {}
    const nextSources = {}
    let updated = false
    let successfulSources = 0

    for (const result of results) {
      nextSources[result.name] = result.source
      const status = { status: result.status, modelCount: result.modelCount }
      if (result.etag) status.etag = result.etag
      if (result.error) {
        status.error = result.error
        warnings.push(`${result.name}: ${result.error}`)
      }
      if (result.status === 'empty-protected') {
        warnings.push(`${result.name}: upstream returned no models; keeping cached snapshot`)
      }
      if (result.status === 'updated') updated = true
      if (result.status === 'updated' || result.status === 'not-modified') successfulSources += 1
      sourceStatus[result.name] = status
    }

    const merged = mergeRegistrySnapshots(nextSources.modelsDev, nextSources.openRouter)
    const modelCount = Object.keys(merged.models).length

    if (modelCount === 0) {
      warnings.push('no models available from either registry source')
      return {
        ok: false,
        updated: false,
        sourceStatus,
        modelCount: this.modelCount,
        checkedAt: currentCheckedAt,
        warnings,
      }
    }

    const checkedAt = new Date(this._now()).toISOString()
    const nextState = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      checkedAt,
      sources: nextSources,
      models: merged.models,
      aliases: merged.aliases,
    }

    if (successfulSources > 0 || currentCheckedAt === null) {
      try {
        await this._writeState(nextState)
      } catch (error) {
        warnings.push(`cache file could not be written: ${messageOf(error)}`)
      }
      this._applyState(nextState)
    }

    return { ok: true, updated, sourceStatus, modelCount, checkedAt, warnings }
  }

  async _refreshSource(plan, { force, timeoutMs, signal }) {
    const cached = plan.cached
    const circuit = plan.circuit
    const nowMs = this._now()

    if (!force && circuit.openUntil > nowMs) {
      return {
        name: plan.name,
        status: 'circuit-open',
        modelCount: cached.modelCount,
        source: cached,
        error: circuit.lastError ? `retry suppressed after ${circuit.lastError}` : 'retry suppressed',
      }
    }

    const headers = { accept: 'application/json', 'user-agent': USER_AGENT }
    if (cached.etag) headers['if-none-match'] = cached.etag
    if (cached.lastModified) headers['if-modified-since'] = cached.lastModified

    let response
    try {
      response = await this._fetchWithTimeout(plan.url, { headers, signal }, timeoutMs)
    } catch (error) {
      const message = messageOf(error)
      circuit.openUntil = this._now() + CIRCUIT_COOLDOWN_MS
      circuit.lastError = message
      return { name: plan.name, status: 'error', modelCount: cached.modelCount, source: cached, error: message }
    }

    if (response && response.status === 304) {
      circuit.openUntil = 0
      circuit.lastError = null
      const source = { ...cached, checkedAt: new Date(this._now()).toISOString() }
      return {
        name: plan.name,
        status: 'not-modified',
        modelCount: cached.modelCount,
        source,
        etag: cached.etag,
      }
    }

    if (!response || response.ok !== true) {
      const statusText = response ? `HTTP ${response.status}` : 'no response received'
      circuit.openUntil = this._now() + CIRCUIT_COOLDOWN_MS
      circuit.lastError = statusText
      return { name: plan.name, status: 'error', modelCount: cached.modelCount, source: cached, error: statusText }
    }

    let text
    try {
      text = await response.text()
    } catch (error) {
      const message = `response body could not be read: ${messageOf(error)}`
      circuit.openUntil = this._now() + CIRCUIT_COOLDOWN_MS
      circuit.lastError = message
      return { name: plan.name, status: 'error', modelCount: cached.modelCount, source: cached, error: message }
    }

    let snapshot
    try {
      snapshot = plan.parser(text)
    } catch (error) {
      const message = `invalid payload: ${messageOf(error)}`
      circuit.openUntil = this._now() + CIRCUIT_COOLDOWN_MS
      circuit.lastError = message
      return { name: plan.name, status: 'error', modelCount: cached.modelCount, source: cached, error: message }
    }

    const modelCount = Object.keys(snapshot.models).length
    if (modelCount === 0) {
      if (cached.modelCount > 0) {
        return { name: plan.name, status: 'empty-protected', modelCount: cached.modelCount, source: cached }
      }
      circuit.openUntil = this._now() + CIRCUIT_COOLDOWN_MS
      circuit.lastError = 'upstream returned no models'
      return {
        name: plan.name,
        status: 'empty',
        modelCount: 0,
        source: cached,
        error: 'upstream returned no models',
      }
    }

    circuit.openUntil = 0
    circuit.lastError = null
    const source = {
      url: plan.url,
      etag: readHeader(response, 'etag') ?? cached.etag,
      lastModified: readHeader(response, 'last-modified') ?? cached.lastModified,
      checkedAt: new Date(this._now()).toISOString(),
      modelCount,
      models: snapshot.models,
      aliases: snapshot.aliases,
    }
    return { name: plan.name, status: 'updated', modelCount, source, etag: source.etag ?? undefined }
  }

  async _fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController()
    const external = init.signal
    const onAbort = () => controller.abort(external?.reason)
    if (external) {
      if (external.aborted) controller.abort(external.reason)
      else external.addEventListener('abort', onAbort, { once: true })
    }

    let timer = null
    const timeoutPromise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`request timed out after ${timeoutMs}ms`))
        reject(new Error(`request timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })

    const fetchPromise = Promise.resolve().then(() => this.fetchImpl(url, { ...init, signal: controller.signal }))
    // Avoid an unhandled rejection when the timeout wins the race.
    fetchPromise.catch(() => {})

    try {
      return await Promise.race([fetchPromise, timeoutPromise])
    } finally {
      if (timer) clearTimeout(timer)
      if (external && typeof external.removeEventListener === 'function') {
        external.removeEventListener('abort', onAbort)
      }
    }
  }

  async _writeState(state) {
    const filePath = this.cacheFilePath
    const directory = dirname(filePath)
    await mkdir(directory, { recursive: true })
    const payload = `${JSON.stringify(serializeState(state))}\n`
    const tempPath = join(directory, `.${basename(filePath)}.${process.pid}.${this._now()}.tmp`)
    try {
      await writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 })
      await rename(tempPath, filePath)
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {})
      throw error
    }
  }
}

function describeSource(source) {
  return {
    url: source.url,
    etag: source.etag,
    lastModified: source.lastModified,
    checkedAt: source.checkedAt,
    modelCount: Object.keys(source.models).length,
  }
}
