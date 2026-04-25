// server/hashcatStatus.test.js
const test = require('node:test');
const assert = require('node:assert');
const { parseStatusLine, summarize } = require('./hashcatStatus');

const sampleLine = JSON.stringify({
    status: 4,
    progress: [1234567, 916132832],
    speed_total: 4200000000,
    time_left: 17,
    devices: [
        { device_id: 1, speed: 2100000000, temp: 62, util: 99 },
        { device_id: 2, speed: 2100000000, temp: 64, util: 100 },
    ],
    guess: { guess_mask: '?1?1?1?1?1 [5]', guess_base: 'aaaab' },
});

test('parseStatusLine returns null for non-JSON', () => {
    assert.strictEqual(parseStatusLine('Session..........: crk-1-1'), null);
});

test('parseStatusLine returns null for JSON without progress', () => {
    assert.strictEqual(parseStatusLine(JSON.stringify({ foo: 1 })), null);
});

test('parseStatusLine returns the parsed object on a real frame', () => {
    const parsed = parseStatusLine(sampleLine);
    assert.ok(parsed);
    assert.deepStrictEqual(parsed.progress, [1234567, 916132832]);
});

test('summarize extracts the wire payload', () => {
    const s = summarize(parseStatusLine(sampleLine));
    assert.strictEqual(s.hashRate, 4200000000);
    assert.deepStrictEqual(s.progress, [1234567, 916132832]);
    assert.strictEqual(s.candidate, 'aaaab');
    assert.strictEqual(s.maskLen, 5);
    assert.strictEqual(s.etaSec, 17);
    assert.strictEqual(s.devices.length, 2);
    assert.strictEqual(s.devices[0].temp, 62);
});

test('summarize copes with missing optional fields', () => {
    const s = summarize({ progress: [0, 100], speed_total: 0, devices: [] });
    assert.strictEqual(s.hashRate, 0);
    assert.strictEqual(s.candidate, null);
    assert.strictEqual(s.maskLen, null);
    assert.strictEqual(s.etaSec, null);
});

test('summarize derives etaSec from estimated_stop when time_left is absent', () => {
    // Pin "now" so the test is deterministic — pretend it's epoch 1_000_000.
    const nowSec = 1_000_000;
    const stopSec = nowSec + 42;
    const { summarize: _ } = require('./hashcatStatus');
    // Patch Date.now for this test only.
    const realNow = Date.now;
    Date.now = () => nowSec * 1000;
    try {
        const s = summarize({
            progress: [0, 100], speed_total: 1, devices: [],
            estimated_stop: stopSec,
        });
        assert.strictEqual(s.etaSec, 42);
    } finally {
        Date.now = realNow;
    }
});

test('summarize prefers time_left over estimated_stop when both are present', () => {
    const s = summarize({
        progress: [0, 100], speed_total: 1, devices: [],
        time_left: 7, estimated_stop: 9999999999,
    });
    assert.strictEqual(s.etaSec, 7);
});

test('summarize returns null etaSec when estimated_stop is in the past', () => {
    const realNow = Date.now;
    Date.now = () => 2_000_000 * 1000;
    try {
        const s = summarize({
            progress: [0, 100], speed_total: 1, devices: [],
            estimated_stop: 1_000_000,
        });
        assert.strictEqual(s.etaSec, null);
    } finally {
        Date.now = realNow;
    }
});

test('maskLen counts ? tokens for JSON-mode mask strings (no [N] suffix)', () => {
    // hashcat --status-json emits the expanded mask string with no length
    // suffix. Each ?X token equals one output character.
    const cases = [
        ['?l?l?l?l',           4],
        ['?l?l?l?l?l',         5],
        ['?l?l?l?l?l?l',       6],
        ['?l?l?l?l?l?l?l',     7],
        ['?l?u?d?l?u?d?l?u',   8],
    ];
    for (const [mask, expected] of cases) {
        const s = summarize({
            progress: [0, 1], speed_total: 0, devices: [],
            guess: { guess_base: mask },
        });
        assert.strictEqual(s.maskLen, expected, `mask "${mask}" should be length ${expected}`);
    }
});

test('maskLen falls back to literal string length for non-mask candidates', () => {
    // Combinator/dictionary candidates have no ? tokens — use string length.
    const s = summarize({
        progress: [0, 1], speed_total: 0, devices: [],
        guess: { guess_base: 'marco12' },
    });
    assert.strictEqual(s.maskLen, 7);
});
