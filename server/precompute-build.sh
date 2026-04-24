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
    if ! "$HASHCAT" --stdout -a 0 -r "$RULES" $WORDLISTS \
            | "$MD5FILL" --output-dir "$outdir"; then
        log "phase 0 FAILED (continuing with other phases)"
        return 0
    fi
    log "phase 0 done"
}

# Generic mask-phase runner. Splits the keyspace across $WORKERS workers.
run_mask_phase() {
    local phase_name="$1"
    local charset_arg="$2"    # e.g. '-1 ?l?u?d!@#$%&*+-_'
    local mask="$3"           # e.g. ?1?1?1?1?1?1 (paired with -i for length ranges)
    local incr_min="$4"       # "" if no -i, else numeric
    local incr_max="$5"       # "" if no -i, else numeric

    log "phase ${phase_name}: mask='${mask}' charset_arg=\"${charset_arg}\""
    local outroot="${BUILD_DIR}/${phase_name}"
    mkdir -p "$outroot"

    # Total keyspace reported by hashcat.
    # shellcheck disable=SC2086
    local ks
    ks=$("$HASHCAT" --keyspace -a 3 $charset_arg "$mask") \
        || die "hashcat --keyspace failed"
    log "  keyspace=$ks"

    local slice=$(( (ks + WORKERS - 1) / WORKERS ))
    local pids=()
    for ((w=0; w<WORKERS; w++)); do
        local skip=$(( w * slice ))
        if [ "$skip" -ge "$ks" ]; then break; fi
        local limit=$(( slice ))
        if [ $(( skip + limit )) -gt "$ks" ]; then
            limit=$(( ks - skip ))
        fi
        local wdir="${outroot}/worker_$(printf '%03d' "$w")"
        mkdir -p "$wdir"

        local -a inc_args=()
        if [ -n "$incr_min" ] && [ -n "$incr_max" ]; then
            inc_args=(-i --increment-min "$incr_min" --increment-max "$incr_max")
        fi

        # shellcheck disable=SC2086
        (
            nice -n 19 "$HASHCAT" --stdout -a 3 $charset_arg \
                "${inc_args[@]}" -s "$skip" -l "$limit" "$mask" \
            | nice -n 19 "$MD5FILL" --output-dir "$wdir"
        ) &
        pids+=($!)
    done

    log "  spawned ${#pids[@]} workers, waiting…"
    local fail=0
    for pid in "${pids[@]}"; do
        if ! wait "$pid"; then fail=1; fi
    done
    [ "$fail" -eq 0 ] || die "one or more workers failed in ${phase_name}"
    log "phase ${phase_name} done"
}

# Phase 1: ?l?u?d + 10 symbols, length 1–6.
phase_1() {
    run_mask_phase "phase1" \
        "-1 ?l?u?d!@#\$%&*+-_" \
        "?1?1?1?1?1?1" \
        "1" "6"
}

# Phase 2: lowercase only, length 7–8.
phase_2() {
    run_mask_phase "phase2" \
        "" \
        "?l?l?l?l?l?l?l?l" \
        "7" "8"
}

# Phase 3: digits only, length 1–8.
phase_3() {
    run_mask_phase "phase3" \
        "" \
        "?d?d?d?d?d?d?d?d" \
        "1" "8"
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
