/**
 * dsh-coding-time · 客户端半边（浏览器侧）。
 *
 * 这里只做一件真实的事：把宿主半边（`/plugins/dsh-coding-time/api/*`）已经算好的
 * 数字，放进 DSH 原生的两个座位里——
 *
 * - `settings.section`：设置 → 编码时长。完整仪表盘 + 配置表单。
 * - `plugins.bundle.config`（keyed `dsh-coding-time`）：插件页里的配置页
 *   （`view: 'summary'` 只给一行摘要，`view: 'page'` 给仪表盘 + 表单）。
 * - `conversation.session.header.actions`：会话头的「今日 AI」小入口，
 *   点开是一个紧凑浮层，不抢主面板。
 *
 * 契约要点（照抄宿主槽位文档，不猜新 API）：
 *
 * - 不经过打包器：`window.__ModuleLoader__.load({ id, factory })`，`factory(require)`
 *   只解析宿主共享模块，所以手写 `react.createElement`、没有 JSX、没有第三方依赖。
 * - `ctx.inject(['slots'], ...)` + `slots.inject(slotName, () => slots.register(...))`，
 *   释放函数交给 `ctx.effect`，插件卸载时统一撤回。
 * - 文案跟着宿主 locale 走（`getLocale().active` + `subscribe`），不读任何凭据。
 *
 * 数字诚实性（这是本插件存在的理由）：
 *
 * - `humanSeconds === null` 显示「未接入 / 未开启」，绝不渲染成 0。
 * - `aiAddedLines === null` 显示「未采集」，不按内容补算行数。
 * - `totals.totalSeconds` 直接用服务端的区间并集，**不在前端把 AI + 人类相加**；
 *   面板上写明这条规则。
 *
 * 所有请求同源（`credentials: 'same-origin'`），不发往任何第三方。
 *
 * @module dsh-coding-time/client
 */

(function bootstrap() {
    'use strict';

    const loader = typeof window !== 'undefined' ? window.__ModuleLoader__ : undefined;
    if (loader === undefined || typeof loader.load !== 'function') return;

    loader.load({
        id: 'dsh-coding-time',
        factory: (require) => {
            const react = require('react');
            const h = react.createElement;

            /** 座位 id：设置页与会话头按钮共用前缀。 */
            const SEAT_ID = 'dsh-coding-time';
            const SLOT_SETTINGS = 'settings.section';
            const SLOT_BUNDLE_CONFIG = 'plugins.bundle.config';
            const SLOT_HEADER_ACTIONS = 'conversation.session.header.actions';
            /** 包名，也是 `plugins.bundle.config` 的分发 key。 */
            const BUNDLE_KEY = 'dsh-coding-time';
            /** 同源 API 前缀（由宿主半边挂载）。 */
            const API_BASE = '/plugins/dsh-coding-time/api';
            const PRESETS = ['today', 'week'];

            /**
             * 与 `lib/config.js` 的 LIMITS 对齐的前端提示范围。
             *
             * 只是"输入时就地提示"，服务端仍然权威：越界、跨字段不一致由宿主返回 422。
             */
            const NUMBER_FIELDS = [
                { key: 'heartbeatIntervalSeconds', min: 5, max: 3600 },
                { key: 'idleThresholdSeconds', min: 5, max: 86_400 },
                { key: 'flushIntervalSeconds', min: 1, max: 600 },
            ];

            /** DSH 设计 token；全部带浅色兜底，不引外部字体、图片或 CDN。 */
            const C = {
                text: 'var(--dsw-alias-label-primary, #17171a)',
                secondary: 'var(--dsw-alias-label-secondary, #5c5c66)',
                tertiary: 'var(--dsw-alias-label-tertiary, #8b8b96)',
                caption: 'var(--dsw-alias-label-caption, #9a9aa4)',
                border: 'var(--dsw-alias-border-l2, rgba(120,120,130,0.22))',
                borderSoft: 'var(--dsw-alias-border-l1, rgba(120,120,130,0.14))',
                borderStrong: 'var(--dsw-alias-border-l3, rgba(120,120,130,0.34))',
                accent: 'var(--dsw-alias-brand-primary, #4d6bfe)',
                danger: 'var(--dsw-alias-state-error-primary, #d92d20)',
                success: 'var(--dsw-alias-state-success-primary, #12805c)',
                warn: 'var(--dsw-alias-state-warn-primary, #b25f00)',
                hover: 'var(--dsw-alias-interactive-bg-hover, rgba(120,120,130,0.08))',
                surface: 'var(--dsw-alias-bg-layer-2, #ffffff)',
                skeleton: 'var(--dsw-alias-bg-skeleton, rgba(120,120,130,0.14))',
                shadow: 'var(--dsw-alias-shadow-popover, 0 10px 30px rgba(0,0,0,0.18))',
            };

            const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

            const S = {
                root: { display: 'flex', flexDirection: 'column', gap: '18px', color: C.text, fontSize: '13px', lineHeight: 1.55, padding: '2px 0 12px' },
                headerBlock: { display: 'flex', flexDirection: 'column', gap: '10px' },
                titleRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px 18px' },
                title: { margin: 0, fontSize: '16px', fontWeight: 600, letterSpacing: '-0.01em', color: C.text },
                subtitle: { margin: '3px 0 0', fontSize: '11.5px', color: C.tertiary, fontVariantNumeric: 'tabular-nums' },
                toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
                button: {
                    display: 'inline-flex', alignItems: 'center', gap: '5px', minHeight: '28px', padding: '3px 10px',
                    border: '1px solid ' + C.border, borderRadius: '6px', background: 'transparent',
                    color: C.secondary, cursor: 'pointer', fontSize: '12px', font: 'inherit', lineHeight: 1.3,
                },
                buttonPrimary: { borderColor: C.accent, background: C.accent, color: 'var(--dsw-alias-label-primary-foreground, #ffffff)' },
                meta: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: '11px', color: C.caption, fontVariantNumeric: 'tabular-nums' },
                metrics: { display: 'flex', flexWrap: 'wrap', borderTop: '1px solid ' + C.border, borderBottom: '1px solid ' + C.border },
                metric: { flex: '1 1 150px', minWidth: '132px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '1px' },
                metricLabel: { fontSize: '11px', color: C.secondary, letterSpacing: '0.02em' },
                metricValue: { fontSize: '25px', fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.18, fontVariantNumeric: 'tabular-nums' },
                metricValueMuted: { fontSize: '15px', fontWeight: 500, lineHeight: 1.7 },
                metricHint: { fontSize: '11px', color: C.tertiary },
                section: { display: 'flex', flexDirection: 'column', gap: '8px' },
                sectionHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' },
                sectionTitle: { margin: 0, fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em', color: C.secondary },
                sectionHint: { margin: '2px 0 0', fontSize: '11px', color: C.tertiary },
                tableWrap: { overflowX: 'auto' },
                table: { width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' },
                th: { padding: '6px 10px', textAlign: 'right', fontSize: '10.5px', fontWeight: 500, letterSpacing: '0.03em', color: C.tertiary, borderBottom: '1px solid ' + C.border, whiteSpace: 'nowrap' },
                thFirst: { padding: '6px 10px', textAlign: 'left', fontSize: '10.5px', fontWeight: 500, letterSpacing: '0.03em', color: C.tertiary, borderBottom: '1px solid ' + C.border },
                td: { padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid ' + C.borderSoft, fontVariantNumeric: 'tabular-nums', verticalAlign: 'top', whiteSpace: 'nowrap' },
                tdFirst: { padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid ' + C.borderSoft, verticalAlign: 'top', minWidth: '200px' },
                tdMuted: { padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid ' + C.borderSoft, color: C.tertiary, verticalAlign: 'top', whiteSpace: 'nowrap' },
                projectLine: { display: 'flex', alignItems: 'center', gap: '6px', color: C.text },
                projectName: { fontSize: '12.5px', fontWeight: 500 },
                projectPath: { fontSize: '10.5px', color: C.caption, fontFamily: MONO, marginTop: '2px', maxWidth: '340px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                activeDot: { width: '6px', height: '6px', borderRadius: '999px', background: C.accent, flex: '0 0 auto' },
                barTrack: { height: '3px', background: C.skeleton, borderRadius: '999px', marginTop: '5px', maxWidth: '240px', overflow: 'hidden' },
                barFill: { height: '3px', background: C.accent, borderRadius: '999px' },
                dayWrap: { display: 'flex', alignItems: 'flex-end', gap: '4px', minHeight: '86px', paddingTop: '4px' },
                dayCol: { flex: '1 1 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', minWidth: 0 },
                dayPair: { display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: '2px', height: '58px', width: '100%' },
                dayBarAi: { width: '46%', maxWidth: '18px', background: C.accent, borderRadius: '2px 2px 0 0', minHeight: '0' },
                dayBarHuman: { width: '26%', maxWidth: '10px', background: C.borderStrong, borderRadius: '2px 2px 0 0' },
                dayTick: { fontSize: '9.5px', color: C.caption, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
                legend: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 14px', fontSize: '10.5px', color: C.tertiary },
                legendSwatch: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', marginRight: '4px', verticalAlign: 'middle' },
                heatGrid: { display: 'grid', gridTemplateColumns: 'repeat(14, minmax(0, 1fr))', gap: '3px' },
                heatCell: { height: '13px', borderRadius: '2px', background: C.skeleton, position: 'relative', overflow: 'hidden' },
                heatFill: { position: 'absolute', inset: 0, background: C.accent },
                empty: { borderTop: '1px solid ' + C.borderSoft, borderBottom: '1px solid ' + C.borderSoft, padding: '14px 2px', display: 'flex', flexDirection: 'column', gap: '2px' },
                emptyTitle: { margin: 0, fontSize: '12.5px', color: C.secondary },
                emptyHint: { margin: 0, fontSize: '11px', color: C.caption },
                notice: { borderLeft: '2px solid ' + C.border, padding: '6px 0 6px 10px', fontSize: '11.5px', color: C.secondary, display: 'flex', flexDirection: 'column', gap: '2px' },
                noticeTitle: { fontWeight: 600, fontSize: '11.5px' },
                noticeList: { margin: 0, paddingLeft: '16px', fontSize: '11px', color: C.tertiary },
                recent: { display: 'flex', flexDirection: 'column' },
                recentRow: { display: 'grid', gridTemplateColumns: '86px minmax(90px, 1fr) minmax(0, 2.2fr)', gap: '10px', padding: '5px 0', borderBottom: '1px solid ' + C.borderSoft, fontSize: '11.5px', alignItems: 'baseline' },
                recentTime: { color: C.caption, fontVariantNumeric: 'tabular-nums' },
                recentTool: { color: C.secondary, fontFamily: MONO, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                recentPath: { color: C.tertiary, fontFamily: MONO, fontSize: '10.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                block: { display: 'flex', flexDirection: 'column', gap: '10px', borderTop: '1px solid ' + C.border, paddingTop: '14px' },
                blockHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '8px 14px' },
                blockTitle: { margin: 0, fontSize: '14px', fontWeight: 600, color: C.text },
                badge: { display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '1px 6px', borderRadius: '999px', border: '1px solid ' + C.border, fontSize: '10px', color: C.tertiary, fontVariantNumeric: 'tabular-nums' },
                formRow: { display: 'grid', gridTemplateColumns: 'minmax(170px, 250px) minmax(0, 1fr)', gap: '4px 18px', padding: '9px 0', borderBottom: '1px solid ' + C.borderSoft, alignItems: 'start' },
                formLabel: { display: 'flex', flexDirection: 'column', gap: '1px' },
                formLabelText: { fontSize: '12.5px', color: C.text },
                formHint: { fontSize: '10.5px', color: C.caption, lineHeight: 1.45 },
                control: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
                input: {
                    width: '104px', padding: '4px 8px', borderRadius: '6px', border: '1px solid ' + C.border,
                    background: 'var(--dsw-alias-bg-layer-1, transparent)', color: C.text,
                    fontVariantNumeric: 'tabular-nums', fontSize: '12.5px', font: 'inherit',
                },
                inputDisabled: { opacity: '0.6', cursor: 'not-allowed' },
                unit: { fontSize: '11px', color: C.caption },
                fieldError: { color: C.danger, fontSize: '10.5px' },
                checkRow: { display: 'inline-flex', alignItems: 'center', gap: '7px', cursor: 'pointer', fontSize: '12.5px', color: C.text },
                pathValue: { fontFamily: MONO, fontSize: '11px', color: C.secondary, wordBreak: 'break-all', background: 'var(--dsw-alias-bg-layer-1, transparent)', border: '1px solid ' + C.borderSoft, borderRadius: '4px', padding: '3px 6px' },
                footer: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', paddingTop: '10px' },
                footerText: { fontSize: '11px', color: C.tertiary, fontVariantNumeric: 'tabular-nums' },
                footerTextError: { fontSize: '11.5px', color: C.danger },
                footerTextOk: { fontSize: '11.5px', color: C.success },
                statGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '4px 18px', fontSize: '11.5px' },
                statItem: { display: 'flex', justifyContent: 'space-between', gap: '8px', borderBottom: '1px solid ' + C.borderSoft, padding: '3px 0' },
                statKey: { color: C.tertiary },
                statValue: { color: C.text, fontVariantNumeric: 'tabular-nums' },
                headerButton: {
                    display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 8px', minHeight: '28px',
                    border: '1px solid ' + C.border, borderRadius: '6px', background: 'transparent',
                    color: C.secondary, cursor: 'pointer', fontSize: '12px', font: 'inherit', lineHeight: 1.3,
                },
                popover: {
                    position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 40, width: '316px',
                    border: '1px solid ' + C.border, borderRadius: '8px', background: C.surface,
                    boxShadow: C.shadow, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '9px',
                },
                popoverHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
                popoverTitle: { margin: 0, fontSize: '12px', fontWeight: 600, color: C.text },
                popoverRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', fontSize: '11.5px' },
                popoverKey: { color: C.tertiary },
                popoverValue: { color: C.text, fontVariantNumeric: 'tabular-nums' },
                popoverHint: { margin: 0, fontSize: '10.5px', color: C.caption },
            };

            /* ------------------------------------------------------------------ *
             * 语言：全部文案经宿主 locale service；默认中文。
             * ------------------------------------------------------------------ */

            const MESSAGES = {
                zh: {
                    nav: '编码时长',
                    title: '编码活动时长',
                    subtitle: '数据只写在本机；宿主没采集到的字段显示为空缺，不填 0。',
                    'preset.today': '今日',
                    'preset.week': '本周',
                    refresh: '刷新',
                    refreshing: '刷新中…',
                    export: '导出 CSV',
                    'export.failed': '导出失败：宿主没有返回可下载的地址。',
                    generated: '生成于',
                    timezone: '时区',
                    'range.unknown': '范围未知',
                    'range.line': '范围 {from} → {to}',
                    'metric.ai': 'AI 活跃',
                    'metric.human': '人类活跃',
                    'metric.total': '合计活跃',
                    'metric.totalHint': '按区间并集去重：重叠时段只计一次，不等于上面两项相加。',
                    'metric.aiHint': '工具调用与助手活动的时间并集。',
                    'metric.lines': 'AI 变更行',
                    'metric.pending': '未采集',
                    'metric.sessions': '会话',
                    'metric.projects': '项目',
                    'human.disabled': '人类计时未开启',
                    'human.not_connected': '人类计时未接入',
                    'human.connected': '人类计时已接入',
                    'human.missing': '未采集',
                    'human.short.disabled': '未开启',
                    'human.short.not_connected': '未接入',
                    'notCollected': '未采集',
                    'lineQuality.full': '行数来自工具返回的真实 diff 元数据。',
                    'lineQuality.partial': '部分工具没有返回 diff 元数据，行数只是下限。',
                    'lineQuality.unavailable': '没有采集到行数；这里不显示 0 冒充数据。',
                    'section.projects': '项目',
                    'section.projectsHint': '按工作目录归并；条长是本项目在本范围的并集时长。',
                    'col.project': '项目',
                    'col.ai': 'AI',
                    'col.human': '人类',
                    'col.total': '合计',
                    'col.lines': 'AI +/−',
                    'col.sessions': '会话',
                    'col.lastActive': '最后活动',
                    active: '进行中',
                    'projects.empty': '这个范围里还没有项目活动。',
                    'projects.emptyHint': '在任意工作区里用 DSH 干活，这里会按 cwd 出现项目行。',
                    'section.days': '按日',
                    'days.hint': '柱高是本日 AI 时长；人类时长用中性灰细柱单列，重叠不叠加。',
                    'days.empty': '该范围没有按日数据。',
                    'days.missing': '未采集',
                    'days.aiLegend': 'AI 时长',
                    'days.humanLegend': '人类时长',
                    'heatmap.title': '按日强度',
                    'heatmap.hint': '每格一天，深浅只表示 AI 时长的相对高低；空格表示未采集。',
                    'heatmap.low': '少',
                    'heatmap.high': '多',
                    'section.recent': '最近事件',
                    'recent.empty': '暂无记录。',
                    'recent.unknownTool': '未知工具',
                    settings: '设置',
                    'settings.loading': '正在读取配置…',
                    'settings.loadError': '读取配置失败',
                    'settings.retry': '重试',
                    'settings.readonly': '暂不可编辑：当前未找到本插件的可写配置入口。为避免保存到错误位置，控件已禁用，也不会发送保存请求。',
                    'settings.readonlyReason': '只读原因',
                    'settings.enabled': '启用采集',
                    'settings.enabledHint': '关闭后不再记录任何时长与行数；已落盘的数据保留。',
                    'settings.heartbeat': '心跳间隔（秒）',
                    'settings.heartbeatHint': '默认 60 秒；用来确认会话仍在活动。',
                    'settings.idle': '空闲阈值（秒）',
                    'settings.idleHint': '默认 180 秒；超过这个时长没有工具活动就断开计时，且不得小于心跳间隔。',
                    'settings.flush': '落盘间隔（秒）',
                    'settings.flushHint': '默认 10 秒；把内存里待写的记录刷到本机目录。',
                    'settings.agent': '记录 AI 活动',
                    'settings.agentHint': '关闭后 AI 时长与行数都不再增加。',
                    'settings.lines': '记录 AI 变更行',
                    'settings.linesHint': '只在工具返回真实 diff 元数据时计数，缺失不补数。',
                    'settings.human': '人类编辑计时（可选）',
                    'settings.humanHint': '默认关闭。开启后仍需接入人类编辑事件；未接入时面板显示「未接入」。',
                    'settings.storage': '存储目录（本机）',
                    'settings.storageHint': '只显示、不随表单提交；数据只写在这台机器上，界面不发送任何密钥。',
                    'settings.storageEmpty': '尚未返回路径',
                    'settings.on': '开启',
                    'settings.off': '关闭',
                    'settings.seconds': '秒',
                    'summary.loading': '正在读取活动数据…',
                    'summary.error': '读取活动数据失败',
                    retry: '重试',
                    'settings.stats': '存储统计',
                    'settings.warnings': '宿主提示',
                    'settings.namespace': '命名空间',
                    'settings.revision': '版本',
                    'settings.readonlyBadge': '不可编辑',
                    'settings.save': '保存',
                    'settings.saving': '保存中…',
                    'settings.saved': '已保存',
                    'settings.dirty': '有未保存的修改',
                    'settings.clean': '没有未保存的修改',
                    'settings.reset': '还原',
                    'settings.reload': '重新载入',
                    'settings.saveError': '保存失败',
                    'settings.validation': '保存被拒绝（422）',
                    'settings.validationHint': '请按上面的字段提示修改后重试；本地草稿已保留。',
                    'settings.conflict': '配置已在别处被修改（409）',
                    'settings.conflictHint': '点「重新载入」拿到最新版本再保存；本地草稿会保留。',
                    'settings.invalidLocal': '先修正下面这些字段再保存。',
                    'settings.noChanges': '没有需要保存的修改。',
                    'settings.required': '不能为空',
                    'settings.integer': '必须是整数',
                    'settings.range': '必须在 {min}..{max} 之间',
                    'settings.idleTooSmall': '必须不小于心跳间隔',
                    'settings.unavailable': '宿主没有返回配置内容',
                    'header.title': '编码时长（今日 AI 活跃）',
                    'header.aiToday': '今日 AI',
                    'header.hint': '完整看板在「设置 → 编码时长」。',
                    'header.empty': '今天还没有记录到 AI 活动。',
                    'header.open': '展开今日摘要',
                    'header.close': '关闭摘要',
                    'bundle.summary': '今日 AI 活跃',
                    'bundle.note': '数据来自本机采集。',
                    'error.network': '网络请求失败：宿主侧接口没有响应。',
                    'error.http': '请求失败（HTTP {status}）',
                    'error.empty': '宿主返回了空响应。',
                    'error.malformed': '宿主返回的不是可解析的 JSON。',
                    'error.unknown': '未知错误。',
                    'error.retryHint': '确认插件已在本机启用后重试；数据不会上传到任何地方。',
                    'stats.records': '记录数',
                    'stats.files': '文件数',
                    'stats.bytes': '占用',
                    'stats.projects': '项目数',
                    'stats.days': '天数',
                    'stats.lastWriteAt': '最近写入',
                    'stats.version': '数据版本',
                    'weekday.0': '日',
                    'weekday.1': '一',
                    'weekday.2': '二',
                    'weekday.3': '三',
                    'weekday.4': '四',
                    'weekday.5': '五',
                    'weekday.6': '六',
                },
                en: {
                    nav: 'Coding time',
                    title: 'Coding activity',
                    subtitle: 'Data stays on this machine. Fields the Host did not collect show as missing, never as 0.',
                    'preset.today': 'Today',
                    'preset.week': 'This week',
                    refresh: 'Refresh',
                    refreshing: 'Refreshing…',
                    export: 'Export CSV',
                    'export.failed': 'Export failed: the Host returned no downloadable address.',
                    generated: 'Generated',
                    timezone: 'Timezone',
                    'range.unknown': 'range unknown',
                    'range.line': 'Range {from} → {to}',
                    'metric.ai': 'AI active',
                    'metric.human': 'Human active',
                    'metric.total': 'Total active',
                    'metric.totalHint': 'Union of intervals: overlaps count once, so this is not the two figures above added together.',
                    'metric.aiHint': 'Union of tool-call and assistant activity.',
                    'metric.lines': 'AI lines',
                    'metric.pending': 'Not collected',
                    'metric.sessions': 'Sessions',
                    'metric.projects': 'Projects',
                    'human.disabled': 'Human timing is off',
                    'human.not_connected': 'Human timing not wired',
                    'human.connected': 'Human timing connected',
                    'human.missing': 'Not collected',
                    'human.short.disabled': 'Off',
                    'human.short.not_connected': 'Not wired',
                    'notCollected': 'Not collected',
                    'lineQuality.full': 'Line counts come from real diff metadata returned by tools.',
                    'lineQuality.partial': 'Some tools returned no diff metadata; counts are a lower bound.',
                    'lineQuality.unavailable': 'No line data was collected; the UI will not show 0 as a stand-in.',
                    'section.projects': 'Projects',
                    'section.projectsHint': 'Grouped by working directory; bar length is this project’s union time in range.',
                    'col.project': 'Project',
                    'col.ai': 'AI',
                    'col.human': 'Human',
                    'col.total': 'Total',
                    'col.lines': 'AI +/−',
                    'col.sessions': 'Sessions',
                    'col.lastActive': 'Last active',
                    active: 'Active now',
                    'projects.empty': 'No project activity in this range yet.',
                    'projects.emptyHint': 'Work in any workspace with DSH and a row appears here, grouped by cwd.',
                    'section.days': 'By day',
                    'days.hint': 'Bar height is that day’s AI time; human time is a separate neutral bar, never stacked.',
                    'days.empty': 'No per-day data in this range.',
                    'days.missing': 'Not collected',
                    'days.aiLegend': 'AI time',
                    'days.humanLegend': 'Human time',
                    'heatmap.title': 'Daily intensity',
                    'heatmap.hint': 'One cell per day; shade only ranks AI time. An empty cell means no data.',
                    'heatmap.low': 'less',
                    'heatmap.high': 'more',
                    'section.recent': 'Recent events',
                    'recent.empty': 'Nothing recorded yet.',
                    'recent.unknownTool': 'unknown tool',
                    settings: 'Settings',
                    'settings.loading': 'Reading configuration…',
                    'settings.loadError': 'Could not read configuration',
                    'settings.retry': 'Retry',
                    'settings.readonly': 'Not editable: no writable configuration entry was found for this plugin. To avoid saving to the wrong location, the controls are disabled and no save request is sent.',
                    'settings.readonlyReason': 'Reason',
                    'settings.enabled': 'Enable collection',
                    'settings.enabledHint': 'When off, no new time or line counts are recorded. Existing data stays.',
                    'settings.heartbeat': 'Heartbeat interval (s)',
                    'settings.heartbeatHint': 'Default 60 s; confirms the session is still active.',
                    'settings.idle': 'Idle threshold (s)',
                    'settings.idleHint': 'Default 180 s; activity stops after this much silence. Must be at least the heartbeat.',
                    'settings.flush': 'Flush interval (s)',
                    'settings.flushHint': 'Default 10 s; writes queued records to the local directory.',
                    'settings.agent': 'Track AI activity',
                    'settings.agentHint': 'When off, AI time and line counts stop growing.',
                    'settings.lines': 'Track AI line counts',
                    'settings.linesHint': 'Counts only real diff metadata; missing metadata is not filled in.',
                    'settings.human': 'Human edit timing (opt-in)',
                    'settings.humanHint': 'Off by default. Needs human edit events; until wired, the panel says “Not wired”.',
                    'settings.storage': 'Storage directory (local)',
                    'settings.storageHint': 'Display only, never submitted. Data stays on this machine; no secrets are sent by the UI.',
                    'settings.storageEmpty': 'No path returned yet',
                    'settings.on': 'On',
                    'settings.off': 'Off',
                    'settings.seconds': 's',
                    'summary.loading': 'Reading activity data…',
                    'summary.error': 'Could not read activity data',
                    retry: 'Retry',
                    'settings.stats': 'Storage stats',
                    'settings.warnings': 'Host notices',
                    'settings.namespace': 'Namespace',
                    'settings.revision': 'Revision',
                    'settings.readonlyBadge': 'Read-only',
                    'settings.save': 'Save',
                    'settings.saving': 'Saving…',
                    'settings.saved': 'Saved',
                    'settings.dirty': 'Unsaved changes',
                    'settings.clean': 'No unsaved changes',
                    'settings.reset': 'Reset',
                    'settings.reload': 'Reload',
                    'settings.saveError': 'Save failed',
                    'settings.validation': 'Save rejected (422)',
                    'settings.validationHint': 'Fix the field messages above and retry; your draft is kept.',
                    'settings.conflict': 'Configuration changed elsewhere (409)',
                    'settings.conflictHint': 'Use “Reload” to fetch the latest revision, then save again. Your draft is kept.',
                    'settings.invalidLocal': 'Fix these fields before saving.',
                    'settings.noChanges': 'Nothing to save.',
                    'settings.required': 'required',
                    'settings.integer': 'must be an integer',
                    'settings.range': 'must be within {min}..{max}',
                    'settings.idleTooSmall': 'must be at least the heartbeat interval',
                    'settings.unavailable': 'The Host returned no configuration body',
                    'header.title': 'Coding time (AI active today)',
                    'header.aiToday': 'AI today',
                    'header.hint': 'Full dashboard: Settings → Coding time.',
                    'header.empty': 'No AI activity recorded today yet.',
                    'header.open': 'Open today’s summary',
                    'header.close': 'Close summary',
                    'bundle.summary': 'AI active today',
                    'bundle.note': 'Collected locally.',
                    'error.network': 'Network request failed: the Host API did not answer.',
                    'error.http': 'Request failed (HTTP {status})',
                    'error.empty': 'The Host returned an empty response.',
                    'error.malformed': 'The Host response was not parseable JSON.',
                    'error.unknown': 'Unknown error.',
                    'error.retryHint': 'Confirm the plugin is enabled on this machine, then retry. Nothing is uploaded anywhere.',
                    'stats.records': 'Records',
                    'stats.files': 'Files',
                    'stats.bytes': 'Size',
                    'stats.projects': 'Projects',
                    'stats.days': 'Days',
                    'stats.lastWriteAt': 'Last write',
                    'stats.version': 'Data version',
                    'weekday.0': 'S',
                    'weekday.1': 'M',
                    'weekday.2': 'T',
                    'weekday.3': 'W',
                    'weekday.4': 'T',
                    'weekday.5': 'F',
                    'weekday.6': 'S',
                },
            };

            /** 宿主 locale 服务；注入前为 undefined。 */
            let localeService;

            /** 读取当前语言；宿主读不到就当中文。 */
            function langOf() {
                try {
                    const snapshot = localeService?.getLocale?.();
                    const active = snapshot?.active;
                    if (typeof active === 'string' && active.toLowerCase().startsWith('en')) return 'en';
                    return 'zh';
                }
                catch {
                    return 'zh';
                }
            }

            function interpolate(template, vars) {
                if (vars === undefined || vars === null) return template;
                return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, key) => (
                    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole
                ));
            }

            function translator(lang) {
                const dict = MESSAGES[lang] ?? MESSAGES.zh;
                return (key, vars) => {
                    const text = dict[key] ?? MESSAGES.zh[key] ?? key;
                    return interpolate(text, vars);
                };
            }

            /** 订阅 locale revision：语言切换后组件自己重渲染，不需要重新注册座位。 */
            /** 等 locale 服务就绪的组件通知：locale 注入可能晚于 slots，不能因此永远停在默认语言。 */
            const localeWaiters = new Set();

            function publishLocale(service) {
                localeService = service;
                for (const notify of [...localeWaiters]) {
                    try {
                        notify();
                    }
                    catch {
                        // 单个组件的通知失败不应影响其它组件。
                    }
                }
            }

            /** 订阅 locale revision：语言切换后组件自己重渲染，不需要重新注册座位。 */
            function useLocaleRevision() {
                const [, bump] = react.useState(0);
                react.useEffect(() => {
                    let unsubscribe;
                    const attach = () => {
                        if (unsubscribe !== undefined) return;
                        if (localeService !== undefined && typeof localeService.subscribe === 'function') {
                            unsubscribe = localeService.subscribe(() => bump(n => n + 1));
                        }
                    };
                    const notify = () => {
                        attach();
                        bump(n => n + 1);
                    };
                    attach();
                    if (unsubscribe === undefined) localeWaiters.add(notify);
                    return () => {
                        localeWaiters.delete(notify);
                        if (typeof unsubscribe === 'function') unsubscribe();
                    };
                }, []);
            }

            function useLang() {
                useLocaleRevision();
                return langOf();
            }

            /* ------------------------------------------------------------------ *
             * 格式化
             * ------------------------------------------------------------------ */

            function isFiniteNumber(value) {
                return typeof value === 'number' && Number.isFinite(value);
            }

            function pad2(value) {
                return String(value).padStart(2, '0');
            }

            function formatNumber(value, lang) {
                if (!isFiniteNumber(value)) return null;
                try {
                    return new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'zh-CN').format(value);
                }
                catch {
                    return String(value);
                }
            }

            /**
             * 时长文案。非数字一律返回 null，由调用方决定「未采集 / 未接入」。
             *
             * @param seconds - 秒数（可能是 null）。
             * @param lang - 'zh' | 'en'。
             * @returns 文案，或 null。
             */
            function formatDuration(seconds, lang) {
                if (!isFiniteNumber(seconds)) return null;
                const total = Math.max(0, Math.round(seconds));
                const hours = Math.floor(total / 3600);
                const minutes = Math.floor((total % 3600) / 60);
                const rest = total % 60;
                if (lang === 'en') {
                    if (hours > 0) return hours + 'h ' + pad2(minutes) + 'm';
                    if (minutes > 0) return minutes + 'm' + (rest > 0 && minutes < 10 ? ' ' + rest + 's' : '');
                    return rest + 's';
                }
                if (hours > 0) return hours + ' 小时 ' + minutes + ' 分';
                if (minutes > 0) return minutes + ' 分';
                return rest + ' 秒';
            }

            function formatDateTime(iso, timezone, lang) {
                if (typeof iso !== 'string' || iso === '') return null;
                const ms = Date.parse(iso);
                if (!Number.isFinite(ms)) return iso;
                try {
                    return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'zh-CN', {
                        timeZone: typeof timezone === 'string' && timezone !== '' ? timezone : undefined,
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                    }).format(new Date(ms));
                }
                catch {
                    return iso.slice(0, 16).replace('T', ' ');
                }
            }

            function formatClock(iso, timezone, lang) {
                const full = formatDateTime(iso, timezone, lang);
                if (full === null) return null;
                const parts = full.split(/[\s,]+/);
                return parts.length > 1 ? parts.slice(1).join(' ') : full;
            }

            function formatBytes(bytes) {
                if (!isFiniteNumber(bytes) || bytes < 0) return null;
                if (bytes < 1024) return bytes + ' B';
                const units = ['KB', 'MB', 'GB', 'TB'];
                let value = bytes / 1024;
                let index = 0;
                while (value >= 1024 && index < units.length - 1) {
                    value /= 1024;
                    index += 1;
                }
                return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[index];
            }

            function basenameOf(value) {
                if (typeof value !== 'string' || value === '') return '';
                const parts = value.split(/[\\/]+/).filter(part => part !== '');
                return parts.length === 0 ? value : parts[parts.length - 1];
            }

            function dateAxisOf(range) {
                const from = typeof range?.fromLocal === 'string' ? range.fromLocal : null;
                const to = typeof range?.toLocal === 'string' ? range.toLocal : null;
                if (from === null || to === null) return [];
                const start = Date.parse(from + 'T00:00:00Z');
                const end = Date.parse(to + 'T00:00:00Z');
                if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
                const days = [];
                for (let ms = start; ms <= end && days.length < 92; ms += 86_400_000) {
                    days.push(new Date(ms).toISOString().slice(0, 10));
                }
                return days;
            }

            /**
             * `YYYY-MM-DD` 对应的星期短名（按 UTC 正午读，避开时区把日期推过边界）。
             *
             * @param date - 本地日期键。
             * @param tr - 翻译器。
             * @returns 短名；解析不了返回 null（调用方退回日期）。
             */
            function weekdayOf(date, tr) {
                if (typeof date !== 'string') return null;
                const ms = Date.parse(date + 'T12:00:00Z');
                if (!Number.isFinite(ms)) return null;
                return tr('weekday.' + new Date(ms).getUTCDay());
            }

            function rangeTextOf(range, preset, lang, tr) {
                if (range === null || range === undefined) return tr('range.unknown');
                if (typeof range.fromLocal === 'string' && typeof range.toLocal === 'string') {
                    if (range.fromLocal === range.toLocal) return range.fromLocal;
                    return tr('range.line', { from: range.fromLocal, to: range.toLocal });
                }
                return tr('range.unknown');
            }

            /* ------------------------------------------------------------------ *
             * API（同源、credentials: 'same-origin'）
             * ------------------------------------------------------------------ */

            class ApiError extends Error {
                constructor(code, options = {}) {
                    super(options.message ?? code);
                    this.name = 'ApiError';
                    this.code = code;
                    this.status = options.status ?? 0;
                    this.body = options.body ?? null;
                }
            }

            function normalizePreset(preset) {
                return PRESETS.includes(preset) ? preset : 'today';
            }

            /**
             * 拼 API 地址：参数一律走 URLSearchParams，调用方不需要关心编码。
             *
             * @param path - 以 `/` 开头的 API 子路径。
             * @param params - 查询参数；空值跳过。
             * @returns 绝对路径（同源）。
             */
            function apiUrl(path, params) {
                const search = new URLSearchParams();
                for (const key of Object.keys(params ?? {})) {
                    const value = params[key];
                    if (value === undefined || value === null || value === '') continue;
                    search.set(key, String(value));
                }
                const query = search.toString();
                return API_BASE + path + (query === '' ? '' : '?' + query);
            }

            function summaryUrl(preset) {
                return apiUrl('/summary', { preset: normalizePreset(preset) });
            }

            function exportUrl(preset) {
                return apiUrl('/export', { format: 'csv', preset: normalizePreset(preset) });
            }

            async function fetchJson(url, options = {}) {
                const init = {
                    method: options.method ?? 'GET',
                    credentials: 'same-origin',
                    headers: { Accept: 'application/json' },
                };
                if (options.body !== undefined) {
                    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
                    init.body = JSON.stringify(options.body);
                }
                if (options.signal !== undefined) init.signal = options.signal;

                let response;
                try {
                    response = await fetch(url, init);
                }
                catch (error) {
                    if (error !== null && typeof error === 'object' && error.name === 'AbortError') throw error;
                    throw new ApiError('network', { message: error instanceof Error ? error.message : String(error) });
                }

                let text = '';
                if (response !== null && typeof response.text === 'function') {
                    text = await response.text();
                }
                else if (response !== null && typeof response.json === 'function') {
                    const parsed = await response.json();
                    text = JSON.stringify(parsed);
                }

                let body = null;
                if (typeof text === 'string' && text !== '') {
                    try {
                        body = JSON.parse(text);
                    }
                    catch {
                        throw new ApiError('malformed', { status: response?.status ?? 0 });
                    }
                }

                const ok = response !== null && response.ok === true;
                if (!ok) throw new ApiError('http', { status: response?.status ?? 0, body });
                if (body === null) throw new ApiError('empty', { status: response?.status ?? 0 });
                return body;
            }

            function describeApiError(error, tr) {
                if (error === null || error === undefined) return tr('error.unknown');
                if (error.name === 'ApiError') {
                    if (error.code === 'network') return tr('error.network');
                    if (error.code === 'http') {
                        const body = error.body;
                        const detail = typeof body?.message === 'string'
                            ? body.message
                            : typeof body?.error?.message === 'string' ? body.error.message : '';
                        const head = tr('error.http', { status: error.status });
                        return detail === '' ? head : head + '：' + detail;
                    }
                    if (error.code === 'empty') return tr('error.empty');
                    if (error.code === 'malformed') return tr('error.malformed');
                    return error.message ?? tr('error.unknown');
                }
                if (typeof error.message === 'string' && error.message !== '') return error.message;
                return tr('error.unknown');
            }

            /* ------------------------------------------------------------------ *
             * 数据归一：只认服务端给的形状；拿不准的字段留 null，绝不补 0。
             * ------------------------------------------------------------------ */

            function secondsOf(value) {
                return isFiniteNumber(value) && value >= 0 ? Math.round(value) : null;
            }

            function countOf(value) {
                return isFiniteNumber(value) && value >= 0 ? Math.round(value) : null;
            }

            function qualityOf(value) {
                return value === 'full' || value === 'partial' || value === 'unavailable' ? value : 'unavailable';
            }

            function normalizeProject(raw) {
                const cwd = typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : (typeof raw.project === 'string' ? raw.project : '');
                const label = typeof raw.label === 'string' && raw.label !== '' ? raw.label : (basenameOf(cwd) || cwd || '—');
                return {
                    project: typeof raw.project === 'string' && raw.project !== '' ? raw.project : cwd,
                    label,
                    cwd,
                    aiSeconds: secondsOf(raw.aiSeconds),
                    humanSeconds: secondsOf(raw.humanSeconds),
                    totalSeconds: secondsOf(raw.totalSeconds),
                    aiAddedLines: countOf(raw.aiAddedLines),
                    aiDeletedLines: countOf(raw.aiDeletedLines),
                    lineDataQuality: qualityOf(raw.lineDataQuality),
                    sessions: countOf(raw.sessions),
                    lastActiveAt: typeof raw.lastActiveAt === 'string' ? raw.lastActiveAt : null,
                    active: raw.active === true,
                };
            }

            function normalizeDay(raw) {
                return {
                    date: typeof raw.date === 'string' ? raw.date : '',
                    aiSeconds: secondsOf(raw.aiSeconds),
                    humanSeconds: secondsOf(raw.humanSeconds),
                    aiAddedLines: countOf(raw.aiAddedLines),
                    aiDeletedLines: countOf(raw.aiDeletedLines),
                };
            }

            function normalizeRecent(raw) {
                return {
                    at: typeof raw.at === 'string' ? raw.at : null,
                    project: typeof raw.project === 'string' ? raw.project : '',
                    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
                    kind: typeof raw.kind === 'string' ? raw.kind : '',
                    tool: typeof raw.tool === 'string' ? raw.tool : '',
                    path: typeof raw.path === 'string' ? raw.path : '',
                };
            }

            /**
             * summary 响应归一。
             *
             * `ok: false` 或非对象 → null（上层显示错误态），不构造一份"全是 0"的假数据。
             */
            function normalizeSummary(body) {
                if (body === null || typeof body !== 'object' || body.ok === false) return null;
                const rawTotals = body.totals !== null && typeof body.totals === 'object' ? body.totals : {};
                const humanStatus = body.humanStatus === 'disabled' || body.humanStatus === 'connected' || body.humanStatus === 'not_connected'
                    ? body.humanStatus
                    : (rawTotals.humanStatus === 'disabled' || rawTotals.humanStatus === 'connected' || rawTotals.humanStatus === 'not_connected'
                        ? rawTotals.humanStatus
                        : 'not_connected');
                return {
                    generatedAt: typeof body.generatedAt === 'string' ? body.generatedAt : null,
                    timezone: typeof body.timezone === 'string' ? body.timezone : null,
                    range: body.range !== null && typeof body.range === 'object' ? body.range : null,
                    humanStatus,
                    totals: {
                        aiSeconds: secondsOf(rawTotals.aiSeconds),
                        humanSeconds: secondsOf(rawTotals.humanSeconds),
                        totalSeconds: secondsOf(rawTotals.totalSeconds),
                        aiAddedLines: countOf(rawTotals.aiAddedLines),
                        aiDeletedLines: countOf(rawTotals.aiDeletedLines),
                        lineDataQuality: qualityOf(rawTotals.lineDataQuality),
                        sessions: countOf(rawTotals.sessions),
                        projects: countOf(rawTotals.projects),
                    },
                    projects: Array.isArray(body.projects)
                        ? body.projects.filter(item => item !== null && typeof item === 'object').map(normalizeProject)
                        : [],
                    days: Array.isArray(body.days)
                        ? body.days.filter(item => item !== null && typeof item === 'object' && typeof item.date === 'string').map(normalizeDay)
                        : [],
                    recent: Array.isArray(body.recent)
                        ? body.recent.filter(item => item !== null && typeof item === 'object').map(normalizeRecent)
                        : [],
                    stats: body.stats !== null && typeof body.stats === 'object' ? body.stats : null,
                };
            }

            function normalizeConfigEntry(body) {
                if (body === null || typeof body !== 'object' || body.ok === false) return null;
                const config = body.config !== null && typeof body.config === 'object' ? body.config : null;
                const warnings = Array.isArray(body.warnings)
                    ? body.warnings.map(item => (typeof item === 'string' ? item : (typeof item?.message === 'string' ? item.message : ''))).filter(text => text !== '')
                    : [];
                return {
                    config,
                    revision: Number.isInteger(body.revision) ? body.revision : null,
                    namespace: typeof body.namespace === 'string' ? body.namespace : null,
                    editable: body.editable !== false,
                    warnings,
                    stats: body.stats !== null && typeof body.stats === 'object' ? body.stats : null,
                };
            }

            /* ------------------------------------------------------------------ *
             * Hooks
             * ------------------------------------------------------------------ */

            function useSummary(preset) {
                const [state, setState] = react.useState({ status: 'loading', data: null, error: null, refreshing: false });
                const [nonce, setNonce] = react.useState(0);
                react.useEffect(() => {
                    let alive = true;
                    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
                    setState(previous => (previous.data !== null
                        ? { status: 'ready', data: previous.data, error: null, refreshing: true }
                        : { status: 'loading', data: null, error: null, refreshing: false }));
                    fetchJson(summaryUrl(preset), { signal: controller?.signal })
                        .then(body => {
                            if (!alive) return;
                            const summary = normalizeSummary(body);
                            if (summary === null) {
                                setState({ status: 'error', data: null, error: new ApiError('empty'), refreshing: false });
                                return;
                            }
                            setState({ status: 'ready', data: summary, error: null, refreshing: false });
                        })
                        .catch(error => {
                            if (!alive) return;
                            if (error !== null && typeof error === 'object' && error.name === 'AbortError') return;
                            setState(previous => ({
                                status: previous.data !== null ? 'ready' : 'error',
                                data: previous.data,
                                error,
                                refreshing: false,
                            }));
                        });
                    return () => {
                        alive = false;
                        if (controller !== undefined) controller.abort();
                    };
                }, [preset, nonce]);
                const refresh = react.useCallback(() => setNonce(value => value + 1), []);
                return { state, refresh };
            }

            function useConfigEntry() {
                const [state, setState] = react.useState({ status: 'loading', entry: null, error: null });
                const [nonce, setNonce] = react.useState(0);
                react.useEffect(() => {
                    let alive = true;
                    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
                    fetchJson(apiUrl('/config'), { signal: controller?.signal })
                        .then(body => {
                            if (!alive) return;
                            const entry = normalizeConfigEntry(body);
                            if (entry === null || entry.config === null) {
                                setState(previous => ({ status: previous.entry !== null ? 'ready' : 'error', entry: previous.entry, error: new ApiError('empty'), }));
                                return;
                            }
                            setState({ status: 'ready', entry, error: null });
                        })
                        .catch(error => {
                            if (!alive) return;
                            if (error !== null && typeof error === 'object' && error.name === 'AbortError') return;
                            setState(previous => ({ status: previous.entry !== null ? 'ready' : 'error', entry: previous.entry, error }));
                        });
                    return () => {
                        alive = false;
                        if (controller !== undefined) controller.abort();
                    };
                }, [nonce]);
                const reload = react.useCallback(() => setNonce(value => value + 1), []);
                const applyEntry = react.useCallback((entry) => setState({ status: 'ready', entry, error: null }), []);
                return { state, reload, applyEntry };
            }

            /* ------------------------------------------------------------------ *
             * 基础组件
             * ------------------------------------------------------------------ */

            function Button(props = {}) {
                const style = { ...S.button, ...(props.primary === true ? S.buttonPrimary : {}), ...(props.style ?? {}) };
                if (props.active === true) {
                    style.color = C.accent;
                    style.borderColor = C.borderStrong;
                    style.background = 'var(--dsw-alias-interactive-bg-active, rgba(120,120,130,0.10))';
                }
                if (props.disabled === true) {
                    style.opacity = '0.55';
                    style.cursor = 'not-allowed';
                }
                return h('button', {
                    type: 'button',
                    onClick: props.disabled === true ? undefined : props.onClick,
                    disabled: props.disabled === true,
                    title: props.title,
                    'aria-label': props.ariaLabel,
                    'aria-pressed': props.pressed,
                    style,
                }, props.children);
            }

            function SectionHead(props = {}) {
                return h('div', { style: S.sectionHead },
                    h('div', null,
                        h('h3', { style: S.sectionTitle }, props.title),
                        props.hint !== undefined ? h('p', { style: S.sectionHint }, props.hint) : null),
                    props.right ?? null);
            }

            function EmptyState(props = {}) {
                return h('div', { style: S.empty, 'data-role': 'empty' },
                    h('p', { style: S.emptyTitle }, props.title),
                    props.hint !== undefined ? h('p', { style: S.emptyHint }, props.hint) : null);
            }

            function Notice(props = {}) {
                const accent = props.tone === 'error' ? C.danger : props.tone === 'warn' ? C.warn : C.borderStrong;
                return h('div', { style: { ...S.notice, borderLeftColor: accent }, 'data-role': props.role ?? 'notice', 'aria-live': props.tone === 'error' ? 'polite' : undefined },
                    h('div', { style: { ...S.noticeTitle, color: props.tone === 'error' ? C.danger : C.secondary } }, props.title),
                    props.children !== undefined ? h('div', { style: { fontSize: '11px', color: C.tertiary } }, props.children) : null,
                    Array.isArray(props.items) && props.items.length > 0
                        ? h('ul', { style: S.noticeList }, props.items.map((item, index) => h('li', { key: index }, item)))
                        : null);
            }

            /* ------------------------------------------------------------------ *
             * 仪表盘
             * ------------------------------------------------------------------ */

            function humanTextOf(seconds, humanStatus, lang, tr) {
                if (isFiniteNumber(seconds)) return formatDuration(seconds, lang);
                if (humanStatus === 'disabled') return tr('human.short.disabled');
                if (humanStatus === 'not_connected') return tr('human.short.not_connected');
                return tr('human.missing');
            }

            function humanHintOf(humanStatus, tr) {
                if (humanStatus === 'disabled') return tr('human.disabled');
                if (humanStatus === 'connected') return tr('human.connected');
                return tr('human.not_connected');
            }

            function linesTextOf(aiAddedLines, aiDeletedLines, tr) {
                if (!isFiniteNumber(aiAddedLines) && !isFiniteNumber(aiDeletedLines)) return tr('notCollected');
                const added = isFiniteNumber(aiAddedLines) ? '+' + aiAddedLines : tr('notCollected');
                const deleted = isFiniteNumber(aiDeletedLines) ? '−' + aiDeletedLines : tr('notCollected');
                return added + ' / ' + deleted;
            }

            function MetricCell(props = {}) {
                const valueText = typeof props.value === 'string' ? props.value : null;
                const bigStyle = valueText !== null && valueText.length > 8 ? S.metricValueMuted : S.metricValue;
                return h('div', { style: S.metric, 'data-metric': props.metric },
                    h('div', { style: S.metricLabel }, props.label),
                    valueText !== null
                        // 空缺标记（未采集/未接入）用小字，不冒充一个像数据的数字。
                        ? h('div', { style: props.muted === true ? S.metricValueMuted : bigStyle, 'data-role': 'metric-value' }, valueText)
                        : (props.children ?? null),
                    props.hint !== undefined ? h('div', { style: S.metricHint }, props.hint) : null);
            }

            function Metrics(props = {}) {
                const { totals, humanStatus, lang, tr } = props;
                const ai = formatDuration(totals.aiSeconds, lang) ?? tr('metric.pending');
                const human = humanTextOf(totals.humanSeconds, humanStatus, lang, tr);
                const total = formatDuration(totals.totalSeconds, lang) ?? tr('metric.pending');
                const linesMissing = !isFiniteNumber(totals.aiAddedLines) && !isFiniteNumber(totals.aiDeletedLines);
                return h('div', { style: S.metrics, 'data-role': 'metrics' },
                    h(MetricCell, { metric: 'ai', label: tr('metric.ai'), value: ai, hint: tr('metric.aiHint'), muted: !isFiniteNumber(totals.aiSeconds) }),
                    h(MetricCell, { metric: 'human', label: tr('metric.human'), value: human, hint: humanHintOf(humanStatus, tr), muted: !isFiniteNumber(totals.humanSeconds) }),
                    h(MetricCell, { metric: 'total', label: tr('metric.total'), value: total, hint: tr('metric.totalHint'), muted: !isFiniteNumber(totals.totalSeconds) }),
                    h(MetricCell, {
                        metric: 'lines',
                        label: tr('metric.lines'),
                        value: linesTextOf(totals.aiAddedLines, totals.aiDeletedLines, tr),
                        hint: tr('lineQuality.' + totals.lineDataQuality),
                        muted: linesMissing,
                    }));
            }

            function ProjectRow(props = {}) {
                const { project, maxSeconds, humanStatus, timezone, lang, tr } = props;
                const total = isFiniteNumber(project.totalSeconds) ? project.totalSeconds : null;
                const width = total === null || maxSeconds <= 0 ? '0%' : Math.max(total > 0 ? 3 : 0, Math.round((total / maxSeconds) * 100)) + '%';
                return h('tr', { 'data-role': 'project-row' },
                    h('td', { style: S.tdFirst },
                        h('div', { style: S.projectLine },
                            project.active === true ? h('span', { style: S.activeDot, title: tr('active'), 'aria-label': tr('active') }) : null,
                            h('span', { style: S.projectName }, project.label)),
                        h('div', { style: S.projectPath, title: project.cwd }, project.cwd),
                        h('div', { style: S.barTrack }, h('div', { style: { ...S.barFill, width } }))),
                    h('td', { style: S.td }, formatDuration(project.aiSeconds, lang) ?? tr('metric.pending')),
                    isFiniteNumber(project.humanSeconds)
                        ? h('td', { style: S.td }, formatDuration(project.humanSeconds, lang))
                        : h('td', { style: S.tdMuted }, humanTextOf(null, humanStatus, lang, tr)),
                    h('td', { style: S.td }, formatDuration(project.totalSeconds, lang) ?? tr('metric.pending')),
                    isFiniteNumber(project.aiAddedLines) || isFiniteNumber(project.aiDeletedLines)
                        ? h('td', { style: S.td, title: tr('lineQuality.' + project.lineDataQuality) }, linesTextOf(project.aiAddedLines, project.aiDeletedLines, tr))
                        : h('td', { style: S.tdMuted }, tr('notCollected')),
                    h('td', { style: S.td }, isFiniteNumber(project.sessions) ? formatNumber(project.sessions, lang) : '—'),
                    h('td', { style: S.td }, formatDateTime(project.lastActiveAt, timezone, lang) ?? '—'));
            }

            function ProjectTable(props = {}) {
                const { projects, totals, humanStatus, timezone, lang, tr } = props;
                if (projects.length === 0) {
                    return h(EmptyState, { title: tr('projects.empty'), hint: tr('projects.emptyHint') });
                }
                // 排行按服务端并集合计降序；total 缺失的项退回 AI 时长，不猜别的。
                const ranked = [...projects].sort((a, b) => {
                    const left = isFiniteNumber(a.totalSeconds) ? a.totalSeconds : (a.aiSeconds ?? -1);
                    const right = isFiniteNumber(b.totalSeconds) ? b.totalSeconds : (b.aiSeconds ?? -1);
                    return right - left;
                });
                const maxSeconds = ranked.reduce((max, project) => (
                    isFiniteNumber(project.totalSeconds) ? Math.max(max, project.totalSeconds) : max
                ), 0);
                return h('div', { style: S.tableWrap, 'data-role': 'projects' },
                    h('table', { style: S.table },
                        h('thead', null,
                            h('tr', null,
                                h('th', { style: S.thFirst }, tr('col.project')),
                                h('th', { style: S.th }, tr('col.ai')),
                                h('th', { style: S.th }, tr('col.human')),
                                h('th', { style: S.th }, tr('col.total')),
                                h('th', { style: S.th }, tr('col.lines')),
                                h('th', { style: S.th }, tr('col.sessions')),
                                h('th', { style: S.th }, tr('col.lastActive')))),
                        h('tbody', null,
                            ranked.map((project, index) => h(ProjectRow, {
                                key: project.project === '' ? 'row-' + index : project.project,
                                project,
                                maxSeconds,
                                humanStatus,
                                timezone,
                                lang,
                                tr,
                            })))),
                    h('p', { style: S.sectionHint },
                        `${tr('metric.sessions')} ${formatNumber(totals.sessions, lang) ?? '—'} · `
                        + `${tr('metric.projects')} ${formatNumber(totals.projects, lang) ?? '—'}`));
            }

            function DaySection(props = {}) {
                const { summary, lang, tr } = props;
                const days = summary.days;
                const axis = dateAxisOf(summary.range);
                const dates = axis.length > 0 ? axis : days.map(day => day.date).filter(date => date !== '');
                const head = h(SectionHead, { title: tr('section.days'), hint: tr('days.hint') });
                if (days.length === 0) {
                    // 服务端没有按日行就是没有；不按 range 硬造一排空柱冒充"采集过"。
                    return h('section', { style: S.section, 'data-role': 'days' }, head, h(EmptyState, { title: tr('days.empty') }));
                }
                const byDate = new Map();
                for (const day of days) byDate.set(day.date, day);
                const aiValues = [];
                const humanValues = [];
                for (const date of dates) {
                    const day = byDate.get(date);
                    if (day === undefined) continue;
                    if (isFiniteNumber(day.aiSeconds)) aiValues.push(day.aiSeconds);
                    if (isFiniteNumber(day.humanSeconds)) humanValues.push(day.humanSeconds);
                }
                const maxAi = aiValues.length > 0 ? Math.max(1, ...aiValues) : 1;
                const maxHuman = humanValues.length > 0 ? Math.max(1, ...humanValues) : 1;
                const dense = dates.length > 14;
                const barHeight = (value, max) => (value > 0 ? Math.max(2, Math.round((value / max) * 54)) + 'px' : '1px');
                const heatLevel = value => (value > 0 ? Math.min(4, Math.max(1, Math.ceil((value / maxAi) * 4))) : 0);

                return h('section', { style: S.section, 'data-role': 'days' },
                    head,
                    h('div', { style: S.dayWrap, role: 'img', 'aria-label': tr('section.days') },
                        dates.map(date => {
                            const day = byDate.get(date);
                            const short = date.length >= 5 ? date.slice(5) : date;
                            const weekday = weekdayOf(date, tr);
                            const label = dense || weekday === null ? short : weekday + ' ' + short;
                            const showTick = !dense || dates.indexOf(date) % 7 === 0 || date === dates[dates.length - 1];
                            if (day === undefined) {
                                return h('div', { key: date, style: S.dayCol, title: date + ' · ' + tr('days.missing') },
                                    h('div', { style: { ...S.dayPair, alignItems: 'flex-end' } },
                                        h('span', { style: { fontSize: '10px', color: C.caption } }, '·')),
                                    h('div', { style: S.dayTick }, showTick ? label : ''));
                            }
                            const ai = isFiniteNumber(day.aiSeconds) ? day.aiSeconds : null;
                            const human = isFiniteNumber(day.humanSeconds) ? day.humanSeconds : null;
                            const title = date
                                + ' · ' + tr('days.aiLegend') + ' ' + (formatDuration(ai, lang) ?? tr('notCollected'))
                                + ' · ' + tr('days.humanLegend') + ' ' + (formatDuration(human, lang) ?? tr('human.short.not_connected'));
                            return h('div', { key: date, style: S.dayCol, title, 'data-role': 'day-cell', 'data-date': date },
                                h('div', { style: S.dayPair },
                                    h('div', { style: { ...S.dayBarAi, height: ai === null ? '0' : barHeight(ai, maxAi) } }),
                                    human !== null && human > 0
                                        ? h('div', { style: { ...S.dayBarHuman, height: barHeight(human, maxHuman) } })
                                        : null),
                                h('div', { style: S.dayTick }, showTick ? label : ''));
                        })),
                    h('div', { style: S.legend },
                        h('span', null, h('span', { style: { ...S.legendSwatch, background: C.accent } }), tr('days.aiLegend')),
                        h('span', null, h('span', { style: { ...S.legendSwatch, background: C.borderStrong } }), tr('days.humanLegend'))),
                    h('div', { style: { ...S.section, gap: '6px' } },
                        h(SectionHead, { title: tr('heatmap.title'), hint: tr('heatmap.hint') }),
                        h('div', { style: { ...S.heatGrid, gridTemplateColumns: 'repeat(' + Math.min(dates.length, 14) + ', minmax(0, 1fr))' }, 'data-role': 'heatmap' },
                            dates.map(date => {
                                const day = byDate.get(date);
                                const value = day !== undefined && isFiniteNumber(day.aiSeconds) ? day.aiSeconds : null;
                                const level = value === null ? 0 : heatLevel(value);
                                return h('div', {
                                    key: 'heat-' + date,
                                    style: S.heatCell,
                                    title: date + ' · ' + (value === null ? tr('days.missing') : (formatDuration(value, lang) ?? tr('notCollected'))),
                                    'data-heat': level,
                                }, level === 0 ? null : h('div', { style: { ...S.heatFill, opacity: String(0.18 + level * 0.2) } }));
                            })),
                        h('div', { style: S.legend },
                            h('span', null, tr('heatmap.low')),
                            h('span', null, h('span', { style: { ...S.legendSwatch, background: C.accent, opacity: '0.2' } })),
                            h('span', null, h('span', { style: { ...S.legendSwatch, background: C.accent, opacity: '0.6' } })),
                            h('span', null, h('span', { style: { ...S.legendSwatch, background: C.accent, opacity: '1' } })),
                            h('span', null, tr('heatmap.high')))));
            }

            function RecentList(props = {}) {
                const { summary, lang, tr } = props;
                const recent = summary.recent.slice(0, 8);
                const head = h(SectionHead, { title: tr('section.recent') });
                if (recent.length === 0) {
                    return h('section', { style: S.section, 'data-role': 'recent' }, head, h(EmptyState, { title: tr('recent.empty') }));
                }
                return h('section', { style: S.section, 'data-role': 'recent' },
                    head,
                    h('div', { style: S.recent },
                        recent.map((item, index) => h('div', { key: index, style: S.recentRow },
                            h('span', { style: S.recentTime }, formatClock(item.at, summary.timezone, lang) ?? '—'),
                            h('span', { style: S.recentTool, title: item.kind }, (item.tool === '' ? tr('recent.unknownTool') : item.tool) + (item.kind === '' ? '' : ' · ' + item.kind)),
                            h('span', { style: S.recentPath, title: item.path === '' ? item.project : item.path }, item.path === '' ? (basenameOf(item.project) || item.project) : item.path)))));
            }

            function SummaryHeader(props = {}) {
                const { preset, setPreset, summary, refreshing, onRefresh, onExport, exportError, lang, tr } = props;
                const meta = [];
                if (summary?.timezone !== null && summary?.timezone !== undefined) meta.push(tr('timezone') + ' ' + summary.timezone);
                if (summary?.generatedAt !== null && summary?.generatedAt !== undefined) {
                    const generated = formatDateTime(summary.generatedAt, summary.timezone, lang);
                    if (generated !== null) meta.push(tr('generated') + ' ' + generated);
                }
                if (refreshing === true) meta.push(tr('refreshing'));
                return h('div', { style: S.headerBlock },
                    h('div', { style: S.titleRow },
                        h('div', null,
                            h('h2', { style: S.title }, tr('title')),
                            h('p', { style: S.subtitle },
                                rangeTextOf(summary?.range ?? null, preset, lang, tr) + (meta.length > 0 ? ' · ' + meta.join(' · ') : '')),
                            h('p', { style: { ...S.subtitle, color: C.caption } }, tr('subtitle'))),
                        h('div', { style: S.toolbar },
                            PRESETS.map(item => h(Button, {
                                key: item,
                                active: preset === item,
                                pressed: preset === item,
                                ariaLabel: tr('preset.' + item),
                                onClick: () => setPreset(item),
                            }, tr('preset.' + item))),
                            h(Button, { ariaLabel: tr('refresh'), onClick: onRefresh }, refreshing === true ? tr('refreshing') : tr('refresh')),
                            h(Button, { ariaLabel: tr('export'), onClick: onExport }, tr('export')))),
                    exportError !== null && exportError !== undefined
                        ? h(Notice, { tone: 'error', title: tr('export.failed') }, exportError)
                        : null);
            }

            function SummaryRegion(props = {}) {
                const lang = useLang();
                const tr = translator(lang);
                const [preset, setPreset] = react.useState(normalizePreset(props.preset ?? 'today'));
                const { state, refresh } = useSummary(preset);
                const [exportError, setExportError] = react.useState(null);
                const summary = state.data;
                const onExport = react.useCallback(() => {
                    try {
                        const url = exportUrl(preset);
                        if (typeof document === 'undefined' || document === null) {
                            // 没有 document 就不是浏览器环境：说清楚，不做"看起来点过了"的假动作。
                            setExportError(tr('export.failed'));
                            return;
                        }
                        const anchor = document.createElement('a');
                        anchor.href = url;
                        anchor.setAttribute('download', 'dsh-coding-time-' + normalizePreset(preset) + '.csv');
                        anchor.rel = 'noopener';
                        if (document.body !== null && document.body !== undefined && typeof document.body.appendChild === 'function') {
                            document.body.appendChild(anchor);
                        }
                        if (typeof anchor.click === 'function') anchor.click();
                        if (typeof anchor.remove === 'function') anchor.remove();
                        setExportError(null);
                    }
                    catch (error) {
                        setExportError(error instanceof Error ? error.message : String(error));
                    }
                }, [preset]);

                return h('div', { style: S.root, 'data-dsh-coding-time': 'summary' },
                    h(SummaryHeader, {
                        preset,
                        setPreset,
                        summary,
                        refreshing: state.refreshing,
                        onRefresh: refresh,
                        onExport,
                        exportError,
                        lang,
                        tr,
                    }),
                    state.status === 'loading' && summary === null
                        ? h('p', { style: { ...S.meta, margin: 0 }, 'data-role': 'summary-loading' }, tr('summary.loading') ?? tr('settings.loading'))
                        : null,
                    state.error !== null && summary === null
                        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' }, 'data-role': 'summary-error' },
                            h(Notice, { tone: 'error', title: tr('summary.error') ?? tr('settings.loadError'), role: 'summary-error-notice' },
                                describeApiError(state.error, tr)),
                            h('p', { style: S.sectionHint }, tr('error.retryHint')),
                            h(Button, { ariaLabel: tr('refresh'), onClick: refresh }, tr('retry') ?? tr('refresh')))
                        : null,
                    state.error !== null && summary !== null
                        ? h(Notice, { tone: 'warn', title: tr('summary.error') ?? tr('settings.loadError'), role: 'summary-stale' },
                            describeApiError(state.error, tr) + ' ' + tr('error.retryHint'))
                        : null,
                    summary !== null
                        ? h(Metrics, { totals: summary.totals, humanStatus: summary.humanStatus, lang, tr })
                        : null,
                    summary !== null
                        ? h('section', { style: S.section, 'data-role': 'projects-section' },
                            h(SectionHead, { title: tr('section.projects'), hint: tr('section.projectsHint') }),
                            h(ProjectTable, {
                                projects: summary.projects,
                                totals: summary.totals,
                                humanStatus: summary.humanStatus,
                                timezone: summary.timezone,
                                lang,
                                tr,
                            }))
                        : null,
                    summary !== null ? h(DaySection, { summary, lang, tr }) : null,
                    summary !== null && props.compact !== true ? h(RecentList, { summary, lang, tr }) : null);
            }

            /* ------------------------------------------------------------------ *
             * 设置表单
             * ------------------------------------------------------------------ */

            function draftOf(config) {
                const source = config ?? {};
                return {
                    enabled: source.enabled === true,
                    heartbeatIntervalSeconds: source.heartbeatIntervalSeconds ?? '',
                    idleThresholdSeconds: source.idleThresholdSeconds ?? '',
                    flushIntervalSeconds: source.flushIntervalSeconds ?? '',
                    trackAgentActivity: source.trackAgentActivity === true,
                    trackAiLines: source.trackAiLines === true,
                    humanEnabled: source.humanTracking !== null && typeof source.humanTracking === 'object' && source.humanTracking.enabled === true,
                    storageDirectory: typeof source.storageDirectory === 'string' ? source.storageDirectory : '',
                    timezone: typeof source.timezone === 'string' ? source.timezone : '',
                    weekStartsOn: source.weekStartsOn,
                    exclude: Array.isArray(source.exclude) ? source.exclude : [],
                };
            }

            const PATCH_FIELDS = ['enabled', 'heartbeatIntervalSeconds', 'idleThresholdSeconds', 'flushIntervalSeconds', 'trackAgentActivity', 'trackAiLines'];

            function buildPatch(draft, config) {
                const base = draftOf(config);
                const patch = {};
                for (const key of PATCH_FIELDS) {
                    if (draft[key] !== base[key]) patch[key] = draft[key];
                }
                if (draft.humanEnabled !== base.humanEnabled) patch.humanTracking = { enabled: draft.humanEnabled === true };
                return patch;
            }

            function coerceNumber(raw) {
                if (raw === '') return '';
                const value = Number(raw);
                return Number.isFinite(value) ? value : raw;
            }

            function validateDraft(draft, tr) {
                const problems = [];
                for (const field of NUMBER_FIELDS) {
                    const value = draft[field.key];
                    if (value === '' || value === null || value === undefined) {
                        problems.push({ path: field.key, message: tr('settings.required') });
                        continue;
                    }
                    if (!isFiniteNumber(value) || !Number.isInteger(value)) {
                        problems.push({ path: field.key, message: tr('settings.integer') });
                        continue;
                    }
                    if (value < field.min || value > field.max) {
                        problems.push({ path: field.key, message: tr('settings.range', { min: field.min, max: field.max }) });
                    }
                }
                if (isFiniteNumber(draft.heartbeatIntervalSeconds) && isFiniteNumber(draft.idleThresholdSeconds)
                    && draft.idleThresholdSeconds < draft.heartbeatIntervalSeconds) {
                    problems.push({ path: 'idleThresholdSeconds', message: tr('settings.idleTooSmall') });
                }
                const fieldErrors = {};
                for (const problem of problems) {
                    if (fieldErrors[problem.path] === undefined) fieldErrors[problem.path] = problem.message;
                }
                return fieldErrors;
            }

            /**
             * 422 响应里的字段错误：兼容 `errors[]` / `details[]` / `fields{}` 三种常见形状。
             *
             * @param body - 响应体。
             * @param tr - 翻译器（保留给未来字段名本地化）。
             * @returns `{ 字段路径: 文案 }`。
             */
            function fieldErrorsOf(body, tr) {
                void tr;
                const out = {};
                const push = (path, message) => {
                    if (typeof path !== 'string' || path === '') return;
                    if (typeof message !== 'string' || message === '') return;
                    if (out[path] === undefined) out[path] = message;
                };
                const list = Array.isArray(body?.errors)
                    ? body.errors
                    : Array.isArray(body?.details) ? body.details : [];
                for (const item of list) {
                    if (item === null || typeof item !== 'object') continue;
                    push(item.path ?? item.field ?? item.name, item.message ?? item.msg ?? item.detail);
                }
                if (body?.fields !== null && typeof body?.fields === 'object' && !Array.isArray(body.fields)) {
                    for (const [key, value] of Object.entries(body.fields)) {
                        push(key, typeof value === 'string' ? value : (typeof value?.message === 'string' ? value.message : ''));
                    }
                }
                return out;
            }

            function validationDetailOf(body) {
                if (typeof body?.message === 'string' && body.message !== '') return body.message;
                if (typeof body?.error?.message === 'string' && body.error.message !== '') return body.error.message;
                return null;
            }

            /* ------------------------------------------------------------------ *
             * 设置表单
             * ------------------------------------------------------------------ */

            /** 字段名 → 文案 key（只用于展示，不改协议）。 */
            const FIELD_LABEL_KEY = {
                enabled: 'settings.enabled',
                heartbeatIntervalSeconds: 'settings.heartbeat',
                idleThresholdSeconds: 'settings.idle',
                flushIntervalSeconds: 'settings.flush',
                trackAgentActivity: 'settings.agent',
                trackAiLines: 'settings.lines',
                'humanTracking.enabled': 'settings.human',
                storageDirectory: 'settings.storage',
                timezone: 'timezone',
            };

            /** 统计里绝不展示的键（防御性：宿主本来也不会返回这些）。 */
            const CREDENTIAL_KEY = /^(?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|passphrase|credential|credentials|authorization|auth|private[_-]?key|session[_-]?key|cookie|webhook[_-]?url)$/i;

            const STAT_LABEL_KEY = {
                records: 'stats.records',
                recordCount: 'stats.records',
                files: 'stats.files',
                fileCount: 'stats.files',
                bytes: 'stats.bytes',
                sizeBytes: 'stats.bytes',
                projects: 'stats.projects',
                projectCount: 'stats.projects',
                days: 'stats.days',
                dayCount: 'stats.days',
                lastWriteAt: 'stats.lastWriteAt',
                version: 'stats.version',
                dataVersion: 'stats.version',
            };

            function statEntries(stats) {
                if (stats === null || stats === undefined || typeof stats !== 'object' || Array.isArray(stats)) return [];
                const out = [];
                for (const [key, value] of Object.entries(stats)) {
                    if (CREDENTIAL_KEY.test(key)) continue;
                    if (typeof value === 'number' || typeof value === 'boolean') out.push([key, value]);
                    else if (typeof value === 'string' && value !== '') out.push([key, value]);
                }
                return out;
            }

            function FieldShell(props = {}) {
                return h('div', { style: S.formRow, 'data-field': props.name },
                    h('div', { style: S.formLabel },
                        h('label', { htmlFor: props.inputId, style: S.formLabelText }, props.label),
                        props.hint !== undefined ? h('span', { style: S.formHint }, props.hint) : null),
                    h('div', { style: S.control },
                        props.children,
                        props.error !== null && props.error !== undefined
                            ? h('span', { style: S.fieldError, role: 'alert' }, props.error)
                            : null));
            }

            function NumberField(props = {}) {
                const inputId = 'dsh-coding-time-' + props.name;
                const disabled = props.disabled === true;
                const value = props.value === null || props.value === undefined ? '' : String(props.value);
                return h(FieldShell, {
                    name: props.name,
                    label: props.label,
                    hint: props.hint,
                    inputId,
                    error: props.error,
                },
                    h('input', {
                        id: inputId,
                        type: 'number',
                        inputMode: 'numeric',
                        min: props.min,
                        max: props.max,
                        step: 1,
                        value,
                        disabled,
                        'aria-invalid': props.error ? 'true' : undefined,
                        onChange: event => props.onChange(coerceNumber(event?.target?.value ?? '')),
                        style: { ...S.input, ...(disabled ? S.inputDisabled : {}) },
                    }),
                    h('span', { style: S.unit }, props.unitLabel),
                    h('span', { style: S.unit }, `(${props.min}..${props.max})`));
            }

            function CheckboxField(props = {}) {
                const inputId = 'dsh-coding-time-' + props.name;
                const disabled = props.disabled === true;
                return h(FieldShell, {
                    name: props.name,
                    label: props.label,
                    hint: props.hint,
                    inputId,
                    error: props.error,
                },
                    h('label', { htmlFor: inputId, style: { ...S.checkRow, opacity: disabled ? '0.6' : '1' } },
                        h('input', {
                            id: inputId,
                            type: 'checkbox',
                            checked: props.checked === true,
                            disabled,
                            onChange: event => props.onChange(event?.target?.checked === true),
                        }),
                        h('span', null, props.checked === true ? props.onText : props.offText)));
            }

            function statusLineOf(status, dirty, lang, tr) {
                if (status.kind === 'saving') return { text: tr('settings.saving'), style: S.footerText, role: 'settings-status' };
                if (status.kind === 'saved') {
                    const at = typeof status.at === 'string' ? formatClock(status.at, undefined, lang) : null;
                    return { text: tr('settings.saved') + (at === null ? '' : ' · ' + at), style: S.footerTextOk, role: 'settings-status' };
                }
                if (status.kind === 'validation') {
                    return {
                        text: tr('settings.validation') + ' — ' + tr('settings.validationHint') + (status.detail === null || status.detail === undefined ? '' : ' — ' + status.detail),
                        style: S.footerTextError,
                        role: 'settings-status',
                    };
                }
                if (status.kind === 'conflict') {
                    return { text: tr('settings.conflict') + ' — ' + tr('settings.conflictHint'), style: S.footerTextError, role: 'settings-status' };
                }
                if (status.kind === 'invalid') return { text: tr('settings.invalidLocal'), style: S.footerTextError, role: 'settings-status' };
                if (status.kind === 'error') {
                    return {
                        text: (status.message ?? tr('settings.saveError')) + (status.detail === null || status.detail === undefined ? '' : ' — ' + status.detail),
                        style: S.footerTextError,
                        role: 'settings-status',
                    };
                }
                if (status.kind === 'info' && status.message !== null && status.message !== undefined) {
                    return { text: status.message, style: S.footerText, role: 'settings-status' };
                }
                return { text: dirty ? tr('settings.dirty') : tr('settings.clean'), style: S.footerText, role: 'settings-status' };
            }

            function SettingsPanel(props = {}) {
                const { entry, reload, applyEntry, lang, tr } = props;
                const config = entry?.config ?? null;
                const editable = entry?.editable !== false;
                const [draft, setDraft] = react.useState(() => draftOf(config));
                const [status, setStatus] = react.useState({ kind: 'idle', message: null, detail: null, at: null, fieldErrors: {} });
                const [saving, setSaving] = react.useState(false);
                const initialized = react.useRef(false);

                // 首次拿到配置时铺草稿。保存/失败都保留草稿，避免用户输入被回滚冲掉。
                react.useEffect(() => {
                    if (initialized.current === true) return;
                    if (config === null) return;
                    initialized.current = true;
                    setDraft(draftOf(config));
                }, [config]);

                const patch = config === null ? {} : buildPatch(draft, config);
                const dirty = Object.keys(patch).length > 0;
                const localErrors = validateDraft(draft, tr);
                const shownErrors = {
                    ...(status.kind === 'invalid' ? localErrors : {}),
                    ...(status.fieldErrors ?? {}),
                };
                // 422 里可能点到表单没画出来的字段（目录/时区），单独列出来，不能吞掉。
                const extraFieldErrors = Object.entries(status.fieldErrors ?? {})
                    .filter(([path]) => FIELD_LABEL_KEY[path] === undefined)
                    .map(([path, message]) => path + '：' + message);

                const setField = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));

                const discard = () => {
                    setDraft(draftOf(config));
                    setStatus({ kind: 'idle', message: null, detail: null, at: null, fieldErrors: {} });
                };

                const reloadFresh = () => {
                    // 只换基线，不改 draft：用户没保存的输入必须留住。
                    reload();
                };

                const save = async () => {
                    if (editable === false || saving === true) return;
                    if (dirty === false) {
                        setStatus({ kind: 'info', message: tr('settings.noChanges'), detail: null, at: null, fieldErrors: {} });
                        return;
                    }
                    if (Object.keys(localErrors).length > 0) {
                        setStatus({ kind: 'invalid', message: null, detail: null, at: null, fieldErrors: {} });
                        return;
                    }
                    setSaving(true);
                    setStatus({ kind: 'saving', message: null, detail: null, at: null, fieldErrors: {} });
                    try {
                        const body = await fetchJson(apiUrl('/config'), {
                            method: 'POST',
                            body: { patch, expectedRevision: entry.revision },
                        });
                        const next = normalizeConfigEntry(body);
                        if (next === null || next.config === null) {
                            setStatus({ kind: 'error', message: tr('settings.saveError'), detail: tr('settings.unavailable'), at: null, fieldErrors: {} });
                            return;
                        }
                        applyEntry(next);
                        setDraft(draftOf(next.config));
                        setStatus({ kind: 'saved', message: null, detail: null, at: new Date().toISOString(), fieldErrors: {} });
                    }
                    catch (error) {
                        if (error?.name === 'ApiError' && error.code === 'http' && error.status === 422) {
                            setStatus({
                                kind: 'validation',
                                message: null,
                                detail: validationDetailOf(error.body),
                                at: null,
                                fieldErrors: fieldErrorsOf(error.body, tr),
                            });
                        }
                        else if (error?.name === 'ApiError' && error.code === 'http' && error.status === 409) {
                            setStatus({ kind: 'conflict', message: null, detail: null, at: null, fieldErrors: {} });
                        }
                        else {
                            setStatus({ kind: 'error', message: tr('settings.saveError'), detail: describeApiError(error, tr), at: null, fieldErrors: {} });
                        }
                    }
                    finally {
                        setSaving(false);
                    }
                };

                const statusLine = statusLineOf(status, dirty, lang, tr);
                const configDisabled = editable === false;
                const inputDisabled = configDisabled || saving === true;

                return h('section', { style: S.block, 'data-role': 'settings' },
                    h('div', { style: S.blockHead },
                        h('h3', { style: S.blockTitle }, tr('settings')),
                        Number.isInteger(entry?.revision) ? h('span', { style: S.badge }, tr('settings.revision') + ' ' + entry.revision) : null,
                        entry?.namespace ? h('span', { style: S.badge }, tr('settings.namespace') + ' ' + entry.namespace) : null,
                        editable === false ? h('span', { style: { ...S.badge, color: C.warn } }, tr('settings.readonlyBadge')) : null),
                    editable === false
                        ? h(Notice, { tone: 'warn', title: tr('settings.readonly'), role: 'settings-readonly' },
                            Array.isArray(entry?.warnings) && entry.warnings.length > 0
                                ? tr('settings.readonlyReason') + '：' + entry.warnings.join('；')
                                : null)
                        : null,
                    Array.isArray(entry?.warnings) && entry.warnings.length > 0
                        ? h(Notice, { tone: 'warn', title: tr('settings.warnings'), items: entry.warnings, role: 'settings-warnings' })
                        : null,
                    config === null
                        ? h(Notice, { tone: 'error', title: tr('settings.unavailable'), role: 'settings-empty' })
                        : h('div', { 'data-role': 'settings-fields' },
                            h(CheckboxField, {
                                name: 'enabled',
                                label: tr('settings.enabled'),
                                hint: tr('settings.enabledHint'),
                                checked: draft.enabled === true,
                                onText: tr('settings.on'),
                                offText: tr('settings.off'),
                                disabled: inputDisabled,
                                error: shownErrors.enabled,
                                onChange: value => setField('enabled', value),
                            }),
                            h(NumberField, {
                                name: 'heartbeatIntervalSeconds',
                                label: tr('settings.heartbeat'),
                                hint: tr('settings.heartbeatHint'),
                                value: draft.heartbeatIntervalSeconds,
                                min: 5,
                                max: 3600,
                                unitLabel: tr('settings.seconds'),
                                disabled: inputDisabled,
                                error: shownErrors.heartbeatIntervalSeconds,
                                onChange: value => setField('heartbeatIntervalSeconds', value),
                            }),
                            h(NumberField, {
                                name: 'idleThresholdSeconds',
                                label: tr('settings.idle'),
                                hint: tr('settings.idleHint'),
                                value: draft.idleThresholdSeconds,
                                min: 5,
                                max: 86_400,
                                unitLabel: tr('settings.seconds'),
                                disabled: inputDisabled,
                                error: shownErrors.idleThresholdSeconds,
                                onChange: value => setField('idleThresholdSeconds', value),
                            }),
                            h(NumberField, {
                                name: 'flushIntervalSeconds',
                                label: tr('settings.flush'),
                                hint: tr('settings.flushHint'),
                                value: draft.flushIntervalSeconds,
                                min: 1,
                                max: 600,
                                unitLabel: tr('settings.seconds'),
                                disabled: inputDisabled,
                                error: shownErrors.flushIntervalSeconds,
                                onChange: value => setField('flushIntervalSeconds', value),
                            }),
                            h(CheckboxField, {
                                name: 'trackAgentActivity',
                                label: tr('settings.agent'),
                                hint: tr('settings.agentHint'),
                                checked: draft.trackAgentActivity === true,
                                onText: tr('settings.on'),
                                offText: tr('settings.off'),
                                disabled: inputDisabled,
                                error: shownErrors.trackAgentActivity,
                                onChange: value => setField('trackAgentActivity', value),
                            }),
                            h(CheckboxField, {
                                name: 'trackAiLines',
                                label: tr('settings.lines'),
                                hint: tr('settings.linesHint'),
                                checked: draft.trackAiLines === true,
                                onText: tr('settings.on'),
                                offText: tr('settings.off'),
                                disabled: inputDisabled,
                                error: shownErrors.trackAiLines,
                                onChange: value => setField('trackAiLines', value),
                            }),
                            h(CheckboxField, {
                                name: 'humanTracking.enabled',
                                label: tr('settings.human'),
                                hint: tr('settings.humanHint'),
                                checked: draft.humanEnabled === true,
                                onText: tr('settings.on'),
                                offText: tr('settings.off'),
                                disabled: inputDisabled,
                                error: shownErrors['humanTracking.enabled'],
                                onChange: value => setField('humanEnabled', value),
                            }),
                            h('div', { style: S.formRow, 'data-field': 'storageDirectory' },
                                h('div', { style: S.formLabel },
                                    h('span', { style: S.formLabelText }, tr('settings.storage')),
                                    h('span', { style: S.formHint }, tr('settings.storageHint'))),
                                h('div', { style: S.control },
                                    h('span', { style: S.pathValue, title: draft.storageDirectory }, draft.storageDirectory === '' ? tr('settings.storageEmpty') : draft.storageDirectory)))),
                    extraFieldErrors.length > 0
                        ? h(Notice, { tone: 'error', title: tr('settings.invalidLocal'), items: extraFieldErrors, role: 'settings-field-errors' })
                        : null,
                    statEntries(entry?.stats).length > 0
                        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
                            h('div', { style: S.sectionTitle }, tr('settings.stats')),
                            h('div', { style: S.statGrid },
                                statEntries(entry.stats).map(([key, value]) => h('div', { key, style: S.statItem },
                                    h('span', { style: S.statKey }, STAT_LABEL_KEY[key] !== undefined ? tr(STAT_LABEL_KEY[key]) : key),
                                    h('span', { style: S.statValue }, formatStatValue(key, value, lang)),
                                )),
                            ),
                        )
                        : null,
                    h('div', { style: S.footer },
                        h(Button, {
                            primary: true,
                            disabled: configDisabled || saving === true,
                            ariaLabel: tr('settings.save'),
                            title: configDisabled ? tr('settings.readonly') : tr('settings.save'),
                            onClick: save,
                        }, saving === true ? tr('settings.saving') : tr('settings.save')),
                        h(Button, {
                            disabled: configDisabled || saving === true || dirty === false,
                            ariaLabel: tr('settings.reset'),
                            onClick: discard,
                        }, tr('settings.reset')),
                        h(Button, {
                            disabled: saving === true,
                            ariaLabel: tr('settings.reload'),
                            onClick: reloadFresh,
                        }, tr('settings.reload')),
                        h('span', { style: statusLine.style, 'data-role': statusLine.role }, statusLine.text)));
            }

            function formatStatValue(key, value, lang) {
                if (typeof value === 'boolean') return lang === 'en' ? (value ? 'yes' : 'no') : (value ? '是' : '否');
                if (typeof value === 'number') {
                    if (key === 'bytes' || key === 'sizeBytes') return formatBytes(value) ?? String(value);
                    return formatNumber(value, lang) ?? String(value);
                }
                if (typeof value === 'string') {
                    const iso = Date.parse(value);
                    if (Number.isFinite(iso) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
                        return formatDateTime(value, undefined, lang) ?? value;
                    }
                    return value;
                }
                return String(value);
            }

            /* ------------------------------------------------------------------ *
             * 会话头入口（紧凑，不抢主面板）
             * ------------------------------------------------------------------ */

            function HeaderAction() {
                const lang = useLang();
                const tr = translator(lang);
                const [open, setOpen] = react.useState(false);
                const { state, refresh } = useSummary('today');
                const totals = state.data?.totals ?? null;
                const ai = totals === null ? null : formatDuration(totals.aiSeconds, lang);
                const label = ai === null ? tr('header.aiToday') : tr('header.aiToday') + ' ' + ai;

                return h('div', { style: { position: 'relative', display: 'inline-block' } },
                    h('button', {
                        type: 'button',
                        'aria-haspopup': 'dialog',
                        'aria-expanded': open,
                        'aria-label': open ? tr('header.close') : tr('header.open'),
                        title: open ? tr('header.close') : label,
                        onClick: () => setOpen(value => !value),
                        style: { ...S.headerButton, ...(open ? { color: C.accent, borderColor: C.borderStrong } : {}) },
                    }, '⏱ ' + label),
                    open
                        ? h('div', { style: S.popover, role: 'dialog', 'aria-label': tr('header.title'), 'data-role': 'header-popover' },
                            h('div', { style: S.popoverHead },
                                h('h4', { style: S.popoverTitle }, tr('header.title')),
                                h(Button, { ariaLabel: tr('header.close'), onClick: () => setOpen(false) }, '×')),
                            state.status === 'loading' && state.data === null
                                ? h('p', { style: S.popoverHint }, tr('settings.loading'))
                                : null,
                            state.error !== null && state.data === null
                                ? h(Notice, { tone: 'error', title: tr('settings.loadError'), role: 'header-error' }, describeApiError(state.error, tr))
                                : null,
                            totals === null
                                ? null
                                : h('div', { style: { display: 'flex', flexDirection: 'column' } },
                                    h('div', { style: S.popoverRow },
                                        h('span', { style: S.popoverKey }, tr('metric.ai')),
                                        h('span', { style: S.popoverValue }, formatDuration(totals.aiSeconds, lang) ?? tr('metric.pending'))),
                                    h('div', { style: S.popoverRow },
                                        h('span', { style: S.popoverKey }, tr('metric.human')),
                                        h('span', { style: S.popoverValue }, humanTextOf(totals.humanSeconds, state.data.humanStatus, lang, tr))),
                                    h('div', { style: S.popoverRow },
                                        h('span', { style: S.popoverKey }, tr('metric.total')),
                                        h('span', { style: S.popoverValue }, formatDuration(totals.totalSeconds, lang) ?? tr('metric.pending')))),
                            state.data !== null && state.data.projects.length === 0
                                ? h('p', { style: S.popoverHint }, tr('header.empty'))
                                : null,
                            state.data !== null && state.data.projects.length > 0
                                ? h('div', { style: { display: 'flex', flexDirection: 'column' } },
                                    state.data.projects.slice(0, 3).map(project => h('div', { key: project.project, style: S.popoverRow },
                                        h('span', { style: { ...S.popoverKey, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: project.cwd }, project.label),
                                        h('span', { style: S.popoverValue }, formatDuration(project.aiSeconds, lang) ?? tr('metric.pending')))))
                                : null,
                            h('p', { style: S.popoverHint }, tr('header.hint')),
                            h(Button, { ariaLabel: tr('refresh'), onClick: refresh }, state.refreshing === true ? tr('refreshing') : tr('refresh')))
                        : null);
            }

            /* ------------------------------------------------------------------ *
             * 组合：设置页、插件配置页
             * ------------------------------------------------------------------ */

            function Dashboard(props = {}) {
                const lang = useLang();
                const tr = translator(lang);
                const { state, reload, applyEntry } = useConfigEntry();

                return h('div', { style: S.root, 'data-dsh-coding-time': 'dashboard' },
                    h(SummaryRegion, { preset: props.preset ?? 'today', compact: props.compact === true }),
                    state.status === 'loading' && state.entry === null
                        ? h('p', { style: { ...S.meta, margin: 0 }, 'data-role': 'config-loading' }, tr('settings.loading'))
                        : null,
                    state.error !== null && state.entry === null
                        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' }, 'data-role': 'config-error' },
                            h(Notice, { tone: 'error', title: tr('settings.loadError'), role: 'config-error-notice' }, describeApiError(state.error, tr)),
                            h(Button, { ariaLabel: tr('settings.retry'), onClick: reload }, tr('settings.retry')))
                        : null,
                    state.entry !== null
                        ? h(SettingsPanel, { entry: state.entry, reload, applyEntry, lang, tr })
                        : null);
            }

            /** `settings.section` 座位：完整页面。 */
            function CodingTimeSection() {
                return h(Dashboard, { preset: 'today', compact: false });
            }

            /** `plugins.bundle.config` 的摘要行。 */
            function BundleSummary() {
                const lang = useLang();
                const tr = translator(lang);
                const { state } = useSummary('today');
                const totals = state.data?.totals ?? null;
                const ai = totals === null ? null : formatDuration(totals.aiSeconds, lang);
                return h('p', { style: { ...S.meta, margin: 0 }, 'data-role': 'bundle-summary' },
                    h('span', null, tr('bundle.summary') + ' '),
                    h('strong', { style: { color: C.text, fontVariantNumeric: 'tabular-nums', fontWeight: 600 } }, ai ?? tr('metric.pending')),
                    h('span', null, ' · ' + tr('bundle.note')));
            }

            /** `plugins.bundle.config` 座位：keyed `dsh-coding-time`。 */
            function BundleConfig(props = {}) {
                const view = props.view === 'summary' ? 'summary' : 'page';
                if (view === 'summary') return h(BundleSummary);
                return h(Dashboard, { preset: 'today', compact: true });
            }

            /* ------------------------------------------------------------------ *
             * 挂载
             * ------------------------------------------------------------------ */

            function registrationLabel(key) {
                return () => translator(langOf())(key);
            }

            /**
             * 挂载客户端半边。
             *
             * @param ctx - 客户端 cordis 上下文。
             */
            function apply(ctx) {
                ctx.inject(['locale'], (injected) => {
                    try {
                        localeService = injected.get('locale');
                    }
                    catch {
                        localeService = undefined;
                    }
                    publishLocale(localeService);
                    return undefined;
                });

                const releases = [];
                ctx.inject(['slots'], (injected) => {
                    let slots;
                    try {
                        slots = injected.get('slots');
                    }
                    catch {
                        slots = undefined;
                    }
                    if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
                        console.warn('[dsh-coding-time] slots 服务不可用，设置页与仪表盘不会被注册。');
                        return undefined;
                    }
                    const register = (slotName, options, Component) => {
                        try {
                            const release = slots.inject(slotName, () => slots.register(options, Component));
                            if (typeof release === 'function') releases.push(release);
                            else if (release !== null && typeof release === 'object' && typeof release.dispose === 'function') {
                                releases.push(() => release.dispose());
                            }
                        }
                        catch (error) {
                            console.warn(`[dsh-coding-time] 注册座位 ${slotName} 失败：`, error);
                        }
                    };
                    // 设置 → 编码时长：完整仪表盘 + 配置表单。
                    register(SLOT_SETTINGS, {
                        name: SLOT_SETTINGS,
                        id: SEAT_ID,
                        order: 64,
                        label: registrationLabel('nav'),
                    }, CodingTimeSection);
                    // 插件页里的本包配置区（keyed 到包名）。
                    register(SLOT_BUNDLE_CONFIG, {
                        name: SLOT_BUNDLE_CONFIG,
                        key: BUNDLE_KEY,
                    }, BundleConfig);
                    // 会话头：今日 AI 时长小入口。
                    register(SLOT_HEADER_ACTIONS, {
                        name: SLOT_HEADER_ACTIONS,
                        id: SEAT_ID + '-session-header',
                        order: -18,
                        label: registrationLabel('header.aiToday'),
                    }, HeaderAction);
                    return undefined;
                });

                ctx.effect(() => () => {
                    for (const release of releases) {
                        try {
                            release?.();
                        }
                        catch (error) {
                            console.warn('[dsh-coding-time] 释放座位失败：', error);
                        }
                    }
                    releases.length = 0;
                });
            }

            return {
                name: 'dsh-coding-time-client',
                inject: [],
                apply,
                /**
                 * 仅供 node:test 使用的纯函数出口。
                 *
                 * 不含任何状态，宿主加载插件时不会碰它；公开出来是为了让测试直接验证
                 * URL 编码、时长/null 语义、补丁构造与 422 字段解析，而不必渲染整棵树。
                 */
                __test: Object.freeze({
                    API_BASE,
                    PRESETS,
                    apiUrl,
                    summaryUrl,
                    exportUrl,
                    normalizePreset,
                    formatDuration,
                    formatNumber,
                    formatBytes,
                    normalizeSummary,
                    normalizeConfigEntry,
                    draftOf,
                    buildPatch,
                    validateDraft,
                    fieldErrorsOf,
                    statEntries,
                    dateAxisOf,
                    humanTextOf,
                }),
            };
        },
    });
})();