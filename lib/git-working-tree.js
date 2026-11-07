/**
 * dsh-coding-time · 只读 Git 工作区快照读取器。
 *
 * 纯读取：**绝不**写用户仓库、绝不 add/commit/reset/init、绝不保存 diff 正文或
 * 命令文本。只用 Node 内建 `execFile`（`shell:false`，参数数组直传，无 shell 注入面）
 * 调用 `git rev-parse` / `git status` / `git diff`。
 *
 * 语义边界（重要）：
 * - 只描述**当前工作区快照**，不代表 AI 或人工贡献，也不代表历史修改时间。
 * - 未跟踪文件、或仓库尚无 HEAD 时，行数**无法证实** → `null`，绝不是 0。
 * - 非 Git 仓库 / 缺 Git / 超时 / 输出过大 → 返回准确的 status，**不抛**，
 *   绝不让异常污染工时统计。
 *
 * 协议依据：git-scm.com 的 `git-status`（porcelain v1 + `-z`）与 `git-diff`
 * （`--numstat -z`）文档。
 *
 * @module dsh-coding-time/git-working-tree
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { DEFAULT_EXCLUDE } from './config.js';
import { isExcludedPath } from './activity.js';

/** 默认每命令超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 2000;

/** 默认单命令输出上限（字节）。 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** 默认文件条目上限。 */
const DEFAULT_MAX_ENTRIES = 1000;

/**
 * 只为本次调用设置的 Git 环境：
 * - `GIT_OPTIONAL_LOCKS=0`：读状态时不抢 index 锁、不刷新 index（**不写仓库**）。
 * - 已显式禁用以下已知机制：`core.fsmonitor=false`（不触发 fsmonitor 钩子）、
 *   `diff.external=`（外部 diff 程序）、以及 `git diff` 上的 `--no-ext-diff`
 *   `--no-textconv`（外部 diff 驱动与 textconv 过滤器）。`GIT_OPTIONAL_LOCKS=0`
 *   保证读状态时不为刷新索引而写仓库。
 *   这不等于"绝不执行仓库配置的任何程序"——Git 仍可能运行内置逻辑；这里只
 *   说明上述几类外部钩子/程序已被显式关闭。
 * - 禁分页、禁颜色、固定英文输出以便稳定解析。
 */
const GIT_ENV = Object.freeze({
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
    LANGUAGE: 'C',
});

/** `git -c` 强制参数：禁用一切可能执行外部程序或写索引的特性。 */
const GIT_SAFE_CONFIG = Object.freeze([
    '-c', 'core.fsmonitor=false',
    '-c', 'diff.external=',
    '-c', 'diff.noprefix=false',
    '-c', 'core.quotepath=false',
]);

/**
 * 状态码 → 语义。
 * porcelain v1 的 X（index）与 Y（worktree）两列。
 */
const STATUS_MAP = Object.freeze({
    '??': 'untracked',
    '!!': 'untracked',
    'DD': 'conflicted',
    'AU': 'conflicted',
    'UD': 'conflicted',
    'UA': 'conflicted',
    'DU': 'conflicted',
    'AA': 'conflicted',
    'UU': 'conflicted',
});

/**
 * 解析 `git status --porcelain=v1 -z` 输出。
 *
 * 格式（`-z` 下以 NUL 分隔记录，且**无**结尾换行）：
 * - 普通记录：`XY <path>`
 * - 重命名/复制：`XY <new>\0<old>`（`-z` 时新路径在前、旧路径紧随其后作为独立字段）
 *
 * @param raw - 原始 stdout 字符串。
 * @returns {Array<{path, oldPath, indexStatus, worktreeStatus, status}>}。
 */
export function parsePorcelainV1Z(raw) {
    if (typeof raw !== 'string' || raw === '') return [];
    const fields = raw.split('\u0000');
    /** @type {Array<object>} */
    const out = [];
    for (let index = 0; index < fields.length; index += 1) {
        const entry = fields[index];
        if (entry === undefined || entry === '') continue;
        // 记录至少要有 "XY " + 路径。
        if (entry.length < 4) continue;
        const indexStatus = entry.slice(0, 1);
        const worktreeStatus = entry.slice(1, 2);
        const pathText = entry.slice(3);
        if (pathText === '') continue;
        let status = STATUS_MAP[`${indexStatus}${worktreeStatus}`];
        if (status === undefined) {
            if (indexStatus === 'R' || worktreeStatus === 'R') status = 'renamed';
            else if (indexStatus === 'C' || worktreeStatus === 'C') status = 'copied';
            else if (indexStatus === 'A' || worktreeStatus === 'A') status = 'added';
            else if (indexStatus === 'D' || worktreeStatus === 'D') status = 'deleted';
            else if (indexStatus === 'U' || worktreeStatus === 'U') status = 'conflicted';
            else status = 'modified';
        }
        /** @type {string | null} */
        let oldPath = null;
        if (status === 'renamed' || status === 'copied') {
            // 紧随其后的字段是旧路径。
            const next = fields[index + 1];
            if (next !== undefined && next !== '') {
                oldPath = next;
                index += 1;
            }
        }
        out.push({ path: pathText, oldPath, indexStatus, worktreeStatus, status });
    }
    return out;
}

/**
 * 解析 `git diff --numstat -z` 输出。
 *
 * 格式（`-z`）：
 * - 普通：`<added>\t<deleted>\t<path>\0`
 * - 重命名：`<added>\t<deleted>\t\0<old>\0<new>\0`（路径字段前置空，**旧路径在前、新路径在后**）
 * - 二进制：`-\t-\t<path>`（记 `binary: true`，行数为 `null`）
 *
 * @param raw - 原始 stdout 字符串。
 * @returns {Map<string, {addedLines, deletedLines, binary, oldPath}>}，键为新路径。
 */
export function parseNumstatZ(raw) {
    /** @type {Map<string, {addedLines: number|null, deletedLines: number|null, binary: boolean, oldPath: string|null}>} */
    const map = new Map();
    if (typeof raw !== 'string' || raw === '') return map;
    const fields = raw.split('\u0000');
    for (let index = 0; index < fields.length; index += 1) {
        const entry = fields[index];
        if (entry === undefined || entry === '') continue;
        // 每项至少 "A\tD\t" 三段。
        const firstTab = entry.indexOf('\t');
        const secondTab = firstTab === -1 ? -1 : entry.indexOf('\t', firstTab + 1);
        if (firstTab === -1 || secondTab === -1) continue;
        const addedRaw = entry.slice(0, firstTab);
        const deletedRaw = entry.slice(firstTab + 1, secondTab);
        const pathField = entry.slice(secondTab + 1);
        const binary = addedRaw === '-' && deletedRaw === '-';
        let addedLines = binary ? null : toLineCount(addedRaw);
        let deletedLines = binary ? null : toLineCount(deletedRaw);
        /** @type {string | null} */
        let oldPath = null;
        let filePath = pathField;
        if (pathField === '') {
            // 重命名：Git 的真实顺序是 **旧路径在前、新路径在后**。
            // （porcelain status -z 才是 new\0old；两者顺序不同，不能混用。）
            const next = fields[index + 1];
            const after = fields[index + 2];
            if (next !== undefined && next !== '') {
                oldPath = next;
                index += 1;
            }
            if (after !== undefined && after !== '') {
                // Map 的键必须是**新路径**，这样按 status 的 new path 才能匹配到行数。
                filePath = after;
                index += 1;
            }
        }
        if (filePath === '') continue;
        map.set(filePath, { addedLines, deletedLines, binary, oldPath });
        void addedLines;
        void deletedLines;
    }
    return map;
}

/**
 * 把 numstat 的计数字段转成数字；非数字（含 `-`）→ null。
 * @param text - 原始字段。
 * @returns 数字或 null。
 */
function toLineCount(text) {
    if (typeof text !== 'string' || text === '') return null;
    const value = Number(text);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 校验并规范化项目路径：必须是非空、绝对、存在的目录语义。
 *
 * **绝不**在非法输入时退回 cwd 去扫任意目录。
 *
 * @param project - 调用方给的项目路径。
 * @returns 规范化绝对路径。
 * @throws 当不是绝对路径或为空时。
 */
function normalizeProject(project) {
    if (typeof project !== 'string' || project.trim() === '') {
        const failure = new Error('project 必须是非空字符串路径');
        failure.code = 'invalid_project';
        throw failure;
    }
    const raw = project.trim();
    if (raw.includes('\u0000')) {
        const failure = new Error('project 不能包含 NUL');
        failure.code = 'invalid_project';
        throw failure;
    }
    if (!path.isAbsolute(raw)) {
        // 退回 cwd 会扫描任意目录：明确拒绝。
        const failure = new Error('project 必须是绝对路径（不会退回当前工作目录）');
        failure.code = 'invalid_project';
        throw failure;
    }
    return path.normalize(raw);
}

/**
 * 运行一条只读 git 命令。
 *
 * @param args - 参数数组（不含 `git` 本体）。
 * @param cwd - 工作目录（已校验的绝对项目路径）。
 * @param options - { timeoutMs, maxBytes }。
 * @returns {Promise<{ok: true, stdout: string} | {ok: false, reason: string}>}。
 */
function runGit(args, cwd, options) {
    const timeoutMs = Number.isInteger(options?.timeoutMs) && options.timeoutMs > 0
        ? Math.min(options.timeoutMs, 30_000)
        : DEFAULT_TIMEOUT_MS;
    const maxBytes = Number.isInteger(options?.maxBytes) && options.maxBytes > 0
        ? Math.min(options.maxBytes, 16 * 1024 * 1024)
        : DEFAULT_MAX_BYTES;
    return new Promise((resolve) => {
        let settled = false;
        /** 完成一次就忽略后续（超时与 close 可能竞争）。 */
        const finish = (value) => {
            if (settled === true) return;
            settled = true;
            resolve(value);
        };
        let child;
        try {
            child = execFile(
                'git',
                [...GIT_SAFE_CONFIG, ...args],
                {
                    cwd,
                    shell: false,          // 无 shell，杜绝注入
                    timeout: timeoutMs,
                    maxBuffer: maxBytes,
                    windowsHide: true,
                    env: { ...process.env, ...GIT_ENV },
                },
                (error, stdout) => {
                    if (error !== null && error !== undefined) {
                        const code = typeof error.code === 'string' ? error.code : '';
                        if (code === 'ENOENT') return finish({ ok: false, reason: 'git_missing' });
                        if (error.killed === true || code === 'ETIMEDOUT') return finish({ ok: false, reason: 'timeout' });
                        // 128 等非零退出：由调用方按上下文判定（可能是非仓库）。
                        return finish({ ok: false, reason: 'git_failed', exitCode: error.code });
                    }
                    return finish({ ok: true, stdout: String(stdout ?? '') });
                },
            );
        }
        catch (error) {
            const code = typeof error?.code === 'string' ? error.code : '';
            if (code === 'ENOENT') return finish({ ok: false, reason: 'git_missing' });
            return finish({ ok: false, reason: 'git_failed' });
        }
        // 兜底：极端情况下回调不触发。
        if (child !== undefined && child !== null && typeof child.on === 'function') {
            child.on('error', (error) => {
                if (typeof error?.code === 'string' && error.code === 'ENOENT') {
                    finish({ ok: false, reason: 'git_missing' });
                }
                else {
                    finish({ ok: false, reason: 'git_failed' });
                }
            });
        }
    });
}

/**
 * 读取一个项目的 Git 工作区快照（**只读**）。
 *
 * @param project - 项目绝对路径（不接受相对路径，不会退回 cwd）。
 * @param options - { exclude?: string[], timeoutMs?: number, maxEntries?: number }。
 * @returns 固定契约对象；任何异常路径都返回准确 status，不抛。
 */
export async function scanGitWorkingTree(project, options = {}) {
    const observedAt = new Date().toISOString();
    /** 所有失败都收敛成这个形状，绝不抛出污染统计。 */
    const failed = (status, reason) => ({
        project: typeof project === 'string' ? project : '',
        repoRoot: null,
        status,
        reason,
        observedAt,
        truncated: false,
        files: [],
    });

    // ① 路径校验：非法立即返回，绝不退回 cwd。
    let cwd;
    try {
        cwd = normalizeProject(project);
    }
    catch (error) {
        return failed('unavailable', error?.code ?? 'invalid_project');
    }

    const exclude = Array.isArray(options?.exclude) && options.exclude.length > 0
        ? options.exclude
        : DEFAULT_EXCLUDE;
    const maxEntries = Number.isInteger(options?.maxEntries) && options.maxEntries > 0
        ? Math.min(options.maxEntries, 50_000)
        : DEFAULT_MAX_ENTRIES;
    const runOptions = { timeoutMs: options?.timeoutMs, maxBytes: options?.maxBytes };

    // ② 定位仓库根。
    const revParse = await runGit(['rev-parse', '--show-toplevel'], cwd, runOptions);
    if (revParse.ok !== true) {
        // 128 = 不是仓库；其它按不可用处理。
        if (revParse.reason === 'git_failed' && revParse.exitCode === 128) {
            return failed('not_git', 'not_a_repository');
        }
        return failed('unavailable', revParse.reason ?? 'git_unavailable');
    }
    const repoRoot = revParse.stdout.trim();
    if (repoRoot === '') return failed('not_git', 'not_a_repository');

    // ③ 状态。
    const statusRun = await runGit(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        repoRoot,
        runOptions,
    );
    if (statusRun.ok !== true) return failed('unavailable', statusRun.reason ?? 'status_failed');

    // ④ 行数（相对 HEAD 的净差异）。
    const numstatRun = await runGit(
        ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', 'HEAD'],
        repoRoot,
        runOptions,
    );
    // 无 HEAD（空仓库）时 numstat 不可用：这是正常的，不是错误。
    const numstat = numstatRun.ok === true ? parseNumstatZ(numstatRun.stdout) : new Map();
    const hasHead = numstatRun.ok === true;

    // ⑤ 组装 + 隐私过滤。
    const parsed = parsePorcelainV1Z(statusRun.stdout);
    const files = [];
    let truncated = false;
    for (const entry of parsed) {
        const filePath = entry.path;
        // 新旧路径都过 exclude（重命名的旧路径同样不该出现）。
        if (isExcludedPath(filePath, exclude)) continue;
        if (entry.oldPath !== null && isExcludedPath(entry.oldPath, exclude)) continue;
        if (files.length >= maxEntries) {
            truncated = true;
            break;
        }
        const stat = numstat.get(filePath);
        // 未跟踪、无 HEAD、或 numstat 未覆盖 → 行数 null（无法证实，绝不是 0）。
        const addedLines = stat === undefined ? null : stat.addedLines;
        const deletedLines = stat === undefined ? null : stat.deletedLines;
        files.push({
            path: filePath,
            oldPath: entry.oldPath,
            status: entry.status,
            indexStatus: entry.indexStatus,
            worktreeStatus: entry.worktreeStatus,
            addedLines,
            deletedLines,
            binary: stat === undefined ? false : stat.binary === true,
        });
    }

    void hasHead;
    return {
        project: cwd,
        repoRoot,
        status: 'ok',
        observedAt,
        truncated,
        files,
    };
}

/** 供测试与上层使用的限制常量（只读快照）。 */
export const GIT_READER_LIMITS = Object.freeze({
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    defaultMaxBytes: DEFAULT_MAX_BYTES,
    defaultMaxEntries: DEFAULT_MAX_ENTRIES,
});
