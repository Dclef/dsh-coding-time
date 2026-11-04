/**
 * dsh-coding-time · store × ActivityTracker 集成测试。
 *
 * 这里跑的是**真实** ActivityTracker + 真实 JsonlStore，不 mock 任何一方，
 * 目标是把三条承诺钉死：
 *
 * 1. project state 往返无损：exportState → writeProjectState → 新实例
 *    readProjectState({raw:true}) → new ActivityTracker(config, {state}) 后，
 *    项目级 60s gate（lastHeartbeatMs）跨进程仍然生效，不会各自限频。
 * 2. state 先 commit、journal 后 commit：journal 只写一半就"崩"了之后重启，
 *    按 id/revision upsert 重建出来的记录集与"一次成功写入"完全一致 —— 时长与
 *    行数都不重复计数。
 * 3. journal 白名单掉的字段（cwd/files/sessionId）必须能从 state 里拿回来，
 *    否则冷启动后的展示与文件明细就没了。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { ActivityTracker, projectKeyOf, summarize } from '../lib/activity.js';
import { JsonlStore } from '../lib/store.js';

const CWD = process.platform === 'win32' ? 'E:\\proj\\demo' : '/proj/demo';
const OTHER_CWD = process.platform === 'win32' ? 'E:\\proj\\other' : '/proj/other';
const BASE = Date.UTC(2026, 3, 1, 9, 0, 0);
const HOUR = 3_600_000;
const STORE_URL = pathToFileURL(path.resolve(import.meta.dirname, '../lib/store.js')).href;

/** 临时目录 + 一个已 init 的 store。 */
async function makeStore(t, name = 'default', overrides = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dct-int-'));
    const store = new JsonlStore({ directory, profile: name, lockTimeoutMs: 2_000, ...overrides });
    t.after(async () => {
        await store.close().catch(() => {});
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    });
    await store.init();
    return { store, directory };
}

/** 恢复一个 tracker（state 为 null 时等价于新开）。 */
function trackerWith(store, key, state, now) {
    return new ActivityTracker({}, { now: () => now, state: state ?? undefined });
}

/** 一次完整事务：读 state → 恢复 → 观察 → 写 state → append。 */
async function commitBatch(store, key, observations, { drainAfter = true } = {}) {
    return store.withProjectLock(key, async () => {
        const state = await store.readProjectState(key, { raw: true });
        const tracker = trackerWith(store, key, state, observations[0].at);
        const verdicts = observations.map((observation) => tracker.observe(observation));
        const exported = tracker.exportState();
        const throughRev = Math.max(
            ...tracker.snapshot().records.map((record) => Number(record.revision ?? 0)),
            0,
        );
        await store.writeProjectState(key, exported, { throughRev });
        const records = tracker.snapshot().records;
        await store.append(records);
        if (drainAfter) await store.flush();
        return { verdicts, exported, records };
    });
}

/** 从磁盘重建：state + journal 的 upsert 结果。 */
function rebuild(recordsFromJournal, state) {
    const tracker = new ActivityTracker({}, { now: () => BASE + 10 * HOUR, state });
    void tracker;
    return recordsFromJournal;
}

test('state 往返：exportState 全字段经 store 写读后能被真实 tracker 恢复', async (t) => {
    const { store } = await makeStore(t);
    const key = projectKeyOf(CWD);

    const first = await commitBatch(store, key, [
        { id: 'e1', cwd: CWD, source: 'ai', sessionId: 's1', at: BASE },
        { id: 'e2', cwd: CWD, source: 'ai', sessionId: 's1', file: 'src/a.js', kind: 'file', linesAdded: 10, linesDeleted: 2, at: BASE + 30_000 },
    ]);
    assert.equal(first.verdicts.every((verdict) => verdict.accepted), true);

    const raw = await store.readProjectState(key, { raw: true });
    assert.equal(raw.v, first.exported.v);
    assert.equal(raw.sequence, first.exported.sequence);
    assert.deepEqual(raw.seen, first.exported.seen);
    assert.equal(raw.projects.length, 1);
    assert.equal(raw.projects[0].cwd, first.exported.projects[0].cwd, 'cwd 必须留在 state 里');
    assert.equal(raw.projects[0].open.length, 1);
    assert.deepEqual(
        raw.projects[0].open[0].files.map((file) => file.path),
        first.exported.projects[0].open[0].files.map((file) => file.path),
        '文件明细不丢',
    );

    // 关键：新 tracker 能吃掉这份 state，而不是抛 invalid_state。
    const restoredTracker = new ActivityTracker({}, { now: () => BASE + 60_000, state: raw });
    assert.equal(restoredTracker.restored, true);
    const again = restoredTracker.exportState();
    assert.deepEqual(again.projects, raw.projects, '往返后项目状态逐字段一致');
    assert.equal(again.sequence, raw.sequence);

    // 没有字段被禁用词命中误删。
    assert.equal(
        store.warnings.filter((warning) => warning.code === 'state_field_forbidden_dropped').length,
        0,
        'exportState 不应触发 allowlist 丢弃',
    );
});

test('项目级 60s gate 跨进程：两个 store 实例 + 同 cwd 两会话只放行一次', async (t) => {
    const { store: a } = await makeStore(t);
    const key = projectKeyOf(CWD);
    // 第二个实例指向同一目录（模拟另一个进程）。
    const b = new JsonlStore({ directory: a.directory, profile: 'default', lockTimeoutMs: 2_000 });
    t.after(async () => { await b.close().catch(() => {}); });
    await b.init();

    await commitBatch(a, key, [{ id: 'a1', cwd: CWD, source: 'ai', sessionId: 's1', at: BASE }]);
    await commitBatch(b, key, [{ id: 'b1', cwd: CWD, source: 'ai', sessionId: 's2', at: BASE + 10_000 }]);

    const state = await a.readProjectState(key, { raw: true });
    const project = state.projects[0];
    assert.equal(project.heartbeats, 1, '60s 内第二个会话被项目级 gate 挡下');
    assert.equal(project.suppressed, 1);
    assert.equal(project.lastHeartbeatMs, BASE, 'gate 时间戳以首次放行为准');

    const tracker = new ActivityTracker({}, { now: () => BASE + 10_000, state });
    const verdict = tracker.observe({ id: 'b2', cwd: CWD, source: 'ai', sessionId: 's3', at: BASE + 10_000 });
    assert.equal(verdict.accepted, false);
    assert.equal(verdict.reason, 'rate_limited');
    assert.equal(verdict.suppressed, true);

    // 60s 之后必须放行，否则就是"过期限流"。
    const after = tracker.observe({ id: 'b3', cwd: CWD, source: 'ai', sessionId: 's3', at: BASE + 70_000 });
    assert.equal(after.accepted, true);
    assert.equal(after.heartbeat, true);
});

test('state 先 commit、journal 后 commit：中途崩掉重启不丢记录也不双计', async (t) => {
    const { store } = await makeStore(t);
    const key = projectKeyOf(CWD);

    // 一批观测：3 条记录（两个会话 + 行数证据）。
    const observations = [
        { id: 'c1', cwd: CWD, source: 'ai', sessionId: 's1', at: BASE },
        { id: 'c2', cwd: CWD, source: 'ai', sessionId: 's1', kind: 'file', file: 'src/a.js', linesAdded: 40, linesDeleted: 5, at: BASE + 20_000 },
        { id: 'c3', cwd: CWD, source: 'ai', sessionId: 's2', at: BASE + 80_000 },
        { id: 'c4', cwd: CWD, source: 'ai', sessionId: 's2', kind: 'file', file: 'src/b.js', linesAdded: 7, linesDeleted: 1, at: BASE + 90_000 },
    ];

    // 1) 正常路径：完整事务，记下基准。
    const clean = await commitBatch(store, key, observations);
    const cleanRecords = await store.readRecords();
    const cleanSummary = summarize(cleanRecords, { from: BASE, timezone: 'UTC' });
    const cleanState = await store.readProjectState(key, { raw: true });

    // 2) 模拟崩溃：新目录里 state 落盘成功，journal 只写进去一半。
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'dct-int-crash-'));
    const crashStore = new JsonlStore({ directory: dir2, profile: 'default', lockTimeoutMs: 2_000 });
    t.after(async () => {
        await crashStore.close().catch(() => {});
        await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});
    });
    await crashStore.init();

    const stateWritten = await crashStore.withProjectLock(key, async () => {
        const state = await crashStore.readProjectState(key, { raw: true });
        const tracker = trackerWith(crashStore, key, state, observations[0].at);
        observations.forEach((observation) => tracker.observe(observation));
        const exported = tracker.exportState();
        await crashStore.writeProjectState(key, exported, { throughRev: 99 });
        // 只追加前两条 = "append 中途崩溃"
        await crashStore.append(tracker.snapshot().records.slice(0, 2));
        await crashStore.flush();
        return exported;
    });
    assert.equal(stateWritten.projects[0].open.length, 2, 'state 里两个会话都在');

    // 3) 重启：读 state，重放剩余 records，再 append 一次（用 revision 保证幂等）。
    const restarted = new JsonlStore({ directory: dir2, profile: 'default', lockTimeoutMs: 2_000 });
    t.after(async () => { await restarted.close().catch(() => {}); });
    await restarted.init();
    const restoredState = await restarted.readProjectState(key, { raw: true });
    assert.deepEqual(restoredState, stateWritten, '重启后 state 完整');

    const tracker = new ActivityTracker({}, { now: () => BASE + 10_000, state: restoredState });
    await restarted.append(tracker.snapshot().records);
    await restarted.flush();

    const recovered = await restarted.readRecords();
    assert.deepEqual(
        recovered.map((record) => record.id).sort(),
        cleanRecords.map((record) => record.id).sort(),
        '记录 id 集合与一次成功写入完全一致',
    );
    const recoveredSummary = summarize(recovered, { from: BASE, timezone: 'UTC' });
    assert.equal(recoveredSummary.wallUnionMs, cleanSummary.wallUnionMs, '时长不双计');
    assert.equal(recoveredSummary.lines.added, cleanSummary.lines.added, '新增行数不双计');
    assert.equal(recoveredSummary.lines.deleted, cleanSummary.lines.deleted, '删除行数不双计');
    assert.equal(recoveredSummary.lines.added, 47);

    // 4) 再崩一次（重复 append 同一批）：仍不双计。
    await restarted.append(tracker.snapshot().records);
    const thrice = summarize(await restarted.readRecords(), { from: BASE, timezone: 'UTC' });
    assert.equal(thrice.lines.added, 47, '重放三次也不重复计数');
    assert.equal(thrice.wallUnionMs, recoveredSummary.wallUnionMs);
});

test('journal 保留 cwd/files/sessionId，正文与凭据永不落盘', async (t) => {
    const { store } = await makeStore(t);
    const key = projectKeyOf(CWD);
    await commitBatch(store, key, [
        { id: 'd1', cwd: CWD, source: 'ai', sessionId: 's1', at: BASE },
        { id: 'd2', cwd: CWD, source: 'ai', sessionId: 's1', kind: 'file', file: 'src/c.js', linesAdded: 3, linesDeleted: 0, at: BASE + 5_000 },
    ]);

    // 改动后的口径：cwd / sessionId / files / lineEntries 是允许且必要的本机
    // 活动元数据（冷启动要能恢复文件与会话），不再是"journal 不落"。
    const journalRecords = await store.readRecords();
    assert.ok(journalRecords.every((record) => record.cwd === CWD), 'journal 保留 cwd');
    assert.ok(journalRecords.every((record) => record.sessionId === 's1'), 'journal 保留 sessionId');
    const withFiles = journalRecords.find((record) => Array.isArray(record.files) && record.files.length > 0);
    assert.ok(withFiles, 'journal 保留文件明细');
    assert.equal(withFiles.files[0].path, 'src/c.js');
    assert.ok(Array.isArray(withFiles.lineEntries) && withFiles.lineEntries.length > 0, 'journal 保留按时刻的行数证据');

    // 正文/凭据类字段即使塞进来也不落盘（白名单之外整体丢弃）。
    await store.append({
        id: 'd3',
        startMs: BASE + 6_000,
        endMs: BASE + 7_000,
        project: 'demo',
        projectKey: key,
        cwd: CWD,
        messages: [{ role: 'user', content: 'secret prompt' }],
        token: 'sk-nope',
    });
    const shardFiles = (await fs.readdir(store.journalDir)).filter((name) => name.endsWith('.jsonl'));
    for (const name of shardFiles) {
        const raw = await fs.readFile(path.join(store.journalDir, name), 'utf8');
        assert.ok(!raw.includes('secret prompt'), '正文不落盘');
        assert.ok(!raw.includes('sk-nope'), '凭据不落盘');
    }

    // state 依然是展示名与累计的权威出口。
    const states = await store.listProjectStates({ includeState: true });
    assert.equal(states.length, 1);
    const project = states[0].state.projects[0];
    assert.equal(project.cwd, CWD);
    assert.ok(project.open.length >= 1);
});

test('首次观察的记录必须写进去（revision 从 0 起也不能被当成低版本跳过）', async (t) => {
    const { store } = await makeStore(t);
    const key = projectKeyOf(CWD);

    const tracker = new ActivityTracker({}, { now: () => BASE });
    const verdict = tracker.observe({ id: 'r0', cwd: CWD, source: 'ai', sessionId: 's1', at: BASE });
    assert.equal(verdict.accepted, true);
    const records = tracker.snapshot().records;
    assert.equal(records.length, 1);

    // 真实 tracker 的首条 open 记录 revision 是 1（open 时 0，吸收观测 +1）；
    // 但 store 必须同样接受 revision=0 的 canonical 记录 —— 那是 pending/证据投影
    // 以及"刚 open 就导出"的合法形态，不能被当成"低版本"跳过。
    assert.ok(Number.isInteger(records[0].revision) && records[0].revision >= 0);
    const first = await store.append(records);
    assert.equal(first.appended, 1, '首条记录必须落盘');
    assert.equal(first.skipped, 0);

    const zeroRev = {
        v: 1,
        kind: 'evidence',
        id: 'pending:r0',
        revision: 0,
        project: 'demo',
        projectKey: key,
        cwd: CWD,
        source: 'ai',
        sessionId: 's1',
        runId: '',
        startMs: BASE,
        endMs: BASE,
        durationMs: 0,
        heartbeats: 0,
        observations: 1,
        pending: true,
        closeReason: 'pending',
    };
    const zeroResult = await store.append(zeroRev);
    assert.equal(zeroResult.appended, 1, 'revision=0 的记录必须被接受');
    const storedZero = (await store.readRecords()).find((record) => record.id === 'pending:r0');
    assert.ok(storedZero, 'rev=0 的记录读得回来');
    assert.equal(storedZero.revision, 0);
    assert.equal(storedZero.rev, 0);

    // 重放同一条：幂等。
    const replay = await store.append(zeroRev);
    assert.equal(replay.skipped, 1);
    assert.equal(replay.appended, 0);

    // rev=0 的记录必须能在**重启后**从磁盘读回来（校验器不能要求 rev>0）。
    await store.flush();
    const reopened = new JsonlStore({ directory: store.directory, profile: 'default', lockTimeoutMs: 2_000 });
    t.after(async () => { await reopened.close().catch(() => {}); });
    await reopened.init();
    const reloaded = await reopened.readRecords();
    assert.ok(reloaded.some((record) => record.id === 'pending:r0' && record.rev === 0), 'rev=0 重启后仍在索引里');
    assert.ok(!reopened.warnings.some((warning) => warning.code === 'journal_line_invalid'), 'rev=0 不是坏行');

    // 取一个只含 rev=0 的窗口：零长度点也必须被 intersectsRange 收进来。
    const pointOnly = await reopened.readRecords({ from: BASE, to: BASE + 1 });
    assert.ok(pointOnly.some((record) => record.id === 'pending:r0'), '零长度点按点判断，不能漏');

    // revision 递增后覆盖。
    tracker.observe({ id: 'r1', cwd: CWD, source: 'ai', sessionId: 's1', at: BASE + 5_000 });
    const bumped = tracker.snapshot().records;
    assert.ok(bumped[0].revision > records[0].revision, '吸收后 revision 递增');
    await store.append(bumped);
    const after = (await store.readRecords()).find((record) => record.id === bumped[0].id);
    assert.equal(after.revision, bumped[0].revision);
    assert.equal(after.endMs, BASE + 5_000);
    await store.writeProjectState(key, tracker.exportState());
    assert.ok(await store.readProjectState(key));
});

test('readRecords 用半开区间相交：跨午夜的段不能因为起点在昨天而被丢', async (t) => {
    const { store } = await makeStore(t);
    // 23:50 开始，次日 00:30 结束（UTC 分片会落在前一天）。
    const startMs = Date.UTC(2026, 5, 1, 23, 50, 0);
    const endMs = Date.UTC(2026, 5, 2, 0, 30, 0);
    const dayStart = Date.UTC(2026, 5, 2, 0, 0, 0);
    const dayEnd = Date.UTC(2026, 5, 3, 0, 0, 0);
    // idleThreshold 拉到 1 小时，让两次观测落进同一个 interval 段。
    const config = { idleThresholdSeconds: 3600 };

    const tracker = new ActivityTracker(config, { now: () => startMs });
    tracker.observe({ id: 'midnight', cwd: CWD, source: 'ai', sessionId: 's1', at: startMs });
    tracker.observe({ id: 'midnight2', cwd: CWD, source: 'ai', sessionId: 's1', at: endMs });
    const records = tracker.snapshot().records;
    assert.equal(records.length, 1, '一次跨零点连续活动仍是一段');
    assert.equal(records[0].startMs, startMs);
    assert.equal(records[0].endMs, endMs);
    await store.append(records);

    // 只查 6/2 当天：旧的"按 startMs 闭区间"会返回 0 条。
    const clipped = await store.readRecords({ from: dayStart, to: dayEnd });
    assert.equal(clipped.length, 1, '跨零点的段必须被返回（相交语义）');
    assert.equal(clipped[0].startMs, startMs);

    // summarize 自己做裁切，只算落在 6/2 的那 30 分钟。
    const summary = summarize(clipped, { from: dayStart, to: dayEnd, timezone: 'UTC' });
    assert.equal(summary.wallUnionMs, 30 * 60_000, '裁切到区间内，不含区间外的 10 分钟');

    // 完全在区间之后的段不返回；完全在之前结束的段也不返回。
    assert.equal((await store.readRecords({ from: dayEnd, to: dayEnd + HOUR })).length, 0);
    assert.equal((await store.readRecords({ from: startMs - HOUR, to: startMs })).length, 0);
    await assert.rejects(() => store.readRecords({ from: dayEnd, to: dayStart }), (error) => error.code === 'E_OPTIONS_INVALID');
});

test('readRecords 能看到另一个实例（另一个"进程"）刚追加的记录', async (t) => {
    const { store: writer } = await makeStore(t);
    const reader = new JsonlStore({ directory: writer.directory, profile: 'default', lockTimeoutMs: 2_000 });
    t.after(async () => { await reader.close().catch(() => {}); });
    await reader.init();

    assert.deepEqual(await reader.readRecords(), [], '初始为空');

    // writer 追加，reader 从未被通知。
    await writer.append({ id: 'from-writer', startMs: BASE, endMs: BASE + 1_000, project: 'demo', projectKey: 'k', cwd: CWD });
    await writer.flush();

    const seen = await reader.readRecords();
    assert.deepEqual(seen.map((record) => record.id), ['from-writer'], '增量 stat 必须刷新外部追加');

    // 再追加一批（同一 shard 增长），仍要看见，且不重复。
    await writer.append({ id: 'second', startMs: BASE + 2_000, endMs: BASE + 3_000, project: 'demo', projectKey: 'k', cwd: CWD });
    await writer.flush();
    const seen2 = await reader.readRecords();
    assert.deepEqual(seen2.map((record) => record.id).sort(), ['from-writer', 'second'], '不重复也不漏');

    // reader 自己追加后仍然一致（同一游标复用）。
    await reader.append({ id: 'from-reader', startMs: BASE + 4_000, endMs: BASE + 5_000, project: 'demo', projectKey: 'k', cwd: CWD });
    const seen3 = await reader.readRecords();
    assert.deepEqual(seen3.map((record) => record.id).sort(), ['from-reader', 'from-writer', 'second']);
});

test('跨进程：两个进程写不同项目到同一个 UTC 日 shard，并发不丢行不被截', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dct-int-mp-'));
    const script = path.join(directory, 'writer.mjs');
    t.after(async () => { await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); });

    // 每个子进程：自己在项目锁里写自己的项目，append 同一批共享日记录，多轮。
    await fs.writeFile(script, `
import { JsonlStore } from ${JSON.stringify(STORE_URL)};
const [directory, tag, roundsRaw, batchRaw, baseRaw] = process.argv.slice(2);
const rounds = Number(roundsRaw); const batchSize = Number(batchRaw); const base = Number(baseRaw);
const store = new JsonlStore({ directory, profile: 'default', lockTimeoutMs: 20000 });
await store.init();
for (let round = 0; round < rounds; round += 1) {
    const projectKey = 'proj-' + tag;
    await store.withProjectLock(projectKey, async () => {
        const batch = [];
        for (let i = 0; i < batchSize; i += 1) {
            const idx = round * batchSize + i;
            batch.push({
                v: 1, id: tag + ':' + idx, kind: 'ai-interval', revision: 1,
                cwd: 'E:\\\\proj\\\\' + tag, project: 'p-' + tag, projectKey,
                startMs: base + idx * 10, endMs: base + idx * 10 + 5,
            });
        }
        await store.append(batch);
    });
    await store.flush();
}
await store.close();
`, 'utf8');

    const ROUNDS = 6;
    const BATCH = 12; // 限制批量大小，保持测试快
    const base = Date.UTC(2026, 7, 1, 12, 0, 0);
    const tags = ['alpha', 'beta', 'gamma'];
    const children = tags.map((tag) => spawn(
        process.execPath,
        [script, directory, tag, String(ROUNDS), String(BATCH), String(base)],
        { stdio: ['ignore', 'pipe', 'pipe'] },
    ));
    t.after(() => { for (const child of children) child.kill('SIGKILL'); });

    let stderr = '';
    for (const child of children) child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const codes = await Promise.all(children.map((child) => new Promise((resolve) => {
        child.on('exit', (code) => resolve(code));
    })));
    assert.deepEqual(codes, [0, 0, 0], `三个子进程都应正常退出：${stderr}`);

    const reader = new JsonlStore({ directory, profile: 'default', lockTimeoutMs: 5_000 });
    t.after(async () => { await reader.close().catch(() => {}); });
    await reader.init();

    const records = await reader.readRecords();
    const expected = tags.length * ROUNDS * BATCH;
    assert.equal(records.length, expected, `一条都不能丢（期望 ${expected}）`);

    for (const tag of tags) {
        const ids = records.filter((record) => record.id.startsWith(`${tag}:`));
        assert.equal(ids.length, ROUNDS * BATCH, `${tag} 的记录完整`);
        const indexes = new Set(ids.map((record) => Number(record.id.split(':')[1])));
        for (let i = 0; i < ROUNDS * BATCH; i += 1) assert.ok(indexes.has(i), `${tag} 缺 ${i}`);
    }

    // 共享 shard 只有一个，且没有残行：每行都是合法 JSON、文件以换行结尾。
    const shards = (await fs.readdir(reader.journalDir)).filter((name) => name.endsWith('.jsonl'));
    assert.equal(shards.length, 1, '同一天只有一个 shard');
    const raw = await fs.readFile(path.join(reader.journalDir, shards[0]), 'utf8');
    assert.ok(raw.endsWith('\n'), '并发写不能留下残尾');
    for (const line of raw.split('\n').filter(Boolean)) JSON.parse(line); // 任何半行都会抛
    assert.equal(reader.warnings.filter((warning) => warning.code === 'journal_tail_truncated').length, 0, '并发下不应有截断发生');
    assert.equal(reader.warnings.filter((warning) => warning.code === 'journal_line_invalid').length, 0, '并发下不应有坏行');
});

test('跨进程：一边持续写入，一边 init 修复，两边数据都不受损', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dct-int-race-'));
    const script = path.join(directory, 'writer.mjs');
    t.after(async () => { await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); });

    const base = Date.UTC(2026, 7, 2, 12, 0, 0);
    await fs.writeFile(script, `
import { JsonlStore } from ${JSON.stringify(STORE_URL)};
const [directory, roundsRaw, batchRaw, baseRaw] = process.argv.slice(2);
const rounds = Number(roundsRaw); const batch = Number(batchRaw); const base = Number(baseRaw);
const store = new JsonlStore({ directory, profile: 'default', lockTimeoutMs: 20000 });
await store.init();
for (let round = 0; round < rounds; round += 1) {
    const records = [];
    for (let i = 0; i < batch; i += 1) {
        const idx = round * batch + i;
        records.push({ v: 1, id: 'w:' + idx, kind: 'ai-interval', revision: 1, project: 'p', projectKey: 'k', cwd: 'E:\\\\\\\\p', startMs: base + idx * 10, endMs: base + idx * 10 + 5 });
    }
    await store.append(records);
    await store.flush();
}
await store.close();
`, 'utf8');

    const ROUNDS = 8;
    const BATCH = 10;
    const child = spawn(process.execPath, [script, directory, String(ROUNDS), String(BATCH), String(base)], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { child.kill('SIGKILL'); });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const exited = new Promise((resolve) => { child.on('exit', (code) => resolve(code)); });

    // 在子进程持续写入期间，反复打开新实例（每个都会跑 init 的尾修复）。
    for (let i = 0; i < 6; i += 1) {
        const probe = new JsonlStore({ directory, profile: 'default', lockTimeoutMs: 20_000 });
        await probe.init();
        await probe.readRecords();
        await probe.close();
        await new Promise((resolve) => { setTimeout(resolve, 40); });
    }

    const code = await exited;
    assert.equal(code, 0, `写入进程应正常退出：${stderr}`);

    const reader = new JsonlStore({ directory, profile: 'default', lockTimeoutMs: 20_000 });
    t.after(async () => { await reader.close().catch(() => {}); });
    await reader.init();
    const records = await reader.readRecords();
    assert.equal(records.length, ROUNDS * BATCH, '修复与写入互斥后一条都不能少');
    assert.equal(reader.warnings.filter((warning) => warning.code === 'journal_tail_truncated').length, 0, '正在写的半条不能被旁人当坏尾截掉');

    const shards = (await fs.readdir(reader.journalDir)).filter((name) => name.endsWith('.jsonl'));
    for (const name of shards) {
        const raw = await fs.readFile(path.join(reader.journalDir, name), 'utf8');
        assert.ok(raw.endsWith('\n'));
        for (const line of raw.split('\n').filter(Boolean)) JSON.parse(line);
    }
});

test('多项目隔离：两个 cwd 各自一把锁、各自 state、互不影响', async (t) => {
    const { store } = await makeStore(t);
    const keyA = projectKeyOf(CWD);
    const keyB = projectKeyOf(OTHER_CWD);
    assert.notEqual(keyA, keyB);

    await commitBatch(store, keyA, [{ id: 'p1', cwd: CWD, source: 'ai', sessionId: 's1', at: BASE }]);
    await commitBatch(store, keyB, [{ id: 'p2', cwd: OTHER_CWD, source: 'ai', sessionId: 's9', at: BASE }]);

    const a = await store.readProjectState(keyA, { raw: true });
    const b = await store.readProjectState(keyB, { raw: true });
    assert.equal(a.projects.length, 1);
    assert.equal(a.projects[0].cwd, CWD);
    assert.equal(b.projects[0].cwd, OTHER_CWD);
    assert.equal(a.projects[0].key !== b.projects[0].key, true);

    // 两个项目在同 60s 内各自放行（项目级 gate 只约束同一个项目）。
    assert.equal(a.projects[0].heartbeats, 1);
    assert.equal(b.projects[0].heartbeats, 1);
    assert.equal(a.projects[0].suppressed, 0);
    assert.equal(b.projects[0].suppressed, 0);

    const recordsA = await store.readRecords({ projectKey: keyA });
    const recordsB = await store.readRecords({ projectKey: keyB });
    assert.equal(recordsA.length, 1);
    assert.equal(recordsB.length, 1);
    assert.notEqual(recordsA[0].id, recordsB[0].id);
});

test('锁内事务失败：state 不被写坏，下一个事务读到的是上一版', async (t) => {
    const { store } = await makeStore(t);
    const key = projectKeyOf(CWD);
    await commitBatch(store, key, [{ id: 'x1', cwd: CWD, source: 'ai', sessionId: 's1', at: BASE }]);
    const before = await store.readProjectState(key);

    await assert.rejects(
        () => store.withProjectLock(key, async () => {
            const state = await store.readProjectState(key, { raw: true });
            const tracker = new ActivityTracker({}, { now: () => BASE + 10_000, state });
            tracker.observe({ id: 'x2', cwd: CWD, source: 'ai', sessionId: 's2', at: BASE + 10_000 });
            await store.writeProjectState(key, tracker.exportState());
            throw new Error('事务中途失败');
        }),
        /事务中途失败/,
    );

    const after = await store.readProjectState(key);
    assert.equal(after.revision, before.revision + 1, 'state 已落盘（写成功后才抛错，属于调用方语义）');
    assert.equal(await store.withProjectLock(key, async () => 'ok'), 'ok', '锁已释放');
    await store.close();
});
