# dsh-coding-time

DeepSeek Harness（DSH）的本地编码活动计时：按项目（`cwd`）统计墙钟活跃区间、
基于**真实 diff 元数据**的增删行记账，以及可选的人工编辑时长。所有数据只留在
本机 `~/.dsh` 之下。这是一个独立、纯本地的插件。

> **它不是 WakaTime。** 不调用任何第三方 API 或 CLI，不向第三方服务注册，没有
> 账号、token、计费、番茄钟、watchdog 进程。它自身**不新增 HTTP 监听端口**——
> Web 设置页/仪表盘路由挂在 Harness 已有的 `webServer` 上。不会向第三方外发统计
> 数据；仪表盘通过宿主同源的本地 HTTP 路由取数，存储是本机 JSONL。
>
> 运行时依赖：计时 / 存储 / 编辑器协议代码只用 Node 内建模块。宿主的设置表单
> 还依赖由宿主提供、声明为 `peerDependency` 的 `@deepseek-ai/schemastery`，
> 仅用于构建 Config schema，**不**随本包打包。它是本地 peer，不是网络服务，
> 也不是第三方注册。

## 状态（请先看这里）

> **实验性（experimental）。** 这是早期、纯本地的插件，以源码形式公开供审阅与
> 自行部署。已知问题（尚未修好）：当前宿主的 `Settings.describe` 未暴露本插件的
> 可写配置入口，因此部分设置控件暂**不可编辑**；客户端已禁用这些控件且不发送
> 保存请求，修复**未**完成。根本原因仍在排查（例如可写 / live 字段入口如何
> 登记），此处**不**把任何候选原因写成已证实结论。本地 Host 采集已实测可用，但
> 登录后的完整浏览器 UI 验收（可编辑 + 保存成功）仍**未**完成。下文任何描述都
> 不代表「生产可用」。

- 核心库（`lib/activity.js`、`lib/collector.js`、`lib/store.js`、
  `lib/config.js`、`lib/routes.js`、`lib/index.js`）与**本地编辑器协议**
  （`lib/editor-inbox.js`、`integrations/local-editor.js`）已实现，并有一套真实
  端到端 summary 契约用例（`test/summary-contract.test.mjs`）：真实 `apply()` +
  事件 + `session/flush` + 真实 `/summary` HTTP 路由，不 mock `summarize`。
- **最终验证记录 2026-11-05：** `npm run check` → `check ok: 9 files`；
  `node --test --test-timeout=30000 --test-reporter=spec test/*.test.mjs` →
  **174 用例 / 173 通过 / 0 失败 / 1 skip / 0 todo**（约 4.4s）。唯一 skip 是
  Windows 上的 POSIX 权限用例。请在你的平台重跑 `npm test` 取当前数字。
- **验收记录 2026-11-05（本 checkout 的历史过程）：** 会话早期插件尚未安装、
  本地 Web GUI 需要认证（401），无法做浏览器验收；此后已安装到本机 `desktop`
  profile，后端与真实本地采集已实测可用，源码正冻结待公开。与用户约定的安装
  目标是 `web` profile，`desktop` 仅用于本机验证。**登录后的完整浏览器 UI 验收
  （设置可编辑 + 保存成功）仍待完成**（见上方已知问题）。本记录不含机器用户名、
  个人路径、会话 ID 或真实用户数据。
- 设计上的限制（不是缺陷）：**不**附带 VSCode / Cursor 扩展，**不**自动覆盖
  外部编辑器。没有真实输入 API 的接入就是「未接入」，人工归因恒为
  `false`/`unknown`；绝不从文件变化事件猜测人类。

## 它统计什么（诚实记账）

计时核心（`lib/activity.js`、`lib/collector.js`）刻意保守，宁可少算也不编造时间：

- **项目级滑动 60s gate**：在任意 `heartbeatIntervalSeconds`（默认 `60`）内，
  同一规范化项目（`cwd`）只允许打开一条新记录，跨 source / session / run 共享，
  不是每个来源各一分钟。被压下的观测作为证据保留，不丢弃：同一被压制段里**两个
  及以上真实点**且相邻 gap <= `idleThresholdSeconds` 时，会投影成真实区间
  （`pending: true`、`heartbeats: 0`、时长 = 末点 − 首点）。gate 限制的是有效
  心跳**计数**，不是时间证据；只有单个孤立点才保持零时长。
- **idle 180s / flush 10s**：只有与上一条**真实观测**的 gap 在
  `idleThresholdSeconds`（默认 `180`）内、且属于同一 segment
  （`source|sessionId|runId`）时才续段；状态按 `flushIntervalSeconds`（默认
  `10`）节奏落盘。强杀（SIGKILL / 断电）**无法保证**最后一次 flush，只有优雅
  `SIGTERM` / 卸载会尽力尝试一次。
- **墙钟 union 估计、孤立点 = 0**：重叠的 AI/人工/多文件区间按时间**并集**合并，
  不相加、不按文件数相乘。单条孤立观测（start == end）时长为 `0`，不赠送一条
  心跳长度；快照也不会把 `endMs` 推到「现在」。
- **只有真实 diff 才算**：增删行只认 `result.meta` 里**显式**的行数元数据。
  没有 meta → `null`（未知），明确为零才是 `0`。`null` 绝不当 `0` 展示。
- **本机 JSONL + profile 隔离**：记录与项目状态位于
  `<storageDirectory>/<profile>/`（默认 `~/.dsh/coding-time/default`）。`profile`
  只能是单段安全名；`cwd`/项目名被 hash 进文件名，目录列表不会泄露工程路径。
- **CSV 注入防护**：CSV 导出（`lib/routes.js`）对单元格做转义（引号/逗号/换行），
  并让 `null` 与 `0` 保持区分。
- **`active` 非实时检测**：项目行里的 `active` 字段当前**没有**实时在线检测，不要
  把它读成「该项目此刻正在编辑」。未采集 / 未接入的状态是 `null`，绝不冒充 `0`。

## 人工归因——刻意克制

`humanTracking.enabled` 默认 **`false`**，由宿主控制，插件本身不自动检测人类输入。

**本地编辑器协议**是通往人工计时的唯一路径，且它是本机文件系统 IPC，不是服务：

- `integrations/local-editor.js` 导出
  `writeEditorHeartbeat({ directory, profile, event, now })` 与
  `createEditorHeartbeatWriter({ directory, profile, now, fs })`：把**单个最小 JSON
  事件**以 `.tmp` → `link`/`rename` 原子写入
  `<storageDirectory>/<profile>/editor-inbox/<id>.json`。重复 `id` 不覆盖（幂等，
  稳定 `id` 交给 tracker 去重）。事件只含
  `id, cwd, file, sessionId/editorInstanceId, runId, at, source, provenance, v`，
  **没有**正文 / 文本 / 命令 / 按键记录 / 密钥。
- `lib/editor-inbox.js` 导出 `consumeEditorInbox({ directory, profile, onEvent,
  enabled, now, fs, maxBatch })`：宿主按自己的 poll/flush 节奏调用，并传入
  `enabled = config.humanTracking.enabled`。它严格校验 schema、本机绝对
  `cwd`/`file`（`file` 必须在 `cwd` 内）、`profile` 不逃逸、`source` 白名单、
  体积/批次上限（每文件 8 KB、每批 64）；**只处理普通文件，绝不跟随符号链接**。
  坏文件移入 `quarantine/`，sink 失败则保留文件下轮重试，成功才删除。
- **必须显式传 `profile`。** 装到 `web` profile 时，`writeEditorHeartbeat` 与
  `consumeEditorInbox` 都要传 `profile: 'web'`（以及一致的 `directory`）。该参数
  缺省是 `default`，是与 `DSH_PROFILE=web` 隔离的另一份目录；依赖缺省会静默把
  事件写到永远不会被消费的目录里。
- `source` 默认 `unknown`。**只有**宿主传入 `enabled === true` 且接入方给出
  显式真实输入 provenance（`kind` 属于 `keyboard | ime | pointer-edit` 且
  `explicit: true`）时才成为 `human`。`fs.watch`、`onDidChangeTextDocument`、
  保存事件、git 作者或任何文件变化**绝不**被推断为人工，一律保持 `unknown`。

**`source`/`human` 只是本地来源*声明*，不是加密证明。** 本插件**不**附带
VSCode/Cursor 扩展，也**不**声称自动覆盖外部编辑器。接入方若没有真实输入 API，
就是**未接入**，人工时长恒为 `false`/`unknown`。绝不自动猜测人类。

## 安装

装到用户指定的 **`web`** profile：

```
dsh plugin --profile web add 'E:/github project/dsh-coding-time'
```

安装的一般前提：Node `>=22.14.0` 运行时，以及一个正在运行、且在你所用 shell
的 `PATH` 里能找到 `dsh` CLI 的 Harness 实例（若找不到，请定位 Harness CLI 或
在能暴露该命令的环境里执行）。这些是常规安装前提，不是本 checkout 的特定事实。

**仅本次验收的情况说明**（不是永久的产品要求）：本次工作期间实际运行的是
`DSH_PROFILE=desktop`，而安装目标是 `web`；本 checkout **没有**改动运行中的
`desktop` profile，也未获授权改动。本会话的本地 Web GUI 地址需要认证，因此这里
没有做浏览器侧验收。上述 `PATH`、profile、GUI 地址都**不是**产品约束，只描述
这一次验收过程中观察到的环境。本文**不**声称插件已安装、已启用或已在浏览器
验收，请在装好之后的运行中 Harness 里自行确认。

## 配置（默认值，来自 `lib/config.js`）

| 字段 | 默认值 |
| --- | --- |
| `enabled` | `true` |
| `heartbeatIntervalSeconds` | `60`（项目级滑动 gate） |
| `idleThresholdSeconds` | `180` |
| `flushIntervalSeconds` | `10` |
| `trackAgentActivity` | `true` |
| `trackAiLines` | `true` |
| `humanTracking.enabled` | **`false`** |
| `storageDirectory` | `~/.dsh/coding-time` |
| `timezone` | 本机 IANA 时区（读不到退 UTC） |
| `weekStartsOn` | `1`（周一） |
| `exclude` | `.git`、`node_modules`、`dist`、`build`、`coverage`、`.venv`、`.env`、`*.pem`、`*.key`、`id_rsa`、`.ssh`、`secrets` |

`normalizeConfig` 是严格的：未知字段、凭据字段、非法数值/时区、非绝对目录一律
报错而不是静默 clamp；`idleThresholdSeconds` 必须 `>= heartbeatIntervalSeconds`。

## 开发与验证

```
npm test                                   # 全量（最终数字见「状态」）
node --test --test-timeout=30000 --test-reporter=spec test/*.test.mjs
npm run check                              # 检查全部 lib/client/integrations 下的 .js
node --test test/summary-contract.test.mjs # 真实 apply + /summary E2E 契约
node --test test/editor-inbox.test.mjs     # 本地编辑器协议用例
npm pack --dry-run                         # 离线打包检查，不发布
```

`npm pack` 仅用于核对会被打进包的内容，不做任何发布。`package.json` 的 `files`
数组包含 `README.md`、`README.zh.md`、`docs/`、`LICENSE`、`lib/`、`integrations/`、
`client/`、`locale/`、`cordis.patch.yml`、`icon.svg`（以你的版本执行
`npm pack --dry-run` 为准）。编辑器协议用例（`test/editor-inbox.test.mjs`）与
summary 契约 E2E 用例（`test/summary-contract.test.mjs`）位于 `test/`，仅用于
开发，不在发布包内。

## 许可

MIT —— 见 [LICENSE](LICENSE)。

英文文档：[README.md](README.md)。安装细节：[docs/INSTALL.md](docs/INSTALL.md)。
