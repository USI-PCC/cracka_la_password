#!/usr/bin/env bash
# Integration test for shard_sort:
#   - write 3 unsorted 24-byte records (with one duplicate)
#   - run sort
#   - verify they are ordered by the 15-byte key (memcmp) and deduped
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="${SHARD_SORT:-$SCRIPT_DIR/../src/shard_sort}"
TMP="$SCRIPT_DIR/tmp/shard_sort"

rm -rf "$TMP"
mkdir -p "$TMP"
SRC="$TMP/unsorted.bin"
DST="$TMP/sorted.bin"

# Three records, all 24 B:
#   record A: key = aa 00..00 (15 B)   password "a"   (len 1)
#   record B: key = 11 22 33 00..00    password "bb"  (len 2)
#   record C: key = 11 22 33 00..00    password "bb"  (len 2) — dup of B
# After sort+dedupe, expected order: B, A (only one 11-prefix row).
python3 - "$SRC" <<'PY'
import sys
path = sys.argv[1]
def rec(key_prefix, pw):
    key = key_prefix + b"\x00" * (15 - len(key_prefix))
    assert len(key) == 15
    assert 1 <= len(pw) <= 8
    pad = b"\x00" * (8 - len(pw))
    return key + bytes([len(pw)]) + pw + pad
records = [
    rec(b"\xaa", b"a"),
    rec(b"\x11\x22\x33", b"bb"),
    rec(b"\x11\x22\x33", b"bb"),  # duplicate
]
with open(path, "wb") as f:
    for r in records:
        assert len(r) == 24
        f.write(r)
PY

"$BIN" --in "$SRC" --out "$DST"

# Expect 48 bytes output (2 records after dedupe).
size=$(stat -c%s "$DST" 2>/dev/null || stat -f%z "$DST")
[ "$size" -eq 48 ] || { echo "BAD SIZE: $size (want 48)"; exit 1; }

# Build the expected hex dump and compare.
#   record 0: key=11 22 33 00..00  (15 B = 30 hex), len=02, pw=6262 + 6 pad
#   record 1: key=aa 00..00         (15 B), len=01, pw=61 + 7 pad
expected0="112233000000000000000000000000"   # 30 hex, 15 bytes
expected0+="02"                               # length byte
expected0+="6262000000000000"                 # 'bb' + 6 zeros
expected1="aa0000000000000000000000000000"   # 30 hex, 15 bytes
expected1+="01"                               # length byte
expected1+="6100000000000000"                 # 'a' + 7 zeros
expected="${expected0}${expected1}"

hex=$(xxd -p "$DST" | tr -d '\n')
if [ "$hex" != "$expected" ]; then
    echo "SORT MISMATCH:"
    echo "  got:      $hex"
    echo "  expected: $expected"
    exit 1
fi

echo "OK"
