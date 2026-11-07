/**
 * dsh-coding-time · Host 装配。
 *
 * 唯一职责：**接线**。计时由 `ActivityTracker`，持久化由 `JsonlStore`，归一化由
 * `collector`，HTTP 由 `routes`。这里不重复任何一条口径。
 *
 * ## 缓冲批处理（`flushIntervalSeconds` 真实生效）
 *
 * 每个 chunk / 每次文件工具结果只把**最小归一化观测**推进内存缓冲（不含正文），
 * 绝不逐条写盘。统一在下列时机 drain 成一批，单次 project 锁事务：
 * 周期定时器（`flushIntervalSeconds`）、`session/flush`、summary/export 前、dispose。
 * 100 个 chunk 在 flush 前只产生**一次** state 提交。
 *
 * 定时器只做 checkpoint，**绝不**据它产生时间观测；时间只来自真实事件的 `at`
 * 与 `ActivityTracker` 自己的 idle/节流逻辑。
 *
 * ## run epoch（不跨 run 自动连线）
 *
 * `agent/status: idle` / `agent/disposed` / `session/disposed` 只**切段**：把该会话的
 * run epoch 递增并标记"下次真实活动换新 runId"。这样用户停止后 60 秒内又继续，
 * 即使间隔 < idle 阈值也不会被旧 open 记录连成一段。`running` 本身不计时，只重置
 * epoch（重复 running 不重复换）。epoch 在**入缓冲那一刻**确定，drain 时不再改。
 *
 * ## apply 的时序契约
 *
 * `apply` 是**同步函数**：在第一个 await 之前完成配置校验、事件订阅、根 scope
 * 订阅与单个 `ctx.effect` 释放器注册，然后返回 `initPromise`。无论宿主 await 与否
 * 都不会错过早期事件。
 *
 * ## 失败语义
 *
 * 模块/peer/存储失败 → 显式报错并停采。配置非法 → 同步抛。批入账失败**不静默丢**：
 * 记录告警并把该批退回缓冲重试（stable id 保证幂等）。
 *
 * @module dsh-coding-time/index
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ConfigError,
    DEFAULT_CONFIG,
    LIMITS,
    defaultStorageDirectory,
    normalizeConfig,
} from './config.js';
import {
    normalizeEditorEvent,
    normalizeProgress,
    normalizeSessionEvent,
    normalizeToolResult,
    resolveRange,
} from './collector.js';
import { ActivityTracker } from './activity.js';
import { JsonlStore } from './store.js';
import { mountRoutes, ROUTE_PREFIX } from './routes.js';
import { scanGitWorkingTree } from './git-working-tree.js';

export const name = 'dsh-coding-time';

/** 无硬依赖：每个服务都 `ctx.get` + 判空。缺一个不该让插件整块消失。 */
export const inject = [];

/** 插件自身目录（排除自污染）。 */
const PLUGIN_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/** 合法 profile 名（与 store.js 一致）。 */
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 设置命名空间：**只**精确匹配当前 entry id。 */
const NS_EXACT = Object.freeze(['dsh-coding-time', 'include:dsh-coding-time']);

/** 单批上限：超过则分多次事务，避免一次锁内跑太久。 */
const MAX_BATCH_OBSERVATIONS = 512;

/** 缓冲上限：超过即告警并强制 drain（显式 backpressure）。 */
const MAX_BUFFER_OBSERVATIONS = 4096;

/** Config 字段（与 config.js 合法键一一对应）。 */
export const CONFIG_FIELD_KEYS = Object.freeze([
    'enabled',
    'heartbeatIntervalSeconds',
    'idleThresholdSeconds',
    'flushIntervalSeconds',
    'trackAgentActivity',
    'trackAiLines',
    'humanTracking',
    'storageDirectory',
    'timezone',
    'weekStartsOn',
    'exclude',
]);

/** 进程启动时刻（拼 runId 用）。 */
const startedAt = Date.now();

/** 载入 schemastery（缺失信息保留，供 apply 明确报错）。 */
const schemasteryLoad = await (async () => {
    try {
        const module = await import('@deepseek-ai/schemastery');
        const z = module?.default ?? module;
        if (typeof z?.object !== 'function') {
            const failure = new Error('@deepseek-ai/schemastery 导出了非法形态（缺少 object()）');
            failure.code = 'invalid_schemastery';
            return { z: null, error: failure };
        }
        return { z, error: null };
    }
    catch (error) {
        const failure = new Error(
            '@deepseek-ai/schemastery 未安装：本插件的设置表单依赖它。请在 profile 中安装该 peer 依赖。'
            + `（原始错误：${error instanceof Error ? error.message : String(error)}）`,
        );
        failure.code = 'missing_schemastery';
        return { z: null, error: failure };
    }
})();

/** 测试注入真实 schemastery 的入口（生产不调用）。 */
let schemaOverride = null;

/**
 * 注入 schemastery 实现（必须是真实现，否则抛）。
 * @param provider - schemastery 命名空间或 null。
 */
export function useSchemaProvider(provider) {
    if (provider === null) {
        schemaOverride = null;
        return;
    }
    if (typeof provider?.object !== 'function') {
        const failure = new Error('注入的 schema provider 不是合法 schemastery（缺少 object()）');
        failure.code = 'invalid_schemastery';
        throw failure;
    }
    schemaOverride = provider;
}

/** 当前生效的 schemastery。 */
function schemaSource() {
    if (schemaOverride !== null) return { z: schemaOverride, error: null };
    return schemasteryLoad;
}

/**
 * 用真实 schemastery 构建 Config，并强制与 `normalizeConfig` 同口径。
 *
 * 真实 schemastery 不拒未知字段、`min/max` 只是 UI 元数据。若直接交给宿主，设置页
 * 会"保存成功"、`apply` 时再失败。所以用 **Proxy** 转发全部 schema 身份
 * （`meta`/`type`/`dict`/符号标记），只在调用/构造时走 `normalizeConfig`。
 *
 * @param z - schemastery 命名空间。
 * @returns 严格化的 schema（Proxy）。
 */
/**
 * 真正支持**热生效**的字段（宿主 Settings 的 `applies:'live'` 对应
 * `x-cordis.volatile`）。
 *
 * 只有这些字段被标 `volatile()`；其余（`storageDirectory`）需要重建 store，
 * 属**冷字段**，绝不标 volatile——否则会把"改了但没生效"伪装成可编辑。
 */
export const LIVE_FIELDS = Object.freeze([
    'enabled',
    'heartbeatIntervalSeconds',
    'idleThresholdSeconds',
    'flushIntervalSeconds',
    'trackAgentActivity',
    'trackAiLines',
    'humanTracking',
    'timezone',
    'weekStartsOn',
    'exclude',
]);

/**
 * 需要重启才能生效的字段（只读展示，不参与 live patch）。
 *
 * 改目录要切存储根、迁移/重建 store，无法在运行中安全完成，所以明确声明为
 * `requiresRestart`，而不是假装可热改。元数据同时通过 `/config` 暴露给前端。
 */
export const COLD_FIELDS = Object.freeze([
    { name: 'storageDirectory', requiresRestart: true, reason: '切换存储目录需要重建存储，保存后会提示重启' },
]);

/**
 * 解包 schemastery 的 `Volatile<T>` 包装。
 *
 * `volatile()` 解析后会把值包成 `{ get() }`（`cosmokit.isVolatile` 可识别）。
 * 校验与业务读取都必须先取真实值，否则 boolean/number 位置会拿到对象。
 *
 * @param value - 可能被包装的值。
 * @returns 解包后的真实值（未包装则原样返回）。
 */
export function unwrapVolatile(value) {
    if (value === null || typeof value !== 'object') return value;
    // 递归解包嵌套对象（如 humanTracking）。
    if (Array.isArray(value)) return value.map(item => unwrapVolatile(item));
    if (typeof value.get === 'function') {
        // **不吞 getter 失败**：读不出来说明宿主值已坏，必须把原错误抛出去，
        // 绝不能悄悄当成默认值（那会把坏配置伪装成"正常启动"）。
        return unwrapVolatile(value.get());
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    let changed = false;
    for (const [key, inner] of Object.entries(value)) {
        // 嵌套对象也要递归解包（如 humanTracking.enabled 被 wrap）。
        const unwrapped = inner !== null && typeof inner === 'object' ? unwrapVolatile(inner) : inner;
        if (unwrapped !== inner) changed = true;
        out[key] = unwrapped;
    }
    return changed === true ? out : value;
}

/**
 * 判断一个值是否被 volatile 包装（不调用 get，仅结构判定）。
 * @param value - 任意值。
 * @returns 是否包装。
 */
export function isVolatileValue(value) {
    return value !== null && typeof value === 'object' && typeof value.get === 'function';
}

export function buildConfigSchema(z) {
    // **live 字段用 `.volatile()` 声明**：宿主 Settings 据此生成可编辑表单
    // （对应 `x-cordis: { volatile: true }`，与 `SettingsDescriptor.applies:'live'`）。
    // 冷字段（storageDirectory）**绝不**标 volatile。
    const base = z.object({
        enabled: z.boolean().default(DEFAULT_CONFIG.enabled).description('采集总开关').volatile(),
        heartbeatIntervalSeconds: z.number().min(LIMITS.heartbeatIntervalSeconds.min).max(LIMITS.heartbeatIntervalSeconds.max)
            .default(DEFAULT_CONFIG.heartbeatIntervalSeconds)
            .description('记录节流上限（秒）；不产生心跳，只约束开新记录的频率')
            .volatile(),
        idleThresholdSeconds: z.number().min(LIMITS.idleThresholdSeconds.min).max(LIMITS.idleThresholdSeconds.max)
            .default(DEFAULT_CONFIG.idleThresholdSeconds)
            .description('超过该秒数没有真实进展即断段（必须 ≥ heartbeatIntervalSeconds）')
            .volatile(),
        flushIntervalSeconds: z.number().min(LIMITS.flushIntervalSeconds.min).max(LIMITS.flushIntervalSeconds.max)
            .default(DEFAULT_CONFIG.flushIntervalSeconds)
            .description('批量落盘周期（秒）')
            .volatile(),
        trackAgentActivity: z.boolean().default(DEFAULT_CONFIG.trackAgentActivity)
            .description('是否统计 AI 活动时长（关闭后仍统计文件与行数证据）')
            .volatile(),
        trackAiLines: z.boolean().default(DEFAULT_CONFIG.trackAiLines)
            .description('是否统计 AI 增删行（仅限可信 diff 元数据）')
            .volatile(),
        // schemastery 禁止嵌套 volatile：外层 object **不能**标 volatile，
        // 只让内层 live 字段带标记（否则 validateVolatileSchema 直接抛）。
        humanTracking: z.object({
            enabled: z.boolean().default(DEFAULT_CONFIG.humanTracking.enabled)
                .description('是否采集人工编码时长（需要显式真实输入来源）')
                .volatile(),
        }).description('人工编码时长采集'),
        // 冷字段：不标 volatile，只读展示；保存需重启（requiresRestart）。
        storageDirectory: z.string().default(defaultStorageDirectory())
            .description('本地存储目录（默认 ~/.dsh/coding-time）。切换需重启后生效'),
        timezone: z.string().default(DEFAULT_CONFIG.timezone).description('统计所用 IANA 时区').volatile(),
        weekStartsOn: z.number().min(0).max(6).default(DEFAULT_CONFIG.weekStartsOn)
            .description('周起始日：0=周日，1=周一')
            .volatile(),
        exclude: z.array(z.string()).default([...DEFAULT_CONFIG.exclude])
            .description('不计入统计的路径片段 / 文件名 glob')
            .volatile(),
    });
    const described = typeof base.description === 'function'
        ? base.description('AI 与人工编码活动时长、行数统计（全部数据仅存本机）')
        : base;
    return new Proxy(described, {
        apply(target, thisArg, args) {
            // 宿主拿到的是**原始** schemastery 结果（保留 volatile 包装身份，
            // 否则 Settings 无法识别 live 字段）。校验只对解包后的快照做。
            const value = Reflect.apply(target, thisArg, args);
            normalizeConfig(unwrapVolatile(value));
            return value;
        },
        construct(target, args, newTarget) {
            const value = Reflect.construct(target, args, newTarget);
            normalizeConfig(unwrapVolatile(value));
            return value;
        },
    });
}

const activeSchema = schemaSource();
export const Config = activeSchema.z === null ? undefined : buildConfigSchema(activeSchema.z);

/**
 * 解析 profile 名。顺序：显式 → DSH_PROFILE → default；非法直接抛。
 * @param explicit - 配置里的 profile。
 * @param environment - 环境变量来源。
 * @returns 合法 profile 名。
 */
export function resolveProfile(explicit, environment = process.env) {
    const candidate = typeof explicit === 'string' && explicit !== ''
        ? explicit
        : (typeof environment?.DSH_PROFILE === 'string' && environment.DSH_PROFILE !== ''
            ? environment.DSH_PROFILE
            : 'default');
    if (PROFILE_PATTERN.test(candidate) === false || candidate.startsWith('.')) {
        const failure = new Error(`profile 名非法（${JSON.stringify(candidate)}）：只允许 [A-Za-z0-9._-]，不得以点开头`);
        failure.code = 'E_PROFILE_INVALID';
        throw failure;
    }
    return candidate;
}

/**
 * 精确查找本插件设置命名空间（绝不按形状猜测别的插件）。
 * @param settings - settings 服务。
 * @returns { ns, revision } 或 null。
 */
export function locateNamespace(settings) {
    if (settings === null || typeof settings !== 'object' || typeof settings.describe !== 'function') return null;
    let descriptors;
    try {
        descriptors = settings.describe();
    }
    catch {
        return null;
    }
    if (!Array.isArray(descriptors)) return null;
    for (const candidate of descriptors) {
        if (typeof candidate?.ns !== 'string') continue;
        if (NS_EXACT.includes(candidate.ns) === false) continue;
        return { ns: candidate.ns, revision: Number.isInteger(candidate.revision) ? candidate.revision : null };
    }
    return null;
}

/**
 * 只挑出 live 字段（避免宿主值里的未知键混进配置）。
 * @param value - 解包后的宿主配置。
 * @returns 仅含 live 字段的对象。
 */
function mergeLiveOnly(value) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of LIVE_FIELDS) {
        if (value[key] !== undefined) out[key] = value[key];
    }
    return out;
}

/** 项目键规范化（与 activity.projectKeyOf 同义）。 */
function normalizeProjectKey(value) {
    const raw = String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? raw.toLowerCase() : raw;
}

/** 本地日键。 */
function localDayKeyOf(timeMs, timezone) {
    try {
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
        const parts = formatter.formatToParts(new Date(timeMs));
        const pick = type => parts.find(part => part.type === type)?.value ?? '';
        const year = pick('year');
        const month = pick('month');
        const day = pick('day');
        if (year && month && day) return `${year}-${month}-${day}`;
    }
    catch {
        // 非法时区退 UTC。
    }
    return new Date(timeMs).toISOString().slice(0, 10);
}

/** 该时区某日零点毫秒。 */
function dayKeyStartMs(dayKey, timezone) {
    const [year, month, day] = String(dayKey).split('-').map(Number);
    const utcGuess = Date.UTC(year, (month ?? 1) - 1, day ?? 1);
    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
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

/** 区间按本地日切开（跨午夜两侧都算）。 */
function splitByDayRange(startMs, endMs, timezone) {
    /** @type {Array<[string, number]>} */
    const out = [];
    let cursor = startMs;
    for (let guard = 0; guard < 400 && cursor < endMs; guard += 1) {
        const dayKey = localDayKeyOf(cursor, timezone);
        const sliceEnd = Math.min(endMs, dayKeyStartMs(dayKey, timezone) + 86_400_000);
        if (sliceEnd > cursor) out.push([dayKey, sliceEnd - cursor]);
        if (sliceEnd <= cursor) break;
        cursor = sliceEnd;
    }
    return out;
}

/** 区间并集长度。 */
function unionMs(intervals, fromMs, toMs) {
    const clamped = [];
    for (const raw of intervals ?? []) {
        const start = Math.max(Number(raw?.start ?? 0), fromMs);
        const end = Math.min(Number(raw?.end ?? 0), toMs);
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

/** 真实存储规模统计（真实行数，不估算）。 */
async function inspectStorage(root) {
    const { readdir, stat } = await import('node:fs/promises');
    const result = { projects: 0, journalShards: 0, records: 0, bytes: 0 };
    let entries = [];
    try {
        entries = await readdir(path.join(root, 'projects'));
    }
    catch {
        entries = [];
    }
    for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
            result.projects += 1;
            result.bytes += (await stat(path.join(root, 'projects', entry))).size;
        }
        catch {
            // 跳过读不到的文件。
        }
    }
    let shards = [];
    try {
        shards = await readdir(path.join(root, 'journal'));
    }
    catch {
        shards = [];
    }
    for (const entry of shards) {
        if (!entry.endsWith('.jsonl')) continue;
        try {
            const info = await stat(path.join(root, 'journal', entry));
            result.journalShards += 1;
            result.bytes += info.size;
            result.records += countLines(path.join(root, 'journal', entry));
        }
        catch {
            // 同上。
        }
    }
    return result;
}

/** 真实逐行计数。 */
function countLines(filePath) {
    try {
        const text = readFileSync(filePath, 'utf8');
        let count = 0;
        for (let index = 0; index < text.length; index += 1) {
            if (text.charCodeAt(index) === 10) count += 1;
        }
        return count;
    }
    catch {
        return 0;
    }
}

/**
 * 挂载插件。**同步注册，返回 initPromise。**
 *
 * @param ctx - cordis 上下文。
 * @param rawConfig - 宿主解析后的 Config。
 * @returns initPromise。
 */

export function apply(ctx, rawConfig) {
    const logger = ctx?.logger;

    // ① schemastery：缺失即同步失败。
    const schema = schemaSource();
    if (schema.error !== null) {
        logger?.error?.(`[dsh-coding-time] 设置依赖不可用，已拒绝启动：${schema.error.message}`);
        throw schema.error;
    }

    // ② 配置：非法即同步抛（不猜默认值、不假装 enabled）。
    // **入口必须解包 volatile**：宿主把 Config schema 的解析产物（live 字段是
    // `Volatile<T>` 包装 `{get()}`）原样传进来，不解包就会得到
    // "heartbeatIntervalSeconds: 必须是有限数字（收到 object）"。
    const configInput = unwrapVolatile(rawConfig ?? {}) ?? {};
    const configOnly = { ...configInput };
    // `profile` 是存储分区名，不是 Config 字段：先剥离再走严格校验
    // （保留对未知字段的 strictness，不移除其它键）。
    delete configOnly.profile;
    let config;
    try {
        config = normalizeConfig(configOnly);
    }
    catch (error) {
        const detail = error instanceof ConfigError ? `${error.path || 'config'}: ${error.message}` : String(error);
        logger?.error?.(`[dsh-coding-time] 配置非法，已拒绝启动采集：${detail}`);
        throw error;
    }

    const profile = resolveProfile(configInput.profile, process.env);
    const requestedDirectory = config.storageDirectory !== '' ? config.storageDirectory : defaultStorageDirectory();
    const effectiveDirectory = path.resolve(requestedDirectory).toLowerCase() === path.resolve(process.cwd()).toLowerCase()
        ? defaultStorageDirectory()
        : requestedDirectory;
    if (effectiveDirectory !== requestedDirectory) {
        logger?.warn?.('[dsh-coding-time] storageDirectory 指向当前工作目录；统计存储不应跟随项目，已改用 ~/.dsh/coding-time');
    }

    /** 生命周期闸门。 */
    let closing = false;
    /** 就绪标记。 */
    let ready = false;
    let readyFailure = null;

    const store = new JsonlStore({
        directory: effectiveDirectory,
        profile,
        heartbeatIntervalSeconds: config.heartbeatIntervalSeconds,
        flushIntervalSeconds: config.flushIntervalSeconds,
    });

    // ③ 缓冲与串行链（任何 await 之前定义）。
    /** @type {Array<object>} 最小归一化观测（无正文）。 */
    let buffer = [];
    /** @type {Promise<void>} 串行链。 */
    let chain = Promise.resolve();
    let chainBusy = 0;
    let bufferWarned = false;

    /** 人类来源证据（真实发生过 human 观测才算 connected）。 */
    let humanSeen = false;

    const humanStatusOf = () => {
        if (config.humanTracking?.enabled !== true) return { humanStatus: 'disabled', reason: 'human_tracking_off' };
        if (humanSeen === true) return { humanStatus: 'connected', reason: 'editor_evidence' };
        return { humanStatus: 'not_connected', reason: 'no_editor_evidence' };
    };

    /** 把任务接到串行链。 */
    const serialize = (task) => {
        chainBusy += 1;
        const next = chain.then(task, task).finally(() => {
            chainBusy -= 1;
        });
        chain = next.catch(() => {});
        return next;
    };

    /**
     * 单批入账：**唯一**写盘入口。
     *
     * 一批里同一 project 只拿一次锁；锁内读 state → 恢复 tracker → observe →
     * 写 state（先）→ append（后）。失败把该批退回缓冲重试（stable id 幂等）。
     *
     * @param batch - 观测数组。
     * @returns { accepted, projects, failed }。
     */
    const ingestBatch = async (batch) => {
        if (config.enabled !== true) return { accepted: 0, projects: 0, failed: false };
        if (batch.some(observation => String(observation?.source ?? '') === 'human')) humanSeen = true;

        /** @type {Map<string, object[]>} */
        const byProject = new Map();
        for (const observation of batch) {
            if (observation === null || typeof observation !== 'object') continue;
            const key = String(observation.cwd ?? '');
            if (key === '') continue;
            const list = byProject.get(key);
            if (list === undefined) byProject.set(key, [observation]);
            else list.push(observation);
        }
        let accepted = 0;
        let failed = false;
        for (const [projectKey, projectBatch] of byProject) {
            try {
                const taken = await store.withProjectLock(projectKey, async () => {
                    const snapshot = await store.readProjectState(projectKey, { raw: true });
                    const tracker = new ActivityTracker(config, { state: snapshot ?? undefined });
                    let count = 0;
                    for (const observation of projectBatch) {
                        const verdict = tracker.observe(observation);
                        if (verdict?.accepted === true) count += 1;
                    }
                    const records = tracker.snapshot().records;
                    // 先写 state（权威），再 append（幂等事件流）。
                    await store.writeProjectState(projectKey, tracker.exportState());
                    if (records.length > 0) await store.append(records);
                    return count;
                });
                accepted += Number.isInteger(taken) ? taken : 0;
            }
            catch (error) {
                failed = true;
                const code = typeof error?.code === 'string' ? error.code : 'ingest_failed';
                logger?.warn?.(`[dsh-coding-time] 项目入账失败（${projectKey}，${code}）：${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return { accepted, projects: byProject.size, failed };
    };

    /**
     * 把缓冲 drain 成**有限次数**事务。
     *
     * @returns { drained, accepted, failed }。
     */
    const drainBuffer = async () => {
        let drained = 0;
        let accepted = 0;
        let failed = false;
        while (buffer.length > 0) {
            const batch = buffer.splice(0, MAX_BATCH_OBSERVATIONS);
            drained += batch.length;
            const result = await ingestBatch(batch);
            accepted += result.accepted;
            if (result.failed === true) {
                // 失败批退回缓冲，靠 stable id 幂等重试；不静默丢。
                failed = true;
                buffer.unshift(...batch);
                if (buffer.length > MAX_BUFFER_OBSERVATIONS) {
                    // 明显积压：丢最旧并显式告警（不假装成功）。
                    const dropped = buffer.splice(0, buffer.length - MAX_BUFFER_OBSERVATIONS);
                    logger?.error?.(`[dsh-coding-time] 缓冲溢出，丢弃 ${dropped.length} 条观测（存储持续不可用）`);
                    bufferWarned = true;
                }
                break;
            }
        }
        return { drained, accepted, failed };
    };

    /**
     * 观测入口：只入缓冲，不做任何 IO。
     *
     * 超上限时**同步**触发一次 drain（显式 backpressure），不无限积压。
     *
     * @param observations - 归一化观测数组。
     */
    const enqueue = (observations) => {
        if (closing === true || observations.length === 0) return;
        buffer.push(...observations);
        if (buffer.length > MAX_BUFFER_OBSERVATIONS && bufferWarned === false) {
            bufferWarned = true;
            logger?.warn?.(`[dsh-coding-time] 缓冲达到 ${buffer.length} 条，启动强制 drain（存储可能变慢）`);
            void serialize(drainBuffer).catch(() => {});
        }
    };

    // ④ 会话 cwd 的唯一来源：workingDirectory.get(session)。
    const cwdOf = (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
        const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined;
        if (typeof sessions?.get !== 'function' || typeof workingDirectory?.get !== 'function') return undefined;
        let session;
        try {
            session = sessions.get(sessionId);
        }
        catch {
            return undefined;
        }
        if (session === undefined || session === null) return undefined;
        try {
            const directory = workingDirectory.get(session);
            return typeof directory === 'string' && directory !== '' ? directory : undefined;
        }
        catch {
            return undefined;
        }
    };

    const hostNonce = `${process.pid}-${startedAt}`;

    /**
     * run epoch：同一会话每次"停止→再开始"换新 runId，避免跨 run 自动连线。
     * epoch 在**入缓冲那一刻**取值，drain 时不再改变。
     */
    const runEpochs = new Map();
    /** epoch 表上限：只保留最近活跃的会话，避免无限增长。 */
    const MAX_EPOCH_ENTRIES = 2048;
    /** 淘汰最旧条目（Map 保持插入顺序）。 */
    const trimEpochs = () => {
        while (runEpochs.size > MAX_EPOCH_ENTRIES) {
            const oldest = runEpochs.keys().next();
            if (oldest.done === true) break;
            runEpochs.delete(oldest.value);
        }
    };
    /** 切段标记：下一次真实活动换新 epoch（不产生观测）。 */
    const markBreak = (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId === '') return;
        const current = runEpochs.get(sessionId);
        if (current === undefined) {
            runEpochs.set(sessionId, { epoch: 0, pendingBreak: true });
            return;
        }
        current.pendingBreak = true;
    };
    /**
     * 会话销毁：把 epoch 推到下一个值。
     *
     * **不是**简单 delete——删掉会让下次同 id 回到 epoch 0，与销毁前的旧 open
     * 记录同 runId，于是被 tracker 自动续段（正是要避免的跨 run 连线）。
     * 这里推进 epoch 并清掉切段标记：同 id 再出现立即用新 run。
     */
    const retireEpoch = (sessionId) => {
        const current = runEpochs.get(sessionId);
        runEpochs.set(sessionId, {
            epoch: current === undefined ? 1 : current.epoch + 1,
            pendingBreak: false,
        });
        trimEpochs();
    };

    /** 取用于本次观测的 runId：若标记了切段，先换 epoch。 */
    const consumeRunId = (sessionId) => {
        const entry = runEpochs.get(sessionId);
        if (entry === undefined) {
            runEpochs.set(sessionId, { epoch: 0, pendingBreak: false });
            return `${hostNonce}:${sessionId}:0`;
        }
        if (entry.pendingBreak === true) {
            entry.epoch += 1;
            entry.pendingBreak = false;
        }
        return `${hostNonce}:${sessionId}:${entry.epoch}`;
    };

    // ⑤ 事件订阅（同步注册；根 scope 也可释放）。
    /** @type {Array<() => void>} */
    const unsubscribers = [];
    const subscribe = (scope, label) => {
        if (scope === null || scope === undefined || typeof scope.on !== 'function') return;
        const register = (eventName, handler) => {
            try {
                const dispose = scope.on(eventName, (...args) => {
                    try {
                        const outcome = handler(...args);
                        if (outcome !== undefined && typeof outcome?.then === 'function') {
                            // 必须把 promise 交回宿主：`session/flush` 是 awaited parallel
                            // checkpoint，宿主靠返回值等待落盘。吞掉返回值会让 flush
                            // 提前完成，数据看起来“没写”。失败照旧留痞。
                            return outcome.catch((error) => {
                                logger?.warn?.(`[dsh-coding-time] ${label}:${eventName} 处理失败：${error instanceof Error ? error.message : String(error)}`);
                            });
                        }
                        return outcome;
                    }
                    catch (error) {
                        logger?.warn?.(`[dsh-coding-time] ${label}:${eventName} 处理失败：${error instanceof Error ? error.message : String(error)}`);
                        return undefined;
                    }
                });
                if (typeof dispose === 'function') unsubscribers.push(dispose);
            }
            catch (error) {
                logger?.warn?.(`[dsh-coding-time] 订阅 ${label}:${eventName} 失败：${error instanceof Error ? error.message : String(error)}`);
            }
        };

        register('tools/result', (exec, result) => {
            if (closing === true) return undefined;
            const sessionId = typeof exec?.agent?.id === 'string' ? exec.agent.id : '';
            const cwd = cwdOf(sessionId);
            if (cwd === undefined) return undefined;
            const runId = consumeRunId(sessionId);
            const observations = normalizeToolResult(exec, result, {
                cwd,
                rules: config.exclude,
                storageDirectory: store.storageDirectory,
                pluginDirectory: PLUGIN_DIRECTORY,
                runId,
            });
            if (observations.length > 0) enqueue(observations);
            return undefined;
        });

        register('agent/assistant-stream', (payload) => {
            if (closing === true) return undefined;
            const sessionId = typeof payload?.agent?.id === 'string' ? payload.agent.id : '';
            const cwd = cwdOf(sessionId);
            if (cwd === undefined) return undefined;
            const frameTime = typeof payload?.frame?.time === 'number' && Number.isFinite(payload.frame.time)
                ? payload.frame.time
                : undefined;
            const runId = consumeRunId(sessionId);
            const observations = normalizeProgress(payload, { cwd, runId, at: frameTime });
            if (observations.length > 0) enqueue(observations);
            return undefined;
        });

        register('session/event', (session, event) => {
            if (closing === true) return undefined;
            const sessionId = typeof session?.id === 'string' ? session.id : '';
            const cwd = cwdOf(sessionId);
            if (cwd === undefined) return undefined;
            const observations = normalizeSessionEvent(session, event, {
                cwd,
                humanEnabled: config.humanTracking?.enabled === true,
            });
            if (observations.length > 0) enqueue(observations);
            return undefined;
        });

        // 只切段，不产生观测；running 只重置 epoch（重复 running 不重复换）。
        register('agent/status', (payload) => {
            const sessionId = typeof payload?.agent?.id === 'string' ? payload.agent.id : '';
            if (sessionId === '') return undefined;
            if (payload?.status === 'idle') markBreak(sessionId);
            return undefined;
        });

        register('agent/disposed', (payload) => {
            const sessionId = typeof payload?.agent?.id === 'string' ? payload.agent.id : '';
            if (sessionId !== '') retireEpoch(sessionId);
            return undefined;
        });

        register('session/disposed', (session) => {
            const sessionId = typeof session?.id === 'string' ? session.id : '';
            if (sessionId !== '') retireEpoch(sessionId);
            return undefined;
        });

        register('session/flush', async () => {
            if (closing === true) return;
            // 宿主 await 全部 listener：这里必须真实落盘（先 drain 再 flush）。
            await serialize(async () => {
                await drainBuffer();
                if (readyFailure === null) await store.flush();
            });
        });
    };

    subscribe(ctx, 'ctx');
    if (ctx?.root !== undefined && ctx.root !== ctx) subscribe(ctx.root, 'root');

    // ⑥ 编辑器心跳轮询（真实本地 inbox；无网络、无端口）。
    let editorTimer = null;
    let checkpointTimer = null;

    /**
     * 按**当前** config 重建周期 timer（flushInterval 变更后必须换周期）。
     *
     * 卸载中或 store 未就绪时不重建，交由 initPromise 的既有分支处理。
     */
    const restartTimers = () => {
        if (checkpointTimer !== null) {
            clearInterval(checkpointTimer);
            checkpointTimer = null;
        }
        if (editorTimer !== null) {
            clearInterval(editorTimer);
            editorTimer = null;
        }
        if (closing === true || ready !== true || readyFailure !== null) return;
        const intervalMs = Math.max(1000, config.flushIntervalSeconds * 1000);
        checkpointTimer = setInterval(() => {
            if (closing === true) return;
            void serialize(async () => {
                await drainBuffer();
                await store.flush();
            }).catch((error) => {
                logger?.warn?.(`[dsh-coding-time] 周期 checkpoint 失败：${error instanceof Error ? error.message : String(error)}`);
            });
        }, intervalMs);
        if (typeof checkpointTimer?.unref === 'function') checkpointTimer.unref();
        if (config.humanTracking?.enabled === true) {
            editorTimer = setInterval(() => {
                void pollEditor();
            }, intervalMs);
            if (typeof editorTimer?.unref === 'function') editorTimer.unref();
            void pollEditor();
        }
    };

    /**
     * 让"纯开关类"配置改动真正落到运行时行为上。
     *
     * 目前只有 `humanTracking.enabled` 需要副作用（启停编辑器轮询）；
     * `enabled` / `trackAgentActivity` / `trackAiLines` / 阈值 / 时区 / 周起点
     * 都是**被读取时**生效（ingest / summary 每次读 config），无需额外动作。
     */
    const applyLiveSwitches = () => {
        if (closing === true || ready !== true) return;
        // 人工采集开关变化 → 重建 timer（enabled 时才会挂 editorTimer）。
        restartTimers();
    };
    const pollEditor = async () => {
        if (closing === true || ready !== true || config.humanTracking?.enabled !== true) return;
        let consumeEditorInbox;
        try {
            const module = await import('./editor-inbox.js');
            consumeEditorInbox = module.consumeEditorInbox;
        }
        catch {
            // editor-inbox 未安装：人工采集不可用，不伪造 human。
            return;
        }
        if (typeof consumeEditorInbox !== 'function') return;
        try {
            await consumeEditorInbox({
                directory: config.storageDirectory,
                profile,
                enabled: true,
                onEvent: (event) => {
                    const observations = normalizeEditorEvent(event, { humanEnabled: true });
                    if (observations.length > 0) enqueue(observations);
                },
            });
        }
        catch (error) {
            logger?.warn?.(`[dsh-coding-time] 编辑器心跳消费失败：${error instanceof Error ? error.message : String(error)}`);
        }
    };

    // ⑦ HTTP 表面。
    const getConfigSnapshot = async () => {
        const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
        const located = locateNamespace(settings);
        let revision = located?.revision ?? null;
        // 以本插件已解析的完整配置为基线（**含冷字段**），只把 descriptor 的
        // live 子集覆盖上去。这样"只有 live 子集"时冷字段不会被默认值冲掉。
        let current = config;
        /** @type {Record<string, unknown> | null} */
        let liveValue = null;
        if (located !== null && typeof settings?.describe === 'function') {
            try {
                const descriptor = settings.describe().find(item => item?.ns === located.ns);
                if (descriptor !== undefined) {
                    revision = Number.isInteger(descriptor.revision) ? descriptor.revision : revision;
                    if (descriptor.value !== null && typeof descriptor.value === 'object') {
                        // 宿主值带 volatile wrapper：**先解包**才能当普通配置用。
                        const unwrapped = unwrapVolatile(descriptor.value);
                        if (unwrapped !== null && typeof unwrapped === 'object') {
                            liveValue = unwrapped;
                            current = { ...config, ...mergeLiveOnly(unwrapped) };
                        }
                    }
                }
            }
            catch {
                // 读回失败不影响只读快照。
            }
        }
        void liveValue;
        return {
            // 入口存在即"该实例有设置页"；仍不放宽 missing 分支（fail-closed）。
            editable: located !== null,
            namespace: located?.ns ?? null,
            revision,
            profile,
            config: current,
            // 冷字段与热字段元数据（供 Client 精确禁用/提示）。
            readonlyFields: COLD_FIELDS.map(field => field.name),
            restartRequiredFields: COLD_FIELDS.filter(field => field.requiresRestart === true).map(field => field.name),
            coldFields: COLD_FIELDS.map(field => ({ ...field })),
            liveFields: [...LIVE_FIELDS],
            storageDirectory: store.storageDirectory,
            stats: await inspectStorage(store.storageDirectory),
            warnings: store.warnings,
        };
    };

    const saveConfig = async ({ patch, expectedRevision }) => {
        const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
        const located = locateNamespace(settings);
        if (located === null || typeof settings?.update !== 'function') {
            const failure = new Error('宿主未暴露本插件的设置命名空间');
            failure.code = 'not_editable';
            throw failure;
        }
        // **只接受 live 字段**：冷字段（storageDirectory）不参与热保存，
        // 提交它会假装切换成功。传了冷字段就明确报字段级错误（422）。
        const incoming = patch !== null && typeof patch === 'object' ? patch : {};
        for (const field of COLD_FIELDS) {
            if (incoming[field.name] !== undefined && incoming[field.name] !== config[field.name]) {
                const failure = new ConfigError(
                    `${field.name} 需要重启后才能生效，不能在运行中修改`,
                    { code: 'requires_restart', path: field.name },
                );
                throw failure;
            }
        }
        // **严格校验必须发生在过滤之前**：否则 `{enabled:true, unknown:1}` 里的
        // unknown 会被 mergeLiveOnly 静默擦掉，等于绕过了 unknown 校验。
        // 这里把 incoming 合并进完整候选（config 打底），交给 normalizeConfig 判
        // 未知字段/越界/类型/凭据键；任何一项不合法都在此 422，绝不发 update。
        // 抛错即 422（调用方转 invalid_config），此时还没有触碰任何运行态。
        normalizeConfig({ ...config, ...incoming });
        const livePatch = mergeLiveOnly(incoming);
        if (Object.keys(livePatch).length === 0) {
            const failure = new ConfigError('没有可热生效的字段被修改', { code: 'no_live_change', path: 'patch' });
            throw failure;
        }
        // 先严格校验（不 clamp、不猜），再交宿主持久化。
        const next = normalizeConfig({ ...config, ...livePatch });
        // **保存前先用旧 config 把已入缓冲的观测落盘**：否则新 `enabled:false`
        // 会作用到"保存前就已采集"的 buffer，导致这批活动被重算丢弃。
        // 顺序：旧 config drain+flush 成功 → 再提交 → 再切运行态。
        try {
            await serialize(async () => {
                await drainBuffer();
                if (readyFailure === null) await store.flush();
            });
        }
        catch (error) {
            const failure = new Error(`保存前落盘失败，已放弃本次保存：${error instanceof Error ? error.message : String(error)}`);
            failure.code = 'preflush_failed';
            throw failure;
        }
        try {
            // **只提交 live patch**，不是含冷字段的全量 next。
            await settings.update(located.ns, livePatch, expectedRevision ?? located.revision ?? undefined);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // 失败**不切运行态**：config/store 保持旧值。
            if (/revision|conflict|stale|E_REVISION_CONFLICT/i.test(message)
                || String(error?.code ?? '') === 'E_REVISION_CONFLICT') {
                const conflict = new Error(message);
                conflict.code = 'revision_conflict';
                throw conflict;
            }
            throw error;
        }
        // **立即生效**：内存配置换新值，store 参数同步，并重建周期 timer
        // （flushInterval 变了必须换周期，否则"改了不起作用"）。
        const previousFlush = config.flushIntervalSeconds;
        config = next;
        store.heartbeatIntervalSeconds = next.heartbeatIntervalSeconds;
        store.flushIntervalSeconds = next.flushIntervalSeconds;
        if (next.flushIntervalSeconds !== previousFlush) restartTimers();
        applyLiveSwitches();
        return getConfigSnapshot();
    };

    /**
     * summary：**先 drain**（实时显示），再按 可见记录 真实聚合。
     *
     * @param query - { preset, from, to, project }。
     * @returns 响应体。
     */
    /**
     * 当前工作区 Git 快照助手：受限、有界，绝不拖累主统计。
     *
     * 安全边界（硬）：路径只来自可信记录（绝对 cwd / projectKey）；query.project
     * 只能缩小集合，绝不新增扫描目标。每请求最多 4 项、并发 2、短超时；
     * 5 秒有界缓存 + 共享 inflight（上限 32，key 含 exclude）。单项目失败只标
     * unavailable，绝不让主统计 500、也绝不当 0。不在 serialize 锁内跑 Git。
     */
    const MAX_GIT_PROJECTS = 4;
    const GIT_CONCURRENCY = 2;
    const GIT_CACHE_MS = 5000;
    const GIT_CACHE_MAX = 32;
    /** @type {Map<string, { at: number, value: object }>} */
    const gitCache = new Map();
    /** @type {Map<string, Promise<object>>} */
    const gitInflight = new Map();

    /** 收集可信项目路径：只取记录中真实出现过的绝对路径，并按最近活动降序。 */
    const trustedProjects = (records, projectFilter) => {
        /** @type {Map<string, string>} */
        const candidates = new Map();
        // 单独一个小 Map 记录每个已知项目的最近时间（不排序整份 records）。
        /** @type {Map<string, number>} */
        const recency = new Map();
        for (const record of records ?? []) {
            const endMs = Number(record?.endMs);
            const startMs = Number(record?.startMs);
            // 以 endMs 为准，缺失时用 startMs 兜底；两者都无效则记 0（排最后）。
            const at = Number.isFinite(endMs) ? endMs : (Number.isFinite(startMs) ? startMs : 0);
            for (const field of ["cwd", "project", "projectKey"]) {
                const value = record?.[field];
                if (typeof value !== "string" || value.trim() === "") continue;
                if (path.isAbsolute(value) === false) continue;
                const key = normalizeProjectKey(value);
                if (candidates.has(key) === false) {
                    candidates.set(key, value);
                    recency.set(key, at);
                }
                else if (at > (recency.get(key) ?? 0)) {
                    // 同一项目出现在多条记录里：保留最新时间。
                    recency.set(key, at);
                }
            }
        }
        // query.project 只能**缩小**集合：必须命中已有可信项目，绝不新增扫描目标。
        if (projectFilter !== null) {
            const hit = candidates.get(projectFilter);
            return hit === undefined ? [] : [hit];
        }
        // 无过滤：按最近活动降序，让「当前项目」优先进入 4 个项目上限。
        return [...candidates.entries()]
            .sort((a, b) => (recency.get(b[0]) ?? 0) - (recency.get(a[0]) ?? 0))
            .map(([, value]) => value);
    };

    /** 单项目读取：缓存 + inflight 共享。 */
    const readWorkingTree = (projectPath, cacheKey, options) => {
        const cached = gitCache.get(cacheKey);
        if (cached !== undefined && Date.now() - cached.at < GIT_CACHE_MS) {
            return Promise.resolve(cached.value);
        }
        const pending = gitInflight.get(cacheKey);
        if (pending !== undefined) return pending;
        const promise = (async () => {
            try {
                const value = await scanGitWorkingTree(projectPath, {
                    exclude: options.exclude,
                    maxEntries: options.maxEntries,
                    timeoutMs: options.timeoutMs,
                });
                gitCache.set(cacheKey, { at: Date.now(), value });
                while (gitCache.size > GIT_CACHE_MAX) {
                    const oldest = gitCache.keys().next();
                    if (oldest.done === true) break;
                    gitCache.delete(oldest.value);
                }
                return value;
            }
            catch (error) {
                return {
                    project: projectPath,
                    repoRoot: null,
                    status: "unavailable",
                    reason: typeof error?.code === "string" ? error.code : "reader_failed",
                    observedAt: new Date().toISOString(),
                    truncated: false,
                    files: [],
                };
            }
            finally {
                gitInflight.delete(cacheKey);
            }
        })();
        gitInflight.set(cacheKey, promise);
        return promise;
    };

    /** 并发受限执行。 */
    const runLimited = async (items, worker, limit) => {
        const results = new Array(items.length);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (cursor < items.length) {
                const index = cursor;
                cursor += 1;
                results[index] = await worker(items[index]);
            }
        });
        await Promise.all(workers);
        return results;
    };

    /** 组装当前工作区快照。 */
    const snapshotWorkingTree = async (records, projectFilter, options) => {
        const candidates = trustedProjects(records, projectFilter);
        const tooMany = candidates.length > MAX_GIT_PROJECTS;
        const picked = candidates.slice(0, MAX_GIT_PROJECTS);
        const exclude = Array.isArray(options?.exclude) ? options.exclude : [];
        // 无歧义缓存键：路径与 exclude **都**参与，避免不同 exclude 数组拼串碰撞。
        const cacheKeyOf = projectPath => JSON.stringify([normalizeProjectKey(projectPath), exclude]);
        const projects = picked.length === 0
            ? []
            : await runLimited(
                picked,
                projectPath => readWorkingTree(projectPath, cacheKeyOf(projectPath), options),
                GIT_CONCURRENCY,
            );
        return {
            observedAt: new Date().toISOString(),
            projects,
            truncated: tooMany === true || projects.some(item => item?.truncated === true),
        };
    };
    const summarizeNow = async (query = {}) => {
        if (ready === true && closing === false) {
            await serialize(drainBuffer).catch(() => {});
        }
        // weekStartsOn 是 live 字段：必须真的参与范围计算（否则"改了不起作用"）。
        const range = resolveRange(query, config.timezone, Date.now(), config.weekStartsOn);
        const fromMs = Date.parse(range.from);
        const toMs = Date.parse(range.to);

        const allRecords = await store.readRecords({});
        const projectFilter = typeof query?.project === 'string' && query.project !== ''
            ? normalizeProjectKey(query.project)
            : null;

        /** 可见记录：项目匹配 + 时间相交。 */
        const visible = allRecords.filter((record) => {
            const startMs = Number(record?.startMs ?? NaN);
            const endMs = Number(record?.endMs ?? NaN);
            if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
            if (endMs <= fromMs || startMs >= toMs) return false;
            if (projectFilter === null) return true;
            return normalizeProjectKey(String(record?.projectKey ?? record?.project ?? '')) === projectFilter;
        });

        const intervalsOf = (list) => list
            .filter(record => record.kind === 'interval')
            .map(record => ({ start: Number(record.startMs), end: Number(record.endMs) }));

        // ① 全局墙钟并集（唯一 totalSeconds 来源）。
        const wallUnionMs = unionMs(intervalsOf(visible), fromMs, toMs);

        /** 按来源的真实时长。 */
        const durationOfSource = (list, source) => unionMs(
            intervalsOf(list.filter(record => String(record.source ?? '') === source)),
            fromMs,
            toMs,
        );

        /** 只从 `source==='ai'` 的记录累加行数；无证据 null。 */
        const linesOf = (list) => {
            let added = 0;
            let deleted = 0;
            let known = false;
            let partial = false;
            for (const record of list) {
                if (String(record?.source ?? '') !== 'ai') continue;
                if (record.linesPartial === true) partial = true;
                for (const entry of record.lineEntries ?? []) {
                    const at = Number(entry?.at ?? NaN);
                    if (!Number.isFinite(at)) continue;
                    if (at < fromMs || at >= toMs) continue;
                    if (entry.added !== null && entry.added !== undefined) { added += Number(entry.added); known = true; }
                    else partial = true;
                    if (entry.deleted !== null && entry.deleted !== undefined) { deleted += Number(entry.deleted); known = true; }
                    else partial = true;
                }
                if (record.linesAdded !== null || record.linesDeleted !== null) known = true;
                added += Number(record.linesUndated?.added ?? 0);
                deleted += Number(record.linesUndated?.deleted ?? 0);
            }
            if (known === false) return { added: null, deleted: null, quality: 'unavailable' };
            return { added, deleted, quality: partial ? 'partial' : 'full' };
        };

        const humanState = humanStatusOf();

        // ② 按 project 分组，各自真实聚合。
        const projectGroups = new Map();
        for (const record of visible) {
            const key = String(record?.projectKey ?? record?.project ?? '');
            if (key === '') continue;
            const list = projectGroups.get(key);
            if (list === undefined) projectGroups.set(key, [record]);
            else list.push(record);
        }

        const projectRows = [];
        for (const [projectKey, list] of projectGroups) {
            const aiMs = durationOfSource(list, 'ai');
            const humanMs = durationOfSource(list, 'human');
            const totalMs = unionMs(intervalsOf(list), fromMs, toMs);
            const lines = linesOf(list);
            const sessions = new Set();
            let lastActiveMs = 0;
            for (const record of list) {
                const sessionId = String(record?.sessionId ?? '');
                if (sessionId !== '') sessions.add(sessionId);
                lastActiveMs = Math.max(lastActiveMs, Number(record?.endMs ?? 0));
            }
            const cwd = list.find(record => typeof record?.cwd === 'string' && record.cwd !== '')?.cwd ?? null;
            const projectName = list.find(record => typeof record?.project === 'string' && record.project !== '')?.project ?? projectKey;
            projectRows.push({
                project: projectName,
                projectKey,
                label: path.basename(projectName) || projectName,
                cwd,
                aiSeconds: Math.round(aiMs / 1000),
                humanSeconds: humanState.humanStatus === 'connected' ? Math.round(humanMs / 1000) : null,
                totalSeconds: Math.round(totalMs / 1000),
                aiAddedLines: lines.added,
                aiDeletedLines: lines.deleted,
                lineDataQuality: lines.quality,
                sessions: sessions.size,
                lastActiveAt: lastActiveMs === 0 ? null : new Date(lastActiveMs).toISOString(),
                active: false,
            });
        }

        // ③ 按日裁切后各自聚合（跨午夜两侧都算）。
        const dayGroups = new Map();
        for (const record of visible) {
            if (record.kind !== 'interval') continue;
            const startMs = Number(record?.startMs ?? NaN);
            const endMs = Number(record?.endMs ?? NaN);
            if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
            const source = String(record.source ?? '');
            for (const [dayKey, ms] of splitByDayRange(startMs, endMs, config.timezone)) {
                const entry = dayGroups.get(dayKey) ?? { day: dayKey, aiMs: 0, humanMs: 0, unionMs: 0 };
                if (source === 'ai') entry.aiMs += ms;
                else if (source === 'human') entry.humanMs += ms;
                entry.unionMs += ms;
                dayGroups.set(dayKey, entry);
            }
        }
        // 行数按真实发生日归属（只认 AI）。
        for (const record of visible) {
            if (String(record?.source ?? '') !== 'ai') continue;
            for (const entry of record.lineEntries ?? []) {
                const at = Number(entry?.at ?? NaN);
                if (!Number.isFinite(at)) continue;
                if (at < fromMs || at >= toMs) continue;
                const dayKey = localDayKeyOf(at, config.timezone);
                const dayEntry = dayGroups.get(dayKey) ?? { day: dayKey, aiMs: 0, humanMs: 0, unionMs: 0 };
                dayEntry.addedLines = (dayEntry.addedLines ?? 0) + (Number(entry.added) || 0);
                dayEntry.deletedLines = (dayEntry.deletedLines ?? 0) + (Number(entry.deleted) || 0);
                dayEntry.linesKnown = true;
                dayGroups.set(dayKey, dayEntry);
            }
        }

        const dayRows = [...dayGroups.values()]
            .filter(entry => entry.day >= range.fromLocal && entry.day <= range.toLocal)
            .sort((a, b) => a.day.localeCompare(b.day))
            .map(entry => ({
                date: entry.day,
                aiSeconds: Math.round(entry.aiMs / 1000),
                humanSeconds: humanState.humanStatus === 'connected' ? Math.round(entry.humanMs / 1000) : null,
                totalSeconds: Math.round(entry.unionMs / 1000),
                aiAddedLines: entry.linesKnown === true ? entry.addedLines : null,
                aiDeletedLines: entry.linesKnown === true ? entry.deletedLines : null,
            }));

        // ④ 按文件聚合真实活跃时长（文件时长占比图的数据源）。
        //
        // 诚实性规则（与 README 一致）：
        // - 只认 `kind === 'interval'` 的活跃区间，evidence/pending 零时长不计；
        // - 一条区间触碰多个文件时，把这段区间**按证据权重切成互不重叠的子段**
        //   分给各文件：各文件时长之和恰好等于该区间时长，绝不重复计入、不乘文件数；
        // - 每个文件对分到的子段再做**并集去重**，重叠只计一次；
        // - 没有文件证据的区间归入「其他」桶，不编造文件名；
        // - 时长是「按证据分摊的估计」，显式标注 attribution='apportioned'。
        const fileGroups = new Map();
        for (const record of visible) {
            if (record.kind !== 'interval') continue;
            const startMs = Number(record?.startMs ?? NaN);
            const endMs = Number(record?.endMs ?? NaN);
            if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
            const from = Math.max(startMs, fromMs);
            const to = Math.min(endMs, toMs);
            if (to <= from) continue;
            const span = to - from;
            const entries = Array.isArray(record.files) ? record.files : [];
            let totalWeight = 0;
            const weighted = [];
            for (const entry of entries) {
                const filePath = typeof entry?.path === 'string' ? entry.path : '';
                if (filePath === '') continue;
                const weight = Number(entry?.touches ?? 1);
                const safeWeight = Number.isFinite(weight) && weight > 0 ? weight : 1;
                weighted.push([filePath, safeWeight]);
                totalWeight += safeWeight;
            }
            const shares = weighted.length === 0
                ? [['__other__', 1]]
                : weighted.map(([filePath, weight]) => [filePath, weight / totalWeight]);
            let cursor = from;
            for (let index = 0; index < shares.length; index += 1) {
                const [filePath, share] = shares[index];
                const subEnd = index === shares.length - 1 ? to : Math.min(to, cursor + Math.round(span * share));
                if (subEnd > cursor) {
                    const group = fileGroups.get(filePath) ?? { path: filePath, intervals: [], touches: 0 };
                    group.intervals.push({ start: cursor, end: subEnd });
                    group.touches += 1;
                    fileGroups.set(filePath, group);
                }
                cursor = subEnd;
            }
        }
        const fileRows = [...fileGroups.values()]
            .map(group => ({
                path: group.path,
                label: group.path === '__other__' ? null : path.basename(group.path),
                totalSeconds: Math.round(unionMs(group.intervals, fromMs, toMs) / 1000),
                touches: group.touches,
                attribution: 'apportioned',
            }))
            .filter(row => row.totalSeconds > 0)
            .sort((a, b) => b.totalSeconds - a.totalSeconds)
            .slice(0, 12);

        // ⑤ session / recent 基于同一份可见集合。
        const sessionSet = new Set();
        for (const record of visible) {
            const sessionId = String(record?.sessionId ?? '');
            if (sessionId !== '') sessionSet.add(sessionId);
        }
        const recent = [...visible]
            .sort((a, b) => Number(b.endMs ?? 0) - Number(a.endMs ?? 0))
            .slice(0, 20)
            .map(record => ({
                at: record.endAt ?? null,
                project: record.project ?? null,
                sessionId: record.sessionId ?? null,
                kind: record.kind ?? null,
                source: record.source ?? null,
            }));

        const linesTotal = linesOf(visible);

        return {
            version: 2,
            ok: true,
            generatedAt: new Date().toISOString(),
            timezone: config.timezone,
            humanStatus: humanState.humanStatus,
            humanStatusReason: humanState.reason,
            range,
            profile,
            storageDirectory: store.storageDirectory,
            warnings: store.warnings,
            stats: await inspectStorage(store.storageDirectory),
            totals: {
                aiSeconds: Math.round(durationOfSource(visible, 'ai') / 1000),
                humanSeconds: humanState.humanStatus === 'connected'
                    ? Math.round(durationOfSource(visible, 'human') / 1000)
                    : null,
                // 全局墙钟并集：绝不等于 aiSeconds + humanSeconds。
                totalSeconds: Math.round(wallUnionMs / 1000),
                aiAddedLines: linesTotal.added,
                aiDeletedLines: linesTotal.deleted,
                lineDataQuality: linesTotal.quality,
                sessions: sessionSet.size,
                projects: projectRows.length,
            },
            projects: projectRows.sort((a, b) => b.totalSeconds - a.totalSeconds),
            days: dayRows,
            // 按文件分摊的活跃时长（文件时长占比图数据源）；旧后端不返回该字段时
            // 客户端应显示「未提供」，绝不自己造一份。
            files: fileRows,
            recent,
            lineEvidence: { quality: linesTotal.quality },
            // 当前工作区 Git 快照（与工时日期无关，不受日期裁切）。
            workingTree: await snapshotWorkingTree(allRecords, projectFilter, {
                exclude: config.exclude,
                maxEntries: 1000,
                timeoutMs: 1000,
            }),
        };
    };

    /**
     * 为本插件实例登记"自动设置页"策略，让条目进入 `settings.describe()`。
     *
     * 这是宿主公开 API（`configure(presentation, owner)`，`auto` 默认 true）。
     * 只登记**本实例的 fiber**，绝不猜别的 namespace、绝不强制 editable。
     * 用 `ctx.effect` 注册释放，保证卸载时撤销。
     */
    const registerSettingsPage = () => {
        return ctx.inject(['settings'], (settingsCtx) => {
            const settings = settingsCtx.settings ?? settingsCtx.get('settings');
            if (settings === null || typeof settings !== 'object') return undefined;
            if (typeof settings.configure !== 'function') return undefined;
            // owner 优先用本实例 fiber（诊断已确认 ctx.fiber 存在）；缺失则按默认调用形态。
            const owner = ctx.fiber;
            try {
                if (owner !== undefined && owner !== null) settings.configure({ auto: true }, owner);
                else settings.configure({ auto: true });
            }
            catch (error) {
                // 重复登记会抛：说明已登记，属正常（不当作失败）。
                logger?.debug?.(`[dsh-coding-time] settings.configure 跳过：${error instanceof Error ? error.message : String(error)}`);
            }
            // configure 的返回是 disposer（若有）：交给 effect 释放。
            return undefined;
        });
    };
    registerSettingsPage();

    ctx.inject(['webServer'], (webCtx) => {
        const release = mountRoutes(webCtx, {
            logger,
            summarize: summarizeNow,
            getConfig: getConfigSnapshot,
            saveConfig,
        });
        webCtx.effect(() => release);
        return undefined;
    });

    // ⑧ 唯一释放器：closing → 停轮询 → drain → flush → close（串行）。
    const shutdown = () => {
        if (closing === true) return chain;
        closing = true;
        if (editorTimer !== null) {
            clearInterval(editorTimer);
            editorTimer = null;
        }
        if (checkpointTimer !== null) {
            clearInterval(checkpointTimer);
            checkpointTimer = null;
        }
        return serialize(async () => {
            try {
                await drainBuffer();
            }
            catch (error) {
                logger?.warn?.(`[dsh-coding-time] 卸载期 drain 失败：${error instanceof Error ? error.message : String(error)}`);
            }
            try {
                if (readyFailure === null) await store.flush();
            }
            catch (error) {
                logger?.warn?.(`[dsh-coding-time] 卸载期 flush 失败：${error instanceof Error ? error.message : String(error)}`);
            }
            try {
                if (readyFailure === null) await store.close();
            }
            catch (error) {
                logger?.warn?.(`[dsh-coding-time] 关闭存储失败：${error instanceof Error ? error.message : String(error)}`);
            }
        });
    };

    ctx.effect(() => () => {
        for (const dispose of unsubscribers) {
            try {
                dispose();
            }
            catch {
                // 释放期重复调用可忽略。
            }
        }
        unsubscribers.length = 0;
        // **return** 让框架可以 await；不拦截进程信号。
        return shutdown();
    });

    // ⑨ initPromise：就绪后开跑。
    const initPromise = (async () => {
        try {
            await store.init();
        }
        catch (error) {
            readyFailure = error;
            logger?.error?.(`[dsh-coding-time] 存储初始化失败（${effectiveDirectory} / profile=${profile}），已停止采集：${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
        ready = true;
        if (closing === true) {
            await serialize(drainBuffer).catch(() => {});
            return { directory: store.storageDirectory, profile, closed: true };
        }

        // 周期 checkpoint / 编辑器轮询：共用 restartTimers（flushInterval 变更时会重建）。
        restartTimers();

        logger?.info?.(`dsh-coding-time: 采集已启用（存储 ${store.storageDirectory}，profile ${profile}，时区 ${config.timezone}，批量 ${config.flushIntervalSeconds}s，路由 ${ROUTE_PREFIX}）`);
        return { directory: store.storageDirectory, profile };
    })();

    initPromise.catch((error) => {
        logger?.error?.(`[dsh-coding-time] 初始化未完成：${error instanceof Error ? error.message : String(error)}`);
    });

    return initPromise;
}

/** 供 Client / 测试使用的常量。 */
export const constants = Object.freeze({
    ROUTE_PREFIX,
    CONFIG_FIELD_KEYS,
    NS_EXACT,
    PROFILE_PATTERN,
    MAX_BATCH_OBSERVATIONS,
    MAX_BUFFER_OBSERVATIONS,
});

export { normalizeEditorEvent, normalizeProgress, normalizeSessionEvent, normalizeToolResult };
