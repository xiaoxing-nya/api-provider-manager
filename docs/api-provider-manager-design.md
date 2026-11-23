# API 接入管理插件设计

本文描述独立插件 `@xiaoxing/api-provider-manager` 的 `0.1.0` 发布候选。它把第三方 / 自定义 API 供应商接入 DSH，并在不复制 DSH `LlmAdapter` 的前提下补齐 pi-ai 路由需要的模型元数据、协议兼容、模型列表同步与默认选择。本文只记录已经实现并可被测试验证的行为；尚未实机覆盖的宿主版本明确标注为待复测。

## 1. 仓库与依赖

源码、资源、离线数据、文档、许可和测试都在本仓库内，只通过 DSH 原生服务协作，不依赖其他插件源码或本机父目录布局。

| 文件/目录 | 职责 |
|---|---|
| [index.js](<../index.js>) | Host 服务、Remote 方法标记、`xiaoxing_api_manager` 工具与生命周期 |
| `client.js` | Web 设置页与 Remote 挂载，与 Host 同包发布；不承载业务逻辑 |
| [lib/reserved.js](<../lib/reserved.js>) | 原生 / 内置目录 / 配置条目保留边界与凭据引用校验 |
| [lib/presets.js](<../lib/presets.js>) | pi-ai 协议常量、网关预设、profile 与 compat 校验 |
| [lib/enricher.js](<../lib/enricher.js>) | 五层元数据裁决、审计与协议拆分计划 |
| [lib/discovery.js](<../lib/discovery.js>) | 端点模型发现、URL 归一化与多方言字段折叠 |
| [lib/prober.js](<../lib/prober.js>) | 可选端点探测与 compat 建议 |
| [lib/registry-cache.js](<../lib/registry-cache.js>) | 离线优先注册表缓存与归一化模型条目 |
| [lib/importer.js](<../lib/importer.js>) | 脱敏导出、四类导入格式与 YAML 子集 |
| [lib/storage.js](<../lib/storage.js>) | 0600 原子 JSON 状态存储与结构校验 |
| [lib/config-sync.js](<../lib/config-sync.js>) | settings / configEditor / credentials 同步 |
| [lib/canon.js](<../lib/canon.js>) | 模型 ID 规范化与目录/族规则匹配键 |
| [lib/errors.js](<../lib/errors.js>) | 稳定错误码与密钥脱敏 |
| [data/model-catalog.json](<../data/model-catalog.json>) | 随包离线模型目录（schemaVersion 1） |
| [data/family-rules.json](<../data/family-rules.json>) | 随包声明式模型族规则（schemaVersion 1） |
| [cordis.patch.yml](<../cordis.patch.yml>) | 插入 Host 行并提供默认数据目录 |
| `tests/` | 隔离行为与契约测试 |
| `scripts/` | 包契约、离线数据、图标与文档链接检查 |

Host 仅使用 Node 内置模块。React 与 Web 侧服务由 DSH 模块表提供；没有 npm 运行依赖或独立 Web 服务。兼容声明面向 DSH `>=0.2.2-rc.1 <0.3.0-0`，pi-ai 常量按 `@deepseek-ai/dsh-llm-pi-ai` `0.2.2-rc.3` 核对；这不是对未测试版本的实机认证。

声明式 Host 依赖只有 `tools`。`settings`、`configEditor`、`credentials`、`llm`、`agentDefaultModel`、`launchEnvironment` 和 `profileContext` 按需读取；缺失能力通过状态或错误明确显示，不缓存为永久不可用。

## 2. 调研综合与设计取舍

### 2.1 Cherry Studio v2：稀疏 delta 与族规则

Cherry Studio 的模型元数据实践把“用户改过的字段”和“可再生成的元数据”分开。插件采用同样的取舍：

- 手工覆盖只保存稀疏 delta（`overrides.json`），字段集合是 `name`、`contextWindow`、`maxTokens`、`input`、`reasoningEfforts`、`compat` 与 `allowOff`；`null` 表示清除该字段，不复制整份模型表。
- 族规则独立于用户配置，作为最后的知识层；规则只描述模型族共有能力，不覆盖用户在 L1 的明确选择。
- 导入侧接受 Cherry Studio 导出（`cherry-json`），避免用户为迁移而手工重抄模型清单。

这样做使升级不依赖旧元数据快照：删掉一条手工覆盖即可回到目录或族规则，而不是留下过期副本。

### 2.2 oh-my-pi / pi-ai：目录、compat 与空缓存保护

- `omp-yaml` 导入按 oh-my-pi 的模型声明归一化，缺省容量使用 128000 上下文 / 16384 输出上限，与运行时保守默认一致。
- `compat` 常量按 pi-ai 0.2.2-rc.3 的 schema 镜像，并按协议过滤；不属于当前协议的字段被拒绝，避免把 A 协议的开关写到 B 协议上。
- 注册表缓存采用离线优先：包内目录保证无网络可用；在线刷新失败、返回空列表或解析失败时保留已有快照，不用“空结果”覆盖可用缓存，这与 pi-ai 目录在空响应下保护既有路由的思路一致。

### 2.3 Magpie：来源可解释与 `allowOff` 分离

- 模型发现把 Magpie 等网关的字段方言（`thinking.zero_allowed`、`reasoning.mandatory`、`supportedEndpointTypes` 等）折叠进统一模型条目，但保留 `reasoning` 与 `allowOff` 两个独立事实：模型支持思考，不等于思考可以被关闭。
- 补全结果为每个托管字段输出 `provenance`（`manual` / `endpoint` / `local-snapshot` / `remote-registry` / `configured` / `heuristic` / `fallback`），审计据此解释“这个值为什么是这样”，而不是把来源差异隐藏。
- `allowOff` 还可作为独立的手工覆盖字段，避免用户只能通过改写整个 `reasoningEfforts` 来表达“保持思考，但不要给 off 档”。

### 2.4 明确不做的事

不复制 `LlmAdapter`、不直接写 profile 文件、不代理模型请求、不把内置目录供应商改造成自定义路由、不把探测建议自动写入配置、不在导出中保留任何密钥或敏感头。安全边界优先于“一步到位”的自动化。

## 3. DSH 0.2.2-rc.3 集成架构

插件把 DSH 的既有配置与凭据能力当作唯一事实源，自身只编排：

1. **自定义路由**写入 `llm-pi-ai`（`@deepseek-ai/dsh-llm-pi-ai`）设置命名空间。读取优先使用 `ctx.settings.describe({redactSecrets: false})` 的 raw `base` / `user` 层，避免 schema 默认值泄漏进要回写的 profile；写入使用 `ctx.settings.mutate(namespace, ops, revision)`，携带读到的 revision，冲突映射为 `config-conflict`。
2. **`.volatile()` 用户层**：`llm-pi-ai` 通过设置描述符以 `.volatile()` 形式暴露用户层；插件读取 `base` / `user` 原始层并在写入时保留 revision 语义，不持有或复制适配器实例，也不自行解析模型协议。
3. **配置编辑器回退**：没有可写 settings 服务或没有 volatile 描述符时，使用 `ctx.configEditor.configuration()` / `edit(entry, mutator)`，按包名或命名空间定位行；两者都不可用时报 `config-unavailable`。
4. **凭据**：`ctx.credentials` 负责 `describe` / `set` / `unset` / `resolve`。路由只保存 `apiKeyEnv`；`resolve` 只服务插件自己的发现、探测与同步请求，结果不进入配置或返回值。
5. **默认模型**：`agent-default-model` 命名空间保存默认 provider / model / reasoning effort。
6. **子代理授权**：`subagent-model-selection-settings` 保存开关与允许路由；同步新增模型时可选择自动加入。

所有 profile 写入先经过统一的 `_withPiAiWrite` 串行尾部，并在 revision 冲突时重读快照、重试一次；服务级队列保证同一时刻只有一个用户或后台同步在写配置。`llm-pi-ai` 不可用时 `status` 返回 `available: false` 与诊断，而不是抛错阻断设置页。

启动顺序为：解析配置与数据目录 → 构造服务 → `ctx.provide('xiaoxingApiManager', service)` → 注册工具 → 初始化注册表缓存；卸载时置关闭标志、中止在途请求并清空 singleflight。

## 4. 保留供应商边界

保留集合由三层组成：

| 类别 | 成员 | 处理 |
|---|---|---|
| DSH 原生 | `deepseek-official`、`deepseek-account`、`llm-deepseek`、`llm-deepseek-account`、`typesafe` | 保存、导入、同步均拒绝 |
| 内置 pi-ai 目录 | 41 个，见 [lib/reserved.js](<../lib/reserved.js>) | 保存、导入、同步均拒绝，提示按名称启用内置路由 |
| 配置提供但未声明 | `llm.listConfigurableProviders()` 中 `declared !== true` 的条目 | 视为已可用，拒绝自定义路由顶替 |

`validateCustomProviderId` 先校验 `^[a-z][a-z0-9-]{0,63}$`，再查保留集；命中返回 `reserved-native-provider` 并带 `category`。读取配置时 `classifyProviders` 把保留路由归入 `reservedProviders` 只读展示，绝不修改。凭据引用必须是合法的环境变量名；未显式提供时按 provider ID 派生。

## 5. 五层元数据流水线与 schema 校验

### 5.1 逐字段裁决

每条模型由 `enrichModel` 收集各层 claims，再按字段自身的顺序选第一个有值的层：

| 字段 | 层顺序（高 → 低） |
|---|---|
| `name` | manual → endpoint → remote-registry → local-snapshot → configured |
| `contextWindow` / `maxTokens` / `input` | manual → endpoint → remote-registry → local-snapshot → configured → heuristic |
| `reasoningEfforts` | manual → configured → endpoint → remote-registry → local-snapshot → heuristic |
| `compat` | manual → configured → heuristic → remote-registry → local-snapshot → fallback |

`configured` 指现有 profile 中未被覆盖的字段。思考档位和 compat 让用户配置高于元数据，是因为档位名称与开关是用户刻意选择；容量和模态则由真正知道该模型的一层优先（在线注册表 `remote-registry` 优先于随包离线目录 `local-snapshot`）。当 `manualOverride` 指定了 `upstreamModel` 时，会以该上游参考模型 ID 查询在线注册表、离线目录与族规则并继承能力参数，但保留自定义模型原本的显示名称。`heuristic` 先匹配族规则，再落到 128000 上下文 / 16384 输出的保守默认值，输入模态默认 `text`。

裁决后执行协议归一化：输入模态只保留 pi-ai 接受的 `text` / `image`，思考档位转成 `reasoningEfforts` 映射（`allowOff: false` 时不生成 `off`），compat 按协议过滤。若上下文窗口不大于 `maxTokens + 65536`，返回告警说明压缩预留可能挤占回复空间。最终 `validateModelProfile` 校验字段类型、重复输入模态、协议不允许的 compat 与空 effort 声明。

### 5.2 离线目录与在线缓存 schema

离线目录 `data/model-catalog.json` 的 `schemaVersion` 为 1，包含 `generatedAt`、`sourceCounts`、`models` 与 `aliases`。每个模型条目含 `id`、`name`、`contextWindow`、`maxTokens`、`input`、`reasoning`、`allowOff`、`efforts`、`interleavedField`、`endpoints` 与 `source`；别名值必须指向存在的模型键。随包目录采用轻量化主流模型白名单策略（便于维护并保证开箱即用，完整长尾模型主要通过在线注册表获取），当前快照精选 169 个主流聊天模型与 234 个别名（约 65 KB）。

在线缓存复用同一模型条目契约，`data/registry-cache.json` 由 `RegistryCacheManager` 原子写入；加载时拒绝符号链接、非普通文件、损坏 JSON 或未知 schema，并以告警降级为空缓存而不是让插件启动失败。刷新使用 singleflight、ETag / Last-Modified、304 只更新检查时间、上游错误触发 60 秒熔断，空响应标记 `empty-protected` 并保留旧快照。

### 5.3 族规则 schema

`data/family-rules.json` 的 `schemaVersion` 为 1，`rules` 是有序数组；每条规则至少有 `id`、`match`、`family`、`vendorGroup`，可选 `contextWindow`、`maxTokens`、`input`、`efforts`、`allowOff`、`compat`、`notes`、`capabilities`。规则按文件顺序匹配，第一条命中即停止；正则同时测试规范化 ID 与点/连字符互换形式。当前 70 条规则覆盖 12 个模型族，非思考模型可省略 `efforts` / `allowOff`。

### 5.4 写入前的校验

- provider：ID 与保留边界、绝对 http(s) baseURL（无凭据、查询串、fragment）、协议枚举、模型非空且 ID 唯一、`apiKeyEnv` 合法、headers 能被 `new Headers()` 接受。
- model：非空 ID、正整数的容量、`text` / `image` 输入、协议允许的思考档位与 compat 类型、`vllmPriority` 为有限数字。
- override delta：只接受托管字段加 `allowOff`，逐字段类型校验，至少设置一个字段；`null` 显式清除。
- 状态文件：`overrides.json`、`sync-state.json`、`custom-presets.json`、`registry-settings.json` 均有 version 1 结构校验；损坏报 `invalid-state` 并保留原文件。

## 6. 自动同步与 IM 实时同步契约

同步没有用户入口：它由两处自动触发，并对外暴露为 IM 可调用的服务。

- **后台周期**：`apply()` 安装一个 `auto-sync` effect，加载 `autoSyncInitialDelayMs`（默认 60000）后执行第一次 `runBackgroundMaintenance()`，之后每 `autoSyncIntervalMs`（默认 21600000，`0` 关闭）一次；定时器 `unref`，上一轮未结束时跳过本轮，插件卸载时清除。一轮维护先调用不带 `force` 的 `refreshRegistry`（只在缓存超过 TTL 且非离线模式时联网），再调用 `syncAllCustomProviders({ onlyAutoEnabled: true })`；两步的失败都折进返回值，不抛出。此外，新安装首次交互调用 `enrich` 或展开一级折叠区搜索参考模型库（`getRegistryStatus({ includeCatalog: true })`）时，若在线注册表缓存仍为空且未开启离线模式，会自动执行一次最长 5 秒的非阻塞按需预热，失败时平滑降级到随包主流离线目录。
- **打开设置页**：首屏只读取供应商列表 `listCustomProviders`，不调用同步、也不读取模型知识库；同步完全由后台周期负责，页面不显示同步状态、不写同步提示、不报同步错误。底部「模型匹配与导入导出」保持默认折叠，仅在用户主动展开时才按需读取注册表状态与候选参考模型。
- **默认策略**：`createDefaultSyncPolicy()` 的 `syncMode` 为 `add-new`，因此从未存过策略的通道也会自动同步；只有显式的 `manual` 才退出。
- **已排除模型**：`ignoredModels` 是同步过滤里的精确 ID 清单。编辑页把移除的模型写进去；`upsertProvider` 在保存时把通道当前携带的 ID 从清单里移除，所以手动加回即恢复。策略补丁在任何写入之前校验，随同一次 `upsertProvider` 落盘。
- **拆分通道**：`splitByProtocol` 写出的每条路由都存 `syncMode: 'manual'`，因为一份端点列表无法归属到单一协议。

Host 通过 `ctx.provide('xiaoxingApiManager', service)` 暴露服务；IM 接入方不需要引用本仓库源码，读取方式为 `ctx.get('xiaoxingApiManager')`，在自身 Cordis 依赖中声明后也可直接写作 `ctx.xiaoxingApiManager.syncProviderModels(...)`：

```js
const manager = ctx.get('xiaoxingApiManager')
if (manager) {
  const result = await manager.syncProviderModels({ provider: 'my-relay', force: false })
  const batch = await manager.syncAllCustomProviders({ onlyAutoEnabled: true })
}
```

同步方法遵守以下契约：

- **singleflight**：同一 provider 的并发调用共享一个 Promise，任务结束后从映射移除。
- **冷却**：默认 30000 毫秒；冷却内返回 `source: 'cooldown-cache'` 与已配置模型，除非 `force: true`。
- **模式**：默认 `add-new`，只追加端点上的新模型并保留已有模型；`mirror` 以端点列表为准移除不再出现的模型；`manual` 关闭自动同步（后台周期与 `onlyAutoEnabled` 跳过），直接调用时提交路径仍按 `add-new` 处理，避免误删；`autoApply: false` 只预览而不写配置。
- **保护**：发现失败、空列表或全部补全失败时返回 `source: 'fallback-configured'`，带 `warning`，模型列表保持不变；`sync-state.json` 记录 `lastStatus` 为 `error` / `empty`。
- **提交**：只有模型 ID 或内容确实变化才写配置；成功后记录 `lastSyncedAt`、`lastDiff`，返回 `source: 'live'` 或 `'unchanged'`。
- **事件**：提交成功后 `ctx.emit('xiaoxing-api-manager/models-synced', payload)`，payload 含 `provider`、`displayName`、`mode`、`added`、`removed`、`unchanged`、`syncedAt`；事件失败只产生告警，不影响同步结果。
- **授权**：`syncToSubagentAllowed: true` 时，新模型可自动加入子代理允许列表；失败只告警。
- **批量**：`syncAllCustomProviders` 串行于服务队列，内部最多 3 个 worker；可只处理非 `manual` 路由，返回每个 provider 的结果与 `updatedCount` / `failureCount` / `warningCount`。

因此 IM 的 `/model` 刷新可以安全地重试：端点临时失败或空响应不会丢失用户已配置模型，冷却也不会反复打到网关。

## 7. 安全与持久化边界

- **原子状态写入**：临时文件以 `0600` 独占创建，写完关闭后 rename 覆盖目标；失败清理临时文件并报 `state-write-failed`。每个 store 有独立串行队列，`update(mutator)` 是安全的读改写。
- **文件安全**：状态文件与缓存加载前 `lstat`，拒绝符号链接和非普通文件；状态文件损坏时保留原文件并报 `invalid-state`，缓存文件损坏时告警并降级为空缓存，不静默替换。
- **凭据不离开凭据服务**：配置只写 `apiKeyEnv`；`apiKey` 只在本次凭据写入或本次发现/探测请求中使用；所有日志、工具结果、探测消息经过 `redactSecretText`（Bearer 令牌、`sk-` key）；导入的明文 key 转入凭据服务，导出移除 key 与敏感头。
- **网络有界**：发现响应上限 4 MiB，请求默认 15 秒超时，支持 AbortSignal；探测每个聊天请求最多 16 个输出 token；注册表刷新有超时、条件请求与熔断。
- **输入不可信**：YAML 子集解析器不执行 `!!js` 标签，只返回数据；baseURL 禁止内嵌凭据；导入按传入的 `payload` 解析，不执行其中的表达式；不把外部内容当指令执行。
- **路由不可遮蔽**：保留边界在保存、导入与同步三处独立校验，竞态下也会在写入前再次检查。

## 8. Host / Remote / Tool 接口与测试范围

Remote 命名空间为 `xiaoxingApiManager`，原型上带 `@deepseek-ai/dsh-typert-protocol/remote-methods` 描述符，方法均为 direct 调用：

| 分组 | 方法 |
|---|---|
| 状态与目录 | `status`、`presets`、`listCustomProviders`、`getRegistryStatus`、`refreshRegistry` |
| 发现与补全 | `discover`、`enrich`、`audit`、`probe` |
| 路由写入 | `upsertProvider`、`removeProvider`、`setSyncPolicy`、`setDefaults`、`saveOverride`、`resetOverride` |
| 同步 | `syncProviderModels`、`syncAllCustomProviders` |
| 配置迁移 | `importConfig`、`exportConfig` |

模型工具 `xiaoxing_api_manager` 使用同一 19 个 action 枚举，参数按用途分组；结果为 `{ok, summary, data?}`，失败时 `summary` 带稳定错误码，Remote 服务层返回 `{ok: false, code, message}` 与脱敏消息。写方法统一经过服务队列；预期失败不向 Remote 调用方抛异常。

测试按职责拆分为六个 Node 隔离测试文件，由 [tests/run.mjs](<../tests/run.mjs>) 逐个以继承标准输出的独立进程执行（30 秒超时）：

- [tests/phase1-rules.test.mjs](<../tests/phase1-rules.test.mjs>)：错误脱敏、保留边界、预设、模型 ID 规范化、族规则与 LF 约定。
- [tests/registry-cache.test.mjs](<../tests/registry-cache.test.mjs>)：两个注册表解析、合并、别名、缓存加载/刷新、空响应保护、条件请求与构建脚本确定性。
- [tests/discovery-enricher.test.mjs](<../tests/discovery-enricher.test.mjs>)：URL 归一化、多协议列表、多方言字段、五层优先级、Gemini 收敛、协议拆分与审计。
- [tests/storage-prober-importer.test.mjs](<../tests/storage-prober-importer.test.mjs>)：原子状态、损坏恢复、队列、符号链接拒绝、六项探测、超时/取消、四类导入、YAML 子集与导出脱敏。
- [tests/service-tool.test.mjs](<../tests/service-tool.test.mjs>)：Host harness 下的接入、保留拒绝、拆分、IM 同步（冷却、add-new、mirror、空响应保护、singleflight、冲突重试）、后台维护（自动通道同步、注册表按 TTL 刷新、端点故障不抛出、定时周期与关闭开关）、已排除模型、覆盖、审计、探测、导入导出与全部工具 action。
- [tests/client-registration.test.mjs](<../tests/client-registration.test.mjs>)：在 `node:vm` 中加载 `client.js`，验证 Remote 描述符、locale 字典（含无死键约束与 46 个 Host 错误码）、三个设置槽位、原生/内置路由的卡片守卫、Remote 挂载失败容错、纯函数与浏览器安全约束；同时锁定两级交互契约：一级页的标题栏、操作栏（「+ 接入 API」、长列表才出现的搜索框、「刷新」）、空状态、供应商行、行内删除确认，以及默认折叠的「模型匹配与导入导出」（展开时懒加载候选模型、为未匹配模型绑定/解绑上游参考模型、刷新在线模型库与切换仅离线模式、导入导出配置、目录读取失败留在折叠区内重试）；二级页新建/编辑共用表单、名称与地址自动推导通道标识、模型信息自动匹配开关（开/关时手填与获取添加及 `autoEnrich` 保存行为）、批量手填模型、从 API 获取后的筛选/单点/批量添加、已配置模型多选与批量操作（批量匹配、编辑态批量允许子代理、批量移除）、单模型细化（显示名、上下文、输出、视觉、思考开关与 `off: null` 档位、单模型重新匹配）、高级设置的请求头/compat/探测，以及编辑页预填、密钥不回显、未修改请求头不提交、`compat: null` 清除、已移除模型写入 `ignoredModels`、地址 `#` 去除、陈旧结果丢弃、无障碍标签与动态行 React key。
- 该契约测试不创建 DOM 或模拟页面，只证明注册与无渲染逻辑，不能替代真实视觉与点击验证。

当前共 301 项隔离测试，本机 Windows 运行 299 项通过，0 项失败，2 项因沙箱不提供符号链接创建而跳过。包检查见 [scripts/check-package.mjs](<../scripts/check-package.mjs>)：校验 package.json、cordis patch、exports、随包文件、locale、图标、两个数据文档、全部 `lib/*.js` 与五份 Markdown 的相对链接。语法、行为测试、打包清单与真实 DSH 验证分别记录，不能相互替代。

正式上传/发布不在本轮自动化步骤中，`private` 保护与远程目标保持待用户确认。

## 9. Web 设置页（两级信息架构）

`client.js` 只承载展示与交互，所有写入仍交给同一组 Remote 方法，不复制 Host 业务逻辑。页面按任务分成两级：一级页回答「有哪些通道」，二级页回答「怎么配置这一个通道」；新建与编辑共用同一套状态机与表单组件，体验完全一致。自动同步继续由 Host 在后台维护，低频的模型匹配修复、在线模型库刷新与配置导入导出收在一级页底部默认折叠的「模型匹配与导入导出」区域中。

### 9.1 一级页：供应商列表

- **页头与操作栏**：页头只展示标题与简洁说明；下方操作栏左侧为主操作「+ 接入 API」，右侧为达到 6 条时出现的搜索框（按名称、标识与地址过滤）与紧凑的「刷新」按钮。没有摘要条、状态筛选卡片或同步按钮。
- **列表**：空列表显示安静的空状态提示；每行以协议矢量图标块锚定左侧，显示名称、协议标签、端点域名（完整 URL 见 `title`）与模型数；缺密钥时显示红色状态点，正常工作的通道没有任何状态标记。右侧只有「编辑」「删除」。
- **删除**：行内二次确认条，支持 `Escape` 取消并管理焦点流转，包含「同时删除已保存密钥」复选框，确认后调用一次 `removeProvider`。
- **模型匹配与导入导出（默认折叠）**：折叠摘要右侧在存在未匹配模型或已绑定映射时显示计数徽章；仅在首次展开时才调用 `getRegistryStatus({ includeCatalog: true })` 懒加载知识库状态与上游参考模型候选，加载失败局限在折叠区内展示并支持行内重试，不覆盖页面顶部错误。内部按三个子区组织：
  1. **未匹配模型 · 上游绑定**：汇总所有通道中未命中知识库/族规则的模型与已手工绑定的模型，支持带 250 ms 防抖搜索上游参考模型或直接输入上游 ID，调用 `saveOverride({ override: { upstreamModel } })` 实时绑定并重算参数，或解绑恢复默认匹配。
  2. **模型知识库**：显示在线缓存模型数与更新状态，提供「更新在线模型库」（仅发送 `{ force: true }`）与「仅离线模式」复选框。
  3. **配置导入 / 导出**：选择导入格式（自动识别 / 本插件 JSON / OMP YAML / Cherry JSON / DSH cordis YAML）并粘贴导入，或一键导出脱敏 JSON。
- **打开页面**：只读取 `listCustomProviders`；不触发同步，也不在折叠区未展开时读取模型知识库。
- **模型卡片扩展**：`settings.models.provider-card:llm-pi-ai` 只对 `declared === true` 的自定义路由渲染一条轻量提示与「探测」按钮，并自带 `<style>`；原生与内置目录行渲染 `null`。

### 9.2 二级页：新建与编辑共用表单

- **顶栏**：左侧「← 返回」与页面标题（新建：接入 API；编辑：编辑 · 名称），右侧主按钮（保存并接入 / 保存修改，仅在执行保存操作时显示「处理中…」）。进入表单或返回列表时焦点自动落到新视图标题。
- **基本连接信息**：名称、协议类型、API 地址、API 密钥（密码框 + 显隐按钮，编辑页初始为空字符串并提示留空保持已保存密钥），以及默认开启的「模型信息自动匹配」开关。新建时根据名称或地址自动推导合规且不冲突的 `provider` 标识：优先取名称的可打印 slug，中文名称回退到 URL 域名，仍不可用则用 `custom-api` 序号；除非用户在高级设置里手动改过标识，保存时都会重新推导，因此不打开高级设置也能保存成功。
- **模型管理**：手动输入支持英文/中文逗号、分号与换行分隔的批量 ID（自动去重去空白、回车即添加）；「从 API 获取模型」调用 `discover`（编辑页传 `provider` 复用已保存密钥，新填的密钥或改动过的请求头一并传入，`suggestedBaseURL` 会回写草稿）。获取结果面板支持搜索、全选未添加、清空勾选、批量「添加已选 (N)」与单点「+ 添加」，已添加行置灰禁用。自动匹配开启时，添加动作批量调用一次 `enrich`（discover 返回的字段会透传），把名称、上下文窗口、最大输出、输入模态与思考档位预填进新模型；调用失败不阻塞添加，保留 ID 并显示原因。关闭时不调用 `enrich`，只加入干净的 `input: ['text']` 条目。
- **已配置模型**：数量达到 6 时出现搜索框；支持单选/全选当前筛选结果（带半选 `indeterminate` 状态与选中高亮），勾选后出现批量操作栏：「批量匹配信息 (N)」（合并调用一次 `enrich`）、编辑页专属的「批量允许子代理 (N)」与「移除已选 (N)」。每个模型是一张紧凑卡片，头部显示复选框、等宽模型 ID、不同于 ID 的显示名称与能力摘要（上下文、输出、视觉、思考档位数），右侧为「设置 / 收起」（带 `aria-expanded`）与「移除」。展开后按字段分组：模型 ID、显示名称、上下文窗口、最大输出（两者都附常用快捷芯片）、文本/视觉输入模态、思考开关与档位网格；每个已勾选档位可填自定义映射值，`off` 留空即 pi-ai 的显式 `null`。单模型操作行提供「匹配此模型信息」主动调用一次 `enrich`，编辑页另有「设为默认模型」「允许子代理」。
- **高级设置（默认折叠）**：新建时可编辑通道标识并实时显示合规/冲突提示，编辑时只读；密钥环境变量名；自定义请求头（编辑时未修改不提交，保护服务端敏感头）；按协议 keyed 渲染的 compat 开关（编辑保存时全部留空会显式发送 `compat: null`）；连通性探测、探测结果与「应用推荐值」；新建页另有「保存后设为默认模型」「允许子代理调用」。
- **保存**：一次 `upsertProvider` 同时提交路由与模型（`autoEnrich` 跟随自动匹配开关），地址经 `trimTrailingHash` 清理，只提交非空密钥；编辑页把被移除的模型写入 `ignoredModels`，避免自动同步重新加回。保存成功后回到一级列表并重读，失败保留错误提示。

交互层的稳定性与可访问性同样由契约测试锁定：所有 `input` / `select` / `textarea` 都有可访问名称，成功提示使用 `role="status"` + `aria-live="polite"`，失败使用 `role="alert"`，动态行与 compat 网格逐项带稳定 React key，`.xxa-mono` 允许长标识换行；`discover` / `probe` / 单模型 `enrich` 的结果通过单调递增的草稿操作引用标记，在用户改动 baseURL 或协议后丢弃陈旧结果，避免回填到已经变化的草稿。
