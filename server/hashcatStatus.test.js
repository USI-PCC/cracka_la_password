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
