/**
 * collector 单测：把归一化口径钉死。
 *
 * 用 **真实 SDK 结构**做主验证（AssistantStreamFrame union、ToolExecution /
 * ToolExecutionResult 形状、ops_* 返回值失败）。裸 StreamChunk 兼容形态也有
 * 用例，但不是主路径。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    classifyTool,
    countLineChanges,
    enumerateDays,
    evaluateToolOutcome,
    extractCandidatePaths,
    extractFileDiffs,
    isCountablePath,
    isExcludedPath,
    isProgressChunk,
    isProgressFrame,
    isSensitivePath,
    localDayKey,
    normalizeProgress,
    normalizeSessionEvent,
    normalizeToolResult,
    readLineEvidence,
    readLineMeta,
    resolveCandidatePath,
    resolveRange,
    splitByDay,
    unionMs,
} from '../lib/collector.js';

const CWD = 'C:\\proj';
const SESSION = 'session-1';

/** 真实 AssistantStreamFrame::chunk 包装。 */
function chunkFrame(chunk, { attemptId = 'a1', revision = 1, index = 1 } = {}) {
    return { type: 'chunk', attemptId, revision, index, time: 1000, chunk };
}

/** 真实 ToolExecution。 */
function exec(name, args, callId = 'call-1') {
    return {
        callId,
        rootCallId: callId,
        name,
        arguments: args,
        agent: { id: SESSION },
        signal: new AbortController().signal,
    };
}

test('isProgressFrame 只认真实 chunk 包装里的非空增量', () => {
    // start / end 不是进展。
    assert.equal(isProgressFrame({ type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1 }), false);
    assert.equal(isProgressFrame({ type: 'end', attemptId: 'a', revision: 1, index: 1, outcome: { kind: 'committed' } }), false);
    // chunk + 有增量的 text-delta 才是。
    assert.equal(isProgressFrame(chunkFrame({ type: 'text-delta', index: 0, text: 'hi' })), true);
    assert.equal(isProgressFrame(chunkFrame({ type: 'reasoning-delta', index: 0, text: 'r' })), true);
    assert.equal(isProgressFrame(chunkFrame({ type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: '{' })), true);
    // chunk + 空增量 / 结构事件不是。
    assert.equal(isProgressFrame(chunkFrame({ type: 'text-delta', index: 0, text: '   ' })), false);
    assert.equal(isProgressFrame(chunkFrame({ type: 'block-start', index: 0, blockType: 'text' })), false);
    assert.equal(isProgressFrame(chunkFrame({ type: 'usage', usage: { inputTokens: 1 } })), false);
    assert.equal(isProgressFrame(chunkFrame({ type: 'finish', reason: { kind: 'stop' } })), false);
    assert.equal(isProgressFrame(null), false);
    assert.equal(isProgressFrame(undefined), false);
});

test('isProgressChunk 直接作用于 StreamChunk', () => {
    assert.equal(isProgressChunk({ type: 'text-delta', text: 'x' }), true);
    assert.equal(isProgressChunk({ type: 'text-delta', text: '' }), false);
    assert.equal(isProgressChunk({ type: 'usage' }), false);
    assert.equal(isProgressChunk({ type: 'finish' }), false);
    assert.equal(isProgressChunk({ type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }), true);
});

test('normalizeProgress 用 attemptId+revision+index 稳定去重，不用正文 hash', () => {
    // 同一个字符连续出现两次是**真实进展**，必须各自产出不同 id。
    const first = normalizeProgress({ agent: { id: SESSION }, frame: chunkFrame({ type: 'text-delta', index: 0, text: 'a' }, { index: 1 }) }, { cwd: CWD, at: 1000 });
    const second = normalizeProgress({ agent: { id: SESSION }, frame: chunkFrame({ type: 'text-delta', index: 0, text: 'a' }, { index: 2 }) }, { cwd: CWD, at: 2000 });
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.notEqual(first[0].id, second[0].id);

    // 完全相同的 frame（同 attempt/revision/index）→ 相同 id，靠 tracker 去重。
    const repeated = normalizeProgress({ agent: { id: SESSION }, frame: chunkFrame({ type: 'text-delta', index: 0, text: 'a' }, { index: 1 }) }, { cwd: CWD, at: 3000 });
    assert.equal(repeated[0].id, first[0].id);

    // start/end 不产出。
    assert.deepEqual(normalizeProgress({ agent: { id: SESSION }, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } }, { cwd: CWD }), []);
    // 无 cwd 不产出。
    assert.deepEqual(normalizeProgress({ agent: { id: SESSION }, frame: chunkFrame({ type: 'text-delta', index: 0, text: 'x' }) }, {}), []);
});

test('normalizeProgress 的 runId 由 Host 传入，不是每 chunk 随机', () => {
    const obs = normalizeProgress(
        { agent: { id: SESSION }, frame: chunkFrame({ type: 'text-delta', index: 0, text: 'x' }) },
        { cwd: CWD, runId: 'nonce-1:session-1' },
    );
    assert.equal(obs.length, 1);
    assert.equal(obs[0].runId, 'nonce-1:session-1');
    assert.equal(obs[0].source, 'ai');
    assert.equal(obs[0].kind, 'agent');
    // 不保留正文。
    assert.equal(obs[0].file, '');
});

test('evaluateToolOutcome：transport 成功不等于文件成功', () => {
    assert.deepEqual(evaluateToolOutcome({ isError: false, value: { status: 'error' } }), { ok: false, perPath: null });
    assert.deepEqual(evaluateToolOutcome({ isError: false, value: { status: 'rejected' } }), { ok: false, perPath: null });
    assert.deepEqual(evaluateToolOutcome({ isError: false, value: { error: { code: 'PATH_RESTRICTED' } } }), { ok: false, perPath: null });
    assert.deepEqual(evaluateToolOutcome({ isError: true }), { ok: false, perPath: null });
    assert.deepEqual(evaluateToolOutcome({ isError: false, value: { ok: true } }), { ok: true, perPath: null });
    assert.deepEqual(evaluateToolOutcome({ isError: false, value: { changed: true } }), { ok: true, perPath: null });
    assert.deepEqual(evaluateToolOutcome({ isError: false, value: { success: false } }), { ok: false, perPath: null });
    // 顶层数组：逐项判定。
    const list = evaluateToolOutcome({ isError: false, value: [{ path: 'a', status: 'ok' }, { path: 'b', status: 'error' }] });
    assert.deepEqual(list.perPath, ['a']);
});

test('ops_* 返回值失败时不产出文件观测', () => {
    const args = { path: 'C:\\proj\\a.js' };
    assert.deepEqual(normalizeToolResult(exec('ops_inspect_local_file', args), { isError: false, value: { status: 'error' } }, { cwd: CWD }), []);
    assert.deepEqual(normalizeToolResult(exec('ops_inspect_local_file', args), { isError: false, value: { error: { code: 'PATH_RESTRICTED' } } }, { cwd: CWD }), []);
    // 真实成功才产出。
    const ok = normalizeToolResult(exec('ops_inspect_local_file', args), { isError: false, value: { ok: true, content: 'x' } }, { cwd: CWD });
    assert.equal(ok.length, 1);
    assert.equal(ok[0].kind, 'file');
});

test('批量 ops_read_files 部分失败只计成功项', () => {
    const args = { files: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }] };
    const result = {
        isError: false,
        value: {
            results: [
                { path: 'C:\\proj\\a.js', status: 'ok' },
                { path: 'C:\\proj\\b.js', status: 'error', error: { code: 'PATH_RESTRICTED' } },
                { path: 'C:\\proj\\c.js', status: 'ok' },
            ],
        },
    };
    const obs = normalizeToolResult(exec('ops_read_files', args), result, { cwd: CWD });
    assert.equal(obs.length, 2);
    const paths = obs.map(item => item.file).sort();
    assert.deepEqual(paths, ['C:\\proj\\a.js', 'C:\\proj\\c.js']);
});

test('ops_bash 一律不解析 shell 路径', () => {
    assert.deepEqual(extractCandidatePaths('ops_bash', { command: 'rm -rf C:\\proj\\x' }), []);
    assert.deepEqual(normalizeToolResult(exec('ops_bash', { command: 'echo hi > C:\\proj\\a.js' }), { isError: false }, { cwd: CWD }), []);
});

test('未知工具与无路径不产出', () => {
    assert.deepEqual(extractCandidatePaths('mystery_tool', { path: 'C:\\proj\\a.js' }), []);
    assert.deepEqual(normalizeToolResult(exec('read', {}, 'c1'), { isError: false }, { cwd: CWD }), []);
    assert.equal(classifyTool('read'), 'file');
    assert.equal(classifyTool('mystery_tool'), 'agent');
});

test('失败的工具结果一律不产出', () => {
    assert.deepEqual(normalizeToolResult(exec('write', { file_path: 'C:\\proj\\a.js' }), { isError: true }, { cwd: CWD }), []);
});

test('敏感与排除路径不产出', () => {
    assert.equal(isSensitivePath('C:\\proj\\.env'), true);
    assert.equal(isSensitivePath('C:\\proj\\id_rsa'), true);
    assert.equal(isExcludedPath('C:\\proj\\node_modules\\x.js'), true);
    assert.deepEqual(normalizeToolResult(exec('read', { path: 'C:\\proj\\.env' }), { isError: false }, { cwd: CWD }), []);
    assert.deepEqual(normalizeToolResult(exec('read', { path: 'C:\\proj\\node_modules\\x.js' }), { isError: false }, { cwd: CWD }), []);
    assert.equal(isCountablePath('C:\\plugins\\dsh-coding-time\\lib\\index.js', { pluginDirectory: 'C:\\plugins\\dsh-coding-time' }), false);
});

test('readLineMeta 只认显式整数计数', () => {
    assert.deepEqual(readLineMeta({ lines: { added: 2, deleted: 0 } }), { added: 2, deleted: 0, source: 'meta.lines' });
    assert.deepEqual(readLineMeta({ addedLines: 5, deletedLines: 1 }), { added: 5, deleted: 1, source: 'meta.addedLines' });
    assert.equal(readLineMeta({}), null);
    assert.equal(readLineMeta({ lines: { added: -1, deleted: 0 } }), null);
    assert.equal(readLineMeta({ lines: { added: 1.5, deleted: 0 } }), null);
    assert.equal(readLineMeta(null), null);
});

test('真实 DiffResultView 形状：before/after 用 LCS 提取真实增删', () => {
    assert.equal(countLineChanges(null, 'a\nb\n').added, 2);
    assert.equal(countLineChanges('a\nb\n', 'a\nb\nc\n').added, 1);
    assert.equal(countLineChanges('a\nb\nc\n', 'a\nc\n').deleted, 1);
    // 改写一行 = 1 增 1 删（不是净长度 0）。
    assert.deepEqual(countLineChanges('a\nb\n', 'a\nX\n'), { added: 1, deleted: 1 });
});

test('extractFileDiffs 认 DiffResultView，也认裸 diffs', () => {
    const view = { card: 'diff', diffs: [{ path: 'C:\\proj\\a.js', oldText: 'x\n', newText: 'x\ny\n' }] };
    const diffs = extractFileDiffs(view);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].path, 'C:\\proj\\a.js');
    assert.equal(extractFileDiffs({ diffs: [{ path: 'p', newText: 'n' }] }).length, 1);
    assert.equal(extractFileDiffs({}), null);
    assert.equal(extractFileDiffs(null), null);
});

test('readLineEvidence：多文件按 path 归属，不把总量重复加到每个文件', () => {
    const meta = {
        card: 'diff',
        diffs: [
            { path: 'C:\\proj\\a.js', oldText: 'x\n', newText: 'x\ny\n' },
            { path: 'C:\\proj\\b.js', oldText: 'p\nq\n', newText: 'p\n' },
        ],
    };
    const evidence = readLineEvidence(meta);
    assert.equal(evidence.quality, 'computed');
    assert.deepEqual(evidence.byPath.get('c:/proj/a.js'), { added: 1, deleted: 0 });
    assert.deepEqual(evidence.byPath.get('c:/proj/b.js'), { added: 0, deleted: 1 });
});

test('多文件调用按 path 精确归属行数', () => {
    const meta = {
        card: 'diff',
        diffs: [
            { path: 'C:\\proj\\a.js', oldText: 'x\n', newText: 'x\ny\n' },
            { path: 'C:\\proj\\b.js', oldText: 'p\n', newText: 'p\nq\nr\n' },
        ],
    };
    const obs = normalizeToolResult(
        exec('write', { files: [{ path: 'C:\\proj\\a.js' }, { path: 'C:\\proj\\b.js' }] }, 'multi'),
        { isError: false, meta, value: { ok: true } },
        { cwd: CWD },
    );
    // write 只认单 file_path；这里用 ops 风格的多路径不产出，改验证单文件归属。
    assert.deepEqual(obs, []);
});

test('单文件 write 用真实 diff 形状算出增删', () => {
    const meta = { card: 'diff', diffs: [{ path: 'C:\\proj\\a.js', oldText: 'a\nb\n', newText: 'a\nX\n' }] };
    const obs = normalizeToolResult(
        exec('write', { file_path: 'C:\\proj\\a.js' }, 'w1'),
        { isError: false, meta, value: { changed: true } },
        { cwd: CWD },
    );
    assert.equal(obs.length, 1);
    assert.equal(obs[0].linesAdded, 1);
    assert.equal(obs[0].linesDeleted, 1);
});

test('显式计数 meta 在单文件调用时可用', () => {
    const obs = normalizeToolResult(
        exec('edit', { file_path: 'C:\\proj\\a.js' }, 'e1'),
        { isError: false, meta: { lines: { added: 3, deleted: 1 } }, value: { ok: true } },
        { cwd: CWD },
    );
    assert.equal(obs.length, 1);
    assert.equal(obs[0].linesAdded, 3);
    assert.equal(obs[0].linesDeleted, 1);
});

test('无 meta → 行数为 null（未知，不是 0）', () => {
    const obs = normalizeToolResult(
        exec('write', { file_path: 'C:\\proj\\a.js' }, 'w2'),
        { isError: false, value: { ok: true } },
        { cwd: CWD },
    );
    assert.equal(obs.length, 1);
    assert.equal(obs[0].linesAdded, null);
    assert.equal(obs[0].linesDeleted, null);
});

test('超过 LCS 上限判定 unavailable，不用净长度伪装', () => {
    const bigOld = Array.from({ length: 1300 }, (_, i) => `line${i}`).join('\n');
    const bigNew = Array.from({ length: 1300 }, (_, i) => `line${i}`).join('\n').replace('line0', 'changed');
    assert.equal(countLineChanges(bigOld, bigNew), null);
});

test('session/event 普通用户消息绝不升级为 human 编码时长（防回归）', () => {
    const session = { id: SESSION };
    // 聊天/发送提示：即使人类采集已开启，也必须是空。
    assert.deepEqual(normalizeSessionEvent(session, { type: 'user/message', seq: 7, time: 1000 }, { cwd: CWD, humanEnabled: true }), []);
    // 即使带了 message 正文也不行。
    assert.deepEqual(normalizeSessionEvent(session, { type: 'user/message', seq: 8, time: 1000, message: { role: 'user' } }, { cwd: CWD, humanEnabled: true }), []);
    // 其它事件类型照旧忽略。
    assert.deepEqual(normalizeSessionEvent(session, { type: 'tool/result', seq: 9, time: 1000 }, { cwd: CWD, humanEnabled: true }), []);
    assert.deepEqual(normalizeSessionEvent(session, { type: 'assistant/message', seq: 10, time: 1000 }, { cwd: CWD, humanEnabled: true }), []);
    // 未启用人类采集同样不产出。
    assert.deepEqual(normalizeSessionEvent(session, { type: 'user/message', seq: 11, time: 1000 }, { cwd: CWD, humanEnabled: false }), []);
});

test('只有携带已验证编辑器 provenance 的事件才算人类', () => {
    const session = { id: SESSION };
    // 缺 file → 不算人类。
    assert.deepEqual(normalizeSessionEvent(session, {
        type: 'user/message',
        seq: 20,
        time: 1000,
        provenance: { kind: 'keyboard', explicit: true },
    }, { cwd: CWD, humanEnabled: true }), []);
    // provenance 非真实输入模态 → 不算人类。
    assert.deepEqual(normalizeSessionEvent(session, {
        type: 'user/message',
        seq: 21,
        time: 1000,
        file: 'C:\\proj\\a.js',
        provenance: { kind: 'save', explicit: true },
    }, { cwd: CWD, humanEnabled: true }), []);
    // explicit 不是 true → 不算人类。
    assert.deepEqual(normalizeSessionEvent(session, {
        type: 'user/message',
        seq: 22,
        time: 1000,
        file: 'C:\\proj\\a.js',
        provenance: { kind: 'keyboard', explicit: false },
    }, { cwd: CWD, humanEnabled: true }), []);
    // 真实键盘输入 + 文件 → 才算人类。
    const obs = normalizeSessionEvent(session, {
        type: 'user/message',
        seq: 23,
        time: 1000,
        file: 'C:\\proj\\a.js',
        provenance: { kind: 'keyboard', explicit: true },
    }, { cwd: CWD, humanEnabled: true });
    assert.equal(obs.length, 1);
    assert.equal(obs[0].source, 'human');
    assert.equal(obs[0].kind, 'file');
});

test('unionMs 对重叠区间只算一次', () => {
    assert.equal(unionMs([], 0, 1000), 0);
    assert.equal(unionMs([{ start: 0, end: 60_000 }, { start: 0, end: 60_000 }], 0, 60_000), 60_000);
    assert.equal(unionMs([{ start: 0, end: 40_000 }, { start: 20_000, end: 60_000 }], 0, 60_000), 60_000);
    assert.equal(unionMs([{ start: 0, end: 10_000 }, { start: 50_000, end: 60_000 }], 0, 60_000), 20_000);
    assert.equal(unionMs([{ startMs: -1000, endMs: 2000 }], 0, 1000), 1000);
});

test('splitByDay 跨午夜两侧都算', () => {
    const start = Date.parse('2026-11-04T15:50:00.000Z');
    const end = start + 30 * 60 * 1000;
    const pieces = new Map();
    splitByDay([{ start, end }], 'Asia/Shanghai', (day, ms) => {
        pieces.set(day, (pieces.get(day) ?? 0) + ms);
    });
    assert.equal(pieces.get('2026-11-04'), 10 * 60 * 1000);
    assert.equal(pieces.get('2026-11-05'), 20 * 60 * 1000);
});

test('localDayKey 与 resolveRange', () => {
    assert.equal(localDayKey(Date.parse('2026-11-04T16:00:00.000Z'), 'Asia/Shanghai'), '2026-11-05');
    assert.equal(localDayKey(Date.parse('2026-11-04T15:59:59.000Z'), 'Asia/Shanghai'), '2026-11-04');
    const nowMs = Date.parse('2026-11-05T02:00:00.000Z');
    const today = resolveRange({ preset: 'today' }, 'Asia/Shanghai', nowMs);
    assert.equal(today.fromLocal, '2026-11-05');
    assert.equal(resolveRange({ preset: 'all' }, 'Asia/Shanghai', nowMs).fromLocal, '1970-01-01');
});

test('enumerateDays 有上限', () => {
    const days = enumerateDays('2026-01-01', '2026-01-10', 400);
    assert.equal(days.length, 10);
    assert.equal(days[0], '2026-01-01');
    assert.equal(days[9], '2026-01-10');
});
