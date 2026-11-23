# 维护与提交

## 独立仓库

本目录是 `@xiaoxing/api-provider-manager` 的仓库根，也是 DSH 安装入口。源码、资源、离线目录、文档、许可与测试都应可单独检出、阅读与安装，不能依赖本仓库之外的文件或其他插件源码。

插件间只通过 DSH 原生服务协作：IM 接入方读取 `ctx.get('xiaoxingApiManager')` 并调用同步方法或监听 `xiaoxing-api-manager/models-synced` 事件，不添加跨仓库相对导入、共享可变全局状态或隐式 IM 依赖。本仓库自包含，不使用子模块。

## Git 身份

仓库本地作者与提交者使用：`xiaoxing-nya <xiaoxing_bot@luoli.my>`，不修改全局 Git 身份。

```powershell
git config --local user.name 'xiaoxing-nya'
git config --local user.email 'xiaoxing_bot@luoli.my'
git log --format='%h %s | %an <%ae> | %cn <%ce>'
```

这里是提交署名，不是 GPG / SSH 密钥签名；没有配置或伪造签名证书。

## 提交历史

初始化采用当前已验收的 0.1.0 快照，不重建未保存的旧版代码，不倒签日期，不把内部迭代编号当作已发布版本。

后续按实际改动组织提交，例如 `feat(api): ...`、`fix(api): ...`、`docs(api): ...`、`chore(repo): ...`。每个提交只解决一个明确问题，但 Host、Client、包清单、离线数据与必要资源应保持一致，避免提交半套插件。

没有配置远程仓库；推送、公开发布与重写已经分享的历史需要单独确认。

## 提交前检查

在本仓库根运行：

```powershell
npm run check
npm test
git diff --check
git diff --cached --check
git status --short
```

`npm run check` 先对 `index.js` 做 `node --check`，再由 [包检查脚本](<scripts/check-package.mjs>)验证包清单、`cordis.patch.yml`、exports、随包文件、locale、图标、`data/` 下的 JSON、全部 `lib/*.js` 的语法与相对导入、`client.js` 的 `node --check`，以及五份 Markdown 文档的相对链接。`npm test` 由 [隔离测试入口](<tests/run.mjs>)逐个以继承标准输出的独立进程执行，避免 Node test runner 的管道捕获限制。

修改行为时，还应在 DSH 中验证设置页与工具共用操作、Remote 请求、供应商接入与删除、模型发现/补全/探测、实时同步的冷却与回退、默认模型与子代理授权、重启后的本机状态。使用临时自定义供应商与临时数据目录，不覆盖真实用户配置；验证后恢复测试改动。

Node 隔离测试覆盖规则与保留边界、存储、探测、导入导出、发现、五层补全、注册表缓存、服务与全部工具动作；Client 注册契约测试存在时会自动纳入。语法、行为测试、打包清单、Git 检查和真实界面验证分别记录，不能相互替代。

## 打包检查

打包使用 `pnpm pack`，检查压缩包中的 `index.js`、`client.js`、`lib/`、`data/`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`docs/`、`README.md`、`CONTRIBUTING.md`、`CHANGELOG.md` 与 `LICENSE`；应确认 `tests/`、`scripts/` 和 `.local/` 未被打进安装包。精选主流离线目录 `data/model-catalog.json` 必须随包发布，否则 L4 离线兜底补全在无网络环境下不可用。

从解包目录验证一次接入流程，不只检查链接安装；`private: true` 保持发布禁用，正式上传前单独确认目标与渠道。

## 私有数据

不提交真实 provider 配置、API key、凭据引用、`overrides.json`、`sync-state.json`、`registry-cache.json`、DSH profile 配置、会话日志或本机路径。默认运行目录位于 `DSH_HOME`，Git 与安装目录都不需要访问它。

本地测试数据使用 `.local/` 或源码仓库外的临时目录；`.gitignore` 中的排除规则只是辅助，暂存前仍要检查实际文件清单。`.gitattributes` 统一文本为 LF，提交前确认没有 CRLF 或多余结尾换行。

包清单保持 `private: true`，避免误发布；当前维护者署名与 MIT 许可位于 `package.json` / [LICENSE](<LICENSE>)。
