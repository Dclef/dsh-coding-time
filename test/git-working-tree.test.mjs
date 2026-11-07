/**
 * dsh-coding-time · 只读 Git 读取器回归（node:test）。
 *
 * 两部分：
 * 1. `parsePorcelainV1Z` / `parseNumstatZ` 的纯解析回归 —— 输入用**真实 NUL 字节**
 *    拼装，形状取自 `git status --porcelain=v1 -z` 与 `git diff --numstat -z` 的
 *    文档与实测输出。
 * 2. 真实临时 Git 仓库的端到端用例（只在 os.tmpdir 下 mkdtemp），验证已暂存
 *    rename 的 old/new 与行数、未跟踪行数为 null、扫描前后 index 未变。
 *
 * **协议依据（实测，不要按印象改）**：`git diff --numstat -z` 在重命名时输出的是
 * `<a>\t<d>\t\0<old>\0<new>\0` —— **旧路径在前、新路径在后**，与
 * `git status --porcelain=v1 -z` 的 `XY <new>\0<old>\0` 正好相反。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseNumstatZ, parsePorcelainV1Z, scanGitWorkingTree } from '../lib/git-working-tree.js';

/** 用真实的 NUL 字节拼出 -z 输出（结尾不带换行，与 git 一致）。 */
function z(...fields) {
    return fields.join('\u0000');
}

// ---------------------------------------------------------------------------
// 纯解析回归
// ---------------------------------------------------------------------------

test('status: 空格/中文/制表符路径原样保真，NUL 分段不串味', () => {
    const raw = z(
        '?? 空 格 文件.txt',
        '?? 中文/目录/文件.md',
        ' M tab\there.txt',
        '',
    );
    const parsed = parsePorcelainV1Z(raw);

    assert.deepEqual(parsed.map((entry) => entry.path), ['空 格 文件.txt', '中文/目录/文件.md', 'tab\there.txt']);
    assert.deepEqual(parsed.map((entry) => entry.status), ['untracked', 'untracked', 'modified']);
    assert.equal(parsed[0].path.includes(' '), true);
    assert.equal(parsed[2].path, 'tab\there.txt');
    assert.deepEqual(parsed.map((entry) => entry.oldPath), [null, null, null]);

    assert.deepEqual(parsePorcelainV1Z(''), []);
    assert.deepEqual(parsePorcelainV1Z(z('')), []);
    assert.deepEqual(parsePorcelainV1Z(z('XY')), []);
});

test('status: 已暂存 rename 读作 new\\0old，new 是 path、old 是 oldPath', () => {
    // git mv 后：`R  <new>\0<old>\0`
    const parsed = parsePorcelainV1Z(z('R  renamed new.txt', '原 文件.txt', ' M other.txt', ''));

    assert.equal(parsed.length, 2, 'old 路径作为独立字段被吃掉，不能多出一条记录');
    assert.equal(parsed[0].path, 'renamed new.txt');
    assert.equal(parsed[0].oldPath, '原 文件.txt');
    assert.equal(parsed[0].status, 'renamed');
    assert.equal(parsed[0].indexStatus, 'R');
    assert.equal(parsed[1].path, 'other.txt', 'rename 之后的记录不能错位');
    assert.equal(parsed[1].oldPath, null);
});

test('status: UU 等冲突码归为 conflicted，不误判成 modified', () => {
    const parsed = parsePorcelainV1Z(z('UU merge.txt', 'AA both-added.txt', 'DU deleted-by-us.txt', ''));

    assert.deepEqual(parsed.map((entry) => entry.status), ['conflicted', 'conflicted', 'conflicted']);
    assert.deepEqual(parsed.map((entry) => entry.path), ['merge.txt', 'both-added.txt', 'deleted-by-us.txt']);
});

test('numstat: 普通记录解析出 added/deleted 数值', () => {
    const map = parseNumstatZ(z('12\t3\tsrc/app.js', '0\t7\tdeleted/lines.ts', ''));

    assert.equal(map.size, 2);
    assert.deepEqual(map.get('src/app.js'), { addedLines: 12, deletedLines: 3, binary: false, oldPath: null });
    assert.deepEqual(map.get('deleted/lines.ts'), { addedLines: 0, deletedLines: 7, binary: false, oldPath: null });

    assert.equal(parseNumstatZ('').size, 0);
});

test('numstat: 二进制 `-\\t-` 记 binary 且行数为 null（绝不退化成 0）', () => {
    const map = parseNumstatZ(z('-\t-\tassets/logo.png', '5\t0\tnormal.txt', ''));

    const binary = map.get('assets/logo.png');
    assert.equal(binary.binary, true);
    assert.equal(binary.addedLines, null);
    assert.equal(binary.deletedLines, null);
    assert.equal(map.get('normal.txt').binary, false);
    assert.equal(map.get('normal.txt').addedLines, 5);
    assert.notEqual(binary.addedLines, 0, '未知行数不能写成 0');
});

test('numstat: rename 为 `\\0<old>\\0<new>\\0`（真实 git 顺序），Map 以 new 为键', () => {
    // 真实 `git diff --numstat -z HEAD`：`<a>\t<d>\t\0<old>\0<new>\0`
    const map = parseNumstatZ(z('1\t0\t', 'old name.txt', 'new name.txt', '', '4\t2\tplain.txt', ''));

    assert.equal(map.size, 2, 'old/new 两个字段都要被消费，不能多出一条');
    assert.deepEqual(map.get('new name.txt'), { addedLines: 1, deletedLines: 0, binary: false, oldPath: 'old name.txt' });
    assert.equal(map.has('old name.txt'), false, '不能以旧路径为键');
    assert.deepEqual(map.get('plain.txt'), { addedLines: 4, deletedLines: 2, binary: false, oldPath: null });
});

// ---------------------------------------------------------------------------
// 真实临时 Git 仓库（只碰 os.tmpdir 下自建目录）
// ---------------------------------------------------------------------------

const FIXTURE_PREFIX = 'dct-gitreader-';
const IDENTITY = ['-c', 'user.name=dct-test', '-c', 'user.email=dct-test@example.invalid'];
const execFileAsync = promisify(execFile);

/** 在临时仓库里跑 git（永远带临时身份与禁系统配置）。 */
function git(cwd, ...args) {
    return execFileAsync('git', [...IDENTITY, ...args], {
        cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
}

/** 建一个自建临时仓库，并保证只清理自己前缀的目录。 */
async function makeRepo(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), FIXTURE_PREFIX));
    t.after(async () => {
        // 只清理"确实由本测试创建"的目录：前缀必须匹配。
        if (!path.basename(dir).startsWith(FIXTURE_PREFIX)) return;
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    });
    const resolved = await fs.realpath(dir);
    await git(resolved, 'init', '-q');
    // 只作用于本临时仓库；不写 global，不影响用户任何仓库。
    await git(resolved, 'config', 'core.autocrlf', 'false');
    await git(resolved, 'config', 'diff.renames', 'true');
    await git(resolved, 'config', 'status.renames', 'true');
    return resolved;
}

/** 索引文件哈希（扫描前后对比"只读"）。 */
async function indexDigest(repoRoot) {
    const bytes = await fs.readFile(path.join(repoRoot, '.git', 'index'));
    return createHash('sha256').update(bytes).digest('hex');
}

/** 从真实 numstat 输出里取出某路径的 added/deleted（自己解析，不复用被测实现）。 */
function realNumstatOf(raw, targetPath) {
    const fields = raw.split('\u0000');
    for (let i = 0; i < fields.length; i += 1) {
        const entry = fields[i];
        if (entry === undefined || entry === '') continue;
        const first = entry.indexOf('\t');
        const second = first === -1 ? -1 : entry.indexOf('\t', first + 1);
        if (first === -1 || second === -1) continue;
        const added = entry.slice(0, first);
        const deleted = entry.slice(first + 1, second);
        const pathField = entry.slice(second + 1);
        let name = pathField;
        if (pathField === '') {
            // 真实顺序：old 在前、new 在后。
            name = fields[i + 2] ?? '';
            i += 2;
        }
        if (name !== targetPath) continue;
        return {
            addedLines: added === '-' ? null : Number(added),
            deletedLines: deleted === '-' ? null : Number(deleted),
            binary: added === '-' && deleted === '-',
        };
    }
    return null;
}

test('真实仓库：已暂存 rename 有 old/new 与真实行数，未跟踪为 null，扫描前后 index 不变', async (t) => {
    const repo = await makeRepo(t);

    await fs.writeFile(path.join(repo, 'keep.txt'), 'one\ntwo\n');
    await fs.writeFile(path.join(repo, 'old-name.txt'), 'alpha\nbeta\ngamma\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', 'init');

    // 已暂存 rename（git mv），并在新路径上追加 1 行 → 工作区相对 HEAD 净新增 1 行。
    await git(repo, 'mv', 'old-name.txt', 'new-name.txt');
    await fs.writeFile(path.join(repo, 'new-name.txt'), 'alpha\nbeta\ngamma\ndelta\n');
    // 未跟踪文件：行数无法证实 → null。
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'u1\nu2\n');
    await fs.writeFile(path.join(repo, '空 格.txt'), 'zh\n');

    // 真值来自同一 fixture 的真实 git 输出，不凭印象。
    const numstatRaw = (await git(repo, 'diff', '--numstat', '-z', 'HEAD')).stdout;
    const expected = realNumstatOf(numstatRaw, 'new-name.txt');
    assert.ok(expected, '真实 git 输出里必须有 new-name.txt 的 numstat 条目');
    assert.equal(expected.addedLines, 1, '真实 git 认为 rename 后净新增 1 行');
    assert.equal(expected.deletedLines, 0);

    const before = await indexDigest(repo);
    const snapshot = await scanGitWorkingTree(repo);
    const after = await indexDigest(repo);

    assert.equal(after, before, '扫描必须只读：.git/index 哈希前后一致');
    assert.equal(snapshot.status, 'ok');
    assert.ok(snapshot.repoRoot.length > 0);

    const renamed = snapshot.files.find((file) => file.path === 'new-name.txt');
    assert.ok(renamed, 'rename 后应以新路径出现');
    assert.equal(renamed.oldPath, 'old-name.txt', 'oldPath 必须是旧路径');
    assert.equal(renamed.status, 'renamed');
    assert.equal(renamed.addedLines, expected.addedLines, '行数必须与真实 git numstat 一致');
    assert.equal(renamed.deletedLines, expected.deletedLines);

    const untracked = snapshot.files.find((file) => file.path === 'untracked.txt');
    assert.ok(untracked);
    assert.equal(untracked.status, 'untracked');
    assert.equal(untracked.addedLines, null, '未跟踪行数无法证实，必须是 null 而不是 0');
    assert.equal(untracked.deletedLines, null);

    assert.ok(snapshot.files.some((file) => file.path === '空 格.txt'), '中文带空格路径要能原样出来');
});

test('真实仓库：maxEntries 截断标记正确，默认 exclude 过滤 node_modules', async (t) => {
    const repo = await makeRepo(t);

    await fs.writeFile(path.join(repo, 'tracked.txt'), 'x\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', 'init');

    await fs.writeFile(path.join(repo, 'a.txt'), '1\n');
    await fs.writeFile(path.join(repo, 'b.txt'), '2\n');
    await fs.writeFile(path.join(repo, 'c.txt'), '3\n');
    await fs.mkdir(path.join(repo, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(repo, 'node_modules', 'dep.js'), 'module\n');

    const truncated = await scanGitWorkingTree(repo, { maxEntries: 2 });
    assert.equal(truncated.truncated, true, '超过 maxEntries 必须标记 truncated');
    assert.equal(truncated.files.length, 2);

    const full = await scanGitWorkingTree(repo);
    assert.equal(full.truncated, false);
    assert.equal(full.files.some((file) => file.path.includes('node_modules')), false, '默认 exclude 过滤 node_modules');
    assert.deepEqual(
        full.files.filter((file) => file.status === 'untracked').map((file) => file.path).sort(),
        ['a.txt', 'b.txt', 'c.txt'],
    );
});
