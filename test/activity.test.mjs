/**
 * 计时核心单测：限频不丢证据、pending → interval 同 id 迁移、跨午夜行数归属、
 * 总墙钟口径、去重窗口保留、跨实例恢复。
 *
 * 全部纯内存，注入时钟，不碰 store/宿主。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ACTIVITY_LIMITS,
    ActivityTracker,
    dayBoundsOf,
    intervalUnion,
    isExcludedPath,
    projectKeyOf,
    recordsToCsv,
    splitByLocalDay,
    summarize,
    totalDurationMs,
    upsertRecords,
} from '../lib/activity.js';

/** 固定配置：心跳 60s、idle 180s、UTC，避免本地时区影响。 */
const CONFIG = {
    heartbeatIntervalSeconds: 60,
    idleThresholdSeconds: 180,
    timezone: 'UTC',
};

const HOUR = 3_600_000;
const MIN = 60_000;

/** T0：2026-01-01T00:00:00Z。 */
const T0 = Date.UTC(2026, 0, 1);

/** 造一个 tracker，时钟固定。 */
function makeTracker(config = CONFIG, state = undefined) {
    return new ActivityTracker(config, { now: () => T0, state });
}

/** 一条 AI 文件观测。 */
function aiFile(id, at, extra = {}) {
    return {
        id,
        cwd: 'E:/proj-a',
        source: 'ai',
        kind: 'file',
        sessionId: 's1',
        runId: 'r1',
        at,
        ...extra,
    };
}

test('projectKeyOf 规范化：绝对路径、Windows 下大小写与分隔符一致、相对路径拒绝', () => {
    const key = projectKeyOf('E:/proj-a');
    assert.ok(key.length > 0);
    // 尾斜杠、反斜杠、盘符大小写都应折成同一个键
    assert.equal(projectKeyOf('E:\\PROJ-A\\'), projectKeyOf('e:/proj-a'));
    assert.throws(() => projectKeyOf('proj-a'), (error) => error.code === 'invalid_cwd');
    assert.throws(() => projectKeyOf(''), (error) => error.code === 'invalid_cwd');
    assert.throws(() => projectKeyOf('/a\0b'), (error) => error.code === 'invalid_cwd');
});

test('孤立点 0 时长；连续观测按时长记账；gap > idle 断段且不赠 idle', () => {
    const tracker = makeTracker();
    const first = tracker.observe(aiFile('a1', T0));
    assert.equal(first.accepted, true);
    assert.equal(first.heartbeat, true);
    // 单点：时长必须为 0，不赠一条心跳
    let records = tracker.snapshot().records;
    assert.equal(records.length, 1);
    assert.equal(records[0].durationMs, 0);

    // 60s 后续段，时长 60s
    tracker.observe(aiFile('a2', T0 + MIN));
    records = tracker.snapshot().records;
    assert.equal(records.length, 1, '同 segment 相邻观测应续段，不是新记录');
    assert.equal(records[0].durationMs, MIN);

    // 断段：超过 idle(180s) → 新开一条，旧段不补时长
    tracker.observe(aiFile('a3', T0 + MIN + 400 * 1000));
    records = tracker.snapshot().records;
    assert.equal(records.length, 2);
    const closed = records.find((record) => !record.open);
    assert.equal(closed.durationMs, MIN, '断段后旧记录时长只到最后真实观测');
    assert.equal(closed.closeReason, 'gap');
});

test('时钟回拨只作证据：不缩短已记时长', () => {
    const tracker = makeTracker();
    tracker.observe(aiFile('a1', T0));
    tracker.observe(aiFile('a2', T0 + 2 * MIN));
    tracker.observe(aiFile('a3', T0 + MIN)); // 回拨
    const record = tracker.snapshot().records[0];
    assert.equal(record.endMs, T0 + 2 * MIN);
    assert.equal(record.durationMs, 2 * MIN);
});

test('项目级 gate 跨 source/session 共享：窗口内不新开记录', () => {
    const tracker = makeTracker();
    const first = tracker.observe(aiFile('a1', T0, { sessionId: 's1' }));
    assert.equal(first.heartbeat, true);

    // 另一个 session，30s 后：同一项目窗口内 → 被压制
    const second = tracker.observe(aiFile('a2', T0 + 30 * 1000, { sessionId: 's2' }));
    assert.equal(second.accepted, false);
    assert.equal(second.reason, 'rate_limited');
    assert.equal(second.pending, true);
    assert.notEqual(second.recordId, first.recordId);
});

test('pending 证据立刻出现在 snapshot：稳定 id、heartbeats 0、零时长、保留行数', () => {
    const tracker = makeTracker();
    tracker.observe(aiFile('a1', T0, { sessionId: 's1' }));
    tracker.observe(aiFile('a2', T0 + 30 * 1000, {
        sessionId: 's2',
        file: 'src/b.js',
        linesAdded: 10,
        linesDeleted: 2,
    }));

    const snap = tracker.snapshot();
    assert.equal(snap.records.length, 2, 'pending 必须是可见投影，不能藏在 Side 状态里');
    const pending = snap.records.find((record) => record.pending);
    assert.ok(pending, '应存在 pending 投影');
    assert.equal(pending.heartbeats, 0, 'pending 不能伪造有效心跳');
    assert.equal(pending.durationMs, 0);
    assert.equal(pending.kind, 'evidence');
    assert.equal(pending.linesAdded, 10, '限频不得丢行数证据');
    assert.equal(pending.linesDeleted, 2);
    assert.equal(pending.files[0].path, 'src/b.js');
    assert.equal(pending.lineEntries[0].at, T0 + 30 * 1000, '行数证据必须带发生时刻');
    // 项目统计也应看到 pending 段
    const project = snap.projects.find((entry) => entry.projectKey === projectKeyOf('E:/proj-a'));
    assert.equal(project.pendingSegments, 1);
});

test('pending 放行后迁移成同 id 的 interval：upsert 替换而非双计', () => {
    const tracker = makeTracker();
    tracker.observe(aiFile('a1', T0, { sessionId: 's1' }));
    tracker.observe(aiFile('a2', T0 + 30 * 1000, {
        sessionId: 's2',
        file: 'src/b.js',
        linesAdded: 10,
        linesDeleted: 2,
    }));
    const before = tracker.snapshot();
    const pendingBefore = before.records.find((record) => record.pending);
    const pendingId = pendingBefore.id;

    // 60s 后同一 segment 再次活动 → 放行，沿用 pending id
    const admitted = tracker.observe(aiFile('a3', T0 + 60 * 1000, { sessionId: 's2' }));
    assert.equal(admitted.accepted, true);
    assert.equal(admitted.recordId, pendingId, '放行必须沿用 pending 的 id，否则会新开一笔账');

    // 再续一段，使迁移后的 interval 有真实时长
    tracker.observe(aiFile('a4', T0 + 120 * 1000, { sessionId: 's2' }));

    const after = tracker.snapshot();
    const migrated = after.records.find((record) => record.id === pendingId);
    assert.ok(migrated, '迁移后的记录必须存在');
    assert.equal(migrated.pending, false);
    assert.equal(migrated.kind, 'interval');
    assert.equal(migrated.heartbeats >= 1, true);
    assert.equal(migrated.durationMs, 90 * 1000, '30s → 120s 的真实区间');
    assert.equal(migrated.startMs, T0 + 30 * 1000, '迁移不得丢掉 pending 期间的起点');
    assert.ok(migrated.revision > pendingBefore.revision, 'revision 必须递增');
    assert.equal(migrated.linesAdded, 10, '迁移不得丢 pending 的行数');

    // 宿主按 id upsert：同一批记录重放不产生双份
    const merged = upsertRecords(before.records, after.records);
    assert.equal(merged.records.length, 2, '合并后仍是 2 条（两个 segment 各一条）');
    assert.equal(merged.records.filter((record) => record.pending).length, 0, '迁移后不应残留 pending 投影');
    const stats = summarize(merged.records, { timezone: 'UTC' });
    assert.equal(stats.lines.added, 10, '合并后行数不得翻倍');
    assert.equal(stats.wallUnionMs, 90 * 1000, '30s 的 pending 真实起点不得被丢弃');
});

test('重复快照 append：同 id 同 revision 幂等，低 revision 不覆盖高 revision', () => {
    const tracker = makeTracker();
    tracker.observe(aiFile('a1', T0));
    const snap = tracker.snapshot();
    const once = upsertRecords([], snap.records);
    const twice = upsertRecords(once.records, snap.records);
    assert.equal(twice.records.length, 1);
    assert.equal(twice.records[0].revision, snap.records[0].revision);

    const stale = { ...snap.records[0], revision: snap.records[0].revision + 10, durationMs: 999 };
    const withStale = upsertRecords([], [snap.records[0], stale]);
    assert.equal(withStale.records.length, 1);
    assert.equal(withStale.records[0].revision, stale.revision, '高 revision 胜出');
});

test('跨午夜区间：时长按本地日切分，行数只落真实发生日（不复制、不按比例）', () => {
    const start = Date.UTC(2026, 0, 1, 22, 0, 0);
    const end = Date.UTC(2026, 0, 2, 2, 0, 0);
    const records = [{
        id: 'cross-midnight',
        kind: 'interval',
        revision: 1,
        project: 'proj-a',
        projectKey: projectKeyOf('E:/proj-a'),
        source: 'ai',
        startMs: start,
        endMs: end,
        heartbeats: 2,
        linesAdded: 15,
        linesDeleted: 2,
        files: [{ path: 'src/a.js', touches: 2, linesAdded: 15, linesDeleted: 2, excluded: false }],
        lineEntries: [
            { at: Date.UTC(2026, 0, 1, 23, 0, 0), file: 'src/a.js', added: 10, deleted: 2 },
            { at: Date.UTC(2026, 0, 2, 1, 0, 0), file: 'src/a.js', added: 5, deleted: 0 },
        ],
    }];
    const stats = summarize(records, { timezone: 'UTC' });
    const day1 = stats.byDay.find((row) => row.day === '2026-01-01');
    const day2 = stats.byDay.find((row) => row.day === '2026-01-02');
    assert.ok(day1 && day2);
    assert.equal(day1.durationMs, 2 * HOUR, '22:00 → 24:00 是 2 小时');
    assert.equal(day2.durationMs, 2 * HOUR, '00:00 → 02:00 是 2 小时');
    assert.equal(day1.linesAdded, 10);
    assert.equal(day2.linesAdded, 5);
    assert.equal(day1.linesAdded + day2.linesAdded, 15, '跨午夜不得把整段行数复制到两天');
    assert.equal(stats.lines.added, 15);
    assert.equal(day2.linesDeleted, 0);
});

test('半开 [from, to)：昨天的行数不冒充今天，时长只裁到范围内', () => {
    const records = [{
        id: 'cross-midnight',
        kind: 'interval',
        revision: 1,
        project: 'proj-a',
        projectKey: projectKeyOf('E:/proj-a'),
        source: 'ai',
        startMs: Date.UTC(2026, 0, 1, 22, 0, 0),
        endMs: Date.UTC(2026, 0, 2, 2, 0, 0),
        lineEntries: [
            { at: Date.UTC(2026, 0, 1, 23, 0, 0), file: 'src/a.js', added: 10, deleted: 2 },
            { at: Date.UTC(2026, 0, 2, 1, 0, 0), file: 'src/a.js', added: 5, deleted: 0 },
        ],
    }];
    const today = summarize(records, {
        timezone: 'UTC',
        from: dayBoundsOf('2026-01-02', 'UTC').startMs,
        to: dayBoundsOf('2026-01-03', 'UTC').startMs,
    });
    assert.equal(today.wallUnionMs, 2 * HOUR, '今天只有 00:00-02:00');
    assert.equal(today.byDay.length, 1);
    assert.equal(today.byDay[0].day, '2026-01-02');
    assert.equal(today.lines.added, 5, '昨天的 10 行不能算进今天');
    assert.equal(today.lines.deleted, 0);

    const yesterday = summarize(records, {
        timezone: 'UTC',
        from: dayBoundsOf('2026-01-01', 'UTC').startMs,
        to: dayBoundsOf('2026-01-02', 'UTC').startMs,
    });
    assert.equal(yesterday.lines.added, 10);
    assert.equal(yesterday.lines.deleted, 2);
});

test('重复版本 summary 只计最新 revision（append 日志重放不双计）', () => {
    const v1 = {
        id: 'r1', kind: 'interval', revision: 1, projectKey: projectKeyOf('E:/proj-a'), project: 'proj-a', source: 'ai',
        startMs: T0, endMs: T0 + 10 * MIN,
        lineEntries: [{ at: T0 + MIN, file: 'a.js', added: 3, deleted: 0 }],
    };
    const v2 = {
        ...v1, revision: 2, endMs: T0 + 20 * MIN,
        lineEntries: [{ at: T0 + MIN, file: 'a.js', added: 3, deleted: 0 }, { at: T0 + 15 * MIN, file: 'a.js', added: 7, deleted: 1 }],
    };
    const stats = summarize([v1, v2, v1], { timezone: 'UTC' });
    assert.equal(stats.recordCount, 1);
    assert.equal(stats.wallUnionMs, 20 * MIN);
    assert.equal(stats.lines.added, 10);
    assert.equal(stats.lines.deleted, 1);
    // 行数按各自时刻归日，仍只落一天
    const day = stats.byDay.find((row) => row.day === '2026-01-01');
    assert.equal(day.linesAdded, 10);
});

test('总墙钟口径：wallUnionMs 是唯一总墙钟，totalMs 并行项目会重复', () => {
    const projectA = projectKeyOf('E:/proj-a');
    const projectB = projectKeyOf('E:/proj-b');
    const base = { kind: 'interval', revision: 1, source: 'ai' };
    const records = [
        { ...base, id: 'a', project: 'proj-a', projectKey: projectA, startMs: T0, endMs: T0 + HOUR },
        { ...base, id: 'b', project: 'proj-b', projectKey: projectB, startMs: T0, endMs: T0 + HOUR },
    ];
    const stats = summarize(records, { timezone: 'UTC' });
    assert.equal(stats.wallUnionMs, HOUR, '并行两项目实际墙钟只有 1 小时');
    assert.equal(stats.totalMs, 2 * HOUR, 'totalMs 是项目时长之和，会重复');
    assert.equal(stats.byProject.length, 2);
    // 同项目重叠只算一次
    const overlap = summarize([
        { ...base, id: 'x1', projectKey: projectA, startMs: T0, endMs: T0 + HOUR },
        { ...base, id: 'x2', projectKey: projectA, startMs: T0 + 30 * MIN, endMs: T0 + 90 * MIN },
    ], { timezone: 'UTC' });
    assert.equal(overlap.totalMs, 90 * MIN);
    assert.equal(overlap.wallUnionMs, 90 * MIN);
});

test('行数未知保持 null：agent 事件、未知 source、被排除路径都不伪造行数', () => {
    const tracker = makeTracker();
    tracker.observe({ id: 'g1', cwd: 'E:/proj-a', source: 'ai', at: T0, linesAdded: 4 });
    tracker.observe({ id: 'g2', cwd: 'E:/proj-a', source: 'unknown', at: T0 + 30 * 1000, linesAdded: 9 });
    tracker.observe({
        id: 'g3', cwd: 'E:/proj-a', source: 'ai', kind: 'file', file: 'node_modules/x.js', at: T0 + 60 * 1000, linesAdded: 10,
    });
    const snap = tracker.snapshot();
    const agentRecord = snap.records.find((record) => record.id.startsWith(projectKeyOf('E:/proj-a')));
    // agent 事件不是文件证据：行数进 dropped，linesAdded 保持 null
    assert.equal(agentRecord.linesAdded, null);
    assert.equal(agentRecord.linesDeleted, null);
    assert.ok(agentRecord.linesDropped >= 4);
    const excluded = snap.records.find((record) => record.files.some((file) => file.path === 'node_modules/x.js'));
    assert.ok(excluded, '被排除文件仍作为证据存在');
    assert.equal(excluded.files[0].excluded, true);
    assert.equal(excluded.files[0].linesAdded, null, '被排除文件不贡献行数，也不伪造 0');
    const stats = summarize(snap.records, { timezone: 'UTC' });
    assert.equal(stats.lines.added, null, '没有可归因行数时应为 null 而不是 0');
    assert.equal(stats.lines.known, false);

    // 明确的 0 必须保持 0
    const zero = makeTracker();
    zero.observe(aiFile('z1', T0, { linesAdded: 0, linesDeleted: 0, file: 'src/a.js' }));
    const zeroStats = summarize(zero.snapshot().records, { timezone: 'UTC' });
    assert.equal(zeroStats.lines.added, 0);
    assert.equal(zeroStats.lines.deleted, 0);
    assert.equal(zeroStats.lines.known, true);
});

test('trackAgentActivity=false 只禁泛 Agent 活动，AI 文件证据仍计', () => {
    const tracker = makeTracker({ ...CONFIG, trackAgentActivity: false });
    const agent = tracker.observe({ id: 'g1', cwd: 'E:/proj-a', source: 'ai', at: T0 });
    assert.equal(agent.accepted, false);
    assert.equal(agent.reason, 'agent_tracking_disabled');

    // 泛 Agent 事件被拒时未占用 gate，文件证据因此能正常开段
    const file = tracker.observe(aiFile('f1', T0 + 30 * 1000, { file: 'src/a.js', linesAdded: 5 }));
    assert.equal(file.accepted, true);
    const stats = summarize(tracker.snapshot().records, { timezone: 'UTC' });
    assert.equal(stats.lines.added, 5, 'AI 文件行数证据不受 agent 开关牵连');
});

test('人类无信号一律 unknown；humanTracking 关闭时不采集人类时长', () => {
    const tracker = makeTracker(); // 默认 humanTracking.enabled=false
    const human = tracker.observe({ id: 'h1', cwd: 'E:/proj-a', source: 'human', at: T0 });
    assert.equal(human.accepted, false);
    assert.equal(human.reason, 'human_tracking_disabled');

    const unknown = tracker.observe({ id: 'u1', cwd: 'E:/proj-a', at: T0 + 60 * 1000, source: 'unknown' });
    assert.equal(unknown.accepted, true);
    assert.equal(unknown.source, 'unknown');
    const stats = summarize(tracker.snapshot().records, { timezone: 'UTC' });
    assert.equal(stats.bySource.length, 1);
    assert.equal(stats.bySource[0].source, 'unknown');
    assert.equal(stats.bySource.some((row) => row.source === 'ai'), false);

    // 开启后人类活动按时长计入，但仍是 human 分类
    const enabled = makeTracker({ ...CONFIG, humanTracking: { enabled: true } });
    enabled.observe({ id: 'h2', cwd: 'E:/proj-a', source: 'human', at: T0 });
    enabled.observe({ id: 'h3', cwd: 'E:/proj-a', source: 'human', at: T0 + 60 * 1000 });
    const humanStats = summarize(enabled.snapshot().records, { timezone: 'UTC' });
    assert.equal(humanStats.bySource.find((row) => row.source === 'human').durationMs, 60 * 1000);
    assert.equal(humanStats.lines.added, null, '人类没有 diff 证据时不臆造行数');
});

test('跨实例恢复：gate、去重、open 段与 pending 全部延续', () => {
    const tracker = makeTracker();
    tracker.observe(aiFile('a1', T0));
    tracker.observe(aiFile('a2', T0 + 30 * 1000, { sessionId: 's2', file: 'src/b.js', linesAdded: 10 }));
    const state = tracker.exportState();
    assert.equal(state.v, 1);
    assert.ok(Array.isArray(state.projects));
    // 必须能 JSON 往返
    const roundTripped = JSON.parse(JSON.stringify(state));

    const restored = makeTracker(CONFIG, roundTripped);
    assert.equal(restored.restored, true);

    // 去重延续：同 id 再来一次仍被拒绝
    const dup = restored.observe(aiFile('a2', T0 + 30 * 1000, { sessionId: 's2' }));
    assert.equal(dup.reason, 'duplicate');

    // gate 延续：30s 处的另一个 session 仍被压制（新实例会把它当首个心跳）
    const suppressed = restored.observe(aiFile('a3', T0 + 40 * 1000, { sessionId: 's3' }));
    assert.equal(suppressed.reason, 'rate_limited');
    const fresh = makeTracker();
    const freshResult = fresh.observe(aiFile('a3', T0 + 40 * 1000, { sessionId: 's3' }));
    assert.equal(freshResult.accepted, true, '无 state 的新实例没有 gate，说明恢复确实带了状态');

    // open 段与 pending 证据都还在
    const snap = restored.snapshot();
    assert.equal(snap.records.filter((record) => record.pending).length, 2, 'pending 段应随 state 恢复');
    assert.ok(snap.records.some((record) => record.open && record.id !== snap.records.find((item) => item.pending)?.id));

    // 续写：120s 起同一 session2 segment 连续活动（gap <= idle，且距上次心跳已过窗口）
    const continued = restored.observe(aiFile('a4', T0 + 60 * 1000, { sessionId: 's2' }));
    assert.equal(continued.accepted, true, '60s 已过 gate 窗口，应放行并沿用原 segment');
    const stats = summarize(restored.drain().records, { timezone: 'UTC' });
    assert.equal(stats.lines.added, 10, '恢复后行数不翻倍');
});

test('state 校验严格：坏版本/坏形状/未知字段都抛错，不半截恢复', () => {
    const tracker = makeTracker();
    tracker.observe(aiFile('a1', T0));
    const state = tracker.exportState();
    const bad = [
        { ...state, v: 99 },
        { ...state, sequence: -1 },
        { ...state, seen: 'nope' },
        { ...state, projects: {} },
        { ...state, extra: 1 },
        { ...state, projects: [{ ...state.projects[0], heartbeats: -1 }] },
        { ...state, projects: [{ ...state.projects[0], closed: [{ ...state.projects[0].closed[0], startMs: 'x' }] }] },
    ];
    for (const candidate of bad) {
        assert.throws(() => makeTracker(CONFIG, candidate), (error) => error.name === 'ActivityError' && error.code === 'invalid_state');
    }
});

test('seen 去重窗口有限但不拒绝新活动：到上限淘汰并计数', () => {
    const tracker = makeTracker();
    // 每个 id 间隔 1s，避免频繁开段；这里只验证去重窗口，不关心记录数
    const total = ACTIVITY_LIMITS.maxDedupeIds + 5;
    for (let index = 0; index < total; index += 1) {
        const result = tracker.observe({ id: `id-${index}`, cwd: 'E:/proj-a', source: 'ai', at: T0 + index * 1000 });
        assert.equal(result.accepted || result.reason === 'rate_limited', true, '上限内不得拒绝活动');
    }
    const state = tracker.exportState();
    assert.ok(state.seen.length <= ACTIVITY_LIMITS.maxDedupeIds, 'seen 不得无限增长');
    assert.ok(state.seenEvicted >= 1, '淘汰必须可观测');
    // 淘汰后仍能继续采集
    const later = tracker.observe({ id: 'late', cwd: 'E:/proj-a', source: 'ai', at: T0 + (total + 1) * 1000 });
    assert.equal(later.reason, 'ok');
});

test('intervalUnion 与总时长：零长度不计、逆序不计、相邻合并', () => {
    assert.equal(totalDurationMs([{ startMs: 0, endMs: 0 }]), 0);
    assert.equal(totalDurationMs([{ startMs: 10, endMs: 5 }]), 0, '逆序（时钟回拨）不产生时间');
    assert.equal(totalDurationMs([{ startMs: 0, endMs: 10 }, { startMs: 10, endMs: 20 }]), 20, '相邻区间应合并');
    assert.equal(intervalUnion([{ startMs: 0, endMs: 10 }, { startMs: 5, endMs: 12 }]).length, 1);
    assert.equal(totalDurationMs([{ startMs: 0, endMs: 100 }, { startMs: 20, endMs: 60 }]), 100, '包含关系不重复计算');
});

test('跨午夜切分不丢时间、DST 日边界按本地日（America/New_York）', () => {
    const pieces = splitByLocalDay(Date.UTC(2026, 0, 1, 22, 0, 0), Date.UTC(2026, 0, 2, 2, 0, 0), 'UTC');
    assert.equal(pieces.length, 2);
    assert.equal(pieces.reduce((sum, piece) => sum + (piece.endMs - piece.startMs), 0), 4 * HOUR);

    // 2026-03-08 是美东 DST 开始日（23 小时）
    const spring = dayBoundsOf('2026-03-08', 'America/New_York');
    assert.equal(spring.endMs - spring.startMs, 23 * HOUR);
    // 2026-11-01 是 DST 结束日（25 小时）
    const fall = dayBoundsOf('2026-11-01', 'America/New_York');
    assert.equal(fall.endMs - fall.startMs, 25 * HOUR);
    // 某日 09:00 本地必须落在该日边界内
    const inside = summarize([{
        id: 'x', kind: 'interval', revision: 1, projectKey: 'p', source: 'ai',
        startMs: spring.startMs + 9 * HOUR, endMs: spring.startMs + 10 * HOUR,
    }], { timezone: 'America/New_York' });
    assert.equal(inside.byDay[0].day, '2026-03-08');
});

test('排除规则只接受相对模式，命中目录/文件名/glob', () => {
    const patterns = ['node_modules', '*.pem', '.env'];
    assert.equal(isExcludedPath('node_modules/x/y.js', patterns), true);
    assert.equal(isExcludedPath('src/node_modules/a.js', patterns), true);
    assert.equal(isExcludedPath('keys/server.pem', patterns), true);
    assert.equal(isExcludedPath('.env', patterns), true);
    assert.equal(isExcludedPath('src/app.js', patterns), false);
    assert.equal(isExcludedPath('', patterns), false);
});

test('drain 封口 pending：单点 evidence / 两点真实时长；dispose 后 observe 拒绝', () => {
    const tracker = makeTracker();
    tracker.observe(aiFile('a1', T0));
    tracker.observe(aiFile('a2', T0 + 30 * 1000, { sessionId: 's2', linesAdded: 4 }));
    // 同一被压制 segment 再来一点：pending 必须记下真实 10s，而不是恒 0
    tracker.observe(aiFile('a3', T0 + 40 * 1000, { sessionId: 's2', linesAdded: 1 }));
    const drained = tracker.drain();
    assert.equal(drained.records.length, 2);
    const pendingClosed = drained.records.find((record) => record.sessionId === 's2');
    assert.ok(pendingClosed, 'pending 段必须落盘');
    assert.equal(pendingClosed.pending, false);
    assert.equal(pendingClosed.heartbeats, 0, 'pending 不带有效心跳');
    assert.equal(pendingClosed.kind, 'interval');
    assert.equal(pendingClosed.durationMs, 10 * 1000, '30s→40s 是 10 秒真实区间');
    assert.match(pendingClosed.closeReason, /pending:drain/);
    assert.equal(pendingClosed.linesAdded, 5, '证据不得因 drain 丢失');
    const admitted = drained.records.find((record) => record.sessionId === 's1');
    assert.equal(admitted.open, false);
    assert.match(admitted.closeReason, /drain/);
    tracker.dispose();
    assert.equal(tracker.observe(aiFile('a4', T0 + 3 * MIN)).reason, 'disposed');
});

test('回归：gate 压制不丢第二种 source 的真实区间（AI t0 + human t10/t20，无 t>=60 事件）', () => {
    const tracker = makeTracker({ ...CONFIG, humanTracking: { enabled: true } });
    // AI 先 admit 占用 60s gate
    const ai = tracker.observe({ id: 'ai-1', cwd: 'E:/proj-a', source: 'ai', sessionId: 'sa', runId: 'ra', at: T0 });
    assert.equal(ai.accepted, true);
    assert.equal(ai.heartbeat, true);

    // 人类同项目 10s 后开始，20s 再记一点——都在 gate 内，且之后没有任何 t>=60 的事件
    const h1 = tracker.observe({ id: 'hu-1', cwd: 'E:/proj-a', source: 'human', kind: 'file', sessionId: 'sh', runId: 'rh', at: T0 + 10_000, file: 'src/a.js', linesAdded: 3 });
    const h2 = tracker.observe({ id: 'hu-2', cwd: 'E:/proj-a', source: 'human', kind: 'file', sessionId: 'sh', runId: 'rh', at: T0 + 20_000, file: 'src/a.js', linesAdded: 0 });
    assert.equal(h1.pending, true, 'gate 内人类观测应进 pending');
    assert.equal(h2.reason, 'rate_limited');

    const snap = tracker.snapshot();
    const human = snap.records.find((record) => record.source === 'human');
    assert.ok(human, '人类 pending 段必须在 snapshot 里可见');
    assert.equal(human.pending, true);
    assert.equal(human.heartbeats, 0, '限频只压有效心跳数');
    assert.equal(human.kind, 'interval', '同 segment 两点且 gap<=idle → 真实时长');
    assert.equal(human.durationMs, 10_000, '人类真实两点应记 10 秒，不是 0');
    assert.equal(human.id.startsWith(projectKeyOf('E:/proj-a')), true, 'id 必须稳定');
    assert.equal(human.revision >= 1, true);

    const stats = summarize(snap.records, { timezone: 'UTC' });
    assert.equal(stats.bySource.find((row) => row.source === 'human').durationMs, 10_000, '按 source 必须有 10s');
    assert.equal(stats.totalEffectiveHeartbeats, 1, '有效心跳只有 AI 那一次');
    // AI 只有 t=0 一个点（孤立点 0 时长），真实墙钟就是人类的 10..20s
    assert.equal(stats.wallUnionMs, 10_000, '墙钟必须包含被压制的人类真实区间');

    // 后续 gate 放行：同 id 升级，heartbeats 1，不双计
    const upgrade = tracker.observe({ id: 'hu-3', cwd: 'E:/proj-a', source: 'human', kind: 'file', sessionId: 'sh', runId: 'rh', at: T0 + 60_000 });
    assert.equal(upgrade.accepted, true);
    assert.equal(upgrade.recordId, human.id, '放行沿用 pending id');
    const after = tracker.snapshot();
    const upgraded = after.records.find((record) => record.id === human.id);
    assert.equal(upgraded.heartbeats, 1);
    assert.equal(upgraded.pending, false);
    assert.equal(upgraded.startMs, T0 + 10_000, '升级不得丢 10s 起点');
    // 10s→60s 仍是真实连续段，时长 50s，没有叠成 60s
    assert.equal(upgraded.durationMs, 50_000);
    const merged = upsertRecords(snap.records, after.records);
    const humanMerged = merged.records.find((record) => record.id === human.id);
    assert.equal(humanMerged.durationMs, 50_000, 'upsert 后不双计');
    assert.equal(merged.records.filter((record) => record.pending).length, 0);
});

test('pending 段间 gap > idle 不跨 gap 连接（两个 source/session 仍各自真实）', () => {
    const tracker = makeTracker({ ...CONFIG, heartbeatIntervalSeconds: 60, idleThresholdSeconds: 60, humanTracking: { enabled: true } });
    tracker.observe({ id: 'ai-1', cwd: 'E:/proj-a', source: 'ai', at: T0 });
    // human 单点 t=10（孤立 → 0 时长 evidence）
    tracker.observe({ id: 'h1', cwd: 'E:/proj-a', source: 'human', sessionId: 'sh', at: T0 + 10_000 });
    // 同一 human segment，t=100（gap 90s > idle 60s）→ 不连，旧段封口
    tracker.observe({ id: 'h2', cwd: 'E:/proj-a', source: 'human', sessionId: 'sh', at: T0 + 100_000 });
    const snap = tracker.snapshot();
    const humans = snap.records.filter((record) => record.source === 'human');
    assert.equal(humans.length, 2, 'gap > idle 必须断成两段，不得跨 gap 连');
    const first = humans.find((record) => record.startMs === T0 + 10_000);
    assert.equal(first.pending, false, '跨 gap 后旧 pending 已封口成正式记录');
    assert.equal(first.heartbeats, 0, '封口的 pending 仍不带有效心跳');
    assert.equal(first.durationMs, 0, '孤立 pending 点仍为 0');
    assert.match(first.closeReason, /pending:gap/);
    const second = humans.find((record) => record.startMs === T0 + 100_000);
    assert.equal(second.heartbeats, 1, '100s 已过 60s gate，第二点正常放行');
    assert.equal(second.durationMs, 0, '第二点也是孤立单点，不得从 10s 跨 gap 连过来');
    assert.equal(first.id !== second.id, true, '断段必须换 id');
    for (const record of snap.records) assert.equal(record.heartbeats <= 1, true);
});

test('pending 跨 state 恢复：保留真实时长与 IDs，重复 upsert 不双计', () => {
    const tracker = makeTracker({ ...CONFIG, humanTracking: { enabled: true } });
    tracker.observe({ id: 'ai-1', cwd: 'E:/proj-a', source: 'ai', at: T0 });
    tracker.observe({ id: 'h1', cwd: 'E:/proj-a', source: 'human', sessionId: 'sh', at: T0 + 10_000 });
    tracker.observe({ id: 'h2', cwd: 'E:/proj-a', source: 'human', sessionId: 'sh', at: T0 + 20_000 });
    const snap = tracker.snapshot();
    const pending = snap.records.find((record) => record.pending);
    assert.equal(pending.durationMs, 10_000);

    const state = JSON.parse(JSON.stringify(tracker.exportState()));
    const restored = makeTracker({ ...CONFIG, humanTracking: { enabled: true } }, state);
    const restoredSnap = restored.snapshot();
    const again = restoredSnap.records.find((record) => record.id === pending.id);
    assert.ok(again);
    assert.equal(again.durationMs, 10_000, '恢复后 pending 真实时长不得归零');
    assert.equal(again.heartbeats, 0);
    const merged = upsertRecords(snap.records, restoredSnap.records);
    const stats = summarize(merged.records, { timezone: 'UTC' });
    assert.equal(stats.bySource.find((row) => row.source === 'human').durationMs, 10_000, '恢复后不双计');
});

test('两个不同 session 同 source 都被 gate 压制时，各自区间仍真实可见', () => {
    const tracker = makeTracker();
    tracker.observe({ id: 'a0', cwd: 'E:/proj-a', source: 'ai', sessionId: 's0', at: T0 });
    // s1: 10s、20s；s2: 30s、40s——同一 source、不同 session，全部被压制
    tracker.observe({ id: 'a1', cwd: 'E:/proj-a', source: 'ai', sessionId: 's1', at: T0 + 10_000 });
    tracker.observe({ id: 'a2', cwd: 'E:/proj-a', source: 'ai', sessionId: 's1', at: T0 + 20_000 });
    tracker.observe({ id: 'a3', cwd: 'E:/proj-a', source: 'ai', sessionId: 's2', at: T0 + 30_000 });
    tracker.observe({ id: 'a4', cwd: 'E:/proj-a', source: 'ai', sessionId: 's2', at: T0 + 40_000 });
    const snap = tracker.snapshot();
    const pendings = snap.records.filter((record) => record.pending);
    assert.equal(pendings.length, 2, '两个 session 各自的 pending 段都要可见');
    const s1 = pendings.find((record) => record.sessionId === 's1');
    const s2 = pendings.find((record) => record.sessionId === 's2');
    assert.equal(s1.durationMs, 10_000);
    assert.equal(s2.durationMs, 10_000);
    for (const record of pendings) assert.equal(record.heartbeats, 0);

    const stats = summarize(snap.records, { timezone: 'UTC' });
    assert.equal(stats.totalEffectiveHeartbeats, 1);
    // 10-20 与 30-40 不相邻 → 墙钟 10+10
    assert.equal(stats.wallUnionMs, 20_000);
});

test('enabled=false 完全不采集', () => {
    const tracker = makeTracker({ ...CONFIG, enabled: false });
    const result = tracker.observe(aiFile('a1', T0));
    assert.equal(result.reason, 'disabled');
    assert.equal(tracker.snapshot().records.length, 0);
});

test('CSV 导出：表头含文件明细、RFC4180 转义、公式注入防护、不泄露凭据', () => {
    const tracker = makeTracker();
    tracker.observe(aiFile('a1', T0, { file: 'src/a,b.js', linesAdded: 1, linesDeleted: 2, project: '=HYPERLINK("x"), inc' }));
    tracker.observe(aiFile('a2', T0 + MIN, { file: '=cmd.js', linesAdded: 3 }));
    const csv = recordsToCsv(tracker.snapshot().records);
    const rows = csv.split('\n').filter(Boolean);
    assert.equal(rows.length, 2);
    assert.match(rows[0], /^id,kind,project/);
    assert.match(rows[0], /files/, '表头必须提供文件归因列');
    // 文件证据出现在输出里（路径含逗号 → 整个单元格被引号包住）
    assert.match(csv, /src\/a,b\.js/, 'CSV 必须能还原"哪个文件加删了几行"');
    assert.match(rows[1], /"'=HYPERLINK\(""x""\), inc"/, '含逗号/引号的值必须被引用、双写引号，并做公式防护');
    // 公式注入：以 = 开头的单元格加前导单引号
    assert.match(csv, /'=cmd|'src\/=cmd/, '= 开头的值必须被防护，不能当公式执行');
    assert.equal(csv.includes('sk-'), false);
    assert.equal(csv.includes('token'), false);
});
