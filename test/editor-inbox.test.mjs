/**
 * 本地编辑器接入协议单测（node:test，零第三方依赖）。
 *
 * 用真实的临时目录 + node:fs/promises 跑，验证 helper 原子写 + 消费者严校验 +
 * 幂等 + 人工归因克制 + 坏文件隔离 + sink 失败重试。不读工程代码正文。
 *
 * 运行：`node --test test/editor-inbox.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    consumeEditorInbox,
    validateEditorEvent,
    resolveInboxDirectory,
    EditorInboxError,
    EDITOR_LIMITS,
} from '../lib/editor-inbox.js';
import {
    writeEditorHeartbeat,
    createEditorHeartbeatWriter,
} from '../integrations/local-editor.js';

const isWindows = process.platform === 'win32';

/** 每个测试一个独立临时存储目录，结束后删除。 */
async function withStorage(fn) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-editor-inbox-'));
    const cwd = path.join(directory, 'project');
    const filePath = path.join(cwd, 'src', 'index.js');
    await fs.mkdir(path.join(cwd, 'src'), { recursive: true });
    await fs.writeFile(filePath, '// placeholder\n', 'utf8');
    try {
        return await fn({ directory, cwd, filePath, profile: 'default' });
    }
    finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

/** 构造一个最小合法事件（默认 source=unknown）。 */
function makeEvent(cwd, filePath, overrides = {}) {
    return {
        id: 'edit-1',
        cwd,
        file: filePath,
        sessionId: 'editor-A',
        runId: 'run-1',
        at: 1_700_000_000_000,
        ...overrides,
    };
}

/** 列出 inbox 根目录里的事件 JSON 文件名（排除 quarantine 子目录）。 */
async function inboxFiles(directory, profile = 'default') {
    const inbox = resolveInboxDirectory({ directory, profile });
    let names;
    try {
        names = await fs.readdir(inbox);
    }
    catch {
        return [];
    }
    return names.filter((n) => n.endsWith('.json'));
}

// ── helper：原子写 / 幂等 / 最小字段 / 路径校验 ────────────────────────────

test('helper 原子写单事件 JSON，文件名 = <id>.json，且不含正文/文本/命令/keys', async () => {
    await withStorage(async ({ directory, cwd, filePath }) => {
        const result = await writeEditorHeartbeat({
            directory,
            event: makeEvent(cwd, filePath),
        });
        assert.equal(result.duplicate, false);
        assert.equal(result.id, 'edit-1');
        assert.ok(result.path.endsWith(path.join('editor-inbox', 'edit-1.json')));

        const raw = await fs.readFile(result.path, 'utf8');
        const parsed = JSON.parse(raw);
        assert.equal(parsed.id, 'edit-1');
        assert.equal(parsed.source, 'unknown'); // 默认 unknown
        assert.equal(parsed.v, 1);
        assert.equal(parsed.cwd, cwd);
        assert.equal(parsed.file, filePath);
        for (const forbidden of ['human', 'content', 'text', 'command', 'keys', 'token']) {
            assert.equal(Object.hasOwn(parsed, forbidden), false, `不该写出 ${forbidden}`);
        }

        // 临时文件不残留。
        const inbox = resolveInboxDirectory({ directory });
        const names = await fs.readdir(inbox);
        assert.deepEqual(names.filter((n) => n.endsWith('.tmp')), []);
        assert.deepEqual(await inboxFiles(directory), ['edit-1.json']);
    });
});

test('helper 重复 id 不覆盖（幂等）', async () => {
    await withStorage(async ({ directory, cwd, filePath }) => {
        const first = await writeEditorHeartbeat({
            directory,
            event: makeEvent(cwd, filePath, { source: 'unknown' }),
        });
        const second = await writeEditorHeartbeat({
            directory,
            event: makeEvent(cwd, filePath, { source: 'human', provenance: { kind: 'keyboard', explicit: true } }),
        });
        assert.equal(second.duplicate, true);
        const parsed = JSON.parse(await fs.readFile(first.path, 'utf8'));
        assert.equal(parsed.source, 'unknown'); // 原文件未被覆盖
        assert.deepEqual(await inboxFiles(directory), ['edit-1.json']);
    });
});

test('createEditorHeartbeatWriter 绑定目录/profile，工厂期即校验配置', async () => {
    await withStorage(async ({ directory, cwd, filePath }) => {
        const write = createEditorHeartbeatWriter({ directory, profile: 'default' });
        const result = await write(makeEvent(cwd, filePath, { id: 'edit-2' }));
        assert.equal(result.duplicate, false);
        assert.deepEqual(await inboxFiles(directory), ['edit-2.json']);

        assert.throws(
            () => createEditorHeartbeatWriter({ directory, profile: '../escape' }),
            (error) => error instanceof EditorInboxError && error.code === 'E_PROFILE',
        );
    });
});

test('helper 拒绝 file 逃逸出 cwd / 相对路径 / 凭据字段', async () => {
    await withStorage(async ({ directory, cwd, filePath }) => {
        await assert.rejects(
            writeEditorHeartbeat({ directory, event: makeEvent(cwd, filePath, { file: path.join(directory, 'other', 'x.js') }) }),
            (error) => error instanceof EditorInboxError && error.code === 'E_PATH_SCOPE',
        );
        await assert.rejects(
            writeEditorHeartbeat({ directory, event: makeEvent(cwd, filePath, { cwd: 'relative/path' }) }),
            (error) => error instanceof EditorInboxError && error.code === 'E_PATH_SCOPE',
        );
        await assert.rejects(
            writeEditorHeartbeat({ directory, event: { ...makeEvent(cwd, filePath), content: 'secret code' } }),
            (error) => error instanceof EditorInboxError && error.code === 'E_FORBIDDEN_FIELD',
        );
        assert.deepEqual(await inboxFiles(directory), []); // 非法事件一律不落盘
    });
});

// ── 消费者：enabled 默认 false / unknown 不升级 / 有效源消费一次 ─────────────

test('enabled 缺省 false：source=human 也不产 human，降级 unknown', async () => {
    await withStorage(async ({ directory, cwd, filePath }) => {
        await writeEditorHeartbeat({
            directory,
            event: makeEvent(cwd, filePath, {
                source: 'human',
                provenance: { kind: 'keyboard', explicit: true },
            }),
        });
        const seen = [];
        const result = await consumeEditorInbox({ directory, onEvent: (e) => seen.push(e) });
        assert.equal(result.consumed, 1);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].human, false);
        assert.equal(seen[0].source, 'unknown');
        assert.equal(seen[0].declaredSource, 'human');
        assert.deepEqual(await inboxFiles(directory), []); // 成功后删除
    });
});

test('未知来源（source=unknown）永不升级成 human，即使 enabled=true', async () => {
    await withStorage(async ({ directory, cwd, filePath }) => {
        await writeEditorHeartbeat({ directory, event: makeEvent(cwd, filePath) });
        const seen = [];
        await consumeEditorInbox({ directory, enabled: true, onEvent: (e) => seen.push(e) });
        assert.equal(seen[0].human, false);
        assert.equal(seen[0].source, 'unknown');
    });
});

test('valid 显式输入证据 + enabled=true 才 human，并稳定 id 投递一次', async () => {
    await withStorage(async ({ directory, cwd, filePath }) => {
        await writeEditorHeartbeat({
            directory,
            event: makeEvent(cwd, filePath, {
                id: 'edit-9',
                source: 'human',
                provenance: { kind: 'keyboard', explicit: true },
            }),
        });
        const seen = [];
        const first = await consumeEditorInbox({ directory, enabled: true, onEvent: (e) => seen.push(e) });
        assert.equal(first.consumed, 1);
        assert.equal(seen[0].human, true);
        assert.equal(seen[0].source, 'human');
        assert.equal(seen[0].id, 'edit-9'); // 稳定 id 交给 tracker 幂等
        assert.deepEqual(await inboxFiles(directory), []);

        // 第二轮：目录已空，不重复投递。
        const second = await consumeEditorInbox({ directory, enabled: true, onEvent: (e) => seen.push(e) });
        assert.equal(second.consumed, 0);
        assert.equal(seen.length, 1);
    });
});

test('enabled=true 但 provenance 是文件变化类（fs.watch/保存）→ 降级 unknown', async () => {
    await withStorage(async ({ directory, cwd, filePath }) => {
        await writeEditorHeartbeat({
            directory,
            event: makeEvent(cwd, filePath, {
                source: 'human',
                provenance: { kind: 'fs.watch', explicit: true }, // 非白名单输入模态
            }),
        });
        const seen = [];
        await consumeEditorInbox({ directory, enabled: true, onEvent: (e) => seen.push(e) });
        assert.equal(seen[0].human, false);
        assert.equal(seen[0].source, 'unknown');
    });
});

test('enabled=true 但 provenance.explicit 非 true → 不产 human', async () => {
    await withStorage(async ({ directory, cwd, filePath }) => {
        await writeEditorHeartbeat({
            directory,
            event: makeEvent(cwd, filePath, {
                source: 'human',
                provenance: { kind: 'keyboard', explicit: false },
            }),
        });
        const seen = [];
        await consumeEditorInbox({ directory, enabled: true, onEvent: (e) => seen.push(e) });
        assert.equal(seen[0].human, false);
    });
});

test('validateEditorEvent 直接单元：未知字段 / source 白名单 / id 形态', () => {
    const cwd = isWindows ? 'C:\\work\\proj' : '/work/proj';
    const file = isWindows ? 'C:\\work\\proj\\a.js' : '/work/proj/a.js';
    const base = { id: 'x-1', cwd, file, sessionId: 'editor', runId: 'r', at: 1 };

    assert.equal(validateEditorEvent({ ...base, source: 'unknown' }, { enabled: false }).source, 'unknown');
    assert.throws(
        () => validateEditorEvent({ ...base, source: 'wakatime' }, { enabled: false }),
        (error) => error instanceof EditorInboxError && error.code === 'E_SOURCE',
    );
    assert.throws(
        () => validateEditorEvent({ ...base, bogus: 1 }, { enabled: false }),
        (error) => error instanceof EditorInboxError && error.code === 'E_SCHEMA',
    );
    assert.throws(
        () => validateEditorEvent({ ...base, id: '../evil' }, { enabled: false }),
        (error) => error instanceof EditorInboxError && error.code === 'E_ID',
    );
});

// ── 消费者：坏 json / 超大 / 路径逃逸 / 符号链接防护 ────────────────────────

test('坏 JSON 被隔离到 quarantine/，不投递', async () => {
    await withStorage(async ({ directory }) => {
        const inbox = resolveInboxDirectory({ directory });
        await fs.mkdir(inbox, { recursive: true });
        await fs.writeFile(path.join(inbox, 'bad-1.json'), '{not json', 'utf8');
        const seen = [];
        const result = await consumeEditorInbox({ directory, onEvent: (e) => seen.push(e) });
        assert.equal(result.quarantined, 1);
        assert.equal(result.consumed, 0);
        assert.equal(seen.length, 0);
        const q = await fs.readdir(path.join(inbox, 'quarantine'));
        assert.equal(q.length, 1);
        assert.deepEqual(await inboxFiles(directory), []); // 根目录已清空
    });
});

test('超大文件被隔离，有限体积上限生效', async () => {
    await withStorage(async ({ directory }) => {
        const inbox = resolveInboxDirectory({ directory });
        await fs.mkdir(inbox, { recursive: true });
        await fs.writeFile(path.join(inbox, 'huge-1.json'), 'x'.repeat(EDITOR_LIMITS.maxFileBytes + 1), 'utf8');
        const result = await consumeEditorInbox({ directory, onEvent: () => {} });
        assert.equal(result.quarantined, 1);
        assert.equal(result.consumed, 0);
    });
});

test('路径逃逸事件（file 不在 cwd 内）被隔离，不投递', async () => {
    await withStorage(async ({ directory, cwd }) => {
        const inbox = resolveInboxDirectory({ directory });
        await fs.mkdir(inbox, { recursive: true });
        const evil = {
            id: 'escape-1', cwd,
            file: path.join(directory, 'secret', 'key.pem'), // 绝对路径但逃出 cwd
            sessionId: 'editor', runId: 'r', at: 1, source: 'human',
            provenance: { kind: 'keyboard', explicit: true },
        };
        await fs.writeFile(path.join(inbox, 'escape-1.json'), JSON.stringify(evil), 'utf8');
        const seen = [];
        const result = await consumeEditorInbox({ directory, enabled: true, onEvent: (e) => seen.push(e) });
        assert.equal(result.quarantined, 1);
        assert.equal(seen.length, 0);
    });
});

test('符号链接被隔离且不跟随（绝不读链接目标内容）', async () => {
    await withStorage(async ({ directory }) => {
        const inbox = resolveInboxDirectory({ directory });
        await fs.mkdir(inbox, { recursive: true });
        const outside = path.join(directory, 'outside.txt');
        await fs.writeFile(outside, 'SHOULD-NOT-BE-READ', 'utf8');
        try {
            await fs.symlink(outside, path.join(inbox, 'link-1.json'));
        }
        catch (error) {
            if (error?.code === 'EPERM' || error?.code === 'EACCES') {
                // Windows 无 symlink 权限：跳过该防护分支（其余测试仍覆盖）。
                return;
            }
            throw error;
        }
        const seen = [];
        const result = await consumeEditorInbox({ directory, onEvent: (e) => seen.push(e) });
        assert.equal(result.quarantined, 1);
        assert.equal(seen.length, 0);
        assert.equal(await fs.readFile(outside, 'utf8'), 'SHOULD-NOT-BE-READ'); // 目标未被改动/读取为事件
    });
});

test('profile 不可逃逸（.. / 分隔符 / 绝对路径）', () => {
    const directory = isWindows ? 'C:\\dsh\\store' : '/dsh/store';
    assert.equal(path.basename(resolveInboxDirectory({ directory, profile: 'web' })), 'editor-inbox');
    for (const profile of ['../escape', 'a/b', '..', '.hidden', 'C:\\evil']) {
        assert.throws(
            () => resolveInboxDirectory({ directory, profile }),
            (error) => error instanceof EditorInboxError && error.code === 'E_PROFILE',
            `profile=${profile} 应被拒`,
        );
    }
});

// ── 消费者：sink 失败保留可重试 / 批次上限 / 目录不存在 ─────────────────────

test('sink 抛错 → 保留文件下轮重试，成功后再删除', async () => {
    await withStorage(async ({ directory, cwd, filePath }) => {
        await writeEditorHeartbeat({ directory, event: makeEvent(cwd, filePath) });
        const seen = [];
        const first = await consumeEditorInbox({
            directory,
            onEvent: () => { throw new Error('tracker 暂不可用'); },
        });
        assert.equal(first.failed, 1);
        assert.equal(first.consumed, 0);
        assert.deepEqual(await inboxFiles(directory), ['edit-1.json']); // 仍在，可重试

        const second = await consumeEditorInbox({ directory, onEvent: (e) => seen.push(e) });
        assert.equal(second.consumed, 1);
        assert.equal(seen.length, 1);
        assert.deepEqual(await inboxFiles(directory), []);
    });
});

test('onEvent 不是函数时抛错且不消费（不静默删除事件）', async () => {
    await withStorage(async ({ directory }) => {
        await assert.rejects(
            consumeEditorInbox({ directory, onEvent: null }),
            (error) => error instanceof EditorInboxError && error.code === 'E_OPTIONS',
        );
    });
});

test('单轮批次上限：超出 maxBatch 的文件保留到下一轮', async () => {
    await withStorage(async ({ directory, cwd, filePath }) => {
        for (let i = 0; i < 3; i += 1) {
            await writeEditorHeartbeat({
                directory,
                event: makeEvent(cwd, filePath, { id: `edit-${i}` }),
            });
        }
        const seen = [];
        const first = await consumeEditorInbox({ directory, maxBatch: 2, onEvent: (e) => seen.push(e) });
        assert.equal(first.consumed, 2);
        assert.equal(first.skipped, 1);
        assert.equal((await inboxFiles(directory)).length, 1);
        const second = await consumeEditorInbox({ directory, maxBatch: 2, onEvent: (e) => seen.push(e) });
        assert.equal(second.consumed, 1);
        assert.equal(seen.length, 3);
    });
});

test('inbox 目录不存在时返回全 0，不报错（首次轮询）', async () => {
    await withStorage(async ({ directory }) => {
        const result = await consumeEditorInbox({ directory, onEvent: () => {} });
        assert.deepEqual(result, { scanned: 0, consumed: 0, quarantined: 0, failed: 0, skipped: 0 });
    });
});
