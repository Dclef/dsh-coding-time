# Install & integration notes（安装与接入说明）

本文档只陈述**当前仓库里真实存在**的文件、命令与状态，不虚构已安装、已启用
或已在浏览器验收的事实。

## 1. 前置条件

- Node.js（见 `package.json` 的 `engines.node`）。
- 一个正在运行的 DeepSeek Harness 实例，且你**有权**向目标 profile 安装插件；
  你所用 shell 的 `PATH` 里能找到 `dsh` CLI（找不到就定位 CLI 或在能暴露它的
  环境里执行）。这是常规安装前提，不是本机特定的永久约束。
- 运行时依赖：计时 / 存储 / 编辑器协议代码只用 Node 内建模块；宿主的**设置
  表单**还依赖由宿主提供、声明为 `peerDependency` 的
  `@deepseek-ai/schemastery`（仅用于构建 Config schema，不随本包打包、不是网络
  服务、不是第三方注册）。因此不能表述成「只用内建、无任何 peer」。

## 2. 安装到 `web` profile

用户指定的目标是 **`web`**：

```
dsh plugin --profile web add 'E:/github project/dsh-coding-time'
```

**仅本次验收的情况说明**（不是永久的产品要求）：早期本地 Web GUI 需要认证
（401），无法做浏览器验收；此后插件已安装到本机 `desktop` profile，后端与真实
本地采集已实测可用，源码正冻结待公开。与用户约定的安装目标是 `web` profile，
`desktop` 仅用于本机验证。上述 `PATH`、profile、GUI 地址都只是这一次验收过程中
观察到的环境，不是产品约束。

**配置编辑的前提（不是缺陷）：** 只有宿主暴露了本插件自己的原生可写 Config
命名空间时才启用编辑；否则设置页显示明确的只读状态，控件禁用且**零**保存请求
（fail-closed，不猜命名空间、不强行放开）。宿主确实暴露时，声明为 live 的字段经
原生 `Settings.update` + `expectedRevision` 保存；`storageDirectory` 是启动参数，
只读展示、不自动迁移，须改宿主配置后重载才生效。

自动化回归通过不等于当前浏览器已实机验收；登录后完整浏览器 UI 验收仍待完成。
**仪表盘与「最近活动」标签：** 设置页仪表盘展示 KPI、按日柱状图、按文件时长占比、
项目时长排行、最近活动与 Git 工作区快照；会话头提供今日摘要浮层。无工具名的
活动区间显示为本地化的「活动区间」，绝不显示成未知工具；真实工具名
（`ops_bash`、`read`、`write_file` 等）原样保留；无工具名的证据点中性显示。

安装后请在运行中的 Harness 里自行确认插件是否出现在目标 profile、设置页与仪表盘
是否可用。本地源码修改需要 DSH 插件刷新，浏览器 F5 **不**等价于 Host 重载；
若 Agent 刷新开关实际处于关闭，请在顶栏手动点插件刷新，不要假定已刷新。

## 3. 离线打包 / 开发验证

不发布、不联网：

```
npm test                                   # 全量用例
node --test --test-timeout=30000 --test-reporter=spec test/*.test.mjs
npm run check                              # 检查全部 lib/client/integrations 下的 .js
npm pack --dry-run                         # 离线核对 tarball 内容
```

测试包含**真实端到端 summary 契约用例**（`test/summary-contract.test.mjs`）：
真实 `apply()` + 真实 `tools/result` / stream 事件 + `session/flush` + 真实
`/summary` HTTP 路由，不 mock `summarize`；以及本地编辑器协议用例
（`test/editor-inbox.test.mjs`）。

**最终验证记录 2026-11-12（v0.1.1 发版）：** `npm run check` →
`check ok: 10 files`；`npm test` → **222 用例 / 221 通过 / 0 失败 / 1 skip**。
本版本为看板的数字与日期格式化器增加有界缓存，按语言与时区隔离，未改变计时、
行数或缺失值口径。
唯一 skip 是 Windows 上的 POSIX 权限用例。请在你的平台重跑 `npm test` 取当前数字。

**验收记录 2026-11-05（本 checkout 的历史过程）：** 会话早期未安装、本地 Web
GUI 需认证（401）；此后已安装到本机 `desktop` profile，后端与真实本地采集已实测
可用，源码冻结待公开。与用户约定的安装目标是 `web` profile，`desktop` 仅用于
本机验证。本机宿主现已暴露可写命名空间、设置入口报告为 live，但登录后的完整
浏览器 UI 手动验收仍待完成（不要把自动化回归当成浏览器验收）。本记录不含机器
用户名、个人路径、会话 ID 或真实用户数据；上述限制是
本次验收事实，不是产品约束。

`npm pack --dry-run` 会把 `lib/`、`integrations/`、`client/`、`locale/`、`docs/`、
`assets/`、`screenshots.json`、`cordis.patch.yml`、`icon.svg`、`README.md`、
`README.zh.md`、`LICENSE` 打进 tarball（以你的版本实际执行结果为准，
`package.json` 的 `files` 数组已列这些条目）。`test/` 仅用于开发，不在发布包内。

已发布版本也可直接从 npm 或 GitHub Release 安装（v0.1.1 对应
`dsh-coding-time-0.1.1.tgz`）：

```
npm install dsh-coding-time@0.1.1
dsh plugin --profile web add 'https://github.com/Dclef/dsh-coding-time/releases/download/v0.1.1/dsh-coding-time-0.1.1.tgz'
```

## 4. 本地编辑器接入协议（供宿主 / 编辑器集成方）

这是**本机文件系统 IPC**，不是网络服务：无 HTTP 监听、无账号/token、无第三方
注册、不读工程代码正文/密钥。目录布局：

```
<storageDirectory>/<profile>/editor-inbox/<id>.json     单事件文件
<storageDirectory>/<profile>/editor-inbox/quarantine/   坏文件隔离区
```

`storageDirectory` 默认 `~/.dsh/coding-time`，`profile` 在 helper / consumer 的
参数缺省时是 `default`（与 `lib/store.js` 一致），规则是
`[A-Za-z0-9][A-Za-z0-9._-]{0,63}` 单段安全名，拒 `..`、路径分隔符、绝对路径
与逃逸。

**重要**：本文安装目标是 `web` profile。生产端 `writeEditorHeartbeat` 与消费端
`consumeEditorInbox` 都必须**显式**传 `profile: 'web'`（以及与宿主一致的
`directory`），不要依赖缺省 `default`，否则会写到与 `DSH_PROFILE=web` 隔离的
另一份目录、事件永远不会被消费。示例：

```
writeEditorHeartbeat({ directory: storageDirectory, profile: 'web', event })
consumeEditorInbox({ directory: storageDirectory, profile: 'web', enabled, onEvent })
```

### 4.1 生产端（编辑器侧）

`integrations/local-editor.js`：

```
writeEditorHeartbeat({ directory, profile, event, now, fs }) -> { path, id, duplicate }
createEditorHeartbeatWriter({ directory, profile, now, fs }) -> (event) => Promise<...>
```

`event` 最小字段：

```
{
  id,                     // 稳定、单段安全 token；同时作文件名
  cwd,                    // 本机绝对路径
  file,                   // 本机绝对路径，且必须位于 cwd 内
  runId,                  // 必填
  sessionId?, editorInstanceId?,   // 至少一个
  at?,                    // epoch ms 或 ISO 字符串，缺省 now()
  source?,                // unknown | ai | human，缺省 unknown
  provenance?,            // { kind, explicit }，可选
  v?                      // 只支持 1
}
```

写出采用 `.tmp` + `link`/`rename` 原子提交，重复 `id` 不覆盖。事件**不含**
正文 / 文本 / 命令 / 按键记录 / 凭据字段；出现即拒收。helper **不写** `human`
字段。

### 4.2 消费端（宿主侧）

`lib/editor-inbox.js`：

```
consumeEditorInbox({ directory, profile, onEvent, enabled, now, fs, maxBatch })
  -> { scanned, consumed, quarantined, failed, skipped }

resolveInboxDirectory({ directory, profile }) -> 绝对 inbox 路径
validateEditorEvent(raw, { now, enabled })   -> 归一化事件或抛 EditorInboxError
normalizeOutboundEvent(raw, { now })         -> 出站归一化
EditorInboxError, INBOX_DIRNAME, DEFAULT_PROFILE,
EDITOR_SOURCES, EXPLICIT_INPUT_KINDS, EDITOR_LIMITS
```

`onEvent` 收到的归一化事件：

```
{ id, cwd, file, sessionId, editorInstanceId, runId, at(ms),
  source, human, declaredSource, provenance|null, receivedAt, v:1 }
```

宿主在自己的 poll/flush 节奏里调用，并传入
`enabled = config.humanTracking.enabled`（默认 `false`），把稳定 `id` 交给
tracker 做幂等去重。消费者：严格 schema 白名单、本机绝对 `cwd`/`file` 且
`file` 在 `cwd` 内、`profile` 不逃逸、`source` 白名单、每文件 8 KB / 每批 64
上限；只处理 `lstat` 判定的普通文件，**绝不跟随符号链接**；坏文件隔离，sink
失败保留重试，成功删除。

### 4.3 人工归因（务必克制）

- `humanTracking.enabled` 默认 **`false`**，由宿主控制。
- `source` 默认 `unknown`；**只有** `enabled === true` 且 `provenance.kind` 属于
  `keyboard | ime | pointer-edit` 且 `provenance.explicit === true` 时才置
  `human: true`。
- `fs.watch` / `onDidChangeTextDocument` / 保存事件 / git 作者 / 任何文件变化
  **绝不**推断人工，一律 `unknown`。
- `source`/`human` 只是本地来源**声明**，不是加密证明。本插件**不**内置
  VSCode/Cursor 扩展，**不**自动覆盖外部编辑器。没有真实输入 API 就是
  **未接入**，人工时长恒为 `false`/`unknown`。

## 5. 数据边界

本插件不调用任何第三方 API/CLI、不注册第三方服务、无账号/token/费用、
不新增网络监听。Web 界面挂在宿主已有的 `webServer` 上，从同源本地路由取数；
所有数据留在本机 JSONL。

## 6. 许可

MIT，见仓库根目录 [LICENSE](../LICENSE)。
