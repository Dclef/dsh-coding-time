/**
 * summary 顶层契约 · 真实端到端测试（node:test，零 mock summarize）。
 *
 * 这条用例刻意**不**伪造 API fixture、不 mock `summarize()`、不直接造 summary
 * 输出：用真实 `apply(ctx, config)` 装配，发真实 `tools/result` /
 * `agent/assistant-stream` 事件，写真实 editor-inbox 心跳，await 真实
 * `session/flush`，最后打真实的 `/plugins/dsh-coding-time/api/summary` HTTP
 * 路由并断言回包。ActivityTracker / JsonlStore / routes 全部是仓库里的真实现。
 *
 * 时间控制：用一个可写的 `Date.now` 替身（每个用例结束恢复），事件带真实 epoch
 * ms，**不睡眠、不等真实定时器**。同源（同 source|sessionId|runId）事件间隔
 * <= idleThresholdSeconds(180s) 才能续段。
 *
 * 运行：`node --test test/summary-contract.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { projectKeyOf } from '../lib/activity.js';
import { ROUTE_PREFIX } from '../lib/routes.js';
import { JsonlStore } from '../lib/store.js';
import { writeEditorHeartbeat } from '../integrations/local-editor.js';

/** 固定「现在」锚点（UTC，便于断言本地日键）。 */
const NOW = Date.parse('2026-06-17T10:00:00Z');
/** 三个不同日：周一/周二属于 week 但不属于 today；周三既是 today 也在 week 内。 */
const DAY_MON = Date.parse('2026-06-15T10:00:00Z');
const DAY_TUE = Date.parse('2026-06-16T10:00:00Z');
const DAY_WED = NOW;

/** 真实的最小 cordis 上下文替身（模式参考 test/host.test.mjs，但不 import 其 tests）。 */
function makeContext(services, webServer) {
    const listeners = new Map();
    const disposers = [];
    const ctx = {
        logger: {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
        },
        get(name) {
            if (name === 'webServer') return webServer;
            return services[name];
        },
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
            // 依赖已就绪：直接执行，模拟宿主注入。
            return callback(this);
        },
        emit(eventName, ...args) {
            const list = [...(listeners.get(eventName) ?? [])];
            return Promise.all(list.map(handler => Promise.resolve().then(() => handler(...args))));
        },
        disposeAll() {
            for (const dispose of disposers) dispose();
            disposers.length = 0;
        },
    };
    ctx.root = ctx;
    return ctx;
}

/** 收集真实 webServer.register 的 exact 路由。 */
function makeWebServer() {
    const routes = new Map();
    return {
        routes,
        register(route) {
            routes.set(route.path, route.handler);
            return () => routes.delete(route.path);
        },
    };
}

/** 真实走 HTTP 路由的客户端替身（fail-closed 门卫要求 connection.requestRejection 放行）。 */
function callSummary(webServer, queryString) {
    const handler = webServer.routes.get(`${ROUTE_PREFIX}/summary`);
    assert.equal(typeof handler, 'function', '真实 summary 路由必须已注册');
    const req = {
        method: 'GET',
        url: `${ROUTE_PREFIX}/summary?${queryString}`,
        headers: {},
    };
    let status = null;
    let payload = null;
    const res = {
        headersSent: false,
        writeHead(code) { status = code; this.headersSent = true; },
        end(body) { payload = JSON.parse(body); },
    };
    return Promise.resolve(handler(req, res)).then(() => {
        assert.equal(status, 200, '真实 /summary 应回 200');
        assert.equal(payload?.ok, true, '回包 ok 必须为 true');
        return payload;
    });
}

/** 真实 tools/result 事件（成功 + 明确路径 + 显式 meta 行数）。 */
function toolResult(sessionId, callId, file) {
    return {
        agent: { id: sessionId },
        name: 'edit',
        callId,
        arguments: { file_path: file },
    };
}

function toolOutcome(meta) {
    return { isError: false, value: { ok: true }, meta };
}

/** 真实 stream 包裹 chunk 事件（带可控 time）。 */
function progressFrame(sessionId, attemptId, revision, index, time) {
    return {
        agent: { id: sessionId },
        frame: {
            type: 'chunk',
            attemptId,
            revision,
            index,
            time,
            chunk: { type: 'text-delta', index: 0, text: 'x' },
        },
    };
}

/**
 * 起一个真实插件实例；返回 ctx / webServer / 固定时钟 setter / 收尾函数。
 *
 * 注意：editor-inbox 心跳文件必须在 `apply()` **之前**写好，这样 init 末尾的那次
 * `pollEditor()`（立即执行一次，不需要等真实定时器）就能确定性消费，避免 sleep。
 * 事件里的 `at` 才决定时间语义，与文件写入时刻无关。
 */
async function boot({ humanTracking = { enabled: false }, preWriteHeartbeats = [] } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dct-summary-'));
    const cwdA = path.join(directory, 'projA');
    const cwdB = path.join(directory, 'projB');
    await fs.mkdir(path.join(cwdA, 'src'), { recursive: true });
    await fs.mkdir(path.join(cwdB, 'src'), { recursive: true });
    const fileA = path.join(cwdA, 'src', 'a.js');
    const fileB = path.join(cwdB, 'src', 'b.js');
    await fs.writeFile(fileA, '// a\n', 'utf8');
    await fs.writeFile(fileB, '// b\n', 'utf8');

    // 预写真实 editor 心跳（在 apply 前），由 init 末尾的立即 pollEditor 消费。
    for (const event of preWriteHeartbeats) {
        await writeEditorHeartbeat({
            directory,
            profile: 'contract',
            event: { ...event, cwd: cwdA, file: fileA },
        });
    }

    const services = {
        sessions: { get: id => ({ id }) },
        workingDirectory: {
            get: (session) => (session.id === 'sB' ? cwdB : cwdA),
        },
        settings: { describe: () => [] },
        connection: { requestRejection: () => undefined }, // fail-closed 门卫：放行
    };
    const webServer = makeWebServer();
    const ctx = makeContext(services, webServer);

    // 可控时钟：node:test 同文件内用例默认串行，逐用例保存/恢复。
    const originalNow = Date.now;
    let clock = DAY_WED;
    Date.now = () => clock;
    const setTime = (ms) => { clock = ms; };

    const mod = await import('../lib/index.js');
    // schemastery 真实 peer 已随本包 devDependencies 安装；apply 直接可用。
    await mod.apply(ctx, {
        storageDirectory: directory,
        profile: 'contract',
        timezone: 'UTC',
        heartbeatIntervalSeconds: 60,
        idleThresholdSeconds: 180,
        flushIntervalSeconds: 10,
        trackAgentActivity: true,
        trackAiLines: true,
        humanTracking,
    });

    const teardown = async () => {
        ctx.disposeAll();
        await new Promise(resolve => setImmediate(resolve));
        Date.now = originalNow;
        await fs.rm(directory, { recursive: true, force: true });
    };

    return { directory, cwdA, cwdB, fileA, fileB, ctx, webServer, setTime, teardown };
}

/** 从 projects 里按 cwd 找一行（cwd 必须是真实绝对路径，不是 label）。 */
function projectByCwd(summary, cwd) {
    return (summary.projects ?? []).find(row => row.cwd === cwd);
}

/** 读真实 JsonlStore 的持久记录（核对有效心跳数，不 mock summarize）。 */
async function readRecords(directory) {
    const store = new JsonlStore({ directory, profile: 'contract' });
    await store.init();
    const records = await store.readRecords({});
    await store.close();
    return records;
}

/** 有效心跳总数：只数 heartbeats > 0 的记录（pending 带真实时长但 hb 仍为 0）。 */
function effectiveHeartbeats(records) {
    return records.filter(record => Number(record?.heartbeats ?? 0) > 0).length;
}

/** 断言顶层契约必备字段。 */
function assertTopLevelShape(summary) {
    assert.equal(summary.ok, true);
    assert.ok(summary.totals !== null && typeof summary.totals === 'object', 'totals 必须在顶层');
    assert.ok(Array.isArray(summary.projects), 'projects 必须在顶层且为数组');
    assert.ok(Array.isArray(summary.days), 'days 必须在顶层且为数组');
    for (const key of ['aiSeconds', 'humanSeconds', 'totalSeconds', 'aiAddedLines', 'aiDeletedLines', 'lineDataQuality', 'sessions', 'projects']) {
        assert.ok(Object.hasOwn(summary.totals, key), `totals 缺字段 ${key}`);
    }
}

// ── 用例 1：两项目不同行数元数据 + 逐项目准确 + cwd 是真路径 ────────────────

test('E2E: 两项目 A/B 真实 diff 行数各自准确，A 不重复拿全局 7 行，project 路径是 cwd', async () => {
    const boot1 = await boot();
    try {
        const { directory, ctx, webServer, setTime, cwdA, cwdB, fileA, fileB } = boot1;
        // 同项目、同源、间隔 5s（<=180s 续段）。A: +2/-1；B: +5/-3。
        setTime(DAY_WED);
        await ctx.emit('tools/result', toolResult('sA', 'c-a1', fileA), toolOutcome({ lines: { added: 2, deleted: 1 } }));
        setTime(DAY_WED + 5_000);
        await ctx.emit('tools/result', toolResult('sA', 'c-a2', fileA), toolOutcome({ lines: { added: 0, deleted: 0 } }));
        await ctx.emit('tools/result', toolResult('sB', 'c-b1', fileB), toolOutcome({ lines: { added: 5, deleted: 3 } }));
        setTime(DAY_WED + 10_000);
        await ctx.emit('tools/result', toolResult('sB', 'c-b2', fileB), toolOutcome({ lines: { added: 0, deleted: 0 } }));
        await ctx.emit('session/flush');

        const all = await callSummary(webServer, 'preset=all');
        assertTopLevelShape(all);

        // 顶层全局行数 = 2+5 / 1+3，且由真实 diff 元数据得出。
        assert.equal(all.totals.aiAddedLines, 7, '全局 added 应为 7');
        assert.equal(all.totals.aiDeletedLines, 4, '全局 deleted 应为 4');
        assert.equal(all.totals.lineDataQuality, 'full');
        assert.equal(all.totals.projects, 2);

        const rowA = projectByCwd(all, cwdA);
        const rowB = projectByCwd(all, cwdB);
        assert.ok(rowA, `A 行必须以真实 cwd ${cwdA} 出现（不是 label）`);
        assert.ok(rowB, `B 行必须以真实 cwd ${cwdB} 出现（不是 label）`);
        assert.equal(rowA.cwd, cwdA);
        assert.equal(rowB.cwd, cwdB);
        // 绝不能用 label 冒充路径。
        assert.ok(path.isAbsolute(rowA.cwd), 'A 的 cwd 必须是绝对路径');
        assert.ok(path.isAbsolute(rowB.cwd), 'B 的 cwd 必须是绝对路径');

        // 逐项目行数准确：A 不能重复拿全局 7 行。
        assert.equal(rowA.aiAddedLines, 2, 'A 只能拿自己的 +2，不能拿全局 +7');
        assert.equal(rowA.aiDeletedLines, 1, 'A 只能拿自己的 -1，不能拿全局 -4');
        assert.equal(rowB.aiAddedLines, 5, 'B 只能拿自己的 +5');
        assert.equal(rowB.aiDeletedLines, 3, 'B 只能拿自己的 -3');

        // AI 时长按来源：A/B 各 5s（t0..t0+5 / t0+5..t0+10 续段），无 human。
        assert.equal(rowA.humanSeconds, null, '未接入人工时 humanSeconds 必须是 null，不是 0');
        assert.equal(rowB.humanSeconds, null);
        assert.equal(rowA.aiSeconds, 5, 'A 的 AI 续段应为精确 5s');
        assert.equal(rowB.aiSeconds, 5, 'B 的 AI 续段应为精确 5s');
        assert.equal(all.totals.humanSeconds, null);
        assert.equal(all.totals.aiSeconds, 10, '全局 aiSeconds 应为 A+B 的 AI 来源之和');
        // 真实持久记录里每条都是 AI 来源，human 不得被写成 ai。
        const records = await readRecords(directory);
        assert.ok(records.length > 0, '真实 session/flush 后应有持久记录');
        assert.ok(records.every(record => String(record.source) === 'ai'), '未开启人工时不得出现 human/unknown 记录');
    }
    finally {
        await boot1.teardown();
    }
});

// ── 用例 2：同项目 AI 与 human 重叠，human 不被算成 ai，wall union 不重复 ────

test('E2E: 同项目 AI 与 human 重叠，human 不算进 ai、wall union 不重复相加', async () => {
    // human 事件在 apply 之前预写入 inbox，由 init 末尾立即 pollEditor 消费（无 sleep）。
    const preWriteHeartbeats = [
        {
            id: 'hb-h1', sessionId: 'ed-A', runId: 'r-human', at: DAY_WED + 10_000,
            source: 'human', provenance: { kind: 'keyboard', explicit: true },
        },
        {
            id: 'hb-h2', sessionId: 'ed-A', runId: 'r-human', at: DAY_WED + 20_000,
            source: 'human', provenance: { kind: 'keyboard', explicit: true },
        },
    ];
    const boot1 = await boot({ humanTracking: { enabled: true }, preWriteHeartbeats });
    try {
        const { directory, ctx, webServer, setTime, cwdA, fileA } = boot1;
        // AI 单点 t0：拿到 60s gate（有效心跳 1），之后无 t>=60 事件。
        // human 两点 t0+10 / t0+20 落在被压下的 pending 段，必须保留真实 10s。
        setTime(DAY_WED);
        await ctx.emit('tools/result', toolResult('sA', 'c-a1', fileA), toolOutcome({ lines: { added: 2, deleted: 1 } }));
        await ctx.emit('session/flush');

        const all = await callSummary(webServer, 'preset=all');
        assertTopLevelShape(all);
        assert.equal(all.humanStatus, 'connected', '有真实 editor 来源证据时应 connected');

        const rowA = projectByCwd(all, cwdA);
        assert.ok(rowA);
        // human 10s 不能被算成 ai：AI 单点时长为 0。
        assert.equal(rowA.aiSeconds, 0, 'AI 只有单点，aiSeconds 必须是 0，不能把 human 10s 算进来');
        assert.equal(rowA.humanSeconds, 10, 'human 两点应保留真实 10s（gate 限计数不限时间证据）');
        assert.equal(all.totals.humanSeconds, 10);
        assert.equal(all.totals.aiSeconds, 0, '全局 aiSeconds 不得混入 human');
        // 墙钟并集：AI 单点(0) ∪ human[10s,20s] = 10s，绝不等于重复相加。
        assert.equal(all.totals.totalSeconds, 10, 'wallUnion 不应把 AI 与 human 叠加成 20s');
        assert.equal(rowA.totalSeconds, 10);
        // 行数仍只认 AI 的真实 diff。
        assert.equal(rowA.aiAddedLines, 2);
        assert.equal(rowA.aiDeletedLines, 1);

        // gate 限制的是「有效心跳计数」，不是时间证据：
        // AI 单点 hb=1，human pending 段带真实 10s 但 hb=0；总有效心跳仍为 1。
        const records = await readRecords(directory);
        assert.equal(effectiveHeartbeats(records), 1, '总有效心跳必须仍为 1，pending 不得增加有效心跳');
        const humanRecord = records.find(record => String(record.source) === 'human');
        assert.ok(humanRecord, '应存在真实 human 持久记录');
        assert.equal(Number(humanRecord.heartbeats), 0, 'pending human 的 heartbeats 必须是 0');
        assert.equal(Number(humanRecord.durationMs), 10_000, 'pending human 必须保留真实 10s 时长');
        assert.equal(String(humanRecord.kind), 'interval', '两点 pending 应投影为 interval（不是零时长 evidence）');
    }
    finally {
        await boot1.teardown();
    }
});

// ── 用例 3：today / week 不同日记录各自准确 ───────────────────────────────

test('E2E: today 与 week 按真实记录日分别归属，不串日', async () => {
    const boot1 = await boot();
    try {
        const { ctx, webServer, setTime, cwdA, fileA } = boot1;
        const emitPair = async (at, call1, call2, meta) => {
            setTime(at);
            await ctx.emit('tools/result', toolResult('sA', call1, fileA), toolOutcome(meta));
            setTime(at + 5_000);
            await ctx.emit('tools/result', toolResult('sA', call2, fileA), toolOutcome({ lines: { added: 0, deleted: 0 } }));
        };
        // 周一 +1/-1，周二 +2/-2，周三(today) +3/-3。
        await emitPair(DAY_MON, 'c-mon1', 'c-mon2', { lines: { added: 1, deleted: 1 } });
        await emitPair(DAY_TUE, 'c-tue1', 'c-tue2', { lines: { added: 2, deleted: 2 } });
        await emitPair(DAY_WED, 'c-wed1', 'c-wed2', { lines: { added: 3, deleted: 3 } });
        await ctx.emit('session/flush');

        const today = await callSummary(webServer, 'preset=today');
        const week = await callSummary(webServer, 'preset=week');
        assertTopLevelShape(today);
        assertTopLevelShape(week);

        // today 只含周三：行数 3/3，天数 1。
        assert.equal(today.totals.aiAddedLines, 3);
        assert.equal(today.totals.aiDeletedLines, 3);
        assert.equal(today.days.length, 1, 'today 只应有 1 个日行');
        assert.equal(today.days[0].date, '2026-06-17');
        assert.equal(today.days[0].aiAddedLines, 3);
        assert.equal(today.days[0].aiDeletedLines, 3);

        // week（周三为 now）含周一/二/三：行数 1+2+3=6 / 1+2+3=6，天数 3。
        assert.equal(week.totals.aiAddedLines, 6);
        assert.equal(week.totals.aiDeletedLines, 6);
        assert.equal(week.days.length, 3, 'week 应含 3 个日行');
        const byDate = new Map(week.days.map(day => [day.date, day]));
        assert.deepEqual([...byDate.keys()].sort(), ['2026-06-15', '2026-06-16', '2026-06-17']);
        assert.equal(byDate.get('2026-06-15').aiAddedLines, 1);
        assert.equal(byDate.get('2026-06-15').aiDeletedLines, 1);
        assert.equal(byDate.get('2026-06-16').aiAddedLines, 2);
        assert.equal(byDate.get('2026-06-16').aiDeletedLines, 2);
        assert.equal(byDate.get('2026-06-17').aiAddedLines, 3);
        assert.equal(byDate.get('2026-06-17').aiDeletedLines, 3);
        // 每日 aiSeconds 只算该日 AI 来源（精确 5s/天），不含跨日串入、不含 human。
        for (const day of week.days) assert.equal(day.aiSeconds, 5, `${day.date} aiSeconds 应精确为 5`);
        for (const day of week.days) assert.equal(day.humanSeconds, null, `${day.date} 未接入人工时 humanSeconds 必须是 null`);
    }
    finally {
        await boot1.teardown();
    }
});

// ── 用例 4：query.project 过滤 + sessions 只含选中范围 ─────────────────────

test('E2E: query.project 过滤后 projects/totals/sessions/days 只反映选中项目', async () => {
    const boot1 = await boot();
    try {
        const { ctx, webServer, setTime, cwdA, cwdB, fileA, fileB } = boot1;
        // A 在今天(sA)，B 在昨天(sB) —— 同时制造不同日与不同会话。
        setTime(DAY_TUE);
        await ctx.emit('tools/result', toolResult('sB', 'c-b1', fileB), toolOutcome({ lines: { added: 5, deleted: 3 } }));
        setTime(DAY_TUE + 5_000);
        await ctx.emit('tools/result', toolResult('sB', 'c-b2', fileB), toolOutcome({ lines: { added: 0, deleted: 0 } }));
        setTime(DAY_WED);
        await ctx.emit('tools/result', toolResult('sA', 'c-a1', fileA), toolOutcome({ lines: { added: 2, deleted: 1 } }));
        setTime(DAY_WED + 5_000);
        await ctx.emit('tools/result', toolResult('sA', 'c-a2', fileA), toolOutcome({ lines: { added: 0, deleted: 0 } }));
        await ctx.emit('session/flush');

        const pkA = projectKeyOf(cwdA);
        const all = await callSummary(webServer, 'preset=all');
        assertTopLevelShape(all);
        assert.equal(all.totals.sessions, 2, '全局应含 sA 与 sB 两个会话');
        assert.equal(all.totals.projects, 2);

        const filtered = await callSummary(webServer, `preset=all&project=${encodeURIComponent(pkA)}`);
        assertTopLevelShape(filtered);
        assert.equal(filtered.totals.projects, 1, '过滤后应只剩 A');
        assert.equal(filtered.projects.length, 1);
        const rowA = projectByCwd(filtered, cwdA);
        assert.ok(rowA, '过滤应保留 A，且其 cwd 是真实路径');
        assert.equal(rowA.cwd, cwdA);
        // 行数收敛到 A 自己，不是全局 7/4。
        assert.equal(filtered.totals.aiAddedLines, 2);
        assert.equal(filtered.totals.aiDeletedLines, 1);
        assert.equal(rowA.aiAddedLines, 2);
        assert.equal(rowA.aiDeletedLines, 1);
        // sessions 只含选中范围：sB 不得混入。
        assert.equal(filtered.totals.sessions, 1, 'sessions 不得混入 B 的 sB');
        assert.equal(rowA.sessions, 1);
        assert.ok((filtered.recent ?? []).every(item => item.project !== 'projB'), 'recent 不得混入 B 的记录');
        // days 只反映 A 的记录日（周三），不能带出 B 的周二。
        assert.equal(filtered.days.length, 1);
        assert.equal(filtered.days[0].date, '2026-06-17');
    }
    finally {
        await boot1.teardown();
    }
});

// ── 用例 5：human 单点 = 0、未知来源不升级、真实 stream 事件也入账 ──────────

test('E2E: 真实 stream 与单点 editor 事件：孤立点 0、unknown 不升级 human', async () => {
    // 一个显式 human 但只有单点（无第二点），以及一个 unknown 来源事件。
    const preWriteHeartbeats = [
        {
            id: 'hb-single', sessionId: 'ed-A', runId: 'r-single', at: DAY_WED + 30_000,
            source: 'human', provenance: { kind: 'keyboard', explicit: true },
        },
        {
            id: 'hb-unknown', sessionId: 'ed-A', runId: 'r-unknown', at: DAY_WED + 40_000,
            source: 'unknown', provenance: null,
        },
    ];
    const boot1 = await boot({ humanTracking: { enabled: true }, preWriteHeartbeats });
    try {
        const { directory, ctx, webServer, setTime, cwdA, fileA } = boot1;
        // 真实 stream chunk 包裹事件（时间可控），同源间隔 <=180s。
        setTime(DAY_WED);
        await ctx.emit('agent/assistant-stream', progressFrame('sA', 'att-1', 1, 0, DAY_WED));
        setTime(DAY_WED + 5_000);
        await ctx.emit('agent/assistant-stream', progressFrame('sA', 'att-1', 1, 1, DAY_WED + 5_000));
        await ctx.emit('tools/result', toolResult('sA', 'c-a1', fileA), toolOutcome({ lines: { added: 2, deleted: 1 } }));
        await ctx.emit('session/flush');

        const all = await callSummary(webServer, 'preset=all');
        assertTopLevelShape(all);
        const rowA = projectByCwd(all, cwdA);
        assert.ok(rowA);
        // 单点 human / unknown 是孤立点：不赠时长、不被推断为有效人工区间。
        assert.equal(rowA.humanSeconds, 0, '单点 human 的 humanSeconds 必须是 0，不能编造时长');
        assert.equal(rowA.aiSeconds, 5, 'stream 续段 + tool 证据应为精确 5s AI');
        assert.equal(all.totals.totalSeconds, 5, 'wall union 不因孤立点变长');
        // 真实 diff 行数仍准确。
        assert.equal(rowA.aiAddedLines, 2);
        assert.equal(rowA.aiDeletedLines, 1);
        // 行数没有 meta 的文本/命令/正文类字段混入 totals。
        assert.equal(all.totals.lineDataQuality, 'full');

        // unknown 来源绝不升级成 human；单点 pending 是零时长 evidence。
        const records = await readRecords(directory);
        const unknown = records.find(record => String(record.source) === 'unknown');
        assert.ok(unknown, 'unknown 来源事件应真实入账');
        assert.equal(Number(unknown.durationMs), 0, '单点 pending 必须保持零时长');
        assert.equal(String(unknown.kind), 'evidence', '单点 pending 应为 evidence（不是有长 interval）');
        assert.equal(effectiveHeartbeats(records), 1, '孤立点不得增加有效心跳');
        assert.ok(!records.some(record => String(record.source) === 'human' && Number(record.durationMs) > 0),
            '单点 human 不得被拼成有长区间');
    }
    finally {
        await boot1.teardown();
    }
});

// ── 用例 6：按文件分摊时长（WakaTime 式环形图数据源）真实链路 ─────────────────

test('E2E: 真实工具事件产出 files[] 分摊时长，各文件之和不超过全局墙钟并集', async () => {
    const boot1 = await boot();
    try {
        const { ctx, webServer, setTime, fileA } = boot1;
        // 同一文件两次事件（间隔 5s ≤ idle），形成一条 5s 的真实 interval。
        setTime(DAY_WED);
        await ctx.emit('tools/result', toolResult('sA', 'c-f1', fileA), toolOutcome({ lines: { added: 2, deleted: 1 } }));
        setTime(DAY_WED + 5_000);
        await ctx.emit('tools/result', toolResult('sA', 'c-f2', fileA), toolOutcome({ lines: { added: 0, deleted: 0 } }));
        await ctx.emit('session/flush');

        const all = await callSummary(webServer, 'preset=all');
        assertTopLevelShape(all);
        assert.ok(Array.isArray(all.files), 'summary.files 必须是顶层数组');
        assert.ok(all.files.length > 0, '有真实文件证据时应产出文件行');

        let sum = 0;
        for (const row of all.files) {
            assert.equal(typeof row.path, 'string', '每行必须有 path');
            assert.ok(row.path !== '', 'path 不得为空字符串');
            assert.ok(Number.isFinite(row.totalSeconds) && row.totalSeconds > 0, '每行必须是正的有限秒数');
            assert.equal(row.attribution, 'apportioned', '必须显式标注为按证据分摊的估计');
            assert.ok(Number.isFinite(row.touches), 'touches 必须是有限数字');
            sum += row.totalSeconds;
        }
        // 诚实性核心：分摊是「切段」不是「重复计入」——各文件之和绝不超过墙钟并集。
        assert.ok(sum <= all.totals.totalSeconds,
            `文件时长之和 ${sum}s 不得超过全局墙钟并集 ${all.totals.totalSeconds}s（不得乘文件数）`);
        // 路径是相对 cwd 的证据路径（fileEvidenceOf 转换过），不是绝对路径、不含盘符。
        for (const row of all.files) {
            assert.doesNotMatch(row.path, /^[A-Za-z]:[\\/]/, '文件证据路径应为相对 cwd 的路径');
        }
    }
    finally {
        await boot1.teardown();
    }
});

test('E2E: 无任何工具事件时 files[] 为空数组，不编造文件行', async () => {
    const boot1 = await boot();
    try {
        const { webServer } = boot1;
        const all = await callSummary(webServer, 'preset=all');
        assert.ok(Array.isArray(all.files), 'files 始终应是数组（哪怕为空）');
        assert.equal(all.files.length, 0, '没有活跃区间就不该凭空出现文件行');
    }
    finally {
        await boot1.teardown();
    }
});
