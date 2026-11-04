/**
 * dsh-coding-time · 本地编辑器接入的「收件箱消费者」。
 *
 * 这是**本地文件系统上的一段 IPC**，不是一个网络服务：编辑器侧的 helper
 * （integrations/local-editor.js）把单事件原子 JSON 文件写进
 * `<storageDirectory>/<profile>/editor-inbox/`，宿主（Host）在自己的
 * poll/flush 节奏里调 `consumeEditorInbox()` 把事件交给 tracker。
 *
 * 边界（刻意写死，调用方不要绕过）：
 *
 * 1. 零第三方依赖，仅 node 内建；**不监听端口、不发起网络、不读账号/token**。
 * 2. 只 readdir/lstat/readFile 这一个 inbox 目录（非递归），**绝不打开事件里
 *    `file` 指向的工程文件**，不读代码正文/密钥/命令/按键记录。
 * 3. 只处理 lstat 判定的**普通文件**；符号链接一律隔离，绝不跟随。
 * 4. 严格事件 schema 白名单，`content/text/command/keys/token/...` 一律拒收；
 *    cwd/file 必须是本机绝对路径、file 必须落在 cwd 内、profile 不可逃逸。
 * 5. **默认不产 human**：`enabled` 缺省 false（= config.humanTracking.enabled，
 *    由 Host 决定）。只有 `enabled === true` 且接入方给出「显式真实输入」
 *    provenance 时才会 `human: true`；fs.watch / onDidChangeTextDocument /
 *    保存事件 / git 作者 / 文件变更**绝不**被推断成人工，一律降级 `unknown`。
 * 6. `source` / `human` 只是本地接入方的**来源声明**，不是加密证明，也不能据此
 *    声称自动支持 VSCode/Cursor 等外部编辑器。没有真实输入 API 就是「未接入」。
 * 7. sink 成功 → 删除文件；sink 抛错 → 保留文件下轮重试；坏文件 → 移入
 *    `quarantine/` 隔离。稳定 `id` 交给 tracker 做幂等去重（本层不记账）。
 *
 * @module dsh-coding-time/editor-inbox
 */
import { randomBytes } from 'node:crypto';
import fsDefault from 'node:fs/promises';
import path from 'node:path';

/** inbox 目录名（在 `<storageDirectory>/<profile>/` 之下）。 */
export const INBOX_DIRNAME = 'editor-inbox';

/** 默认分区名，与 lib/store.js 的默认 profile 保持一致。 */
export const DEFAULT_PROFILE = 'default';

/** 事件 `source` 白名单。 */
export const EDITOR_SOURCES = Object.freeze(['unknown', 'ai', 'human']);

/**
 * 可被认定为「显式真实人工输入」的 provenance.kind。
 *
 * 只有接入方确实拿到键盘 / 输入法 / 指针编辑这类**输入事件**时才允许使用。
 * 文件变化类信号（fs.watch、onDidChangeTextDocument、保存、git 作者等）不在表内，
 * 出现即降级 unknown。
 */
export const EXPLICIT_INPUT_KINDS = Object.freeze(['keyboard', 'ime', 'pointer-edit']);

/** 体积与批次上限（有限体积，防止异常流把进程撑爆）。 */
export const EDITOR_LIMITS = Object.freeze({
    maxFileBytes: 8 * 1024,
    maxBatch: 64,
    maxIdLength: 128,
    maxPathChars: 4096,
    maxTokenChars: 512,
    maxProvenanceKindChars: 64,
});

/** 事件字段白名单：任何其它键都拒收（尤其正文/凭据/按键）。 */
const EVENT_KEYS = Object.freeze([
    'id', 'cwd', 'file', 'sessionId', 'editorInstanceId', 'runId',
    'at', 'source', 'provenance', 'v',
]);

/** 正文 / 凭据 / 按键类键名，出现即给出明确拒收理由。 */
const FORBIDDEN_KEY = /^(?:content|contents|text|body|message|messages|prompt|prompts|command|commands|keys|key|keystrokes|token|tokens|api[_-]?key|apikey|secret|secrets|password|passwd|passphrase|authorization|cookie|cookies|private[_-]?key|credential|credentials|session[_-]?key|webhook[_-]?url|auth|access[_-]?token|refresh[_-]?token)$/i;

/** id 同时用作文件名 stem：单段安全 token，不以点开头、不含 `..`。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** inbox 文件名：`${id}.json`。 */
const FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;

/** profile 单段安全名，与 lib/store.js 的 PROFILE_PATTERN 同义。 */
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 统一错误：code 供调用方分支，path 指出错字段。 */
export class EditorInboxError extends Error {
    constructor(message, { code = 'invalid', path: fieldPath = '', cause } = {}) {
        super(fieldPath ? `${fieldPath}: ${message}` : message, cause === undefined ? undefined : { cause });
        this.name = 'EditorInboxError';
        this.code = code;
        this.path = fieldPath;
    }
}

/** 普通对象（排除数组/null/Date/Map）。 */
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function typeName(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

function fail(fieldPath, code, message) {
    throw new EditorInboxError(message, { code, path: fieldPath });
}

/** 把路径统一成 `/` 分隔、去尾斜杠的形式，便于跨盘符/跨平台做前缀比对。 */
function toUnified(raw) {
    return raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
}

/** 校验「本机绝对路径」字符串：拒 NUL / ~ / URL / UNC / 相对 / `..` 穿越。 */
function validateLocalAbsolute(value, fieldPath) {
    if (typeof value !== 'string') fail(fieldPath, 'E_SCHEMA', `必须是字符串（收到 ${typeName(value)}）`);
    const raw = value.trim();
    if (raw === '') fail(fieldPath, 'E_SCHEMA', '不能为空');
    if (raw.length > EDITOR_LIMITS.maxPathChars) fail(fieldPath, 'E_TOO_LARGE', '路径过长');
    if (raw.includes('\0')) fail(fieldPath, 'E_PATH_SCOPE', '路径不能含 NUL');
    if (/[\x00-\x1f]/.test(raw)) fail(fieldPath, 'E_PATH_SCOPE', '路径不能含控制字符');
    if (raw.startsWith('~')) fail(fieldPath, 'E_PATH_SCOPE', '不支持 ~ 展开，请写绝对路径');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) fail(fieldPath, 'E_PATH_SCOPE', '不接受 URL，请写本机绝对路径');
    if (raw.startsWith('\\\\') || raw.startsWith('//')) {
        fail(fieldPath, 'E_PATH_SCOPE', '不接受网络共享/UNC 路径，必须是本机绝对路径');
    }
    const looksAbsolute = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw);
    if (!looksAbsolute) fail(fieldPath, 'E_PATH_SCOPE', `必须是本机绝对路径（收到 ${JSON.stringify(raw)}）`);
    const unified = toUnified(raw);
    if (unified.split('/').includes('..')) fail(fieldPath, 'E_PATH_SCOPE', '路径不能含 .. 穿越');
    return { raw, unified };
}

/** 校验 profile：单段安全名，且解析后仍在 directory 内。 */
export function resolveInboxPaths({ directory, profile } = {}) {
    if (directory === undefined || typeof directory !== 'string' || directory.trim() === '') {
        fail('directory', 'E_DIRECTORY', '必须提供本机绝对存储目录');
    }
    const { raw: dirRaw } = validateLocalAbsolute(directory, 'directory');
    const dir = path.normalize(dirRaw);

    let prof = profile === undefined || profile === null ? DEFAULT_PROFILE : profile;
    if (typeof prof !== 'string' || prof.trim() === '') {
        fail('profile', 'E_PROFILE', 'profile 必须是非空字符串');
    }
    prof = prof.trim();
    if (!PROFILE_PATTERN.test(prof) || prof === '.' || prof === '..' || prof.includes('..') || prof.includes('/') || prof.includes('\\')) {
        fail('profile', 'E_PROFILE', `profile 只允许单段安全名 [A-Za-z0-9][A-Za-z0-9._-]{0,63}（收到 ${JSON.stringify(prof)}）`);
    }

    const root = path.join(dir, prof);
    const relative = path.relative(path.resolve(dir), path.resolve(root));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        fail('profile', 'E_PROFILE', 'profile 解析后逃出了存储目录');
    }
    const inbox = path.join(root, INBOX_DIRNAME);
    const inboxRel = path.relative(path.resolve(root), path.resolve(inbox));
    if (inboxRel !== INBOX_DIRNAME) {
        fail('directory', 'E_DIRECTORY', 'inbox 目录解析异常');
    }
    return { directory: dir, profile: prof, root, inbox };
}

/** 便捷入口：返回校验后的绝对 inbox 路径（字符串）。 */
export function resolveInboxDirectory(options = {}) {
    return resolveInboxPaths(options).inbox;
}

/** 读可选短字符串 token（sessionId / editorInstanceId / runId）。 */
function readToken(value, fieldPath, { required = false } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) fail(fieldPath, 'E_SCHEMA', '该字段必填');
        return '';
    }
    if (typeof value !== 'string') fail(fieldPath, 'E_SCHEMA', `必须是字符串（收到 ${typeName(value)}）`);
    const token = value.trim();
    if (token.length > EDITOR_LIMITS.maxTokenChars) fail(fieldPath, 'E_TOO_LARGE', '字段过长');
    if (/[\x00-\x1f]/.test(token)) fail(fieldPath, 'E_SCHEMA', '字段不能含控制字符');
    return token;
}

/** 读 `at`：有限数字(epoch ms) 或可解析的 ISO 字符串 → 整数毫秒。 */
function readAt(value) {
    if (value === undefined || value === null) fail('at', 'E_AT', 'at 必填（epoch 毫秒或 ISO 字符串）');
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail('at', 'E_AT', 'at 必须是有限数字');
        return Math.floor(value);
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const ms = Date.parse(value);
        if (!Number.isFinite(ms)) fail('at', 'E_AT', 'at 不是可解析的时间');
        return ms;
    }
    fail('at', 'E_AT', `at 类型非法（收到 ${typeName(value)}）`);
}

/** 读 `provenance`：可选普通对象，只允许 { kind, explicit }，拒凭据/正文键。 */
function readProvenance(value) {
    if (value === undefined || value === null) return null;
    if (!isPlainObject(value)) fail('provenance', 'E_PROVENANCE', 'provenance 必须是普通对象');
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_KEY.test(key)) fail(`provenance.${key}`, 'E_FORBIDDEN_FIELD', 'provenance 不得包含凭据/正文/按键字段');
        if (key !== 'kind' && key !== 'explicit') fail(`provenance.${key}`, 'E_SCHEMA', 'provenance 只允许 kind / explicit');
    }
    const kind = value.kind;
    if (typeof kind !== 'string' || kind.trim() === '' || kind.trim().length > EDITOR_LIMITS.maxProvenanceKindChars) {
        fail('provenance.kind', 'E_PROVENANCE', 'provenance.kind 必须是非空短字符串');
    }
    const explicit = value.explicit === undefined ? false : value.explicit;
    if (typeof explicit !== 'boolean') fail('provenance.explicit', 'E_PROVENANCE', 'provenance.explicit 必须是布尔值');
    return Object.freeze({ kind: kind.trim(), explicit });
}

/**
 * 共享的 schema / 路径校验：产出「最小可信字段 + declaredSource + provenance」。
 * 不含 human（human 由 classify 结合 enabled 决定），不含 receivedAt。
 */
function parseAndValidate(raw) {
    if (!isPlainObject(raw)) fail('event', 'E_SCHEMA', `事件必须是普通对象（收到 ${typeName(raw)}）`);
    for (const key of Object.keys(raw)) {
        if (FORBIDDEN_KEY.test(key)) fail(key, 'E_FORBIDDEN_FIELD', '事件不得包含正文/凭据/命令/按键字段');
        if (!EVENT_KEYS.includes(key)) fail(key, 'E_SCHEMA', `未知事件字段（合法字段：${EVENT_KEYS.join(', ')}）`);
    }

    // id
    const id = raw.id;
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || id.includes('..') || id.length > EDITOR_LIMITS.maxIdLength) {
        fail('id', 'E_ID', 'id 必须是单段安全 token [A-Za-z0-9][A-Za-z0-9._-]{0,127}，不含 ..');
    }

    // v
    if (raw.v !== undefined && raw.v !== 1) fail('v', 'E_SCHEMA', '事件版本 v 只支持 1');

    // source（白名单，缺省 unknown）
    let declaredSource = 'unknown';
    if (raw.source !== undefined) {
        if (typeof raw.source !== 'string' || !EDITOR_SOURCES.includes(raw.source)) {
            fail('source', 'E_SOURCE', `source 必须是 ${EDITOR_SOURCES.join(' | ')}（收到 ${JSON.stringify(raw.source)}）`);
        }
        declaredSource = raw.source;
    }

    // cwd / file：本机绝对路径，file 必须落在 cwd 内
    const cwd = validateLocalAbsolute(raw.cwd, 'cwd');
    const file = validateLocalAbsolute(raw.file, 'file');
    const key = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
    const cwdKey = key(cwd.unified);
    const fileKey = key(file.unified);
    if (fileKey !== cwdKey && !fileKey.startsWith(`${cwdKey}/`)) {
        fail('file', 'E_PATH_SCOPE', 'file 必须位于 cwd 之内');
    }

    // 会话标识：至少给一个
    const sessionId = readToken(raw.sessionId, 'sessionId');
    const editorInstanceId = readToken(raw.editorInstanceId, 'editorInstanceId');
    if (sessionId === '' && editorInstanceId === '') {
        fail('sessionId', 'E_SCHEMA', 'sessionId / editorInstanceId 至少提供一个');
    }
    const runId = readToken(raw.runId, 'runId', { required: true });

    const at = readAt(raw.at);
    const provenance = readProvenance(raw.provenance);

    return {
        id,
        cwd: cwd.raw,
        file: file.raw,
        sessionId,
        editorInstanceId,
        runId,
        at,
        declaredSource,
        provenance,
        v: 1,
    };
}

/** 依据 enabled + provenance 决定 source / human（绝不从文件变化推断人工）。 */
function classify(declaredSource, provenance, enabled) {
    let source = declaredSource;
    let human = false;
    if (declaredSource === 'human') {
        const explicitInput = enabled === true
            && provenance !== null
            && EXPLICIT_INPUT_KINDS.includes(provenance.kind)
            && provenance.explicit === true;
        if (explicitInput) human = true;
        else source = 'unknown'; // 未启用 / 无真实输入证据 → 绝不升级成 human
    }
    return { source, human };
}

/**
 * 校验并归一化一个**入站**事件（消费者用）。
 *
 * @param raw - 解析后的 JSON 对象。
 * @param options - { now: () => epochMs, enabled: boolean }；enabled 缺省 false。
 * @returns 归一化事件，含稳定 id、source、human、declaredSource、receivedAt。
 * @throws EditorInboxError 校验失败。
 */
export function validateEditorEvent(raw, { now, enabled = false } = {}) {
    const clock = typeof now === 'function' ? now : () => Date.now();
    const base = parseAndValidate(raw);
    const { source, human } = classify(base.declaredSource, base.provenance, enabled);
    return Object.freeze({
        id: base.id,
        cwd: base.cwd,
        file: base.file,
        sessionId: base.sessionId,
        editorInstanceId: base.editorInstanceId,
        runId: base.runId,
        at: base.at,
        source,
        human,
        declaredSource: base.declaredSource,
        provenance: base.provenance,
        receivedAt: clock(),
        v: base.v,
    });
}

/**
 * 校验并归一化一个**出站**事件（helper 写文件用）。
 *
 * 只写最小字段；`source` 是接入方的声明（缺省 unknown），**不写 human**——
 * human 只能由消费者在 Host 控制的 enabled 下决定。
 */
export function normalizeOutboundEvent(raw, { now } = {}) {
    const clock = typeof now === 'function' ? now : () => Date.now();
    const candidate = {
        ...raw,
        at: raw?.at ?? clock(),
        source: raw?.source ?? 'unknown',
        v: raw?.v ?? 1,
        sessionId: raw?.sessionId ?? '',
        editorInstanceId: raw?.editorInstanceId ?? '',
    };
    const base = parseAndValidate(candidate);
    return Object.freeze({
        id: base.id,
        cwd: base.cwd,
        file: base.file,
        sessionId: base.sessionId,
        editorInstanceId: base.editorInstanceId,
        runId: base.runId,
        at: base.at,
        source: base.declaredSource,
        provenance: base.provenance,
        v: base.v,
    });
}

/**
 * 把坏文件从 inbox 移到 `quarantine/`，不再参与投递。
 *
 * symlink 只走 rename（rename 不跟随）；copyFile 会跟随符号链接读目标内容，
 * 因此对 symlink 禁用 copy 兜底，严格满足「不跟随 symlink」。
 */
async function moveToQuarantine(f, inbox, name, clock, { allowCopy = true } = {}) {
    const quarantine = path.join(inbox, 'quarantine');
    try {
        await f.mkdir(quarantine, { recursive: true });
        const src = path.join(inbox, name);
        const dest = path.join(quarantine, `${clock()}-${randomBytes(4).toString('hex')}-${path.basename(name)}`);
        try {
            await f.rename(src, dest);
            return true;
        }
        catch {
            if (!allowCopy) return false;
            await f.copyFile(src, dest);
            await f.unlink(src);
            return true;
        }
    }
    catch {
        return false; // 隔离失败：留在原地，下轮再试（绝不静默丢弃已读到的异常）
    }
}

/**
 * 消费一轮 editor-inbox。
 *
 * 只扫 inbox 根目录（非递归），按文件名稳定排序，最多处理 `maxBatch` 个文件。
 *
 * @param options - {
 *   directory: 本机绝对存储目录;
 *   profile: 分区名（默认 'default'）;
 *   onEvent: (normalizedEvent) => void|Promise，tracker 的 sink;
 *   enabled: 是否允许 human（默认 false，= config.humanTracking.enabled）;
 *   now: () => epochMs（测试注入）;
 *   fs: node:fs/promises 同形态对象（测试注入）;
 *   maxBatch: 单轮最多处理文件数（默认 EDITOR_LIMITS.maxBatch）。
 * }
 * @returns { scanned, consumed, quarantined, failed, skipped }
 * @throws EditorInboxError 目录/profile 非法，或 onEvent 不是函数。
 */
export async function consumeEditorInbox(options = {}) {
    const clock = typeof options.now === 'function' ? options.now : () => Date.now();
    const f = options.fs ?? fsDefault;
    const enabled = options.enabled === true;
    const maxBatch = Number.isInteger(options.maxBatch) && options.maxBatch > 0
        ? Math.min(options.maxBatch, EDITOR_LIMITS.maxBatch)
        : EDITOR_LIMITS.maxBatch;

    if (typeof options.onEvent !== 'function') {
        throw new EditorInboxError('onEvent 必须是函数（没有 sink 时不该消费并删除事件）', { code: 'E_OPTIONS', path: 'onEvent' });
    }

    const { inbox } = resolveInboxPaths({ directory: options.directory, profile: options.profile });
    const result = { scanned: 0, consumed: 0, quarantined: 0, failed: 0, skipped: 0 };

    let names;
    try {
        names = await f.readdir(inbox);
    }
    catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return result; // 首次轮询：目录还不存在
        throw error;
    }
    names.sort();

    let attempted = 0;
    for (const name of names) {
        // quarantine 子目录本身不是事件，跳过（非递归，不扫整个项目）。
        if (name === 'quarantine') { result.skipped += 1; continue; }
        if (!name.endsWith('.json')) { result.skipped += 1; continue; }

        result.scanned += 1;
        if (attempted >= maxBatch) { result.skipped += 1; continue; }

        let stat;
        try {
            stat = await f.lstat(path.join(inbox, name));
        }
        catch {
            result.skipped += 1; // 文件已消失或竞态
            continue;
        }

        // 符号链接：隔离，绝不跟随（allowCopy:false 防 copyFile 读目标内容）。
        if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
            attempted += 1;
            const moved = await moveToQuarantine(f, inbox, name, clock, { allowCopy: false });
            if (moved) result.quarantined += 1;
            else result.failed += 1;
            continue;
        }
        // 只处理普通文件。
        if (typeof stat.isFile !== 'function' || !stat.isFile()) { result.skipped += 1; continue; }

        attempted += 1;

        // 体积上限：lstat.size 先挡一道，read 之后再挡一道。
        if (typeof stat.size === 'number' && stat.size > EDITOR_LIMITS.maxFileBytes) {
            const moved = await moveToQuarantine(f, inbox, name, clock);
            if (moved) result.quarantined += 1; else result.failed += 1;
            continue;
        }
        if (!FILE_PATTERN.test(name)) {
            const moved = await moveToQuarantine(f, inbox, name, clock);
            if (moved) result.quarantined += 1; else result.failed += 1;
            continue;
        }

        let buffer;
        try {
            buffer = await f.readFile(path.join(inbox, name));
        }
        catch {
            result.failed += 1; // 读失败保留重试
            continue;
        }
        if (buffer.length > EDITOR_LIMITS.maxFileBytes) {
            const moved = await moveToQuarantine(f, inbox, name, clock);
            if (moved) result.quarantined += 1; else result.failed += 1;
            continue;
        }

        let parsed;
        try {
            parsed = JSON.parse(buffer.toString('utf8'));
        }
        catch {
            const moved = await moveToQuarantine(f, inbox, name, clock);
            if (moved) result.quarantined += 1; else result.failed += 1;
            continue;
        }

        // 文件名 stem 必须与事件 id 一致，防止「挂羊头卖狗肉」。
        let event;
        try {
            event = validateEditorEvent(parsed, { now: clock, enabled });
            if (event.id !== name.slice(0, -'.json'.length)) {
                throw new EditorInboxError('事件 id 与文件名不一致', { code: 'E_ID', path: 'id' });
            }
        }
        catch {
            const moved = await moveToQuarantine(f, inbox, name, clock);
            if (moved) result.quarantined += 1; else result.failed += 1;
            continue;
        }

        // 投递：sink 抛错 → 保留文件下轮重试（稳定 id 交给 tracker 幂等）。
        try {
            await options.onEvent(event);
        }
        catch {
            result.failed += 1;
            continue;
        }
        try {
            await f.unlink(path.join(inbox, name));
            result.consumed += 1;
        }
        catch {
            result.failed += 1; // 投递成功但删除失败：下轮重投，由 tracker 按 id 去重
        }
    }
    return result;
}
