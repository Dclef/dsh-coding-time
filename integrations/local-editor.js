/**
 * dsh-coding-time · 本地编辑器接入 helper（生产端）。
 *
 * 给「确实能拿到输入来源」的编辑器侧集成使用：把**单个最小事件**写成
 * `<storageDirectory>/<profile>/editor-inbox/<id>.json`，宿主再用
 * lib/editor-inbox.js 的 `consumeEditorInbox()` 取走。
 *
 * 设计边界（与消费者一致，别绕过）：
 *
 * - 零第三方依赖，仅 node 内建；**无 HTTP 监听、无网络、无账号/token/费用**，
 *   不是 WakaTime，不调用任何第三方 API/CLI，不注册第三方服务。
 * - 原子写：先写 `.tmp` 临时文件，再 `rename` 成 `<id>.json`；重复 id 不覆盖
 *   （幂等，交给 tracker 按稳定 id 去重）。
 * - 事件只含最小元数据：`id,cwd,file,sessionId/editorInstanceId,runId,at,
 *   source,provenance,v`。**没有**正文/文本/命令/按键记录/密钥。
 * - `source` 默认是 `unknown`；helper **绝不写 human 字段**。能否被认作 human
 *   完全由 Host 在 `humanTracking.enabled === true` 且 provenance 是显式真实输入
 *   （keyboard / ime / pointer-edit）时决定。
 * - `fs.watch` / `onDidChangeTextDocument` / 保存事件 / git 作者 / 文件变更
 *   **不是**人工输入证据，接入方不得据此把 source 写成 human；本 helper 也不会
 *   替你推断。没有真实输入 API，就是「未接入」，human 恒 false/unknown。
 * - 本 helper **不**内置 VSCode / Cursor 扩展，**不**自动覆盖任何外部编辑器，
 *   也**不**声称能证明输入来自人类；source/human 只是本地来源声明。
 *
 * 典型用法（编辑器扩展内，仅在确实拿到键盘/IME 输入事件时调用）：
 *
 * **必须显式传 profile**：装到 `web` profile 时写 `profile: 'web'`（并与宿主
 * 消费端 `consumeEditorInbox` 用同一个值）。参数缺省是 `'default'`，那是与
 * `DSH_PROFILE=web` 隔离的另一份目录，依赖缺省会把事件写到永远不会被消费的
 * 目录里。
 * ```
 * import { writeEditorHeartbeat } from 'dsh-coding-time/integrations/local-editor.js';
 * writeEditorHeartbeat({
 *   directory: config.storageDirectory, profile: 'web',
 *   event: {
 *     id: `edit-${Date.now()}-${seq}`, // 稳定、单段安全 token
 *     cwd: workspaceRoot,              // 本机绝对路径
 *     file: absoluteFilePath,          // 本机绝对路径，必须在 cwd 内
 *     runId: 'session-1', sessionId: 'editor-A',
 *     at: Date.now(), source: 'human',
 *     provenance: { kind: 'keyboard', explicit: true },
 *   },
 * });
 * ```
 *
 * @module dsh-coding-time/integrations/local-editor
 */
import { randomBytes } from 'node:crypto';
import fsDefault from 'node:fs/promises';
import path from 'node:path';

import {
    INBOX_DIRNAME,
    EditorInboxError,
    normalizeOutboundEvent,
    resolveInboxPaths,
} from '../lib/editor-inbox.js';

/**
 * 写出一个编辑器心跳事件（原子 JSON 单文件）。
 *
 * @param options - {
 *   directory: 本机绝对存储目录;
 *   profile: 分区名（默认 'default'）;
 *   event: 最小事件对象（见模块头说明）;
 *   now: () => epochMs（测试注入）;
 *   fs: node:fs/promises 同形态对象（测试注入）。
 * }
 * @returns { path, id, duplicate } —— duplicate=true 表示同 id 已存在、未覆盖。
 * @throws EditorInboxError 目录/profile/event 校验失败。
 */
export async function writeEditorHeartbeat(options = {}) {
    const f = options.fs ?? fsDefault;
    const clock = typeof options.now === 'function' ? options.now : () => Date.now();
    const { inbox } = resolveInboxPaths({ directory: options.directory, profile: options.profile });

    // 先校验再落盘：非法事件一律不写文件（消费者侧的同一套规则）。
    let event;
    try {
        event = normalizeOutboundEvent(options.event, { now: clock });
    }
    catch (error) {
        if (error instanceof EditorInboxError) throw error;
        throw new EditorInboxError(
            `事件校验失败：${error instanceof Error ? error.message : String(error)}`,
            { code: 'E_EVENT', path: 'event', cause: error },
        );
    }

    await f.mkdir(inbox, { recursive: true });
    const target = path.join(inbox, `${event.id}.json`);

    // 稳定 id 幂等：已存在则不覆盖，pending 与最终文件都算「已存在」。
    try {
        await f.lstat(target);
        return { path: target, id: event.id, duplicate: true };
    }
    catch (error) {
        if (error?.code !== 'ENOENT') {
            // 若是符号链接，lstat 仍成功（上面已 return）；这里只处理真正的竞态/权限问题。
            if (error?.code !== 'EACCES' && error?.code !== 'EPERM') throw error;
        }
    }

    const tmp = `.${event.id}.${clock()}-${randomBytes(4).toString('hex')}.tmp`;
    const tmpPath = path.join(inbox, tmp);
    const payload = `${JSON.stringify(event)}\n`;

    // 临时文件用 'wx' 独占创建，内容写完整后才做原子提交。
    await f.writeFile(tmpPath, payload, { encoding: 'utf8', flag: 'wx' });

    // 原子提交优先用 link(tmp → target)：目标已存在会 EEXIST，天然满足
    // 「重复 id 不覆盖」。POSIX 的 rename 会静默覆盖已存在的目标，不能用它做
    // 无覆盖提交；仅当文件系统不支持硬链接时才退回带 lstat  guarding 的 rename。
    let duplicate = false;
    try {
        await f.link(tmpPath, target);
    }
    catch (error) {
        if (error?.code === 'EEXIST') {
            duplicate = true;
        }
        else if (['EPERM', 'EACCES', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EMLINK', 'EXDEV'].includes(error?.code)) {
            // 不支持硬链接：退回 rename，但先再确认一次目标不存在。
            try {
                await f.lstat(target);
                duplicate = true;
            }
            catch (lstatError) {
                if (lstatError?.code !== 'ENOENT') throw lstatError;
                await f.rename(tmpPath, target); // rename 不跟随符号链接
            }
        }
        else {
            throw error;
        }
    }
    finally {
        // 无论成功/重复/失败，临时文件都不该留在 inbox（消费者只认 *.json）。
        await f.unlink(tmpPath).catch(() => {});
    }

    return { path: target, id: event.id, duplicate };
}

/**
 * 绑定 directory/profile 的 writer 工厂，便于编辑器侧只关心 event。
 *
 * @param options - { directory, profile, now, fs }
 * @returns (event) => Promise<{ path, id, duplicate }>
 */
export function createEditorHeartbeatWriter(options = {}) {
    // 提前校验目录/profile，工厂建立时就能暴露配置错误。
    resolveInboxPaths({ directory: options.directory, profile: options.profile });
    return (event) => writeEditorHeartbeat({ ...options, event });
}

export { INBOX_DIRNAME };
