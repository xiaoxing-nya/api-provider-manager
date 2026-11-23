/**
 * Live model discovery for custom API providers.
 *
 * A custom provider that speaks one of the pi-ai wire protocols can publish its
 * model list at a protocol-specific URL. This module normalizes the base URL,
 * builds the listing request (including auth headers), reads the response under
 * a hard size bound, and folds the many field dialects gateways use (New-API,
 * CLIProxyAPI, Magpie, vLLM, OpenRouter, models.dev, Anthropic, and Gemini) into
 * one model shape for the enricher.
 *
 * The module is pure Node >= 22 ESM and has no external dependencies. Callers
 * inject `fetchImpl` so discovery is fully testable offline.
 * @module @xiaoxing/api-provider-manager/discovery
 */

import { isLikelyNonChatModel } from './canon.js'
import { ApiManagerError, messageOf, redactSecretText } from './errors.js'
import { SUPPORTED_PROTOCOLS, THINKING_LEVELS } from './presets.js'

/** Hard cap on a model-listing response body (4 MiB). */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Anthropic API version sent with `x-api-key` requests. */
export const ANTHROPIC_VERSION = '2023-06-01'

/** Protocols whose listing endpoint is the OpenAI-compatible `${base}/models`. */
const OPENAI_PROTOCOLS = Object.freeze(['openai-completions', 'openai-responses'])

/** Upstream `type` values that unambiguously describe a non-chat model. */
const NON_CHAT_TYPES = Object.freeze(['embedding', 'rerank', 'image', 'audio', 'tts', 'asr'])

/** Entry paths carrying a context-window token count, in precedence order. */
const CONTEXT_WINDOW_FIELDS = Object.freeze([
  'contextWindow',
  'context_window',
  'context_length',
  'max_context_length',
  'max_context_window',
  'max_model_len',
  'max_input_tokens',
  'max_prompt_tokens',
  'limit.context',
  'limit.input',
  'inputTokenLimit',
  'top_provider.context_length',
])

/** Entry paths carrying a maximum output-token count, in precedence order. */
const MAX_TOKENS_FIELDS = Object.freeze([
  'maxOutputTokens',
  'max_output_tokens',
  'maxTokens',
  'max_tokens',
  'max_completion_tokens',
  'limit.output',
  'outputTokenLimit',
  'top_provider.max_completion_tokens',
])

/** Whether a value is a plain object rather than an array or class instance. */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Read a possibly dotted property path without assuming the shape of the
 * intermediate objects.
 * @param {unknown} source - object to inspect.
 * @param {string} path - dotted property path such as `limit.context`.
 * @returns {unknown} the value at the path, or `undefined`.
 */
function readPath(source, path) {
  if (!isPlainObject(source)) return undefined
  let current = source
  for (const segment of path.split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

/**
 * Return the first positive integer available on one of the given paths.
 * @param {unknown} source - entry to inspect.
 * @param {readonly string[]} paths - candidate dotted property paths.
 * @returns {number | undefined} the first positive integer found.
 */
function firstPositiveInteger(source, paths) {
  for (const path of paths) {
    const value = readPath(source, path)
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  }
  return undefined
}

/**
 * Read one response header without assuming a `Headers` instance.
 * @param {unknown} response - fetch response.
 * @param {string} name - header name, matched case-insensitively.
 * @returns {string | null} the header value, or `null`.
 */
function readHeader(response, name) {
  const headers = isPlainObject(response) || typeof response === 'object' ? response?.headers : undefined
  if (!headers) return null
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return typeof value === 'string' && value.length > 0 ? value : null
  }
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== lower) continue
    const value = headers[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * Normalize a configured base URL.
 *
 * The returned base URL is trimmed, does not end in a slash, and is known to be
 * an http(s) URL without embedded credentials. A trailing `#` is a caller marker
 * meaning "use this URL verbatim": the listing URL is built by appending the
 * protocol's relative path without inserting or stripping `/v1`.
 * @param {unknown} rawUrl - base URL as entered by a user or read from config.
 * @returns {{ baseURL: string, verbatim: boolean }} the normalized base URL and whether it was marked verbatim.
 * @throws {ApiManagerError} `invalid-url` when the value is not a usable http(s) base URL.
 */
export function normalizeBaseUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    throw new ApiManagerError('invalid-url', 'baseURL must be a string', { baseURL: rawUrl })
  }
  const trimmed = rawUrl.trim()
  if (trimmed.length === 0) {
    throw new ApiManagerError('invalid-url', 'baseURL must not be empty')
  }
  const verbatim = trimmed.endsWith('#')
  let clean = verbatim ? trimmed.slice(0, -1) : trimmed
  while (clean.endsWith('/')) clean = clean.slice(0, -1)
  if (clean.length === 0) {
    throw new ApiManagerError('invalid-url', 'baseURL must name a host, not only a marker')
  }

  let parsed
  try {
    parsed = new URL(clean)
  } catch {
    throw new ApiManagerError(
      'invalid-url',
      `baseURL "${redactSecretText(clean)}" is not a valid absolute URL`,
      { baseURL: redactSecretText(clean) },
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiManagerError(
      'invalid-url',
      `baseURL must use http: or https:, got "${parsed.protocol}"`,
      { baseURL: redactSecretText(clean) },
    )
  }
  if (parsed.username !== '' || parsed.password !== '') {
    // Never echo the userinfo: it is the credential.
    throw new ApiManagerError('invalid-url', 'baseURL must not embed a username or password')
  }
  if (parsed.hostname === '') {
    throw new ApiManagerError('invalid-url', 'baseURL must name a host', { baseURL: redactSecretText(clean) })
  }
  return { baseURL: clean, verbatim }
}

/**
 * Build the model-listing URL for one protocol.
 *
 * OpenAI-compatible endpoints list at `${base}/models`. Anthropic lists at
 * `${root}/v1/models` unless the user marked the URL verbatim, and Gemini lists
 * at `${base}/models?pageSize=1000`.
 * @param {unknown} baseURL - base URL of the provider.
 * @param {string} api - wire protocol.
 * @param {{ verbatim?: boolean }} [options] - extra verbatim marker from the caller.
 * @returns {string} the absolute listing URL.
 * @throws {ApiManagerError} `invalid-url` for an unusable base URL, `invalid-api` for an unsupported protocol.
 */
/**
 * Build the listing URL from an already-normalized base URL descriptor.
 * @param {{ baseURL: string, verbatim: boolean }} normalized - normalized base URL.
 * @param {string} api - wire protocol.
 * @param {boolean} [verbatim] - caller verbatim override.
 * @returns {string} the absolute listing URL.
 */
function buildListingUrlFromNormalized(normalized, api, verbatim = false) {
  const clean = normalized.baseURL
  const useVerbatim = verbatim === true || normalized.verbatim
  if (api === 'google-generative-ai') return `${clean}/models?pageSize=1000`
  if (api === 'anthropic-messages') {
    if (useVerbatim) return `${clean}/models?limit=1000`
    const root = clean.endsWith('/v1') ? clean.slice(0, -3) : clean
    return `${root}/v1/models?limit=1000`
  }
  return `${clean}/models`
}

/**
 * Derive the OpenAI-compatible `/v1` fallback listing URL from an already-normalized descriptor.
 * @param {{ baseURL: string, verbatim: boolean }} normalized - normalized base URL.
 * @param {string} api - wire protocol.
 * @param {boolean} [verbatim] - caller verbatim override.
 * @returns {{ url: string, suggestedBaseURL: string } | null} the fallback listing URL and corrected base URL, or `null`.
 */
function fallbackV1UrlFromNormalized(normalized, api, verbatim = false) {
  if (!OPENAI_PROTOCOLS.includes(api)) return null
  if (verbatim === true || normalized.verbatim) return null
  const parsed = new URL(normalized.baseURL)
  if (parsed.pathname !== '/') return null
  const suggestedBaseURL = `${normalized.baseURL}/v1`
  return { url: `${suggestedBaseURL}/models`, suggestedBaseURL }
}

/**
 * Build the protocol-specific model listing URL.
 *
 * OpenAI-compatible relays expose `${base}/models`, Anthropic exposes
 * `${root}/v1/models?limit=1000` (unless `#` requested verbatim), and Gemini
 * exposes `${base}/models?pageSize=1000`.
 * @param {unknown} baseURL - base URL of the provider.
 * @param {string} api - wire protocol.
 * @param {{ verbatim?: boolean }} [options] - extra verbatim marker from the caller.
 * @returns {string} the absolute listing URL.
 * @throws {ApiManagerError} `invalid-url` for an unusable base URL, `invalid-api` for an unsupported protocol.
 */
export function buildListingUrl(baseURL, api, { verbatim = false } = {}) {
  if (!SUPPORTED_PROTOCOLS.includes(api)) {
    throw new ApiManagerError(
      'invalid-api',
      `api must be one of ${SUPPORTED_PROTOCOLS.join(', ')}; got ${JSON.stringify(api)}`,
      { api },
    )
  }
  const normalized = normalizeBaseUrl(baseURL)
  return buildListingUrlFromNormalized(normalized, api, verbatim)
}

/**
 * Derive the OpenAI-compatible `/v1` fallback listing URL.
 *
 * A user who pasted `https://proxy.example` without the `/v1` suffix gets a 404
 * from `${base}/models`. When the normalized URL has no path at all, this
 * helper describes the `/v1` alternative and the base URL the user should save.
 * @param {unknown} baseURL - base URL of the provider.
 * @param {string} api - wire protocol.
 * @param {{ verbatim?: boolean }} [options] - extra verbatim marker from the caller.
 * @returns {{ url: string, suggestedBaseURL: string } | null} the fallback listing URL and corrected base URL, or `null`.
 */
export function fallbackV1Url(baseURL, api, { verbatim = false } = {}) {
  if (!OPENAI_PROTOCOLS.includes(api)) return null
  const normalized = normalizeBaseUrl(baseURL)
  return fallbackV1UrlFromNormalized(normalized, api, verbatim)
}

/**
 * Validate an API key before it is placed in a request header.
 * @param {unknown} apiKey - configured credential.
 * @returns {string | undefined} the printable key, or `undefined` when none was supplied.
 * @throws {ApiManagerError} `invalid-api-key` when the value cannot be sent as a header.
 */
function validateApiKey(apiKey) {
  if (apiKey === undefined || apiKey === null) return undefined
  if (typeof apiKey !== 'string') {
    throw new ApiManagerError('invalid-api-key', 'apiKey must be a string', { type: typeof apiKey })
  }
  if (apiKey.length === 0) return undefined
  if (apiKey !== apiKey.trim() || !/^[\x20-\x7E]+$/u.test(apiKey)) {
    throw new ApiManagerError(
      'invalid-api-key',
      'apiKey contains whitespace or control characters and cannot be sent in an HTTP header',
    )
  }
  return apiKey
}

/**
 * Build the request headers for one protocol, merging caller headers safely.
 *
 * Protocol authentication headers win over caller headers so a stale config
 * cannot shadow the credential the caller supplied. Caller headers may still
 * add gateway routing, referer, or beta headers.
 * @param {string} api - wire protocol.
 * @param {string | undefined} apiKey - validated credential.
 * @param {unknown} headers - caller-supplied extra header map.
 * @returns {Headers} the request headers.
 * @throws {ApiManagerError} `invalid-headers` when the caller headers are unusable.
 */
function buildRequestHeaders(api, apiKey, headers) {
  let merged
  try {
    merged = new Headers(isPlainObject(headers) ? headers : undefined)
  } catch (error) {
    throw new ApiManagerError(
      'invalid-headers',
      `headers are not valid HTTP headers: ${redactSecretText(messageOf(error))}`,
    )
  }
  if (headers !== undefined && headers !== null && !isPlainObject(headers)) {
    throw new ApiManagerError('invalid-headers', 'headers must be an object of header name to string value')
  }
  merged.set('accept', 'application/json')
  if (apiKey !== undefined) {
    if (api === 'anthropic-messages') merged.set('x-api-key', apiKey)
    else if (api === 'google-generative-ai') merged.set('x-goog-api-key', apiKey)
    else merged.set('authorization', `Bearer ${apiKey}`)
  }
  if (api === 'anthropic-messages' && !merged.has('anthropic-version')) {
    merged.set('anthropic-version', ANTHROPIC_VERSION)
  }
  return merged
}

/**
 * Fetch one listing URL with a bounded timeout and an optional external signal.
 * @param {object} options - request settings.
 * @param {string} options.url - listing URL.
 * @param {Headers} options.headers - request headers.
 * @param {Function} options.fetchImpl - fetch implementation.
 * @param {AbortSignal | undefined} options.signal - caller cancellation signal.
 * @param {number} options.timeoutMs - request timeout.
 * @param {string | undefined} options.apiKey - secret to redact from failures.
 * @returns {Promise<Response>} the fetch response.
 * @throws {ApiManagerError} `discovery-timeout`, `request-aborted`, or `network-error`.
 */
async function fetchListing({ url, headers, fetchImpl, signal, timeoutMs, apiKey }) {
  const safeUrl = redactSecretText(url, apiKey === undefined ? [] : [apiKey])
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const abortFromCaller = () => controller.abort(signal?.reason)
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', abortFromCaller, { once: true })
  }
  try {
    return await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    })
  } catch (error) {
    if (timedOut) {
      throw new ApiManagerError(
        'discovery-timeout',
        `model listing request to ${safeUrl} timed out after ${timeoutMs} ms`,
        { url: safeUrl, timeoutMs },
      )
    }
    if (signal?.aborted) {
      throw new ApiManagerError('request-aborted', `model listing request to ${safeUrl} was aborted`, { url: safeUrl })
    }
    throw new ApiManagerError(
      'network-error',
      `model listing request to ${safeUrl} failed: ${redactSecretText(messageOf(error), apiKey === undefined ? [] : [apiKey])}`,
      { url: safeUrl },
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', abortFromCaller)
  }
}

/**
 * Throw the standard too-large failure for one listing response.
 * @param {number} bytes - observed or declared body size.
 * @returns {never} always throws.
 */
function responseTooLarge(bytes) {
  throw new ApiManagerError(
    'response-too-large',
    `model listing response exceeds the ${MAX_RESPONSE_BYTES}-byte limit (${bytes} bytes); narrow the endpoint or use a smaller page size`,
    { bytes, limit: MAX_RESPONSE_BYTES },
  )
}

/**
 * Read a bounded response body and parse it as JSON.
 *
 * The body is streamed so an endless or oversized response cannot exhaust
 * memory: the declared `Content-Length` is checked first and the streamed byte
 * count is capped at {@link MAX_RESPONSE_BYTES}.
 * @param {Response} response - fetch response with a successful status.
 * @param {string} url - request URL, for diagnostics.
 * @param {string | undefined} apiKey - secret to redact from failures.
 * @returns {Promise<unknown>} the parsed JSON payload.
 * @throws {ApiManagerError} `response-too-large` or `invalid-response`.
 */
async function readBoundedJson(response, url, apiKey) {
  const safeUrl = redactSecretText(url, apiKey === undefined ? [] : [apiKey])
  const declared = readHeader(response, 'content-length')
  if (declared !== null) {
    const size = Number.parseInt(declared, 10)
    if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) responseTooLarge(size)
  }

  let text
  const body = response?.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
        total += chunk.byteLength
        if (total > MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel()
          } catch {
            // The connection may already be closed; the size verdict stands.
          }
          responseTooLarge(total)
        }
        chunks.push(chunk)
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // A released or errored reader needs no cleanup.
      }
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    text = new TextDecoder('utf-8').decode(bytes)
  } else {
    // Minimal fetch doubles (tests, tooling) may expose only `text()`.
    text = typeof response?.text === 'function' ? await response.text() : ''
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      responseTooLarge(new TextEncoder().encode(text).byteLength)
    }
  }

  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ApiManagerError(
      'invalid-response',
      `model listing from ${safeUrl} is not valid JSON: ${redactSecretText(messageOf(error), apiKey === undefined ? [] : [apiKey])}`,
      { url: safeUrl },
    )
  }
}

/**
 * Throw the standard HTTP-status failure for one listing request.
 * @param {number} status - HTTP status code.
 * @param {string} url - request URL, for diagnostics.
 * @param {string | undefined} apiKey - secret to redact from the message.
 * @param {Record<string, unknown>} [extra] - additional structured details.
 * @returns {never} always throws.
 */
function httpFailure(status, url, apiKey, extra = {}) {
  const safeUrl = redactSecretText(url, apiKey === undefined ? [] : [apiKey])
  throw new ApiManagerError(
    'http-error',
    `model listing request to ${safeUrl} failed with HTTP ${status}`,
    { status, url: safeUrl, ...extra },
  )
}

/**
 * Normalize one entry's input modalities to the pi-ai subset.
 * @param {unknown} values - declared modalities.
 * @returns {('text' | 'image')[] | undefined} the supported subset, or `undefined`.
 */
function normalizeModalities(values) {
  if (!Array.isArray(values)) return undefined
  const seen = new Set()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const modality = value.trim().toLowerCase()
    if (modality === 'text') seen.add('text')
    else if (modality === 'image' || modality === 'vision' || modality === 'image_url') seen.add('image')
  }
  const subset = ['text', 'image'].filter(modality => seen.has(modality))
  return subset.length === 0 ? undefined : subset
}

/**
 * Extract the input modalities one listing entry declares.
 * @param {Record<string, unknown>} entry - listing entry.
 * @returns {('text' | 'image')[] | undefined} the supported subset, or `undefined`.
 */
function extractInputModalities(entry) {
  const candidates = [
    entry.inputModalities,
    entry.input_modalities,
    entry.supportedInputModalities,
    readPath(entry, 'architecture.input_modalities'),
  ]
  if (entry.modalities !== undefined) {
    candidates.push(isPlainObject(entry.modalities) ? entry.modalities.input : entry.modalities)
  }
  for (const candidate of candidates) {
    const subset = normalizeModalities(candidate)
    if (subset !== undefined) return subset
  }
  const capabilities = isPlainObject(entry.capabilities) ? entry.capabilities : null
  if (capabilities?.vision === true || entry.supports_vision === true) return ['text', 'image']
  return undefined
}

/**
 * Collect reasoning level strings from an upstream value list.
 * @param {unknown} values - an array of level strings or level objects.
 * @returns {string[]} the raw level spellings.
 */
function collectLevels(values) {
  const levels = []
  if (!Array.isArray(values)) return levels
  for (const value of values) {
    if (typeof value === 'string') {
      levels.push(value)
      continue
    }
    if (!isPlainObject(value)) continue
    const level = value.level ?? value.name ?? value.id ?? value.value
    if (typeof level === 'string') levels.push(level)
  }
  return levels
}

/**
 * Canonicalize declared reasoning level spellings.
 * @param {readonly string[]} levels - raw level spellings.
 * @param {boolean} allowOff - whether reasoning can be disabled.
 * @returns {string[]} canonical levels; includes `off` when allowed.
 */
function normalizeReasoningLevels(levels, allowOff) {
  const declared = new Set()
  for (const level of levels) {
    const normalized = level.trim().toLowerCase()
    if (normalized === 'none' || normalized === 'off' || normalized === 'disabled') declared.add('off')
    else if (THINKING_LEVELS.includes(normalized)) declared.add(normalized)
  }
  const ordered = THINKING_LEVELS.filter(level => level !== 'off' && declared.has(level))
  if (ordered.length === 0) return []
  if (!allowOff) return ordered
  return ['off', ...ordered]
}

/**
 * Extract reasoning metadata from one listing entry.
 *
 * `reasoningDeclared` distinguishes a model whose listing explicitly confirmed
 * whether reasoning is supported (`true` or `false`) from a bare listing entry
 * that simply omitted reasoning fields (`false` with `reasoningDeclared: false`).
 * @param {Record<string, unknown>} entry - listing entry.
 * @returns {{ reasoning: boolean, reasoningDeclared: boolean, allowOff: boolean, efforts: string[] }} the reasoning declaration.
 */
function extractReasoning(entry) {
  let reasoning = false
  let reasoningDeclared = false
  let allowOff = true
  const levels = []

  levels.push(...collectLevels(entry.supported_reasoning_levels))
  levels.push(...collectLevels(entry.reasoning_levels))

  const thinking = isPlainObject(entry.thinking) ? entry.thinking : null
  if (thinking !== null) {
    reasoning = true
    reasoningDeclared = true
    levels.push(...collectLevels(thinking.levels))
    if (thinking.zero_allowed === false) allowOff = false
  } else if (typeof entry.thinking === 'boolean') {
    reasoningDeclared = true
    if (entry.thinking === true) reasoning = true
  }

  const reasoningInfo = isPlainObject(entry.reasoning) ? entry.reasoning : null
  if (reasoningInfo !== null) {
    reasoningDeclared = true
    if (reasoningInfo.supported !== false) {
      reasoning = true
      if (reasoningInfo.mandatory === true) allowOff = false
      levels.push(...collectLevels(reasoningInfo.supported_efforts))
    }
  } else if (typeof entry.reasoning === 'boolean') {
    reasoningDeclared = true
    if (entry.reasoning === true) reasoning = true
  }

  const parameters = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : []
  if (parameters.includes('reasoning') || parameters.includes('reasoning_effort')) {
    reasoning = true
    reasoningDeclared = true
  }
  if (typeof entry.supports_reasoning === 'boolean') {
    reasoningDeclared = true
    if (entry.supports_reasoning === true) reasoning = true
  }
  const capabilities = isPlainObject(entry.capabilities) ? entry.capabilities : null
  if (capabilities?.thinking === true || isPlainObject(capabilities?.thinking)) {
    reasoning = true
    reasoningDeclared = true
  } else if (capabilities?.thinking === false) {
    reasoningDeclared = true
  }
  if (capabilities?.reasoning === true || isPlainObject(capabilities?.reasoning)) {
    reasoning = true
    reasoningDeclared = true
  } else if (capabilities?.reasoning === false) {
    reasoningDeclared = true
  }

  const efforts = normalizeReasoningLevels(levels, allowOff)
  if (efforts.length > 0) {
    reasoning = true
    reasoningDeclared = true
  }
  return { reasoning, reasoningDeclared, allowOff, efforts: reasoning ? efforts : [] }
}

/**
 * Extract the endpoint protocol types one listing entry declares.
 * @param {Record<string, unknown>} entry - listing entry.
 * @returns {string[]} declared endpoint types, deduplicated in input order.
 */
function extractEndpointTypes(entry) {
  for (const field of ['supported_endpoint_types', 'native_endpoints', 'endpoints']) {
    const value = entry[field]
    if (!Array.isArray(value)) continue
    const types = []
    const seen = new Set()
    for (const candidate of value) {
      if (typeof candidate !== 'string') continue
      const type = candidate.trim()
      if (type.length === 0 || seen.has(type)) continue
      seen.add(type)
      types.push(type)
    }
    return types
  }
  return []
}

/**
 * Read a display name from one listing entry and clean it.
 * @param {Record<string, unknown>} entry - listing entry.
 * @param {string} id - resolved model id.
 * @returns {string} the display name, never empty.
 */
function extractName(entry, id) {
  for (const candidate of [entry.name, entry.display_name, entry.displayName]) {
    if (typeof candidate !== 'string') continue
    const name = candidate.replace(/\s+/gu, ' ').trim()
    if (name.length > 0) return name
  }
  return id
}

/**
 * Classify a listing entry as a non-chat model.
 * @param {string} id - model id.
 * @param {Record<string, unknown>} entry - listing entry.
 * @returns {boolean} whether the entry is a non-chat model.
 */
function isNonChatEntry(id, entry) {
  if (isLikelyNonChatModel(id).nonChat) return true
  const type = entry.type ?? entry.model_type
  if (typeof type !== 'string') return false
  const normalized = type.trim().toLowerCase()
  return NON_CHAT_TYPES.some(candidate => normalized === candidate || normalized.includes(candidate))
}

/**
 * Normalize one OpenAI/Anthropic style listing entry into the discovery shape.
 * @param {Record<string, unknown>} entry - listing entry.
 * @param {string | undefined} fallbackId - map key used when the entry has no id.
 * @returns {object | null} the normalized model, or `null` when it has no id.
 */
function normalizeListingEntry(entry, fallbackId) {
  if (!isPlainObject(entry)) return null
  let id = entry.id
  if (typeof id !== 'string' || id.trim().length === 0) id = fallbackId
  if (typeof id !== 'string' || id.trim().length === 0) id = entry.model
  if (typeof id !== 'string' || id.trim().length === 0) return null
  const modelId = id.trim()
  const reasoning = extractReasoning(entry)
  const model = {
    id: modelId,
    name: extractName(entry, modelId),
    reasoning: reasoning.reasoning,
    reasoningDeclared: reasoning.reasoningDeclared,
    allowOff: reasoning.allowOff,
    efforts: reasoning.efforts,
    supportedEndpointTypes: extractEndpointTypes(entry),
  }
  const contextWindow = firstPositiveInteger(entry, CONTEXT_WINDOW_FIELDS)
  if (contextWindow !== undefined) model.contextWindow = contextWindow
  const maxTokens = firstPositiveInteger(entry, MAX_TOKENS_FIELDS)
  if (maxTokens !== undefined) model.maxTokens = maxTokens
  const input = extractInputModalities(entry)
  if (input !== undefined) model.input = input
  if (typeof entry.description === 'string' && entry.description.trim().length > 0) {
    model.description = entry.description.trim()
  }
  const type = entry.type ?? entry.model_type
  if (typeof type === 'string' && type.trim().length > 0) model.type = type.trim().toLowerCase()
  if (isNonChatEntry(modelId, entry)) model.nonChat = true
  return model
}

/**
 * Normalize one Gemini `models[]` entry into the discovery shape.
 * @param {Record<string, unknown>} entry - Gemini model entry.
 * @returns {object | null} the normalized model, or `null` when it has no id or cannot generate content.
 */
function normalizeGeminiEntry(entry) {
  if (!isPlainObject(entry)) return null
  const methods = Array.isArray(entry.supportedGenerationMethods) ? entry.supportedGenerationMethods : null
  if (methods !== null && !methods.includes('generateContent')) return null
  let id = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (id.startsWith('models/')) id = id.slice('models/'.length)
  if (id.length === 0 && typeof entry.id === 'string') id = entry.id.trim()
  if (id.length === 0) return null
  const reasoning = extractReasoning(entry)
  // Gemini reports the human label in `displayName` and the API path in `name`.
  const displayName = typeof entry.displayName === 'string' ? { name: entry.displayName } : entry
  const model = {
    id,
    name: extractName(displayName, id),
    reasoning: reasoning.reasoning,
    reasoningDeclared: reasoning.reasoningDeclared,
    allowOff: reasoning.allowOff,
    efforts: reasoning.efforts,
    supportedEndpointTypes: extractEndpointTypes(entry),
  }
  const contextWindow = firstPositiveInteger(entry, CONTEXT_WINDOW_FIELDS)
  if (contextWindow !== undefined) model.contextWindow = contextWindow
  const maxTokens = firstPositiveInteger(entry, MAX_TOKENS_FIELDS)
  if (maxTokens !== undefined) model.maxTokens = maxTokens
  const input = extractInputModalities(entry)
  if (input !== undefined) model.input = input
  if (typeof entry.description === 'string' && entry.description.trim().length > 0) {
    model.description = entry.description.trim()
  }
  if (isNonChatEntry(id, entry)) model.nonChat = true
  return model
}

/**
 * Split an OpenAI/Anthropic listing payload into candidate entries.
 * @param {unknown} payload - parsed listing payload.
 * @returns {{ entries: { entry: Record<string, unknown>, fallbackId?: string }[], rawCount: number }} candidates and the raw record count.
 * @throws {ApiManagerError} `invalid-response` when the payload is not a model listing.
 */
function collectGenericEntries(payload) {
  const candidates = []
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (isPlainObject(entry)) candidates.push({ entry })
    }
    return { entries: candidates, rawCount: payload.length }
  }
  if (!isPlainObject(payload)) {
    throw new ApiManagerError('invalid-response', 'model listing payload must be an object or an array')
  }
  if (Array.isArray(payload.data)) {
    for (const entry of payload.data) {
      if (isPlainObject(entry)) candidates.push({ entry })
    }
    return { entries: candidates, rawCount: payload.data.length }
  }
  if (isPlainObject(payload.models)) {
    const keys = Object.keys(payload.models)
    for (const key of keys) {
      const value = payload.models[key]
      if (isPlainObject(value)) candidates.push({ entry: value, fallbackId: key })
      else if (typeof value === 'string') candidates.push({ entry: { name: value }, fallbackId: key })
    }
    return { entries: candidates, rawCount: keys.length }
  }
  if (Array.isArray(payload.models)) {
    for (const entry of payload.models) {
      if (isPlainObject(entry)) candidates.push({ entry })
    }
    return { entries: candidates, rawCount: payload.models.length }
  }
  throw new ApiManagerError('invalid-response', 'model listing payload has no data[] or models[] list')
}

/**
 * Parse a listing payload into normalized discovery models.
 *
 * Gemini payloads (`{ models: [...] }`) are filtered to entries whose
 * `supportedGenerationMethods` includes `generateContent`; every other payload
 * uses the OpenAI/Anthropic `data[]`, `models` map, or bare-array dialects.
 * Non-chat models are skipped unless `includeNonChat` is set, and duplicate ids
 * are dropped keeping the first entry in endpoint order.
 * @param {unknown} payload - parsed listing payload.
 * @param {string} api - wire protocol.
 * @param {{ includeNonChat?: boolean }} [options] - parse options.
 * @returns {{ models: object[], rawCount: number, nonChatSkipped: number }} the parsed models and counts.
 * @throws {ApiManagerError} `invalid-response` when the payload shape is unusable.
 */
function parseListingPayload(payload, api, { includeNonChat = false } = {}) {
  const include = includeNonChat === true
  let candidates
  let rawCount
  const normalized = []

  if (api === 'google-generative-ai' && isPlainObject(payload) && Array.isArray(payload.models)) {
    rawCount = payload.models.length
    for (const entry of payload.models) {
      const model = normalizeGeminiEntry(entry)
      if (model !== null) normalized.push(model)
    }
  } else {
    const collected = collectGenericEntries(payload)
    rawCount = collected.rawCount
    for (const candidate of collected.entries) {
      const model = normalizeListingEntry(candidate.entry, candidate.fallbackId)
      if (model !== null) normalized.push(model)
    }
  }

  const models = []
  const seen = new Set()
  let nonChatSkipped = 0
  for (const model of normalized) {
    if (model.nonChat === true && !include) {
      nonChatSkipped += 1
      continue
    }
    if (seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return { models, rawCount, nonChatSkipped }
}

/**
 * Discover the model list a custom provider publishes.
 *
 * The request URL is protocol-specific. For OpenAI-compatible endpoints, a 404
 * from `${base}/models` triggers one retry at `${base}/v1/models` when the user
 * pasted a bare host; a successful retry returns `suggestedBaseURL` so the
 * settings page can offer to save the corrected base URL.
 * @param {object} options - discovery options.
 * @param {string} options.baseURL - provider base URL (a trailing `#` marks it verbatim).
 * @param {string} [options.api] - wire protocol.
 * @param {string} [options.apiKey] - credential sent with the request.
 * @param {Record<string, string>} [options.headers] - extra request headers.
 * @param {AbortSignal} [options.signal] - caller cancellation signal.
 * @param {number} [options.timeoutMs] - request timeout in milliseconds.
 * @param {boolean} [options.includeNonChat] - keep embeddings, rerankers, and media models.
 * @param {Function} [options.fetchImpl] - fetch implementation, injectable for tests.
 * @returns {Promise<{ ok: true, url: string, api: string, latencyMs: number, rawCount: number,
 *   nonChatSkipped: number, models: object[], suggestedBaseURL?: string }>} the discovered models.
 * @throws {ApiManagerError} `invalid-url`, `invalid-api`, `invalid-api-key`, `invalid-headers`,
 *   `discovery-timeout`, `request-aborted`, `network-error`, `http-error`, `response-too-large`, or `invalid-response`.
 */
export async function discoverEndpointModels({
  baseURL,
  api = 'openai-completions',
  apiKey,
  headers,
  signal,
  timeoutMs = 10_000,
  includeNonChat = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!SUPPORTED_PROTOCOLS.includes(api)) {
    throw new ApiManagerError(
      'invalid-api',
      `api must be one of ${SUPPORTED_PROTOCOLS.join(', ')}; got ${JSON.stringify(api)}`,
      { api },
    )
  }
  if (typeof fetchImpl !== 'function') {
    throw new ApiManagerError('invalid-fetch', 'fetchImpl must be a function')
  }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ApiManagerError('invalid-timeout', 'timeoutMs must be a positive finite number', { timeoutMs })
  }

  const secret = validateApiKey(apiKey)
  const normalized = normalizeBaseUrl(baseURL)
  const requestHeaders = buildRequestHeaders(api, secret, headers)
  const initialUrl = buildListingUrlFromNormalized(normalized, api)
  const fallback = fallbackV1UrlFromNormalized(normalized, api)
  const startedAt = Date.now()

  const readListing = async url => {
    const response = await fetchListing({
      url,
      headers: requestHeaders,
      fetchImpl,
      signal,
      timeoutMs,
      apiKey: secret,
    })
    const status = typeof response?.status === 'number' ? response.status : 0
    const ok = response?.ok === true || (status >= 200 && status < 300)
    if (!ok) {
      try {
        await response?.body?.cancel?.()
      } catch {
        // Draining a failed response is best effort.
      }
      return { ok: false, status }
    }
    const payload = await readBoundedJson(response, url, secret)
    return { ok: true, status, payload }
  }

  let result = await readListing(initialUrl)
  let usedUrl = initialUrl
  let suggestedBaseURL
  if (!result.ok && result.status === 404 && fallback !== null) {
    const retry = await readListing(fallback.url)
    if (retry.ok) {
      result = retry
      usedUrl = fallback.url
      suggestedBaseURL = fallback.suggestedBaseURL
    } else {
      httpFailure(retry.status, fallback.url, secret, { initialStatus: 404, initialUrl: redactSecretText(initialUrl, secret === undefined ? [] : [secret]) })
    }
  }
  if (!result.ok) httpFailure(result.status, usedUrl, secret)

  const parsed = parseListingPayload(result.payload, api, { includeNonChat })
  const latencyMs = Date.now() - startedAt
  const response = {
    ok: true,
    url: usedUrl,
    api,
    latencyMs,
    rawCount: parsed.rawCount,
    nonChatSkipped: parsed.nonChatSkipped,
    models: parsed.models,
  }
  if (suggestedBaseURL !== undefined) response.suggestedBaseURL = suggestedBaseURL
  return response
}
