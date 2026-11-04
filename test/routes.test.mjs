/**
 * routes 单测：把 HTTP 门卫与响应形状钉死。
 *
 * 重点是**鉴权 fail-closed**：任何"拿不到可靠结论"的路径都必须拒绝，
 * 绝不因为异常而放行；以及 **导出必须是真实数据**，不能是空文件。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { authorize, mountRoutes, ROUTE_PREFIX, summaryToCsv } from '../lib/routes.js';

/** 记录写出的响应。 */
function makeResponse() {
    return {
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
            if (typeof body === 'string') this.body = body;
            this.headersSent = true;
        },
        json() {
            return JSON.parse(this.body);
        },
    };
}

/** 造请求。 */
function makeRequest({ method = 'GET', url = '/', headers = {}, body } = {}) {
    const request = { method, url, headers };
    if (body !== undefined) request.body = body;
    return request;
}

/** context 替身。 */
function makeContext(services = {}) {
    return {
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        get: name => services[name],
        effect: fn => {
            const dispose = fn();
            return () => {
                if (typeof dispose === 'function') dispose();
            };
        },
        inject: (names, callback) => callback({
            ...makeContext(services),
            webServer: services.webServer,
            get: innerName => (innerName === 'webServer' ? services.webServer : services[innerName]),
        }),
    };
}

/** 装配一个 webServer 替身。 */
function makeServer() {
    return {
        routes: new Map(),
        register(route) {
            this.routes.set(route.path, route.handler);
            return () => this.routes.delete(route.path);
        },
    };
}

/** 直接调用某条路由。 */
async function call(server, routePath, request) {
    const handler = server.routes.get(routePath);
    assert.ok(handler !== undefined, `路由 ${routePath} 未注册`);
    const response = makeResponse();
    await handler(request, response);
    return response;
}

test('authorize：undefined 才放行，401/403 原样回', async () => {
    const allow = { requestRejection: () => undefined };
    assert.deepEqual(authorize({ get: () => allow }, { headers: {} }), { allowed: true, status: 200, code: 'ok' });

    const deny401 = { requestRejection: () => 401 };
    assert.deepEqual(authorize({ get: () => deny401 }, { headers: {} }), { allowed: false, status: 401, code: 'unauthorized' });

    const deny403 = { requestRejection: () => 403 };
    assert.deepEqual(authorize({ get: () => deny403 }, { headers: {} }), { allowed: false, status: 403, code: 'forbidden' });
});

test('authorize fail-closed：connection 缺失/无方法/抛错/未知返回值全拒', async () => {
    // 没有 connection 服务。
    assert.equal(authorize({ get: () => undefined }, { headers: {} }).allowed, false);
    assert.equal(authorize({ get: () => undefined }, { headers: {} }).status, 401);
    // ctx.get 本身抛错。
    assert.equal(authorize({ get: () => { throw new Error('boom'); } }, { headers: {} }).allowed, false);
    // 服务存在但没有 requestRejection。
    assert.equal(authorize({ get: () => ({}) }, { headers: {} }).allowed, false);
    // 判定抛错：绝不降级放行。
    const throws = { requestRejection: () => { throw new Error('evaluation failed'); } };
    assert.deepEqual(authorize({ get: () => throws }, { headers: {} }), {
        allowed: false, status: 403, code: 'authorization_failed',
    });
    // 未知返回值（含 409 之类）。
    const weird = { requestRejection: () => 409 };
    assert.deepEqual(authorize({ get: () => weird }, { headers: {} }), {
        allowed: false, status: 403, code: 'unexpected_verdict',
    });
    // 请求本身不可读。
    assert.equal(authorize({ get: () => ({ requestRejection: () => undefined }) }, {}).allowed, false);
});

test('未认证请求命中任一路由都不会执行 handler', async () => {
    const server = makeServer();
    let summarizeCalls = 0;
    const ctx = makeContext({ webServer: server });
    mountRoutes(ctx, {
        summarize: async () => { summarizeCalls += 1; return { ok: true }; },
        getConfig: async () => ({ config: {} }),
        saveConfig: async () => ({ config: {} }),
    });

    // connection 缺失 → 401，且 handler 未执行。
    const summary = await call(server, `${ROUTE_PREFIX}/summary`, makeRequest({ url: `${ROUTE_PREFIX}/summary` }));
    assert.equal(summary.status, 401);
    assert.equal(summarizeCalls, 0, '未认证时绝不允许执行 summarize');
    assert.equal(summary.json().error.code, 'connection_unavailable');
    // 未认证时 config 的写入口同样不得执行。
    let configWrites = 0;
    const server2 = makeServer();
    mountRoutes(makeContext({ webServer: server2 }), {
        getConfig: async () => ({ editable: true, config: {} }),
        saveConfig: async () => { configWrites += 1; return { editable: true, config: {} }; },
    });
    const configPost = await call(server2, `${ROUTE_PREFIX}/config`, makeRequest({
        method: 'POST',
        url: `${ROUTE_PREFIX}/config`,
        body: JSON.stringify({ patch: { enabled: false } }),
    }));
    assert.equal(configPost.status, 401);
    assert.equal(configWrites, 0, '未认证时绝不允许写配置');
});

test('鉴权返回 403 时原样回 403，且 handler 未执行', async () => {
    const server = makeServer();
    let calls = 0;
    const deny = { requestRejection: () => 403 };
    mountRoutes(makeContext({ webServer: server, connection: deny }), {
        summarize: async () => { calls += 1; return { ok: true }; },
    });
    const forbidden = await call(server, `${ROUTE_PREFIX}/summary`, makeRequest({ url: `${ROUTE_PREFIX}/summary` }));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json().error.code, 'forbidden');
    assert.equal(calls, 0);
});

test('鉴权通过后 summary 返回 200 与真实字段', async () => {
    const server = makeServer();
    const allow = { requestRejection: () => undefined };
    const payload = {
        version: 2,
        ok: true,
        totals: {
            aiSeconds: 120,
            humanSeconds: null,
            totalSeconds: 120,
            aiAddedLines: null,
            aiDeletedLines: null,
            lineDataQuality: 'unavailable',
            sessions: 2,
            projects: 1,
        },
        projects: [{ project: 'C:\\proj', label: 'proj', cwd: 'C:\\proj', aiSeconds: 120, sessions: 2 }],
        days: [{ date: '2026-11-05', aiSeconds: 120 }],
    };
    mountRoutes(makeContext({ webServer: server, connection: allow }), {
        summarize: async query => ({ ...payload, echoed: query }),
    });
    const response = await call(server, `${ROUTE_PREFIX}/summary`, makeRequest({
        url: `${ROUTE_PREFIX}/summary?preset=today`,
        headers: {},
    }));
    assert.equal(response.status, 200);
    assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(response.headers['Cache-Control'], 'no-store');
    const body = response.json();
    assert.equal(body.totals.aiSeconds, 120);
    assert.equal(body.totals.humanSeconds, null, '未采集人类时长必须是 null');
    assert.equal(body.totals.totalSeconds, 120);
    assert.equal(body.echoed.preset, 'today');
});

test('summary 只接受 GET，其它方法 405', async () => {
    const server = makeServer();
    const allow = { requestRejection: () => undefined };
    mountRoutes(makeContext({ webServer: server, connection: allow }), {
        summarize: async () => ({ ok: true }),
    });
    const response = await call(server, `${ROUTE_PREFIX}/summary`, makeRequest({
        method: 'POST',
        url: `${ROUTE_PREFIX}/summary`,
    }));
    assert.equal(response.status, 405);
    assert.equal(response.json().error.code, 'method_not_allowed');
});

test('鉴权通过但 handler 抛错 → 500，绝不因此放行或泄露细节', async () => {
    const server = makeServer();
    const allow = { requestRejection: () => undefined };
    mountRoutes(makeContext({ webServer: server, connection: allow }), {
        summarize: async () => { throw new Error('secret internals: C:\\secret\\path'); },
    });
    const response = await call(server, `${ROUTE_PREFIX}/summary`, makeRequest({ url: `${ROUTE_PREFIX}/summary` }));
    assert.equal(response.status, 500);
    const body = response.json();
    assert.equal(body.error.code, 'internal_error');
    assert.equal(JSON.stringify(body).includes('secret'), false, '不得把内部错误细节回给客户端');
});

test('config GET 返回真实配置与 editable 标记', async () => {
    const server = makeServer();
    const allow = { requestRejection: () => undefined };
    mountRoutes(makeContext({ webServer: server, connection: allow }), {
        getConfig: async () => ({
            editable: true,
            namespace: 'dsh-coding-time',
            revision: 7,
            profile: 'desktop',
            config: { enabled: true, timezone: 'Asia/Shanghai' },
            storageDirectory: 'C:\\Users\\x\\.dsh\\coding-time',
            stats: { projects: 2, journalShards: 3, records: 40, bytes: 1024 },
            warnings: [],
        }),
    });
    const response = await call(server, `${ROUTE_PREFIX}/config`, makeRequest({ url: `${ROUTE_PREFIX}/config` }));
    assert.equal(response.status, 200);
    const body = response.json();
    assert.equal(body.editable, true);
    assert.equal(body.namespace, 'dsh-coding-time');
    assert.equal(body.revision, 7);
    assert.equal(body.storageDirectory, 'C:\\Users\\x\\.dsh\\coding-time');
});

test('config POST 非法值 → 422 带字段路径；revision 冲突 → 409', async () => {
    const server = makeServer();
    const allow = { requestRejection: () => undefined };
    const { ConfigError } = await import('../lib/config.js');
    mountRoutes(makeContext({ webServer: server, connection: allow }), {
        getConfig: async () => ({ editable: true, config: {} }),
        saveConfig: async ({ patch }) => {
            if (patch?.fail === 'config') {
                throw new ConfigError('必须不小于 5', { code: 'invalid_number', path: 'heartbeatIntervalSeconds' });
            }
            if (patch?.fail === 'revision') {
                const error = new Error('revision stale');
                error.code = 'revision_conflict';
                throw error;
            }
            return { editable: true, config: { ...patch } };
        },
    });

    const invalid = await call(server, `${ROUTE_PREFIX}/config`, makeRequest({
        method: 'POST',
        url: `${ROUTE_PREFIX}/config`,
        body: JSON.stringify({ patch: { fail: 'config' } }),
    }));
    assert.equal(invalid.status, 422);
    assert.equal(invalid.json().error.code, 'invalid_config');
    assert.equal(invalid.json().error.path, 'heartbeatIntervalSeconds');

    const conflict = await call(server, `${ROUTE_PREFIX}/config`, makeRequest({
        method: 'POST',
        url: `${ROUTE_PREFIX}/config`,
        body: JSON.stringify({ fail: 'revision' }),
    }));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json().error.code, 'revision_conflict');
});

test('export 产出真实 CSV，不是空文件', async () => {
    const server = makeServer();
    const allow = { requestRejection: () => undefined };
    const payload = {
        generatedAt: '2026-11-05T00:00:00.000Z',
        timezone: 'Asia/Shanghai',
        profile: 'desktop',
        humanStatus: 'disabled',
        range: { from: '2026-11-04T16:00:00.000Z', to: '2026-11-05T16:00:00.000Z' },
        totals: {
            aiSeconds: 120,
            humanSeconds: null,
            totalSeconds: 120,
            aiAddedLines: 12,
            aiDeletedLines: 3,
            lineDataQuality: 'full',
            sessions: 2,
        },
        projects: [{
            project: 'C:\\proj',
            cwd: 'C:\\proj',
            aiSeconds: 120,
            humanSeconds: null,
            totalSeconds: 120,
            aiAddedLines: 12,
            aiDeletedLines: 3,
            sessions: 2,
        }],
        days: [{ date: '2026-11-05', totalSeconds: 120, aiSeconds: 120, aiAddedLines: 12, aiDeletedLines: 3 }],
    };
    mountRoutes(makeContext({ webServer: server, connection: allow }), {
        summarize: async () => payload,
    });
    const response = await call(server, `${ROUTE_PREFIX}/export`, makeRequest({
        url: `${ROUTE_PREFIX}/export?format=csv`,
    }));
    assert.equal(response.status, 200);
    assert.equal(response.headers['Content-Type'], 'text/csv; charset=utf-8');
    assert.match(response.headers['Content-Disposition'], /attachment/);
    assert.ok(response.body.length > 0, 'CSV 不能是空文件');
    assert.match(response.body, /scope,project,date,source,duration_seconds/);
    const totalRow = response.body.split('\n').find(line => line.startsWith('total,'));
    assert.ok(totalRow !== undefined, '必须有 total 行');
    const cells = totalRow.split(',');
    assert.equal(cells[4], '120', '真实总时长');
    assert.equal(cells[5], '120', '真实 AI 时长');
    assert.equal(cells[6], '', '未采集人类时长必须是空格，不能是 0');
    assert.equal(cells[7], '12', '真实新增行数');
    assert.equal(cells[8], '3', '真实删除行数');
    assert.ok(response.body.split('\n').some(line => line.startsWith('project,') && line.includes('proj')),
        'CSV 必须含真实项目行');
});

test('export 只支持 csv/json，其它 400', async () => {
    const server = makeServer();
    const allow = { requestRejection: () => undefined };
    mountRoutes(makeContext({ webServer: server, connection: allow }), {
        summarize: async () => ({ summary: {} }),
    });
    const response = await call(server, `${ROUTE_PREFIX}/export`, makeRequest({
        url: `${ROUTE_PREFIX}/export?format=xml`,
    }));
    assert.equal(response.status, 400);
    assert.equal(response.json().error.code, 'unsupported_format');
});

test('summaryToCsv 把 null 渲染成空单元格（不与 0 混淆）', () => {
    const csv = summaryToCsv({
        generatedAt: '2026-11-05T00:00:00.000Z',
        totals: {
            aiSeconds: 0,
            humanSeconds: null,
            totalSeconds: 0,
            aiAddedLines: null,
            aiDeletedLines: null,
            lineDataQuality: 'unavailable',
            sessions: 0,
        },
        projects: [],
        days: [],
    });
    const totalRow = csv.split('\n').find(line => line.startsWith('total,'));
    assert.ok(totalRow !== undefined);
    const cells = totalRow.split(',');
    // human_seconds / lines_added / lines_deleted 必须是空（未采集），不是 0。
    assert.equal(cells[6], '');
    assert.equal(cells[7], '');
    assert.equal(cells[8], '');
    // ai_seconds 是明确的 0（有采集但确实为 0）。
    assert.equal(cells[5], '0');
});

test('无 webServer 时不注册任何路由，且不抛错', async () => {
    let called = 0;
    const release = mountRoutes(makeContext({}), {
        summarize: async () => { called += 1; return {}; },
    });
    assert.equal(called, 0);
    assert.equal(typeof release, 'function');
    release();
});

test('缺失 summarize 依赖时 summary 返回 503，而不是抛到宿主', async () => {
    const server = makeServer();
    const allow = { requestRejection: () => undefined };
    mountRoutes(makeContext({ webServer: server, connection: allow }), {});
    const response = await call(server, `${ROUTE_PREFIX}/summary`, makeRequest({ url: `${ROUTE_PREFIX}/summary` }));
    assert.equal(response.status, 503);
    assert.equal(response.json().error.code, 'collector_unavailable');
});

test('路由前缀是 /plugins/dsh-coding-time/api', () => {
    assert.equal(ROUTE_PREFIX, '/plugins/dsh-coding-time/api');
});

test('三条路由都以 exact 注册且互不覆盖', async () => {
    const server = makeServer();
    mountRoutes(makeContext({ webServer: server, connection: { requestRejection: () => undefined } }), {
        summarize: async () => ({ ok: true }),
        getConfig: async () => ({ editable: true, config: {} }),
        saveConfig: async () => ({ editable: true, config: {} }),
    });
    assert.deepEqual([...server.routes.keys()].sort(), [
        `${ROUTE_PREFIX}/config`,
        `${ROUTE_PREFIX}/export`,
        `${ROUTE_PREFIX}/summary`,
    ].sort());
});
