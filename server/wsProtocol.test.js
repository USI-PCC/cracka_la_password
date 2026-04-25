// server/wsProtocol.test.js
const test = require('node:test');
const assert = require('node:assert');
const { envelope, MESSAGE_KINDS } = require('./wsProtocol');

test('envelope wraps payload with kind and ts', () => {
    const before = Date.now();
    const m = envelope('received', {});
    const after = Date.now();
    assert.strictEqual(m.kind, 'received');
    assert.ok(m.ts >= before && m.ts <= after);
});

test('envelope merges payload fields', () => {
    const m = envelope('stage', { name: 'dictionary', phase: 'start' });
    assert.strictEqual(m.name, 'dictionary');
    assert.strictEqual(m.phase, 'start');
});

test('MESSAGE_KINDS exposes the canonical set', () => {
    for (const k of ['hello','received','stage','status','cache_hit','result','error']) {
        assert.ok(MESSAGE_KINDS[k.toUpperCase()] === k, `missing ${k}`);
    }
});

test('envelope payload cannot overwrite kind or ts', () => {
    const m = envelope('received', { kind: 'evil', ts: 0, extra: 1 });
    assert.strictEqual(m.kind, 'received');
    assert.notStrictEqual(m.ts, 0);
    assert.strictEqual(m.extra, 1);
});
