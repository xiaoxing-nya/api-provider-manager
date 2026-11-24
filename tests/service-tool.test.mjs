/**
 * Host service and tool tests for `@xiaoxing/api-provider-manager`.
 *
 * An in-memory DSH Host harness stands in for the settings editor, the
 * credential store, the configurable-provider directory, the agent default
 * model, and the launch environment. Network access is always mocked, so the
 * suite exercises onboarding, reserved-route refusal, protocol splitting,
 * IM-ready live sync (cooldown, add-new, mirror, empty-response protection,
 * singleflight, conflict retry), manual overrides, auditing, probing,
 * import/export, and every tool action without leaving the process.
 *
 * Run with `node tests/service-tool.test.mjs` from the package root.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import {
  ApiManagerError,
  ApiManagerService,
  REMOTE_METHOD_DESCRIPTOR,
  REMOTE_METHODS,
  SERVICE_KEY,
  apply,
  inject,
} from '../index.js'
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_PKG,
  LLM_PI_AI_ID,
  LLM_PI_AI_PKG,
  SUBAGENT_SETTINGS_ID,
  SUBAGENT_SETTINGS_PKG,
  classifyProviders,
  describeCredential,
  findNamespaceEntry,
  readPiAiSnapshot,
  resolveCredential,
  setCredential,
  unsetCredential,
} from '../lib/config-sync.js'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from '../lib/enricher.js'
import { maskSecret } from '../lib/importer.js'

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** A chat model served by an OpenAI-compatible relay. */
const FLASH_ENTRY = Object.freeze({
  id: 'deepseek-v4.1-flash',
  name: 'DeepSeek V4.1 Flash',
  context_length: 128_000,
  top_provider: { max_completion_tokens: 16_384 },
  architecture: { input_modalities: ['text', 'image'] },
  supported_parameters: ['reasoning'],
  reasoning: { mandatory: false, supported_efforts: ['low', 'medium', 'high'] },
  supported_endpoint_types: ['openai'],
})

/** An Anthropic-messages model served by the same relay. */
const SONNET_ENTRY = Object.freeze({
  id: 'claude-sonnet-5-5',
  name: 'Claude Sonnet 5.5',
  context_length: 200_000,
  top_provider: { max_completion_tokens: 16_384 },
  architecture: { input_modalities: ['text', 'image'] },
  reasoning: { mandatory: false, supported_efforts: ['low', 'high'] },
  supported_endpoint_types: ['anthropic'],
})

/** A Gemini model served by the same relay. */
const GEMINI_ENTRY = Object.freeze({
  id: 'gemini-4-hydrogen',
  name: 'Gemini 4 Hydrogen',
  context_length: 1_048_576,
  top_provider: { max_completion_tokens: 65_536 },
  architecture: { input_modalities: ['text', 'image'] },
  reasoning: { mandatory: false, supported_efforts: ['low', 'high'] },
  supported_endpoint_types: ['gemini'],
})

/** A model the endpoint publishes that is not configured yet. */
const NEW_ENTRY = Object.freeze({
  id: 'brand-new-model',
  name: 'Brand New Model',
  context_length: 131_072,
  top_provider: { max_completion_tokens: 32_768 },
  architecture: { input_modalities: ['text', 'image'] },
})

/** Minimal models.dev payload used by registry refreshes. */
const MODELS_DEV_PAYLOAD = Object.freeze({
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    models: {
      'deepseek/deepseek-v4.1-flash': {
        id: 'deepseek/deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        canonical_model_id: 'deepseek/deepseek-v4.1-flash',
        reasoning: true,
        limit: { context: 128_000, output: 16_384 },
        modalities: { input: ['text', 'image'] },
      },
    },
  },
})

/** Minimal OpenRouter payload used by registry refreshes. */
const OPEN_ROUTER_PAYLOAD = Object.freeze({
  data: [
    {
      id: 'deepseek/deepseek-v4.1-flash',
      canonical_slug: 'deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek: DeepSeek V4.1 Flash',
      context_length: 128_000,
      top_provider: { context_length: 128_000, max_completion_tokens: 16_384 },
      supported_parameters: ['reasoning'],
      reasoning: { mandatory: false, supported_efforts: ['low', 'high'] },
      architecture: { input_modalities: ['text', 'image'] },
      endpoints: ['/api/v1/chat/completions'],
    },
  ],
})

/** A provider profile accepted by the manager's own validation. */
const SEEDED_PROFILE = Object.freeze({
  displayName: 'Seeded Relay',
  api: 'openai-completions',
  baseURL: 'https://seeded.example/v1',
  apiKeyEnv: 'SEEDED_API_KEY',
  models: [
    {
      id: 'deepseek-v4.1-flash',
      name: 'Seeded Flash',
      contextWindow: 64_000,
      maxTokens: 8_192,
      input: ['text'],
      reasoningEfforts: { off: null, low: 'low' },
    },
  ],
})

/** Tool parameter names required by the Host contract. */
const TOOL_PARAMETERS = Object.freeze([
  'action', 'provider', 'displayName', 'baseURL', 'api', 'presetId', 'apiKey', 'apiKeyEnv',
  'headers', 'models', 'modelId', 'override', 'reset', 'syncMode', 'syncCooldownMs',
  'includePatterns', 'excludePatterns', 'includeNonChat', 'syncToSubagentAllowed', 'force',
  'autoApply', 'splitByProtocol', 'setAsDefault', 'reasoningEffort', 'addToSubagent',
  'enableSubagent', 'removeCredential', 'format', 'payload', 'offlineOnly', 'modelsDevUrl',
  'openRouterUrl', 'checks',
])

/** Temporary plugin data directories created by the suite. */
const TEMP_DIRS = []

/* ------------------------------------------------------------------ */
/* Mocked DSH Host                                                     */
/* ------------------------------------------------------------------ */

/** Deep-copy one JSON-shaped value. */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (value === null || typeof value !== 'object') return value
  const copy = {}
  for (const [key, child] of Object.entries(value)) copy[key] = clone(child)
  return copy
}

/** Whether a value is a plain object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Merge two configuration layers, higher winning per plain-object key. */
function mergeConfig(under, over) {
  const merged = clone(isPlainObject(under) ? under : {})
  for (const [key, value] of Object.entries(isPlainObject(over) ? over : {})) {
    merged[key] = isPlainObject(merged[key]) && isPlainObject(value) ? mergeConfig(merged[key], value) : clone(value)
  }
  return merged
}

/** Apply one settings path operation to a detached configuration object. */
function applyPathOp(node, op) {
  if (op.path.length === 0) return op.op === 'set' ? clone(op.value) : undefined
  const [head, ...rest] = op.path
  const base = isPlainObject(node) ? { ...node } : {}
  if (rest.length === 0) {
    if (op.op === 'set') base[head] = clone(op.value)
    else delete base[head]
    return base
  }
  const child = applyPathOp(base[head], { op: op.op, path: rest, value: op.value })
  if (child === undefined) delete base[head]
  else base[head] = child
  return base
}

/** Build one successful JSON response. */
function jsonResponse(payload, { status = 200 } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Build a settings-conflict error matching the DSH settings seam. */
function conflictError(namespace, expected, actual) {
  return Object.assign(
    new Error(`settings namespace "${namespace}" changed since it was read (expected revision ${expected}, now ${actual})`),
    { name: 'SettingsConflictError', code: 'SETTINGS_CONFLICT', expected, actual },
  )
}

/**
 * In-memory DSH Host: settings editor, credential seam, configurable-provider
 * directory, agent default model, launch environment, and a routed fetch double.
 */
class HostHarness {
  constructor(options = {}) {
    this.clock = { now: Date.parse('2026-01-01T00:00:00.000Z') }
    this.namespaces = new Map()
    this.mutations = []
    this.fetchCalls = []
    this.credentialSets = []
    this.credentialStore = new Map()
    this.emitted = []
    this.logs = []
    this.forcedConflicts = []
    this.conflictsThrown = 0
    this.endpoint = { models: [], status: 200 }
    this.settingsEnabled = options.settings !== false
    this.credentialsEnabled = options.credentials !== false
    this.agentDefaultModelEnabled = options.agentDefaultModel !== false
    this.configurableProviders = Array.isArray(options.configurableProviders) ? options.configurableProviders : []
    this.launchEnvironment = options.launchEnvironment ?? null
    this.addNamespace(LLM_PI_AI_ID, LLM_PI_AI_PKG, { providers: {} })
    this.addNamespace(DEFAULT_MODEL_ID, DEFAULT_MODEL_PKG, { provider: 'seed-provider', model: 'seed-model' })
    this.addNamespace(SUBAGENT_SETTINGS_ID, SUBAGENT_SETTINGS_PKG, { enabled: false, allowedModels: [] })
    for (const [id, config] of Object.entries(options.namespaces ?? {})) {
      const record = this.namespaces.get(id)
      if (record === undefined) this.addNamespace(id, id, config)
      else {
        record.user = clone(config)
        record.revision += 1
      }
    }
    this.settings = {
      describe: descriptorOptions => [...this.namespaces.values()].map(record => this.describe(record, descriptorOptions)),
      mutate: (namespace, ops, expectedRevision) => this.mutate(namespace, ops, expectedRevision),
    }
    this.editor = {
      configuration: () => [...this.namespaces.values()].map(record => ({
        entry: { options: { id: record.id, name: record.name, config: clone(record.user) } },
        inherited: clone(record.base),
        override: clone(record.user),
      })),
      edit: async (entry, change) => {
        const record = this.namespaces.get(entry?.options?.id)
        assert.ok(record, `editor.edit for unknown entry ${String(entry?.options?.id)}`)
        const next = change(clone(record.user), clone(record.base))
        record.user = clone(next)
        record.revision += 1
        this.mutations.push({ ns: record.id, editor: true, revision: record.revision })
      },
    }
    this.credentials = {
      describe: async ref => {
        if (!this.credentialStore.has(ref)) return { configured: false, writable: true }
        return {
          configured: true,
          source: 'file',
          writable: true,
          masked: maskSecret(this.credentialStore.get(ref)),
        }
      },
      resolve: async ref => (this.credentialStore.has(ref)
        ? { value: this.credentialStore.get(ref), source: 'file' }
        : undefined),
      set: async (ref, value) => {
        this.credentialStore.set(ref, value)
        this.credentialSets.push({ ref, value })
      },
      unset: async ref => {
        this.credentialStore.delete(ref)
      },
    }
    this.llm = {
      listConfigurableProviders: () => clone(this.configurableProviders),
    }
    this.agentDefaultModel = {
      currentSelection: () => {
        const record = this.namespace(DEFAULT_MODEL_ID)
        return {
          provider: record.user.provider,
          model: record.user.model,
          ...(record.user.reasoningEffort === undefined ? {} : { reasoningEffort: record.user.reasoningEffort }),
        }
      },
      saveSelection: async selection => {
        const record = this.namespace(DEFAULT_MODEL_ID)
        record.user = {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(selection.reasoningEffort) }),
        }
        record.revision += 1
        this.mutations.push({ ns: record.id, saveSelection: true, revision: record.revision })
      },
    }
    this.deps = {
      getSettings: () => (this.settingsEnabled ? this.settings : undefined),
      getEditor: () => this.editor,
      getCredentials: () => (this.credentialsEnabled ? this.credentials : undefined),
      getLlm: () => this.llm,
      getAgentDefaultModel: () => (this.agentDefaultModelEnabled ? this.agentDefaultModel : undefined),
      getLaunchEnvironment: () => this.launchEnvironment ?? undefined,
      emitSynced: payload => this.emitted.push(payload),
      log: message => this.logs.push(String(message)),
    }
    this.fetchImpl = async (url, init = {}) => {
      const text = String(url)
      this.fetchCalls.push({ url: text, init })
      if (text.includes('models.dev')) return jsonResponse(MODELS_DEV_PAYLOAD)
      if (text.includes('openrouter.ai')) return jsonResponse(OPEN_ROUTER_PAYLOAD)
      const method = typeof init.method === 'string' ? init.method.toUpperCase() : 'GET'
      if (this.endpoint.status !== 200) {
        return jsonResponse({ error: { message: 'upstream failure' } }, { status: this.endpoint.status })
      }
      if (method === 'GET') {
        return jsonResponse({ object: 'list', data: this.endpoint.models.map(entry => clone(entry)) })
      }
      return jsonResponse({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
  }

  /** Create one settings namespace record. */
  addNamespace(id, name, config) {
    this.namespaces.set(id, { id, name, base: {}, user: clone(config), revision: 0 })
  }

  /** Read one settings namespace record. */
  namespace(id) {
    const record = this.namespaces.get(id)
    assert.ok(record, `missing settings namespace ${id}`)
    return record
  }

  /** Build one settings descriptor. */
  describe(record, options = {}) {
    const value = mergeConfig(record.base, record.user)
    return {
      autoGenerate: true,
      ns: record.id,
      schema: {},
      revision: record.revision,
      applies: 'live',
      value,
      base: clone(record.base),
      user: clone(record.user),
      ...(options.redactSecrets ? { secrets: [] } : {}),
    }
  }

  /** Apply one settings mutation, honoring forced conflicts and revisions. */
  async mutate(namespace, ops, expectedRevision) {
    const record = this.namespaces.get(namespace)
    assert.ok(record, `settings.mutate for unknown namespace ${namespace}`)
    const forced = this.forcedConflicts.indexOf(namespace)
    if (forced >= 0) {
      this.forcedConflicts.splice(forced, 1)
      this.conflictsThrown += 1
      throw conflictError(namespace, expectedRevision ?? record.revision, record.revision)
    }
    if (expectedRevision !== undefined && expectedRevision !== record.revision) {
      throw conflictError(namespace, expectedRevision, record.revision)
    }
    let next = clone(record.user)
    for (const op of ops) next = applyPathOp(next, op)
    record.user = next
    record.revision += 1
    this.mutations.push({ ns: namespace, ops: clone(ops), revision: record.revision })
  }

  /** Replace the configured llm-pi-ai providers. */
  setProviders(providers) {
    const record = this.namespace(LLM_PI_AI_ID)
    record.user = { providers: clone(providers) }
    record.revision += 1
  }

  /** Read the configured llm-pi-ai providers. */
  providers() {
    return this.namespace(LLM_PI_AI_ID).user.providers ?? {}
  }

  /** Replace the endpoint listing the fetch double serves. */
  setEndpoint(models, status = 200) {
    this.endpoint = { models: clone(models), status }
  }

  /** Advance the injected clock. */
  advance(milliseconds) {
    this.clock.now += milliseconds
  }

  /** Count endpoint listing GET requests. */
  listingFetches() {
    return this.fetchCalls.filter(call => {
      const method = typeof call.init?.method === 'string' ? call.init.method.toUpperCase() : 'GET'
      return method === 'GET' && String(call.url).endsWith('/models')
    }).length
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Create a temporary plugin data directory owned by the suite. */
async function makeDataDir() {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoxing-api-manager-test-'))
  TEMP_DIRS.push(directory)
  return directory
}

/** Create a service wired to one harness. */
async function createService(harness, overrides = {}) {
  const dataDir = overrides.dataDir ?? await makeDataDir()
  return new ApiManagerService({
    dataDir,
    deps: harness.deps,
    fetchImpl: harness.fetchImpl,
    now: () => harness.clock.now,
    timeoutMs: 2_000,
    syncCooldownMs: 30_000,
    ...overrides,
  })
}

/** Read one plugin store document. */
async function readStore(service, fileName) {
  return JSON.parse(await readFile(join(service.dataDir, fileName), 'utf8'))
}

/** Read one provider's persisted sync state. */
async function syncStateOf(service, providerId) {
  try {
    const data = await readStore(service, 'sync-state.json')
    return isPlainObject(data.providers) && isPlainObject(data.providers[providerId]) ? data.providers[providerId] : null
  } catch {
    return null
  }
}

/** Seed one custom provider into the llm-pi-ai namespace. */
function seedProvider(harness, providerId, profile = SEEDED_PROFILE) {
  const providers = harness.providers()
  providers[providerId] = clone(profile)
  harness.setProviders(providers)
}

/** Create the plugin through `apply()` against one harness. */
async function createApplyHarness(harness, { syncCooldownMs = 0, config = {} } = {}) {
  const dataDir = await makeDataDir()
  const services = new Map([
    ['settings', harness.settings],
    ['configEditor', harness.editor],
    ['credentials', harness.credentials],
    ['llm', harness.llm],
    ['agentDefaultModel', harness.agentDefaultModel],
  ])
  const provided = new Map()
  const disposers = []
  const events = []
  const logs = []
  const ctx = {
    get: name => services.get(name),
    provide: (key, value) => {
      provided.set(key, value)
      services.set(key, value)
      return () => {
        provided.delete(key)
        services.delete(key)
      }
    },
    effect: callback => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    tools: {
      tool: undefined,
      register(tool) {
        this.tool = tool
        return () => {
          this.tool = undefined
        }
      },
    },
    emit: (event, payload) => events.push({ event, payload }),
    logger: { warn: message => logs.push(String(message)) },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = harness.fetchImpl
  try {
    apply(ctx, { dataDir, timeoutMs: 2_000, syncCooldownMs, ...config })
  } finally {
    globalThis.fetch = originalFetch
  }
  const service = provided.get(SERVICE_KEY)
  assert.ok(service instanceof ApiManagerService, 'apply must provide the service')
  assert.ok(ctx.tools.tool, 'apply must register the tool')
  return { ctx, dataDir, disposers, events, logs, provided, service, tool: ctx.tools.tool }
}

/** Call one tool action and return its envelope. */
async function runTool(tool, args) {
  const result = await tool.execute(args, { signal: new AbortController().signal })
  assert.equal(typeof result.ok, 'boolean')
  assert.equal(typeof result.summary, 'string')
  return result
}

/** JSON-safe rendering of a value for secret-leak assertions. */
function rendered(value) {
  return JSON.stringify(value)
}

/* ------------------------------------------------------------------ */
/* Config synchronization primitives                                   */
/* ------------------------------------------------------------------ */

describe('config synchronization', () => {
  test('findNamespaceEntry resolves settings descriptors and the editor fallback', async () => {
    const harness = new HostHarness()
    const viaSettings = findNamespaceEntry(harness.deps, LLM_PI_AI_ID, LLM_PI_AI_PKG)
    assert.equal(viaSettings?.source, 'settings')
    assert.equal(viaSettings.ns, LLM_PI_AI_ID)
    assert.equal(typeof viaSettings.revision, 'number')

    const editorHarness = new HostHarness({ settings: false })
    const viaEditor = findNamespaceEntry(editorHarness.deps, LLM_PI_AI_ID, LLM_PI_AI_PKG)
    assert.equal(viaEditor?.source, 'editor')
    assert.equal(viaEditor.ns, LLM_PI_AI_ID)
    assert.equal(findNamespaceEntry(editorHarness.deps, 'vendor/unknown', '@vendor/unknown'), undefined)
  })

  test('findNamespaceEntry accepts configuration rows returned by a settings describe', () => {
    const deps = {
      getSettings: () => ({
        describe: () => [{
          entry: { options: { id: LLM_PI_AI_ID, name: LLM_PI_AI_PKG } },
          inherited: { providers: { 'legacy-relay': clone(SEEDED_PROFILE) } },
          override: {},
          revision: 7,
        }],
      }),
    }
    const found = findNamespaceEntry(deps, LLM_PI_AI_ID, LLM_PI_AI_PKG)
    assert.equal(found?.source, 'editor')
    assert.equal(found.revision, 7)
    const snapshot = readPiAiSnapshot(deps)
    assert.equal(snapshot.available, true)
    assert.ok(snapshot.providers['legacy-relay'])
  })

  test('readPiAiSnapshot reports missing configuration instead of throwing', () => {
    const harness = new HostHarness()
    const snapshot = readPiAiSnapshot(harness.deps)
    assert.equal(snapshot.available, true)
    assert.deepEqual(snapshot.providers, {})

    harness.namespaces.delete(LLM_PI_AI_ID)
    const missing = readPiAiSnapshot(harness.deps)
    assert.equal(missing.available, false)
    assert.match(missing.error ?? '', /llm-pi-ai/)
  })

  test('classifyProviders keeps custom routes and reports reserved namespaces', () => {
    const harness = new HostHarness({
      configurableProviders: [
        { provider: 'declared-route', declared: true },
        { provider: 'catalog-route', declared: false },
      ],
    })
    harness.setProviders({
      'deepseek-official': SEEDED_PROFILE,
      openai: SEEDED_PROFILE,
      'catalog-route': SEEDED_PROFILE,
      'custom-relay': SEEDED_PROFILE,
    })
    const { customProviders, reservedProviders } = classifyProviders(readPiAiSnapshot(harness.deps))
    assert.deepEqual(customProviders.map(entry => entry.provider), ['custom-relay'])
    assert.deepEqual(reservedProviders.map(entry => entry.provider).sort(), ['catalog-route', 'deepseek-official', 'openai'])
    assert.equal(reservedProviders.find(entry => entry.provider === 'deepseek-official')?.category, 'native')
    assert.equal(reservedProviders.find(entry => entry.provider === 'openai')?.category, 'builtin-catalog')
    assert.equal(reservedProviders.find(entry => entry.provider === 'catalog-route')?.reason, 'provider id "catalog-route" is already offered by the DSH configuration')
  })

  test('credential wrappers store, describe, resolve, and remove without echoing the secret', async () => {
    const harness = new HostHarness()
    const secret = 'sk-primitive-secret-0123456789'
    const stored = await setCredential(harness.deps, 'PRIMITIVE_API_KEY', secret)
    assert.deepEqual(stored, { ref: 'PRIMITIVE_API_KEY', stored: true })
    assert.equal(harness.credentialStore.get('PRIMITIVE_API_KEY'), secret)

    const described = await describeCredential(harness.deps, 'PRIMITIVE_API_KEY')
    assert.equal(described.available, true)
    assert.equal(described.configured, true)
    assert.equal(described.writable, true)
    assert.equal(described.source, 'file')
    assert.notEqual(described.masked, secret)
    assert.ok(!String(described.masked).includes(secret))

    const resolved = await resolveCredential(harness.deps, 'PRIMITIVE_API_KEY')
    assert.deepEqual(resolved, { value: secret, source: 'file' })

    await unsetCredential(harness.deps, 'PRIMITIVE_API_KEY')
    assert.equal(harness.credentialStore.has('PRIMITIVE_API_KEY'), false)
    assert.equal((await describeCredential(harness.deps, 'PRIMITIVE_API_KEY')).configured, false)
  })

  test('credential wrappers read the launch environment read-only without the credential seam', async () => {
    const harness = new HostHarness({
      credentials: false,
      launchEnvironment: { get: name => (name === 'LAUNCH_API_KEY' ? { value: 'launch-secret-value', source: 'user-env' } : undefined) },
    })
    const described = await describeCredential(harness.deps, 'LAUNCH_API_KEY')
    assert.equal(described.configured, true)
    assert.equal(described.writable, false)
    assert.equal(described.source, 'user-env')
    assert.ok(!String(described.masked).includes('launch-secret-value'))
    assert.deepEqual(await resolveCredential(harness.deps, 'LAUNCH_API_KEY'), { value: 'launch-secret-value', source: 'user-env' })
    await assert.rejects(
      () => setCredential(harness.deps, 'LAUNCH_API_KEY', 'another-secret'),
      error => error instanceof ApiManagerError && error.code === 'credentials-unavailable',
    )
  })

  test('setCredential rejects unusable key values', async () => {
    const harness = new HostHarness()
    for (const value of ['', '  padded  ', 'line\nbreak']) {
      await assert.rejects(
        () => setCredential(harness.deps, 'BAD_KEY', value),
        error => error instanceof ApiManagerError && error.code === 'invalid-api-key',
      )
    }
  })

  test('credential write failures redact the secret value', async () => {
    const harness = new HostHarness()
    const secret = 'sk-leaky-write-failure-2468'
    const service = await createService(harness, {
      deps: {
        ...harness.deps,
        getCredentials: () => ({
          ...harness.credentials,
          set: async (_ref, value) => {
            throw new Error(`store rejected ${value}`)
          },
        }),
      },
    })
    try {
      const result = await service.upsertProvider({
        provider: 'leaky-relay',
        baseURL: 'https://leaky.example/v1',
        api: 'openai-completions',
        apiKey: secret,
        models: ['deepseek-v4.1-flash'],
      })
      assert.equal(result.ok, false)
      assert.equal(result.code, 'credential-write-failed')
      assert.ok(!rendered(result).includes(secret), 'the failure envelope must not echo the secret')
      assert.equal(harness.providers()['leaky-relay'], undefined, 'a failed credential write must not persist the profile')
    } finally {
      service.dispose()
    }
  })
})

/* ------------------------------------------------------------------ */
/* Reserved route protection                                           */
/* ------------------------------------------------------------------ */

describe('reserved provider protection', () => {
  const RESERVED_IDS = ['deepseek-official', 'deepseek-account', 'openai', 'anthropic', 'deepseek']

  test('service mutations refuse native and built-in routes', async () => {
    const harness = new HostHarness()
    const service = await createService(harness)
    try {
      for (const provider of RESERVED_IDS) {
        const upsert = await service.upsertProvider({
          provider,
          baseURL: 'https://reserved.example/v1',
          api: 'openai-completions',
          models: ['some-model'],
        })
        assert.equal(upsert.ok, false)
        assert.equal(upsert.code, 'reserved-native-provider')

        const removed = await service.removeProvider({ provider })
        assert.equal(removed.ok, false)
        assert.equal(removed.code, 'reserved-native-provider')

        const synced = await service.syncProviderModels({ provider, force: true })
        assert.equal(synced.ok, false)
        assert.equal(synced.code, 'reserved-native-provider')

        const policy = await service.setSyncPolicy({ provider, policy: { syncMode: 'mirror' } })
        assert.equal(policy.ok, false)
        assert.equal(policy.code, 'reserved-native-provider')
      }
      assert.deepEqual(harness.providers(), {})
    } finally {
      service.dispose()
    }
  })

  test('the tool reports reserved-route refusal for every mutating action', async () => {
    const harness = new HostHarness()
    const applied = await createApplyHarness(harness)
    const provider = 'deepseek-official'
    const cases = [
      { action: 'upsertProvider', provider, baseURL: 'https://reserved.example/v1', models: ['m'] },
      { action: 'removeProvider', provider },
      { action: 'syncProviderModels', provider, force: true },
      { action: 'saveOverride', provider, modelId: 'm', override: { maxTokens: 1024 } },
      { action: 'resetOverride', provider, modelId: 'm' },
    ]
    for (const args of cases) {
      const result = await runTool(applied.tool, args)
      assert.equal(result.ok, false, `action ${args.action} must refuse a reserved provider`)
      assert.match(result.summary, /reserved-native-provider/)
    }
    assert.ok(!rendered(await runTool(applied.tool, { action: 'status' })).includes('reserved-native-provider: provider id'))
    for (const dispose of applied.disposers.reverse()) dispose()
  })
})

/* ------------------------------------------------------------------ */
/* Onboarding                                                          */
/* ------------------------------------------------------------------ */

describe('custom provider onboarding', () => {
  test('discover -> upsert keeps the API key in the credential store only', async () => {
    const harness = new HostHarness()
    harness.setEndpoint([FLASH_ENTRY])
    const service = await createService(harness)
    const secret = 'sk-onboarding-secret-1234'
    try {
      const discovery = await service.discover({
        baseURL: 'https://relay.example/v1',
        api: 'openai-completions',
        apiKey: secret,
      })
      assert.equal(discovery.ok, true)
      assert.equal(discovery.models.length, 1)
      assert.equal(discovery.models[0].id, 'deepseek-v4.1-flash')
      assert.ok(!rendered(discovery).includes(secret), 'discovery must never echo the API key')

      const upserted = await service.upsertProvider({
        provider: 'xiaoxing-relay',
        displayName: 'Xiaoxing Relay',
        baseURL: 'https://relay.example/v1',
        api: 'openai-completions',
        apiKey: secret,
        models: discovery.models,
        setAsDefault: { model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
        addToSubagent: ['deepseek-v4.1-flash'],
        enableSubagent: true,
        syncPolicy: { syncMode: 'add-new', syncToSubagentAllowed: true },
      })
      assert.equal(upserted.ok, true)
      assert.equal(upserted.credentialStored, true)
      assert.equal(upserted.credential?.configured, true)
      assert.equal(harness.credentialStore.get('XIAOXING_RELAY_API_KEY'), secret)

      const profile = harness.providers()['xiaoxing-relay']
      assert.equal(profile.apiKeyEnv, 'XIAOXING_RELAY_API_KEY')
      assert.equal(Object.hasOwn(profile, 'apiKey'), false)
      assert.equal(profile.displayName, 'Xiaoxing Relay')
      assert.ok(!rendered(profile).includes(secret), 'configuration must never carry the API key')
      assert.ok(!rendered(upserted).includes(secret), 'the Remote result must never carry the API key')

      const status = await service.status({})
      assert.equal(status.ok, true)
      assert.equal(status.customProviderCount, 1)
      assert.ok(!rendered(status).includes(secret), 'status must never carry the API key')

      const listed = await service.listCustomProviders({})
      assert.equal(listed.providers.length, 1)
      assert.equal(listed.providers[0].credential.configured, true)
      assert.equal(listed.providers[0].syncPolicy.syncMode, 'add-new')
      assert.equal(listed.providers[0].syncPolicy.syncToSubagentAllowed, true)
      assert.equal(typeof listed.providers[0].audit?.modelCount, 'number')
      assert.ok(!rendered(listed).includes(secret), 'the provider list must never carry the API key')

      assert.ok(!rendered(harness.logs).includes(secret), 'logs must never carry the API key')
      for (const fileName of ['sync-state.json', 'overrides.json']) {
        let text
        try {
          text = await readFile(join(service.dataDir, fileName), 'utf8')
        } catch {
          continue
        }
        assert.ok(!text.includes(secret), `${fileName} must never carry the API key`)
      }

      const defaults = harness.namespace(DEFAULT_MODEL_ID).user
      assert.deepEqual(defaults, {
        provider: 'xiaoxing-relay',
        model: 'deepseek-v4.1-flash',
        reasoningEffort: 'high',
      })

      const subagent = harness.namespace(SUBAGENT_SETTINGS_ID).user
      assert.equal(subagent.enabled, true)
      assert.deepEqual(subagent.allowedModels, [{ provider: 'xiaoxing-relay', model: 'deepseek-v4.1-flash' }])

      const policy = await service.getRegistryStatus({})
      assert.equal(policy.ok, true)
    } finally {
      service.dispose()
    }
  })

  test('discover and probe resolve an existing profile credential internally', async () => {
    const harness = new HostHarness()
    harness.setEndpoint([FLASH_ENTRY])
    seedProvider(harness, 'seeded-relay')
    const secret = 'sk-seeded-env-secret-3333'
    harness.credentialStore.set('SEEDED_API_KEY', secret)
    const service = await createService(harness)
    try {
      const discovery = await service.discover({ provider: 'seeded-relay' })
      assert.equal(discovery.ok, true)
      assert.equal(discovery.models.length, 1)
      const requestHeaders = harness.fetchCalls.at(-1)?.init?.headers
      assert.equal(requestHeaders.get('authorization'), `Bearer ${secret}`)
      assert.ok(!rendered(discovery).includes(secret))

      const probe = await service.probe({ provider: 'seeded-relay', checks: ['connectivity'] })
      assert.equal(probe.ok, true)
      assert.equal(probe.healthy, true)
      assert.ok(!rendered(probe).includes(secret))

      const missing = await service.discover({ provider: 'not-configured' })
      assert.equal(missing.ok, false)
      assert.equal(missing.code, 'provider-not-found')
    } finally {
      service.dispose()
    }
  })

  test('an update preserves untouched fields and can remove the stored key', async () => {
    const harness = new HostHarness()
    harness.setEndpoint([FLASH_ENTRY])
    seedProvider(harness, 'relay-one', {
      ...SEEDED_PROFILE,
      headers: { 'x-routing': 'eu' },
      transport: 'sse',
    })
    harness.credentialStore.set('SEEDED_API_KEY', 'sk-seeded-value-9999')
    const service = await createService(harness)
    try {
      const updated = await service.upsertProvider({
        provider: 'relay-one',
        displayName: 'Renamed Relay',
        models: ['deepseek-v4.1-flash'],
      })
      assert.equal(updated.ok, true)
      assert.equal(updated.created, false)
      const profile = harness.providers()['relay-one']
      assert.equal(profile.displayName, 'Renamed Relay')
      assert.equal(profile.apiKeyEnv, 'SEEDED_API_KEY')
      assert.deepEqual(profile.headers, { 'x-routing': 'eu' })
      assert.equal(profile.transport, 'sse')

      const removed = await service.upsertProvider({ provider: 'relay-one', removeCredential: true })
      assert.equal(removed.ok, true)
      assert.equal(removed.credentialRemoved, true)
      assert.equal(harness.credentialStore.has('SEEDED_API_KEY'), false)
      assert.equal(Object.hasOwn(harness.providers()['relay-one'], 'apiKeyEnv'), false)
    } finally {
      service.dispose()
    }
  })

  test('editor saves recompute automatic values and persist only manual capabilities', async () => {
    const harness = new HostHarness()
    const service = await createService(harness)
    const provider = 'metadata-relay'
    const id = 'relay-reference-model'
    const automaticId = 'relay-automatic-model'
    const publishRegistry = (contextWindow, maxTokens, efforts) => {
      service.registryCache = { models: Object.fromEntries([id, automaticId].map(modelId => [modelId, {
        id: modelId, name: 'Reference Model', contextWindow, maxTokens,
        input: ['text', 'image'], reasoning: true, efforts,
      }])) }
    }
    try {
      await service.initialize()
      await service.refreshRegistry({ offlineOnly: true })
      publishRegistry(128_000, 16_384, ['low'])
      const preview = await service.enrich({ models: [id, automaticId] })
      assert.equal(preview.models[0].profile.contextWindow, 128_000)

      publishRegistry(256_000, 32_768, ['high'])
      const saved = await service.upsertProvider({
        provider, baseURL: 'https://metadata.example/v1',
        models: [
          { ...preview.models[0].profile, maxTokens: 8_192, reasoningEfforts: false, manualFields: { maxTokens: true, reasoningEfforts: true } },
          { ...preview.models[1].profile, manualFields: {}, discovered: { contextWindow: 180_000 } },
        ],
      })
      assert.equal(saved.ok, true, rendered(saved))
      const [manual, automatic] = harness.providers()[provider].models
      assert.equal(manual.contextWindow, 256_000)
      assert.equal(manual.maxTokens, 8_192)
      assert.equal(manual.reasoningEfforts, false)
      assert.equal(automatic.contextWindow, 180_000, 'real endpoint facts stay above the catalog')
      assert.equal(automatic.maxTokens, 32_768)
      assert.deepEqual(automatic.reasoningEfforts, { off: null, high: 'high' })
      assert.equal(Object.hasOwn(automatic, 'discovered') || Object.hasOwn(automatic, 'manualFields'), false)
      const overrides = await readStore(service, 'overrides.json')
      assert.deepEqual(overrides.providers[provider].models[id], { maxTokens: 8192, reasoningEfforts: false })

      publishRegistry(300_000, 48_000, ['medium'])
      const rematched = await service.enrich({ provider })
      assert.equal(rematched.ok, true, rendered(rematched))
      assert.equal(rematched.models[0].profile.maxTokens, 8192)
      assert.equal(rematched.models[0].provenance.reasoningEfforts, 'manual')
      assert.equal(rematched.models[1].profile.contextWindow, 300_000)
      assert.deepEqual(rematched.models[1].profile.reasoningEfforts, { off: null, medium: 'medium' })
      assert.equal(rematched.models[1].provenance.reasoningEfforts, 'remote-registry')

      // An unsuccessful profile write restores the previous sparse overrides.
      harness.forcedConflicts.push(LLM_PI_AI_ID, LLM_PI_AI_ID)
      const rejected = await service.upsertProvider({ provider, models: [
        { id, maxTokens: 4_096, manualFields: { maxTokens: true } },
        { id: automaticId, manualFields: {} },
      ] })
      assert.equal(rejected.code, 'config-conflict')
      assert.deepEqual(await readStore(service, 'overrides.json'), overrides)
      assert.deepEqual(harness.providers()[provider].models, [manual, automatic])
    } finally {
      service.dispose()
    }
  })

  test('refresh enrich and rematch save recover stale configured reasoningEfforts:false while preserving manual overrides', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'stale-relay', {
      ...SEEDED_PROFILE,
      models: [
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], reasoningEfforts: false },
        { id: 'gpt-6-astra-cc-format', name: 'GPT 6', contextWindow: 64_000, maxTokens: 8_192, input: ['text'], reasoningEfforts: false },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200_000, maxTokens: 64_000, input: ['text', 'image'], reasoningEfforts: false },
      ],
    })
    const service = await createService(harness)
    try {
      await service.initialize()
      await service.refreshRegistry({ offlineOnly: true })
      service.registryCache = {
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
          'claude-sonnet-4-6': {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            contextWindow: 200_000,
            maxTokens: 64_000,
            input: ['text', 'image'],
            reasoning: true,
            allowOff: true,
            efforts: ['off', 'low', 'medium', 'high', 'max'],
          },
        },
      }
      // Explicitly disable reasoning on claude-sonnet-4-6 via manual override.
      const disabled = await service.saveOverride({
        provider: 'stale-relay',
        model: 'claude-sonnet-4-6',
        override: { reasoningEfforts: false },
      })
      assert.equal(disabled.ok, true, rendered(disabled))

      // Explicit refresh ignores stale configured values for both registry-matched and rule-only models.
      const refreshed = await service.enrich({
        provider: 'stale-relay',
        refresh: true,
        models: [{ id: 'claude-sonnet-5-5' }, { id: 'gpt-6-astra-cc-format' }, { id: 'claude-sonnet-4-6' }],
      })
      assert.equal(refreshed.ok, true, rendered(refreshed))
      const byId = Object.fromEntries(refreshed.models.map(item => [item.id, item]))
      assert.deepEqual(byId['claude-sonnet-5-5'].profile.reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
      assert.equal(byId['claude-sonnet-5-5'].provenance.reasoningEfforts, 'remote-registry')
      assert.equal(isPlainObject(byId['gpt-6-astra-cc-format'].profile.reasoningEfforts), true)
      assert.equal(byId['gpt-6-astra-cc-format'].provenance.reasoningEfforts, 'heuristic')
      assert.equal(byId['claude-sonnet-4-6'].profile.reasoningEfforts, false)
      assert.equal(byId['claude-sonnet-4-6'].provenance.reasoningEfforts, 'manual')

      // Saving the rematched edit form persists the refreshed reasoning tiers and strips internal flags.
      const saved = await service.upsertProvider({
        provider: 'stale-relay',
        models: [
          { id: 'claude-sonnet-5-5', manualFields: {}, rematch: true },
          { id: 'gpt-6-astra-cc-format', manualFields: {}, rematch: true },
          { id: 'claude-sonnet-4-6', manualFields: {}, rematch: true },
        ],
      })
      assert.equal(saved.ok, true, rendered(saved))
      const persisted = Object.fromEntries(harness.providers()['stale-relay'].models.map(model => [model.id, model]))
      assert.deepEqual(persisted['claude-sonnet-5-5'].reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
      assert.equal(isPlainObject(persisted['gpt-6-astra-cc-format'].reasoningEfforts), true)
      assert.equal(persisted['claude-sonnet-4-6'].reasoningEfforts, false)
      assert.equal(Object.hasOwn(persisted['claude-sonnet-5-5'], 'rematch'), false)
    } finally {
      service.dispose()
    }
  })

  test('rule-only models stay available for upstream binding', async () => {
    const harness = new HostHarness()
    const id = 'gpt-5.5-gateway-only'
    seedProvider(harness, 'rule-relay', { ...SEEDED_PROFILE, models: [{ id }] })
    const service = await createService(harness)
    try {
      const listed = await service.listCustomProviders({})
      assert.equal(listed.ok, true)
      const row = listed.providers[0]
      assert.deepEqual(row.unmatchedModels, [id])
      assert.equal(row.models[0].match.matchedRuleId, 'gpt-5')
      assert.equal(row.models[0].match.matchedCatalogId, null)
      assert.equal(row.models[0].match.matchedRegistryId, null)
    } finally {
      service.dispose()
    }
  })

  test('update works through the configuration editor when the settings service is absent', async () => {
    const harness = new HostHarness({ settings: false })
    const service = await createService(harness)
    try {
      const created = await service.upsertProvider({
        provider: 'editor-relay',
        baseURL: 'https://editor.example/v1',
        api: 'openai-completions',
        apiKeyEnv: 'EDITOR_API_KEY',
        models: ['deepseek-v4.1-flash'],
      })
      assert.equal(created.ok, true)
      assert.equal(harness.providers()['editor-relay'].apiKeyEnv, 'EDITOR_API_KEY')
      assert.ok(harness.mutations.some(mutation => mutation.editor === true), 'the editor fallback must be used')

      const renamed = await service.upsertProvider({ provider: 'editor-relay', displayName: 'Editor Renamed' })
      assert.equal(renamed.ok, true)
      const updated = harness.providers()['editor-relay']
      assert.equal(updated.displayName, 'Editor Renamed')
      assert.equal(updated.apiKeyEnv, 'EDITOR_API_KEY')
      assert.deepEqual(updated.models.map(model => model.id), ['deepseek-v4.1-flash'])

      const selected = await service.setDefaults({
        provider: 'editor-relay',
        model: 'deepseek-v4.1-flash',
      })
      assert.equal(selected.ok, true)
      assert.equal(harness.namespace(DEFAULT_MODEL_ID).user.provider, 'editor-relay')
    } finally {
      service.dispose()
    }
  })
})

/* ------------------------------------------------------------------ */
/* Protocol split                                                      */
/* ------------------------------------------------------------------ */

describe('protocol split', () => {
  test('splitByProtocol creates one linked route per protocol sharing the credential reference', async () => {
    const harness = new HostHarness()
    harness.setEndpoint([FLASH_ENTRY, SONNET_ENTRY, GEMINI_ENTRY])
    const secret = 'sk-split-secret-4242'
    const service = await createService(harness)
    try {
      const discovery = await service.discover({
        baseURL: 'https://trio.example/v1',
        api: 'openai-completions',
      })
      assert.equal(discovery.ok, true)
      assert.equal(discovery.models.length, 3)
      const result = await service.upsertProvider({
        provider: 'trio-relay',
        displayName: 'Trio Relay',
        baseURL: 'https://trio.example/v1',
        api: 'openai-completions',
        apiKey: secret,
        splitByProtocol: true,
        models: discovery.models,
      })
      assert.equal(result.ok, true)
      assert.equal(result.split, true)
      assert.deepEqual(result.groups.map(group => group.api).sort(), ['anthropic-messages', 'google-generative-ai', 'openai-completions'])
      const providers = harness.providers()
      const ids = Object.keys(providers).sort()
      assert.deepEqual(ids, ['trio-relay', 'trio-relay-anthropic', 'trio-relay-gemini'])
      for (const id of ids) {
        assert.equal(providers[id].apiKeyEnv, 'TRIO_RELAY_API_KEY')
        assert.equal(Object.hasOwn(providers[id], 'apiKey'), false)
      }
      assert.deepEqual(providers['trio-relay'].models.map(model => model.id), ['deepseek-v4.1-flash'])
      assert.deepEqual(providers['trio-relay-anthropic'].models.map(model => model.id), ['claude-sonnet-5-5'])
      assert.deepEqual(providers['trio-relay-gemini'].models.map(model => model.id), ['gemini-4-hydrogen'])
      assert.equal(harness.credentialStore.get('TRIO_RELAY_API_KEY'), secret)
      assert.ok(!rendered(result).includes(secret))
      assert.ok(!rendered(providers).includes(secret))
    } finally {
      service.dispose()
    }
  })
  test('a single protocol keeps the requested route id when split is requested', async () => {
    const harness = new HostHarness()
    harness.setEndpoint([SONNET_ENTRY])
    const service = await createService(harness)
    try {
      const discovery = await service.discover({ baseURL: 'https://solo.example/v1', api: 'openai-completions' })
      const result = await service.upsertProvider({
        provider: 'solo-anthropic',
        displayName: 'Solo Anthropic',
        baseURL: 'https://solo.example/v1',
        api: 'openai-completions',
        apiKeyEnv: 'SOLO_API_KEY',
        splitByProtocol: true,
        models: discovery.models,
      })
      assert.equal(result.ok, true)
      assert.equal(result.split, false)
      assert.equal(result.groups.length, 1)
      assert.equal(result.groups[0].provider, 'solo-anthropic')
      assert.equal(result.groups[0].api, 'anthropic-messages')
      const profile = harness.providers()['solo-anthropic']
      assert.equal(profile.api, 'anthropic-messages')
      assert.equal(profile.displayName, 'Solo Anthropic')
      assert.equal(profile.apiKeyEnv, 'SOLO_API_KEY')
    } finally {
      service.dispose()
    }
  })
})

/* ------------------------------------------------------------------ */
/* IM-ready live sync                                                  */
/* ------------------------------------------------------------------ */

describe('live model sync', () => {
  test('a fresh sync applies in add-new mode and a second call serves the cooldown cache', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'sync-relay', {
      ...SEEDED_PROFILE,
      models: [{ id: 'deepseek-v4.1-flash', name: 'Custom Flash', contextWindow: 64_000, maxTokens: 8_192, input: ['text'] }],
    })
    harness.setEndpoint([FLASH_ENTRY, NEW_ENTRY])
    const service = await createService(harness)
    try {
      const first = await service.syncProviderModels({ provider: 'sync-relay' })
      assert.equal(first.ok, true)
      assert.equal(first.source, 'live')
      assert.equal(first.applied, true)
      assert.equal(first.mode, 'add-new')
      assert.deepEqual(first.diff.added, ['brand-new-model'])
      assert.deepEqual(first.diff.removed, [])
      const models = harness.providers()['sync-relay'].models
      assert.deepEqual(models.map(model => model.id), ['deepseek-v4.1-flash', 'brand-new-model'])
      assert.deepEqual(models[0], { id: 'deepseek-v4.1-flash', name: 'Custom Flash', contextWindow: 64_000, maxTokens: 8_192, input: ['text'] })
      assert.equal(models[1].contextWindow, 131_072)
      assert.equal(models[1].maxTokens, 32_768)
      assert.deepEqual(models[1].input, ['text', 'image'])

      const fetches = harness.listingFetches()
      const second = await service.syncProviderModels({ provider: 'sync-relay' })
      assert.equal(second.ok, true)
      assert.equal(second.source, 'cooldown-cache')
      assert.equal(second.applied, false)
      assert.deepEqual(second.diff, { added: [], removed: [], unchanged: 2 })
      assert.equal(harness.listingFetches(), fetches, 'the cooldown must not refetch the endpoint')
      assert.equal(second.models.length, 2)

      harness.advance(31_000)
      const third = await service.syncProviderModels({ provider: 'sync-relay' })
      assert.equal(third.ok, true)
      assert.notEqual(third.source, 'cooldown-cache')
      assert.ok(harness.listingFetches() > fetches, 'the cooldown expiry must refetch')
    } finally {
      service.dispose()
    }
  })

  test('force bypasses the cooldown', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'force-relay')
    harness.setEndpoint([FLASH_ENTRY])
    const service = await createService(harness)
    try {
      await service.syncProviderModels({ provider: 'force-relay' })
      const fetches = harness.listingFetches()
      const forced = await service.syncProviderModels({ provider: 'force-relay', force: true })
      assert.equal(forced.ok, true)
      assert.notEqual(forced.source, 'cooldown-cache')
      assert.ok(harness.listingFetches() > fetches)
    } finally {
      service.dispose()
    }
  })

  test('mirror removes discontinued models and keeps configured reasoning efforts', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'mirror-relay', {
      ...SEEDED_PROFILE,
      models: [
        {
          id: 'deepseek-v4.1-flash',
          name: 'Custom Flash',
          contextWindow: 64_000,
          maxTokens: 8_192,
          input: ['text'],
          reasoningEfforts: { off: null, low: 'low', max: 'max' },
        },
        { id: 'old-model', name: 'Old Model', contextWindow: 32_000, maxTokens: 4_096, input: ['text'] },
      ],
    })
    harness.setEndpoint([FLASH_ENTRY, NEW_ENTRY])
    const service = await createService(harness)
    try {
      const policy = await service.setSyncPolicy({ provider: 'mirror-relay', policy: { syncMode: 'mirror' } })
      assert.equal(policy.ok, true)
      const synced = await service.syncProviderModels({ provider: 'mirror-relay', force: true })
      assert.equal(synced.ok, true)
      assert.equal(synced.mode, 'mirror')
      assert.equal(synced.applied, true)
      assert.deepEqual(synced.diff.added, ['brand-new-model'])
      assert.deepEqual(synced.diff.removed, ['old-model'])
      const models = harness.providers()['mirror-relay'].models
      assert.deepEqual(models.map(model => model.id), ['deepseek-v4.1-flash', 'brand-new-model'])
      assert.deepEqual(models[0].reasoningEfforts, { off: null, low: 'low', max: 'max' })
    } finally {
      service.dispose()
    }
  })

  test('an empty listing keeps the configured models and records the protected state', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'empty-relay')
    harness.setEndpoint([])
    const service = await createService(harness)
    try {
      const before = clone(harness.providers()['empty-relay'])
      const synced = await service.syncProviderModels({ provider: 'empty-relay', force: true })
      assert.equal(synced.ok, true)
      assert.equal(synced.source, 'fallback-configured')
      assert.equal(synced.applied, false)
      assert.match(synced.warning ?? '', /no usable models/)
      assert.deepEqual(synced.diff, { added: [], removed: [], unchanged: before.models.length })
      assert.deepEqual(harness.providers()['empty-relay'], before, 'an empty listing must never wipe configured models')
      assert.equal((await syncStateOf(service, 'empty-relay'))?.lastStatus, 'empty')
    } finally {
      service.dispose()
    }
  })

  test('an endpoint failure keeps the configured models and records the error', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'error-relay')
    harness.setEndpoint([], 500)
    const service = await createService(harness)
    try {
      const before = clone(harness.providers()['error-relay'])
      const synced = await service.syncProviderModels({ provider: 'error-relay', force: true })
      assert.equal(synced.ok, true)
      assert.equal(synced.source, 'fallback-configured')
      assert.equal(synced.applied, false)
      assert.match(synced.warning ?? '', /skipped to protect the configured models/)
      assert.deepEqual(harness.providers()['error-relay'], before)
      assert.equal((await syncStateOf(service, 'error-relay'))?.lastStatus, 'error')
    } finally {
      service.dispose()
    }
  })

  test('syncToSubagentAllowed authorizes newly synced models', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'subagent-relay')
    harness.namespace(SUBAGENT_SETTINGS_ID).user = {
      enabled: true,
      allowedModels: [{ provider: 'subagent-relay', model: 'deepseek-v4.1-flash' }],
    }
    harness.setEndpoint([FLASH_ENTRY, NEW_ENTRY])
    const service = await createService(harness)
    try {
      const policy = await service.setSyncPolicy({
        provider: 'subagent-relay',
        policy: { syncMode: 'add-new', syncToSubagentAllowed: true },
      })
      assert.equal(policy.ok, true)
      const synced = await service.syncProviderModels({ provider: 'subagent-relay', force: true })
      assert.equal(synced.applied, true)
      const selection = harness.namespace(SUBAGENT_SETTINGS_ID).user
      assert.equal(selection.enabled, true)
      assert.deepEqual(selection.allowedModels, [
        { provider: 'subagent-relay', model: 'deepseek-v4.1-flash' },
        { provider: 'subagent-relay', model: 'brand-new-model' },
      ])
    } finally {
      service.dispose()
    }
  })

  test('concurrent calls for one provider share a single discovery request', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'flight-relay')
    harness.setEndpoint([FLASH_ENTRY])
    const service = await createService(harness)
    try {
      const fetches = harness.listingFetches()
      const [left, right] = await Promise.all([
        service.syncProviderModels({ provider: 'flight-relay', force: true }),
        service.syncProviderModels({ provider: 'flight-relay', force: true }),
      ])
      assert.equal(harness.listingFetches() - fetches, 1, 'singleflight must deduplicate the discovery request')
      assert.equal(left.ok, true)
      assert.deepEqual(left, right)
    } finally {
      service.dispose()
    }
  })

  test('a settings conflict is retried once against a fresh snapshot', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'conflict-relay')
    harness.setEndpoint([FLASH_ENTRY, NEW_ENTRY])
    harness.forcedConflicts.push(LLM_PI_AI_ID)
    const service = await createService(harness)
    try {
      const synced = await service.syncProviderModels({ provider: 'conflict-relay', force: true })
      assert.equal(synced.ok, true)
      assert.equal(synced.applied, true)
      assert.ok(harness.providers()['conflict-relay'].models.some(model => model.id === 'brand-new-model'))
      assert.equal(harness.conflictsThrown, 1, 'the first write must be refused by the injected conflict')
      assert.equal(harness.forcedConflicts.length, 0, 'the retry must consume the conflict')
      assert.equal((await syncStateOf(service, 'conflict-relay'))?.lastStatus, 'success')
    } finally {
      service.dispose()
    }
  })

  test('autoApply false previews the pending change without writing', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'preview-relay')
    harness.setEndpoint([FLASH_ENTRY, NEW_ENTRY])
    const service = await createService(harness)
    try {
      const before = clone(harness.providers()['preview-relay'])
      const preview = await service.syncProviderModels({ provider: 'preview-relay', force: true, autoApply: false })
      assert.equal(preview.ok, true)
      assert.equal(preview.source, 'preview')
      assert.equal(preview.applied, false)
      assert.deepEqual(preview.diff.added, ['brand-new-model'])
      assert.deepEqual(harness.providers()['preview-relay'], before, 'a preview must not write configuration')
      assert.equal(await syncStateOf(service, 'preview-relay'), null, 'a preview must not record a sync timestamp')

      const applied = await service.syncProviderModels({ provider: 'preview-relay', force: true })
      assert.equal(applied.applied, true)
      assert.equal(harness.providers()['preview-relay'].models.length, 2)
    } finally {
      service.dispose()
    }
  })

  test('syncAllCustomProviders can restrict itself to auto-enabled policies', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'auto-relay')
    seedProvider(harness, 'manual-relay', { ...SEEDED_PROFILE, baseURL: 'https://seeded.example/v2' })
    harness.setEndpoint([FLASH_ENTRY])
    const service = await createService(harness)
    try {
      // A route with no stored policy syncs automatically; only an explicit
      // `manual` opts out.
      const policy = await service.setSyncPolicy({ provider: 'manual-relay', policy: { syncMode: 'manual' } })
      assert.equal(policy.ok, true)
      const listed = await service.listCustomProviders({})
      assert.equal(listed.providers.find(entry => entry.provider === 'auto-relay').syncPolicy.syncMode, 'add-new')
      const restricted = await service.syncAllCustomProviders({ force: true, onlyAutoEnabled: true })
      assert.equal(restricted.ok, true)
      assert.equal(restricted.syncedCount, 1)
      assert.equal(restricted.providers[0].provider, 'auto-relay')
    } finally {
      service.dispose()
    }
  })

  test('background maintenance syncs automatic routes and refreshes a stale registry', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'auto-relay')
    seedProvider(harness, 'manual-relay', { ...SEEDED_PROFILE, baseURL: 'https://seeded.example/v2' })
    harness.setEndpoint([FLASH_ENTRY, NEW_ENTRY])
    const service = await createService(harness)
    try {
      await service.setSyncPolicy({ provider: 'manual-relay', policy: { syncMode: 'manual' } })
      const first = await service.runBackgroundMaintenance()
      assert.equal(first.ok, true)
      assert.equal(first.registry.updated, true, 'a registry that was never fetched is refreshed')
      assert.equal(first.sync.syncedCount, 1)
      assert.equal(first.sync.updatedCount, 1)
      assert.ok(harness.providers()['auto-relay'].models.some(model => model.id === 'brand-new-model'))
      assert.equal(harness.providers()['manual-relay'].models.some(model => model.id === 'brand-new-model'), false, 'a manual route is left alone')

      // A second run inside the cooldown and the registry TTL touches no endpoint.
      const fetchesBefore = harness.fetchCalls.length
      const second = await service.runBackgroundMaintenance()
      assert.equal(second.ok, true)
      assert.equal(second.registry.updated, false)
      assert.equal(second.sync.updatedCount, 0)
      assert.equal(harness.fetchCalls.length, fetchesBefore, 'cooldown and TTL keep a repeated run offline')
    } finally {
      service.dispose()
    }
  })

  test('background maintenance reports an unreachable relay without throwing', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'down-relay')
    harness.setEndpoint([], 500)
    const service = await createService(harness)
    try {
      const before = clone(harness.providers()['down-relay'])
      const result = await service.runBackgroundMaintenance()
      assert.equal(result.sync.ok, true)
      assert.equal(result.sync.updatedCount, 0)
      assert.deepEqual(harness.providers()['down-relay'], before, 'the configured models survive an endpoint failure')
    } finally {
      service.dispose()
    }
  })

  test('a model the owner declined is never added back by sync', async () => {
    const harness = new HostHarness()
    harness.setEndpoint([FLASH_ENTRY, NEW_ENTRY])
    const service = await createService(harness)
    try {
      // Created with one of two listed models: the other one is declined.
      const created = await service.upsertProvider({
        provider: 'picky-relay',
        baseURL: 'https://seeded.example/v1',
        api: 'openai-completions',
        models: [{ id: 'deepseek-v4.1-flash' }],
        syncPolicy: { syncMode: 'add-new', ignoredModels: ['brand-new-model', 'brand-new-model'] },
      })
      assert.equal(created.ok, true)
      assert.deepEqual(created.syncPolicy.ignoredModels, ['brand-new-model'])
      const synced = await service.syncProviderModels({ provider: 'picky-relay', force: true })
      assert.equal(synced.ok, true)
      assert.deepEqual(harness.providers()['picky-relay'].models.map(model => model.id), ['deepseek-v4.1-flash'])

      // An update that keeps the model list leaves the declined ids alone.
      const renamed = await service.upsertProvider({ provider: 'picky-relay', displayName: 'Picky' })
      assert.equal(renamed.ok, true)
      assert.equal(renamed.syncPolicy, null)
      assert.deepEqual((await syncStateOf(service, 'picky-relay')).ignoredModels, ['brand-new-model'])

      // Adding the model by hand makes it wanted again.
      const added = await service.upsertProvider({
        provider: 'picky-relay',
        models: [{ id: 'deepseek-v4.1-flash' }, { id: 'brand-new-model' }],
      })
      assert.equal(added.ok, true)
      assert.deepEqual(added.syncPolicy.ignoredModels, [])

      // A declined id that the same request keeps is dropped from the list.
      const declined = await service.upsertProvider({
        provider: 'picky-relay',
        models: [{ id: 'brand-new-model' }],
        syncPolicy: { ignoredModels: ['deepseek-v4.1-flash', 'brand-new-model'] },
      })
      assert.deepEqual(declined.syncPolicy.ignoredModels, ['deepseek-v4.1-flash'])
      harness.advance(60_000)
      await service.syncProviderModels({ provider: 'picky-relay', force: true })
      assert.deepEqual(harness.providers()['picky-relay'].models.map(model => model.id), ['brand-new-model'])
    } finally {
      service.dispose()
    }
  })

  test('syncAllCustomProviders runs every custom route with bounded concurrency', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'batch-one')
    seedProvider(harness, 'batch-two', { ...SEEDED_PROFILE, baseURL: 'https://seeded.example/v2' })
    harness.setProviders({ ...harness.providers(), openai: SEEDED_PROFILE })
    harness.setEndpoint([FLASH_ENTRY, NEW_ENTRY])
    const service = await createService(harness)
    try {
      const batch = await service.syncAllCustomProviders({ force: true, concurrency: 99 })
      assert.equal(batch.ok, true)
      assert.equal(batch.syncedCount, 2)
      assert.equal(batch.updatedCount, 2)
      assert.equal(batch.providers.length, 2)
      assert.equal(harness.providers()['batch-one'].models.length, 2)
      assert.equal(harness.providers()['batch-two'].models.length, 2)
    } finally {
      service.dispose()
    }
  })
})

/* ------------------------------------------------------------------ */
/* Manual overrides                                                    */
/* ------------------------------------------------------------------ */

describe('manual model overrides', () => {
  test('saveOverride re-enriches the live profile and resetOverride drops it', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'override-relay', {
      ...SEEDED_PROFILE,
      models: [{ id: 'local-test-model-zzz', name: 'Local Test Model' }],
    })
    const service = await createService(harness)
    try {
      const saved = await service.saveOverride({
        provider: 'override-relay',
        model: 'local-test-model-zzz',
        override: { contextWindow: 999_000, maxTokens: 111_000 },
      })
      assert.equal(saved.ok, true)
      assert.equal(saved.profile.contextWindow, 999_000)
      assert.equal(saved.profile.maxTokens, 111_000)
      assert.equal(saved.provenance.contextWindow, 'manual')
      const live = harness.providers()['override-relay'].models[0]
      assert.equal(live.contextWindow, 999_000)
      assert.equal(live.maxTokens, 111_000)
      const overrides = await readStore(service, 'overrides.json')
      assert.deepEqual(overrides.providers['override-relay'].models['local-test-model-zzz'], {
        contextWindow: 999_000,
        maxTokens: 111_000,
      })

      const reset = await service.resetOverride({ provider: 'override-relay', model: 'local-test-model-zzz' })
      assert.equal(reset.ok, true)
      assert.equal(reset.removed, true)
      const restored = harness.providers()['override-relay'].models[0]
      assert.equal(restored.contextWindow, DEFAULT_CONTEXT_WINDOW)
      assert.equal(restored.maxTokens, DEFAULT_MAX_TOKENS)
      assert.equal(isPlainObject(restored.reasoningEfforts) || restored.reasoningEfforts === false || restored.reasoningEfforts === undefined, true)

      const nothing = await service.resetOverride({ provider: 'override-relay', model: 'local-test-model-zzz' })
      assert.equal(nothing.ok, true)
      assert.equal(nothing.removed, false)
    } finally {
      service.dispose()
    }
  })

  test('a reset field falls back through the enrichment layers', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'override-relay', {
      ...SEEDED_PROFILE,
      models: [{ id: 'local-test-model-zzz', name: 'Local Test Model', maxTokens: 4_096 }],
    })
    const service = await createService(harness)
    try {
      const saved = await service.saveOverride({
        provider: 'override-relay',
        model: 'local-test-model-zzz',
        override: { contextWindow: 250_000 },
      })
      assert.equal(saved.ok, true)
      const resetField = await service.saveOverride({
        provider: 'override-relay',
        model: 'local-test-model-zzz',
        reset: ['contextWindow'],
      })
      assert.equal(resetField.ok, true)
      const live = harness.providers()['override-relay'].models[0]
      assert.equal(live.contextWindow, DEFAULT_CONTEXT_WINDOW)
      assert.equal(live.maxTokens, 4_096)
    } finally {
      service.dispose()
    }
  })

  test('saveOverride validates the allowed fields', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'override-relay')
    const service = await createService(harness)
    try {
      const invalidField = await service.saveOverride({
        provider: 'override-relay',
        model: 'deepseek-v4.1-flash',
        override: { apiKey: 'sk-nope' },
      })
      assert.equal(invalidField.ok, false)
      assert.equal(invalidField.code, 'invalid-override')
      const invalidValue = await service.saveOverride({
        provider: 'override-relay',
        model: 'deepseek-v4.1-flash',
        override: { contextWindow: -1 },
      })
      assert.equal(invalidValue.ok, false)
      assert.equal(invalidValue.code, 'invalid-override')
      const missing = await service.saveOverride({
        provider: 'override-relay',
        model: 'does-not-exist',
        override: { maxTokens: 1024 },
      })
      assert.equal(missing.ok, false)
      assert.equal(missing.code, 'model-not-found')
      const badUpstream = await service.saveOverride({
        provider: 'override-relay',
        model: 'deepseek-v4.1-flash',
        override: { upstreamModel: '   ' },
      })
      assert.equal(badUpstream.ok, false)
      assert.equal(badUpstream.code, 'invalid-override')
    } finally {
      service.dispose()
    }
  })

  test('saveOverride supports upstreamModel binding, live re-enrichment, listCustomProviders reporting, and unbinding', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'override-relay', {
      ...SEEDED_PROFILE,
      models: [{
        id: 'my-unmatched-alias',
        name: 'My Unmatched Alias',
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
        input: ['text'],
        reasoningEfforts: false,
      }],
    })
    const service = await createService(harness)
    try {
      const before = await service.listCustomProviders({})
      assert.equal(before.ok, true)
      assert.deepEqual(before.providers[0].unmatchedModels, ['my-unmatched-alias'])
      assert.deepEqual(before.providers[0].upstreamBindings, {})

      const bound = await service.saveOverride({
        provider: 'override-relay',
        model: 'my-unmatched-alias',
        override: { upstreamModel: 'claude-sonnet-4-5' },
      })
      assert.equal(bound.ok, true)
      assert.equal(bound.meta.upstreamModel, 'claude-sonnet-4-5')
      assert.ok(bound.meta.matchedCatalogId !== null || bound.meta.matchedRuleId !== null)
      const live = harness.providers()['override-relay'].models[0]
      assert.equal(live.id, 'my-unmatched-alias')
      assert.equal(live.name, 'My Unmatched Alias')
      assert.equal(live.contextWindow, 200_000)
      assert.deepEqual(live.input, ['text', 'image'])
      assert.equal(isPlainObject(live.reasoningEfforts), true)

      const after = await service.listCustomProviders({})
      assert.equal(after.ok, true)
      assert.deepEqual(after.providers[0].unmatchedModels, [])
      assert.equal(after.providers[0].upstreamBindings['my-unmatched-alias'].upstreamModel, 'claude-sonnet-4-5')
      assert.equal(after.providers[0].upstreamBindings['my-unmatched-alias'].matched, true)

      const catalog = await service.getRegistryStatus({ query: 'claude', limit: 10 })
      assert.equal(catalog.ok, true)
      assert.ok(Array.isArray(catalog.catalogModels) && catalog.catalogModels.length > 0)
      assert.ok(catalog.catalogTotal >= catalog.catalogModels.length)

      const unbound = await service.saveOverride({
        provider: 'override-relay',
        model: 'my-unmatched-alias',
        override: { upstreamModel: null },
      })
      assert.equal(unbound.ok, true)
      const restored = harness.providers()['override-relay'].models[0]
      assert.equal(restored.contextWindow, DEFAULT_CONTEXT_WINDOW)
      assert.deepEqual(restored.input, ['text'])
      const afterUnbind = await service.listCustomProviders({})
      assert.deepEqual(afterUnbind.providers[0].unmatchedModels, ['my-unmatched-alias'])
      assert.deepEqual(afterUnbind.providers[0].upstreamBindings, {})
    } finally {
      service.dispose()
    }
  })
})

/* ------------------------------------------------------------------ */
/* Audit and probe                                                     */
/* ------------------------------------------------------------------ */

describe('audit and probe', () => {
  test('audit reports missing capacities and compat on a cpa-like route', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'cpa-like', {
      displayName: 'cpa',
      api: 'openai-completions',
      baseURL: 'https://cpa.example/v1',
      apiKeyEnv: 'CPA_LIKE_API_KEY',
      models: [{ id: 'gateway-only-model', name: 'Gateway Only' }],
    })
    const service = await createService(harness)
    try {
      const audit = await service.audit({ provider: 'cpa-like' })
      assert.equal(audit.ok, true)
      assert.equal(audit.providerId, 'cpa-like')
      assert.equal(audit.modelCount, 1)
      const codes = new Set(audit.issues.map(issue => issue.code))
      assert.ok(codes.has('missing-context-window'))
      assert.ok(codes.has('missing-max-tokens'))
      assert.ok(codes.has('missing-compat'))
      assert.ok(audit.suggestions.length === 1)
      assert.equal(audit.suggestions[0].profile.id, 'gateway-only-model')
    } finally {
      service.dispose()
    }
  })

  test('probe reports a healthy endpoint and never echoes the key', async () => {
    const harness = new HostHarness()
    harness.setEndpoint([FLASH_ENTRY])
    const service = await createService(harness)
    const secret = 'sk-probe-secret-777888'
    try {
      const probe = await service.probe({
        baseURL: 'https://probe.example/v1',
        api: 'openai-completions',
        apiKey: secret,
        modelId: 'deepseek-v4.1-flash',
        checks: ['connectivity', 'chat'],
      })
      assert.equal(probe.ok, true)
      assert.equal(probe.healthy, true)
      assert.equal(probe.checks.connectivity.ok, true)
      assert.equal(probe.checks.chat.ok, true)
      assert.ok(!rendered(probe).includes(secret))
    } finally {
      service.dispose()
    }
  })

  test('probe reports an unhealthy endpoint without throwing', async () => {
    const harness = new HostHarness()
    harness.setEndpoint([], 500)
    const service = await createService(harness)
    try {
      const probe = await service.probe({
        baseURL: 'https://probe.example/v1',
        api: 'openai-completions',
        checks: ['connectivity'],
      })
      assert.equal(probe.ok, true)
      assert.equal(probe.healthy, false)
      assert.equal(probe.checks.connectivity.ok, false)
    } finally {
      service.dispose()
    }
  })
})

/* ------------------------------------------------------------------ */
/* Import and export                                                   */
/* ------------------------------------------------------------------ */

describe('import and export', () => {
  test('import moves literal keys into the credential store and export stays sanitized', async () => {
    const harness = new HostHarness()
    const service = await createService(harness)
    const secret = 'sk-imported-secret-555666'
    try {
      const imported = await service.importConfig({
        payload: {
          format: 'xiaoxing-api-manager-v1',
          providers: {
            'imported-relay': {
              name: 'Imported Relay',
              baseURL: 'https://imported.example/v1',
              api: 'openai-completions',
              apiKey: secret,
              headers: { 'x-routing': 'us', authorization: 'Bearer should-not-survive' },
              models: [{ id: 'imported-model', contextWindow: 100_000, maxTokens: 8_000, input: ['text'] }],
            },
            openai: {
              baseURL: 'https://openai.com/v1',
              api: 'openai-completions',
              models: [{ id: 'gpt-test' }],
            },
          },
        },
      })
      assert.equal(imported.ok, true)
      assert.equal(imported.importedCount, 1)
      assert.deepEqual(imported.skippedReserved.map(entry => entry.providerId), ['openai'])
      assert.deepEqual(imported.credentialsStored.map(entry => entry.apiKeyEnv), ['IMPORTED_RELAY_API_KEY'])
      assert.equal(harness.credentialStore.get('IMPORTED_RELAY_API_KEY'), secret)
      assert.ok(!rendered(imported).includes(secret), 'the import result must never carry the key')
      assert.equal(Object.hasOwn(imported, 'pendingSecrets') || Object.hasOwn(imported.data ?? {}, 'pendingSecrets'), false)
      const profile = harness.providers()['imported-relay']
      assert.equal(profile.apiKeyEnv, 'IMPORTED_RELAY_API_KEY')
      assert.deepEqual(profile.headers, { 'x-routing': 'us' })
      assert.ok(!rendered(profile).includes(secret))
      assert.ok(!rendered(harness.providers()).includes(secret))

      const exported = await service.exportConfig({ includeSyncPolicy: true })
      assert.equal(exported.ok, true)
      assert.equal(exported.format, 'xiaoxing-api-manager-v1')
      assert.equal(exported.count, 1)
      assert.equal(exported.providers['imported-relay'].apiKeyEnv, 'IMPORTED_RELAY_API_KEY')
      assert.ok(!rendered(exported).includes(secret), 'the export must never carry the key')
      assert.equal(Object.hasOwn(exported.providers['imported-relay'], 'apiKey'), false)

      const one = await service.exportConfig({ provider: 'imported-relay' })
      assert.equal(one.count, 1)
      const none = await service.exportConfig({ providerIds: ['missing-provider'] })
      assert.equal(none.count, 0)
    } finally {
      service.dispose()
    }
  })

  test('import rejects unusable documents with a stable failure code', async () => {
    const harness = new HostHarness()
    const service = await createService(harness)
    try {
      const empty = await service.importConfig({ payload: '' })
      assert.equal(empty.ok, false)
      assert.equal(empty.code, 'invalid-import')
      const badFormat = await service.importConfig({ payload: '{}', format: 'unknown-format' })
      assert.equal(badFormat.ok, false)
      assert.equal(badFormat.code, 'unsupported-import-format')
    } finally {
      service.dispose()
    }
  })
})

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

describe('registry cache', () => {
  test('status and refresh read and store the mocked feeds', async () => {
    const harness = new HostHarness()
    const service = await createService(harness)
    try {
      const initial = await service.getRegistryStatus({})
      assert.equal(initial.ok, true)
      assert.equal(initial.stale, true)
      const refreshed = await service.refreshRegistry({ force: true })
      assert.equal(refreshed.ok, true)
      assert.equal(refreshed.updated, true)
      assert.ok(refreshed.modelCount >= 1)
      assert.equal(refreshed.warnings.length, 0)
      const status = await service.getRegistryStatus({})
      assert.equal(status.ok, true)
      assert.equal(status.modelCount, refreshed.modelCount)
      assert.equal(status.stale, false)
    } finally {
      service.dispose()
    }
  })

  test('offline refresh never reaches the network', async () => {
    const harness = new HostHarness()
    const service = await createService(harness)
    try {
      const before = harness.fetchCalls.length
      const refreshed = await service.refreshRegistry({ force: true, offlineOnly: true })
      assert.equal(refreshed.ok, true)
      assert.equal(harness.fetchCalls.length, before)
    } finally {
      service.dispose()
    }
  })

  test('interactive enrich and catalog search warm an empty online registry cache on demand', async () => {
    const harness = new HostHarness()
    const service = await createService(harness)
    try {
      const initial = await service.getRegistryStatus({})
      assert.equal(initial.checkedAt, null)
      const enriched = await service.enrich({ api: 'openai-completions', models: ['deepseek-v4.1-flash'] })
      assert.equal(enriched.ok, true)
      assert.equal(enriched.models[0].provenance.contextWindow, 'remote-registry')
      const after = await service.getRegistryStatus({})
      assert.notEqual(after.checkedAt, null)
      assert.equal(after.stale, false)
    } finally {
      service.dispose()
    }
  })
})

/* ------------------------------------------------------------------ */
/* State resilience                                                    */
/* ------------------------------------------------------------------ */

describe('state resilience', () => {
  test('a corrupt state file is reported without blocking status', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'state-relay')
    const service = await createService(harness)
    try {
      await writeFile(join(service.dataDir, 'overrides.json'), '{not json')
      const status = await service.status({})
      assert.equal(status.ok, true)
      assert.ok(status.warnings.some(warning => /overrides state could not be loaded/.test(warning)))
      const saved = await service.saveOverride({
        provider: 'state-relay',
        model: 'deepseek-v4.1-flash',
        override: { maxTokens: 12_345 },
      })
      assert.equal(saved.ok, false)
      assert.equal(saved.code, 'invalid-state')
    } finally {
      service.dispose()
    }
  })
})

/* ------------------------------------------------------------------ */
/* Remote descriptor and plugin registration                           */
/* ------------------------------------------------------------------ */

describe('Remote descriptor', () => {
  test('the prototype descriptor matches the exported method list', async () => {
    assert.deepEqual([...REMOTE_METHODS], [
      'status', 'presets', 'listCustomProviders', 'discover', 'enrich', 'audit', 'probe',
      'upsertProvider', 'removeProvider', 'syncProviderModels', 'syncAllCustomProviders',
      'setSyncPolicy', 'setDefaults', 'saveOverride', 'resetOverride', 'getRegistryStatus',
      'refreshRegistry', 'importConfig', 'exportConfig',
    ])
    assert.equal(REMOTE_METHODS.includes('remove'), false)
    const descriptor = Object.getOwnPropertyDescriptor(ApiManagerService.prototype, REMOTE_METHOD_DESCRIPTOR)
    assert.ok(descriptor)
    assert.equal(descriptor.value.version, 1)
    assert.deepEqual(descriptor.value.methods.map(entry => entry.method), [...REMOTE_METHODS])
    for (const entry of descriptor.value.methods) {
      assert.deepEqual(entry.invocation, { kind: 'direct' })
      assert.equal(typeof ApiManagerService.prototype[entry.method], 'function')
    }
    assert.ok(Object.isFrozen(descriptor.value))
    assert.ok(Object.isFrozen(descriptor.value.methods))
  })

  test('the service exposes a frozen typertRemote identity', async () => {
    const dataDir = await makeDataDir()
    const service = new ApiManagerService({ dataDir, deps: {}, syncCooldownMs: 0 })
    try {
      assert.ok(Object.isFrozen(service.typertRemote))
      assert.equal(service.typertRemote.service, service)
      assert.equal(service.typertRemote.serviceKey, 'xiaoxingApiManager')
      assert.equal(service.typertRemote.namespace, 'xiaoxingApiManager')
      const disposed = await service.status({})
      assert.equal(disposed.ok, true)
      service.dispose()
      const afterDispose = await service.upsertProvider({ provider: 'late-relay', baseURL: 'https://late.example/v1', models: ['m'] })
      assert.equal(afterDispose.ok, false)
      assert.equal(afterDispose.code, 'disposed')
    } finally {
      service.dispose()
    }
  })
})

describe('plugin registration', () => {
  test('apply provides the service, registers the tool, and disposes cleanly', async () => {
    assert.deepEqual(inject, ['tools'])
    const harness = new HostHarness()
    const applied = await createApplyHarness(harness)
    // provide, tool, lifecycle, and the background sync schedule.
    assert.equal(applied.disposers.length, 4)
    assert.equal(applied.tool.name, 'xiaoxing_api_manager')
    assert.equal(applied.tool.parameters.type, 'object')
    assert.deepEqual(applied.tool.parameters.required, ['action'])
    assert.deepEqual(applied.tool.parameters.properties.action.enum, [...REMOTE_METHODS])
    for (const parameter of TOOL_PARAMETERS) {
      assert.ok(Object.hasOwn(applied.tool.parameters.properties, parameter), `tool parameter ${parameter} is missing`)
    }
    assert.equal(applied.tool.parameters.properties.action.type, 'string')
    assert.deepEqual(applied.tool.output.schema.required, ['ok', 'summary'])
    const renderedBlocks = applied.tool.output.render({}, { ok: true, summary: 'hello' })
    assert.deepEqual(renderedBlocks, [{ type: 'text', text: 'hello' }])
    assert.equal(applied.provided.get(SERVICE_KEY), applied.service)

    for (const dispose of applied.disposers.reverse()) dispose()
    assert.equal(applied.provided.has(SERVICE_KEY), false)
    assert.equal(applied.ctx.tools.tool, undefined)
    assert.equal(applied.service.closed, true)
  })

  test('apply runs background maintenance on its own schedule and stops on dispose', async () => {
    const harness = new HostHarness()
    const applied = await createApplyHarness(harness, { config: { autoSyncInitialDelayMs: 5, autoSyncIntervalMs: 20 } })
    let runs = 0
    applied.service.runBackgroundMaintenance = async () => {
      runs += 1
      return { ok: true }
    }
    await new Promise(resolve => setTimeout(resolve, 70))
    assert.ok(runs >= 2, `the schedule fires after the initial delay and again per interval (ran ${runs} time(s))`)
    for (const dispose of applied.disposers.reverse()) dispose()
    const settled = runs
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(runs, settled, 'no run fires after the plugin is disposed')
  })

  test('autoSyncIntervalMs 0 turns the background schedule off', async () => {
    const harness = new HostHarness()
    const applied = await createApplyHarness(harness, { config: { autoSyncInitialDelayMs: 1, autoSyncIntervalMs: 0 } })
    let runs = 0
    applied.service.runBackgroundMaintenance = async () => {
      runs += 1
      return { ok: true }
    }
    assert.equal(applied.disposers.length, 3, 'no schedule effect is installed')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(runs, 0)
    for (const dispose of applied.disposers.reverse()) dispose()
  })
})

/* ------------------------------------------------------------------ */
/* Tool actions                                                        */
/* ------------------------------------------------------------------ */

describe('tool actions', () => {
  test('every action executes through the tool schema', async () => {
    const harness = new HostHarness()
    harness.setEndpoint([FLASH_ENTRY])
    const applied = await createApplyHarness(harness)
    const secret = 'sk-tool-action-secret-13579'
    try {
      const discovered = await runTool(applied.tool, {
        action: 'discover',
        baseURL: 'https://tool.example/v1',
        api: 'openai-completions',
        apiKey: secret,
      })
      assert.equal(discovered.ok, true)
      assert.equal(discovered.data.models.length, 1)

      const upserted = await runTool(applied.tool, {
        action: 'upsertProvider',
        provider: 'tool-relay',
        displayName: 'Tool Relay',
        baseURL: 'https://tool.example/v1',
        api: 'openai-completions',
        apiKey: secret,
        models: discovered.data.models,
        setAsDefault: { model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
        addToSubagent: ['deepseek-v4.1-flash'],
        enableSubagent: true,
        syncMode: 'add-new',
        syncCooldownMs: 0,
        syncToSubagentAllowed: true,
      })
      assert.equal(upserted.ok, true)
      assert.match(upserted.summary, /Saved provider "tool-relay"/)
      assert.ok(!rendered(upserted).includes(secret))

      const enriched = await runTool(applied.tool, {
        action: 'enrich',
        provider: 'tool-relay',
        models: ['deepseek-v4.1-flash'],
      })
      assert.equal(enriched.ok, true)
      assert.equal(enriched.data.models[0].profile.id, 'deepseek-v4.1-flash')

      const audited = await runTool(applied.tool, { action: 'audit', provider: 'tool-relay' })
      assert.equal(audited.ok, true)

      const probed = await runTool(applied.tool, {
        action: 'probe',
        baseURL: 'https://tool.example/v1',
        api: 'openai-completions',
        checks: ['connectivity'],
      })
      assert.equal(probed.ok, true)
      assert.equal(probed.data.healthy, true)

      const listed = await runTool(applied.tool, { action: 'listCustomProviders' })
      assert.equal(listed.ok, true)
      assert.equal(listed.data.providers[0].provider, 'tool-relay')

      const status = await runTool(applied.tool, { action: 'status' })
      assert.equal(status.ok, true)
      assert.equal(status.data.defaultSelection.provider, 'tool-relay')
      assert.equal(status.data.subagentSelection.enabled, true)

      const presets = await runTool(applied.tool, { action: 'presets' })
      assert.equal(presets.ok, true)
      assert.ok(presets.data.presets.length >= 5)

      const policy = await runTool(applied.tool, {
        action: 'setSyncPolicy',
        provider: 'tool-relay',
        syncMode: 'add-new',
        syncCooldownMs: 0,
        syncToSubagentAllowed: true,
      })
      assert.equal(policy.ok, true)
      assert.equal(policy.data.syncPolicy.syncMode, 'add-new')

      const overridden = await runTool(applied.tool, {
        action: 'saveOverride',
        provider: 'tool-relay',
        modelId: 'deepseek-v4.1-flash',
        override: { maxTokens: 20_000 },
      })
      assert.equal(overridden.ok, true)
      assert.equal(overridden.data.profile.maxTokens, 20_000)

      const reset = await runTool(applied.tool, {
        action: 'resetOverride',
        provider: 'tool-relay',
        modelId: 'deepseek-v4.1-flash',
      })
      assert.equal(reset.ok, true)
      assert.equal(reset.data.removed, true)

      const defaults = await runTool(applied.tool, {
        action: 'setDefaults',
        provider: 'tool-relay',
        modelId: 'deepseek-v4.1-flash',
        reasoningEffort: 'high',
      })
      assert.equal(defaults.ok, true)
      assert.equal(defaults.data.defaultSelection.reasoningEffort, 'high')

      harness.setEndpoint([FLASH_ENTRY, NEW_ENTRY])
      const synced = await runTool(applied.tool, {
        action: 'syncProviderModels',
        provider: 'tool-relay',
        force: true,
      })
      assert.equal(synced.ok, true)
      assert.equal(synced.data.applied, true)
      assert.ok(applied.events.some(event => event.event === 'xiaoxing-api-manager/models-synced'), 'the sync callback must emit')

      const syncedAll = await runTool(applied.tool, { action: 'syncAllCustomProviders', force: true })
      assert.equal(syncedAll.ok, true)
      assert.equal(syncedAll.data.syncedCount, 1)

      const registry = await runTool(applied.tool, { action: 'getRegistryStatus' })
      assert.equal(registry.ok, true)

      const refreshed = await runTool(applied.tool, { action: 'refreshRegistry', force: true })
      assert.equal(refreshed.ok, true)
      assert.ok(refreshed.data.modelCount >= 1)

      const imported = await runTool(applied.tool, {
        action: 'importConfig',
        payload: {
          format: 'xiaoxing-api-manager-v1',
          providers: {
            'tool-imported': {
              baseURL: 'https://imported.example/v1',
              api: 'openai-completions',
              apiKeyEnv: 'TOOL_IMPORTED_API_KEY',
              models: [{ id: 'tool-model', contextWindow: 128_000, maxTokens: 16_384, input: ['text'] }],
            },
          },
        },
      })
      assert.equal(imported.ok, true)
      assert.equal(imported.data.importedCount, 1)

      const exported = await runTool(applied.tool, { action: 'exportConfig', provider: 'tool-imported' })
      assert.equal(exported.ok, true)
      assert.equal(exported.data.count, 1)
      assert.ok(!rendered(exported).includes(secret))

      const removed = await runTool(applied.tool, {
        action: 'removeProvider',
        provider: 'tool-imported',
        removeCredential: true,
      })
      assert.equal(removed.ok, true)
      assert.equal(harness.providers()['tool-imported'], undefined)

      const unknown = await runTool(applied.tool, { action: 'explode' })
      assert.equal(unknown.ok, false)
      assert.match(unknown.summary, /invalid-action/)
    } finally {
      for (const dispose of applied.disposers.reverse()) dispose()
    }
  })

  test('a sync request respects the stored cooldown through the tool', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'tool-cooldown')
    harness.setEndpoint([FLASH_ENTRY])
    const applied = await createApplyHarness(harness, { syncCooldownMs: 30_000 })
    try {
      const first = await runTool(applied.tool, { action: 'syncProviderModels', provider: 'tool-cooldown', force: true })
      assert.equal(first.ok, true)
      const second = await runTool(applied.tool, { action: 'syncProviderModels', provider: 'tool-cooldown' })
      assert.equal(second.ok, true)
      assert.equal(second.data.source, 'cooldown-cache')
    } finally {
      for (const dispose of applied.disposers.reverse()) dispose()
    }
  })

  test('sync and discover-enrich preserve real reasoningEfforts for bare /v1/models entries', async () => {
    const harness = new HostHarness()
    seedProvider(harness, 'bare-relay')
    harness.setEndpoint([
      { id: 'deepseek-v4.1-flash', object: 'model', owned_by: 'deepseek' },
      { id: 'claude-sonnet-5-5', object: 'model', owned_by: 'anthropic' },
      { id: 'vertex/gemini-4-neon', object: 'model', owned_by: 'google' },
      { id: 'explicit-chat-only', object: 'model', supports_reasoning: false },
    ])
    const service = await createService(harness)
    try {
      const discovered = await service.discover({ baseURL: 'https://seeded.example/v1', api: 'openai-completions' })
      assert.equal(discovered.ok, true)
      const enriched = await service.enrich({ api: 'openai-completions', models: discovered.models })
      assert.equal(enriched.ok, true)
      const byId = Object.fromEntries(enriched.models.map(item => [item.id, item]))
      assert.ok(
        isPlainObject(byId['claude-sonnet-5-5'].profile.reasoningEfforts),
        'bare endpoint claude model must not be marked reasoningEfforts: false',
      )
      assert.ok(
        isPlainObject(byId['vertex/gemini-4-neon'].profile.reasoningEfforts),
        'vertex/ prefixed gemini model must resolve family reasoningEfforts',
      )
      assert.equal(byId['explicit-chat-only'].profile.reasoningEfforts, false)

      const synced = await service.syncProviderModels({ provider: 'bare-relay', force: true })
      assert.equal(synced.ok, true)
      const persisted = Object.fromEntries(
        harness.providers()['bare-relay'].models.map(model => [model.id, model]),
      )
      assert.ok(isPlainObject(persisted['claude-sonnet-5-5'].reasoningEfforts))
      assert.ok(isPlainObject(persisted['vertex/gemini-4-neon'].reasoningEfforts))
      assert.equal(persisted['explicit-chat-only'].reasoningEfforts, false)
    } finally {
      service.dispose()
    }
  })
})

/* ------------------------------------------------------------------ */
/* Cleanup                                                             */
/* ------------------------------------------------------------------ */

after(async () => {
  for (const directory of TEMP_DIRS) await rm(directory, { recursive: true, force: true })
})
