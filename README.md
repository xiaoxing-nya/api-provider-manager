# 小星 API 接入管理

`@xiaoxing/api-provider-manager` 是独立的 DeepSeek Harness（DSH）插件仓库，当前为 `0.1.0` 发布候选。它面向部署自己提供的第三方 / 自定义 API 供应商，把路由接入、模型元数据补全、协议兼容、实时模型同步、端点探测和默认模型选择收在一处；DSH 原生供应商和内置 `pi-ai` 目录供应商保持只读，不会被改写或遮蔽。

插件只依赖 DSH 原生服务，不依赖其他小星Bot插件或 IM 插件，也不自带模型运行时。自定义路由写入 `llm-pi-ai` 设置命名空间，密钥写入 DSH 凭据服务，本机运行状态保存在独立数据目录。

## 功能

- 接入纯自定义路由：支持四种 pi-ai 协议，填写 baseURL、凭据引用和模型即可；内置网关预设提供保守默认值。
- 五层模型元数据补全：手工稀疏覆盖（含上游参考模型绑定 `upstreamModel`）、端点扩展字段、在线注册表缓存、随包精选主流离线目录、族规则与保守默认值逐字段裁决，并返回每个字段的来源。
- 协议兼容：按协议过滤的 26 个 `compat` 开关，处理 `supportsDeveloperRole`、`maxTokensField`、`thinkingFormat` 等差异；Gemini 思考档位收敛到其 API 接受的范围。
- 自动模型同步：通道默认按 `add-new` 自动同步——Host 启动后与之后每 6 小时在后台同步一次；设置页打开时只读取列表，不触发同步，也没有同步按钮或提示。可按通道改为 `mirror` 或关闭（`manual`）。冷却、singleflight、空响应与错误回退保证空列表或端点故障不会清掉已配置模型，用户排除的模型不会被同步加回。
- 探测与审计：连通性、聊天、developer role、输出字段、reasoning、tools 六项检查，只返回建议 `compat`，不自动改写配置。
- 导入与导出：支持本插件导出、oh-my-pi `models.yml`、Cherry Studio 导出与 DSH Cordis patch 四类格式；导入的明文密钥转入凭据服务，导出剥离密钥与敏感请求头。
- 默认模型与子代理：可把已保存模型设为 Agent 默认，并把自定义路由加入子代理模型允许列表。
- 设置页与模型工具共用同一套 Host 服务、Remote 方法与错误枚举，不维护两套业务逻辑。
- 两级开箱即用界面：一级页保持清爽主干——标题栏、操作栏（「+ 接入 API」、达到 6 条时出现的搜索框、「刷新」）与供应商列表（协议图标、名称、协议、域名与模型数，缺密钥才标红，删除走行内二次确认），底部提供默认折叠的「模型匹配与导入导出」（展开时才按需加载，支持为未匹配模型绑定上游参考模型、查看/更新在线模型知识库与切换仅离线模式、配置导入导出）；二级页新建与编辑共用同一套表单：名称、协议、地址、密钥、模型信息自动匹配开关，模型管理支持批量手填、从 API 获取后搜索/单点/批量添加，已配置模型支持多选批量操作（批量匹配模型信息、编辑态批量允许子代理、批量移除）以及单模型上下文窗口、输出上限、输入模态与思考档位细化设置；通道标识、密钥变量、请求头、compat 与连通性探测收在默认折叠的高级设置里。

## 使用

在 DSH 插件管理中安装本仓库的绝对目录，或使用 CLI，下面的路径与 profile 名称需替换为实际值：

```powershell
dsh plugin --profile desktop add 'C:\path\to\api-provider-manager'
```

安装是否即时生效以 DSH 返回结果为准；需要重启或刷新时按提示操作。安装后打开「设置 → 小星 API 接入」管理自定义供应商。设置页分两级：一级页是供应商列表，点「+ 接入 API」进入二级新建页，点某行的「编辑」进入二级编辑页，两者共用同一套表单。填好名称、协议、地址与密钥即可保存；名称含中文时内部通道标识会回退用地址域名推导，再回退到 `custom-api` 序号，因此不打开高级设置也不会因为标识为空而失败。地址末尾的 `#` 只是请求期标记（按原样拼接协议路径），保存时会自动去掉。「模型信息自动匹配」默认开启：手填或从 API 选中添加模型时会自动补全上下文窗口、输出上限、输入模态与思考档位，保存时同时以显式字段提交用户手动细化的值；关闭后只保留干净的模型 ID。从 API 获取模型后可搜索、勾选批量添加，或单点「+ 添加」快速加入；已配置模型支持勾选批量匹配、批量允许子代理（编辑页）或批量移除，每个模型也可展开单独设置并按需「匹配此模型信息」。若网关使用了自定义模型别名，可在列表底部的「模型匹配与导入导出」折叠区将其绑定到上游参考模型并实时应用参数。编辑页不回显已保存密钥（留空即保持），未修改的请求头不会提交，清空全部 compat 开关会显式清空通道级开关。删除在行内二次确认，可勾选同时删除已保存密钥。也可以让模型通过 `xiaoxing_api_manager` 工具操作。两者调用同一组 Remote 方法，行为一致：

```json
{ "action": "syncProviderModels", "provider": "my-relay" }
```

首次接入建议顺序（通过 `xiaoxing_api_manager` 工具时）：`presets` 选网关预设 → `discover` 读取端点模型 → `enrich` 预览补全结果 → `upsertProvider` 保存 → `probe` / `audit` 校验。保存后的通道默认自动同步，不需要再建立同步策略。设置页把同样的步骤收进一个二级接入页：填写名称与地址 → 「从 API 获取模型」→ 勾选或单点添加 → 保存；需要时可以展开单个模型细化参数，或先跑一次连通性探测。

## 供应商边界

自定义供应商 ID 必须匹配 `^[a-z][a-z0-9-]{0,63}$`：小写字母开头，只含小写字母、数字和连字符，最长 64 字符。以下命名空间永远保留，保存、导入和同步都会拒绝或跳过：

- DSH 原生供应商 5 个：`deepseek-official`、`deepseek-account`、`llm-deepseek`、`llm-deepseek-account`、`typesafe`。
- 内置 `pi-ai` 目录供应商 41 个，例如 `anthropic`、`openai`、`google`、`openrouter`、`deepseek`、`moonshotai`、`zai` 等；完整清单见 [lib/reserved.js](<lib/reserved.js>)。
- 当前 DSH 配置已经提供、但不是本部署自己声明的供应商条目：它们可以按名称直接使用，因此同样不允许被自定义路由顶替。

需要内置目录里的供应商时，应在 DSH 配置中按名称启用，而不是在本插件里再声明一个同名自定义路由。供应商名称到凭据引用的默认映射为 `UPPER_SNAKE_CASE` 加 `_API_KEY`，例如 `my-relay` → `MY_RELAY_API_KEY`。

## 模型元数据：五层补全

DSH 需要的不只是模型 ID：显示名、上下文窗口、输出上限、输入模态、思考档位和 pi-ai 兼容开关都会影响路由是否可用。插件按字段独立裁决，优先级从高到低为：

| 层 | 来源 | 说明 |
|---|---|---|
| L1 手工覆盖 | `overrides.json` 与请求中的显式字段 | 只保存稀疏 delta（支持 `upstreamModel` 绑定上游参考模型）；`null` 表示清除该字段，不复制完整模型表 |
| L2 端点扩展字段 | 实时发现返回的模型条目 | 上下文、输出上限、输入模态、思考档位、`allowOff`、端点协议等 |
| L3 在线注册表 | `registry-cache.json`（models.dev / OpenRouter） | 在线优先；默认 TTL 24 小时，首次交互补全时自动按需预热，支持 ETag / Last-Modified 条件请求与仅离线模式 |
| L4 随包离线目录 | 包内 `data/model-catalog.json` | 精选 169 个主流聊天模型与 234 个别名，便于维护并在无网络环境下开箱即用 |
| L5 族规则与默认值 | 包内 `data/family-rules.json` | 70 条规则覆盖 12 个模型族；没有命中时使用保守的 128000 上下文 / 16384 输出上限 |

优先级并非对所有字段完全相同：`name`、`contextWindow`、`maxTokens`、`input` 由手工覆盖优先，在线注册表优先于随包离线目录，现有配置优先于族规则猜测；`reasoningEfforts` 和 `compat` 则让现有配置高于端点、在线与离线元数据，使用户刻意选择的档位和开关在升级后保留。补全结果带 `provenance`，逐字段说明最终值来自哪一层，审计据此解释差异，Remote 返回也保留该信息。

随包离线目录只维护覆盖主流系列（DeepSeek、Claude、GPT/o 系列、Gemini、GLM、Qwen/QwQ、Kimi、MiniMax、Grok、Mistral、Llama、Doubao/Seed、MiMo）的精选模型集，由 models.dev 3067 条与 OpenRouter 362 条记录合并为 3072 条后按主流白名单筛选并折叠日期快照生成，随包发布；完整长尾模型主要通过在线注册表获取，刷新失败或返回空列表时不会覆盖已有缓存。当上下文窗口不足以容纳 `maxTokens + 65536` 的压缩预留时，补全会给出告警，而不是静默写入一个可能挤掉回复空间的配置。

## 自动同步与 IM 实时同步

同步是 Host 的后台职责，不需要任何人触发。插件加载约 1 分钟后执行第一次后台维护，之后每 6 小时一次：先在缓存超过 24 小时 TTL 时刷新在线注册表（models.dev 与 OpenRouter；离线模式下不联网），再同步所有未关闭自动同步的通道。设置页打开时只读取供应商列表，不触发同步；所有同步路径都遵守每个通道的冷却，失败只留在返回结果与 `sync-state.json` 里，不会弹出没人触发过的错误。

后台周期通过插件行配置 `autoSyncIntervalMs` 调整（毫秒，默认 21600000；`0` 关闭整个后台周期），`autoSyncInitialDelayMs` 调整启动后的首次延迟（默认 60000）。在线注册表的刷新与「仅离线模式」开关既可在设置页一级折叠区「模型匹配与导入导出」中操作，也可通过工具设置：`{ "action": "refreshRegistry", "offlineOnly": true }`。

同一套同步同时是可跨插件调用的 Host 服务，供 IM 接入方在刷新模型选择器时使用，而不是让 IM 直接改 DSH 配置：

```js
// 也可以在自己的 Cordis 依赖中声明 xiaoxingApiManager 后写作 ctx.xiaoxingApiManager
const manager = ctx.get('xiaoxingApiManager')
const result = await manager.syncProviderModels({ provider: 'my-relay' })
// 或批量同步非 manual 模式的路由
const batch = await manager.syncAllCustomProviders({ onlyAutoEnabled: true })
```

同步保证：

- 同一供应商的并发调用共享一次执行（singleflight），不会同时写两次配置。
- 默认冷却 30000 毫秒；冷却期内返回 `cooldown-cache` 和已配置模型，不重复请求端点。`force: true` 可绕过冷却。
- 端点失败、返回空列表或模型全部无法补全时，返回 `fallback-configured` 并保留原有模型列表，不会让 IM 侧已配置的模型消失。
- 未存过策略的通道默认 `add-new`：只追加端点上的新模型，不删除已有模型；`mirror` 以端点列表为准，移除不再出现的模型；`manual` 关闭自动同步，后台周期与 `onlyAutoEnabled` 批量同步都会跳过它，直接调用 `syncProviderModels` 时仍按追加语义提交。`autoApply: false` 只预览而不写配置。
- 因模型列表没有变化而跳过写入时返回 `unchanged`；真正提交成功时返回 `live`。
- 提交成功后发出 `xiaoxing-api-manager/models-synced` 事件，载荷包含 `provider`、`displayName`、`mode`、`added`、`removed`、`unchanged`、`syncedAt`，IM 可据此刷新选择器。
- 可通过 `includePatterns` / `excludePatterns` 过滤模型 ID（子串、glob 或 `/regex/`），`ignoredModels` 按精确 ID 排除用户不要的模型（保存通道时如果它又出现在模型列表里，会自动从排除清单移除），`includeNonChat` 决定是否保留嵌入、重排和媒体模型，`syncToSubagentAllowed` 决定新模型是否自动获得子代理授权。
- 批量同步的并发上限为 3；结果按供应商返回，失败项逐项报告，不中断其他供应商。
- 用 `splitByProtocol` 拆分出的通道默认关闭自动同步：一份端点模型列表无法归属到单一协议，自动同步会把所有模型灌进每条拆分路由。

## 协议兼容

支持四种 pi-ai 协议：`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`。保存的 baseURL 必须是绝对 http(s) URL，不能内嵌凭据、查询串或 fragment。

`compat` 按协议过滤，跨四种协议共有 26 个不同开关。OpenAI Chat Completions 提供 19 个，包括 `supportsStore`、`supportsDeveloperRole`、`supportsReasoningEffort`、`maxTokensField`、`thinkingFormat`、`requiresReasoningContentOnAssistantMessages`、`supportsStrictMode` 等；OpenAI Responses 和 Anthropic Messages 各有自己的子集；Gemini 不接受 `compat`。不属于当前协议的字段会被拒绝，而不是静默丢弃。

思考档位以 pi-ai 顺序 `off / minimal / low / medium / high / xhigh / max` 表达；Gemini 只接受 `minimal / low / medium / high`，其余档位在归一化时丢弃。模型可用 `reasoningEfforts: false` 明确声明非思考模型，`allowOff` 单独表达“思考能否关闭”，两者不会被混为一谈。

发现请求的 baseURL 末尾可以带一个 `#`，表示按原样拼接协议路径（不再自动插入或去除 `/v1`）；它只是请求期标记，不能写入保存的 provider 配置。混合协议的聚合网关可在保存时传 `splitByProtocol: true`，插件按模型端点类型与模型族拆成 OpenAI、Responses、Anthropic、Gemini 路由，共享同一个凭据引用，并按协议追加 `-responses`、`-anthropic`、`-gemini` 后缀。

## 配置与本机数据

仓库的 `cordis.patch.yml` 插入 `xiaoxing-api-provider-manager` 行，只提供数据目录，不包含任何凭据：

```yaml
config:
  dataDir: !!js dshHomePath('xiaoxing', 'api-manager')
```

`dataDir` 通常解析为 `<DSH_HOME>/xiaoxing/api-manager`。未提供时依次使用 `profileContext.home`、`process.env.DSH_HOME` 下的同名路径；全部不可用时返回 `invalid-config`。插件不声明 Config schema，`dataDir`、`timeoutMs`（默认 15000 毫秒）、`syncCooldownMs`（默认 30000 毫秒）、`autoSyncIntervalMs`（默认 21600000 毫秒，`0` 关闭）和 `autoSyncInitialDelayMs`（默认 60000 毫秒）通过自己的 Cordis 插件行配置，不手工覆盖整个 profile 文件。

该目录保存运行状态，不含源码或凭据：

| 文件 | 用途 |
|---|---|
| `overrides.json` | 每个模型的 L1 稀疏覆盖 delta |
| `sync-state.json` | 每个供应商的同步模式、冷却、过滤规则、已排除模型、上次结果与 diff |
| `custom-presets.json` | 用户自定义网关预设 |
| `registry-settings.json` | 在线注册表开关、TTL 与 feed URL |
| `registry-cache.json` | models.dev / OpenRouter 的归一化模型缓存 |

这些是用户私有数据，不随仓库提交或发布。四个状态文件损坏时保留原文件并报告 `invalid-state`，不会静默重置；注册表缓存损坏时告警并降级为空缓存。符号链接或非普通文件不会被跟随。

## 凭据边界

API key 只通过 DSH 凭据服务（`ctx.credentials`）保存和读取，provider 配置只保留 `apiKeyEnv` 环境变量名作为引用；`cordis.patch.yml` 不承载任何密钥。请求可以携带一次性 `apiKey`：保存路由时写入凭据服务，发现或探测时只用于本次请求；两者都不会把它写进 `llm-pi-ai` 配置，也不会出现在返回结果、工具输出或日志中。

- 读取凭据只返回是否配置、可写性和掩码，不返回明文。
- 导入第三方配置时，明文 key 被移入凭据服务，`apiKeyEnv` 留在路由里；导出时剥离 key、Authorization 等敏感头和明文值。
- 诊断消息、探测结果和工具摘要统一经过密钥脱敏，`Bearer` 令牌与 `sk-` 形式的 key 都会被覆盖。
- baseURL 不允许携带用户名、密码或查询串，避免把凭据写进 URL。

## 服务与工具

Host 服务键与 Remote 命名空间均为 `xiaoxingApiManager`。Remote 方法共 19 个：`status`、`presets`、`listCustomProviders`、`discover`、`enrich`、`audit`、`probe`、`upsertProvider`、`removeProvider`、`syncProviderModels`、`syncAllCustomProviders`、`setSyncPolicy`、`setDefaults`、`saveOverride`、`resetOverride`、`getRegistryStatus`、`refreshRegistry`、`importConfig`、`exportConfig`。

模型工具 `xiaoxing_api_manager` 的 `action` 枚举与方法一一对应，主要参数包括 `provider`、`baseURL`、`api`、`presetId`、`apiKey`、`apiKeyEnv`、`models`、`compat`、`modelId`、`override`、`syncMode`、`syncCooldownMs`、`ignoredModels`、`force`、`autoApply`、`splitByProtocol`、`setAsDefault`、`addToSubagent`、`payload` 等。工具结果为 `{ok, summary, data?}`；业务失败返回 `{ok: false}`，摘要中带稳定错误码，Remote 服务层另有 `{ok: false, code, message}`。工具不会向调用方抛出异常或返回凭据。所有写操作经过序列化队列，profile 写入还会按命名空间串行并在冲突时重试。

## 开发与许可

Host 只使用 Node 内置模块；React 与 Web 设置页服务由宿主模块表提供。没有 npm 运行依赖，也没有独立 Web 服务。

```powershell
npm run check
npm test
git status --short
```

`npm run check` 执行 `node --check` 与包契约检查（清单、patch、exports、文件、locale、图标、数据目录、文档链接），`npm test` 逐个运行隔离测试文件。当前包含 301 项隔离测试（本机运行 299 项通过，2 项因 Windows 沙箱不提供符号链接而跳过），覆盖规则与保留边界、存储/探测/导入、发现与五层补全、注册表缓存、服务与全部工具动作，以及 Client 注册契约——后者锁定注册/字典/无障碍约束与两级交互契约：一级页的列表、搜索、空状态、行内删除确认与默认折叠的「模型匹配与导入导出」（未匹配模型上游绑定、模型知识库刷新与仅离线模式、配置导入导出）；二级页的新建/编辑共用表单、名称与地址自动推导通道标识、模型信息自动匹配开关（开/关时手填与获取添加及 `autoEnrich` 保存行为）、批量手填、从 API 获取后的筛选/单点/批量添加、已配置模型多选与批量操作（批量匹配、编辑态批量允许子代理、批量移除）、单模型细化（显示名、上下文、输出、视觉、思考开关与 `off: null` 档位、单模型重新匹配）、高级设置的请求头/compat 清空与探测；以及编辑页的预填、密钥不回显、未修改请求头不提交、`compat: null` 清除、已移除模型写入 `ignoredModels`、地址 `#` 去除、陈旧结果丢弃与无死键字典等回归点。语法与隔离测试不能代替 DSH 中的真实设置页、真实端点与 IM 调用验证。

当前为 `0.1.0` 发布候选；Node 22+，兼容声明为 DSH `>=0.2.2-rc.1 <0.3.0-0`，pi-ai 常量按 `0.2.2-rc.3` 核对，其他版本需复测。保持 `private: true`，未配置远程仓库或执行上传；实际发布前另行确认目标仓库与渠道。

- [设计说明](<docs/api-provider-manager-design.md>)
- [维护与提交约定](<CONTRIBUTING.md>)
- [版本记录](<CHANGELOG.md>)

作者：xiaoxing-nya `<xiaoxing_bot@luoli.my>`。许可：[MIT](<LICENSE>)。
