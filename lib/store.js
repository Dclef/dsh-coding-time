/**
 * dsh-coding-time · 本地 JSONL 存储 + 跨进程项目锁。
 *
 * 这块只做"在本机 ~/.dsh 下把活动记账安全落盘"，不认识 Harness、不认识 HTTP，
 * 也不产生任何网络行为。零 runtime 依赖，只用 node 内建。
 *
 * 磁盘布局（`root = <directory>/<profile>`，profile 只能是单段安全名）：
 *
 * ```
 * <directory>/<profile>/projects/<sha256(projectKey)>.json   项目状态快照（source of truth）
 * <directory>/<profile>/journal/YYYY-MM-DD.jsonl             按 UTC 日分片的记录流水
 * <directory>/<profile>/journal/corrupt/*.tail               被隔离的截断尾字节（取证用）
 * <directory>/<profile>/locks/<sha256(projectKey)>.lock      项目锁（O_EXCL + owner nonce/pid）
 * <directory>/<profile>/locks/journal.lock                   共享 journal 锁（见下）
 * ```
 *
 * 四条硬约束（刻意写死，别在调用方绕过）：
 *
 * 1. **文件名里不出现 cwd/项目名**：一律 sha256 截断成 32 hex，目录列表不会泄露
 *    工程路径；锁文件里也只存 hash，不存明文 projectId。
 * 2. **journal 只落白名单元数据**：落盘字段集合由 `RECORD_SCALARS` 加
 *    `files[]` / `lineEntries[]` 的细字段白名单决定。`cwd` / `files` / `sessionId` /
 *    `runId` / `lineEntries` / `linesPartial` 是**允许**的本机活动元数据（Host
 *    冷启动要靠它们恢复文件与会话）；`content` / `messages` / `token` 这类正文与
 *    凭据永远丢弃并告警。
 * 3. **不可证明持有者已死就不抢锁**：超时只报错，不删别人的锁。**没有例外**：
 *    0 字节或读不懂内容的锁文件既证明不了活着也证明不了死了，一律等到超时并
 *    告警要求人工确认，绝不用"够老了"当作死亡证据。
 * 4. **共享 journal 的写/修必须拿 `journal.lock`**：一天一个 shard 是全 profile
 *    共享的，项目锁串不了别的项目；"读尾 + 修复坏尾 + appendFile + 游标推进"
 *    整段在 journal 锁内完成，锁序固定 **project → journal**（`append()` 从不
 *    回头拿项目锁，因此不会死锁）。同一实例内另有一层进程内 promise 队列 +
 *    超时，避免两个并发 append 把彼此的文件锁当成"遗留锁"。
 *
 * 崩溃边界（非常重要，UI 应把 warnings 原样给用户）：
 *
 * - `append()` 把整行写进 OS page cache；`flush()` 才 fsync。进程崩溃不丢已
 *   append 的行（内核还会落盘），**断电**可能丢最后未 fsync 的部分。这里不做
 *   WAL/双写，无法承诺断电零损。
 * - `writeProjectState()` 是 tmp 文件 + fsync + rename 覆盖，读取方永远看到
 *   "上一份完整 snapshot"或"这一份完整 snapshot"，不会看到半截。
 * - 恢复能力：project state 是权威计数器；journal 是幂等事件流（同 id 同 rev
 *   忽略、更高 rev 覆盖，rev=0 也合法）。因此一次崩溃的最坏结果是重放，不会
 *   重复计数。调用方要按 `readRecords()` 的 upsert 结果重建，**不要按行数累加**。
 * - 锁被持有者遗留且无法证明死亡时，本层**不会自愈**：只能人工确认后删锁文件。
 *   这是刻意的取舍（宁可卡住也不破坏并发安全），UI 需要把 warning 显示出来。
 *
 * @module dsh-coding-time/store
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import fsDefault from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 存储层结构版本（snapshot / lock / journal 行都带 `v`）。 */
export const STORE_VERSION = 1;
/** journal 行版本。 */
export const JOURNAL_VERSION = 1;
/** 锁文件版本。 */
export const LOCK_VERSION = 1;

/**
 * 数值边界。**故意与 config.js 的同名字段保持一致**，但这里不 import 配置层：
 * 存储层要能独立测试、独立复用，不能让"配置校验改动"把存储层一起拖下水。
 */
export const STORE_LIMITS = Object.freeze({
    heartbeatIntervalSeconds: Object.freeze({ min: 5, max: 3600 }),
    flushIntervalSeconds: Object.freeze({ min: 1, max: 600 }),
    lockTimeoutMs: Object.freeze({ min: 50, max: 600_000 }),
    /** 单条 journal 行上限：canonical 记录带 files/lineEntries，给足空间；超限报错不截断。 */
    maxRecordBytes: 8 * 1024 * 1024,
    maxStateBytes: 8 * 1024 * 1024,
    maxStateDepth: 16,
    maxIdLength: 512,
    maxWarnings: 200,
});

/** profile 只能是单段安全名：不含分隔符、不以点开头、不含 `..`。 */
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** shard 文件名：严格 `YYYY-MM-DD.jsonl`。 */
const SHARD_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** 疑似正文/凭据的键名：快照里出现就丢弃，journal 里出现就告警。 */
const FORBIDDEN_KEY = /^(?:content|contents|text|body|message|messages|prompt|prompts|token|tokens|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|secret|secrets|password|passwd|passphrase|authorization|cookie|cookies|private[_-]?key|credential|credentials|session[_-]?key|webhook[_-]?url)$/i;

/**
 * journal 行允许出现的标量字段（白名单第一批）。
 *
 * 这里是"Host 冷启动要能从 journal 自己重建"所需要的最小 canonical 集合：
 * ActivityTracker 的 interval/evidence 记录里除了 `files` / `lineEntries` 两个
 * 嵌套数组（单独按细字段 sanitize）之外的全部字段。**故意不含**正文类字段。
 */
const RECORD_SCALARS = Object.freeze({
    strings: Object.freeze([
        'kind',
        'project',
        'projectKey',
        'cwd',
        'source',
        'sessionId',
        'runId',
        'closeReason',
        'startAt',
        'endAt',
        'updateAt',
    ]),
    counters: Object.freeze([
        'startMs',
        'endMs',
        'durationMs',
        'heartbeats',
        'observations',
        'linesAdded',
        'linesDeleted',
        'linesDropped',
        'fileCount',
        'filesDropped',
    ]),
    booleans: Object.freeze(['open', 'pending', 'linesPartial']),
    /** `linesUndated` 是固定形状的小对象。 */
    nested: Object.freeze(['linesUndated']),
});

/** `files[]` 每项允许的细字段。 */
const FILE_ENTRY_KEYS = Object.freeze(['path', 'touches', 'linesAdded', 'linesDeleted', 'excluded']);

/** `lineEntries[]` 每项允许的细字段。 */
const LINE_ENTRY_KEYS = Object.freeze(['at', 'file', 'added', 'deleted']);

/** 单个字符串元数据的上限（cwd / 路径可以长一点）。 */
const STRING_META_LIMIT = 1024;

/** `files[]` 与 `lineEntries[]` 的条数上限：防止一条记录把 journal 撑爆。 */
const MAX_FILES_PER_RECORD = 4096;
const MAX_LINE_ENTRIES_PER_RECORD = 8192;

/** 统一错误类型：`code` 给调用方分支，`path` 指出错字段。 */
export class StoreError extends Error {
    /**
     * @param message - 人读说明（中文，带期望值）。
     * @param options - { code, path, cause }。
     */
    constructor(message, { code = 'E_STORE', path: fieldPath = '', cause } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'StoreError';
        this.code = code;
        this.path = fieldPath;
    }
}

/** 普通对象判定（排除数组 / null / Date / Map）。 */
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/** 类型名，用于报错。 */
function typeName(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (value instanceof Date) return 'Date';
    return typeof value;
}

/** 毫秒 → ISO 字符串。 */
function isoOf(ms) {
    return new Date(ms).toISOString();
}

/** 有限非负整数判定。 */
function isNonNegativeInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * 记录是否与 `[from, to)` 相交。
 *
 * - interval：区间相交（昨天开始、今天还在继续的段不能丢）
 * - 零长度点（首条心跳 / evidence / pending）：按点判断 `from <= t < to`
 * - 缺省边界表示该侧无限
 */
function intersectsRange(record, from, to) {
    const start = Number(record.startMs);
    const end = Number(record.endMs ?? record.startMs);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return from === undefined && to === undefined;
    const isPoint = end <= start || record.kind === 'evidence' || record.pending === true;
    if (isPoint) {
        const at = end;
        if (from !== undefined && at < from) return false;
        if (to !== undefined && at >= to) return false;
        return true;
    }
    if (from !== undefined && end <= from) return false;
    if (to !== undefined && start >= to) return false;
    return true;
}

/** 取第一个非 undefined 的值（别名折叠用；null 也算"给了"）。 */
function firstDefined(...values) {
    for (const value of values) if (value !== undefined) return value;
    return undefined;
}

/** 稳定短 hash：文件名与锁键都用它，绝不用原始路径。 */
export function projectKeyHash(projectId) {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
        throw new StoreError('projectId 必须是非空字符串', { code: 'E_INVALID_PROJECT', path: 'projectId' });
    }
    return createHash('sha256').update(projectId.trim(), 'utf8').digest('hex').slice(0, 32);
}

/** UTC 日 shard 键。 */
function shardKeyOf(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) {
        throw new StoreError('时间戳必须是有限数字', { code: 'E_INVALID_RECORD', path: 'startMs' });
    }
    return new Date(ms).toISOString().slice(0, 10);
}

/** 睡一会儿（有限等待用；不做可中断，锁超时靠 deadline 判定）。 */
function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 读目录选项：本机绝对路径，拒 URL / UNC / `~` / NUL。 */
function readDirectoryOption(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new StoreError('directory 必须是非空绝对路径（通常是 ~/.dsh/coding-time）', { code: 'E_DIRECTORY_INVALID', path: 'directory' });
    }
    const raw = value.trim();
    if (raw.includes('\0')) throw new StoreError('directory 不能包含 NUL', { code: 'E_DIRECTORY_INVALID', path: 'directory' });
    if (raw.startsWith('~')) throw new StoreError('directory 不支持 ~ 展开，请传绝对路径', { code: 'E_DIRECTORY_INVALID', path: 'directory' });
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw new StoreError('directory 不接受 URL', { code: 'E_DIRECTORY_INVALID', path: 'directory' });
    if (raw.startsWith('\\\\') || raw.startsWith('//')) {
        throw new StoreError('directory 不接受网络共享/UNC 路径', { code: 'E_DIRECTORY_INVALID', path: 'directory' });
    }
    const absolute = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw);
    if (!absolute) throw new StoreError(`directory 必须是绝对路径（收到 ${JSON.stringify(raw)}）`, { code: 'E_DIRECTORY_INVALID', path: 'directory' });
    return path.normalize(raw);
}

/** 读 profile：单段安全名，且解析后必须仍在 directory 内。 */
function readProfileOption(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new StoreError('profile 必须是非空字符串', { code: 'E_PROFILE_INVALID', path: 'profile' });
    }
    const profile = value.trim();
    if (!PROFILE_PATTERN.test(profile) || profile === '.' || profile === '..' || profile.includes('..')) {
        throw new StoreError(
            `profile 只允许单段安全名 [A-Za-z0-9][A-Za-z0-9._-]{0,63}（收到 ${JSON.stringify(profile)}）`,
            { code: 'E_PROFILE_INVALID', path: 'profile' },
        );
    }
    return profile;
}

/** 读整数秒 / 毫秒。 */
function readIntegerOption(value, name, limits, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new StoreError(`${name} 必须是整数（收到 ${typeName(value)}）`, { code: 'E_OPTIONS_INVALID', path: name });
    }
    if (value < limits.min || value > limits.max) {
        throw new StoreError(`${name} 必须在 ${limits.min}..${limits.max} 之间（收到 ${value}）`, { code: 'E_OPTIONS_INVALID', path: name });
    }
    return value;
}

/**
 * 本地存储。
 *
 * 生命周期：`new → init() → (append / withProjectLock / readRecords / writeProjectState …) → close()`。
 * 除 `init()` 外的每个异步方法都要求已完成 `init()`，关闭后一律 `E_CLOSED`。
 */
export class JsonlStore {
    /**
     * @param options - {
     *   directory: 本机绝对目录（调用方给，通常 `~/.dsh/coding-time`）;
     *   profile: 分区名，默认 `default`;
     *   heartbeatIntervalSeconds / flushIntervalSeconds: 与配置层同名同义;
     *   lockTimeoutMs: 锁等待上限，默认 10s;
     *   now / fs: 测试注入点（fs 需是 node:fs/promises 同形态对象）。
     * }
     */
    constructor(options = {}) {
        if (!isPlainObject(options)) {
            throw new StoreError('构造参数必须是普通对象', { code: 'E_OPTIONS_INVALID', path: 'options' });
        }
        this.directory = readDirectoryOption(options.directory);
        this.profile = readProfileOption(options.profile === undefined ? 'default' : options.profile);

        this.heartbeatIntervalSeconds = readIntegerOption(
            options.heartbeatIntervalSeconds,
            'heartbeatIntervalSeconds',
            STORE_LIMITS.heartbeatIntervalSeconds,
            60,
        );
        this.flushIntervalSeconds = readIntegerOption(
            options.flushIntervalSeconds,
            'flushIntervalSeconds',
            STORE_LIMITS.flushIntervalSeconds,
            10,
        );
        this.lockTimeoutMs = readIntegerOption(options.lockTimeoutMs, 'lockTimeoutMs', STORE_LIMITS.lockTimeoutMs, 10_000);

        this._fs = options.fs ?? fsDefault;
        this._now = typeof options.now === 'function' ? options.now : () => Date.now();
        if (typeof this._now !== 'function') {
            throw new StoreError('now 必须是函数', { code: 'E_OPTIONS_INVALID', path: 'now' });
        }

        this.root = path.join(this.directory, this.profile);
        const relative = path.relative(path.resolve(this.directory), path.resolve(this.root));
        if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new StoreError('profile 解析后逃出了存储目录', { code: 'E_PROFILE_INVALID', path: 'profile' });
        }
        this.projectsDir = path.join(this.root, 'projects');
        this.journalDir = path.join(this.root, 'journal');
        this.corruptDir = path.join(this.journalDir, 'corrupt');
        this.locksDir = path.join(this.root, 'locks');

        this._ownerId = `${process.pid}-${randomBytes(9).toString('hex')}`;
        this._warnings = [];
        /** id → { rev, record, shard, byteOffset } */
        this._index = new Map();
        /** shard 文件名 → { safeOffset, size }：增量读，绝不重复解析整份文件。 */
        this._readers = new Map();
        this._dirty = new Set();
        this._needsDirSync = false;
        this._heldLocks = new Map();
        /** journal 锁的同进程重入深度（跨实例不共享；跨进程靠文件锁）。 */
        this._journalLockDepth = 0;
        /**
         * 同实例内按锁路径排队的 promise 链。
         *
         * 跨进程互斥靠 O_EXCL 文件锁；但**同一实例**里两个并发 append 会同时
         * 去 open('wx')，后者 EEXIST 后探活到自己（owner 相同）就会误判成"遗留
         * 锁"。所以进程内也排队：先过本地队列，再拿文件锁。这只是必要补充，
         * 不能替代文件锁（另一个进程不受本队列约束）。
         */
        this._localQueues = new Map();
        /** 当前异步调用链已持有的项目锁集合（用于区分"重入"与"并发排队"）。 */
        this._lockContext = new AsyncLocalStorage();
        this._tmpFiles = new Set();
        this._initialized = false;
        this._indexReady = false;
        this._closed = false;
        this._timer = null;
    }

    /** 实际存储根目录（含 profile）。 */
    get storageDirectory() {
        return this.root;
    }

    /** 最近告警的快照副本（UI 直接展示）。 */
    get warnings() {
        return this._warnings.slice();
    }

    // ---------------------------------------------------------------------
    // 生命周期
    // ---------------------------------------------------------------------

    /**
     * 建目录、收紧权限、回收死锁、修复 journal 截断尾。
     *
     * 幂等：重复调用返回同一份状态，不重复告警。
     *
     * @returns {Promise<{directory, profile, version, warnings, repaired: string[]}>}
     */
    async init() {
        if (this._closed) throw new StoreError('store 已关闭，不能再次 init', { code: 'E_CLOSED', path: 'init' });
        if (this._initialized) return this._status();

        for (const dir of [this.root, this.projectsDir, this.journalDir, this.corruptDir, this.locksDir]) {
            await this._mkdir(dir);
        }
        await this._tightenModes();

        const repaired = [];
        for (const warning of await this._reapDeadLocks()) repaired.push(warning.code);
        // 尾修复同样要拿 journal 跨进程锁：别的进程可能正好在半条行中间。
        await this._withJournalLock(async () => {
            for (const warning of await this._repairJournalTails()) repaired.push(warning.code);
        });

        this._initialized = true;
        this._startTimer();
        return this._status(repaired);
    }

    /**
     * 在项目锁内执行一段事务。
     *
     * 典型用法（Host 侧）：
     * ```js
     * await store.withProjectLock(projectKey, async () => {
     *   const snapshot = await store.readProjectState(projectKey); // 可能是 null
     *   const tracker = new ActivityTracker(config, { state: snapshot?.state ?? null });
     *   tracker.observe(...);              // 更新
     *   await store.writeProjectState(projectKey, tracker.exportState());
     *   await store.append(tracker.drain().records);
     * });
     * ```
     *
     * 锁是**跨进程**的：O_EXCL 创建 `<hash>.lock`，内容是 `{ v, owner, pid, host, createdAt }`。
     * 等待有上限（`lockTimeoutMs`），超时抛 `E_LOCK_TIMEOUT`，**不偷活锁**；同一进程
     * 内对同一项目嵌套调用直接抛 `E_LOCK_REENTRANT`（不死等、不静默降级）。
     *
     * @param projectId - 项目键（cwd 或 projectKey，任何稳定字符串）。
     * @param asyncFn - `async ({ projectId, projectIdHash, lockPath, warnings }) => any`。
     * @param options - { timeoutMs }：本次等待上限（覆盖实例默认值）。
     */
    async withProjectLock(projectId, asyncFn, options = {}) {
        this._assertReady('withProjectLock');
        if (typeof asyncFn !== 'function') {
            throw new StoreError('withProjectLock 需要异步函数', { code: 'E_OPTIONS_INVALID', path: 'asyncFn' });
        }
        if (options === null || typeof options !== 'object') {
            throw new StoreError('withProjectLock 的 options 必须是对象', { code: 'E_OPTIONS_INVALID', path: 'options' });
        }
        const hash = projectKeyHash(projectId);
        // 真嵌套（在锁内再要同一把锁）→ 立刻报错：等下去就是自己等自己。
        // 并发但独立的两条调用链 → 排本地队、再拿文件锁，等一会儿就能进（Host 会
        // 并发提交同一项目的两批，不能直接拒绝）。
        const active = this._lockContext.getStore();
        if (active !== undefined && active.has(hash)) {
            throw new StoreError(
                `同一调用链内对项目 ${hash} 的锁已持有：withProjectLock 不支持嵌套（会自锁）`,
                { code: 'E_LOCK_REENTRANT', path: 'projectId' },
            );
        }
        const timeoutMs = readIntegerOption(
            options.timeoutMs,
            'timeoutMs',
            { min: 10, max: 600_000 },
            this.lockTimeoutMs,
        );
        const lockPath = path.join(this.locksDir, `${hash}.lock`);
        return this._withLocalQueue(lockPath, async () => {
            await this._acquireLock(lockPath, { hash, timeoutMs });
            this._heldLocks.set(hash, this._ownerId);
            const inherited = this._lockContext.getStore();
            const next = new Set(inherited ?? []);
            next.add(hash);
            try {
                return await this._lockContext.run(next, async () => asyncFn({
                    projectId,
                    projectIdHash: hash,
                    lockPath,
                    warnings: () => this.warnings,
                }));
            }
            finally {
                this._heldLocks.delete(hash);
                await this._releaseLock(lockPath).catch((error) => {
                    this._warn('lock_release_failed', `释放项目锁失败：${error?.message ?? error}`, { lockPath });
                });
            }
        }, { timeoutMs, label: `项目锁 ${hash}` });
    }

    /**
     * 读项目状态快照。
     *
     * @param projectId - 项目键。
     * @param options - { raw: true } 时只返回调用方当初写入的 state 对象本身。
     * @returns null | {v, projectIdHash, revision, updatedAt, throughRev, state}
     */
    async readProjectState(projectId, options = {}) {
        this._assertReady('readProjectState');
        const hash = projectKeyHash(projectId);
        const file = path.join(this.projectsDir, `${hash}.json`);
        let text;
        try {
            text = await this._fs.readFile(file, 'utf8');
        }
        catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw new StoreError(`读取项目快照失败：${error?.message ?? error}`, { code: 'E_READ_FAILED', path: file, cause: error });
        }
        let envelope;
        try {
            envelope = JSON.parse(text);
        }
        catch {
            this._warn('state_corrupt', '项目快照不是合法 JSON，已忽略（保留文件供排查）', { file });
            return null;
        }
        if (!isPlainObject(envelope) || !isPlainObject(envelope.state) || !isNonNegativeInteger(envelope.revision)) {
            this._warn('state_corrupt', '项目快照结构不合法，已忽略（保留文件供排查）', { file });
            return null;
        }
        if (envelope.v !== STORE_VERSION) {
            this._warn('state_version_mismatch', `项目快照版本 ${envelope.v} 与当前 ${STORE_VERSION} 不符，已忽略`, { file });
            return null;
        }
        if (options.raw === true) return envelope.state;
        return {
            v: envelope.v,
            projectIdHash: hash,
            revision: envelope.revision,
            updatedAt: typeof envelope.updatedAt === 'string' ? envelope.updatedAt : '',
            throughRev: isNonNegativeInteger(envelope.throughRev) ? envelope.throughRev : 0,
            state: envelope.state,
        };
    }

    /**
     * 原子写项目状态快照：临时文件 → fsync → rename 覆盖。
     *
     * 读方永远看到完整旧快照或完整新快照；rename 失败时旧快照原样保留。
     * `throughRev` 是调用方对"本快照已经吸收了 journal 到哪个 rev"的声明，默认 0
     * （= 未声明，安全做法：把 journal 全量重放，靠 id/rev upsert 幂等去重）。
     *
     * @param projectId - 项目键。
     * @param state - 任意可 JSON 化的普通对象（tracker.exportState()）。
     * @param options - { throughRev?, expectedRevision? }：expectedRevision 用于乐观并发。
     * @returns {Promise<{revision, updatedAt, throughRev, stateBytes, warnings}>}
     */
    async writeProjectState(projectId, state, options = {}) {
        this._assertReady('writeProjectState');
        const hash = projectKeyHash(projectId);
        const file = path.join(this.projectsDir, `${hash}.json`);

        if (!isPlainObject(state)) {
            throw new StoreError(`state 必须是普通对象（收到 ${typeName(state)}）`, { code: 'E_STATE_INVALID', path: 'state' });
        }
        const sanitized = this._sanitizeState(state);
        const previous = await this._readEnvelope(file);
        const currentRevision = previous?.revision ?? 0;
        if (options.expectedRevision !== undefined) {
            if (!isNonNegativeInteger(options.expectedRevision)) {
                throw new StoreError('expectedRevision 必须是非负整数', { code: 'E_OPTIONS_INVALID', path: 'expectedRevision' });
            }
            if (options.expectedRevision !== currentRevision) {
                throw new StoreError(
                    `项目快照已被其他进程更新（期望 revision ${options.expectedRevision}，实际 ${currentRevision}）`,
                    { code: 'E_REVISION_CONFLICT', path: 'expectedRevision' },
                );
            }
        }
        let throughRev = 0;
        if (options.throughRev !== undefined) {
            if (!isNonNegativeInteger(options.throughRev)) {
                throw new StoreError('throughRev 必须是非负整数', { code: 'E_OPTIONS_INVALID', path: 'throughRev' });
            }
            throughRev = options.throughRev;
        }

        const revision = currentRevision + 1;
        const updatedAt = isoOf(this._now());
        const envelope = { v: STORE_VERSION, projectIdHash: hash, revision, updatedAt, throughRev, state: sanitized };
        let payload;
        try {
            payload = JSON.stringify(envelope);
        }
        catch (error) {
            throw new StoreError(`state 不能 JSON 序列化：${error?.message ?? error}`, { code: 'E_STATE_INVALID', path: 'state', cause: error });
        }
        const stateBytes = Buffer.byteLength(payload, 'utf8');
        if (stateBytes > STORE_LIMITS.maxStateBytes) {
            throw new StoreError(`state 过大（${stateBytes} 字节 > ${STORE_LIMITS.maxStateBytes}）`, { code: 'E_STATE_TOO_LARGE', path: 'state' });
        }

        const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        this._tmpFiles.add(tmp);
        try {
            const handle = await this._fs.open(tmp, 'w', 0o600);
            try {
                await handle.writeFile(payload, 'utf8');
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            await this._chmod(tmp, 0o600);
            await this._fs.rename(tmp, file);
            this._tmpFiles.delete(tmp);
            await this._chmod(file, 0o600);
            await this._syncDir(this.projectsDir);
        }
        catch (error) {
            this._tmpFiles.delete(tmp);
            await this._unlink(tmp).catch(() => {});
            this._warn('state_write_failed', `写项目快照失败，旧快照保持不变：${error?.message ?? error}`, { file });
            throw new StoreError(`写项目快照失败：${error?.message ?? error}`, { code: 'E_WRITE_FAILED', path: file, cause: error });
        }

        return { revision, updatedAt, throughRev, stateBytes, warnings: [] };
    }

    /**
     * 追加 journal 记录（同 id 按 revision upsert）。
     *
     * 每行以 `\n` 结尾；`flush()` 负责 fsync。同 id 且 rev 不更大 → 跳过（幂等）。
     * 每条记录在写入前过白名单，正文/凭据类字段被丢弃并告警。
     *
     * @param records - 单条或数组；每条至少 `{ id }`，可选 `rev`（正整数）。
     * @returns {Promise<{appended, skipped, shards, throughRev, warnings}>}
     */
    async append(records) {
        this._assertReady('append');
        const list = Array.isArray(records) ? records : [records];
        const result = { appended: 0, skipped: 0, shards: [], throughRev: {}, warnings: [] };
        if (list.length === 0) return result;

        await this._refreshIndex();

        /** @type {Map<string, { record: object, shard: string, bytes: number, forbidden: string[] }>} */
        const entries = [];
        const localRev = new Map();
        for (let i = 0; i < list.length; i += 1) {
            const normalized = this._normalizeRecord(list[i], i);
            const id = normalized.record.id;
            const known = localRev.has(id) ? localRev.get(id) : this._index.get(id)?.rev;
            const explicitRev = firstDefined(list[i]?.rev, list[i]?.revision);
            let rev;
            if (explicitRev === undefined) {
                // 内部版本号从 1 起（0 保留给"调用方显式声明的首次版本"）。
                rev = known === undefined ? 1 : known + 1;
            }
            else if (isNonNegativeInteger(explicitRev)) {
                // ActivityTracker 的 revision 从 0 起，必须接受 0（首次写入不能被当成"低版本"跳过）。
                rev = explicitRev;
            }
            else {
                throw new StoreError(
                    `第 ${i + 1} 条记录的 rev/revision 必须是非负整数（收到 ${typeName(explicitRev)}）`,
                    { code: 'E_INVALID_RECORD', path: `records[${i}].rev` },
                );
            }

            // 只有"同一个 id 已经存在且版本不更大"才跳过；首次出现永远写入（含 rev=0）。
            if (known !== undefined && known >= rev) {
                result.skipped += 1;
                continue;
            }
            normalized.record.rev = rev;
            if (!isNonNegativeInteger(normalized.record.revision)) normalized.record.revision = rev;
            const line = `${JSON.stringify(normalized.record)}\n`;
            const bytes = Buffer.byteLength(line, 'utf8');
            if (bytes > STORE_LIMITS.maxRecordBytes) {
                throw new StoreError(`第 ${i + 1} 条记录过大（${bytes} 字节 > ${STORE_LIMITS.maxRecordBytes}）`, { code: 'E_INVALID_RECORD', path: `records[${i}]` });
            }
            const shard = shardKeyOf(normalized.record.startMs ?? this._now());
            localRev.set(id, rev);
            entries.push({ record: normalized.record, shard, line, bytes, forbidden: normalized.forbidden });
        }

        const batches = new Map();
        for (const entry of entries) {
            const bucket = batches.get(entry.shard) ?? { lines: [], bytes: 0 };
            bucket.lines.push(entry.line);
            bucket.bytes += entry.bytes;
            batches.set(entry.shard, bucket);
        }

        // 关键：**读尾修复 + 追加**这一整段必须跨进程互斥，否则另一个进程的修复
        // 逻辑会把本进程刚写下的半条行当成坏尾截掉。锁序固定 project → journal。
        // 索引更新放在锁外（它只依赖本实例，不需要与磁盘同步）。
        await this._withJournalLock(async () => {
            for (const [shard, bucket] of batches) {
                const fileName = `${shard}.jsonl`;
                const file = path.join(this.journalDir, fileName);
                let beforeSize;
                try {
                    beforeSize = await this._ensureTrailingNewline(file);
                    const created = beforeSize === 0;
                    await this._fs.appendFile(file, bucket.lines.join(''), { mode: 0o600 });
                    await this._chmod(file, 0o600);
                    const afterSize = beforeSize + bucket.bytes;
                    const reader = this._readers.get(fileName);
                    if (reader && reader.size === beforeSize && reader.safeOffset === beforeSize) {
                        reader.safeOffset = afterSize;
                        reader.size = afterSize;
                    }
                    else if (reader) {
                        this._readers.delete(fileName);
                        this._indexReady = false;
                    }
                    if (created) this._needsDirSync = true;
                    this._dirty.add(shard);
                    result.shards.push(shard);
                }
                catch (error) {
                    this._warn('journal_write_failed', `journal 写入失败：${error?.message ?? error}`, { shard });
                    throw new StoreError(`journal 写入失败：${error?.message ?? error}`, { code: 'E_WRITE_FAILED', path: file, cause: error });
                }
            }
        });

        for (const entry of entries) {
            const id = entry.record.id;
            const existing = this._index.get(id);
            if (existing && existing.rev >= entry.record.rev) continue;
            this._index.set(id, {
                rev: entry.record.rev,
                record: entry.record,
                shard: `${entry.shard}.jsonl`,
                byteOffset: 0,
            });
            result.throughRev[id] = entry.record.rev;
            result.appended += 1;
            for (const field of entry.forbidden) {
                this._warn('record_field_forbidden_dropped', `journal 丢弃疑似正文/凭据字段 ${field}`, { id });
            }
        }
        result.warnings = this.warnings;
        return result;
    }

    /**
     * 读 journal 里"每个 id 的最新 revision"。
     *
     * **区间语义是半开相交**（`[from, to)`），不是"起点落在区间内"：
     * - interval 记录：`endMs > from && startMs < to`（跨午夜、昨天开始今天还在
     *   继续的段仍然会返回，交给 `summarize()` 去裁切）
     * - evidence / pending 记录：按 `endMs`（事实发生时刻）判断 `from <= at < to`
     *
     * 每次调用都会增量 stat 一遍 shard 文件，所以**别的进程刚 append 的记录也看得见**
     * （`_readers` 只是"已解析到哪个字节"的游标，不是数据快照）。
     *
     * @param options - { from?, to?, project?, projectKey?, shard?, limit? }：
     *   from/to 是毫秒时间戳（半开区间相交）；project/projectKey 精确匹配；
     *   shard 是 `YYYY-MM-DD`。
     * @returns 按 startMs / project / id 排序的记录副本数组（`rev` 与 `revision` 都有）。
     */
    async readRecords(options = {}) {
        this._assertReady('readRecords');
        if (!isPlainObject(options)) {
            throw new StoreError('readRecords 参数必须是普通对象', { code: 'E_OPTIONS_INVALID', path: 'options' });
        }
        const { from, to, shard } = options;
        for (const [name, value] of Object.entries({ from, to })) {
            if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
                throw new StoreError(`${name} 必须是毫秒时间戳`, { code: 'E_OPTIONS_INVALID', path: name });
            }
        }
        if (from !== undefined && to !== undefined && to <= from) {
            throw new StoreError(`to 必须大于 from（半开区间 [from, to)，收到 ${from}..${to}）`, { code: 'E_OPTIONS_INVALID', path: 'to' });
        }
        if (shard !== undefined && (typeof shard !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(shard))) {
            throw new StoreError('shard 必须是 YYYY-MM-DD', { code: 'E_OPTIONS_INVALID', path: 'shard' });
        }
        const project = options.project;
        const projectKey = options.projectKey;
        for (const [name, value] of Object.entries({ project, projectKey })) {
            if (value !== undefined && typeof value !== 'string') {
                throw new StoreError(`${name} 必须是字符串`, { code: 'E_OPTIONS_INVALID', path: name });
            }
        }

        await this._refreshIndex();

        const out = [];
        for (const entry of this._index.values()) {
            const record = entry.record;
            if (shard !== undefined && entry.shard !== `${shard}.jsonl`) continue;
            if (project !== undefined && record.project !== project) continue;
            if (projectKey !== undefined && record.projectKey !== projectKey) continue;
            if (!intersectsRange(record, from, to)) continue;
            // 两个版本字段都回给调用方：ActivityTracker.upsertRecords 读 `revision`，
            // store 自己的 upsert 读 `rev`，不该让调用方记两套。
            out.push({ ...record, revision: record.revision ?? record.rev, rev: record.rev });
        }
        out.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0)
            || String(a.project ?? '').localeCompare(String(b.project ?? ''))
            || String(a.id).localeCompare(String(b.id)));
        if (options.limit !== undefined) {
            if (!isNonNegativeInteger(options.limit) || options.limit === 0) {
                throw new StoreError('limit 必须是正整数', { code: 'E_OPTIONS_INVALID', path: 'limit' });
            }
            return out.slice(0, options.limit);
        }
        return out;
    }

    /**
     * 列举磁盘上所有项目快照（冷启动恢复用，不需要逐个项目 id）。
     *
     * 枚举 `projects/*.json`，坏文件跳过并 push warning，**不抛**。文件名只有 hash，
     * 展示名与累计从 `state.project` / `state.cwd` 里取；journal 里也有 cwd，
     * 但"当前活的 state"只有这里能整份拿到。
     *
     * @param options - { includeState = false }：true 时把 snapshot 的 state 原样带上。
     * @returns {Promise<Array<{projectIdHash, revision, updatedAt, throughRev, state?}>>}
     */
    async listProjectStates(options = {}) {
        this._assertReady('listProjectStates');
        if (!isPlainObject(options)) {
            throw new StoreError('listProjectStates 参数必须是普通对象', { code: 'E_OPTIONS_INVALID', path: 'options' });
        }
        const includeState = options.includeState === true;
        let names;
        try {
            names = await this._fs.readdir(this.projectsDir);
        }
        catch (error) {
            if (error?.code === 'ENOENT') return [];
            throw new StoreError(`列举项目快照失败：${error?.message ?? error}`, { code: 'E_READ_FAILED', path: this.projectsDir, cause: error });
        }
        const out = [];
        for (const name of names) {
            if (!name.endsWith('.json')) continue;
            const file = path.join(this.projectsDir, name);
            let envelope;
            try {
                envelope = await this._readEnvelope(file);
            }
            catch {
                this._warn('state_read_failed', '项目快照读取失败，已跳过', { file });
                continue;
            }
            if (!envelope) {
                // 坏 JSON / 结构不合法：`_readEnvelope` 已经告警过，这里只跳过。
                continue;
            }
            if (envelope.v !== STORE_VERSION || !isPlainObject(envelope.state)) {
                this._warn('state_version_mismatch', `项目快照版本 ${envelope.v} 与当前 ${STORE_VERSION} 不符，已跳过`, { file });
                continue;
            }
            const entry = {
                projectIdHash: typeof envelope.projectIdHash === 'string' ? envelope.projectIdHash : name.slice(0, -5),
                revision: envelope.revision,
                updatedAt: typeof envelope.updatedAt === 'string' ? envelope.updatedAt : '',
                throughRev: isNonNegativeInteger(envelope.throughRev) ? envelope.throughRev : 0,
            };
            if (includeState) entry.state = envelope.state;
            out.push(entry);
        }
        out.sort((a, b) => a.projectIdHash.localeCompare(b.projectIdHash));
        return out;
    }

    /**
     * 删除早于 `before`（`YYYY-MM-DD`，UTC 日）的 journal 分片。
     *
     * 只删**整份** shard 文件，绝不改写存活 shard；被删 shard 的索引项一并丢弃。
     * 删除是不可逆的（快照里 `throughRev` 仍保留计数），调用方自己决定保留窗口。
     *
     * @param options - { before: YYYY-MM-DD }。
     * @returns {Promise<{removed: string[], warnings}>}
     */
    async pruneJournal(options = {}) {
        this._assertReady('pruneJournal');
        if (!isPlainObject(options)) {
            throw new StoreError('pruneJournal 参数必须是普通对象', { code: 'E_OPTIONS_INVALID', path: 'options' });
        }
        const before = options.before;
        if (typeof before !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(before)) {
            throw new StoreError('before 必须是 YYYY-MM-DD', { code: 'E_OPTIONS_INVALID', path: 'before' });
        }
        if (!Number.isFinite(Date.parse(`${before}T00:00:00Z`))) {
            throw new StoreError(`before 不是合法日期：${before}`, { code: 'E_OPTIONS_INVALID', path: 'before' });
        }
        const removed = [];
        // 删 shard 也在 journal 锁内做：否则可能删掉别的进程正在追加的文件。
        await this._withJournalLock(async () => {
            for (const name of await this._shardNames()) {
                const day = name.slice(0, 10);
                if (!(day < before)) continue;
                const file = path.join(this.journalDir, name);
                try {
                    await this._unlink(file);
                    removed.push(day);
                    this._dropShardIndex(name);
                    this._readers.delete(name);
                    this._dirty.delete(day);
                }
                catch (error) {
                    this._warn('journal_prune_failed', `删除 journal 分片失败：${error?.message ?? error}`, { shard: name });
                }
            }
        });
        if (removed.length > 0) {
            this._indexReady = false;
            await this._syncDir(this.journalDir);
        }
        return { removed, warnings: this.warnings };
    }

    /**
     * fsync 所有脏 shard（幂等；关闭后调用返回 0，不抛）。
     *
     * @returns {Promise<{flushed, warnings}>}
     */
    async flush() {
        if (this._closed) {
            this._warn('flush_after_close', 'store 已关闭，flush 为空操作');
            return { flushed: 0, warnings: this.warnings };
        }
        let flushed = 0;
        for (const shard of [...this._dirty]) {
            const file = path.join(this.journalDir, `${shard}.jsonl`);
            let handle;
            try {
                handle = await this._fs.open(file, 'r+');
                await handle.sync();
                this._dirty.delete(shard);
                flushed += 1;
            }
            catch (error) {
                if (error?.code === 'ENOENT') {
                    this._dirty.delete(shard);
                    continue;
                }
                this._warn('flush_failed', `journal fsync 失败：${error?.message ?? error}`, { shard });
            }
            finally {
                await handle?.close().catch(() => {});
            }
        }
        if (this._needsDirSync) {
            await this._syncDir(this.journalDir);
            this._needsDirSync = false;
        }
        return { flushed, warnings: this.warnings };
    }

    /**
     * flush 后关闭（幂等）。不删除任何数据；未释放的自有锁会被尽力释放。
     *
     * @returns {Promise<{closed, warnings}>}
     */
    async close() {
        if (this._closed) return { closed: true, warnings: this.warnings };
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        if (this._initialized) await this.flush().catch(() => {});
        for (const [hash, owner] of [...this._heldLocks]) {
            this._warn('lock_held_at_close', '关闭时仍持有项目锁，已尽力释放', { projectIdHash: hash });
            try {
                await this._releaseLock(path.join(this.locksDir, `${hash}.lock`));
            }
            catch { /* 释放失败不阻塞关闭；锁文件有 pid 证据可被后续 init 回收 */ }
            this._heldLocks.delete(hash);
        }
        for (const tmp of [...this._tmpFiles]) {
            await this._unlink(tmp).catch(() => {});
            this._tmpFiles.delete(tmp);
        }
        this._closed = true;
        return { closed: true, warnings: this.warnings };
    }

    // ---------------------------------------------------------------------
    // 锁
    // ---------------------------------------------------------------------

    /** journal 共享锁的文件名（**日级全 journal**，不是 per-shard）。 */
    get journalLockPath() {
        return path.join(this.locksDir, 'journal.lock');
    }

    /**
     * 在 journal 跨进程锁内执行一段同步的写/修复事务。
     *
     * 为什么需要它：多个进程会写**同一个** UTC 日 shard 文件。项目锁只按项目
     * 串行化，管不住"进程 A 正在 appendFile、进程 B 的修复逻辑把 A 的半个行当
     * 坏尾截掉"。所以凡是"读尾 + 修复 + 追加 + 更新游标"这一段必须整体互斥。
     *
     * 锁序固定为 **project → journal**：`append()` 只拿 journal 锁、从不回头拿
     * 项目锁，`withProjectLock()` 内的 `append()` 天然是 project → journal，
     * 因此不存在反向获取，也就不会死锁。
     */
    async _withJournalLock(asyncFn, { timeoutMs = this.lockTimeoutMs } = {}) {
        if (this._journalLockDepth > 0) {
            // 本实例已持有（例如 init 的修复被 append 复用）：同进程重入直接跑。
            this._journalLockDepth += 1;
            try {
                return await asyncFn();
            }
            finally {
                this._journalLockDepth -= 1;
            }
        }
        return this._withLocalQueue(this.journalLockPath, async () => {
            await this._acquireLock(this.journalLockPath, { hash: 'journal', timeoutMs });
            this._journalLockDepth = 1;
            try {
                return await asyncFn();
            }
            finally {
                this._journalLockDepth = 0;
                await this._releaseLock(this.journalLockPath).catch((error) => {
                    this._warn('lock_release_failed', `释放 journal 锁失败：${error?.message ?? error}`, { lockPath: this.journalLockPath });
                });
            }
        });
    }

    /**
     * 同实例内按 key 串行化（promise 链，不阻塞事件循环）。
     *
     * 只解决"同一个 JsonlStore 被并发调用"；跨进程仍由文件锁负责。两者叠加才
     * 既不会自锁误判，也不会与别的进程撞车。等待也受 `timeoutMs` 约束：
     * 本地队列同样**不无限等**，超时抛 E_LOCK_TIMEOUT，与文件锁口径一致。
     */
    async _withLocalQueue(key, asyncFn, { timeoutMs = this.lockTimeoutMs, label = key } = {}) {
        const previous = this._localQueues.get(key) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const tail = previous.then(() => gate);
        this._localQueues.set(key, tail);
        try {
            await this._waitWithDeadline(previous, timeoutMs, { key, label });
            return await asyncFn();
        }
        finally {
            release();
            // 最后一个排队者负责清掉链，避免 Map 无限增长。
            void tail.then(() => {
                if (this._localQueues.get(key) === tail) this._localQueues.delete(key);
            });
        }
    }

    /** 等 `promise` 至多 `timeoutMs`；超时抛 E_LOCK_TIMEOUT（不取消对方，只是不再等）。 */
    async _waitWithDeadline(promise, timeoutMs, { key, label }) {
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => { resolve('timeout'); }, timeoutMs);
            if (typeof timer.unref === 'function') timer.unref();
        });
        try {
            const outcome = await Promise.race([promise.then(() => 'ok'), timeout]);
            if (outcome === 'timeout') {
                throw new StoreError(
                    `等待本进程内 ${label} 队列超时（${timeoutMs}ms，key=${key}）；未抢占、未跳过排队`,
                    { code: 'E_LOCK_TIMEOUT', path: key },
                );
            }
        }
        finally {
            clearTimeout(timer);
        }
    }

    /** O_EXCL 抢锁；有界等待；只有"同主机 + pid 已死"才回收别人的锁。 */
    async _acquireLock(lockPath, { hash, timeoutMs }) {
        const deadline = this._now() + timeoutMs;
        let delay = 20;
        let longHoldWarned = false;
        for (;;) {
            let handle;
            try {
                handle = await this._fs.open(lockPath, 'wx', 0o600);
                const payload = JSON.stringify({
                    v: LOCK_VERSION,
                    owner: this._ownerId,
                    pid: process.pid,
                    host: os.hostname(),
                    createdAt: isoOf(this._now()),
                    key: hash,
                });
                try {
                    await handle.writeFile(`${payload}\n`, 'utf8');
                    await handle.sync();
                }
                finally {
                    await handle.close();
                }
                await this._chmod(lockPath, 0o600);
                await this._syncDir(this.locksDir);
                return;
            }
            catch (error) {
                if (error?.code === 'ENOENT') {
                    await this._mkdir(this.locksDir);
                    continue;
                }
                if (error?.code !== 'EEXIST') {
                    throw new StoreError(`创建项目锁失败：${error?.message ?? error}`, { code: 'E_WRITE_FAILED', path: lockPath, cause: error });
                }
            }

            const info = await this._inspectLock(lockPath);
            if (!info) continue;

            const verdict = this._judgeLock(info);
            if (verdict === 'dead') {
                await this._unlink(lockPath).catch(() => {});
                await this._syncDir(this.locksDir);
                this._warn('lock_reclaimed_dead', '回收了同主机上已退出进程遗留的项目锁', { key: hash });
                continue;
            }
            if (verdict === 'self') {
                throw new StoreError('检测到本进程遗留的同名锁（owner 相同）', { code: 'E_LOCK_STALE_SELF', path: lockPath });
            }
            if (!longHoldWarned && verdict === 'alive'
                && this._now() - info.stat.mtimeMs > this.heartbeatIntervalSeconds * 2000) {
                longHoldWarned = true;
                this._warn('lock_held_long', '项目锁被同主机进程持有超过 2 个心跳窗口（未偷锁，继续等）', { key: hash });
            }

            if (this._now() >= deadline) {
                const owner = isPlainObject(info.payload)
                    ? `${info.payload.host ?? 'unknown'}/${info.payload.pid ?? '?'}`
                    : 'unknown（锁内容不可读）';
                if (!isPlainObject(info.payload)) {
                    this._warn(
                        'lock_unreadable_needs_recovery',
                        '项目锁内容不可读，无法证明持有者已退出；已按"不抢活锁"处理，需要人工确认后删除该锁文件',
                        { lockPath, key: hash, size: info.stat.size },
                    );
                }
                throw new StoreError(
                    `等待项目锁超时（${timeoutMs}ms，hash=${hash}，持有者 ${owner}）；未偷取活锁`,
                    { code: 'E_LOCK_TIMEOUT', path: lockPath },
                );
            }
            await sleep(delay + Math.floor(Math.random() * 15));
            delay = Math.min(delay * 2, 200);
        }
    }

    /** 读锁文件（不存在返回 null）。 */
    async _inspectLock(lockPath) {
        let stat;
        try {
            stat = await this._fs.stat(lockPath);
        }
        catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
        let raw = '';
        try {
            raw = await this._fs.readFile(lockPath, 'utf8');
        }
        catch (error) {
            if (error?.code === 'ENOENT') return null;
        }
        let payload = null;
        try {
            payload = JSON.parse(raw.trim());
        }
        catch {
            payload = null;
        }
        return { lockPath, stat, raw, payload };
    }

    /**
     * 判定锁持有者状态。
     *
     * `dead` **只**由"同主机 + pid 探测 ESRCH"给出——这是唯一能证明持有者已退出
     * 的证据。0 字节 / 读不懂内容的锁既证明不了活着也证明不了死了，一律 `unknown`：
     * 不抢、只等、超时告警要求人工确认（创建者可能刚 open 就被暂停）。
     * PID 复用这种极端情况本层无法证明，属于已知边界（见模块文档）。
     */
    _judgeLock(info) {
        const payload = info.payload;
        if (!isPlainObject(payload)) return 'unknown';
        if (payload.owner === this._ownerId) return 'self';
        if (typeof payload.host !== 'string' || payload.host !== os.hostname()) return 'unknown';
        if (!Number.isInteger(payload.pid) || payload.pid <= 0) return 'unknown';
        if (payload.pid === process.pid) return 'alive';
        try {
            process.kill(payload.pid, 0);
            return 'alive';
        }
        catch (error) {
            if (error?.code === 'ESRCH') return 'dead';
            if (error?.code === 'EPERM') return 'alive';
            return 'unknown';
        }
    }

    /** 释放自己的锁；owner 已变则保留别人的锁并告警。 */
    async _releaseLock(lockPath) {
        const info = await this._inspectLock(lockPath);
        if (!info) return;
        if (info.payload?.owner !== this._ownerId) {
            this._warn('lock_release_skipped', '锁文件已不属于本进程，未删除', { lockPath });
            return;
        }
        await this._unlink(lockPath);
        await this._syncDir(this.locksDir);
    }

    /** init 时回收死锁（只碰有证据的）。 */
    async _reapDeadLocks() {
        const out = [];
        let names;
        try {
            names = await this._fs.readdir(this.locksDir);
        }
        catch {
            return out;
        }
        for (const name of names) {
            if (!name.endsWith('.lock')) continue;
            const lockPath = path.join(this.locksDir, name);
            let info;
            try {
                info = await this._inspectLock(lockPath);
            }
            catch {
                continue;
            }
            if (!info) continue;
            if (this._judgeLock(info) !== 'dead') continue;
            await this._unlink(lockPath).catch(() => {});
            out.push(this._warn('lock_reclaimed_dead', '回收了同主机上已退出进程遗留的项目锁', { lock: name }));
        }
        return out;
    }

    // ---------------------------------------------------------------------
    // journal：写与读
    // ---------------------------------------------------------------------

    /**
     * 记录白名单化；返回 `{ record, forbidden }`。
     *
     * 保留 canonical ActivityTracker 记录（含 cwd/files/sessionId/runId/
     * lineEntries/linesPartial）——这些是本机活动元数据，Host 冷启动要靠它们
     * 恢复文件与会话；只把真正的正文/凭据键丢掉并回报。
     */
    _normalizeRecord(raw, index) {
        if (!isPlainObject(raw)) {
            throw new StoreError(`第 ${index + 1} 条记录必须是普通对象`, { code: 'E_INVALID_RECORD', path: `records[${index}]` });
        }
        const idRaw = raw.id;
        if (typeof idRaw !== 'string' || idRaw.trim() === '') {
            throw new StoreError(`第 ${index + 1} 条记录缺少非空字符串 id`, { code: 'E_INVALID_RECORD', path: `records[${index}].id` });
        }
        const id = idRaw.trim();
        if (id.length > STORE_LIMITS.maxIdLength) {
            throw new StoreError(`第 ${index + 1} 条记录 id 过长`, { code: 'E_INVALID_RECORD', path: `records[${index}].id` });
        }

        // 采集层（collector）用的是 start/end/ms/revision/added/deleted 这套短名；
        // 这里做一层**显式**别名折叠，避免调用方为了写库再复制一份映射表。
        const view = {
            ...raw,
            startMs: firstDefined(raw.startMs, raw.start, raw.at),
            endMs: firstDefined(raw.endMs, raw.end),
            durationMs: firstDefined(raw.durationMs, raw.ms),
            linesAdded: firstDefined(raw.linesAdded, raw.added),
            linesDeleted: firstDefined(raw.linesDeleted, raw.deleted),
        };
        const where = `records[${index}]`;
        const fail = (field, message, code = 'E_INVALID_RECORD') => {
            throw new StoreError(`第 ${index + 1} 条记录${message}`, { code, path: `${where}.${field}` });
        };

        /** @type {Record<string, any>} */
        const record = { v: JOURNAL_VERSION, kind: 'interval', id, recordedAt: isoOf(this._now()) };

        for (const field of RECORD_SCALARS.strings) {
            const value = view[field];
            if (value === undefined || value === null) continue;
            if (typeof value !== 'string') fail(field, `字段 ${field} 必须是字符串`);
            const text = value.trim();
            if (text.length > STRING_META_LIMIT) fail(field, `字段 ${field} 过长`);
            if (field === 'kind') {
                if (!/^[a-z][a-z0-9_-]{0,31}$/.test(text)) fail(field, 'kind 必须是短 token（小写字母/数字/下划线）');
            }
            if (field === 'source' && !/^[a-z][a-z0-9_-]{0,31}$/.test(text)) fail(field, 'source 必须是短 token');
            if (text !== '') record[field] = text;
        }
        for (const field of RECORD_SCALARS.counters) {
            const value = view[field];
            if (value === undefined || value === null) continue;
            if (!isNonNegativeInteger(value)) fail(field, `字段 ${field} 必须是非负整数（收到 ${typeName(value)}）`);
            record[field] = value;
        }
        for (const field of RECORD_SCALARS.booleans) {
            const value = view[field];
            if (value === undefined || value === null) continue;
            if (typeof value !== 'boolean') fail(field, `字段 ${field} 必须是布尔值`);
            record[field] = value;
        }
        const undated = view.linesUndated;
        if (undated !== undefined && undated !== null) {
            if (!isPlainObject(undated)) fail('linesUndated', '字段 linesUndated 必须是对象');
            record.linesUndated = {
                added: isNonNegativeInteger(undated.added) ? undated.added : 0,
                deleted: isNonNegativeInteger(undated.deleted) ? undated.deleted : 0,
            };
        }

        if (view.files !== undefined && view.files !== null) {
            if (!Array.isArray(view.files)) fail('files', '字段 files 必须是数组');
            if (view.files.length > MAX_FILES_PER_RECORD) fail('files', `files 最多 ${MAX_FILES_PER_RECORD} 条`);
            record.files = [];
            for (let i = 0; i < view.files.length; i += 1) {
                const entry = view.files[i];
                if (!isPlainObject(entry)) continue;
                const clean = {};
                if (typeof entry.path === 'string' && entry.path.trim() !== '') clean.path = entry.path.trim().slice(0, STRING_META_LIMIT);
                else continue; // 没有路径的文件证据没有意义
                if (isNonNegativeInteger(entry.touches)) clean.touches = entry.touches;
                if (isNonNegativeInteger(entry.linesAdded)) clean.linesAdded = entry.linesAdded;
                if (isNonNegativeInteger(entry.linesDeleted)) clean.linesDeleted = entry.linesDeleted;
                if (typeof entry.excluded === 'boolean') clean.excluded = entry.excluded;
                record.files.push(clean);
            }
            if (record.fileCount === undefined) record.fileCount = record.files.length;
        }
        if (view.lineEntries !== undefined && view.lineEntries !== null) {
            if (!Array.isArray(view.lineEntries)) fail('lineEntries', '字段 lineEntries 必须是数组');
            if (view.lineEntries.length > MAX_LINE_ENTRIES_PER_RECORD) fail('lineEntries', `lineEntries 最多 ${MAX_LINE_ENTRIES_PER_RECORD} 条`);
            record.lineEntries = [];
            for (const entry of view.lineEntries) {
                if (!isPlainObject(entry)) continue;
                if (!isNonNegativeInteger(entry.at)) continue;
                const clean = { at: entry.at };
                if (typeof entry.file === 'string') clean.file = entry.file.slice(0, STRING_META_LIMIT);
                if (isNonNegativeInteger(entry.added)) clean.added = entry.added;
                if (isNonNegativeInteger(entry.deleted)) clean.deleted = entry.deleted;
                record.lineEntries.push(clean);
            }
        }

        if (record.startMs === undefined) {
            fail('startMs', '缺少时间（startMs/start/at 至少要有一个）');
        }
        if (record.endMs === undefined) record.endMs = record.startMs;
        if (record.endMs < record.startMs) record.endMs = record.startMs;
        if (record.durationMs === undefined) record.durationMs = Math.max(0, record.endMs - record.startMs);
        record.time = record.startMs;
        // canonical `revision`：ActivityTracker 的 upsert 读的是它，append 的 upsert 读的是 `rev`。
        // 两个都写，避免调用方在两套字段之间猜。
        if (raw.revision !== undefined && raw.revision !== null) {
            if (!isNonNegativeInteger(raw.revision)) fail('revision', 'revision 必须是非负整数');
            record.revision = raw.revision;
        }

        const forbidden = [];
        const walkForbidden = (value, prefix, depth) => {
            if (depth > 4 || value === null || typeof value !== 'object') return;
            for (const [key, item] of Object.entries(value)) {
                if (FORBIDDEN_KEY.test(key)) {
                    forbidden.push(prefix === '' ? key : `${prefix}.${key}`);
                    continue;
                }
                walkForbidden(item, prefix === '' ? key : `${prefix}.${key}`, depth + 1);
            }
        };
        walkForbidden(raw, '', 0);
        return { record, forbidden };
    }

    /** 增量刷新索引：只解析新增/变化的完整行，坏中间行告警跳过。 */
    async _refreshIndex() {
        const names = await this._shardNames();
        if (this._indexReady) {
            for (const name of names) await this._syncShard(name);
            return;
        }
        this._index.clear();
        for (const name of names) {
            this._readers.delete(name);
            await this._syncShard(name);
        }
        this._indexReady = true;
    }

    /** 读某 shard 的新增部分；文件被截断则丢弃索引重读。 */
    async _syncShard(name) {
        const file = path.join(this.journalDir, name);
        let stat;
        try {
            stat = await this._fs.stat(file);
        }
        catch (error) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
        let reader = this._readers.get(name);
        if (!reader) {
            reader = { safeOffset: 0, size: 0 };
            this._readers.set(name, reader);
        }
        if (stat.size === reader.size) return;

        if (stat.size < reader.safeOffset) {
            this._dropShardIndex(name);
            reader.safeOffset = 0;
            reader.size = 0;
            this._warn('shard_truncated', 'journal 分片被外部截断，索引已重建', { shard: name });
        }
        let start = reader.safeOffset;
        if (start > 0) {
            const boundary = await this._readByteAt(file, start - 1);
            if (boundary !== 0x0a) {
                this._dropShardIndex(name);
                start = 0;
                reader.safeOffset = 0;
                this._warn('shard_resync', 'journal 分片在读取位置前不是行边界，已从头重读', { shard: name });
            }
        }
        if (stat.size <= start) {
            reader.size = stat.size;
            return;
        }
        const length = stat.size - start;
        const buffer = await this._readAt(file, start, length);
        if (buffer.length === 0) {
            reader.size = stat.size;
            return;
        }
        const text = buffer.toString('utf8');
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline === -1) {
            // 整段都是未写完的尾行：留给下一次（append 前会先修复坏尾）。
            reader.size = stat.size;
            return;
        }
        const complete = text.slice(0, lastNewline + 1);
        this._ingestLines(name, complete, start);
        reader.safeOffset = start + Buffer.byteLength(complete, 'utf8');
        reader.size = stat.size;
    }

    /** 解析一批完整行；坏行只告警，绝不补数字。 */
    _ingestLines(name, text, baseOffset) {
        let offset = baseOffset;
        for (const line of text.split('\n')) {
            if (line === '') {
                offset += 1;
                continue;
            }
            const bytes = Buffer.byteLength(line, 'utf8') + 1;
            let payload;
            let ok = true;
            try {
                payload = JSON.parse(line);
            }
            catch {
                ok = false;
            }
            if (ok) {
                ok = isPlainObject(payload)
                    && payload.v === JOURNAL_VERSION
                    && typeof payload.id === 'string'
                    && payload.id !== ''
                    && isNonNegativeInteger(payload.rev)
                    && isNonNegativeInteger(payload.startMs);
            }
            if (!ok) {
                this._warn('journal_line_invalid', 'journal 中有无法解析的行，已跳过（该行不做任何数字推断）', { shard: name, byteOffset: offset });
                offset += bytes;
                continue;
            }
            const existing = this._index.get(payload.id);
            if (!existing || existing.rev < payload.rev) {
                this._index.set(payload.id, { rev: payload.rev, record: payload, shard: name, byteOffset: offset });
            }
            offset += bytes;
        }
    }

    /** 丢弃某个 shard 的索引项（文件被截断/重写时用）。 */
    _dropShardIndex(name) {
        for (const [id, entry] of this._index) {
            if (entry.shard === name) this._index.delete(id);
        }
    }

    /** shard 文件名列表（升序）。 */
    async _shardNames() {
        let names;
        try {
            names = await this._fs.readdir(this.journalDir);
        }
        catch (error) {
            if (error?.code === 'ENOENT') return [];
            throw error;
        }
        return names.filter((name) => SHARD_PATTERN.test(name)).sort();
    }

    // ---------------------------------------------------------------------
    // journal：尾行完整性
    // ---------------------------------------------------------------------

    /** init 时检查所有 shard 的尾字节，坏尾隔离 + 截断。 */
    async _repairJournalTails() {
        const out = [];
        for (const name of await this._shardNames()) {
            const file = path.join(this.journalDir, name);
            const warning = await this._repairTail(file, name);
            if (warning) out.push(warning);
        }
        return out;
    }

    /** 追加前确保文件以 `\n` 结尾；不是则修复，绝不把新行粘在坏尾后面。 */
    async _ensureTrailingNewline(file) {
        let stat;
        try {
            stat = await this._fs.stat(file);
        }
        catch (error) {
            if (error?.code === 'ENOENT') return 0;
            throw error;
        }
        if (stat.size === 0) return 0;
        const last = await this._readByteAt(file, stat.size - 1);
        if (last === 0x0a) return stat.size;
        await this._repairTail(file, path.basename(file));
        const repaired = await this._fs.stat(file);
        return repaired.size;
    }

    /** 把 `[lastNewline+1, size)` 的残片移到 corrupt/ 并截断；返回告警或 null。 */
    async _repairTail(file, shardName) {
        let stat;
        try {
            stat = await this._fs.stat(file);
        }
        catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
        if (stat.size === 0) return null;
        const last = await this._readByteAt(file, stat.size - 1);
        if (last === 0x0a) return null;

        const handle = await this._fs.open(file, 'r');
        let cut;
        try {
            const lastNewline = await this._lastNewlineOffset(handle, stat.size);
            cut = lastNewline === -1 ? 0 : lastNewline + 1;
        }
        finally {
            await handle.close();
        }

        const fragmentLength = stat.size - cut;
        if (fragmentLength > 0) {
            const fragment = await this._readAt(file, cut, fragmentLength);
            // 残片恰好是**完整** JSON 行（只少了换行）：补换行即可，绝不丢这条记录。
            if (this._isValidJournalLine(fragment.toString('utf8'))) {
                const appender = await this._fs.open(file, 'a');
                try {
                    await appender.write('\n');
                    await appender.sync();
                }
                finally {
                    await appender.close();
                }
                this._readers.delete(shardName);
                this._indexReady = false;
                return this._warn('journal_tail_newline_added', 'journal 尾部是一条完整行但缺换行，已补换行（记录保留）', {
                    shard: shardName,
                    bytes: fragmentLength,
                });
            }
            try {
                const stamp = isoOf(this._now()).replace(/[:.]/g, '-');
                const isolate = path.join(this.corruptDir, `${shardName}.${cut}-${stat.size}.${stamp}.tail`);
                await this._mkdir(this.corruptDir);
                await this._fs.writeFile(isolate, fragment, { mode: 0o600 });
            }
            catch {
                // 取证副本失败不影响修复：先保证"新行不粘坏尾"。
            }
        }
        const truncateHandle = await this._fs.open(file, 'r+');
        try {
            await truncateHandle.truncate(cut);
            await truncateHandle.sync();
        }
        finally {
            await truncateHandle.close();
        }
        this._readers.delete(shardName);
        this._indexReady = false;
        return this._warn('journal_tail_truncated', 'journal 尾部残行已隔离并截断（保留前面有效记录）', {
            shard: shardName,
            bytes: fragmentLength,
            cutAt: cut,
        });
    }

    /** 一行文本是否是可接受的 journal 记录（用于"补换行"判定）。 */
    _isValidJournalLine(text) {
        const trimmed = text.trim();
        if (trimmed === '' || !trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
        let payload;
        try {
            payload = JSON.parse(trimmed);
        }
        catch {
            return false;
        }
        return isPlainObject(payload)
            && payload.v === JOURNAL_VERSION
            && typeof payload.id === 'string'
            && payload.id !== ''
            && isNonNegativeInteger(payload.rev)
            && isNonNegativeInteger(payload.startMs);
    }

    /** 定长读取（循环补齐短读）；读到 EOF 时返回已读部分。 */
    async _readAt(file, start, length) {
        const buffer = Buffer.allocUnsafe(length);
        const handle = await this._fs.open(file, 'r');
        try {
            let filled = 0;
            while (filled < length) {
                const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
                if (bytesRead === 0) break;
                filled += bytesRead;
            }
            return filled === length ? buffer : buffer.subarray(0, filled);
        }
        finally {
            await handle.close();
        }
    }

    /** 从文件尾向前找最后一个 `\n` 的绝对偏移；找不到返回 -1。 */
    async _lastNewlineOffset(handle, size, chunkSize = 64 * 1024) {
        let position = size;
        while (position > 0) {
            const length = Math.min(chunkSize, position);
            position -= length;
            const buffer = Buffer.allocUnsafe(length);
            await handle.read(buffer, 0, length, position);
            const index = buffer.lastIndexOf(0x0a);
            if (index !== -1) return position + index;
        }
        return -1;
    }

    /** 读单字节；文件不存在返回 -1。 */
    async _readByteAt(file, position) {
        const handle = await this._fs.open(file, 'r');
        try {
            const buffer = Buffer.allocUnsafe(1);
            const { bytesRead } = await handle.read(buffer, 0, 1, position);
            return bytesRead === 1 ? buffer[0] : -1;
        }
        finally {
            await handle.close();
        }
    }

    // ---------------------------------------------------------------------
    // 内部工具
    // ---------------------------------------------------------------------

    /** 状态快照的深拷贝白名单化（丢弃正文/凭据键，拒绝函数与循环引用）。 */
    _sanitizeState(value) {
        const seen = new Set();
        const dropped = new Set();
        const walk = (input, keyPath, depth) => {
            if (depth > STORE_LIMITS.maxStateDepth) {
                throw new StoreError(`state 嵌套过深（>${STORE_LIMITS.maxStateDepth}）：${keyPath}`, { code: 'E_STATE_INVALID', path: keyPath });
            }
            if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
            if (typeof input === 'number') {
                if (!Number.isFinite(input)) throw new StoreError(`state 中有非有限数字：${keyPath}`, { code: 'E_STATE_INVALID', path: keyPath });
                return input;
            }
            if (input instanceof Date) {
                if (!Number.isFinite(input.getTime())) throw new StoreError(`state 中有非法 Date：${keyPath}`, { code: 'E_STATE_INVALID', path: keyPath });
                return input.toISOString();
            }
            if (Array.isArray(input)) {
                return input.map((item, index) => walk(item, `${keyPath}[${index}]`, depth + 1));
            }
            if (!isPlainObject(input)) {
                throw new StoreError(`state 含有不可序列化的值（${typeName(input)}）：${keyPath}`, { code: 'E_STATE_INVALID', path: keyPath });
            }
            if (seen.has(input)) {
                throw new StoreError(`state 不能有循环引用：${keyPath}`, { code: 'E_STATE_INVALID', path: keyPath });
            }
            seen.add(input);
            /** @type {Record<string, any>} */
            const out = {};
            for (const [key, item] of Object.entries(input)) {
                if (FORBIDDEN_KEY.test(key)) {
                    dropped.add(`${keyPath}.${key}`);
                    continue;
                }
                if (item === undefined) continue;
                out[key] = walk(item, `${keyPath}.${key}`, depth + 1);
            }
            seen.delete(input);
            return out;
        };
        const sanitized = walk(value, 'state', 0);
        for (const keyPath of dropped) {
            this._warn('state_field_forbidden_dropped', `项目快照丢弃疑似正文/凭据字段 ${keyPath}`, { path: keyPath });
        }
        return sanitized;
    }

    /** 读已有 envelope（宽容：坏文件返回 null，并告警）。 */
    async _readEnvelope(file) {
        let text;
        try {
            text = await this._fs.readFile(file, 'utf8');
        }
        catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
        try {
            const parsed = JSON.parse(text);
            if (!isPlainObject(parsed) || !isNonNegativeInteger(parsed.revision)) return null;
            return parsed;
        }
        catch {
            this._warn('state_corrupt', '项目快照不是合法 JSON，将用新快照覆盖（旧文件内容已被丢弃）', { file });
            return null;
        }
    }

    _status(repaired = []) {
        return {
            directory: this.root,
            profile: this.profile,
            version: STORE_VERSION,
            warnings: this.warnings,
            repaired,
        };
    }

    _startTimer() {
        if (this._timer) return;
        this._timer = setInterval(() => {
            this.flush().catch((error) => {
                this._warn('flush_failed', `定时 flush 失败：${error?.message ?? error}`);
            });
        }, this.flushIntervalSeconds * 1000);
        if (typeof this._timer.unref === 'function') this._timer.unref();
    }

    _assertReady(method) {
        if (this._closed) {
            throw new StoreError(`store 已关闭，不能 ${method}`, { code: 'E_CLOSED', path: method });
        }
        if (!this._initialized) {
            throw new StoreError(`store 尚未 init()，不能 ${method}`, { code: 'E_NOT_INITIALIZED', path: method });
        }
    }

    _warn(code, message, detail = {}) {
        const warning = { code, message, detail, at: isoOf(this._now()) };
        this._warnings.push(warning);
        if (this._warnings.length > STORE_LIMITS.maxWarnings) this._warnings.shift();
        return warning;
    }

    async _mkdir(dir) {
        try {
            await this._fs.mkdir(dir, { recursive: true, mode: 0o700 });
        }
        catch (error) {
            if (error?.code === 'EEXIST') return;
            throw new StoreError(`创建目录失败：${dir}（${error?.message ?? error}）`, { code: 'E_WRITE_FAILED', path: dir, cause: error });
        }
    }

    /** 目录 0700 / 文件 0600：Windows 上 chmod 基本无效，失败一律吞掉。 */
    async _tightenModes() {
        for (const dir of [this.root, this.projectsDir, this.journalDir, this.corruptDir, this.locksDir]) {
            await this._chmod(dir, 0o700);
        }
        for (const dir of [this.projectsDir, this.journalDir, this.locksDir]) {
            let names = [];
            try {
                names = await this._fs.readdir(dir);
            }
            catch {
                continue;
            }
            for (const name of names) {
                if (!name.endsWith('.json') && !name.endsWith('.jsonl') && !name.endsWith('.lock')) continue;
                await this._chmod(path.join(dir, name), 0o600);
            }
        }
    }

    async _chmod(target, mode) {
        try {
            await this._fs.chmod(target, mode);
        }
        catch {
            // Windows / 不支持权限位的文件系统：忽略，不让权限收紧挡住主流程。
        }
    }

    async _unlink(target) {
        try {
            await this._fs.unlink(target);
        }
        catch (error) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
    }

    /** 目录 fsync：rename / unlink 的持久化保证，Windows 上会失败，忽略。 */
    async _syncDir(dir) {
        let handle;
        try {
            handle = await this._fs.open(dir, 'r');
            await handle.sync();
        }
        catch {
            // Windows 不允许对目录 fsync；这是已知能力边界，不是错误。
        }
        finally {
            await handle?.close().catch(() => {});
        }
    }
}

export default JsonlStore;
