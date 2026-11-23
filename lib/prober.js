/**
 * Opt-in live endpoint probing for one custom provider.
 *
 * A profile can be guessed from documentation and metadata, but a few wire
 * details only an authenticated request can settle: whether the gateway accepts
 * the OpenAI `developer` role, whether it takes `max_completion_tokens` or
 * `max_tokens`, and whether it rejects reasoning or tool controls. Probing is
 * strictly opt-in — nothing here runs unless the settings page or the tool asks
 * for it — and it is deliberately cheap: a model listing plus at most 16 output
 * tokens per chat-shaped request.
 *
 * Credentials never reach a result: request headers carry the key, and every
 * message that leaves this module passes through `redactSecretText`. Timeouts
 * combine the caller's signal with a per-request deadline, so a hung endpoint
 * cannot block the settings call indefinitely.
 * @module @xiaoxing/api-provider-manager/prober
 */

import { ApiManagerError, messageOf, redactSecretText } from './errors.js'
import { SUPPORTED_PROTOCOLS } from './presets.js'

/** Checks `probeEndpoint` understands, in execution order. */
export const PROBE_CHECKS = Object.freeze([
  'connectivity',
  'chat',
  'developerRole',
  'maxTokensField',
  'reasoning',
  'tools',
])

/** Default per-request deadline. */
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000

/** Output-token cap of every minimal chat request. */
const MINIMAL_OUTPUT_TOKENS = 16

/** Reasoning budget an Anthropic thinking probe asks for. */
const ANTHROPIC_THINKING_BUDGET = 1024

/** User agent sent with probe requests. */
const PROBE_USER_AGENT = '@xiaoxing/api-provider-manager prober'

/** Header names whose values are credentials and must never be echoed. */
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'proxy-authorization',
  'cookie',
])

/** HTTP statuses a gateway uses to reject an unsupported parameter or role. */
const REJECTION_STATUSES = new Set([400, 422])

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
 * Mask every credential a diagnostic must not carry.
 * @param {unknown} text - text to redact.
 * @param {readonly string[]} secrets - secret literals to replace.
 * @returns {string} the redacted text.
 */
function redactText(text, secrets) {
  return redactSecretText(String(text), secrets)
}

/**
 * Collect every secret literal a probe knows about.
 * @param {string | undefined} apiKey - credential sent with the probe.
 * @param {Record<string, string>} headers - extra headers supplied by the caller.
 * @returns {string[]} secret literals to redact from diagnostics.
 */
function collectSecrets(apiKey, headers) {
  const secrets = []
  if (typeof apiKey === 'string' && apiKey.length > 0) secrets.push(apiKey)
  if (isPlainObject(headers)) {
    for (const [name, value] of Object.entries(headers)) {
      if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) && typeof value === 'string' && value.length > 0) {
        secrets.push(value)
      }
    }
  }
  return secrets
}

/**
 * Append one path to a base URL without doubling a separator.
 * @param {string} baseURL - endpoint root.
 * @param {string} path - path starting with `/`.
 * @returns {string} the joined URL.
 */
function joinEndpoint(baseURL, path) {
  return `${baseURL.replace(/\/+$/u, '')}${path}`
}

/**
 * Build the request headers for one wire protocol.
 * @param {string} api - wire protocol.
 * @param {string | undefined} apiKey - credential to send, when one was given.
 * @param {Record<string, string>} extraHeaders - caller-supplied headers, merged last.
 * @returns {Record<string, string>} the merged, lower-cased header map.
 */
function buildRequestHeaders(api, apiKey, extraHeaders) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': PROBE_USER_AGENT,
  }
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    if (api === 'anthropic-messages') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else if (api === 'google-generative-ai') {
      headers['x-goog-api-key'] = apiKey
    } else {
      headers.authorization = `Bearer ${apiKey}`
    }
  }
  if (isPlainObject(extraHeaders)) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      headers[name.toLowerCase()] = value
    }
  }
  return headers
}

/**
 * Build a Gemini generateContent path for one model id.
 * @param {string} modelId - model id, optionally prefixed with `models/`.
 * @returns {string} the encoded path.
 */
function geminiGeneratePath(modelId) {
  const bare = String(modelId).trim().replace(/^models\//u, '')
  return `/models/${encodeURIComponent(bare)}:generateContent`
}

/**
 * Describe a rejected request without leaking a credential.
 * @param {unknown} error - thrown value from `fetch`.
 * @param {number} timeoutMs - configured deadline, for the timeout message.
 * @param {AbortSignal | undefined} externalSignal - caller signal, if any.
 * @param {readonly string[]} secrets - secret literals to redact.
 * @returns {string} a redacted, actionable message.
 */
function describeRequestError(error, timeoutMs, externalSignal, secrets) {
  if (externalSignal !== undefined && externalSignal.aborted === true) return 'probe aborted by the caller'
  const name = isPlainObject(error) || error instanceof Error ? error.name : undefined
  if (name === 'TimeoutError' || name === 'AbortError') return `request timed out after ${timeoutMs}ms`
  return redactText(`request failed: ${messageOf(error)}`, secrets).slice(0, 800)
}

/**
 * Read an HTTP failure detail out of a response body.
 *
 * Gateways disagree on the error envelope, so the common OpenAI, Responses,
 * Anthropic, and Gemini shapes are all inspected. Text bodies are included
 * because proxies sometimes answer with an HTML error page.
 * @param {{ ok: boolean, status: number | null, json: unknown, text: string, error: string | null }} result - request result.
 * @param {readonly string[]} secrets - secret literals to redact.
 * @returns {string} a redacted one-line detail, or an empty string.
 */
function extractErrorDetail(result, secrets) {
  const pieces = []
  const json = result.json
  if (isPlainObject(json)) {
    for (const field of ['error', 'message', 'detail', 'error_description']) {
      const value = json[field]
      if (typeof value === 'string') pieces.push(value)
    }
    if (isPlainObject(json.error)) {
      for (const field of ['message', 'type', 'code', 'status']) {
        const value = json.error[field]
        if (typeof value === 'string') pieces.push(value)
      }
    }
    if (Array.isArray(json.errors)) {
      for (const value of json.errors) {
        if (typeof value === 'string') pieces.push(value)
        else if (isPlainObject(value) && typeof value.message === 'string') pieces.push(value.message)
      }
    }
  } else if (typeof json === 'string') {
    pieces.push(json)
  }
  if (typeof result.text === 'string' && result.text !== '') pieces.push(result.text)
  const detail = pieces
    .filter(piece => typeof piece === 'string' && piece.trim() !== '')
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return redactText(detail, secrets).slice(0, 1000)
}

/**
 * Perform one HTTP request with a hard deadline.
 *
 * The deadline is enforced twice: `AbortSignal.any` combines the caller signal
 * with `AbortSignal.timeout`, and a timer races the request so an implementation
 * that ignores the signal still cannot hang the probe.
 * @param {string} url - absolute request URL.
 * @param {RequestInit} init - request options without `signal`.
 * @param {{ timeoutMs: number, fetchImpl: typeof fetch, signal?: AbortSignal, secrets: readonly string[] }} context - probe context.
 * @returns {Promise<{ ok: boolean, status: number | null, latencyMs: number, json: unknown, text: string, error: string | null }>}
 *   the normalized attempt.
 */
async function performRequest(url, init, context) {
  const { timeoutMs, fetchImpl, signal: externalSignal, secrets } = context
  const startedAt = Date.now()
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal =
    externalSignal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, externalSignal])

  let timer
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(null), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })

  const failure = error => ({
    ok: false,
    status: null,
    latencyMs: Date.now() - startedAt,
    json: null,
    text: '',
    error: redactText(error, secrets).slice(0, 800),
  })

  try {
    const fetchPromise = Promise.resolve().then(() => fetchImpl(url, { ...init, signal }))
    fetchPromise.catch(() => {})
    const outcome = await Promise.race([
      fetchPromise.then(
        response => ({ response }),
        error => ({ error }),
      ),
      deadline,
    ])
    if (outcome === null) return failure(`request timed out after ${timeoutMs}ms`)
    if (outcome.error !== undefined) {
      return failure(describeRequestError(outcome.error, timeoutMs, externalSignal, secrets))
    }
    const response = outcome.response
    if (response === null || response === undefined) return failure('fetchImpl returned no response')

    let text = ''
    if (typeof response.text === 'function') {
      const textPromise = Promise.resolve().then(() => response.text())
      textPromise.catch(() => {})
      const textOutcome = await Promise.race([
        textPromise.then(
          value => ({ value }),
          error => ({ error }),
        ),
        deadline,
      ])
      if (textOutcome === null) return failure(`request timed out after ${timeoutMs}ms`)
      if (textOutcome.error !== undefined) {
        return failure(describeRequestError(textOutcome.error, timeoutMs, externalSignal, secrets))
      }
      text = typeof textOutcome.value === 'string' ? textOutcome.value : ''
    }

    let json = null
    if (text.trim() !== '') {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    const status = typeof response.status === 'number' ? response.status : null
    const ok = response.ok === true || (status !== null && status >= 200 && status < 300)
    return {
      ok,
      status,
      latencyMs: Date.now() - startedAt,
      json,
      text: text.slice(0, 65_536),
      error: ok ? null : `HTTP ${status === null ? 'unknown' : status}`,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Extract model ids from a listing response.
 * @param {string} api - wire protocol.
 * @param {unknown} json - parsed listing body.
 * @returns {string[]} deduplicated model ids.
 */
function extractListedModelIds(api, json) {
  const list = api === 'google-generative-ai'
    ? isPlainObject(json) && Array.isArray(json.models) ? json.models : []
    : Array.isArray(json) ? json : isPlainObject(json) && Array.isArray(json.data) ? json.data : []
  const ids = []
  for (const item of list) {
    if (typeof item === 'string') {
      if (item !== '') ids.push(item)
      continue
    }
    if (!isPlainObject(item)) continue
    for (const field of ['id', 'model', 'name']) {
      const value = item[field]
      if (typeof value !== 'string' || value === '') continue
      ids.push(api === 'google-generative-ai' && field === 'name' ? value.replace(/^models\//u, '') : value)
      break
    }
  }
  return [...new Set(ids)]
}

/**
 * Whether an HTTP status is the kind a gateway uses to reject a parameter.
 * @param {number | null} status - response status.
 * @returns {boolean} whether the request was rejected as malformed.
 */
function isRejectionStatus(status) {
  return status !== null && REJECTION_STATUSES.has(status)
}

/**
 * Whether an error detail mentions the developer role being unsupported.
 * @param {string} detail - lower-case-able error detail.
 * @returns {boolean} whether the endpoint rejected the developer role.
 */
function mentionsDeveloperRole(detail) {
  const text = detail.toLowerCase()
  if (text.includes('developer')) return true
  return /\brole\b/u.test(text) && /(unsupported|not supported|invalid|unknown|unrecognized|unexpected)/u.test(text)
}

/**
 * Whether an error detail mentions the output-token field.
 * @param {string} detail - error detail.
 * @returns {boolean} whether the endpoint rejected `max_completion_tokens`.
 */
function mentionsMaxTokensField(detail) {
  const text = detail.toLowerCase()
  return text.includes('max_completion_tokens') || text.includes('max_tokens')
}

/**
 * Whether an error detail mentions reasoning controls.
 * @param {string} detail - error detail.
 * @returns {boolean} whether the endpoint rejected a reasoning control.
 */
function mentionsReasoning(detail) {
  const text = detail.toLowerCase()
  return text.includes('reasoning') || text.includes('thinking') || text.includes('effort')
}

/**
 * Whether an error detail blames a strict tool schema.
 * @param {string} detail - error detail.
 * @returns {boolean} whether strict tool mode should be disabled.
 */
function mentionsStrictTools(detail) {
  return detail.toLowerCase().includes('strict')
}

/**
 * Build the minimal non-streaming chat request for one protocol.
 * @param {string} api - wire protocol.
 * @param {string} modelId - model to test.
 * @returns {{ path: string, body: Record<string, unknown> }} request path and JSON body.
 */
function buildChatRequest(api, modelId) {
  if (api === 'openai-responses') {
    return {
      path: '/responses',
      body: {
        model: modelId,
        input: [{ role: 'user', content: 'Reply OK.' }],
        max_output_tokens: MINIMAL_OUTPUT_TOKENS,
      },
    }
  }
  if (api === 'anthropic-messages') {
    return {
      path: '/messages',
      body: {
        model: modelId,
        max_tokens: MINIMAL_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: 'Reply OK.' }],
      },
    }
  }
  if (api === 'google-generative-ai') {
    return {
      path: geminiGeneratePath(modelId),
      body: {
        contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }],
        generationConfig: { maxOutputTokens: MINIMAL_OUTPUT_TOKENS },
      },
    }
  }
  return {
    path: '/chat/completions',
    body: {
      model: modelId,
      messages: [{ role: 'user', content: 'Reply OK.' }],
      max_tokens: MINIMAL_OUTPUT_TOKENS,
      stream: false,
    },
  }
}

/**
 * Build the developer-role request for an OpenAI-style protocol.
 * @param {string} api - `openai-completions` or `openai-responses`.
 * @param {string} modelId - model to test.
 * @returns {{ path: string, body: Record<string, unknown> }} request path and JSON body.
 */
function buildDeveloperRoleRequest(api, modelId) {
  const messages = [
    { role: 'developer', content: 'Follow instructions.' },
    { role: 'user', content: 'OK' },
  ]
  if (api === 'openai-responses') {
    return {
      path: '/responses',
      body: { model: modelId, input: messages, max_output_tokens: MINIMAL_OUTPUT_TOKENS },
    }
  }
  return {
    path: '/chat/completions',
    body: { model: modelId, messages, max_tokens: MINIMAL_OUTPUT_TOKENS, stream: false },
  }
}

/**
 * Build the `max_completion_tokens` request for OpenAI Chat Completions.
 * @param {string} modelId - model to test.
 * @returns {{ path: string, body: Record<string, unknown> }} request path and JSON body.
 */
function buildMaxCompletionTokensRequest(modelId) {
  return {
    path: '/chat/completions',
    body: {
      model: modelId,
      messages: [{ role: 'user', content: 'Reply OK.' }],
      max_completion_tokens: MINIMAL_OUTPUT_TOKENS,
      stream: false,
    },
  }
}

/**
 * Build the reasoning-control request for one protocol.
 * @param {string} api - wire protocol.
 * @param {string} modelId - model to test.
 * @returns {{ path: string, body: Record<string, unknown>, field: string }} request path, body, and controlled field.
 */
function buildReasoningRequest(api, modelId) {
  if (api === 'openai-responses') {
    return {
      path: '/responses',
      field: 'reasoning',
      body: {
        model: modelId,
        input: [{ role: 'user', content: 'Reply OK.' }],
        max_output_tokens: MINIMAL_OUTPUT_TOKENS,
        reasoning: { effort: 'low' },
      },
    }
  }
  if (api === 'anthropic-messages') {
    return {
      path: '/messages',
      field: 'thinking',
      body: {
        model: modelId,
        max_tokens: ANTHROPIC_THINKING_BUDGET * 2,
        messages: [{ role: 'user', content: 'Reply OK.' }],
        thinking: { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET },
      },
    }
  }
  if (api === 'google-generative-ai') {
    return {
      path: geminiGeneratePath(modelId),
      field: 'thinkingConfig',
      body: {
        contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }],
        generationConfig: {
          maxOutputTokens: MINIMAL_OUTPUT_TOKENS,
          thinkingConfig: { includeThoughts: false },
        },
      },
    }
  }
  return {
    path: '/chat/completions',
    field: 'reasoning_effort',
    body: {
      model: modelId,
      messages: [{ role: 'user', content: 'Reply OK.' }],
      max_tokens: MINIMAL_OUTPUT_TOKENS,
      stream: false,
      reasoning_effort: 'low',
    },
  }
}

/**
 * Build a one-tool request for one protocol.
 * @param {string} api - wire protocol.
 * @param {string} modelId - model to test.
 * @returns {{ path: string, body: Record<string, unknown> }} request path and JSON body.
 */
function buildToolsRequest(api, modelId) {
  const parameters = { type: 'object', properties: {}, additionalProperties: false }
  if (api === 'openai-responses') {
    return {
      path: '/responses',
      body: {
        model: modelId,
        input: [{ role: 'user', content: 'Reply OK.' }],
        max_output_tokens: MINIMAL_OUTPUT_TOKENS,
        tools: [{ type: 'function', name: 'ping', description: 'Returns pong.', parameters }],
      },
    }
  }
  if (api === 'anthropic-messages') {
    return {
      path: '/messages',
      body: {
        model: modelId,
        max_tokens: MINIMAL_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: 'Reply OK.' }],
        tools: [{ name: 'ping', description: 'Returns pong.', input_schema: parameters }],
      },
    }
  }
  if (api === 'google-generative-ai') {
    return {
      path: geminiGeneratePath(modelId),
      body: {
        contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }],
        generationConfig: { maxOutputTokens: MINIMAL_OUTPUT_TOKENS },
        tools: [
          {
            functionDeclarations: [
              { name: 'ping', description: 'Returns pong.', parameters: { type: 'OBJECT', properties: {} } },
            ],
          },
        ],
      },
    }
  }
  return {
    path: '/chat/completions',
    body: {
      model: modelId,
      messages: [{ role: 'user', content: 'Reply OK.' }],
      max_tokens: MINIMAL_OUTPUT_TOKENS,
      stream: false,
      tools: [{ type: 'function', function: { name: 'ping', description: 'Returns pong.', parameters } }],
    },
  }
}

/**
 * Validate and normalize `probeEndpoint` options.
 * @param {unknown} options - caller-supplied options.
 * @returns {{ baseURL: string, api: string, apiKey: string | undefined, headers: Record<string, string>,
 *   modelId: string | undefined, checks: string[], timeoutMs: number, fetchImpl: typeof fetch, signal: AbortSignal | undefined }}
 *   the normalized options.
 * @throws {TypeError} for a non-object options value, a bad timeout, or a bad fetch implementation.
 * @throws {ApiManagerError} `unsupported-api`, `invalid-probe-target`, or `invalid-probe-check` for other failures.
 */
function resolveProbeOptions(options) {
  if (!isPlainObject(options)) throw new TypeError('probeEndpoint options must be an object')
  const {
    baseURL,
    api = 'openai-completions',
    apiKey,
    headers,
    modelId,
    checks = [...PROBE_CHECKS],
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    signal,
  } = options

  if (!SUPPORTED_PROTOCOLS.includes(api)) {
    throw new ApiManagerError('unsupported-api', `api must be one of ${SUPPORTED_PROTOCOLS.join(', ')}; got ${JSON.stringify(api)}`, { api })
  }
  if (typeof baseURL !== 'string' || baseURL.trim() === '') {
    throw new ApiManagerError('invalid-probe-target', 'baseURL must be a non-empty string')
  }
  if (baseURL !== baseURL.trim()) {
    throw new ApiManagerError('invalid-probe-target', 'baseURL must not start or end with whitespace', { baseURL })
  }
  let parsed
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new ApiManagerError('invalid-probe-target', `baseURL "${baseURL}" is not a valid absolute URL`, { baseURL })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiManagerError('invalid-probe-target', `baseURL "${baseURL}" must use http: or https:`, { baseURL })
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ApiManagerError('invalid-probe-target', `baseURL "${baseURL}" must not embed credentials`, { baseURL })
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new ApiManagerError('invalid-probe-target', `baseURL "${baseURL}" must not carry a query string or fragment`, { baseURL })
  }
  if (parsed.hostname === '') {
    throw new ApiManagerError('invalid-probe-target', `baseURL "${baseURL}" needs a host`, { baseURL })
  }

  let credential
  if (apiKey !== undefined && apiKey !== null) {
    if (typeof apiKey !== 'string') throw new TypeError('apiKey must be a string when provided')
    if (apiKey.trim() !== '') credential = apiKey
  }

  let extraHeaders = {}
  if (headers !== undefined) {
    if (!isPlainObject(headers)) throw new TypeError('headers must be an object of header name to string value')
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== 'string') throw new TypeError(`headers.${name} must be a string`)
    }
    try {
      new Headers(headers)
    } catch (error) {
      throw new ApiManagerError('invalid-probe-target', `headers are not valid HTTP headers: ${messageOf(error)}`)
    }
    extraHeaders = { ...headers }
  }

  let targetModel
  if (modelId !== undefined && modelId !== null) {
    if (typeof modelId !== 'string' || modelId.trim() === '') {
      throw new ApiManagerError('invalid-probe-target', 'modelId must be a non-empty string when provided')
    }
    targetModel = modelId.trim()
  }

  if (!Array.isArray(checks) || checks.some(check => typeof check !== 'string')) {
    throw new ApiManagerError('invalid-probe-check', 'checks must be an array of probe check names')
  }
  const unknown = checks.filter(check => !PROBE_CHECKS.includes(check))
  if (unknown.length > 0) {
    throw new ApiManagerError('invalid-probe-check', `unknown probe checks: ${unknown.join(', ')}; expected ${PROBE_CHECKS.join(', ')}`, {
      checks: unknown,
    })
  }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive finite number')
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  if (signal !== undefined && signal !== null) {
    if (typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean') {
      throw new TypeError('signal must be an AbortSignal')
    }
  }

  return {
    baseURL,
    api,
    apiKey: credential,
    headers: extraHeaders,
    modelId: targetModel,
    checks: [...new Set(checks)],
    timeoutMs,
    fetchImpl,
    signal: signal ?? undefined,
  }
}

/**
 * Probe one custom-provider endpoint over the network.
 *
 * Each requested check is independent: a rejected compatibility control yields a
 * recommendation instead of failing the whole probe, while a failed connectivity
 * or chat request does mark the probe as unsuccessful. Checks that need a model
 * id and were requested without one are reported as skipped.
 * @param {object} [options] - probe options.
 * @param {string} options.baseURL - provider endpoint root (for example `https://relay.example.com/v1`).
 * @param {string} [options.api] - wire protocol; one of the four supported protocols.
 * @param {string} [options.apiKey] - credential sent in the protocol's auth header; never returned.
 * @param {Record<string, string>} [options.headers] - extra non-secret request headers.
 * @param {string} [options.modelId] - model id the model-dependent checks exercise.
 * @param {string[]} [options.checks] - subset of `PROBE_CHECKS`; defaults to every check.
 * @param {number} [options.timeoutMs] - per-request deadline.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation (tests inject a mock).
 * @param {AbortSignal} [options.signal] - caller cancellation signal.
 * @returns {Promise<{ ok: boolean, api: string, baseURL: string, modelId: string | null,
 *   checks: Record<string, object>, recommendedCompat: Record<string, unknown>, warnings: string[],
 *   checkedAt: string, durationMs: number }>} the probe report.
 * @throws {TypeError} for invalid option types.
 * @throws {ApiManagerError} when the target, protocol, or requested checks are invalid.
 */
export async function probeEndpoint(options = {}) {
  const config = resolveProbeOptions(options)
  const { baseURL, api, apiKey, headers, modelId, checks, timeoutMs, fetchImpl, signal } = config
  const secrets = collectSecrets(apiKey, headers)
  const requestHeaders = buildRequestHeaders(api, apiKey, headers)
  const context = { timeoutMs, fetchImpl, signal, secrets }
  const startedAt = Date.now()
  const requested = new Set(checks)
  const checksReport = {}
  const recommendedCompat = {}
  const warnings = []
  let ok = true

  /** Send one JSON POST and normalize its outcome. */
  const sendJson = (request) =>
    performRequest(
      joinEndpoint(baseURL, request.path),
      { method: 'POST', headers: requestHeaders, body: JSON.stringify(request.body) },
      context,
    )

  if (requested.has('connectivity')) {
    const result = await performRequest(joinEndpoint(baseURL, '/models'), { method: 'GET', headers: requestHeaders }, context)
    const models = result.ok ? extractListedModelIds(api, result.json) : []
    const report = {
      ok: result.ok,
      status: result.status,
      latencyMs: result.latencyMs,
      modelCount: models.length,
    }
    if (models.length > 0) report.models = models.slice(0, 200)
    if (!result.ok) {
      report.error = extractErrorDetail(result, secrets) || result.error || 'connectivity check failed'
      ok = false
      warnings.push(`connectivity check failed: ${report.error}`)
    } else if (models.length === 0) {
      warnings.push('the model list endpoint returned no models; declare the model list manually')
    }
    checksReport.connectivity = report
  }

  if (requested.has('chat')) {
    if (modelId === undefined) {
      checksReport.chat = { skipped: true, reason: 'a model id is required' }
      warnings.push('chat probe skipped: no model id was given')
    } else {
      const result = await sendJson(buildChatRequest(api, modelId))
      const report = { ok: result.ok, status: result.status, latencyMs: result.latencyMs }
      if (!result.ok) {
        report.error = extractErrorDetail(result, secrets) || result.error
        ok = false
        warnings.push(`chat probe failed: ${report.error}`)
      }
      checksReport.chat = report
    }
  }

  if (requested.has('developerRole')) {
    if (api !== 'openai-completions' && api !== 'openai-responses') {
      checksReport.developerRole = { skipped: true, reason: `the ${api} protocol has no developer role` }
    } else if (modelId === undefined) {
      checksReport.developerRole = { skipped: true, reason: 'a model id is required' }
      warnings.push('developer role probe skipped: no model id was given')
    } else {
      const result = await sendJson(buildDeveloperRoleRequest(api, modelId))
      const detail = extractErrorDetail(result, secrets)
      const report = { ok: result.ok, status: result.status, latencyMs: result.latencyMs }
      if (result.ok) {
        report.supported = true
      } else if (isRejectionStatus(result.status) && mentionsDeveloperRole(detail)) {
        report.supported = false
        report.error = detail || result.error
        report.recommendation = { supportsDeveloperRole: false }
        recommendedCompat.supportsDeveloperRole = false
        warnings.push('the endpoint rejected the developer role; set compat.supportsDeveloperRole to false')
      } else {
        report.supported = null
        report.error = detail || result.error
        warnings.push(`developer role probe was inconclusive (${report.error}); no recommendation was made`)
      }
      checksReport.developerRole = report
    }
  }

  if (requested.has('maxTokensField')) {
    if (api !== 'openai-completions') {
      checksReport.maxTokensField = {
        skipped: true,
        reason: `the ${api} protocol does not take max_completion_tokens`,
      }
    } else if (modelId === undefined) {
      checksReport.maxTokensField = { skipped: true, reason: 'a model id is required' }
      warnings.push('max tokens field probe skipped: no model id was given')
    } else {
      const result = await sendJson(buildMaxCompletionTokensRequest(modelId))
      const detail = extractErrorDetail(result, secrets)
      const report = {
        ok: result.ok,
        status: result.status,
        latencyMs: result.latencyMs,
        field: 'max_completion_tokens',
      }
      if (result.ok) {
        report.supported = true
        recommendedCompat.maxTokensField = 'max_completion_tokens'
      } else if (isRejectionStatus(result.status) && mentionsMaxTokensField(detail)) {
        report.supported = false
        report.error = detail || result.error
        report.recommendation = { maxTokensField: 'max_tokens' }
        recommendedCompat.maxTokensField = 'max_tokens'
        warnings.push('the endpoint rejected max_completion_tokens; set compat.maxTokensField to "max_tokens"')
      } else {
        report.supported = null
        report.error = detail || result.error
        warnings.push(`max tokens field probe was inconclusive (${report.error}); no recommendation was made`)
      }
      checksReport.maxTokensField = report
    }
  }

  if (requested.has('reasoning')) {
    if (modelId === undefined) {
      checksReport.reasoning = { skipped: true, reason: 'a model id is required' }
      warnings.push('reasoning probe skipped: no model id was given')
    } else {
      const request = buildReasoningRequest(api, modelId)
      const result = await sendJson(request)
      const detail = extractErrorDetail(result, secrets)
      const report = {
        ok: result.ok,
        status: result.status,
        latencyMs: result.latencyMs,
        field: request.field,
      }
      if (result.ok) {
        report.accepted = true
        if (api === 'openai-completions') recommendedCompat.supportsReasoningEffort = true
      } else if (isRejectionStatus(result.status) && mentionsReasoning(detail)) {
        report.accepted = false
        report.error = detail || result.error
        if (api === 'openai-completions') {
          report.recommendation = { supportsReasoningEffort: false }
          recommendedCompat.supportsReasoningEffort = false
          warnings.push('the endpoint rejected reasoning_effort; set compat.supportsReasoningEffort to false')
        } else {
          warnings.push(`the endpoint rejected ${request.field}; the model appears not to accept extended thinking`)
        }
      } else {
        report.accepted = null
        report.error = detail || result.error
        warnings.push(`reasoning probe was inconclusive (${report.error}); no recommendation was made`)
      }
      checksReport.reasoning = report
    }
  }

  if (requested.has('tools')) {
    if (modelId === undefined) {
      checksReport.tools = { skipped: true, reason: 'a model id is required' }
      warnings.push('tool schema probe skipped: no model id was given')
    } else {
      const result = await sendJson(buildToolsRequest(api, modelId))
      const detail = extractErrorDetail(result, secrets)
      const report = {
        ok: result.ok,
        status: result.status,
        latencyMs: result.latencyMs,
        tool: 'ping',
      }
      if (result.ok) {
        report.accepted = true
      } else if (isRejectionStatus(result.status)) {
        report.accepted = false
        report.error = detail || result.error
        if (mentionsStrictTools(detail)) {
          report.recommendation = { supportsStrictMode: false }
          recommendedCompat.supportsStrictMode = false
          warnings.push('the endpoint rejected the tool schema mentioning strict mode; set compat.supportsStrictMode to false')
        } else {
          warnings.push(`the endpoint rejected a minimal tool schema: ${report.error}`)
        }
      } else {
        report.accepted = null
        report.error = detail || result.error
        warnings.push(`tool schema probe was inconclusive (${report.error}); no recommendation was made`)
      }
      checksReport.tools = report
    }
  }

  return {
    ok,
    api,
    baseURL,
    modelId: modelId ?? null,
    checks: checksReport,
    recommendedCompat,
    warnings,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  }
}
