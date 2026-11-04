/**
 * dsh-coding-time · 归一化层。
 *
 * **只做"原始宿主事件 → 观测(observation)"的翻译与来源判定**，不自己记时、
 * 不自己累计、不自己落盘。计时与限频由 `ActivityTracker` 唯一负责，持久化由
 * `JsonlStore` 唯一负责。这样任何口径变化只有一处可改。
 *
 * 三条硬规则（工单安全约束的可执行版本）：
 *
 * 1. `tools/result` 只在 **成功**（`result.isError === false`）时产生观测，且必须
 *    有**明确路径**。`ops_bash` 一律不解析：任意 shell 脚本里的路径是猜的。
 * 2. 行数只认 `result.meta` 里**显式**的 added/deleted。缺失 → `null`（未知），
 *    绝不按"整个文件多少行"倒推，也绝不把 `workspaceChanges.summary` 的整轮
 *    净变更归因给 AI。
 * 3. `agent/status: running` **不**产生时长锚点（泛 Agent 一直 running 不等于在
 *    敲代码）；只有真实 stream 进展才算活动。
 *
 * @module dsh-coding-time/collector
 */
import path from 'node:path';
import { DEFAULT_EXCLUDE } from './config.js';

/** 工具别名 → 路径取法。未知工具一律不取路径（宁缺勿猜）。 */
const TOOL_RULES = Object.freeze({
    read: Object.freeze({ kind: 'file', paths: Object.freeze(['file_path', 'path']) }),
    write: Object.freeze({ kind: 'file', paths: Object.freeze(['file_path', 'path']) }),
    edit: Object.freeze({ kind: 'file', paths: Object.freeze(['file_path', 'path']) }),
    str_replace: Object.freeze({ kind: 'file', paths: Object.freeze(['file_path', 'path']) }),
    ops_read_files: Object.freeze({ kind: 'file', fileList: 'files' }),
    ops_inspect_local_file: Object.freeze({ kind: 'file', paths: Object.freeze(['path']) }),
    // 执行类：明确不解析任何命令文本，路径未知即不产生观测。
    ops_bash: Object.freeze({ kind: 'exec', paths: Object.freeze([]) }),
});

/** 敏感文件名：命中即不产生观测。 */
const SENSITIVE_NAME = Object.freeze([
    /^\.env(\.|\b)/i,
    /\.pem$/i,
    /\.key$/i,
    /\.pfx$/i,
    /\.p12$/i,
    /^id_rsa$/i,
    /^id_ed25519$/i,
    /^\.npmrc$/i,
    /^\.pypirc$/i,
    /^credentials$/i,
    /^secrets?\.(json|yml|yaml|txt)$/i,
]);

/** 敏感目录段。 */
const SENSITIVE_SEGMENT = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.secrets', 'secrets', 'secret']);

/** 真实输入模态：只有这些才算人类（与 editor-inbox 的 EXPLICIT_INPUT_KINDS 一致）。 */
const EXPLICIT_INPUT_KINDS = Object.freeze(['keyboard', 'ime', 'pointer-edit']);

/**
 * 按工具名与参数取候选路径。
 * @param name - 工具名。
 * @param args - 调用参数。
 * @returns 候选路径（去重，未绝对化）。
 */
export function extractCandidatePaths(name, args) {
    const rule = TOOL_RULES[String(name ?? '')];
    if (rule === undefined) return [];
    if (args === null || typeof args !== 'object') return [];
    /** @type {string[]} */
    const out = [];
    for (const key of rule.paths ?? []) {
        const value = args[key];
        if (typeof value === 'string' && value !== '') out.push(value);
    }
    if (rule.fileList !== undefined) {
        const list = args[rule.fileList];
        if (Array.isArray(list)) {
            for (const item of list) {
                if (typeof item === 'string') out.push(item);
                else if (item !== null && typeof item === 'object' && typeof item.path === 'string') out.push(item.path);
            }
        }
    }
    const seen = new Set();
    /** @type {string[]} */
    const unique = [];
    for (const item of out) {
        const key = process.platform === 'win32' ? item.toLowerCase() : item;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
    }
    return unique;
}

/**
 * 工具分类（映射到 `ActivityTracker` 的 kind）。
 * @param name - 工具名。
 * @returns 'file' | 'exec' | 'agent'。
 */
export function classifyTool(name) {
    const rule = TOOL_RULES[String(name ?? '')];
    if (rule === undefined) return 'agent';
    return rule.kind === 'file' ? 'file' : 'agent';
}

/**
 * 绝对化：能在会话 cwd 里落地的才算"明确路径"。
 * @param raw - 工具给的路径。
 * @param cwd - 会话工作目录。
 * @returns 绝对路径或 undefined。
 */
export function resolveCandidatePath(raw, cwd) {
    if (typeof raw !== 'string' || raw === '') return undefined;
    if (path.isAbsolute(raw)) return path.normalize(raw);
    if (typeof cwd === 'string' && cwd !== '' && path.isAbsolute(cwd)) return path.normalize(path.resolve(cwd, raw));
    return undefined;
}

/**
 * 敏感路径判定（只看路径形态，不读内容）。
 * @param absolutePath - 绝对路径。
 * @returns 是否敏感。
 */
export function isSensitivePath(absolutePath) {
    if (typeof absolutePath !== 'string' || absolutePath === '') return true;
    const segments = absolutePath.split(/[\\/]+/).filter(Boolean);
    for (const segment of segments) {
        if (SENSITIVE_SEGMENT.has(segment.toLowerCase())) return true;
    }
    const base = segments[segments.length - 1] ?? '';
    return SENSITIVE_NAME.some(pattern => pattern.test(base));
}

/**
 * 排除规则（默认片段 + 用户配置）。
 * @param absolutePath - 绝对路径。
 * @param rules - 排除片段。
 * @returns 是否排除。
 */
export function isExcludedPath(absolutePath, rules = DEFAULT_EXCLUDE) {
    if (typeof absolutePath !== 'string' || absolutePath === '') return true;
    const lower = absolutePath.toLowerCase();
    for (const rule of rules ?? []) {
        if (typeof rule !== 'string' || rule === '') continue;
        const needle = rule.toLowerCase();
        if (needle.startsWith('*.')) {
            if (lower.endsWith(needle.slice(1))) return true;
            continue;
        }
        if (lower.split(/[\\/]+/).includes(needle)) return true;
    }
    return false;
}

/**
 * 是否可计入统计（敏感 / 排除 / 插件自身 / 存储目录）。
 * @param absolutePath - 绝对路径。
 * @param options - { rules, storageDirectory, pluginDirectory }。
 * @returns 是否计入。
 */
export function isCountablePath(absolutePath, options = {}) {
    if (isSensitivePath(absolutePath)) return false;
    if (isExcludedPath(absolutePath, options.rules)) return false;
    for (const guarded of [options.storageDirectory, options.pluginDirectory]) {
        if (typeof guarded !== 'string' || guarded === '') continue;
        const base = path.normalize(guarded);
        if (absolutePath === base) return false;
        if (absolutePath.startsWith(base + path.sep)) return false;
    }
    return true;
}

/**
 * 从成功结果的 meta 读显式计数；没有就是 **null**（未知，不是 0）。
 *
 * 只认**计数型**形状（三个字段都是非负整数）。真正的 diff 文本形状交给
 * `readDiffEvidence` 按行计算。
 *
 * @param meta - `result.meta`。
 * @returns { added, deleted, source } 或 null。
 */
export function readLineMeta(meta) {
    if (meta === null || typeof meta !== 'object') return null;
    const candidates = [
        [meta.lines, 'meta.lines'],
        [meta, 'meta.addedLines'],
        [meta.diff, 'meta.diff'],
    ];
    for (const [shape, source] of candidates) {
        if (shape === null || typeof shape !== 'object') continue;
        const added = shape.added ?? shape.addedLines ?? shape.linesAdded;
        const deleted = shape.deleted ?? shape.deletedLines ?? shape.linesRemoved;
        if (!Number.isInteger(added) || !Number.isInteger(deleted)) continue;
        if (added < 0 || deleted < 0) continue;
        return { added, deleted, source };
    }
    return null;
}

/** 单文件 LCS 的行数上限：超过即判定 unavailable，不伪装成 net 长度差。 */
const LCS_MAX_LINES = 1200;
/** 单次 meta 里参与计算的 diff 文件数上限。 */
const DIFF_MAX_FILES = 64;

/**
 * 判定 meta 是否携带真实 before/after diff 形状。
 *
 * 真实投射类型是 `DiffResultView { card:'diff', diffs: FileDiff[] }`，
 * `FileDiff { path, oldText: string | null, newText: string }`。
 *
 * @param meta - `result.meta`。
 * @returns FileDiff 数组或 null。
 */
export function extractFileDiffs(meta) {
    if (meta === null || typeof meta !== 'object') return null;
    const direct = Array.isArray(meta.diffs) ? meta.diffs : undefined;
    const nested = meta.card === 'diff' && Array.isArray(meta.diffs) ? meta.diffs : undefined;
    const list = direct ?? nested;
    if (list === undefined) return null;
    const diffs = [];
    for (const item of list.slice(0, DIFF_MAX_FILES)) {
        if (item === null || typeof item !== 'object') continue;
        if (typeof item.path !== 'string' || item.path === '') continue;
        if (item.newText !== undefined && typeof item.newText !== 'string') continue;
        if (item.oldText !== undefined && item.oldText !== null && typeof item.oldText !== 'string') continue;
        diffs.push({
            path: item.path,
            oldText: typeof item.oldText === 'string' ? item.oldText : null,
            newText: typeof item.newText === 'string' ? item.newText : '',
        });
    }
    return diffs.length === 0 ? null : diffs;
}

/**
 * 用有界行 LCS 从 before/after 提取真实增删行数。
 *
 * **绝不把文本带出**：返回值只有计数，`oldText`/`newText` 在本函数内丢弃。
 * 超过行数上限、或行数差异过大时返回 `null`——宁可 `unavailable`，也不用
 * "净长度差"伪装成增删。
 *
 * @param oldText - 旧文本（null 表示新增文件）。
 * @param newText - 新文本。
 * @returns { added, deleted } 或 null。
 */
export function countLineChanges(oldText, newText) {
    const splitLines = (text) => {
        if (typeof text !== 'string') return [];
        // 统一换行；末尾换行不额外产生一行。
        const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (normalized === '') return [];
        const lines = normalized.split('\n');
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
        return lines;
    };
    const before = splitLines(oldText ?? '');
    let after;
    try {
        after = splitLines(newText ?? '');
    }
    catch {
        return null;
    }
    if (before.length > LCS_MAX_LINES || after.length > LCS_MAX_LINES) return null;

    // 经典 O(n*m) LCS，仅在行数上限内运行。
    const rows = before.length + 1;
    const cols = after.length + 1;
    const table = new Uint16Array(rows * cols);
    for (let i = 1; i < rows; i += 1) {
        for (let j = 1; j < cols; j += 1) {
            if (before[i - 1] === after[j - 1]) {
                table[i * cols + j] = table[(i - 1) * cols + (j - 1)] + 1;
            }
            else {
                const up = table[(i - 1) * cols + j];
                const left = table[i * cols + (j - 1)];
                table[i * cols + j] = up > left ? up : left;
            }
        }
    }
    const common = table[(rows - 1) * cols + (cols - 1)];
    return {
        added: after.length - common,
        deleted: before.length - common,
    };
}

/**
 * 从 meta 提取"按文件路径"的行数证据。
 *
 * 多文件 diff **按 path 归属**，绝不把总量重复加到每个文件。
 *
 * @param meta - `result.meta`。
 * @returns { byPath: Map<string,{added,deleted}>, unfiled: {added,deleted}|null, quality }
 *   `quality` 为 `'counted'`（显式计数）、`'computed'`（LCS 算出）、`'unavailable'`。
 */
export function readLineEvidence(meta) {
    const explicit = readLineMeta(meta);
    if (explicit !== null) {
        return { byPath: null, unfiled: { added: explicit.added, deleted: explicit.deleted }, quality: 'counted', source: explicit.source };
    }
    const diffs = extractFileDiffs(meta);
    if (diffs === null) return { byPath: null, unfiled: null, quality: 'unavailable', source: 'none' };

    const byPath = new Map();
    let computed = 0;
    let unavailable = 0;
    for (const diff of diffs) {
        const counts = countLineChanges(diff.oldText, diff.newText);
        if (counts === null) {
            unavailable += 1;
            continue;
        }
        computed += 1;
        byPath.set(normalizeKey(diff.path), counts);
    }
    if (computed === 0) return { byPath: null, unfiled: null, quality: 'unavailable', source: 'diff' };
    return {
        byPath,
        unfiled: null,
        quality: unavailable > 0 ? 'partial' : 'computed',
        source: 'diff',
    };
}

/**
 * 流式 frame 是否代表真实进展。
 *
 * 真实载荷是 `AssistantStreamFrame` union：
 * `{type:'start',attemptId,revision,turn,step}` /
 * `{type:'chunk',attemptId,revision,index,time,chunk:StreamChunk}` /
 * `{type:'end',attemptId,revision,index,outcome}`。
 *
 * 只有 `type==='chunk'` 且 `chunk` 内有**非空增量**才算；`start`/`end`/`usage`/
 * `finish`/空增量一律不算。同时兼容裸 `StreamChunk`（测试与未来形态）。
 *
 * @param frame - AssistantStreamFrame 或 StreamChunk。
 * @returns 是否有增量（只判断真假，不保留任何正文）。
 */
export function isProgressFrame(frame) {
    if (frame === null || typeof frame !== 'object') return false;
    const type = typeof frame.type === 'string' ? frame.type : '';
    // 真实包裹形态。
    if (type === 'start' || type === 'end') return false;
    if (type === 'chunk') return isProgressChunk(frame.chunk);
    // 裸 StreamChunk 兼容形态。
    return isProgressChunk(frame);
}

/**
 * StreamChunk 是否带非空增量。
 * @param chunk - StreamChunk。
 * @returns 是否有增量。
 */
export function isProgressChunk(chunk) {
    if (chunk === null || typeof chunk !== 'object') return false;
    const type = typeof chunk.type === 'string' ? chunk.type : '';
    if (type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== '';
    if (type === 'reasoning-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== '';
    if (type === 'tool-call-delta') return typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta.trim() !== '';
    if (type === 'block-end') return chunk.block !== null && typeof chunk.block === 'object';
    // block-start / usage / finish：结构事件，不构成"在写代码"的进展证据。
    return false;
}

/**
 * 判定一次工具调用的**返回值**是否真的成功。
 *
 * 真实宿主里 `isError:false` 只表示"传输层没抛错"：`ops_*` 常在返回值里写
 * `value.status='error'|'rejected'` 或 `value.error.code='PATH_RESTRICTED'`。
 * 把 transport 成功当文件成功会伪造文件证据，所以这里必须读返回值。
 *
 * @param result - ToolExecutionResult。
 * @returns { ok, perPath } —— `perPath` 是"按路径的成功名单"（批量工具部分失败时用）：
 *   `null` 表示整体结论适用所有路径；数组表示只对这些路径成功。
 */
export function evaluateToolOutcome(result) {
    if (result === null || typeof result !== 'object') return { ok: false, perPath: null };
    if (result.isError === true) return { ok: false, perPath: null };
    const value = result.value;

    // 明确的拒绝/错误状态（大小写不敏感）。
    const rejectedStatuses = new Set(['error', 'rejected', 'refused', 'denied', 'failed', 'forbidden', 'unauthorized']);
    const readStatus = (candidate) => {
        if (typeof candidate !== 'string') return '';
        return candidate.trim().toLowerCase();
    };

    if (typeof value === 'string') {
        // 纯文本返回值不足以证明文件成功；但也不构成失败证据。
        return { ok: false, perPath: null };
    }
    if (value === null || typeof value !== 'object') {
        return { ok: false, perPath: null };
    }
    if (Array.isArray(value)) {
        // 顶层数组：逐项判定。
        return { ok: false, perPath: collectArraySuccess(value) };
    }

    const status = readStatus(value.status) || readStatus(value.state) || readStatus(value.outcome);
    if (status !== '' && rejectedStatuses.has(status)) return { ok: false, perPath: null };
    if (value.error !== undefined && value.error !== null) {
        // `error` 存在即视为失败（`PATH_RESTRICTED` 等就在这里）。
        return { ok: false, perPath: null };
    }

    // 批量：results/entries/items/files 数组，逐项看成功。
    for (const key of ['results', 'entries', 'items', 'files', 'paths']) {
        const list = value[key];
        if (Array.isArray(list)) {
            const perPath = collectArraySuccess(list);
            return { ok: perPath.length > 0, perPath };
        }
    }
    // 显式布尔成功标记。
    if (value.ok === false || value.success === false || value.changed === false) {
        return { ok: false, perPath: null };
    }
    // 明确的"读写到了东西"证据。
    if (value.ok === true || value.success === true || value.changed === true) {
        return { ok: true, perPath: null };
    }
    if (Array.isArray(value.lines) || typeof value.content === 'string' || Array.isArray(value.content)) {
        return { ok: true, perPath: null };
    }
    // 结构上有可读载荷（对象）且无拒绝证据：保守地当成功，但只用于"文件被触碰"，
    // 行数仍然只认 meta。
    return { ok: true, perPath: null };
}

/**
 * 批量条目里哪些是成功的。
 * @param list - 条目数组。
 * @returns 成功条目的路径（或空数组）。
 */
function collectArraySuccess(list) {
    const out = [];
    for (const item of list) {
        if (item === null || typeof item !== 'object') continue;
        if (item.isError === true) continue;
        // 只有**真的带** error 才算失败（undefined 是"没这个字段"）。
        if (item.error !== undefined && item.error !== null) continue;
        const status = typeof item.status === 'string' ? item.status.trim().toLowerCase() : '';
        if (status === 'error' || status === 'rejected' || status === 'failed' || status === 'denied') continue;
        const itemPath = typeof item.path === 'string' ? item.path : (typeof item.file === 'string' ? item.file : '');
        if (itemPath !== '') out.push(itemPath);
    }
    return out;
}

/**
 * 归一化 `tools/result`。
 *
 * @param exec - ToolExecution。
 * @param result - ToolExecutionResult。
 * @param options - { cwd, rules, storageDirectory, pluginDirectory, at }。
 * @returns 观测数组（**可能为空**：失败、返回值失败、无路径、敏感、排除、ops_bash）。
 */
export function normalizeToolResult(exec, result, options = {}) {
    if (exec === null || typeof exec !== 'object') return [];
    if (result !== null && typeof result === 'object' && result.isError === true) return [];
    const sessionId = typeof exec.agent?.id === 'string' ? exec.agent.id : '';
    const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : '';
    if (cwd === '') return [];
    const name = typeof exec.name === 'string' ? exec.name : '';
    const callId = String(exec.callId ?? '');
    const rule = TOOL_RULES[name];
    if (rule === undefined) return [];
    const kind = rule.kind === 'file' ? 'file' : 'agent';

    // 返回值语义：transport 成功 ≠ 文件成功。
    const outcome = evaluateToolOutcome(result);
    if (outcome.ok === false && outcome.perPath === null) return [];

    // 批量部分失败：只保留返回值确认成功的那些路径。
    const allowedByOutcome = outcome.perPath === null ? null : new Set(outcome.perPath.map(item => normalizeKey(item)));

    const counted = [];
    for (const raw of extractCandidatePaths(name, exec.arguments)) {
        const absolute = resolveCandidatePath(raw, cwd);
        if (absolute === undefined) continue;
        if (isCountablePath(absolute, {
            rules: options.rules,
            storageDirectory: options.storageDirectory,
            pluginDirectory: options.pluginDirectory,
        }) === false) continue;
        // 用**绝对化后**的路径与返回值比对（返回值里通常是相对/绝对混合）。
        if (allowedByOutcome !== null && allowedByOutcome.has(normalizeKey(absolute)) === false) {
            // 批里这一项没被返回值确认成功：跳过，不伪造。
            continue;
        }
        counted.push(absolute);
    }
    if (counted.length === 0) return [];

    // 行数证据：只认 meta，且必须有明确成功。
    // 多文件 diff **按 path 归属**，绝不把 meta 总量重复加到每个文件。
    const evidence = kind === 'file' ? readLineEvidence(result?.meta) : { byPath: null, unfiled: null, quality: 'unavailable' };
    const at = Number.isFinite(options.at) ? options.at : Date.now();
    const base = toolObservationId(sessionId, callId, name);
    const runId = typeof options.runId === 'string' ? options.runId : (callId === '' ? '' : callId);
    /** @type {object[]} */
    const observations = [];
    for (const absolute of counted) {
        let linesAdded = null;
        let linesDeleted = null;
        if (evidence.byPath !== null) {
            // 按文件精确归属；该文件不在 diff 里就是 null（未知）。
            const match = evidence.byPath.get(normalizeKey(absolute)) ?? evidence.byPath.get(normalizeKey(path.basename(absolute)));
            if (match !== undefined) {
                linesAdded = match.added;
                linesDeleted = match.deleted;
            }
        }
        else if (evidence.unfiled !== null && counted.length === 1) {
            // 只有单文件调用才允许把"整体计数"当作该文件的计数。
            linesAdded = evidence.unfiled.added;
            linesDeleted = evidence.unfiled.deleted;
        }
        observations.push({
            id: `${base}:${absolute}`,
            cwd,
            at,
            source: 'ai',
            kind,
            sessionId,
            runId,
            file: absolute,
            linesAdded,
            linesDeleted,
            project: path.basename(cwd),
        });
    }
    return observations;
}

/**
 * 一次工具调用的稳定观测 id 前缀。
 * @param sessionId - 会话 id。
 * @param callId - 工具调用 id。
 * @param name - 工具名。
 * @returns 稳定前缀。
 */
export function toolObservationId(sessionId, callId, name) {
    const base = String(sessionId ?? '');
    const tail = String(callId ?? '') !== '' ? String(callId) : `n:${String(name ?? '')}`;
    return `tool:${base}:${tail}`;
}

/** 路径比较键（Windows 折叠大小写 + 统一分隔符）。 */
function normalizeKey(value) {
    const text = String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? text.toLowerCase() : text;
}

/**
 * 归一化 `agent/assistant-stream`：只有真实进展才产出观测。
 *
 * id 由 `attemptId + revision + index` 组成（**稳定、可复算**），绝不用正文 hash：
 * 连续相同字符是真实的进展，不能被当成重复包吞掉。
 *
 * @param payload - { agent, frame }。
 * @param options - { cwd, at, runId }。`runId` 应由 Host 侧传入
 *   "进程 nonce + session activation 标识"，不是每个 chunk 随机生成。
 * @returns 观测数组（0 或 1）。
 */
export function normalizeProgress(payload, options = {}) {
    const sessionId = typeof payload?.agent?.id === 'string' ? payload.agent.id : '';
    const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : '';
    if (sessionId === '' || cwd === '') return [];
    const frame = payload?.frame;
    if (isProgressFrame(frame) === false) return [];
    const at = Number.isFinite(options.at) ? options.at : Date.now();
    const attemptId = String(frame?.attemptId ?? '');
    const revision = Number.isInteger(frame?.revision) ? frame.revision : -1;
    const index = Number.isInteger(frame?.index) ? frame.index : -1;
    // 裸 chunk 没有这些字段时，退到"时间 + 序号"这种同样可复算的稳定键。
    const id = attemptId !== '' && revision >= 0 && index >= 0
        ? `stream:${sessionId}:${attemptId}:${revision}:${index}`
        : `stream:${sessionId}:${at}:${index}`;
    return [{
        id,
        cwd,
        at,
        source: 'ai',
        kind: 'agent',
        sessionId,
        runId: typeof options.runId === 'string' ? options.runId : '',
        file: '',
        linesAdded: null,
        linesDeleted: null,
        project: path.basename(cwd),
    }];
}

/**
 * 归一化 `session/event`。
 *
 * **普通用户消息绝不产生 human 编码观测**。聊天里敲一句"帮我改一下"不是人类
 * 编写代码；把 `user/message` 当成 human 会让"还没接入编辑器"就显示 connected，
 * 这是口径造假。
 *
 * 人类时长的唯一入口是编辑器 helper → `editor-inbox` → `normalizeEditorEvent`
 * （它要求 `provenance.kind ∈ keyboard|ime|pointer-edit` 且 `explicit === true`）。
 *
 * 本函数保留是为了：① 显式记录"这里不产出"；② 若将来 `session/event` 真的携带
 * 已验证的 editor provenance + file（那才属于人类输入），才转交给
 * `normalizeEditorEvent`。当前宿主事件不带该字段，所以恒返回 `[]`。
 *
 * 另外 `tool/result` 与 `assistant/message` 一律忽略——它们已由 `tools/result` 与
 * stream 覆盖，重复处理会双算。
 *
 * @param session - Session。
 * @param event - SessionEvent。
 * @param options - { cwd, humanEnabled }。
 * @returns 观测数组（当前恒为空）。
 */
export function normalizeSessionEvent(session, event, options = {}) {
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    if (sessionId === '') return [];
    if (event?.type !== 'user/message') return [];
    // 只有事件本身携带**已验证的编辑器输入证据**时才算人类；普通聊天没有。
    const provenance = event?.provenance;
    if (provenance === null || typeof provenance !== 'object') return [];
    if (provenance.explicit !== true) return [];
    if (EXPLICIT_INPUT_KINDS.includes(String(provenance.kind ?? '')) === false) return [];
    if (options.humanEnabled !== true) return [];
    const file = typeof event?.file === 'string' ? event.file : '';
    if (file === '') return [];
    const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : '';
    if (cwd === '') return [];
    // 走与编辑器事件完全相同的归一化与来源判定，避免两套口径。
    return normalizeEditorEvent({
        id: `session:${sessionId}:${Number.isInteger(event?.seq) ? event.seq : 0}`,
        cwd,
        file,
        at: Number.isInteger(event?.time) ? event.time : Date.now(),
        sessionId,
        runId: '',
        human: true,
        provenance,
    }, { humanEnabled: true });
}

/**
 * 归一化编辑器心跳（来自 `editor-inbox` 的已校验事件）。
 *
 * helper 只说"本地接入方声明了什么"，这里据此决定 source：
 * 只有 `human === true` 且启用人类采集时才标 human，其余一律 unknown——
 * 绝不从文件变更推断人工。
 *
 * @param event - 已通过 `validateEditorEvent` 的归一化事件。
 * @param options - { humanEnabled }。
 * @returns 观测数组（0 或 1）。
 */
export function normalizeEditorEvent(event, options = {}) {
    if (event === null || typeof event !== 'object') return [];
    if (typeof event.id !== 'string' || event.id === '') return [];
    const cwd = typeof event.cwd === 'string' ? event.cwd : '';
    if (cwd === '') return [];
    const human = event.human === true && options.humanEnabled === true;
    const at = Number.isInteger(event.at) ? event.at : Date.now();
    return [{
        id: `editor:${event.id}`,
        cwd,
        at,
        source: human ? 'human' : 'unknown',
        kind: 'file',
        sessionId: typeof event.sessionId === 'string' ? event.sessionId : '',
        runId: typeof event.runId === 'string' ? event.runId : '',
        file: typeof event.file === 'string' ? event.file : '',
        linesAdded: null,
        linesDeleted: null,
        project: path.basename(cwd),
    }];
}

/** 32 位字符串散列（仅用于稳定 id，不做安全用途）。 */
function hash32(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 时区本地日键（YYYY-MM-DD）。路由层按日分组展示时用。
 * @param timeMs - 毫秒时间戳。
 * @param timezone - IANA 时区。
 * @returns 本地日键。
 */
export function localDayKey(timeMs, timezone) {
    try {
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        const parts = formatter.formatToParts(new Date(timeMs));
        const pick = type => parts.find(part => part.type === type)?.value ?? '';
        const year = pick('year');
        const month = pick('month');
        const day = pick('day');
        if (year && month && day) return `${year}-${month}-${day}`;
    }
    catch {
        // 非法时区退 UTC，只影响分桶。
    }
    return new Date(timeMs).toISOString().slice(0, 10);
}

/**
 * 日键 → 该日本地零点毫秒。
 * @param dayKey - YYYY-MM-DD。
 * @param timezone - IANA 时区。
 * @returns 毫秒。
 */
export function dayKeyStartMs(dayKey, timezone) {
    const [year, month, day] = String(dayKey).split('-').map(Number);
    const utcGuess = Date.UTC(year, (month ?? 1) - 1, day ?? 1);
    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour12: false,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        let offsetMs = 0;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const current = utcGuess + offsetMs;
            const parts = formatter.formatToParts(new Date(current));
            const pick = type => Number(parts.find(part => part.type === type)?.value ?? 0);
            const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour') % 24, pick('minute'), pick('second'));
            offsetMs = asUtc - current;
        }
        return utcGuess - offsetMs;
    }
    catch {
        return utcGuess;
    }
}

/**
 * 区间并集长度（裁剪到 [fromMs, toMs]）。
 * @param intervals - [{ start, end }] 或 [{ startMs, endMs }]。
 * @param fromMs - 下限（含）。
 * @param toMs - 上限（不含）。
 * @returns 并集毫秒数。
 */
export function unionMs(intervals, fromMs, toMs) {
    if (!Array.isArray(intervals) || intervals.length === 0) return 0;
    const clamped = [];
    for (const raw of intervals) {
        const start = Math.max(Number(raw?.start ?? raw?.startMs ?? 0), fromMs);
        const end = Math.min(Number(raw?.end ?? raw?.endMs ?? 0), toMs);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        if (end > start) clamped.push({ start, end });
    }
    if (clamped.length === 0) return 0;
    clamped.sort((a, b) => a.start - b.start);
    let total = 0;
    let cursorStart = clamped[0].start;
    let cursorEnd = clamped[0].end;
    for (let index = 1; index < clamped.length; index += 1) {
        const item = clamped[index];
        if (item.start <= cursorEnd) {
            cursorEnd = Math.max(cursorEnd, item.end);
            continue;
        }
        total += cursorEnd - cursorStart;
        cursorStart = item.start;
        cursorEnd = item.end;
    }
    total += cursorEnd - cursorStart;
    return total;
}

/**
 * 把跨日区间切到各自的日里（**跨午夜两侧都要算**）。
 * @param intervals - [{ start, end }] 或 [{ startMs, endMs }]。
 * @param timezone - IANA 时区。
 * @param emit - (dayKey, ms) => void。
 */
export function splitByDay(intervals, timezone, emit) {
    for (const interval of intervals ?? []) {
        let cursor = Number(interval?.start ?? interval?.startMs ?? 0);
        const end = Number(interval?.end ?? interval?.endMs ?? 0);
        if (!Number.isFinite(cursor) || !Number.isFinite(end) || end <= cursor) continue;
        for (let guard = 0; guard < 400 && cursor < end; guard += 1) {
            const dayKey = localDayKey(cursor, timezone);
            const dayStart = dayKeyStartMs(dayKey, timezone);
            const sliceEnd = Math.min(end, dayStart + 86_400_000);
            if (sliceEnd > cursor) emit(dayKey, sliceEnd - cursor);
            if (sliceEnd <= cursor) break;
            cursor = sliceEnd;
        }
    }
}

/**
 * 解析 preset → 时间范围（含本地日键）。
 * @param query - { preset, from, to }。
 * @param timezone - IANA 时区。
 * @param timeMs - 当前时间。
 * @returns { preset, from, to, fromLocal, toLocal }。
 */
export function resolveRange(query = {}, timezone = 'UTC', timeMs = Date.now()) {
    const preset = typeof query.preset === 'string' ? query.preset : 'today';
    const todayKey = localDayKey(timeMs, timezone);
    let fromLocal = todayKey;
    let toLocal = todayKey;
    if (preset === 'week') {
        const todayStart = dayKeyStartMs(todayKey, timezone);
        const weekday = new Date(todayStart + 12 * 3600 * 1000).getUTCDay();
        const daysBack = weekday === 0 ? 6 : weekday - 1;
        fromLocal = localDayKey(todayStart - daysBack * 86_400_000, timezone);
    }
    else if (preset === 'all') {
        fromLocal = '1970-01-01';
        toLocal = todayKey;
    }
    else if (typeof query.from === 'string' && query.from !== '') {
        fromLocal = query.from;
        toLocal = typeof query.to === 'string' && query.to !== '' ? query.to : todayKey;
    }
    return {
        preset,
        from: new Date(dayKeyStartMs(fromLocal, timezone)).toISOString(),
        to: new Date(dayKeyStartMs(toLocal, timezone) + 86_400_000).toISOString(),
        fromLocal,
        toLocal,
    };
}

/**
 * 列出范围内日键（含首尾，带上限）。
 * @param fromLocal - 起始日键。
 * @param toLocal - 结束日键。
 * @param maxDays - 上限。
 * @returns 日键数组。
 */
export function enumerateDays(fromLocal, toLocal, maxDays = 400) {
    const keys = [];
    let cursor = fromLocal;
    for (let guard = 0; guard < maxDays; guard += 1) {
        keys.push(cursor);
        if (cursor >= toLocal) break;
        cursor = new Date(dayKeyStartMs(cursor, 'UTC') + 86_400_000).toISOString().slice(0, 10);
    }
    return keys;
}
