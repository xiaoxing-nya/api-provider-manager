#!/usr/bin/env node
/**
 * Build the bundled offline model catalog for `@xiaoxing/api-provider-manager`.
 *
 * The script fetches (or reads from disk) the two live registry feeds:
 *   - https://models.dev/api.json
 *   - https://openrouter.ai/api/v1/models
 * normalizes them with the exact same parser/merger used at runtime by
 * `lib/registry-cache.js`, then compacts the result into `data/model-catalog.json`:
 *
 *   {
 *     "schemaVersion": 1,
 *     "generatedAt": "2026-11-23T00:00:00.000Z",
 *     "sourceCounts": { "modelsDev": 3067, "openRouter": 362, "merged": 3072, "catalog": 169, "aliases": 234 },
 *     "models": { "<canonical id>": { ...normalized model entry... } },
 *     "aliases": { "<alternate id>": "<canonical id>" }
 *   }
 *
 * Only curated mainstream chat-capable models from major model families are
 * kept in the bundled offline catalog, dated snapshots collapse onto their
 * base model as aliases, and the output is deterministic: keys are sorted and
 * `generatedAt` can be pinned with `--now` / `SOURCE_DATE_EPOCH` for
 * reproducible offline builds. Full model coverage is fetched dynamically at
 * runtime by `lib/registry-cache.js`.
 *
 * Usage:
 *   node scripts/build-catalog.mjs
 *   node scripts/build-catalog.mjs --models-dev ./fixtures/models-dev.json --openrouter ./fixtures/openrouter.json
 *   node scripts/build-catalog.mjs --out ./data/model-catalog.json --now 2026-11-16T00:00:00.000Z
 *
 * Options:
 *   --models-dev <file|url>   models.dev payload source (default: live URL)
 *   --openrouter <file|url>   OpenRouter payload source (default: live URL)
 *   --out <file>              output path (default: <plugin>/data/model-catalog.json)
 *   --now <iso>               pin `generatedAt` (default: SOURCE_DATE_EPOCH or now)
 *   --timeout <ms>            network timeout per feed (default: 30000)
 *   --help                    show this help
 *
 * Pure Node >= 22 ESM. No external dependencies.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectIdVariants,
  mergeRegistrySnapshots,
  modelMatchKey,
  parseModelsDevPayload,
  parseOpenRouterPayload,
  stripSnapshotSuffix,
} from '../lib/registry-cache.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(SCRIPT_DIR, '..')
const DEFAULT_OUT = resolve(PLUGIN_ROOT, 'data', 'model-catalog.json')
const DEFAULT_MODELS_DEV_URL = 'https://models.dev/api.json'
const DEFAULT_OPEN_ROUTER_URL = 'https://openrouter.ai/api/v1/models'
const DEFAULT_TIMEOUT_MS = 30_000
const CATALOG_SCHEMA_VERSION = 1
const USER_AGENT = '@xiaoxing/api-provider-manager build-catalog'

/**
 * Hand-curated mainstream models shipped in the bundled offline fallback
 * catalog (`data/model-catalog.json`).
 *
 * The offline catalog is intentionally small and easy to maintain: it covers
 * only mainstream base models across major families for out-of-box offline
 * enrichment, while runtime enrichment prioritizes the live online registry
 * cache (`models.dev` + `OpenRouter`). Every id below is verified against the
 * upstream feeds at build time; effort-qualified ids such as
 * `gemini-4-argon-high` map onto their real base model as aliases.
 */
const MAINSTREAM_MODEL_IDS = Object.freeze([
  // DeepSeek
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-flash',
  'deepseek-v3.2',
  'deepseek-v3.2-thinking',
  'deepseek-v3.1-terminus',
  'deepseek-v3',
  'deepseek-r1',
  'deepseek-chat',
  'deepseek-reasoner',
  // Anthropic Claude
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-haiku-5-5',
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4.1',
  'claude-opus-4',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-haiku-4-5',
  'claude-3.7-sonnet',
  'claude-3.5-sonnet',
  'claude-3.5-haiku',
  // OpenAI GPT & o-series
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.4-pro',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex',
  'gpt-5.2',
  'gpt-5.2-pro',
  'gpt-5.2-codex',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5',
  'gpt-5-pro',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5-codex',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-mini',
  'o4-mini',
  'o3',
  'o3-pro',
  'o3-mini',
  'o1',
  'o1-pro',
  // Google Gemini
  'gemini-4-argon',
  'gemini-4-argon-high',
  'gemini-4-hydrogen',
  'gemini-4-hydrogen-xhigh',
  'gemini-4-carbon',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-pro',
  'gemini-3.1-flash-lite',
  'gemini-3-pro',
  'gemini-3-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  // Zhipu GLM
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'glm-5.1',
  'glm-5',
  'glm-4.7',
  'glm-4.7-flash',
  'glm-4.6',
  'glm-4.6v',
  'glm-4.5',
  'glm-4.5-air',
  'glm-4.5-flash',
  'glm-4.5v',
  // Alibaba Qwen / QwQ
  'qwen4-max',
  'qwen3.8-max',
  'qwen3.8-flash',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.7-flash',
  'qwen3.6-plus',
  'qwen3.6-flash',
  'qwen3.5-plus',
  'qwen3.5-flash',
  'qwen3-max',
  'qwen3-coder-plus',
  'qwen3-coder-next',
  'qwen3-coder',
  'qwen3-235b-a22b',
  'qwen3-32b',
  'qwen3-vl-plus',
  'qwen-max',
  'qwen-plus',
  'qwen-turbo',
  'qwq-plus',
  'qwq-32b',
  // Moonshot Kimi
  'kimi-k3.1-pro',
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'kimi-k2.5',
  'kimi-k2',
  'kimi-k2-thinking',
  'kimi-for-coding',
  // MiniMax
  'minimax-m3.1-flash',
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'minimax-m2.1',
  'minimax-m2',
  'minimax-m1',
  'minimax-01',
  // xAI Grok
  'grok-4.7',
  'grok-4.6',
  'grok-4.5',
  'grok-4.3',
  'grok-4.20',
  'grok-4.1',
  'grok-4.1-fast',
  'grok-4',
  'grok-4-fast',
  'grok-3',
  'grok-3-mini',
  'grok-code-fast-1',
  // Mistral / Codestral / Devstral
  'mistral-large-4-0',
  'mistral-large-4',
  'mistral-large-latest',
  'mistral-medium-3.5-128b',
  'mistral-medium-latest',
  'mistral-small-4',
  'mistral-small-latest',
  'codestral-latest',
  'devstral-latest',
  // Meta Llama
  'llama-4-maverick',
  'llama-4-scout',
  'llama-3.3-70b-instruct',
  'llama-3.1-70b-instruct',
  // ByteDance Doubao / Seed & Xiaomi MiMo
  'doubao-seed-2.1-pro',
  'doubao-seed-2.1-turbo',
  'doubao-seed-2.0-code',
  'doubao-seed-1.8',
  'doubao-seed-1.6',
  'seed-2.1-turbo',
  'seed-2.0-pro',
  'mimo-v2.6-pro',
  'mimo-v2.6-flash',
  'mimo-v2.5-pro',
])

/* ------------------------------------------------------------------------- */
/* CLI                                                                       */
/* ------------------------------------------------------------------------- */

function parseArgs(argv) {
  const options = {
    modelsDev: DEFAULT_MODELS_DEV_URL,
    openRouter: DEFAULT_OPEN_ROUTER_URL,
    out: DEFAULT_OUT,
    now: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  }
  const valueOf = (index, flag) => {
    const value = argv[index]
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}`)
    }
    return value
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--models-dev') {
      options.modelsDev = valueOf((index += 1), arg)
    } else if (arg === '--openrouter') {
      options.openRouter = valueOf((index += 1), arg)
    } else if (arg === '--out') {
      options.out = valueOf((index += 1), arg)
    } else if (arg === '--now') {
      options.now = valueOf((index += 1), arg)
    } else if (arg === '--timeout') {
      const raw = valueOf((index += 1), arg)
      const timeoutMs = Number(raw)
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid --timeout value: ${raw}`)
      options.timeoutMs = timeoutMs
    } else if (arg.startsWith('--models-dev=')) {
      options.modelsDev = arg.slice('--models-dev='.length)
    } else if (arg.startsWith('--openrouter=')) {
      options.openRouter = arg.slice('--openrouter='.length)
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length)
    } else if (arg.startsWith('--now=')) {
      options.now = arg.slice('--now='.length)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function usage() {
  return [
    'Build the bundled offline model catalog for @xiaoxing/api-provider-manager.',
    '',
    'Usage: node scripts/build-catalog.mjs [options]',
    '',
    'Options:',
    '  --models-dev <file|url>   models.dev payload source (default: live URL)',
    '  --openrouter <file|url>   OpenRouter payload source (default: live URL)',
    '  --out <file>              output path (default: data/model-catalog.json)',
    '  --now <iso>               pin generatedAt (default: SOURCE_DATE_EPOCH or now)',
    '  --timeout <ms>            network timeout per feed (default: 30000)',
    '  --help                    show this help',
  ].join('\n')
}

/* ------------------------------------------------------------------------- */
/* Input loading                                                             */
/* ------------------------------------------------------------------------- */

async function loadPayload(source, label, timeoutMs) {
  if (/^https?:\/\//i.test(source)) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    try {
      const response = await fetch(source, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`${label}: HTTP ${response.status} from ${source}`)
      return await response.text()
    } finally {
      clearTimeout(timer)
    }
  }
  const filePath = isAbsolute(source) ? source : resolve(process.cwd(), source)
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    throw new Error(`${label}: could not read ${filePath} (${error.message})`)
  }
}

function resolveGeneratedAt(raw) {
  if (raw) {
    const parsed = new Date(raw)
    if (Number.isNaN(parsed.getTime())) throw new Error(`invalid --now value: ${raw}`)
    return parsed.toISOString()
  }
  const epoch = process.env.SOURCE_DATE_EPOCH
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString()
  return new Date().toISOString()
}

/* ------------------------------------------------------------------------- */
/* Catalog selection                                                         */
/* ------------------------------------------------------------------------- */

function compare(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function sortObject(object) {
  const sorted = {}
  for (const key of Object.keys(object).sort(compare)) sorted[key] = object[key]
  return sorted
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

/**
 * Collect the match keys of models that are usable through a chat-completions
 * API: text output only (no image/audio/video generation) and text input.
 */
function collectChatMatchKeys(modelsDevPayload, openRouterPayload) {
  const keys = new Set()

  for (const provider of Object.values(modelsDevPayload)) {
    const models = provider?.models
    if (!models || typeof models !== 'object') continue
    for (const model of Object.values(models)) {
      if (!model || typeof model !== 'object') continue
      const outputs = model.modalities?.output
      const inputs = model.modalities?.input
      if (!Array.isArray(outputs) || outputs.length === 0) continue
      if (!outputs.every((modality) => modality === 'text')) continue
      if (Array.isArray(inputs) && inputs.length > 0 && !inputs.includes('text')) continue
      keys.add(modelMatchKey(model.id))
      if (typeof model.canonical_model_id === 'string') keys.add(modelMatchKey(model.canonical_model_id))
    }
  }

  for (const model of openRouterPayload.data ?? []) {
    if (!model || typeof model !== 'object') continue
    const outputs = model.architecture?.output_modalities
    const inputs = model.architecture?.input_modalities
    if (!Array.isArray(outputs) || outputs.length === 0) continue
    if (!outputs.every((modality) => modality === 'text')) continue
    if (Array.isArray(inputs) && inputs.length > 0 && !inputs.includes('text')) continue
    keys.add(modelMatchKey(model.id))
    if (typeof model.canonical_slug === 'string') keys.add(modelMatchKey(model.canonical_slug))
  }

  return keys
}

/**
 * Select the curated mainstream subset from the merged registry:
 *   - chat-capable models from `MAINSTREAM_MODEL_IDS`,
 *   - effort-qualified ids (`gemini-4-argon-high`) map onto their base model as
 *     aliases instead of fabricating metadata,
 *   - dated snapshots in the upstream feeds that strip down to a selected
 *     mainstream base model are recorded as aliases.
 *
 * @returns {{
 *   selected: Record<string, object>,
 *   droppedDated: Map<string, string>,
 *   included: string[],
 *   mappedAliases: Array<{ seed: string, target: string }>,
 *   unresolved: string[],
 * }}
 */
function selectCatalogModels(merged, chatMatchKeys) {
  const index = new Map()
  for (const key of Object.keys(merged.models).sort(compare)) {
    if (key.includes('/') || key.includes('~') || key.includes(':')) continue
    if (!chatMatchKeys.has(modelMatchKey(key))) continue
    const matchKey = modelMatchKey(key)
    if (matchKey && !index.has(matchKey)) index.set(matchKey, key)
  }

  const lookup = (candidate) => {
    if (
      hasOwn(merged.models, candidate) &&
      !candidate.includes('/') &&
      !candidate.includes('~') &&
      !candidate.includes(':') &&
      chatMatchKeys.has(modelMatchKey(candidate))
    ) {
      return candidate
    }
    if (hasOwn(merged.aliases, candidate)) {
      const target = merged.aliases[candidate]
      if (hasOwn(merged.models, target) && chatMatchKeys.has(modelMatchKey(target))) {
        return target
      }
    }
    return index.get(modelMatchKey(candidate)) ?? null
  }

  const selectedKeys = new Set()
  const included = []
  const mappedAliases = []
  const unresolved = []

  for (const seed of MAINSTREAM_MODEL_IDS) {
    const direct = lookup(seed)
    if (direct) {
      selectedKeys.add(direct)
      included.push(seed)
      continue
    }
    const baseSeed = seed.replace(/-(?:xhigh|high|medium|low|max|minimal)$/, '')
    const base = baseSeed !== seed ? lookup(baseSeed) : null
    if (base) {
      selectedKeys.add(base)
      mappedAliases.push({ seed, target: base })
      continue
    }
    unresolved.push(seed)
  }

  const droppedDated = new Map()
  for (const key of Object.keys(merged.models).sort(compare)) {
    if (selectedKeys.has(key)) continue
    if (key.includes('/') || key.includes('~') || key.includes(':')) continue
    const base = stripSnapshotSuffix(key)
    if (base !== key && selectedKeys.has(base)) {
      droppedDated.set(key, base)
    }
  }

  const selected = {}
  for (const key of [...selectedKeys].sort(compare)) selected[key] = merged.models[key]
  return { selected, droppedDated, included, mappedAliases, unresolved }
}

/**
 * Build the alias map for the catalog: alternate spellings from both upstreams,
 * dot/hyphen variants, dated snapshots of selected models, and seed aliases.
 */
function buildCatalogAliases(merged, selected, droppedDated, seedAliases) {
  const aliases = {}
  const add = (form, target) => {
    if (!form || !target || form === target) return
    if (hasOwn(selected, form)) return
    if (!hasOwn(selected, target)) return
    if (hasOwn(aliases, form)) return
    aliases[form] = target
  }

  for (const [form, target] of Object.entries(merged.aliases)) add(form, target)
  for (const key of Object.keys(selected).sort(compare)) {
    for (const variant of collectIdVariants(key)) add(variant, key)
  }
  for (const [dated, base] of droppedDated) add(dated, base)
  for (const [form, target] of Object.entries(seedAliases)) add(form, target)

  return sortObject(aliases)
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                */
/* ------------------------------------------------------------------------- */

function validateCatalog(catalog) {
  const problems = []
  if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) problems.push('unexpected schemaVersion')
  if (typeof catalog.generatedAt !== 'string' || Number.isNaN(Date.parse(catalog.generatedAt))) {
    problems.push('invalid generatedAt')
  }
  const modelKeys = Object.keys(catalog.models)
  if (modelKeys.length === 0) problems.push('catalog has no models')
  for (const key of modelKeys) {
    const entry = catalog.models[key]
    if (!entry || typeof entry !== 'object') {
      problems.push(`${key}: entry is not an object`)
      continue
    }
    if (entry.id !== key) problems.push(`${key}: id mismatch (${entry.id})`)
    if (typeof entry.name !== 'string' || entry.name === '') problems.push(`${key}: missing name`)
    if (entry.contextWindow !== null && !(Number.isFinite(entry.contextWindow) && entry.contextWindow > 0)) {
      problems.push(`${key}: invalid contextWindow`)
    }
    if (entry.maxTokens !== null && !(Number.isFinite(entry.maxTokens) && entry.maxTokens > 0)) {
      problems.push(`${key}: invalid maxTokens`)
    }
    if (!Array.isArray(entry.input)) problems.push(`${key}: invalid input`)
    if (typeof entry.reasoning !== 'boolean') problems.push(`${key}: invalid reasoning`)
    if (typeof entry.allowOff !== 'boolean') problems.push(`${key}: invalid allowOff`)
    if (!Array.isArray(entry.efforts)) problems.push(`${key}: invalid efforts`)
    if (entry.reasoning && entry.allowOff && !entry.efforts.includes('off')) {
      problems.push(`${key}: allowOff is true but efforts lacks off`)
    }
    if (entry.reasoning && !entry.allowOff && entry.efforts.includes('off')) {
      problems.push(`${key}: allowOff is false but efforts includes off`)
    }
    if (!entry.reasoning && entry.efforts.length > 0) problems.push(`${key}: non-reasoning model has efforts`)
    if (entry.interleavedField !== null && typeof entry.interleavedField !== 'string') {
      problems.push(`${key}: invalid interleavedField`)
    }
    if (!Array.isArray(entry.endpoints)) problems.push(`${key}: invalid endpoints`)
    if (typeof entry.source !== 'string' || entry.source === '') problems.push(`${key}: missing source`)
  }
  for (const [alias, target] of Object.entries(catalog.aliases)) {
    if (!hasOwn(catalog.models, target)) problems.push(`alias ${alias}: unknown target ${target}`)
    if (hasOwn(catalog.models, alias)) problems.push(`alias ${alias}: shadows a catalog model`)
  }
  return problems
}

/* ------------------------------------------------------------------------- */
/* Main                                                                      */
/* ------------------------------------------------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }

  const generatedAt = resolveGeneratedAt(options.now)
  const warnings = []

  const loadOne = async (source, label) => {
    try {
      return await loadPayload(source, label, options.timeoutMs)
    } catch (error) {
      warnings.push(error.message)
      return null
    }
  }

  const [modelsDevText, openRouterText] = await Promise.all([
    loadOne(options.modelsDev, 'models.dev'),
    loadOne(options.openRouter, 'OpenRouter'),
  ])
  if (!modelsDevText && !openRouterText) {
    throw new Error(`both registry feeds failed:\n  - ${warnings.join('\n  - ')}`)
  }

  const modelsDevPayload = modelsDevText ? JSON.parse(modelsDevText) : {}
  const openRouterPayload = openRouterText ? JSON.parse(openRouterText) : { data: [] }

  const modelsDevSnapshot = parseModelsDevPayload(modelsDevPayload)
  const openRouterSnapshot = parseOpenRouterPayload(openRouterPayload)
  const merged = mergeRegistrySnapshots(modelsDevSnapshot, openRouterSnapshot)

  const chatMatchKeys = collectChatMatchKeys(modelsDevPayload, openRouterPayload)
  const { selected, droppedDated, included, mappedAliases, unresolved } = selectCatalogModels(merged, chatMatchKeys)

  const seedAliases = {}
  for (const { seed, target } of mappedAliases) seedAliases[seed] = target
  const aliases = buildCatalogAliases(merged, selected, droppedDated, seedAliases)

  const catalog = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt,
    sourceCounts: {
      modelsDev: Object.keys(modelsDevSnapshot.models).length,
      openRouter: Object.keys(openRouterSnapshot.models).length,
      merged: Object.keys(merged.models).length,
      catalog: Object.keys(selected).length,
      aliases: Object.keys(aliases).length,
    },
    models: sortObject(selected),
    aliases,
  }

  const problems = validateCatalog(catalog)
  if (problems.length > 0) {
    throw new Error(`generated catalog is invalid:\n  - ${problems.slice(0, 20).join('\n  - ')}`)
  }

  const outPath = isAbsolute(options.out) ? options.out : resolve(process.cwd(), options.out)
  // Compact JSON keeps the bundled catalog inside its size budget; keys are
  // already sorted by `sortObject`, so the output is deterministic.
  const payload = `${JSON.stringify(catalog)}\n`
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, payload, 'utf8')

  const counts = catalog.sourceCounts
  process.stdout.write(
    `build-catalog: models.dev=${counts.modelsDev} openrouter=${counts.openRouter} merged=${counts.merged}\n`,
  )
  process.stdout.write(
    `build-catalog: catalog=${counts.catalog} aliases=${counts.aliases} bytes=${Buffer.byteLength(payload)}\n`,
  )
  process.stdout.write(
    `build-catalog: mainstream included=${included.length}/${MAINSTREAM_MODEL_IDS.length}` +
      ` mapped-as-alias=${mappedAliases.length}` +
      ` unresolved=${unresolved.length}\n`,
  )
  for (const { seed, target } of mappedAliases) {
    process.stdout.write(`build-catalog: mainstream ${seed} -> alias of ${target}\n`)
  }
  for (const seed of unresolved.slice(0, 5)) {
    process.stdout.write(`build-catalog: WARNING mainstream ${seed} not found upstream (not fabricated)\n`)
  }
  if (unresolved.length > 5) {
    process.stdout.write(`build-catalog: WARNING ...and ${unresolved.length - 5} more mainstream ids absent from fixture\n`)
  }
  for (const warning of warnings) process.stdout.write(`build-catalog: WARNING ${warning}\n`)
  process.stdout.write(`build-catalog: wrote ${outPath}\n`)
}

main().catch((error) => {
  process.stderr.write(`build-catalog: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
