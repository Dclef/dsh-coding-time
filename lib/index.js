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
export function buildConfigSchema(z) {
    const base = z.object({
        enabled: z.boolean().default(DEFAULT_CONFIG.enabled).description('采集总开关'),
        heartbeatIntervalSeconds: z.number().min(LIMITS.heartbeatIntervalSeconds.min).max(LIMITS.heartbeatIntervalSeconds.max)
            .default(DEFAULT_CONFIG.heartbeatIntervalSeconds)
            .description('记录节流上限（秒）；不产生心跳，只约束开新记录的频率'),
        idleThresholdSeconds: z.number().min(LIMITS.idleThresholdSeconds.min).max(LIMITS.idleThresholdSeconds.max)
            .default(DEFAULT_CONFIG.idleThresholdSeconds)
            .description('超过该秒数没有真实进展即断段（必须 ≥ heartbeatIntervalSeconds）'),
        flushIntervalSeconds: z.number().min(LIMITS.flushIntervalSeconds.min).max(LIMITS.flushIntervalSeconds.max)
            .default(DEFAULT_CONFIG.flushIntervalSeconds)
            .description('批量落盘周期（秒）'),
        trackAgentActivity: z.boolean().default(DEFAULT_CONFIG.trackAgentActivity)
            .description('是否统计 AI 活动时长（关闭后仍统计文件与行数证据）'),
        trackAiLines: z.boolean().default(DEFAULT_CONFIG.trackAiLines)
            .description('是否统计 AI 增删行（仅限可信 diff 元数据）'),
        humanTracking: z.object({
            enabled: z.boolean().default(DEFAULT_CONFIG.humanTracking.enabled)
                .description('是否采集人工编码时长（需要显式真实输入来源）'),
        }).description('人工编码时长采集'),
        storageDirectory: z.string().default(defaultStorageDirectory())
            .description('本地存储目录（默认 ~/.dsh/coding-time，绝不跟随项目）'),
        timezone: z.string().default(DEFAULT_CONFIG.timezone).description('统计所用 IANA 时区'),
        weekStartsOn: z.number().min(0).max(6).default(DEFAULT_CONFIG.weekStartsOn)
            .description('周起始日：0=周日，1=周一'),
        exclude: z.array(z.string()).default([...DEFAULT_CONFIG.exclude])
            .description('不计入统计的路径片段 / 文件名 glob'),
    });
    const described = typeof base.description === 'function'
        ? base.description('AI 与人工编码活动时长、行数统计（全部数据仅存本机）')
        : base;
    return new Proxy(described, {
        apply(target, thisArg, args) {
            const value = Reflect.apply(target, thisArg, args);
            normalizeConfig(value);
            return value;
        },
        construct(target, args, newTarget) {
            const value = Reflect.construct(target, args, newTarget);
            normalizeConfig(value);
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
    const configInput = rawConfig ?? {};
    const configOnly = { ...configInput };
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
        let current = config;
        if (located !== null && typeof settings?.describe === 'function') {
            try {
                const descriptor = settings.describe().find(item => item?.ns === located.ns);
                if (descriptor !== undefined) {
                    revision = Number.isInteger(descriptor.revision) ? descriptor.revision : revision;
                    if (descriptor.value !== null && typeof descriptor.value === 'object') {
                        try {
                            current = normalizeConfig(descriptor.value);
                        }
                        catch {
                            // 宿主值非法：保留当前配置，不假装它合法。
                        }
                    }
                }
            }
            catch {
                // 读回失败不影响只读快照。
            }
        }
        return {
            editable: located !== null,
            namespace: located?.ns ?? null,
            revision,
            profile,
            config: current,
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
        const next = normalizeConfig({ ...config, ...(patch ?? {}) });
        try {
            await settings.update(located.ns, next, expectedRevision ?? located.revision ?? undefined);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/revision|conflict|stale/i.test(message)) {
                const conflict = new Error(message);
                conflict.code = 'revision_conflict';
                throw conflict;
            }
            throw error;
        }
        // 立即生效：内存配置换新值，store 参数同步。
        config = next;
        store.heartbeatIntervalSeconds = next.heartbeatIntervalSeconds;
        store.flushIntervalSeconds = next.flushIntervalSeconds;
        // 保存前先 drain + flush，绝不丢历史。
        try {
            await serialize(async () => {
                await drainBuffer();
                await store.flush();
            });
        }
        catch (error) {
            logger?.warn?.(`[dsh-coding-time] 保存配置后落盘失败：${error instanceof Error ? error.message : String(error)}`);
        }
        return getConfigSnapshot();
    };

    /**
     * summary：**先 drain**（实时显示），再按 可见记录 真实聚合。
     *
     * @param query - { preset, from, to, project }。
     * @returns 响应体。
     */
    const summarizeNow = async (query = {}) => {
        if (ready === true && closing === false) {
            await serialize(drainBuffer).catch(() => {});
        }
        const range = resolveRange(query, config.timezone, Date.now());
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

        // ④ session / recent 基于同一份可见集合。
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
            recent,
            lineEvidence: { quality: linesTotal.quality },
        };
    };

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

        // flushInterval 周期 checkpoint：只 drain 缓冲 + flush，**绝不造时间观测**。
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

        if (closing === false && config.humanTracking?.enabled === true) {
            editorTimer = setInterval(() => {
                void pollEditor();
            }, Math.max(1000, config.flushIntervalSeconds * 1000));
            if (typeof editorTimer?.unref === 'function') editorTimer.unref();
            void pollEditor();
        }

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
