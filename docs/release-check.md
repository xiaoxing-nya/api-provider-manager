# 发布前检查：0.1.0

## 结论

已完成 `@xiaoxing/api-provider-manager` `0.1.0` 的实现、UI/UX 与模型匹配修复、全量隔离测试、分发包检查以及在 DSH Desktop `0.2.2-rc.3` profile 中的实机安装与联调验证。当前保持 `private: true`，不执行 npm 上传。

## 已通过

| 检查 | 结果与证据范围 |
|---|---|
| 包契约与语法检查 | [check-package.mjs](<../scripts/check-package.mjs>) 通过：清单、exports、`cordis.patch.yml`、精选 169 个主流离线模型 / 234 条别名（约 65 KB）、70 条家族规则、12 个库模块、`client.js` 语法、图标、locale 元数据及 37 条文档链接全部通过。 |
| 行为与回归测试 | [tests/run.mjs](<../tests/run.mjs>) 运行 6 个独立进程套件：共 311 项，309 项通过、0 失败、2 跳过（Windows 沙盒符号链接创建返回 `EPERM`，源码 `lstat` 拒绝逻辑保留）。 |
| 原生供应商避让 | 实机通过 `xiaoxing_api_manager` 工具与单测验证 `deepseek-official`（native）与 `openai`（builtin-catalog）均在配置写入前被 `reserved-native-provider` 拒绝。 |
| 凭据与持久化安全 | 密钥通过 `ctx.credentials` 只写保管（`$DSH_HOME/.credentials.yaml`），`cordis.patch.yml` 只写 `apiKeyEnv` 引用，错误与工具返回经过 `redactSecretText` 脱敏；数据文件采用 `0o600` 原子写入，损坏 JSON 报 `invalid-state` 不静默清空。 |
| 自动同步、IM 实时同步与保护 | `syncProviderModels` / `syncAllCustomProviders` / `runBackgroundMaintenance` 经单测与模拟端点验证单飞去重、冷却期、`add-new`/`mirror`、空列表/网络失败回退保护、默认自动同步与 `manual` 退出、已排除模型不被加回、后台定时周期的触发与卸载清理，以及子代理授权联动。 |
| 分发包与解包冒烟 | `pnpm pack` 生成新版 `.tgz`，仅包含运行时与文档必需文件；在 `.local` 临时解包目录中独立进程验证模块导入、5 套预设及 `deepseek-v4.1-flash` / `claude-sonnet-4-5` 自动补全正常，随后清理临时目录。 |
| 实机安装与热更新闭环 | 在 DSH `0.2.2-rc.3` `desktop` profile 安装返回 `application: "applied"`、无警告；`list_plugins` 为 `active`；用临时路由 `xiaoxing-smoke-test` 实测 `upsertProvider` → `listCustomProviders` → `removeProvider({ removeCredential: true })` 即时生效与彻底清理，已有自定义通道配置零改动。 |
| Git | 独立仓库签名保持 `xiaoxing-nya <xiaoxing_bot@luoli.my>`，无未忽略的私有数据或临时脚本。 |

## 范围约束

- 当前 `0.1.0` 专注**纯自定义第三方 API（Custom Provider）**接入，预设限定 5 种通用协议与聚合原型（`custom-relay-openai`、`custom-openai-chat`、`custom-openai-responses`、`custom-anthropic`、`custom-gemini`）。
- 本插件编排 DSH 原生 `llm-pi-ai`、`.volatile()` 设置、凭据服务、`agent-default-model` 与 `subagent-model-selection-settings`，不重写 `LlmAdapter` 传输层。

## 验证边界与人工复核

- 隔离测试与 `client-registration.test.mjs` 不是真实浏览器渲染或鼠标点击测试；当前会话无浏览器 DOM/截图控制权，在 Web GUI 中的浅/深色主题排版、响应式折行与按钮交互需在浏览器刷新后人工复核。
- 请在连接的页面打开 **插件** 确认标题/描述/图标显示正常，在 **设置 → 小星 API 接入** 复核两级界面：一级页包含标题栏、操作栏（「+ 接入 API」、达到 6 条时出现的搜索框、「刷新」）、供应商列表（正常行没有状态标记、缺密钥才标红、删除走行内二次确认并支持 `Esc` 取消）与底部默认折叠的「模型匹配与导入导出」（展开后可为未匹配模型绑定/解绑上游参考模型、查看/更新在线模型知识库与切换仅离线模式、导入导出配置）；点「+ 接入 API」与行内「编辑」分别进入新建/编辑二级页，两者共用同一套表单：名称、协议、地址、密钥、模型信息自动匹配开关、批量手填与「从 API 获取模型」后的搜索/单点/批量添加、已配置模型多选批量操作（批量匹配、编辑态批量允许子代理、批量移除）与单模型细化设置（上下文、输出、输入模态、思考档位），以及默认折叠的高级设置（通道标识、密钥变量、请求头、compat 与连通性探测）。编辑页应不回显已保存密钥，未修改请求头时不提交；并在 **设置 → 模型** 展开已有自定义供应商卡片确认底部只有「由小星 API 接入管理」与安静的「探测」。
- 后台自动同步只在隔离测试中验证过；它在真实 Desktop 进程里的首次触发需要重载插件或重启 Desktop 后观察 `sync-state.json` 的 `lastSyncedAt`。设置页打开时只读取供应商列表，不再触发同步，因此页面本身不需要观察同步结果。
- 实机验证基于 `0.2.2-rc.3`，升级 DSH 主版本后应重新运行 `npm run check`、`npm test` 与实机冒烟检查。

操作与架构说明见 [README](<../README.md>) 与 [设计文档](<api-provider-manager-design.md>)；变更记录见 [CHANGELOG](<../CHANGELOG.md>)。
