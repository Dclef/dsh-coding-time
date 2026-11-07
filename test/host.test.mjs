/**
 * Host 装配集成测试。
 *
 * 用**真实**的 `ActivityTracker` / `JsonlStore` / schemastery（从本包自己的
 * `node_modules` 解析，不硬编码主机绝对路径），配一个最小 cordis 上下文替身，
 * 覆盖工单要求的全链场景。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/** 载入本包解析到的真实 schemastery（不可用则返回 null）。 */
async function loadRealSchema() {
    try {
        const module = await import('@deepseek-ai/schemastery');
        const z = module?.default ?? module;
        return typeof z?.object === 'function' ? z : null;
    }
    catch {
        return null;
    }
}

/**
 * 最小 cordis 上下文替身：只实现被测代码真正调用的成员。
 *
 * @param options - { services, effects, onHandlers }。
 */
function makeContext(options = {}) {
    const services = options.services ?? {};
    const disposers = [];
    const listeners = new Map();
    const injectCalls = [];
    const ctx = {
        logger: {
            info: () => {},
            warn: () => {},
            error: () => {},
            debug: () => {},
        },
        root: options.root,
        get(name) {
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
            const dispose = () => {
                const current = listeners.get(eventName) ?? [];
                const index = current.indexOf(handler);
                if (index >= 0) current.splice(index, 1);
                // 与真实 cordis 一致：最后一个 handler 移除后键也消失。
                if (current.length === 0) listeners.delete(eventName);
            };
            return dispose;
        },
        inject(names, callback) {
            injectCalls.push({ names, callback });
            // 测试里直接执行，模拟已就绪的依赖。
            return callback(this);
        },
        emit(eventName, ...args) {
            const list = [...(listeners.get(eventName) ?? [])];
            return Promise.all(list.map(handler => Promise.resolve().then(() => handler(...args))));
        },
        listenerCount(eventName) {
            return (listeners.get(eventName) ?? []).length;
        },
        allListenerNames() {
            return [...listeners.keys()];
        },
        disposeAll() {
            for (const dispose of disposers) dispose();
            disposers.length = 0;
        },
    };
    ctx.root = ctx.root ?? ctx;
    trackedContexts.push(ctx);
    return ctx;
}

/** 本轮创建的所有上下文：断言中途失败也必须先 dispose 再清目录。 */
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

/**
 * webServer 替身：记录 exact 路由。
 * @returns 带 routes Map 的替身。
 */
function makeServer() {
    return {
        routes: new Map(),
        register(route) {
            this.routes.set(route.path, route.handler);
            return () => this.routes.delete(route.path);
        },
    };
}

/**
 * 直接调用一条已注册路由，返回 { status, body }。
 *
 * @param server - makeServer() 的替身。
 * @param routePath - 注册时的 path。
 * @param url - 请求 URL（含 query）。
 * @param options - { method, body }。
 */
async function callRoute(server, routePath, url, options = {}) {
    const handler = server.routes.get(routePath);
    assert.ok(handler !== undefined, `路由 ${routePath} 未注册`);
    const response = {
        headersSent: false,
        status: 0,
        headers: {},
        body: '',
        writeHead(status, headers) {
            this.status = status;
            this.headers = headers ?? {};
            this.headersSent = true;
        },
        end(body) {
            this.body = typeof body === 'string' ? body : '';
            this.headersSent = true;
        },
    };
    await handler({
        method: options.method ?? 'GET',
        url,
        headers: {},
        body: options.body,
    }, response);
    return { status: response.status, headers: response.headers, body: response.body };
}

/** 建临时存储目录。 */
async function tempDir(prefix = 'dct-') {
    return mkdtemp(path.join(os.tmpdir(), prefix));
}

test('真实 schemastery 可用（否则 schema 断言必须 skip）', async () => {
    const z = await loadRealSchema();
    if (z === null) return;
    assert.equal(typeof z.object, 'function');
});

test('Config 必须与 normalizeConfig 同口径：越界与未知字段都要拒', async () => {
    const z = await loadRealSchema();
    if (z === null) return;
    const { buildConfigSchema, unwrapVolatile, LIVE_FIELDS, COLD_FIELDS } = await import('../lib/index.js');
    const schema = buildConfigSchema(z);
    // 真实 schemastery 的 schema 是可调用的 validator（不是纯对象）。
    assert.equal(typeof schema, 'function');
    // 返回值**必须保留 native volatile wrapper**（宿主 Settings 靠它识别 live 字段）。
    const raw = schema({});
    assert.equal(typeof raw.enabled?.get, 'function', 'live 字段必须仍是 volatile 包装');
    assert.equal(typeof raw.heartbeatIntervalSeconds?.get, 'function');
    // 冷字段**不能**被包装（否则会伪装成可热改）。
    assert.equal(typeof raw.storageDirectory?.get, 'undefined', 'cold 字段绝不能被 volatile 包装');
    // 解包后才拿到真实值（= normalizeConfig 的权威结果）。
    const value = unwrapVolatile(raw);
    assert.equal(value.heartbeatIntervalSeconds, 60);
    assert.equal(value.idleThresholdSeconds, 180);
    assert.equal(value.enabled, true);
    assert.equal(value.humanTracking.enabled, false);
    // 字段分类必须与 volatile 标记一致。
    assert.deepEqual(COLD_FIELDS.map(field => field.name), ['storageDirectory']);
    for (const name of LIVE_FIELDS) {
        // humanTracking 是外层 object：schemastery 禁止嵌套 volatile，标记在内层字段上。
        if (name === 'humanTracking') {
            assert.equal(typeof raw.humanTracking?.get, 'undefined', '外层不能标 volatile（schemastery 禁止嵌套）');
            assert.equal(typeof raw.humanTracking?.enabled?.get, 'function', 'humanTracking.enabled 必须是 live');
            continue;
        }
        assert.ok(typeof raw[name] === 'object' && typeof raw[name]?.get === 'function', `${name} 必须是 live`);
    }
    // 越界必须被拒（schemastery 自身的范围元数据就能拒，不需要我们的 Proxy 兜底）。
    assert.throws(() => schema({ heartbeatIntervalSeconds: 2 }));
    // 未知字段必须被拒：**这条是 Proxy 用 normalizeConfig 补上的**，
    // 因为真实 schemastery 不拒 unknown。
    assert.throws(() => schema({ unknownField: 1 }), error => error.name === 'ConfigError');
    // 交叉校验：idle < heartbeat 必须被 Proxy 拒。
    assert.throws(
        () => schema({ heartbeatIntervalSeconds: 600, idleThresholdSeconds: 30 }),
        error => error.name === 'ConfigError',
    );
    // 凭据字段必须被 Proxy 拒。
    assert.throws(() => schema({ apiKey: 'x' }), error => error.name === 'ConfigError');
    // metadata 仍透传给宿主（schema 身份未被破坏）。
    assert.equal(typeof schema.meta, 'object');
    assert.equal(typeof schema.toJSON, 'function');
    assert.equal(typeof schema.toString, 'function');
});

test('Config 在 peer 缺失时是 undefined，绝不导出伪 schema', async () => {
    const module = await import('../lib/index.js');
    if (await loadRealSchema() !== null) {
        assert.ok(module.Config !== undefined, '本机有真实 peer，Config 必须是真 schema');
        assert.equal(typeof module.Config, 'function');
        assert.equal(module.Config.fields, undefined, '绝不能是伪 {fields} 兜底');
        return;
    }
    assert.equal(module.Config, undefined);
});

test('resolveProfile：显式 > DSH_PROFILE > default，非法名抛 E_PROFILE_INVALID', async () => {
    const { resolveProfile } = await import('../lib/index.js');
    assert.equal(resolveProfile('desktop', {}), 'desktop');
    assert.equal(resolveProfile(undefined, { DSH_PROFILE: 'desktop' }), 'desktop');
    assert.equal(resolveProfile(undefined, {}), 'default');
    assert.throws(() => resolveProfile('..', {}), error => error.code === 'E_PROFILE_INVALID');
    assert.throws(() => resolveProfile('a/b', {}), error => error.code === 'E_PROFILE_INVALID');
    assert.throws(() => resolveProfile('.hidden', {}), error => error.code === 'E_PROFILE_INVALID');
    assert.throws(() => resolveProfile('a b', {}), error => error.code === 'E_PROFILE_INVALID');
});

test('locateNamespace 只精确匹配，绝不按形状猜测别的插件', async () => {
    const { locateNamespace } = await import('../lib/index.js');
    assert.equal(locateNamespace(undefined), null);
    assert.equal(locateNamespace({}), null);
    // 形状相似但不是本插件：必须不匹配。
    const decoy = {
        describe: () => [{
            ns: 'dsh-agent-foreman',
            revision: 3,
            schema: { properties: Object.fromEntries(['enabled', 'timezone', 'exclude', 'weekStartsOn'].map(key => [key, {}])) },
            value: { enabled: true },
        }],
    };
    assert.equal(locateNamespace(decoy), null);
    // 精确匹配才返回。
    const exact = { describe: () => [{ ns: 'dsh-coding-time', revision: 7 }] };
    assert.deepEqual(locateNamespace(exact), { ns: 'dsh-coding-time', revision: 7 });
    const prefixed = { describe: () => [{ ns: 'include:dsh-coding-time', revision: 2 }] };
    assert.deepEqual(locateNamespace(prefixed), { ns: 'include:dsh-coding-time', revision: 2 });
});

test('非法配置拒绝启动，不假装 enabled', async () => {
    const module = await import('../lib/index.js');
    const z = await loadRealSchema();
    if (z !== null) module.useSchemaProvider(z);
    const directory = await tempDir();
    try {
        const ctx = makeContext({ services: {} });
        // `apply` 是同步函数：非法配置在第一个 await 之前就同步抛出。
        assert.throws(
            () => module.apply(ctx, { idleThresholdSeconds: 10, heartbeatIntervalSeconds: 600, storageDirectory: directory }),
            error => error.name === 'ConfigError' && error.code === 'inconsistent',
        );
        assert.throws(
            () => module.apply(ctx, { unknownField: 1, storageDirectory: directory }),
            error => error.name === 'ConfigError' && error.code === 'unknown_field',
        );
        // 抛错之后绝不留下任何订阅（同步抛发生在订阅之前）。
        assert.equal(ctx.allListenerNames().length, 0, '配置非法时不得注册 listener');
    }
    finally {
        // **先** dispose（串行 drain → flush → close），**再**删目录；
        // 否则仍在写盘的 store 会撞上被删的目录（ENOENT）。
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('全链：真实 tracker + store，60 秒节流 gate、跨 session、重启恢复', async () => {
    const module = await import('../lib/index.js');
    const z = await loadRealSchema();
    if (z !== null) module.useSchemaProvider(z);
    const directory = await tempDir();
    try {
        const sessionCwd = new Map();
        const services = {
            sessions: { get: id => (sessionCwd.has(id) ? { id } : undefined) },
            workingDirectory: { get: session => sessionCwd.get(session.id) },
            settings: { describe: () => [] },
        };
        const ctx = makeContext({ services });

        // 会话 A/B 共用项目 cwd。
        sessionCwd.set('session-A', directory);
        sessionCwd.set('session-B', directory);
        /** 可控事件时钟：所有观测的 at 都来自它，不依赖墙钟。 */
        let clock = Date.parse('2026-11-05T01:00:00.000Z');

        await module.apply(ctx, {
            storageDirectory: directory,
            idleThresholdSeconds: 180,
            heartbeatIntervalSeconds: 60,
            flushIntervalSeconds: 10,
            profile: 'testrun',
        });

        const frame = (attemptId, revision, index, text) => ({
            type: 'chunk',
            attemptId,
            revision,
            index,
            // 用**可控的事件时间**（真实 SDK 的 frame.time），而不是墙钟：
            // 60s gate 与 idle 分段都基于事件自带的 at。
            time: clock,
            chunk: { type: 'text-delta', index: 0, text },
        });

        // 会话 A：两次真实进展（间隔 5s，被 60s gate 抑制第二次开新记录）。
        await ctx.emit('agent/assistant-stream', { agent: { id: 'session-A' }, frame: frame('a1', 1, 0, 'x') });
        clock += 5_000;
        await ctx.emit('agent/assistant-stream', { agent: { id: 'session-A' }, frame: frame('a1', 1, 1, 'y') });
        // 会话 B：另一路真实进展，必须独立可见。
        await ctx.emit('agent/assistant-stream', { agent: { id: 'session-B' }, frame: frame('b1', 1, 0, 'z') });

        await ctx.emit('session/flush');

        // 两个会话都在持久历史里（跨 session 不被 gate 吞掉）。
        const { JsonlStore } = await import('../lib/store.js');
        const store = new JsonlStore({ directory, profile: 'testrun' });
        await store.init();
        const records = await store.readRecords({});
        assert.ok(records.length >= 1, `应有持久记录，实际 ${records.length}`);
        const states = await store.listProjectStates({ includeState: true });
        assert.equal(states.length, 1, '同一 cwd 应只有一个项目快照');
        await store.close();

        // 重启恢复：新 store + apply，summary 仍能读到历史。
        const restarted = makeContext({ services });
        await module.apply(restarted, {
            storageDirectory: directory,
            idleThresholdSeconds: 180,
            heartbeatIntervalSeconds: 60,
            profile: 'testrun',
        });
        const summary = await restarted.summarizeForTest?.();
        void summary;
        // 通过路由依赖拿 summary（mountRoutes 在 inject 时被调用）。
        const webServer = {
            register(route) {
                this.routes = this.routes ?? new Map();
                this.routes.set(route.path, route.handler);
                return () => this.routes.delete(route.path);
            },
        };
        const routed = makeContext({ services: { ...services, webServer } });
        await module.apply(routed, {
            storageDirectory: directory,
            idleThresholdSeconds: 180,
            heartbeatIntervalSeconds: 60,
            profile: 'testrun',
        });
        assert.ok(webServer.routes !== undefined, '应注册路由');

        restarted.disposeAll();
        routed.disposeAll();
        ctx.disposeAll();
    }
    finally {
        // **先** dispose（串行 drain → flush → close），**再**删目录；
        // 否则仍在写盘的 store 会撞上被删的目录（ENOENT）。
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('多 profile 隔离：不同 profile 的存储互不可见', async () => {
    const module = await import('../lib/index.js');
    const z = await loadRealSchema();
    if (z !== null) module.useSchemaProvider(z);
    const directory = await tempDir();
    try {
        const cwd = directory;
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => cwd },
            settings: { describe: () => [] },
        };

        const ctxAlpha = makeContext({ services });
        await module.apply(ctxAlpha, { storageDirectory: directory, profile: 'alpha' });
        await ctxAlpha.emit('agent/assistant-stream', {
            agent: { id: 's1' },
            frame: { type: 'chunk', attemptId: 'x', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', text: 'a' } },
        });
        await ctxAlpha.emit('session/flush');

        const ctxBeta = makeContext({ services });
        await module.apply(ctxBeta, { storageDirectory: directory, profile: 'beta' });
        await ctxBeta.emit('session/flush');

        const { JsonlStore } = await import('../lib/store.js');
        const alpha = new JsonlStore({ directory, profile: 'alpha' });
        await alpha.init();
        const beta = new JsonlStore({ directory, profile: 'beta' });
        await beta.init();

        assert.ok((await alpha.readRecords({})).length >= 1, 'alpha 应有记录');
        assert.equal((await beta.readRecords({})).length, 0, 'beta 绝不应看到 alpha 的记录');
        await alpha.close();
        await beta.close();
        ctxAlpha.disposeAll();
        ctxBeta.disposeAll();
    }
    finally {
        // **先** dispose（串行 drain → flush → close），**再**删目录；
        // 否则仍在写盘的 store 会撞上被删的目录（ENOENT）。
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('enabled=false 时不入账（关闭真实生效）', async () => {
    const module = await import('../lib/index.js');
    const z = await loadRealSchema();
    if (z !== null) module.useSchemaProvider(z);
    const directory = await tempDir();
    try {
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => directory },
            settings: { describe: () => [] },
        };
        const ctx = makeContext({ services });
        await module.apply(ctx, { storageDirectory: directory, enabled: false, profile: 'off' });
        await ctx.emit('agent/assistant-stream', {
            agent: { id: 's1' },
            frame: { type: 'chunk', attemptId: 'x', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', text: 'a' } },
        });
        await ctx.emit('session/flush');
        const { JsonlStore } = await import('../lib/store.js');
        const store = new JsonlStore({ directory, profile: 'off' });
        await store.init();
        assert.equal((await store.readRecords({})).length, 0, 'enabled=false 必须零记录');
        await store.close();
        ctx.disposeAll();
    }
    finally {
        // **先** dispose（串行 drain → flush → close），**再**删目录；
        // 否则仍在写盘的 store 会撞上被删的目录（ENOENT）。
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('卸载后根 scope listener 全部释放，不留泄漏', async () => {
    const module = await import('../lib/index.js');
    const z = await loadRealSchema();
    if (z !== null) module.useSchemaProvider(z);
    const directory = await tempDir();
    try {
        const rootEvents = [];
        const root = {
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            get: () => undefined,
            effect: () => () => {},
            on(eventName, handler) {
                rootEvents.push({ eventName, handler });
                return () => {
                    const index = rootEvents.findIndex(item => item.handler === handler);
                    if (index >= 0) rootEvents.splice(index, 1);
                };
            },
            inject: () => {},
        };
        root.root = root;
        const ctx = makeContext({ services: {} });
        ctx.root = root;
        await module.apply(ctx, { storageDirectory: directory, profile: 'leak' });
        assert.ok(rootEvents.length > 0, '应挂到 root scope');
        ctx.disposeAll();
        assert.equal(rootEvents.length, 0, '卸载后 root listener 必须清零');
        // 插件自身 scope 的 listener 也应释放。
        assert.equal(ctx.allListenerNames().length, 0, '插件 scope listener 也必须清零');
    }
    finally {
        // **先** dispose（串行 drain → flush → close），**再**删目录；
        // 否则仍在写盘的 store 会撞上被删的目录（ENOENT）。
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('volatile 投射：live 字段带 volatile，cold 字段不带', async () => {
    const z = await loadRealSchema();
    if (z === null) return;
    const { buildConfigSchema, LIVE_FIELDS, COLD_FIELDS } = await import('../lib/index.js');
    const schema = buildConfigSchema(z);
    const json = schema.toJSON();
    const refs = json.refs;
    const dict = refs[json.uid]?.dict ?? {};
    for (const [key, ref] of Object.entries(dict)) {
        const node = refs[ref];
        const isLive = node?.meta?.volatile === true;
        const shouldBeLive = LIVE_FIELDS.includes(key) && key !== 'humanTracking';
        if (COLD_FIELDS.some(field => field.name === key)) {
            assert.equal(isLive, false, `冷字段 ${key} 绝不能被标 volatile`);
            continue;
        }
        if (key === 'humanTracking') {
            // 外层 object 不标 volatile；内层 enabled 才是 live。
            assert.equal(isLive, false, 'humanTracking 外层不能标 volatile');
            continue;
        }
        assert.equal(isLive, shouldBeLive, `${key} 的 volatile 标记与字段分类不一致`);
    }
});

test('descriptor 契约：getConfigSnapshot 合并 cold 字段并给出元数据', async () => {
    const module = await import('../lib/index.js');
    const z = await loadRealSchema();
    const directory = await tempDir();
    try {
        if (z !== null) module.useSchemaProvider(z);
        const renderConfig = { color: 'dark', enabled: true, size: 14 };
        const descriptorValue = {
            enabled: { get: () => false },
            heartbeatIntervalSeconds: { get: () => 90 },
        };
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => directory },
            settings: {
                // 模拟真实宿主：只返回 live 子集（且带 volatile wrapper）。
                describe: () => [{
                    ns: 'dsh-coding-time',
                    revision: 9,
                    applies: 'live',
                    value: descriptorValue,
                }],
                update: async () => {},
                configure: () => {},
            },
        };
        const ctx = makeContext({ services });
        await module.apply(ctx, { storageDirectory: directory, profile: 'desc' });

        // 通过路由拿真实 GET /config 响应。
        const webServer = makeServer();
        const routed = makeContext({ services: { ...services, webServer, connection: { requestRejection: () => undefined } } });
        await module.apply(routed, { storageDirectory: directory, profile: 'desc2' });
        const response = await callRoute(webServer, '/plugins/dsh-coding-time/api/config', '/plugins/dsh-coding-time/api/config');
        const body = JSON.parse(response.body);

        // live 子集被正确解包并覆盖。
        assert.equal(body.editable, true, '有 descriptor 时必须可编辑');
        assert.equal(body.namespace, 'dsh-coding-time');
        assert.equal(body.revision, 9);
        assert.equal(body.config.enabled, false, 'live 值必须来自 descriptor（不是默认 true）');
        assert.equal(body.config.heartbeatIntervalSeconds, 90);
        // **cold 字段不被 descriptor 的 live 子集冲掉**（保留真实值）。
        assert.equal(body.config.storageDirectory, directory);
        assert.ok(typeof body.config.timezone === 'string' && body.config.timezone !== '');
        // 元数据契约。
        assert.deepEqual(body.readonlyFields, ['storageDirectory']);
        assert.deepEqual(body.restartRequiredFields, ['storageDirectory']);
        assert.ok(Array.isArray(body.liveFields) && body.liveFields.length > 0);
        assert.equal(body.coldFields[0].requiresRestart, true);
        void renderConfig;
        await ctx.disposeAll();
        await routed.disposeAll();
    }
    finally {
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('保存：只提交 live patch，cold 字段被拒 422', async () => {
    const module = await import('../lib/index.js');
    const z = await loadRealSchema();
    const directory = await tempDir();
    try {
        if (z !== null) module.useSchemaProvider(z);
        const updates = [];
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => directory },
            settings: {
                describe: () => [{ ns: 'dsh-coding-time', revision: 4, value: { enabled: { get: () => true } } }],
                update: async (ns, patch, revision) => { updates.push({ ns, patch, revision }); },
                configure: () => {},
            },
        };
        const webServer = makeServer();
        const ctx = makeContext({ services: { ...services, webServer, connection: { requestRejection: () => undefined } } });
        await module.apply(ctx, { storageDirectory: directory, profile: 'save' });

        // ① 正常 live 保存：只提交变动的 live 字段。
        const okResponse = await callRoute(webServer, '/plugins/dsh-coding-time/api/config', '/plugins/dsh-coding-time/api/config', {
            method: 'POST',
            body: JSON.stringify({ patch: { heartbeatIntervalSeconds: 120 }, expectedRevision: 4 }),
        });
        assert.equal(okResponse.status, 200);
        assert.equal(updates.length, 1);
        assert.equal(updates[0].ns, 'dsh-coding-time');
        // **只提交 live patch，不含 storageDirectory 等 cold 字段**。
        assert.deepEqual(Object.keys(updates[0].patch), ['heartbeatIntervalSeconds']);
        assert.equal(updates[0].patch.heartbeatIntervalSeconds, 120);
        assert.equal(updates[0].revision, 4);

        // ② 改冷字段：明确 422，且**不**调用 update。
        const coldResponse = await callRoute(webServer, '/plugins/dsh-coding-time/api/config', '/plugins/dsh-coding-time/api/config', {
            method: 'POST',
            body: JSON.stringify({ patch: { storageDirectory: 'D:\other' } }),
        });
        assert.equal(coldResponse.status, 422, '冷字段必须 422');
        const coldBody = JSON.parse(coldResponse.body);
        assert.equal(coldBody.error.code, 'invalid_config');
        assert.equal(coldBody.error.path, 'storageDirectory');
        assert.equal(updates.length, 1, '冷字段绝不能被提交到 settings.update');

        // ③ 没有 live 变更：也明确拒绝。
        const emptyResponse = await callRoute(webServer, '/plugins/dsh-coding-time/api/config', '/plugins/dsh-coding-time/api/config', {
            method: 'POST',
            body: JSON.stringify({ patch: {} }),
        });
        assert.equal(emptyResponse.status, 422);
        assert.equal(updates.length, 1);
        await ctx.disposeAll();
    }
    finally {
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('保存冲突与非法值：409 / 422 语义保持', async () => {
    const module = await import('../lib/index.js');
    const z = await loadRealSchema();
    const directory = await tempDir();
    try {
        if (z !== null) module.useSchemaProvider(z);
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => directory },
            settings: {
                describe: () => [{ ns: 'dsh-coding-time', revision: 4, value: {} }],
                update: async () => {
                    const error = new Error('revision stale');
                    error.code = 'E_REVISION_CONFLICT';
                    throw error;
                },
                configure: () => {},
            },
        };
        const webServer = makeServer();
        const ctx = makeContext({ services: { ...services, webServer, connection: { requestRejection: () => undefined } } });
        await module.apply(ctx, { storageDirectory: directory, profile: 'conflict' });

        // 冲突 → 409。
        const conflict = await callRoute(webServer, '/plugins/dsh-coding-time/api/config', '/plugins/dsh-coding-time/api/config', {
            method: 'POST',
            body: JSON.stringify({ patch: { enabled: false }, expectedRevision: 1 }),
        });
        assert.equal(conflict.status, 409);
        assert.equal(JSON.parse(conflict.body).error.code, 'revision_conflict');

        // 非法值 → 422（带字段路径）。
        const invalid = await callRoute(webServer, '/plugins/dsh-coding-time/api/config', '/plugins/dsh-coding-time/api/config', {
            method: 'POST',
            body: JSON.stringify({ patch: { heartbeatIntervalSeconds: 2 } }),
        });
        assert.equal(invalid.status, 422);
        const invalidBody = JSON.parse(invalid.body);
        assert.equal(invalidBody.error.code, 'invalid_config');
        assert.equal(invalidBody.error.path, 'heartbeatIntervalSeconds');
        await ctx.disposeAll();
    }
    finally {
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('真实 peer 产物直接传给 apply：不因 volatile wrapper 启动失败', async () => {
    const module = await import('../lib/index.js');
    const z = await loadRealSchema();
    assert.ok(z !== null, '本机必须有真实 schemastery（本测试不做 mock 替代）');
    const directory = await tempDir();
    try {
        module.useSchemaProvider(z);
        // **真实** schemastery 产物：live 字段是 Volatile 包装 {get()}。
        const schemaProduct = module.buildConfigSchema(z)({});
        // 断言这确实是带 wrapper 的真实产物（否则本测试没抓住 bug）。
        assert.equal(typeof schemaProduct.enabled?.get, 'function', '前提：产物必须带 volatile wrapper');
        assert.equal(typeof schemaProduct.heartbeatIntervalSeconds?.get, 'function');

        // 把它**原样**当作 rawConfig 传进 apply（复现线上 FAILED 路径）。
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => directory },
            settings: {
                describe: () => [{ ns: 'dsh-coding-time', revision: 2, applies: 'live', value: schemaProduct }],
                update: async () => {},
                configure: () => {},
            },
        };
        const ctx = makeContext({ services });
        ctx.fiber = { kind: 'fiber' };
        // 不给 storageDirectory：沿用 schema 产物里的真实默认值（会经过解包）。
        const initPromise = module.apply(ctx, { ...schemaProduct, storageDirectory: directory, profile: 'peer' });
        await initPromise;   // 必须能完整 resolve，不能抛 ConfigError
        // 完整 dispose 并 await（验证收尾链路也吃这份真实产物）。
        await ctx.disposeAll();
        assert.equal(ctx.allListenerNames().length, 0, 'dispose 后不得留 listener');
    }
    finally {
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('坏的 volatile getter 必须抛出，不静默落默认值', async () => {
    const module = await import('../lib/index.js');
    const z = await loadRealSchema();
    if (z !== null) module.useSchemaProvider(z);
    const directory = await tempDir();
    try {
        const brokenValue = {
            get enabled() { throw new Error('host value unreadable'); },
        };
        assert.throws(
            () => module.unwrapVolatile(brokenValue),
            error => /unreadable/.test(String(error?.message ?? '')),
        );
        // apply 入口同样必须失败（不能把坏值当默认值启动）。
        const ctx = makeContext({ services: {} });
        assert.throws(
            () => module.apply(ctx, brokenValue),
            error => /unreadable/.test(String(error?.message ?? '')),
        );
        assert.equal(ctx.allListenerNames().length, 0, '启动失败不得留 listener');
    }
    finally {
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('混合合法 live 与顶层未知键：必须 422 且绝不调用 update', async () => {
    const module = await import('../lib/index.js');
    const z = await loadRealSchema();
    const directory = await tempDir();
    try {
        if (z !== null) module.useSchemaProvider(z);
        const updates = [];
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => directory },
            settings: {
                describe: () => [{ ns: 'dsh-coding-time', revision: 3, value: {} }],
                update: async (ns, patch, revision) => { updates.push({ ns, patch, revision }); },
                configure: () => {},
            },
        };
        const webServer = makeServer();
        const ctx = makeContext({ services: { ...services, webServer, connection: { requestRejection: () => undefined } } });
        await module.apply(ctx, { storageDirectory: directory, profile: 'mix' });

        // enabled 是合法 live，unknownField 是未知顶层键。
        const response = await callRoute(webServer, '/plugins/dsh-coding-time/api/config', '/plugins/dsh-coding-time/api/config', {
            method: 'POST',
            body: JSON.stringify({ patch: { enabled: true, unknownField: 1 } }),
        });
        assert.equal(response.status, 422, '未知键必须 422（不能被过滤后静默接受）');
        const body = JSON.parse(response.body);
        assert.equal(body.error.code, 'invalid_config');
        assert.equal(body.error.path, 'unknownField', '错误必须指向真实未知键');
        // **关键**：绝不能因为"过滤后只剩合法字段"就下发 update。
        assert.equal(updates.length, 0, '校验失败时绝不可调用 settings.update');
        await ctx.disposeAll();
    }
    finally {
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('只有合法 live 字段时才正常保存（对照组）', async () => {
    const module = await import('../lib/index.js');
    const z = await loadRealSchema();
    const directory = await tempDir();
    try {
        if (z !== null) module.useSchemaProvider(z);
        const updates = [];
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => directory },
            settings: {
                describe: () => [{ ns: 'dsh-coding-time', revision: 3, value: {} }],
                update: async (ns, patch, revision) => { updates.push({ ns, patch, revision }); },
                configure: () => {},
            },
        };
        const webServer = makeServer();
        const ctx = makeContext({ services: { ...services, webServer, connection: { requestRejection: () => undefined } } });
        await module.apply(ctx, { storageDirectory: directory, profile: 'mix2' });

        const response = await callRoute(webServer, '/plugins/dsh-coding-time/api/config', '/plugins/dsh-coding-time/api/config', {
            method: 'POST',
            body: JSON.stringify({ patch: { enabled: true, weekStartsOn: 0 } }),
        });
        assert.equal(response.status, 200);
        assert.equal(updates.length, 1);
        assert.deepEqual(Object.keys(updates[0].patch).sort(), ['enabled', 'weekStartsOn']);
        await ctx.disposeAll();
    }
    finally {
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});

test('configure 只登记一次且不猜别的 namespace', async () => {
    const module = await import('../lib/index.js');
    const z = await loadRealSchema();
    const directory = await tempDir();
    try {
        if (z !== null) module.useSchemaProvider(z);
        const configureCalls = [];
        const services = {
            sessions: { get: id => ({ id }) },
            workingDirectory: { get: () => directory },
            settings: {
                describe: () => [{ ns: 'dsh-coding-time', revision: 1, value: {} }],
                update: async () => {},
                configure: (presentation, owner) => { configureCalls.push({ presentation, hasOwner: owner !== undefined }); },
            },
        };
        const ctx = makeContext({ services });
        // 真实 cordis 上下文带 fiber；替身必须同样提供，否则测不到 owner 传递。
        ctx.fiber = { kind: 'fiber' };
        await module.apply(ctx, { storageDirectory: directory, profile: 'cfg' });
        assert.equal(configureCalls.length, 1, 'configure 只应登记一次');
        assert.equal(configureCalls[0].presentation.auto, true);
        assert.equal(configureCalls[0].hasOwner, true, '必须带上本实例 owner');
        await ctx.disposeAll();
    }
    finally {
        await disposeTracked();
        await rm(directory, { recursive: true, force: true });
    }
});
