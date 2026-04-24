/*
 * enumerate_md5 — enumerate a keyspace slice, MD5 each candidate, and
 * write 24-byte sharded records. Replaces `hashcat --stdout | md5fill_kv`
 * for the mask phases of precompute-build.sh.
 *
 *   usage: enumerate_md5 --charset STR --length N --skip S --limit L
 *                        --output-dir DIR
 *
 * Indexing: candidate i (0-based) over charset of size K, length N, is
 *   decoded as base-K digits little-endian-per-position, left-padded:
 *       pw[N-1] = charset[i % K];   i /= K
 *       pw[N-2] = charset[i % K];   i /= K
 *       ...
 *   So the sequence with charset "abc" length 2 is "aa","ab","ac","ba",...
 *   Identical ordering to hashcat -a 3 with a single-char custom charset.
 *
 * Record layout (24 B, matches md5fill_kv / shard_sort / kvLookup):
 *   [ 0..14] = MD5 bytes 1..15       (15 B — byte 0 is shard index)
 *   [    15] = password length       (1..8)
 *   [16..23] = password, null-padded to 8 B
 *
 * Writes are batched per shard (SHARD_BUF bytes) to reduce syscalls, and
 * flushed on exit. Each worker gets its own --output-dir (caller-managed),
 * so shard fds are never shared across processes and per-write atomicity
 * isn't required.
 */
#include <errno.h>
#include <fcntl.h>
#include <openssl/md5.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define MAX_PW       8
#define RECORD_SIZE  24
#define N_SHARDS     256
#define SHARD_BUF    (24 * 341)    /* 8184 B — close to 8 KB, record-aligned */

struct shard_state {
    int fd;
    size_t used;
    unsigned char buf[SHARD_BUF];
};

static struct shard_state shards[N_SHARDS];

static void open_shards(const char *dir)
{
    char path[4096];
    if (mkdir(dir, 0755) == -1 && errno != EEXIST) {
        fprintf(stderr, "mkdir %s: %s\n", dir, strerror(errno));
        exit(1);
    }
    for (int i = 0; i < N_SHARDS; i++) {
        snprintf(path, sizeof path, "%s/shard_%02x.bin", dir, i);
        int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0644);
        if (fd < 0) {
            fprintf(stderr, "open %s: %s\n", path, strerror(errno));
            exit(1);
        }
        shards[i].fd = fd;
        shards[i].used = 0;
    }
}

static void flush_shard(struct shard_state *sh)
{
    size_t off = 0;
    while (off < sh->used) {
        ssize_t n = write(sh->fd, sh->buf + off, sh->used - off);
        if (n <= 0) {
            fprintf(stderr, "write: %s\n", strerror(errno));
            exit(1);
        }
        off += (size_t)n;
    }
    sh->used = 0;
}

static void flush_all(void)
{
    for (int i = 0; i < N_SHARDS; i++) {
        if (shards[i].used > 0) flush_shard(&shards[i]);
    }
}

static void append_record(const unsigned char md5[16],
                          const char *pw, size_t pw_len)
{
    struct shard_state *sh = &shards[md5[0]];
    if (sh->used + RECORD_SIZE > SHARD_BUF) flush_shard(sh);
    unsigned char *p = sh->buf + sh->used;
    memcpy(p, md5 + 1, 15);
    p[15] = (unsigned char)pw_len;
    memset(p + 16, 0, 8);
    memcpy(p + 16, pw, pw_len);
    sh->used += RECORD_SIZE;
}

int main(int argc, char **argv)
{
    const char *charset = NULL;
    int length = 0;
    uint64_t skip = 0;
    uint64_t limit = 0;
    int limit_set = 0;
    const char *outdir = NULL;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--charset") && i + 1 < argc) {
            charset = argv[++i];
        } else if (!strcmp(argv[i], "--length") && i + 1 < argc) {
            length = atoi(argv[++i]);
        } else if (!strcmp(argv[i], "--skip") && i + 1 < argc) {
            skip = strtoull(argv[++i], NULL, 10);
        } else if (!strcmp(argv[i], "--limit") && i + 1 < argc) {
            limit = strtoull(argv[++i], NULL, 10);
            limit_set = 1;
        } else if (!strcmp(argv[i], "--output-dir") && i + 1 < argc) {
            outdir = argv[++i];
        } else {
            fprintf(stderr, "usage: %s --charset STR --length N "
                            "--skip S --limit L --output-dir DIR\n", argv[0]);
            return 2;
        }
    }
    if (!charset || !length || !outdir || !limit_set) {
        fprintf(stderr, "missing required arg\n");
        return 2;
    }
    if (length < 1 || length > MAX_PW) {
        fprintf(stderr, "length %d out of range [1..%d]\n", length, MAX_PW);
        return 2;
    }
    size_t cs_len = strlen(charset);
    if (cs_len == 0 || cs_len > 255) {
        fprintf(stderr, "charset size %zu out of range [1..255]\n", cs_len);
        return 2;
    }

    /* total keyspace = cs_len ^ length */
    uint64_t total = 1;
    for (int i = 0; i < length; i++) {
        if (total > UINT64_MAX / (uint64_t)cs_len) {
            fprintf(stderr, "keyspace overflow (cs_len=%zu length=%d)\n",
                    cs_len, length);
            return 2;
        }
        total *= (uint64_t)cs_len;
    }

    uint64_t end;
    if (skip >= total) return 0;
    if (limit > total - skip) end = total;
    else end = skip + limit;

    open_shards(outdir);

    char pw[MAX_PW];
    unsigned char md5[16];
    for (uint64_t idx = skip; idx < end; idx++) {
        uint64_t x = idx;
        for (int i = length - 1; i >= 0; i--) {
            pw[i] = charset[x % cs_len];
            x /= (uint64_t)cs_len;
        }
        MD5((const unsigned char *)pw, (size_t)length, md5);
        append_record(md5, pw, (size_t)length);
    }
    flush_all();
    return 0;
}
