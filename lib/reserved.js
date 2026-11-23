/**
 * Provider ids the manager must never overwrite.
 *
 * Two namespaces are reserved. Native DSH providers ship with the harness, and
 * the installed pi-ai catalog ships built-in chat providers that a deployment
 * selects by naming them in configuration; a custom provider reusing either id
 * would shadow a working route. A provider the deployment itself declared in
 * configuration is configurable and therefore not reserved.
 * @module @xiaoxing/api-provider-manager/reserved
 */

import { ApiManagerError } from './errors.js'

/** Provider ids owned by DSH itself. */
export const NATIVE_DSH_PROVIDERS = Object.freeze(new Set([
  'deepseek-official',
  'deepseek-account',
  'llm-deepseek',
  'llm-deepseek-account',
  'typesafe',
]))

/**
 * Provider ids the installed pi-ai catalog ships as built-in chat providers,
 * verified against `@deepseek-ai/dsh-llm-pi-ai` 0.2.2-rc.3.
 */
export const BUILTIN_PI_AI_PROVIDERS = Object.freeze(new Set([
  'amazon-bedrock',
  'ant-ling',
  'anthropic',
  'azure',
  'baseten',
  'cerebras',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'deepseek',
  'fireworks',
  'github-copilot',
  'google',
  'google-vertex',
  'groq',
  'huggingface',
  'kimi-coding',
  'meta',
  'minimax',
  'minimax-cn',
  'mistral',
  'moonshotai',
  'moonshotai-cn',
  'nvidia',
  'openai',
  'openai-codex',
  'opencode',
  'opencode-go',
  'openrouter',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
  'radius',
  'together',
  'vercel-ai-gateway',
  'xai',
  'xiaomi',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'zai',
  'zai-coding-cn',
]))

/** A custom provider id: lowercase, starts with a letter, up to 64 characters. */
const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u

/** An environment variable name usable as a credential reference. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

/**
 * Merge every reserved provider id.
 *
 * Configuration entries for providers the deployment did not declare itself
 * are reserved too: they are already reachable by naming them, so a custom
 * provider must not take their place.
 * @param {readonly { provider?: string, declared?: boolean }[]} [configurableProviders] - provider entries the
 *   DSH configuration offers.
 * @returns {Set<string>} the reserved provider ids.
 */
export function collectReservedProviderIds(configurableProviders = []) {
  const reserved = new Set([...NATIVE_DSH_PROVIDERS, ...BUILTIN_PI_AI_PROVIDERS])
  for (const entry of configurableProviders) {
    if (!entry || entry.declared === true) continue
    if (typeof entry.provider === 'string' && entry.provider.length > 0) reserved.add(entry.provider)
  }
  return reserved
}

/**
 * Classify one provider id against the reserved namespaces.
 * @param {unknown} id - candidate provider id.
 * @param {readonly { provider?: string, declared?: boolean }[]} [configurableProviders] - provider entries the
 *   DSH configuration offers.
 * @returns {{ reserved: boolean, category: 'native' | 'builtin-catalog' | null, reason: string | null }} the
 *   verdict; `category` is `null` for a configuration-owned id and for an allowed id.
 */
export function checkReservedProviderId(id, configurableProviders = []) {
  if (typeof id !== 'string' || id.length === 0) {
    return { reserved: false, category: null, reason: null }
  }
  if (NATIVE_DSH_PROVIDERS.has(id)) {
    return {
      reserved: true,
      category: 'native',
      reason: `provider id "${id}" is a native DSH provider; choose a different id for the custom provider`,
    }
  }
  if (BUILTIN_PI_AI_PROVIDERS.has(id)) {
    return {
      reserved: true,
      category: 'builtin-catalog',
      reason: `provider id "${id}" is a built-in pi-ai catalog provider; name it as a route instead of declaring a custom provider`,
    }
  }
  for (const entry of configurableProviders) {
    if (!entry || entry.declared === true) continue
    if (entry.provider === id) {
      return {
        reserved: true,
        category: null,
        reason: `provider id "${id}" is already offered by the DSH configuration`,
      }
    }
  }
  return { reserved: false, category: null, reason: null }
}

/**
 * Validate a custom provider id.
 * @param {unknown} id - candidate provider id.
 * @param {readonly { provider?: string, declared?: boolean }[]} [configurableProviders] - provider entries the
 *   DSH configuration offers.
 * @returns {string} the validated id.
 * @throws {ApiManagerError} `invalid-provider-id` when the id is malformed,
 *   `reserved-native-provider` when it collides with a reserved namespace.
 */
export function validateCustomProviderId(id, configurableProviders = []) {
  if (typeof id !== 'string' || !CUSTOM_PROVIDER_ID_PATTERN.test(id)) {
    throw new ApiManagerError(
      'invalid-provider-id',
      'provider id must be 1-64 characters, start with a lowercase letter, and contain only lowercase letters, digits, and hyphens',
      { id },
    )
  }
  const verdict = checkReservedProviderId(id, configurableProviders)
  if (verdict.reserved) {
    throw new ApiManagerError('reserved-native-provider', verdict.reason ?? `provider id "${id}" is reserved`, {
      id,
      category: verdict.category,
    })
  }
  return id
}

/**
 * Derive the default credential reference for a provider id.
 *
 * The reference is the provider id upper-cased with hyphens turned into
 * underscores plus an `_API_KEY` suffix, so `my-relay` becomes
 * `MY_RELAY_API_KEY`.
 * @param {unknown} providerId - provider id to derive from.
 * @returns {string} the derived environment variable name.
 * @throws {ApiManagerError} `invalid-credential-ref` when no valid name can be derived.
 */
export function deriveCredentialRef(providerId) {
  if (typeof providerId !== 'string' || providerId.length === 0) {
    throw new ApiManagerError('invalid-credential-ref', 'a provider id is required to derive a credential reference', {
      providerId,
    })
  }
  const ref = `${providerId.replaceAll('-', '_').toUpperCase()}_API_KEY`
  if (!CREDENTIAL_REF_PATTERN.test(ref)) {
    throw new ApiManagerError(
      'invalid-credential-ref',
      `provider id "${providerId}" cannot be mapped to an environment variable name`,
      { providerId },
    )
  }
  return ref
}

/**
 * Validate a credential reference.
 * @param {unknown} ref - environment variable name to validate.
 * @returns {string} the validated reference.
 * @throws {ApiManagerError} `invalid-credential-ref` when it is not an environment variable name.
 */
export function validateCredentialRef(ref) {
  if (typeof ref !== 'string' || !CREDENTIAL_REF_PATTERN.test(ref)) {
    throw new ApiManagerError(
      'invalid-credential-ref',
      'credential reference must be an environment variable name: letters, digits, and underscores, not starting with a digit',
      { ref },
    )
  }
  return ref
}
