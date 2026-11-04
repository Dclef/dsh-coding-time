/**
 * dsh-coding-time · 纯计时核心。
 *
 * 不碰文件系统、不碰宿主：只接收已发生的活动观测，输出可持久化、可导出的版本化记录。
 * 宿主按项目持锁重放：
 *
 * ```
 * snap = await store.readProjectState(projectKey)
 * tracker = new ActivityTracker(config, { state: snap?.state ?? null })
 * tracker.observe(...)
 * await store.writeProjectState(projectKey, tracker.exportState())
 * await store.append(tracker.snapshot().records)   // 同 id upsert，重复 append 不双计
 * ```
 *
 * 记账规则（诚实优先，宁可少算）：
 *
 * 1. `id` 去重；去重窗口有限，淘汰数记 `seenEvicted`，到窗口上限也不拒绝新活动。
 * 2. **项目级 gate**：同一项目（规范化 cwd）任意 `heartbeatIntervalSeconds` 内只允许开
 *    一条新记录，跨 source / session / run 共享，不是每个 source 各一分钟。
 * 3. **证据不丢**：被 gate 压下的观测立刻进 `snapshot()`（`pending: true`、`heartbeats: 0`、
 *    零时长），带行数与文件证据；放行时迁移为**同 id** 的 interval（revision 递增），
 *    宿主按 id upsert 即替换，不会出现两条账。
 * 4. **连通性**：仅同 segment（source|sessionId|runId）且 gap <= idle 时续段；
 *    跨 run / 会话 / 崩溃不连接。
 * 5. **孤立点 = 0**；**无尾部赠送**（endMs 只到最后真实观测）。
 * 6. **行数带时间戳**：每条 diff 证据带发生时刻，只归真实发生日；跨午夜不复制、
 *    不按比例拆分。未知是 `null`，明确的 0 才是 `0`。
 * 7. **总墙钟只有一个**：`wallUnionMs`（全局并集）。`totalMs` 是各项目 union 之和，
 *    并行项目会重复，不能当总墙钟显示。
 *
 * @module dsh-coding-time/activity
 */
import path from 'node:path';
import { detectTimezone, normalizeConfig } from './config.js';

/** 记录结构版本。 */
export const RECORD_VERSION = 1;

/** 内存状态版本（`exportState()` 用）。 */
export const STATE_VERSION = 1;

/** 活动分类。 */
export const SOURCES = Object.freeze(['ai', 'human', 'unknown']);

/** 观测种类：泛活动 vs 文件/行数证据。 */
export const KINDS = Object.freeze(['agent', 'file']);

/** 内存上限：到限不拒绝新活动，只做可计数淘汰。 */
export const ACTIVITY_LIMITS = Object.freeze({
    maxProjects: 2048,
    maxOpenSegments: 64,
    maxPendingSegments: 256,
    maxLineEntriesPerRecord: 4096,
    maxFilesPerRecord: 4096,
    maxDedupeIds: 8192,
    maxClosedRecords: 20000,
});

/** 观测/状态错误。 */
export class ActivityError extends Error {
    constructor(message, { code = 'invalid', path: fieldPath = '' } = {}) {
        super(fieldPath ? `${fieldPath}: ${message}` : message);
        this.name = 'ActivityError';
        this.code = code;
        this.path = fieldPath;
    }
}

const isoOf = (ms) => {
    // 非有限时间（旧状态/损坏数据）绝不抛：返回空串，让记录仍然可导出
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    return new Date(ms).toISOString();
};

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function finiteNumber(value, fieldPath) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ActivityError(`必须是有限数字（收到 ${typeof value}）`, { code: 'invalid_number', path: fieldPath });
    }
    return value;
}

function readAt(value, fieldPath) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
    if (value instanceof Date && Number.isFinite(value.getTime())) return Math.floor(value.getTime());
    throw new ActivityError('必须是毫秒时间戳或 Date', { code: 'invalid_at', path: fieldPath });
}

/** 行数：缺省/`null` → `null`（未知）；0 是明确为零。 */
function readLines(value, fieldPath) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new ActivityError(`必须是非负整数或 null（收到 ${value}）`, { code: 'invalid_number', path: fieldPath });
    }
    if (value > 1_000_000_000) throw new ActivityError(`数值过大（收到 ${value}）`, { code: 'out_of_range', path: fieldPath });
    return value;
}

function optionalString(value, fieldPath, maxLength = 512) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new ActivityError(`必须是字符串（收到 ${typeof value}）`, { code: 'invalid_type', path: fieldPath });
    const trimmed = value.trim();
    if (trimmed.length > maxLength) throw new ActivityError(`长度上限 ${maxLength}（收到 ${trimmed.length}）`, { code: 'out_of_range', path: fieldPath });
    return trimmed;
}

/** 规范化项目键（纯字符串处理，Windows 小写；符号链接不合并）。 */
export function projectKeyOf(cwd) {
    if (typeof cwd !== 'string' || cwd.trim() === '') throw new ActivityError('cwd 必须是非空字符串', { code: 'invalid_cwd', path: 'cwd' });
    const raw = cwd.trim();
    if (raw.includes('\0')) throw new ActivityError('cwd 不能包含 NUL', { code: 'invalid_cwd', path: 'cwd' });
    if (!(path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw))) {
        throw new ActivityError(`cwd 必须是绝对路径（收到 ${JSON.stringify(raw)}）`, { code: 'invalid_cwd', path: 'cwd' });
    }
    let unified = raw.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
    if (/^[A-Za-z]:$/.test(unified)) unified += '/';
    return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

function projectNameOf(cwd) {
    const unified = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    return unified.slice(unified.lastIndexOf('/') + 1) || unified;
}

/** file → 相对 cwd 路径；cwd 之外不记录路径文本。 */
function fileEvidenceOf(cwd, file) {
    if (!file) return null;
    const windows = process.platform === 'win32';
    const raw = file.replace(/\\/g, '/').trim();
    if (raw === '') return null;
    const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    const fold = (value) => (windows ? value.toLowerCase() : value);
    const absolute = raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.startsWith('//');
    if (absolute) {
        const rawKey = fold(raw);
        const baseKey = fold(base);
        if (!(rawKey === baseKey || rawKey.startsWith(`${baseKey}/`))) return { path: null, excluded: true, outside: true };
        const relative = raw.slice(base.length).replace(/^\/+/, '');
        return { path: relative || null, excluded: !relative, outside: false };
    }
    const rel = raw.replace(/^\.\//, '').replace(/^\/+/, '');
    if (rel === '' || rel === '.' || rel.startsWith('..')) return { path: null, excluded: true, outside: true };
    return { path: rel, excluded: false, outside: false };
}

function globToRegExp(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`);
}

/** 路径是否被排除（整段相等、文件名 glob、或 `dir/` 前缀）。 */
export function isExcludedPath(filePath, patterns) {
    if (!filePath) return false;
    const windows = process.platform === 'win32';
    const target = windows ? filePath.toLowerCase() : filePath;
    const segments = target.split('/');
    const base = segments[segments.length - 1];
    for (const pattern of patterns ?? []) {
        const rule = windows ? pattern.toLowerCase() : pattern;
        if (rule.includes('*')) {
            const re = globToRegExp(rule);
            if (re.test(base) || re.test(target)) return true;
            for (const segment of segments) if (re.test(segment)) return true;
            continue;
        }
        if (segments.includes(rule) || base === rule) return true;
        if (target === rule || target.startsWith(`${rule}/`)) return true;
    }
    return false;
}

/** 区间并集；零长度与逆序区间都不产生时长（宁可少算，不把回拨算成时间）。 */
export function intervalUnion(intervals) {
    const list = [];
    for (const item of intervals ?? []) {
        const startMs = Number(item?.startMs);
        const endMs = Number(item?.endMs);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
        if (endMs <= startMs) continue;
        list.push([startMs, endMs]);
    }
    if (list.length === 0) return [];
    list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [list[0]];
    for (let index = 1; index < list.length; index += 1) {
        const current = list[index];
        const last = merged[merged.length - 1];
        if (current[0] <= last[1]) {
            if (current[1] > last[1]) last[1] = current[1];
        }
        else merged.push(current);
    }
    return merged.map(([startMs, endMs]) => ({ startMs, endMs }));
}

/** 并集总时长。 */
export function totalDurationMs(intervals) {
    let total = 0;
    for (const span of intervalUnion(intervals)) total += span.endMs - span.startMs;
    return total;
}

function clipSpan(startMs, endMs, from, to) {
    let lo = startMs;
    let hi = endMs;
    if (from !== null && lo < from) lo = from;
    if (to !== null && hi > to) hi = to;
    return hi <= lo ? null : { startMs: lo, endMs: hi };
}

const formatterCache = new Map();

function formatterFor(timezone) {
    let formatter = formatterCache.get(timezone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        });
        formatterCache.set(timezone, formatter);
    }
    return formatter;
}

/** 某毫秒在该时区的墙上时间分量。 */
export function localPartsOf(ms, timezone = detectTimezone()) {
    const parts = formatterFor(timezone).formatToParts(new Date(ms));
    const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
    for (const part of parts) {
        if (part.type === 'literal' || !(part.type in out)) continue;
        out[part.type] = Number(part.value === '24' ? '0' : part.value);
    }
    return out;
}

function offsetMsAt(ms, timezone) {
    const parts = localPartsOf(ms, timezone);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(ms / 1000) * 1000;
}

function wallToUtcMs(timezone, year, month, day, hour = 0, minute = 0, second = 0) {
    const target = Date.UTC(year, month - 1, day, hour, minute, second);
    let candidate = target - offsetMsAt(target, timezone);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const next = target - offsetMsAt(candidate, timezone);
        if (next === candidate) break;
        candidate = next;
    }
    return candidate;
}

/** 本地日期键 `YYYY-MM-DD`。 */
export function dayKeyOf(ms, timezone = detectTimezone()) {
    const parts = localPartsOf(ms, timezone);
    return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** 某本地日的 [起, 止)；DST 日可能 23h/25h。 */
export function dayBoundsOf(dayKey, timezone = detectTimezone()) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey));
    if (!match) throw new ActivityError(`非法日期键 ${JSON.stringify(dayKey)}`, { code: 'invalid_day', path: 'dayKey' });
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const startMs = wallToUtcMs(timezone, year, month, day);
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    const endMs = wallToUtcMs(timezone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
    return { day: String(dayKey), startMs, endMs };
}

/** 所属周起始日键（避免 ISO 周号跨年争议）。 */
export function weekKeyOf(ms, { timezone = detectTimezone(), weekStartsOn = 1 } = {}) {
    const parts = localPartsOf(ms, timezone);
    const utcDay = Date.UTC(parts.year, parts.month - 1, parts.day);
    const weekday = new Date(utcDay).getUTCDay();
    const shift = ((weekday - weekStartsOn) % 7 + 7) % 7;
    const shifted = new Date(utcDay - shift * 86_400_000);
    return `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

/** 区间按本地日切分（零区间返回空）。 */
export function splitByLocalDay(startMs, endMs, timezone = detectTimezone()) {
    const out = [];
    if (!(endMs > startMs)) return out;
    let cursor = startMs;
    let guard = 0;
    while (cursor < endMs && guard < 4096) {
        guard += 1;
        const day = dayKeyOf(cursor, timezone);
        const bounds = dayBoundsOf(day, timezone);
        let next = Math.min(bounds.endMs, endMs);
        if (next <= cursor) next = cursor + 1;
        out.push({ day, startMs: cursor, endMs: next });
        cursor = next;
    }
    return out;
}

function verdict(accepted, reason, extra = {}) {
    return { accepted, reason, suppressed: false, projectKey: '', source: '', kind: '', segmentKey: '', ...extra };
}

/** 行数累加：`null` 参与即 partial。 */
function addLineValue(current, value, state) {
    if (value === null || value === undefined) {
        state.partial = true;
        return current;
    }
    return current === null ? value : current + value;
}

function evidenceSkeleton() {
    return {
        lineEntries: [],
        files: new Map(),
        linesAdded: null,
        linesDeleted: null,
        linesPartial: false,
        linesDropped: 0,
        linesUndated: { added: 0, deleted: 0 },
        filesDropped: 0,
    };
}

/** 记录 → 可序列化视图（Map → 数组，补 durationMs/pending）。 */
function recordView(record) {
    const files = [...record.files.values()]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => ({ ...file, linesAdded: file.linesAdded ?? null, linesDeleted: file.linesDeleted ?? null }));
    return {
        v: RECORD_VERSION,
        kind: record.kind,
        id: record.id,
        revision: record.revision,
        updateAt: isoOf(record.updateMs),
        project: record.project,
        projectKey: record.projectKey,
        cwd: record.cwd,
        source: record.source,
        sessionId: record.sessionId,
        runId: record.runId,
        startMs: record.startMs,
        endMs: record.endMs,
        startAt: isoOf(record.startMs),
        endAt: isoOf(record.endMs),
        durationMs: record.kind === 'interval' ? Math.max(0, record.endMs - record.startMs) : 0,
        heartbeats: record.heartbeats,
        observations: record.observations,
        linesAdded: record.linesAdded,
        linesDeleted: record.linesDeleted,
        linesPartial: record.linesPartial,
        linesDropped: record.linesDropped,
        linesUndated: { ...record.linesUndated },
        filesDropped: record.filesDropped,
        fileCount: files.length,
        files,
        lineEntries: record.lineEntries.map((entry) => ({ ...entry })),
        open: record.open,
        pending: record.pending === true,
        closeReason: record.closeReason,
    };
}

function emptyRecord({ id, kind, project, projectKey, cwd, source, sessionId, runId, at, heartbeats, open, pending }) {
    return {
        ...evidenceSkeleton(),
        id,
        kind,
        project,
        projectKey,
        cwd,
        source,
        sessionId,
        runId,
        startMs: at,
        endMs: at,
        updateMs: at,
        revision: 0,
        heartbeats,
        observations: 0,
        open,
        pending: pending === true,
        closeReason: '',
    };
}

/** 活动跟踪器。 */
export class ActivityTracker {
    /**
     * @param config - 见 `normalizeConfig`。
     * @param options - { now, state }：`state` 是 `exportState()` 的产物。
     */
    constructor(config = {}, options = {}) {
        if (!isPlainObject(options)) throw new ActivityError('options 必须是对象', { code: 'invalid_options', path: 'options' });
        const clock = options.now;
        if (clock !== undefined && typeof clock !== 'function') throw new ActivityError('now 必须是函数', { code: 'invalid_clock', path: 'now' });
        this.config = normalizeConfig(config);
        this._clock = clock ?? (() => Date.now());
        this._projects = new Map();
        this._seen = new Set();
        this._seenEvicted = 0;
        this._sequence = 0;
        this._disposed = false;
        this._restored = false;
        if (options.state !== undefined && options.state !== null) {
            this._restoreState(options.state);
            this._restored = true;
        }
        this.startedAt = Math.floor(this._clock());
    }

    get configView() {
        return this.config;
    }

    get restored() {
        return this._restored;
    }

    /**
     * 记录一次观测。
     *
     * @param event - `id`/`cwd` 必需；`source` 缺省 `unknown`；`kind` 缺省按有无 `file` 推断。
     */
    observe(event) {
        if (this._disposed) return verdict(false, 'disposed');
        const config = this.config;
        if (!config.enabled) return verdict(false, 'disabled');

        let observation;
        try {
            observation = this._readEvent(event);
        }
        catch (error) {
            if (error instanceof ActivityError) return verdict(false, error.code, { detail: error.message });
            return verdict(false, 'invalid_event', { detail: String(error?.message ?? error) });
        }

        const projectKey = projectKeyOf(observation.cwd);
        const segmentKey = `${observation.source}|${observation.sessionId}|${observation.runId}`;
        const base = { projectKey, source: observation.source, kind: observation.kind, segmentKey };

        // 泛 Agent 活动可关；AI 文件/行数证据不受牵连
        if (observation.source === 'ai' && observation.kind === 'agent' && !config.trackAgentActivity) {
            return { ...base, accepted: false, reason: 'agent_tracking_disabled', suppressed: false };
        }
        if (observation.source === 'human' && !config.humanTracking.enabled) {
            return { ...base, accepted: false, reason: 'human_tracking_disabled', suppressed: false };
        }
        if (this._seen.has(observation.id)) return { ...base, accepted: false, reason: 'duplicate', suppressed: false };
        this._rememberSeen(observation.id);

        let project;
        try {
            project = this._projectOf(projectKey, observation.cwd, observation.projectName);
        }
        catch (error) {
            return { ...base, accepted: false, reason: error?.code ?? 'project_limit', suppressed: false, detail: error?.message };
        }

        project.observations += 1;
        project.lastActivityMs = Math.max(project.lastActivityMs ?? 0, observation.at);

        const idleMs = config.idleThresholdSeconds * 1000;
        const heartbeatMs = config.heartbeatIntervalSeconds * 1000;

        const open = project.open.get(segmentKey);
        let record = null;
        if (open) {
            if (observation.at >= open.endMs && observation.at - open.endMs <= idleMs) record = open;
            else if (observation.at < open.endMs) record = open; // 时钟回拨：只作证据
            else this._close(project, segmentKey, 'gap');
        }

        let heartbeat = false;
        let suppressed = false;
        let recordId = null;

        if (!record) {
            const allowed = project.lastHeartbeatMs === null || observation.at - project.lastHeartbeatMs >= heartbeatMs;
            if (allowed) {
                record = this._openRecord(project, segmentKey, observation);
                project.lastHeartbeatMs = observation.at;
                project.heartbeats += 1;
                heartbeat = true;
                recordId = record.id;
            }
            else {
                suppressed = true;
                recordId = this._pend(project, segmentKey, observation).id;
                project.suppressed += 1;
            }
        }

        if (record) {
            this._absorb(record, observation);
            recordId = record.id;
        }

        return {
            ...base,
            accepted: !suppressed,
            reason: suppressed ? 'rate_limited' : 'ok',
            suppressed,
            heartbeat,
            recordId,
            pending: suppressed,
        };
    }

    /**
     * 当前快照（默认不改状态）：closed + open + pending 证据三种投影。
     *
     * @param options - { finalize }：true 时把 open 与 pending 全部落成关闭记录。
     */
    snapshot(options = {}) {
        if (options?.finalize) {
            for (const project of this._projects.values()) this._finalizeProject(project, 'snapshot');
        }
        const records = [];
        const projects = [];
        for (const project of this._projects.values()) {
            for (const record of project.closed) records.push(recordView(record));
            for (const record of project.open.values()) records.push(recordView({ ...record, pending: false }));
            for (const pending of project.pending.values()) records.push(recordView(pending));
            const spans = [
                ...project.closed.filter((record) => record.kind === 'interval').map(({ startMs, endMs }) => ({ startMs, endMs })),
                ...[...project.open.values()].map(({ startMs, endMs }) => ({ startMs, endMs })),
            ];
            projects.push({
                project: project.name,
                projectKey: project.key,
                cwd: project.cwd,
                records: project.closed.length + project.open.size,
                pendingSegments: project.pending.size,
                heartbeats: project.heartbeats,
                observations: project.observations,
                suppressed: project.suppressed,
                recordsEvicted: project.recordsEvicted,
                lastHeartbeatAt: project.lastHeartbeatMs === null ? '' : isoOf(project.lastHeartbeatMs),
                lastActivityAt: project.lastActivityMs === null ? '' : isoOf(project.lastActivityMs),
                durationMs: totalDurationMs(spans),
            });
        }
        records.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
        projects.sort((a, b) => b.durationMs - a.durationMs || a.projectKey.localeCompare(b.projectKey));
        return { v: RECORD_VERSION, generatedAt: isoOf(Math.floor(this._clock())), records, projects };
    }

    /** 完整计时状态（纯 JSON）：gate、去重窗口、open/closed/pending、计数器。 */
    exportState() {
        const projects = [];
        for (const project of this._projects.values()) {
            projects.push({
                key: project.key,
                cwd: project.cwd,
                name: project.name,
                lastHeartbeatMs: project.lastHeartbeatMs,
                lastActivityMs: project.lastActivityMs,
                heartbeats: project.heartbeats,
                observations: project.observations,
                suppressed: project.suppressed,
                recordsEvicted: project.recordsEvicted,
                closed: project.closed.map((record) => recordView(record)),
                open: [...project.open.values()].map((record) => recordView({ ...record, pending: false })),
                pending: [...project.pending.values()].map((record) => recordView(record)),
            });
        }
        return {
            v: STATE_VERSION,
            savedAt: isoOf(Math.floor(this._clock())),
            startedAt: this.startedAt,
            sequence: this._sequence,
            seen: [...this._seen],
            seenEvicted: this._seenEvicted,
            projects,
        };
    }

    /** 封口全部 open/pending，返回记录集并清空台账。 */
    drain() {
        for (const project of this._projects.values()) this._finalizeProject(project, 'drain');
        const result = this.snapshot();
        this._projects.clear();
        this._seen.clear();
        this._sequence = 0;
        return result;
    }

    dispose() {
        const result = this.drain();
        this._disposed = true;
        return { v: RECORD_VERSION, disposed: true, records: result.records.length };
    }

    _readEvent(event) {
        if (!isPlainObject(event)) throw new ActivityError('观测必须是对象', { code: 'invalid_event', path: 'event' });
        const rawId = event.id;
        if (typeof rawId !== 'string' || rawId.trim() === '') throw new ActivityError('id 必须是非空字符串', { code: 'invalid_id', path: 'id' });
        projectKeyOf(event.cwd);
        const source = event.source === undefined || event.source === null || event.source === '' ? 'unknown' : event.source;
        if (!SOURCES.includes(source)) throw new ActivityError(`source 必须是 ${SOURCES.join(' / ')}（收到 ${JSON.stringify(event.source)}）`, { code: 'invalid_source', path: 'source' });
        const kind = event.kind === undefined || event.kind === null || event.kind === '' ? (event.file ? 'file' : 'agent') : event.kind;
        if (!KINDS.includes(kind)) throw new ActivityError(`kind 必须是 ${KINDS.join(' / ')}（收到 ${JSON.stringify(event.kind)}）`, { code: 'invalid_kind', path: 'kind' });
        const at = event.at === undefined || event.at === null ? Math.floor(this._clock()) : readAt(event.at, 'at');
        if (at < 0) throw new ActivityError('at 不能为负', { code: 'invalid_at', path: 'at' });
        return {
            id: rawId.trim(),
            cwd: event.cwd.trim(),
            at,
            source,
            kind,
            sessionId: optionalString(event.sessionId, 'sessionId'),
            runId: optionalString(event.runId, 'runId'),
            file: optionalString(event.file, 'file', 1024),
            linesAdded: readLines(event.linesAdded, 'linesAdded'),
            linesDeleted: readLines(event.linesDeleted, 'linesDeleted'),
            projectName: optionalString(event.project, 'project', 256),
        };
    }

    /** 去重窗口：到上限淘汰最旧并记数，不拒绝新活动。 */
    _rememberSeen(id) {
        if (this._seen.has(id)) return;
        while (this._seen.size >= ACTIVITY_LIMITS.maxDedupeIds) {
            this._seen.delete(this._seen.values().next().value);
            this._seenEvicted += 1;
        }
        this._seen.add(id);
    }

    _projectOf(key, cwd, projectName) {
        const existing = this._projects.get(key);
        if (existing) {
            if (!existing.cwd && cwd) existing.cwd = cwd.trim();
            if (!existing.name && projectName) existing.name = projectName;
            return existing;
        }
        if (this._projects.size >= ACTIVITY_LIMITS.maxProjects) {
            throw new ActivityError('项目数已达上限，拒绝新项目以免丢账', { code: 'project_limit', path: 'cwd' });
        }
        const project = {
            key,
            cwd: cwd.trim(),
            name: projectName || projectNameOf(cwd),
            closed: [],
            open: new Map(),
            pending: new Map(),
            lastHeartbeatMs: null,
            lastActivityMs: null,
            heartbeats: 0,
            observations: 0,
            suppressed: 0,
            recordsEvicted: 0,
        };
        this._projects.set(key, project);
        return project;
    }

    /**
     * 开新记录：同 segment 的 pending 在 gap <= idle 时沿用其 id 并吸收（upsert 替换，不新开账）；
     * gap > idle 时**不得跨 gap 连接**：旧 pending 按自己的真实时长封口，新记录从当前点起算。
     */
    _openRecord(project, segmentKey, observation) {
        if (project.open.size >= ACTIVITY_LIMITS.maxOpenSegments) {
            const oldest = [...project.open.entries()].sort((a, b) => a[1].endMs - b[1].endMs)[0];
            if (oldest) this._close(project, oldest[0], 'limit');
        }
        const idleMs = this.config.idleThresholdSeconds * 1000;
        let pending = project.pending.get(segmentKey);
        if (pending && observation.at >= pending.lastMs && observation.at - pending.lastMs > idleMs) {
            // 断段：旧 pending 独立封口（保留它自己的真实时长），新段另起一笔
            project.pending.delete(segmentKey);
            const closedPending = this._pendingToRecord(project, pending, 'pending:gap');
            this._closeRecord(project, closedPending, 'pending:gap');
            pending = null;
        }
        if (pending) project.pending.delete(segmentKey);
        const record = emptyRecord({
            id: pending ? pending.id : `${project.key}#${observation.at}#${++this._sequence}`,
            kind: 'interval',
            project: observation.projectName || project.name,
            projectKey: project.key,
            cwd: project.cwd,
            source: observation.source,
            sessionId: observation.sessionId,
            runId: observation.runId,
            at: observation.at,
            heartbeats: 1,
            open: true,
        });
        if (pending) {
            // 投影已归档的 revision 必须被超越，否则 upsert 会留着旧 pending
            record.revision = pending.revision;
            this._mergeEvidence(record, pending);
            // 升级不得抹掉 pending 期间已经真实发生的起点：startMs 取两者最早
            if (pending.firstMs < record.startMs) {
                record.startMs = pending.firstMs;
                record.endMs = Math.max(record.endMs, observation.at);
            }
        }
        project.open.set(segmentKey, record);
        return record;
    }

    _absorb(record, observation) {
        record.observations += 1;
        if (observation.at > record.endMs) record.endMs = observation.at;
        record.updateMs = Math.max(record.updateMs, observation.at);
        record.revision += 1;
        this._absorbEvidence(record, observation);
    }

    /** 观测 → 证据（记录与 pending 共用一套规则；行数带发生时刻）。 */
    _absorbEvidence(target, observation) {
        const config = this.config;
        const info = fileEvidenceOf(target.cwd || observation.cwd, observation.file);
        const tracksLines = observation.kind === 'file'
            && ((observation.source === 'ai' && config.trackAiLines) || (observation.source === 'human' && config.humanTracking.enabled));
        const excluded = info?.excluded === true || isExcludedPath(info?.path, config.exclude);
        const counts = tracksLines && !excluded;
        const hasLines = observation.linesAdded !== null || observation.linesDeleted !== null;
        const linesState = { partial: target.linesPartial };

        if (counts) {
            target.linesAdded = addLineValue(target.linesAdded, observation.linesAdded, linesState);
            target.linesDeleted = addLineValue(target.linesDeleted, observation.linesDeleted, linesState);
            target.linesPartial = linesState.partial;
            if (target.lineEntries.length < ACTIVITY_LIMITS.maxLineEntriesPerRecord) {
                target.lineEntries.push({ at: observation.at, file: info?.path ?? '', added: observation.linesAdded, deleted: observation.linesDeleted });
            }
            else {
                // 总量保住，日期归属显式记为 undated（不伪造日期）
                target.linesUndated.added += observation.linesAdded ?? 0;
                target.linesUndated.deleted += observation.linesDeleted ?? 0;
            }
            if (info?.path) this._touchFile(target, info.path, false, observation);
            return;
        }

        if (hasLines) target.linesDropped += (observation.linesAdded ?? 0) + (observation.linesDeleted ?? 0);
        if (info?.path && observation.kind === 'file') this._touchFile(target, info.path, true, observation);
    }

    _touchFile(target, filePath, excluded, observation) {
        const existing = target.files.get(filePath);
        if (!existing && target.files.size >= ACTIVITY_LIMITS.maxFilesPerRecord) {
            target.filesDropped += 1;
            return;
        }
        const entry = existing ?? { path: filePath, touches: 0, linesAdded: null, linesDeleted: null, excluded };
        entry.touches += 1;
        entry.excluded = entry.excluded || excluded;
        if (!excluded) {
            entry.linesAdded = addLineValue(entry.linesAdded, observation.linesAdded, { partial: false });
            entry.linesDeleted = addLineValue(entry.linesDeleted, observation.linesDeleted, { partial: false });
        }
        target.files.set(filePath, entry);
    }

    /** pending 证据并入记录（同 id 迁移）。 */
    _mergeEvidence(record, pending) {
        record.observations += pending.observations;
        record.revision += 1;
        if (pending.lastMs > record.endMs) record.endMs = pending.lastMs;
        record.updateMs = Math.max(record.updateMs, pending.lastMs);
        const linesState = { partial: record.linesPartial || pending.linesPartial };
        record.linesAdded = addLineValue(record.linesAdded, pending.linesAdded, linesState);
        record.linesDeleted = addLineValue(record.linesDeleted, pending.linesDeleted, linesState);
        record.linesPartial = linesState.partial;
        record.linesDropped += pending.linesDropped;
        record.linesUndated.added += pending.linesUndated.added;
        record.linesUndated.deleted += pending.linesUndated.deleted;
        record.filesDropped += pending.filesDropped;
        record.lineEntries.push(...pending.lineEntries);
        for (const [filePath, pendingFile] of pending.files) {
            const current = record.files.get(filePath);
            if (!current) {
                record.files.set(filePath, { ...pendingFile });
                continue;
            }
            current.touches += pendingFile.touches;
            current.excluded = current.excluded || pendingFile.excluded;
            current.linesAdded = addLineValue(current.linesAdded, pendingFile.linesAdded, { partial: false });
            current.linesDeleted = addLineValue(current.linesDeleted, pendingFile.linesDeleted, { partial: false });
        }
    }

    /**
     * gate 压制：观测进 pending。id 稳定、`heartbeats: 0`（不算有效心跳）。
     *
     * 限频只限制 effective heartbeat count，**不丢 source timing**：同一 segment 内若出现
     * 第二点且与上一点 gap <= idle，pending 就是一条真实时长的 interval
     * （`durationMs = lastMs - firstMs`）；只有孤立单点才是零时长 evidence。
     * gap > idle 仍不连接：旧 pending 先封口，再开新的。
     */
    _pend(project, segmentKey, observation) {
        const idleMs = this.config.idleThresholdSeconds * 1000;
        let pending = project.pending.get(segmentKey);
        if (pending) {
            if (observation.at > pending.lastMs && observation.at - pending.lastMs > idleMs) {
                // 段内 gap 超阈值：不跨 gap 连；旧段按真实时长封口，新段重新开始
                project.pending.delete(segmentKey);
                this._closeRecord(project, this._pendingToRecord(project, pending, 'pending:gap'), 'pending:gap');
                pending = null;
            }
            else if (observation.at >= pending.firstMs) {
                // 同段内的正常前进：直接推进 lastMs
            }
        }
        if (!pending) {
            if (project.pending.size >= ACTIVITY_LIMITS.maxPendingSegments) {
                const oldest = [...project.pending.entries()].sort((a, b) => a[1].updateMs - b[1].updateMs)[0];
                if (oldest) {
                    project.pending.delete(oldest[0]);
                    this._closeRecord(project, this._pendingToRecord(project, oldest[1], 'pending:overflow'), 'pending:overflow');
                }
            }
            pending = {
                ...evidenceSkeleton(),
                id: `${project.key}#pending#${segmentKey}#${observation.at}`,
                kind: 'evidence',
                project: observation.projectName || project.name,
                projectKey: project.key,
                cwd: project.cwd,
                source: observation.source,
                sessionId: observation.sessionId,
                runId: observation.runId,
                startMs: observation.at,
                endMs: observation.at,
                firstMs: observation.at,
                lastMs: observation.at,
                updateMs: observation.at,
                revision: 0,
                heartbeats: 0,
                observations: 0,
                open: false,
                closeReason: 'pending',
                pending: true,
            };
            project.pending.set(segmentKey, pending);
        }
        pending.observations += 1;
        pending.lastMs = Math.max(pending.lastMs, observation.at);
        pending.firstMs = Math.min(pending.firstMs, observation.at);
        pending.startMs = pending.firstMs;
        pending.endMs = pending.lastMs;
        pending.updateMs = Math.max(pending.updateMs, observation.at);
        pending.revision += 1;
        // 两个真实点（gap <= idle）即真实时长；单点仍是零时长 evidence
        pending.kind = pending.lastMs > pending.firstMs ? 'interval' : 'evidence';
        this._absorbEvidence(pending, observation);
        return pending;
    }

    /** pending → 记录（interval 保留真实时长，单点 evidence 零时长；heartbeats 恒为 0）。 */
    _pendingToRecord(project, pending, reason) {
        const record = emptyRecord({
            id: pending.id,
            kind: pending.lastMs > pending.firstMs ? 'interval' : 'evidence',
            project: pending.project,
            projectKey: project.key,
            cwd: pending.cwd || project.cwd,
            source: pending.source,
            sessionId: pending.sessionId,
            runId: pending.runId,
            at: pending.firstMs,
            heartbeats: 0,
            open: false,
        });
        record.startMs = pending.firstMs;
        record.endMs = pending.lastMs;
        record.updateMs = pending.lastMs;
        record.closeReason = reason;
        record.revision = pending.revision;
        this._mergeEvidence(record, { ...pending, lastMs: pending.lastMs });
        return record;
    }

    _close(project, segmentKey, reason) {
        const record = project.open.get(segmentKey);
        if (!record) return null;
        project.open.delete(segmentKey);
        return this._closeRecord(project, record, reason);
    }

    /** 归档到 closed（保留窗口，淘汰数可观测；已归档行由宿主 append 保存）。 */
    _closeRecord(project, record, reason) {
        record.open = false;
        record.pending = false;
        record.closeReason = reason;
        record.updateMs = Math.max(record.updateMs, Math.floor(this._clock()));
        record.revision += 1;
        project.closed.push(record);
        if (project.closed.length > ACTIVITY_LIMITS.maxClosedRecords) {
            const overflow = project.closed.length - ACTIVITY_LIMITS.maxClosedRecords;
            project.closed.splice(0, overflow);
            project.recordsEvicted += overflow;
        }
        return record;
    }

    _finalizeProject(project, reason) {
        for (const segmentKey of [...project.open.keys()]) this._close(project, segmentKey, reason);
        for (const [segmentKey, pending] of [...project.pending.entries()]) {
            project.pending.delete(segmentKey);
            const record = this._pendingToRecord(project, pending, `pending:${reason}`);
            this._closeRecord(project, record, record.closeReason);
        }
    }

    /** 严格恢复 exportState()（版本/形状/类型不符一律抛错）。 */
    _restoreState(state) {
        if (!isPlainObject(state)) throw new ActivityError('state 必须是对象', { code: 'invalid_state', path: 'state' });
        const allowed = ['v', 'savedAt', 'startedAt', 'sequence', 'seen', 'seenEvicted', 'projects'];
        for (const key of Object.keys(state)) {
            if (!allowed.includes(key)) throw new ActivityError(`state 含未知字段 ${key}`, { code: 'invalid_state', path: key });
        }
        if (state.v !== STATE_VERSION) throw new ActivityError(`state 版本不支持（收到 ${JSON.stringify(state.v)}，期望 ${STATE_VERSION}）`, { code: 'invalid_state', path: 'v' });
        if (typeof state.startedAt !== 'number' || !Number.isFinite(state.startedAt)) throw new ActivityError('startedAt 必须是数字', { code: 'invalid_state', path: 'startedAt' });
        if (!Number.isInteger(state.sequence) || state.sequence < 0) throw new ActivityError('sequence 必须是非负整数', { code: 'invalid_state', path: 'sequence' });
        if (!Array.isArray(state.seen) || state.seen.some((item) => typeof item !== 'string')) throw new ActivityError('seen 必须是字符串数组', { code: 'invalid_state', path: 'seen' });
        if (!Number.isInteger(state.seenEvicted ?? 0) || (state.seenEvicted ?? 0) < 0) throw new ActivityError('seenEvicted 必须是非负整数', { code: 'invalid_state', path: 'seenEvicted' });
        if (!Array.isArray(state.projects)) throw new ActivityError('projects 必须是数组', { code: 'invalid_state', path: 'projects' });

        this._sequence = state.sequence;
        this.startedAt = state.startedAt;
        this._seenEvicted = state.seenEvicted ?? 0;
        this._seen.clear();
        const seen = state.seen;
        for (let index = Math.max(0, seen.length - ACTIVITY_LIMITS.maxDedupeIds); index < seen.length; index += 1) this._seen.add(seen[index]);
        this._seenEvicted += Math.max(0, seen.length - ACTIVITY_LIMITS.maxDedupeIds);

        for (const [index, entry] of state.projects.entries()) {
            const where = `projects[${index}]`;
            if (!isPlainObject(entry)) throw new ActivityError('项目状态必须是对象', { code: 'invalid_state', path: where });
            const projectKeys = ['key', 'cwd', 'name', 'lastHeartbeatMs', 'lastActivityMs', 'heartbeats', 'observations', 'suppressed', 'recordsEvicted', 'closed', 'open', 'pending'];
            for (const key of Object.keys(entry)) {
                if (!projectKeys.includes(key)) throw new ActivityError(`项目状态含未知字段 ${key}`, { code: 'invalid_state', path: `${where}.${key}` });
            }
            if (typeof entry.key !== 'string' || entry.key === '') throw new ActivityError('key 必须是非空字符串', { code: 'invalid_state', path: `${where}.key` });
            if (typeof entry.cwd !== 'string' || entry.cwd === '') throw new ActivityError('cwd 必须是非空字符串', { code: 'invalid_state', path: `${where}.cwd` });
            for (const counter of ['heartbeats', 'observations', 'suppressed', 'recordsEvicted']) {
                if (!Number.isInteger(entry[counter]) || entry[counter] < 0) throw new ActivityError(`${counter} 必须是非负整数`, { code: 'invalid_state', path: `${where}.${counter}` });
            }
            for (const key of ['lastHeartbeatMs', 'lastActivityMs']) {
                if (entry[key] !== null && (typeof entry[key] !== 'number' || !Number.isFinite(entry[key]))) throw new ActivityError(`${key} 必须是数字或 null`, { code: 'invalid_state', path: `${where}.${key}` });
            }
            if (!Array.isArray(entry.closed) || !Array.isArray(entry.open) || !Array.isArray(entry.pending)) throw new ActivityError('closed/open/pending 必须是数组', { code: 'invalid_state', path: where });
            if (this._projects.size >= ACTIVITY_LIMITS.maxProjects) throw new ActivityError('恢复的项目数超过上限', { code: 'invalid_state', path: 'projects' });

            const project = {
                key: entry.key,
                cwd: entry.cwd,
                name: typeof entry.name === 'string' ? entry.name : '',
                closed: [],
                open: new Map(),
                pending: new Map(),
                lastHeartbeatMs: entry.lastHeartbeatMs,
                lastActivityMs: entry.lastActivityMs,
                heartbeats: entry.heartbeats,
                observations: entry.observations,
                suppressed: entry.suppressed,
                recordsEvicted: entry.recordsEvicted,
            };
            entry.closed.forEach((record, recordIndex) => {
                project.closed.push(this._restoreRecord(record, `${where}.closed[${recordIndex}]`, { open: false, pending: false }));
            });
            entry.open.forEach((record, recordIndex) => {
                const restored = this._restoreRecord(record, `${where}.open[${recordIndex}]`, { open: true, pending: false });
                const segmentKey = `${restored.source}|${restored.sessionId}|${restored.runId}`;
                if (project.open.has(segmentKey)) throw new ActivityError(`open 记录 segment 重复 ${segmentKey}`, { code: 'invalid_state', path: `${where}.open` });
                project.open.set(segmentKey, restored);
            });
            entry.pending.forEach((pending, pendingIndex) => {
                const restored = this._restoreRecord(pending, `${where}.pending[${pendingIndex}]`, { open: false, pending: true });
                const segmentKey = `${restored.source}|${restored.sessionId}|${restored.runId}`;
                restored.pending = true;
                // 恢复时同样保留真实时长：两点且 gap<=idle 是 interval，单点才降级为 evidence
                restored.firstMs = restored.startMs;
                restored.lastMs = restored.endMs;
                restored.kind = restored.endMs > restored.startMs ? 'interval' : 'evidence';
                restored.heartbeats = 0;
                project.pending.set(segmentKey, restored);
            });
            this._projects.set(project.key, project);
        }
    }

    _restoreRecord(record, where, { open, pending }) {
        if (!isPlainObject(record)) throw new ActivityError('记录必须是对象', { code: 'invalid_state', path: where });
        if (typeof record.id !== 'string' || record.id === '') throw new ActivityError('id 必须是非空字符串', { code: 'invalid_state', path: `${where}.id` });
        if (typeof record.projectKey !== 'string') throw new ActivityError('projectKey 必须是字符串', { code: 'invalid_state', path: `${where}.projectKey` });
        if (!SOURCES.includes(record.source)) throw new ActivityError('source 非法', { code: 'invalid_state', path: `${where}.source` });
        const startMs = finiteNumber(record.startMs, `${where}.startMs`);
        const endMs = finiteNumber(record.endMs, `${where}.endMs`);
        if (endMs < startMs) throw new ActivityError('endMs 不能小于 startMs', { code: 'invalid_state', path: `${where}.endMs` });
        if (!Number.isInteger(record.revision) || record.revision < 0) throw new ActivityError('revision 必须是非负整数', { code: 'invalid_state', path: `${where}.revision` });
        if (!Array.isArray(record.files)) throw new ActivityError('files 必须是数组', { code: 'invalid_state', path: `${where}.files` });
        const lineEntries = (record.lineEntries ?? []);
        if (!Array.isArray(lineEntries)) throw new ActivityError('lineEntries 必须是数组', { code: 'invalid_state', path: `${where}.lineEntries` });

        const files = new Map();
        record.files.forEach((file, index) => {
            const restoredFile = this._restoreFile(file, `${where}.files[${index}]`);
            files.set(restoredFile.path, restoredFile);
        });
        lineEntries.forEach((entry, index) => {
            const entryWhere = `${where}.lineEntries[${index}]`;
            if (!isPlainObject(entry)) throw new ActivityError('lineEntries 项必须是对象', { code: 'invalid_state', path: entryWhere });
            finiteNumber(entry.at, `${entryWhere}.at`);
            if (typeof entry.file !== 'string') throw new ActivityError('file 必须是字符串', { code: 'invalid_state', path: `${entryWhere}.file` });
            for (const key of ['added', 'deleted']) {
                const value = entry[key];
                if (value !== null && value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
                    throw new ActivityError(`${key} 必须是数字或 null`, { code: 'invalid_state', path: `${entryWhere}.${key}` });
                }
            }
        });
        const undated = record.linesUndated ?? {};

        return {
            ...evidenceSkeleton(),
            id: record.id,
            kind: pending ? 'evidence' : (record.kind === 'evidence' ? 'evidence' : 'interval'),
            project: typeof record.project === 'string' ? record.project : '',
            projectKey: record.projectKey,
            cwd: typeof record.cwd === 'string' ? record.cwd : '',
            source: record.source,
            sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
            runId: typeof record.runId === 'string' ? record.runId : '',
            startMs,
            endMs,
            updateMs: typeof record.updateAt === 'string' && Number.isFinite(Date.parse(record.updateAt)) ? Date.parse(record.updateAt) : endMs,
            revision: record.revision,
            heartbeats: pending ? 0 : (Number.isInteger(record.heartbeats) ? record.heartbeats : 0),
            observations: Number.isInteger(record.observations) ? record.observations : 0,
            linesAdded: record.linesAdded ?? null,
            linesDeleted: record.linesDeleted ?? null,
            linesPartial: record.linesPartial === true,
            linesDropped: Number.isInteger(record.linesDropped) ? record.linesDropped : 0,
            linesUndated: {
                added: Number.isInteger(undated.added) ? undated.added : 0,
                deleted: Number.isInteger(undated.deleted) ? undated.deleted : 0,
            },
            filesDropped: Number.isInteger(record.filesDropped) ? record.filesDropped : 0,
            files,
            lineEntries: lineEntries.map((entry) => ({
                at: Number(entry.at),
                file: entry.file,
                added: entry.added ?? null,
                deleted: entry.deleted ?? null,
            })),
            firstMs: startMs,
            lastMs: endMs,
            open,
            pending,
            closeReason: typeof record.closeReason === 'string' ? record.closeReason : '',
        };
    }

    _restoreFile(file, where) {
        if (!isPlainObject(file)) throw new ActivityError('文件证据必须是对象', { code: 'invalid_state', path: where });
        if (typeof file.path !== 'string' || file.path === '') throw new ActivityError('path 必须是非空字符串', { code: 'invalid_state', path: `${where}.path` });
        if (!Number.isInteger(file.touches) || file.touches < 0) throw new ActivityError('touches 必须是非负整数', { code: 'invalid_state', path: `${where}.touches` });
        for (const key of ['linesAdded', 'linesDeleted']) {
            const value = file[key];
            if (value !== null && value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
                throw new ActivityError(`${key} 必须是数字或 null`, { code: 'invalid_state', path: `${where}.${key}` });
            }
        }
        return { path: file.path, touches: file.touches, linesAdded: file.linesAdded ?? null, linesDeleted: file.linesDeleted ?? null, excluded: file.excluded === true };
    }
}

/**
 * 按 id 归并记录：同 id 取 `revision` 更大的版本。宿主 append 必须用它，
 * pending 投影 → interval 的迁移只替换一行，不双计。
 */
export function upsertRecords(existing, incoming) {
    const byId = new Map();
    for (const record of existing ?? []) {
        if (record && typeof record.id === 'string') byId.set(record.id, record);
    }
    let added = 0;
    let updated = 0;
    for (const record of incoming ?? []) {
        if (!record || typeof record.id !== 'string') continue;
        const current = byId.get(record.id);
        if (!current) {
            byId.set(record.id, record);
            added += 1;
            continue;
        }
        if (Number(record.revision ?? 0) >= Number(current.revision ?? 0)) {
            byId.set(record.id, record);
            updated += 1;
        }
    }
    return { records: [...byId.values()], added, updated };
}

/** 每个 id 只留最新 revision（防重复 append 双计）。 */
function latestVersions(records) {
    const byId = new Map();
    for (const record of records ?? []) {
        if (!record || typeof record.id !== 'string') continue;
        const current = byId.get(record.id);
        if (!current || Number(record.revision ?? 0) >= Number(current.revision ?? 0)) byId.set(record.id, record);
    }
    return [...byId.values()];
}

/** 按 key 追加区间到一组（Map<key, span[]>）。 */
function pushSpan(map, key, span) {
    const list = map.get(key);
    if (list) list.push(span);
    else map.set(key, [span]);
}

/**
 * 汇总：只统计落在半开 `[from, to)` 内的活动。
 *
 * - `wallUnionMs`：**唯一总墙钟**（全局并集，并行项目不重复）。仪表盘总时长用它。
 * - `totalMs`：各项目 union 之和（同项目重叠只算一次，并行项目会重复），不能当总墙钟。
 * - 行数按条目真实时刻归日（跨午夜不复制、不按比例拆分）；`linesUndated` 只进总量。
 *
 * @param records - 记录数组（可含重复版本的 append 日志，内部按 id 取最新）。
 * @param options - { from, to, timezone, weekStartsOn }；from/to 是 epoch 毫秒，半开。
 */
export function summarize(records, options = {}) {
    const timezone = options.timezone ?? detectTimezone();
    const weekStartsOn = options.weekStartsOn ?? 1;
    const from = options.from === undefined || options.from === null ? null : readAt(options.from, 'from');
    const to = options.to === undefined || options.to === null ? null : readAt(options.to, 'to');
    if (from !== null && to !== null && to <= from) throw new ActivityError('to 必须大于 from（半开区间 [from, to)）', { code: 'invalid_range', path: 'to' });
    const inRangeAt = (at) => (from === null || at >= from) && (to === null || at < to);
    /** 零时长记录（单点活动）也要算"相交"，否则它的行数证据会凭空消失。 */
    const intersectsRange = (startMs, endMs) => {
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
        if (endMs > startMs) return clipSpan(startMs, endMs, from, to) !== null;
        return inRangeAt(endMs);
    };

    const recordsUnique = latestVersions(records);

    /** 时长：按 project / source / day / week 归集区间。 */
    const allSpans = [];
    const projectSpans = new Map();
    const sourceSpans = new Map();
    const daySpans = new Map();
    const weekSpans = new Map();
    const dayDetail = new Map();

    for (const record of recordsUnique) {
        if (record.kind !== 'interval') continue;
        const startMs = Number(record.startMs);
        const endMs = Number(record.endMs);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
        if (!intersectsRange(startMs, endMs)) continue;
        const projectKey = String(record.projectKey ?? '');
        const source = String(record.source ?? 'unknown');
        // 零时长（单点）记录贡献 0ms，但仍出现在 byProject/bySource 里，避免"有活动却没有行"
        const span = endMs > startMs ? clipSpan(startMs, endMs, from, to) : { startMs: endMs, endMs, zero: true };
        if (!span) continue;
        allSpans.push(span);
        pushSpan(projectSpans, projectKey, span);
        pushSpan(sourceSpans, source, span);
        for (const piece of splitByLocalDay(span.startMs, span.endMs, timezone)) {
            pushSpan(daySpans, piece.day, piece);
            pushSpan(weekSpans, weekKeyOf(piece.startMs, { timezone, weekStartsOn }), piece);
            pushSpan(dayDetail, `${piece.day}|${projectKey}|${source}`, piece);
        }
    }

    /** 行数：同一条 diff 只落真实发生日。 */
    const fileTotals = new Map();
    const dayLines = new Map();
    let added = 0;
    let deleted = 0;
    let knownLines = false;
    let partialLines = false;
    let dropped = 0;
    let undatedAdded = 0;
    let undatedDeleted = 0;
    let filesDropped = 0;

    for (const record of recordsUnique) {
        const startMs = Number(record.startMs);
        const endMs = Number(record.endMs);
        if (!intersectsRange(startMs, endMs)) continue;

        dropped += Number(record.linesDropped ?? 0);
        filesDropped += Number(record.filesDropped ?? 0);
        if (record.linesPartial === true) partialLines = true;

        for (const entry of record.lineEntries ?? []) {
            const at = Number(entry.at);
            if (!Number.isFinite(at) || !inRangeAt(at)) continue;
            if (entry.added !== null && entry.added !== undefined) { added += entry.added; knownLines = true; }
            else partialLines = true;
            if (entry.deleted !== null && entry.deleted !== undefined) { deleted += entry.deleted; knownLines = true; }
            else partialLines = true;
            const dayEntry = dayLines.get(dayKeyOf(at, timezone)) ?? { added: 0, deleted: 0 };
            dayEntry.added += entry.added ?? 0;
            dayEntry.deleted += entry.deleted ?? 0;
            dayLines.set(dayKeyOf(at, timezone), dayEntry);
            if (entry.file) {
                const fileEntry = fileTotals.get(entry.file) ?? { path: entry.file, linesAdded: null, linesDeleted: null, touches: 0, excluded: false };
                if (entry.added !== null) fileEntry.linesAdded = (fileEntry.linesAdded ?? 0) + entry.added;
                if (entry.deleted !== null) fileEntry.linesDeleted = (fileEntry.linesDeleted ?? 0) + entry.deleted;
                fileTotals.set(entry.file, fileEntry);
            }
        }

        undatedAdded += Number(record.linesUndated?.added ?? 0);
        undatedDeleted += Number(record.linesUndated?.deleted ?? 0);
        for (const file of record.files ?? []) {
            const fileEntry = fileTotals.get(file.path) ?? { path: file.path, linesAdded: null, linesDeleted: null, touches: 0, excluded: false };
            fileEntry.touches += Number(file.touches ?? 0);
            fileEntry.excluded = fileEntry.excluded || file.excluded === true;
            fileTotals.set(file.path, fileEntry);
        }
    }
    added += undatedAdded;
    deleted += undatedDeleted;
    if (undatedAdded > 0 || undatedDeleted > 0) knownLines = true;

    const projectRows = [...projectSpans.entries()]
        .map(([projectKey, list]) => ({
            projectKey,
            project: recordsUnique.find((record) => String(record.projectKey ?? '') === projectKey)?.project ?? '',
            durationMs: totalDurationMs(list),
        }))
        .sort((a, b) => b.durationMs - a.durationMs);
    const sourceRows = [...sourceSpans.entries()]
        .map(([source, list]) => ({ source, durationMs: totalDurationMs(list) }))
        .sort((a, b) => b.durationMs - a.durationMs);
    const dayRows = [...daySpans.entries()]
        .map(([day, list]) => ({
            day,
            startMs: dayBoundsOf(day, timezone).startMs,
            durationMs: totalDurationMs(list),
            linesAdded: dayLines.get(day)?.added ?? 0,
            linesDeleted: dayLines.get(day)?.deleted ?? 0,
        }))
        .sort((a, b) => a.day.localeCompare(b.day));
    const weekRows = [...weekSpans.entries()]
        .map(([week, list]) => ({ week, durationMs: totalDurationMs(list) }))
        .sort((a, b) => a.week.localeCompare(b.week));
    const detailRows = [...dayDetail.entries()]
        .map(([key, list]) => {
            const [day, projectKey, source] = key.split('|');
            return { day, projectKey, source, durationMs: totalDurationMs(list) };
        })
        .sort((a, b) => a.day.localeCompare(b.day) || a.projectKey.localeCompare(b.projectKey));

    let totalMs = 0;
    for (const list of projectSpans.values()) totalMs += totalDurationMs(list);

    /** 有效心跳数：只数 heartbeats > 0 的记录；pending 的真实时长不算心跳（限频只压心跳数）。 */
    let totalEffectiveHeartbeats = 0;
    for (const record of recordsUnique) {
        if (!intersectsRange(Number(record.startMs), Number(record.endMs))) continue;
        totalEffectiveHeartbeats += Math.max(0, Number(record.heartbeats ?? 0));
    }

    return {
        v: RECORD_VERSION,
        generatedAt: isoOf(Math.floor(Date.now())),
        from,
        to,
        timezone,
        weekStartsOn,
        /** 唯一总墙钟（全局并集），含被 gate 压制但真实发生的 source 区间。 */
        wallUnionMs: totalDurationMs(allSpans),
        /** 各项目 union 之和；并行项目重复，不能当总墙钟。 */
        totalMs,
        /** 有效心跳数（只数 heartbeats > 0）；pending 真实时长不计入。 */
        totalEffectiveHeartbeats,
        recordCount: recordsUnique.filter((record) => record.kind === 'interval').length,
        pendingRecords: recordsUnique.filter((record) => record.pending === true).length,
        byProject: projectRows,
        bySource: sourceRows,
        byDay: dayRows,
        byWeek: weekRows,
        byDayDetail: detailRows,
        files: [...fileTotals.values()].sort((a, b) => b.touches - a.touches || a.path.localeCompare(b.path)),
        lines: {
            added: knownLines ? added : null,
            deleted: knownLines ? deleted : null,
            partial: partialLines,
            dropped,
            known: knownLines,
            undated: { added: undatedAdded, deleted: undatedDeleted },
            filesDropped,
        },
    };
}

function csvCell(value) {
    if (value === null || value === undefined) return '';
    let text = String(value);
    // RFC 4180：含逗号/引号/换行的值要加引号并把引号双写
    const quoted = /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    return quoted;
}

/** 公式注入防护：以 = + - @ \t \r 开头的单元格加前导单引号（Excel/Sheets 不再求值）。 */
function csvGuard(value) {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** 文件明细单元格：`path: +A/-D (n 次)`，分号分隔；路径本身走公式注入防护与 RFC 4180 转义。 */
function csvFiles(files) {
    if (!Array.isArray(files) || files.length === 0) return '';
    return files
        .map((file) => {
            const added = file.linesAdded === null || file.linesAdded === undefined ? '?' : file.linesAdded;
            const deleted = file.linesDeleted === null || file.linesDeleted === undefined ? '?' : file.linesDeleted;
            const flag = file.excluded ? '!' : '';
            return `${flag}${file.path}:+${added}/-${deleted}@${file.touches}`;
        })
        .join(';');
}

/** 记录导出 CSV（含表头；不含凭据/正文）。 */
export function recordsToCsv(records) {
    const header = [
        'id', 'kind', 'project', 'projectKey', 'source', 'sessionId', 'runId',
        'startAt', 'endAt', 'durationMs', 'heartbeats', 'observations',
        'linesAdded', 'linesDeleted', 'linesPartial', 'linesDropped', 'fileCount',
        'files', 'open', 'pending', 'closeReason',
    ];
    const rows = [header.join(',')];
    for (const record of latestVersions(records)) {
        rows.push(header.map((key) => {
            if (key === 'durationMs') {
                const startMs = Number(record.startMs);
                const endMs = Number(record.endMs);
                if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return '';
                return record.kind === 'interval' ? Math.max(0, endMs - startMs) : 0;
            }
            if (key === 'fileCount') return Array.isArray(record.files) ? record.files.length : 0;
            if (key === 'files') return csvCell(csvGuard(csvFiles(record.files)));
            if (typeof record[key] === 'string') return csvCell(csvGuard(record[key]));
            return csvCell(record[key]);
        }).join(','));
    }
    // 行以 \n 结尾（RFC 4180 CRLF 可选；这里统一 LF，末尾保留一个换行）
    return `${rows.join('\n')}\n`;
}
