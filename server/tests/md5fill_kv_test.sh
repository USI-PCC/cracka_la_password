#!/usr/bin/env bash
# Integration test for md5fill_kv:
#   - feed 3 known candidates on stdin
#   - verify the 3 resulting 24-byte records land in the correct shard files
#   - verify record contents (hash tail, length byte, password bytes)
#
# Runs from the repo root or from anywhere (uses $0 to locate itself).
# Binary is resolved from $MD5FILL_KV (override for containerised runs) or
# defaults to ../src/md5fill_kv relative to this script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="${MD5FILL_KV:-$SCRIPT_DIR/../src/md5fill_kv}"
TMP="$SCRIPT_DIR/tmp/md5fill_kv"

rm -rf "$TMP"
mkdir -p "$TMP"

# Candidates chosen so their MD5s land in three distinct shards:
#   hello -> 5d41402abc4b2a76b9719d911017c592  (shard 5d)
#   world -> 7d793037a0760186574b0282f2f435e7  (shard 7d)
#   ciao  -> 6e6bc4e49dd477ebc98ef4046c067b5f  (shard 6e)
printf 'hello\nworld\nciao\n' | "$BIN" --output-dir "$TMP"

# Expected shard files exist and are exactly one record (24 B).
for shard in 5d 7d 6e; do
    f="$TMP/shard_${shard}.bin"
    [ -f "$f" ] || { echo "MISSING shard $shard"; exit 1; }
    size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
    [ "$size" -eq 24 ] || { echo "BAD SIZE shard $shard: $size (want 24)"; exit 1; }
done

# Only the three expected shards should have received a record.
non_empty=$(find "$TMP" -name 'shard_*.bin' -size +0 | wc -l | tr -d ' ')
[ "$non_empty" -eq 3 ] || { echo "UNEXPECTED non-empty shard count: $non_empty (want 3)"; exit 1; }

# Decode the 'hello' record and verify byte-by-byte:
#   bytes  0..14 = MD5(hello)[1..15]   = 41402abc4b2a76b9719d911017c592
#   byte   15    = password length     = 5
#   bytes 16..20 = 'hello'
#   bytes 21..23 = zero padding
hex=$(xxd -p "$TMP/shard_5d.bin" | tr -d '\n')
expected="41402abc4b2a76b9719d911017c59205" # 15 bytes tail + len=0x05
expected+="68656c6c6f"                       # 'hello'
expected+="000000"                             # padding to 24 B
if [ "$hex" != "$expected" ]; then
    echo "RECORD MISMATCH for 'hello':"
    echo "  got:      $hex"
    echo "  expected: $expected"
    exit 1
fi

echo "OK"
