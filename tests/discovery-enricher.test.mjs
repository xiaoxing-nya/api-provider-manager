/**
 * Discovery and enrichment tests: base-URL normalization, protocol-aware model
 * listing, multi-dialect field extraction, the five-layer metadata precedence,
 * protocol-aware reasoning/compat resolution, protocol splitting, and route
 * auditing.
 *
 * Run with `node tests/discovery-enricher.test.mjs` from the package root.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import {
  MAX_RESPONSE_BYTES,
  buildListingUrl,
  discoverEndpointModels,
  fallbackV1Url,
  normalizeBaseUrl,
} from '../lib/discovery.js'
import {
  COMPACTION_HEADROOM,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  auditProvider,
  enrichModel,
  lookupOfflineCatalog,
  matchFamilyRule,
  planProtocolSplit,
  searchCatalogModels,
} from '../lib/enricher.js'
import { ApiManagerError } from '../lib/errors.js'

const REAL_RULES = JSON.parse(readFileSync(new URL('../data/family-rules.json', import.meta.url), 'utf8'))
const EMPTY_CATALOG = { models: {}, aliases: {} }

/** Build a successful JSON response. */
function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/**
 * Build a fetch double returning the queued responses in order while recording
 * every request.
 */
function recordingFetch(responses) {
  const calls = []
  let index = 0
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    return typeof response === 'function' ? response(url, init) : response
  }
  return { fetchImpl, calls }
}

/** Capture a rejected ApiManagerError code. */
async function rejectionCode(promise) {
  try {
    await promise
  } catch (error) {
    return error.code
  }
  throw new Error('expected the promise to reject')
}

describe('normalizeBaseUrl', () => {
  test('trims, strips a trailing slash, and detects the verbatim marker', () => {
    assert.deepEqual(normalizeBaseUrl('  https://relay.example/v1/  '), {
      baseURL: 'https://relay.example/v1',
      verbatim: false,
    })
    assert.deepEqual(normalizeBaseUrl('https://relay.example/anthropic/v1/#'), {
      baseURL: 'https://relay.example/anthropic/v1',
      verbatim: true,
    })
    assert.deepEqual(normalizeBaseUrl('https://relay.example///'), {
      baseURL: 'https://relay.example',
      verbatim: false,
    })
  })

  test('rejects empty, malformed, non-http, and credential-bearing URLs', () => {
    for (const baseURL of ['', '   ', 'relay.example', 'ftp://relay.example', 'https://user:pass@relay.example']) {
      assert.throws(
        () => normalizeBaseUrl(baseURL),
        error => error instanceof ApiManagerError && error.code === 'invalid-url',
      )
    }
  })

  test('never echoes embedded credentials', () => {
    try {
      normalizeBaseUrl('https://admin:hunter2@relay.example')
      assert.fail('expected a rejection')
    } catch (error) {
      assert.equal(error.code, 'invalid-url')
      assert.ok(!error.message.includes('hunter2'))
    }
  })
})

describe('buildListingUrl and fallbackV1Url', () => {
  test('builds the protocol-specific listing URL', () => {
    assert.equal(buildListingUrl('https://relay.example/v1', 'openai-completions'), 'https://relay.example/v1/models')
    assert.equal(buildListingUrl('https://relay.example/v1', 'openai-responses'), 'https://relay.example/v1/models')
    assert.equal(
      buildListingUrl('https://api.anthropic.com', 'anthropic-messages'),
      'https://api.anthropic.com/v1/models?limit=1000',
    )
    assert.equal(
      buildListingUrl('https://api.anthropic.com/v1/', 'anthropic-messages'),
      'https://api.anthropic.com/v1/models?limit=1000',
    )
    assert.equal(
      buildListingUrl('https://generativelanguage.googleapis.com', 'google-generative-ai'),
      'https://generativelanguage.googleapis.com/models?pageSize=1000',
    )
  })

  test('keeps a verbatim anthropic base URL untouched', () => {
    assert.equal(
      buildListingUrl('https://gateway.example/anthropic/v1/#', 'anthropic-messages'),
      'https://gateway.example/anthropic/v1/models?limit=1000',
    )
    assert.equal(
      buildListingUrl('https://gateway.example/anthropic/v1', 'anthropic-messages', { verbatim: true }),
      'https://gateway.example/anthropic/v1/models?limit=1000',
    )
  })

  test('rejects unsupported protocols', () => {
    assert.throws(
      () => buildListingUrl('https://relay.example', 'graphql'),
      error => error instanceof ApiManagerError && error.code === 'invalid-api',
    )
  })

  test('derives the /v1 fallback only for a bare OpenAI host', () => {
    assert.deepEqual(fallbackV1Url('https://proxy.example', 'openai-completions'), {
      url: 'https://proxy.example/v1/models',
      suggestedBaseURL: 'https://proxy.example/v1',
    })
    assert.deepEqual(fallbackV1Url('https://proxy.example/', 'openai-responses'), {
      url: 'https://proxy.example/v1/models',
      suggestedBaseURL: 'https://proxy.example/v1',
    })
    assert.equal(fallbackV1Url('https://proxy.example/v1', 'openai-completions'), null)
    assert.equal(fallbackV1Url('https://proxy.example/#', 'openai-completions'), null)
    assert.equal(fallbackV1Url('https://api.anthropic.com', 'anthropic-messages'), null)
  })
})

describe('discoverEndpointModels', () => {
  test('parses OpenAI data[] with multi-dialect fields and filters non-chat models', async () => {
    const payload = {
      object: 'list',
      data: [
        {
          id: 'gpt-6.1-sol',
          name: 'GPT-6.1 Sol',
          context_length: 400000,
          top_provider: { context_length: 400000, max_completion_tokens: 128000 },
          architecture: { input_modalities: ['text', 'image', 'pdf'] },
          supported_parameters: ['tools', 'reasoning'],
        },
        { id: 'vllm-qwen3-32b', max_model_len: 32768, max_tokens: 8192, input_modalities: ['text'] },
        {
          id: 'magpie-claude',
          max_context_length: 200000,
          max_output_tokens: 64000,
          supported_endpoint_types: ['openai', 'anthropic'],
          supported_reasoning_levels: ['low', 'high'],
          thinking: { zero_allowed: true, levels: ['low', 'medium', 'high'] },
        },
        {
          id: 'newapi-glm',
          context_window: 200000,
          max_output_tokens: 32768,
          supported_reasoning_levels: [{ level: 'low' }, { level: 'high' }],
          thinking: { zero_allowed: false },
        },
        {
          id: 'cli-deepseek',
          context_window: 1048576,
          max_output_tokens: 393216,
          input_modalities: ['text', 'image'],
          thinking: { levels: ['off', 'low', 'high', 'max'], zero_allowed: true },
        },
        { id: 'gpt-6.1-sol', name: 'duplicate', context_length: 1 },
        { id: 'text-embedding-3-large', type: 'embedding' },
        { id: 'bge-rerank-v2' },
      ],
    }
    const { fetchImpl, calls } = recordingFetch([jsonResponse(payload)])
    const result = await discoverEndpointModels({
      baseURL: 'https://relay.example/v1',
      api: 'openai-completions',
      apiKey: 'test-key-123',
      headers: { 'x-gateway': 'relay', authorization: 'Bearer stale-key' },
      fetchImpl,
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://relay.example/v1/models')
    const headers = calls[0].init.headers
    assert.equal(headers.get('authorization'), 'Bearer test-key-123')
    assert.equal(headers.get('x-gateway'), 'relay')
    assert.equal(headers.get('accept'), 'application/json')

    assert.equal(result.ok, true)
    assert.equal(result.api, 'openai-completions')
    assert.equal(result.url, 'https://relay.example/v1/models')
    assert.equal(result.rawCount, 8)
    assert.equal(result.nonChatSkipped, 2)
    assert.ok(Number.isInteger(result.latencyMs) && result.latencyMs >= 0)
    assert.equal('suggestedBaseURL' in result, false)
    assert.ok(!JSON.stringify(result).includes('test-key-123'))
    assert.deepEqual(
      result.models.map(model => model.id),
      ['gpt-6.1-sol', 'vllm-qwen3-32b', 'magpie-claude', 'newapi-glm', 'cli-deepseek'],
    )

    const gpt = result.models[0]
    assert.equal(gpt.name, 'GPT-6.1 Sol')
    assert.equal(gpt.contextWindow, 400000)
    assert.equal(gpt.maxTokens, 128000)
    assert.deepEqual(gpt.input, ['text', 'image'])
    assert.equal(gpt.reasoning, true)
    assert.equal(gpt.reasoningDeclared, true)

    const vllm = result.models[1]
    assert.equal(vllm.contextWindow, 32768)
    assert.equal(vllm.maxTokens, 8192)
    assert.equal(vllm.name, 'vllm-qwen3-32b')
    assert.equal(vllm.reasoning, false)
    assert.equal(vllm.reasoningDeclared, false)

    const magpie = result.models[2]
    assert.equal(magpie.contextWindow, 200000)
    assert.equal(magpie.maxTokens, 64000)
    assert.deepEqual(magpie.supportedEndpointTypes, ['openai', 'anthropic'])
    assert.deepEqual(magpie.efforts, ['off', 'low', 'medium', 'high'])
    assert.equal(magpie.allowOff, true)

    const newapi = result.models[3]
    assert.deepEqual(newapi.efforts, ['low', 'high'])
    assert.equal(newapi.allowOff, false)

    const deepseek = result.models[4]
    assert.equal(deepseek.contextWindow, 1048576)
    assert.equal(deepseek.maxTokens, 393216)
    assert.deepEqual(deepseek.efforts, ['off', 'low', 'high', 'max'])
  })

  test('keeps non-chat models when includeNonChat is set', async () => {
    const payload = { data: [{ id: 'text-embedding-3-large', type: 'embedding' }, { id: 'chat-model' }] }
    const { fetchImpl } = recordingFetch([jsonResponse(payload)])
    const result = await discoverEndpointModels({ baseURL: 'https://relay.example', includeNonChat: true, fetchImpl })
    assert.equal(result.nonChatSkipped, 0)
    assert.equal(result.models.length, 2)
    assert.equal(result.models[0].nonChat, true)
  })

  test('parses a models map and a bare array fallback', async () => {
    const mapPayload = {
      models: {
        'my-model-a': { name: 'My Model A', max_context_length: 64000 },
        'my-model-b': 'My Model B',
      },
    }
    const mapRun = recordingFetch([jsonResponse(mapPayload)])
    const fromMap = await discoverEndpointModels({
      baseURL: 'https://relay.example/v1',
      fetchImpl: mapRun.fetchImpl,
    })
    assert.equal(fromMap.rawCount, 2)
    assert.deepEqual(fromMap.models.map(model => model.id), ['my-model-a', 'my-model-b'])
    assert.equal(fromMap.models[0].name, 'My Model A')
    assert.equal(fromMap.models[0].contextWindow, 64000)
    assert.equal(fromMap.models[1].name, 'My Model B')

    const arrayRun = recordingFetch([jsonResponse([{ id: 'together-model', context_length: 32768 }])])
    const fromArray = await discoverEndpointModels({
      baseURL: 'https://relay.example/v1',
      fetchImpl: arrayRun.fetchImpl,
    })
    assert.deepEqual(fromArray.models.map(model => model.id), ['together-model'])
    assert.equal(fromArray.models[0].contextWindow, 32768)
  })

  test('uses Anthropic auth headers and /v1/models', async () => {
    const payload = {
      data: [
        {
          id: 'claude-sonnet-5-5',
          display_name: 'Claude Sonnet 5.5',
          max_input_tokens: 200000,
          max_tokens: 64000,
          input_modalities: ['text', 'image'],
        },
      ],
      has_more: false,
    }
    const { fetchImpl, calls } = recordingFetch([jsonResponse(payload)])
    const result = await discoverEndpointModels({
      baseURL: 'https://api.anthropic.com',
      api: 'anthropic-messages',
      apiKey: 'anthropic-key',
      fetchImpl,
    })
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000')
    assert.equal(calls[0].init.headers.get('x-api-key'), 'anthropic-key')
    assert.equal(calls[0].init.headers.get('anthropic-version'), '2023-06-01')
    const model = result.models[0]
    assert.equal(model.id, 'claude-sonnet-5-5')
    assert.equal(model.name, 'Claude Sonnet 5.5')
    assert.equal(model.contextWindow, 200000)
    assert.equal(model.maxTokens, 64000)
    assert.deepEqual(model.input, ['text', 'image'])
  })

  test('parses Gemini models and filters unsupported generation methods', async () => {
    const payload = {
      models: [
        {
          name: 'models/gemini-4-hydrogen',
          displayName: 'Gemini 4 Hydrogen',
          description: 'Frontier Gemini model',
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
          thinking: true,
        },
        {
          name: 'models/text-embedding-004',
          supportedGenerationMethods: ['embedContent'],
          inputTokenLimit: 2048,
        },
      ],
    }
    const { fetchImpl, calls } = recordingFetch([jsonResponse(payload)])
    const result = await discoverEndpointModels({
      baseURL: 'https://generativelanguage.googleapis.com',
      api: 'google-generative-ai',
      apiKey: 'gemini-key',
      fetchImpl,
    })
    assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/models?pageSize=1000')
    assert.equal(calls[0].init.headers.get('x-goog-api-key'), 'gemini-key')
    assert.equal(result.rawCount, 2)
    assert.equal(result.models.length, 1)
    const model = result.models[0]
    assert.equal(model.id, 'gemini-4-hydrogen')
    assert.equal(model.name, 'Gemini 4 Hydrogen')
    assert.equal(model.contextWindow, 1048576)
    assert.equal(model.maxTokens, 65536)
    assert.equal(model.description, 'Frontier Gemini model')
  })

  test('retries /v1/models after a 404 and reports the suggested base URL', async () => {
    const { fetchImpl, calls } = recordingFetch([
      new Response('not found', { status: 404 }),
      jsonResponse({ data: [{ id: 'relay-model', context_length: 128000 }] }),
    ])
    const result = await discoverEndpointModels({
      baseURL: 'https://proxy.example',
      api: 'openai-completions',
      fetchImpl,
    })
    assert.deepEqual(
      calls.map(call => call.url),
      ['https://proxy.example/models', 'https://proxy.example/v1/models'],
    )
    assert.equal(result.url, 'https://proxy.example/v1/models')
    assert.equal(result.suggestedBaseURL, 'https://proxy.example/v1')
    assert.deepEqual(result.models.map(model => model.id), ['relay-model'])
  })

  test('throws an http-error when the fallback also fails and when no fallback exists', async () => {
    const failedFallback = recordingFetch([
      new Response('not found', { status: 404 }),
      new Response('still missing', { status: 404 }),
    ])
    assert.equal(
      await rejectionCode(
        discoverEndpointModels({ baseURL: 'https://proxy.example', fetchImpl: failedFallback.fetchImpl }),
      ),
      'http-error',
    )

    const noFallback = recordingFetch([new Response('server error', { status: 500 })])
    assert.equal(
      await rejectionCode(
        discoverEndpointModels({ baseURL: 'https://proxy.example/v1', fetchImpl: noFallback.fetchImpl }),
      ),
      'http-error',
    )
  })

  test('rejects oversized responses by Content-Length and by streamed bytes', async () => {
    const declaredLarge = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(MAX_RESPONSE_BYTES + 1) }),
      body: null,
      text: async () => '{}',
    }
    const declaredRun = recordingFetch([declaredLarge])
    assert.equal(
      await rejectionCode(
        discoverEndpointModels({ baseURL: 'https://relay.example', fetchImpl: declaredRun.fetchImpl }),
      ),
      'response-too-large',
    )

    const chunk = new Uint8Array(1024 * 1024)
    const oversized = new Response(
      new ReadableStream({
        start(controller) {
          for (let index = 0; index < 5; index += 1) controller.enqueue(chunk)
          controller.close()
        },
      }),
    )
    const streamedRun = recordingFetch([oversized])
    assert.equal(
      await rejectionCode(
        discoverEndpointModels({ baseURL: 'https://relay.example', fetchImpl: streamedRun.fetchImpl }),
      ),
      'response-too-large',
    )
  })

  test('redacts the API key from network failures and validates header-safe keys', async () => {
    const apiKey = 'sk-super-secret-value'
    const failing = async () => {
      throw new Error(`socket hangup while sending ${apiKey}`)
    }
    try {
      await discoverEndpointModels({ baseURL: 'https://relay.example', apiKey, fetchImpl: failing })
      assert.fail('expected a rejection')
    } catch (error) {
      assert.equal(error.code, 'network-error')
      assert.ok(!error.message.includes(apiKey))
      assert.ok(error.message.includes('***'))
    }

    for (const badKey of ['line\nbreak', 'tab\tkey', ' leading-space', 'trailing-space ']) {
      try {
        await discoverEndpointModels({
          baseURL: 'https://relay.example',
          apiKey: badKey,
          fetchImpl: async () => jsonResponse({ data: [] }),
        })
        assert.fail('expected a rejection')
      } catch (error) {
        assert.equal(error.code, 'invalid-api-key')
        assert.ok(!error.message.includes(badKey.trim()))
      }
    }
  })

  test('invalid JSON and invalid protocols fail with stable codes', async () => {
    const invalidJson = recordingFetch([new Response('not json', { status: 200 })])
    assert.equal(
      await rejectionCode(
        discoverEndpointModels({ baseURL: 'https://relay.example', fetchImpl: invalidJson.fetchImpl }),
      ),
      'invalid-response',
    )

    const unsupported = recordingFetch([jsonResponse({ data: [] })])
    assert.equal(
      await rejectionCode(
        discoverEndpointModels({ baseURL: 'https://relay.example', api: 'graphql', fetchImpl: unsupported.fetchImpl }),
      ),
      'invalid-api',
    )
  })

  test('honours timeoutMs and an external abort signal', async () => {
    const hanging = (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    assert.equal(
      await rejectionCode(
        discoverEndpointModels({ baseURL: 'https://relay.example', timeoutMs: 20, fetchImpl: hanging }),
      ),
      'discovery-timeout',
    )

    const controller = new AbortController()
    controller.abort()
    assert.equal(
      await rejectionCode(
        discoverEndpointModels({
          baseURL: 'https://relay.example',
          signal: controller.signal,
          fetchImpl: async (url, init) => {
            if (init.signal.aborted) throw new Error('aborted before send')
            return jsonResponse({ data: [] })
          },
        }),
      ),
      'request-aborted',
    )
  })

  test('sends a verbatim anthropic listing URL without inserting /v1 and skips /v1 fallback on verbatim openai URLs', async () => {
    const { fetchImpl, calls } = recordingFetch([jsonResponse({ data: [{ id: 'claude-model' }] })])
    await discoverEndpointModels({
      baseURL: 'https://gateway.example/anthropic/v1/#',
      api: 'anthropic-messages',
      apiKey: 'key',
      fetchImpl,
    })
    assert.equal(calls[0].url, 'https://gateway.example/anthropic/v1/models?limit=1000')

    const verbatimOpenai = recordingFetch([
      new Response('not found', { status: 404 }),
      jsonResponse({ data: [{ id: 'should-not-be-reached' }] }),
    ])
    assert.equal(
      await rejectionCode(
        discoverEndpointModels({
          baseURL: 'https://gateway.example/#',
          api: 'openai-completions',
          fetchImpl: verbatimOpenai.fetchImpl,
        }),
      ),
      'http-error',
    )
    assert.equal(verbatimOpenai.calls.length, 1, 'verbatim # must disable the /v1 fallback retry')
    assert.equal(verbatimOpenai.calls[0].url, 'https://gateway.example/models')
  })

  test('distinguishes undeclared reasoning from explicit non-reasoning declarations', async () => {
    const payload = {
      data: [
        { id: 'bare-openai-entry' },
        { id: 'explicit-supports-false', supports_reasoning: false },
        { id: 'explicit-reasoning-false', reasoning: false },
        { id: 'explicit-reasoning-obj-false', reasoning: { supported: false } },
        { id: 'explicit-thinking-false', thinking: false },
        { id: 'explicit-capabilities-false', capabilities: { thinking: false } },
        { id: 'explicit-thinking-true', thinking: true },
      ],
    }
    const { fetchImpl } = recordingFetch([jsonResponse(payload)])
    const result = await discoverEndpointModels({ baseURL: 'https://relay.example/v1', fetchImpl })
    const byId = Object.fromEntries(result.models.map(model => [model.id, model]))

    assert.equal(byId['bare-openai-entry'].reasoning, false)
    assert.equal(byId['bare-openai-entry'].reasoningDeclared, false)

    for (const id of [
      'explicit-supports-false',
      'explicit-reasoning-false',
      'explicit-reasoning-obj-false',
      'explicit-thinking-false',
      'explicit-capabilities-false',
    ]) {
      assert.equal(byId[id].reasoning, false, id)
      assert.equal(byId[id].reasoningDeclared, true, id)
    }

    assert.equal(byId['explicit-thinking-true'].reasoning, true)
    assert.equal(byId['explicit-thinking-true'].reasoningDeclared, true)
  })
})

/* ------------------------------------------------------------------------- */
/* Enricher fixtures                                                         */
/* ------------------------------------------------------------------------- */

const CATALOG = {
  models: {
    'sample-model-x': {
      id: 'sample-model-x',
      name: 'Sample X (catalog)',
      contextWindow: 400000,
      maxTokens: 64000,
      input: ['text', 'image', 'pdf'],
      reasoning: true,
      allowOff: true,
      efforts: ['off', 'low', 'high'],
      interleavedField: null,
      endpoints: ['/v1/chat/completions'],
      source: 'models.dev',
    },
    'embed-model': {
      id: 'embed-model',
      name: 'Embedding Model',
      contextWindow: 8192,
      maxTokens: 2048,
      input: ['text'],
      reasoning: false,
      allowOff: true,
      efforts: [],
      interleavedField: null,
      endpoints: [],
      source: 'models.dev',
    },
  },
  aliases: {
    'sample-x': 'sample-model-x',
    'sample-model-x-latest': 'sample-model-x',
  },
}

const RULES = {
  rules: [
    {
      id: 'sample-rule',
      match: '^sample-model-x(?:$|[-.])',
      vendorGroup: 'Sample',
      contextWindow: 200000,
      maxTokens: 32000,
      input: ['text'],
      efforts: ['off', 'low', 'medium'],
      allowOff: true,
      compat: { thinkingFormat: 'openai' },
    },
    {
      id: 'implicit-off-rule',
      match: '^implicit-off(?:$|[-.])',
      vendorGroup: 'Sample',
      contextWindow: 100000,
      maxTokens: 8000,
      input: ['text'],
      efforts: ['low', 'high'],
    },
    {
      id: 'off-forbidden-rule',
      match: '^off-forbidden(?:$|[-.])',
      vendorGroup: 'Sample',
      contextWindow: 100000,
      maxTokens: 8000,
      input: ['text'],
      efforts: ['high'],
      allowOff: false,
    },
  ],
}

const DISCOVERED = {
  id: 'sample-model-x',
  name: 'Sample X (endpoint)',
  contextWindow: 300000,
  maxTokens: 48000,
  input: ['text'],
  reasoning: true,
  allowOff: true,
  efforts: ['off', 'low'],
  supportedEndpointTypes: ['openai', 'anthropic'],
}

const REGISTRY_ENTRY = {
  id: 'sample-model-x',
  name: 'Sample X (registry)',
  contextWindow: 250000,
  maxTokens: 40000,
  input: ['text', 'image'],
  reasoning: true,
  allowOff: true,
  efforts: ['off', 'low', 'high'],
  interleavedField: null,
  endpoints: ['/v1/chat/completions'],
  source: 'models.dev',
}

/** Registry cache double: returns the entry for the canonical key only. */
function fakeRegistry(entry = REGISTRY_ENTRY) {
  const calls = []
  return {
    calls,
    lookup(keys) {
      calls.push(keys)
      return keys.includes('sample-model-x') ? entry : null
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Enricher tests                                                            */
/* ------------------------------------------------------------------------- */

describe('lookupOfflineCatalog and matchFamilyRule', () => {
  test('resolves exact ids, canon variants, dot/hyphen variants, and aliases', () => {
    assert.equal(lookupOfflineCatalog('sample-model-x', CATALOG)?.id, 'sample-model-x')
    assert.equal(lookupOfflineCatalog('Sample_Model_X', CATALOG)?.id, 'sample-model-x')
    assert.equal(lookupOfflineCatalog('sample-x', CATALOG)?.id, 'sample-model-x')
    assert.equal(lookupOfflineCatalog('sample-model-x-latest', CATALOG)?.id, 'sample-model-x')
    assert.equal(lookupOfflineCatalog('vendor/sample-model-x', CATALOG)?.id, 'sample-model-x')
    assert.equal(lookupOfflineCatalog('missing-model', CATALOG), null)
  })

  test('uses the bundled catalog by default', () => {
    assert.equal(lookupOfflineCatalog('deepseek-v4.1-flash-1017')?.id, 'deepseek-v4.1-flash')
  })

  test('exact model ids outrank colliding dated variants and ambiguous inferences are not selected', () => {
    const colliding = {
      models: {
        'example-model-20260101': { id: 'example-model-20260101', contextWindow: 32768 },
        'example-model': { id: 'example-model', contextWindow: 128000 },
        'vendor-a/shared-model': { id: 'vendor-a/shared-model', contextWindow: 64000 },
        'vendor-b/shared-model': { id: 'vendor-b/shared-model', contextWindow: 96000 },
      },
      aliases: {},
    }
    assert.equal(lookupOfflineCatalog('example-model', colliding)?.id, 'example-model')
    assert.equal(lookupOfflineCatalog('example-model-20260101', colliding)?.id, 'example-model-20260101')
    const id = 'unqualified/shared-model'
    const ids = ['vendor-a/shared-model', 'vendor-b/shared-model']
    assert.equal(lookupOfflineCatalog(id, colliding), null)
    const result = enrichModel({ id, offlineCatalog: colliding, familyRules: [] })
    assert.equal(result.meta.matchedCatalogId, null)
    assert.deepEqual(result.meta.ambiguousModelIds, ids)
    assert.equal(result.provenance.contextWindow, 'fallback')
    assert.deepEqual(result.warnings.map(warning => warning.code), ['ambiguous-model-match'])
    const search = searchCatalogModels({ query: id, offlineCatalog: colliding })
    assert.deepEqual(search.models.map(model => model.id), ids)
    assert.equal(search.total, 2)
  })

  test('online and offline matching share identity precedence without mixing models', () => {
    const offlineCatalog = {
      models: { 'relay-model': { id: 'relay-model', contextWindow: 320000 } },
      aliases: { 'relay-preview': 'relay-model' },
    }
    const registryCache = {
      models: {
        'relay-model-20260101': { id: 'relay-model-20260101', contextWindow: 200000 },
        other: { id: 'other', contextWindow: 64000 },
      },
      aliases: { 'online-preview': 'other' },
    }
    const options = { offlineCatalog, registryCache }
    for (const [query, expected] of [['relay-model', 'relay-model'], ['relay-preview', 'relay-model'], ['online-preview', 'other']]) {
      const { meta, profile } = enrichModel({ id: query, ...options })
      assert.equal(meta.matchedRegistryId ?? meta.matchedCatalogId, expected)
      assert.equal(searchCatalogModels({ query, limit: 1, ...options }).models[0]?.id, expected)
      assert.equal(profile.contextWindow, expected === 'other' ? 64000 : 320000)
    }
    const conflict = enrichModel({ id: 'relay-model-20260201', ...options })
    assert.deepEqual(conflict.meta.ambiguousModelIds, ['relay-model', 'relay-model-20260101'])
    assert.equal(conflict.meta.matchedRegistryId, null)
  })

  test('offline aliases are searchable by their exact spelling', () => {
    for (const [alias, target] of [
      ['claude-sonnet-4.5', 'claude-sonnet-4-5'],
      ['gemini-4-argon-high', 'gemini-4-argon'],
      ['deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash'],
    ]) {
      const result = searchCatalogModels({ query: alias, limit: 10 })
      assert.equal(result.models[0]?.id, target, alias)
      assert.ok(result.total >= 1, alias)
    }
  })

  test('matches family rules against normalized and dot/hyphen spellings', () => {
    assert.equal(matchFamilyRule('sample-model-x-20260101', RULES)?.id, 'sample-rule')
    assert.equal(matchFamilyRule('Sample.Model.X', RULES)?.id, 'sample-rule')
    assert.equal(matchFamilyRule('sample-model-x-extra', RULES)?.id, 'sample-rule')
    assert.equal(matchFamilyRule('missing-model', RULES), null)
  })

  test('matches the bundled DeepSeek, Claude, and GLM rules', () => {
    assert.equal(matchFamilyRule('deepseek-v4.1-flash-1017', REAL_RULES)?.id, 'deepseek-v4-1-flash')
    assert.equal(matchFamilyRule('claude-sonnet-5-5-20260101', REAL_RULES)?.id, 'claude-sonnet-5')
    assert.equal(matchFamilyRule('glm-5.3-flash', REAL_RULES)?.id, 'glm-vision')
  })
})

describe('enrichModel layer precedence', () => {
  test('manual override wins every managed field', () => {
    const registry = fakeRegistry()
    const result = enrichModel({
      id: 'sample-model-x',
      discovered: DISCOVERED,
      configured: { contextWindow: 111111, maxTokens: 22222 },
      manualOverride: {
        name: 'Manual X',
        contextWindow: 500000,
        maxTokens: 100000,
        input: ['text', 'image'],
        reasoningEfforts: { off: null, high: 'high' },
        compat: { supportsStore: true },
      },
      api: 'openai-completions',
      presetId: 'custom-relay-openai',
      registryCache: registry,
      offlineCatalog: CATALOG,
      familyRules: RULES,
    })
    assert.equal(result.profile.name, 'Manual X')
    assert.equal(result.profile.contextWindow, 500000)
    assert.equal(result.profile.maxTokens, 100000)
    assert.deepEqual(result.profile.input, ['text', 'image'])
    assert.deepEqual(result.profile.reasoningEfforts, { off: null, high: 'high' })
    assert.equal(result.profile.compat.supportsStore, true)
    assert.equal(result.profile.compat.supportsDeveloperRole, false)
    for (const field of ['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts']) {
      assert.equal(result.provenance[field], 'manual', field)
    }
    assert.equal(result.provenance.compat, 'manual')
  })

  test('a manual null resets a field to the next layer', () => {
    const result = enrichModel({
      id: 'sample-model-x',
      discovered: DISCOVERED,
      manualOverride: { contextWindow: null, maxTokens: 99999 },
      api: 'openai-completions',
      offlineCatalog: CATALOG,
      familyRules: RULES,
    })
    assert.equal(result.profile.contextWindow, 300000)
    assert.equal(result.provenance.contextWindow, 'endpoint')
    assert.equal(result.profile.maxTokens, 99999)
    assert.equal(result.provenance.maxTokens, 'manual')
  })

  test('endpoint outranks every offline layer', () => {
    const result = enrichModel({
      id: 'sample-model-x',
      discovered: DISCOVERED,
      api: 'openai-completions',
      registryCache: fakeRegistry(),
      offlineCatalog: CATALOG,
      familyRules: RULES,
    })
    assert.equal(result.profile.name, 'Sample X (endpoint)')
    assert.equal(result.profile.contextWindow, 300000)
    assert.equal(result.profile.maxTokens, 48000)
    assert.deepEqual(result.profile.input, ['text'])
    assert.deepEqual(result.profile.reasoningEfforts, { off: null, low: 'low' })
    assert.equal(result.provenance.name, 'endpoint')
    assert.equal(result.provenance.contextWindow, 'endpoint')
    assert.equal(result.provenance.maxTokens, 'endpoint')
    assert.equal(result.provenance.input, 'endpoint')
    assert.equal(result.provenance.reasoningEfforts, 'endpoint')
  })

  test('remote registry outranks the local snapshot and the family rule', () => {
    const result = enrichModel({
      id: 'sample-model-x',
      api: 'openai-completions',
      registryCache: fakeRegistry(),
      offlineCatalog: CATALOG,
      familyRules: RULES,
    })
    assert.equal(result.profile.name, 'Sample X (registry)')
    assert.equal(result.profile.contextWindow, 250000)
    assert.equal(result.profile.maxTokens, 40000)
    assert.equal(result.provenance.contextWindow, 'remote-registry')
    assert.deepEqual(result.profile.reasoningEfforts, { off: null, low: 'low', high: 'high' })
    assert.equal(result.meta.matchedRegistryId, 'sample-model-x')
    assert.equal(result.meta.matchedCatalogId, 'sample-model-x')
  })

  test('local snapshot outranks the family rule when the registry has no entry', () => {
    const result = enrichModel({
      id: 'sample-model-x',
      api: 'openai-completions',
      registryCache: fakeRegistry(null),
      offlineCatalog: CATALOG,
      familyRules: RULES,
    })
    assert.equal(result.profile.name, 'Sample X (catalog)')
    assert.equal(result.profile.contextWindow, 400000)
    assert.equal(result.profile.maxTokens, 64000)
    assert.deepEqual(result.profile.input, ['text', 'image'])
    assert.deepEqual(result.profile.reasoningEfforts, { off: null, low: 'low', high: 'high' })
    assert.equal(result.provenance.contextWindow, 'local-snapshot')
    assert.deepEqual(result.meta.supportedEndpointTypes, ['/v1/chat/completions'])
    assert.equal(result.meta.matchedCatalogId, 'sample-model-x')
  })

  test('the family rule fills the gap when no metadata entry exists', () => {
    const result = enrichModel({
      id: 'sample-model-x',
      api: 'openai-completions',
      registryCache: fakeRegistry(null),
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.equal(result.profile.contextWindow, 200000)
    assert.equal(result.profile.maxTokens, 32000)
    assert.deepEqual(result.profile.input, ['text'])
    assert.deepEqual(result.profile.reasoningEfforts, { off: null, low: 'low', medium: 'medium' })
    assert.equal(result.provenance.contextWindow, 'heuristic')
    assert.equal(result.provenance.reasoningEfforts, 'heuristic')
    assert.equal(result.meta.matchedRuleId, 'sample-rule')
  })

  test('an existing configured profile fills untouched fields before the fallback', () => {
    const result = enrichModel({
      id: 'unknown-model-zzz',
      configured: {
        id: 'unknown-model-zzz',
        name: 'Configured Z',
        contextWindow: 123456,
        maxTokens: 23456,
        input: ['text', 'image'],
        reasoningEfforts: { off: null, high: 'high' },
        compat: { supportsStore: true },
        customNote: 'keep me',
      },
      api: 'openai-completions',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.equal(result.profile.name, 'Configured Z')
    assert.equal(result.profile.contextWindow, 123456)
    assert.equal(result.profile.maxTokens, 23456)
    assert.deepEqual(result.profile.input, ['text', 'image'])
    assert.deepEqual(result.profile.reasoningEfforts, { off: null, high: 'high' })
    assert.equal(result.profile.customNote, 'keep me')
    for (const field of ['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts']) {
      assert.equal(result.provenance[field], 'configured', field)
    }
  })

  test('an existing capacity outranks the heuristic but not a metadata snapshot', () => {
    const keepConfigured = enrichModel({
      id: 'sample-model-x',
      configured: { contextWindow: 5000, maxTokens: 1000 },
      api: 'openai-completions',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.equal(keepConfigured.profile.contextWindow, 5000)
    assert.equal(keepConfigured.profile.maxTokens, 1000)
    assert.equal(keepConfigured.provenance.contextWindow, 'configured')
    assert.equal(keepConfigured.provenance.maxTokens, 'configured')

    const snapshotWins = enrichModel({
      id: 'sample-model-x',
      configured: { contextWindow: 5000, maxTokens: 1000 },
      api: 'openai-completions',
      offlineCatalog: CATALOG,
      familyRules: RULES,
    })
    assert.equal(snapshotWins.profile.contextWindow, 400000)
    assert.equal(snapshotWins.provenance.contextWindow, 'local-snapshot')
  })

  test('falls back to conservative defaults and then preset defaults', () => {
    const plain = enrichModel({
      id: 'unknown-model-zzz',
      api: 'openai-completions',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.equal(plain.profile.name, 'unknown-model-zzz')
    assert.equal(plain.profile.contextWindow, DEFAULT_CONTEXT_WINDOW)
    assert.equal(plain.profile.maxTokens, DEFAULT_MAX_TOKENS)
    assert.deepEqual(plain.profile.input, ['text'])
    assert.equal(Object.hasOwn(plain.profile, 'reasoningEfforts'), false)
    for (const field of ['name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat']) {
      assert.equal(plain.provenance[field], 'fallback', field)
    }

    const geminiPreset = enrichModel({
      id: 'unknown-model-zzz',
      api: 'google-generative-ai',
      presetId: 'custom-gemini',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.equal(geminiPreset.profile.contextWindow, 1048576)
    assert.equal(geminiPreset.profile.maxTokens, 65536)
    assert.equal(geminiPreset.provenance.contextWindow, 'fallback')
  })

  test('validates the final profile and unknown presets warn', () => {
    assert.throws(
      () =>
        enrichModel({
          id: 'sample-model-x',
          manualOverride: { contextWindow: -5 },
          offlineCatalog: CATALOG,
          familyRules: RULES,
        }),
      error => error instanceof ApiManagerError && error.code === 'invalid-model-profile',
    )
    const unknownPreset = enrichModel({
      id: 'unknown-model-zzz',
      presetId: 'does-not-exist',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.ok(unknownPreset.warnings.some(warning => warning.code === 'unknown-preset'))
    assert.equal(unknownPreset.profile.contextWindow, DEFAULT_CONTEXT_WINDOW)
  })
})

describe('enrichModel protocol-aware reasoning and compat', () => {
  test('clamps Gemini reasoning efforts and warns about dropped levels', () => {
    const rules = {
      rules: [
        {
          id: 'gemini-test',
          match: '^gemini-4[.-]hydrogen',
          vendorGroup: 'Google',
          contextWindow: 1048576,
          maxTokens: 65536,
          input: ['text', 'image'],
          efforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
          allowOff: true,
        },
      ],
    }
    const result = enrichModel({
      id: 'gemini-4-hydrogen',
      api: 'google-generative-ai',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: rules,
    })
    assert.deepEqual(result.profile.reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' })
    assert.equal(result.provenance.reasoningEfforts, 'heuristic')
    const warning = result.warnings.find(entry => entry.code === 'reasoning-efforts-clamped')
    assert.ok(warning, 'expected a clamping warning')
    for (const level of ['off', 'xhigh', 'max']) assert.ok(warning.levels.includes(level))
  })

  test('DeepSeek rules add the deepseek thinking format and replayed reasoning content', () => {
    const result = enrichModel({
      id: 'deepseek-v4.1-flash',
      api: 'openai-completions',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: REAL_RULES,
    })
    assert.deepEqual(result.profile.reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' })
    assert.deepEqual(result.profile.input, ['text', 'image'])
    assert.equal(result.profile.compat.thinkingFormat, 'deepseek')
    assert.equal(result.profile.compat.requiresReasoningContentOnAssistantMessages, true)
    assert.equal(result.provenance.compat, 'heuristic')
  })

  test('filters compat strictly for the target protocol', () => {
    const result = enrichModel({
      id: 'deepseek-v4.1-flash',
      api: 'anthropic-messages',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: REAL_RULES,
    })
    assert.equal(Object.hasOwn(result.profile, 'compat'), false)
    assert.equal(result.provenance.compat, 'fallback')
  })

  test('Magpie #6845: only allowOff === false drops the off level', () => {
    const implicitOff = enrichModel({
      id: 'implicit-off-model',
      api: 'openai-completions',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.equal(implicitOff.profile.reasoningEfforts.off, null)
    assert.equal(implicitOff.profile.reasoningEfforts.low, 'low')

    const forbiddenOff = enrichModel({
      id: 'off-forbidden-model',
      api: 'openai-completions',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.equal(Object.hasOwn(forbiddenOff.profile.reasoningEfforts, 'off'), false)
    assert.equal(forbiddenOff.profile.reasoningEfforts.high, 'high')
  })

  test('does not repeat route-level compat inside the model', () => {
    const result = enrichModel({
      id: 'sample-model-x',
      api: 'openai-completions',
      presetId: 'custom-relay-openai',
      routeCompat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.deepEqual(result.profile.compat, { thinkingFormat: 'openai' })
    assert.equal(result.provenance.compat, 'heuristic')
  })

  test('a model capability beats a gateway preset default', () => {
    const result = enrichModel({
      id: 'gpt-5.4',
      api: 'openai-completions',
      presetId: 'custom-relay-openai',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: REAL_RULES,
    })
    assert.equal(result.profile.compat.supportsDeveloperRole, true)
    assert.equal(result.profile.compat.supportsStore, false)
    assert.equal(result.profile.compat.maxTokensField, 'max_tokens')
    assert.equal(result.profile.compat.thinkingFormat, 'openai')
    assert.equal(result.provenance.compat, 'heuristic')
  })

  test('manual compat overrides a contradicting preset default', () => {
    const result = enrichModel({
      id: 'sample-model-x',
      api: 'openai-completions',
      presetId: 'custom-relay-openai',
      manualOverride: { compat: { supportsDeveloperRole: true } },
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.equal(result.profile.compat.supportsDeveloperRole, true)
    assert.equal(result.provenance.compat, 'manual')
  })

  test('warns when compaction headroom is tight', () => {
    const tight = enrichModel({
      id: 'unknown-model-zzz',
      api: 'openai-completions',
      discovered: { contextWindow: 65536, maxTokens: 16384 },
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    const warning = tight.warnings.find(entry => entry.code === 'compaction-headroom-tight')
    assert.ok(warning, 'expected a compaction headroom warning')
    assert.equal(warning.reserved, 16384 + COMPACTION_HEADROOM)
    assert.ok(warning.message.includes('dsh-compaction-basic'))

    const roomy = enrichModel({
      id: 'unknown-model-zzz',
      api: 'openai-completions',
      discovered: { contextWindow: 200000, maxTokens: 16000 },
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.equal(roomy.warnings.some(entry => entry.code === 'compaction-headroom-tight'), false)
  })

  test('reports vendor group, endpoint types, and non-chat status', () => {
    const registry = fakeRegistry()
    const result = enrichModel({
      id: 'sample-model-x',
      discovered: DISCOVERED,
      api: 'openai-completions',
      registryCache: registry,
      offlineCatalog: CATALOG,
      familyRules: RULES,
    })
    assert.equal(result.meta.vendorGroup, 'Sample')
    assert.deepEqual(result.meta.supportedEndpointTypes, ['openai', 'anthropic'])
    assert.equal(result.meta.isNonChat, false)
    assert.ok(registry.calls[0].includes('sample-model-x'))

    const nonChat = enrichModel({
      id: 'text-embedding-3-large',
      api: 'openai-completions',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.equal(nonChat.meta.isNonChat, true)
  })

  test('undeclared endpoint reasoning falls through to lower layers while explicit false wins', () => {
    const bareEndpoint = {
      id: 'sample-model-x',
      name: 'sample-model-x',
      reasoning: false,
      reasoningDeclared: false,
      allowOff: true,
      efforts: [],
    }
    const fromCatalog = enrichModel({
      id: 'sample-model-x',
      discovered: bareEndpoint,
      api: 'openai-completions',
      offlineCatalog: CATALOG,
      familyRules: RULES,
    })
    assert.deepEqual(fromCatalog.profile.reasoningEfforts, { off: null, low: 'low', high: 'high' })
    assert.equal(fromCatalog.provenance.reasoningEfforts, 'local-snapshot')

    const fromRules = enrichModel({
      id: 'sample-model-x',
      discovered: bareEndpoint,
      api: 'openai-completions',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.deepEqual(fromRules.profile.reasoningEfforts, { off: null, low: 'low', medium: 'medium' })
    assert.equal(fromRules.provenance.reasoningEfforts, 'heuristic')

    const unknownBare = enrichModel({
      id: 'unknown-bare-model',
      discovered: { id: 'unknown-bare-model', reasoning: false, reasoningDeclared: false, efforts: [] },
      api: 'openai-completions',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.equal(Object.hasOwn(unknownBare.profile, 'reasoningEfforts'), false)
    assert.equal(unknownBare.provenance.reasoningEfforts, 'fallback')

    const explicitNonReasoning = enrichModel({
      id: 'sample-model-x',
      discovered: { id: 'sample-model-x', reasoning: false, reasoningDeclared: true, efforts: [] },
      api: 'openai-completions',
      offlineCatalog: CATALOG,
      familyRules: RULES,
    })
    assert.equal(explicitNonReasoning.profile.reasoningEfforts, false)
    assert.equal(explicitNonReasoning.provenance.reasoningEfforts, 'endpoint')
  })

  test('vertex/ prefixed Gemini models match family rules and registry lookups', () => {
    const vertexGemini = enrichModel({
      id: 'vertex/gemini-4-neon',
      api: 'openai-completions',
      offlineCatalog: EMPTY_CATALOG,
      familyRules: REAL_RULES,
    })
    assert.equal(vertexGemini.meta.matchedRuleId, 'gemini-4')
    assert.equal(vertexGemini.profile.contextWindow, 1048576)
    assert.deepEqual(vertexGemini.profile.reasoningEfforts, {
      off: null,
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
    })
  })
})

describe('planProtocolSplit', () => {
  const claude = enrichModel({
    id: 'claude-sonnet-5-5',
    api: 'openai-completions',
    discovered: { id: 'claude-sonnet-5-5', supportedEndpointTypes: ['openai', 'anthropic'] },
    offlineCatalog: EMPTY_CATALOG,
    familyRules: REAL_RULES,
  })
  const gemini = enrichModel({
    id: 'gemini-4-hydrogen',
    api: 'openai-completions',
    discovered: { id: 'gemini-4-hydrogen', supportedEndpointTypes: ['openai', 'gemini'] },
    offlineCatalog: EMPTY_CATALOG,
    familyRules: REAL_RULES,
  })
  const deepseek = enrichModel({
    id: 'deepseek-v4.1-flash',
    api: 'openai-completions',
    discovered: { id: 'deepseek-v4.1-flash', supportedEndpointTypes: ['openai'] },
    offlineCatalog: EMPTY_CATALOG,
    familyRules: REAL_RULES,
  })

  test('splits a mixed relay into native protocol groups sharing apiKeyEnv', () => {
    const plan = planProtocolSplit({
      providerId: 'relay',
      displayName: 'Relay',
      baseURL: 'https://relay.example/v1',
      apiKeyEnv: 'RELAY_API_KEY',
      enrichedModels: [deepseek, gemini, claude],
    })
    assert.equal(plan.split, true)
    assert.deepEqual(
      plan.groups.map(group => group.api),
      ['openai-completions', 'anthropic-messages', 'google-generative-ai'],
    )
    assert.deepEqual(
      plan.groups.map(group => group.id),
      ['relay', 'relay-anthropic', 'relay-gemini'],
    )
    for (const group of plan.groups) {
      assert.equal(group.apiKeyEnv, 'RELAY_API_KEY')
      assert.equal(group.baseURL, 'https://relay.example/v1')
      assert.equal(group.modelCount, 1)
      assert.equal(group.models[0].id !== undefined, true)
    }
    assert.equal(plan.groups[0].displayName, 'Relay')
    assert.equal(plan.groups[1].displayName, 'Relay (Anthropic Messages)')
  })

  test('keeps a single-protocol relay intact', () => {
    const plan = planProtocolSplit({
      providerId: 'relay',
      displayName: 'Relay',
      apiKeyEnv: 'RELAY_API_KEY',
      enrichedModels: [deepseek],
    })
    assert.equal(plan.split, false)
    assert.equal(plan.groups.length, 1)
    assert.equal(plan.groups[0].id, 'relay')
    assert.equal(plan.groups[0].api, 'openai-completions')
  })

  test('skips empty groups and warns when there are no models', () => {
    const empty = planProtocolSplit({ providerId: 'relay', enrichedModels: [] })
    assert.equal(empty.split, false)
    assert.deepEqual(empty.groups, [])
    assert.ok(empty.warnings.some(warning => warning.code === 'no-models'))
  })

  test('avoids configured and reserved provider ids with numeric suffixes', () => {
    const plan = planProtocolSplit({
      providerId: 'relay',
      displayName: 'Relay',
      apiKeyEnv: 'RELAY_API_KEY',
      enrichedModels: [deepseek, gemini, claude],
      existingProviders: { 'relay-anthropic': { displayName: 'taken' } },
      configurableProviders: [{ provider: 'relay-gemini', declared: false }],
    })
    assert.deepEqual(
      plan.groups.map(group => group.id),
      ['relay', 'relay-anthropic-2', 'relay-gemini-2'],
    )
  })

  test('derives family protocol hints without endpoint metadata', () => {
    const plan = planProtocolSplit({
      providerId: 'relay',
      enrichedModels: [{ profile: { id: 'claude-opus-5', name: 'Claude' } }, { profile: { id: 'gemini-4', name: 'Gemini' } }],
    })
    assert.deepEqual(
      plan.groups.map(group => group.api),
      ['anthropic-messages', 'google-generative-ai'],
    )
    assert.deepEqual(
      plan.groups.map(group => group.id),
      ['relay-anthropic', 'relay-gemini'],
    )
  })

  test('rejects an invalid source provider id', () => {
    assert.throws(
      () => planProtocolSplit({ providerId: 'Bad Id!', enrichedModels: [deepseek] }),
      error => error instanceof ApiManagerError && error.code === 'invalid-provider-id',
    )
  })
})

describe('auditProvider', () => {
  /** A cpa-style route: ids, display names, inputs, and efforts but no capacities or compat. */
  const CPA_PROFILE = {
    name: 'cpa',
    baseURL: 'https://cpa.luoli.my/v1',
    api: 'openai-completions',
    apiKeyEnv: 'CPA_API_KEY',
    models: [
      {
        id: 'deepseek-v4.1-flash',
        name: 'deepseek-v4.1-flash',
        input: ['text', 'image'],
        reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
      },
      {
        id: 'glm-5.3-flash',
        name: 'glm-5.3-flash',
        input: ['text', 'image'],
        reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
      },
      {
        id: 'claude-sonnet-5-5',
        name: 'claude-sonnet-5-5',
        input: ['text', 'image'],
      },
    ],
  }

  test('flags missing capacities and compat and suggests enriched profiles', () => {
    const audit = auditProvider({ providerId: 'cpa', profile: CPA_PROFILE })
    assert.equal(audit.providerId, 'cpa')
    assert.equal(audit.api, 'openai-completions')
    assert.equal(audit.modelCount, 3)
    assert.equal(audit.suggestions.length, 3)
    assert.ok(audit.issueCount > 0)

    const codes = new Set(audit.issues.map(issue => issue.code))
    for (const code of [
      'missing-context-window',
      'missing-max-tokens',
      'missing-compat',
      'missing-reasoning-efforts',
    ]) {
      assert.ok(codes.has(code), `expected issue code ${code}`)
    }
    for (const issue of audit.issues) {
      assert.equal(typeof issue.message, 'string')
      assert.ok(['warning', 'info', 'error'].includes(issue.severity))
    }

    const deepseek = audit.suggestions.find(suggestion => suggestion.profile.id === 'deepseek-v4.1-flash')
    assert.ok(deepseek.profile.contextWindow > 0)
    assert.ok(deepseek.profile.maxTokens > 0)
    assert.deepEqual(deepseek.profile.reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' })
    assert.equal(deepseek.profile.compat.thinkingFormat, 'deepseek')

    assert.equal(audit.summary.modelCount, 3)
    assert.equal(audit.summary.suggestionCount, 3)
    assert.equal(audit.summary.issueCount, audit.issueCount)
    assert.equal(
      audit.summary.warningCount + audit.summary.infoCount + audit.summary.errorCount,
      audit.issueCount,
    )
    assert.equal(typeof audit.summary.message, 'string')
  })

  test('reasoningEfforts prefers registry/catalog over configured unless manually overridden', () => {
    const registryCache = {
      models: {
        'claude-sonnet-5-5': {
          id: 'claude-sonnet-5-5',
          name: 'Claude Sonnet 5.5',
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          input: ['text', 'image'],
          reasoning: true,
          allowOff: false,
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      },
    }
    const configuredFalse = { id: 'claude-sonnet-5-5', reasoningEfforts: false }
    const healed = enrichModel({ id: 'claude-sonnet-5-5', configured: configuredFalse, registryCache })
    assert.deepEqual(healed.profile.reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
    assert.equal(healed.provenance.reasoningEfforts, 'remote-registry')

    const configuredStaleMap = enrichModel({
      id: 'claude-sonnet-5-5',
      configured: { id: 'claude-sonnet-5-5', reasoningEfforts: { low: 'low', max: 'max' } },
      registryCache,
    })
    assert.deepEqual(configuredStaleMap.profile.reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
    assert.equal(configuredStaleMap.provenance.reasoningEfforts, 'remote-registry')

    const manualOff = enrichModel({
      id: 'claude-sonnet-5-5',
      configured: configuredFalse,
      manualOverride: { reasoningEfforts: false },
      registryCache,
    })
    assert.equal(manualOff.profile.reasoningEfforts, false)
    assert.equal(manualOff.provenance.reasoningEfforts, 'manual')

    const manualCustomMap = enrichModel({
      id: 'claude-sonnet-5-5',
      configured: configuredFalse,
      manualOverride: { reasoningEfforts: { low: 'low', max: 'max' } },
      registryCache,
    })
    assert.deepEqual(manualCustomMap.profile.reasoningEfforts, { low: 'low', max: 'max' })
    assert.equal(manualCustomMap.provenance.reasoningEfforts, 'manual')
  })

  test('reports unknown models and preserves configured reasoning efforts', () => {
    const audit = auditProvider({
      providerId: 'custom',
      profile: {
        api: 'openai-completions',
        models: [
          { id: 'glm-5.3-flash', reasoningEfforts: { low: 'low', high: 'high', max: 'max' } },
          { id: 'totally-unknown-xyz' },
        ],
      },
    })
    assert.ok(audit.issues.some(issue => issue.code === 'unknown-model'))
    const glm = audit.suggestions.find(suggestion => suggestion.profile.id === 'glm-5.3-flash')
    assert.deepEqual(glm.profile.reasoningEfforts, { low: 'low', high: 'high', max: 'max' })
  })

  test('applies sparse per-model overrides', () => {
    const audit = auditProvider({
      providerId: 'custom',
      profile: {
        api: 'openai-completions',
        models: [{ id: 'sample-model-x', name: 'Sample X' }],
      },
      offlineCatalog: CATALOG,
      familyRules: RULES,
      overrides: { models: { 'sample-model-x': { contextWindow: 777777, maxTokens: 12345 } } },
    })
    const suggestion = audit.suggestions[0]
    assert.equal(suggestion.profile.contextWindow, 777777)
    assert.equal(suggestion.profile.maxTokens, 12345)
    assert.equal(suggestion.provenance.contextWindow, 'manual')
    const codes = new Set(audit.issues.map(issue => issue.code))
    assert.equal(codes.has('missing-context-window'), false)
    assert.equal(codes.has('missing-max-tokens'), false)
  })

  test('upstreamModel override binds an unmatched model to a catalog, registry, or rule target while keeping its own id and name', () => {
    const bound = enrichModel({
      id: 'my-relay-alias-v1',
      configured: { id: 'my-relay-alias-v1', name: 'My Relay Alias' },
      manualOverride: { upstreamModel: 'sample-model-x' },
      api: 'openai-completions',
      offlineCatalog: CATALOG,
      familyRules: RULES,
    })
    assert.equal(bound.profile.id, 'my-relay-alias-v1')
    assert.equal(bound.profile.name, 'My Relay Alias')
    assert.equal(bound.profile.contextWindow, 400_000)
    assert.equal(bound.profile.maxTokens, 64_000)
    assert.deepEqual(bound.profile.input, ['text', 'image'])
    assert.deepEqual(bound.profile.reasoningEfforts, { off: null, low: 'low', high: 'high' })
    assert.equal(bound.meta.matchedCatalogId, 'sample-model-x')
    assert.equal(bound.meta.upstreamModel, 'sample-model-x')

    const audit = auditProvider({
      providerId: 'custom',
      profile: {
        api: 'openai-completions',
        models: [{ id: 'my-relay-alias-v1', name: 'My Relay Alias' }],
      },
      offlineCatalog: CATALOG,
      familyRules: RULES,
      overrides: { models: { 'my-relay-alias-v1': { upstreamModel: 'sample-model-x' } } },
    })
    assert.equal(audit.issues.some(issue => issue.code === 'unknown-model'), false)

    const registryOnly = auditProvider({
      providerId: 'custom',
      profile: {
        api: 'openai-completions',
        models: [{ id: 'brand-new-registry-model' }],
      },
      offlineCatalog: EMPTY_CATALOG,
      familyRules: [],
      registryCache: {
        lookup: () => ({ id: 'brand-new-registry-model', contextWindow: 300_000, maxTokens: 32_000, input: ['text', 'image'] }),
      },
    })
    assert.equal(registryOnly.suggestions[0].meta.matchedRegistryId, 'brand-new-registry-model')
    assert.equal(registryOnly.issues.some(issue => issue.code === 'unknown-model'), false)
  })

  test('searchCatalogModels merges online registry and offline catalog entries and ranks matches', () => {
    const result = searchCatalogModels({
      query: 'sample',
      limit: 5,
      offlineCatalog: CATALOG,
      registryCache: {
        listModels: () => [
          { id: 'sample-online-pro', name: 'Sample Online Pro', contextWindow: 500_000, maxTokens: 64_000, input: ['text', 'image'], reasoning: true, source: 'models.dev' },
        ],
      },
    })
    assert.ok(result.total >= 2)
    assert.ok(result.models.some(model => model.id === 'sample-online-pro'))
    assert.ok(result.models.some(model => model.id === 'sample-model-x'))
  })

  test('reports invalid api, invalid models, and failed enrichment', () => {
    const invalidApi = auditProvider({
      providerId: 'broken',
      profile: { api: 'graphql', models: [{ id: 'model-a' }] },
    })
    assert.equal(invalidApi.issues[0].code, 'invalid-api')
    assert.equal(invalidApi.issues[0].severity, 'error')
    assert.equal(invalidApi.suggestions.length, 0)

    const invalidModels = auditProvider({
      providerId: 'broken',
      profile: { api: 'openai-completions', models: [{ name: 'no id' }, { id: 'ok-model' }] },
    })
    assert.ok(invalidModels.issues.some(issue => issue.code === 'invalid-model'))
    assert.equal(invalidModels.summary.failedModelCount, 1)

    const failed = auditProvider({
      providerId: 'custom',
      profile: { api: 'openai-completions', models: [{ id: 'sample-model-x' }] },
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
      overrides: { 'sample-model-x': { name: 42 } },
    })
    assert.ok(failed.issues.some(issue => issue.code === 'invalid-model-profile'))
    assert.equal(failed.suggestions.length, 0)
    assert.equal(failed.summary.failedModelCount, 1)

    assert.throws(
      () => auditProvider({ providerId: 'broken', profile: null }),
      error => error instanceof ApiManagerError && error.code === 'invalid-provider-profile',
    )
  })

  test('passes enrichment warnings through as issues and ranks Zhipu GLM in empty catalog search', () => {
    const audit = auditProvider({
      providerId: 'custom',
      profile: {
        api: 'openai-completions',
        models: [{ id: 'tight-model', contextWindow: 65536, maxTokens: 16384 }],
      },
      offlineCatalog: EMPTY_CATALOG,
      familyRules: RULES,
    })
    assert.ok(audit.issues.some(issue => issue.code === 'compaction-headroom-tight'))

    const search = searchCatalogModels({
      query: '',
      limit: 10,
      offlineCatalog: {
        schemaVersion: 1,
        generatedAt: '2026-11-23T00:00:00.000Z',
        models: {
          'gpt-5': { id: 'gpt-5', name: 'GPT-5', contextWindow: 128000, maxTokens: 16384, input: ['text'], reasoning: false, allowOff: true, efforts: [], source: 'models.dev' },
          'glm-5': { id: 'glm-5', name: 'GLM-5', contextWindow: 200000, maxTokens: 64000, input: ['text', 'image'], reasoning: true, allowOff: true, efforts: ['off', 'high'], source: 'models.dev' },
        },
        aliases: {},
      },
    })
    assert.equal(search.models[0].id, 'glm-5', 'featured Zhipu GLM with reasoning and vision ranks ahead of text-only GPT-5')
  })
})
