/**
 * Sanitized export and third-party config import for the provider manager.
 *
 * The manager has to move provider definitions in and out without ever leaking a
 * credential. Export strips sensitive headers and plaintext keys, keeps the
 * `apiKeyEnv` reference, and marks the document with a stable format id. Import
 * accepts the formats a user is likely to have already:
 *
 *   - `xiaoxing-json`      this manager's own sanitized export,
 *   - `omp-yaml`           an oh-my-pi `models.yml` provider block,
 *   - `cherry-json`        a Cherry Studio provider export,
 *   - `dsh-cordis-yaml`    a DSH `cordis.patch.yml` that declares pi-ai providers.
 *
 * Import never trusts the source shape. Provider ids are validated against the
 * reserved namespaces (a native DSH or built-in pi-ai provider is reported in
 * `skippedReserved`, never imported), metadata is normalized to the DSH
 * `PiAiProviderProfile` shape, and any inline literal `apiKey` is moved into
 * `pendingSecrets` while the profile only keeps an `apiKeyEnv` reference.
 *
 * The self-contained YAML subset parser understands nested mappings, block
 * sequences, quoted and plain scalars, inline `[...]`/`{...}` collections, and
 * `!!js` tags, which are returned as `{ __jsExpr }` values and never evaluated.
 * @module @xiaoxing/api-provider-manager/importer
 */

import { ApiManagerError, messageOf } from './errors.js'
import {
  COMPAT_FIELDS_BY_API,
  GEMINI_THINKING_LEVELS,
  MODALITIES,
  SUPPORTED_PROTOCOLS,
  THINKING_LEVELS,
  filterCompatForApi,
  normalizeReasoningEffortsForApi,
  validateModelProfile,
  validateProviderProfile,
} from './presets.js'
import {
  checkReservedProviderId,
  deriveCredentialRef,
  validateCredentialRef,
  validateCustomProviderId,
} from './reserved.js'

/** Marker written into every sanitized export. */
export const EXPORT_FORMAT = 'xiaoxing-api-manager-v1'

/** Import formats `importThirdPartyConfig` understands. */
export const IMPORT_FORMATS = Object.freeze(['xiaoxing-json', 'omp-yaml', 'cherry-json', 'dsh-cordis-yaml'])

/** Header names that always carry a credential. */
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'proxy-authorization',
  'cookie',
])

/** Profile keys that always carry a plaintext credential. */
const FORBIDDEN_EXPORT_KEYS = new Set([
  'apikey',
  'api_key',
  'apikeyvalue',
  'api_key_value',
  'secret',
  'token',
  'accesstoken',
  'access_token',
])

/** Environment variable name usable as a credential reference. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** An OMP `apiKey` value that names an environment variable instead of a secret. */
const BARE_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,}$/u

/** Defaults OMP applies to a declared model that omits its metadata. */
const OMP_DEFAULT_CONTEXT_WINDOW = 128_000
const OMP_DEFAULT_MAX_TOKENS = 16_384

/** OMP API names that map onto a DSH-supported protocol. */
const OMP_API_ALIASES = Object.freeze({
  'openai-codex-responses': 'openai-responses',
  'azure-openai-responses': 'openai-responses',
  'google-gemini-cli': 'google-generative-ai',
  'google-vertex': 'google-generative-ai',
})

/** Cherry Studio provider `type` values that map onto a DSH protocol. */
const CHERRY_TYPE_TO_API = Object.freeze({
  openai: 'openai-completions',
  'openai-completions': 'openai-completions',
  'openai-response': 'openai-responses',
  'openai-responses': 'openai-responses',
  responses: 'openai-responses',
  anthropic: 'anthropic-messages',
  'anthropic-messages': 'anthropic-messages',
  gemini: 'google-generative-ai',
  google: 'google-generative-ai',
  'google-generative-ai': 'google-generative-ai',
  azure: 'openai-completions',
  'azure-openai': 'openai-completions',
  ollama: 'openai-completions',
  lmstudio: 'openai-completions',
  'new-api': 'openai-completions',
  'one-api': 'openai-completions',
})

/* ------------------------------------------------------------------------- */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------- */

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
 * Compare two strings for deterministic ordering.
 * @param {string} left - first string.
 * @param {string} right - second string.
 * @returns {number} negative, zero, or positive.
 */
function compareStrings(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Read the first non-empty string among several object fields.
 * @param {unknown} source - object to read.
 * @param {readonly string[]} fields - candidate field names, in priority order.
 * @returns {string | undefined} the first non-empty string.
 */
function pickFirstString(source, fields) {
  if (!isPlainObject(source)) return undefined
  for (const field of fields) {
    const value = source[field]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * Read the first positive integer among several object fields.
 * @param {unknown} source - object to read.
 * @param {readonly string[]} fields - candidate field names, in priority order.
 * @returns {number | undefined} the first positive integer.
 */
function pickPositiveInteger(source, fields) {
  if (!isPlainObject(source)) return undefined
  for (const field of fields) {
    const value = source[field]
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
    if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
      const parsed = Number.parseInt(value.trim(), 10)
      if (parsed > 0) return parsed
    }
  }
  return undefined
}

/**
 * Whether a header value looks like a credential rather than a plain setting.
 * @param {string} value - header value.
 * @returns {boolean} whether it must be dropped from an export or import.
 */
function looksLikeCredentialValue(value) {
  const text = value.trim()
  if (/^(?:bearer|basic|token)\s+\S+/iu.test(text)) return true
  return /\bsk-[A-Za-z0-9_-]{8,}/u.test(text)
}

/**
 * Whether a value references an environment variable or a shell command.
 * @param {string} value - candidate value.
 * @returns {boolean} whether it cannot be imported literally.
 */
function looksLikeEnvReference(value) {
  const text = value.trim()
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/u.test(text)) return true
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u.test(text)) return true
  return text.startsWith('!')
}

/**
 * Mask a secret for a preview or a log line.
 * @param {unknown} secret - secret to mask.
 * @returns {string} a masked rendering that never contains the whole secret.
 */
export function maskSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return ''
  if (secret.length <= 8) return '*'.repeat(secret.length)
  const tail = secret.slice(-4)
  return `${secret.slice(0, 4)}${'*'.repeat(Math.min(secret.length - 8, 12))}${tail}`
}

/* ------------------------------------------------------------------------- */
/* Sanitized export                                                          */
/* ------------------------------------------------------------------------- */

/**
 * List provider entries from a persisted provider collection.
 * @param {unknown} providers - provider map keyed by id, or an array of profiles.
 * @returns {Array<[string, Record<string, unknown>]>} id/profile pairs.
 */
function listProviderEntries(providers) {
  if (Array.isArray(providers)) {
    const entries = []
    for (const item of providers) {
      if (!isPlainObject(item) || typeof item.id !== 'string' || item.id === '') continue
      const profile = { ...item }
      delete profile.id
      entries.push([item.id, profile])
    }
    return entries
  }
  if (!isPlainObject(providers)) return []
  const entries = []
  for (const [providerId, value] of Object.entries(providers)) {
    if (!isPlainObject(value)) continue
    entries.push([providerId, isPlainObject(value.profile) ? value.profile : value])
  }
  return entries
}

/**
 * Build a JSON-safe copy of one provider profile with every credential removed.
 * @param {unknown} value - profile, model, or metadata value.
 * @returns {unknown} the sanitized copy.
 */
function sanitizeForExport(value) {
  if (Array.isArray(value)) return value.map(entry => sanitizeForExport(entry))
  if (!isPlainObject(value)) return value
  const sanitized = {}
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (FORBIDDEN_EXPORT_KEYS.has(lower)) continue
    if (lower === 'headers') {
      const headers = sanitizeHeadersForExport(child)
      if (headers !== undefined) sanitized[key] = headers
      continue
    }
    sanitized[key] = sanitizeForExport(child)
  }
  return sanitized
}

/**
 * Strip credential-carrying headers, dropping the whole map when nothing stays.
 * @param {unknown} headers - header map.
 * @returns {Record<string, string> | undefined} the sanitized header map.
 */
function sanitizeHeadersForExport(headers) {
  if (!isPlainObject(headers)) return undefined
  const sanitized = {}
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') continue
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) continue
    if (looksLikeCredentialValue(value)) continue
    sanitized[name] = value
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

/**
 * Find the sync policy belonging to one provider.
 * @param {unknown} syncPolicies - policy map keyed by provider id, or an array of policies.
 * @param {string} providerId - provider id to look up.
 * @returns {Record<string, unknown> | undefined} the policy.
 */
function findSyncPolicy(syncPolicies, providerId) {
  if (Array.isArray(syncPolicies)) {
    const found = syncPolicies.find(
      policy => isPlainObject(policy) && (policy.providerId === providerId || policy.id === providerId),
    )
    return isPlainObject(found) ? found : undefined
  }
  if (isPlainObject(syncPolicies) && isPlainObject(syncPolicies[providerId])) return syncPolicies[providerId]
  return undefined
}

/**
 * Copy the documented sync-policy fields of one policy.
 * @param {unknown} policy - policy to copy.
 * @returns {Record<string, unknown> | undefined} the sanitized policy.
 */
function sanitizePolicyForExport(policy) {
  if (!isPlainObject(policy)) return undefined
  const sanitized = {}
  for (const field of [
    'syncMode',
    'syncCooldownMs',
    'includePatterns',
    'excludePatterns',
    'includeNonChat',
    'syncToSubagentAllowed',
    'lastSyncedAt',
    'lastStatus',
    'lastError',
    'lastDiff',
  ]) {
    if (policy[field] === undefined) continue
    sanitized[field] = sanitizeForExport(policy[field])
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

/**
 * Export provider definitions with every credential removed.
 *
 * The returned document keeps the `apiKeyEnv` reference of each provider, so a
 * receiver can reproduce the configuration once the referenced environment
 * variable is set, and it never contains a plaintext key or a credential header.
 *
 * @param {unknown} providers - provider map keyed by id, or an array of provider profiles.
 * @param {object} [options] - export options.
 * @param {string[]} [options.providerIds] - restriction list; omitted exports every provider.
 * @param {boolean} [options.includeSyncPolicy] - attach each provider's sync policy.
 * @param {unknown} [options.syncPolicies] - policy map keyed by id, or an array of policies.
 * @returns {{ format: string, exportedAt: string, providers: Record<string, Record<string, unknown>> }}
 *   the sanitized, JSON-serializable export document.
 */
export function exportSanitizedProviders(providers, { providerIds, includeSyncPolicy = false, syncPolicies } = {}) {
  const filter =
    Array.isArray(providerIds) ? new Set(providerIds.filter(id => typeof id === 'string' && id !== '')) : null
  const exported = {}
  const entries = listProviderEntries(providers).sort((left, right) => compareStrings(left[0], right[0]))
  for (const [providerId, profile] of entries) {
    if (filter !== null && !filter.has(providerId)) continue
    const sanitized = sanitizeForExport(profile)
    if (includeSyncPolicy === true) {
      const policy = sanitizePolicyForExport(findSyncPolicy(syncPolicies, providerId))
      if (policy !== undefined) sanitized.syncPolicy = policy
    }
    exported[providerId] = sanitized
  }
  return { format: EXPORT_FORMAT, exportedAt: new Date().toISOString(), providers: exported }
}

/* ------------------------------------------------------------------------- */
/* YAML subset parser                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Report one YAML subset parse failure with its source line.
 * @param {number} line - 1-based source line.
 * @param {string} message - actionable detail that never echoes file content.
 * @returns {never} always throws.
 */
function yamlFailure(line, message) {
  throw new ApiManagerError('invalid-import', `YAML line ${line}: ${message}`, { line })
}

/**
 * Whether a quote character at one offset opens a quoted YAML scalar.
 *
 * A quote only starts a scalar at the beginning of a token; an apostrophe or a
 * double quote inside a plain scalar (`O'Brien`, `5"`) is ordinary text, and
 * treating it as a quote would hide a following `# comment` from the scanner.
 * @param {string} raw - source line.
 * @param {number} index - offset of the quote character.
 * @returns {boolean} whether the quote opens a quoted scalar.
 */
function opensYamlQuote(raw, index) {
  if (index === 0) return true
  const previous = raw[index - 1]
  return (
    previous === ' ' ||
    previous === '\t' ||
    previous === ':' ||
    previous === '-' ||
    previous === '[' ||
    previous === '{' ||
    previous === ',' ||
    previous === '='
  )
}

/**
 * Strip a trailing YAML comment while leaving `#` inside quotes and plain
 * scalars (for example a URL fragment) untouched.
 * @param {string} raw - source line.
 * @returns {string} the line without its comment.
 */
function stripYamlComment(raw) {
  let quote = null
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (quote === '"') {
      if (character === '\\') index += 1
      else if (character === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (character === "'") {
        if (raw[index + 1] === "'") index += 1
        else quote = null
      }
      continue
    }
    if ((character === '"' || character === "'") && opensYamlQuote(raw, index)) {
      quote = character
      continue
    }
    if (character === '#' && (index === 0 || /\s/u.test(raw[index - 1]))) return raw.slice(0, index)
  }
  return raw
}

/**
 * Turn one YAML document into significant lines with indentation and line numbers.
 * @param {string} text - YAML source.
 * @returns {Array<{ indent: number, text: string, line: number }>} significant lines.
 */
function tokenizeYaml(text) {
  const rawLines = String(text ?? '').replace(/^\uFEFF/u, '').split(/\r?\n/u)
  const tokens = []
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]
    const indentation = /^[ \t]*/u.exec(raw)[0]
    if (indentation.includes('\t')) yamlFailure(index + 1, 'tab indentation is not supported')
    const uncommented = stripYamlComment(raw)
    if (uncommented.trim() === '') continue
    const indent = uncommented.length - uncommented.trimStart().length
    tokens.push({ indent, text: uncommented.slice(indent).trimEnd(), line: index + 1 })
  }
  return tokens
}

/**
 * Unescape the body of one double-quoted YAML scalar.
 * @param {string} text - quoted body.
 * @returns {string} the unescaped string.
 */
function unescapeYamlDouble(text) {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/gu, (match, escape) => {
    if (escape.startsWith('u')) return String.fromCharCode(Number.parseInt(escape.slice(1), 16))
    switch (escape) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      case '"':
        return '"'
      case '\\':
        return '\\'
      default:
        return escape
    }
  })
}

/**
 * Parse one plain or quoted YAML scalar.
 * @param {string} text - scalar text.
 * @returns {unknown} the parsed scalar.
 */
function parseYamlScalar(text) {
  const value = String(text).trim()
  if (value === '') return ''
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeYamlDouble(value.slice(1, -1))
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'")
  }
  if (value === 'true' || value === 'True' || value === 'TRUE') return true
  if (value === 'false' || value === 'False' || value === 'FALSE') return false
  if (value === 'null' || value === 'Null' || value === 'NULL' || value === '~') return null
  if (/^[-+]?\d+$/u.test(value)) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/u.test(value)) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return value
}

/**
 * Reparse one optionally quoted mapping key.
 * @param {string} text - key text.
 * @returns {string} the key.
 */
function parseYamlKey(text) {
  const value = text.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeYamlDouble(value.slice(1, -1))
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'")
  }
  return value
}

/**
 * Whether one line starts a block sequence item.
 * @param {string} text - trimmed line.
 * @returns {boolean} whether it is a `-` item.
 */
function isSequenceItem(text) {
  return /^-(?:\s|$)/u.test(text)
}

/**
 * Whether a value begins a literal or folded block scalar, which this subset
 * parser deliberately does not implement.
 * @param {string} value - mapping value.
 * @returns {boolean} whether it is a block scalar indicator.
 */
function isBlockIndicator(value) {
  return /^[>|][+-]?\d*$/u.test(value)
}

/**
 * Parse one `!!js` tag into an opaque expression marker.
 * @param {string} value - tag and expression text.
 * @returns {{ __jsExpr: string }} the marker; the expression is never evaluated.
 */
function parseJsTag(value) {
  const expression = value.slice(4).trim()
  if (
    expression.length >= 2 &&
    ((expression.startsWith('"') && expression.endsWith('"')) ||
      (expression.startsWith("'") && expression.endsWith("'")))
  ) {
    return { __jsExpr: String(parseYamlScalar(expression)) }
  }
  return { __jsExpr: expression }
}

/**
 * Parse one inline collection (`[...]` or `{...}`), including nested ones.
 * @param {string} source - collection text.
 * @param {number} line - 1-based source line, for errors.
 * @returns {unknown} the parsed collection.
 */
function parseFlowValue(source, line) {
  const parser = { text: source, index: 0, line }
  skipFlowSpace(parser)
  const value = parseFlowNode(parser, false)
  skipFlowSpace(parser)
  if (parser.index < parser.text.length) yamlFailure(line, 'unexpected characters after an inline value')
  return value
}

/**
 * Skip whitespace inside an inline collection.
 * @param {{ text: string, index: number, line: number }} parser - flow parser state.
 * @returns {void}
 */
function skipFlowSpace(parser) {
  while (parser.index < parser.text.length && /\s/u.test(parser.text[parser.index])) parser.index += 1
}

/**
 * Parse one node inside an inline collection.
 * @param {{ text: string, index: number, line: number }} parser - flow parser state.
 * @param {boolean} asKey - whether the node is a mapping key.
 * @returns {unknown} the parsed node.
 */
function parseFlowNode(parser, asKey) {
  skipFlowSpace(parser)
  const character = parser.text[parser.index]
  if (character === '[') return parseFlowSequence(parser)
  if (character === '{') return parseFlowMapping(parser)
  if (character === '"') return parseFlowDoubleQuoted(parser)
  if (character === "'") return parseFlowSingleQuoted(parser)
  return parseFlowBareScalar(parser, asKey)
}

/**
 * Parse one inline sequence.
 * @param {{ text: string, index: number, line: number }} parser - flow parser state.
 * @returns {unknown[]} the parsed items.
 */
function parseFlowSequence(parser) {
  parser.index += 1
  const items = []
  skipFlowSpace(parser)
  if (parser.text[parser.index] === ']') {
    parser.index += 1
    return items
  }
  for (;;) {
    items.push(parseFlowNode(parser, false))
    skipFlowSpace(parser)
    const character = parser.text[parser.index]
    if (character === ',') {
      parser.index += 1
      skipFlowSpace(parser)
      if (parser.text[parser.index] === ']') {
        parser.index += 1
        return items
      }
      continue
    }
    if (character === ']') {
      parser.index += 1
      return items
    }
    yamlFailure(parser.line, 'expected a comma or closing bracket in an inline sequence')
  }
}

/**
 * Parse one inline mapping.
 * @param {{ text: string, index: number, line: number }} parser - flow parser state.
 * @returns {Record<string, unknown>} the parsed mapping.
 */
function parseFlowMapping(parser) {
  parser.index += 1
  const mapping = {}
  skipFlowSpace(parser)
  if (parser.text[parser.index] === '}') {
    parser.index += 1
    return mapping
  }
  for (;;) {
    const key = parseFlowNode(parser, true)
    skipFlowSpace(parser)
    if (parser.text[parser.index] !== ':') yamlFailure(parser.line, 'expected a colon in an inline mapping')
    parser.index += 1
    const value = parseFlowNode(parser, false)
    mapping[String(key)] = value
    skipFlowSpace(parser)
    const character = parser.text[parser.index]
    if (character === ',') {
      parser.index += 1
      skipFlowSpace(parser)
      if (parser.text[parser.index] === '}') {
        parser.index += 1
        return mapping
      }
      continue
    }
    if (character === '}') {
      parser.index += 1
      return mapping
    }
    yamlFailure(parser.line, 'expected a comma or closing brace in an inline mapping')
  }
}

/**
 * Parse one double-quoted inline scalar.
 * @param {{ text: string, index: number, line: number }} parser - flow parser state.
 * @returns {string} the unescaped string.
 */
function parseFlowDoubleQuoted(parser) {
  const start = parser.index + 1
  parser.index += 1
  let body = ''
  while (parser.index < parser.text.length) {
    const character = parser.text[parser.index]
    if (character === '\\') {
      body += parser.text.slice(parser.index, parser.index + 2)
      parser.index += 2
      continue
    }
    if (character === '"') {
      parser.index += 1
      return unescapeYamlDouble(body)
    }
    body += character
    parser.index += 1
  }
  parser.index = start
  yamlFailure(parser.line, 'unterminated double-quoted string')
}

/**
 * Parse one single-quoted inline scalar.
 * @param {{ text: string, index: number, line: number }} parser - flow parser state.
 * @returns {string} the parsed string.
 */
function parseFlowSingleQuoted(parser) {
  parser.index += 1
  let body = ''
  while (parser.index < parser.text.length) {
    const character = parser.text[parser.index]
    if (character === "'") {
      if (parser.text[parser.index + 1] === "'") {
        body += "'"
        parser.index += 2
        continue
      }
      parser.index += 1
      return body
    }
    body += character
    parser.index += 1
  }
  yamlFailure(parser.line, 'unterminated single-quoted string')
}

/**
 * Parse one bare inline scalar.
 * @param {{ text: string, index: number, line: number }} parser - flow parser state.
 * @param {boolean} asKey - whether the scalar is a mapping key (stops at `:`).
 * @returns {unknown} the parsed scalar.
 */
function parseFlowBareScalar(parser, asKey) {
  const start = parser.index
  while (parser.index < parser.text.length) {
    const character = parser.text[parser.index]
    if (character === ',' || character === ']' || character === '}') break
    if (asKey && character === ':') break
    parser.index += 1
  }
  const raw = parser.text.slice(start, parser.index).trim()
  if (raw === '') yamlFailure(parser.line, 'missing value in an inline collection')
  return parseYamlScalar(raw)
}

/**
 * Match one `key: value` mapping entry, ignoring colons inside quotes and inline
 * collections.
 * @param {string} text - trimmed line.
 * @param {number} line - 1-based source line, for errors.
 * @returns {{ key: string, value: string } | undefined} the entry, or `undefined` for a non-entry line.
 */
function matchMappingEntry(text, line) {
  let quote = null
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote === '"') {
      if (character === '\\') index += 1
      else if (character === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (character === "'") {
        if (text[index + 1] === "'") index += 1
        else quote = null
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '[' || character === '{') {
      depth += 1
      continue
    }
    if (character === ']' || character === '}') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (character === ':' && depth === 0 && (index === text.length - 1 || /\s/u.test(text[index + 1]))) {
      const rawKey = text.slice(0, index).trim()
      if (rawKey === '') yamlFailure(line, 'a mapping entry needs a key')
      return { key: parseYamlKey(rawKey), value: text.slice(index + 1).trim() }
    }
  }
  return undefined
}

/**
 * Parse one mapping value, including `!!js` tags and inline collections.
 * @param {string} text - value text.
 * @param {number} line - 1-based source line, for errors.
 * @returns {unknown} the parsed value.
 */
function parseMappingValue(text, line) {
  const value = text.trim()
  if (value.startsWith('!!js')) return parseJsTag(value)
  if (value.startsWith('[') || value.startsWith('{')) return parseFlowValue(value, line)
  return parseYamlScalar(value)
}

/**
 * Parse one block mapping at a fixed indentation.
 * @param {{ tokens: Array<object>, index: number }} state - parser state.
 * @param {number} indent - mapping indentation.
 * @returns {Record<string, unknown>} the parsed mapping.
 */
function parseBlockMapping(state, indent) {
  const mapping = {}
  while (state.index < state.tokens.length) {
    const token = state.tokens[state.index]
    if (token.indent !== indent || isSequenceItem(token.text)) break
    state.index += 1
    parseBlockMappingEntry(state, mapping, token.text, indent, token.line)
  }
  return mapping
}

/**
 * Parse one `key: value` entry, consuming the nested block or indentationless
 * sequence that belongs to an empty value.
 * @param {{ tokens: Array<object>, index: number }} state - parser state.
 * @param {Record<string, unknown>} mapping - mapping being filled.
 * @param {string} text - entry text.
 * @param {number} entryIndent - indentation of the entry's key.
 * @param {number} line - 1-based source line, for errors.
 * @returns {void}
 */
function parseBlockMappingEntry(state, mapping, text, entryIndent, line) {
  const entry = matchMappingEntry(text, line)
  if (entry === undefined) yamlFailure(line, 'expected a "key: value" mapping entry')
  if (entry.value === '') {
    const next = state.tokens[state.index]
    if (next !== undefined && next.indent > entryIndent) {
      mapping[entry.key] = parseBlockNode(state, next.indent)
      return
    }
    if (next !== undefined && next.indent === entryIndent && isSequenceItem(next.text)) {
      mapping[entry.key] = parseBlockSequence(state, entryIndent)
      return
    }
    mapping[entry.key] = null
    return
  }
  if (isBlockIndicator(entry.value)) yamlFailure(line, 'block scalars ("|" or ">") are not supported')
  mapping[entry.key] = parseMappingValue(entry.value, line)
}

/**
 * Parse one block sequence at a fixed indentation.
 * @param {{ tokens: Array<object>, index: number }} state - parser state.
 * @param {number} indent - sequence indentation.
 * @returns {unknown[]} the parsed items.
 */
function parseBlockSequence(state, indent) {
  const items = []
  while (state.index < state.tokens.length) {
    const token = state.tokens[state.index]
    if (token.indent !== indent || !isSequenceItem(token.text)) break
    const afterDash = token.text.slice(1)
    const inline = afterDash.trim()
    const itemIndent = indent + 1 + (afterDash.length - afterDash.trimStart().length)
    state.index += 1
    if (inline === '') {
      const next = state.tokens[state.index]
      if (next === undefined || next.indent <= indent) {
        items.push(null)
        continue
      }
      items.push(parseBlockNode(state, next.indent))
      continue
    }
    if (isBlockIndicator(inline)) yamlFailure(token.line, 'block scalars ("|" or ">") are not supported')
    if (matchMappingEntry(inline, token.line) !== undefined) {
      const mapping = {}
      parseBlockMappingEntry(state, mapping, inline, itemIndent, token.line)
      while (state.index < state.tokens.length) {
        const next = state.tokens[state.index]
        if (next.indent !== itemIndent || isSequenceItem(next.text)) break
        state.index += 1
        parseBlockMappingEntry(state, mapping, next.text, itemIndent, next.line)
      }
      items.push(mapping)
      continue
    }
    items.push(parseMappingValue(inline, token.line))
  }
  return items
}

/**
 * Parse the block node starting at the current token.
 * @param {{ tokens: Array<object>, index: number }} state - parser state.
 * @param {number} indent - node indentation.
 * @returns {unknown} the parsed node.
 */
function parseBlockNode(state, indent) {
  const token = state.tokens[state.index]
  if (token.indent !== indent) yamlFailure(token.line, `expected ${indent} spaces of indentation`)
  return isSequenceItem(token.text) ? parseBlockSequence(state, indent) : parseBlockMapping(state, indent)
}

/**
 * Parse the YAML subset used by oh-my-pi `models.yml` and DSH Cordis patches.
 *
 * Supported: nested block mappings, block sequences (including `- key: value`
 * items), quoted and plain scalars, inline `[...]` and `{...}` collections, `#`
 * comments, a leading `---` document marker, and `!!js` tags. `!!js` values are
 * returned as `{ __jsExpr }` markers and are never evaluated. Block scalars
 * (`|`, `>`), anchors, and multiple documents are rejected with a line number.
 *
 * @param {string} text - YAML source.
 * @returns {unknown} the parsed document, or `null` when it has no content.
 * @throws {ApiManagerError} `invalid-import` with `details.line` on a syntax error.
 */
export function parseYamlSubset(text) {
  const tokens = tokenizeYaml(text)
  if (tokens.length === 0) return null

  const endIndex = tokens.findIndex(token => token.indent === 0 && token.text === '...')
  if (endIndex >= 0) tokens.length = endIndex
  if (tokens.length === 0) return null

  if (tokens[0].indent === 0 && (tokens[0].text === '---' || tokens[0].text.startsWith('--- '))) {
    if (tokens[0].text === '---') tokens.shift()
    else tokens[0] = { ...tokens[0], text: tokens[0].text.slice(3).trim() }
  }
  if (tokens.length === 0) return null
  const secondMarker = tokens.find(token => token.indent === 0 && (token.text === '---' || token.text.startsWith('--- ')))
  if (secondMarker !== undefined) yamlFailure(secondMarker.line, 'multiple YAML documents are not supported')

  const state = { tokens, index: 0 }
  const value = parseBlockNode(state, tokens[0].indent)
  if (state.index < tokens.length) {
    yamlFailure(state.tokens[state.index].line, 'unexpected content; check the indentation')
  }
  return value
}

/* ------------------------------------------------------------------------- */
/* Import: format detection and entry collection                             */
/* ------------------------------------------------------------------------- */

/**
 * Collect the provider-id candidates of one raw provider entry.
 * @param {unknown} raw - raw provider entry.
 * @returns {string[]} candidate ids, most authoritative first.
 */
function providerEntryCandidates(raw) {
  const candidates = []
  if (!isPlainObject(raw)) return candidates
  for (const field of ['id', 'provider', 'providerId', 'provider_id', 'name', 'label', 'displayName']) {
    const value = raw[field]
    if (typeof value === 'string' && value.trim() !== '') candidates.push(value)
  }
  return candidates
}

/**
 * Turn a candidate id into a valid custom provider id.
 * @param {unknown} candidate - candidate string.
 * @returns {string | null} the valid id, or `null` when no valid id can be derived.
 */
function normalizeProviderId(candidate) {
  if (typeof candidate !== 'string') return null
  const text = candidate.trim().toLowerCase()
  if (text === '') return null
  const mangled = text
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '')
  for (const form of [text, mangled]) {
    if (/^[a-z][a-z0-9-]{0,63}$/u.test(form)) return form
  }
  return null
}

/**
 * Derive the first valid provider id from a candidate list.
 * @param {readonly unknown[]} candidates - candidate ids.
 * @returns {string | null} the valid id, or `null`.
 */
function deriveProviderId(candidates) {
  for (const candidate of candidates) {
    const id = normalizeProviderId(candidate)
    if (id !== null) return id
  }
  return null
}

/**
 * List id/profile pairs from a provider map or a provider array.
 * @param {unknown} node - provider collection.
 * @returns {Array<{ idCandidates: string[], raw: Record<string, unknown> }>} provider entries.
 */
function listProfileEntries(node) {
  if (Array.isArray(node)) {
    return node
      .filter(isPlainObject)
      .map(item => ({ idCandidates: providerEntryCandidates(item), raw: item }))
  }
  if (!isPlainObject(node)) return []
  const entries = []
  for (const [key, value] of Object.entries(node)) {
    if (!isPlainObject(value)) continue
    const raw = isPlainObject(value.profile) ? value.profile : value
    const candidates = [key, ...providerEntryCandidates(raw).filter(candidate => candidate !== key)]
    entries.push({ idCandidates: candidates, raw })
  }
  return entries
}

/**
 * List Cherry Studio provider entries.
 * @param {unknown} root - parsed Cherry Studio payload.
 * @returns {Array<{ idCandidates: string[], raw: Record<string, unknown> }>} provider entries.
 */
function listCherryEntries(root) {
  let list = null
  if (Array.isArray(root)) list = root
  else if (isPlainObject(root)) {
    if (Array.isArray(root.providers)) list = root.providers
    else if (isPlainObject(root.providers)) return listProfileEntries(root.providers)
    else if (Array.isArray(root.data)) list = root.data
    else if (typeof root.apiHost === 'string' || (typeof root.type === 'string' && Array.isArray(root.models))) list = [root]
  }
  if (list === null) return []
  return list
    .filter(isPlainObject)
    .map(item => ({ idCandidates: providerEntryCandidates(item), raw: item }))
}

/**
 * Whether an object looks like a DSH pi-ai provider profile.
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether it carries an endpoint or a supported protocol.
 */
function looksLikeProviderProfile(value) {
  if (!isPlainObject(value)) return false
  if (typeof value.baseURL === 'string' && value.baseURL !== '') return true
  if (typeof value.baseUrl === 'string' && value.baseUrl !== '') return true
  if (typeof value.apiHost === 'string' && value.apiHost !== '') return true
  return typeof value.api === 'string' && SUPPORTED_PROTOCOLS.includes(value.api)
}

/**
 * Find every `providers` map inside a DSH Cordis patch document.
 * @param {unknown} root - parsed patch document.
 * @returns {Array<{ idCandidates: string[], raw: Record<string, unknown> }>} provider entries.
 */
function listCordisEntries(root) {
  const entries = []
  const seen = new Set()
  const visit = node => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (!isPlainObject(node)) return
    if (isPlainObject(node.providers)) {
      for (const [key, value] of Object.entries(node.providers)) {
        if (seen.has(key) || !looksLikeProviderProfile(value)) continue
        seen.add(key)
        const candidates = [key, ...providerEntryCandidates(value).filter(candidate => candidate !== key)]
        entries.push({ idCandidates: candidates, raw: value })
      }
    }
    for (const value of Object.values(node)) visit(value)
  }
  visit(root)
  return entries
}

/**
 * Whether a document contains a `providers` map of provider-like values.
 * @param {unknown} root - parsed document.
 * @returns {boolean} whether such a map exists.
 */
function containsProvidersMap(root) {
  const visit = node => {
    if (Array.isArray(node)) return node.some(item => visit(item))
    if (!isPlainObject(node)) return false
    if (isPlainObject(node.providers) && Object.values(node.providers).some(looksLikeProviderProfile)) return true
    return Object.values(node).some(value => visit(value))
  }
  return visit(root)
}

/**
 * Detect the import format of an already-parsed payload.
 * @param {unknown} root - parsed JSON or YAML payload.
 * @returns {string} one of `IMPORT_FORMATS`.
 * @throws {ApiManagerError} `unsupported-import-format` when nothing matches.
 */
function detectFormatFromStructure(root) {
  if (isPlainObject(root) && root.format === EXPORT_FORMAT) return 'xiaoxing-json'
  if (Array.isArray(root)) {
    if (root.some(item => isPlainObject(item) && (item.insert !== undefined || item.patch !== undefined))) {
      return 'dsh-cordis-yaml'
    }
    if (root.some(item => isPlainObject(item) && typeof item.apiHost === 'string')) return 'cherry-json'
    if (root.some(item => isPlainObject(item) && typeof item.type === 'string')) return 'cherry-json'
    return 'xiaoxing-json'
  }
  if (!isPlainObject(root)) {
    throw new ApiManagerError('unsupported-import-format', 'the config payload must be an object or an array')
  }
  if (isPlainObject(root.providers)) {
    const values = Object.values(root.providers).filter(isPlainObject)
    if (values.some(value => typeof value.apiHost === 'string')) return 'cherry-json'
    if (values.some(value => typeof value.baseUrl === 'string')) return 'omp-yaml'
    if (values.some(value => typeof value.type === 'string' && value.baseURL === undefined && value.baseUrl === undefined)) {
      return 'cherry-json'
    }
    return 'xiaoxing-json'
  }
  if (Array.isArray(root.providers)) {
    return root.providers.some(item => isPlainObject(item) && typeof item.apiHost === 'string')
      ? 'cherry-json'
      : 'xiaoxing-json'
  }
  if (containsProvidersMap(root)) return 'dsh-cordis-yaml'
  if (Object.values(root).some(value => isPlainObject(value) && looksLikeProviderProfile(value))) return 'xiaoxing-json'
  if (
    Array.isArray(root.data) &&
    root.data.some(item => isPlainObject(item) && (typeof item.apiHost === 'string' || typeof item.type === 'string'))
  ) {
    return 'cherry-json'
  }
  if (typeof root.apiHost === 'string' || (typeof root.type === 'string' && Array.isArray(root.models))) {
    return 'cherry-json'
  }
  throw new ApiManagerError('unsupported-import-format', 'the config payload does not match any supported import format')
}

/**
 * Detect the import format of a parsed YAML payload.
 * @param {unknown} root - parsed YAML document.
 * @returns {string} `omp-yaml` or `dsh-cordis-yaml`.
 * @throws {ApiManagerError} `unsupported-import-format` when nothing matches.
 */
function detectFormatFromYaml(root) {
  if (Array.isArray(root)) return 'dsh-cordis-yaml'
  if (isPlainObject(root) && isPlainObject(root.providers)) return 'omp-yaml'
  if (isPlainObject(root) && Array.isArray(root.providers)) return 'omp-yaml'
  if (isPlainObject(root) && containsProvidersMap(root)) return 'dsh-cordis-yaml'
  throw new ApiManagerError(
    'unsupported-import-format',
    'the YAML config has no "providers" mapping; expected an OMP models.yml or a DSH Cordis patch',
  )
}

/**
 * Resolve the payload and format of one import input.
 * @param {unknown} input - config text or an already-parsed payload.
 * @param {string} format - requested format or `auto`.
 * @returns {{ format: string, root: unknown }} the resolved format and payload.
 * @throws {ApiManagerError} `invalid-import` or `unsupported-import-format`.
 */
function resolveImportInput(input, format) {
  const explicit = format !== 'auto'
  if (input === null || input === undefined) {
    throw new ApiManagerError('invalid-import', 'a config payload is required')
  }
  if (typeof input === 'object') {
    return { format: explicit ? format : detectFormatFromStructure(input), root: input }
  }
  if (typeof input !== 'string') throw new TypeError('config input must be a string or a parsed object')
  const text = input.replace(/^\uFEFF/u, '')
  if (text.trim() === '') throw new ApiManagerError('invalid-import', 'the config payload is empty')
  const trimmed = text.trimStart()
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[')

  if (explicit) {
    if (looksLikeJson) {
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      if (parsed !== undefined) return { format, root: parsed }
    }
    return { format, root: parseYamlSubset(text) }
  }

  if (looksLikeJson) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (parsed !== undefined) return { format: detectFormatFromStructure(parsed), root: parsed }
  }
  const root = parseYamlSubset(text)
  return { format: detectFormatFromYaml(root), root }
}

/**
 * Collect provider entries for one detected format.
 * @param {string} format - detected import format.
 * @param {unknown} root - parsed payload.
 * @returns {Array<{ idCandidates: string[], raw: Record<string, unknown> }>} provider entries.
 * @throws {ApiManagerError} `invalid-import` when the format's own shape is missing.
 */
function collectProviderEntries(format, root) {
  if (format === 'xiaoxing-json') {
    const node = isPlainObject(root) && root.providers !== undefined ? root.providers : root
    return listProfileEntries(node)
  }
  if (format === 'omp-yaml') {
    if (!isPlainObject(root) || root.providers === undefined) {
      throw new ApiManagerError('invalid-import', 'OMP models.yml needs a top-level "providers" mapping')
    }
    return listProfileEntries(root.providers)
  }
  if (format === 'cherry-json') return listCherryEntries(root)
  if (format === 'dsh-cordis-yaml') return listCordisEntries(root)
  throw new ApiManagerError('unsupported-import-format', `unsupported import format "${format}"`, { format })
}

/* ------------------------------------------------------------------------- */
/* Import: provider and model normalization                                  */
/* ------------------------------------------------------------------------- */

/**
 * Resolve the wire protocol of one imported provider.
 * @param {Record<string, unknown>} raw - raw provider entry.
 * @param {string} providerId - validated provider id, for diagnostics.
 * @param {{ warnings: string[] }} context - import context.
 * @returns {string | undefined} a supported protocol, or `undefined` when the provider must be skipped.
 */
function resolveProviderApi(raw, providerId, context) {
  const declared = pickFirstString(raw, ['api', 'protocol', 'transport'])
  if (declared !== undefined) {
    const value = declared.trim()
    if (SUPPORTED_PROTOCOLS.includes(value)) return value
    const alias = OMP_API_ALIASES[value]
    if (alias !== undefined) {
      context.warnings.push(`provider "${providerId}" uses api "${value}"; it was imported as "${alias}"`)
      return alias
    }
    const modelApi = findModelApi(raw.models)
    if (modelApi !== undefined) {
      context.warnings.push(
        `provider "${providerId}" uses api "${value}", which this manager cannot configure; its api was derived from the model list`,
      )
      return modelApi
    }
    context.warnings.push(`provider "${providerId}" uses api "${value}", which this manager cannot configure; it was skipped`)
    return undefined
  }
  const type = pickFirstString(raw, ['type', 'apiType', 'api_type'])
  if (type !== undefined) {
    const mapped = CHERRY_TYPE_TO_API[type.trim().toLowerCase()]
    if (mapped !== undefined) return mapped
    context.warnings.push(`provider "${providerId}" has unknown type "${type}"; it was imported as openai-completions`)
    return 'openai-completions'
  }
  const modelApi = findModelApi(raw.models)
  if (modelApi !== undefined) return modelApi
  context.warnings.push(`provider "${providerId}" does not declare an api; it was imported as openai-completions`)
  return 'openai-completions'
}

/**
 * Read a supported api from a provider's model list.
 * @param {unknown} models - raw model collection.
 * @returns {string | undefined} the first supported api declared by a model.
 */
function findModelApi(models) {
  const list = Array.isArray(models) ? models : isPlainObject(models) ? Object.values(models) : []
  for (const item of list) {
    if (!isPlainObject(item)) continue
    if (typeof item.api === 'string' && SUPPORTED_PROTOCOLS.includes(item.api)) return item.api
  }
  return undefined
}

/**
 * Sanitize imported provider headers: credentials and environment references
 * cannot be reproduced safely, so they are dropped with a warning.
 * @param {Record<string, unknown>} raw - raw provider entry.
 * @param {string} providerId - validated provider id, for diagnostics.
 * @param {{ warnings: string[] }} context - import context.
 * @returns {Record<string, string> | undefined} the sanitized header map.
 */
function normalizeImportedHeaders(raw, providerId, context) {
  if (raw.headers === undefined) return undefined
  if (!isPlainObject(raw.headers)) {
    context.warnings.push(`provider "${providerId}" has a non-object "headers" field; it was dropped`)
    return undefined
  }
  const headers = {}
  for (const [name, value] of Object.entries(raw.headers)) {
    if (typeof value !== 'string') {
      context.warnings.push(`provider "${providerId}" header "${name}" is not a string; it was dropped`)
      continue
    }
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
      context.warnings.push(
        `provider "${providerId}" header "${name}" carries a credential; use apiKey or apiKeyEnv instead — it was dropped`,
      )
      continue
    }
    if (looksLikeCredentialValue(value)) {
      context.warnings.push(`provider "${providerId}" header "${name}" carries a credential-like value; it was dropped`)
      continue
    }
    if (looksLikeEnvReference(value)) {
      context.warnings.push(
        `provider "${providerId}" header "${name}" references an environment variable or command, which cannot be imported safely; it was dropped`,
      )
      continue
    }
    headers[name] = value
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

/**
 * Read a `$ENV_VAR` credential reference from one value.
 * @param {string} value - candidate value.
 * @returns {string | null} the referenced variable name, or `null`.
 */
function parseEnvironmentReference(value) {
  const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value.trim())
  if (braced !== null) return braced[1]
  const plain = /^\$([A-Za-z_][A-Za-z0-9_]*)$/u.exec(value.trim())
  return plain === null ? null : plain[1]
}

/**
 * Resolve a provider's credential reference and move any literal key out of the
 * profile into `pendingSecrets`.
 * @param {Record<string, unknown>} raw - raw provider entry.
 * @param {string} providerId - validated provider id.
 * @param {{ warnings: string[], pendingSecrets: Array<{ providerId: string, apiKeyEnv: string, secret: string }> }} context - import context.
 * @returns {{ apiKeyEnv?: string }} the credential reference to store on the profile.
 */
function resolveImportedCredential(raw, providerId, context) {
  const credential = {}
  const declaredEnvValue = raw.apiKeyEnv ?? raw.api_key_env ?? raw.keyEnv ?? raw.key_env
  if (isPlainObject(declaredEnvValue) && typeof declaredEnvValue.__jsExpr === 'string') {
    context.warnings.push(`provider "${providerId}" declares apiKeyEnv through a !!js expression; set apiKeyEnv manually`)
  } else {
    const declaredEnv = pickFirstString(raw, ['apiKeyEnv', 'api_key_env', 'keyEnv', 'key_env', 'credentialRef', 'credential_ref'])
    if (declaredEnv !== undefined) {
      const value = declaredEnv.trim()
      if (CREDENTIAL_REF_PATTERN.test(value)) credential.apiKeyEnv = validateCredentialRef(value)
      else context.warnings.push(`provider "${providerId}" declares an invalid apiKeyEnv; it was ignored`)
    }
  }

  const rawKeyValue = raw.apiKey ?? raw.api_key ?? raw.apiKeyValue ?? raw.api_key_value
  if (isPlainObject(rawKeyValue) && typeof rawKeyValue.__jsExpr === 'string') {
    context.warnings.push(`provider "${providerId}" declares apiKey through a !!js expression; set apiKeyEnv manually`)
    return credential
  }
  const rawKey = pickFirstString(raw, ['apiKey', 'api_key', 'apiKeyValue', 'api_key_value'])
  if (rawKey === undefined) return credential

  const envReference = parseEnvironmentReference(rawKey)
  if (envReference !== null) {
    if (credential.apiKeyEnv === undefined) credential.apiKeyEnv = envReference
    return credential
  }
  if (rawKey.startsWith('!')) {
    context.warnings.push(
      `provider "${providerId}" resolves apiKey from a shell command; commands are never executed on import — set apiKeyEnv manually`,
    )
    return credential
  }
  if (BARE_ENV_NAME_PATTERN.test(rawKey)) {
    if (credential.apiKeyEnv === undefined) credential.apiKeyEnv = rawKey
    return credential
  }

  let apiKeyEnv = credential.apiKeyEnv
  if (apiKeyEnv === undefined) {
    try {
      apiKeyEnv = deriveCredentialRef(providerId)
    } catch (error) {
      context.warnings.push(`provider "${providerId}" has a literal apiKey but no credential reference could be derived: ${messageOf(error)}`)
      return credential
    }
  }
  context.pendingSecrets.push({ providerId, apiKeyEnv, secret: rawKey })
  credential.apiKeyEnv = apiKeyEnv
  return credential
}

/**
 * Normalize a model's declared input modalities.
 * @param {Record<string, unknown>} raw - raw model entry.
 * @returns {string[] | undefined} the normalized modality list.
 */
function normalizeImportedInput(raw) {
  const values = []
  if (Array.isArray(raw.input)) values.push(...raw.input)
  else if (typeof raw.input === 'string') values.push(raw.input)
  if (Array.isArray(raw.modalities)) values.push(...raw.modalities)
  else if (isPlainObject(raw.modalities) && Array.isArray(raw.modalities.input)) values.push(...raw.modalities.input)
  if (raw.vision === true || raw.supportsVision === true || raw.imageInput === true) values.push('image')
  const selected = new Set()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const modality = value.trim().toLowerCase()
    if (MODALITIES.includes(modality)) selected.add(modality)
  }
  if (selected.size === 0) return undefined
  selected.add('text')
  return MODALITIES.filter(modality => selected.has(modality))
}

/**
 * Default reasoning-effort ladder for one protocol.
 * @param {string} api - wire protocol.
 * @returns {Record<string, string> | undefined} the normalized effort map.
 */
function defaultReasoningLadder(api) {
  if (api === 'google-generative-ai') {
    return normalizeReasoningEffortsForApi(
      { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
      api,
    )
  }
  return normalizeReasoningEffortsForApi({ low: 'low', medium: 'medium', high: 'high' }, api)
}

/**
 * Normalize an OMP `thinking` block into DSH reasoning efforts.
 * @param {unknown} thinking - raw thinking declaration.
 * @param {Record<string, unknown>} raw - raw model entry (for `compat.reasoningEffortMap`).
 * @param {string} api - wire protocol.
 * @param {{ warnings: string[] }} context - import context.
 * @param {string} providerId - validated provider id, for diagnostics.
 * @param {string} modelId - model id, for diagnostics.
 * @returns {false | Record<string, string> | undefined} the normalized declaration.
 */
function normalizeThinkingBlock(thinking, raw, api, context, providerId, modelId) {
  if (thinking === false) return false
  if (thinking === true) return defaultReasoningLadder(api)
  if (typeof thinking === 'string') {
    const level = thinking.trim().toLowerCase()
    if (level === 'off' || level === 'none' || level === 'disabled' || level === 'false') return false
    const levels = api === 'google-generative-ai' ? GEMINI_THINKING_LEVELS : THINKING_LEVELS
    if (level !== 'off' && levels.includes(level)) {
      const single = normalizeReasoningEffortsForApi({ [level]: level }, api)
      if (single !== undefined) return single
    }
    context.warnings.push(
      `provider "${providerId}" model "${modelId}" has an unrecognised thinking level; the default level ladder was used`,
    )
    return defaultReasoningLadder(api)
  }
  if (!isPlainObject(thinking)) {
    context.warnings.push(`provider "${providerId}" model "${modelId}" has an unrecognised thinking block; it was dropped`)
    return undefined
  }
  if (thinking.enabled === false) return false

  let effortMap = {}
  if (isPlainObject(thinking.effortMap)) effortMap = thinking.effortMap
  else if (isPlainObject(raw.compat) && isPlainObject(raw.compat.reasoningEffortMap)) {
    effortMap = raw.compat.reasoningEffortMap
  }
  const allowedLevels = api === 'google-generative-ai' ? GEMINI_THINKING_LEVELS : THINKING_LEVELS
  const declaredLevels = Array.isArray(thinking.efforts)
    ? thinking.efforts
    : Array.isArray(thinking.levels)
      ? thinking.levels
      : []
  const efforts = {}
  for (const value of declaredLevels) {
    if (typeof value !== 'string') continue
    const level = value.trim().toLowerCase()
    if (level === 'off' || !allowedLevels.includes(level)) continue
    const wire = effortMap[level]
    efforts[level] = typeof wire === 'string' && wire !== '' ? wire : level
  }
  if (Object.keys(efforts).length === 0) return defaultReasoningLadder(api)
  return normalizeReasoningEffortsForApi(efforts, api)
}

/**
 * Resolve a model's reasoning-effort declaration.
 * @param {Record<string, unknown>} raw - raw model entry.
 * @param {string} api - wire protocol.
 * @param {{ warnings: string[] }} context - import context.
 * @param {string} providerId - validated provider id, for diagnostics.
 * @param {string} modelId - model id, for diagnostics.
 * @returns {false | Record<string, string> | undefined} the normalized declaration.
 */
function resolveImportedReasoningEfforts(raw, api, context, providerId, modelId) {
  const declared = raw.reasoningEfforts ?? raw.reasoning_efforts
  if (declared !== undefined) {
    const normalized = normalizeReasoningEffortsForApi(declared, api)
    if (normalized === undefined) {
      context.warnings.push(
        `provider "${providerId}" model "${modelId}" declares unusable reasoningEfforts; they were dropped`,
      )
    }
    return normalized
  }
  if (raw.thinking !== undefined) {
    return normalizeThinkingBlock(raw.thinking, raw, api, context, providerId, modelId)
  }
  if (raw.reasoning === true || raw.supportsReasoning === true) return defaultReasoningLadder(api)
  if (raw.reasoning === false) return false
  return undefined
}

/**
 * Normalize one model's compat block to the fields its protocol offers.
 * @param {Record<string, unknown>} raw - raw model entry.
 * @param {string} api - wire protocol.
 * @param {{ warnings: string[] }} context - import context.
 * @param {string} providerId - validated provider id, for diagnostics.
 * @param {string} modelId - model id, for diagnostics.
 * @returns {Record<string, unknown> | undefined} the normalized compat block.
 */
function normalizeImportedCompat(raw, api, context, providerId, modelId) {
  if (!isPlainObject(raw.compat)) return undefined
  const offered = COMPAT_FIELDS_BY_API[api] ?? []
  const consumed = new Set()
  if (isPlainObject(raw.compat.reasoningEffortMap) && raw.thinking !== undefined) consumed.add('reasoningEffortMap')
  const dropped = Object.keys(raw.compat).filter(field => !offered.includes(field) && !consumed.has(field))
  const filtered = filterCompatForApi(raw.compat, api)
  if (Object.keys(filtered).length === 0) {
    if (dropped.length > 0) {
      context.warnings.push(
        `provider "${providerId}" model "${modelId}" compat fields ${dropped.join(', ')} are not supported by api "${api}"; they were dropped`,
      )
    }
    return undefined
  }
  if (dropped.length > 0) {
    context.warnings.push(
      `provider "${providerId}" model "${modelId}" compat fields ${dropped.join(', ')} are not supported by api "${api}"; they were dropped`,
    )
  }
  return filtered
}

/**
 * Normalize one imported model entry to the DSH model profile shape.
 * @param {Record<string, unknown>} raw - raw model entry.
 * @param {string} api - provider wire protocol.
 * @param {string} providerId - validated provider id, for diagnostics.
 * @param {{ format: string, warnings: string[] }} context - import context.
 * @returns {Record<string, unknown> | undefined} the model profile, or `undefined` when it must be skipped.
 */
function normalizeImportedModel(raw, api, providerId, context) {
  const rawId = pickFirstString(raw, ['id', 'model', 'modelId', 'model_id'])
  if (rawId === undefined) {
    context.warnings.push(`provider "${providerId}" has a model entry without an id; it was skipped`)
    return undefined
  }
  const modelId = rawId.trim()
  const declaredApi = pickFirstString(raw, ['api', 'protocol'])
  if (declaredApi !== undefined && declaredApi.trim() !== api) {
    context.warnings.push(
      `provider "${providerId}" model "${modelId}" declares api "${declaredApi.trim()}", which cannot be represented under provider api "${api}"; the model was skipped`,
    )
    return undefined
  }

  const model = { id: modelId }
  const name = pickFirstString(raw, ['name', 'label', 'displayName'])
  model.name = name === undefined ? modelId : name.trim()

  let contextWindow = pickPositiveInteger(raw, ['contextWindow', 'context_window', 'contextLength', 'context_length', 'context'])
  if (contextWindow === undefined && isPlainObject(raw.limit)) {
    contextWindow = pickPositiveInteger(raw.limit, ['context'])
  }
  if (contextWindow !== undefined) model.contextWindow = contextWindow

  let maxTokens = pickPositiveInteger(raw, [
    'maxTokens',
    'max_tokens',
    'maxOutputTokens',
    'max_output_tokens',
    'maxCompletionTokens',
    'output',
  ])
  if (maxTokens === undefined && isPlainObject(raw.limit)) maxTokens = pickPositiveInteger(raw.limit, ['output'])
  if (maxTokens !== undefined) model.maxTokens = maxTokens

  const input = normalizeImportedInput(raw)
  if (input !== undefined) model.input = input

  const reasoningEfforts = resolveImportedReasoningEfforts(raw, api, context, providerId, modelId)
  if (reasoningEfforts !== undefined) model.reasoningEfforts = reasoningEfforts

  const compat = normalizeImportedCompat(raw, api, context, providerId, modelId)
  if (compat !== undefined) model.compat = compat

  if (context.format === 'omp-yaml') {
    if (model.contextWindow === undefined) model.contextWindow = OMP_DEFAULT_CONTEXT_WINDOW
    if (model.maxTokens === undefined) model.maxTokens = OMP_DEFAULT_MAX_TOKENS
    if (model.input === undefined) model.input = ['text']
    if (model.reasoningEfforts === undefined) model.reasoningEfforts = false
  }

  try {
    validateModelProfile(model, api)
  } catch (error) {
    context.warnings.push(`provider "${providerId}" model "${modelId}" was skipped: ${messageOf(error)}`)
    return undefined
  }
  return model
}

/**
 * Normalize a provider's model list.
 * @param {unknown} rawModels - array or map of raw model entries.
 * @param {string} api - provider wire protocol.
 * @param {string} providerId - validated provider id, for diagnostics.
 * @param {{ format: string, warnings: string[] }} context - import context.
 * @returns {Array<Record<string, unknown>>} the normalized model profiles.
 */
function normalizeImportedModels(rawModels, api, providerId, context) {
  const list = []
  if (Array.isArray(rawModels)) {
    for (const item of rawModels) {
      if (typeof item === 'string') list.push({ id: item })
      else if (isPlainObject(item)) list.push(item)
    }
  } else if (isPlainObject(rawModels)) {
    for (const [modelId, value] of Object.entries(rawModels)) {
      if (isPlainObject(value)) list.push({ id: modelId, ...value })
      else if (typeof value === 'string') list.push({ id: modelId, name: value })
      else list.push({ id: modelId })
    }
  }
  const models = []
  const seen = new Set()
  for (const rawModel of list) {
    const model = normalizeImportedModel(rawModel, api, providerId, context)
    if (model === undefined) continue
    if (seen.has(model.id)) {
      context.warnings.push(`provider "${providerId}" lists model "${model.id}" more than once; the first definition wins`)
      continue
    }
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/**
 * Normalize one raw provider entry to a DSH `PiAiProviderProfile`.
 * @param {string} providerId - validated provider id.
 * @param {Record<string, unknown>} raw - raw provider entry.
 * @param {{ format: string, configurableProviders: unknown[], warnings: string[], pendingSecrets: unknown[] }} context - import context.
 * @returns {Record<string, unknown> | undefined} the profile, or `undefined` when the provider must be skipped.
 */
function normalizeImportedProvider(providerId, raw, context) {
  const baseURLCandidate = pickFirstString(raw, [
    'baseURL',
    'baseUrl',
    'base_url',
    'apiHost',
    'apiBase',
    'api_base',
    'endpoint',
    'url',
  ])
  if (baseURLCandidate === undefined) {
    context.warnings.push(`provider "${providerId}" has no endpoint URL; it was skipped`)
    return undefined
  }
  const baseURL = baseURLCandidate.trim().replace(/\/+$/u, '')
  const api = resolveProviderApi(raw, providerId, context)
  if (api === undefined) return undefined
  if (raw.syncPolicy !== undefined) {
    context.warnings.push(`provider "${providerId}" carries a sync policy, which the importer does not apply`)
  }

  const models = normalizeImportedModels(raw.models, api, providerId, context)
  if (models.length === 0) {
    context.warnings.push(`provider "${providerId}" has no usable models; it was skipped`)
    return undefined
  }

  const profile = { name: providerId, baseURL, api, models }
  const name = pickFirstString(raw, ['name', 'label', 'displayName', 'title'])
  if (name !== undefined) profile.name = name.trim()
  const credential = resolveImportedCredential(raw, providerId, context)
  if (credential.apiKeyEnv !== undefined) profile.apiKeyEnv = credential.apiKeyEnv
  const headers = normalizeImportedHeaders(raw, providerId, context)
  if (headers !== undefined) profile.headers = headers

  try {
    validateProviderProfile(providerId, profile, context.configurableProviders)
  } catch (error) {
    context.warnings.push(`provider "${providerId}" was skipped: ${messageOf(error)}`)
    return undefined
  }
  return profile
}

/**
 * Import provider definitions from a third-party or DSH config document.
 *
 * Reserved ids (native DSH providers and built-in pi-ai catalog providers) are
 * never imported: they are reported in `skippedReserved` so the caller can tell
 * the user to name the route instead. A literal inline `apiKey` is removed from
 * the profile and returned in `pendingSecrets` together with the credential
 * reference the profile now carries.
 *
 * @param {unknown} input - config text, or an already-parsed JSON/YAML payload.
 * @param {object} [options] - import options.
 * @param {string} [options.format] - `auto` or one of `IMPORT_FORMATS`.
 * @param {Array<{ provider?: string, declared?: boolean }>} [options.configurableProviders] - provider entries the
 *   DSH configuration offers.
 * @returns {{ format: string, providers: Record<string, Record<string, unknown>>,
 *   pendingSecrets: Array<{ providerId: string, apiKeyEnv: string, secret: string }>,
 *   skippedReserved: Array<{ providerId: string, category: string | null, reason: string | null }>,
 *   warnings: string[] }} the normalized import result.
 * @throws {TypeError} when an option type is invalid.
 * @throws {ApiManagerError} `unsupported-import-format` for an unknown format,
 *   `invalid-import` for unparsable or structurally invalid input.
 */
export function importThirdPartyConfig(input, { format = 'auto', configurableProviders = [] } = {}) {
  if (format !== 'auto' && !IMPORT_FORMATS.includes(format)) {
    throw new ApiManagerError('unsupported-import-format', `format must be "auto" or one of ${IMPORT_FORMATS.join(', ')}`, {
      format,
    })
  }
  if (!Array.isArray(configurableProviders)) throw new TypeError('configurableProviders must be an array')

  const resolved = resolveImportInput(input, format)
  const context = {
    format: resolved.format,
    configurableProviders,
    pendingSecrets: [],
    skippedReserved: [],
    warnings: [],
  }
  const entries = collectProviderEntries(resolved.format, resolved.root)
  const providers = {}
  const seen = new Set()

  for (const entry of entries) {
    const providerId = deriveProviderId(entry.idCandidates)
    if (providerId === null) {
      context.warnings.push('a provider entry has no id that can be mapped to a valid provider id; it was skipped')
      continue
    }
    if (seen.has(providerId)) {
      context.warnings.push(`provider "${providerId}" appears more than once; the first definition wins`)
      continue
    }
    seen.add(providerId)

    const reserved = checkReservedProviderId(providerId, configurableProviders)
    if (reserved.reserved) {
      context.skippedReserved.push({ providerId, category: reserved.category, reason: reserved.reason })
      continue
    }
    try {
      validateCustomProviderId(providerId, configurableProviders)
    } catch (error) {
      context.warnings.push(`provider "${providerId}" was skipped: ${messageOf(error)}`)
      continue
    }

    const profile = normalizeImportedProvider(providerId, entry.raw, context)
    if (profile !== undefined) providers[providerId] = profile
  }

  const sortedProviders = {}
  for (const providerId of Object.keys(providers).sort(compareStrings)) {
    sortedProviders[providerId] = providers[providerId]
  }
  return {
    format: resolved.format,
    providers: sortedProviders,
    pendingSecrets: context.pendingSecrets,
    skippedReserved: context.skippedReserved,
    warnings: context.warnings,
  }
}
