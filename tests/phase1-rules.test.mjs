/**
 * Phase 1 rule tests: error redaction, reserved provider ids, presets, model id
 * canonicalization, and the declarative family rules.
 *
 * Run with `node tests/phase1-rules.test.mjs` from the package root.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { ApiManagerError, messageOf, redactSecretText } from '../lib/errors.js'
import {
  BUILTIN_PI_AI_PROVIDERS,
  NATIVE_DSH_PROVIDERS,
  checkReservedProviderId,
  collectReservedProviderIds,
  deriveCredentialRef,
  validateCredentialRef,
  validateCustomProviderId,
} from '../lib/reserved.js'
import {
  CACHE_CONTROL_FORMATS,
  COMPAT_FIELDS_BY_API,
  CUSTOM_GATEWAY_PRESETS,
  GEMINI_THINKING_LEVELS,
  MAX_TOKENS_FIELDS,
  MODALITIES,
  SUPPORTED_PROTOCOLS,
  SUPPORTED_THINKING_FORMATS,
  THINKING_LEVELS,
  THINKING_TOKEN_BUDGET_FIELDS,
  filterCompatForApi,
  getPreset,
  listPresets,
  normalizeReasoningEffortsForApi,
  validateModelProfile,
  validateProviderProfile,
} from '../lib/presets.js'
import {
  canonModelId,
  candidateLookupKeys,
  deriveVendorGroup,
  isLikelyNonChatModel,
} from '../lib/canon.js'

const FAMILY_RULES = JSON.parse(readFileSync(new URL('../data/family-rules.json', import.meta.url), 'utf8'))

/** Provider ids the installed pi-ai catalog ships, in catalog order. */
const EXPECTED_BUILTIN_PROVIDERS = [
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
]

/** Compat fields the four supported protocols offer, in schema order. */
const EXPECTED_COMPAT_FIELDS = {
  'openai-completions': [
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
  ],
  'openai-responses': [
    'supportsDeveloperRole',
    'supportsMaxOutputTokens',
    'supportsStrictMode',
    'supportsLongCacheRetention',
  ],
  'anthropic-messages': [
    'supportsEagerToolInputStreaming',
    'supportsLongCacheRetention',
    'supportsCacheControlOnTools',
    'supportsTemperature',
    'forceAdaptiveThinking',
    'allowEmptySignature',
    'supportsStrictTools',
  ],
  'google-generative-ai': [],
}

/** Vendor groups `deriveVendorGroup` may return. */
const VENDOR_GROUPS = new Set([
  'DeepSeek',
  'Anthropic',
  'OpenAI',
  'Google',
  'Zhipu GLM',
  'Qwen',
  'Moonshot',
  'MiniMax',
  'Mistral',
  'Meta Llama',
  'xAI',
  'Other',
])

/** Every compat field name any supported protocol offers. */
const ALL_COMPAT_FIELDS = new Set(Object.values(COMPAT_FIELDS_BY_API).flat())

/**
 * Assert that a call throws an `ApiManagerError` with one code.
 * @param {() => unknown} call - call expected to throw.
 * @param {string} code - expected error code.
 * @param {string} label - assertion label.
 * @returns {void}
 */
function assertThrowsCode(call, code, label) {
  assert.throws(call, error => {
    assert.ok(error instanceof ApiManagerError, `${label}: expected ApiManagerError, got ${error?.constructor?.name}`)
    assert.equal(error.code, code, `${label}: expected code ${code}, got ${error.code}`)
    return true
  })
}

/**
 * Read one package file as UTF-8 text.
 * @param {string} relativePath - path relative to this test file.
 * @returns {string} file text.
 */
function readText(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
}

/**
 * Find the first family rule matching one model id, as a consumer would.
 * @param {string} id - model id.
 * @returns {object | undefined} the first matching rule.
 */
function firstMatchingRule(id) {
  const normalized = canonModelId(id).normalized
  return FAMILY_RULES.rules.find(rule => new RegExp(rule.match, 'iu').test(normalized))
}

test('errors: ApiManagerError carries name, code, message, and details', () => {
  const error = new ApiManagerError('invalid-provider-id', 'provider id is malformed', { id: 'Bad Id' })
  assert.ok(error instanceof Error)
  assert.ok(error instanceof ApiManagerError)
  assert.equal(error.name, 'ApiManagerError')
  assert.equal(error.code, 'invalid-provider-id')
  assert.equal(error.message, 'provider id is malformed')
  assert.deepEqual(error.details, { id: 'Bad Id' })

  const bare = new ApiManagerError('bare', 'no details')
  assert.equal(bare.details, undefined)
})

test('errors: messageOf stringifies any thrown value', () => {
  assert.equal(messageOf(new Error('boom')), 'boom')
  assert.equal(messageOf(new ApiManagerError('code', 'coded')), 'coded')
  assert.equal(messageOf('plain string'), 'plain string')
  assert.equal(messageOf(42), '42')
  assert.equal(messageOf(null), 'null')
  assert.equal(messageOf(undefined), 'undefined')
  assert.equal(messageOf({}), '[object Object]')
})

test('errors: redactSecretText masks provided secrets and common key spellings', () => {
  assert.equal(redactSecretText('request failed with sk-abc123DEF'), 'request failed with ***')
  assert.equal(redactSecretText('Authorization: Bearer abc.def-123'), 'Authorization: ***')
  assert.equal(redactSecretText('authorization: bearer abc123'), 'authorization: ***')
  assert.equal(redactSecretText('token=supersecret', ['supersecret']), 'token=***')
  assert.equal(redactSecretText('a supersecret b supersecret', ['supersecret']), 'a *** b ***')
  assert.equal(redactSecretText('nothing secret here'), 'nothing secret here')
  assert.equal(redactSecretText('sk-'), 'sk-')
  assert.equal(redactSecretText(42), '42')
  assert.equal(redactSecretText('keep me', ['', null, 42]), 'keep me')
  assert.equal(redactSecretText('Bearer sk-abc'), '***')
})

test('reserved: native and built-in namespaces are exact', () => {
  assert.ok(Object.isFrozen(NATIVE_DSH_PROVIDERS))
  assert.ok(Object.isFrozen(BUILTIN_PI_AI_PROVIDERS))
  assert.deepEqual([...NATIVE_DSH_PROVIDERS].sort(), [
    'deepseek-account',
    'deepseek-official',
    'llm-deepseek',
    'llm-deepseek-account',
    'typesafe',
  ])
  assert.equal(BUILTIN_PI_AI_PROVIDERS.size, 41)
  assert.deepEqual([...BUILTIN_PI_AI_PROVIDERS].sort(), [...EXPECTED_BUILTIN_PROVIDERS].sort())
  assert.ok(!BUILTIN_PI_AI_PROVIDERS.has('typesafe'))
})

test('reserved: collectReservedProviderIds merges namespaces and undeclared configuration entries', () => {
  const plain = collectReservedProviderIds()
  assert.equal(plain.size, NATIVE_DSH_PROVIDERS.size + BUILTIN_PI_AI_PROVIDERS.size)
  for (const id of [...NATIVE_DSH_PROVIDERS, ...BUILTIN_PI_AI_PROVIDERS]) assert.ok(plain.has(id), id)

  const configurable = [
    { provider: 'legacy-relay', declared: false },
    { provider: 'user-relay', declared: true },
    { provider: 'preset-route' },
    null,
    {},
  ]
  const merged = collectReservedProviderIds(configurable)
  assert.ok(merged.has('legacy-relay'))
  assert.ok(merged.has('preset-route'))
  assert.ok(!merged.has('user-relay'))
})

test('reserved: checkReservedProviderId classifies every namespace', () => {
  const native = checkReservedProviderId('deepseek-official')
  assert.equal(native.reserved, true)
  assert.equal(native.category, 'native')
  assert.ok(native.reason.includes('deepseek-official'))

  const builtin = checkReservedProviderId('deepseek')
  assert.equal(builtin.reserved, true)
  assert.equal(builtin.category, 'builtin-catalog')
  assert.ok(builtin.reason.includes('deepseek'))

  const configurable = checkReservedProviderId('legacy-relay', [{ provider: 'legacy-relay', declared: false }])
  assert.equal(configurable.reserved, true)
  assert.equal(configurable.category, null)
  assert.ok(configurable.reason.includes('legacy-relay'))

  const declared = checkReservedProviderId('user-relay', [{ provider: 'user-relay', declared: true }])
  assert.deepEqual(declared, { reserved: false, category: null, reason: null })

  assert.deepEqual(checkReservedProviderId('my-relay'), { reserved: false, category: null, reason: null })
  assert.deepEqual(checkReservedProviderId(42), { reserved: false, category: null, reason: null })
})

test('reserved: validateCustomProviderId accepts custom ids', () => {
  assert.equal(validateCustomProviderId('my-relay'), 'my-relay')
  assert.equal(validateCustomProviderId('relay'), 'relay')
  assert.equal(validateCustomProviderId('a'), 'a')
  assert.equal(validateCustomProviderId('a'.repeat(64)), 'a'.repeat(64))
  assert.equal(validateCustomProviderId('user-relay', [{ provider: 'user-relay', declared: true }]), 'user-relay')
})

test('reserved: validateCustomProviderId rejects malformed ids', () => {
  const invalid = ['', 'My-Relay', '1relay', '-relay', 'relay_1', 'relay/1', 'relay name', 'a'.repeat(65), null, undefined, 42]
  for (const id of invalid) assertThrowsCode(() => validateCustomProviderId(id), 'invalid-provider-id', String(id))
})

test('reserved: validateCustomProviderId rejects every reserved id', () => {
  const reserved = [...NATIVE_DSH_PROVIDERS, ...BUILTIN_PI_AI_PROVIDERS]
  assert.equal(reserved.length, 46)
  for (const id of reserved) assertThrowsCode(() => validateCustomProviderId(id), 'reserved-native-provider', id)
  assertThrowsCode(
    () => validateCustomProviderId('legacy-relay', [{ provider: 'legacy-relay', declared: false }]),
    'reserved-native-provider',
    'legacy-relay',
  )
})

test('reserved: deriveCredentialRef maps provider ids to environment names', () => {
  assert.equal(deriveCredentialRef('my-relay'), 'MY_RELAY_API_KEY')
  assert.equal(deriveCredentialRef('relay'), 'RELAY_API_KEY')
  assert.equal(deriveCredentialRef('my_relay'), 'MY_RELAY_API_KEY')
  assert.equal(deriveCredentialRef('a1-b2'), 'A1_B2_API_KEY')
  assert.match(deriveCredentialRef('my-relay'), /^[A-Za-z_][A-Za-z0-9_]*$/u)
  for (const id of ['', 'my relay', '1relay', 'relay/1', null, undefined, 42]) {
    assertThrowsCode(() => deriveCredentialRef(id), 'invalid-credential-ref', String(id))
  }
})

test('reserved: validateCredentialRef accepts environment names only', () => {
  for (const ref of ['MY_RELAY_API_KEY', 'my_relay', '_KEY', 'A1']) assert.equal(validateCredentialRef(ref), ref)
  for (const ref of ['', '1KEY', 'KEY-1', 'KEY 1', 'KEY.1', null, undefined, 42]) {
    assertThrowsCode(() => validateCredentialRef(ref), 'invalid-credential-ref', String(ref))
  }
})

test('presets: schema constants match dsh-llm-pi-ai 0.2.2-rc.3', () => {
  assert.deepEqual([...SUPPORTED_PROTOCOLS], [
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
    'google-generative-ai',
  ])
  assert.deepEqual([...THINKING_LEVELS], ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual([...GEMINI_THINKING_LEVELS], ['minimal', 'low', 'medium', 'high'])
  assert.deepEqual([...SUPPORTED_THINKING_FORMATS], [
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
  assert.deepEqual([...MAX_TOKENS_FIELDS], ['max_completion_tokens', 'max_tokens'])
  assert.deepEqual([...THINKING_TOKEN_BUDGET_FIELDS], [
    'thinking_token_budget',
    'thinking_budget',
    'thinking_budget_tokens',
  ])
  assert.deepEqual([...CACHE_CONTROL_FORMATS], ['anthropic'])
  assert.deepEqual([...MODALITIES], ['text', 'image'])
})

test('presets: COMPAT_FIELDS_BY_API lists the offered fields per protocol', () => {
  assert.deepEqual(Object.keys(COMPAT_FIELDS_BY_API).sort(), Object.keys(EXPECTED_COMPAT_FIELDS).sort())
  for (const [api, fields] of Object.entries(EXPECTED_COMPAT_FIELDS)) {
    assert.deepEqual([...COMPAT_FIELDS_BY_API[api]], fields, api)
  }
})

test('presets: the five custom-provider presets are exact', () => {
  assert.equal(CUSTOM_GATEWAY_PRESETS.length, 5)
  assert.deepEqual(CUSTOM_GATEWAY_PRESETS.map(preset => preset.id), [
    'custom-relay-openai',
    'custom-openai-chat',
    'custom-openai-responses',
    'custom-anthropic',
    'custom-gemini',
  ])

  const relay = getPreset('custom-relay-openai')
  assert.equal(relay.api, 'openai-completions')
  assert.equal(relay.defaultContextWindow, 128000)
  assert.equal(relay.defaultMaxTokens, 16384)
  assert.deepEqual(relay.recommendedCompat, {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
  })
  assert.equal(relay.supportsProtocolSplit, true)

  const chat = getPreset('custom-openai-chat')
  assert.equal(chat.api, 'openai-completions')
  assert.deepEqual(chat.recommendedCompat, { supportsStore: false })

  const responses = getPreset('custom-openai-responses')
  assert.equal(responses.api, 'openai-responses')
  assert.deepEqual(responses.recommendedCompat, {})

  const anthropic = getPreset('custom-anthropic')
  assert.equal(anthropic.api, 'anthropic-messages')
  assert.equal(anthropic.defaultContextWindow, 200000)
  assert.equal(anthropic.defaultMaxTokens, 16384)
  assert.deepEqual(anthropic.recommendedCompat, {})

  const gemini = getPreset('custom-gemini')
  assert.equal(gemini.api, 'google-generative-ai')
  assert.equal(gemini.requiresApiKey, true)
  assert.equal(gemini.defaultContextWindow, 1048576)
  assert.equal(gemini.defaultMaxTokens, 65536)
  assert.deepEqual(gemini.recommendedCompat, {})

  for (const preset of CUSTOM_GATEWAY_PRESETS) {
    assert.ok(SUPPORTED_PROTOCOLS.includes(preset.api), preset.id)
    assert.ok(Number.isInteger(preset.defaultContextWindow) && preset.defaultContextWindow > 0, preset.id)
    assert.ok(Number.isInteger(preset.defaultMaxTokens) && preset.defaultMaxTokens > 0, preset.id)
    assert.deepEqual(filterCompatForApi(preset.recommendedCompat, preset.api), preset.recommendedCompat, preset.id)
  }
})

test('presets: getPreset and listPresets expose copies', () => {
  assert.deepEqual(getPreset('custom-relay-openai'), CUSTOM_GATEWAY_PRESETS[0])
  assert.equal(getPreset('no-such-preset'), undefined)
  const listed = listPresets()
  assert.equal(listed.length, 5)
  assert.deepEqual(listed, CUSTOM_GATEWAY_PRESETS)
  assert.notEqual(listed, CUSTOM_GATEWAY_PRESETS)
  listed.push({ id: 'extra' })
  assert.equal(CUSTOM_GATEWAY_PRESETS.length, 5)
})

test('presets: filterCompatForApi keeps only fields the protocol takes', () => {
  assert.deepEqual(
    filterCompatForApi({ supportsStore: false, supportsDeveloperRole: true, maxTokensField: 'max_tokens' }, 'openai-completions'),
    { supportsStore: false, supportsDeveloperRole: true, maxTokensField: 'max_tokens' },
  )
  assert.deepEqual(
    filterCompatForApi({ supportsStore: false, supportsMaxOutputTokens: true }, 'openai-responses'),
    { supportsMaxOutputTokens: true },
  )
  assert.deepEqual(
    filterCompatForApi({ supportsStore: false, supportsDeveloperRole: true }, 'anthropic-messages'),
    {},
  )
  assert.deepEqual(
    filterCompatForApi({ supportsStore: null, supportsDeveloperRole: undefined, supportsReasoningEffort: false }, 'openai-completions'),
    { supportsReasoningEffort: false },
  )
  assert.deepEqual(filterCompatForApi({ chatTemplateKwargs: {} }, 'openai-completions'), {})
  assert.deepEqual(
    filterCompatForApi({ chatTemplateKwargs: { enable_thinking: true } }, 'openai-completions'),
    { chatTemplateKwargs: { enable_thinking: true } },
  )
  assert.deepEqual(filterCompatForApi({ supportsStore: false }, 'google-generative-ai'), {})
  assert.deepEqual(filterCompatForApi({ supportsStore: false }, 'not-a-protocol'), {})
  assert.deepEqual(filterCompatForApi(null, 'openai-completions'), {})

  const input = { supportsStore: false, bogus: 1 }
  filterCompatForApi(input, 'openai-completions')
  assert.deepEqual(input, { supportsStore: false, bogus: 1 })
})

test('presets: normalizeReasoningEffortsForApi handles false, empty, and invalid levels', () => {
  assert.equal(normalizeReasoningEffortsForApi(false, 'openai-completions'), false)
  assert.equal(normalizeReasoningEffortsForApi(undefined, 'openai-completions'), undefined)
  assert.equal(normalizeReasoningEffortsForApi(null, 'openai-completions'), undefined)
  assert.deepEqual(normalizeReasoningEffortsForApi({}, 'openai-completions'), undefined)
  assert.equal(normalizeReasoningEffortsForApi([], 'openai-completions'), undefined)
  assert.equal(normalizeReasoningEffortsForApi('high', 'openai-completions'), undefined)
  assert.equal(normalizeReasoningEffortsForApi({ off: null }, 'openai-completions'), undefined)
  assert.deepEqual(
    normalizeReasoningEffortsForApi({ off: null, low: 'low', high: 'high' }, 'openai-completions'),
    { off: null, low: 'low', high: 'high' },
  )
  assert.deepEqual(normalizeReasoningEffortsForApi({ off: '', low: 'low' }, 'openai-completions'), { low: 'low' })
  assert.deepEqual(normalizeReasoningEffortsForApi({ low: '', high: 'high' }, 'openai-completions'), { high: 'high' })
  assert.deepEqual(normalizeReasoningEffortsForApi({ low: 42, high: 'high' }, 'openai-completions'), { high: 'high' })
  assert.deepEqual(normalizeReasoningEffortsForApi({ turbo: 'x', high: 'high' }, 'openai-completions'), { high: 'high' })
  assert.equal(normalizeReasoningEffortsForApi({ turbo: 'x' }, 'openai-completions'), undefined)
  assert.deepEqual(
    normalizeReasoningEffortsForApi({ high: 'high', low: 'low' }, 'openai-completions'),
    { low: 'low', high: 'high' },
  )
})

test('presets: normalizeReasoningEffortsForApi clamps Gemini levels', () => {
  assert.deepEqual(
    normalizeReasoningEffortsForApi(
      { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
      'google-generative-ai',
    ),
    { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
  )
  assert.equal(normalizeReasoningEffortsForApi({ off: null }, 'google-generative-ai'), undefined)
  assert.equal(normalizeReasoningEffortsForApi({ xhigh: 'xhigh' }, 'google-generative-ai'), undefined)
  assert.deepEqual(
    normalizeReasoningEffortsForApi({ minimal: '', low: 'low' }, 'google-generative-ai'),
    { low: 'low' },
  )
})

test('presets: validateModelProfile accepts a complete model', () => {
  const model = {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    input: ['text', 'image'],
    reasoningEfforts: { off: null, low: 'low', high: 'high' },
    compat: { thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true },
  }
  assert.equal(validateModelProfile(model, 'openai-completions'), model)
  assert.equal(validateModelProfile({ id: 'bare-model' }, 'anthropic-messages').id, 'bare-model')
  assert.equal(validateModelProfile({ id: 'no-reasoning', reasoningEfforts: false }, 'openai-completions').id, 'no-reasoning')
  assert.equal(
    validateModelProfile({ id: 'gemini-model', reasoningEfforts: { minimal: 'minimal', low: 'low' } }, 'google-generative-ai').id,
    'gemini-model',
  )
  assert.equal(validateModelProfile({ id: 'compat-empty', compat: {} }, 'google-generative-ai').id, 'compat-empty')
  assert.equal(validateModelProfile({ id: 'priority', compat: { vllmPriority: 5 } }, 'openai-completions').id, 'priority')
})

test('presets: validateModelProfile rejects invalid ids and capacities', () => {
  const invalid = [
    { model: null },
    { model: 'model' },
    { model: { id: '' } },
    { model: { id: '   ' } },
    { model: { id: ' padded' } },
    { model: { id: 'model', contextWindow: 0 } },
    { model: { id: 'model', contextWindow: -1 } },
    { model: { id: 'model', contextWindow: 1.5 } },
    { model: { id: 'model', contextWindow: '128000' } },
    { model: { id: 'model', maxTokens: 0 } },
    { model: { id: 'model', maxTokens: 1.5 } },
    { model: { id: 'model', name: '' } },
  ]
  for (const { model } of invalid) assertThrowsCode(() => validateModelProfile(model, 'openai-completions'), 'invalid-model-profile', JSON.stringify(model))
})

test('presets: validateModelProfile rejects invalid input modalities', () => {
  for (const input of [[], ['audio'], ['text', 'text'], 'text', null]) {
    assertThrowsCode(
      () => validateModelProfile({ id: 'model', input }, 'openai-completions'),
      'invalid-model-profile',
      JSON.stringify(input),
    )
  }
})

test('presets: validateModelProfile rejects invalid reasoningEfforts', () => {
  const cases = [
    'high',
    {},
    { off: null },
    { low: '' },
    { high: 42 },
    { turbo: 'x' },
    { off: 42, low: 'low' },
  ]
  for (const reasoningEfforts of cases) {
    assertThrowsCode(
      () => validateModelProfile({ id: 'model', reasoningEfforts }, 'openai-completions'),
      'invalid-model-profile',
      JSON.stringify(reasoningEfforts),
    )
  }
  for (const reasoningEfforts of [{ off: null }, { minimal: '' }, { xhigh: 'xhigh' }, { turbo: 'x' }]) {
    assertThrowsCode(
      () => validateModelProfile({ id: 'model', reasoningEfforts }, 'google-generative-ai'),
      'invalid-model-profile',
      `gemini ${JSON.stringify(reasoningEfforts)}`,
    )
  }
})

test('presets: validateModelProfile rejects invalid compat', () => {
  const cases = [
    ['openai-completions', 'nope'],
    ['openai-completions', { supportsStore: null }],
    ['openai-completions', { supportsStore: 'yes' }],
    ['openai-completions', { maxTokensField: 'bogus' }],
    ['openai-completions', { thinkingFormat: 'bogus' }],
    ['openai-completions', { thinkingTokenBudgetField: 'bogus' }],
    ['openai-completions', { cacheControlFormat: 'bogus' }],
    ['openai-completions', { chatTemplateKwargs: 'nope' }],
    ['openai-completions', { vllmPriority: 'high' }],
    ['anthropic-messages', { supportsStore: false }],
    ['openai-responses', { supportsStore: false }],
    ['google-generative-ai', { supportsStore: false }],
  ]
  for (const [api, compat] of cases) {
    assertThrowsCode(
      () => validateModelProfile({ id: 'model', compat }, api),
      'invalid-model-profile',
      `${api} ${JSON.stringify(compat)}`,
    )
  }
})

test('presets: validateProviderProfile accepts a complete provider', () => {
  const profile = {
    name: 'My relay',
    baseURL: 'https://api.relay.example/v1',
    api: 'openai-completions',
    models: [
      {
        id: 'deepseek-v4.1-flash',
        contextWindow: 1048576,
        maxTokens: 65536,
        input: ['text', 'image'],
        reasoningEfforts: { off: null, low: 'low' },
        compat: { thinkingFormat: 'deepseek' },
      },
      { id: 'deepseek-v4-pro' },
    ],
    apiKeyEnv: 'MY_RELAY_API_KEY',
    headers: { 'x-relay-tenant': 'xiaoxing' },
  }
  assert.equal(validateProviderProfile('my-relay', profile), profile)
  assert.equal(
    validateProviderProfile('local-relay', {
      baseURL: 'http://localhost:8080/v1',
      api: 'anthropic-messages',
      models: [{ id: 'claude-sonnet-4-5' }],
    }).api,
    'anthropic-messages',
  )
})

test('presets: validateProviderProfile rejects invalid provider ids', () => {
  const profile = { baseURL: 'https://api.example/v1', api: 'openai-completions', models: [{ id: 'model' }] }
  assertThrowsCode(() => validateProviderProfile('Bad Id', profile), 'invalid-provider-id', 'Bad Id')
  assertThrowsCode(() => validateProviderProfile('deepseek', profile), 'reserved-native-provider', 'deepseek')
})

test('presets: validateProviderProfile rejects invalid base URLs', () => {
  const invalid = [
    '',
    '   ',
    ' https://api.example/v1 ',
    'not a url',
    'ftp://api.example/v1',
    'https://user:pass@api.example/v1',
    'https://api.example/v1?key=1',
    'https://api.example/v1#frag',
    'https://',
    null,
    42,
  ]
  for (const baseURL of invalid) {
    assertThrowsCode(
      () => validateProviderProfile('my-relay', { baseURL, api: 'openai-completions', models: [{ id: 'model' }] }),
      'invalid-provider-profile',
      JSON.stringify(baseURL),
    )
  }
})

test('presets: validateProviderProfile rejects invalid api, models, apiKeyEnv, and headers', () => {
  const base = { baseURL: 'https://api.example/v1', api: 'openai-completions', models: [{ id: 'model' }] }
  assertThrowsCode(() => validateProviderProfile('my-relay', { ...base, api: 'openai-chat' }), 'invalid-provider-profile', 'api')
  assertThrowsCode(() => validateProviderProfile('my-relay', { ...base, api: undefined }), 'invalid-provider-profile', 'api missing')
  assertThrowsCode(() => validateProviderProfile('my-relay', { ...base, models: undefined }), 'invalid-provider-profile', 'models missing')
  assertThrowsCode(() => validateProviderProfile('my-relay', { ...base, models: [] }), 'invalid-provider-profile', 'models empty')
  assertThrowsCode(() => validateProviderProfile('my-relay', { ...base, models: 'model' }), 'invalid-provider-profile', 'models type')
  assertThrowsCode(
    () => validateProviderProfile('my-relay', { ...base, models: [{ id: 'model' }, { id: 'model' }] }),
    'invalid-provider-profile',
    'duplicate models',
  )
  assertThrowsCode(
    () => validateProviderProfile('my-relay', { ...base, models: [{ id: '' }] }),
    'invalid-model-profile',
    'invalid model',
  )
  assertThrowsCode(() => validateProviderProfile('my-relay', { ...base, apiKeyEnv: 'my key' }), 'invalid-credential-ref', 'apiKeyEnv')
  assertThrowsCode(() => validateProviderProfile('my-relay', { ...base, apiKeyEnv: 42 }), 'invalid-credential-ref', 'apiKeyEnv type')
  assertThrowsCode(() => validateProviderProfile('my-relay', { ...base, headers: 'x' }), 'invalid-provider-profile', 'headers type')
  assertThrowsCode(() => validateProviderProfile('my-relay', { ...base, headers: [] }), 'invalid-provider-profile', 'headers array')
  assertThrowsCode(
    () => validateProviderProfile('my-relay', { ...base, headers: { 'bad header': 'x' } }),
    'invalid-provider-profile',
    'invalid header name',
  )
  assertThrowsCode(
    () => validateProviderProfile('my-relay', { ...base, headers: { 'x-header': 1 } }),
    'invalid-provider-profile',
    'invalid header value',
  )
  assertThrowsCode(() => validateProviderProfile('my-relay', { ...base, name: '' }), 'invalid-provider-profile', 'name')
})

test('canon: canonModelId strips vendor prefixes, dates, and routing suffixes', () => {
  assert.deepEqual(canonModelId('openai/gpt-4o-2024-08-06'), {
    raw: 'openai/gpt-4o-2024-08-06',
    strippedVendor: 'gpt-4o-2024-08-06',
    withoutDate: 'gpt-4o',
    normalized: 'gpt-4o',
    dotHyphenNormalized: 'gpt-4o',
  })
  assert.deepEqual(canonModelId('anthropic/claude-3-5-sonnet-20241022'), {
    raw: 'anthropic/claude-3-5-sonnet-20241022',
    strippedVendor: 'claude-3-5-sonnet-20241022',
    withoutDate: 'claude-3-5-sonnet',
    normalized: 'claude-3-5-sonnet',
    dotHyphenNormalized: 'claude-3-5-sonnet',
  })
  assert.deepEqual(canonModelId('deepseek-ai/DeepSeek-V4.1-Flash@20250219'), {
    raw: 'deepseek-ai/DeepSeek-V4.1-Flash@20250219',
    strippedVendor: 'DeepSeek-V4.1-Flash@20250219',
    withoutDate: 'DeepSeek-V4.1-Flash',
    normalized: 'deepseek-v4.1-flash',
    dotHyphenNormalized: 'deepseek-v4-1-flash',
  })
  assert.equal(canonModelId('deepseek-r1:free').withoutDate, 'deepseek-r1')
  assert.equal(canonModelId('deepseek-v3.1:thinking').withoutDate, 'deepseek-v3.1')
  assert.equal(canonModelId('deepseek-r1-0528').withoutDate, 'deepseek-r1')
  assert.equal(canonModelId('deepseek-v3-0324').withoutDate, 'deepseek-v3')
  assert.equal(canonModelId('gpt-4-0613').withoutDate, 'gpt-4')
  assert.equal(canonModelId('model-1234').withoutDate, 'model-1234')
  assert.equal(canonModelId('Pro/openai/gpt-4o').normalized, 'gpt-4o')
  assert.equal(canonModelId('vertex/gemini-2.5-pro').normalized, 'gemini-2.5-pro')
  assert.equal(canonModelId('google-vertex/gemini-4-neon').normalized, 'gemini-4-neon')
  assert.equal(canonModelId('bedrock/claude-sonnet-4-5').normalized, 'claude-sonnet-4-5')
  assert.equal(canonModelId('azure/gpt-5.4').normalized, 'gpt-5.4')
  assert.equal(canonModelId('us.anthropic.claude-sonnet-4-5').strippedVendor, 'anthropic.claude-sonnet-4-5')
  assert.equal(canonModelId('~openai/gpt-astra-latest').strippedVendor, 'gpt-astra-latest')
  assert.equal(canonModelId('~anthropic/claude-fable-latest').strippedVendor, 'claude-fable-latest')
  assert.equal(
    canonModelId('accounts/fireworks/models/deepseek-v4p1-flash').strippedVendor,
    'deepseek-v4p1-flash',
  )
  assert.equal(canonModelId('accounts/fireworks/models/deepseek-v4p1-flash').normalized, 'deepseek-v4.1-flash')
  assert.equal(canonModelId('accounts/fireworks/routers/glm-5p3-fast').normalized, 'glm-5.3-fast')
  assert.equal(canonModelId('claude-fable-5:batch').withoutDate, 'claude-fable-5')
  assert.equal(canonModelId('qwen3p8-max').normalized, 'qwen3.8-max')
  assert.equal(canonModelId('zai-glm-5-2').normalized, 'zai-glm-5-2')
  assert.equal(canonModelId(42).raw, '42')
  assert.equal(canonModelId(null).raw, '')
})

test('canon: canonModelId preserves parameter sizes and tier words', () => {
  const sizes = [
    ['qwen2.5-72b', 'qwen2.5-72b'],
    ['qwen2.5-235b', 'qwen2.5-235b'],
    ['qwen3-30b-a3b', 'qwen3-30b-a3b'],
    ['llama-3.1-405b', 'llama-3.1-405b'],
    ['deepseek-v4-flash', 'deepseek-v4-flash'],
    ['gpt-4o-mini', 'gpt-4o-mini'],
    ['claude-3-5-sonnet', 'claude-3-5-sonnet'],
    ['gemini-2.5-pro', 'gemini-2.5-pro'],
    ['qwen3-235b-a22b', 'qwen3-235b-a22b'],
  ]
  for (const [input, expected] of sizes) assert.equal(canonModelId(input).normalized, expected, input)
  assert.notEqual(canonModelId('qwen2.5-30b').normalized, canonModelId('qwen2.5-235b').normalized)
})

test('canon: candidateLookupKeys offers both dot and hyphen version spellings', () => {
  const dotted = candidateLookupKeys('deepseek-v4.1-flash')
  assert.equal(dotted[0], 'deepseek-v4.1-flash')
  assert.ok(dotted.includes('deepseek-v4-1-flash'))
  assert.equal(new Set(dotted).size, dotted.length)

  const hyphenated = candidateLookupKeys('deepseek-v4-1-flash')
  assert.ok(hyphenated.includes('deepseek-v4.1-flash'))
  assert.equal(new Set(hyphenated).size, hyphenated.length)

  const claude = candidateLookupKeys('claude-3-5-sonnet')
  assert.ok(claude.includes('claude-3.5-sonnet'))

  const qwen = candidateLookupKeys('Qwen/Qwen3.5-235B-A22B')
  assert.ok(qwen.includes('Qwen/Qwen3.5-235B-A22B'))
  assert.ok(qwen.includes('qwen3.5-235b-a22b'))
  assert.ok(qwen.includes('qwen3-5-235b-a22b'))

  const dated = candidateLookupKeys('openai/gpt-4o-2024-08-06')
  assert.ok(dated.includes('gpt-4o'))
  assert.ok(dated.includes('openai/gpt-4o-2024-08-06'))

  const encoded = candidateLookupKeys('deepseek-v4p1-flash')
  assert.ok(encoded.includes('deepseek-v4p1-flash'))
  assert.ok(encoded.includes('deepseek-v4.1-flash'))
  assert.ok(encoded.includes('deepseek-v4-1-flash'))

  assert.deepEqual(candidateLookupKeys(null), [])
  assert.deepEqual(candidateLookupKeys(''), [])
})

test('canon: isLikelyNonChatModel detects non-chat families', () => {
  const cases = [
    ['text-embedding-3-large', 'embedding'],
    ['bge-reranker-v2-m3', 'rerank'],
    ['whisper-1', 'speech'],
    ['tts-1', 'speech'],
    ['gpt-4o-transcribe', 'speech'],
    ['dall-e-3', 'image'],
    ['flux.1-pro', 'image'],
    ['imagen-3.0-generate', 'image'],
    ['sora-2', 'video'],
    ['text-moderation-latest', 'moderation'],
    ['veo-3', 'video'],
    ['wanx2.1-t2v', 'video'],
    ['seedance-1-0-pro', 'video'],
    ['gemini-2.5-flash-image', 'image'],
    ['seedream-4.5', 'image'],
  ]
  for (const [id, category] of cases) assert.deepEqual(isLikelyNonChatModel(id), { nonChat: true, category }, id)
  for (const id of ['gpt-4o', 'deepseek-chat', 'claude-sonnet-4-5', '']) {
    assert.deepEqual(isLikelyNonChatModel(id), { nonChat: false, category: null }, id)
  }
  assert.deepEqual(isLikelyNonChatModel(42), { nonChat: false, category: null })
})

test('canon: deriveVendorGroup classifies every vendor family', () => {
  const cases = [
    ['deepseek-v4.1-flash', 'DeepSeek'],
    ['deepseek-ai/deepseek-v3', 'DeepSeek'],
    ['claude-sonnet-4-5', 'Anthropic'],
    ['anthropic/claude-haiku-4-5', 'Anthropic'],
    ['gpt-4o', 'OpenAI'],
    ['o3-mini', 'OpenAI'],
    ['openai/o3-mini', 'OpenAI'],
    ['gpt-oss-120b', 'OpenAI'],
    ['gemini-2.5-flash', 'Google'],
    ['gemma-3-27b', 'Google'],
    ['glm-5', 'Zhipu GLM'],
    ['zai-org/glm-5', 'Zhipu GLM'],
    ['qwen3-235b-a22b', 'Qwen'],
    ['qwq-32b', 'Qwen'],
    ['kimi-k2', 'Moonshot'],
    ['minimax-m2', 'MiniMax'],
    ['mistral-large-latest', 'Mistral'],
    ['pixtral-12b', 'Mistral'],
    ['llama-4-scout', 'Meta Llama'],
    ['meta-llama/llama-3.3-70b', 'Meta Llama'],
    ['grok-4', 'xAI'],
    ['x-ai/grok-4', 'xAI'],
    ['MiniMaxAI/MiniMax-M3', 'MiniMax'],
    ['accounts/fireworks/models/deepseek-v4p1-flash', 'DeepSeek'],
    ['~anthropic/claude-fable-latest', 'Anthropic'],
    ['totally-unknown-model', 'Other'],
    ['', 'Other'],
  ]
  for (const [id, group] of cases) assert.equal(deriveVendorGroup(id), group, id)
  assert.ok(VENDOR_GROUPS.has(deriveVendorGroup(null)))
})

test('family rules: JSON is valid and every rule is well formed', () => {
  assert.equal(FAMILY_RULES.schemaVersion, 1)
  assert.ok(Array.isArray(FAMILY_RULES.rules))
  assert.ok(FAMILY_RULES.rules.length >= 50, `expected at least 50 rules, got ${FAMILY_RULES.rules.length}`)

  const ids = new Set()
  for (const rule of FAMILY_RULES.rules) {
    assert.equal(typeof rule.id, 'string')
    assert.ok(rule.id.length > 0)
    assert.ok(!ids.has(rule.id), `duplicate rule id ${rule.id}`)
    ids.add(rule.id)

    assert.equal(typeof rule.match, 'string')
    assert.ok(rule.match.startsWith('^'), `${rule.id}: match must be anchored`)
    assert.doesNotThrow(() => new RegExp(rule.match, 'iu'), `${rule.id}: match must compile`)

    assert.equal(typeof rule.family, 'string')
    assert.ok(VENDOR_GROUPS.has(rule.vendorGroup), `${rule.id}: vendorGroup ${rule.vendorGroup}`)
    assert.ok(Number.isInteger(rule.contextWindow) && rule.contextWindow > 0, `${rule.id}: contextWindow`)
    assert.ok(Number.isInteger(rule.maxTokens) && rule.maxTokens > 0, `${rule.id}: maxTokens`)

    assert.ok(Array.isArray(rule.input) && rule.input.length > 0, `${rule.id}: input`)
    for (const modality of rule.input) assert.ok(MODALITIES.includes(modality), `${rule.id}: modality ${modality}`)

    if (rule.efforts !== undefined) {
      assert.ok(Array.isArray(rule.efforts) && rule.efforts.length > 0, `${rule.id}: efforts`)
      for (const level of rule.efforts) assert.ok(THINKING_LEVELS.includes(level), `${rule.id}: level ${level}`)
      assert.equal(typeof rule.allowOff, 'boolean', `${rule.id}: allowOff`)
      assert.equal(rule.efforts.includes('off'), rule.allowOff, `${rule.id}: allowOff must match off`)
    } else {
      assert.equal(rule.allowOff, undefined, `${rule.id}: allowOff without efforts`)
    }

    if (rule.compat !== undefined) {
      for (const [field, value] of Object.entries(rule.compat)) {
        assert.ok(ALL_COMPAT_FIELDS.has(field), `${rule.id}: compat field ${field}`)
        if (field === 'thinkingFormat') assert.ok(SUPPORTED_THINKING_FORMATS.includes(value), `${rule.id}: thinkingFormat`)
        if (field === 'requiresReasoningContentOnAssistantMessages') assert.equal(typeof value, 'boolean')
      }
    }
    if (rule.capabilities !== undefined) {
      for (const [field, value] of Object.entries(rule.capabilities)) {
        assert.equal(field, 'supportsDeveloperRole', `${rule.id}: capability field ${field}`)
        assert.equal(typeof value, 'boolean')
      }
    }
    if (rule.notes !== undefined) assert.equal(typeof rule.notes, 'string')
  }
})

test('family rules: rules are ordered from specific to general', () => {
  const indexOf = id => FAMILY_RULES.rules.findIndex(rule => rule.id === id)
  const ordered = [
    ['deepseek-v4-1-flash', 'deepseek-flash'],
    ['deepseek-flash', 'deepseek-v4'],
    ['deepseek-reasoner', 'deepseek-general'],
    ['claude-sonnet-4-6-plus', 'claude-sonnet-4'],
    ['claude-opus-4-6-plus', 'claude-opus-4'],
    ['claude-3-5', 'claude-general'],
    ['gpt-oss', 'openai-general'],
    ['gemini-2-0', 'gemini-general'],
    ['glm-vision', 'glm-5'],
    ['glm-5-3', 'glm-5'],
    ['glm-5-2', 'glm-5'],
    ['glm-4-5', 'glm-general'],
    ['qwen3-5', 'qwen3'],
    ['qwen3-vl-omni', 'qwen3'],
    ['qwen-vl', 'qwen2-5'],
    ['qwen2-5', 'qwen-general'],
    ['kimi-k2-thinking', 'kimi-k2'],
    ['kimi-k2-5', 'kimi-k2'],
    ['kimi-k2', 'kimi-general'],
    ['minimax-m1', 'minimax-general'],
    ['mistral-large', 'mistral-general'],
    ['grok-3', 'grok-general'],
    ['llama-3-2-vision', 'llama-3-2'],
    ['llama-3-2', 'llama-3-general'],
  ]
  for (const [specific, general] of ordered) {
    assert.ok(indexOf(specific) >= 0, `${specific} exists`)
    assert.ok(indexOf(general) >= 0, `${general} exists`)
    assert.ok(indexOf(specific) < indexOf(general), `${specific} must precede ${general}`)
  }
})

test('family rules: first match resolves canonical ids to the expected family rule', () => {
  const expected = new Map([
    ['deepseek-v4.1-flash', 'deepseek-v4-1-flash'],
    ['deepseek-v4-flash', 'deepseek-flash'],
    ['deepseek-v4-pro', 'deepseek-v4'],
    ['deepseek-r1', 'deepseek-r1'],
    ['deepseek-v3', 'deepseek-v3'],
    ['deepseek-chat', 'deepseek-chat'],
    ['deepseek-reasoner', 'deepseek-reasoner'],
    ['claude-sonnet-5', 'claude-sonnet-5'],
    ['claude-opus-5', 'claude-opus-5'],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6-plus'],
    ['claude-opus-4-6', 'claude-opus-4-6-plus'],
    ['claude-opus-4-5', 'claude-opus-4'],
    ['claude-sonnet-4-5', 'claude-sonnet-4'],
    ['claude-haiku-4-5', 'claude-haiku-4'],
    ['claude-3-7-sonnet', 'claude-3-7-sonnet'],
    ['claude-3-5-sonnet', 'claude-3-5'],
    ['gpt-6', 'gpt-6'],
    ['gpt-5.1', 'gpt-5'],
    ['gpt-4.1', 'gpt-4-1'],
    ['gpt-4o', 'gpt-4o'],
    ['o3-mini', 'o3'],
    ['o4-mini', 'o4'],
    ['o1', 'o1'],
    ['gpt-oss-120b', 'gpt-oss'],
    ['gemini-4-hydrogen', 'gemini-4-hydrogen'],
    ['gemini-4-argon', 'gemini-4'],
    ['gemini-3-flash', 'gemini-3'],
    ['gemini-2.5-flash', 'gemini-2-5'],
    ['gemini-2.0-flash', 'gemini-2-0'],
    ['glm-5.3', 'glm-5-3'],
    ['glm-5.2', 'glm-5-2'],
    ['glm-5', 'glm-5'],
    ['glm-4.7', 'glm-4-7'],
    ['glm-4.6', 'glm-4-6'],
    ['glm-4.5', 'glm-4-5'],
    ['glm-4.6v', 'glm-vision'],
    ['qwen3.5', 'qwen3-5'],
    ['qwen3-vl-235b', 'qwen3-vl-omni'],
    ['qwen3-235b-a22b', 'qwen3'],
    ['qwq-32b', 'qwq'],
    ['qwen2.5-vl-72b', 'qwen-vl'],
    ['qwen2.5-72b', 'qwen2-5'],
    ['kimi-k2-thinking', 'kimi-k2-thinking'],
    ['kimi-k2.5', 'kimi-k2-5'],
    ['kimi-k2', 'kimi-k2'],
    ['moonshot-v1-128k', 'moonshot-v1'],
    ['minimax-m2.1', 'minimax-m2'],
    ['minimax-m1', 'minimax-m1'],
    ['pixtral-12b', 'pixtral'],
    ['magistral-medium', 'magistral'],
    ['mistral-large-latest', 'mistral-large'],
    ['codestral-2501', 'codestral'],
    ['grok-4', 'grok-4'],
    ['grok-3', 'grok-3'],
    ['llama-4-scout', 'llama-4'],
    ['llama-3.3-70b', 'llama-3-3'],
    ['llama-3.2-11b-vision-instruct', 'llama-3-2-vision'],
    ['llama-3.2-1b', 'llama-3-2'],
    ['llama-3.1-8b-instant', 'llama-3-general'],
    ['claude-fable-5', 'claude-general'],
    ['claude-haiku-5-5', 'claude-general'],
    ['gemini-flash-latest', 'gemini-general'],
    ['gemma-4-26b-a4b-it', 'gemma-general'],
    ['qwen-plus', 'qwen-general'],
    ['qwen-3.8-27b', 'qwen3'],
    ['mistral-medium-3.5', 'mistral-general'],
    ['minimax-m3', 'minimax-general'],
    ['kimi-k3', 'kimi-general'],
    ['glm-latest', 'glm-general'],
    ['zai-glm-5-2', 'glm-general'],
    ['grok-build-0.1', 'grok-general'],
    ['gpt-4-turbo', 'openai-general'],
    ['deepseek-pro-latest', 'deepseek-general'],
    ['accounts/fireworks/models/deepseek-v4p1-flash', 'deepseek-v4-1-flash'],
    ['accounts/fireworks/models/glm-5p3-flash', 'glm-vision'],
    ['accounts/fireworks/routers/kimi-k3-fast', 'kimi-general'],
    ['~anthropic/claude-fable-5', 'claude-general'],
    ['~openai/gpt-astra-latest', 'openai-general'],
    ['~z-ai/glm-latest', 'glm-general'],
    ['~x-ai/grok-latest', 'grok-general'],
    ['~google/gemini-flash-latest', 'gemini-general'],
    ['~deepseek/deepseek-flash-latest', 'deepseek-flash'],
    ['alibaba/qwen-3-14b', 'qwen3'],
    ['nvidia/llama-3.1-nemotron-70b-instruct', 'llama-3-general'],
    ['moonshotai/Kimi-K3', 'kimi-general'],
    ['meta/llama-3.1-70b', 'llama-3-general'],
    ['mistralai/devstral-2512', 'mistral-general'],
    ['open-mistral-7b', 'mistral-general'],
    ['labs-devstral-small-2512', 'mistral-general'],
    ['MiniMaxAI/MiniMax-M3', 'minimax-general'],
  ])
  for (const [id, ruleId] of expected) {
    const rule = firstMatchingRule(id)
    assert.ok(rule !== undefined, `${id}: no rule matched`)
    assert.equal(rule.id, ruleId, `${id}: matched ${rule.id}`)
  }
  assert.equal(firstMatchingRule('totally-unknown-model'), undefined)
})

test('family rules: dot and hyphen spellings resolve to the same rule', () => {
  const pairs = [
    ['deepseek-v4.1-flash', 'deepseek-v4-1-flash'],
    ['claude-3.5-sonnet', 'claude-3-5-sonnet'],
    ['claude-3.7-sonnet', 'claude-3-7-sonnet'],
    ['gemini-2.5-flash', 'gemini-2-5-flash'],
    ['gemini-2.0-flash', 'gemini-2-0-flash'],
    ['glm-4.5', 'glm-4-5'],
    ['qwen3.5', 'qwen3-5'],
    ['qwen2.5-72b', 'qwen2-5-72b'],
    ['llama-3.3-70b', 'llama-3-3-70b'],
    ['gpt-4.1', 'gpt-4-1'],
  ]
  for (const [dotted, hyphenated] of pairs) {
    const dottedRule = firstMatchingRule(dotted)
    const hyphenatedRule = firstMatchingRule(hyphenated)
    assert.ok(dottedRule !== undefined, dotted)
    assert.ok(hyphenatedRule !== undefined, hyphenated)
    assert.equal(dottedRule.id, hyphenatedRule.id, `${dotted} vs ${hyphenated}`)
  }
})

test('family rules: DeepSeek rules carry the DSH dispatch hints', () => {
  const flash = FAMILY_RULES.rules.find(rule => rule.id === 'deepseek-v4-1-flash')
  assert.equal(flash.contextWindow, 1048576)
  assert.equal(flash.maxTokens, 65536)
  assert.deepEqual(flash.input, ['text', 'image'])
  assert.equal(flash.compat.thinkingFormat, 'deepseek')
  assert.equal(flash.compat.requiresReasoningContentOnAssistantMessages, true)
  assert.equal(flash.allowOff, true)
  assert.deepEqual(flash.efforts, ['off', 'low', 'high', 'max'])

  const v4 = FAMILY_RULES.rules.find(rule => rule.id === 'deepseek-v4')
  assert.equal(v4.contextWindow, 1048576)
  assert.equal(v4.compat.thinkingFormat, 'deepseek')

  const r1 = FAMILY_RULES.rules.find(rule => rule.id === 'deepseek-r1')
  assert.equal(r1.contextWindow, 131072)
  assert.equal(r1.allowOff, false)
  assert.ok(!r1.efforts.includes('off'))

  const v3 = FAMILY_RULES.rules.find(rule => rule.id === 'deepseek-v3')
  assert.equal(v3.contextWindow, 131072)
})

test('family rules: Claude rules use 200K context, vision, and adaptive efforts', () => {
  const claudeRules = FAMILY_RULES.rules.filter(rule => rule.family === 'claude')
  assert.ok(claudeRules.length >= 8)
  for (const rule of claudeRules) {
    assert.equal(rule.contextWindow, 200000, rule.id)
    assert.deepEqual(rule.input, ['text', 'image'], rule.id)
    assert.ok([64000, 16384, 8192].includes(rule.maxTokens), `${rule.id}: maxTokens ${rule.maxTokens}`)
  }
  for (const id of ['claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-4-6-plus', 'claude-opus-4-6-plus']) {
    const rule = FAMILY_RULES.rules.find(candidate => candidate.id === id)
    assert.ok(rule.efforts.includes('xhigh'), id)
    assert.ok(rule.efforts.includes('max'), id)
  }
  for (const id of ['claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4', 'claude-3-7-sonnet']) {
    const rule = FAMILY_RULES.rules.find(candidate => candidate.id === id)
    assert.deepEqual(rule.efforts, ['off', 'low', 'medium', 'high'], id)
  }
  assert.equal(FAMILY_RULES.rules.find(rule => rule.id === 'claude-3-5').efforts, undefined)
})

test('family rules: OpenAI rules use accurate contexts and capability hints', () => {
  const byId = id => FAMILY_RULES.rules.find(rule => rule.id === id)
  assert.equal(byId('gpt-6').contextWindow, 400000)
  assert.equal(byId('gpt-5').contextWindow, 400000)
  assert.equal(byId('gpt-4-1').contextWindow, 1047576)
  assert.equal(byId('gpt-4o').contextWindow, 128000)
  assert.equal(byId('o3').contextWindow, 200000)
  assert.equal(byId('o4').contextWindow, 200000)
  assert.equal(byId('o1').contextWindow, 200000)
  for (const id of ['gpt-6', 'gpt-5', 'o3', 'o4', 'o1']) {
    assert.equal(byId(id).capabilities.supportsDeveloperRole, true, id)
    assert.equal(byId(id).compat.thinkingFormat, 'openai', id)
  }
  assert.deepEqual(byId('gpt-5').input, ['text', 'image'])
  assert.deepEqual(byId('o3').input, ['text', 'image'])
  assert.deepEqual(byId('gpt-oss').input, ['text'])
})

test('family rules: Gemini rules use 1M context and note the adapter clamp', () => {
  const geminiRules = FAMILY_RULES.rules.filter(rule => rule.family === 'gemini')
  assert.ok(geminiRules.length >= 5)
  for (const rule of geminiRules) {
    assert.equal(rule.contextWindow, 1048576, rule.id)
    assert.equal(rule.maxTokens, 65536, rule.id)
    assert.deepEqual(rule.input, ['text', 'image'], rule.id)
    assert.ok(rule.notes.includes('clamp'), rule.id)
  }
  const hydrogen = FAMILY_RULES.rules.find(rule => rule.id === 'gemini-4-hydrogen')
  assert.deepEqual(hydrogen.efforts, ['off', 'low', 'medium', 'high', 'xhigh'])
  const gemini4 = FAMILY_RULES.rules.find(rule => rule.id === 'gemini-4')
  assert.deepEqual(gemini4.efforts, ['off', 'minimal', 'low', 'medium', 'high'])
})

test('family rules: GLM and Qwen rules carry their thinking formats', () => {
  for (const rule of FAMILY_RULES.rules.filter(candidate => candidate.family === 'glm')) {
    assert.equal(rule.compat.thinkingFormat, 'zai', rule.id)
  }
  assert.deepEqual(FAMILY_RULES.rules.find(rule => rule.id === 'glm-vision').input, ['text', 'image'])
  assert.equal(FAMILY_RULES.rules.find(rule => rule.id === 'glm-4-5').contextWindow, 128000)
  assert.equal(FAMILY_RULES.rules.find(rule => rule.id === 'glm-5').contextWindow, 200000)

  for (const rule of FAMILY_RULES.rules.filter(candidate => candidate.family === 'qwen' && candidate.compat !== undefined)) {
    assert.equal(rule.compat.thinkingFormat, 'qwen', rule.id)
  }
  assert.deepEqual(FAMILY_RULES.rules.find(rule => rule.id === 'qwen3-5').input, ['text', 'image'])
  assert.equal(FAMILY_RULES.rules.find(rule => rule.id === 'qwen3-5').contextWindow, 262144)
  assert.equal(FAMILY_RULES.rules.find(rule => rule.id === 'qwen3').contextWindow, 131072)
})

test('family rules: vendor groups agree with deriveVendorGroup', () => {
  const samples = {
    deepseek: 'deepseek-v4.1-flash',
    claude: 'claude-sonnet-4-5',
    openai: 'gpt-4o',
    gemini: 'gemini-2.5-flash',
    glm: 'glm-5',
    qwen: 'qwen3-235b-a22b',
    kimi: 'kimi-k2',
    minimax: 'minimax-m2',
    mistral: 'mistral-large-latest',
    grok: 'grok-4',
    llama: 'llama-4-scout',
  }
  for (const [family, sample] of Object.entries(samples)) {
    const rule = firstMatchingRule(sample)
    assert.ok(rule !== undefined, family)
    assert.equal(rule.family, family, sample)
    assert.equal(rule.vendorGroup, deriveVendorGroup(sample), sample)
  }
})

test('files: LF line endings and exactly one trailing newline', () => {
  const files = [
    '../lib/errors.js',
    '../lib/reserved.js',
    '../lib/presets.js',
    '../lib/canon.js',
    '../data/family-rules.json',
    './phase1-rules.test.mjs',
  ]
  for (const file of files) {
    const text = readText(file)
    assert.ok(!text.includes('\r'), `${file} must use LF line endings`)
    assert.ok(text.endsWith('\n'), `${file} must end with a newline`)
    assert.ok(!text.endsWith('\n\n'), `${file} must end with exactly one newline`)
  }
})
