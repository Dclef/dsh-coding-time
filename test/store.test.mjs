/**
 * dsh-coding-time · 存储层测试（node:test，零依赖）。
 *
 * 覆盖派单要求的关键面：同 id 版本覆盖、并发/跨进程锁、尾损恢复、目录权限、
 * profile 逃逸、flush/close 幂等、rename 失败可读旧快照，以及"journal 只落
 * 白名单元数据"和"坏行只告警不编数字"。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { JsonlStore, StoreError, projectKeyHash } from '../lib/store.js';

const STORE_URL = pathToFileURL(path.resolve(import.meta.dirname, '../lib/store.js')).href;
const canCheckModes = process.platform !== 'win32';

/** 新建临时存储目录，并在测试结束时清理。 */
async function makeStore(t, overrides = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dct-store-'));
    const store = new JsonlStore({ directory, profile: 'default', lockTimeoutMs: 500, ...overrides });
    t.after(async () => {
        await store.close().catch(() => {});
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    });
    await store.init();
    return { store, directory };
}

/** 造一条最小可写的记录。 */
function rec(id, startMs, extra = {}) {
    return { id, startMs, endMs: startMs + 1000, linesAdded: 3, project: 'demo', projectKey: 'k', ...extra };
}

/** 等条件成立（跨进程用），超时抛错。 */
async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await predicate()) return;
        if (Date.now() >= deadline) throw new Error('waitFor 超时');
        await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
    }
}

test('同 id 按 revision upsert：低版本忽略、高版本覆盖，重开也保持', async (t) => {
    const { store, directory } = await makeStore(t);

    await store.append(rec('a', 1_000));
    await store.append({ id: 'a', startMs: 1_000, endMs: 9_000, linesAdded: 7, project: 'demo' });
    let records = await store.readRecords();
    assert.equal(records.length, 1, '同 id 只留一条');
    assert.equal(records[0].endMs, 9_000, '后写覆盖先写');
    assert.equal(records[0].linesAdded, 7);
    assert.equal(records[0].rev, 2, '缺省 rev 递增');

    const skipped = await store.append({ id: 'a', startMs: 1_000, endMs: 1_500, rev: 1 });
    assert.equal(skipped.skipped, 1, '低 rev 幂等跳过');
    assert.equal(skipped.appended, 0);

    await store.append({ id: 'a', startMs: 1_000, endMs: 12_000, rev: 5 });
    await store.close();

    const reopened = new JsonlStore({ directory, profile: 'default', lockTimeoutMs: 500 });
    t.after(async () => { await reopened.close().catch(() => {}); });
    await reopened.init();
    records = await reopened.readRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].rev, 5);
    assert.equal(records[0].endMs, 12_000);

    const again = await reopened.append({ id: 'a', startMs: 1_000, rev: 5 });
    assert.equal(again.skipped, 1, '相同 rev 不重复写');
});

test('append 拒绝非法记录且不落半行；journal 保留活动元数据、丢弃正文/凭据', async (t) => {
    const { store } = await makeStore(t);

    await assert.rejects(() => store.append({ startMs: 1 }), (error) => error instanceof StoreError && error.code === 'E_INVALID_RECORD');
    await assert.rejects(() => store.append({ id: 'x', startMs: -5 }), (error) => error.code === 'E_INVALID_RECORD');
    assert.deepEqual(await store.readRecords(), [], '失败不留下半条记录');

    const result = await store.append({
        id: 'b',
        startMs: 2_000,
        endMs: 3_000,
        project: 'demo',
        projectKey: 'k',
        cwd: 'E:\\secret\\project',
        sessionId: 'sess-1',
        runId: 'run-1',
        files: [{ path: 'a.js', touches: 2, linesAdded: 4, linesDeleted: 1 }],
        lineEntries: [{ at: 2_500, file: 'a.js', added: 4, deleted: 1 }],
        linesPartial: false,
        content: 'const a = 1',
        token: 'sk-should-not-be-persisted',
        nested: { messages: [{ role: 'user', content: 'hi' }], keep: 1 },
    });
    assert.equal(result.appended, 1);
    assert.ok(result.warnings.some((warning) => warning.code === 'record_field_forbidden_dropped'));

    const [record] = await store.readRecords();
    // 允许：本机活动元数据（Host 冷启动靠它恢复文件与会话）。
    assert.equal(record.cwd, 'E:\\secret\\project', 'cwd 属允许元数据');
    assert.equal(record.sessionId, 'sess-1');
    assert.equal(record.runId, 'run-1');
    assert.deepEqual(record.files, [{ path: 'a.js', touches: 2, linesAdded: 4, linesDeleted: 1 }]);
    assert.deepEqual(record.lineEntries, [{ at: 2_500, file: 'a.js', added: 4, deleted: 1 }]);
    assert.equal(record.linesPartial, false);
    // 禁止：正文与凭据，即使藏在嵌套对象里也不落盘。
    assert.equal(record.content, undefined);
    assert.equal(record.token, undefined);
    assert.equal(record.messages, undefined);
    assert.equal(record.nested, undefined, '白名单外字段整体丢弃，不做深拷贝');
    assert.equal(record.project, 'demo', '白名单内字段保留');

    const shard = path.join(store.journalDir, `${new Date(2_000).toISOString().slice(0, 10)}.jsonl`);
    const raw = await fs.readFile(shard, 'utf8');
    assert.ok(raw.endsWith('\n'), '行尾必须有换行');
    assert.ok(!raw.includes('sk-should-not-be-persisted'), '凭据不落盘');
    assert.ok(!raw.includes('const a = 1'), '正文不落盘');
    assert.ok(!raw.includes('"role":"user"'), '嵌套正文不落盘');
    assert.equal(raw.trim().split('\n').length, 1);
});

test('采集层短名字段（start/end/ms/revision/added/deleted）可直接落库', async (t) => {
    const { store } = await makeStore(t);
    const start = Date.UTC(2026, 2, 4, 10, 0, 0);
    const result = await store.append([
        { v: 1, id: 'ai:s1:1000:2000', kind: 'ai-interval', sessionId: 's1', project: 'p', start, end: start + 60_000, ms: 60_000, revision: 1, at: start + 60_000 },
        { v: 1, id: 'lines:s1:c1', kind: 'line-delta', sessionId: 's1', project: 'p', callId: 'c1', added: 12, deleted: 3, revision: 1, at: start + 5_000 },
    ]);
    assert.equal(result.appended, 2);

    const [interval, lines] = await store.readRecords();
    assert.equal(interval.kind, 'ai-interval');
    assert.equal(interval.startMs, start);
    assert.equal(interval.endMs, start + 60_000);
    assert.equal(interval.durationMs, 60_000);
    assert.equal(interval.project, 'p');
    assert.equal(lines.kind, 'line-delta');
    assert.equal(lines.startMs, start + 5_000, '无 start 时用 at 兜底');
    assert.equal(lines.linesAdded, 12);
    assert.equal(lines.linesDeleted, 3);

    // 采集层用 revision 而不是 rev：数值相同即视为同一版本，重放必须幂等。
    const replay = await store.append({ v: 1, id: 'lines:s1:c1', kind: 'line-delta', project: 'p', added: 12, deleted: 3, revision: 1, at: start + 5_000 });
    assert.equal(replay.skipped, 1, 'revision=1 重放不重复计数');
});

test('未 init / 已 close 的方法边界', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dct-store-'));
    const store = new JsonlStore({ directory, profile: 'default' });
    t.after(async () => { await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); });

    await assert.rejects(() => store.append(rec('a', 1)), (error) => error.code === 'E_NOT_INITIALIZED');
    await assert.rejects(() => store.readRecords(), (error) => error.code === 'E_NOT_INITIALIZED');
    await assert.rejects(() => store.withProjectLock('p', async () => {}), (error) => error.code === 'E_NOT_INITIALIZED');

    await store.init();
    await store.close();
    await assert.rejects(() => store.readRecords(), (error) => error.code === 'E_CLOSED');
    await assert.rejects(() => store.init(), (error) => error.code === 'E_CLOSED');
});

test('flush 与 close 幂等', async (t) => {
    const { store } = await makeStore(t);
    await store.append(rec('a', 1_000));

    const first = await store.flush();
    assert.ok(first.flushed >= 1);
    const second = await store.flush();
    assert.equal(second.flushed, 0, '第二次 flush 无事可做');

    const closedOnce = await store.close();
    assert.equal(closedOnce.closed, true);
    const afterClose = await store.flush();
    assert.equal(afterClose.flushed, 0, '关闭后 flush 不抛');
    assert.ok(afterClose.warnings.some((warning) => warning.code === 'flush_after_close'));
    const closedTwice = await store.close();
    assert.equal(closedTwice.closed, true);
});

test('profile 路径逃逸一律拒绝', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dct-store-'));
    t.after(async () => { await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); });

    for (const profile of ['../evil', '..\\evil', 'a/b', 'a\\b', '.hidden', '..', 'a..b', '', '  ']) {
        assert.throws(
            () => new JsonlStore({ directory, profile }),
            (error) => error instanceof StoreError && error.code === 'E_PROFILE_INVALID',
            `应拒绝 profile=${JSON.stringify(profile)}`,
        );
    }
    const ok = new JsonlStore({ directory, profile: 'work-2026_ok.1' });
    assert.equal(ok.profile, 'work-2026_ok.1');
    assert.ok(ok.storageDirectory.startsWith(directory));
});

test('目录 0700 / 文件 0600（不支持的平台跳过）', async (t) => {
    if (!canCheckModes) {
        t.skip('Windows 不支持 POSIX 权限位');
        return;
    }
    const { store } = await makeStore(t);
    await store.writeProjectState('proj', { totalMs: 1 });
    await store.append(rec('a', 1_000));
    await store.withProjectLock('proj', async () => {
        const lockFile = path.join(store.locksDir, `${projectKeyHash('proj')}.lock`);
        assert.equal((await fs.stat(lockFile)).mode & 0o777, 0o600, '锁文件 0600');
    });

    for (const dir of [store.storageDirectory, store.projectsDir, store.journalDir, store.locksDir]) {
        assert.equal((await fs.stat(dir)).mode & 0o777, 0o700, `${dir} 应为 0700`);
    }
    const files = await fs.readdir(store.projectsDir);
    assert.equal(files.length, 1);
    assert.equal((await fs.stat(path.join(store.projectsDir, files[0]))).mode & 0o777, 0o600);
    for (const shard of await fs.readdir(store.journalDir)) {
        if (!shard.endsWith('.jsonl')) continue;
        assert.equal((await fs.stat(path.join(store.journalDir, shard))).mode & 0o777, 0o600);
    }
});

test('journal 截断尾：保留前面有效记录，隔离残片，新行绝不接坏尾', async (t) => {
    const { store } = await makeStore(t);
    await store.append([rec('a', 1_000), rec('b', 2_000)]);
    await store.close();

    const shard = path.join(store.journalDir, `${new Date(1_000).toISOString().slice(0, 10)}.jsonl`);
    const before = await fs.readFile(shard, 'utf8');
    await fs.appendFile(shard, '{"v":1,"id":"c","rev":1,"startMs":3000', 'utf8');

    const reopened = new JsonlStore({ directory: store.directory, profile: 'default', lockTimeoutMs: 500 });
    t.after(async () => { await reopened.close().catch(() => {}); });
    const status = await reopened.init();
    assert.ok(status.warnings.some((warning) => warning.code === 'journal_tail_truncated'));

    const records = await reopened.readRecords();
    assert.deepEqual(records.map((record) => record.id).sort(), ['a', 'b'], '有效记录全保留');
    const afterRepair = await fs.readFile(shard, 'utf8');
    assert.equal(afterRepair, before, '残片被截掉后回到原样');
    const corrupt = await fs.readdir(reopened.corruptDir);
    assert.equal(corrupt.length, 1, '残片被隔离到 corrupt/');

    await reopened.append(rec('d', 4_000));
    const text = await fs.readFile(shard, 'utf8');
    assert.ok(text.endsWith('\n'));
    assert.ok(!text.includes('"startMs":3000{"'), '新行没有粘在坏尾上');
    assert.equal((await reopened.readRecords()).length, 3);
});

test('journal 尾行完整但缺换行：补换行且记录不丢', async (t) => {
    const { store } = await makeStore(t);
    await store.append(rec('a', 1_000));
    await store.close();

    const shard = path.join(store.journalDir, `${new Date(1_000).toISOString().slice(0, 10)}.jsonl`);
    const text = (await fs.readFile(shard, 'utf8')).trimEnd();
    await fs.writeFile(shard, text, 'utf8');

    const reopened = new JsonlStore({ directory: store.directory, profile: 'default', lockTimeoutMs: 500 });
    t.after(async () => { await reopened.close().catch(() => {}); });
    const status = await reopened.init();
    assert.ok(status.warnings.some((warning) => warning.code === 'journal_tail_newline_added'));
    assert.equal((await reopened.readRecords()).length, 1, '完整行必须保留');
    assert.ok((await fs.readFile(shard, 'utf8')).endsWith('\n'));
});

test('坏中间行显式告警并跳过，不推断数字', async (t) => {
    const { store } = await makeStore(t);
    await store.append([rec('a', 1_000), rec('b', 2_000)]);
    await store.close();

    const shard = path.join(store.journalDir, `${new Date(1_000).toISOString().slice(0, 10)}.jsonl`);
    const lines = (await fs.readFile(shard, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    await fs.writeFile(shard, `${lines[0]}\n{not json}\n${lines[1]}\n`, 'utf8');

    const reopened = new JsonlStore({ directory: store.directory, profile: 'default', lockTimeoutMs: 500 });
    t.after(async () => { await reopened.close().catch(() => {}); });
    await reopened.init();
    const records = await reopened.readRecords();
    assert.deepEqual(records.map((record) => record.id).sort(), ['a', 'b']);
    assert.ok(reopened.warnings.some((warning) => warning.code === 'journal_line_invalid'), '坏行必须显式告警');
    assert.ok(records.every((record) => record.linesAdded === 3), '没有任何"猜出来的"数字');
});

test('按 UTC 日分片 + readRecords 时间/项目过滤 + limit', async (t) => {
    const { store } = await makeStore(t);
    const day1 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const day2 = Date.UTC(2026, 0, 2, 12, 0, 0);
    await store.append([
        rec('a', day1, { project: 'p1' }),
        rec('b', day2, { project: 'p2' }),
        rec('c', day2 + 1_000, { project: 'p1' }),
    ]);
    const shards = (await fs.readdir(store.journalDir)).filter((name) => name.endsWith('.jsonl')).sort();
    assert.deepEqual(shards, ['2026-01-01.jsonl', '2026-01-02.jsonl']);

    assert.equal((await store.readRecords({ from: day2, to: day2 + 5_000 })).length, 2);
    assert.deepEqual(
        (await store.readRecords({ project: 'p1' })).map((record) => record.id).sort(),
        ['a', 'c'],
    );
    assert.equal((await store.readRecords({ shard: '2026-01-01' })).length, 1);
    assert.deepEqual((await store.readRecords({ limit: 1 })).map((record) => record.id), ['a']);
    await assert.rejects(() => store.readRecords({ from: 'nope' }), (error) => error.code === 'E_OPTIONS_INVALID');
});

test('writeProjectState 原子覆盖、throughRev 往返、expectedRevision 冲突', async (t) => {
    const { store } = await makeStore(t);
    assert.equal(await store.readProjectState('proj'), null);

    const first = await store.writeProjectState('proj', { totalMs: 1_000, projects: { p1: 1_000 } }, { throughRev: 3 });
    assert.equal(first.revision, 1);
    const read = await store.readProjectState('proj');
    assert.equal(read.revision, 1);
    assert.equal(read.throughRev, 3);
    assert.equal(read.state.totalMs, 1_000);
    assert.equal(read.projectIdHash, projectKeyHash('proj'));

    const raw = await store.readProjectState('proj', { raw: true });
    assert.deepEqual(raw.projects, { p1: 1_000 }, 'raw 只返回 state 本体');

    const second = await store.writeProjectState('proj', { totalMs: 2_000 }, { expectedRevision: 1 });
    assert.equal(second.revision, 2);

    await assert.rejects(
        () => store.writeProjectState('proj', { totalMs: 3_000 }, { expectedRevision: 1 }),
        (error) => error.code === 'E_REVISION_CONFLICT',
    );
    assert.equal((await store.readProjectState('proj')).state.totalMs, 2_000, '冲突不覆盖');

    await assert.rejects(
        () => store.writeProjectState('proj', { bad: Number.NaN }),
        (error) => error.code === 'E_STATE_INVALID',
    );
});

test('project state 里正文/凭据类字段被丢弃并告警', async (t) => {
    const { store } = await makeStore(t);
    await store.writeProjectState('proj', {
        totalMs: 5,
        project: 'demo',
        cwd: 'E:\\demo',
        token: 'sk-secret',
        content: 'very secret body',
        nested: { messages: [{ role: 'user' }], keep: 1 },
    });
    const raw = await store.readProjectState('proj', { raw: true });
    assert.equal(raw.totalMs, 5);
    assert.equal(raw.project, 'demo');
    assert.equal(raw.cwd, 'E:\\demo', '展示名仍可落快照');
    assert.equal(raw.token, undefined);
    assert.equal(raw.content, undefined);
    assert.deepEqual(raw.nested, { keep: 1 });
    assert.ok(store.warnings.some((warning) => warning.code === 'state_field_forbidden_dropped'));
});

test('rename 失败时旧 snapshot 仍可读，新内容不半截', async (t) => {
    const { store, directory } = await makeStore(t);
    await store.writeProjectState('proj', { totalMs: 111 });
    const before = await store.readProjectState('proj');

    const realFs = fs;
    const failingFs = Object.assign(Object.create(null), realFs, {
        rename: async () => {
            const error = new Error('rename boom');
            error.code = 'EIO';
            throw error;
        },
    });
    const broken = new JsonlStore({ directory, profile: 'default', lockTimeoutMs: 500, fs: failingFs });
    t.after(async () => { await broken.close().catch(() => {}); });
    await broken.init();

    await assert.rejects(
        () => broken.writeProjectState('proj', { totalMs: 222 }),
        (error) => error.code === 'E_WRITE_FAILED',
    );
    const after = await broken.readProjectState('proj');
    assert.equal(after.revision, before.revision, 'revision 未推进');
    assert.equal(after.state.totalMs, 111, '旧快照仍完整可读');
    const leftovers = (await fs.readdir(broken.projectsDir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], '临时文件被清理');
});

test('listProjectStates 枚举快照，坏文件跳过不抛', async (t) => {
    const { store } = await makeStore(t);
    assert.deepEqual(await store.listProjectStates(), []);

    await store.writeProjectState('proj-a', { project: 'A', totalMs: 10 }, { throughRev: 2 });
    await store.writeProjectState('proj-b', { project: 'B', totalMs: 20 });
    await fs.writeFile(path.join(store.projectsDir, 'deadbeef.json'), '{oops', 'utf8');

    const withoutState = await store.listProjectStates();
    const hashes = withoutState.map((entry) => entry.projectIdHash).sort();
    assert.deepEqual(hashes, [projectKeyHash('proj-a'), projectKeyHash('proj-b')].sort());
    assert.ok(withoutState.every((entry) => entry.state === undefined));
    assert.ok(store.warnings.some((warning) => warning.code === 'state_corrupt'));

    const withState = await store.listProjectStates({ includeState: true });
    const a = withState.find((entry) => entry.projectIdHash === projectKeyHash('proj-a'));
    assert.equal(a.state.project, 'A');
    assert.equal(a.throughRev, 2);
    assert.equal(a.revision, 1);
});

test('pruneJournal 只删整份旧 shard', async (t) => {
    const { store } = await makeStore(t);
    const day1 = Date.UTC(2026, 0, 1, 12);
    const day3 = Date.UTC(2026, 0, 3, 12);
    await store.append([rec('a', day1), rec('b', day3)]);
    const pruned = await store.pruneJournal({ before: '2026-01-02' });
    assert.deepEqual(pruned.removed, ['2026-01-01']);
    assert.deepEqual((await store.readRecords()).map((record) => record.id), ['b']);
    await assert.rejects(() => store.pruneJournal({ before: '2026/01/02' }), (error) => error.code === 'E_OPTIONS_INVALID');
});

test('同一实例并发（非嵌套）调用排队通过，不死锁不误判重入', async (t) => {
    const { store } = await makeStore(t, 'default', { lockTimeoutMs: 3_000 });

    const order = [];
    const run = (label, holdMs) => store.withProjectLock('proj', async () => {
        order.push(`start:${label}`);
        await new Promise((resolve) => { setTimeout(resolve, holdMs); });
        order.push(`end:${label}`);
        return label;
    });

    // 三批并发提交（Host 会这样用）：必须全部成功，且彼此串行。
    const results = await Promise.all([run('a', 40), run('b', 10), run('c', 5)]);
    assert.deepEqual(results.sort(), ['a', 'b', 'c']);
    assert.equal(order.length, 6, '每批都完整进出');
    for (let i = 0; i < order.length; i += 2) {
        assert.equal(order[i].replace('start:', ''), order[i + 1].replace('end:', ''), '同一批的 start/end 必须相邻，说明真的串行');
    }
    assert.deepEqual(await fs.readdir(store.locksDir), [], '全部释放');
});

test('两个 store 实例互斥：活锁不偷、超时报错，释放后可再取', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dct-store-'));
    const a = new JsonlStore({ directory, profile: 'default', lockTimeoutMs: 300 });
    const b = new JsonlStore({ directory, profile: 'default', lockTimeoutMs: 300 });
    t.after(async () => {
        await a.close().catch(() => {});
        await b.close().catch(() => {});
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    });
    await a.init();
    await b.init();

    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const inside = a.withProjectLock('proj', async () => {
        await held;
        return 'a-done';
    });

    const lockFile = path.join(a.locksDir, `${projectKeyHash('proj')}.lock`);
    await waitFor(async () => {
        try {
            await fs.stat(lockFile);
            return true;
        }
        catch {
            return false;
        }
    });

    try {
        // 另一个 store 实例：只能等到超时，绝不能偷锁。
        await assert.rejects(
            () => b.withProjectLock('proj', async () => 'b-done'),
            (error) => error.code === 'E_LOCK_TIMEOUT',
        );
        assert.ok(await fs.stat(lockFile).then(() => true, () => false), '超时不得删除活锁');

        // 真嵌套（在锁回调内部再要同一把锁）立刻报 E_LOCK_REENTRANT，不死等。
        let nestedError = null;
        await a.withProjectLock('proj2', async () => {
            try {
                await a.withProjectLock('proj2', async () => 'nested');
            }
            catch (error) {
                nestedError = error;
            }
        });
        assert.equal(nestedError?.code, 'E_LOCK_REENTRANT', '锁内重入必须立刻拒绝');
    }
    finally {
        release();
    }

    assert.equal(await inside, 'a-done');
    assert.equal(await b.withProjectLock('proj', async () => 'b-done'), 'b-done', '释放后另一个实例能拿到');
    await waitFor(async () => {
        try {
            await fs.stat(lockFile);
            return false;
        }
        catch {
            return true;
        }
    });
    assert.deepEqual(await fs.readdir(a.locksDir), [], '锁文件已释放');
});

test('只有有证据的死者锁才被回收；不可读锁一律不偷', async (t) => {
    const { store } = await makeStore(t);
    const hash = projectKeyHash('proj');
    const lockFile = path.join(store.locksDir, `${hash}.lock`);

    await fs.writeFile(lockFile, `${JSON.stringify({
        v: 1, owner: 'dead-owner', pid: 4_194_303, host: os.hostname(), createdAt: new Date().toISOString(), key: hash,
    })}\n`, 'utf8');
    assert.equal(await store.withProjectLock('proj', async () => 'ok'), 'ok', '死 pid 的锁被回收');
    assert.ok(store.warnings.some((warning) => warning.code === 'lock_reclaimed_dead'));

    // 0 字节锁：证明不了活着，也证明不了死了 —— 即使放得很老也不许偷。
    await fs.writeFile(lockFile, '', 'utf8');
    const old = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(lockFile, old, old);
    await assert.rejects(
        () => store.withProjectLock('proj', async () => 'never', { timeoutMs: 150 }),
        (error) => error.code === 'E_LOCK_TIMEOUT',
        '没有 owner 证据就不能回收，哪怕它很老',
    );
    assert.ok(
        store.warnings.some((warning) => warning.code === 'lock_unreadable_needs_recovery'),
        '必须显式告警"需人工恢复"',
    );
    assert.equal(await fs.stat(lockFile).then(() => true, () => false), true, '锁文件必须原样保留');

    // 同主机但 pid 探活为 EPERM：视为活着，不偷。
    await fs.writeFile(lockFile, `${JSON.stringify({
        v: 1, owner: 'eperm-owner', pid: 4, host: os.hostname(), createdAt: new Date().toISOString(), key: hash,
    })}\n`, 'utf8');
    await assert.rejects(
        () => store.withProjectLock('proj', async () => 'never', { timeoutMs: 150 }),
        (error) => error.code === 'E_LOCK_TIMEOUT',
    );

    await fs.unlink(lockFile).catch(() => {});
});

test('跨进程：子进程持锁期间父进程拿不到，且能看到子进程写入的记录', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dct-store-'));
    const marker = path.join(directory, 'held.marker');
    const script = path.join(directory, 'child.mjs');
    t.after(async () => { await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); });

    await fs.writeFile(script, `
import fs from 'node:fs';
import { JsonlStore } from ${JSON.stringify(STORE_URL)};
const [directory, marker] = process.argv.slice(2);
const store = new JsonlStore({ directory, profile: 'default', lockTimeoutMs: 15000 });
await store.init();
await store.withProjectLock('proj-shared', async () => {
    fs.writeFileSync(marker, 'held');
    await store.append({ id: 'child-1', startMs: Date.now(), endMs: Date.now(), project: 'demo' });
    await store.flush();
    await new Promise((resolve) => setTimeout(resolve, 1200));
});
await store.close();
`, 'utf8');

    const child = spawn(process.execPath, [script, directory, marker], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childErr = '';
    child.stderr.on('data', (chunk) => { childErr += String(chunk); });
    const childExit = new Promise((resolve) => { child.on('exit', (code) => resolve(code)); });
    t.after(() => { child.kill('SIGKILL'); });

    await waitFor(async () => fs.stat(marker).then(() => true, () => false), { timeoutMs: 15_000 });

    const store = new JsonlStore({ directory, profile: 'default', lockTimeoutMs: 200 });
    t.after(async () => { await store.close().catch(() => {}); });
    await store.init();

    await assert.rejects(
        () => store.withProjectLock('proj-shared', async () => 'nope'),
        (error) => error.code === 'E_LOCK_TIMEOUT',
        '跨进程活锁不偷',
    );

    const result = await store.withProjectLock('proj-shared', async () => 'parent-done', { timeoutMs: 20_000 });
    assert.equal(result, 'parent-done');
    await store.append(rec('parent-1', Date.now()));
    const ids = (await store.readRecords()).map((record) => record.id).sort();
    assert.deepEqual(ids, ['child-1', 'parent-1'], '子进程写入的记录对父进程可见');

    const exitCode = await childExit;
    assert.equal(exitCode, 0, `子进程应正常退出：${childErr}`);
});
