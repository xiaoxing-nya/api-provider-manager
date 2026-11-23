/**
 * Registration, rendering-contract, and helper tests for the API provider
 * manager client half.
 *
 * The suite loads `client.js` in a bare `node:vm` context, mounts a fake
 * `__ModuleLoader__`, and asserts the registration contract, the two-level UI
 * contract (quiet provider list + shared create/edit form), the provider-card
 * extension, the preserved credential/failure invariants, and the pure helpers
 * behind identity derivation, model editing, and reasoning efforts.
 *
 * There is no DOM and no pixel render; every element tree is a plain object.
 * Run with `node tests/client-registration.test.mjs` from the package root.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

import { REMOTE_METHODS, REMOTE_NAMESPACE, SERVICE_KEY } from '../index.js'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

const PACKAGE = '@xiaoxing/api-provider-manager'
const NS = 'xiaoxing-api-manager'
const SECTION_CELL = 'settings.section:xiaoxing-api-manager'
const ICON_CELL = 'settings.section.icon:xiaoxing-api-manager'
const CARD_CELL = 'settings.models.provider-card:llm-pi-ai'

/** Every Host failure code the client dictionary localizes. */
const HOST_ERROR_CODES = [
  'config-conflict', 'config-unavailable', 'config-write-failed', 'credential-read-failed',
  'credential-write-failed', 'credentials-unavailable', 'default-selection-failed', 'discovery-timeout',
  'disposed', 'http-error', 'import-failed', 'invalid-api', 'invalid-api-key', 'invalid-catalog',
  'invalid-config', 'invalid-credential-ref', 'invalid-fetch', 'invalid-headers', 'invalid-import',
  'invalid-model-id', 'invalid-model-profile', 'invalid-override', 'invalid-probe-check',
  'invalid-probe-target', 'invalid-provider-id', 'invalid-provider-profile', 'invalid-request',
  'invalid-response', 'invalid-rules', 'invalid-state', 'invalid-subagent-selection', 'invalid-sync-mode',
  'invalid-sync-policy', 'invalid-timeout', 'invalid-url', 'model-not-found', 'network-error',
  'provider-not-found', 'request-aborted', 'reserved-native-provider', 'response-too-large',
  'state-write-failed', 'unknown-preset', 'unsafe-file', 'unsupported-api', 'unsupported-import-format',
]

/** Static labels the reworked UI must carry in both languages. */
const REQUIRED_KEYS = [
  'title', 'subtitle', 'loading', 'common.back', 'common.cancel', 'common.working',
  'header.refresh', 'list.connect', 'list.search', 'list.clear', 'list.filterEmpty',
  'list.emptyTitle', 'list.emptyHint', 'list.unavailable', 'list.models', 'list.missingKey',
  'list.edit', 'list.delete', 'list.deleteTitle', 'list.deleteHint', 'list.deleteCredential',
  'list.deleteConfirm', 'list.deleted', 'list.created', 'list.updated',
  'form.createTitle', 'form.editTitle', 'form.saveCreate', 'form.saveEdit', 'form.connection',
  'form.name', 'form.namePlaceholder', 'form.api',
  'form.baseURL', 'form.baseURLPlaceholder', 'form.baseURLHint', 'form.apiKey',
  'form.apiKeyHintEdit', 'form.autoMatch', 'form.autoMatchHint',
  'form.models', 'form.manualPlaceholder',
  'form.manualAdd', 'form.manualEmpty', 'form.duplicateSkipped', 'form.fetch',
  'form.fetchNeedURL', 'form.fetched', 'form.fetchEmpty', 'form.needSelection', 'form.modelsAdded',
  'form.enrichPartial', 'form.needURL', 'form.needModels', 'form.invalidModelId',
  'form.duplicateModelId', 'form.invalidNumber', 'form.discoveryTitle', 'form.discoveryCount',
  'form.discoverySearch', 'form.discoverySelectAll', 'form.discoveryClear',
  'form.discoveryAddSelected', 'form.discoveryAdd', 'form.discoveryAdded',
  'form.discoveryCollapse', 'form.discoveryExpand', 'form.discoveryClose', 'form.discoveryEmpty',
  'model.title', 'model.search', 'model.selectAll', 'model.selectedCount', 'model.clearSelection',
  'model.batchMatch', 'model.batchSubagent', 'model.batchRemove', 'model.batchRemoved',
  'model.batchMatched', 'model.batchMatchPartial', 'model.batchSubagentSaved', 'model.selectOne',
  'model.emptyTitle', 'model.emptyHint', 'model.settings',
  'model.collapse', 'model.remove', 'model.id', 'model.name', 'model.namePlaceholder',
  'model.contextWindow', 'model.maxTokens', 'model.input', 'model.text', 'model.image',
  'model.reasoning', 'model.reasoningHint', 'model.effortMapping', 'model.match', 'model.matched',
  'model.setDefault', 'model.defaultSaved', 'model.allowSubagent', 'model.subagentSaved',
  'model.meta.output', 'model.meta.image', 'model.meta.reasoningTiers',
  'advanced.title', 'advanced.hint', 'advanced.provider', 'advanced.providerHint',
  'advanced.providerReadonly', 'advanced.apiKeyEnv', 'advanced.apiKeyEnvHint',
  'advanced.apiKeyEnvKeep', 'advanced.headers', 'advanced.headersHint', 'advanced.compat',
  'advanced.compatHint', 'advanced.compatNone', 'advanced.compatDefault', 'advanced.compatActive',
  'advanced.compatInvalid', 'advanced.probe', 'advanced.probeRun', 'advanced.probeHealthy',
  'advanced.probeUnhealthy', 'advanced.probeRecommend', 'advanced.probeNoRecommend',
  'advanced.applyRecommended', 'advanced.recommendApplied', 'advanced.setDefault',
  'advanced.allowSubagent', 'field.show', 'field.hide', 'id.available', 'id.invalid',
  'id.reservedNative', 'id.reservedBuiltin', 'id.exists',
  'providerCard.managed', 'providerCard.probe', 'providerCard.healthy',
  'providerCard.unhealthy', 'providerCard.unconfigured',
  'protocol.openai-completions', 'protocol.openai-responses', 'protocol.anthropic-messages',
  'protocol.google-generative-ai',
  'editor.effort.off', 'editor.effort.minimal', 'editor.effort.low', 'editor.effort.medium',
  'editor.effort.high', 'editor.effort.xhigh', 'editor.effort.max',
  'probe.supported', 'probe.unsupported', 'probe.inconclusive', 'probe.skipped', 'probe.error',
  'probe.check.connectivity', 'probe.check.chat', 'probe.check.developerRole',
  'probe.check.maxTokensField', 'probe.check.reasoning', 'probe.check.tools',
  'error.title', 'error.remote-unavailable', 'error.internal',
]

/** Minimal React surface: element objects plus stateful hook stubs. */
function createReact() {
  const cells = []
  const effects = []
  let index = 0
  return {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: initial => {
      const slot = index
      index += 1
      if (cells[slot] === undefined) cells[slot] = typeof initial === 'function' ? initial() : initial
      const setter = update => { cells[slot] = typeof update === 'function' ? update(cells[slot]) : update }
      return [cells[slot], setter]
    },
    useCallback: callback => callback,
    useMemo: factory => factory(),
    useRef: initial => ({ current: initial }),
    useEffect: callback => { effects.push(callback) },
    Fragment: 'Fragment',
    /** Reset the hook cursor and the recorded effects before a direct component invocation. */
    begin() { index = 0; effects.length = 0 },
    effects,
    cells,
  }
}

/** Flatten every text node of one element tree. */
function textOf(node) {
  if (node === null || node === undefined || node === true || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textOf)
  if (typeof node === 'object' && node !== null && node.props !== undefined) return textOf(node.props.children)
  return []
}

/** Flatten only the text a reader sees (drops the injected stylesheet). */
function uiText(node) {
  if (node === null || node === undefined) return ''
  const tree = Array.isArray(node) ? node : [node]
  const parts = []
  const walk = value => {
    if (value === null || value === undefined || typeof value === 'boolean') return
    if (typeof value === 'string' || typeof value === 'number') { parts.push(String(value)); return }
    if (Array.isArray(value)) { for (const child of value) walk(child); return }
    if (typeof value !== 'object') return
    if (value.type === 'style') return
    walk(value.props?.children)
  }
  walk(tree)
  return parts.join(' ')
}

/** Collect every element matching one predicate. */
function findElements(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, found)
    return found
  }
  if (node.type !== undefined && predicate(node)) found.push(node)
  findElements(node.props?.children, predicate, found)
  return found
}

/** Collect every `.xxa-badge` element with its class and visible text. */
function collectBadges(node) {
  return findElements(node, candidate => typeof candidate.props?.className === 'string' && /(?:^|\s)xxa-badge(?:\s|$)/u.test(candidate.props.className))
    .map(element => ({ className: element.props.className, text: textOf(element).join('').trim() }))
}

/** Detach one cross-realm fixture so deep equality compares values, not prototypes. */
const plain = value => JSON.parse(JSON.stringify(value))

/** Find one button by its exact visible label. */
function buttonByLabel(tree, label) {
  const found = findElements(tree, node => node.type === 'button' && textOf(node).join('').trim() === label)
  assert(found.length > 0, `button "${label}" renders`)
  return found[0]
}

/** Find one input or textarea by its placeholder. */
function fieldByPlaceholder(tree, placeholder) {
  const found = findElements(tree, node => (node.type === 'input' || node.type === 'textarea') && node.props.placeholder === placeholder)
  assert(found.length > 0, `field with placeholder "${placeholder}" renders`)
  return found[0]
}

/** Find the wrapper label of one labelled form field. */
function labelledField(tree, label) {
  const found = findElements(tree, node => node.type === 'label'
    && typeof node.props?.className === 'string'
    && /(?:^|\s)xxa-field(?:\s|$)/u.test(node.props.className)
    && textOf(node.props.children?.[0]).join('').trim() === label)
  assert(found.length > 0, `field "${label}" renders`)
  return found[0]
}

/** Find the first input/select/textarea inside one labelled field. */
function controlByLabel(tree, label) {
  const found = findElements(labelledField(tree, label), node => node.type === 'input' || node.type === 'select' || node.type === 'textarea')
  assert(found.length > 0, `control for "${label}" renders`)
  return found[0]
}

/** Find the checkbox inside the compact row whose text contains one label. */
function checkboxByText(tree, text) {
  for (const label of findElements(tree, node => node.type === 'label' && textOf(node).join('').includes(text))) {
    const box = findElements(label, node => node.type === 'input' && node.props.type === 'checkbox')[0]
    if (box !== undefined) return box
  }
  assert.fail(`checkbox "${text}" renders`)
}

/** Find one accessible switch by its aria-label. */
function switchByLabel(tree, label) {
  const found = findElements(tree, node => node.type === 'button' && node.props.role === 'switch' && node.props['aria-label'] === label)
  assert(found.length > 0, `switch "${label}" renders`)
  return found[0]
}

/** Find one input by its aria-label. */
function inputByAria(tree, label) {
  const found = findElements(tree, node => (node.type === 'input' || node.type === 'textarea' || node.type === 'select') && node.props['aria-label'] === label)
  assert(found.length > 0, `control "${label}" renders`)
  return found[0]
}

/** Wait for the pending microtask chain of one Remote round trip. */
const settle = () => new Promise(resolve => setImmediate(resolve))

/**
 * Collect every input/select that has no accessible name: neither an
 * `aria-label` nor a wrapping `<label>` element. Checkboxes are covered by
 * their compact check row, so they are excluded on purpose.
 */
function unlabelledControls(node, insideLabel = false, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) unlabelledControls(child, insideLabel, found)
    return found
  }
  if ((node.type === 'input' || node.type === 'select') && node.props['aria-label'] === undefined) {
    if (node.props.type !== 'checkbox' && insideLabel !== true) found.push(node)
  }
  unlabelledControls(node.props?.children, insideLabel || node.type === 'label', found)
  return found
}

/** Build a client bundle instance over one fake context. */
function makeClient({ mountFails = false, responses = {} } = {}) {
  let definition
  let descriptors
  const locales = new Map()
  const slots = new Map()
  const cleanups = []
  const logs = []
  const remoteCalls = []
  const sandbox = { window: { __ModuleLoader__: { load: entry => { definition = entry } } } }
  const context = vm.createContext(sandbox)
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.equal(definition.id, PACKAGE)
  const reactSurface = createReact()
  /** Build one value in the bundle realm so `isPlainObject` accepts it. */
  const realmValue = value => vm.runInContext(`(${JSON.stringify(value)})`, context)
  const plugin = definition.factory(name => {
    assert.equal(name, 'react')
    return reactSurface
  })
  const remoteNamespace = new Proxy({}, {
    get: (_target, property) => {
      if (typeof property !== 'string') return undefined
      return async request => {
        remoteCalls.push({ method: property, request })
        const value = typeof responses[property] === 'function' ? responses[property](request) : responses[property]
        return realmValue({ ok: true, value: value === undefined ? {} : value })
      }
    },
  })
  const ctx = {
    logger: { warn: value => { logs.push(String(value)) } },
    get: name => (name === `remote.${REMOTE_NAMESPACE}` ? remoteNamespace : undefined),
    effect: callback => {
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    locale: {
      bind: ns => (key, params) => {
        const template = locales.get(ns)?.en?.[key] ?? key
        if (params === undefined) return template
        return String(template).replace(/\{(\w+)\}/gu, (_match, name) => (params[name] === undefined ? '' : String(params[name])))
      },
      register: (ns, dictionaries) => { locales.set(ns, dictionaries); return () => locales.delete(ns) },
    },
    remote: {
      $mount: async payload => {
        descriptors = payload
        if (mountFails) throw new Error('simulated mount failure')
        return async () => {}
      },
    },
    slots: {
      inject: (key, callback) => {
        const installed = callback()
        const contributions = Array.isArray(installed) ? installed : [installed]
        for (const disposer of contributions) {
          if (typeof disposer === 'function') cleanups.push(disposer)
        }
      },
      register: (options, component) => {
        const cell = `${options.name}:${options.key ?? options.id ?? ''}`
        slots.set(cell, { options, component })
        return () => slots.delete(cell)
      },
    },
  }
  return {
    definition,
    plugin,
    ctx,
    locales,
    slots,
    logs,
    remoteCalls,
    react: reactSurface,
    realmValue,
    get descriptors() { return descriptors },
    dispose: () => { for (const cleanup of cleanups.reverse()) cleanup() },
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A settled, healthy, empty page state. */
const settledView = () => ({ busy: false, loaded: true, failure: null, notice: '' })

/** One configured provider as `listCustomProviders` reports it. */
const providerFixture = {
  provider: 'my-relay',
  displayName: 'My relay',
  api: 'openai-completions',
  baseURL: 'https://relay.example/v1',
  apiKeyEnv: 'MY_RELAY_API_KEY',
  modelCount: 2,
  models: [{ id: 'a', contextWindow: 128000 }, { id: 'b' }],
  credential: { configured: true },
  syncPolicy: { syncMode: 'add-new', lastSyncedAt: '2026-01-02T03:04:05.000Z', ignoredModels: [] },
  audit: { issueCount: 2, missingFieldCount: 2, issues: [] },
}

/** One model editor row. */
function modelFixture(id, extra = {}) {
  return {
    key: `model-${id}`,
    id,
    name: '',
    contextWindow: '',
    maxTokens: '',
    input: ['text'],
    reasoning: false,
    efforts: {},
    discovered: null,
    ...extra,
  }
}

/** One create-mode form draft. */
function createDraftFixture(extra = {}) {
  return {
    mode: 'create',
    provider: '',
    providerDirty: false,
    displayName: '',
    api: 'openai-completions',
    baseURL: '',
    apiKey: '',
    showKey: false,
    apiKeyEnv: '',
    apiKeyEnvDirty: false,
    headersText: '',
    initialHeadersText: '',
    autoMatch: true,
    models: [],
    modelSearch: '',
    manualModelInput: '',
    discovery: null,
    expandedKeys: [],
    compatDraft: {},
    probe: null,
    setAsDefault: false,
    enableSubagent: false,
    ignoredModels: [],
    originalModelIds: [],
    ...extra,
  }
}

/** Seed hook cells with fixtures created in the bundle's own realm. */
function seedCells(client, values) {
  for (const [slot, value] of Object.entries(values)) {
    if (value === undefined) continue
    client.react.cells[Number(slot)] = value === null ? null : client.realmValue(value)
  }
}

/**
 * Render the settings section once with controlled hook-state cells.
 *
 * Hook cell order: 0 data, 1 view, 2 draft, 3 list filter, 4 removal target, 5 list advanced.
 */
async function renderSection(overrides = {}) {
  const client = makeClient({ responses: overrides.responses ?? {} })
  await client.plugin.apply(client.ctx)
  seedCells(client, {
    0: overrides.data,
    1: overrides.view === undefined ? settledView() : overrides.view,
    2: overrides.draft,
    3: overrides.filter,
    4: overrides.removeTarget,
    5: overrides.advanced,
  })
  const component = client.slots.get(SECTION_CELL).component
  const render = () => {
    client.react.begin()
    return component({ t: key => key })
  }
  const tree = render()
  return { client, tree, render }
}

/** Render the provider-card extras over its own hook-state cells. */
async function renderExtras(overrides = {}) {
  const client = makeClient()
  await client.plugin.apply(client.ctx)
  // Hook order inside the configured body: 0 probe, 1 busy, 2 failure.
  client.react.cells[0] = overrides.probe === undefined ? null : client.realmValue(overrides.probe)
  client.react.cells[1] = overrides.busy === true
  client.react.cells[2] = overrides.failure === undefined ? null : client.realmValue(overrides.failure)
  const component = client.slots.get(CARD_CELL).component
  const props = {
    provider: client.realmValue({ provider: 'my-relay', displayName: 'My relay', declared: true }),
    configured: true,
    keyConfigured: true,
    t: key => key,
  }
  const guard = component(props)
  assert.notEqual(guard, null)
  client.react.begin()
  const tree = guard.type({ ...props, ...guard.props })
  return { client, tree }
}

/** Open the create page from the list, or keep a pre-seeded create draft. */
async function openCreatePage(overrides = {}) {
  const section = await renderSection({
    data: { available: true, providers: [] },
    ...overrides,
  })
  if (section.client.react.cells[2] !== null) return section
  buttonByLabel(section.tree, 'list.connect').props.onClick()
  return { ...section, tree: section.render() }
}

/** Open the edit page of the fixture provider. */
async function openEditPage(overrides = {}) {
  const section = await renderSection({
    data: { available: true, providers: [providerFixture] },
    ...overrides,
  })
  buttonByLabel(section.tree, 'list.edit').props.onClick()
  return { ...section, tree: section.render() }
}

/* -------------------------------------------------------------------------- */
/* Registration contract                                                      */
/* -------------------------------------------------------------------------- */

test('client registers the exact Remote descriptor set, locale, and three slots', async () => {
  const client = makeClient()
  await client.plugin.apply(client.ctx)

  assert.deepEqual(Array.from(client.plugin.inject), ['slots', 'remote', 'locale'])
  const payload = client.descriptors
  assert.equal(payload.package, PACKAGE)
  assert.equal(payload.descriptors.length, 19)
  assert.deepEqual([...payload.descriptors.map(descriptor => descriptor.method)], [...REMOTE_METHODS])
  for (const descriptor of payload.descriptors) {
    assert.equal(descriptor.id, `${PACKAGE}#${descriptor.method}`)
    assert.equal(descriptor.service, SERVICE_KEY)
    assert.equal(descriptor.namespace, REMOTE_NAMESPACE)
    assert.equal(descriptor.invocation.kind, 'direct')
    assert.equal(descriptor.result.mode, 'strict')
    assert.equal(descriptor.result.typeSymbol, `${PACKAGE}#res.${descriptor.method}`)
    assert.equal(descriptor.parameters.length, 1)
    const parameter = descriptor.parameters[0]
    assert.equal(parameter.name, 'request')
    assert.equal(parameter.wire, 'request')
    assert.equal(parameter.source, 'json')
    assert.equal(parameter.codec.mode, 'strict')
    assert.equal(parameter.codec.typeSymbol, `${PACKAGE}#req.${descriptor.method}`)
    assert.equal(parameter.codec.create(), null)
  }

  const section = client.slots.get(SECTION_CELL)
  assert(section)
  assert.equal(section.options.name, 'settings.section')
  assert.equal(section.options.order, 62)
  assert.equal(section.options.locale, NS)
  assert.equal(typeof section.component, 'function')
  assert.equal(section.options.label(), 'Xiaoxing API access')

  const icon = client.slots.get(ICON_CELL)
  assert(icon)
  assert.equal(typeof icon.component, 'function')
  const iconElement = icon.component({ active: true, size: 20 })
  assert.equal(iconElement.type, 'svg')
  assert.equal(iconElement.props.viewBox, '0 0 36 36')
  assert.equal(iconElement.props.fill, 'currentColor')
  assert.equal(iconElement.props.style.opacity, 1)
  assert.equal(icon.component({ active: false }).props.style.opacity, 0.78)

  // `settings.models.provider-card` is a keyed seat: the Models section
  // dispatches `entryKey = settingsNs`, so the key is the adapter family.
  const card = client.slots.get(CARD_CELL)
  assert(card)
  assert.equal(card.options.name, 'settings.models.provider-card')
  assert.equal(card.options.key, 'llm-pi-ai')
  assert.equal(card.options.locale, NS)
  assert.equal(typeof card.component, 'function')

  const dictionaries = client.locales.get(NS)
  assert(dictionaries)
  assert.equal(Object.keys(dictionaries.en).length, Object.keys(dictionaries.zh).length)

  client.dispose()
  assert.equal(client.locales.size, 0)
  assert.equal(client.slots.size, 0)
})

test('Remote mount failure keeps every slot and locale registration in place', async () => {
  const client = makeClient({ mountFails: true })
  await client.plugin.apply(client.ctx)
  assert.equal(client.slots.size, 3)
  assert(client.slots.has(SECTION_CELL))
  assert(client.slots.has(ICON_CELL))
  assert(client.slots.has(CARD_CELL))
  assert(client.locales.has(NS))
  assert.equal(client.logs.length, 1)
  assert.match(client.logs[0], /Remote mount failed/u)
  assert.match(client.logs[0], /simulated mount failure/u)
  client.dispose()
  assert.equal(client.slots.size, 0)
  assert.equal(client.locales.size, 0)
})

test('EN and ZH dictionaries stay in lockstep and localize every Host error code', async () => {
  const client = makeClient()
  await client.plugin.apply(client.ctx)
  const dictionaries = client.locales.get(NS)
  const en = dictionaries.en
  const zh = dictionaries.zh
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const language of ['en', 'zh']) {
    const dictionary = dictionaries[language]
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, 'string', `${language}:${key} is a string`)
      assert.notEqual(value.trim(), '', `${language}:${key} is not empty`)
    }
    for (const code of HOST_ERROR_CODES) {
      const value = dictionary[`error.${code}`]
      assert.equal(typeof value, 'string', `${language}: error.${code}`)
      assert.notEqual(value.trim(), '', `${language}: error.${code} is not empty`)
      assert.notEqual(value, `error.${code}`, `${language}: error.${code} is translated`)
    }
    for (const key of REQUIRED_KEYS) {
      assert.equal(typeof dictionary[key], 'string', `${language}:${key} exists`)
      assert.notEqual(dictionary[key].trim(), '', `${language}:${key} is not empty`)
    }
  }
  // Every statically referenced dictionary key resolves in both languages, and
  // no dead dictionary entries linger outside dynamic vocabulary prefixes.
  const used = new Set()
  for (const match of source.matchAll(/(?<![\w.])t\('([^'\\]+)'(?=[,)])/gu)) used.add(match[1])
  for (const key of used) {
    assert.equal(typeof en[key], 'string', `en dictionary defines ${key}`)
    assert.equal(typeof zh[key], 'string', `zh dictionary defines ${key}`)
  }
  const dynamicPrefix = /^(?:error\.|editor\.effort\.|protocol\.|probe\.|id\.|importFormat\.)/u
  for (const key of Object.keys(en)) {
    if (!dynamicPrefix.test(key)) assert.equal(used.has(key), true, `dictionary key "${key}" is referenced by the UI`)
  }
  assert.equal(HOST_ERROR_CODES.length, 46, 'the Host error-code vocabulary stays complete')
  for (const required of ['error.remote-unavailable', 'error.internal']) {
    assert.equal(typeof en[required], 'string', `en defines ${required}`)
    assert.equal(typeof zh[required], 'string', `zh defines ${required}`)
  }
  client.dispose()
})

test('client is browser-safe: React-only require, token-only styles, LF endings', () => {
  const requires = [...source.matchAll(/require\(([^)]*)\)/gu)].map(match => match[1].trim())
  assert(requires.length > 0)
  assert.deepEqual(Array.from(new Set(requires)), ["'react'"])
  assert.equal(source.includes('@deepseek-ai/'), false)
  assert.equal(/^\s*import\s/mu.test(source), false, 'the browser half carries no ESM import')
  assert.equal(/\brequire\(\s*['"](?:fs|path|os|url|crypto|util)['"]\s*\)/u.test(source), false)

  const styles = source.match(/const STYLES = `([^`]*)`/u)?.[1] ?? ''
  assert(styles.length > 0)
  assert.equal(/#[0-9a-fA-F]{3,8}\b/u.test(styles), false, 'STYLES carries no hardcoded hex color')
  assert.equal(/\b(?:rgba?|hsla?)\(/u.test(styles), false, 'STYLES carries no literal rgb/hsl color')
  assert.match(styles, /var\(--dsw-alias-[a-z0-9-]+/u)
  assert.match(styles, /var\(--dsw-radius-[a-z0-9-]+/u)
  assert.match(styles, /var\(--ds-font-family-code/u)
  assert.match(styles, /color-mix\(in srgb/u)
  assert.match(styles, /\.xxa-root\b/u)
  assert.match(styles, /max-width: 760px/u)
  assert.match(styles, /\.xxa-switch\[aria-checked="true"\]/u)
  assert.match(styles, /:focus-visible/u)

  // Accessibility, secret handling, and no empty badge surface.
  assert.match(source, /role: 'switch'/u)
  assert.match(source, /'aria-checked'/u)
  assert.match(source, /autoComplete: 'new-password'/u)
  assert.match(source, /type: current\.showKey === true \? 'text' : 'password'/u)
  assert.match(source, /apiKey: ''/u)
  assert.equal(/apiKey:\s*provider\./u.test(source), false)
  assert.equal(source.includes('credential.masked'), false)
  assert.match(source, /if \(text === '' \|\| text === undefined \|\| text === null\) return null/u)

  assert.equal(source.includes('\r'), false, 'LF line endings')
  assert.equal(source.endsWith('\n'), true, 'a trailing newline exists')
  assert.equal(source.endsWith('\n\n'), false, 'exactly one trailing newline')
})

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Evaluate the constants plus the pure helper declarations from the bundle source. */
function loadHelpers() {
  const preludeStart = source.indexOf('    const PACKAGE = ')
  const helpersStart = source.indexOf('    /**\n     * Whether a value is a plain object')
  const dictionaryStart = source.indexOf('    /** English dictionary')
  assert(preludeStart >= 0 && helpersStart > preludeStart && dictionaryStart > helpersStart)
  const names = [
    'isPlainObject', 'messageOfError', 'unwrapRemoteResult', 'formatTokenCount', 'trimFraction',
    'splitModelIds', 'parseHeadersLines', 'formatHeadersLines', 'trimTrailingHash', 'isHttpURL',
    'compatToDraft', 'buildCompatPayload', 'countCompatOverrides', 'formatCompatFields',
    'deriveCredentialRef', 'checkProviderIdDraft', 'hostOfUrl', 'endpointHost',
    'deriveDisplayNameFromUrl', 'slugifyProviderName', 'resolveUsableProviderId',
    'deriveProviderIdFromName', 'deriveProviderSlugFromUrl', 'fallbackProviderId',
    'deriveProviderIdFromDraft', 'parseOptionalPositiveInteger', 'failureText', 'vocabularyText',
    'describeProbeCheck', 'probeCheckClass', 'modelCapabilities', 'defaultReasoningEfforts',
    'buildReasoningEfforts', 'effortMapToDraft', 'providerKeyMissing',
  ]
  const program = `(function () {\n${source.slice(preludeStart, dictionaryStart)}\nreturn { ${names.join(', ')} }\n})()`
  return vm.runInThisContext(program, { filename: 'client-helpers.js' })
}

test('pure helpers unwrap both envelopes, format counts, and split model id batches', () => {
  const helpers = loadHelpers()
  assert.equal(helpers.isPlainObject({}), true)
  assert.equal(helpers.isPlainObject([]), false)
  assert.equal(helpers.isPlainObject(null), false)
  assert.equal(helpers.messageOfError(new Error('boom')), 'boom')
  assert.equal(helpers.messageOfError('plain'), 'plain')

  // Outer Remote envelope.
  assert.deepEqual(Array.from(Object.keys(helpers.unwrapRemoteResult({ ok: true, value: { ok: true, providers: [] } }))), ['ok', 'value'])
  const innerFailure = helpers.unwrapRemoteResult({ ok: true, value: { ok: false, code: 'provider-not-found', message: 'gone', details: { provider: 'x' } } })
  assert.equal(innerFailure.ok, false)
  assert.equal(innerFailure.code, 'provider-not-found')
  assert.equal(innerFailure.message, 'gone')
  assert.deepEqual(innerFailure.details, { provider: 'x' })
  const outerFailure = helpers.unwrapRemoteResult({ ok: false, error: { code: 'config-unavailable', message: 'no namespace' } })
  assert.equal(outerFailure.ok, false)
  assert.equal(outerFailure.code, 'config-unavailable')
  const unknown = helpers.unwrapRemoteResult(null)
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'internal')
  assert.deepEqual(helpers.unwrapRemoteResult({ ok: true }).value, {})

  assert.equal(helpers.formatTokenCount(1048576), '1M')
  assert.equal(helpers.formatTokenCount(200000), '200K')
  assert.equal(helpers.formatTokenCount(128000), '128K')
  assert.equal(helpers.formatTokenCount(65536), '65.5K')
  assert.equal(helpers.formatTokenCount(1500000), '1.5M')
  assert.equal(helpers.formatTokenCount(0), '0')
  assert.equal(helpers.formatTokenCount(-1), '')
  assert.equal(helpers.formatTokenCount('128000'), '')

  // Manual batch input accepts English/Chinese commas, semicolons, and new lines.
  assert.deepEqual(Array.from(helpers.splitModelIds(' a, b\nc；d;e ， f ')), ['a', 'b', 'c', 'd', 'e', 'f'])
  assert.deepEqual(Array.from(helpers.splitModelIds('a,a,b\n\n')), ['a', 'b'])
  assert.deepEqual(Array.from(helpers.splitModelIds('   ')), [])
  assert.deepEqual(Array.from(helpers.splitModelIds(null)), [])

  assert.deepEqual(helpers.parseHeadersLines('X-Test: 1\nY-Trace: two:three\n\n'), { 'X-Test': '1', 'Y-Trace': 'two:three' })
  assert.throws(() => helpers.parseHeadersLines('not a header line'), /needs "Name: value"/u)
  assert.throws(() => helpers.parseHeadersLines(': empty name'), /needs "Name: value"/u)
  assert.throws(() => helpers.parseHeadersLines('X-Empty:'), /needs a value/u)
  // A stored credential header is never pre-filled into an editable draft.
  assert.equal(helpers.formatHeadersLines({ Authorization: 'Bearer secret', 'x-api-key': 'sk-secret', 'X-Test': '1' }), 'X-Test: 1')
  assert.equal(helpers.formatHeadersLines(null), '')

  assert.deepEqual(helpers.compatToDraft({ supportsStore: false, chatTemplateKwargs: { keep: 'x' } }, 'openai-completions'), {
    supportsStore: 'false',
    chatTemplateKwargs: '{"keep":"x"}',
  })
  const responsesPayload = helpers.buildCompatPayload({ supportsDeveloperRole: 'true', supportsStrictMode: 'maybe', supportsStore: 'false' }, 'openai-responses')
  assert.deepEqual(responsesPayload.compat, { supportsDeveloperRole: true })
  assert.deepEqual(responsesPayload.invalid, ['supportsStrictMode'])
  const enumPayload = helpers.buildCompatPayload({ maxTokensField: 'max_tokens', thinkingFormat: 'bogus' }, 'openai-completions')
  assert.deepEqual(enumPayload.compat, { maxTokensField: 'max_tokens' })
  assert.deepEqual(enumPayload.invalid, ['thinkingFormat'])
  assert.deepEqual(helpers.buildCompatPayload({ supportsStore: 'false' }, 'google-generative-ai'), { compat: {}, invalid: [] })
  assert.equal(helpers.countCompatOverrides({ supportsStore: 'false', supportsDeveloperRole: '' }), 1)
  assert.equal(helpers.countCompatOverrides(null), 0)
  assert.equal(helpers.formatCompatFields({ supportsStore: false, maxTokensField: 'max_tokens' }), 'supportsStore=false, maxTokensField=max_tokens')

  // A discovery marker `#` is request-time only and never written to a provider.
  assert.equal(helpers.trimTrailingHash(' https://relay.example/v1# '), 'https://relay.example/v1')
  assert.equal(helpers.trimTrailingHash('https://relay.example/v1'), 'https://relay.example/v1')
  assert.equal(helpers.trimTrailingHash(''), '')
  assert.equal(helpers.isHttpURL('https://relay.example/v1'), true)
  assert.equal(helpers.isHttpURL('http://relay.example:8080/v1'), true)
  assert.equal(helpers.isHttpURL('relay.example'), false)
  assert.equal(helpers.isHttpURL('ftp://relay.example'), false)
  assert.equal(helpers.isHttpURL(''), false)

  // Only a missing key marks a provider, and capability tags stay factual.
  assert.equal(helpers.providerKeyMissing({ credential: { configured: true } }), false)
  assert.equal(helpers.providerKeyMissing({ credential: { configured: false } }), true)
  assert.equal(helpers.providerKeyMissing({}), true)
  assert.deepEqual(helpers.modelCapabilities(key => key, null), [])
  const chips = helpers.modelCapabilities(key => key, {
    contextWindow: 200000, maxTokens: 16384, input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' },
  })
  assert.deepEqual(plain(chips), [
    { text: '200K', tone: 'neutral' },
    { text: 'model.meta.output', tone: 'neutral' },
    { text: 'model.meta.image', tone: 'neutral' },
    { text: 'model.meta.reasoningTiers', tone: 'accent' },
  ])
  assert.deepEqual(plain(helpers.modelCapabilities(key => key, { input: ['text'], reasoningEfforts: false })), [])

  const translate = key => (key === 'error.invalid-api' ? 'Unknown wire protocol.' : key)
  assert.equal(helpers.failureText(translate, { code: 'invalid-api', message: 'bad' }), 'Unknown wire protocol. (bad)')
  assert.equal(helpers.failureText(translate, { code: 'not-a-code', message: 'detail' }), 'detail')
  assert.equal(helpers.failureText(translate, { code: 'not-a-code', message: '' }), 'error.internal')
  assert.equal(helpers.vocabularyText(translate, 'protocol', 'openai-completions'), 'openai-completions')
  assert.equal(helpers.vocabularyText(translate, 'protocol', 'weird-api'), 'weird-api')

  assert.equal(helpers.parseOptionalPositiveInteger('128000'), 128000)
  assert.equal(helpers.parseOptionalPositiveInteger(''), undefined)
  assert.equal(helpers.parseOptionalPositiveInteger('-1'), null)
  assert.equal(helpers.parseOptionalPositiveInteger('1.5'), null)
  assert.equal(helpers.parseOptionalPositiveInteger('abc'), null)
})

test('pure helpers derive conflict-free provider ids from names, urls, and fallbacks', () => {
  const helpers = loadHelpers()
  assert.equal(helpers.deriveCredentialRef('my-relay'), 'MY_RELAY_API_KEY')
  assert.equal(helpers.deriveCredentialRef(''), '')
  assert.equal(helpers.checkProviderIdDraft('my-relay').key, 'id.available')
  assert.equal(helpers.checkProviderIdDraft('Bad Id').key, 'id.invalid')
  assert.equal(helpers.checkProviderIdDraft('').ok, false)
  assert.equal(helpers.checkProviderIdDraft('anthropic').key, 'id.reservedBuiltin')
  assert.equal(helpers.checkProviderIdDraft('deepseek-official').key, 'id.reservedNative')

  assert.equal(helpers.hostOfUrl('https://cpa.luoli.my/v1'), 'cpa.luoli.my')
  assert.equal(helpers.hostOfUrl('cpa.luoli.my/v1'), 'cpa.luoli.my')
  assert.equal(helpers.hostOfUrl(''), '')
  assert.equal(helpers.hostOfUrl('not a url'), '')
  assert.equal(helpers.endpointHost('https://relay.example/v1'), 'relay.example')
  assert.equal(helpers.endpointHost(''), '')
  assert.equal(helpers.deriveDisplayNameFromUrl('https://www.relay.example.com/v1'), 'relay.example.com')

  // Name first, URL as the fallback for names without an ASCII slug.
  assert.equal(helpers.slugifyProviderName('OpenRouter'), 'openrouter')
  assert.equal(helpers.slugifyProviderName('My Relay 2'), 'my-relay-2')
  assert.equal(helpers.slugifyProviderName('我的中转'), '')
  assert.equal(helpers.deriveProviderIdFromName('OpenRouter', []), 'openrouter-custom', 'built-in catalog id is suffixed')
  assert.equal(helpers.deriveProviderIdFromName('我的中转', []), '')
  assert.equal(helpers.deriveProviderIdFromDraft('我的中转', 'https://openrouter.ai/api/v1', []), 'openrouter-custom')
  assert.equal(helpers.deriveProviderIdFromDraft('我的中转', 'https://cpa.luoli.my/v1', []), 'cpa')
  assert.equal(helpers.deriveProviderIdFromDraft('我的中转', '', []), 'custom-api')
  assert.equal(helpers.deriveProviderIdFromDraft('', '', ['custom-api']), 'custom-api-2')
  assert.equal(helpers.deriveProviderIdFromDraft('', '', []), 'custom-api')
  assert.equal(helpers.deriveProviderIdFromDraft('Relay', 'https://relay.example/v1', ['relay']), 'relay-2')
  assert.equal(helpers.deriveProviderIdFromDraft('', 'https://relay.example/v1', ['relay', 'relay-2']), 'relay-3')

  // A meaningful subdomain label wins without any reserved-id collision.
  assert.equal(helpers.deriveProviderSlugFromUrl('https://cpa.luoli.my/v1'), 'cpa')
  assert.equal(helpers.deriveProviderSlugFromUrl('https://relay.example.com/v1'), 'relay')
  // Generic infrastructure labels are skipped before the reserved check.
  assert.equal(helpers.deriveProviderSlugFromUrl('https://api.openai.com/v1'), 'openai-custom')
  assert.equal(helpers.deriveProviderSlugFromUrl('https://api.deepseek.com'), 'deepseek-custom')
  assert.equal(helpers.deriveProviderSlugFromUrl('https://www.anthropic.com/v1'), 'anthropic-custom')
  // Nothing derivable stays empty rather than producing an invalid id.
  assert.equal(helpers.deriveProviderSlugFromUrl(''), '')
  assert.equal(helpers.deriveProviderSlugFromUrl('not a url'), '')

  // A non-standard port keeps loopback and local relays distinguishable.
  assert.equal(helpers.deriveProviderSlugFromUrl('http://127.0.0.1:8080/v1'), 'local-8080')
  assert.equal(helpers.deriveProviderSlugFromUrl('http://localhost:3000/v1'), 'local-3000')
  assert.equal(helpers.deriveProviderSlugFromUrl('https://localhost/v1'), 'local')
  assert.equal(helpers.deriveProviderSlugFromUrl('https://relay.example.com:8443/v1'), 'relay-8443')
  assert.equal(helpers.resolveUsableProviderId('relay', ['relay', 'relay-2']), 'relay-3')
  assert.equal(helpers.fallbackProviderId([]), 'custom-api')
  assert.equal(helpers.fallbackProviderId(['custom-api']), 'custom-api-2')
})

test('reasoning drafts keep off: null, seed protocol defaults, and map blank values', () => {
  const helpers = loadHelpers()
  // `off: null` stays an explicit null and blank levels fall back to their name.
  assert.deepEqual(plain(helpers.buildReasoningEfforts({ reasoning: true, efforts: { off: null, high: 'high' } }, 'openai-completions')), { off: null, high: 'high' })
  assert.deepEqual(plain(helpers.buildReasoningEfforts({ reasoning: true, efforts: { off: '', minimal: '' } }, 'openai-completions')), { off: null, minimal: 'minimal' })
  assert.equal(helpers.buildReasoningEfforts({ reasoning: false, efforts: { high: 'high' } }, 'openai-completions'), false, 'a non-reasoning model stays false')
  assert.equal(helpers.buildReasoningEfforts({ reasoning: true, efforts: { off: null } }, 'openai-completions'), undefined, 'off alone is not a checked level')
  assert.equal(helpers.buildReasoningEfforts({ reasoning: true, efforts: {} }, 'openai-completions'), undefined)
  assert.deepEqual(plain(helpers.buildReasoningEfforts({ reasoning: true, efforts: { minimal: 'minimal' } }, 'google-generative-ai')), { minimal: 'minimal' })
  assert.deepEqual(plain(helpers.defaultReasoningEfforts('openai-completions')), { off: null, low: 'low', medium: 'medium', high: 'high' })
  assert.deepEqual(plain(helpers.defaultReasoningEfforts('google-generative-ai')), { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' })
  assert.deepEqual(plain(helpers.effortMapToDraft({ off: null, high: 'high', ignored: 3 })), { off: null, high: 'high' })
  assert.deepEqual(plain(helpers.effortMapToDraft(null)), {})

  // Probe verdicts stay conservative about transport failures.
  assert.equal(helpers.describeProbeCheck({ skipped: true }), 'skipped')
  assert.equal(helpers.describeProbeCheck({ ok: true, status: 200 }), 'supported')
  assert.equal(helpers.describeProbeCheck({ ok: false, status: 500, error: 'HTTP 500' }), 'unsupported')
  assert.equal(helpers.describeProbeCheck({ ok: false, status: null, error: 'network down' }), 'error')
  assert.equal(helpers.describeProbeCheck({ accepted: null }), 'inconclusive')
  assert.equal(helpers.describeProbeCheck(null), 'inconclusive')
  assert.match(helpers.probeCheckClass('supported'), /xxa-checkSuccess/u)
  assert.match(helpers.probeCheckClass('unsupported'), /xxa-checkWarn/u)
  assert.match(helpers.probeCheckClass('error'), /xxa-checkError/u)
  assert.match(helpers.probeCheckClass('inconclusive'), /xxa-checkMuted/u)
})

/* -------------------------------------------------------------------------- */
/* Provider-card extras                                                       */
/* -------------------------------------------------------------------------- */

test('provider-card extras render nothing for native, built-in, and undeclared routes', async () => {
  const client = makeClient()
  await client.plugin.apply(client.ctx)
  const component = client.slots.get(CARD_CELL).component
  const t = key => key
  assert.equal(component({ t }), null, 'a missing provider prop renders nothing')
  assert.equal(component({ provider: null, t }), null, 'a null provider renders nothing')
  assert.equal(component({ provider: { provider: 'anthropic' }, configured: true, t }), null)
  assert.equal(component({ provider: { provider: 'anthropic', declared: false }, configured: true, t }), null)
  assert.equal(component({ provider: { provider: 'deepseek-official' }, t }), null)
  client.dispose()
})

test('provider-card extras keep one quiet managed strip with its own stylesheet', async () => {
  const { client, tree } = await renderExtras({ probe: { healthy: true, checks: { connectivity: { ok: true, status: 200 } } } })
  assert.equal(tree.type, 'div')
  assert.match(tree.props.className, /xxa-cardExtras/u)
  const text = uiText(tree)
  assert.match(text, /providerCard\.managed/u)

  // The card seat mounts independently of the settings section, so the extras
  // must carry the stylesheet themselves.
  const styleChild = tree.props.children.find(child => typeof child === 'object' && child !== null && child.type === 'style')
  assert(styleChild, 'the configured extras render their own <style>')
  const styleText = textOf(styleChild).join('')
  assert.match(styleText, /\.xxa-cardExtras/u)
  assert.match(styleText, /\.xxa-badge/u)
  assert.match(styleText, /max-width: 760px/u)

  // One probe action and one verdict; no audit/complete action remains.
  const buttons = findElements(tree, node => node.type === 'button').map(node => textOf(node).join('').trim())
  assert.deepEqual(buttons, ['providerCard.probe'])
  assert.match(text, /providerCard\.healthy/u)
  assert.match(text, /connectivity: probe\.supported/u)
  for (const badge of collectBadges(tree)) assert.notEqual(badge.text, '', `badge "${badge.className}" has text`)

  // An unconfigured declared row still explains itself instead of disappearing.
  const guard = client.slots.get(CARD_CELL).component
  const extraGuard = guard({ provider: client.realmValue({ provider: 'my-relay', declared: true }), configured: false, t: key => key })
  assert.notEqual(extraGuard, null)
  client.react.begin()
  const unconfiguredTree = extraGuard.type(extraGuard.props)
  assert.match(uiText(unconfiguredTree), /providerCard\.unconfigured/u)
  assert(unconfiguredTree.props.children.some(child => typeof child === 'object' && child !== null && child.type === 'style'))
  client.dispose()
})

test('provider-card extras probe their provider and report failures', async () => {
  const client = makeClient({ responses: { probe: { healthy: false, checks: { chat: { ok: false, status: 500 } } } } })
  await client.plugin.apply(client.ctx)
  const component = client.slots.get(CARD_CELL).component
  const props = { provider: client.realmValue({ provider: 'my-relay', declared: true }), configured: true, t: key => key }
  const render = () => {
    client.react.begin()
    const guard = component(props)
    return guard.type({ ...props, ...guard.props })
  }
  const tree = render()
  buttonByLabel(tree, 'providerCard.probe').props.onClick()
  await settle()
  const probeCall = client.remoteCalls.find(call => call.method === 'probe')
  assert(probeCall)
  assert.deepEqual(plain(probeCall.request), { provider: 'my-relay' })
  const probed = render()
  assert.match(uiText(probed), /providerCard\.unhealthy/u)
  assert.match(uiText(probed), /chat: probe\.unsupported/u)
  client.dispose()

  const failing = await renderExtras({ failure: { code: 'network-error', message: 'relay down' } })
  assert.match(uiText(failing.tree), /relay down/u)
  failing.client.dispose()
})

/* -------------------------------------------------------------------------- */
/* Level one: the provider list                                               */
/* -------------------------------------------------------------------------- */

test('the first level is one calm list: title, one primary action, empty state', async () => {
  const { client, tree } = await renderSection({ data: { available: true, providers: [] }, view: settledView() })
  assert.equal(tree.type, 'div')
  assert.match(tree.props.className, /xxa-root/u)
  const rootStyle = tree.props.children.find(child => typeof child === 'object' && child !== null && child.type === 'style')
  assert(rootStyle, 'the section renders one <style>')
  assert.match(textOf(rootStyle).join(''), /\.xxa-root/u)

  const text = uiText(tree)
  assert.match(text, /title/u)
  assert.match(text, /subtitle/u)
  // Header stays calm without top-right buttons; Connect API and the compact refresh sit in the lower list bar.
  const header = findElements(tree, node => node.type === 'header')[0]
  const headerButtons = findElements(header, node => node.type === 'button').map(node => textOf(node).join('').trim())
  assert.deepEqual(headerButtons, [])
  const listBar = findElements(tree, node => node.props?.className === 'xxa-listBar')[0]
  assert(listBar, 'the lower action bar holds Connect API and compact refresh')
  const listBarButtons = findElements(listBar, node => node.type === 'button')
  assert.deepEqual(listBarButtons.map(node => textOf(node).join('').trim()), ['list.connect', 'header.refresh'])
  assert.match(listBarButtons[1].props.className, /xxa-btnSmall/u, 'refresh button stays compact')
  // Level-one advanced settings is present and collapsed by default.
  const fold = findElements(tree, node => node.type === 'details' && node.props?.className === 'xxa-fold')[0]
  assert(fold, 'level-one advanced fold exists')
  assert.equal(fold.props.open, undefined, 'level-one advanced fold is collapsed by default')
  assert.match(text, /listAdvanced\.title/u)
  assert.match(text, /list\.emptyTitle/u)
  assert.match(text, /list\.emptyHint/u)
  for (const gone of ['syncAll', 'summary.', 'quick.', 'advanced.', 'form.saveCreate', 'editor.', 'filter.empty', 'provider.complete']) {
    assert.equal(text.includes(gone), false, `"${gone}" is not on the first level`)
  }
  assert.equal(source.includes('summaryStrip'), false)
  assert.equal(source.includes('xxa-statTiles'), false, 'no filter tiles')
  assert.equal(source.includes('dangerouslySetInnerHTML'), false)

  // A loading first read shows only the calm loading hint, not the empty state.
  const loading = await renderSection({ data: { available: true, providers: [] }, view: { busy: true, loaded: false, failure: null, notice: '' } })
  assert.match(uiText(loading.tree), /loading/u)
  assert.equal(uiText(loading.tree).includes('list.emptyTitle'), false)
  loading.client.dispose()
  client.dispose()
})

test('a provider row shows identity, protocol, endpoint, model count, and only fixable warnings', async () => {
  const { client, tree } = await renderSection({ data: { available: true, providers: [providerFixture] }, view: settledView() })
  const text = uiText(tree)
  assert.match(text, /My relay/u)
  assert.match(text, /openai-completions/u)
  assert.match(text, /relay\.example/u)
  assert.match(text, /list\.models/u)
  const endpointNode = findElements(tree, node => node.props?.className === 'xxa-endpoint')[0]
  assert.equal(endpointNode?.props?.title, 'https://relay.example/v1', 'the full URL lives in the tooltip')
  assert.equal(findElements(tree, node => typeof node.props?.className === 'string' && node.props.className.includes('xxa-markTile')).length, 1)
  const actions = findElements(tree, node => node.props?.className === 'xxa-providerActions')[0]
  assert.deepEqual(findElements(actions, node => node.type === 'button').map(node => textOf(node).join('').trim()), ['list.edit', 'list.delete'])
  // Nothing to read when nothing is wrong: no sync mode, no last-synced time, no audit noise.
  assert.equal(findElements(tree, node => /xxa-statusLabel/u.test(node.props?.className ?? '')).length, 0)
  for (const gone of ['add-new', 'provider.lastSynced', 'provider.sync', 'provider.complete', 'audit']) {
    assert.equal(text.includes(gone), false, `"${gone}" is not on the row`)
  }
  client.dispose()

  const keyless = await renderSection({
    data: { available: true, providers: [{ ...providerFixture, credential: { configured: false } }] },
    view: settledView(),
  })
  const flags = findElements(keyless.tree, node => /xxa-statusLabelError/u.test(node.props?.className ?? ''))
  assert.equal(flags.length, 1, 'the one state that stops a channel working is flagged once')
  assert.match(uiText(keyless.tree), /list\.missingKey/u)
  keyless.client.dispose()
})

test('the provider search appears only once the list is long enough to scan', async () => {
  const provider = index => ({
    ...providerFixture,
    provider: `relay-${index}`,
    displayName: `Relay ${index}`,
    baseURL: `https://relay-${index}.example/v1`,
  })
  const few = await renderSection({
    data: { available: true, providers: [1, 2, 3, 4, 5].map(provider) },
    view: settledView(),
    filter: { search: 'relay-9' },
  })
  assert.equal(findElements(few.tree, node => node.type === 'input' && node.props.placeholder === 'list.search').length, 0)
  assert.match(uiText(few.tree), /Relay 5/u, 'a search typed earlier never hides a short list')
  few.client.dispose()

  const { client, tree, render } = await renderSection({
    data: { available: true, providers: [1, 2, 3, 4, 5, 6].map(provider) },
    view: settledView(),
  })
  fieldByPlaceholder(tree, 'list.search').props.onChange({ target: { value: 'relay-6.example' } })
  let text = uiText(render())
  assert.match(text, /Relay 6/u)
  assert.equal(text.includes('Relay 1'), false)
  fieldByPlaceholder(render(), 'list.search').props.onChange({ target: { value: 'does-not-exist' } })
  const emptyFiltered = render()
  assert.match(uiText(emptyFiltered), /list\.filterEmpty/u)
  buttonByLabel(emptyFiltered, 'list.clear').props.onClick()
  assert.match(uiText(render()), /Relay 1/u)
  client.dispose()
})

test('deleting a provider asks once inline, with an optional key removal', async () => {
  const { client, tree, render } = await renderSection({
    data: { available: true, providers: [providerFixture] },
    view: settledView(),
    responses: { removeProvider: { removed: true }, listCustomProviders: { available: true, providers: [] } },
  })
  buttonByLabel(tree, 'list.delete').props.onClick()
  let confirmTree = render()
  const confirmText = uiText(confirmTree)
  assert.match(confirmText, /list\.deleteTitle/u)
  assert.match(confirmText, /list\.deleteHint/u)
  assert.match(confirmText, /list\.deleteCredential/u)
  assert.equal(client.react.cells[4].provider, 'my-relay')
  assert.equal(client.react.cells[4].removeCredential, false)

  // Cancel leaves the provider alone.
  buttonByLabel(confirmTree, 'common.cancel').props.onClick()
  assert.equal(client.react.cells[4], null)
  assert.equal(client.remoteCalls.some(call => call.method === 'removeProvider'), false)

  // Confirm with the credential checkbox forwards both flags.
  buttonByLabel(render(), 'list.delete').props.onClick()
  confirmTree = render()
  checkboxByText(confirmTree, 'list.deleteCredential').props.onChange({ target: { checked: true } })
  assert.equal(client.react.cells[4].removeCredential, true)
  buttonByLabel(render(), 'list.deleteConfirm').props.onClick()
  await settle()
  const removal = client.remoteCalls.find(call => call.method === 'removeProvider')
  assert(removal)
  assert.deepEqual(plain(removal.request), { provider: 'my-relay', removeCredential: true })
  assert.equal(client.react.cells[4], null)
  assert.equal(client.react.cells[1].notice, 'list.deleted')
  client.dispose()
})

test('opening the page only reads the list; sync stays a Host background duty', async () => {
  const { client, render } = await renderSection({
    data: { available: true, providers: [] },
    view: { busy: true, loaded: false, failure: null, notice: '' },
    responses: { listCustomProviders: { available: true, providers: [providerFixture] }, presets: { presets: [] } },
  })
  render()
  assert.equal(client.react.effects.length, 1)
  client.react.effects[0]()
  await settle()
  assert.deepEqual(client.remoteCalls.map(call => call.method), ['listCustomProviders'], 'the page never triggers a model sync or catalog read')
  assert.equal(client.react.cells[0].providers.length, 1)
  assert.equal(client.react.cells[1].loaded, true)
  assert.equal(client.react.cells[1].busy, false)

  // The explicit refresh re-reads the list.
  const tree = render()
  buttonByLabel(tree, 'header.refresh').props.onClick()
  await settle()
  assert.equal(client.remoteCalls.filter(call => call.method === 'listCustomProviders').length, 2)
  client.dispose()

  const unavailable = await renderSection({
    data: { available: false, providers: [] },
    view: settledView(),
    responses: { listCustomProviders: { available: false, providers: [] } },
  })
  assert.match(uiText(unavailable.tree), /list\.unavailable/u)
  unavailable.client.dispose()
})

test('a failed action keeps its explanation through the successful re-read', async () => {
  const { client, tree, render } = await renderSection({
    data: { available: true, providers: [providerFixture] },
    view: settledView(),
    responses: {
      removeProvider: { ok: false, code: 'provider-not-found', message: 'gone' },
      listCustomProviders: { available: true, providers: [providerFixture] },
    },
  })
  buttonByLabel(tree, 'list.delete').props.onClick()
  const confirmTree = render()
  buttonByLabel(confirmTree, 'list.deleteConfirm').props.onClick()
  await settle()
  assert.equal(client.react.cells[1].failure.code, 'provider-not-found', 'the failure survives the re-read')
  const rendered = render()
  assert.match(uiText(rendered), /error\.title/u)
  assert.match(uiText(rendered), /gone/u)
  client.dispose()
})

test('level-one advanced fold lazily loads catalog models, binds unmatched models, unbinds, and handles registry/IO actions', async () => {
  const unmatchedProvider = {
    ...providerFixture,
    models: [
      ...providerFixture.models,
      { id: 'my-weird-alias', name: 'My Weird Alias', contextWindow: 128000, maxTokens: 16384, input: ['text'] },
    ],
    unmatchedModels: ['my-weird-alias'],
    upstreamBindings: {},
  }
  const boundProvider = {
    ...providerFixture,
    models: [
      ...providerFixture.models,
      { id: 'my-weird-alias', name: 'My Weird Alias', contextWindow: 200000, maxTokens: 64000, input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' } },
    ],
    unmatchedModels: [],
    upstreamBindings: {
      'my-weird-alias': { upstreamModel: 'claude-sonnet-4-5', matched: true, matchedSource: 'catalog' },
    },
  }
  const section = await renderSection({
    data: { available: true, providers: [unmatchedProvider] },
    view: settledView(),
    responses: {
      getRegistryStatus: {
        modelCount: 1200,
        checkedAt: '2026-11-23T12:00:00.000Z',
        stale: false,
        offlineOnly: false,
        settings: { offlineOnly: false },
        catalogTotal: 1200,
        catalogModels: [
          { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200000, maxTokens: 64000, input: ['text', 'image'], reasoning: true, source: 'models.dev' },
        ],
      },
      saveOverride: {
        provider: 'my-relay',
        model: 'my-weird-alias',
        override: { upstreamModel: 'claude-sonnet-4-5' },
        meta: { matchedCatalogId: 'claude-sonnet-4-5', matchedRegistryId: null, matchedRuleId: 'claude-4-5', upstreamModel: 'claude-sonnet-4-5' },
      },
      listCustomProviders: { available: true, providers: [boundProvider] },
      refreshRegistry: { updated: true, modelCount: 1250 },
      importConfig: { importedCount: 1, format: 'xiaoxing-json' },
      exportConfig: { count: 1, format: 'xiaoxing-api-manager-v1', exportedAt: '2026-11-23T12:00:00.000Z', providers: {} },
    },
  })

  // Collapsed by default and shows unmatched badge before expanding.
  const fold = findElements(section.tree, node => node.type === 'details' && node.props?.className === 'xxa-fold')[0]
  assert.equal(fold.props.open, undefined)
  assert.match(uiText(section.tree), /listAdvanced\.unmatchedBadge/u)
  assert.equal(section.client.remoteCalls.length, 0)

  // Expanding lazily fetches registry status + catalog candidates.
  fold.props.onToggle({ target: { open: true } })
  await settle()
  assert.equal(section.client.remoteCalls.some(call => call.method === 'getRegistryStatus'), true)

  // Open inline binding panel for the unmatched model and bind via candidate button.
  let tree = section.render()
  assert.match(uiText(tree), /my-weird-alias/u)
  buttonByLabel(tree, 'listAdvanced.bind').props.onClick()
  await settle()
  tree = section.render()
  assert.match(uiText(tree), /claude-sonnet-4-5/u)
  buttonByLabel(tree, 'listAdvanced.bindPick').props.onClick()
  await settle()
  const bindCall = section.client.remoteCalls.find(call => call.method === 'saveOverride')
  assert(bindCall)
  assert.deepEqual(plain(bindCall.request), {
    provider: 'my-relay',
    modelId: 'my-weird-alias',
    override: { upstreamModel: 'claude-sonnet-4-5' },
  })
  assert.equal(section.client.react.cells[1].notice, 'listAdvanced.bindSaved')

  // After re-read, the bound model offers rebind and unbind; unbinding sends upstreamModel: null.
  tree = section.render()
  assert.match(uiText(tree), /listAdvanced\.boundTo/u)
  buttonByLabel(tree, 'listAdvanced.unbind').props.onClick()
  await settle()
  const unbindCall = section.client.remoteCalls.filter(call => call.method === 'saveOverride')[1]
  assert(unbindCall)
  assert.deepEqual(plain(unbindCall.request), {
    provider: 'my-relay',
    modelId: 'my-weird-alias',
    override: { upstreamModel: null },
  })
  assert.equal(section.client.react.cells[1].notice, 'listAdvanced.unbindSaved')

  // Registry refresh sends only { force: true }, and offline toggle announces its state.
  tree = section.render()
  buttonByLabel(tree, 'listAdvanced.registryRefresh').props.onClick()
  await settle()
  const refreshCall = section.client.remoteCalls.find(call => call.method === 'refreshRegistry')
  assert(refreshCall)
  assert.deepEqual(plain(refreshCall.request), { force: true })

  tree = section.render()
  checkboxByText(tree, 'listAdvanced.registryOffline').props.onChange({ target: { checked: true } })
  await settle()
  const offlineCall = section.client.remoteCalls.filter(call => call.method === 'refreshRegistry')[1]
  assert(offlineCall)
  assert.deepEqual(plain(offlineCall.request), { offlineOnly: true, force: false })
  assert.equal(section.client.react.cells[1].notice, 'listAdvanced.registryOfflineOn')

  tree = section.render()
  buttonByLabel(tree, 'listAdvanced.exportButton').props.onClick()
  await settle()
  assert.equal(section.client.remoteCalls.some(call => call.method === 'exportConfig'), true)
  assert.deepEqual(JSON.parse(section.client.react.cells[5].exportText), {
    format: 'xiaoxing-api-manager-v1',
    exportedAt: '2026-11-23T12:00:00.000Z',
    providers: {},
  })

  // Import config sends textarea payload and format.
  tree = section.render()
  fieldByPlaceholder(tree, 'listAdvanced.importPlaceholder').props.onChange({ target: { value: '{"providers":{}}' } })
  tree = section.render()
  buttonByLabel(tree, 'listAdvanced.importButton').props.onClick()
  await settle()
  const importCall = section.client.remoteCalls.find(call => call.method === 'importConfig')
  assert(importCall)
  assert.deepEqual(plain(importCall.request), { payload: '{"providers":{}}', format: 'auto' })
  assert.equal(section.client.react.cells[1].notice, 'listAdvanced.importDone')
  section.client.dispose()

  // A failed catalog read stays inside the fold with an inline retry and does not overwrite page-level errors.
  const failingCatalog = await renderSection({
    data: { available: true, providers: [unmatchedProvider] },
    view: settledView(),
    responses: {
      getRegistryStatus: { ok: false, code: 'network-error', message: 'catalog down' },
    },
  })
  findElements(failingCatalog.tree, node => node.type === 'details' && node.props?.className === 'xxa-fold')[0].props.onToggle({ target: { open: true } })
  await settle()
  const failedFoldTree = failingCatalog.render()
  assert.equal(failingCatalog.client.react.cells[1].failure, null)
  assert.match(uiText(failedFoldTree), /listAdvanced\.catalogFailed/u)
  assert.match(uiText(failedFoldTree), /listAdvanced\.catalogRetry/u)
  failingCatalog.client.dispose()
})

/* -------------------------------------------------------------------------- */
/* Level two: create                                                          */
/* -------------------------------------------------------------------------- */

test('create opens the shared form with the connection card and auto-match on', async () => {
  const { client, tree } = await openCreatePage()
  assert.equal(client.react.cells[2].mode, 'create')
  assert.equal(client.react.cells[2].autoMatch, true)
  const text = uiText(tree)
  assert.match(text, /form\.createTitle/u)
  assert.match(text, /form\.connection/u)
  assert.match(text, /form\.autoMatch/u)
  assert.match(text, /form\.models/u)
  assert.match(text, /advanced\.title/u, 'the advanced fold is collapsed, not absent')
  assert.equal(findElements(tree, node => node.type === 'details').length, 1)
  assert.equal(findElements(tree, node => node.props?.role === 'switch' && node.props['aria-label'] === 'form.autoMatch').length, 1)
  // The create page starts from empty connection fields and no echoed secret.
  const passwordFields = findElements(tree, node => node.type === 'input' && node.props.type === 'password')
  assert.equal(passwordFields.length, 1)
  assert.equal(passwordFields[0].props.value, '')
  assert.equal(passwordFields[0].props.autoComplete, 'new-password')
  client.dispose()

  // The back action returns to the list and drops the draft.
  buttonByLabel(tree, 'common.back').props.onClick()
  assert.equal(client.react.cells[2], null)
})

test('a typed name and url always derive a valid provider id', async () => {
  // A readable name wins, and a built-in catalog id is suffixed.
  const first = await openCreatePage()
  fieldByPlaceholder(first.tree, 'form.namePlaceholder').props.onChange({ target: { value: 'OpenRouter' } })
  assert.equal(first.client.react.cells[2].provider, 'openrouter-custom')
  assert.equal(first.client.react.cells[2].apiKeyEnv, 'OPENROUTER_CUSTOM_API_KEY')
  let tree = first.render()
  fieldByPlaceholder(tree, 'form.baseURLPlaceholder').props.onChange({ target: { value: 'https://openrouter.ai/api/v1' } })
  assert.equal(first.client.react.cells[2].provider, 'openrouter-custom')
  first.client.dispose()

  // A Chinese name falls back to the URL hostname, then to custom-api.
  const chinese = await openCreatePage()
  fieldByPlaceholder(chinese.tree, 'form.namePlaceholder').props.onChange({ target: { value: '我的中转' } })
  assert.equal(chinese.client.react.cells[2].provider, 'custom-api')
  tree = chinese.render()
  fieldByPlaceholder(tree, 'form.baseURLPlaceholder').props.onChange({ target: { value: 'https://cpa.luoli.my/v1' } })
  assert.equal(chinese.client.react.cells[2].provider, 'cpa')
  assert.equal(chinese.client.react.cells[2].apiKeyEnv, 'CPA_API_KEY')
  chinese.client.dispose()

  // A derived id never collides with an id the page already lists.
  const taken = await renderSection({
    data: { available: true, providers: [{ ...providerFixture, provider: 'relay' }] },
    view: settledView(),
  })
  buttonByLabel(taken.tree, 'list.connect').props.onClick()
  fieldByPlaceholder(taken.render(), 'form.baseURLPlaceholder').props.onChange({ target: { value: 'https://relay.example.com/v1' } })
  assert.equal(taken.client.react.cells[2].provider, 'relay-2')
  taken.client.dispose()

  // A manual advanced id wins over later identity edits.
  const manual = await openCreatePage()
  fieldByPlaceholder(manual.tree, 'form.namePlaceholder').props.onChange({ target: { value: 'Relay' } })
  tree = manual.render()
  controlByLabel(tree, 'advanced.provider').props.onChange({ target: { value: 'relay-manual' } })
  tree = manual.render()
  fieldByPlaceholder(tree, 'form.baseURLPlaceholder').props.onChange({ target: { value: 'https://other.example/v1' } })
  assert.equal(manual.client.react.cells[2].provider, 'relay-manual')
  assert.equal(manual.client.react.cells[2].providerDirty, true)
  manual.client.dispose()
})

test('manual models enrich, prefill, and clear the batch input', async () => {
  const { client, tree } = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay',
      provider: 'my-relay',
      providerDirty: true,
      baseURL: 'https://relay.example/v1',
      manualModelInput: 'manual-model',
    }),
    responses: {
      enrich: {
        models: [{
          id: 'manual-model',
          profile: { id: 'manual-model', name: 'Manual Model', contextWindow: 200000, maxTokens: 8192, input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' } },
        }],
      },
    },
  })
  buttonByLabel(tree, 'form.manualAdd').props.onClick()
  await settle()
  const enrichCall = client.remoteCalls.find(call => call.method === 'enrich')
  assert(enrichCall, 'the manual id is enriched through the Host')
  assert.deepEqual(plain(enrichCall.request.models), [{ id: 'manual-model' }])
  assert.equal(enrichCall.request.api, 'openai-completions')
  assert.equal(enrichCall.request.presetId, 'custom-relay-openai')
  const draft = client.react.cells[2]
  assert.equal(draft.manualModelInput, '')
  assert.equal(draft.models.length, 1)
  assert.equal(draft.models[0].id, 'manual-model')
  assert.equal(draft.models[0].name, 'Manual Model')
  assert.equal(draft.models[0].contextWindow, '200000')
  assert.equal(draft.models[0].input.includes('image'), true)
  assert.equal(draft.models[0].reasoning, true)
  assert.deepEqual(plain(draft.models[0].efforts), { off: null, high: 'high' })
  assert.equal(client.react.cells[1].notice, 'form.modelsAdded')
  client.dispose()
})

test('auto-match off adds clean model entries without calling enrich', async () => {
  const { client, tree } = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay',
      provider: 'my-relay',
      providerDirty: true,
      baseURL: 'https://relay.example/v1',
      autoMatch: false,
      manualModelInput: 'a, b',
    }),
  })
  buttonByLabel(tree, 'form.manualAdd').props.onClick()
  await settle()
  assert.equal(client.remoteCalls.some(call => call.method === 'enrich'), false, 'auto-match off never enriches')
  const models = client.react.cells[2].models
  assert.deepEqual(plain(models.map(model => model.id)), ['a', 'b'])
  assert.deepEqual(plain(models[0]), {
    key: models[0].key,
    id: 'a',
    name: '',
    contextWindow: '',
    maxTokens: '',
    input: ['text'],
    reasoning: false,
    efforts: {},
    discovered: null,
  })
  client.dispose()

  // Fetched models added with auto-match off stay clean entries too.
  const fetched = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay',
      provider: 'my-relay',
      providerDirty: true,
      baseURL: 'https://relay.example/v1',
      autoMatch: false,
    }),
    responses: { discover: { models: [{ id: 'c', contextWindow: 1000, input: ['text', 'image'] }, { id: 'd' }] } },
  })
  buttonByLabel(fetched.tree, 'form.fetch').props.onClick()
  await settle()
  let rendered = fetched.render()
  buttonByLabel(rendered, 'form.discoverySelectAll').props.onClick()
  rendered = fetched.render()
  buttonByLabel(rendered, 'form.discoveryAddSelected').props.onClick()
  await settle()
  assert.equal(fetched.client.remoteCalls.some(call => call.method === 'enrich'), false, 'no enrich without auto-match')
  const fetchedModels = fetched.client.react.cells[2].models
  assert.deepEqual(plain(fetchedModels.map(model => model.id)), ['c', 'd'])
  assert.equal(fetchedModels[0].contextWindow, '', 'endpoint facts are not applied when auto-match is off')
  assert.deepEqual(plain(fetchedModels[0].input), ['text'])
  fetched.client.dispose()
})

test('batch input splits on every separator, trims, and de-duplicates', async () => {
  const { client, tree } = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay', provider: 'my-relay', providerDirty: true, baseURL: 'https://relay.example/v1',
      manualModelInput: ' a, b\nc；d; e ，a ',
    }),
    responses: { enrich: request => ({ models: request.models.map(entry => ({ id: entry.id, profile: { id: entry.id, name: entry.id } })) }) },
  })
  buttonByLabel(tree, 'form.manualAdd').props.onClick()
  await settle()
  const enrichCall = client.remoteCalls.find(call => call.method === 'enrich')
  assert.deepEqual(plain(enrichCall.request.models.map(entry => entry.id)), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(plain(client.react.cells[2].models.map(model => model.id)), ['a', 'b', 'c', 'd', 'e'])
  client.dispose()

  // Empty input fails without a Remote call.
  const empty = await openCreatePage({
    draft: createDraftFixture({ displayName: 'My relay', provider: 'my-relay', providerDirty: true, manualModelInput: '   ' }),
  })
  buttonByLabel(empty.tree, 'form.manualAdd').props.onClick()
  await settle()
  assert.equal(empty.client.react.cells[1].failure.code, 'invalid-model-id')
  assert.equal(empty.client.react.cells[1].failure.message, 'form.manualEmpty')
  assert.equal(empty.client.remoteCalls.length, 0)
  empty.client.dispose()

  // An id already configured is skipped with a notice, not duplicated.
  const duplicate = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay', provider: 'my-relay', providerDirty: true,
      manualModelInput: 'a',
      models: [modelFixture('a')],
    }),
  })
  buttonByLabel(duplicate.tree, 'form.manualAdd').props.onClick()
  await settle()
  assert.equal(duplicate.client.remoteCalls.some(call => call.method === 'enrich'), false)
  assert.equal(duplicate.client.react.cells[2].models.length, 1)
  assert.equal(duplicate.client.react.cells[1].notice, 'form.duplicateSkipped')
  duplicate.client.dispose()
})

test('the discover panel filters, selects, and adds fetched models with their endpoint facts', async () => {
  const fetched = [
    { id: 'a', name: 'Alpha', contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'], reasoning: true, reasoningDeclared: true, allowOff: true, efforts: ['low', 'high'] },
    { id: 'b' },
  ]
  const { client, tree } = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay',
      provider: 'my-relay',
      providerDirty: true,
      baseURL: 'https://relay.example/v1',
      apiKey: 'sk-typed',
      apiKeyEnv: 'MY_RELAY_API_KEY',
      headersText: 'X-Test: 1',
    }),
    responses: {
      discover: { models: fetched, suggestedBaseURL: 'https://relay.example/v1' },
      enrich: request => ({
        models: request.models.map(entry => ({
          id: entry.id,
          profile: { id: entry.id, name: entry.name ?? entry.id, contextWindow: entry.contextWindow ?? 200000, maxTokens: entry.maxTokens ?? 8192, input: entry.input ?? ['text'] },
        })),
      }),
    },
  })
  buttonByLabel(tree, 'form.fetch').props.onClick()
  await settle()
  const discoverCall = client.remoteCalls.find(call => call.method === 'discover')
  assert(discoverCall)
  assert.equal(discoverCall.request.baseURL, 'https://relay.example/v1')
  assert.equal(discoverCall.request.api, 'openai-completions')
  assert.equal(discoverCall.request.apiKey, 'sk-typed')
  assert.equal(discoverCall.request.apiKeyEnv, 'MY_RELAY_API_KEY')
  assert.deepEqual(plain(discoverCall.request.headers), { 'X-Test': '1' })
  assert.equal(discoverCall.request.provider, undefined, 'create never reuses a saved provider')
  const draft = client.react.cells[2]
  assert.equal(draft.baseURL, 'https://relay.example/v1')
  assert.equal(draft.discovery.models.length, 2)
  assert.deepEqual(plain(draft.discovery.selected), [])
  assert.equal(client.react.cells[1].notice, 'form.fetched')

  // The panel filters by id and adds a single model with one click.
  let rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  assert.match(uiText(rendered), /form\.discoveryTitle/u)
  assert.match(uiText(rendered), /form\.discoveryCount/u)
  inputByAria(rendered, 'form.discoverySearch').props.onChange({ target: { value: 'b' } })
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  const candidates = findElements(rendered, node => node.type === 'li' && typeof node.props?.className === 'string' && node.props.className.includes('xxa-candidate'))
  assert.equal(candidates.length, 1, 'the filter hides the other fetched model')
  buttonByLabel(rendered, 'form.discoveryAdd').props.onClick()
  await settle()
  const singleEnrich = client.remoteCalls.filter(call => call.method === 'enrich').at(-1)
  assert.equal(singleEnrich.request.models.length, 1)
  assert.equal(singleEnrich.request.models[0].id, 'b')
  assert.equal(client.react.cells[2].models.length, 1)

  // A fetched row already added is disabled and marked.
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  inputByAria(rendered, 'form.discoverySearch').props.onChange({ target: { value: '' } })
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  const addedRowCheckboxes = findElements(rendered, node => node.type === 'input' && node.props.type === 'checkbox' && node.props.disabled === true)
  assert.equal(addedRowCheckboxes.length, 1, 'the added row is disabled in the fetched list')
  assert.match(uiText(rendered), /form\.discoveryAdded/u)

  // Select all + batch add passes the endpoint facts through enrich.
  buttonByLabel(rendered, 'form.discoverySelectAll').props.onClick()
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  const addSelected = buttonByLabel(rendered, 'form.discoveryAddSelected')
  assert.equal(addSelected.props.disabled, false)
  addSelected.props.onClick()
  await settle()
  const batchEnrich = client.remoteCalls.filter(call => call.method === 'enrich').at(-1)
  assert.deepEqual(plain(batchEnrich.request.models.map(entry => entry.id)), ['a'])
  const passed = batchEnrich.request.models[0]
  assert.equal(passed.contextWindow, 128000)
  assert.equal(passed.maxTokens, 8192)
  assert.deepEqual(plain(passed.input), ['text', 'image'])
  assert.equal(passed.reasoning, true)
  assert.equal(passed.reasoningDeclared, true)
  assert.equal(passed.allowOff, true)
  assert.deepEqual(plain(passed.efforts), ['low', 'high'])
  assert.deepEqual(plain(client.react.cells[2].models.map(model => model.id)), ['b', 'a'])
  assert.equal(client.react.cells[1].notice, 'form.modelsAdded')
  client.dispose()
})

test('a failed enrich never blocks adding: the id is kept and the reason is shown', async () => {
  const { client, tree } = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay', provider: 'my-relay', providerDirty: true, baseURL: 'https://relay.example/v1', manualModelInput: 'm1',
    }),
    responses: { enrich: { ok: false, code: 'network-error', message: 'relay down' } },
  })
  buttonByLabel(tree, 'form.manualAdd').props.onClick()
  await settle()
  const draft = client.react.cells[2]
  assert.equal(draft.models.length, 1, 'the model is still added')
  assert.equal(draft.models[0].id, 'm1')
  assert.deepEqual(plain(draft.models[0].input), ['text'])
  assert.equal(draft.models[0].contextWindow, '')
  assert.equal(client.react.cells[1].failure.code, 'network-error')
  const rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  assert.match(uiText(rendered), /error\.title/u)
  assert.match(uiText(rendered), /relay down/u)
  client.dispose()
})

test('per-model settings edit capabilities and keep off: null', async () => {
  const { client, tree } = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay', provider: 'my-relay', providerDirty: true,
      models: [modelFixture('m1', { contextWindow: '128000', maxTokens: '8192' })],
      expandedKeys: ['model-m1'],
    }),
  })
  let rendered = tree
  assert.match(uiText(rendered), /model\.contextWindow/u)
  assert.match(uiText(rendered), /model\.reasoning/u)
  // Preset chips fill the numeric fields without inventing values.
  buttonByLabel(rendered, '1M').props.onClick()
  assert.equal(client.react.cells[2].models[0].contextWindow, '1048576')
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  buttonByLabel(rendered, '64K').props.onClick()
  assert.equal(client.react.cells[2].models[0].maxTokens, '65536')
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  controlByLabel(rendered, 'model.name').props.onChange({ target: { value: 'Friendly name' } })
  assert.equal(client.react.cells[2].models[0].name, 'Friendly name')

  // Modalities toggle independently via pill buttons.
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  buttonByLabel(rendered, 'model.image').props.onClick()
  assert.deepEqual(plain(client.react.cells[2].models[0].input), ['text', 'image'])
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  buttonByLabel(rendered, 'model.text').props.onClick()
  assert.deepEqual(plain(client.react.cells[2].models[0].input), ['image'])

  // Switching reasoning on seeds protocol defaults with off: null.
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  switchByLabel(rendered, 'model.reasoning').props.onClick()
  const seeded = client.react.cells[2].models[0]
  assert.equal(seeded.reasoning, true)
  assert.deepEqual(plain(seeded.efforts), { off: null, low: 'low', medium: 'medium', high: 'high' })
  // Hiding the details folds the model card back to a compact summary.
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  buttonByLabel(rendered, 'model.collapse').props.onClick()
  assert.deepEqual(plain(client.react.cells[2].expandedKeys), [])
  client.dispose()
})

test('the configured-model search appears only once the list is long enough', async () => {
  const models = Array.from({ length: 6 }, (_value, index) => modelFixture(`m-${index}`))
  const section = await openCreatePage({ draft: createDraftFixture({ models }) })
  const search = fieldByPlaceholder(section.tree, 'model.search')
  search.props.onChange({ target: { value: 'm-4' } })
  const rendered = section.render()
  const cards = findElements(rendered, node => node.type === 'li' && typeof node.props?.className === 'string' && node.props.className.includes('xxa-modelCard'))
  assert.equal(cards.length, 1, 'the model filter hides the other rows')
  section.client.dispose()

  const few = await openCreatePage({ draft: createDraftFixture({ models: models.slice(0, 5) }) })
  assert.equal(findElements(few.tree, node => node.type === 'input' && node.props.placeholder === 'model.search').length, 0)
  few.client.dispose()
})

test('effort tiles store off: null, custom mappings, and switch reasoning off when emptied', async () => {
  const { client } = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay', provider: 'my-relay', providerDirty: true,
      models: [modelFixture('m1', { reasoning: true, efforts: { off: null, low: 'low', medium: 'medium', high: 'high' } })],
      expandedKeys: ['model-m1'],
    }),
  })
  const section = client.slots.get(SECTION_CELL)
  const render = () => { client.react.begin(); return section.component({ t: key => key }) }
  let rendered = render()
  // Every configured tier renders a mapping input; off defaults to null.
  const offMapping = inputByAria(rendered, 'model.effortMapping: off')
  assert.equal(offMapping.props.value, '')
  assert.equal(offMapping.props.placeholder, 'null')
  // A custom mapping value replaces the tier default.
  inputByAria(rendered, 'model.effortMapping: high').props.onChange({ target: { value: 'max' } })
  assert.deepEqual(plain(client.react.cells[2].models[0].efforts), { off: null, low: 'low', medium: 'medium', high: 'max' })

  // Unchecking a tier removes it; emptying every tier switches reasoning off.
  let box = findElements(render(), node => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === 'model.reasoning: low')[0]
  box.props.onChange({ target: { checked: false } })
  assert.equal(client.react.cells[2].models[0].efforts.low, undefined)
  for (const level of ['off', 'medium', 'high']) {
    const found = findElements(render(), node => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === `model.reasoning: ${level}`)[0]
    found.props.onChange({ target: { checked: false } })
  }
  assert.equal(client.react.cells[2].models[0].reasoning, false, 'no tier left means reasoning is off')

  // Removing the model drops it from the draft.
  buttonByLabel(render(), 'model.remove').props.onClick()
  assert.equal(client.react.cells[2].models.length, 0)
  client.dispose()
})

test('matching one model re-enriches it on demand and applies the result', async () => {
  const { client } = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay', provider: 'my-relay', providerDirty: true,
      models: [modelFixture('m1')],
      expandedKeys: ['model-m1'],
    }),
    responses: {
      enrich: {
        models: [{
          id: 'm1',
          profile: { id: 'm1', name: 'Matched Name', contextWindow: 131072, maxTokens: 16384, input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' } },
        }],
      },
    },
  })
  const section = client.slots.get(SECTION_CELL)
  const render = () => { client.react.begin(); return section.component({ t: key => key }) }
  buttonByLabel(render(), 'model.match').props.onClick()
  await settle()
  const enrichCall = client.remoteCalls.find(call => call.method === 'enrich')
  assert(enrichCall)
  assert.deepEqual(plain(enrichCall.request.models), [{ id: 'm1' }])
  const model = client.react.cells[2].models[0]
  assert.equal(model.name, 'Matched Name')
  assert.equal(model.contextWindow, '131072')
  assert.equal(model.maxTokens, '16384')
  assert.deepEqual(plain(model.input), ['text', 'image'])
  assert.equal(model.reasoning, true)
  assert.deepEqual(plain(model.efforts), { off: null, high: 'high' })
  assert.equal(client.react.cells[1].notice, 'model.matched')
  client.dispose()
})

test('advanced settings expose a validated id, headers, keyed compat, and a probe', async () => {
  const { client, tree } = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay', provider: 'my-relay', providerDirty: true, baseURL: 'https://relay.example/v1', apiKey: 'sk-typed',
    }),
    responses: {
      probe: { healthy: true, checks: { connectivity: { ok: true, status: 200 } }, recommendedCompat: { supportsStore: false } },
    },
  })
  // Every Chat Completions compat field is keyed by its schema name.
  const compatFields = findElements(tree, node => typeof node.props?.key === 'string' && node.props.key.startsWith('compat-'))
  assert.equal(compatFields.length, 19, 'every Chat Completions compat field carries a key')
  assert.equal(new Set(compatFields.map(field => field.props.key)).size, 19, 'the compat keys are unique')
  assert.match(uiText(tree), /supportsDeveloperRole/u)

  // The provider id editor reports its verdict before any Host call.
  controlByLabel(tree, 'advanced.provider').props.onChange({ target: { value: 'Bad Id' } })
  let rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  assert.match(uiText(rendered), /id\.invalid/u)
  controlByLabel(rendered, 'advanced.provider').props.onChange({ target: { value: 'custom-id' } })
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  assert.match(uiText(rendered), /id\.available/u)

  // A manual id that already exists is reported before the save call.
  const conflicting = await openCreatePage({
    data: { available: true, providers: [providerFixture] },
    draft: createDraftFixture({
      displayName: 'My relay', provider: 'my-relay', providerDirty: true, baseURL: 'https://relay.example/v1',
    }),
  })
  const conflictTree = conflicting.render()
  controlByLabel(conflictTree, 'advanced.provider').props.onChange({ target: { value: 'my-relay' } })
  const conflictRendered = conflicting.render()
  assert.match(uiText(conflictRendered), /id\.exists/u)
  conflicting.client.dispose()

  // Headers are parsed from the textarea and sent with the probe.
  controlByLabel(rendered, 'advanced.headers').props.onChange({ target: { value: 'X-Test: 1' } })
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  buttonByLabel(rendered, 'advanced.probeRun').props.onClick()
  await settle()
  const probeCall = client.remoteCalls.find(call => call.method === 'probe')
  assert(probeCall)
  assert.equal(probeCall.request.baseURL, 'https://relay.example/v1')
  assert.equal(probeCall.request.api, 'openai-completions')
  assert.equal(probeCall.request.apiKey, 'sk-typed')
  assert.deepEqual(plain(probeCall.request.headers), { 'X-Test': '1' })
  assert.equal(probeCall.request.provider, undefined)

  // The recommendation fills the compat draft on one click.
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  assert.match(uiText(rendered), /advanced\.probeRecommend/u)
  buttonByLabel(rendered, 'advanced.applyRecommended').props.onClick()
  assert.equal(client.react.cells[2].compatDraft.supportsStore, 'false')
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  assert.match(uiText(rendered), /advanced\.compatActive/u)

  // The create page offers the two post-save selections.
  assert.match(uiText(rendered), /advanced\.setDefault/u)
  assert.match(uiText(rendered), /advanced\.allowSubagent/u)
  client.dispose()
})

test('saving a new provider sends one write-only, auto-matched payload', async () => {
  const { client, tree } = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay',
      api: 'openai-completions',
      baseURL: 'https://relay.example/v1#',
      apiKey: 'sk-typed',
      apiKeyEnv: 'MY_RELAY_API_KEY',
      headersText: 'X-Test: 1',
      autoMatch: true,
      compatDraft: { supportsStore: 'false' },
      setAsDefault: true,
      enableSubagent: true,
      models: [
        modelFixture('a', { name: 'Alpha', contextWindow: '128000', maxTokens: '8192', input: ['text', 'image'], reasoning: true, efforts: { off: null, high: 'high' } }),
        modelFixture('b'),
      ],
    }),
    responses: {
      upsertProvider: { provider: 'my-relay', displayName: 'My relay', modelCount: 2 },
      listCustomProviders: { available: true, providers: [] },
    },
  })
  buttonByLabel(tree, 'form.saveCreate').props.onClick()
  await settle()
  const upsert = client.remoteCalls.find(call => call.method === 'upsertProvider')
  assert(upsert, 'the create page saves through upsertProvider')
  // The name derives a valid provider id even though the advanced fold was never opened.
  assert.equal(upsert.request.provider, 'my-relay')
  assert.equal(upsert.request.displayName, 'My relay')
  assert.equal(upsert.request.baseURL, 'https://relay.example/v1', 'a trailing # is a discovery marker only')
  assert.equal(upsert.request.api, 'openai-completions')
  assert.equal(upsert.request.presetId, 'custom-relay-openai')
  assert.equal(upsert.request.autoEnrich, true)
  assert.equal(upsert.request.apiKey, 'sk-typed', 'the typed key is forwarded once, never read back')
  assert.equal(upsert.request.apiKeyEnv, 'MY_RELAY_API_KEY')
  assert.deepEqual(plain(upsert.request.headers), { 'X-Test': '1' })
  assert.deepEqual(plain(upsert.request.compat), { supportsStore: false })
  assert.deepEqual(plain(upsert.request.models), [
    { id: 'a', name: 'Alpha', contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' } },
    { id: 'b', input: ['text'], reasoningEfforts: false },
  ])
  assert.equal(upsert.request.setAsDefault, true)
  assert.equal(upsert.request.enableSubagent, true)
  assert.deepEqual(plain(upsert.request.addToSubagent), ['a', 'b'])
  assert.equal(upsert.request.syncPolicy, undefined, 'sync stays on the Host default')
  assert.equal(client.react.cells[2], null, 'the form closes on success')
  assert.equal(client.react.cells[1].notice, 'list.created')
  assert.equal(client.remoteCalls.some(call => call.method === 'listCustomProviders'), true, 'a successful save re-reads the list')
  client.dispose()

  // Auto-match off is forwarded as an explicit false and no compat is invented.
  const plainSave = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay', baseURL: 'https://relay.example/v1', autoMatch: false,
      models: [modelFixture('a')],
    }),
    responses: { upsertProvider: {}, listCustomProviders: { available: true, providers: [] } },
  })
  buttonByLabel(plainSave.tree, 'form.saveCreate').props.onClick()
  await settle()
  const plainUpsert = plainSave.client.remoteCalls.find(call => call.method === 'upsertProvider')
  assert.equal(plainUpsert.request.autoEnrich, false)
  assert.equal(plainUpsert.request.compat, undefined)
  assert.equal(plainUpsert.request.apiKey, undefined)
  plainSave.client.dispose()
})

test('invalid create drafts fail locally before any write', async () => {
  const saveWith = async draft => {
    const section = await openCreatePage({ draft })
    buttonByLabel(section.tree, 'form.saveCreate').props.onClick()
    await settle()
    return section
  }
  const base = { displayName: 'My relay', provider: 'my-relay', providerDirty: true, baseURL: 'https://relay.example/v1' }

  const noModels = await saveWith(createDraftFixture(base))
  assert.equal(noModels.client.react.cells[1].failure.code, 'invalid-provider-profile')
  assert.equal(noModels.client.react.cells[1].failure.message, 'form.needModels')
  noModels.client.dispose()

  const badNumber = await saveWith(createDraftFixture({ ...base, models: [modelFixture('a', { contextWindow: 'abc' })] }))
  assert.equal(badNumber.client.react.cells[1].failure.code, 'invalid-model-profile')
  assert.equal(badNumber.client.react.cells[1].failure.message, 'form.invalidNumber')
  badNumber.client.dispose()

  const duplicate = await saveWith(createDraftFixture({ ...base, models: [modelFixture('a'), modelFixture('a')] }))
  assert.equal(duplicate.client.react.cells[1].failure.code, 'invalid-model-profile')
  assert.equal(duplicate.client.react.cells[1].failure.message, 'form.duplicateModelId')
  duplicate.client.dispose()

  const badURL = await saveWith(createDraftFixture({ ...base, baseURL: 'relay.example' }))
  assert.equal(badURL.client.react.cells[1].failure.code, 'invalid-url')
  badURL.client.dispose()

  const badProvider = await saveWith(createDraftFixture({ ...base, provider: 'Bad Id', models: [modelFixture('a')] }))
  assert.equal(badProvider.client.react.cells[1].failure.code, 'invalid-provider-id')
  assert.equal(badProvider.client.react.cells[1].failure.message, 'id.invalid')
  badProvider.client.dispose()

  for (const failureCase of [noModels, badNumber, duplicate, badURL, badProvider]) {
    assert.equal(failureCase.client.remoteCalls.some(call => call.method === 'upsertProvider'), false)
  }
})

/* -------------------------------------------------------------------------- */
/* Level two: edit                                                            */
/* -------------------------------------------------------------------------- */

test('edit reuses the same form, pre-fills the profile, and never echoes the key', async () => {
  const { client, tree } = await openEditPage({
    data: {
      available: true,
      providers: [{
        ...providerFixture,
        headers: { 'X-Test': '1' },
        compat: { supportsStore: false },
        syncPolicy: { syncMode: 'add-new', ignoredModels: ['z'] },
        models: [
          { id: 'a', contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' } },
          { id: 'b' },
        ],
      }],
    },
  })
  assert.equal(client.react.cells[2].mode, 'edit')
  assert.equal(client.react.cells[2].provider, 'my-relay')
  const text = uiText(tree)
  assert.match(text, /form\.editTitle/u)
  assert.match(text, /form\.connection/u)
  assert.match(text, /form\.saveEdit/u)
  assert.match(text, /advanced\.providerReadonly/u)
  assert.equal(findElements(tree, node => node.type === 'input' && node.props.type === 'password').length, 1)
  const passwordFields = findElements(tree, node => node.type === 'input' && node.props.type === 'password')
  assert.equal(passwordFields[0].props.value, '', 'the saved secret is never pre-filled')
  const models = client.react.cells[2].models
  assert.deepEqual(plain(models.map(model => model.id)), ['a', 'b'])
  assert.equal(models[0].contextWindow, '128000')
  assert.equal(models[0].reasoning, true)
  assert.deepEqual(plain(models[0].efforts), { off: null, high: 'high' })
  assert.equal(models[1].contextWindow, '')
  assert.equal(client.react.cells[2].compatDraft.supportsStore, 'false')
  assert.equal(client.react.cells[2].headersText, 'X-Test: 1')
  assert.deepEqual(plain(client.react.cells[2].ignoredModels), ['z'])
  client.dispose()
})

test('edit saves the same payload shape and preserves untouched secrets and headers', async () => {
  const { client, tree, render } = await openEditPage({
    data: {
      available: true,
      providers: [{
        ...providerFixture,
        headers: { 'X-Test': '1' },
        compat: { supportsStore: false },
        syncPolicy: { syncMode: 'add-new', ignoredModels: ['z'] },
        models: [{ id: 'a', contextWindow: 128000 }, { id: 'b' }],
      }],
    },
    responses: { upsertProvider: {}, listCustomProviders: { available: true, providers: [] } },
  })
  buttonByLabel(tree, 'form.saveEdit').props.onClick()
  await settle()
  const upsert = client.remoteCalls.find(call => call.method === 'upsertProvider')
  assert(upsert)
  assert.equal(upsert.request.provider, 'my-relay')
  assert.equal(upsert.request.apiKey, undefined, 'a blank key field keeps the saved credential')
  assert.equal(upsert.request.headers, undefined, 'an untouched header draft stays out of the payload')
  assert.equal(upsert.request.autoEnrich, true)
  assert.deepEqual(plain(upsert.request.compat), { supportsStore: false })
  assert.deepEqual(plain(upsert.request.models.map(model => model.id)), ['a', 'b'])
  assert.equal(upsert.request.models[0].contextWindow, 128000)
  assert.deepEqual(plain(upsert.request.syncPolicy), { ignoredModels: ['z'] }, 'stored sync exclusions survive the edit')
  assert.equal(client.react.cells[2], null)
  assert.equal(client.react.cells[1].notice, 'list.updated')

  // A changed header block and a typed key are forwarded; an emptied compat
  // grid clears the route level with an explicit null.
  const changed = await openEditPage({
    data: { available: true, providers: [{ ...providerFixture, headers: { 'X-Test': '1' }, compat: { supportsStore: false } }] },
    responses: { upsertProvider: {}, listCustomProviders: { available: true, providers: [] } },
  })
  changed.client.react.cells[2] = changed.client.realmValue({
    ...changed.client.react.cells[2],
    headersText: 'X-Test: 2',
    apiKey: 'sk-new',
    compatDraft: {},
    autoMatch: false,
  })
  buttonByLabel(changed.render(), 'form.saveEdit').props.onClick()
  await settle()
  const changedUpsert = changed.client.remoteCalls.find(call => call.method === 'upsertProvider')
  assert.deepEqual(plain(changedUpsert.request.headers), { 'X-Test': '2' })
  assert.equal(changedUpsert.request.apiKey, 'sk-new')
  assert.equal(changedUpsert.request.compat, null, 'an empty compat grid clears the route level')
  assert.equal(changedUpsert.request.autoEnrich, false)
  changed.client.dispose()

  // Removing a model from the edit page declines it for automatic sync.
  const pruned = await openEditPage({
    data: { available: true, providers: [{ ...providerFixture, syncPolicy: { syncMode: 'add-new', ignoredModels: [] } }] },
    responses: { upsertProvider: {}, listCustomProviders: { available: true, providers: [] } },
  })
  findElements(pruned.tree, node => node.type === 'button' && textOf(node).join('').trim() === 'model.remove')[1].props.onClick()
  buttonByLabel(pruned.render(), 'form.saveEdit').props.onClick()
  await settle()
  const prunedUpsert = pruned.client.remoteCalls.find(call => call.method === 'upsertProvider')
  assert.deepEqual(plain(prunedUpsert.request.models.map(model => model.id)), ['a'])
  assert.deepEqual(plain(prunedUpsert.request.syncPolicy.ignoredModels), ['b'])
  pruned.client.dispose()
})

test('edit fetch reuses the saved provider while forwarding typed keys and headers', async () => {
  const { client, tree } = await openEditPage({
    data: { available: true, providers: [{ ...providerFixture, headers: {} }] },
    responses: {
      discover: { models: [{ id: 'c' }] },
      enrich: { models: [{ id: 'c', profile: { id: 'c', name: 'Gamma', contextWindow: 64000 } }] },
    },
  })
  controlByLabel(tree, 'advanced.headers').props.onChange({ target: { value: 'X-New: 1' } })
  let rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  controlByLabel(rendered, 'form.apiKey').props.onChange({ target: { value: 'sk-edited' } })
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  buttonByLabel(rendered, 'form.fetch').props.onClick()
  await settle()
  const discoverCall = client.remoteCalls.find(call => call.method === 'discover')
  assert(discoverCall)
  assert.equal(discoverCall.request.provider, 'my-relay', 'edit reuses the saved credential through the provider id')
  assert.equal(discoverCall.request.apiKey, 'sk-edited')
  assert.deepEqual(plain(discoverCall.request.headers), { 'X-New': '1' })

  // Single-click add from the panel passes the provider context to enrich.
  rendered = (() => { client.react.begin(); return client.slots.get(SECTION_CELL).component({ t: key => key }) })()
  buttonByLabel(rendered, 'form.discoveryAdd').props.onClick()
  await settle()
  const enrichCall = client.remoteCalls.find(call => call.method === 'enrich')
  assert.equal(enrichCall.request.provider, 'my-relay')
  assert.equal(client.react.cells[2].models.at(-1).id, 'c')
  client.dispose()
})

test('edit exposes per-model default and subagent actions', async () => {
  const { client, tree } = await openEditPage({
    data: { available: true, providers: [{ ...providerFixture, models: [{ id: 'a' }] }] },
  })
  // A single-model provider opens expanded so its actions are reachable directly.
  assert.deepEqual(plain(client.react.cells[2].expandedKeys), ['model-0'])
  buttonByLabel(tree, 'model.setDefault').props.onClick()
  await settle()
  const defaultCall = client.remoteCalls.find(call => call.method === 'setDefaults')
  assert(defaultCall)
  assert.deepEqual(plain(defaultCall.request), { provider: 'my-relay', model: 'a' })
  assert.equal(client.react.cells[1].notice, 'model.defaultSaved')

  buttonByLabel(tree, 'model.allowSubagent').props.onClick()
  await settle()
  const subagentCall = client.remoteCalls.filter(call => call.method === 'setDefaults').at(-1)
  assert.deepEqual(plain(subagentCall.request), { provider: 'my-relay', addToSubagent: ['a'] })
  assert.equal(client.react.cells[1].notice, 'model.subagentSaved')
  client.dispose()

  // Create mode has no per-model selection actions and no readonly provider line.
  const create = await openCreatePage({ draft: createDraftFixture({ models: [modelFixture('x')], expandedKeys: ['model-x'] }) })
  assert.equal(findElements(create.tree, node => node.type === 'button' && textOf(node).join('').trim() === 'model.setDefault').length, 0)
})

/* -------------------------------------------------------------------------- */
/* Accessibility and stale-result safety                                      */
/* -------------------------------------------------------------------------- */

test('both levels label every control, announce notices, and key their loops', async () => {
  const list = await renderSection({
    data: { available: true, providers: [providerFixture] },
    view: { ...settledView(), notice: 'Saved.' },
  })
  const notice = findElements(list.tree, node => node.type === 'p' && node.props.role === 'status')[0]
  assert(notice, 'the notice is a live status region')
  assert.equal(notice.props['aria-live'], 'polite')
  assert.deepEqual(unlabelledControls(list.tree), [], 'no unlabelled control on the list')
  assert.match(source, /'aria-live': 'polite'/u)
  assert.match(source, /role: 'alert'/u)
  list.client.dispose()

  const failing = await renderSection({
    data: { available: true, providers: [] },
    view: { ...settledView(), failure: { code: 'invalid-url', message: 'bad url' } },
  })
  const alert = findElements(failing.tree, node => node.type === 'div' && node.props?.role === 'alert')[0]
  assert(alert, 'a failure is an alert region')
  assert.match(uiText(alert), /error\.title/u)
  assert.match(uiText(alert), /bad url/u)
  failing.client.dispose()

  for (const open of [openCreatePage, openEditPage]) {
    const section = await open()
    const tree = section.tree
    assert.deepEqual(unlabelledControls(tree), [], 'no unlabelled control on the form')
    const modelKeys = findElements(tree, node => node.type === 'li' && typeof node.props?.key === 'string' && node.props.key.startsWith('model-'))
    assert.equal(new Set(modelKeys.map(model => model.props.key)).size, modelKeys.length, 'model cards keep unique keys')
    const compatKeys = findElements(tree, node => typeof node.props?.key === 'string' && node.props.key.startsWith('compat-'))
    assert.equal(new Set(compatKeys.map(field => field.props.key)).size, compatKeys.length, 'compat fields keep unique keys')
    section.client.dispose()
  }
})

test('in-flight candidate results are dropped once the draft identity changes', async () => {
  const section = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay', provider: 'my-relay', providerDirty: true, baseURL: 'https://relay.example/v1',
    }),
    responses: { discover: { models: [{ id: 'a' }] } },
  })
  buttonByLabel(section.tree, 'form.fetch').props.onClick()
  fieldByPlaceholder(section.tree, 'form.baseURLPlaceholder').props.onChange({ target: { value: 'https://other.example/v1' } })
  await settle()
  assert.equal(section.client.react.cells[2].discovery, null, 'a stale discovery result is dropped')
  assert.equal(section.client.react.cells[1].notice, '')
  section.client.dispose()

  const probeSection = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay', provider: 'my-relay', providerDirty: true, baseURL: 'https://relay.example/v1', models: [modelFixture('a')],
    }),
  })
  buttonByLabel(probeSection.tree, 'advanced.probeRun').props.onClick()
  fieldByPlaceholder(probeSection.tree, 'form.baseURLPlaceholder').props.onChange({ target: { value: 'https://other.example/v1' } })
  await settle()
  assert.equal(probeSection.client.react.cells[2].probe, null, 'a stale probe verdict is dropped')
  probeSection.client.dispose()

  const matchSection = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay', provider: 'my-relay', providerDirty: true, models: [modelFixture('m1')], expandedKeys: ['model-m1'],
    }),
    responses: { enrich: { models: [{ id: 'm1', profile: { id: 'm1', contextWindow: 999999 } }] } },
  })
  buttonByLabel(matchSection.tree, 'model.match').props.onClick()
  buttonByLabel(matchSection.tree, 'anthropic-messages').props.onClick()
  await settle()
  assert.equal(matchSection.client.react.cells[2].models[0].contextWindow, '', 'a stale match result is dropped')
  matchSection.client.dispose()
})

test('configured models support multi-select, indeterminate select-all, filtered select, and batch remove', async () => {
  const models = [modelFixture('alpha-1'), modelFixture('alpha-2'), modelFixture('beta-1')]
  const section = await openCreatePage({
    draft: createDraftFixture({
      displayName: 'My relay', provider: 'my-relay', providerDirty: true,
      models,
      expandedKeys: ['model-alpha-1'],
      selectedModelKeys: [],
    }),
  })
  const selectAllBox = tree => findElements(tree, node => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === 'model.selectAll')[0]
  const rowBox = (tree, id) => findElements(tree, node => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === `model.selectOne` && node.props.className === 'xxa-checkbox')
  assert(selectAllBox(section.tree), 'select-all checkbox renders')
  assert.equal(selectAllBox(section.tree).props.checked, false)
  assert.equal(findElements(section.tree, node => typeof node.props?.className === 'string' && node.props.className.includes('xxa-batchBar')).length, 0, 'batch bar stays hidden until at least one model is selected')

  // Selecting one configured model flips select-all into the indeterminate state and reveals the batch bar.
  const boxes = rowBox(section.tree)
  assert.equal(boxes.length, 3)
  boxes[0].props.onChange({ target: { checked: true } })
  let rendered = section.render()
  assert.equal(selectAllBox(rendered).props['data-indeterminate'], 'true', 'partial selection sets indeterminate state')
  assert.equal(selectAllBox(rendered).props.checked, false)
  assert.match(uiText(rendered), /model\.selectedCount/u)

  // Clicking select-all selects every remaining model; clicking it again clears them.
  selectAllBox(rendered).props.onChange({ target: { checked: true } })
  rendered = section.render()
  assert.equal(selectAllBox(rendered).props.checked, true)
  assert.equal(selectAllBox(rendered).props['data-indeterminate'], undefined)
  assert.deepEqual(plain(section.client.react.cells[2].selectedModelKeys), ['model-alpha-1', 'model-alpha-2', 'model-beta-1'])

  buttonByLabel(rendered, 'model.clearSelection').props.onClick()
  rendered = section.render()
  assert.deepEqual(plain(section.client.react.cells[2].selectedModelKeys), [])
  assert.equal(findElements(rendered, node => typeof node.props?.className === 'string' && node.props.className.includes('xxa-batchBar')).length, 0)

  // Select two models and batch remove them: expandedKeys and selection clear cleanly.
  rowBox(rendered)[0].props.onChange({ target: { checked: true } })
  rendered = section.render()
  rowBox(rendered)[2].props.onChange({ target: { checked: true } })
  rendered = section.render()
  buttonByLabel(rendered, 'model.batchRemove').props.onClick()
  rendered = section.render()
  assert.deepEqual(plain(section.client.react.cells[2].models.map(m => m.id)), ['alpha-2'])
  assert.deepEqual(plain(section.client.react.cells[2].expandedKeys), [])
  assert.deepEqual(plain(section.client.react.cells[2].selectedModelKeys), [])
  assert.equal(section.client.react.cells[1].notice, 'model.batchRemoved')
  section.client.dispose()
})

test('configured-model batch match enriches all selected models in one call and edit mode supports batch subagent allow', async () => {
  const section = await openEditPage({
    responses: {
      enrich: {
        models: [
          { id: 'a', profile: { id: 'a', contextWindow: 200000, maxTokens: 16384, input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' } } },
          { id: 'gpt-5-mini', profile: { id: 'gpt-5-mini', contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoningEfforts: false } },
        ],
      },
      setDefaults: { ok: true },
    },
  })
  // Seed a second configured model on the edit draft and select both.
  section.client.react.cells[2] = section.client.realmValue({
    ...section.client.react.cells[2],
    models: [
      ...plain(section.client.react.cells[2].models),
      modelFixture('gpt-5-mini'),
    ],
    selectedModelKeys: ['model-0', 'model-gpt-5-mini'],
  })
  let rendered = section.render()
  buttonByLabel(rendered, 'model.batchMatch').props.onClick()
  await settle()
  const enrichCall = section.client.remoteCalls.find(call => call.method === 'enrich')
  assert(enrichCall, 'batch match issues one enrich call')
  assert.equal(enrichCall.request.provider, 'my-relay')
  assert.deepEqual(plain(enrichCall.request.models.map(m => m.id)), ['a', 'gpt-5-mini'])
  assert.equal(section.client.react.cells[2].models.find(m => m.id === 'a').contextWindow, '200000')
  assert.equal(section.client.react.cells[2].models.find(m => m.id === 'gpt-5-mini').contextWindow, '128000')
  assert.equal(section.client.react.cells[1].notice, 'model.batchMatched')

  // Edit mode also exposes batch allow-subagent for selected models.
  rendered = section.render()
  buttonByLabel(rendered, 'model.batchSubagent').props.onClick()
  await settle()
  const subagentCall = section.client.remoteCalls.find(call => call.method === 'setDefaults')
  assert(subagentCall, 'batch subagent issues one setDefaults call')
  assert.deepEqual(plain(subagentCall.request), { provider: 'my-relay', addToSubagent: ['a', 'gpt-5-mini'] })
  assert.equal(section.client.react.cells[1].notice, 'model.batchSubagentSaved')
  section.client.dispose()
})

/* -------------------------------------------------------------------------- */
/* Source-level contracts                                                     */
/* -------------------------------------------------------------------------- */

test('client source keeps the two-level contracts and preserved invariants', () => {
  // Outer module-loader format, React only.
  assert.match(source, /window\.__ModuleLoader__\.load\(\{\s*\n\s*id: '@xiaoxing\/api-provider-manager',\s*\n\s*factory\(require\) \{/u)
  // Two surfaces plus the card extension each carry their stylesheet.
  assert.equal((source.match(/h\('style', null, STYLES\)/gu) ?? []).length, 3)
  assert.equal(source.includes('dangerouslySetInnerHTML'), false)
  // The first level has no quick card, sync control, registry control, tabs, or wizard.
  for (const gone of [/summaryStrip/u, /quick\./u, /drawer\./u, /tabs\./u, /wizard/iu, /step1/u, /xxa-statTile/u, /status\.reservedHint/u]) {
    assert.equal(gone.test(source), false, `${gone} is gone from the client`)
  }
  assert.equal(/call\('syncAllCustomProviders'/u.test(source), false, 'the page never triggers a sync')
  assert.equal(/call\('syncProviderModels'/u.test(source), false)
  // Level-one advanced settings lazily reads the catalog and saves upstream bindings on demand.
  assert.match(source, /call\('getRegistryStatus', \{ includeCatalog: true, query, limit: 30 \}\)/u)
  assert.match(source, /call\('saveOverride', \{ provider, modelId, override: \{ upstreamModel: target \} \}\)/u)
  // `refresh()` keeps a failure that the action reported before the re-read.
  assert.match(source, /const refresh = React\.useCallback\(async \(options = \{\}\) => \{/u)
  assert.match(source, /const preserveFailure = options\?\.preserveFailure === true/u)
  assert.match(source, /failure: problem !== null \? problem : preserveFailure \? current\.failure : null/u)
  assert.match(source, /await refresh\(\{ preserveFailure: true \}\)/u)
  // A monotonic draft ref drops results that no longer describe the draft.
  assert.match(source, /const beginDraftOp = \(\) => \{ opRef\.current \+= 1; return opRef\.current \}/u)
  assert.match(source, /const isStaleDraftOp = token => opRef\.current !== token/u)
  assert.match(source, /const token = beginDraftOp\(\)/u)
  // Secrets stay write-only; headers stay untouched unless edited.
  assert.match(source, /apiKey: ''/u)
  assert.equal(/apiKey:\s*provider\./u.test(source), false)
  assert.match(source, /current\.headersText !== current\.initialHeadersText/u)
  assert.match(source, /initialHeadersText: headersText/u)
  // The discovery marker is stripped exactly once, on save.
  assert.equal((source.match(/trimTrailingHash\(current\.baseURL\)/gu) ?? []).length, 1)
  // Identity derivation always yields a saveable provider id.
  assert.match(source, /const PROVIDER_ID_FALLBACK = 'custom-api'/u)
  assert.match(source, /deriveProviderIdFromDraft\(current\.displayName, baseURL, data\.providers\.map\(provider => String\(provider\.provider\)\)\)/u)
  assert.match(source, /data\.providers\.some\(provider => String\(provider\.provider\) === providerId\)/u)
  assert.match(source, /t\('id\.exists'\)/u)
  // Auto-match is forwarded explicitly and failed enrichment never fabricates values.
  assert.match(source, /autoEnrich: current\.autoMatch === true/u)
  assert.match(source, /if \(efforts === false\) entry\.reasoningEfforts = false/u)
  // Reasoning keeps off: null; the editor clears route compat with an explicit null.
  assert.match(source, /efforts\[level\] = level === 'off' \? null : level/u)
  assert.match(source, /const raw = model\.efforts\.off/u)
  assert.match(source, /efforts\.off = typeof raw === 'string' && raw\.trim\(\) !== '' \? raw\.trim\(\) : null/u)
  assert.match(source, /payload\.compat = null/u)
  assert.match(source, /else if \(isEdit\) payload\.compat = null/u)
  // Enter submits the manual batch input, and both levels share one form.
  assert.match(source, /if \(event\.key === 'Enter'\) \{ event\.preventDefault\(\); options\.onEnter\(\) \}/u)
  assert.match(source, /onEnter: \(\) => \{ void addManualModels\(\) \}/u)
  assert.match(source, /mode: 'create'/u)
  assert.match(source, /mode: 'edit'/u)
  assert.match(source, /draft === null \? renderList\(\) : renderForm\(draft\)/u)
  // Loop-rendered rows carry stable keys.
  assert.match(source, /key: `provider-\$\{providerId\}`/u)
  assert.match(source, /key: `candidate-\$\{model\.id\}`/u)
  assert.match(source, /key: `effort-\$\{level\}-\$\{model\.key\}`/u)
  assert.match(source, /`compat-\$\{name\}`/u)
  // The mono typography wraps long ids instead of overflowing the row.
  assert.match(source, /\.xxa-mono \{[^}]*overflow-wrap: anywhere/u)
  // The provider-card seat still guards on `declared === true`.
  assert.match(source, /provider\.declared !== true/u)
})
