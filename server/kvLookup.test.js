// Tests for kvLookup — a sync KV reader over sharded sorted binary files.
// Runs with `node --test server/kvLookup.test.js` (node >= 18).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const kv = require('./kvLookup');

// Build a tiny synthetic KV: 256 shard files, most empty, with the
// entries we care about slotted into their real shards by md5[0].
function buildFixtureKV(tmpDir, entries) {
    const RECORD = 24;
    const byShard = new Map();
    for (let i = 0; i < 256; i++) byShard.set(i, []);

    for (const pw of entries) {
        const md5 = crypto.createHash('md5').update(pw).digest();    // 16 B
        const shard = md5[0];
        const rec = Buffer.alloc(RECORD);
        md5.copy(rec, 0, 1, 16);                                     // 15 B hash tail
        rec[15] = pw.length;
        Buffer.from(pw).copy(rec, 16, 0, Math.min(pw.length, 8));
        byShard.get(shard).push({ key: rec.subarray(0, 15), rec });
    }
    for (const [shardId, list] of byShard) {
        list.sort((a, b) => Buffer.compare(a.key, b.key));
        const hex = shardId.toString(16).padStart(2, '0');
        const fp = path.join(tmpDir, `shard_${hex}.bin`);
        const out = Buffer.concat(list.map(x => x.rec));
        fs.writeFileSync(fp, out);
    }
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({
        schema_version: 1,
        shard_count: 256,
        record_size: 24,
        complete: true,
    }));
}

test('kvLookup — hit returns password', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvlookup-hit-'));
    buildFixtureKV(dir, ['hello', 'world', 'ciao']);

    kv.open(dir);
    try {
        assert.strictEqual(kv.lookup('5d41402abc4b2a76b9719d911017c592'), 'hello');
        assert.strictEqual(kv.lookup('7d793037a0760186574b0282f2f435e7'), 'world');
        assert.strictEqual(kv.lookup('6e6bc4e49dd477ebc98ef4046c067b5f'), 'ciao');
    } finally {
        kv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('kvLookup — miss returns null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvlookup-miss-'));
    buildFixtureKV(dir, ['hello']);

    kv.open(dir);
    try {
        assert.strictEqual(
            kv.lookup('ffffffffffffffffffffffffffffffff'),
            null
        );
    } finally {
        kv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('kvLookup — missing manifest disables lookup gracefully', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvlookup-noman-'));
    // No manifest.json, no shard files.
    kv.open(dir);
    try {
        assert.strictEqual(kv.lookup('5d41402abc4b2a76b9719d911017c592'), null);
        assert.strictEqual(kv.isEnabled(), false);
    } finally {
        kv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('kvLookup — manifest with complete:false disables lookup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvlookup-incomplete-'));
    buildFixtureKV(dir, ['hello']);
    const manPath = path.join(dir, 'manifest.json');
    const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    man.complete = false;
    fs.writeFileSync(manPath, JSON.stringify(man));

    kv.open(dir);
    try {
        assert.strictEqual(kv.isEnabled(), false);
        assert.strictEqual(kv.lookup('5d41402abc4b2a76b9719d911017c592'), null);
    } finally {
        kv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('kvLookup — binary search correctness across multiple records in one shard', () => {
    // Force several entries into shard 00 to exercise the bsearch loop.
    // Plain integer strings have widely-distributed MD5s; we just want to
    // check lookup() works for every member of a many-entry KV.
    const manyWords = [];
    for (let i = 0; i < 5000; i++) manyWords.push(`w${i}`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvlookup-many-'));
    buildFixtureKV(dir, manyWords);

    kv.open(dir);
    try {
        for (const pw of manyWords) {
            const h = crypto.createHash('md5').update(pw).digest('hex');
            assert.strictEqual(kv.lookup(h), pw, `expected lookup(md5(${pw}))=${pw}`);
        }
    } finally {
        kv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('kvLookup — malformed hash input returns null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvlookup-bad-'));
    buildFixtureKV(dir, ['hello']);

    kv.open(dir);
    try {
        assert.strictEqual(kv.lookup(''), null);
        assert.strictEqual(kv.lookup('5d41'), null);                      // too short
        assert.strictEqual(kv.lookup('X'.repeat(32)), null);              // non-hex
        assert.strictEqual(kv.lookup(null), null);
        assert.strictEqual(kv.lookup(undefined), null);
    } finally {
        kv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
