/**
 * 配置层单测：默认值、边界、拒绝语义、凭据隔离、目录与时区校验。
 *
 * 只测纯模块，不碰宿主、不写盘。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
    CONFIG_VERSION,
    ConfigError,
    DEFAULT_CONFIG,
    DEFAULT_EXCLUDE,
    LIMITS,
    defaultStorageDirectory,
    detectTimezone,
    normalizeConfig,
    sanitizeConfig,
} from '../lib/config.js';

/** 断言抛出期望 code/path 的 ConfigError。 */
function expectConfigError(fn, code, pathField) {
    assert.throws(fn, (error) => {
        assert.ok(error instanceof ConfigError, `应抛 ConfigError，实际 ${error?.name}`);
        assert.equal(error.code, code);
        if (pathField !== undefined) assert.equal(error.path, pathField);
        return true;
    });
}

test('默认配置：冻结、含全部字段、存储目录在用户主目录而不是 cwd', () => {
    assert.equal(CONFIG_VERSION, 1);
    assert.ok(Object.isFrozen(DEFAULT_CONFIG));
    assert.ok(Object.isFrozen(DEFAULT_CONFIG.humanTracking));
    assert.ok(Object.isFrozen(DEFAULT_CONFIG.exclude));
    assert.equal(DEFAULT_CONFIG.enabled, true);
    assert.equal(DEFAULT_CONFIG.heartbeatIntervalSeconds, 60);
    assert.equal(DEFAULT_CONFIG.idleThresholdSeconds, 180);
    assert.equal(DEFAULT_CONFIG.flushIntervalSeconds, 10);
    assert.equal(DEFAULT_CONFIG.trackAgentActivity, true);
    assert.equal(DEFAULT_CONFIG.trackAiLines, true);
    assert.deepEqual(DEFAULT_CONFIG.humanTracking, { enabled: false });
    assert.equal(DEFAULT_CONFIG.weekStartsOn, 1);
    assert.equal(DEFAULT_CONFIG.storageDirectory, path.join(os.homedir(), '.dsh', 'coding-time'));
    assert.equal(defaultStorageDirectory(), DEFAULT_CONFIG.storageDirectory);
    assert.ok(path.isAbsolute(DEFAULT_CONFIG.storageDirectory));
    assert.ok(!DEFAULT_CONFIG.storageDirectory.includes(process.cwd()));
    // 默认排除必须覆盖工单列出的项
    for (const pattern of ['.git', 'node_modules', 'dist', 'build']) {
        assert.ok(DEFAULT_CONFIG.exclude.includes(pattern), `默认排除缺 ${pattern}`);
    }
    assert.ok(DEFAULT_EXCLUDE.includes('*.pem') && DEFAULT_EXCLUDE.includes('*.key'));
    // 默认配置本身必须能原样再归一化（幂等）
    const again = normalizeConfig(DEFAULT_CONFIG);
    assert.deepEqual(again, DEFAULT_CONFIG);
});

test('缺省与空对象等价于默认值，且返回冻结对象', () => {
    const fromNothing = normalizeConfig();
    const fromEmpty = normalizeConfig({});
    assert.deepEqual(fromNothing, DEFAULT_CONFIG);
    assert.deepEqual(fromEmpty, DEFAULT_CONFIG);
    assert.ok(Object.isFrozen(fromNothing));
    assert.throws(() => { fromEmpty.enabled = false; }, TypeError, '冻结对象必须不可写');
});

test('以 invalid 开头的输入类型一律拒绝，不做静默兜底', () => {
    for (const bad of ['string', 42, true, [], () => {}, new Date()]) {
        expectConfigError(() => normalizeConfig(bad), 'invalid_type', 'config');
    }
    // null/undefined 表示"没配"，按默认处理（与 sanitize 的空对象口径一致）
    assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
    assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
});

test('未知字段被拒绝，并指名字段路径', () => {
    expectConfigError(() => normalizeConfig({ nope: 1 }), 'unknown_field', 'nope');
    expectConfigError(() => normalizeConfig({ enabled: true, extra: 'x' }), 'unknown_field', 'extra');
    expectConfigError(() => normalizeConfig({ humanTracking: { enabled: true, prompt: 'x' } }), 'unknown_field', 'humanTracking.prompt');
});

test('任何层级的凭据字段都被拒绝（配置永远不含密钥）', () => {
    for (const key of ['apiKey', 'api_key', 'token', 'password', 'secret', 'privateKey', 'credentials', 'authorization']) {
        expectConfigError(() => normalizeConfig({ [key]: 'leak' }), 'credential_forbidden', key);
    }
    expectConfigError(
        () => normalizeConfig({ humanTracking: { enabled: true, token: 'leak' } }),
        'credential_forbidden',
        'humanTracking.token',
    );
});

test('数值字段：类型、整数、范围、NaN/Infinity 都拒绝', () => {
    expectConfigError(() => normalizeConfig({ heartbeatIntervalSeconds: '60' }), 'invalid_type', 'heartbeatIntervalSeconds');
    expectConfigError(() => normalizeConfig({ heartbeatIntervalSeconds: 60.5 }), 'invalid_number', 'heartbeatIntervalSeconds');
    expectConfigError(() => normalizeConfig({ heartbeatIntervalSeconds: Number.NaN }), 'invalid_type', 'heartbeatIntervalSeconds');
    expectConfigError(() => normalizeConfig({ idleThresholdSeconds: Number.POSITIVE_INFINITY }), 'invalid_type', 'idleThresholdSeconds');
    expectConfigError(
        () => normalizeConfig({ heartbeatIntervalSeconds: LIMITS.heartbeatIntervalSeconds.min - 1 }),
        'out_of_range',
        'heartbeatIntervalSeconds',
    );
    expectConfigError(
        () => normalizeConfig({ idleThresholdSeconds: LIMITS.idleThresholdSeconds.max + 1 }),
        'out_of_range',
        'idleThresholdSeconds',
    );
    expectConfigError(
        () => normalizeConfig({ flushIntervalSeconds: LIMITS.flushIntervalSeconds.max + 1 }),
        'out_of_range',
        'flushIntervalSeconds',
    );
    // 边界值本身必须通过
    const atBounds = normalizeConfig({
        heartbeatIntervalSeconds: LIMITS.heartbeatIntervalSeconds.min,
        idleThresholdSeconds: LIMITS.idleThresholdSeconds.max,
        flushIntervalSeconds: LIMITS.flushIntervalSeconds.min,
    });
    assert.equal(atBounds.heartbeatIntervalSeconds, LIMITS.heartbeatIntervalSeconds.min);
    assert.equal(atBounds.idleThresholdSeconds, LIMITS.idleThresholdSeconds.max);
    assert.equal(atBounds.flushIntervalSeconds, LIMITS.flushIntervalSeconds.min);
});

test('idle 阈值必须不小于心跳窗口（不隐式 clamp，直接报错）', () => {
    expectConfigError(
        () => normalizeConfig({ heartbeatIntervalSeconds: 120, idleThresholdSeconds: 60 }),
        'inconsistent',
        'idleThresholdSeconds',
    );
    // 相等是允许的下界
    const equal = normalizeConfig({ heartbeatIntervalSeconds: 120, idleThresholdSeconds: 120 });
    assert.equal(equal.idleThresholdSeconds, 120);
    // 只改心跳、把默认 idle 顶穿也要拒绝
    expectConfigError(() => normalizeConfig({ heartbeatIntervalSeconds: 300 }), 'inconsistent', 'idleThresholdSeconds');
});

test('布尔字段严格类型；关闭采集是显式 false 而不是字符串', () => {
    expectConfigError(() => normalizeConfig({ enabled: 'false' }), 'invalid_type', 'enabled');
    expectConfigError(() => normalizeConfig({ humanTracking: { enabled: 'yes' } }), 'invalid_type', 'humanTracking.enabled');
    expectConfigError(() => normalizeConfig({ humanTracking: [] }), 'invalid_type', 'humanTracking');
    const off = normalizeConfig({ enabled: false, trackAgentActivity: false, trackAiLines: false });
    assert.equal(off.enabled, false);
    assert.equal(off.trackAgentActivity, false);
    assert.equal(off.trackAiLines, false);
});

test('时区必须是真实 IANA 名（含本地检测值）', () => {
    assert.equal(typeof detectTimezone(), 'string');
    const zone = normalizeConfig({ timezone: 'Asia/Shanghai' }).timezone;
    assert.equal(zone, 'Asia/Shanghai');
    expectConfigError(() => normalizeConfig({ timezone: 'Asia/Shanghia' }), 'invalid_timezone', 'timezone');
    expectConfigError(() => normalizeConfig({ timezone: '' }), 'invalid_type', 'timezone');
    expectConfigError(() => normalizeConfig({ timezone: 8 }), 'invalid_type', 'timezone');
    assert.equal(normalizeConfig({ timezone: 'UTC' }).timezone, 'UTC');
});

test('存储目录必须本机绝对路径：拒绝相对、~、URL、UNC、NUL', () => {
    expectConfigError(() => normalizeConfig({ storageDirectory: 'data' }), 'invalid_directory', 'storageDirectory');
    expectConfigError(() => normalizeConfig({ storageDirectory: './data' }), 'invalid_directory', 'storageDirectory');
    expectConfigError(() => normalizeConfig({ storageDirectory: '~/.dsh' }), 'invalid_directory', 'storageDirectory');
    expectConfigError(() => normalizeConfig({ storageDirectory: 'file:///tmp/x' }), 'invalid_directory', 'storageDirectory');
    expectConfigError(() => normalizeConfig({ storageDirectory: '//host/share' }), 'invalid_directory', 'storageDirectory');
    expectConfigError(() => normalizeConfig({ storageDirectory: '\\\\host\\share' }), 'invalid_directory', 'storageDirectory');
    expectConfigError(() => normalizeConfig({ storageDirectory: '' }), 'invalid_directory', 'storageDirectory');
    expectConfigError(() => normalizeConfig({ storageDirectory: 'C:/x\0y' }), 'invalid_directory', 'storageDirectory');
    const absolute = defaultStorageDirectory();
    const normalized = normalizeConfig({ storageDirectory: absolute });
    assert.equal(normalized.storageDirectory, path.normalize(absolute));
    assert.ok(Object.isFrozen(normalized));
});

test('weekStartsOn 只接受 0..6 的整数', () => {
    assert.equal(normalizeConfig({ weekStartsOn: 0 }).weekStartsOn, 0);
    assert.equal(normalizeConfig({ weekStartsOn: 6 }).weekStartsOn, 6);
    expectConfigError(() => normalizeConfig({ weekStartsOn: 7 }), 'out_of_range', 'weekStartsOn');
    expectConfigError(() => normalizeConfig({ weekStartsOn: -1 }), 'out_of_range', 'weekStartsOn');
    expectConfigError(() => normalizeConfig({ weekStartsOn: 1.5 }), 'invalid_type', 'weekStartsOn');
});

test('排除模式：相对而非绝对、禁 .. 穿越、去重、上限', () => {
    const deduped = normalizeConfig({ exclude: ['node_modules', './node_modules/', '*.key'] }).exclude;
    assert.deepEqual([...deduped].sort(), ['*.key', 'node_modules'].sort());
    expectConfigError(() => normalizeConfig({ exclude: ['C:/Users'] }), 'invalid_pattern', 'exclude');
    expectConfigError(() => normalizeConfig({ exclude: ['/etc/passwd'] }), 'invalid_pattern', 'exclude');
    expectConfigError(() => normalizeConfig({ exclude: ['../outside'] }), 'invalid_pattern', 'exclude');
    expectConfigError(() => normalizeConfig({ exclude: [''] }), 'invalid_pattern', 'exclude');
    expectConfigError(() => normalizeConfig({ exclude: [42] }), 'invalid_type', 'exclude');
    expectConfigError(() => normalizeConfig({ exclude: 'node_modules' }), 'invalid_type', 'exclude');
    const tooMany = Array.from({ length: 201 }, (_, index) => `p${index}`);
    expectConfigError(() => normalizeConfig({ exclude: tooMany }), 'out_of_range', 'exclude');
});

test('嵌套 humanTracking 与默认值合并（只给 enabled 也不丢结构）', () => {
    const merged = normalizeConfig({ humanTracking: { enabled: true } });
    assert.deepEqual(merged.humanTracking, { enabled: true });
    const inherited = normalizeConfig({});
    assert.deepEqual(inherited.humanTracking, { enabled: false });
});

test('sanitizeConfig：宽容丢弃未知/凭据字段，其余仍严格校验，返回可序列化纯对象', () => {
    const dirty = {
        enabled: true,
        heartbeatIntervalSeconds: 90,
        idleThresholdSeconds: 180,
        apiKey: 'sk-leak',
        token: 'leak',
        unknownThing: 1,
        humanTracking: { enabled: false, password: 'leak', other: 1 },
        exclude: ['node_modules'],
    };
    const clean = sanitizeConfig(dirty);
    assert.equal(clean.apiKey, undefined);
    assert.equal(clean.token, undefined);
    assert.equal(clean.unknownThing, undefined);
    assert.deepEqual(clean.humanTracking, { enabled: false });
    assert.equal(clean.heartbeatIntervalSeconds, 90);
    assert.ok(!Object.isFrozen(clean), 'sanitize 结果给前端用，不冻结');
    assert.doesNotThrow(() => JSON.stringify(clean));
    assert.deepEqual(JSON.parse(JSON.stringify(clean)), clean);
    // 序列化后再严格归一化必须等价（sanitize 不打折边界）
    assert.deepEqual(normalizeConfig(clean), clean);
    // 非法值仍然报错
    expectConfigError(() => sanitizeConfig({ heartbeatIntervalSeconds: 0 }), 'out_of_range', 'heartbeatIntervalSeconds');
    expectConfigError(() => sanitizeConfig({ humanTracking: { enabled: 'x' } }), 'invalid_type', 'humanTracking.enabled');
    expectConfigError(() => sanitizeConfig('nope'), 'invalid_type', 'config');
});

test('DEFAULT_CONFIG 即使被外部改也改不动（模块级默认值受保护）', () => {
    assert.throws(() => { DEFAULT_CONFIG.exclude.push('x'); }, TypeError);
    const first = normalizeConfig({});
    const second = normalizeConfig({ exclude: [] });
    assert.deepEqual(first.exclude, DEFAULT_CONFIG.exclude);
    assert.deepEqual(second.exclude, []);
});
