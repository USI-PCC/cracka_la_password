/*
 * kvLookup — sync binary-search over 256 sharded sorted binary files.
 *
 * open(dir):
 *   - read `dir/manifest.json`; if missing or not complete, stay disabled
 *   - open one fd per shard_XX.bin (00..ff); cache (fd, recordCount)
 *
 * lookup(hashHex):
 *   - shardId = first byte of hash
 *   - key = bytes 1..15 of hash
 *   - binary search the shard via fs.readSync on a 24-byte scratch buffer
 *   - return password string on hit, null on miss / disabled / bad input
 */
const fs = require('node:fs');
const path = require('node:path');

const RECORD = 24;
const N_SHARDS = 256;
const KEY_SIZE = 15;

let enabled = false;
let shards = null;      // Array<{ fd: number, recordCount: number }>
const scratch = Buffer.alloc(RECORD);

function isEnabled() { return enabled; }

function closeFdsOnly() {
    if (!shards) return;
    for (const s of shards) {
        if (s && typeof s.fd === 'number') {
            try { fs.closeSync(s.fd); } catch (_) { /* ignore */ }
        }
    }
    shards = null;
}

function close() {
    closeFdsOnly();
    enabled = false;
}

function open(dir) {
    close();

    const manPath = path.join(dir, 'manifest.json');
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    } catch (e) {
        console.warn(`[kvLookup] manifest missing or unreadable at ${manPath}: ${e.message}`);
        enabled = false;
        return;
    }
    if (manifest.complete !== true) {
        console.warn(`[kvLookup] manifest at ${manPath} has complete=${manifest.complete}; disabling`);
        enabled = false;
        return;
    }

    shards = new Array(N_SHARDS);
    for (let i = 0; i < N_SHARDS; i++) {
        const hex = i.toString(16).padStart(2, '0');
        const fp = path.join(dir, `shard_${hex}.bin`);
        let st;
        try {
            st = fs.statSync(fp);
        } catch (e) {
            console.warn(`[kvLookup] shard ${hex} missing: ${e.message}; disabling`);
            closeFdsOnly();
            enabled = false;
            return;
        }
        if (st.size % RECORD !== 0) {
            console.warn(`[kvLookup] shard ${hex} size ${st.size} not divisible by ${RECORD}; disabling`);
            closeFdsOnly();
            enabled = false;
            return;
        }
        const fd = fs.openSync(fp, 'r');
        shards[i] = { fd, recordCount: st.size / RECORD };
    }
    enabled = true;
    const total = shards.reduce((a, s) => a + s.recordCount, 0);
    console.log(`[kvLookup] enabled: ${total} records across ${N_SHARDS} shards (${dir})`);
}

/**
 * Look up the password for a given MD5.
 * @param {string} hashHex — 32-character lowercase hex MD5
 * @returns {string|null}
 */
function lookup(hashHex) {
    if (!enabled) return null;
    if (typeof hashHex !== 'string' || hashHex.length !== 32) return null;
    if (!/^[0-9a-f]{32}$/.test(hashHex)) return null;

    const shardId = parseInt(hashHex.slice(0, 2), 16);
    const shard = shards[shardId];
    if (!shard || shard.recordCount === 0) return null;

    const key = Buffer.from(hashHex.slice(2), 'hex'); // 15 B
    if (key.length !== KEY_SIZE) return null;

    let lo = 0;
    let hi = shard.recordCount;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const bytesRead = fs.readSync(shard.fd, scratch, 0, RECORD, mid * RECORD);
        if (bytesRead !== RECORD) return null; // truncated file
        const cmp = Buffer.compare(scratch.subarray(0, KEY_SIZE), key);
        if (cmp === 0) {
            const len = scratch[15];
            if (len < 1 || len > 8) return null;
            return scratch.subarray(16, 16 + len).toString('utf8');
        }
        if (cmp < 0) lo = mid + 1; else hi = mid;
    }
    return null;
}

module.exports = { open, close, lookup, isEnabled };
