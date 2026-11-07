/**
 * dsh-coding-time · HTTP 表面。
 *
 * 只挂宿主 `webServer` 的既有监听器：**不新起端口、不自造 decorator、不自造
 * typert 命名空间**。三条 exact 路由都走同一道门卫。
 *
 * 门卫**fail-closed**（不得回退）：
 *
 * - `connection.requestRejection(req)` 返回 `undefined` → 放行；
 * - 返回 `401` / `403` → 原样回，不降级；
 * - `connection` 缺失、没有该方法、抛错、或返回未知值 → **一律拒绝**，
 *   绝不退回"本地猜测就放行"。
 *
 * 反跨域 Origin 由宿主负责（`requestRejection` 内部即做 Host/Origin 检查）。
 *
 * @module dsh-coding-time/routes
 */
import { ConfigError, sanitizeConfig } from './config.js';

/** 路由前缀。 */
export const ROUTE_PREFIX = '/plugins/dsh-coding-time/api';

/** CSV 单次导出的行上限。 */
const CSV_MAX_ROWS = 20_000;

/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 门卫判定。
 *
 * 任何异常路径都落到 `allowed:false`——这是 fail-closed 的实现核心。
 *
 * @param ctx - 插件上下文。
 * @param req - 带 headers 的请求。
 * @returns { allowed, status, code }。
 */
export function authorize(ctx, req) {
    let connection;
    try {
        connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined;
    }
    catch {
        return { allowed: false, status: 401, code: 'connection_unavailable' };
    }
    if (connection === undefined || connection === null) {
        return { allowed: false, status: 401, code: 'connection_unavailable' };
    }
    if (typeof connection.requestRejection !== 'function') {
        return { allowed: false, status: 401, code: 'connection_unsupported' };
    }
    const headers = req?.headers;
    if (headers === undefined || headers === null || typeof headers !== 'object') {
        return { allowed: false, status: 403, code: 'request_unreadable' };
    }
    let verdict;
    try {
        verdict = connection.requestRejection({ headers });
    }
    catch {
        return { allowed: false, status: 403, code: 'authorization_failed' };
    }
    if (verdict === undefined) return { allowed: true, status: 200, code: 'ok' };
    if (verdict === 401) return { allowed: false, status: 401, code: 'unauthorized' };
    if (verdict === 403) return { allowed: false, status: 403, code: 'forbidden' };
    return { allowed: false, status: 403, code: 'unexpected_verdict' };
}

/**
 * JSON 回包。
 * @param res - 响应。
 * @param status - 状态码。
 * @param body - 可序列化对象。
 * @param extraHeaders - 追加头。
 */
export function sendJson(res, status, body, extraHeaders = {}) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders,
    });
    res.end(JSON.stringify(body, null, 2));
}

/**
 * 错误回包。
 * @param res - 响应。
 * @param status - 状态码。
 * @param code - 机器可读 code。
 * @param message - 人读说明。
 * @param extra - 附加字段。
 */
export function sendError(res, status, code, message, extra = {}) {
    sendJson(res, status, { version: 2, ok: false, error: { code, message, ...extra } });
}

/**
 * 读取请求体（有界）。
 * @param req - 请求。
 * @returns Buffer 或 null（超限）。
 */
async function readBody(req) {
    if (req === null || typeof req !== 'object') return Buffer.alloc(0);
    if (typeof req[Symbol.asyncIterator] !== 'function') {
        if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
        if (typeof req.body === 'object' && req.body !== null) return Buffer.from(JSON.stringify(req.body), 'utf8');
        return Buffer.alloc(0);
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buffer.length;
        if (size > MAX_BODY_BYTES) return null;
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

/**
 * 解析请求 URL。
 * @param req - 请求。
 * @returns URL。
 */
function requestUrl(req) {
    const raw = typeof req?.url === 'string' ? req.url : '/';
    try {
        return new URL(raw, 'http://127.0.0.1');
    } catch {
        return new URL('http://127.0.0.1/');
    }
}

/** CSV 单元转义。 */
function csvCell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** null/undefined → 空串（CSV 里 null 必须与 0 区分）。 */
function csvNumber(value) {
    if (typeof value !== 'number' || Number.isFinite(value) === false) return '';
    return String(value);
}

/**
 * 把 summary 响应渲染成 CSV。
 *
 * 直接读**约定的顶层字段**（`totals/projects/days`），`null` 一律渲染成**空单元格**
 * （与 0 区分——"未采集"和"真的是零"不同）。
 *
 * @param payload - summarizeNow 的响应体。
 * @returns CSV 文本。
 */
export function summaryToCsv(payload) {
    const totals = payload?.totals ?? {};
    const lines = [];
    lines.push('# dsh-coding-time summary');
    lines.push(`# generatedAt,${csvCell(payload?.generatedAt ?? '')}`);
    lines.push(`# timezone,${csvCell(payload?.timezone ?? '')}`);
    lines.push(`# profile,${csvCell(payload?.profile ?? '')}`);
    lines.push(`# rangeFrom,${csvCell(payload?.range?.from ?? '')}`);
    lines.push(`# rangeTo,${csvCell(payload?.range?.to ?? '')}`);
    lines.push(`# humanStatus,${csvCell(payload?.humanStatus ?? '')}`);
    lines.push(`# lineDataQuality,${csvCell(totals?.lineDataQuality ?? '')}`);
    lines.push('');
    lines.push('scope,project,date,source,duration_seconds,ai_seconds,human_seconds,lines_added,lines_deleted,sessions');
    lines.push([
        'total', '', '', '',
        csvNumber(totals?.totalSeconds),
        csvNumber(totals?.aiSeconds),
        csvNumber(totals?.humanSeconds),
        csvNumber(totals?.aiAddedLines),
        csvNumber(totals?.aiDeletedLines),
        csvNumber(totals?.sessions),
    ].join(','));
    let rows = 0;
    for (const row of payload?.projects ?? []) {
        if (rows >= CSV_MAX_ROWS) break;
        lines.push([
            'project', csvCell(row.project ?? ''), '', '',
            csvNumber(row.totalSeconds),
            csvNumber(row.aiSeconds),
            csvNumber(row.humanSeconds),
            csvNumber(row.aiAddedLines),
            csvNumber(row.aiDeletedLines),
            csvNumber(row.sessions),
        ].join(','));
        rows += 1;
    }
    for (const row of payload?.days ?? []) {
        if (rows >= CSV_MAX_ROWS) break;
        lines.push([
            'day', '', csvCell(row.date ?? ''), '',
            csvNumber(row.totalSeconds),
            csvNumber(row.aiSeconds),
            csvNumber(row.humanSeconds),
            csvNumber(row.aiAddedLines),
            csvNumber(row.aiDeletedLines),
            '',
        ].join(','));
        rows += 1;
    }
    return `${lines.join('\n')}\n`;
}

/**
 * 挂载全部路由。
 *
 * @param webCtx - 已 inject webServer 的上下文。
 * @param deps - { summarize, getConfig, saveConfig, logger }。
 * @returns 释放函数。
 */
export function mountRoutes(webCtx, deps) {
    const logger = deps?.logger;
    const releases = [];
    const server = webCtx?.webServer ?? webCtx?.get?.('webServer');
    if (server === undefined || typeof server.register !== 'function') {
        // 没有 webServer 就只采集、不开表面——这不是错误。
        logger?.info?.('[dsh-coding-time] 宿主无 webServer，统计界面不可用（采集不受影响）');
        return () => {};
    }

    const guard = handler => async (req, res) => {
        const decision = authorize(webCtx, req);
        if (decision.allowed !== true) {
            sendError(res, decision.status, decision.code,
                decision.status === 401 ? '未认证' : '宿主拒绝该请求（跨站或未授权）');
            return;
        }
        try {
            await handler(req, res);
        }
        catch (error) {
            // 处理失败只报 500，绝不因异常改变鉴权结论。
            logger?.error?.(`[dsh-coding-time] 路由异常：${error instanceof Error ? error.message : String(error)}`);
            if (res.headersSent !== true) sendError(res, 500, 'internal_error', '统计接口内部错误');
        }
    };

    const register = (pathValue, handler) => {
        try {
            releases.push(server.register({ kind: 'exact', path: pathValue, handler: guard(handler) }));
        }
        catch (error) {
            logger?.error?.(`[dsh-coding-time] 注册路由 ${pathValue} 失败 — ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const readQuery = (req) => {
        const url = requestUrl(req);
        return {
            preset: url.searchParams.get('preset') ?? undefined,
            from: url.searchParams.get('from') ?? undefined,
            to: url.searchParams.get('to') ?? undefined,
            project: url.searchParams.get('project') ?? undefined,
        };
    };

    // ── summary ────────────────────────────────────────────────────────────
    register(`${ROUTE_PREFIX}/summary`, async (req, res) => {
        const method = typeof req?.method === 'string' ? req.method : 'GET';
        if (method !== 'GET' && method !== 'HEAD') {
            sendError(res, 405, 'method_not_allowed', '只支持 GET');
            return;
        }
        if (typeof deps?.summarize !== 'function') {
            sendError(res, 503, 'collector_unavailable', '采集器尚未就绪');
            return;
        }
        sendJson(res, 200, await deps.summarize(readQuery(req)));
    });

    // ── config ─────────────────────────────────────────────────────────────
    register(`${ROUTE_PREFIX}/config`, async (req, res) => {
        const method = typeof req?.method === 'string' ? req.method : 'GET';
        if (typeof deps?.getConfig !== 'function') {
            sendError(res, 503, 'config_unavailable', '配置层尚未就绪');
            return;
        }
        if (method === 'GET' || method === 'HEAD') {
            try {
                const snapshot = await deps.getConfig();
                sendJson(res, 200, {
                    version: 2,
                    ok: true,
                    editable: snapshot?.editable === true,
                    namespace: snapshot?.namespace ?? null,
                    revision: Number.isInteger(snapshot?.revision) ? snapshot.revision : null,
                    profile: snapshot?.profile ?? null,
                    config: sanitizeConfig(snapshot?.config ?? {}),
                    // 冷/热字段元数据：Client 据此精确禁用与提示（缺失即视为无元数据）。
                    readonlyFields: Array.isArray(snapshot?.readonlyFields) ? snapshot.readonlyFields : [],
                    restartRequiredFields: Array.isArray(snapshot?.restartRequiredFields) ? snapshot.restartRequiredFields : [],
                    coldFields: Array.isArray(snapshot?.coldFields) ? snapshot.coldFields : [],
                    liveFields: Array.isArray(snapshot?.liveFields) ? snapshot.liveFields : [],
                    storageDirectory: snapshot?.storageDirectory ?? null,
                    stats: snapshot?.stats ?? null,
                    warnings: Array.isArray(snapshot?.warnings) ? snapshot.warnings : [],
                });
            }
            catch (error) {
                logger?.error?.(`[dsh-coding-time] 读取配置失败：${error instanceof Error ? error.message : String(error)}`);
                sendError(res, 500, 'config_read_failed', '读取配置失败');
            }
            return;
        }
        if (method !== 'POST') {
            sendError(res, 405, 'method_not_allowed', '只支持 GET / POST');
            return;
        }
        if (typeof deps?.saveConfig !== 'function') {
            sendError(res, 409, 'not_editable', '宿主未暴露本插件配置');
            return;
        }
        const raw = await readBody(req);
        if (raw === null) {
            sendError(res, 413, 'body_too_large', '请求体过大');
            return;
        }
        let payload;
        try {
            payload = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
        }
        catch {
            sendError(res, 400, 'invalid_json', '请求体不是合法 JSON');
            return;
        }
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
            sendError(res, 400, 'invalid_body', '请求体必须是对象');
            return;
        }
        try {
            const result = await deps.saveConfig({
                patch: payload.patch ?? payload,
                expectedRevision: Number.isInteger(payload.expectedRevision) ? payload.expectedRevision : undefined,
            });
            sendJson(res, 200, {
                version: 2,
                ok: true,
                editable: result?.editable === true,
                namespace: result?.namespace ?? null,
                revision: Number.isInteger(result?.revision) ? result.revision : null,
                profile: result?.profile ?? null,
                config: sanitizeConfig(result?.config ?? {}),
                readonlyFields: Array.isArray(result?.readonlyFields) ? result.readonlyFields : [],
                restartRequiredFields: Array.isArray(result?.restartRequiredFields) ? result.restartRequiredFields : [],
                coldFields: Array.isArray(result?.coldFields) ? result.coldFields : [],
                liveFields: Array.isArray(result?.liveFields) ? result.liveFields : [],
                storageDirectory: result?.storageDirectory ?? null,
                stats: result?.stats ?? null,
                warnings: Array.isArray(result?.warnings) ? result.warnings : [],
            });
        }
        catch (error) {
            if (error instanceof ConfigError) {
                sendError(res, 422, 'invalid_config', error.message, { path: error.path, configCode: error.code });
                return;
            }
            const code = typeof error?.code === 'string' ? error.code : '';
            if (code === 'revision_conflict') {
                sendError(res, 409, 'revision_conflict', '配置已被其他窗口修改，请刷新后重试');
                return;
            }
            if (code === 'not_editable') {
                sendError(res, 409, 'not_editable', '宿主未暴露本插件配置');
                return;
            }
            logger?.error?.(`[dsh-coding-time] 保存配置失败：${error instanceof Error ? error.message : String(error)}`);
            sendError(res, 500, 'config_write_failed', '保存配置失败');
        }
    });

    // ── export ─────────────────────────────────────────────────────────────
    register(`${ROUTE_PREFIX}/export`, async (req, res) => {
        const method = typeof req?.method === 'string' ? req.method : 'GET';
        if (method !== 'GET' && method !== 'HEAD') {
            sendError(res, 405, 'method_not_allowed', '只支持 GET');
            return;
        }
        if (typeof deps?.summarize !== 'function') {
            sendError(res, 503, 'collector_unavailable', '采集器尚未就绪');
            return;
        }
        const url = requestUrl(req);
        const format = (url.searchParams.get('format') ?? 'csv').toLowerCase();
        const payload = await deps.summarize(readQuery(req));
        const stamp = (payload?.generatedAt ?? new Date().toISOString()).slice(0, 19).replace(/[:T]/g, '-');
        if (format === 'json') {
            sendJson(res, 200, payload, {
                'Content-Disposition': `attachment; filename="dsh-coding-time-${stamp}.json"`,
            });
            return;
        }
        if (format !== 'csv') {
            sendError(res, 400, 'unsupported_format', 'format 只支持 csv 或 json');
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="dsh-coding-time-${stamp}.csv"`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        res.end(summaryToCsv(payload));
    });

    return () => {
        for (const release of releases) {
            try {
                release?.();
            }
            catch {
                // 卸载期重复释放可忽略。
            }
        }
        releases.length = 0;
    };
}
