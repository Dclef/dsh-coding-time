/**
 * dsh-coding-time · 客户端半边测试。
 *
 * 客户端插件是宿主用 `window.__ModuleLoader__.load()` 现加载的裸函数：没有构建步骤
 * 能替我们发现「引用了不存在的变量」「hooks 顺序变了」「null 被渲染成 0」这类错。
 *
 * 这里不装 react、不装 jsdom（本工程故意零前端依赖）：
 *
 * - `vm` 造一个只有 `window.__ModuleLoader__` 的宿主沙箱，把 client/index.js 真跑一遍；
 * - 一个极小的 hooks 运行时实现 useState/useRef/useEffect/useCallback 的**足够语义**
 *   （按展开顺序线性分配 hook 槽位，deps 变化才重跑 effect），让组件真的渲染、真的
 *   请求、真的重新渲染；
 * - `fetch` / `document` 用可控 mock，断言请求地址、请求体、错误态与空态的文案。
 *
 * 断言的重点不是"画得像不像"，而是数据的诚实性：服务端给 null 就显示未采集，绝不
 * 在前端补 0；合计用服务端并集值，不在前端相加。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSource = fs.readFileSync(path.join(here, '..', 'client', 'index.js'), 'utf8');

/* -------------------------------------------------------------------------- *
 * 极简 hooks 运行时
 * -------------------------------------------------------------------------- */

function depsEqual(a, b) {
    if (a === undefined || b === undefined) return false;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => Object.is(item, b[index]));
}

function createRuntime() {
    const runtime = {
        cursor: 0,
        hooks: [],
        effects: [],
        dirty: false,
        react: null,
    };

    const react = {
        createElement(type, props, ...children) {
            const merged = { ...(props ?? {}) };
            if (children.length === 1) merged.children = children[0];
            else if (children.length > 1) merged.children = children;
            return { type, props: merged };
        },
        useState(initial) {
            const index = runtime.cursor++;
            if (!(index in runtime.hooks)) {
                runtime.hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
            }
            const slot = runtime.hooks[index];
            return [slot.value, (next) => {
                const value = typeof next === 'function' ? next(slot.value) : next;
                if (Object.is(value, slot.value)) return;
                slot.value = value;
                runtime.dirty = true;
            }];
        },
        useRef(initial) {
            const index = runtime.cursor++;
            if (!(index in runtime.hooks)) runtime.hooks[index] = { kind: 'ref', current: initial };
            return runtime.hooks[index];
        },
        useCallback(fn, deps) {
            const index = runtime.cursor++;
            const previous = runtime.hooks[index];
            if (previous !== undefined && previous.kind === 'callback' && depsEqual(previous.deps, deps)) return previous.fn;
            runtime.hooks[index] = { kind: 'callback', fn, deps };
            return fn;
        },
        useMemo(fn, deps) {
            const index = runtime.cursor++;
            const previous = runtime.hooks[index];
            if (previous !== undefined && previous.kind === 'memo' && depsEqual(previous.deps, deps)) return previous.value;
            const value = fn();
            runtime.hooks[index] = { kind: 'memo', value, deps };
            return value;
        },
        useEffect(fn, deps) {
            const index = runtime.cursor++;
            const previous = runtime.hooks[index];
            const slot = previous !== undefined && previous.kind === 'effect'
                ? previous
                : { kind: 'effect', deps: undefined, prevDeps: undefined, cleanup: undefined, mounted: false, fn: undefined };
            slot.fn = fn;
            slot.deps = deps;
            runtime.hooks[index] = slot;
            runtime.effects.push(index);
        },
    };
    runtime.react = react;
    return runtime;
}

function expand(runtime, node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (Array.isArray(node)) return node.map(child => expand(runtime, child));
    if (typeof node === 'string' || typeof node === 'number') return node;
    if (typeof node.type === 'function') return expand(runtime, node.type(node.props ?? {}));
    return { type: node.type, props: { ...node.props, children: expand(runtime, node.props?.children) } };
}

function runEffects(runtime) {
    const pending = [];
    for (const index of runtime.effects) {
        const slot = runtime.hooks[index];
        if (slot.mounted === true && depsEqual(slot.prevDeps, slot.deps)) continue;
        pending.push(index);
    }
    for (const index of pending) {
        const slot = runtime.hooks[index];
        if (typeof slot.cleanup === 'function') slot.cleanup();
        slot.cleanup = undefined;
        slot.mounted = true;
        slot.prevDeps = slot.deps;
        const result = slot.fn();
        if (typeof result === 'function') slot.cleanup = result;
    }
}

function unmountEffects(runtime) {
    for (const slot of runtime.hooks) {
        if (slot !== null && typeof slot === 'object' && slot.kind === 'effect' && typeof slot.cleanup === 'function') {
            slot.cleanup();
            slot.cleanup = undefined;
        }
    }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * 渲染并推进到稳定状态：effect 触发的 fetch → setState 会被继续渲染，直到没有脏标记。
 *
 * @param runtime - hooks 运行时。
 * @param Component - 顶层组件。
 * @param props - 顶层 props。
 * @returns 展开后的宿主元素树。
 */
async function settle(runtime, Component, props) {
    let tree = null;
    for (let round = 0; round < 40; round += 1) {
        runtime.cursor = 0;
        runtime.effects = [];
        runtime.dirty = false;
        tree = expand(runtime, Component(props ?? {}));
        runEffects(runtime);
        await tick();
        await tick();
        if (runtime.dirty === false) return tree;
    }
    throw new Error('组件在 40 轮内没有稳定：可能有 effect 每次渲染都触发 setState');
}

function textOf(node, into = []) {
    if (node === null || node === undefined || typeof node === 'boolean') return into;
    if (typeof node === 'string' || typeof node === 'number') {
        into.push(String(node));
        return into;
    }
    if (Array.isArray(node)) {
        for (const child of node) textOf(child, into);
        return into;
    }
    if (typeof node === 'object') textOf(node.props?.children, into);
    return into;
}

function findAll(node, predicate, out = []) {
    if (node === null || node === undefined || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
        for (const child of node) findAll(child, predicate, out);
        return out;
    }
    if (predicate(node)) out.push(node);
    findAll(node.props?.children, predicate, out);
    return out;
}

function findOne(node, predicate) {
    return findAll(node, predicate)[0] ?? null;
}

function byAriaLabel(label) {
    return node => node.type === 'button' && node.props['aria-label'] === label;
}

/**
 * 跨 realm 的深比较：客户端模块在 vm 沙箱里创建对象，`deepStrictEqual` 会因为
 * 原型来自另一个 realm 而误判。这里只比 JSON 可表达的值，足够覆盖纯函数输出。
 */
function sameJson(actual, expected, message) {
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

/* -------------------------------------------------------------------------- *
 * 宿主沙箱
 * -------------------------------------------------------------------------- */

const hostState = { fetch: null, document: null };

/** 收集 `window.__ModuleLoader__.load()` 的实参。 */
const loaded = [];

const sandbox = {
    window: {
        __ModuleLoader__: {
            load(definition) {
                loaded.push(definition);
            },
        },
    },
    console,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    get fetch() {
        return hostState.fetch;
    },
    get document() {
        return hostState.document;
    },
};

const context = vm.createContext(sandbox);
vm.runInContext(clientSource, context, { filename: 'client/index.js' });

/** 客户端模块定义（整个文件只会 load 一次）。 */
const definition = loaded[0];

/**
 * 挂载客户端插件，拿到注册的座位与 dispose 入口。
 *
 * @param lang - 宿主语言。
 * @returns `{ module, seats, releases, dispose, locale, listeners }`。
 */
function mountPlugin(lang = 'zh') {
    const listeners = [];
    let active = lang;
    const locale = {
        getLocale: () => ({ active, revision: 1 }),
        subscribe: (fn) => {
            listeners.push(fn);
            return () => {
                const index = listeners.indexOf(fn);
                if (index >= 0) listeners.splice(index, 1);
            };
        },
    };
    const runtime = createRuntime();
    const module = definition.factory(name => {
        if (name === 'react') return runtime.react;
        throw new Error('unexpected require: ' + name);
    });
    const seats = [];
    const releases = [];
    const slots = {
        inject(name, callback) {
            void name;
            return callback();
        },
        register(seat, component) {
            seats.push({ ...seat, component });
            const release = () => {
                releases.push(seat.id ?? seat.key ?? seat.name);
            };
            return release;
        },
    };
    let cleanup = null;
    const ctx = {
        inject(names, callback) {
            if (names.includes('slots')) return callback({ get: () => slots });
            if (names.includes('locale')) return callback({ get: () => locale });
            return undefined;
        },
        effect(setup) {
            cleanup = setup();
            return () => cleanup?.();
        },
    };
    module.apply(ctx);
    return {
        module,
        runtime,
        seats,
        releases,
        locale,
        listeners,
        setLang: (next) => {
            active = next;
            for (const listener of [...listeners]) listener();
        },
        dispose: () => cleanup?.(),
    };
}

/* -------------------------------------------------------------------------- *
 * fetch / document mock
 * -------------------------------------------------------------------------- */

function jsonResponse(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
    };
}

function makeFetch(handler) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init, method: init?.method ?? 'GET', body: init?.body });
        return handler(url, init);
    };
    fetchImpl.calls = calls;
    return fetchImpl;
}

function summaryBody(overrides = {}) {
    return {
        version: 2,
        ok: true,
        generatedAt: '2026-11-05T01:20:00.000Z',
        timezone: 'Asia/Shanghai',
        range: { preset: 'today', from: '2026-11-04T16:00:00.000Z', to: '2026-11-05T16:00:00.000Z', fromLocal: '2026-11-05', toLocal: '2026-11-05' },
        humanStatus: 'not_connected',
        totals: {
            aiSeconds: 3600,
            humanSeconds: null,
            totalSeconds: 3600,
            aiAddedLines: null,
            aiDeletedLines: null,
            sessions: 2,
            projects: 1,
            lineDataQuality: 'unavailable',
        },
        projects: [
            {
                project: 'e:/work/alpha',
                label: 'alpha',
                cwd: 'e:/work/alpha',
                aiSeconds: 3600,
                humanSeconds: null,
                totalSeconds: 3600,
                aiAddedLines: null,
                aiDeletedLines: null,
                lineDataQuality: 'unavailable',
                sessions: 2,
                lastActiveAt: '2026-11-05T01:10:00.000Z',
                active: true,
            },
        ],
        days: [{ date: '2026-11-05', aiSeconds: 3600, humanSeconds: null, aiAddedLines: null, aiDeletedLines: null }],
        recent: [{ at: '2026-11-05T01:00:00.000Z', project: 'e:/work/alpha', sessionId: 's1', kind: 'write', tool: 'write_file', path: 'e:/work/alpha/a.js' }],
        ...overrides,
    };
}

function configBody(overrides = {}) {
    return {
        ok: true,
        config: {
            enabled: true,
            heartbeatIntervalSeconds: 60,
            idleThresholdSeconds: 180,
            flushIntervalSeconds: 10,
            trackAgentActivity: true,
            trackAiLines: true,
            humanTracking: { enabled: false },
            storageDirectory: 'C:\\Users\\tester\\.dsh\\coding-time',
            timezone: 'Asia/Shanghai',
            weekStartsOn: 1,
            exclude: ['.git'],
        },
        revision: 7,
        namespace: 'dsh-coding-time',
        editable: true,
        warnings: [],
        stats: { records: 12, bytes: 2048, projects: 1 },
        ...overrides,
    };
}

function makeDocument() {
    const anchors = [];
    return {
        anchors,
        createElement(tag) {
            const node = {
                tag,
                attributes: {},
                clicked: 0,
                href: '',
                setAttribute(key, value) {
                    this.attributes[key] = value;
                },
                click() {
                    this.clicked += 1;
                },
                remove() {},
            };
            anchors.push(node);
            return node;
        },
        body: { appendChild() {} },
    };
}

/** 默认路由：summary + config 正常返回。 */
function defaultFetch(options = {}) {
    return makeFetch((url) => {
        if (url.includes('/summary')) return jsonResponse(options.summary ?? summaryBody());
        if (url.includes('/config')) return jsonResponse(options.config ?? configBody());
        return jsonResponse({ ok: false, message: 'unexpected ' + url }, 404);
    });
}

/* -------------------------------------------------------------------------- *
 * 静态约束：无外部资源、无凭据读取
 * -------------------------------------------------------------------------- */

test('client 源码不引外部资源、不读凭据', () => {
    assert.doesNotMatch(clientSource, /https?:\/\//, '客户端不应出现任何 http(s) 绝对地址');
    assert.doesNotMatch(clientSource, /@import\s+url|cdn\.|fonts\.googleapis/i);
    // 只看真正会读凭据/存储的调用形态：配置过滤用的字段名正则不算。
    assert.doesNotMatch(clientSource, /localStorage\s*\.|sessionStorage\s*\.|document\.cookie/);
    assert.doesNotMatch(clientSource, /credentials\s*:\s*['"]include/);
    assert.doesNotMatch(clientSource, /\beval\s*\(|new\s+Function\s*\(/);
    assert.match(clientSource, /credentials:\s*'same-origin'/, '同源请求必须显式声明 same-origin');
});

/* -------------------------------------------------------------------------- *
 * 注册与释放
 * -------------------------------------------------------------------------- */

test('注册 settings.section、plugins.bundle.config 与会话头入口，dispose 时全部撤回', () => {
    const { module, seats, releases, dispose } = mountPlugin();
    assert.equal(module.name, 'dsh-coding-time-client');
    assert.ok(Array.isArray(module.inject));
    assert.equal(module.inject.length, 0);
    assert.equal(typeof module.apply, 'function');
    assert.equal(seats.length, 3);

    const bySlot = new Map(seats.map(seat => [seat.name, seat]));
    sameJson([...bySlot.keys()].sort(), [
        'conversation.session.header.actions',
        'plugins.bundle.config',
        'settings.section',
    ]);
    assert.equal(bySlot.get('settings.section').id, 'dsh-coding-time');
    assert.equal(bySlot.get('settings.section').order, 64);
    assert.equal(bySlot.get('plugins.bundle.config').key, 'dsh-coding-time');
    assert.equal(bySlot.get('conversation.session.header.actions').id, 'dsh-coding-time-session-header');
    for (const seat of seats) assert.equal(typeof seat.component, 'function');

    // label 是 thunk：语言切换后不需要重新注册座位。
    assert.equal(bySlot.get('settings.section').label(), '编码时长');
    dispose();
    assert.equal(releases.length, 3);
});

test('宿主没有 slots 服务时安静降级，不抛错', () => {
    const runtime = createRuntime();
    const module = definition.factory(name => {
        if (name === 'react') return runtime.react;
        throw new Error('unexpected require: ' + name);
    });
    let cleaned = null;
    const ctx = {
        inject(names, callback) {
            if (names.includes('slots')) return callback({ get: () => undefined });
            return callback({ get: () => ({ getLocale: () => ({ active: 'zh' }) }) });
        },
        effect(setup) {
            cleaned = setup();
        },
    };
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        module.apply(ctx);
    }
    finally {
        console.warn = originalWarn;
    }
    assert.ok(warnings.some(line => line.includes('slots')));
    cleaned?.();
});

/* -------------------------------------------------------------------------- *
 * 查询与渲染
 * -------------------------------------------------------------------------- */

test('summary 用 URLSearchParams 编码、同源、今日/本周切换会重新查询', async () => {
    const fetcher = defaultFetch();
    hostState.fetch = fetcher;
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const runtime = plugin.runtime;
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    let tree = await settle(runtime, Section, {});

    const summaryCalls = fetcher.calls.filter(call => call.url.includes('/summary'));
    assert.equal(summaryCalls.length, 1);
    assert.equal(summaryCalls[0].url, '/plugins/dsh-coding-time/api/summary?preset=today');
    assert.equal(summaryCalls[0].init.credentials, 'same-origin');
    assert.equal(summaryCalls[0].method, 'GET');

    const weekButton = findOne(tree, byAriaLabel('本周'));
    assert.ok(weekButton !== null);
    weekButton.props.onClick();
    tree = await settle(runtime, Section, {});
    const urls = fetcher.calls.filter(call => call.url.includes('/summary')).map(call => call.url);
    assert.ok(urls.includes('/plugins/dsh-coding-time/api/summary?preset=week'), urls.join(', '));

    // 导出一定带 format=csv 且 preset 编码过。
    const exportButton = findOne(tree, byAriaLabel('导出 CSV'));
    exportButton.props.onClick();
    const anchors = hostState.document.anchors;
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].href, '/plugins/dsh-coding-time/api/export?format=csv&preset=week');
    assert.equal(anchors[0].attributes.download, 'dsh-coding-time-week.csv');
    assert.equal(anchors[0].clicked, 1);
});

test('null 语义：人类时长未接入、AI 行数未采集都不会渲染成 0，合计不前端相加', async () => {
    hostState.fetch = defaultFetch({
        summary: summaryBody({
            humanStatus: 'connected',
            totals: {
                aiSeconds: 3600,
                humanSeconds: 3600,
                totalSeconds: 3600, // 与服务端一致：并集，重叠只计一次
                aiAddedLines: null,
                aiDeletedLines: null,
                sessions: 2,
                projects: 1,
                lineDataQuality: 'unavailable',
            },
            projects: [{
                project: 'e:/work/alpha',
                label: 'alpha',
                cwd: 'e:/work/alpha',
                aiSeconds: 3600,
                humanSeconds: null,
                totalSeconds: 3600,
                aiAddedLines: null,
                aiDeletedLines: null,
                lineDataQuality: 'unavailable',
                sessions: 2,
                lastActiveAt: null,
                active: false,
            }],
        }),
    });
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});
    const text = textOf(tree).join(' ');

    assert.match(text, /合计活跃/);
    assert.match(text, /1 小时 0 分/, '合计应直接使用服务端并集值');
    assert.doesNotMatch(text, /2 小时/, 'AI + 人类不得在界面上相加');
    assert.match(text, /未采集/, 'null 行数必须显示未采集');
    assert.doesNotMatch(text, /\+0|−0|\+-0/, '不得把 null 行数补成 0');
    // 项目行的人类时长是 null，而全局状态是 connected → 行内显示未采集，不是 0 秒。
    const rows = findAll(tree, node => node.props?.['data-role'] === 'project-row');
    assert.equal(rows.length, 1);
    const rowText = textOf(rows[0]).join(' ');
    assert.match(rowText, /未采集/);
    assert.doesNotMatch(rowText, /0 秒/);
    assert.match(text, /没有采集到行数/);
    // 界面上不能漏出 undefined / null / NaN 这类内部值。
    assert.doesNotMatch(text, /undefined|\bnull\b|NaN/);
});

test('空态：没有项目/按日数据时给明确空态，不造示例数据', async () => {
    hostState.fetch = defaultFetch({
        summary: summaryBody({ projects: [], days: [], recent: [], totals: {
            aiSeconds: 0,
            humanSeconds: null,
            totalSeconds: 0,
            aiAddedLines: null,
            aiDeletedLines: null,
            sessions: 0,
            projects: 0,
            lineDataQuality: 'unavailable',
        } }),
    });
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});
    const text = textOf(tree).join(' ');

    assert.match(text, /这个范围里还没有项目活动/);
    assert.match(text, /该范围没有按日数据/);
    assert.match(text, /暂无记录/);
    assert.equal(findAll(tree, node => node.props?.['data-role'] === 'project-row').length, 0);
});

test('summary 失败与空响应显示可操作错误，不显示伪造的 0', async () => {
    hostState.fetch = makeFetch((url) => {
        if (url.includes('/summary')) return jsonResponse({ ok: false, message: 'collector offline' }, 503);
        return jsonResponse(configBody());
    });
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});
    const text = textOf(tree).join(' ');

    assert.match(text, /请求失败（HTTP 503）/);
    assert.match(text, /collector offline/);
    assert.match(text, /确认插件已在本机启用/);
    assert.doesNotMatch(text, /合计活跃/);
});

/* -------------------------------------------------------------------------- *
 * 设置：保存、422、409、只读
 * -------------------------------------------------------------------------- */

function inputByField(tree, field) {
    return findOne(tree, node => node.type === 'input' && node.props.id === 'dsh-coding-time-' + field);
}

test('保存只发 {patch, expectedRevision}，成功后显示已保存与新版本', async () => {
    const fetcher = makeFetch((url, init) => {
        if (url.includes('/summary')) return jsonResponse(summaryBody());
        if (url.includes('/config') && init?.method === 'POST') {
            const patch = JSON.parse(init.body).patch;
            return jsonResponse(configBody({
                revision: 8,
                config: {
                    ...configBody().config,
                    heartbeatIntervalSeconds: patch.heartbeatIntervalSeconds,
                },
            }));
        }
        return jsonResponse(configBody());
    });
    hostState.fetch = fetcher;
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    let tree = await settle(plugin.runtime, Section, {});

    const heartbeat = inputByField(tree, 'heartbeatIntervalSeconds');
    assert.ok(heartbeat !== null, '应渲染心跳间隔输入框');
    assert.equal(heartbeat.props.value, '60');
    heartbeat.props.onChange({ target: { value: '90' } });
    tree = await settle(plugin.runtime, Section, {});
    assert.match(textOf(tree).join(' '), /有未保存的修改/);

    const save = findOne(tree, byAriaLabel('保存'));
    assert.equal(save.props.disabled, false);
    save.props.onClick();
    tree = await settle(plugin.runtime, Section, {});

    const posts = fetcher.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, '/plugins/dsh-coding-time/api/config');
    assert.equal(posts[0].init.credentials, 'same-origin');
    assert.equal(posts[0].body, JSON.stringify({ patch: { heartbeatIntervalSeconds: 90 }, expectedRevision: 7 }));
    assert.match(textOf(tree).join(' '), /已保存/);
    assert.match(textOf(tree).join(' '), /版本 8/);
});

test('422 显示中文字段提示并保留草稿；409 显示冲突与重新载入', async () => {
    let mode = '422';
    const fetcher = makeFetch((url, init) => {
        if (url.includes('/summary')) return jsonResponse(summaryBody());
        if (url.includes('/config') && init?.method === 'POST') {
            if (mode === '422') {
                return jsonResponse({
                    ok: false,
                    message: '配置校验失败',
                    errors: [{ path: 'idleThresholdSeconds', message: '必须不小于心跳间隔（收到 60）' }],
                }, 422);
            }
            return jsonResponse({ ok: false, message: 'revision conflict' }, 409);
        }
        return jsonResponse(configBody());
    });
    hostState.fetch = fetcher;
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    let tree = await settle(plugin.runtime, Section, {});

    inputByField(tree, 'idleThresholdSeconds').props.onChange({ target: { value: '60' } });
    tree = await settle(plugin.runtime, Section, {});
    findOne(tree, byAriaLabel('保存')).props.onClick();
    tree = await settle(plugin.runtime, Section, {});
    let text = textOf(tree).join(' ');
    assert.match(text, /保存被拒绝（422）/);
    assert.match(text, /必须不小于心跳间隔/);
    assert.match(text, /本地草稿已保留/);
    assert.equal(inputByField(tree, 'idleThresholdSeconds').props.value, '60', '草稿不能被错误态回滚');

    mode = '409';
    findOne(tree, byAriaLabel('保存')).props.onClick();
    tree = await settle(plugin.runtime, Section, {});
    text = textOf(tree).join(' ');
    assert.match(text, /配置已在别处被修改（409）/);
    assert.match(text, /重新载入/);
    assert.doesNotMatch(text, /已保存/);
});

test('editable=false：准确提示未找到可写配置入口、控件禁用、点击保存不发请求', async () => {
    const fetcher = defaultFetch({ config: configBody({ editable: false, warnings: ['组织策略锁定配置'] }) });
    hostState.fetch = fetcher;
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});

    const text = textOf(tree).join(' ');
    // 文案只描述「未找到可写配置入口」，不归因于宿主把配置设为只读。
    assert.match(text, /暂不可编辑：当前未找到本插件的可写配置入口/);
    assert.match(text, /为避免保存到错误位置，控件已禁用，也不会发送保存请求/);
    assert.doesNotMatch(text, /宿主把这份配置设为只读/);
    assert.match(text, /组织策略锁定配置/);
    assert.equal(findOne(tree, byAriaLabel('保存')).props.disabled, true);
    assert.equal(inputByField(tree, 'heartbeatIntervalSeconds').props.disabled, true);
    assert.equal(fetcher.calls.filter(call => call.method === 'POST').length, 0);
});

test('editable=true 但配置读取失败：错误态 + 重试按钮，不渲染表单', async () => {
    const fetcher = makeFetch((url) => {
        if (url.includes('/summary')) return jsonResponse(summaryBody());
        return jsonResponse({ ok: false, message: 'no settings document' }, 500);
    });
    hostState.fetch = fetcher;
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});

    assert.ok(findOne(tree, node => node.props?.['data-role'] === 'config-error') !== null);
    assert.equal(findOne(tree, node => node.props?.['data-role'] === 'settings-fields'), null);
    findOne(tree, byAriaLabel('重试')).props.onClick();
    await settle(plugin.runtime, Section, {});
    assert.ok(fetcher.calls.filter(call => call.url.includes('/config')).length >= 2);
});

/* -------------------------------------------------------------------------- *
 * 插件页与会话头
 * -------------------------------------------------------------------------- */

test('plugins.bundle.config：summary 视图只给一行摘要，page 视图给仪表盘 + 表单', async () => {
    hostState.fetch = defaultFetch();
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Bundle = plugin.seats.find(seat => seat.name === 'plugins.bundle.config').component;

    const summaryTree = await settle(plugin.runtime, Bundle, { view: 'summary' });
    const summaryText = textOf(summaryTree).join(' ');
    assert.match(summaryText, /今日 AI 活跃/);
    assert.match(summaryText, /1 小时 0 分/);
    assert.equal(findOne(summaryTree, node => node.props?.['data-role'] === 'settings-fields'), null);

    const pageTree = await settle(plugin.runtime, Bundle, { view: 'page' });
    assert.ok(findOne(pageTree, node => node.props?.['data-role'] === 'metrics') !== null);
    assert.ok(findOne(pageTree, node => node.props?.['data-role'] === 'settings-fields') !== null);
});

test('会话头入口只请求今日摘要，展开后给合计与前三项目', async () => {
    const fetcher = defaultFetch();
    hostState.fetch = fetcher;
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Header = plugin.seats.find(seat => seat.name === 'conversation.session.header.actions').component;
    let tree = await settle(plugin.runtime, Header, {});

    assert.equal(fetcher.calls.filter(call => call.url.includes('/summary')).length, 1);
    assert.equal(fetcher.calls[0].url, '/plugins/dsh-coding-time/api/summary?preset=today');
    assert.match(textOf(tree).join(' '), /今日 AI/);

    findOne(tree, node => node.type === 'button' && node.props['aria-haspopup'] === 'dialog').props.onClick();
    tree = await settle(plugin.runtime, Header, {});
    const text = textOf(tree).join(' ');
    assert.match(text, /合计活跃/);
    assert.match(text, /alpha/);
    assert.match(text, /完整看板在/);
    assert.equal(findOne(tree, node => node.props?.['data-role'] === 'settings'), null, '会话头不应塞进设置表单');
});

/* -------------------------------------------------------------------------- *
 * 语言
 * -------------------------------------------------------------------------- */

test('英文 locale 走英文文案（含座位 label 与会话头按钮）', async () => {
    hostState.fetch = defaultFetch();
    hostState.document = makeDocument();
    const plugin = mountPlugin('en');
    const seat = plugin.seats.find(item => item.name === 'settings.section');
    assert.equal(seat.label(), 'Coding time');
    const Section = seat.component;
    const tree = await settle(plugin.runtime, Section, {});
    const text = textOf(tree).join(' ');
    assert.match(text, /Coding activity/);
    assert.match(text, /AI active/);
    assert.match(text, /Project/);
    assert.match(text, /Settings/);
    assert.doesNotMatch(text, /编码活动时长/);
});

test('locale 运行时切回中文：已挂载组件跟着换文案，且不重新注册座位', async () => {
    hostState.fetch = defaultFetch();
    hostState.document = makeDocument();
    const plugin = mountPlugin('en');
    const seat = plugin.seats.find(item => item.name === 'settings.section');
    let tree = await settle(plugin.runtime, seat.component, {});
    assert.match(textOf(tree).join(' '), /Coding activity/);

    plugin.setLang('zh');
    tree = await settle(plugin.runtime, seat.component, {});
    const text = textOf(tree).join(' ');
    assert.match(text, /编码活动时长/);
    assert.doesNotMatch(text, /Coding activity/);
    assert.equal(plugin.seats.length, 3, '语言切换不应重新注册座位');
    assert.equal(seat.label(), '编码时长', 'label thunk 跟随当前 locale');
});

/* -------------------------------------------------------------------------- *
 * 纯函数（URL / null / 补丁 / 422 解析）
 * -------------------------------------------------------------------------- */

test('__test 纯函数：URL 编码、preset 兜底、null 语义、补丁与 422 解析', async () => {
    hostState.fetch = defaultFetch();
    const plugin = mountPlugin();
    const t = plugin.module.__test;

    assert.equal(t.summaryUrl('week'), '/plugins/dsh-coding-time/api/summary?preset=week');
    assert.equal(t.summaryUrl('tomorrow'), '/plugins/dsh-coding-time/api/summary?preset=today', '未知 preset 必须收敛到 today');
    assert.equal(t.apiUrl('/export', { format: 'csv', preset: 'a b&c=d' }), '/plugins/dsh-coding-time/api/export?format=csv&preset=a+b%26c%3Dd');
    assert.equal(t.apiUrl('/config', { unused: undefined, empty: '' }), '/plugins/dsh-coding-time/api/config');
    assert.equal(t.normalizePreset(''), 'today');

    assert.equal(t.formatDuration(null, 'zh'), null);
    assert.equal(t.formatDuration(0, 'zh'), '0 秒');
    assert.equal(t.formatDuration(3661, 'zh'), '1 小时 1 分');

    const summary = t.normalizeSummary({
        ok: true,
        totals: {},
        projects: [{ cwd: 'C:/x', aiSeconds: 10 }],
        days: [],
        recent: [],
    });
    assert.equal(summary.totals.aiSeconds, null, '缺字段必须是 null，不是 0');
    assert.equal(summary.totals.aiAddedLines, null);
    assert.equal(summary.totals.totalSeconds, null);
    assert.equal(summary.projects[0].aiAddedLines, null);
    assert.equal(summary.projects[0].label, 'x');
    assert.equal(summary.projects[0].humanSeconds, null);
    assert.equal(summary.humanStatus, 'not_connected');
    assert.equal(t.normalizeSummary(null), null);
    assert.equal(t.normalizeSummary({ ok: false }), null);

    const config = configBody().config;
    const draft = t.draftOf(config);
    sameJson(t.buildPatch(draft, config), {}, '没改动就不该产生补丁');
    sameJson(t.buildPatch({ ...draft, humanEnabled: true }, config), { humanTracking: { enabled: true } });
    sameJson(t.buildPatch({ ...draft, enabled: false, flushIntervalSeconds: 20 }, config), { enabled: false, flushIntervalSeconds: 20 });

    const tr = key => key;
    const errors = t.validateDraft({ ...draft, idleThresholdSeconds: 10 }, tr);
    assert.ok(errors.heartbeatIntervalSeconds === undefined);
    assert.match(errors.idleThresholdSeconds, /idleTooSmall/);
    const rangeErrors = t.validateDraft({ ...draft, heartbeatIntervalSeconds: 9999 }, tr);
    assert.match(rangeErrors.heartbeatIntervalSeconds, /settings.range/);

    sameJson(
        t.fieldErrorsOf({ errors: [{ path: 'idleThresholdSeconds', message: '太小' }] }),
        { idleThresholdSeconds: '太小' },
    );
    sameJson(
        t.fieldErrorsOf({ fields: { storageDirectory: { message: '必须是绝对路径' } } }),
        { storageDirectory: '必须是绝对路径' },
    );

    sameJson(t.statEntries({ records: 3, token: 'secret', note: 'x', nested: {} }), [['records', 3], ['note', 'x']], '统计里的凭据键必须被过滤');
});
