#!/usr/bin/env bash
# Integration test for enumerate_md5:
#   charset="abc", length=2 -> 9 candidates total: aa, ab, ac, ba, bb, bc, ca, cb, cc
#   Verify slice --skip 0 --limit 3 writes MD5 records for aa, ab, ac only.
#   MD5("aa") = 4124bc0a9335c27f086f24ba207a4912 -> shard 41
#   MD5("ab") = 187ef4436122d1cc2f40dc2b92f0eba0 -> shard 18
#   MD5("ac") = e2075474294983e013ee4dd06da3e9e8 -> shard e2
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="${ENUMERATE_MD5:-$SCRIPT_DIR/../src/enumerate_md5}"
TMP="$SCRIPT_DIR/tmp/enumerate_md5"

rm -rf "$TMP"
mkdir -p "$TMP"

"$BIN" --charset abc --length 2 --skip 0 --limit 3 --output-dir "$TMP"

# Expect exactly 3 non-empty shard files (41, 18, e2), each 24 B.
for shard in 41 18 e2; do
    f="$TMP/shard_${shard}.bin"
    [ -f "$f" ] || { echo "MISSING shard $shard"; exit 1; }
    size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
    [ "$size" -eq 24 ] || { echo "BAD SIZE shard $shard: $size (want 24)"; exit 1; }
done
non_empty=$(find "$TMP" -name 'shard_*.bin' -size +0 | wc -l | tr -d ' ')
[ "$non_empty" -eq 3 ] || { echo "UNEXPECTED non-empty shard count: $non_empty (want 3)"; exit 1; }

# Decode record for 'aa' (shard 41) and verify byte-exact contents.
hex=$(xxd -p "$TMP/shard_41.bin" | tr -d '\n')
expected="24bc0a9335c27f086f24ba207a491202" # hash tail [1..15] + len=2
expected+="6161000000000000"                 # 'aa' + 6 zeros
if [ "$hex" != "$expected" ]; then
    echo "RECORD MISMATCH for 'aa':"
    echo "  got:      $hex"
    echo "  expected: $expected"
    exit 1
fi

# Slice mid-range: --skip 4 --limit 2 -> candidates bb, bc
rm -rf "$TMP"
mkdir -p "$TMP"
"$BIN" --charset abc --length 2 --skip 4 --limit 2 --output-dir "$TMP"

# Ask Python which shards should be non-empty by computing MD5 of "bb"
# and "bc" directly. Avoids hardcoded hashes that can drift.
expected=$(python3 -c "
import hashlib
for pw in ['bb', 'bc']:
    print('%02x' % hashlib.md5(pw.encode()).digest()[0])
" | sort -u)

for shard in $expected; do
    f="$TMP/shard_${shard}.bin"
    [ -f "$f" ] || { echo "MISSING slice shard $shard"; exit 1; }
    size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
    [ "$size" -eq 24 ] || { echo "BAD SIZE slice shard $shard: $size (want 24)"; exit 1; }
done

n_expected=$(echo "$expected" | wc -l | tr -d ' ')
non_empty=$(find "$TMP" -name 'shard_*.bin' -size +0 | wc -l | tr -d ' ')
[ "$non_empty" -eq "$n_expected" ] || {
    echo "slice: unexpected non-empty count: $non_empty (want $n_expected)"; exit 1;
}

echo "OK"
