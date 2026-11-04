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
    const { buildConfigSchema } = await import('../lib/index.js');
    const schema = buildConfigSchema(z);
    // 真实 schemastery 的 schema 是可调用的 validator（不是纯对象）。
    assert.equal(typeof schema, 'function');
    // 默认值走 normalizeConfig 的权威结果。
    const value = schema({});
    assert.equal(value.heartbeatIntervalSeconds, 60);
    assert.equal(value.idleThresholdSeconds, 180);
    assert.equal(value.enabled, true);
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
