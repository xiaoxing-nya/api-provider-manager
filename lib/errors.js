/**
 * Failure types and diagnostic redaction for the Xiaoxing API provider manager.
 *
 * Every business failure carries a stable `code` so the settings page, the tool,
 * and the tests can branch on the cause instead of matching message text. Error
 * text may echo a failed request, so redaction runs before a message reaches a
 * log, a tool result, or the Web client.
 * @module @xiaoxing/api-provider-manager/errors
 */

/** Business failure carrying a stable machine-readable code. */
export class ApiManagerError extends Error {
  /**
   * @param {string} code - stable machine-readable code.
   * @param {string} message - human-readable English detail.
   * @param {unknown} [details] - structured context for diagnostics.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'ApiManagerError'
    this.code = code
    this.details = details
  }
}

/**
 * Read one thrown value's message without assuming it is an `Error`.
 * @param {unknown} error - thrown value.
 * @returns {string} its message, or the value stringified.
 */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Bearer credentials accidentally embedded in a message. */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu
/** OpenAI-style API keys accidentally embedded in a message. */
const SK_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]+/gu
/** Replacement written over every redacted secret. */
const REDACTED = '***'

/**
 * Mask credentials a diagnostic must not carry.
 *
 * Provider failures often echo the request that failed, which can include an
 * API key from a header or a URL. The two common key spellings are masked
 * first, then every secret literal the caller already knows is replaced.
 * @param {unknown} text - message to redact.
 * @param {readonly string[]} [secrets] - secret literals known to the caller.
 * @returns {string} the message with every matched secret replaced by `***`.
 */
export function redactSecretText(text, secrets = []) {
  let redacted = String(text).replace(BEARER_PATTERN, REDACTED).replace(SK_KEY_PATTERN, REDACTED)
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue
    redacted = redacted.split(secret).join(REDACTED)
  }
  return redacted
}
