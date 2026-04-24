#!/usr/bin/env bash
# precompute-build.sh — build the sharded KV cache under $KV_DIR.
#
# Intended to run inside the cracka container (where /app/hashcat/hashcat
# and /app/bin/{md5fill_kv,shard_sort} live), with the host's /scratch
# bind-mounted at the same path. Invoke from the host:
#
#   docker compose exec cracka bash /app/precompute-build.sh
#
# Environment overrides:
#   KV_DIR        default /scratch/cracka_kv
#   WORKERS       default 128
#   PHASES        default "0 1 2 3"   (space-separated phase indexes)
#   HASHCAT       default /app/hashcat/hashcat
#   MD5FILL       default /app/bin/md5fill_kv
#   SHARD_SORT    default /app/bin/shard_sort
#   WORDLISTS     default "/app/bruteforce.txt /app/parole_uniche.txt"
#   RULES         default /app/hashcat/rules/best64.rule
set -euo pipefail

KV_DIR="${KV_DIR:-/scratch/cracka_kv}"
WORKERS="${WORKERS:-128}"
PHASES="${PHASES:-0 1 2 3}"
HASHCAT="${HASHCAT:-/app/hashcat/hashcat}"
MD5FILL="${MD5FILL:-/app/bin/md5fill_kv}"
SHARD_SORT="${SHARD_SORT:-/app/bin/shard_sort}"
WORDLISTS="${WORDLISTS:-/app/bruteforce.txt /app/parole_uniche.txt}"
RULES="${RULES:-/app/hashcat/rules/best64.rule}"

BUILD_DIR="${KV_DIR}/build"
MANIFEST="${KV_DIR}/manifest.json"

log()  { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die()  { log "FATAL: $*"; exit 1; }

sanity_checks() {
    [ -x "$HASHCAT" ]    || die "hashcat not executable: $HASHCAT"
    [ -x "$MD5FILL" ]    || die "md5fill_kv not executable: $MD5FILL"
    [ -x "$SHARD_SORT" ] || die "shard_sort not executable: $SHARD_SORT"
    mkdir -p "$KV_DIR" "$BUILD_DIR"
    log "KV_DIR=$KV_DIR WORKERS=$WORKERS PHASES=\"$PHASES\""
}

# ----- Phase runners -------------------------------------------------------

# Phase 0: wordlist + rules. Single-threaded (throughput is tiny anyway).
# Best-effort: missing rule file or wordlist is logged but not fatal, since
# phases 1–3 are the real bulk and we don't want to forfeit them on a
# path typo.
phase_0() {
    log "phase 0: wordlist + rules"
    if [ ! -f "$RULES" ]; then
        log "phase 0 SKIPPED: rules file not found: $RULES"
        return 0
    fi
    local outdir="${BUILD_DIR}/phase0"
    mkdir -p "$outdir"
    # shellcheck disable=SC2086
    if ! "$HASHCAT" --stdout -a 0 -r "$RULES" \
            --backend-ignore-cuda --backend-ignore-hip \
            --backend-ignore-metal --backend-ignore-opencl \
            $WORDLISTS \
            | "$MD5FILL" --output-dir "$outdir"; then
        log "phase 0 FAILED (continuing with other phases)"
        return 0
    fi
    log "phase 0 done"
}

# Generic mask-phase runner. Hashcat v7 refuses --skip/--limit together
# with --stdout, so we can't slice keyspace that way. Instead we fix the
# FIRST CHARACTER of the mask per worker: workers run in parallel, each
# covering one starting letter. This gives us N parallel workers per
# length, where N = |first_chars|.
#
# Args:
#   $1 phase_name    — subdir under $BUILD_DIR
#   $2 charset_arg   — the -1/-2/-3/-4 custom charset declaration (may be empty)
#   $3 len_min       — inclusive
#   $4 len_max       — inclusive
#   $5 first_chars   — string of characters used as the fixed first position
#   $6 mask_token    — mask token for remaining positions ("?1", "?l", "?d")
run_mask_phase() {
    local phase_name="$1"
    local charset_arg="$2"
    local len_min="$3"
    local len_max="$4"
    local first_chars="$5"
    local mask_token="$6"

    log "phase ${phase_name}: lengths ${len_min}..${len_max} (|first_chars|=${#first_chars})"
    local outroot="${BUILD_DIR}/${phase_name}"
    mkdir -p "$outroot"

    local nchars=${#first_chars}
    local len
    for ((len=len_min; len<=len_max; len++)); do
        local suffix=""
        local j
        for ((j=1; j<len; j++)); do suffix="${suffix}${mask_token}"; done

        local pids=()
        local i
        for ((i=0; i<nchars; i++)); do
            local c="${first_chars:$i:1}"
            local mask="${c}${suffix}"
            local wdir="${outroot}/len${len}_slot$(printf '%03d' "$i")"
            mkdir -p "$wdir"
            local sess="pre_${phase_name}_l${len}_s${i}_$$"

            # shellcheck disable=SC2086
            # --stdout doesn't need a GPU backend — disable CUDA/HIP/Metal/
            # OpenCL init explicitly, otherwise 72 parallel hashcats each
            # try to allocate CUDA contexts on the Blackwells and OOM.
            (
                nice -n 19 "$HASHCAT" --stdout -a 3 $charset_arg \
                    --backend-ignore-cuda --backend-ignore-hip \
                    --backend-ignore-metal --backend-ignore-opencl \
                    --session "$sess" "$mask" \
                | nice -n 19 "$MD5FILL" --output-dir "$wdir"
            ) &
            pids+=($!)
        done

        log "  len=$len: spawned ${#pids[@]} workers, waiting…"
        local fail=0
        local pid
        for pid in "${pids[@]}"; do
            if ! wait "$pid"; then fail=1; fi
        done
        [ "$fail" -eq 0 ] || die "worker(s) failed in ${phase_name} len=$len"
        log "  len=$len done"
    done

    log "phase ${phase_name} done"
}

# Phase 1: ?l?u?d + 10 symbols = 72-char custom charset, length 1–6.
# first_chars enumerates all 72 alphabet members as the fixed first
# position. Literal shell specials (!, $, &, *) are safe because the
# string is single-quoted and never `eval`'d.
phase_1() {
    local chars='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*+-_'
    run_mask_phase "phase1" \
        '-1 ?l?u?d!@#$%&*+-_' \
        1 6 \
        "$chars" \
        "?1"
}

# Phase 2: lowercase only, length 7–8. 26 parallel workers per length.
phase_2() {
    run_mask_phase "phase2" \
        "" \
        7 8 \
        'abcdefghijklmnopqrstuvwxyz' \
        "?l"
}

# Phase 3: digits only, length 1–8. 10 parallel workers per length.
phase_3() {
    run_mask_phase "phase3" \
        "" \
        1 8 \
        '0123456789' \
        "?d"
}

# ----- Sort phase ----------------------------------------------------------

sort_shards() {
    log "sort phase: merging + sorting 256 shards"
    local sort_tmp="${BUILD_DIR}/sort_tmp"
    mkdir -p "$sort_tmp"

    export KV_DIR SHARD_SORT BUILD_DIR sort_tmp

    # Parallelize: xargs -P spawns up to $WORKERS concurrent shard sorts.
    seq 0 255 | xargs -I{} -P "$WORKERS" bash -c '
        i=$0
        hex=$(printf "%02x" "$i")
        out="${KV_DIR}/shard_${hex}.bin"
        merged="${sort_tmp}/merged_${hex}.bin"
        : > "$merged"
        find "${BUILD_DIR}" -name "shard_${hex}.bin" -type f -print0 \
            | xargs -0 -r cat >> "$merged"
        if [ -s "$merged" ]; then
            "${SHARD_SORT}" --in "$merged" --out "$out"
        else
            : > "$out"
        fi
        rm -f "$merged"
    ' {}

    rm -rf "$sort_tmp"
    log "sort phase done"
}

# ----- Manifest ------------------------------------------------------------

write_manifest() {
    log "writing manifest"
    local total=0
    for ((i=0; i<256; i++)); do
        local hex
        hex=$(printf '%02x' "$i")
        local f="${KV_DIR}/shard_${hex}.bin"
        local sz
        sz=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
        [ $((sz % 24)) -eq 0 ] || die "shard $hex not aligned: $sz"
        total=$((total + sz / 24))
    done
    cat > "$MANIFEST" <<JSON
{
  "built_at": "$(date -u +%FT%TZ)",
  "schema_version": 1,
  "shard_count": 256,
  "record_size": 24,
  "total_entries": ${total},
  "phases_run": "${PHASES}",
  "complete": true
}
JSON
    log "manifest written: total_entries=${total}"
}

# ----- Main ----------------------------------------------------------------

sanity_checks
for p in $PHASES; do
    case "$p" in
        0) phase_0 ;;
        1) phase_1 ;;
        2) phase_2 ;;
        3) phase_3 ;;
        *) die "unknown phase: $p" ;;
    esac
done
sort_shards
write_manifest
log "ALL DONE"
