# Changelog

## 0.1.0 — 初始发布候选

- 首个独立仓库快照：面向纯自定义 API 供应商的接入、模型元数据补全、协议兼容、端点探测、实时同步、导入导出与默认模型选择；Host、Web 设置页与模型工具共用同一套服务。
- 供应商边界固定：只受理部署自己声明的自定义路由，DSH 原生 5 个供应商与内置 pi-ai 目录 41 个供应商只读，配置已提供但非本部署声明的条目同样保留。
- 五层元数据补全：L1 稀疏手工覆盖（支持 `upstreamModel` 绑定上游参考模型） > L2 端点扩展字段 > L3 models.dev / OpenRouter 在线注册表缓存（首次交互补全时按需预热） > L4 随包精选主流离线目录 > L5 族规则与保守默认值；逐字段返回 `provenance`，并检查压缩预留是否挤占回复空间。
- 随包精选离线目录：169 个主流聊天模型、234 个别名（约 65 KB），由 models.dev 3067 条与 OpenRouter 362 条记录合并为 3072 条后按主流系列白名单筛选并折叠日期快照生成，长尾模型主要通过在线注册表获取；70 条族规则覆盖 DeepSeek、Claude、OpenAI、Gemini、GLM、Qwen、Kimi、MiniMax、Mistral、Grok、Llama 等 12 个模型族。
- 协议兼容：四种 pi-ai 协议、26 个不同 `compat` 开关按协议过滤；处理 `supportsDeveloperRole`、`maxTokensField`、`thinkingFormat` 与 `requiresReasoningContentOnAssistantMessages`；Gemini 思考档位收敛，`allowOff` 与思考可用性分开表达。
- 混合协议拆分：`splitByProtocol` 按模型端点类型与族规则拆成 OpenAI Chat / Responses / Anthropic / Gemini 路由，共享凭据引用并校验派生 ID。
- 自动同步：未存过策略的通道默认 `add-new`；Host 加载约 1 分钟后及之后每 6 小时在后台刷新过期的在线注册表并同步未关闭自动同步的通道（`autoSyncIntervalMs`，`0` 关闭），设置页只读取供应商列表、不触发同步。`syncProviderModels` 与 `syncAllCustomProviders` 仍可供 IM 直接调用，支持 `manual` / `add-new` / `mirror`，默认 30000 毫秒冷却、同供应商 singleflight、批量并发上限 3；空响应与端点错误返回 `fallback-configured` 并保留已配置模型，`ignoredModels` 保证用户排除的模型不会被同步加回，提交成功后发出 `xiaoxing-api-manager/models-synced` 事件。
- 端点能力：模型发现支持 OpenAI、Anthropic、Gemini 列表端点与多方言字段；探测覆盖 connectivity / chat / developerRole / maxTokensField / reasoning / tools，仅返回建议 `compat`。
- 导入导出：支持本插件导出、oh-my-pi `models.yml`、Cherry Studio 导出与 DSH Cordis patch；明文密钥转入凭据服务，导出剥离密钥和敏感头，`!!js` 标签只作为数据不执行。
- 本机状态：`overrides.json`、`sync-state.json`、`custom-presets.json`、`registry-settings.json` 与 `registry-cache.json` 使用 0600 临时文件加 rename 的原子写入；状态存储拒绝符号链接与非普通文件，损坏 JSON 报 `invalid-state` 且不静默重置，注册表缓存损坏时告警并降级为空缓存。
- 设置页采用两级信息架构：一级页保留标题栏、操作栏（「+ 接入 API」、长列表搜索框、「刷新」）、供应商列表（协议图标、名称、协议、域名、模型数，缺密钥才标红，行内二次确认删除）与默认折叠的「模型匹配与导入导出」（展开时按需读取，支持未匹配模型绑定上游参考模型、查看/更新在线模型知识库与仅离线模式开关、配置导入导出）；二级页新建与编辑共用同一套表单——基本连接信息与模型信息自动匹配开关、批量手填与从 API 获取后搜索/单点/批量添加、已配置模型多选批量操作（批量匹配、编辑态批量允许子代理、批量移除）与单模型上下文/输出/模态/思考档位细化、默认折叠的高级设置（通道标识、密钥变量、请求头、compat、连通性探测）。新建时名称或地址会自动推导合规且不冲突的通道标识，编辑页不回显已保存密钥、未修改请求头不提交。
- 服务与工具面：`xiaoxingApiManager` Host 服务与 Remote 命名空间共 19 个方法，工具 `xiaoxing_api_manager` 使用同一 action 枚举；写操作串行，profile 写入冲突重试，业务失败返回 `{ok: false, code, message}`。
- 模型匹配与编辑保存增强：参考模型搜索与自动补全共用查找逻辑（精确 ID > 显式别名 > 归一化匹配），多候选歧义会在设置页提示并提供上游选择；界面区分在线/离线目录命中与族规则推断，仅靠推断或存在歧义的模型仍可绑定上游；保存时按当前目录重算自动字段、将手改字段存为稀疏覆盖，并修复旧配置裸 `reasoningEfforts: false` 阻塞模型库思考档位刷新的问题；编辑页单模型/批量重新匹配与保存支持跳过陈旧配置快照，改模型 ID 时清理旧端点与匹配残留。
- 测试与包检查：311 项隔离测试（本机运行 309 项通过，2 项因 Windows 沙箱不提供符号链接权限而跳过），覆盖规则与保留边界、存储/探测/导入、发现与五层补全、注册表缓存、服务与全部工具动作，以及 Client 注册契约与两级页面交互契约；新增包契约、离线数据、图标、locale 与文档链接检查。
- 保持 `private: true`，不执行 npm 上传。
