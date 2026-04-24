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
# Sort phase parallelism is intentionally much lower than WORKERS because
# each parallel sort mmaps/qsorts a whole shard (~33 GB) in RAM. Default
# of 4 keeps peak sort RAM around 130 GB.
SORT_CONCURRENCY="${SORT_CONCURRENCY:-4}"
HASHCAT="${HASHCAT:-/app/hashcat/hashcat}"
MD5FILL="${MD5FILL:-/app/bin/md5fill_kv}"
ENUMERATE_MD5="${ENUMERATE_MD5:-/app/bin/enumerate_md5}"
SHARD_SORT="${SHARD_SORT:-/app/bin/shard_sort}"
WORDLISTS="${WORDLISTS:-/app/bruteforce.txt /app/parole_uniche.txt}"
RULES="${RULES:-/app/hashcat/rules/best64.rule}"

BUILD_DIR="${KV_DIR}/build"
MANIFEST="${KV_DIR}/manifest.json"

log()  { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die()  { log "FATAL: $*"; exit 1; }

sanity_checks() {
    [ -x "$HASHCAT" ]        || die "hashcat not executable: $HASHCAT"
    [ -x "$MD5FILL" ]        || die "md5fill_kv not executable: $MD5FILL"
    [ -x "$ENUMERATE_MD5" ]  || die "enumerate_md5 not executable: $ENUMERATE_MD5"
    [ -x "$SHARD_SORT" ]     || die "shard_sort not executable: $SHARD_SORT"
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
            --backend-ignore-cuda --backend-ignore-opencl \
            $WORDLISTS \
            | "$MD5FILL" --output-dir "$outdir"; then
        log "phase 0 FAILED (continuing with other phases)"
        return 0
    fi
    log "phase 0 done"
}

# Generic mask-phase runner using our own enumerate_md5 binary.
# We compute the keyspace for this (charset, length) directly (|charset|^length),
# split it into $WORKERS contiguous slices, and spawn one enumerate_md5 per slice.
# Full 128-way parallelism per length; no hashcat in the hot path.
#
# Args:
#   $1 phase_name  — subdir under $BUILD_DIR
#   $2 charset     — literal charset string (e.g. 'abc...xyz')
#   $3 len_min     — inclusive
#   $4 len_max     — inclusive
run_mask_phase() {
    local phase_name="$1"
    local charset="$2"
    local len_min="$3"
    local len_max="$4"

    local cs_len=${#charset}
    log "phase ${phase_name}: lengths ${len_min}..${len_max} charset_size=${cs_len}"
    local outroot="${BUILD_DIR}/${phase_name}"
    mkdir -p "$outroot"

    local len
    for ((len=len_min; len<=len_max; len++)); do
        # Keyspace for this length = cs_len^len. bash arithmetic is 64-bit;
        # our largest is 72^6 = 1.4e11, well within int64.
        local ks=1
        local j
        for ((j=0; j<len; j++)); do ks=$(( ks * cs_len )); done

        # Pick worker count: for tiny keyspaces, single worker avoids fork cost.
        local nw=$WORKERS
        if [ "$ks" -lt "$((WORKERS * 4))" ]; then nw=1; fi

        local slice=$(( (ks + nw - 1) / nw ))
        log "  len=$len keyspace=$ks nworkers=$nw slice=$slice"

        local pids=()
        local w
        for ((w=0; w<nw; w++)); do
            local skip=$(( w * slice ))
            [ "$skip" -ge "$ks" ] && break
            local limit=$slice
            [ $(( skip + limit )) -gt "$ks" ] && limit=$(( ks - skip ))
            local wdir="${outroot}/len${len}_w$(printf '%03d' "$w")"
            mkdir -p "$wdir"

            (
                nice -n 19 "$ENUMERATE_MD5" \
                    --charset "$charset" \
                    --length "$len" \
                    --skip "$skip" \
                    --limit "$limit" \
                    --output-dir "$wdir"
            ) &
            pids+=($!)
        done

        log "    spawned ${#pids[@]} workers, waiting…"
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

# Phase 1: ?l?u?d + 10 symbols = 72-char charset, length 1–6.
# Literal !, $, &, *, + etc. are safe because the argv is passed as a
# single-quoted shell argument and never `eval`'d.
phase_1() {
    run_mask_phase "phase1" \
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*+-_' \
        1 6
}

# Phase 2: lowercase only, length 7–8.
phase_2() {
    run_mask_phase "phase2" \
        'abcdefghijklmnopqrstuvwxyz' \
        7 8
}

# Phase 3: digits only, length 1–8.
phase_3() {
    run_mask_phase "phase3" \
        '0123456789' \
        1 8
}

# ----- Sort phase ----------------------------------------------------------

sort_shards() {
    log "sort phase: merging + sorting 256 shards (concurrency=$SORT_CONCURRENCY)"
    local sort_tmp="${BUILD_DIR}/sort_tmp"
    mkdir -p "$sort_tmp"

    export KV_DIR SHARD_SORT BUILD_DIR sort_tmp

    # Sort parallelism is deliberately modest: each sort mmaps/qsorts a
    # ~33 GB shard in RAM. Concurrency 4 ≈ 130 GB peak sort RAM.
    # Per-shard cleanup frees BUILD_DIR chunks progressively so peak
    # disk usage stays close to the final KV size (~8.5 TB) rather than
    # doubling. Sort is idempotent: if KV_DIR/shard_XX.bin already has
    # content (e.g. from a previous run), it is absorbed into the merge
    # before re-sorting + dedupe.
    seq 0 255 | xargs -I{} -P "$SORT_CONCURRENCY" bash -c '
        i=$0
        hex=$(printf "%02x" "$i")
        out="${KV_DIR}/shard_${hex}.bin"
        merged="${sort_tmp}/merged_${hex}.bin"

        # Start merged with existing sorted KV if present (idempotence).
        if [ -s "$out" ]; then
            cp "$out" "$merged"
        else
            : > "$merged"
        fi

        # Append every BUILD_DIR chunk for this shard.
        find "${BUILD_DIR}" -mindepth 2 -name "shard_${hex}.bin" -type f -print0 \
            | xargs -0 -r cat >> "$merged"

        if [ -s "$merged" ]; then
            "${SHARD_SORT}" --in "$merged" --out "$out"
        else
            : > "$out"
        fi

        # Free space immediately: drop merged copy and all source chunks
        # for this shard. Do not touch sibling shard files.
        rm -f "$merged"
        find "${BUILD_DIR}" -mindepth 2 -name "shard_${hex}.bin" -type f -delete
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
