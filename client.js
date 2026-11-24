/**
 * Client half of the Xiaoxing API provider manager bundle.
 *
 * Two levels, one job each. The first level is a quiet list of connected API
 * providers: a title bar holding "connect" and "refresh", a list that only
 * speaks up when a key is missing, an inline delete confirmation, and one
 * collapsed fold for upstream model binding, the model knowledge base, and
 * config import/export that reads nothing until it is opened. The second level is
 * a shared create/edit form: connection details plus one auto-match switch,
 * then model management (manual batch input, fetching the API model list with
 * single-click or batch add, and per-model fine-grained capability settings),
 * and finally a collapsed advanced fold for the provider id, credential
 * reference, headers, compat switches, and a connectivity probe.
 *
 * Every write still goes through the same Host Remote methods; secrets stay
 * write-only and are never pre-filled. New routes derive a valid, non-reserved
 * provider id from the typed name or URL, so a user who never opens the
 * advanced fold can still save successfully.
 */

window.__ModuleLoader__.load({
  id: '@xiaoxing/api-provider-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Package name owning the Host service and the Remote descriptors. */
    const PACKAGE = '@xiaoxing/api-provider-manager'
    /** Locale namespace owned by this plugin. */
    const NS = 'xiaoxing-api-manager'
    /** Wire namespace of the mounted Remote service. */
    const REMOTE_NAMESPACE = 'xiaoxingApiManager'
    /** Settings section id shared by the section and its icon. */
    const SLOT_ID = 'xiaoxing-api-manager'
    /** Keyed adapter area inside one provider card of the `llm-pi-ai` family. */
    const PROVIDER_CARD_SLOT = 'settings.models.provider-card'
    /** Settings namespace the provider-card seat dispatches (`entryKey = settingsNs`). */
    const PROVIDER_CARD_KEY = 'llm-pi-ai'
    /** Remote methods in declaration order; mirrors `index.js` `REMOTE_METHODS`. */
    const REMOTE_METHODS = [
      'status', 'presets', 'listCustomProviders', 'discover', 'enrich', 'audit', 'probe',
      'upsertProvider', 'removeProvider', 'syncProviderModels', 'syncAllCustomProviders',
      'setSyncPolicy', 'setDefaults', 'saveOverride', 'resetOverride', 'getRegistryStatus',
      'refreshRegistry', 'importConfig', 'exportConfig',
    ]
    /** Wire protocols a custom provider may speak. */
    const SUPPORTED_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']
    /** Gateway preset enrichment defaults for each protocol. */
    const PRESET_ID_BY_API = {
      'openai-completions': 'custom-relay-openai',
      'openai-responses': 'custom-openai-responses',
      'anthropic-messages': 'custom-anthropic',
      'google-generative-ai': 'custom-gemini',
    }
    /** Selectable reasoning levels, in pi-ai escalation order. */
    const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    /** Reasoning levels the Gemini API accepts. */
    const GEMINI_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high']
    /** Output-cap field spellings pi-ai accepts. */
    const MAX_TOKENS_FIELDS = ['max_completion_tokens', 'max_tokens']
    /** Reasoning-budget field spellings pi-ai accepts. */
    const THINKING_TOKEN_BUDGET_FIELDS = ['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens']
    /** Prompt-cache marker conventions pi-ai accepts. */
    const CACHE_CONTROL_FORMATS = ['anthropic']
    /** Reasoning-dispatch wire formats a profile may name. */
    const SUPPORTED_THINKING_FORMATS = [
      'openai', 'deepseek', 'openrouter', 'together', 'baseten', 'zai', 'qwen',
      'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling',
    ]
    /** The pi-ai compat fields each supported protocol offers, in schema order. */
    const COMPAT_FIELDS_BY_API = {
      'openai-completions': [
        'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming',
        'supportsFinishReason', 'maxTokensField', 'requiresToolResultName', 'requiresAssistantAfterToolResult',
        'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages', 'thinkingFormat',
        'chatTemplateKwargs', 'chatTemplateArgs', 'supportsThinkingTokenBudget', 'thinkingTokenBudgetField',
        'vllmPriority', 'supportsStrictMode', 'cacheControlFormat', 'supportsLongCacheRetention',
      ],
      'openai-responses': ['supportsDeveloperRole', 'supportsMaxOutputTokens', 'supportsStrictMode', 'supportsLongCacheRetention'],
      'anthropic-messages': [
        'supportsEagerToolInputStreaming', 'supportsLongCacheRetention', 'supportsCacheControlOnTools',
        'supportsTemperature', 'forceAdaptiveThinking', 'allowEmptySignature', 'supportsStrictTools',
      ],
      'google-generative-ai': [],
    }
    /** Compat fields carrying a boolean switch. */
    const BOOLEAN_COMPAT_FIELDS = new Set([
      'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming',
      'supportsFinishReason', 'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText',
      'requiresReasoningContentOnAssistantMessages', 'supportsThinkingTokenBudget', 'supportsStrictMode',
      'supportsLongCacheRetention', 'supportsMaxOutputTokens', 'supportsEagerToolInputStreaming',
      'supportsCacheControlOnTools', 'supportsTemperature', 'forceAdaptiveThinking', 'allowEmptySignature',
      'supportsStrictTools',
    ])
    /** Compat fields carrying one value from a closed set. */
    const ENUM_COMPAT_VALUES = {
      maxTokensField: MAX_TOKENS_FIELDS,
      thinkingFormat: SUPPORTED_THINKING_FORMATS,
      thinkingTokenBudgetField: THINKING_TOKEN_BUDGET_FIELDS,
      cacheControlFormat: CACHE_CONTROL_FORMATS,
    }
    /** Compat fields carrying a request template dictionary. */
    const OBJECT_COMPAT_FIELDS = new Set(['chatTemplateKwargs', 'chatTemplateArgs'])
    /** Request modalities a model may declare. */
    const MODALITIES = ['text', 'image']
    /** Config document formats `importConfig` understands. */
    const IMPORT_FORMATS = ['auto', 'xiaoxing-json', 'omp-yaml', 'cherry-json', 'dsh-cordis-yaml']
    /** Discovery fields a fetched model entry may carry into enrichment. */
    const DISCOVERY_FIELDS = [
      'name', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'reasoningDeclared',
      'allowOff', 'efforts', 'supportedEndpointTypes', 'nonChat',
    ]
    /** Context-window shortcuts offered next to the model editor. */
    const CONTEXT_WINDOW_PRESETS = [
      { value: 32768, label: '32K' },
      { value: 131072, label: '128K' },
      { value: 200000, label: '200K' },
      { value: 1048576, label: '1M' },
    ]
    /** Max-output shortcuts offered next to the model editor. */
    const MAX_TOKENS_PRESETS = [
      { value: 4096, label: '4K' },
      { value: 8192, label: '8K' },
      { value: 16384, label: '16K' },
      { value: 32768, label: '32K' },
      { value: 65536, label: '64K' },
    ]
    /** Header names whose values are credentials and must never be pre-filled. */
    const SENSITIVE_HEADER_NAMES = ['authorization', 'x-api-key', 'x-goog-api-key', 'proxy-authorization', 'cookie']
    /** Provider ids owned by DSH itself; reserved so derivation warns early. */
    const NATIVE_DSH_PROVIDERS = ['deepseek-official', 'deepseek-account', 'llm-deepseek', 'llm-deepseek-account', 'typesafe']
    /** Provider ids the installed pi-ai catalog ships as built-in chat providers. */
    const BUILTIN_PI_AI_PROVIDERS = [
      'amazon-bedrock', 'ant-ling', 'anthropic', 'azure', 'baseten', 'cerebras', 'cloudflare-ai-gateway',
      'cloudflare-workers-ai', 'deepseek', 'fireworks', 'github-copilot', 'google', 'google-vertex', 'groq',
      'huggingface', 'kimi-coding', 'meta', 'minimax', 'minimax-cn', 'mistral', 'moonshotai', 'moonshotai-cn',
      'nvidia', 'openai', 'openai-codex', 'opencode', 'opencode-go', 'openrouter', 'qwen-token-plan',
      'qwen-token-plan-cn', 'qwen-token-plan-individual', 'radius', 'together', 'vercel-ai-gateway', 'xai',
      'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'zai', 'zai-coding-cn',
    ]
    /** Provider count from which the list offers a search box. */
    const SEARCH_MIN_PROVIDERS = 6
    /** Model count from which each model list offers a search box. */
    const SEARCH_MIN_MODELS = 6
    /** Quiet period before a typed upstream-model query reads the catalog. */
    const CATALOG_SEARCH_DEBOUNCE_MS = 250
    /** A custom provider id: lowercase, starts with a letter, up to 64 characters. */
    const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u
    /** A printable HTTP header name. */
    const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u
    /** An environment variable name usable as a credential reference. */
    const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
    /** Suffix appended when a derived id collides with a reserved route. */
    const PROVIDER_ID_SUFFIX = '-custom'
    /** Last-resort provider id stem when nothing can be derived from the typed name or URL. */
    const PROVIDER_ID_FALLBACK = 'custom-api'

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
    /** Read one error message without depending on the error class realm. */
    function messageOfError(error) {
      return error instanceof Error ? error.message : String(error)
    }
    /** Unwrap the outer Remote envelope and the inner Host business envelope. */
    function unwrapRemoteResult(result) {
      if (!isPlainObject(result)) return { ok: false, code: 'internal', message: '' }
      if (result.ok !== true) {
        const error = isPlainObject(result.error) ? result.error : null
        return {
          ok: false,
          code: error !== null && typeof error.code === 'string' ? error.code : 'internal',
          message: error !== null && typeof error.message === 'string' ? error.message : '',
          ...(error !== null && isPlainObject(error.details) ? { details: error.details } : {}),
        }
      }
      const value = result.value
      if (isPlainObject(value) && value.ok === false) {
        return {
          ok: false,
          code: typeof value.code === 'string' ? value.code : 'internal',
          message: typeof value.message === 'string' ? value.message : '',
          ...(isPlainObject(value.details) ? { details: value.details } : {}),
        }
      }
      return { ok: true, value: isPlainObject(value) ? value : {} }
    }
    /** Format a token count compactly (`1048576` becomes `1M`). */
    function formatTokenCount(count) {
      const value = typeof count === 'number' ? count : Number.NaN
      if (!Number.isFinite(value) || value < 0) return ''
      if (value >= 1000000) return `${trimFraction(value / 1000000)}M`
      if (value >= 1000) return `${trimFraction(value / 1000)}K`
      return String(Math.trunc(value))
    }
    /** Render one decimal to at most one fractional digit without a trailing zero. */
    function trimFraction(value) {
      return String(Number(value.toFixed(1)))
    }
    /**
     * Split a user-typed model id block into unique ids.
     *
     * English and Chinese commas, semicolons, and new lines all separate ids;
     * surrounding whitespace is dropped and duplicates keep their first spot.
     * @param {unknown} text - typed model id block.
     * @returns {string[]} the unique model ids.
     */
    function splitModelIds(text) {
      if (typeof text !== 'string' || text.trim() === '') return []
      const ids = []
      const seen = new Set()
      for (const raw of text.split(/[\n,，;；]+/u)) {
        const id = raw.trim()
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        ids.push(id)
      }
      return ids
    }
    /** Parse a `Name: value` header block typed by the user. */
    function parseHeadersLines(text) {
      const headers = {}
      const source = typeof text === 'string' ? text : ''
      for (const rawLine of source.split(/\r?\n/u)) {
        const line = rawLine.trim()
        if (line === '') continue
        const separator = line.indexOf(':')
        if (separator <= 0) throw new Error(`header line ${JSON.stringify(line)} needs "Name: value"`)
        const name = line.slice(0, separator).trim()
        const value = line.slice(separator + 1).trim()
        if (!HEADER_NAME_PATTERN.test(name)) throw new Error(`header name ${JSON.stringify(name)} is not a valid HTTP header name`)
        if (value === '') throw new Error(`header ${JSON.stringify(name)} needs a value`)
        headers[name] = value
      }
      return headers
    }
    /** Render a header map as editable lines, never pre-filling a credential header. */
    function formatHeadersLines(headers) {
      if (!isPlainObject(headers)) return ''
      const lines = []
      for (const [name, value] of Object.entries(headers)) {
        if (SENSITIVE_HEADER_NAMES.includes(String(name).toLowerCase())) continue
        if (typeof value !== 'string' || value === '') continue
        lines.push(`${name}: ${value}`)
      }
      return lines.join('\n')
    }
    /** Strip a trailing discovery marker `#` from a base URL before persisting it. */
    function trimTrailingHash(rawUrl) {
      const text = typeof rawUrl === 'string' ? rawUrl.trim() : ''
      return text.replace(/#+$/u, '').trim()
    }
    /** Whether a value looks like an absolute http(s) URL (Host validation goes deeper). */
    function isHttpURL(value) {
      const text = typeof value === 'string' ? value.trim() : ''
      return /^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/iu.test(text)
    }
    /** Convert a compat value map into editable draft strings. */
    function compatToDraft(compat, api) {
      const draft = {}
      const offered = COMPAT_FIELDS_BY_API[api]
      if (!Array.isArray(offered) || !isPlainObject(compat)) return draft
      for (const field of offered) {
        const value = compat[field]
        if (value === undefined || value === null) continue
        draft[field] = typeof value === 'object' ? JSON.stringify(value) : String(value)
      }
      return draft
    }
    /** Build the compat payload one protocol accepts from its draft strings. */
    function buildCompatPayload(draftCompat, api) {
      const compat = {}
      const invalid = []
      const offered = COMPAT_FIELDS_BY_API[api]
      if (!Array.isArray(offered) || !isPlainObject(draftCompat)) return { compat, invalid }
      for (const field of offered) {
        if (!Object.hasOwn(draftCompat, field)) continue
        const raw = draftCompat[field]
        if (raw === undefined || raw === null) continue
        const text = typeof raw === 'string' ? raw.trim() : raw
        if (text === '') continue
        if (BOOLEAN_COMPAT_FIELDS.has(field)) {
          if (text === true || text === 'true') compat[field] = true
          else if (text === false || text === 'false') compat[field] = false
          else invalid.push(field)
          continue
        }
        if (Object.hasOwn(ENUM_COMPAT_VALUES, field)) {
          if (typeof text === 'string' && ENUM_COMPAT_VALUES[field].includes(text)) compat[field] = text
          else invalid.push(field)
          continue
        }
        if (OBJECT_COMPAT_FIELDS.has(field)) {
          if (isPlainObject(text)) {
            compat[field] = text
            continue
          }
          try {
            const parsed = JSON.parse(String(text))
            if (isPlainObject(parsed)) compat[field] = parsed
            else invalid.push(field)
          } catch {
            invalid.push(field)
          }
          continue
        }
        if (field === 'vllmPriority') {
          const numeric = typeof text === 'number' ? text : Number(text)
          if (Number.isFinite(numeric)) compat[field] = numeric
          else invalid.push(field)
          continue
        }
        compat[field] = text
      }
      return { compat, invalid }
    }
    /** Count non-empty compat overrides currently entered in a draft. */
    function countCompatOverrides(compatDraft) {
      if (!isPlainObject(compatDraft)) return 0
      return Object.values(compatDraft).filter(value => typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null).length
    }
    /** Render a compat map as one compact recommendation line. */
    function formatCompatFields(compat) {
      if (!isPlainObject(compat)) return ''
      return Object.entries(compat)
        .map(([name, value]) => `${name}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
        .join(', ')
    }
    /** Derive the default credential reference of a provider id (`my-relay` becomes `MY_RELAY_API_KEY`). */
    function deriveCredentialRef(providerId) {
      const text = typeof providerId === 'string' ? providerId.trim() : ''
      if (text === '') return ''
      return `${text.replace(/-/gu, '_').toUpperCase()}_API_KEY`
    }
    /** Validate a provider id typed into the form before any Host call. */
    function checkProviderIdDraft(id) {
      const text = typeof id === 'string' ? id.trim() : ''
      if (text === '' || !PROVIDER_ID_PATTERN.test(text)) return { ok: false, key: 'id.invalid' }
      if (NATIVE_DSH_PROVIDERS.includes(text)) return { ok: false, key: 'id.reservedNative' }
      if (BUILTIN_PI_AI_PROVIDERS.includes(text)) return { ok: false, key: 'id.reservedBuiltin' }
      return { ok: true, key: 'id.available' }
    }
    /** Parse the lowercase hostname of a base URL typed with or without a scheme. */
    function hostOfUrl(rawUrl) {
      const text = typeof rawUrl === 'string' ? rawUrl.trim() : ''
      if (text === '') return ''
      const withoutScheme = text.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '')
      const hostPart = withoutScheme.split(/[/?#]/u)[0] ?? ''
      const authority = hostPart.includes('@') ? hostPart.slice(hostPart.lastIndexOf('@') + 1) : hostPart
      const host = authority.replace(/:\d+$/u, '').toLowerCase()
      if (host === '' || !/^[a-z0-9.-]+$/u.test(host)) return ''
      return host
    }
    /** Short host portion of a URL so list rows read cleanly without path noise. */
    function endpointHost(rawUrl) {
      const host = hostOfUrl(rawUrl)
      if (host !== '') return host
      return typeof rawUrl === 'string' ? rawUrl.trim() : ''
    }
    /** Derive a readable display name from a base URL hostname. */
    function deriveDisplayNameFromUrl(rawUrl) {
      const host = hostOfUrl(rawUrl)
      return host === '' ? '' : host.replace(/^www\./u, '')
    }
    /**
     * Turn a readable name into a printable provider-id stem.
     * @param {unknown} name - typed display name.
     * @returns {string} a lowercase stem, or an empty string when the name has no ASCII slug.
     */
    function slugifyProviderName(name) {
      const text = typeof name === 'string' ? name.trim().toLowerCase() : ''
      if (text === '') return ''
      const slug = text
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/-{2,}/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 56)
      if (slug === '') return ''
      if (!/^[a-z]/u.test(slug)) return `p-${slug}`.slice(0, 56)
      return slug
    }
    /**
     * Make one provider-id stem usable: avoid reserved routes and taken ids.
     * @param {string} base - derived stem.
     * @param {string[]} [existingIds] - provider ids already configured.
     * @returns {string} a usable id, or an empty string when nothing usable remains.
     */
    function resolveUsableProviderId(base, existingIds = []) {
      const text = typeof base === 'string' ? base : ''
      if (text === '') return ''
      const verdict = checkProviderIdDraft(text)
      let candidate = text
      if (verdict.ok !== true) {
        if (verdict.key === 'id.invalid') return ''
        candidate = `${text.slice(0, 56)}${PROVIDER_ID_SUFFIX}`
      }
      const taken = new Set((Array.isArray(existingIds) ? existingIds : []).map(id => String(id)))
      if (!taken.has(candidate)) return candidate
      for (let suffix = 2; suffix <= 9999; suffix += 1) {
        const next = `${candidate.slice(0, 56)}-${suffix}`
        if (!taken.has(next)) return next
      }
      return ''
    }
    /**
     * Derive a provider id from a readable name.
     * @param {unknown} name - typed display name.
     * @param {string[]} [existingIds] - provider ids already configured.
     * @returns {string} a usable provider id, or an empty string.
     */
    function deriveProviderIdFromName(name, existingIds = []) {
      const slug = slugifyProviderName(name)
      return slug === '' ? '' : resolveUsableProviderId(slug, existingIds)
    }
    /**
     * Derive a provider id from a base URL, avoiding DSH reserved routes.
     *
     * Loopback and bare-IP endpoints collapse to one readable stem and keep a
     * non-standard port so two local relays stay distinguishable; the result is
     * then de-duplicated against the ids the page already lists.
     * @param {string} rawUrl - typed base URL.
     * @param {string[]} [existingIds] - provider ids already configured.
     * @returns {string} a usable provider id, or an empty string.
     */
    function deriveProviderSlugFromUrl(rawUrl, existingIds = []) {
      const text = typeof rawUrl === 'string' ? rawUrl.trim() : ''
      if (text === '') return ''
      const withoutScheme = text.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '')
      const hostPart = withoutScheme.split(/[/?#]/u)[0] ?? ''
      const authority = hostPart.includes('@') ? hostPart.slice(hostPart.lastIndexOf('@') + 1) : hostPart
      const portMatch = /:(\d+)$/u.exec(authority)
      const port = portMatch === null ? '' : portMatch[1]
      const host = authority.replace(/:\d+$/u, '').toLowerCase()
      if (host === '' || !/^[a-z0-9.-]+$/u.test(host)) return ''
      let stem
      if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.localhost')) stem = 'local'
      else if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) stem = `p-${host.replace(/\./gu, '-')}`
      else {
        const labels = host.split('.').filter(label => label !== '')
        const generic = ['www', 'api', 'chat', 'llm', 'v1']
        let index = 0
        while (index < labels.length - 1 && generic.includes(labels[index])) index += 1
        stem = String(labels[index] ?? labels[0] ?? '')
          .replace(/[^a-z0-9-]+/gu, '-')
          .replace(/-{2,}/gu, '-')
          .replace(/^-+|-+$/gu, '')
          .slice(0, 56)
        if (stem === '') return ''
        if (!/^[a-z]/u.test(stem)) stem = `p-${stem}`
      }
      const standardPort = port === '' || port === '80' || port === '443'
      const base = standardPort ? stem : `${stem.slice(0, 56)}-${port}`
      return resolveUsableProviderId(base, existingIds)
    }
    /**
     * Build a numeric fallback provider id such as `custom-api` or `custom-api-2`.
     * @param {string[]} [existingIds] - provider ids already configured.
     * @returns {string} the first free fallback id.
     */
    function fallbackProviderId(existingIds = []) {
      const taken = new Set((Array.isArray(existingIds) ? existingIds : []).map(id => String(id)))
      if (!taken.has(PROVIDER_ID_FALLBACK)) return PROVIDER_ID_FALLBACK
      for (let suffix = 2; suffix <= 999; suffix += 1) {
        const candidate = `${PROVIDER_ID_FALLBACK}-${suffix}`
        if (!taken.has(candidate)) return candidate
      }
      return ''
    }
    /**
     * Derive the provider id a create form should carry.
     *
     * The typed name wins, the URL hostname is the fallback for names without an
     * ASCII slug, and a numbered `custom-api` id is the last resort so the save
     * path never fails on a missing provider id.
     * @param {unknown} displayName - typed display name.
     * @param {unknown} baseURL - typed base URL.
     * @param {string[]} [existingIds] - provider ids already configured.
     * @returns {string} a usable provider id.
     */
    function deriveProviderIdFromDraft(displayName, baseURL, existingIds = []) {
      return deriveProviderIdFromName(displayName, existingIds)
        || deriveProviderSlugFromUrl(baseURL, existingIds)
        || fallbackProviderId(existingIds)
    }
    /** Parse an optional positive integer editor field. */
    function parseOptionalPositiveInteger(text) {
      if (typeof text === 'number') return Number.isSafeInteger(text) && text > 0 ? text : null
      const trimmed = typeof text === 'string' ? text.trim() : ''
      if (trimmed === '') return undefined
      const value = Number(trimmed)
      return Number.isSafeInteger(value) && value > 0 ? value : null
    }
    /**
     * Localized text for one failure code, falling back to the Host message.
     *
     * A local validation failure (`local: true`) already carries a localized
     * hint, which is shown on its own instead of behind the generic code text.
     */
    function failureText(t, failure) {
      const code = typeof failure?.code === 'string' && failure.code !== '' ? failure.code : 'internal'
      const key = code.startsWith('gateway/') ? 'error.service-unavailable' : `error.${code}`
      const detail = typeof failure?.message === 'string' ? failure.message : ''
      if (failure?.local === true && detail !== '') return detail
      const localized = t(key)
      if (localized !== key) return detail === '' ? localized : `${localized} (${detail})`
      return detail === '' ? t('error.internal') : detail
    }
    /** Localized label of one vocabulary id, falling back to the raw id. */
    function vocabularyText(t, prefix, id) {
      const key = `${prefix}.${String(id)}`
      const label = t(key)
      return label === key ? String(id) : label
    }
    /** Reduce one probe check report to a verdict id the dictionaries localize. */
    function describeProbeCheck(result) {
      if (!isPlainObject(result)) return 'inconclusive'
      if (result.skipped === true) return 'skipped'
      const verdict = typeof result.supported === 'boolean'
        ? result.supported
        : typeof result.accepted === 'boolean'
          ? result.accepted
          : typeof result.ok === 'boolean'
            ? result.ok
            : null
      if (verdict === true) return 'supported'
      if (verdict === false) {
        // A transport-level failure has no HTTP status; report it as an error, not a "no".
        if (result.status === null && typeof result.error === 'string' && result.error !== '') return 'error'
        return 'unsupported'
      }
      return 'inconclusive'
    }
    /** CSS tone class of one probe check verdict. */
    function probeCheckClass(verdict) {
      if (verdict === 'supported') return 'xxa-checkItem xxa-checkSuccess'
      if (verdict === 'unsupported') return 'xxa-checkItem xxa-checkWarn'
      if (verdict === 'error') return 'xxa-checkItem xxa-checkError'
      return 'xxa-checkItem xxa-checkMuted'
    }
    /** Structured capability tags for one model profile (`['1M', 'vision', 'reasoning']`). */
    function modelCapabilities(t, profile) {
      if (!isPlainObject(profile)) return []
      const chips = []
      const window = formatTokenCount(profile.contextWindow)
      if (window !== '') chips.push({ text: window, tone: 'neutral' })
      const output = formatTokenCount(profile.maxTokens)
      if (output !== '') chips.push({ text: t('model.meta.output', { count: output }), tone: 'neutral' })
      if (Array.isArray(profile.input) && profile.input.includes('image')) chips.push({ text: t('model.meta.image'), tone: 'neutral' })
      const efforts = profile.reasoningEfforts
      if (isPlainObject(efforts)) {
        const tiers = Object.keys(efforts).filter(level => typeof level === 'string' && level !== '').length
        if (tiers > 0) chips.push({ text: t('model.meta.reasoningTiers', { count: tiers }), tone: 'accent' })
      } else if (efforts === true) {
        chips.push({ text: t('model.meta.reasoningTiers', { count: 0 }), tone: 'accent' })
      }
      return chips
    }
    /** Default reasoning efforts of one protocol when reasoning is switched on. */
    function defaultReasoningEfforts(api) {
      return api === 'google-generative-ai'
        ? { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' }
        : { off: null, low: 'low', medium: 'medium', high: 'high' }
    }
    /**
     * Build one model reasoning-effort payload from the editor draft.
     *
     * `off` keeps pi-ai's explicit `null` value (off means "no reasoning
     * budget", not "unspecified"); every other checked level falls back to its
     * own name when the draft value is blank.
     * @param {object} model - editor model row.
     * @param {string} api - wire protocol.
     * @returns {object | false | undefined} the effort map, or a switch state.
     */
    function buildReasoningEfforts(model, api) {
      if (model.reasoning !== true) return false
      const levels = api === 'google-generative-ai' ? GEMINI_THINKING_LEVELS : THINKING_LEVELS
      const efforts = {}
      let hasLevel = false
      for (const level of levels) {
        if (!Object.hasOwn(model.efforts, level)) continue
        if (level === 'off') {
          const raw = model.efforts.off
          efforts.off = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
          continue
        }
        const raw = typeof model.efforts[level] === 'string' ? model.efforts[level].trim() : ''
        efforts[level] = raw === '' ? level : raw
        hasLevel = true
      }
      return hasLevel ? efforts : undefined
    }
    /** Map a stored reasoningEfforts object into editable draft values. */
    function effortMapToDraft(reasoningEfforts) {
      if (!isPlainObject(reasoningEfforts)) return {}
      const draft = {}
      for (const [level, value] of Object.entries(reasoningEfforts)) {
        if (level === 'off') {
          draft.off = typeof value === 'string' ? value : null
          continue
        }
        if (typeof value === 'string') draft[level] = value
      }
      return draft
    }
    /** Whether a channel has no usable key: the one state that stops it from working. */
    function providerKeyMissing(provider) {
      const credential = isPlainObject(provider?.credential) ? provider.credential : null
      return credential === null || credential.configured !== true
    }

    /** English dictionary (sentence case, direct active copy). */
    const EN = {
      'title': 'Xiaoxing API access',
      'subtitle': 'Connect third-party API providers; model capabilities and metadata are matched automatically.',
      'loading': 'Loading…',
      'common.back': '← Back',
      'common.cancel': 'Cancel',
      'common.working': 'Working…',
      'header.refresh': 'Refresh',
      'list.connect': '+ Connect API',
      'list.search': 'Search name, id, or endpoint',
      'list.clear': 'Clear',
      'list.filterEmpty': 'No provider matches the search.',
      'list.emptyTitle': 'No API provider yet',
      'list.emptyHint': 'Connect a third-party API to add its models to DSH.',
      'list.unavailable': 'The llm-pi-ai configuration is unavailable in this profile.',
      'list.models': '{count} models',
      'list.missingKey': 'key missing',
      'list.edit': 'Edit',
      'list.delete': 'Delete',
      'list.deleteTitle': 'Delete "{name}"?',
      'list.deleteHint': 'Removes the provider and its models from llm-pi-ai.',
      'list.deleteCredential': 'Also delete the saved key',
      'list.deleteConfirm': 'Delete',
      'list.deleted': 'Deleted "{name}".',
      'list.created': 'Connected "{name}" with {count} model(s).',
      'list.updated': 'Saved "{name}".',
      'listAdvanced.title': 'Model matching & import/export',
      'listAdvanced.unmatchedBadge': '{count} unmatched',
      'listAdvanced.boundBadge': '{count} bound',
      'listAdvanced.bindingsTitle': 'Manual upstream model binding',
      'listAdvanced.bindingsHint': 'Bind unmatched configured models to a known upstream model so they inherit context window, output limit, vision, reasoning tiers, and compat switches.',
      'listAdvanced.bindingsEmpty': 'All configured models have a catalog match.',
      'listAdvanced.unmatched': 'Unmatched',
      'listAdvanced.boundTo': 'Bound → {target}',
      'listAdvanced.boundUnmatched': 'Bound → {target} (unmatched)',
      'listAdvanced.bind': 'Bind upstream',
      'listAdvanced.rebind': 'Change',
      'listAdvanced.unbind': 'Unbind',
      'listAdvanced.targetPlaceholder': 'Search or enter upstream model id (e.g. claude-sonnet-4-5, gpt-5)',
      'listAdvanced.bindConfirm': 'Confirm bind',
      'listAdvanced.bindPick': 'Bind',
      'listAdvanced.bindNeedTarget': 'Enter or pick an upstream model id first.',
      'listAdvanced.bindSaved': 'Bound "{model}" to "{target}" and applied capabilities live.',
      'listAdvanced.bindSavedUnmatched': 'Bound "{model}" to "{target}", but no catalog entry matched that id.',
      'listAdvanced.unbindSaved': 'Removed upstream binding for "{model}".',
      'listAdvanced.catalogLoading': 'Loading upstream model catalog…',
      'listAdvanced.catalogEmpty': 'No matching catalog model; you can still type any upstream id above and bind directly.',
      'listAdvanced.catalogCount': 'Showing {shown} of {total} catalog models',
      'listAdvanced.catalogFailed': 'Could not read the model catalog: {reason}',
      'listAdvanced.catalogRetry': 'Retry',
      'listAdvanced.registryTitle': 'Model knowledge base',
      'listAdvanced.registrySummary': 'Online cache: {count} models · {state}',
      'listAdvanced.registryStateFresh': 'up to date',
      'listAdvanced.registryStateStale': 'update available',
      'listAdvanced.registryStateNever': 'not synced yet',
      'listAdvanced.registryRefresh': 'Update online catalog',
      'listAdvanced.registryRefreshed': 'Online catalog updated ({count} models).',
      'listAdvanced.registryOffline': 'Offline only (skip network catalog updates)',
      'listAdvanced.registryOfflineOn': 'Offline only is on; online catalog updates are skipped.',
      'listAdvanced.registryOfflineOff': 'Offline only is off; the online catalog can update again.',
      'listAdvanced.ioTitle': 'Config import / export',
      'listAdvanced.importHint': 'Paste JSON, OMP YAML, Cherry JSON, or DSH cordis YAML. Keys are moved into the credential store.',
      'listAdvanced.importFormat': 'Format',
      'listAdvanced.importPlaceholder': 'Paste provider configuration here…',
      'listAdvanced.importButton': 'Import config',
      'listAdvanced.importEmpty': 'Paste configuration text before importing.',
      'listAdvanced.importDone': 'Imported {count} provider(s).',
      'listAdvanced.exportButton': 'Export sanitized config',
      'listAdvanced.exportClear': 'Clear',
      'listAdvanced.exportDone': 'Exported {count} provider(s) with credentials removed.',
      'importFormat.auto': 'Auto detect',
      'importFormat.xiaoxing-json': 'Xiaoxing JSON',
      'importFormat.omp-yaml': 'OMP YAML',
      'importFormat.cherry-json': 'Cherry JSON',
      'importFormat.dsh-cordis-yaml': 'DSH cordis YAML',
      'form.createTitle': 'Connect API',
      'form.editTitle': 'Edit · {name}',
      'form.saveCreate': 'Save and connect',
      'form.saveEdit': 'Save changes',
      'form.connection': 'Connection',
      'form.name': 'Name',
      'form.namePlaceholder': 'e.g. OpenRouter or My relay',
      'form.api': 'Protocol',
      'form.baseURL': 'API base URL',
      'form.baseURLPlaceholder': 'https://relay.example.com/v1',
      'form.baseURLHint': 'Append # to keep the endpoint path verbatim.',
      'form.apiKey': 'API key',
      'form.apiKeyHintEdit': 'Leave empty to keep the saved key unchanged.',
      'form.autoMatch': 'Model info auto-match',
      'form.autoMatchHint': 'While on, adding a model fills in context window, output limit, modalities, and reasoning tiers automatically.',
      'form.models': 'Models',
      'form.manualPlaceholder': 'Model id (commas, semicolons, or new lines separate several)',
      'form.manualAdd': 'Add',
      'form.manualEmpty': 'Enter at least one model id.',
      'form.duplicateSkipped': '{count} model(s) were already listed and skipped.',
      'form.fetch': 'Fetch models from API',
      'form.fetchNeedURL': 'Enter the API base URL first.',
      'form.fetched': 'Fetched {count} models.',
      'form.fetchEmpty': 'The endpoint returned no usable models.',
      'form.needSelection': 'Select at least one model.',
      'form.modelsAdded': 'Added {count} model(s).',
      'form.enrichPartial': 'Added {count} model(s); {failed} kept their id without matched info.',
      'form.needURL': 'Enter a valid http(s) API base URL.',
      'form.needModels': 'Add at least one model before saving.',
      'form.invalidModelId': 'Model ids cannot be empty.',
      'form.duplicateModelId': 'Duplicate model id: {id}',
      'form.invalidNumber': '{field} must be a positive integer.',
      'form.discoveryTitle': 'API models',
      'form.discoveryCount': '{total} fetched · {added} added',
      'form.discoverySearch': 'Filter fetched models',
      'form.discoverySelectAll': 'Select all',
      'form.discoveryClear': 'Clear selection',
      'form.discoveryAddSelected': 'Add selected ({count})',
      'form.discoveryAdd': '+ Add',
      'form.discoveryAdded': 'Added',
      'form.discoveryCollapse': 'Collapse',
      'form.discoveryExpand': 'Expand',
      'form.discoveryClose': 'Close',
      'form.discoveryEmpty': 'No fetched model matches the filter.',
      'model.title': 'Configured models ({count})',
      'model.search': 'Filter configured models',
      'model.selectAll': 'Select all configured models',
      'model.selectedCount': '{count} selected',
      'model.clearSelection': 'Clear',
      'model.batchMatch': 'Match info ({count})',
      'model.batchSubagent': 'Allow subagent ({count})',
      'model.batchRemove': 'Remove ({count})',
      'model.batchRemoved': 'Removed {count} model(s).',
      'model.batchMatched': 'Updated parameters for {count} model(s).',
      'model.batchMatchPartial': 'Updated parameters for {count} model(s). {failed} kept existing values.',
      'model.batchSubagentSaved': 'Allowed {count} model(s) for subagents.',
      'model.selectOne': 'Select {id}',
      'model.emptyTitle': 'No model configured yet',
      'model.emptyHint': 'Add a model id above, or fetch the API list and add models from it.',
      'model.settings': 'Settings',
      'model.collapse': 'Collapse',
      'model.remove': 'Remove',
      'model.id': 'Model id',
      'model.name': 'Display name',
      'model.namePlaceholder': 'Same as the model id',
      'model.contextWindow': 'Context window',
      'model.maxTokens': 'Max output tokens',
      'model.input': 'Input modalities',
      'model.text': 'Text',
      'model.image': 'Vision',
      'model.reasoning': 'Reasoning',
      'model.reasoningHint': 'Pick the tiers this model accepts. A blank mapping falls back to the tier name, and "off" maps to null.',
      'model.effortMapping': 'Mapping',
      'model.match': 'Match model info',
      'model.matched': 'Offline catalog match · {id}',
      'model.registryMatch': 'Online registry match · {id}',
      'model.ruleMatch': 'Estimated from family rule · {id}',
      'model.ambiguousMatch': '{count} reference models match. Choose an upstream model.',
      'model.ambiguousDraftMatch': '{count} reference models match. After saving, choose one under Model matching & import/export.',
      'model.noMatch': 'No catalog match. Using available parameters.',
      'model.setDefault': 'Set as default',
      'model.defaultSaved': 'Default model set to "{model}".',
      'model.allowSubagent': 'Allow subagent',
      'model.subagentSaved': '"{model}" is now available to subagents.',
      'model.meta.output': '{count} out',
      'model.meta.image': 'vision',
      'model.meta.reasoningTiers': 'reasoning · {count}',
      'advanced.title': 'Advanced settings',
      'advanced.hint': 'Provider id, credential reference, request headers, and protocol compat switches.',
      'advanced.provider': 'Provider id',
      'advanced.providerHint': 'Lowercase letters, digits, and hyphens; must start with a letter.',
      'advanced.providerReadonly': 'The provider id cannot be changed while editing.',
      'advanced.apiKeyEnv': 'Credential variable',
      'advanced.apiKeyEnvHint': 'Defaults to the provider id in upper case plus _API_KEY.',
      'advanced.apiKeyEnvKeep': 'Leave empty to keep the saved variable name.',
      'advanced.headers': 'Custom request headers',
      'advanced.headersHint': 'One "Name: value" per line. Unchanged headers stay untouched.',
      'advanced.compatActive': '{count} active',
      'advanced.compat': 'Protocol compat',
      'advanced.compatHint': 'Explicit overrides for this provider; empty values fall back to the protocol preset.',
      'advanced.compatNone': 'This protocol has no extra compat switch.',
      'advanced.compatDefault': 'Default',
      'advanced.compatInvalid': 'Invalid compat values: {fields}',
      'advanced.probe': 'Connectivity probe',
      'advanced.probeRun': 'Run probe',
      'advanced.probeHealthy': 'Endpoint reachable',
      'advanced.probeUnhealthy': 'Endpoint check failed',
      'advanced.probeRecommend': 'Recommended compat: {fields}',
      'advanced.probeNoRecommend': 'No compat adjustment needed',
      'advanced.applyRecommended': 'Apply recommendations',
      'advanced.recommendApplied': 'Recommendations filled in; save to apply.',
      'advanced.setDefault': 'Set the first model as the default after saving',
      'advanced.allowSubagent': 'Allow subagent calls',
      'field.show': 'Show',
      'field.hide': 'Hide',
      'id.available': 'available',
      'id.invalid': 'Lowercase letters, digits, and dashes; start with a letter.',
      'id.reservedNative': 'Reserved by DSH native providers.',
      'id.reservedBuiltin': 'Already shipped by the built-in catalog.',
      'id.exists': 'That provider id already exists; pick another one.',
      'providerCard.managed': 'Managed by Xiaoxing API access',
      'providerCard.probe': 'Probe',
      'providerCard.healthy': 'reachable',
      'providerCard.unhealthy': 'unreachable',
      'providerCard.unconfigured': 'Configure this provider in Xiaoxing API access first.',
      'protocol.openai-completions': 'OpenAI compatible',
      'protocol.openai-responses': 'OpenAI Responses',
      'protocol.anthropic-messages': 'Anthropic Messages',
      'protocol.google-generative-ai': 'Gemini API',
      'editor.effort.off': 'Off',
      'editor.effort.minimal': 'Minimal',
      'editor.effort.low': 'Low',
      'editor.effort.medium': 'Medium',
      'editor.effort.high': 'High',
      'editor.effort.xhigh': 'xHigh',
      'editor.effort.max': 'Max',
      'probe.supported': 'supported',
      'probe.unsupported': 'unsupported',
      'probe.inconclusive': 'inconclusive',
      'probe.skipped': 'skipped',
      'probe.error': 'error',
      'probe.check.connectivity': 'Connectivity',
      'probe.check.chat': 'Chat',
      'probe.check.developerRole': 'Developer role',
      'probe.check.maxTokensField': 'Max tokens field',
      'probe.check.reasoning': 'Reasoning',
      'probe.check.tools': 'Tools',
      'error.title': 'Operation failed',
      'error.internal': 'The provider manager failed.',
      'error.remote-unavailable': 'Provider service is not ready yet. Reopen this page.',
      'error.service-unavailable': 'Host service unavailable. Refresh after reload.',
      'error.config-conflict': 'Configuration changed during write. Retry.',
      'error.config-unavailable': 'llm-pi-ai configuration is unavailable in this profile.',
      'error.config-write-failed': 'Configuration write failed.', 'error.credential-read-failed': 'Stored key could not be read.',
      'error.credential-write-failed': 'Key could not be stored.', 'error.credentials-unavailable': 'Credential store is unavailable.',
      'error.default-selection-failed': 'Default model could not be saved.', 'error.discovery-timeout': 'Endpoint discovery timed out.',
      'error.disposed': 'Plugin unloaded. Reload and reopen this page.', 'error.http-error': 'Endpoint returned an HTTP error.',
      'error.import-failed': 'Configuration import failed.', 'error.invalid-api': 'Unknown wire protocol.',
      'error.invalid-api-key': 'API key is not usable.', 'error.invalid-catalog': 'Model catalog is malformed.',
      'error.invalid-config': 'Configuration is malformed.', 'error.invalid-credential-ref': 'Credential variable name is invalid.',
      'error.invalid-fetch': 'Fetch implementation is invalid.', 'error.invalid-headers': 'Request header is malformed.',
      'error.invalid-import': 'Import payload is invalid.', 'error.invalid-model-id': 'Model id is invalid.',
      'error.invalid-model-profile': 'Model profile is invalid.', 'error.invalid-override': 'Model override is invalid.',
      'error.invalid-probe-check': 'Unknown probe check.', 'error.invalid-probe-target': 'Probe target is invalid.',
      'error.invalid-provider-id': 'Provider id is invalid or reserved.', 'error.invalid-provider-profile': 'Provider profile is invalid.',
      'error.invalid-request': 'Request is invalid.', 'error.invalid-response': 'Endpoint response is invalid.',
      'error.invalid-rules': 'Family rules are malformed.', 'error.invalid-state': 'Saved manager state is invalid.',
      'error.invalid-subagent-selection': 'Subagent model selection is invalid.', 'error.invalid-sync-mode': 'Unknown sync mode.',
      'error.invalid-sync-policy': 'Sync policy is invalid.', 'error.invalid-timeout': 'Timeout value is invalid.',
      'error.invalid-url': 'URL is invalid.', 'error.model-not-found': 'Model was not found on this provider.',
      'error.network-error': 'Network request failed.', 'error.provider-not-found': 'Custom provider was not found.',
      'error.request-aborted': 'Request was cancelled.', 'error.reserved-native-provider': 'Owned by a DSH native provider.',
      'error.response-too-large': 'Endpoint response was too large.', 'error.state-write-failed': 'Manager state write failed.',
      'error.unknown-preset': 'Unknown gateway preset.', 'error.unsafe-file': 'State file is not a regular file.',
      'error.unsupported-api': 'Wire protocol is not supported.', 'error.unsupported-import-format': 'Import format is not supported.',
    }

    /** Chinese dictionary (clean, direct, active labels). */
    const ZH = {
      'title': '小星 API 接入',
      'subtitle': '接入并管理第三方 API 供应商，模型参数与能力自动匹配。',
      'loading': '正在加载…',
      'common.back': '← 返回',
      'common.cancel': '取消',
      'common.working': '处理中…',
      'header.refresh': '刷新',
      'list.connect': '+ 接入 API',
      'list.search': '搜索名称、标识或地址',
      'list.clear': '清除',
      'list.filterEmpty': '没有符合搜索条件的供应商。',
      'list.emptyTitle': '还没有接入 API',
      'list.emptyHint': '接入一个第三方 API，把它的模型加入 DSH。',
      'list.unavailable': '当前 profile 无法访问 llm-pi-ai 配置。',
      'list.models': '{count} 个模型',
      'list.missingKey': '缺密钥',
      'list.edit': '编辑',
      'list.delete': '删除',
      'list.deleteTitle': '删除「{name}」？',
      'list.deleteHint': '将从 llm-pi-ai 移除该供应商及其模型。',
      'list.deleteCredential': '同时删除已保存密钥',
      'list.deleteConfirm': '确认删除',
      'list.deleted': '已删除「{name}」。',
      'list.created': '已接入「{name}」，共 {count} 个模型。',
      'list.updated': '已保存「{name}」。',
      'listAdvanced.title': '模型匹配与导入导出',
      'listAdvanced.unmatchedBadge': '{count} 个未匹配',
      'listAdvanced.boundBadge': '已绑定 {count} 个',
      'listAdvanced.bindingsTitle': '未匹配模型手动绑定',
      'listAdvanced.bindingsHint': '将现有配置中未自动匹配的模型手动绑定到已知上游模型，自动继承其上下文窗口、输出上限、视觉、思考档位与兼容开关。',
      'listAdvanced.bindingsEmpty': '当前已配置模型均有模型库记录。',
      'listAdvanced.unmatched': '未匹配',
      'listAdvanced.boundTo': '已绑定 → {target}',
      'listAdvanced.boundUnmatched': '已绑定 → {target}（未命中）',
      'listAdvanced.bind': '绑定上游',
      'listAdvanced.rebind': '更换绑定',
      'listAdvanced.unbind': '解除绑定',
      'listAdvanced.targetPlaceholder': '搜索或输入上游模型 ID（如 claude-sonnet-4-5、gpt-5）',
      'listAdvanced.bindConfirm': '确认绑定',
      'listAdvanced.bindPick': '绑定',
      'listAdvanced.bindNeedTarget': '请先输入或选择一个上游模型 ID。',
      'listAdvanced.bindSaved': '已将「{model}」绑定到「{target}」，参数已实时生效。',
      'listAdvanced.bindSavedUnmatched': '已将「{model}」绑定到「{target}」，但模型库中暂未命中该上游 ID。',
      'listAdvanced.unbindSaved': '已解除「{model}」的上游模型绑定。',
      'listAdvanced.catalogLoading': '正在加载上游模型库…',
      'listAdvanced.catalogEmpty': '模型库中无匹配项，仍可在上方直接输入新上游模型 ID 进行绑定。',
      'listAdvanced.catalogCount': '当前显示 {shown} / {total} 个上游参考模型',
      'listAdvanced.catalogFailed': '无法读取模型库：{reason}',
      'listAdvanced.catalogRetry': '重试',
      'listAdvanced.registryTitle': '模型知识库',
      'listAdvanced.registrySummary': '在线缓存：{count} 个模型 · {state}',
      'listAdvanced.registryStateFresh': '已是最新',
      'listAdvanced.registryStateStale': '可更新',
      'listAdvanced.registryStateNever': '尚未更新',
      'listAdvanced.registryRefresh': '更新在线模型库',
      'listAdvanced.registryRefreshed': '在线模型库已更新（共 {count} 个模型）。',
      'listAdvanced.registryOffline': '仅离线模式（跳过在线模型库更新）',
      'listAdvanced.registryOfflineOn': '已开启仅离线模式，在线模型库不再更新。',
      'listAdvanced.registryOfflineOff': '已关闭仅离线模式，在线模型库可以继续更新。',
      'listAdvanced.ioTitle': '配置导入 / 导出',
      'listAdvanced.importHint': '支持 JSON、OMP YAML、Cherry JSON 或 DSH cordis YAML；密钥会自动转存到密钥存储。',
      'listAdvanced.importFormat': '格式',
      'listAdvanced.importPlaceholder': '在此粘贴供应商配置内容…',
      'listAdvanced.importButton': '导入配置',
      'listAdvanced.importEmpty': '请先粘贴要导入的配置内容。',
      'listAdvanced.importDone': '已导入 {count} 个供应商配置。',
      'listAdvanced.exportButton': '导出脱敏配置',
      'listAdvanced.exportClear': '清空',
      'listAdvanced.exportDone': '已导出 {count} 个供应商配置（密钥已脱敏）。',
      'importFormat.auto': '自动识别',
      'importFormat.xiaoxing-json': '小星 JSON',
      'importFormat.omp-yaml': 'OMP YAML',
      'importFormat.cherry-json': 'Cherry JSON',
      'importFormat.dsh-cordis-yaml': 'DSH cordis YAML',
      'form.createTitle': '接入 API',
      'form.editTitle': '编辑 · {name}',
      'form.saveCreate': '保存并接入',
      'form.saveEdit': '保存修改',
      'form.connection': '基本连接信息',
      'form.name': '名称',
      'form.namePlaceholder': '例如 OpenRouter / 我的中转',
      'form.api': '协议类型',
      'form.baseURL': 'API 地址',
      'form.baseURLPlaceholder': 'https://relay.example.com/v1',
      'form.baseURLHint': '末尾加 # 可原样保留地址路径。',
      'form.apiKey': 'API 密钥',
      'form.apiKeyHintEdit': '留空则保持已保存密钥不变。',
      'form.autoMatch': '模型信息自动匹配',
      'form.autoMatchHint': '开启后，添加模型会自动匹配上下文窗口、最大输出、输入模态与思考档位。',
      'form.models': '模型管理',
      'form.manualPlaceholder': '输入模型 ID（逗号、分号或换行可批量添加）',
      'form.manualAdd': '添加',
      'form.manualEmpty': '请输入至少一个模型 ID。',
      'form.duplicateSkipped': '有 {count} 个模型已在列表中，已跳过。',
      'form.fetch': '从 API 获取模型',
      'form.fetchNeedURL': '请先填写 API 地址。',
      'form.fetched': '已获取 {count} 个模型。',
      'form.fetchEmpty': '端点没有返回可用模型。',
      'form.needSelection': '请至少选择一个模型。',
      'form.modelsAdded': '已添加 {count} 个模型。',
      'form.enrichPartial': '已添加 {count} 个模型，{failed} 个未匹配到信息但已保留 ID。',
      'form.needURL': '请填写有效的 http(s) API 地址。',
      'form.needModels': '请至少添加一个模型后再保存。',
      'form.invalidModelId': '模型 ID 不能为空。',
      'form.duplicateModelId': '模型 ID 重复：{id}',
      'form.invalidNumber': '{field} 必须是正整数。',
      'form.discoveryTitle': 'API 模型列表',
      'form.discoveryCount': '共获取 {total} 个 · 已添加 {added} 个',
      'form.discoverySearch': '筛选获取到的模型',
      'form.discoverySelectAll': '全选未添加',
      'form.discoveryClear': '清空勾选',
      'form.discoveryAddSelected': '添加已选 ({count})',
      'form.discoveryAdd': '+ 添加',
      'form.discoveryAdded': '已添加',
      'form.discoveryCollapse': '收起',
      'form.discoveryExpand': '展开',
      'form.discoveryClose': '关闭',
      'form.discoveryEmpty': '没有符合筛选的模型。',
      'model.title': '已配置模型 ({count})',
      'model.search': '筛选已配置模型',
      'model.selectAll': '全选已配置模型',
      'model.selectedCount': '已选 {count} 项',
      'model.clearSelection': '取消选择',
      'model.batchMatch': '批量匹配 ({count})',
      'model.batchSubagent': '允许子代理 ({count})',
      'model.batchRemove': '批量移除 ({count})',
      'model.batchRemoved': '已移除 {count} 个模型。',
      'model.batchMatched': '已更新 {count} 个模型的参数。',
      'model.batchMatchPartial': '已更新 {count} 个模型的参数，{failed} 个保留原值。',
      'model.batchSubagentSaved': '已允许 {count} 个模型供子代理调用。',
      'model.selectOne': '选择 {id}',
      'model.emptyTitle': '还没有模型',
      'model.emptyHint': '在上方手动输入模型 ID，或从 API 模型列表中挑选添加。',
      'model.settings': '设置',
      'model.collapse': '收起',
      'model.remove': '移除',
      'model.id': '模型 ID',
      'model.name': '显示名称',
      'model.namePlaceholder': '默认与模型 ID 相同',
      'model.contextWindow': '上下文窗口',
      'model.maxTokens': '最大输出 Token',
      'model.input': '输入模态',
      'model.text': '文本',
      'model.image': '视觉 / 图片',
      'model.reasoning': '思考 / 推理能力',
      'model.reasoningHint': '勾选该模型支持的档位；映射值留空时，off 为 null，其余档位默认使用档位名。',
      'model.effortMapping': '映射值',
      'model.match': '匹配此模型信息',
      'model.matched': '离线模型库命中 · {id}',
      'model.registryMatch': '在线模型库命中 · {id}',
      'model.ruleMatch': '族规则推断 · {id}',
      'model.ambiguousMatch': '有 {count} 个参考模型符合条件，请选择上游模型。',
      'model.ambiguousDraftMatch': '有 {count} 个参考模型符合条件。保存后可在「模型匹配与导入导出」中选择。',
      'model.noMatch': '未命中模型库，使用已有参数或默认值。',
      'model.setDefault': '设为默认模型',
      'model.defaultSaved': '已将「{model}」设为默认模型。',
      'model.allowSubagent': '允许子代理',
      'model.subagentSaved': '已允许子代理调用「{model}」。',
      'model.meta.output': '{count}出',
      'model.meta.image': '视觉',
      'model.meta.reasoningTiers': '思考 · {count}',
      'advanced.title': '高级设置',
      'advanced.hint': '通道标识、密钥变量、请求头与协议兼容开关。',
      'advanced.provider': '通道标识 (provider)',
      'advanced.providerHint': '小写字母开头，仅含小写字母、数字与连字符。',
      'advanced.providerReadonly': '编辑时通道标识不可修改。',
      'advanced.apiKeyEnv': '密钥环境变量名',
      'advanced.apiKeyEnvHint': '默认由通道标识大写并加 _API_KEY 生成。',
      'advanced.apiKeyEnvKeep': '留空则保持已保存的变量名。',
      'advanced.headers': '自定义请求头',
      'advanced.headersHint': '每行一个「Name: value」；编辑时未修改则保持服务端已保存的请求头。',
      'advanced.compatActive': '{count} 项已配置',
      'advanced.compat': '协议兼容开关 (compat)',
      'advanced.compatHint': '显式覆盖该供应商的兼容项；留空表示沿用协议预设。',
      'advanced.compatNone': '该协议没有额外兼容开关。',
      'advanced.compatDefault': '默认',
      'advanced.compatInvalid': '兼容项取值无效：{fields}',
      'advanced.probe': '连通性探测',
      'advanced.probeRun': '开始探测',
      'advanced.probeHealthy': '端点连通正常',
      'advanced.probeUnhealthy': '端点探测异常',
      'advanced.probeRecommend': '推荐 compat：{fields}',
      'advanced.probeNoRecommend': '无需调整兼容项',
      'advanced.applyRecommended': '应用推荐值',
      'advanced.recommendApplied': '已填入推荐值，保存后生效。',
      'advanced.setDefault': '保存后将第一个模型设为默认模型',
      'advanced.allowSubagent': '允许子代理调用',
      'field.show': '显示',
      'field.hide': '隐藏',
      'id.available': '可用',
      'id.invalid': '仅小写字母、数字和连字符，需字母开头。',
      'id.reservedNative': 'DSH 原生通道保留。',
      'id.reservedBuiltin': '内置目录已提供。',
      'id.exists': '该通道标识已存在，请换一个。',
      'providerCard.managed': '由「小星 API 接入」管理',
      'providerCard.probe': '探测',
      'providerCard.healthy': '连通正常',
      'providerCard.unhealthy': '连通异常',
      'providerCard.unconfigured': '请先在小星 API 接入中配置该供应商。',
      'protocol.openai-completions': 'OpenAI 兼容',
      'protocol.openai-responses': 'OpenAI Responses',
      'protocol.anthropic-messages': 'Anthropic Messages',
      'protocol.google-generative-ai': 'Gemini API',
      'editor.effort.off': '关闭',
      'editor.effort.minimal': '极简',
      'editor.effort.low': '低',
      'editor.effort.medium': '中',
      'editor.effort.high': '高',
      'editor.effort.xhigh': '极高',
      'editor.effort.max': '最高',
      'probe.supported': '支持',
      'probe.unsupported': '不支持',
      'probe.inconclusive': '无法判断',
      'probe.skipped': '已跳过',
      'probe.error': '出错',
      'probe.check.connectivity': '连通性',
      'probe.check.chat': '对话',
      'probe.check.developerRole': 'developer 角色',
      'probe.check.maxTokensField': '输出上限字段',
      'probe.check.reasoning': '思考参数',
      'probe.check.tools': '工具调用',
      'error.title': '操作失败',
      'error.internal': '通道管理服务执行失败。',
      'error.remote-unavailable': '通道服务尚未就绪，请重新打开此页面。',
      'error.service-unavailable': '宿主服务不可用，请在插件重载后刷新。',
      'error.config-conflict': '写入期间配置已变化，请重试。',
      'error.config-unavailable': '当前 profile 无法访问 llm-pi-ai 配置。',
      'error.config-write-failed': '配置写入失败。', 'error.credential-read-failed': '无法读取已保存密钥。',
      'error.credential-write-failed': '密钥保存失败。', 'error.credentials-unavailable': '密钥存储不可用。',
      'error.default-selection-failed': '默认模型保存失败。', 'error.discovery-timeout': '端点模型发现超时。',
      'error.disposed': '插件已卸载，请重载后重开此页面。', 'error.http-error': '端点返回了 HTTP 错误。',
      'error.import-failed': '配置导入失败。', 'error.invalid-api': '未知的协议类型。',
      'error.invalid-api-key': 'API 密钥不可用。', 'error.invalid-catalog': '模型目录格式不正确。',
      'error.invalid-config': '配置格式不正确。', 'error.invalid-credential-ref': '密钥变量名无效。',
      'error.invalid-fetch': 'fetch 实现无效。', 'error.invalid-headers': '请求头格式不正确。',
      'error.invalid-import': '导入内容无效。', 'error.invalid-model-id': '模型 ID 无效。',
      'error.invalid-model-profile': '模型参数无效。', 'error.invalid-override': '模型覆盖项无效。',
      'error.invalid-probe-check': '未知的探测项。', 'error.invalid-probe-target': '探测目标无效。',
      'error.invalid-provider-id': '通道标识无效或已被保留。', 'error.invalid-provider-profile': '通道参数无效。',
      'error.invalid-request': '请求无效。', 'error.invalid-response': '端点响应无效。',
      'error.invalid-rules': '型号规则格式不正确。', 'error.invalid-state': '管理状态无效。',
      'error.invalid-subagent-selection': '子代理模型选择无效。', 'error.invalid-sync-mode': '未知同步模式。',
      'error.invalid-sync-policy': '同步策略无效。', 'error.invalid-timeout': '超时值无效。',
      'error.invalid-url': 'URL 无效。', 'error.model-not-found': '该通道找不到此模型。',
      'error.network-error': '网络请求失败。', 'error.provider-not-found': '找不到该自定义通道。',
      'error.request-aborted': '请求已取消。', 'error.reserved-native-provider': '该标识属于 DSH 原生通道。',
      'error.response-too-large': '端点响应过大。', 'error.state-write-failed': '管理状态写入失败。',
      'error.unknown-preset': '未知网关预设。', 'error.unsafe-file': '状态文件不是普通文件。',
      'error.unsupported-api': '不支持该协议类型。', 'error.unsupported-import-format': '不支持该导入格式。',
    }

    /**
     * Styles.
     *
     * Color and geometry come only from DSH CSS variables, token `color-mix()`
     * tints, `--dsw-radius-*`, and `--ds-font-family-code`; no literal color.
     */
    const STYLES = `
.xxa-root { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 760px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }
.xxa-page { display: flex; flex-direction: column; gap: 14px; }
.xxa-formRoot { display: flex; flex-direction: column; gap: 14px; }
.xxa-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 12px; }
.xxa-headMain { display: flex; flex: 1 1 280px; flex-direction: column; gap: 4px; min-width: 0; }
.xxa-heading { margin: 0; font-size: 15px; line-height: 24px; font-weight: 600; }
.xxa-heading:focus { outline: none; }
.xxa-heading:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; border-radius: 4px; }
.xxa-subTitle { margin: 0; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.xxa-live:empty { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.xxa-intro { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.xxa-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.xxa-actionsEnd { justify-content: flex-end; }
.xxa-btn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 5px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm, 8px); padding: 5px 12px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; white-space: nowrap; }
.xxa-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.xxa-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.xxa-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.xxa-btn:disabled { cursor: default; opacity: 0.55; }
.xxa-btnPrimary { border-color: transparent; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-inverted); }
.xxa-btnPrimary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.xxa-btnPrimary:active:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.xxa-btnAccent { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 35%, transparent); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-state-business-primary); }
.xxa-btnAccent:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); }
.xxa-btnDanger { color: var(--dsw-alias-state-error-primary); }
.xxa-btnPrimary.xxa-btnDanger { border-color: transparent; background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-primary-inverted); }
.xxa-btnSmall { padding: 3px 9px; font-size: 12px; line-height: 18px; }
.xxa-chip { flex: none; border-radius: 5px; padding: 1px 6px; border-color: transparent; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 11px; line-height: 16px; }
.xxa-chip:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.xxa-chipActive, .xxa-chipActive:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); color: var(--dsw-alias-state-business-primary); }
.xxa-card { display: flex; flex-direction: column; gap: 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 12px); padding: 12px; background: var(--dsw-alias-bg-layer-1); }
.xxa-cardHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.xxa-cardTitle { margin: 0; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.xxa-cardHint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.xxa-formHead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.xxa-formHeadMain { display: flex; flex: 1 1 240px; align-items: center; gap: 8px; min-width: 0; }
.xxa-formHeadMain .xxa-heading { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xxa-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px 12px; align-items: start; }
.xxa-gridConn { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr); gap: 10px 12px; align-items: start; }
.xxa-gridTwo { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; align-items: start; }
@media (max-width: 480px) { .xxa-gridTwo, .xxa-gridConn { grid-template-columns: 1fr; } }
.xxa-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.xxa-fieldWide { grid-column: 1 / -1; }
.xxa-labelRow { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 10px; }
.xxa-label { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.xxa-hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.xxa-input, .xxa-select, .xxa-textarea { box-sizing: border-box; width: 100%; max-width: 100%; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm, 8px); padding: 6px 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; }
.xxa-inputSmall { padding: 3px 8px; font-size: 12px; line-height: 18px; }
.xxa-textarea { min-height: 76px; resize: vertical; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12px; line-height: 18px; }
.xxa-input:focus-visible, .xxa-select:focus-visible, .xxa-textarea:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -1px; }
.xxa-mono { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12px; overflow-wrap: anywhere; }
.xxa-secretBox { position: relative; display: flex; align-items: center; }
.xxa-secretBox .xxa-input { padding-right: 34px; }
.xxa-keyToggle { position: absolute; right: 2px; top: 2px; bottom: 2px; display: inline-flex; align-items: center; justify-content: center; width: 28px; border: 0; border-radius: 6px; padding: 0; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.xxa-keyToggle:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.xxa-keyToggle:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -1px; }
.xxa-protoGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 8px; }
@media (max-width: 400px) { .xxa-protoGrid { grid-template-columns: 1fr; } }
.xxa-protoBtn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: flex-start; gap: 6px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm, 8px); padding: 5px 10px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.xxa-protoBtn svg { flex: none; }
.xxa-protoBtn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.xxa-protoBtn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.xxa-protoBtnActive, .xxa-protoBtnActive:hover { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-state-business-primary); font-weight: 500; }
.xxa-switchRow { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 10px; }
.xxa-switchMeta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.xxa-switchTitle { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.xxa-checkbox { flex: none; margin: 0; accent-color: var(--dsw-alias-state-business-primary); cursor: pointer; }
.xxa-checks { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.xxa-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); cursor: pointer; user-select: none; }
.xxa-switch { position: relative; flex: none; width: 32px; height: 18px; border: 0; border-radius: 9px; padding: 0; background: var(--dsw-alias-state-idle-primary); cursor: pointer; }
.xxa-switch[aria-checked="true"] { background: var(--dsw-alias-state-business-primary); }
.xxa-switch:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.xxa-switch:disabled { cursor: default; opacity: 0.55; }
.xxa-switchThumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-switch-thumb); transition: transform 120ms ease; }
.xxa-switch[aria-checked="true"] .xxa-switchThumb { transform: translateX(14px); }
.xxa-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 12px); overflow: hidden; }
.xxa-rowGroup { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.xxa-rowGroup:first-child { border-top: none; }
.xxa-providerRow { display: flex; align-items: center; gap: 10px; padding: 9px 12px; }
.xxa-providerRow:hover { background: var(--dsw-alias-interactive-bg-hover); }
.xxa-markTile { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.xxa-markTileAccent { color: var(--dsw-alias-state-business-primary); }
.xxa-markTileDone { color: var(--dsw-alias-state-done-primary); }
.xxa-markTileWarn { color: var(--dsw-alias-state-warn-label); }
.xxa-markTileSuccess { color: var(--dsw-alias-state-success-primary); }
.xxa-providerMain { display: flex; flex: 1 1 auto; flex-direction: column; gap: 2px; min-width: 0; }
.xxa-providerMainClickable { cursor: pointer; }
.xxa-providerTitle { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.xxa-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 20px; }
.xxa-metaLine { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.xxa-endpoint { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.xxa-providerActions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-left: auto; }
.xxa-statusLabel { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.xxa-pip { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.xxa-statusLabelError .xxa-pip { background: var(--dsw-alias-state-error-primary); }
.xxa-statusLabelError { color: var(--dsw-alias-state-error-primary); }
.xxa-badge { display: inline-flex; align-items: center; border-radius: 5px; padding: 1px 6px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.xxa-badgeWarn { color: var(--dsw-alias-state-warn-label); }
.xxa-badgeSuccess { color: var(--dsw-alias-state-success-primary); }
.xxa-badgeError { color: var(--dsw-alias-state-error-primary); }
.xxa-badgeAccent { color: var(--dsw-alias-state-business-primary); }
.xxa-chipGroup { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.xxa-listHead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.xxa-listHeadLeft { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.xxa-bulkHint { align-self: center; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; white-space: nowrap; }
.xxa-modelActions { margin-left: auto; }
.xxa-confirm { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; border-top: 0.5px dashed var(--dsw-alias-border-l3); padding: 9px 12px; background: var(--dsw-alias-bg-module-platform); }
.xxa-confirmText { display: flex; flex: 1 1 220px; flex-direction: column; gap: 2px; min-width: 0; }
.xxa-confirmText strong { font-size: 12px; line-height: 18px; font-weight: 500; overflow-wrap: anywhere; }
.xxa-confirmActions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-left: auto; }
.xxa-empty { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; border: 0.5px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg, 12px); padding: 16px 14px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; text-align: center; }
.xxa-emptyTitle { margin: 0; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.xxa-emptyHint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.xxa-emptyActions { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; margin-top: 4px; }
.xxa-notice { margin: 0; color: var(--dsw-alias-state-success-primary); font-size: 12px; line-height: 18px; }
.xxa-warn { margin: 0; color: var(--dsw-alias-state-warn-label); font-size: 12px; line-height: 18px; }
.xxa-error { display: flex; flex-direction: column; gap: 2px; border-radius: 8px; padding: 8px 10px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.xxa-errorInline { flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 10px; }
.xxa-errorInline > span { flex: 1 1 200px; min-width: 0; }
.xxa-addBar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.xxa-addInputWrap { display: flex; flex: 1 1 260px; align-items: center; gap: 8px; min-width: 0; }
.xxa-addInputWrap .xxa-input { flex: 1 1 auto; }
.xxa-discovery { display: flex; flex-direction: column; gap: 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 12px); padding: 10px 12px; background: var(--dsw-alias-bg-module-platform); }
.xxa-discoveryHead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 10px; }
.xxa-discoveryTitleRow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.xxa-discoveryTitle { margin: 0; font-size: 12px; line-height: 18px; font-weight: 500; }
.xxa-discoveryBody { display: flex; flex-direction: column; gap: 8px; }
.xxa-discoveryToolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.xxa-discoveryToolbar .xxa-input { flex: 1 1 150px; min-width: 140px; }
.xxa-candidateList { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; max-height: 280px; overflow: auto; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-layer-1); }
.xxa-candidate { display: flex; align-items: center; gap: 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); padding: 7px 10px; }
.xxa-candidate:first-child { border-top: none; }
.xxa-candidateAdded { opacity: 0.58; }
.xxa-candidateCheck { display: inline-flex; flex: none; align-items: center; }
.xxa-candidateMain { display: flex; flex: 1 1 auto; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
.xxa-batchBar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.xxa-modelList { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.xxa-modelCard { display: flex; flex-direction: column; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.xxa-modelCard:first-child { border-top: none; }
.xxa-modelCardHead { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 9px 12px; }
.xxa-modelCardHead:hover { background: var(--dsw-alias-interactive-bg-hover); }
.xxa-modelCardOpen > .xxa-modelCardHead { background: var(--dsw-alias-bg-module-platform); }
.xxa-modelCardSelected > .xxa-modelCardHead { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent); box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary); }
.xxa-modelCardMain { display: flex; flex: 1 1 200px; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
.xxa-modelId { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.xxa-modelName { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.xxa-modelCardBody { display: flex; flex-direction: column; gap: 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); padding: 12px; background: var(--dsw-alias-bg-module-platform); }
.xxa-capBar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 14px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 8px); padding: 8px 10px; background: var(--dsw-alias-bg-layer-1); }
.xxa-capGroup { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.xxa-pillToggle { box-sizing: border-box; display: inline-flex; align-items: center; gap: 4px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 6px; padding: 2px 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.xxa-pillToggle:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.xxa-pillToggleOn, .xxa-pillToggleOn:hover { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-state-business-primary); }
.xxa-effortBox { display: flex; flex-direction: column; gap: 6px; }
.xxa-effortGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(144px, 1fr)); gap: 6px; }
.xxa-effortTile { display: flex; flex-direction: column; gap: 5px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 8px); padding: 6px 8px; background: var(--dsw-alias-bg-layer-1); font-size: 12px; line-height: 16px; }
.xxa-effortTileOn { border-color: var(--dsw-alias-state-business-primary); }
.xxa-effortCheck { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
.xxa-effortKey { margin-left: auto; color: var(--dsw-alias-label-tertiary); font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 11px; }
.xxa-effortTile .xxa-input { padding: 3px 6px; font-size: 11px; line-height: 16px; }
.xxa-modelFoot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; border-top: 0.5px dashed var(--dsw-alias-border-l3); padding-top: 10px; }
.xxa-fold { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 12px); padding: 10px 12px; background: var(--dsw-alias-bg-layer-1); }
.xxa-foldSummary { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; font-weight: 500; list-style: none; }
.xxa-foldSummary::-webkit-details-marker { display: none; }
.xxa-foldTitle { display: inline-flex; align-items: center; gap: 6px; }
.xxa-foldTitle::before { content: ''; width: 5px; height: 5px; border-right: 1.5px solid currentcolor; border-bottom: 1.5px solid currentcolor; transform: rotate(-45deg) translate(-1px, -1px); transition: transform 120ms ease; }
.xxa-fold[open] > .xxa-foldSummary .xxa-foldTitle::before { transform: rotate(45deg) translate(-1px, -1px); }
.xxa-foldSummary:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; border-radius: 4px; }
.xxa-foldBody { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; padding-top: 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.xxa-subSection { display: flex; flex-direction: column; gap: 6px; }
.xxa-subSectionDivider { border-top: 0.5px solid var(--dsw-alias-border-l2); padding-top: 10px; }
.xxa-listBar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.xxa-listBarTools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-left: auto; }
.xxa-bindList { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.xxa-bindItem { display: flex; flex-direction: column; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.xxa-bindItem:first-child { border-top: none; }
.xxa-bindRow { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 10px; padding: 8px 10px; }
.xxa-bindMain { display: flex; flex: 1 1 220px; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
.xxa-bindEditor { display: flex; flex-direction: column; gap: 8px; border-top: 0.5px dashed var(--dsw-alias-border-l3); padding: 10px; background: var(--dsw-alias-bg-module-platform); }
.xxa-bindInputRow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.xxa-bindInputRow .xxa-input { flex: 1 1 220px; min-width: 160px; }
.xxa-bindPicker { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; max-height: 200px; overflow: auto; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-layer-1); }
.xxa-bindOption { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 0.5px solid var(--dsw-alias-border-l2); padding: 6px 10px; }
.xxa-bindOption:first-child { border-top: none; }
.xxa-bindOption:hover { background: var(--dsw-alias-interactive-bg-hover); }
.xxa-bindOptionMain { display: flex; flex: 1 1 auto; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
.xxa-ioRow { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.xxa-checkStrip { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 11px; line-height: 16px; }
.xxa-checkItem { display: inline-flex; align-items: center; white-space: nowrap; }
.xxa-checkSuccess { color: var(--dsw-alias-state-success-primary); }
.xxa-checkWarn { color: var(--dsw-alias-state-warn-label); }
.xxa-checkError { color: var(--dsw-alias-state-error-primary); }
.xxa-checkMuted { color: var(--dsw-alias-label-tertiary); }
.xxa-cardExtras { display: flex; flex-direction: column; gap: 6px; max-width: 760px; }
.xxa-cardStrip { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.xxa-chevron { display: inline-flex; transition: transform 140ms ease; }
.xxa-chevronOpen { transform: rotate(180deg); }
@media (prefers-reduced-motion: reduce) {
  .xxa-switchThumb, .xxa-foldTitle::before, .xxa-chevron { transition: none; }
}
`

    /**
     * One action button (`primary`, `accent`, `danger`, `chip`, compact `small`).
     *
     * An array label (icon plus text) is spread into positional children so
     * React never sees a keyless child list.
     */
    const button = (label, onClick, options = {}) => h('button', {
      type: 'button',
      className: [
        'xxa-btn',
        options.small === true ? 'xxa-btnSmall' : '',
        options.primary === true ? 'xxa-btnPrimary' : '',
        options.accent === true ? 'xxa-btnAccent' : '',
        options.danger === true ? 'xxa-btnDanger' : '',
        options.chip === true ? 'xxa-chip' : '',
        options.active === true && options.chip === true ? 'xxa-chipActive' : '',
      ].filter(Boolean).join(' '),
      disabled: options.disabled === true,
      ...(options.ariaExpanded === undefined ? {} : { 'aria-expanded': options.ariaExpanded }),
      ...(options.ariaLabel === undefined ? {} : { 'aria-label': options.ariaLabel }),
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.key === undefined ? {} : { key: options.key }),
      ...(options.ref === undefined ? {} : { ref: options.ref }),
      onClick,
    }, ...(Array.isArray(label) ? label : [label]))
    /** One text input bound to a string draft field; Enter may submit the row. */
    const input = (value, onChange, options = {}) => h('input', {
      className: [
        'xxa-input',
        options.mono === true ? 'xxa-mono' : '',
        options.small === true ? 'xxa-inputSmall' : '',
      ].filter(Boolean).join(' '),
      value,
      ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
      ...(options.width === undefined ? {} : { style: { width: options.width } }),
      ...(options.numeric === true ? { inputMode: 'numeric' } : {}),
      ...(options.ariaLabel === undefined ? {} : { 'aria-label': options.ariaLabel }),
      ...(options.readOnly === true ? { readOnly: true } : {}),
      onChange: event => { onChange(event.target.value) },
      ...(options.onEnter === undefined ? {} : {
        onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); options.onEnter() } },
      }),
    })
    /** One select bound to a string draft field. */
    const select = (value, onChange, values, labelOf, options = {}) => h('select', {
      className: 'xxa-select',
      value,
      ...(options.width === undefined ? {} : { style: { width: options.width } }),
      ...(options.ariaLabel === undefined ? {} : { 'aria-label': options.ariaLabel }),
      onChange: event => { onChange(event.target.value) },
    }, values.map(option => h('option', { key: option, value: option }, labelOf(option))))
    /** One textarea bound to a string draft field. */
    const textarea = (value, onChange, options = {}) => h('textarea', {
      className: 'xxa-textarea',
      value,
      ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
      ...(options.readOnly === true ? { readOnly: true } : {}),
      ...(options.ariaLabel === undefined ? {} : { 'aria-label': options.ariaLabel }),
      onChange: event => { onChange(event.target.value) },
    })
    /** One native-styled checkbox with indeterminate ref + data attribute. */
    const checkbox = (checked, onChange, options = {}) => h('input', {
      type: 'checkbox',
      className: 'xxa-checkbox',
      checked: checked === true,
      disabled: options.disabled === true,
      ...(options.indeterminate === true
        ? { 'data-indeterminate': 'true', ref: node => { if (node) node.indeterminate = true } }
        : { ref: node => { if (node) node.indeterminate = false } }),
      ...(options.ariaLabel === undefined ? {} : { 'aria-label': options.ariaLabel }),
      ...(options.key === undefined ? {} : { key: options.key }),
      onChange: event => { onChange(event.target.checked) },
    })
    /** One labelled form field; the label sits above, an optional inline or bottom hint accompanies it. */
    const field = (label, control, hint, options = {}) => h('label', {
      className: `xxa-field${options.wide === true ? ' xxa-fieldWide' : ''}`,
      ...(options.key === undefined ? {} : { key: options.key }),
    },
      options.inlineHint === undefined || options.inlineHint === '' || options.inlineHint === null
        ? h('span', { className: 'xxa-label' }, label)
        : h('span', { className: 'xxa-labelRow' },
          h('span', { className: 'xxa-label' }, label),
          h('span', { className: 'xxa-hint' }, options.inlineHint),
        ),
      control,
      hint === undefined || hint === '' || hint === null ? null : h('span', { className: 'xxa-hint' }, hint),
    )
    /** One compact checkbox row. */
    const checkRow = (label, checked, onChange, key, options = {}) => h('label', { className: 'xxa-check', ...(key === undefined ? {} : { key }) },
      checkbox(checked, onChange, options),
      h('span', null, label),
    )
    /** One accessible switch row. */
    const switchRow = (label, checked, onChange, key) => h('label', { className: 'xxa-check', ...(key === undefined ? {} : { key }) },
      h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        className: 'xxa-switch',
        onClick: () => onChange(checked !== true),
      }, h('span', { className: 'xxa-switchThumb', 'aria-hidden': true })),
      h('span', null, label),
    )
    /** One standalone switch toggle button for split-row layouts. */
    const switchControl = (label, checked, onChange) => h('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': checked === true,
      'aria-label': label,
      className: 'xxa-switch',
      onClick: () => onChange(checked !== true),
    }, h('span', { className: 'xxa-switchThumb', 'aria-hidden': true }))
    /** One compact read-out label with a state pip. */
    const statusLabel = (text, tone, key) => {
      if (text === '' || text === undefined || text === null) return null
      const className = tone === undefined ? 'xxa-statusLabel' : `xxa-statusLabel xxa-statusLabel${tone}`
      return h('span', { className, ...(key === undefined ? {} : { key }) },
        h('span', { className: 'xxa-pip', 'aria-hidden': true }),
        h('span', null, text),
      )
    }
    /** Build one tiny neutral/tinted badge; an empty label renders nothing. */
    const badge = (text, tone, key) => {
      if (text === '' || text === undefined || text === null) return null
      const className = tone === undefined ? 'xxa-badge' : `xxa-badge xxa-badge${tone}`
      return h('span', { className, ...(key === undefined ? {} : { key }) }, text)
    }
    /** Crisp 13px-16px monochrome vector icons using `currentColor`. */
    const svgIcon = (paths, size = 14) => h('svg', {
      width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    }, ...paths)
    const iconCloud = () => svgIcon([
      h('path', { key: 'a', d: 'M4.5 11.5h7.2a2.5 2.5 0 0 0 .4-5 3.6 3.6 0 0 0-7-.8A2.4 2.4 0 0 0 4.5 11.5Z' }),
      h('path', { key: 'b', d: 'M8 8.2v4.6M6.3 11.2 8 12.8l1.7-1.6' }),
    ], 14)
    const iconRefresh = () => svgIcon([
      h('path', { key: 'a', d: 'M13 8a5 5 0 1 1-1.3-3.4M13 2.8v2.4h-2.4' }),
    ], 13)
    const iconChevron = open => h('span', { className: `xxa-chevron${open ? ' xxa-chevronOpen' : ''}`, 'aria-hidden': true }, svgIcon([
      h('path', { key: 'a', d: 'M4.5 6.2 8 9.7l3.5-3.5' }),
    ], 12))
    const iconEye = open => open
      ? svgIcon([
        h('path', { key: 'a', d: 'M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Z' }),
        h('circle', { key: 'b', cx: 8, cy: 8, r: 1.6 }),
      ], 14)
      : svgIcon([
        h('path', { key: 'a', d: 'M2.5 2.5l11 11M6.3 4.3A6.6 6.6 0 0 1 8 4c3.8 0 6 4 6 4a11 11 0 0 1-1.9 2.5M4.1 5.7A11 11 0 0 0 2 8s2.2 4 6 4a6.4 6.4 0 0 0 2-.3' }),
      ], 14)
    /** Protocol glyph at any icon size. */
    function protocolGlyph(api, size = 16) {
      if (api === 'anthropic-messages') return svgIcon([h('path', { key: 'a', d: 'M4 12.5 7 3.5h2l3 9M5.2 9.5h5.6' })], size)
      if (api === 'google-generative-ai') return svgIcon([h('path', { key: 'a', d: 'M8 2.2c.5 3.1 2.7 5.3 5.8 5.8-3.1.5-5.3 2.7-5.8 5.8-.5-3.1-2.7-5.3-5.8-5.8 3.1-.5 5.3-2.7 5.8-5.8Z' })], size)
      if (api === 'openai-responses') return svgIcon([h('path', { key: 'a', d: 'M9 2.2 4.5 8.8H8L7 13.8l4.5-6.6H8L9 2.2Z' })], size)
      return svgIcon([
        h('circle', { key: 'a', cx: 8, cy: 8, r: 4.8 }),
        h('circle', { key: 'b', cx: 8, cy: 8, r: 1.6 }),
      ], size)
    }
    /** Protocol tile mark for provider cards. */
    function protocolMark(api) {
      const tone = api === 'anthropic-messages' ? 'Warn' : api === 'google-generative-ai' ? 'Success' : api === 'openai-responses' ? 'Done' : 'Accent'
      return h('span', { className: `xxa-markTile xxa-markTile${tone}`, 'aria-hidden': true }, protocolGlyph(api, 16))
    }
    /** Render the capability badges of one model profile. */
    function capabilityChips(t, profile, keyPrefix) {
      const chips = modelCapabilities(t, profile)
      if (chips.length === 0) return null
      return h('span', { className: 'xxa-chipGroup' },
        chips.map((chip, index) => badge(chip.text, chip.tone === 'accent' ? 'Accent' : undefined, `${keyPrefix}-chip-${index}`)),
      )
    }
    /* ----------------------------------------------------------------------- */
    /* Draft model helpers                                                     */
    /* ----------------------------------------------------------------------- */

    /** Monotonic key source for model rows added from the API or by hand. */
    let modelKeySequence = 0
    /** Build one unique stable React key for a model row. */
    function nextModelKey() {
      modelKeySequence += 1
      return `model-new-${modelKeySequence}`
    }
    /** Keep only the discovery fields of one fetched model entry. */
    function pickDiscoveryFields(entry) {
      if (!isPlainObject(entry)) return null
      const picked = {}
      for (const field of DISCOVERY_FIELDS) {
        if (Object.hasOwn(entry, field)) picked[field] = entry[field]
      }
      return Object.keys(picked).length === 0 ? null : picked
    }
    /** Explain the match evidence supplied by the Host for one model. */
    function modelMatchLabel(t, meta, inDraft = false) {
      if (!isPlainObject(meta)) return null
      const count = Array.isArray(meta.ambiguousModelIds) ? meta.ambiguousModelIds.length : 0
      if (count > 0) {
        return inDraft ? t('model.ambiguousDraftMatch', { count }) : t('model.ambiguousMatch', { count })
      }
      if (typeof meta.matchedRegistryId === 'string') return t('model.registryMatch', { id: meta.matchedRegistryId })
      if (typeof meta.matchedCatalogId === 'string') return t('model.matched', { id: meta.matchedCatalogId })
      if (typeof meta.matchedRuleId === 'string') return t('model.ruleMatch', { id: meta.matchedRuleId })
      return t('model.noMatch')
    }

    /** Build one blank model draft for a model id. */
    function blankModelDraft(id) {
      return {
        key: nextModelKey(),
        id: typeof id === 'string' ? id : '',
        name: '',
        contextWindow: '',
        maxTokens: '',
        input: ['text'],
        reasoning: false,
        efforts: {},
        manualFields: {},
        discovered: null,
      }
    }
    /** Build the editor draft of one configured model. */
    function modelToDraft(model, index) {
      const values = Array.isArray(model.input) ? model.input.filter(value => MODALITIES.includes(value)) : []
      const efforts = isPlainObject(model.reasoningEfforts) ? effortMapToDraft(model.reasoningEfforts) : {}
      return {
        key: `model-${index}`,
        id: typeof model.id === 'string' ? model.id : '',
        name: typeof model.name === 'string' && model.name !== model.id ? model.name : '',
        contextWindow: typeof model.contextWindow === 'number' ? String(model.contextWindow) : '',
        maxTokens: typeof model.maxTokens === 'number' ? String(model.maxTokens) : '',
        input: values.length === 0 ? ['text'] : values,
        reasoning: Object.keys(efforts).length > 0,
        efforts,
        manualFields: {},
        match: isPlainObject(model.match) ? model.match : null,
        discovered: null,
      }
    }
    /**
     * Refresh the preview and leave fields the user has edited in this draft alone.
     * An explicit match can be saved even when automatic matching is disabled.
     */
    function applyMatchToModelDraft(model, result, matchedInDraft = false) {
      const profile = result.profile
      const next = { ...model, match: result.meta ?? null, matchedInDraft }
      const manual = model.manualFields ?? {}
      if (!manual.name && typeof profile.name === 'string') next.name = profile.name === model.id.trim() ? '' : profile.name
      if (!manual.contextWindow && Number.isInteger(profile.contextWindow) && profile.contextWindow > 0) next.contextWindow = String(profile.contextWindow)
      if (!manual.maxTokens && Number.isInteger(profile.maxTokens) && profile.maxTokens > 0) next.maxTokens = String(profile.maxTokens)
      if (!manual.input && Array.isArray(profile.input) && profile.input.length > 0) {
        const input = profile.input.filter(value => MODALITIES.includes(value))
        next.input = input.length === 0 ? ['text'] : input
      }
      if (!manual.reasoningEfforts) {
        next.efforts = effortMapToDraft(profile.reasoningEfforts)
        next.reasoning = Object.keys(next.efforts).length > 0
        next.matchedNonReasoning = profile.reasoningEfforts === false
      }
      return next
    }
    /** Keep the endpoint's original facts separate from the preview. */
    function modelFromDiscovery(entry, result) {
      const model = blankModelDraft(entry.id)
      model.discovered = pickDiscoveryFields(entry)
      return result === undefined ? model : applyMatchToModelDraft(model, result)
    }
    /** Build the enrich request entry of one model draft. */
    function discoveryPayloadOf(model) {
      return isPlainObject(model.discovered) ? { id: model.id, discovered: model.discovered } : { id: model.id }
    }
    /** The capability preview of one model draft. */
    function modelDraftProfile(model, api) {
      return {
        contextWindow: parseOptionalPositiveInteger(model.contextWindow),
        maxTokens: parseOptionalPositiveInteger(model.maxTokens),
        input: model.input,
        reasoningEfforts: buildReasoningEfforts(model, api),
      }
    }
    /** Build one empty create draft. */
    function createBlankDraft() {
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
        selectedModelKeys: [],
        compatDraft: {},
        probe: null,
        setAsDefault: false,
        enableSubagent: false,
        ignoredModels: [],
        originalModelIds: [],
      }
    }
    /** Build the editor draft of one configured provider. */
    function createEditDraft(provider) {
      const headersText = formatHeadersLines(provider.headers)
      const rawModels = Array.isArray(provider.models) ? provider.models : []
      const policy = isPlainObject(provider.syncPolicy) ? provider.syncPolicy : {}
      const api = typeof provider.api === 'string' ? provider.api : 'openai-completions'
      return {
        mode: 'edit',
        provider: String(provider.provider),
        providerDirty: true,
        displayName: typeof provider.displayName === 'string' ? provider.displayName : String(provider.provider),
        api,
        baseURL: typeof provider.baseURL === 'string' ? provider.baseURL : '',
        apiKey: '',
        showKey: false,
        apiKeyEnv: typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv : '',
        apiKeyEnvDirty: false,
        headersText,
        initialHeadersText: headersText,
        autoMatch: true,
        models: rawModels.map((model, index) => modelToDraft(model, index)),
        modelSearch: '',
        manualModelInput: '',
        discovery: null,
        expandedKeys: rawModels.length === 1 ? ['model-0'] : [],
        selectedModelKeys: [],
        compatDraft: compatToDraft(provider.compat, api),
        probe: null,
        setAsDefault: false,
        enableSubagent: false,
        ignoredModels: Array.isArray(policy.ignoredModels) ? policy.ignoredModels.filter(id => typeof id === 'string' && id !== '') : [],
        originalModelIds: rawModels.map(model => (typeof model.id === 'string' ? model.id : '')).filter(id => id !== ''),
      }
    }

    /** Build the settings section component for one plugin context. */
    function createSection(ctx, fallbackT) {
      return function ApiManagerSection(props) {
        const t = typeof props?.t === 'function' ? props.t : fallbackT
        const [data, setData] = React.useState({ providers: [], available: true })
        const [view, setView] = React.useState({ busy: true, saving: false, loaded: false, failure: null, notice: '' })
        const [draft, setDraft] = React.useState(null)
        const [filter, setFilter] = React.useState({ search: '' })
        const [removeTarget, setRemoveTarget] = React.useState(null)
        const [advanced, setAdvanced] = React.useState({
          open: false,
          registry: null,
          catalogModels: [],
          catalogTotal: 0,
          catalogLoading: false,
          catalogError: null,
          editingTarget: null,
          upstreamInput: '',
          catalogQuery: '',
          importText: '',
          importFormat: 'auto',
          exportText: '',
        })
        const generation = React.useRef(0)
        const opRef = React.useRef(0)
        const catalogSeqRef = React.useRef(0)
        /** Pending debounced catalog search timer of the upstream-binding input. */
        const catalogTimerRef = React.useRef(null)
        /** Which element should take focus once it next mounts (view switch, inline confirm). */
        const pendingFocusRef = React.useRef(null)

        /** Call one Remote method and unwrap both envelopes. */
        const call = React.useCallback(async (method, request) => {
          try {
            // The mounted namespace is an optional service keyed
            // `remote.xiaoxingApiManager`; resolve it through the global service
            // store (ctx.get), not the ctx property proxy.
            const namespace = typeof ctx.get === 'function' ? ctx.get(`remote.${REMOTE_NAMESPACE}`) : undefined
            if (namespace === undefined || namespace === null || typeof namespace[method] !== 'function') return { ok: false, code: 'remote-unavailable', message: '' }
            return unwrapRemoteResult(await namespace[method](request === undefined ? {} : request))
          } catch (error) {
            return { ok: false, code: 'remote-unavailable', message: messageOfError(error) }
          }
        }, [])
        const patchView = React.useCallback(patch => { setView(current => ({ ...current, ...patch })) }, [])
        /** Start one draft operation; a newer edit makes every older result stale. */
        const beginDraftOp = () => { opRef.current += 1; return opRef.current }
        /** Invalidate in-flight draft operations after an identity-bearing edit. */
        const invalidateDraftOps = () => { opRef.current += 1 }
        /** Whether a draft operation was superseded by a newer edit. */
        const isStaleDraftOp = token => opRef.current !== token
        /**
         * Report a local validation failure in the shared error slot.
         *
         * A localized hint is shown as is; without a hint the code's own
         * dictionary text explains the failure.
         */
        const fail = (code, hint = '') => { patchView({ failure: { code, message: hint, local: true } }); return null }
        /** Report a local failure whose raw detail still needs the localized code text in front. */
        const failDetail = (code, detail) => { patchView({ failure: { code, message: detail } }); return null }
        /** Ref callback that focuses its node once, when the pending focus target names it. */
        const focusWhenPending = target => node => {
          if (node === null || node === undefined || pendingFocusRef.current !== target) return
          pendingFocusRef.current = null
          if (typeof node.focus === 'function') node.focus()
        }
        /** Drop a scheduled upstream-catalog search that has not fired yet. */
        const cancelCatalogSearch = () => {
          const timer = catalogTimerRef.current
          if (timer === null || timer === undefined) return
          catalogTimerRef.current = null
          if (typeof window.clearTimeout === 'function') window.clearTimeout(timer)
        }
        /**
         * Re-read the provider list.
         *
         * A caller that just reported its own failure keeps it: a successful
         * re-read must not wipe the error the action is still explaining.
         */
        const refresh = React.useCallback(async (options = {}) => {
          const preserveFailure = options?.preserveFailure === true
          const serial = generation.current + 1
          generation.current = serial
          const listResult = await call('listCustomProviders', {})
          if (generation.current !== serial) return
          const providers = listResult.ok && Array.isArray(listResult.value?.providers) ? listResult.value.providers : []
          const available = listResult.ok ? listResult.value?.available !== false : true
          setData({ providers, available })
          const problem = listResult.ok ? null : listResult
          setView(current => ({
            ...current, busy: false, loaded: true,
            failure: problem !== null ? problem : preserveFailure ? current.failure : null,
          }))
        }, [call])
        const reload = React.useCallback(async () => { await refresh() }, [refresh])
        React.useEffect(() => {
          void reload()
          return () => {
            generation.current += 1
            cancelCatalogSearch()
          }
        }, [reload])
        /**
         * Run one action behind the shared busy flag.
         * @param {() => Promise<unknown>} task - the action.
         * @param {object} [options] - `saving` marks the form save, the only action the save button reports.
         */
        const withBusy = async (task, options = {}) => {
          if (view.busy === true) return
          patchView({ busy: true, saving: options.saving === true, failure: null, notice: '' })
          try { await task() } finally { patchView({ busy: false, saving: false }) }
        }
        /** Report one Host failure and re-read without dropping it. */
        const failHost = async failure => { patchView({ failure }); await refresh({ preserveFailure: true }) }

        /* ----- level one: the provider list ---------------------------------- */
        const openCreate = () => {
          invalidateDraftOps()
          setRemoveTarget(null)
          pendingFocusRef.current = 'form-heading'
          setDraft(createBlankDraft())
          patchView({ failure: null, notice: '' })
        }
        const openEdit = provider => {
          invalidateDraftOps()
          setRemoveTarget(null)
          pendingFocusRef.current = 'form-heading'
          setDraft(createEditDraft(provider))
          patchView({ failure: null, notice: '' })
        }
        const closeForm = () => {
          invalidateDraftOps()
          pendingFocusRef.current = 'list-heading'
          setDraft(null)
          patchView({ failure: null, notice: '' })
        }
        const requestRemove = provider => {
          pendingFocusRef.current = 'confirm-cancel'
          setRemoveTarget({ provider: String(provider.provider), removeCredential: false })
        }
        /** Close the inline delete confirmation and hand focus back to its row's delete button. */
        const cancelRemove = () => {
          if (removeTarget !== null) pendingFocusRef.current = `delete-${removeTarget.provider}`
          setRemoveTarget(null)
        }
        /** Delete one provider, optionally removing its stored key. */
        const confirmRemove = () => withBusy(async () => {
          const target = removeTarget
          if (target === null) return
          const name = providerName(data.providers.find(provider => String(provider.provider) === target.provider))
          const result = await call('removeProvider', { provider: target.provider, removeCredential: target.removeCredential === true })
          setRemoveTarget(null)
          if (!result.ok) return failHost(result)
          await refresh()
          patchView({ notice: t('list.deleted', { name }) })
        })
        /** Readable name of one listed provider. */
        const providerName = provider => {
          if (isPlainObject(provider) && typeof provider.displayName === 'string' && provider.displayName.trim() !== '') return provider.displayName
          return isPlainObject(provider) ? String(provider.provider) : ''
        }
        const patchAdvanced = React.useCallback(patch => { setAdvanced(current => ({ ...current, ...patch })) }, [])
        /**
         * Lazily query the registry status and matching upstream catalog models.
         *
         * A failure stays inside the fold (`catalogError`) so it never replaces
         * the page-level error another action is still explaining.
         */
        const loadCatalog = React.useCallback(async (query = '') => {
          const serial = catalogSeqRef.current + 1
          catalogSeqRef.current = serial
          setAdvanced(current => ({ ...current, catalogLoading: true, catalogError: null }))
          const result = await call('getRegistryStatus', { includeCatalog: true, query, limit: 30 })
          if (catalogSeqRef.current !== serial) return
          if (!result.ok) {
            setAdvanced(current => ({ ...current, catalogLoading: false, catalogError: result }))
            return
          }
          const value = isPlainObject(result.value) ? result.value : {}
          setAdvanced(current => ({
            ...current,
            catalogLoading: false,
            catalogError: null,
            registry: value,
            catalogModels: Array.isArray(value.catalogModels) ? value.catalogModels : current.catalogModels,
            catalogTotal: typeof value.catalogTotal === 'number' ? value.catalogTotal : current.catalogTotal,
          }))
        }, [call])
        /** Read the catalog for one typed query after a short quiet period. */
        const scheduleCatalogSearch = query => {
          cancelCatalogSearch()
          if (typeof window.setTimeout !== 'function') {
            void loadCatalog(query)
            return
          }
          catalogTimerRef.current = window.setTimeout(() => {
            catalogTimerRef.current = null
            void loadCatalog(query)
          }, CATALOG_SEARCH_DEBOUNCE_MS)
        }
        const onToggleListAdvanced = open => {
          patchAdvanced({ open: open === true })
          if (open !== true) {
            cancelCatalogSearch()
            return
          }
          if (advanced.registry === null && advanced.catalogLoading !== true) void loadCatalog('')
        }
        const openBindTarget = (provider, modelId, upstreamInput, catalogQuery) => {
          cancelCatalogSearch()
          patchAdvanced({ editingTarget: { provider, modelId }, upstreamInput, catalogQuery })
          void loadCatalog(catalogQuery)
        }
        const closeBindTarget = () => {
          cancelCatalogSearch()
          patchAdvanced({ editingTarget: null, upstreamInput: '', catalogQuery: '' })
        }
        const onUpstreamInputChange = value => {
          patchAdvanced({ upstreamInput: value, catalogQuery: value })
          scheduleCatalogSearch(value)
        }
        /** Bind one existing model to an upstream reference model and re-enrich live. */
        const bindUpstreamModel = (provider, modelId, rawTarget) => withBusy(async () => {
          const target = String(rawTarget ?? '').trim()
          if (target === '') return fail('invalid-model-id', t('listAdvanced.bindNeedTarget'))
          cancelCatalogSearch()
          const result = await call('saveOverride', { provider, modelId, override: { upstreamModel: target } })
          if (!result.ok) return failHost(result)
          patchAdvanced({ editingTarget: null, upstreamInput: '', catalogQuery: '' })
          await refresh()
          const meta = isPlainObject(result.value?.meta) ? result.value.meta : null
          const matched = typeof meta?.matchedCatalogId === 'string' || typeof meta?.matchedRegistryId === 'string'
          patchView({
            notice: matched
              ? t('listAdvanced.bindSaved', { model: modelId, target })
              : t('listAdvanced.bindSavedUnmatched', { model: modelId, target }),
          })
        })
        /** Clear one manual upstream model binding and restore default matching. */
        const unbindUpstreamModel = (provider, modelId) => withBusy(async () => {
          const result = await call('saveOverride', { provider, modelId, override: { upstreamModel: null } })
          if (!result.ok) return failHost(result)
          setAdvanced(current => (
            current.editingTarget !== null
            && current.editingTarget.provider === provider
            && current.editingTarget.modelId === modelId
              ? { ...current, editingTarget: null, upstreamInput: '', catalogQuery: '' }
              : current
          ))
          await refresh()
          patchView({ notice: t('listAdvanced.unbindSaved', { model: modelId }) })
        })
        /**
         * Force-refresh the online model knowledge base and re-audit providers.
         *
         * The request never names `offlineOnly`: the Host persists that flag
         * whenever it is present, and a refresh must not switch offline mode off.
         */
        const runRefreshRegistry = () => withBusy(async () => {
          const result = await call('refreshRegistry', { force: true })
          if (!result.ok) return failHost(result)
          await refresh()
          await loadCatalog(advanced.editingTarget === null ? '' : advanced.catalogQuery)
          patchView({ notice: t('listAdvanced.registryRefreshed', { count: typeof result.value?.modelCount === 'number' ? result.value.modelCount : 0 }) })
        })
        /** Toggle offline-only mode for the model knowledge base. */
        const toggleOfflineOnly = checked => withBusy(async () => {
          const offlineOnly = checked === true
          const result = await call('refreshRegistry', { offlineOnly, force: false })
          if (!result.ok) return failHost(result)
          await loadCatalog(advanced.editingTarget === null ? '' : advanced.catalogQuery)
          patchView({ notice: offlineOnly ? t('listAdvanced.registryOfflineOn') : t('listAdvanced.registryOfflineOff') })
        })
        /** Import third-party provider configuration text. */
        const runImportConfig = () => withBusy(async () => {
          if (advanced.importText.trim() === '') return fail('invalid-import', t('listAdvanced.importEmpty'))
          const result = await call('importConfig', { payload: advanced.importText, format: advanced.importFormat })
          if (!result.ok) return failHost(result)
          patchAdvanced({ importText: '' })
          await refresh()
          patchView({ notice: t('listAdvanced.importDone', { count: typeof result.value?.importedCount === 'number' ? result.value.importedCount : 0 }) })
        })
        /** Export sanitized custom provider configuration JSON. */
        const runExportConfig = () => withBusy(async () => {
          const result = await call('exportConfig', { includeSyncPolicy: true })
          if (!result.ok) return failHost(result)
          // The Host returns the sanitized document fields inline
          // (`format`, `exportedAt`, `providers`) next to `ok` and `count`.
          const value = isPlainObject(result.value) ? result.value : {}
          const exported = {
            format: value.format,
            exportedAt: value.exportedAt,
            providers: isPlainObject(value.providers) ? value.providers : {},
          }
          patchAdvanced({ exportText: JSON.stringify(exported, null, 2) })
          patchView({ notice: t('listAdvanced.exportDone', { count: typeof result.value?.count === 'number' ? result.value.count : 0 }) })
        })

        /* ----- level two: one shared create/edit state machine ---------------- */
        /** Apply one identity-bearing edit and keep the derived provider id in step. */
        const updateDraftIdentity = patch => setDraft(current => {
          if (current === null) return current
          const next = { ...current, ...patch }
          if (next.mode === 'create' && next.providerDirty !== true) {
            const provider = deriveProviderIdFromDraft(next.displayName, next.baseURL, data.providers.map(provider => String(provider.provider)))
            next.provider = provider
            if (next.apiKeyEnvDirty !== true) next.apiKeyEnv = deriveCredentialRef(provider)
          }
          return next
        })
        const onNameChange = value => { updateDraftIdentity({ displayName: value }) }
        const onBaseURLChange = value => { invalidateDraftOps(); updateDraftIdentity({ baseURL: value }) }
        const onApiChange = value => {
          invalidateDraftOps()
          setDraft(current => (current === null ? current : { ...current, api: value, compatDraft: {}, probe: null }))
        }
        const onProviderChange = value => setDraft(current => {
          if (current === null) return current
          return {
            ...current,
            provider: value,
            providerDirty: true,
            ...(current.apiKeyEnvDirty === true ? {} : { apiKeyEnv: deriveCredentialRef(value) }),
          }
        })
        const onApiKeyEnvChange = value => setDraft(current => (current === null ? current : { ...current, apiKeyEnv: value, apiKeyEnvDirty: true }))
        const onApiKeyChange = value => setDraft(current => (current === null ? current : { ...current, apiKey: value }))
        const onToggleKeyVisible = () => setDraft(current => (current === null ? current : { ...current, showKey: current.showKey !== true }))
        const onHeadersChange = value => setDraft(current => (current === null ? current : { ...current, headersText: value }))
        const onAutoMatchChange = value => setDraft(current => (current === null ? current : { ...current, autoMatch: value }))
        const onSetAsDefaultChange = value => setDraft(current => (current === null ? current : { ...current, setAsDefault: value }))
        const onEnableSubagentChange = value => setDraft(current => (current === null ? current : { ...current, enableSubagent: value }))
        const patchCompat = (fieldName, value) => setDraft(current => (current === null ? current : { ...current, compatDraft: { ...current.compatDraft, [fieldName]: value } }))
        const patchModel = (modelKey, patch, field) => setDraft(current => (current === null ? current : {
          ...current,
          models: current.models.map(model => (model.key !== modelKey ? model : {
            ...model,
            ...patch,
            manualFields: { ...model.manualFields, [field]: true },
          })),
        }))
        const changeModelId = (modelKey, id) => {
          const previousId = draft?.models.find(model => model.key === modelKey)?.id
          const changed = previousId?.trim() !== id.trim()
          if (changed) {
            invalidateDraftOps()
            patchView({ notice: '' })
          }
          setDraft(current => (current === null ? current : {
            ...current,
            models: current.models.map(model => {
              if (model.key !== modelKey) return model
              if (!changed) return { ...model, id }
              const manual = model.manualFields ?? {}
              return {
                ...model, id,
                discovered: null, match: null, matchedInDraft: false, matchedNonReasoning: false,
                name: manual.name ? model.name : '',
                contextWindow: manual.contextWindow ? model.contextWindow : '',
                maxTokens: manual.maxTokens ? model.maxTokens : '',
                input: manual.input ? model.input : ['text'],
                reasoning: manual.reasoningEfforts === true && model.reasoning === true,
                efforts: manual.reasoningEfforts ? model.efforts : {},
              }
            }),
          }))
        }
        const toggleModelExpanded = modelKey => setDraft(current => {
          if (current === null) return current
          const expanded = current.expandedKeys.includes(modelKey)
            ? current.expandedKeys.filter(item => item !== modelKey)
            : [...current.expandedKeys, modelKey]
          return { ...current, expandedKeys: expanded }
        })
        const selectedKeysOf = state => (Array.isArray(state?.selectedModelKeys) ? state.selectedModelKeys : [])
        const removeModel = modelKey => setDraft(current => (current === null ? current : {
          ...current,
          expandedKeys: current.expandedKeys.filter(item => item !== modelKey),
          selectedModelKeys: selectedKeysOf(current).filter(item => item !== modelKey),
          models: current.models.filter(model => model.key !== modelKey),
        }))
        const toggleModelSelected = modelKey => setDraft(current => {
          if (current === null) return current
          const keys = selectedKeysOf(current)
          const selected = keys.includes(modelKey)
            ? keys.filter(item => item !== modelKey)
            : [...keys, modelKey]
          return { ...current, selectedModelKeys: selected }
        })
        const toggleSelectAllVisibleModels = visibleKeys => setDraft(current => {
          if (current === null || visibleKeys.length === 0) return current
          const keys = selectedKeysOf(current)
          const selectedSet = new Set(keys)
          const allSelected = visibleKeys.every(key => selectedSet.has(key))
          if (allSelected) {
            const visibleSet = new Set(visibleKeys)
            return { ...current, selectedModelKeys: keys.filter(key => !visibleSet.has(key)) }
          }
          for (const key of visibleKeys) selectedSet.add(key)
          return { ...current, selectedModelKeys: [...selectedSet] }
        })
        const clearSelectedModels = () => setDraft(current => (current === null ? current : { ...current, selectedModelKeys: [] }))
        const removeSelectedModels = () => {
          const current = draft
          if (current === null) return
          const selectedSet = new Set(selectedKeysOf(current))
          const targets = current.models.filter(model => selectedSet.has(model.key))
          if (targets.length === 0) return
          const targetKeys = new Set(targets.map(model => model.key))
          setDraft(state => (state === null ? state : {
            ...state,
            models: state.models.filter(model => !targetKeys.has(model.key)),
            expandedKeys: state.expandedKeys.filter(key => !targetKeys.has(key)),
            selectedModelKeys: [],
          }))
          patchView({ notice: t('model.batchRemoved', { count: targets.length }), failure: null })
        }
        const setModelModality = (modelKey, modality, enabled) => setDraft(current => (current === null ? current : {
          ...current,
          models: current.models.map(model => {
            if (model.key !== modelKey) return model
            const next = model.input.filter(value => value !== modality)
            if (enabled === true && !next.includes(modality)) next.push(modality)
            return { ...model, input: next.length === 0 ? ['text'] : next, manualFields: { ...(isPlainObject(model.manualFields) ? model.manualFields : {}), input: true } }
          }),
        }))
        const toggleModelReasoning = (modelKey, enabled) => setDraft(current => {
          if (current === null) return current
          return {
            ...current,
            models: current.models.map(model => {
              if (model.key !== modelKey) return model
              if (enabled !== true) return { ...model, reasoning: false, manualFields: { ...(isPlainObject(model.manualFields) ? model.manualFields : {}), reasoningEfforts: true } }
              // Turning reasoning on for a model that never declared levels seeds
              // the protocol defaults so its effort tiles are usable at once.
              const efforts = Object.keys(model.efforts).length > 0 ? model.efforts : defaultReasoningEfforts(current.api)
              return { ...model, reasoning: true, efforts, manualFields: { ...(isPlainObject(model.manualFields) ? model.manualFields : {}), reasoningEfforts: true } }
            }),
          }
        })
        const setModelEffort = (modelKey, level, enabled) => setDraft(current => (current === null ? current : {
          ...current,
          models: current.models.map(model => {
            if (model.key !== modelKey) return model
            const efforts = { ...model.efforts }
            // pi-ai spells the "thinking can be turned off" level as `off: null`,
            // every other level stores its own name.
            if (enabled === true) efforts[level] = level === 'off' ? null : level
            else delete efforts[level]
            const hasTier = Object.keys(efforts).some(name => name !== 'off')
            return { ...model, efforts, reasoning: hasTier ? model.reasoning : false, manualFields: { ...(isPlainObject(model.manualFields) ? model.manualFields : {}), reasoningEfforts: true } }
          }),
        }))
        const setModelEffortValue = (modelKey, level, value) => setDraft(current => (current === null ? current : {
          ...current,
          models: current.models.map(model => (model.key === modelKey ? {
            ...model,
            efforts: { ...model.efforts, [level]: value },
            manualFields: { ...(isPlainObject(model.manualFields) ? model.manualFields : {}), reasoningEfforts: true },
          } : model)),
        }))
        const patchDiscovery = patch => setDraft(current => {
          if (current === null || current.discovery === null) return current
          return { ...current, discovery: { ...current.discovery, ...patch } }
        })
        const toggleDiscoveryCandidate = id => setDraft(current => {
          if (current === null || current.discovery === null) return current
          if (current.models.some(model => model.id === id)) return current
          const selected = current.discovery.selected.includes(id)
            ? current.discovery.selected.filter(item => item !== id)
            : [...current.discovery.selected, id]
          return { ...current, discovery: { ...current.discovery, selected } }
        })
        const selectAllCandidates = () => setDraft(current => {
          if (current === null || current.discovery === null) return current
          const added = new Set(current.models.map(model => model.id))
          const selected = current.discovery.models
            .map(model => model.id)
            .filter(id => !added.has(id))
          return { ...current, discovery: { ...current.discovery, selected } }
        })
        const clearCandidateSelection = () => patchDiscovery({ selected: [] })
        const closeDiscovery = () => setDraft(current => (current === null ? current : { ...current, discovery: null }))

        /**
         * Add fetched or hand-typed model entries to the draft.
         *
         * With auto-match on, one batched `enrich` call fills in capabilities
         * first; a failed call never blocks the add, the id is kept and the
         * failure is reported. Results from a superseded draft are dropped.
         * @param {object[]} entries - model entries (ids and optional discovery fields).
         * @param {object} [options] - `clearManual` clears the manual input afterwards.
         */
        const addModelDrafts = async (entries, options = {}) => {
          const current = draft
          if (current === null) return
          const known = new Set(current.models.map(model => model.id.trim()))
          const seen = new Set()
          const fresh = []
          for (const entry of entries) {
            const id = isPlainObject(entry) && typeof entry.id === 'string' ? entry.id.trim() : ''
            if (id === '' || known.has(id) || seen.has(id)) continue
            seen.add(id)
            fresh.push({ ...entry, id })
          }
          if (options.clearManual === true) setDraft(state => (state === null ? state : { ...state, manualModelInput: '' }))
          if (fresh.length === 0) {
            patchView({ notice: t('form.duplicateSkipped', { count: entries.length }) })
            return
          }
          let added = []
          let failed = 0
          let enrichFailure = null
          if (current.autoMatch === true) {
            const token = beginDraftOp()
            const models = fresh.map(entry => discoveryPayloadOf({ id: entry.id, discovered: pickDiscoveryFields(entry) }))
            const request = { api: current.api, presetId: PRESET_ID_BY_API[current.api], models }
            if (current.mode === 'edit') request.provider = current.provider
            const enriched = await call('enrich', request)
            if (isStaleDraftOp(token)) return
            if (enriched.ok) {
              const profiles = new Map()
              const resultModels = Array.isArray(enriched.value?.models) ? enriched.value.models : []
              for (const item of resultModels) {
                if (isPlainObject(item) && typeof item.id === 'string' && isPlainObject(item.profile)) profiles.set(item.id, item)
              }
              added = fresh.map(entry => {
                const profile = profiles.get(entry.id)
                if (profile === undefined) {
                  failed += 1
                  return modelFromDiscovery(entry)
                }
                return modelFromDiscovery(entry, profile)
              })
            } else {
              added = fresh.map(entry => modelFromDiscovery(entry))
              failed = fresh.length
              enrichFailure = enriched
            }
          } else {
            added = fresh.map(entry => modelFromDiscovery(entry))
          }
          setDraft(state => {
            if (state === null) return state
            const stateIds = new Set(state.models.map(model => model.id.trim()))
            const appended = added.filter(model => !stateIds.has(model.id))
            const appendedIds = new Set(appended.map(model => model.id))
            const discovery = state.discovery === null ? null : {
              ...state.discovery,
              selected: state.discovery.selected.filter(id => !appendedIds.has(id)),
            }
            return { ...state, models: [...state.models, ...appended], discovery, modelSearch: '' }
          })
          if (enrichFailure !== null) { patchView({ failure: enrichFailure }); return }
          if (failed > 0) patchView({ notice: t('form.enrichPartial', { count: fresh.length - failed, failed }) })
          else patchView({ notice: t('form.modelsAdded', { count: fresh.length }) })
        }
        /** Add every model id typed into the manual batch input. */
        const addManualModels = () => withBusy(async () => {
          const current = draft
          if (current === null) return
          const ids = splitModelIds(current.manualModelInput)
          if (ids.length === 0) return fail('invalid-model-id', t('form.manualEmpty'))
          await addModelDrafts(ids.map(id => ({ id })), { clearManual: true })
        })
        /** Fetch the endpoint model list and open the selection panel. */
        const fetchModels = () => withBusy(async () => {
          const current = draft
          if (current === null) return
          const rawURL = current.baseURL.trim()
          if (rawURL === '') return fail('invalid-url', t('form.fetchNeedURL'))
          let headers
          if (current.headersText.trim() !== '' && (current.mode === 'create' || current.headersText !== current.initialHeadersText)) {
            try { headers = parseHeadersLines(current.headersText) } catch (error) { return failDetail('invalid-headers', messageOfError(error)) }
          }
          const token = beginDraftOp()
          const request = { baseURL: rawURL, api: current.api }
          if (current.mode === 'edit') request.provider = current.provider
          if (current.apiKey !== '') request.apiKey = current.apiKey
          if (current.mode === 'create' && current.apiKeyEnv.trim() !== '') request.apiKeyEnv = current.apiKeyEnv.trim()
          if (headers !== undefined) request.headers = headers
          const result = await call('discover', request)
          if (isStaleDraftOp(token)) return
          if (!result.ok) { patchView({ failure: result }); return }
          const fetched = Array.isArray(result.value?.models)
            ? result.value.models.filter(item => isPlainObject(item) && typeof item.id === 'string' && item.id.trim() !== '')
            : []
          const suggested = typeof result.value?.suggestedBaseURL === 'string' ? result.value.suggestedBaseURL : ''
          setDraft(state => (state === null ? state : {
            ...state,
            ...(suggested === '' ? {} : { baseURL: suggested }),
            discovery: { models: fetched, selected: [], search: '', open: true },
          }))
          patchView({ notice: fetched.length === 0 ? t('form.fetchEmpty') : t('form.fetched', { count: fetched.length }) })
        })
        /** Add every selected fetched model that is not configured yet. */
        const addSelectedCandidates = () => withBusy(async () => {
          const current = draft
          if (current === null || current.discovery === null) return
          const known = new Set(current.models.map(model => model.id.trim()))
          const selected = new Set(current.discovery.selected)
          const entries = current.discovery.models.filter(model => selected.has(model.id) && !known.has(model.id))
          if (entries.length === 0) return fail('invalid-request', t('form.needSelection'))
          await addModelDrafts(entries)
        })
        /** Add one fetched model with a single click. */
        const addCandidate = id => withBusy(async () => {
          const current = draft
          if (current === null || current.discovery === null) return
          const entry = current.discovery.models.find(model => model.id === id)
          if (entry === undefined) return
          await addModelDrafts([entry])
        })
        /** Re-enrich one model on demand, regardless of the auto-match switch. */
        const matchModel = modelKey => withBusy(async () => {
          const current = draft
          if (current === null) return
          const model = current.models.find(item => item.key === modelKey)
          if (model === undefined) return
          const id = model.id.trim()
          if (id === '') return fail('invalid-model-id', t('form.invalidModelId'))
          const token = beginDraftOp()
          const request = { api: current.api, presetId: PRESET_ID_BY_API[current.api], models: [discoveryPayloadOf({ ...model, id })] }
          if (current.mode === 'edit') {
            request.provider = current.provider
            request.refresh = true
          }
          const result = await call('enrich', request)
          if (isStaleDraftOp(token)) return
          if (!result.ok) { patchView({ failure: result }); return }
          const resultModels = Array.isArray(result.value?.models) ? result.value.models : []
          const item = resultModels.find(entry => isPlainObject(entry) && entry.id === id)
          if (!isPlainObject(item?.profile)) return fail('invalid-response')
          setDraft(state => {
            if (state === null) return state
            return {
              ...state,
              models: state.models.map(entry => (entry.key === modelKey && entry.id.trim() === id
                ? applyMatchToModelDraft(entry, item, true) : entry)),
            }
          })
          patchView({ notice: modelMatchLabel(t, item.meta, true) ?? t('model.noMatch') })
        })
        /** Re-enrich every selected configured model in one batched call. */
        const matchSelectedModels = () => withBusy(async () => {
          const current = draft
          if (current === null) return
          const selectedSet = new Set(selectedKeysOf(current))
          const targets = current.models
            .filter(model => selectedSet.has(model.key))
            .map(model => ({ model, id: model.id.trim() }))
            .filter(item => item.id !== '')
          if (targets.length === 0) return fail('invalid-request', t('form.needSelection'))
          const token = beginDraftOp()
          const request = {
            api: current.api,
            presetId: PRESET_ID_BY_API[current.api],
            models: targets.map(item => discoveryPayloadOf({ ...item.model, id: item.id })),
          }
          if (current.mode === 'edit') {
            request.provider = current.provider
            request.refresh = true
          }
          const result = await call('enrich', request)
          if (isStaleDraftOp(token)) return
          if (!result.ok) { patchView({ failure: result }); return }
          const profiles = new Map()
          const resultModels = Array.isArray(result.value?.models) ? result.value.models : []
          for (const item of resultModels) {
            if (isPlainObject(item) && typeof item.id === 'string' && isPlainObject(item.profile)) profiles.set(item.id, item)
          }
          const matchedByKey = new Map()
          let failed = 0
          for (const item of targets) {
            const profile = profiles.get(item.id)
            if (profile === undefined) failed += 1
            else matchedByKey.set(item.model.key, profile)
          }
          setDraft(state => {
            if (state === null) return state
            return {
              ...state,
              models: state.models.map(entry => {
                const profile = matchedByKey.get(entry.key)
                return profile === undefined || entry.id.trim() !== profile.id ? entry : applyMatchToModelDraft(entry, profile, true)
              }),
            }
          })
          if (failed > 0) patchView({ notice: t('model.batchMatchPartial', { count: targets.length - failed, failed }) })
          else patchView({ notice: t('model.batchMatched', { count: targets.length }) })
        })
        /** Allow every selected edited model for subagent calls. */
        const allowSelectedSubagent = () => withBusy(async () => {
          const current = draft
          if (current === null || current.mode !== 'edit') return
          const selectedSet = new Set(selectedKeysOf(current))
          const ids = [...new Set(current.models
            .filter(model => selectedSet.has(model.key))
            .map(model => model.id.trim())
            .filter(id => id !== ''))]
          if (ids.length === 0) return fail('invalid-request', t('form.needSelection'))
          const result = await call('setDefaults', { provider: current.provider, addToSubagent: ids })
          if (!result.ok) { patchView({ failure: result }); return }
          patchView({ notice: t('model.batchSubagentSaved', { count: ids.length }) })
        })
        /** Point the agent default model (or allow subagent calls) at one edited model. */
        const saveModelSelection = (modelKey, kind) => withBusy(async () => {
          const current = draft
          if (current === null || current.mode !== 'edit') return
          const model = current.models.find(item => item.key === modelKey)
          if (model === undefined) return
          const id = model.id.trim()
          if (id === '') return fail('invalid-model-id', t('form.invalidModelId'))
          const result = await call('setDefaults', kind === 'default'
            ? { provider: current.provider, model: id }
            : { provider: current.provider, addToSubagent: [id] })
          if (!result.ok) { patchView({ failure: result }); return }
          patchView({ notice: kind === 'default' ? t('model.defaultSaved', { model: id }) : t('model.subagentSaved', { model: id }) })
        })
        /** Probe the typed endpoint and keep the verdict on the draft. */
        const runProbe = () => withBusy(async () => {
          const current = draft
          if (current === null) return
          const baseURL = current.baseURL.trim()
          if (baseURL === '') return fail('invalid-url', t('form.needURL'))
          let headers
          if (current.headersText.trim() !== '' && (current.mode === 'create' || current.headersText !== current.initialHeadersText)) {
            try { headers = parseHeadersLines(current.headersText) } catch (error) { return failDetail('invalid-headers', messageOfError(error)) }
          }
          const token = beginDraftOp()
          const request = { baseURL, api: current.api }
          if (current.mode === 'edit') request.provider = current.provider
          if (current.apiKey !== '') request.apiKey = current.apiKey
          if (current.mode === 'create' && current.apiKeyEnv.trim() !== '') request.apiKeyEnv = current.apiKeyEnv.trim()
          if (headers !== undefined) request.headers = headers
          const first = current.models.find(model => model.id.trim() !== '')
          if (first !== undefined) request.modelId = first.id.trim()
          const result = await call('probe', request)
          if (isStaleDraftOp(token)) return
          if (!result.ok) { patchView({ failure: result }); return }
          setDraft(state => (state === null ? state : { ...state, probe: result.value }))
        })
        /** Fill the compat draft with the probe's recommendations. */
        const applyRecommendedCompat = () => {
          setDraft(current => {
            if (current === null) return current
            const recommended = isPlainObject(current.probe?.recommendedCompat) ? current.probe.recommendedCompat : {}
            if (Object.keys(recommended).length === 0) return current
            return { ...current, compatDraft: { ...current.compatDraft, ...compatToDraft(recommended, current.api) } }
          })
          patchView({ notice: t('advanced.recommendApplied') })
        }
        /**
         * Convert the model drafts into the Host model-entry payload.
         * @param {object} current - the form draft.
         * @returns {object[]} the model entries.
         * @throws {Error} with a localized message when one entry is invalid.
         */
        const buildModelEntries = current => {
          const entries = []
          const seen = new Set()
          for (const model of current.models) {
            const id = String(model.id ?? '').trim()
            if (id === '') throw new Error(t('form.invalidModelId'))
            if (seen.has(id)) throw new Error(t('form.duplicateModelId', { id }))
            seen.add(id)
            const manualFields = model.manualFields ?? {}
            const entry = { id, manualFields }
            const keepPreview = current.autoMatch !== true && model.matchedInDraft === true
            const name = typeof model.name === 'string' ? model.name.trim() : ''
            if (manualFields.name) entry.name = name || null
            else if (keepPreview && name) entry.name = name
            for (const [field, label] of [['contextWindow', t('model.contextWindow')], ['maxTokens', t('model.maxTokens')]]) {
              const value = parseOptionalPositiveInteger(model[field])
              if (value === null) throw new Error(t('form.invalidNumber', { field: label }))
              if (manualFields[field]) entry[field] = value ?? null
              else if (keepPreview && value !== undefined) entry[field] = value
            }
            if (manualFields.input || keepPreview) entry.input = [...model.input]
            const efforts = buildReasoningEfforts(model, current.api)
            if (manualFields.reasoningEfforts) entry.reasoningEfforts = efforts ?? null
            else if (keepPreview && (model.reasoning || model.matchedNonReasoning)) entry.reasoningEfforts = efforts
            if (current.autoMatch === true && isPlainObject(model.discovered)) entry.discovered = model.discovered
            if (current.mode === 'edit' && current.autoMatch === true && model.matchedInDraft === true) entry.rematch = true
            entries.push(entry)
          }
          return entries
        }
        /** Persist the create/edit draft through one `upsertProvider` call. */
        const saveDraft = () => withBusy(async () => {
          const current = draft
          if (current === null) return
          const isEdit = current.mode === 'edit'
          const baseURL = trimTrailingHash(current.baseURL)
          if (baseURL === '' || !isHttpURL(baseURL)) return fail('invalid-url', t('form.needURL'))
          let models
          try {
            models = buildModelEntries(current)
          } catch (error) {
            return fail('invalid-model-profile', messageOfError(error))
          }
          if (models.length === 0) return fail('invalid-provider-profile', t('form.needModels'))
          let providerId = current.provider.trim()
          if (!isEdit) {
            // A user who never opened the advanced fold still gets a valid,
            // collision-free provider id derived from the name or the URL.
            if (current.providerDirty !== true || providerId === '') {
              providerId = deriveProviderIdFromDraft(current.displayName, baseURL, data.providers.map(provider => String(provider.provider)))
            }
            const verdict = checkProviderIdDraft(providerId)
            if (verdict.ok !== true) return fail('invalid-provider-id', t(verdict.key))
            if (data.providers.some(provider => String(provider.provider) === providerId)) return fail('invalid-provider-id', t('id.exists'))
          }
          let headers
          const headersChanged = current.headersText !== current.initialHeadersText
          if (headersChanged) {
            if (current.headersText.trim() === '') {
              // An emptied header block clears the editable headers; the Host
              // keeps the sensitive credential headers it never echoed.
              if (isEdit) headers = {}
            } else {
              try { headers = parseHeadersLines(current.headersText) } catch (error) { return failDetail('invalid-headers', messageOfError(error)) }
            }
          }
          const env = current.apiKeyEnv.trim()
          if (env !== '' && !CREDENTIAL_REF_PATTERN.test(env)) return fail('invalid-credential-ref')
          const compatPayload = buildCompatPayload(current.compatDraft, current.api)
          if (compatPayload.invalid.length > 0) return fail('invalid-request', t('advanced.compatInvalid', { fields: compatPayload.invalid.join(', ') }))
          const displayName = current.displayName.trim() !== ''
            ? current.displayName.trim()
            : (deriveDisplayNameFromUrl(baseURL) || providerId)
          const payload = {
            provider: providerId,
            displayName,
            baseURL,
            api: current.api,
            presetId: PRESET_ID_BY_API[current.api],
            models,
            autoEnrich: current.autoMatch === true,
          }
          if (current.apiKey !== '') payload.apiKey = current.apiKey
          if (env !== '') payload.apiKeyEnv = env
          if (headers !== undefined) payload.headers = headers
          if (Object.keys(compatPayload.compat).length > 0) payload.compat = compatPayload.compat
          else if (isEdit) payload.compat = null
          if (isEdit) {
            // A model removed here is declined: automatic sync must not add it
            // back. Ids that are configured again leave the ignored list.
            const keptIds = new Set(models.map(model => model.id))
            const ignored = [...new Set([...current.ignoredModels, ...current.originalModelIds])].filter(id => !keptIds.has(id))
            if (ignored.length > 0 || current.ignoredModels.length > 0) payload.syncPolicy = { ignoredModels: ignored }
          } else {
            if (current.setAsDefault === true) payload.setAsDefault = true
            if (current.enableSubagent === true) {
              payload.enableSubagent = true
              payload.addToSubagent = models.map(model => model.id)
            }
          }
          const result = await call('upsertProvider', payload)
          if (!result.ok) return failHost(result)
          pendingFocusRef.current = 'list-heading'
          setDraft(null)
          await refresh()
          patchView({
            notice: isEdit
              ? t('list.updated', { name: displayName })
              : t('list.created', { name: displayName, count: models.length }),
          })
        }, { saving: true })

        /* ----- render helpers ------------------------------------------------ */
        /** The live status region stays mounted (empty when quiet) so screen readers announce each notice. */
        const renderNotice = () => h('p', {
          className: 'xxa-notice xxa-live', role: 'status', 'aria-live': 'polite',
        }, view.notice)
        const renderFailure = () => (view.failure === null
          ? null
          : h('div', { className: 'xxa-error', role: 'alert' },
            h('strong', null, t('error.title')),
            h('span', null, failureText(t, view.failure)),
          ))
        const renderCompatControl = (name, current) => {
          const value = typeof current.compatDraft[name] === 'string' ? current.compatDraft[name] : ''
          if (BOOLEAN_COMPAT_FIELDS.has(name)) return select(value, option => { patchCompat(name, option) }, ['', 'true', 'false'], option => (option === '' ? t('advanced.compatDefault') : option))
          if (Object.hasOwn(ENUM_COMPAT_VALUES, name)) return select(value, option => { patchCompat(name, option) }, ['', ...ENUM_COMPAT_VALUES[name]], option => (option === '' ? t('advanced.compatDefault') : option))
          return input(value, option => { patchCompat(name, option) }, { mono: true, placeholder: OBJECT_COMPAT_FIELDS.has(name) ? '{}' : '' })
        }
        const renderEffortGrid = (current, model) => {
          const levels = current.api === 'google-generative-ai' ? GEMINI_THINKING_LEVELS : THINKING_LEVELS
          return h('div', { className: 'xxa-effortBox' },
            h('div', { className: 'xxa-effortGrid' },
              levels.map(level => {
                const checked = Object.hasOwn(model.efforts, level)
                const raw = checked ? model.efforts[level] : ''
                return h('div', { key: `effort-${level}-${model.key}`, className: `xxa-effortTile${checked ? ' xxa-effortTileOn' : ''}` },
                  h('label', { className: 'xxa-effortCheck' },
                    checkbox(checked, value => { setModelEffort(model.key, level, value) }, {
                      ariaLabel: `${t('model.reasoning')}: ${level}`,
                    }),
                    h('span', null, t(`editor.effort.${level}`)),
                    h('span', { className: 'xxa-effortKey' }, level),
                  ),
                  !checked ? null : input(raw === null ? '' : raw, value => { setModelEffortValue(model.key, level, value) }, {
                    mono: true,
                    placeholder: level === 'off' ? 'null' : level,
                    ariaLabel: `${t('model.effortMapping')}: ${level}`,
                  }),
                )
              }),
            ),
            h('p', { className: 'xxa-hint' }, t('model.reasoningHint')),
          )
        }
        const renderModelCard = (current, model) => {
          const expanded = current.expandedKeys.includes(model.key)
          const selected = selectedKeysOf(current).includes(model.key)
          const isEdit = current.mode === 'edit'
          const chips = capabilityChips(t, modelDraftProfile(model, current.api), `model-${model.key}`)
          const matchLabel = modelMatchLabel(t, model.match, true)
          const hasText = model.input.includes('text')
          const hasImage = model.input.includes('image')
          return h('li', {
            className: `xxa-modelCard${selected ? ' xxa-modelCardSelected' : ''}${expanded ? ' xxa-modelCardOpen' : ''}`,
            key: model.key,
          },
            h('div', { className: 'xxa-modelCardHead' },
              h('label', { className: 'xxa-candidateCheck' },
                checkbox(selected, () => { toggleModelSelected(model.key) }, {
                  ariaLabel: t('model.selectOne', { id: model.id === '' ? model.key : model.id }),
                }),
              ),
              h('div', { className: 'xxa-modelCardMain' },
                h('span', { className: 'xxa-modelId' }, model.id === '' ? t('model.id') : model.id),
                model.name !== '' && model.name !== model.id ? h('span', { className: 'xxa-modelName' }, model.name) : null,
                chips,
                matchLabel === null ? null : h('span', { className: 'xxa-hint' }, matchLabel),
              ),
              h('div', { className: 'xxa-actions xxa-modelActions' },
                button([expanded ? t('model.collapse') : t('model.settings'), iconChevron(expanded)], () => { toggleModelExpanded(model.key) }, {
                  small: true, ariaExpanded: expanded,
                }),
                button(t('model.remove'), () => { removeModel(model.key) }, { small: true, danger: true }),
              ),
            ),
            !expanded ? null : h('div', { className: 'xxa-modelCardBody' },
              h('div', { className: 'xxa-gridTwo' },
                field(t('model.id'), input(model.id, value => { changeModelId(model.key, value) }, {
                  mono: true, placeholder: 'model-id', ariaLabel: t('model.id'),
                })),
                field(t('model.name'), input(model.name, value => { patchModel(model.key, { name: value }, 'name') }, {
                  placeholder: t('model.namePlaceholder'), ariaLabel: t('model.name'),
                })),
                field(t('model.contextWindow'),
                  h('div', { className: 'xxa-subSection' },
                    input(model.contextWindow, value => { patchModel(model.key, { contextWindow: value }, 'contextWindow') }, { numeric: true, ariaLabel: t('model.contextWindow') }),
                    h('div', { className: 'xxa-chipGroup' },
                      CONTEXT_WINDOW_PRESETS.map(preset => button(preset.label, () => { patchModel(model.key, { contextWindow: String(preset.value) }, 'contextWindow') }, {
                        chip: true, active: model.contextWindow.trim() === String(preset.value), key: `context-${preset.value}`, title: t('model.contextWindow'),
                      })),
                    ),
                  )),
                field(t('model.maxTokens'),
                  h('div', { className: 'xxa-subSection' },
                    input(model.maxTokens, value => { patchModel(model.key, { maxTokens: value }, 'maxTokens') }, { numeric: true, ariaLabel: t('model.maxTokens') }),
                    h('div', { className: 'xxa-chipGroup' },
                      MAX_TOKENS_PRESETS.map(preset => button(preset.label, () => { patchModel(model.key, { maxTokens: String(preset.value) }, 'maxTokens') }, {
                        chip: true, active: model.maxTokens.trim() === String(preset.value), key: `max-${preset.value}`, title: t('model.maxTokens'),
                      })),
                    ),
                  )),
              ),
              h('div', { className: 'xxa-capBar' },
                h('div', { className: 'xxa-capGroup' },
                  h('span', { className: 'xxa-label' }, t('model.input')),
                  h('button', {
                    type: 'button',
                    className: `xxa-pillToggle${hasText ? ' xxa-pillToggleOn' : ''}`,
                    'aria-pressed': hasText,
                    onClick: () => { setModelModality(model.key, 'text', !hasText) },
                  }, t('model.text')),
                  h('button', {
                    type: 'button',
                    className: `xxa-pillToggle${hasImage ? ' xxa-pillToggleOn' : ''}`,
                    'aria-pressed': hasImage,
                    onClick: () => { setModelModality(model.key, 'image', !hasImage) },
                  }, t('model.image')),
                ),
                h('div', { className: 'xxa-capGroup' },
                  switchRow(t('model.reasoning'), model.reasoning === true, value => { toggleModelReasoning(model.key, value) }, 'reasoning-switch'),
                ),
              ),
              model.reasoning !== true ? null : renderEffortGrid(current, model),
              h('div', { className: 'xxa-modelFoot' },
                button(t('model.match'), () => { void matchModel(model.key) }, { small: true, disabled: view.busy }),
                !isEdit ? null : h('div', { className: 'xxa-actions' },
                  button(t('model.setDefault'), () => { void saveModelSelection(model.key, 'default') }, { small: true, disabled: view.busy }),
                  button(t('model.allowSubagent'), () => { void saveModelSelection(model.key, 'subagent') }, { small: true, disabled: view.busy }),
                ),
              ),
            ),
          )
        }
        /** Render the fetched-model selection panel. */
        const renderDiscovery = current => {
          const discovery = current.discovery
          if (discovery === null) return null
          const configuredIds = new Set(current.models.map(model => model.id.trim()))
          const addedCount = discovery.models.filter(model => configuredIds.has(model.id)).length
          const query = discovery.search.trim().toLowerCase()
          const visible = discovery.models.filter(model => query === '' || model.id.toLowerCase().includes(query))
          const selectable = new Set(discovery.models.filter(model => !configuredIds.has(model.id)).map(model => model.id))
          const selectedCount = discovery.selected.filter(id => selectable.has(id)).length
          return h('div', { className: 'xxa-discovery' },
            h('div', { className: 'xxa-discoveryHead' },
              h('div', { className: 'xxa-discoveryTitleRow' },
                h('h4', { className: 'xxa-discoveryTitle' }, t('form.discoveryTitle')),
                badge(t('form.discoveryCount', { total: discovery.models.length, added: addedCount })),
              ),
              h('div', { className: 'xxa-actions' },
                button(discovery.open ? t('form.discoveryCollapse') : t('form.discoveryExpand'), () => { patchDiscovery({ open: discovery.open !== true }) }, {
                  small: true, ariaExpanded: discovery.open,
                }),
                button(t('form.discoveryClose'), closeDiscovery, { small: true }),
              ),
            ),
            discovery.open !== true ? null : h('div', { className: 'xxa-discoveryBody' },
              h('div', { className: 'xxa-discoveryToolbar' },
                input(discovery.search, value => { patchDiscovery({ search: value }) }, {
                  small: true, placeholder: t('form.discoverySearch'), ariaLabel: t('form.discoverySearch'),
                }),
                h('div', { className: 'xxa-actions' },
                  button(t('form.discoverySelectAll'), selectAllCandidates, { small: true }),
                  button(t('form.discoveryClear'), clearCandidateSelection, { small: true }),
                  button(t('form.discoveryAddSelected', { count: selectedCount }), () => { void addSelectedCandidates() }, {
                    small: true, accent: true, disabled: view.busy || selectedCount === 0,
                  }),
                ),
              ),
              visible.length === 0
                ? h('p', { className: 'xxa-hint' }, t('form.discoveryEmpty'))
                : h('ul', { className: 'xxa-candidateList' }, visible.map(model => {
                  const added = configuredIds.has(model.id)
                  const selected = !added && discovery.selected.includes(model.id)
                  const effortLevels = model.reasoning === true && Array.isArray(model.efforts) && model.efforts.length > 0
                    ? Object.fromEntries(model.efforts.filter(level => typeof level === 'string').map(level => [level, level === 'off' ? null : level]))
                    : null
                  const preview = {
                    contextWindow: model.contextWindow,
                    maxTokens: model.maxTokens,
                    input: model.input,
                    reasoningEfforts: effortLevels,
                  }
                  return h('li', {
                    key: `candidate-${model.id}`,
                    className: `xxa-candidate${added ? ' xxa-candidateAdded' : ''}`,
                  },
                    h('label', { className: 'xxa-candidateCheck' },
                      checkbox(selected, () => { toggleDiscoveryCandidate(model.id) }, {
                        disabled: added, ariaLabel: model.id,
                      }),
                    ),
                    h('div', { className: 'xxa-candidateMain' },
                      h('span', { className: 'xxa-modelId' }, model.id),
                      capabilityChips(t, preview, `candidate-${model.id}`),
                    ),
                    added
                      ? badge(t('form.discoveryAdded'), 'Success', `added-${model.id}`)
                      : button(t('form.discoveryAdd'), () => { void addCandidate(model.id) }, { small: true, disabled: view.busy }),
                  )
                })),
            ),
          )
        }
        /** Render the connection card. */
        const renderConnection = current => {
          const isEdit = current.mode === 'edit'
          return h('section', { className: 'xxa-card' },
            h('div', { className: 'xxa-cardHead' },
              h('h3', { className: 'xxa-cardTitle' }, t('form.connection')),
            ),
            h('div', { className: 'xxa-gridConn' },
              field(t('form.name'), input(current.displayName, onNameChange, {
                placeholder: t('form.namePlaceholder'), ariaLabel: t('form.name'),
              })),
              field(t('form.apiKey'), h('span', { className: 'xxa-secretBox' },
                h('input', {
                  className: 'xxa-input',
                  type: current.showKey === true ? 'text' : 'password',
                  value: current.apiKey,
                  placeholder: isEdit ? t('form.apiKeyHintEdit') : 'sk-...',
                  autoComplete: 'new-password',
                  onChange: event => { onApiKeyChange(event.target.value) },
                }),
                current.apiKey === '' ? null : h('button', {
                  type: 'button',
                  className: 'xxa-keyToggle',
                  'aria-label': current.showKey === true ? t('field.hide') : t('field.show'),
                  title: current.showKey === true ? t('field.hide') : t('field.show'),
                  onClick: onToggleKeyVisible,
                }, iconEye(current.showKey === true)),
              ), isEdit ? t('form.apiKeyHintEdit') : undefined),
              field(t('form.baseURL'), input(current.baseURL, onBaseURLChange, {
                placeholder: t('form.baseURLPlaceholder'), ariaLabel: t('form.baseURL'),
              }), undefined, { wide: true, inlineHint: t('form.baseURLHint') }),
              h('div', { className: 'xxa-field xxa-fieldWide' },
                h('span', { className: 'xxa-label' }, t('form.api')),
                h('div', { className: 'xxa-protoGrid', role: 'radiogroup', 'aria-label': t('form.api') },
                  SUPPORTED_PROTOCOLS.map(protocol => {
                    const active = current.api === protocol
                    return h('button', {
                      key: `proto-${protocol}`,
                      type: 'button',
                      role: 'radio',
                      'aria-checked': active,
                      className: `xxa-protoBtn${active ? ' xxa-protoBtnActive' : ''}`,
                      onClick: () => { onApiChange(protocol) },
                    }, protocolGlyph(protocol, 14), h('span', null, vocabularyText(t, 'protocol', protocol)))
                  }),
                ),
              ),
            ),
            h('div', { className: 'xxa-switchRow' },
              h('div', { className: 'xxa-switchMeta' },
                h('span', { className: 'xxa-switchTitle' }, t('form.autoMatch')),
                h('span', { className: 'xxa-hint' }, t('form.autoMatchHint')),
              ),
              switchControl(t('form.autoMatch'), current.autoMatch === true, onAutoMatchChange),
            ),
          )
        }
        /** Render the model management card. */
        const renderModels = current => {
          const isEdit = current.mode === 'edit'
          const query = current.modelSearch.trim().toLowerCase()
          const visible = current.models.filter(model => query === '' || model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query))
          const validKeys = new Set(current.models.map(model => model.key))
          const selectedKeys = selectedKeysOf(current).filter(key => validKeys.has(key))
          const selectedSet = new Set(selectedKeys)
          const selectedCount = selectedKeys.length
          const visibleKeys = visible.map(model => model.key)
          const visibleSelectedCount = visibleKeys.filter(key => selectedSet.has(key)).length
          const allVisibleSelected = visibleKeys.length > 0 && visibleSelectedCount === visibleKeys.length
          const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected
          return h('section', { className: 'xxa-card' },
            h('div', { className: 'xxa-cardHead' },
              h('h3', { className: 'xxa-cardTitle' }, t('form.models')),
              badge(t('list.models', { count: current.models.length })),
            ),
            h('div', { className: 'xxa-addBar' },
              h('div', { className: 'xxa-addInputWrap' },
                input(current.manualModelInput, value => { setDraft(state => (state === null ? state : { ...state, manualModelInput: value })) }, {
                  placeholder: t('form.manualPlaceholder'),
                  ariaLabel: t('form.manualPlaceholder'),
                  onEnter: () => { void addManualModels() },
                }),
                button(t('form.manualAdd'), () => { void addManualModels() }, { disabled: view.busy }),
              ),
              button([iconCloud(), t('form.fetch')], () => { void fetchModels() }, { accent: true, disabled: view.busy }),
            ),
            renderDiscovery(current),
            current.models.length === 0 ? null : h('div', { className: 'xxa-listHead' },
              h('div', { className: 'xxa-listHeadLeft' },
                h('label', { className: 'xxa-check' },
                  checkbox(allVisibleSelected, () => { toggleSelectAllVisibleModels(visibleKeys) }, {
                    indeterminate: someVisibleSelected,
                    disabled: visibleKeys.length === 0,
                    ariaLabel: t('model.selectAll'),
                  }),
                  h('span', null, t('model.title', { count: current.models.length })),
                ),
                selectedCount === 0 ? null : h('span', { className: 'xxa-batchBar' },
                  h('span', { className: 'xxa-bulkHint' }, t('model.selectedCount', { count: selectedCount })),
                  button(t('model.clearSelection'), clearSelectedModels, { small: true }),
                  button(t('model.batchMatch', { count: selectedCount }), () => { void matchSelectedModels() }, { small: true, disabled: view.busy }),
                  isEdit ? button(t('model.batchSubagent', { count: selectedCount }), () => { void allowSelectedSubagent() }, { small: true, disabled: view.busy }) : null,
                  button(t('model.batchRemove', { count: selectedCount }), removeSelectedModels, { small: true, danger: true, disabled: view.busy }),
                ),
              ),
              current.models.length < SEARCH_MIN_MODELS ? null : input(current.modelSearch, value => { setDraft(state => (state === null ? state : { ...state, modelSearch: value })) }, {
                small: true, placeholder: t('model.search'), ariaLabel: t('model.search'), width: '190px',
              }),
            ),
            current.models.length === 0
              ? h('div', { className: 'xxa-empty' },
                h('p', { className: 'xxa-emptyTitle' }, t('model.emptyTitle')),
                h('p', { className: 'xxa-emptyHint' }, t('model.emptyHint')),
              )
              : visible.length === 0
                ? h('p', { className: 'xxa-hint' }, t('form.discoveryEmpty'))
                : h('ul', { className: 'xxa-modelList' }, visible.map(model => renderModelCard(current, model))),
          )
        }
        /** Render the collapsed advanced settings. */
        const renderAdvanced = current => {
          const isEdit = current.mode === 'edit'
          const offered = Array.isArray(COMPAT_FIELDS_BY_API[current.api]) ? COMPAT_FIELDS_BY_API[current.api] : []
          const compatCount = countCompatOverrides(current.compatDraft)
          const probe = isPlainObject(current.probe) ? current.probe : null
          const recommended = probe !== null && isPlainObject(probe.recommendedCompat) ? probe.recommendedCompat : {}
          const probeChecks = probe !== null && isPlainObject(probe.checks) ? Object.entries(probe.checks) : []
          const verdict = checkProviderIdDraft(current.provider)
          const providerConflict = verdict.ok === true && data.providers.some(provider => String(provider.provider) === current.provider)
          const providerHint = verdict.ok !== true ? t(verdict.key) : providerConflict ? t('id.exists') : t('id.available')
          return h('details', { className: 'xxa-fold' },
            h('summary', { className: 'xxa-foldSummary' },
              h('span', { className: 'xxa-foldTitle' }, t('advanced.title')),
              compatCount === 0 ? null : badge(t('advanced.compatActive', { count: compatCount }), 'Accent'),
            ),
            h('div', { className: 'xxa-foldBody' },
              h('p', { className: 'xxa-hint' }, t('advanced.hint')),
              isEdit
                ? h('div', { className: 'xxa-field' },
                  h('span', { className: 'xxa-label' }, t('advanced.provider')),
                  h('span', { className: 'xxa-mono' }, current.provider),
                  h('span', { className: 'xxa-hint' }, t('advanced.providerReadonly')),
                )
                : field(t('advanced.provider'), input(current.provider, onProviderChange, {
                  mono: true, ariaLabel: t('advanced.provider'), placeholder: PROVIDER_ID_FALLBACK,
                }), `${t('advanced.providerHint')} · ${providerHint}`),
              field(t('advanced.apiKeyEnv'), input(current.apiKeyEnv, onApiKeyEnvChange, {
                mono: true, ariaLabel: t('advanced.apiKeyEnv'),
              }), isEdit ? t('advanced.apiKeyEnvKeep') : t('advanced.apiKeyEnvHint'), { wide: true }),
              field(t('advanced.headers'), textarea(current.headersText, onHeadersChange, {
                placeholder: 'X-Custom: value', ariaLabel: t('advanced.headers'),
              }), t('advanced.headersHint'), { wide: true }),
              h('div', { className: 'xxa-subSection xxa-subSectionDivider' },
                h('h3', { className: 'xxa-subTitle' }, t('advanced.compat')),
                offered.length === 0
                  ? h('p', { className: 'xxa-hint' }, t('advanced.compatNone'))
                  : h('div', { className: 'xxa-grid' }, offered.map(name => field(h('span', { className: 'xxa-mono' }, name), renderCompatControl(name, current), undefined, {
                    key: `compat-${name}`,
                  }))),
                h('p', { className: 'xxa-hint' }, t('advanced.compatHint')),
              ),
              h('div', { className: 'xxa-subSection xxa-subSectionDivider' },
                h('h3', { className: 'xxa-subTitle' }, t('advanced.probe')),
                h('div', { className: 'xxa-actions' },
                  button(t('advanced.probeRun'), () => { void runProbe() }, { small: true, disabled: view.busy }),
                  probe === null ? null : badge(probe.healthy === true ? t('advanced.probeHealthy') : t('advanced.probeUnhealthy'), probe.healthy === true ? 'Success' : 'Error'),
                  probe === null || Object.keys(recommended).length === 0
                    ? null
                    : button(t('advanced.applyRecommended'), applyRecommendedCompat, { small: true, accent: true, disabled: view.busy }),
                ),
                probe === null ? null : h('p', { className: 'xxa-hint' }, Object.keys(recommended).length === 0
                  ? t('advanced.probeNoRecommend')
                  : t('advanced.probeRecommend', { fields: formatCompatFields(recommended) })),
                probeChecks.length === 0 ? null : h('div', { className: 'xxa-checkStrip' }, probeChecks.map(([check, result]) => {
                  const checkVerdict = describeProbeCheck(result)
                  return h('span', { key: `probe-${check}`, className: probeCheckClass(checkVerdict) }, `${vocabularyText(t, 'probe.check', check)}: ${t(`probe.${checkVerdict}`)}`)
                })),
              ),
              isEdit ? null : h('div', { className: 'xxa-checks' },
                checkRow(t('advanced.setDefault'), current.setAsDefault === true, onSetAsDefaultChange, 'set-default'),
                checkRow(t('advanced.allowSubagent'), current.enableSubagent === true, onEnableSubagentChange, 'enable-subagent'),
              ),
            ),
          )
        }
        /** Render one provider row of the list. */
        const renderProviderRow = provider => {
          const providerId = String(provider.provider)
          const displayName = providerName(provider)
          const modelCount = typeof provider.modelCount === 'number' ? provider.modelCount : (Array.isArray(provider.models) ? provider.models.length : 0)
          const keyMissing = providerKeyMissing(provider)
          const confirming = removeTarget !== null && removeTarget.provider === providerId
          const host = typeof provider.baseURL === 'string' && provider.baseURL !== '' ? endpointHost(provider.baseURL) : ''
          const showHost = host !== '' && host.toLowerCase() !== displayName.trim().toLowerCase()
          return h('li', { key: `provider-${providerId}`, className: 'xxa-rowGroup' },
            h('div', { className: 'xxa-providerRow' },
              protocolMark(provider.api),
              h('div', {
                className: 'xxa-providerMain xxa-providerMainClickable',
                onClick: () => { if (!view.busy) openEdit(provider) },
              },
                h('div', { className: 'xxa-providerTitle' },
                  h('span', { className: 'xxa-name', title: displayName }, displayName),
                  keyMissing ? statusLabel(t('list.missingKey'), 'Error', `status-${providerId}`) : null,
                ),
                h('div', { className: 'xxa-metaLine' },
                  badge(vocabularyText(t, 'protocol', provider.api), 'Accent', `proto-${providerId}`),
                  !showHost ? null : h('span', { className: 'xxa-endpoint', title: provider.baseURL }, host),
                  badge(t('list.models', { count: modelCount }), undefined, `models-${providerId}`),
                ),
              ),
              h('div', { className: 'xxa-providerActions' },
                button(t('list.edit'), () => { openEdit(provider) }, { small: true, disabled: view.busy }),
                button(t('list.delete'), () => { requestRemove(provider) }, {
                  small: true, danger: true, disabled: view.busy, ref: focusWhenPending(`delete-${providerId}`),
                }),
              ),
            ),
            !confirming ? null : h('div', {
              className: 'xxa-confirm',
              role: 'group',
              'aria-label': t('list.deleteTitle', { name: displayName }),
              onKeyDown: event => {
                if (event.key !== 'Escape' || view.busy) return
                event.preventDefault()
                cancelRemove()
              },
            },
              h('div', { className: 'xxa-confirmText' },
                h('strong', null, t('list.deleteTitle', { name: displayName })),
                h('span', { className: 'xxa-hint' }, t('list.deleteHint')),
              ),
              h('div', { className: 'xxa-confirmActions' },
                checkRow(t('list.deleteCredential'), removeTarget.removeCredential === true, value => {
                  setRemoveTarget(current => (current === null ? current : { ...current, removeCredential: value === true }))
                }, 'remove-credential'),
                button(t('common.cancel'), cancelRemove, { small: true, disabled: view.busy, ref: focusWhenPending('confirm-cancel') }),
                button(t('list.deleteConfirm'), () => { void confirmRemove() }, { small: true, primary: true, danger: true, disabled: view.busy }),
              ),
            ),
          )
        }
        /** Collect unmatched and manually-bound models across every configured provider. */
        const collectBindingRows = providers => {
          const rows = []
          for (const provider of Array.isArray(providers) ? providers : []) {
            const providerId = String(provider.provider ?? '')
            if (providerId === '') continue
            const displayName = providerName(provider)
            const modelsById = new Map(
              (Array.isArray(provider.models) ? provider.models : [])
                .filter(model => isPlainObject(model) && typeof model.id === 'string')
                .map(model => [model.id, model]),
            )
            const bindings = isPlainObject(provider.upstreamBindings) ? provider.upstreamBindings : {}
            const unmatchedSet = new Set(
              Array.isArray(provider.unmatchedModels)
                ? provider.unmatchedModels.filter(id => typeof id === 'string' && id !== '')
                : [],
            )
            if (unmatchedSet.size === 0 && Array.isArray(provider.audit?.issues)) {
              for (const issue of provider.audit.issues) {
                if (issue?.code === 'unknown-model' && typeof issue.modelId === 'string' && issue.modelId !== '') {
                  unmatchedSet.add(issue.modelId)
                }
              }
            }
            const seen = new Set()
            const pushRow = modelId => {
              if (!modelId || seen.has(modelId)) return
              seen.add(modelId)
              const binding = isPlainObject(bindings[modelId]) ? bindings[modelId] : null
              rows.push({
                key: `${providerId}::${modelId}`,
                provider: providerId,
                providerName: displayName,
                modelId,
                model: modelsById.get(modelId) ?? { id: modelId },
                unmatched: unmatchedSet.has(modelId),
                upstreamModel: binding !== null && typeof binding.upstreamModel === 'string' && binding.upstreamModel !== '' ? binding.upstreamModel : null,
                bindingMatched: binding !== null ? binding.matched !== false : false,
              })
            }
            for (const modelId of unmatchedSet) pushRow(modelId)
            for (const modelId of Object.keys(bindings)) pushRow(modelId)
          }
          return rows
        }
        /** Render the collapsed-by-default level-one advanced settings fold. */
        const renderListAdvanced = providers => {
          const bindingRows = collectBindingRows(providers)
          const unmatchedCount = bindingRows.filter(row => row.unmatched === true).length
          const boundCount = bindingRows.filter(row => row.upstreamModel !== null).length
          const registry = isPlainObject(advanced.registry) ? advanced.registry : null
          const registryCount = registry !== null && typeof registry.modelCount === 'number' ? registry.modelCount : 0
          const registryState = registry === null || !registry.checkedAt
            ? t('listAdvanced.registryStateNever')
            : registry.stale === true
              ? t('listAdvanced.registryStateStale')
              : t('listAdvanced.registryStateFresh')
          const offlineOnly = registry?.settings?.offlineOnly === true || registry?.offlineOnly === true
          const editing = isPlainObject(advanced.editingTarget) ? advanced.editingTarget : null
          const catalogModels = Array.isArray(advanced.catalogModels) ? advanced.catalogModels : []
          const catalogTotal = typeof advanced.catalogTotal === 'number' ? advanced.catalogTotal : 0
          return h('details', {
            className: 'xxa-fold',
            open: advanced.open === true ? true : undefined,
            onToggle: event => { onToggleListAdvanced(event.target?.open === true) },
          },
            h('summary', { className: 'xxa-foldSummary' },
              h('span', { className: 'xxa-foldTitle' }, t('listAdvanced.title')),
              h('span', { className: 'xxa-actions' },
                unmatchedCount > 0 ? badge(t('listAdvanced.unmatchedBadge', { count: unmatchedCount }), 'Warn', 'adv-unmatched') : null,
                boundCount > 0 ? badge(t('listAdvanced.boundBadge', { count: boundCount }), 'Accent', 'adv-bound') : null,
              ),
            ),
            h('div', { className: 'xxa-foldBody' },
              advanced.catalogError === null
                ? null
                : h('div', { className: 'xxa-error xxa-errorInline', role: 'alert' },
                  h('span', null, t('listAdvanced.catalogFailed', { reason: failureText(t, advanced.catalogError) })),
                  button(t('listAdvanced.catalogRetry'), () => {
                    void loadCatalog(editing === null ? '' : advanced.catalogQuery)
                  }, { small: true, disabled: view.busy || advanced.catalogLoading === true }),
                ),
              h('div', { className: 'xxa-subSection' },
                h('h3', { className: 'xxa-subTitle' }, t('listAdvanced.bindingsTitle')),
                h('p', { className: 'xxa-hint' }, t('listAdvanced.bindingsHint')),
                bindingRows.length === 0
                  ? h('p', { className: 'xxa-hint' }, t('listAdvanced.bindingsEmpty'))
                  : h('ul', { className: 'xxa-bindList' }, bindingRows.map(row => {
                    const isEditing = editing !== null && editing.provider === row.provider && editing.modelId === row.modelId
                    return h('li', { key: `bind-${row.key}`, className: 'xxa-bindItem' },
                      h('div', { className: 'xxa-bindRow' },
                        h('div', { className: 'xxa-bindMain' },
                          h('span', { className: 'xxa-modelId' }, row.modelId),
                          badge(row.providerName, undefined, `bind-prov-${row.key}`),
                          row.upstreamModel !== null
                            ? badge(
                              row.bindingMatched ? t('listAdvanced.boundTo', { target: row.upstreamModel }) : t('listAdvanced.boundUnmatched', { target: row.upstreamModel }),
                              row.bindingMatched ? 'Accent' : 'Warn',
                              `bind-state-${row.key}`,
                            )
                            : badge(modelMatchLabel(t, row.model.match) ?? t('listAdvanced.unmatched'), 'Warn', `bind-state-${row.key}`),
                          row.upstreamModel !== null && !row.bindingMatched
                            ? h('span', { className: 'xxa-hint' }, modelMatchLabel(t, row.model.match)) : null,
                          capabilityChips(t, row.model, `bind-cap-${row.key}`),
                        ),
                        h('div', { className: 'xxa-actions' },
                          button(row.upstreamModel !== null ? t('listAdvanced.rebind') : t('listAdvanced.bind'), () => {
                            if (isEditing) closeBindTarget()
                            else {
                              const ambiguous = row.model.match?.ambiguousModelIds?.length > 0
                              const currentUpstream = row.upstreamModel ?? ''
                              const query = currentUpstream || (ambiguous ? row.modelId : '')
                              openBindTarget(row.provider, row.modelId, ambiguous ? '' : currentUpstream, query)
                            }
                          }, { small: true, disabled: view.busy }),
                          row.upstreamModel === null ? null : button(t('listAdvanced.unbind'), () => {
                            void unbindUpstreamModel(row.provider, row.modelId)
                          }, { small: true, danger: true, disabled: view.busy }),
                        ),
                      ),
                      !isEditing ? null : h('div', { className: 'xxa-bindEditor' },
                        h('div', { className: 'xxa-bindInputRow' },
                          input(advanced.upstreamInput, onUpstreamInputChange, {
                            small: true,
                            mono: true,
                            placeholder: t('listAdvanced.targetPlaceholder'),
                            ariaLabel: t('listAdvanced.targetPlaceholder'),
                            onEnter: () => { void bindUpstreamModel(row.provider, row.modelId, advanced.upstreamInput) },
                          }),
                          button(t('listAdvanced.bindConfirm'), () => {
                            void bindUpstreamModel(row.provider, row.modelId, advanced.upstreamInput)
                          }, { small: true, primary: true, disabled: view.busy || advanced.upstreamInput.trim() === '' }),
                          button(t('common.cancel'), closeBindTarget, { small: true, disabled: view.busy }),
                        ),
                        advanced.catalogLoading === true
                          ? h('p', { className: 'xxa-hint' }, t('listAdvanced.catalogLoading'))
                          : advanced.catalogError !== null
                            ? null
                            : catalogModels.length === 0
                              ? h('p', { className: 'xxa-hint' }, t('listAdvanced.catalogEmpty'))
                              : [
                              catalogTotal > 0 ? h('p', { key: 'catalog-count', className: 'xxa-hint' }, t('listAdvanced.catalogCount', { shown: catalogModels.length, total: catalogTotal })) : null,
                              h('ul', { key: 'catalog-list', className: 'xxa-bindPicker' }, catalogModels.map(candidate => {
                                const preview = {
                                  contextWindow: candidate.contextWindow,
                                  maxTokens: candidate.maxTokens,
                                  input: candidate.input,
                                  reasoningEfforts: candidate.reasoning === true ? { medium: 'medium' } : false,
                                }
                                return h('li', { key: `upstream-${candidate.id}`, className: 'xxa-bindOption' },
                                  h('div', { className: 'xxa-bindOptionMain' },
                                    h('span', { className: 'xxa-modelId' }, candidate.id),
                                    candidate.name && candidate.name !== candidate.id ? h('span', { className: 'xxa-modelName' }, candidate.name) : null,
                                    capabilityChips(t, preview, `upstream-cap-${candidate.id}`),
                                  ),
                                  button(t('listAdvanced.bindPick'), () => {
                                    void bindUpstreamModel(row.provider, row.modelId, candidate.id)
                                  }, { small: true, disabled: view.busy }),
                                )
                              })),
                            ],
                      ),
                    )
                  })),
              ),
              h('div', { className: 'xxa-subSection xxa-subSectionDivider' },
                h('h3', { className: 'xxa-subTitle' }, t('listAdvanced.registryTitle')),
                h('div', { className: 'xxa-ioRow' },
                  h('span', { className: 'xxa-hint' }, t('listAdvanced.registrySummary', { count: registryCount, state: registryState })),
                  button(t('listAdvanced.registryRefresh'), () => { void runRefreshRegistry() }, { small: true, disabled: view.busy || offlineOnly || registry === null || advanced.catalogLoading === true }),
                ),
                checkRow(t('listAdvanced.registryOffline'), offlineOnly, value => { void toggleOfflineOnly(value === true) }, 'registry-offline', { disabled: view.busy || registry === null || advanced.catalogLoading === true }),
              ),
              h('div', { className: 'xxa-subSection xxa-subSectionDivider' },
                h('h3', { className: 'xxa-subTitle' }, t('listAdvanced.ioTitle')),
                h('p', { className: 'xxa-hint' }, t('listAdvanced.importHint')),
                h('div', { className: 'xxa-ioRow' },
                  select(advanced.importFormat, value => { patchAdvanced({ importFormat: value }) }, IMPORT_FORMATS, value => vocabularyText(t, 'importFormat', value), {
                    width: '180px', ariaLabel: t('listAdvanced.importFormat'),
                  }),
                  h('div', { className: 'xxa-actions' },
                    button(t('listAdvanced.importButton'), () => { void runImportConfig() }, { small: true, disabled: view.busy }),
                    button(t('listAdvanced.exportButton'), () => { void runExportConfig() }, { small: true, disabled: view.busy }),
                  ),
                ),
                textarea(advanced.importText, value => { patchAdvanced({ importText: value }) }, {
                  placeholder: t('listAdvanced.importPlaceholder'),
                  ariaLabel: t('listAdvanced.importPlaceholder'),
                }),
                advanced.exportText === '' ? null : h('div', { className: 'xxa-subSection' },
                  textarea(advanced.exportText, () => {}, { readOnly: true, ariaLabel: t('listAdvanced.exportButton') }),
                  h('div', { className: 'xxa-actions xxa-actionsEnd' },
                    button(t('listAdvanced.exportClear'), () => { patchAdvanced({ exportText: '' }) }, { small: true }),
                  ),
                ),
              ),
            ),
          )
        }
        /** Render the level-one provider list. */
        const renderList = () => {
          const providers = data.providers
          // A search earns its place only once the list is long enough to scan.
          const searchVisible = providers.length >= SEARCH_MIN_PROVIDERS
          const activeSearch = searchVisible ? filter.search.trim().toLowerCase() : ''
          const filteredProviders = activeSearch === '' ? providers : providers.filter(provider => {
            const haystack = `${provider.provider ?? ''} ${provider.displayName ?? ''} ${provider.baseURL ?? ''}`.toLowerCase()
            return haystack.includes(activeSearch)
          })
          return h('div', { className: 'xxa-page' },
            h('header', { className: 'xxa-head' },
              h('div', { className: 'xxa-headMain' },
                h('h2', { className: 'xxa-heading', tabIndex: -1, ref: focusWhenPending('list-heading') }, t('title')),
                h('p', { className: 'xxa-intro' }, t('subtitle')),
              ),
            ),
            renderNotice(),
            renderFailure(),
            data.available === false ? h('p', { className: 'xxa-warn', role: 'status' }, t('list.unavailable')) : null,
            h('div', { className: 'xxa-listBar' },
              button(t('list.connect'), openCreate, { primary: true, disabled: view.busy }),
              h('div', { className: 'xxa-listBarTools' },
                !searchVisible ? null : input(filter.search, value => { setFilter({ search: value }) }, {
                  small: true, placeholder: t('list.search'), ariaLabel: t('list.search'), width: '220px',
                }),
                !searchVisible || activeSearch === '' ? null : button(t('list.clear'), () => { setFilter({ search: '' }) }, { small: true }),
                button([iconRefresh(), t('header.refresh')], () => { patchView({ busy: true }); void reload() }, { small: true, disabled: view.busy }),
              ),
            ),
            providers.length === 0
              ? h('div', { className: 'xxa-empty' },
                view.loaded === true
                  ? [
                    h('p', { key: 'empty-title', className: 'xxa-emptyTitle' }, t('list.emptyTitle')),
                    h('p', { key: 'empty-hint', className: 'xxa-emptyHint' }, t('list.emptyHint')),
                  ]
                  : h('p', { className: 'xxa-emptyHint' }, t('loading')))
              : filteredProviders.length === 0
                ? h('div', { className: 'xxa-empty' },
                  h('p', { className: 'xxa-emptyHint' }, t('list.filterEmpty')),
                  h('div', { className: 'xxa-emptyActions' },
                    button(t('list.clear'), () => { setFilter({ search: '' }) }, { small: true })),
                )
                : h('ul', { className: 'xxa-list' }, filteredProviders.map(provider => renderProviderRow(provider))),
            renderListAdvanced(providers),
          )
        }
        /** Render the level-two create/edit page. */
        const renderForm = current => {
          const isEdit = current.mode === 'edit'
          const titleName = current.displayName.trim() !== '' ? current.displayName.trim() : current.provider
          return h('div', { className: 'xxa-formRoot' },
            h('header', { className: 'xxa-formHead' },
              h('div', { className: 'xxa-formHeadMain' },
                button(t('common.back'), closeForm, { small: true }),
                h('h2', { className: 'xxa-heading', tabIndex: -1, ref: focusWhenPending('form-heading') }, isEdit ? t('form.editTitle', { name: titleName }) : t('form.createTitle')),
              ),
              button(view.saving === true ? t('common.working') : (isEdit ? t('form.saveEdit') : t('form.saveCreate')), () => { void saveDraft() }, { primary: true, disabled: view.busy }),
            ),
            renderNotice(),
            renderFailure(),
            renderConnection(current),
            renderModels(current),
            renderAdvanced(current),
          )
        }
        return h('div', { className: 'xxa-root' },
          h('style', null, STYLES),
          draft === null ? renderList() : renderForm(draft),
        )
      }
    }

    /**
     * Build the provider-card extension.
     *
     * The seat dispatches every `llm-pi-ai` card; only a row the deployment
     * declared is a custom route this plugin manages. Every DSH native and
     * built-in catalog row renders nothing.
     */
    function createProviderCardExtras(ctx, fallbackT) {
      function ProviderCardExtrasGuard(props) {
        const provider = props !== null && typeof props === 'object' ? props.provider : null
        if (provider === null || typeof provider !== 'object' || provider.declared !== true) return null
        return h(ProviderCardExtrasBody, props)
      }
      function ProviderCardExtrasBody(props) {
        const t = typeof props.t === 'function' ? props.t : fallbackT
        const providerId = props.provider !== null && typeof props.provider === 'object' && typeof props.provider.provider === 'string' ? props.provider.provider : ''
        const configured = props.configured === true && providerId !== ''
        const [probe, setProbe] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [failure, setFailure] = React.useState(null)
        const call = React.useCallback(async (method, request) => {
          try {
            const namespace = typeof ctx.get === 'function' ? ctx.get(`remote.${REMOTE_NAMESPACE}`) : undefined
            if (namespace === undefined || namespace === null || typeof namespace[method] !== 'function') return { ok: false, code: 'remote-unavailable', message: '' }
            return unwrapRemoteResult(await namespace[method](request === undefined ? {} : request))
          } catch (error) {
            return { ok: false, code: 'remote-unavailable', message: messageOfError(error) }
          }
        }, [])
        if (!configured) {
          // The card seat mounts independently of the settings section, so the
          // extension carries its own `<style>`.
          return h('div', { className: 'xxa-cardExtras' },
            h('style', null, STYLES),
            h('p', { className: 'xxa-cardHint' }, t('providerCard.unconfigured')),
          )
        }
        const runProbe = async () => {
          if (busy) return
          setBusy(true)
          setFailure(null)
          const result = await call('probe', { provider: providerId })
          setBusy(false)
          if (!result.ok) { setFailure(result); return }
          setProbe(result.value)
        }
        const checks = isPlainObject(probe) && isPlainObject(probe.checks) ? Object.entries(probe.checks) : []
        return h('div', { className: 'xxa-cardExtras' },
          h('style', null, STYLES),
          h('div', { className: 'xxa-cardStrip' },
            h('span', { className: 'xxa-cardHint' }, t('providerCard.managed')),
            button(t('providerCard.probe'), () => { void runProbe() }, { small: true, disabled: busy }),
            isPlainObject(probe)
              ? badge(probe.healthy === true ? t('providerCard.healthy') : t('providerCard.unhealthy'), probe.healthy === true ? 'Success' : 'Error')
              : null,
          ),
          failure === null ? null : h('p', { className: 'xxa-cardHint xxa-error', role: 'alert' }, failureText(t, failure)),
          checks.length === 0 ? null : h('div', { className: 'xxa-checkStrip' }, checks.map(([check, result]) => {
            const verdict = describeProbeCheck(result)
            return h('span', { key: `${providerId}-probe-${check}`, className: probeCheckClass(verdict) }, `${vocabularyText(t, 'probe.check', check)}: ${t(`probe.${verdict}`)}`)
          })),
        )
      }
      return ProviderCardExtrasGuard
    }
    /** Settings navigation glyph: a model-provider node with a sparkle. */
    function ApiManagerIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
      return h('svg', {
        viewBox: '0 0 36 36', width: size, height: size, fill: 'currentColor', 'aria-hidden': true, focusable: 'false',
        style: { display: 'block', opacity: props?.active === true ? 1 : 0.78 },
      },
        h('path', { d: 'M10 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 2.4a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2z' }),
        h('path', { d: 'M13.6 14h6.8v2h-6.8z' }),
        h('path', { d: 'M25.2 9.4l1.1 2.2 2.2 1.1-2.2 1.1-1.1 2.2-1.1-2.2-2.2-1.1 2.2-1.1z' }),
        h('path', { d: 'M10.5 21.5h15a2.5 2.5 0 0 1 0 5h-15a2.5 2.5 0 0 1 0-5zm2.2 2.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm5.3 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm5.3 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2z' }),
      )
    }

    return {
      inject: ['slots', 'remote', 'locale'],
      async apply(ctx) {
        const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : key => EN[key] ?? key
        ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'xiaoxing-api-manager.locale')
        const descriptors = REMOTE_METHODS.map(method => ({
          id: `${PACKAGE}#${method}`,
          service: 'xiaoxingApiManager',
          namespace: REMOTE_NAMESPACE,
          method,
          parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: `${PACKAGE}#req.${method}`, create: () => null } }],
          result: { mode: 'strict', typeSymbol: `${PACKAGE}#res.${method}`, create: () => null },
          invocation: { kind: 'direct' },
        }))
        try {
          await ctx.remote.$mount({ package: PACKAGE, descriptors })
        } catch (error) {
          // Keep the section available so its error state can explain the failure.
          ctx.logger?.warn(`api provider manager Remote mount failed: ${messageOfError(error)}`)
        }
        const Section = createSection(ctx, t)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: SLOT_ID, order: 62, label: () => t('title'), locale: NS,
        }, Section))
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({ name: 'settings.section.icon', id: SLOT_ID }, ApiManagerIcon))
        // `settings.models.provider-card` is a keyed seat: the Models section
        // dispatches `entryKey = settingsNs`, so the registration key is the
        // adapter family namespace rather than a free list id.
        ctx.slots.inject(PROVIDER_CARD_SLOT, () => ctx.slots.register({ name: PROVIDER_CARD_SLOT, key: PROVIDER_CARD_KEY, locale: NS }, createProviderCardExtras(ctx, t)))
      },
    }
  },
})
