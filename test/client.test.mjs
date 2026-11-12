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

test('注册 settings.section、导航图标、plugins.bundle.config 与会话头入口，dispose 时全部撤回', () => {
    const { module, seats, releases, dispose } = mountPlugin();
    assert.equal(module.name, 'dsh-coding-time-client');
    assert.ok(Array.isArray(module.inject));
    assert.equal(module.inject.length, 0);
    assert.equal(typeof module.apply, 'function');
    assert.equal(seats.length, 4);

    const bySlot = new Map(seats.map(seat => [seat.name, seat]));
    sameJson([...bySlot.keys()].sort(), [
        'conversation.session.header.actions',
        'plugins.bundle.config',
        'settings.section',
        'settings.section.icon',
    ]);
    assert.equal(bySlot.get('settings.section').id, 'dsh-coding-time');
    assert.equal(bySlot.get('settings.section').order, 64);
    // 导航图标座位：id 必须与 settings.section 相同，宿主才会渲染（替换默认齿轮）。
    const iconSeat = bySlot.get('settings.section.icon');
    assert.equal(iconSeat.id, 'dsh-coding-time');
    assert.equal(typeof iconSeat.component, 'function');
    // 图标组件按宿主传入的 size 渲染蓝色方块，不引外部资源、符号为计时符。
    const iconTree = iconSeat.component({ size: 16, active: true });
    const iconText = textOf(iconTree).join(' ');
    assert.match(iconText, /◷/);
    assert.doesNotMatch(iconText, /undefined|NaN/);
    assert.equal(bySlot.get('plugins.bundle.config').key, 'dsh-coding-time');
    assert.equal(bySlot.get('conversation.session.header.actions').id, 'dsh-coding-time-session-header');
    for (const seat of seats) assert.equal(typeof seat.component, 'function');

    // label 是 thunk：语言切换后不需要重新注册座位。
    assert.equal(bySlot.get('settings.section').label(), '编码时长');
    dispose();
    assert.equal(releases.length, 4);
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

test('volatile Host 成功：editable=true + 冷字段元数据时热字段可编辑可保存，POST 带正确 patch/revision', async () => {
    // Host 真实成功形状：入口可写，storageDirectory 是唯一冷字段（不可热改、需重载）。
    const volatileBody = () => configBody({
        editable: true,
        readonlyFields: ['storageDirectory'],
        restartRequiredFields: ['storageDirectory'],
        liveFields: [
            'enabled', 'heartbeatIntervalSeconds', 'idleThresholdSeconds', 'flushIntervalSeconds',
            'trackAgentActivity', 'trackAiLines', 'humanTracking', 'timezone', 'weekStartsOn', 'exclude',
        ],
    });
    const fetcher = makeFetch((url, init) => {
        if (url.includes('/summary')) return jsonResponse(summaryBody());
        if (url.includes('/config') && init?.method === 'POST') {
            const payload = JSON.parse(init.body);
            // 冷字段绝不能进 patch；其余热字段改动照常提交。
            assert.equal(Object.hasOwn(payload.patch, 'storageDirectory'), false);
            return jsonResponse(volatileBody());
        }
        return jsonResponse(volatileBody());
    });
    hostState.fetch = fetcher;
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    let tree = await settle(plugin.runtime, Section, {});

    const text0 = textOf(tree).join(' ');
    // 冷字段提示出现，但「未找到可写入口」的只读提示不得出现。
    assert.match(text0, /部分字段需重载后生效/);
    assert.match(text0, /本次保存不会搬移已有数据，也不会切换目录/);
    assert.doesNotMatch(text0, /暂不可编辑：当前未找到本插件的可写配置入口/);

    // 热字段仍可编辑；保存按钮可用。
    const heartbeat = inputByField(tree, 'heartbeatIntervalSeconds');
    assert.equal(heartbeat.props.disabled, false, '热字段在 editable=true 时不得被禁用');
    assert.equal(findOne(tree, byAriaLabel('保存')).props.disabled, false);

    heartbeat.props.onChange({ target: { value: '90' } });
    tree = await settle(plugin.runtime, Section, {});
    findOne(tree, byAriaLabel('保存')).props.onClick();
    tree = await settle(plugin.runtime, Section, {});

    const posts = fetcher.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 1, 'editable=true 时应真实发出一次保存请求');
    assert.equal(posts[0].body, JSON.stringify({ patch: { heartbeatIntervalSeconds: 90 }, expectedRevision: 7 }));
    assert.match(textOf(tree).join(' '), /已保存/);
    // 冷字段 storageDirectory 是只读展示（无输入框），且提示仍在。
    assert.match(textOf(tree).join(' '), /需重载后生效/);
});

test('字段元数据缺失/含未知名时仍按 editable 判断，不强行禁用也不强行放行', async () => {
    // 只给 editable=true、完全不带元数据：热字段可编辑、保存可用（保持旧行为）。
    const plain = configBody({ editable: true });
    delete plain.readonlyFields;
    delete plain.restartRequiredFields;
    const fetcher = makeFetch((url) => {
        if (url.includes('/summary')) return jsonResponse(summaryBody());
        return jsonResponse(plain);
    });
    hostState.fetch = fetcher;
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});
    assert.equal(inputByField(tree, 'heartbeatIntervalSeconds').props.disabled, false);
    assert.equal(findOne(tree, byAriaLabel('保存')).props.disabled, false);
    assert.doesNotMatch(textOf(tree).join(' '), /部分字段需重载后生效/);
});

test('英文 locale 下冷字段提示与只读提示均为准确文案', async () => {
    const volatileBody = () => configBody({
        editable: true,
        readonlyFields: ['storageDirectory'],
        restartRequiredFields: ['storageDirectory'],
    });
    const fetcher = makeFetch((url) => {
        if (url.includes('/summary')) return jsonResponse(summaryBody());
        return jsonResponse(volatileBody());
    });
    hostState.fetch = fetcher;
    hostState.document = makeDocument();
    const plugin = mountPlugin('en');
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});
    const text = textOf(tree).join(' ');
    assert.match(text, /Some fields take effect after a reload/);
    assert.match(text, /This save does not migrate existing data or switch directories/);
    assert.doesNotMatch(text, /no writable configuration entry was found/i);
    assert.equal(findOne(tree, byAriaLabel('Save')).props.disabled, false);
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

test('editable 缺失或非布尔真值（"true"/1）：fail-closed 禁用且零 POST', async () => {
    for (const candidate of [
        { label: '缺 editable', make: () => { const body = configBody(); delete body.editable; return body; } },
        { label: '字符串 "true"', make: () => configBody({ editable: 'true' }) },
        { label: '数字 1', make: () => configBody({ editable: 1 }) },
    ]) {
        const fetcher = defaultFetch({ config: candidate.make() });
        hostState.fetch = fetcher;
        hostState.document = makeDocument();
        const plugin = mountPlugin();
        const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
        const tree = await settle(plugin.runtime, Section, {});
        assert.equal(findOne(tree, byAriaLabel('保存')).props.disabled, true, `${candidate.label}：保存按钮应禁用`);
        assert.equal(inputByField(tree, 'heartbeatIntervalSeconds').props.disabled, true, `${candidate.label}：热字段应禁用`);
        assert.match(textOf(tree).join(' '), /暂不可编辑：当前未找到本插件的可写配置入口/, `${candidate.label}：应出只读提示`);
        // 尝试点击保存（即便被禁用也要确认不发请求）。
        findOne(tree, byAriaLabel('保存')).props.onClick?.();
        await settle(plugin.runtime, Section, {});
        assert.equal(fetcher.calls.filter(call => call.method === 'POST').length, 0, `${candidate.label}：零 POST`);
    }
});

test('字段元数据只认已知配置名：未知名不误禁热字段、不误提示、不误解锁', async () => {
    const body = configBody({
        editable: true,
        readonlyFields: ['heartbeatIntervalSeconds', 'notAField', '', 42, null],
        restartRequiredFields: ['notAField', 'nope'],
        liveFields: ['enabled', 'ghostField'],
    });
    const fetcher = defaultFetch({ config: body });
    hostState.fetch = fetcher;
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});
    const text = textOf(tree).join(' ');
    // restartRequired 全为未知名 → 冷字段提示不得出现（不误提示）。
    assert.doesNotMatch(text, /部分字段需重载后生效/);
    // known 的 heartbeatIntervalSeconds 被标 readonly → 逐字段禁用。
    assert.equal(inputByField(tree, 'heartbeatIntervalSeconds').props.disabled, true);
    // 未知 readonly 名不得「解锁」其它热字段；其余已知热字段仍可编辑。
    assert.equal(inputByField(tree, 'idleThresholdSeconds').props.disabled, false);
    assert.equal(inputByField(tree, 'flushIntervalSeconds').props.disabled, false);
    // 整体 editable=true 仍可保存，但不因未知元数据而放行被标 readonly 的字段。
    assert.equal(findOne(tree, byAriaLabel('保存')).props.disabled, false);
    // 只读展示的存储目录仍在页面中（未知元数据不改变其只读展示语义）。
    assert.match(text, /settings.storage|只显示/);
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
    assert.equal(plugin.seats.length, 4, '语言切换不应重新注册座位');
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


/* -------------------------------------------------------------------------- *
 * 授权 fail-closed：缺 editable / 非布尔真值一律不解锁
 * -------------------------------------------------------------------------- */

/** 造一个只返回给定 config 的 fetcher，并渲染设置页。 */
async function renderSettings(configOverrides) {
    // 传进来的若已是完整 config 回包（含 config 字段），就原样使用：
    // 否则 configBody() 会把缺失的 editable 用默认 true 补回来，导致
    // 「缺 editable」用例实际拿到 editable:true，测不到 fail-closed。
    const body = configOverrides !== null && typeof configOverrides === 'object'
        && Object.hasOwn(configOverrides, 'config')
        ? configOverrides
        : configBody(configOverrides);
    const fetcher = makeFetch((url) => {
        if (url.includes('/summary')) return jsonResponse(summaryBody());
        return jsonResponse(body);
    });
    hostState.fetch = fetcher;
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});
    return { fetcher, plugin, tree };
}

test('缺少 editable 字段：一律不解锁（控件禁用 + 零 POST）', async () => {
    // 直接删掉 editable：不能因为"看起来正常"就默认可写。
    const missing = configBody();
    delete missing.editable;
    const { fetcher, tree } = await renderSettings(missing);
    assert.equal(findOne(tree, byAriaLabel('保存')).props.disabled, true, '缺 editable 必须禁用保存');
    assert.equal(inputByField(tree, 'heartbeatIntervalSeconds').props.disabled, true, '缺 editable 必须禁用字段');
    const text = textOf(tree).join(' ');
    assert.match(text, /暂不可编辑/, '缺 editable 必须显示未授权提示');
    findOne(tree, byAriaLabel('保存')).props.onClick?.();
    await tick();
    assert.equal(fetcher.calls.filter(call => call.method === 'POST').length, 0, '缺 editable 绝不可 POST');
});

test('editable 非布尔真值（"true" / 1 / {} / []）：都不算授权', async () => {
    for (const bogus of ['true', 1, {}, [], 'yes', '1']) {
        const { fetcher, tree } = await renderSettings(configBody({ editable: bogus }));
        assert.equal(findOne(tree, byAriaLabel('保存')).props.disabled, true,
            'editable=' + JSON.stringify(bogus) + ' 必须禁用保存');
        assert.equal(inputByField(tree, 'heartbeatIntervalSeconds').props.disabled, true,
            'editable=' + JSON.stringify(bogus) + ' 必须禁用字段');
        findOne(tree, byAriaLabel('保存')).props.onClick?.();
        await tick();
        assert.equal(fetcher.calls.filter(call => call.method === 'POST').length, 0,
            'editable=' + JSON.stringify(bogus) + ' 绝不可 POST');
    }
});

test('editable 缺失但带冷字段元数据：仍不得因元数据而解锁', async () => {
    const missing = configBody({
        readonlyFields: ['storageDirectory'],
        restartRequiredFields: ['storageDirectory'],
        liveFields: ['enabled', 'heartbeatIntervalSeconds'],
    });
    delete missing.editable;
    const { fetcher, tree } = await renderSettings(missing);
    assert.equal(findOne(tree, byAriaLabel('保存')).props.disabled, true, '元数据不能替代 editable 授权');
    assert.equal(inputByField(tree, 'heartbeatIntervalSeconds').props.disabled, true);
    findOne(tree, byAriaLabel('保存')).props.onClick?.();
    await tick();
    assert.equal(fetcher.calls.filter(call => call.method === 'POST').length, 0);
});

/* -------------------------------------------------------------------------- *
 * 字段元数据白名单：未知/缺失不得误禁、误提示、误放行
 * -------------------------------------------------------------------------- */

test('readonlyFields 含未知名：未知名不得连带禁用其它热字段', async () => {
    const { tree } = await renderSettings(configBody({
        editable: true,
        readonlyFields: ['storageDirectory', 'unknownField', 'totallyMadeUp'],
        restartRequiredFields: ['unknownField'],
    }));
    const storageInput = inputByField(tree, 'storageDirectory');
    assert.ok(storageInput === null || storageInput.props.disabled === true, 'storageDirectory 必须只读/禁用');
    assert.equal(inputByField(tree, 'heartbeatIntervalSeconds').props.disabled, false, '未知名不得连带禁用热字段');
    assert.equal(inputByField(tree, 'flushIntervalSeconds').props.disabled, false);
    assert.equal(findOne(tree, byAriaLabel('保存')).props.disabled, false);
});

test('restartRequiredFields 只含未知名：不得凭空造重载提示', async () => {
    const { tree } = await renderSettings(configBody({
        editable: true,
        readonlyFields: [],
        restartRequiredFields: ['unknownField', 'madeUpCold'],
    }));
    const text = textOf(tree).join(' ');
    assert.doesNotMatch(text, /部分字段需重载后生效/, '未知冷字段不得触发重载提示');
    assert.doesNotMatch(text, /不会立即迁移/, '未知冷字段不得触发迁移提示');
    assert.equal(inputByField(tree, 'heartbeatIntervalSeconds').props.disabled, false);
});

test('只有 storageDirectory 这类已知冷字段才出重载提示', async () => {
    const { tree } = await renderSettings(configBody({
        editable: true,
        readonlyFields: ['storageDirectory'],
        restartRequiredFields: ['storageDirectory'],
    }));
    const text = textOf(tree).join(' ');
    assert.match(text, /部分字段需重载后生效/, '已知冷字段必须出重载提示');
    assert.equal(inputByField(tree, 'heartbeatIntervalSeconds').props.disabled, false, '热字段不受冷字段影响');
});

test('元数据是字符串而非数组：不得被误解析成授权/禁用', async () => {
    const { tree } = await renderSettings(configBody({
        editable: true,
        readonlyFields: 'storageDirectory',
        restartRequiredFields: 'storageDirectory',
        liveFields: 'enabled',
    }));
    assert.equal(inputByField(tree, 'heartbeatIntervalSeconds').props.disabled, false);
    const text = textOf(tree).join(' ');
    assert.doesNotMatch(text, /部分字段需重载后生效/);
});

test('元数据数组含非字符串项：忽略非字符串，不崩坏', async () => {
    const { tree } = await renderSettings(configBody({
        editable: true,
        readonlyFields: [null, 1, {}, 'storageDirectory'],
    }));
    const storageInput = inputByField(tree, 'storageDirectory');
    assert.ok(storageInput === null || storageInput.props.disabled === true, '已知冷字段生效');
    assert.equal(inputByField(tree, 'heartbeatIntervalSeconds').props.disabled, false);
});

/* -------------------------------------------------------------------------- *
 * 正常 editable=true：保存精确 live patch（回归保护）
 * -------------------------------------------------------------------------- */

test('editable=true + 含未知名元数据：保存仍发精确 live patch 与 expectedRevision', async () => {
    const fetcher = makeFetch((url, init) => {
        if (url.includes('/summary')) return jsonResponse(summaryBody());
        if (init?.method === 'POST') return jsonResponse(configBody({ revision: 8 }));
        return jsonResponse(configBody({
            editable: true,
            readonlyFields: ['storageDirectory', 'unknownField'],
            restartRequiredFields: ['storageDirectory', 'bogus'],
        }));
    });
    hostState.fetch = fetcher;
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});

    const input = inputByField(tree, 'heartbeatIntervalSeconds');
    input.props.onChange?.({ target: { value: '90' } });
    // 改字段后重新渲染，用当前 render 的 Save 按钮（避免点到旧闭包里 disabled 的按钮）。
    const fresh = await settle(plugin.runtime, Section, {});
    findOne(fresh, byAriaLabel('保存')).props.onClick?.();
    await tick();
    await tick();

    const posts = fetcher.calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 1);
    const body = JSON.parse(posts[0].body);
    assert.equal(body.patch.heartbeatIntervalSeconds, 90);
    assert.equal(body.expectedRevision, 7);
    assert.equal('storageDirectory' in body.patch, false, 'cold 字段绝不出现在 patch');
    assert.equal('unknownField' in body.patch, false, '未知名绝不出现在 patch');
});


/* -------------------------------------------------------------------------- *
 * 最近活动标签：活动区间 vs 真实工具
 * -------------------------------------------------------------------------- */

/** 用给定 recent 数组渲染设置页，返回展开后的树。 */
async function renderWithRecent(recent) {
    const fetcher = makeFetch((url) => {
        if (url.includes('/summary')) return jsonResponse(summaryBody({ recent }));
        return jsonResponse(configBody());
    });
    hostState.fetch = fetcher;
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});
    return { fetcher, plugin, tree };
}

/** 抽出「最近活动」区域里每行的标签文本。
 *
 * 行结构是 div[span(时间), span(标签, title=kind), span(路径)]。
 * 每个 h() 调用只带一个 child，因此 props.children 是单节点而非数组；
 * 这里按 span 的 title 属性（绑定的正是 item.kind）精确挑出标签 span。
 */
function recentLabels(tree) {
    const section = findOne(tree, node => node.type === 'section' && node.props['data-role'] === 'recent');
    if (section === null) return [];
    const spans = findAll(section, node => node.type === 'span' && typeof node.props?.title === 'string');
    // 标签 span 与路径 span 都带 title，但只有标签 span 有「style 里带 recentTool 特征」。
    // 更稳的判据：标签 span 与其兄弟 span 同属一个 div 且它是第二个子节点。
    const rows = findAll(section, node => node.type === 'div' && node.props?.key !== undefined);
    return rows.map((row) => {
        const children = node_children(row);
        const label = children[1];
        return label === undefined ? '' : textOf(label).join(' ').trim();
    }).filter(text => text !== '');
}

/** 取 h() 节点的子节点序列（单 child 归一成数组）。 */
function node_children(node) {
    const raw = node?.props?.children;
    if (raw === undefined || raw === null) return [];
    return Array.isArray(raw) ? raw : [raw];
}

test('interval 无 tool：中英文都显示活动区间，绝不出现工具名或裸 interval', async () => {
    const intervalItem = {
        at: '2026-11-05T01:00:00.000Z',
        project: 'e:/work/alpha',
        sessionId: 's1',
        kind: 'interval',
        source: 'ai',
        tool: null,
        path: null,
    };

    // 中文
    const zh = await renderWithRecent([intervalItem]);
    const zhLabels = recentLabels(zh.tree);
    assert.ok(zhLabels.length >= 1, '应渲染出最近活动行');
    assert.equal(zhLabels[0], '活动区间', '中文 interval 必须显示"活动区间"');
    const zhText = textOf(zh.tree).join(' ');
    assert.doesNotMatch(zhText, /未知工具/, 'interval 不得显示"未知工具"');
    assert.doesNotMatch(zhText, /\binterval\b/i, '中文界面不得暴露裸 interval 标识');

    // 英文
    const en = await renderWithRecent([intervalItem]);
    en.plugin.setLang('en');
    const enTree = await settle(en.plugin.runtime, en.plugin.seats.find(seat => seat.name === 'settings.section').component, {});
    const enLabels = recentLabels(enTree);
    assert.equal(enLabels[0], 'Activity interval', '英文 interval 必须显示 Activity interval');
    const enText = textOf(enTree).join(' ');
    assert.doesNotMatch(enText, /unknown tool/i, '英文 interval 不得显示 unknown tool');
});

test('真实工具名必须原样保留（ops_bash / read / write）', async () => {
    const { tree } = await renderWithRecent([
        { at: '2026-11-05T01:05:00.000Z', project: 'e:/work/alpha', sessionId: 's1', kind: 'exec', tool: 'ops_bash', path: null },
        { at: '2026-11-05T01:04:00.000Z', project: 'e:/work/alpha', sessionId: 's1', kind: 'read', tool: 'read', path: 'e:/work/alpha/a.js' },
        { at: '2026-11-05T01:03:00.000Z', project: 'e:/work/alpha', sessionId: 's1', kind: 'write', tool: 'write_file', path: 'e:/work/alpha/b.js' },
    ]);
    const labels = recentLabels(tree);
    assert.ok(labels.length >= 3, '应渲染出三条最近活动');
    // 顺序按 recent 原序（服务端已排序）。
    assert.equal(labels[0], 'ops_bash', '真实工具名 ops_bash 必须原样展示');
    assert.equal(labels[1], 'read', '真实工具名 read 必须原样展示');
    assert.equal(labels[2], 'write_file', '真实工具名必须原样展示');
    // 不得被统一替换成活动区间。
    const text = textOf(tree).join(' ');
    assert.doesNotMatch(text, /活动区间.*ops_bash/s, '有真实工具时不得退化为活动区间');
});

test('文件变更面板：真实 workingTree 渲染 + 行数可见 + 未知 null 显示—，工时指标不被替换', async () => {
    const workingTree = {
        observedAt: '2026-11-05T01:19:00.000Z',
        truncated: false,
        projects: [{
            project: '/p', repoRoot: '/p', status: 'ok', observedAt: '2026-11-05T01:19:00.000Z',
            truncated: false,
            files: [
                { path: 'src/a.js', oldPath: null, status: 'modified', indexStatus: ' ', worktreeStatus: 'M', addedLines: 5, deletedLines: 2, binary: false },
                { path: 'new.md', oldPath: null, status: 'untracked', indexStatus: '?', worktreeStatus: '?', addedLines: null, deletedLines: null, binary: false },
            ],
        }],
    };
    const fetcher = makeFetch((url) => {
        if (url.includes('/summary')) return jsonResponse(summaryBody({ workingTree }));
        return jsonResponse(configBody());
    });
    hostState.fetch = fetcher;
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});

    const panel = findOne(tree, node => node.type === 'section' && node.props['data-role'] === 'working-tree');
    assert.ok(panel !== null, '文件变更面板必须真实挂载');
    const panelText = textOf(panel).join(' ');
    assert.match(panelText, /文件变更/, '本地化标题');
    assert.match(panelText, /src\/a\.js/, '真实修改文件路径可见');
    assert.match(panelText, /\+5/, '真实 +5 行数可见');
    assert.match(panelText, /−2/, '真实 -2 行数可见');
    assert.match(panelText, /new\.md/, '未跟踪文件路径可见');
    assert.match(panelText, /未跟踪/, '状态本地化');
    // 未知行数必须是 —，绝不冒充 0。
    assert.match(panelText, /—/, 'null 行数显示 —');
    assert.doesNotMatch(panelText, /\+0|−0|0 \/ 0/, '不得把未知行数写成 0');
    // 工时指标仍来自 summary.totals（3600s），不被 Git 行数替换或相加。
    assert.match(panelText, /当前 Git 工作区差异，不受工时日期范围影响/, '提示不受工时范围影响');
    assert.match(textOf(tree).join(' '), /1 小时 0 分/, '区间总工时必须保持原值');
});

test('无名 evidence：中性活动记录，不伪造成工具名', async () => {
    const { tree } = await renderWithRecent([
        // evidence 且无 tool：应显示中性标签，不是工具名、也不是"活动区间"。
        { at: '2026-11-05T01:02:00.000Z', project: 'e:/work/alpha', sessionId: 's1', kind: 'evidence', source: 'ai', tool: null, path: null },
        // 连 kind 都没有的极端情况：同样中性。
        { at: '2026-11-05T01:01:00.000Z', project: 'e:/work/alpha', sessionId: 's1' },
    ]);
    const labels = recentLabels(tree);
    assert.ok(labels.length >= 2);
    assert.equal(labels[0], '活动记录', '无工具 evidence 应显示"活动记录"');
    assert.equal(labels[1], '活动记录', '完全没有 kind/tool 时同样中性');
    // 绝不能出现伪造工具名。
    for (const label of labels) {
        assert.notEqual(label, 'activity', '不得显示裸英文 activity 作为工具名');
        assert.doesNotMatch(label, /未知/, '不得显示"未知工具"');
    }
});

/* -------------------------------------------------------------------------- *
 * 文件时长环形图（WakaTime 式占比）：服务端给什么就画什么，缺字段绝不造假
 * -------------------------------------------------------------------------- */

test('环形图：服务端返回 files[] 时按真实时长渲染占比与总时长', async () => {
    const files = [
        { path: 'E:/work/alpha/src/a.js', label: 'a.js', totalSeconds: 3600, touches: 3, attribution: 'apportioned' },
        { path: 'E:/work/alpha/src/b.ts', label: 'b.ts', totalSeconds: 1800, touches: 1, attribution: 'apportioned' },
        { path: '__other__', label: null, totalSeconds: 1800, touches: 1, attribution: 'apportioned' },
    ];
    hostState.fetch = makeFetch((url) => {
        if (url.includes('/summary')) return jsonResponse(summaryBody({ files }));
        return jsonResponse(configBody());
    });
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});
    const panel = findOne(tree, node => node.props?.['data-role'] === 'heatmap');
    assert.ok(panel !== null, '环形图区域必须挂载');
    const text = textOf(panel).join(' ');
    assert.match(text, /文件时长占比/);
    assert.match(text, /a\.js/);
    assert.match(text, /b\.ts/);
    assert.match(text, /其他（无文件证据）/, '无文件证据的桶本地化为「其他」');
    assert.match(text, /2h 00m/, '中心用紧凑格式显示真实总时长：3600+1800+1800 = 2h 00m');
    assert.match(text, /50%/, '最大段占比可见');
    assert.match(text, /25%/, '其余段占比可见');
    // 数据诚实：不出现 undefined/null/NaN，也不凭空造文件名。
    assert.doesNotMatch(text, /undefined|\bnull\b|NaN/);
    assert.doesNotMatch(text, /fake\.js|example\.js/);
});

test('环形图：旧后端不返回 files 字段 → 明确显示「尚未提供」，不画空环、不造占比', async () => {
    const body = summaryBody();
    delete body.files;
    hostState.fetch = makeFetch((url) => {
        if (url.includes('/summary')) return jsonResponse(body);
        return jsonResponse(configBody());
    });
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});
    const panel = findOne(tree, node => node.props?.['data-role'] === 'heatmap');
    assert.ok(panel !== null);
    const text = textOf(panel).join(' ');
    assert.match(text, /尚未提供文件级时长数据/);
    assert.doesNotMatch(text, /\d+%/, '缺字段时绝不能凭空出现占比数字');
    assert.equal(findOne(panel, node => node.props?.style?.background?.includes?.('conic-gradient')), null, '不应画出环形');
});

test('环形图：files 为空数组 → 显示空态，不画环、不出现占比', async () => {
    hostState.fetch = makeFetch((url) => {
        if (url.includes('/summary')) return jsonResponse(summaryBody({ files: [] }));
        return jsonResponse(configBody());
    });
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});
    const panel = findOne(tree, node => node.props?.['data-role'] === 'heatmap');
    assert.ok(panel !== null);
    const text = textOf(panel).join(' ');
    assert.match(text, /该范围还没有文件级活跃时长数据/);
    assert.doesNotMatch(text, /\d+%/);
});

test('环形图：files 里时长为 0 / 非数字 / 负数一律被归一丢弃，不污染占比', async () => {
    const files = [
        { path: 'a.js', label: 'a.js', totalSeconds: 3600, touches: 1, attribution: 'apportioned' },
        { path: 'zero.js', label: null, totalSeconds: 0, touches: 1, attribution: 'apportioned' },
        { path: 'neg.js', label: null, totalSeconds: -50, touches: 1, attribution: 'apportioned' },
        { path: 'str.js', label: null, totalSeconds: '3600', touches: 1, attribution: 'apportioned' },
    ];
    hostState.fetch = makeFetch((url) => {
        if (url.includes('/summary')) return jsonResponse(summaryBody({ files }));
        return jsonResponse(configBody());
    });
    hostState.document = makeDocument();
    const plugin = mountPlugin();
    const Section = plugin.seats.find(seat => seat.name === 'settings.section').component;
    const tree = await settle(plugin.runtime, Section, {});
    const panel = findOne(tree, node => node.props?.['data-role'] === 'heatmap');
    const text = textOf(tree).join(' ');
    assert.match(text, /a\.js/);
    assert.doesNotMatch(text, /zero\.js|neg\.js|str\.js/, '无效时长项不得进入占比图');
    assert.doesNotMatch(text, /undefined|\bnull\b|NaN/);
});

/* -------------------------------------------------------------------------- *
 * 格式化缓存：实例复用、参数隔离、失败不缓存、有界淘汰
 * -------------------------------------------------------------------------- */

/**
 * 在独立 vm 沙箱里重新加载一次客户端源码，拿到「冷缓存」的 __test。
 *
 * 该沙箱的 Intl 换成计数 stub：包住真实构造器并记录构造次数，保留原型与
 * supportedLocalesOf 静态方法，行为与原生一致；restore() 把 Intl 换回原对象。
 */
function loadFreshClient() {
    const definitions = [];
    const realIntl = Intl;
    const counts = { number: 0, dateTime: 0 };
    const stubIntl = {
        NumberFormat: function CountingNumberFormat(...args) {
            counts.number += 1;
            return new realIntl.NumberFormat(...args);
        },
        DateTimeFormat: function CountingDateTimeFormat(...args) {
            counts.dateTime += 1;
            return new realIntl.DateTimeFormat(...args);
        },
    };
    stubIntl.NumberFormat.prototype = realIntl.NumberFormat.prototype;
    stubIntl.NumberFormat.supportedLocalesOf = realIntl.NumberFormat.supportedLocalesOf;
    stubIntl.DateTimeFormat.prototype = realIntl.DateTimeFormat.prototype;
    stubIntl.DateTimeFormat.supportedLocalesOf = realIntl.DateTimeFormat.supportedLocalesOf;
    const localSandbox = {
        window: { __ModuleLoader__: { load(definition) { definitions.push(definition); } } },
        console,
        Intl: stubIntl,
    };
    const localContext = vm.createContext(localSandbox);
    vm.runInContext(clientSource, localContext, { filename: 'client/index.js' });
    const localModule = definitions[0].factory(() => ({ createElement: () => null }));
    return {
        test: localModule.__test,
        counts,
        restore() {
            localSandbox.Intl = realIntl;
        },
    };
}

test('格式化缓存：同参复用、语言/时区隔离，输出与原生一致', () => {
    assert.equal(typeof definition.factory(() => ({ createElement: () => null })).__test.formatDateTime, 'function',
        'formatDateTime 必须出现在 __test 导出里');

    const fresh = loadFreshClient();
    try {
        const { test: t, counts } = fresh;
        const iso = '2026-11-05T01:20:00.000Z';
        const nativeDate = (locale, timezone) => new Intl.DateTimeFormat(locale, {
            timeZone: timezone,
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(new Date(Date.parse(iso)));

        // 数字：同语言重复调用只构造一次
        assert.equal(t.formatNumber(1234.5, 'zh'), new Intl.NumberFormat('zh-CN').format(1234.5));
        assert.equal(counts.number, 1);
        assert.equal(t.formatNumber(9876, 'zh'), new Intl.NumberFormat('zh-CN').format(9876));
        assert.equal(counts.number, 1, '同语言必须复用同一个 NumberFormat');

        // 换语言必须另建实例，输出与原生一致
        assert.equal(t.formatNumber(1234.5, 'en'), new Intl.NumberFormat('en-US').format(1234.5));
        assert.equal(counts.number, 2);
        assert.equal(t.formatNumber(1234.5, 'en'), new Intl.NumberFormat('en-US').format(1234.5));
        assert.equal(counts.number, 2);

        // 日期时间：同语言 + 同时区只构造一次
        const shanghai = t.formatDateTime(iso, 'Asia/Shanghai', 'zh');
        assert.equal(shanghai, nativeDate('zh-CN', 'Asia/Shanghai'));
        assert.equal(counts.dateTime, 1);
        assert.equal(t.formatDateTime(iso, 'Asia/Shanghai', 'zh'), shanghai);
        assert.equal(counts.dateTime, 1, '同语言同时区必须复用');

        // 换时区不能串缓存
        const tokyo = t.formatDateTime(iso, 'Asia/Tokyo', 'zh');
        assert.equal(counts.dateTime, 2);
        assert.equal(tokyo, nativeDate('zh-CN', 'Asia/Tokyo'));
        assert.notEqual(shanghai, tokyo, '不同时区必须给出不同结果');

        // 换语言不能串缓存
        const english = t.formatDateTime(iso, 'Asia/Shanghai', 'en');
        assert.equal(counts.dateTime, 3);
        assert.equal(english, nativeDate('en-US', 'Asia/Shanghai'));

        // 空时区与 undefined/null 共用「本地时区」这一个槽位
        const local = t.formatDateTime(iso, undefined, 'zh');
        assert.equal(counts.dateTime, 4);
        assert.equal(local, nativeDate('zh-CN', undefined));
        assert.equal(t.formatDateTime(iso, '', 'zh'), local);
        assert.equal(t.formatDateTime(iso, null, 'zh'), local);
        assert.equal(counts.dateTime, 4, '空时区必须与本地时区共用实例');

        // 非法时区：保持原 fallback，且失败构造不进缓存
        const fallback = iso.slice(0, 16).replace('T', ' ');
        assert.equal(t.formatDateTime(iso, 'Not/AZone', 'zh'), fallback);
        const afterFirstFailure = counts.dateTime;
        assert.equal(t.formatDateTime(iso, 'Not/AZone', 'zh'), fallback);
        assert.equal(counts.dateTime, afterFirstFailure + 1, '失败构造不能被缓存');
        assert.equal(t.formatDateTime(iso, 'Asia/Shanghai', 'zh'), shanghai);
        assert.equal(counts.dateTime, afterFirstFailure + 1, '失败不能污染已成功的缓存');

        // 空值 / 非法时间语义不变，且完全不构造格式化器
        const before = { ...counts };
        assert.equal(t.formatNumber(null, 'zh'), null);
        assert.equal(t.formatNumber(undefined, 'zh'), null);
        assert.equal(t.formatNumber(Number.NaN, 'zh'), null);
        assert.equal(t.formatNumber('12', 'zh'), null);
        assert.equal(t.formatDateTime(null, 'Asia/Shanghai', 'zh'), null);
        assert.equal(t.formatDateTime('', 'Asia/Shanghai', 'zh'), null);
        assert.equal(t.formatDateTime(undefined, 'Asia/Shanghai', 'zh'), null);
        assert.equal(t.formatDateTime('nope', 'Asia/Shanghai', 'zh'), 'nope');
        sameJson(counts, before, '空值/非法时间不应触发实例构造');
    }
    finally {
        fresh.restore();
    }
});

test('格式化缓存有界：超过 32 项按插入顺序淘汰最旧', () => {
    const zones = [
        'UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Kolkata',
        'Asia/Dubai', 'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Manila',
        'Asia/Karachi', 'Asia/Tehran', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
        'Europe/Rome', 'Europe/Moscow', 'Europe/Warsaw', 'Europe/Stockholm', 'Europe/Lisbon', 'Europe/Athens',
        'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto',
        'America/Sao_Paulo', 'America/Mexico_City', 'Australia/Sydney', 'Pacific/Auckland',
    ];
    assert.equal(zones.length, 33, '用例需要 33 个不同时区才越过 32 项上限');
    const fresh = loadFreshClient();
    try {
        const { test: t, counts } = fresh;
        const iso = '2026-11-05T01:20:00.000Z';
        for (const zone of zones) {
            assert.equal(t.formatDateTime(iso, zone, 'en'),
                new Intl.DateTimeFormat('en-US', {
                    timeZone: zone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
                }).format(new Date(Date.parse(iso))));
        }
        assert.equal(counts.dateTime, 33, '33 个不同时区各构造一次');
        // 第 33 次写入时最旧项被淘汰：再取要重新构造
        t.formatDateTime(iso, zones[0], 'en');
        assert.equal(counts.dateTime, 34, '超出上限后最旧项必须已被淘汰');
        // 最近写入的仍在缓存里
        t.formatDateTime(iso, zones[32], 'en');
        assert.equal(counts.dateTime, 34, '缓存内的项仍应命中，不应无限增长');
    }
    finally {
        fresh.restore();
    }
});
