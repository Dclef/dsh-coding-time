/**
 * dsh-coding-time · 配置层。
 *
 * 纯 ESM、零 runtime 依赖：只用 node 内建 `os` / `path`，这样库存储、Web 半边和
 * 测试都共享同一份校验规则，不会出现"测试里能过、宿主里默认值不同"的分叉。
 *
 * 两条路径，故意分开：
 *
 * - `normalizeConfig(input)` —— **严格**。给宿主配置用。未知字段、凭据字段、非法
 *   时区、非法数值、非本机绝对目录一律抛 `ConfigError`，不做隐式 clamp，因为把
 *   用户写错的 `idleThresholdSeconds: 10` 悄悄改成 180 比直接报错更危险。
 * - `sanitizeConfig(input)` —— **宽容**。给"从磁盘/HTTP 读回来的旧数据、要回显给
 *   前端"用。未知键与凭据键被静默丢弃，数值仍然严格校验，绝不把凭据带进内存。
 *
 * @module dsh-coding-time/config
 */
import os from 'node:os';
import path from 'node:path';

/** 配置结构版本。字段语义变化时递增。 */
export const CONFIG_VERSION = 1;

/** 数值字段的硬边界（越界即报错，不 clamp）。 */
export const LIMITS = Object.freeze({
    heartbeatIntervalSeconds: Object.freeze({ min: 5, max: 3600 }),
    idleThresholdSeconds: Object.freeze({ min: 5, max: 86_400 }),
    flushIntervalSeconds: Object.freeze({ min: 1, max: 600 }),
});

/** 默认排除的路径片段/文件名（区分大小写由调用方决定，Windows 上按小写比对）。 */
export const DEFAULT_EXCLUDE = Object.freeze([
    '.git',
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.venv',
    '.env',
    '*.pem',
    '*.key',
    'id_rsa',
    '.ssh',
    'secrets',
]);

/** 任何层级都不允许出现在配置里的字段名。 */
const CREDENTIAL_KEY = /^(?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|passphrase|credential|credentials|authorization|auth|private[_-]?key|session[_-]?key|cookie|webhook[_-]?url)$/i;

/** 顶层合法字段。 */
const TOP_LEVEL_KEYS = Object.freeze([
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

/** `humanTracking` 的合法子字段。 */
const HUMAN_KEYS = Object.freeze(['enabled']);

/**
 * 配置错误。`code` 供调用方分支，`path` 是出错字段的路径（`humanTracking.enabled`）。
 */
export class ConfigError extends Error {
    /**
     * @param message - 人读的说明（中文，带期望值）。
     * @param fields - { code, path }。
     */
    constructor(message, { code = 'invalid', path: fieldPath = '' } = {}) {
        super(fieldPath ? `${fieldPath}: ${message}` : message);
        this.name = 'ConfigError';
        this.code = code;
        this.path = fieldPath;
    }
}

/** 本机时区；读不到就退到 UTC（这是唯一允许的静默兜底，而且只影响显示）。 */
export function detectTimezone() {
    try {
        const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
        return typeof zone === 'string' && zone ? zone : 'UTC';
    }
    catch {
        return 'UTC';
    }
}

/** 默认存储目录：`~/.dsh/coding-time`（**不是** cwd，绝不跟着工程走）。 */
export function defaultStorageDirectory() {
    return path.join(os.homedir(), '.dsh', 'coding-time');
}

/** 深度冻结，保证模块级默认值不会被某个调用方改掉。 */
function deepFreeze(value) {
    if (Array.isArray(value)) {
        for (const item of value) deepFreeze(item);
        return Object.freeze(value);
    }
    if (value !== null && typeof value === 'object') {
        for (const item of Object.values(value)) deepFreeze(item);
        return Object.freeze(value);
    }
    return value;
}

/** 冻结的默认配置。 */
export const DEFAULT_CONFIG = deepFreeze({
    enabled: true,
    heartbeatIntervalSeconds: 60,
    idleThresholdSeconds: 180,
    flushIntervalSeconds: 10,
    trackAgentActivity: true,
    trackAiLines: true,
    humanTracking: { enabled: false },
    storageDirectory: defaultStorageDirectory(),
    timezone: detectTimezone(),
    weekStartsOn: 1,
    exclude: [...DEFAULT_EXCLUDE],
});

/** 判断普通对象（排除数组、null、Date 等）。 */
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/** 类型名，用于报错。 */
function typeName(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

/** 抛出统一形态的配置错误。 */
function fail(fieldPath, code, message) {
    throw new ConfigError(message, { code, path: fieldPath });
}

/**
 * 读布尔；未提供走默认。
 *
 * 取值的键与报错的字段路径分开传：嵌套字段的键是 `enabled`、路径是
 * `humanTracking.enabled`，两者不能混用。
 */
function readBoolean(source, key, fallback, fieldPath = key) {
    const value = source[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') fail(fieldPath, 'invalid_type', `必须是布尔值（收到 ${typeName(value)}）`);
    return value;
}

/** 读整数秒；未提供走默认。 */
function readInteger(input, fieldPath, fallback, limits) {
    const value = input[fieldPath];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(fieldPath, 'invalid_type', `必须是有限数字（收到 ${typeName(value)}）`);
    }
    if (!Number.isInteger(value)) fail(fieldPath, 'invalid_number', `必须是整数秒（收到 ${value}）`);
    if (value < limits.min || value > limits.max) {
        fail(fieldPath, 'out_of_range', `必须在 ${limits.min}..${limits.max} 之间（收到 ${value}）`);
    }
    return value;
}

/** 读 IANA 时区；未提供走本机检测值。 */
function readTimezone(input, fieldPath, fallback) {
    const value = input[fieldPath];
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value.trim() === '') {
        fail(fieldPath, 'invalid_type', '必须是 IANA 时区名（如 Asia/Shanghai）');
    }
    const zone = value.trim();
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
    }
    catch {
        fail(fieldPath, 'invalid_timezone', `不是有效的 IANA 时区（收到 ${JSON.stringify(zone)}）`);
    }
    return zone;
}

/** 读周起始日：0=周日，1=周一，允许 0..6。 */
function readWeekStartsOn(input, fieldPath, fallback) {
    const value = input[fieldPath];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        fail(fieldPath, 'invalid_type', '必须是整数（0=周日 … 6=周六）');
    }
    if (value < 0 || value > 6) fail(fieldPath, 'out_of_range', `必须在 0..6 之间（收到 ${value}）`);
    return value;
}

/**
 * 读存储目录：必须是本机绝对路径。
 *
 * 拒绝 `~` 展开、URL、协议相对路径（`//host/share`）、Windows UNC（`\\\\host\\share`）、
 * NUL 字节——这些都会把"本机私有目录"变成别的东西。
 */
function readDirectory(input, fieldPath, fallback) {
    const value = input[fieldPath];
    if (value === undefined) return fallback;
    if (typeof value !== 'string') fail(fieldPath, 'invalid_type', `必须是字符串（收到 ${typeName(value)}）`);
    const raw = value.trim();
    if (raw === '') fail(fieldPath, 'invalid_directory', '目录不能为空');
    if (raw.includes('\0')) fail(fieldPath, 'invalid_directory', '目录不能包含 NUL');
    if (raw.startsWith('~')) fail(fieldPath, 'invalid_directory', '不支持 ~ 展开，请写绝对路径');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) fail(fieldPath, 'invalid_directory', '不接受 URL，请写本机绝对路径');
    if (raw.startsWith('\\\\') || raw.startsWith('//')) {
        fail(fieldPath, 'invalid_directory', '不接受网络共享/UNC 路径，必须是本机绝对路径');
    }
    const looksAbsolute = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw);
    if (!looksAbsolute) fail(fieldPath, 'invalid_directory', `必须是绝对路径（收到 ${JSON.stringify(raw)}）`);
    return path.normalize(raw);
}

/**
 * 读排除列表：相对模式（目录名、文件名或 `*.ext`），拒绝对路径、`..` 穿越与控制字符。
 */
function readExclude(input, fieldPath, fallback) {
    const value = input[fieldPath];
    if (value === undefined) return Object.freeze([...fallback]);
    if (!Array.isArray(value)) fail(fieldPath, 'invalid_type', `必须是字符串数组（收到 ${typeName(value)}）`);
    if (value.length > 200) fail(fieldPath, 'out_of_range', '排除模式最多 200 条');
    const seen = new Set();
    const out = [];
    for (const item of value) {
        if (typeof item !== 'string') fail(fieldPath, 'invalid_type', `每一条都必须是字符串（收到 ${typeName(item)}）`);
        const pattern = item.trim().replace(/^\.\//, '').replace(/\/+$/, '');
        if (pattern === '') fail(fieldPath, 'invalid_pattern', '排除模式不能为空');
        if (pattern.length > 200) fail(fieldPath, 'invalid_pattern', '单条排除模式最多 200 字符');
        if (/[\0-\x1f]/.test(pattern)) fail(fieldPath, 'invalid_pattern', '排除模式不能含控制字符');
        if (path.isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern)) {
            fail(fieldPath, 'invalid_pattern', `排除模式必须是相对模式，不能是绝对路径（收到 ${JSON.stringify(pattern)}）`);
        }
        if (pattern.split('/').includes('..')) fail(fieldPath, 'invalid_pattern', '排除模式不能含 .. 穿越');
        const dedupe = process.platform === 'win32' ? pattern.toLowerCase() : pattern;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        out.push(pattern);
    }
    return Object.freeze(out);
}

/** 读嵌套 `humanTracking`：未知子字段与凭据子字段同样拒绝。 */
function readHumanTracking(input, fieldPath, fallback) {
    const value = input[fieldPath];
    if (value === undefined) return deepFreeze({ enabled: fallback.enabled });
    if (!isPlainObject(value)) fail(fieldPath, 'invalid_type', `必须是对象（收到 ${typeName(value)}）`);
    for (const key of Object.keys(value)) {
        if (CREDENTIAL_KEY.test(key)) fail(`${fieldPath}.${key}`, 'credential_forbidden', '配置不得包含凭据字段');
        if (!HUMAN_KEYS.includes(key)) fail(`${fieldPath}.${key}`, 'unknown_field', `未知配置字段（合法字段：${HUMAN_KEYS.join(', ')}）`);
    }
    return deepFreeze({ enabled: readBoolean(value, 'enabled', fallback.enabled, `${fieldPath}.enabled`) });
}

/**
 * 严格归一化配置。
 *
 * @param input - 用户/宿主给的配置对象，缺省即全默认。
 * @returns 深度冻结的配置（含 `CONFIG_VERSION` 之外的只读字段集）。
 * @throws ConfigError 未知字段、凭据字段、非法类型/数值/时区/目录、idle < heartbeat。
 */
export function normalizeConfig(input = {}) {
    const source = input === undefined || input === null ? {} : input;
    if (!isPlainObject(source)) {
        throw new ConfigError(`配置必须是普通对象（收到 ${typeName(source)}）`, { code: 'invalid_type', path: 'config' });
    }
    for (const key of Object.keys(source)) {
        if (CREDENTIAL_KEY.test(key)) fail(key, 'credential_forbidden', '配置不得包含凭据字段（密钥/令牌只留在宿主侧）');
        if (!TOP_LEVEL_KEYS.includes(key)) {
            fail(key, 'unknown_field', `未知配置字段（合法字段：${TOP_LEVEL_KEYS.join(', ')}）`);
        }
    }

    const heartbeat = readInteger(source, 'heartbeatIntervalSeconds', DEFAULT_CONFIG.heartbeatIntervalSeconds, LIMITS.heartbeatIntervalSeconds);
    const idle = readInteger(source, 'idleThresholdSeconds', DEFAULT_CONFIG.idleThresholdSeconds, LIMITS.idleThresholdSeconds);

    /** @type {任何} */
    const config = {
        enabled: readBoolean(source, 'enabled', DEFAULT_CONFIG.enabled),
        heartbeatIntervalSeconds: heartbeat,
        idleThresholdSeconds: idle,
        flushIntervalSeconds: readInteger(source, 'flushIntervalSeconds', DEFAULT_CONFIG.flushIntervalSeconds, LIMITS.flushIntervalSeconds),
        trackAgentActivity: readBoolean(source, 'trackAgentActivity', DEFAULT_CONFIG.trackAgentActivity),
        trackAiLines: readBoolean(source, 'trackAiLines', DEFAULT_CONFIG.trackAiLines),
        humanTracking: readHumanTracking(source, 'humanTracking', DEFAULT_CONFIG.humanTracking),
        storageDirectory: readDirectory(source, 'storageDirectory', DEFAULT_CONFIG.storageDirectory),
        timezone: readTimezone(source, 'timezone', DEFAULT_CONFIG.timezone),
        weekStartsOn: readWeekStartsOn(source, 'weekStartsOn', DEFAULT_CONFIG.weekStartsOn),
        exclude: readExclude(source, 'exclude', DEFAULT_CONFIG.exclude),
    };

    if (config.idleThresholdSeconds < config.heartbeatIntervalSeconds) {
        throw new ConfigError(
            `idleThresholdSeconds(${config.idleThresholdSeconds}) 必须不小于 heartbeatIntervalSeconds(${config.heartbeatIntervalSeconds})；`
            + '否则心跳窗口内就会断段。请同时调整 idleThresholdSeconds。',
            { code: 'inconsistent', path: 'idleThresholdSeconds' },
        );
    }

    return deepFreeze(config);
}

/**
 * 宽容的公共转换：把"可能来自旧版本磁盘/HTTP 的配置"折成干净的 config。
 *
 * 未知键、凭据键静默丢弃（它们本来就不该存在）；其余字段仍然严格校验，
 * 不允许用静默兜底掩盖错误值。返回**非冻结**的纯 JSON 对象，可直接回显给前端。
 *
 * @param input - 任意配置候选。
 * @returns 纯 JSON 的可序列化 config。
 */
export function sanitizeConfig(input = {}) {
    const source = input === undefined || input === null ? {} : input;
    if (!isPlainObject(source)) {
        throw new ConfigError(`配置必须是普通对象（收到 ${typeName(source)}）`, { code: 'invalid_type', path: 'config' });
    }
    /** @type {任何} */
    const kept = {};
    for (const [key, value] of Object.entries(source)) {
        if (CREDENTIAL_KEY.test(key)) continue;
        if (!TOP_LEVEL_KEYS.includes(key)) continue;
        kept[key] = value;
    }
    if (isPlainObject(kept.humanTracking)) {
        /** @type {任何} */
        const human = {};
        for (const [key, value] of Object.entries(kept.humanTracking)) {
            if (CREDENTIAL_KEY.test(key)) continue;
            if (!HUMAN_KEYS.includes(key)) continue;
            human[key] = value;
        }
        kept.humanTracking = human;
    }
    return JSON.parse(JSON.stringify(normalizeConfig(kept)));
}
