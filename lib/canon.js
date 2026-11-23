/**
 * Model id canonicalization for catalog lookup and family matching.
 *
 * Providers spell the same model differently: a vendor prefix, a snapshot date,
 * a routing suffix, or a dot where another feed writes a hyphen. Canonicalizing
 * first lets one metadata rule or catalog entry serve every spelling without
 * touching the parts that identify the model — parameter sizes and tier words.
 * @module @xiaoxing/api-provider-manager/canon
 */

/**
 * Vendor, channel, and region prefixes stripped before canonical comparison.
 * Each entry ends with its separator so a prefix never matches half a segment.
 */
const VENDOR_PREFIXES = Object.freeze([
  'deepseek-ai/', 'deepseek/', 'anthropic/', 'openai/', 'google/', 'z-ai/', 'zai-org/', 'zhipuai/',
  'qwen/', 'moonshotai/', 'moonshot/', 'minimax/', 'minimaxai/', 'mistralai/', 'mistral/', 'meta-llama/',
  'meta/', 'x-ai/', 'xai/', 'spacexai/', 'alibaba/', 'nvidia/', 'thinkingmachines/', 'cohere/', 'amazon/',
  'microsoft/', 'bytedance/', 'bytedance-seed/', 'tencent/', 'baidu/', 'inclusionai/', 'stepfun/',
  'stepfun-ai/', 'arcee-ai/', 'sakana/', 'liquid/', 'upstage/', 'inception/', 'ai21/', 'ibm/', 'ibm-granite/',
  'nousresearch/', 'openrouter/', 'vercel/', 'groq/', 'cerebras/', 'fireworks/', 'togetherai/', 'deepinfra/',
  'sambanova/', 'perplexity/', 'huggingface/', 'ollama/', 'lmstudio/', 'xiaomi/', 'xiaomimimo/', 'meituan/',
  'quiverai/', 'stealth/', 'poolside/', 'aion-labs/', 'dots-studio/', 'nex-agi/', 'perceptron/', 'prism-ml/',
  'rekaai/', 'relace/', 'unbiased/', 'callstack/', 'interfaze/', 'mixedbread/', 'typesafe/',
  'vertex/', 'google-vertex/', 'bedrock/', 'amazon-bedrock/', 'azure/',
  'Pro/', 'free/',
  'us.', 'eu.', 'global.',
])

/** OpenRouter's leading marker on a vendor's "latest" alias route. */
const ALIAS_PREFIX_PATTERN = /^~/u

/** Fireworks-style account path in front of a routed model id. */
const ACCOUNTS_PREFIX_PATTERN = /^accounts\/[^/]+\/(?:models|routers)\//iu

/** Trailing routing suffixes stripped after the vendor prefix. */
const ROUTING_SUFFIXES = Object.freeze([
  ':free', ':batch', ':thinking', ':exacto', ':extended', ':nitro', ':floor',
])

/**
 * Trailing snapshot stamps. The four-digit form is only a date when it reads as
 * a valid `MMDD`, so a size or tier that happens to be four digits survives.
 */
const DATE_SUFFIX_PATTERNS = Object.freeze([
  /@\d{8}$/u,
  /-\d{4}-\d{2}-\d{2}$/u,
  /-\d{8}$/u,
  /-(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/u,
])

/** Non-chat model markers, most specific category first. */
const NON_CHAT_MARKERS = Object.freeze([
  ['embedding', 'embedding'],
  ['rerank', 'rerank'],
  ['whisper', 'speech'],
  ['tts', 'speech'],
  ['speech', 'speech'],
  ['transcribe', 'speech'],
  ['dall-e', 'image'],
  ['dalle', 'image'],
  ['flux', 'image'],
  ['imagen', 'image'],
  ['image', 'image'],
  ['seedream', 'image'],
  ['sora', 'video'],
  ['moderation', 'moderation'],
  ['veo', 'video'],
  ['wanx', 'video'],
  ['seedance', 'video'],
])

/** Vendor classification patterns, in match order. */
const VENDOR_GROUP_PATTERNS = Object.freeze([
  ['DeepSeek', /deepseek/u],
  ['Anthropic', /claude|anthropic/u],
  ['OpenAI', /gpt|openai|chatgpt|codex|^o[1-9](?:-|$)/u],
  ['Google', /gemini|google|gemma|palm/u],
  ['Zhipu GLM', /glm|zhipu|chatglm/u],
  ['Qwen', /qwen|qwq/u],
  ['Moonshot', /kimi|moonshot/u],
  ['MiniMax', /minimax|abab/u],
  ['Mistral', /mistral|mixtral|codestral|pixtral|magistral|devstral/u],
  ['Meta Llama', /llama|meta-llama/u],
  ['xAI', /grok|x-ai|xai/u],
])

/**
 * Strip every leading vendor, channel, or region prefix.
 * @param {string} id - model id to strip.
 * @returns {string} the id without its leading namespace segments.
 */
function stripVendorPrefixes(id) {
  let stripped = id.replace(ALIAS_PREFIX_PATTERN, '').replace(ACCOUNTS_PREFIX_PATTERN, '')
  for (;;) {
    const lower = stripped.toLowerCase()
    const prefix = VENDOR_PREFIXES.find(candidate => lower.startsWith(candidate.toLowerCase()) && stripped.length > candidate.length)
    if (prefix === undefined) return stripped
    stripped = stripped.slice(prefix.length)
  }
}

/**
 * Strip every trailing routing suffix.
 * @param {string} id - model id to strip.
 * @returns {string} the id without its trailing routing suffix.
 */
function stripRoutingSuffixes(id) {
  let stripped = id
  for (;;) {
    const lower = stripped.toLowerCase()
    const suffix = ROUTING_SUFFIXES.find(candidate => lower.endsWith(candidate) && stripped.length > candidate.length)
    if (suffix === undefined) return stripped
    stripped = stripped.slice(0, -suffix.length)
  }
}

/**
 * Strip every trailing snapshot stamp.
 * @param {string} id - model id to strip.
 * @returns {string} the id without its trailing snapshot stamp.
 */
function stripDateStamps(id) {
  let stripped = id
  for (;;) {
    const pattern = DATE_SUFFIX_PATTERNS.find(candidate => candidate.test(stripped))
    if (pattern === undefined) return stripped
    stripped = stripped.replace(pattern, '')
  }
}

/**
 * Normalize one id for comparison: lowercase, hyphen separators, no noise.
 * Dots and underscores stay because they carry version and name information,
 * and a `p` between digits becomes the dot it encodes (`4p1` is `4.1`).
 * @param {string} id - model id to normalize.
 * @returns {string} the normalized id.
 */
function normalizeId(id) {
  return id
    .trim()
    .toLowerCase()
    .replace(/(\d)p(?=\d)/gu, '$1.')
    .replace(/\s+/gu, '-')
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/\.{2,}/gu, '.')
    .replace(/-{2,}/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
}

/**
 * Rewrite numeric dots as hyphens, the spelling feeds use for version parts.
 * @param {string} id - normalized id.
 * @returns {string} the same id with dots between digits replaced by hyphens.
 */
function dotToHyphen(id) {
  return id.replaceAll('.', '-').replace(/-{2,}/gu, '-')
}

/**
 * Rewrite a hyphen between two short digit groups as a dot, the other spelling
 * feeds use for version parts. A trailing size suffix (`-8b`, `-235b`) and a
 * snapshot stamp keep their hyphen.
 * @param {string} id - normalized id.
 * @returns {string} the same id with version hyphens replaced by dots.
 */
function hyphenToDot(id) {
  return id.replace(/(\d{1,2})-(\d{1,2})(?![0-9bmk])/gu, '$1.$2')
}

/**
 * Canonicalize one model id into the forms lookup and matching need.
 * @param {unknown} rawId - model id as a provider or feed spells it.
 * @returns {{ raw: string, strippedVendor: string, withoutDate: string, normalized: string,
 *   dotHyphenNormalized: string }} the canonical views, each a subset of the previous one.
 */
export function canonModelId(rawId) {
  const raw = typeof rawId === 'string' ? rawId.trim() : String(rawId ?? '').trim()
  const strippedVendor = stripVendorPrefixes(raw)
  const withoutDate = stripDateStamps(stripRoutingSuffixes(strippedVendor))
  const normalized = normalizeId(withoutDate)
  return { raw, strippedVendor, withoutDate, normalized, dotHyphenNormalized: dotToHyphen(normalized) }
}

/**
 * Build the lookup keys to try for one model id, most exact first.
 *
 * The list starts with the id as written and ends with the canonical
 * normalized spelling, including both the dot and the hyphen form of every
 * numeric version separator so either feed spelling resolves.
 * @param {unknown} rawId - model id to build keys for.
 * @returns {string[]} deduplicated lookup keys, most exact first.
 */
export function candidateLookupKeys(rawId) {
  const canon = canonModelId(rawId)
  const keys = []
  const seen = new Set()
  const push = key => {
    if (typeof key !== 'string' || key.length === 0 || seen.has(key)) return
    seen.add(key)
    keys.push(key)
  }
  const addStage = (stage, versionDot = false) => {
    if (stage.length === 0) return
    push(stage)
    const lower = stage.toLowerCase()
    push(lower)
    push(dotToHyphen(lower))
    if (versionDot) push(hyphenToDot(lower))
  }
  addStage(canon.raw)
  addStage(canon.strippedVendor)
  addStage(canon.withoutDate)
  addStage(canon.normalized, true)
  addStage(canon.dotHyphenNormalized, true)
  // A variant suffix outside the routing list (a quantization or context tag)
  // still names the same model for lookup purposes.
  addStage(canon.withoutDate.replace(/:[^:]*.*$/u, ''), true)
  return keys
}

/**
 * Detect a model id that is not a chat model.
 * @param {unknown} id - model id to inspect.
 * @returns {{ nonChat: boolean, category: string | null }} whether it is a non-chat model and, when it is,
 *   one of `embedding`, `rerank`, `speech`, `image`, `video`, or `moderation`.
 */
export function isLikelyNonChatModel(id) {
  const normalized = typeof id === 'string' ? id.toLowerCase() : ''
  for (const [marker, category] of NON_CHAT_MARKERS) {
    if (normalized.includes(marker)) return { nonChat: true, category }
  }
  return { nonChat: false, category: null }
}

/**
 * Classify one model id into its vendor group.
 * @param {unknown} id - model id to classify.
 * @returns {'DeepSeek' | 'Anthropic' | 'OpenAI' | 'Google' | 'Zhipu GLM' | 'Qwen' | 'Moonshot' | 'MiniMax' |
 *   'Mistral' | 'Meta Llama' | 'xAI' | 'Other'} the vendor group.
 */
export function deriveVendorGroup(id) {
  const normalized = canonModelId(id).normalized
  if (normalized.length === 0) return 'Other'
  for (const [group, pattern] of VENDOR_GROUP_PATTERNS) {
    if (pattern.test(normalized)) return group
  }
  return 'Other'
}
