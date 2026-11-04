/**
 * 端到端契约测试：真实 normalize → tracker → state → journal → restart →
 * summary → CSV。
 *
 * 所有模块都是真的（`collector` / `activity` / `store` / `apply` / `routes`），
 * 只替身 cordis 上下文与 HTTP 请求对象。断言的是**真实非零数据**，不是 `ok:true`。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/** 最小 cordis 上下文替身。 */
/** 本轮创建的所有上下文：断言中途失败也要先 dispose 再清目录。 */
const trackedContexts = [];

/** 逆序释放并 await 全部被跟踪的上下文（幂等）。 */
async function disposeTracked() {
    for (const entry of trackedContexts.splice(0).reverse()) {
        try {
            await entry.disposeAll();
        }
        catch {
            // 清理期异常不应掩盖真正的断言失败。
        }
    }
}

function makeContext(services = {}) {
    const disposers = [];
    const listeners = new Map();
    const ctx = {
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        get: name => services[name],
        effect(fn) {
            const dispose = fn();
            if (typeof dispose === 'function') disposers.push(dispose);
            return () => {};
        },
        on(eventName, handler) {
            const list = listeners.get(eventName) ?? [];
            list.push(handler);
            listeners.set(eventName, list);
            return () => {
                const current = listeners.get(eventName) ?? [];
                const index = current.indexOf(handler);
                if (index >= 0) current.splice(index, 1);
                if (current.length === 0) listeners.delete(eventName);
            };
        },
        inject(names, callback) {
            return callback(ctx);
        },
        async emit(eventName, ...args) {
            const list = [...(listeners.get(eventName) ?? [])];
            const results = await Promise.all(list.map(handler => Promise.resolve().then(() => handler(...args))));
            return results;
        },
        /** 串行执行全部 disposer 并 await 它们的返回值。 */
        async disposeAll() {
            const results = [];
            for (const dispose of disposers) results.push(await dispose());
            disposers.length = 0;
            return results;
        },
        listenerCount() {
            let count = 0;
            for (const list of listeners.values()) count += list.length;
            return count;
        },
    };
    ctx.root = ctx;
    trackedContexts.push(ctx);
    return ctx;
}

/** webServer 替身。 */
function makeServer() {
    return {
        routes: new Map(),
        register(route) {
            this.routes.set(route.path, route.handler);
            return () => this.routes.delete(route.path);
        },
    };
}

/** 调用路由并取回 JSON。 */
async function get(server, routePath, url, headers = {}) {
    const handler = server.routes.get(routePath);
    assert.ok(handler !== undefined, `缺少路由 ${routePath}`);
    const response = {
        headersSent: false,
        status: 0,
        headers: {},
        body: '',
        writeHead(status, values) {
            this.status = status;
            this.headers = values ?? {};
            this.headersSent = true;
        },
        end(body) {
            this.body = typeof body === 'string' ? body : '';
            this.headersSent = true;
        },
    };
    await handler({ method: 'GET', url, headers }, response);
    return { status: response.status, headers: response.headers, body: response.body };
}

test('端到端：真实事件 → 落盘 → 重启 → summary 非零 → 真实 CSV', async () => {
    const module = await import('../lib/index.js');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'dct-e2e-'));
    try {
        const cwd = directory;
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => cwd },
            settings: { describe: () => [] },
        };
        const server = makeServer();
        const ctx = makeContext({ ...services, webServer: server, connection: { requestRejection: () => undefined } });

        // apply 是同步函数，返回 initPromise。
        const initPromise = module.apply(ctx, {
            storageDirectory: directory,
            profile: 'e2e',
            heartbeatIntervalSeconds: 60,
            idleThresholdSeconds: 180,
        });
        assert.ok(initPromise !== undefined && typeof initPromise.then === 'function');
        await initPromise;

        // 真实 AssistantStreamFrame::chunk 序列（每 70s 一次，跨过 60s gate）。
        const base = Date.parse('2026-11-05T01:00:00.000Z');
        const realNow = Date.now;
        let clock = base;
        const frame = (index, text) => ({
            type: 'chunk',
            attemptId: 'attempt-1',
            revision: 1,
            index,
            time: clock,
            chunk: { type: 'text-delta', index: 0, text },
        });
        const emitAt = async (offsetMs, index, text, sessionId = 'session-alpha') => {
            clock = base + offsetMs;
            await ctx.emit('agent/assistant-stream', { agent: { id: sessionId }, frame: frame(index, text) });
        };

        // 60s 内的两次进展 → 一个区间。
        await emitAt(0, 0, 'a');
        await emitAt(30_000, 1, 'b');
        // 跨过 gate 后一次 → 第二个区间（真实续段）。
        await emitAt(120_000, 2, 'c');
        await emitAt(150_000, 3, 'd');

        // 真实工具结果：显式 diff 计数（单文件，带 meta）。
        const toolExec = {
            callId: 'call-w1',
            rootCallId: 'call-w1',
            name: 'write',
            arguments: { file_path: path.join(cwd, 'sample.js') },
            agent: { id: 'session-alpha' },
            signal: new AbortController().signal,
        };
        await ctx.emit('tools/result', toolExec, {
            isError: false,
            value: { changed: true },
            meta: { lines: { added: 12, deleted: 3 } },
        });

        // 真实 flush（宿主 await 全部 listener）。
        await ctx.emit('session/flush');
        void realNow;

        // 通过真实 HTTP 路由读 summary（这条链就是 Client 会走的那条）。
        const summaryResponse = await get(server, '/plugins/dsh-coding-time/api/summary', '/plugins/dsh-coding-time/api/summary?preset=today');
        assert.equal(summaryResponse.status, 200);
        const summary = JSON.parse(summaryResponse.body);

        // 非零真实数据（不是 ok:true 的空壳）：
        assert.ok(summary.totals.totalSeconds > 0, `totalSeconds 应非零，实际 ${summary.totals.totalSeconds}`);
        assert.ok(summary.totals.aiSeconds > 0, `aiSeconds 应非零，实际 ${summary.totals.aiSeconds}`);
        assert.equal(summary.projects.length, 1, '应有一个项目');
        const projectRow = summary.projects[0];
        assert.equal(projectRow.cwd, cwd, 'cwd 必须是真实工作目录，不是 label');
        assert.ok(projectRow.aiSeconds > 0);
        assert.equal(projectRow.sessions, 1, '应统计到 1 个会话');
        // AI 行数来自真实 meta。
        assert.equal(summary.totals.aiAddedLines, 12);
        assert.equal(summary.totals.aiDeletedLines, 3);
        assert.equal(summary.totals.lineDataQuality, 'full');
        // 人类未启用 → null，不是 0。
        assert.equal(summary.totals.humanSeconds, null);
        assert.equal(summary.humanStatus, 'disabled');
        // totalSeconds 是并集，不等于相加（这里 human 为 0/null）。
        assert.equal(summary.totals.totalSeconds, projectRow.totalSeconds);
        // day 行有真实数据。
        const activeDay = summary.days.find(row => row.totalSeconds > 0);
        assert.ok(activeDay !== undefined, '应有一天的真实时长');

        // 导出必须基于真实返回，不是空文件。
        const csvResponse = await get(server, '/plugins/dsh-coding-time/api/export', '/plugins/dsh-coding-time/api/export?format=csv&preset=today');
        assert.equal(csvResponse.status, 200);
        assert.match(csvResponse.headers['Content-Type'], /text\/csv/);
        assert.ok(csvResponse.body.length > 200, 'CSV 不能是空文件');
        assert.match(csvResponse.body, /scope,project,date,source,duration_seconds/);
        // CSV 的 total 行必须带**真实**时长与行数，不是空文件占位。
        const totalRow = csvResponse.body.split('\n').find(line => line.startsWith('total,'));
        assert.ok(totalRow !== undefined, 'CSV 必须有 total 行');
        const cells = totalRow.split(',');
        // 列序：scope,project,date,source,duration_seconds,ai_seconds,human_seconds,lines_added,lines_deleted,sessions
        assert.ok(Number(cells[4]) > 0, `CSV total duration 应非零，实际 ${cells[4]}`);
        assert.equal(cells[7], '12', `CSV 行数必须是真实 meta 值，实际 ${cells[7]}`);
        assert.equal(cells[8], '3', `CSV 删除行必须是真实 meta 值，实际 ${cells[8]}`);
        // 人类未启用 → human_seconds 是空单元格，不是 0。
        assert.equal(cells[6], '', '未采集人类时长必须是空单元格');
        assert.match(csvResponse.body, /c:\\proj|dct-e2e/i, 'CSV 必须含真实项目行');
        // 除表头与注释外必须有数据行（name 行/合计行之外的 project 行）。
        assert.ok(csvResponse.body.split('\n').some(line => line.startsWith('project,')), 'CSV 必须含项目数据行');

        // 卸载：await dispose 后**立即**检查持久化（不 sleep）。
        await ctx.disposeAll();

        const { JsonlStore } = await import('../lib/store.js');
        const store = new JsonlStore({ directory, profile: 'e2e' });
        await store.init();
        const records = await store.readRecords({});
        assert.ok(records.length > 0, '卸载后必须已落盘');
        const intervalRecords = records.filter(record => record.kind === 'interval');
        assert.ok(intervalRecords.length >= 1, '应有真实区间记录');
        // 记录带真实 cwd / sessionId（journal canonical 字段）。
        assert.ok(intervalRecords.some(record => record.cwd === cwd));
        assert.ok(intervalRecords.some(record => record.sessionId === 'session-alpha'));
        await store.close();

        // 重启：新 apply 后 summary 仍能读到历史（不从零开始）。
        const restartServer = makeServer();
        const restarted = makeContext({
            ...services,
            webServer: restartServer,
            connection: { requestRejection: () => undefined },
        });
        const secondInit = module.apply(restarted, {
            storageDirectory: directory,
            profile: 'e2e',
            heartbeatIntervalSeconds: 60,
            idleThresholdSeconds: 180,
        });
        await secondInit;
        const afterRestart = JSON.parse((await get(restartServer,
            '/plugins/dsh-coding-time/api/summary',
            '/plugins/dsh-coding-time/api/summary?preset=today')).body);
        assert.equal(afterRestart.projects.length, 1, '重启后必须仍看得到历史项目');
        assert.ok(afterRestart.projects[0].aiSeconds > 0, '重启后历史时长不能丢');
        assert.equal(afterRestart.totals.aiAddedLines, 12, '重启后历史行数不能丢');
        await restarted.disposeAll();
    }
    finally {
        // **先** dispose（内部串行 drain → flush → close），**再**删目录。
        // 顺序颠倒会让仍在写盘的 store 撞上被删的目录（ENOENT）。
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('端到端：多项目不互相复制行数，AI 只算 AI 来源', async () => {
    const module = await import('../lib/index.js');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'dct-multi-'));
    try {
        const cwdA = path.join(directory, 'projA');
        const cwdB = path.join(directory, 'projB');
        const cwdBySession = { 'session-A': cwdA, 'session-B': cwdB };
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: session => cwdBySession[session.id] },
            settings: { describe: () => [] },
        };
        const server = makeServer();
        const ctx = makeContext({ ...services, webServer: server, connection: { requestRejection: () => undefined } });
        await module.apply(ctx, {
            storageDirectory: directory,
            profile: 'multi',
            humanTracking: { enabled: true },
        });

        let clock = Date.parse('2026-11-05T02:00:00.000Z');
        const streamAt = async (sessionId, index, text, offsetMs) => {
            clock += offsetMs;
            await ctx.emit('agent/assistant-stream', {
                agent: { id: sessionId },
                frame: { type: 'chunk', attemptId: `a-${sessionId}`, revision: 1, index, time: clock, chunk: { type: 'text-delta', index: 0, text } },
            });
        };

        // 项目 A：两次进展（60s 窗口内）。
        await streamAt('session-A', 0, 'a', 0);
        await streamAt('session-A', 1, 'b', 10_000);
        // 项目 B：两次进展。
        await streamAt('session-B', 0, 'c', 10_000);
        await streamAt('session-B', 1, 'd', 10_000);

        // A 的文件真实写 2 行，B 写 5 行。
        await ctx.emit('tools/result', {
            callId: 'wA', rootCallId: 'wA', name: 'write', arguments: { file_path: path.join(cwdA, 'a.js') },
            agent: { id: 'session-A' }, signal: new AbortController().signal,
        }, { isError: false, value: { changed: true }, meta: { lines: { added: 2, deleted: 0 } } });
        await ctx.emit('tools/result', {
            callId: 'wB', rootCallId: 'wB', name: 'write', arguments: { file_path: path.join(cwdB, 'b.js') },
            agent: { id: 'session-B' }, signal: new AbortController().signal,
        }, { isError: false, value: { changed: true }, meta: { lines: { added: 5, deleted: 1 } } });

        await ctx.emit('session/flush');
        const summary = JSON.parse((await get(server,
            '/plugins/dsh-coding-time/api/summary',
            '/plugins/dsh-coding-time/api/summary?preset=today')).body);

        assert.equal(summary.projects.length, 2, '两个项目各一行');
        const rowA = summary.projects.find(row => row.cwd === cwdA);
        const rowB = summary.projects.find(row => row.cwd === cwdB);
        assert.ok(rowA !== undefined && rowB !== undefined);
        // 行数精确归属：A=2/0，B=5/1，绝不各显示 7。
        assert.equal(rowA.aiAddedLines, 2);
        assert.equal(rowA.aiDeletedLines, 0);
        assert.equal(rowB.aiAddedLines, 5);
        assert.equal(rowB.aiDeletedLines, 1);
        assert.notEqual(rowA.aiAddedLines, rowB.aiAddedLines);
        // 全局行数是两个项目的真实合计。
        assert.equal(summary.totals.aiAddedLines, 7);
        assert.equal(summary.totals.aiDeletedLines, 1);
        // AI 时长只算 AI 来源。
        assert.ok(rowA.aiSeconds > 0);
        assert.ok(rowB.aiSeconds > 0);
        // totalSeconds 是墙钟并集：两项目并行 → 小于各项目之和或等于较大者。
        const sumOfProjects = rowA.totalSeconds + rowB.totalSeconds;
        assert.ok(summary.totals.totalSeconds <= sumOfProjects, 'totalSeconds 不能是各项目简单相加');
        // 人类启用但没有编辑器证据 → not_connected + null。
        assert.equal(summary.humanStatus, 'not_connected');
        assert.equal(summary.totals.humanSeconds, null);
        await ctx.disposeAll();
    }
    finally {
        // **先** dispose（内部串行 drain → flush → close），**再**删目录。
        // 顺序颠倒会让仍在写盘的 store 撞上被删的目录（ENOENT）。
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('端到端：project 过滤真的按项目筛（totals 与 days 也一起筛）', async () => {
    const module = await import('../lib/index.js');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'dct-filter-'));
    try {
        const cwdA = path.join(directory, 'projA');
        const cwdB = path.join(directory, 'projB');
        const cwdBySession = { 'session-A': cwdA, 'session-B': cwdB };
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: session => cwdBySession[session.id] },
            settings: { describe: () => [] },
        };
        const server = makeServer();
        const ctx = makeContext({ ...services, webServer: server, connection: { requestRejection: () => undefined } });
        await module.apply(ctx, { storageDirectory: directory, profile: 'filter' });

        let clock = Date.parse('2026-11-05T03:00:00.000Z');
        for (const [sessionId, index] of [['session-A', 0], ['session-A', 1], ['session-B', 0], ['session-B', 1]]) {
            clock += 20_000;
            await ctx.emit('agent/assistant-stream', {
                agent: { id: sessionId },
                frame: { type: 'chunk', attemptId: `a-${sessionId}`, revision: 1, index, time: clock, chunk: { type: 'text-delta', index: 0, text: `x${index}` } },
            });
        }
        await ctx.emit('session/flush');

        const filtered = JSON.parse((await get(server,
            '/plugins/dsh-coding-time/api/summary',
            `/plugins/dsh-coding-time/api/summary?preset=today&project=${encodeURIComponent(cwdA)}`)).body);
        assert.equal(filtered.projects.length, 1, 'project 过滤应只剩一个项目');
        assert.equal(filtered.projects[0].cwd, cwdA);
        // totals 也必须跟着筛（不能还是全局）。
        assert.ok(filtered.totals.projects === 1);
        assert.ok(filtered.totals.sessions <= 1, '过滤后只应看到一个会话');
        // days 也有数据（不能空）。
        assert.ok(filtered.days.length > 0, 'project 过滤后 days 不能为空');
        await ctx.disposeAll();
    }
    finally {
        // **先** dispose（内部串行 drain → flush → close），**再**删目录。
        // 顺序颠倒会让仍在写盘的 store 撞上被删的目录（ENOENT）。
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('端到端：init 未完成时的事件在就绪后只入账一次', async () => {
    const module = await import('../lib/index.js');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'dct-early-'));
    try {
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => directory },
            settings: { describe: () => [] },
        };
        const ctx = makeContext(services);
        const initPromise = module.apply(ctx, { storageDirectory: directory, profile: 'early' });
        // 同步注册已完成：initPromise 还没 resolve 就能拿到 listener。
        assert.ok(ctx.listenerCount() > 0, 'apply 必须在第一个 await 前完成订阅');
        // 在就绪前发真实进展（两次，构成区间）。
        let clock = Date.parse('2026-11-05T04:00:00.000Z');
        await ctx.emit('agent/assistant-stream', {
            agent: { id: 's1' },
            frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: clock, chunk: { type: 'text-delta', index: 0, text: 'p' } },
        });
        clock += 30_000;
        await ctx.emit('agent/assistant-stream', {
            agent: { id: 's1' },
            frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: clock, chunk: { type: 'text-delta', index: 0, text: 'q' } },
        });
        await initPromise;
        await ctx.emit('session/flush');
        await ctx.disposeAll();

        const { JsonlStore } = await import('../lib/store.js');
        const store = new JsonlStore({ directory, profile: 'early' });
        await store.init();
        const records = await store.readRecords({});
        await store.close();
        // 只入账一次：不允许重复记录。
        const ids = records.map(record => `${record.id}|${record.revision}`);
        assert.equal(ids.length, new Set(ids).size, '同一记录不得重复入账');
        assert.ok(records.length > 0, '早期事件必须最终入账');
    }
    finally {
        // **先** dispose（内部串行 drain → flush → close），**再**删目录。
        // 顺序颠倒会让仍在写盘的 store 撞上被删的目录（ENOENT）。
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('端到端：init 未完成时卸载不晚注册、不接新活动、不泄漏', async () => {
    const module = await import('../lib/index.js');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'dct-early-dispose-'));
    try {
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => directory },
            settings: { describe: () => [] },
        };
        const ctx = makeContext(services);
        const initPromise = module.apply(ctx, { storageDirectory: directory, profile: 'earlyoff' });
        // 立刻卸载（init 可能还没完成）。
        await ctx.disposeAll();
        assert.equal(ctx.listenerCount(), 0, '卸载后绝不留 listener');
        await initPromise.catch(() => {});
        // 卸载后的事件不得再被接受。
        let clock = Date.parse('2026-11-05T05:00:00.000Z');
        await ctx.emit('agent/assistant-stream', {
            agent: { id: 's1' },
            frame: { type: 'chunk', attemptId: 'a9', revision: 1, index: 0, time: clock, chunk: { type: 'text-delta', index: 0, text: 'z' } },
        });
        clock += 30_000;
        await ctx.emit('agent/assistant-stream', {
            agent: { id: 's1' },
            frame: { type: 'chunk', attemptId: 'a9', revision: 1, index: 1, time: clock, chunk: { type: 'text-delta', index: 0, text: 'z2' } },
        });
        const { JsonlStore } = await import('../lib/store.js');
        const store = new JsonlStore({ directory, profile: 'earlyoff' });
        await store.init();
        const records = await store.readRecords({});
        await store.close();
        assert.equal(records.length, 0, '卸载后不得接受新活动');
    }
    finally {
        // **先** dispose（内部串行 drain → flush → close），**再**删目录。
        // 顺序颠倒会让仍在写盘的 store 撞上被删的目录（ENOENT）。
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('100 个真实 chunk 在 flush 前只产生有限次 state 提交', async () => {
    const module = await import('../lib/index.js');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'dct-batch-'));
    try {
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => directory },
            settings: { describe: () => [] },
        };
        const ctx = makeContext(services);
        // flushInterval 设得足够长，确保 100 个 chunk 期间不会有周期 checkpoint。
        await module.apply(ctx, {
            storageDirectory: directory,
            profile: 'batch',
            flushIntervalSeconds: 600,
            heartbeatIntervalSeconds: 60,
            idleThresholdSeconds: 180,
        });

        const { JsonlStore } = await import('../lib/store.js');
        // 统计写盘次数：包一层 store 不可行（apply 内部构造），改看 journal/state 产物。
        const base = Date.parse('2026-11-05T06:00:00.000Z');
        // 100 个真实 chunk，间隔 1s（远小于 idle 阈值，全部属于同一段）。
        for (let index = 0; index < 100; index += 1) {
            await ctx.emit('agent/assistant-stream', {
                agent: { id: 'session-batch' },
                frame: {
                    type: 'chunk',
                    attemptId: 'attempt-1',
                    revision: 1,
                    index,
                    time: base + index * 1000,
                    chunk: { type: 'text-delta', index: 0, text: `t${index}` },
                },
            });
        }
        // flush 前不得有任何 journal 分片（缓冲生效）。
        const store0 = new JsonlStore({ directory, profile: 'batch' });
        await store0.init();
        const beforeFlush = await store0.readRecords({});
        await store0.close();
        assert.equal(beforeFlush.length, 0, 'flush 前不应写盘（缓冲必须真实生效）');

        // session/flush 之后一次性完成。
        await ctx.emit('session/flush');
        const store1 = new JsonlStore({ directory, profile: 'batch' });
        await store1.init();
        const afterFlush = await store1.readRecords({});
        const states = await store1.listProjectStates({ includeState: true });
        await store1.close();
        assert.ok(afterFlush.length >= 1, 'flush 后必须有记录');
        // 100 个 chunk 属于同一段 → 只有一条区间记录，不是 100 条。
        assert.equal(afterFlush.length, 1, `应只有 1 条区间记录，实际 ${afterFlush.length}`);
        assert.equal(states.length, 1, '只应有 1 个项目快照');
        // 区间覆盖全部 100 个 chunk 的时间跨度（99s）。
        const span = afterFlush[0].endMs - afterFlush[0].startMs;
        assert.equal(span, 99_000, `区间跨度应为 99s，实际 ${span}`);
        // 100 条观测只产生一次 state 提交（revision 不应该随 chunk 数线性增长）。
        assert.ok(states[0].revision <= 2, `state 提交次数应有限，实际 revision ${states[0].revision}`);
        await ctx.disposeAll();
    }
    finally {
        // **先** dispose（内部串行 drain → flush → close），**再**删目录。
        // 顺序颠倒会让仍在写盘的 store 撞上被删的目录（ENOENT）。
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('idle 后重新活动：间隔 < idle 阈值也不跨 run 连线', async () => {
    const module = await import('../lib/index.js');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'dct-epoch-'));
    try {
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => directory },
            settings: { describe: () => [] },
        };
        const ctx = makeContext(services);
        await module.apply(ctx, {
            storageDirectory: directory,
            profile: 'epoch',
            heartbeatIntervalSeconds: 60,
            idleThresholdSeconds: 180,
            flushIntervalSeconds: 600,
        });

        const base = Date.parse('2026-11-05T07:00:00.000Z');
        const streamAt = (index, at, attempt = 'a1', text = 'x') => ctx.emit('agent/assistant-stream', {
            agent: { id: 'session-epoch' },
            frame: { type: 'chunk', attemptId: attempt, revision: 1, index, time: at, chunk: { type: 'text-delta', index: 0, text } },
        });

        // 第一段：两次进展，间隔 30s。
        await streamAt(0, base);
        await streamAt(1, base + 30_000);
        // idle（只切段，不计时）。
        await ctx.emit('agent/status', { agent: { id: 'session-epoch' }, status: 'idle' });
        // 60s 后重新活动（远小于 180s idle 阈值，但属于新 run）。
        await streamAt(2, base + 90_000);
        await streamAt(3, base + 90_000 + 30_000);
        await ctx.emit('session/flush');

        const { JsonlStore } = await import('../lib/store.js');
        const store = new JsonlStore({ directory, profile: 'epoch' });
        await store.init();
        const records = await store.readRecords({});
        await store.close();
        // 两段必须是两条独立记录（runId 不同），不能连成一条。
        const distinctRuns = new Set(records.map(record => String(record.runId ?? '')));
        assert.equal(records.length, 2, `应为两条独立区间，实际 ${records.length}`);
        assert.equal(distinctRuns.size, 2, '两段的 runId 必须不同');
        await ctx.disposeAll();
    }
    finally {
        // **先** dispose（内部串行 drain → flush → close），**再**删目录。
        // 顺序颠倒会让仍在写盘的 store 撞上被删的目录（ENOENT）。
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('只有 running 状态（无真实进展）始终 0 秒', async () => {
    const module = await import('../lib/index.js');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'dct-running-'));
    try {
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => directory },
            settings: { describe: () => [] },
            connection: { requestRejection: () => undefined },
        };
        const server = makeServer();
        const ctx = makeContext({ ...services, webServer: server });
        await module.apply(ctx, { storageDirectory: directory, profile: 'running', flushIntervalSeconds: 600 });

        // 反复 running（无 stream 进展）。
        for (let index = 0; index < 5; index += 1) {
            await ctx.emit('agent/status', { agent: { id: 'session-run' }, status: 'running' });
        }
        await ctx.emit('session/flush');

        const summary = JSON.parse((await get(server,
            '/plugins/dsh-coding-time/api/summary',
            '/plugins/dsh-coding-time/api/summary?preset=today')).body);
        assert.equal(summary.totals.totalSeconds, 0, 'running 本身绝不计时');
        assert.equal(summary.totals.aiSeconds, 0);
        assert.deepEqual(summary.projects, []);
        await ctx.disposeAll();
    }
    finally {
        // **先** dispose（内部串行 drain → flush → close），**再**删目录。
        // 顺序颠倒会让仍在写盘的 store 撞上被删的目录（ENOENT）。
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('session/disposed 清理 epoch，同 id 再出现不沿用旧 run', async () => {
    const module = await import('../lib/index.js');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'dct-disposed-'));
    try {
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => directory },
            settings: { describe: () => [] },
        };
        const ctx = makeContext(services);
        await module.apply(ctx, { storageDirectory: directory, profile: 'disposed', flushIntervalSeconds: 600 });

        const base = Date.parse('2026-11-05T08:00:00.000Z');
        const streamAt = (index, at, text) => ctx.emit('agent/assistant-stream', {
            agent: { id: 'session-d' },
            frame: { type: 'chunk', attemptId: 'a1', revision: 1, index, time: at, chunk: { type: 'text-delta', index: 0, text } },
        });

        await streamAt(0, base, 'x');
        await streamAt(1, base + 30_000, 'y');
        // 会话销毁。
        await ctx.emit('session/disposed', { id: 'session-d' });
        // 同 id 再出现（新一次会话），时间紧贴着上一段末尾。
        await streamAt(2, base + 40_000, 'z');
        await streamAt(3, base + 70_000, 'w');
        await ctx.emit('session/flush');

        const { JsonlStore } = await import('../lib/store.js');
        const store = new JsonlStore({ directory, profile: 'disposed' });
        await store.init();
        const records = await store.readRecords({});
        await store.close();
        // 销毁前后必须是两条独立记录。
        assert.equal(records.length, 2, `应为两条独立区间，实际 ${records.length}`);
        await ctx.disposeAll();
    }
    finally {
        // **先** dispose（内部串行 drain → flush → close），**再**删目录。
        // 顺序颠倒会让仍在写盘的 store 撞上被删的目录（ENOENT）。
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});
