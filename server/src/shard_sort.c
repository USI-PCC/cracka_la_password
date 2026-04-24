/*
 * shard_sort — sort a shard file in memory.
 *   - reads --in file (must be a multiple of 24 bytes)
 *   - sorts 24-byte records by the first 15 bytes ascending (memcmp)
 *   - drops adjacent duplicates (by full 24 B record)
 *   - writes result to --out
 *
 * Peak RAM usage ≈ input size. For our shards that's ~13 GB per shard,
 * comfortably within the 128-core host's RAM budget.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define RECORD_SIZE 24
#define KEY_SIZE 15

static int cmp_rec(const void *a, const void *b)
{
    return memcmp(a, b, KEY_SIZE);
}

int main(int argc, char **argv)
{
    const char *in_path = NULL;
    const char *out_path = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--in") == 0 && i + 1 < argc) in_path = argv[++i];
        else if (strcmp(argv[i], "--out") == 0 && i + 1 < argc) out_path = argv[++i];
        else {
            fprintf(stderr, "usage: %s --in <file> --out <file>\n", argv[0]);
            return 2;
        }
    }
    if (!in_path || !out_path) {
        fprintf(stderr, "usage: %s --in <file> --out <file>\n", argv[0]);
        return 2;
    }

    int in_fd = open(in_path, O_RDONLY);
    if (in_fd < 0) { perror(in_path); return 1; }

    struct stat st;
    if (fstat(in_fd, &st) < 0) { perror("fstat"); close(in_fd); return 1; }
    off_t size = st.st_size;
    if (size == 0) {
        /* Empty input -> empty output. */
        int out_fd = open(out_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (out_fd < 0) { perror(out_path); close(in_fd); return 1; }
        close(out_fd);
        close(in_fd);
        return 0;
    }
    if (size % RECORD_SIZE != 0) {
        fprintf(stderr, "input size %lld not a multiple of %d\n",
                (long long)size, RECORD_SIZE);
        close(in_fd);
        return 1;
    }
    size_t n = (size_t)(size / RECORD_SIZE);

    unsigned char *buf = malloc((size_t)size);
    if (!buf) { perror("malloc"); close(in_fd); return 1; }

    ssize_t got = 0;
    while (got < size) {
        ssize_t r = read(in_fd, buf + got, (size_t)(size - got));
        if (r < 0) { perror("read"); free(buf); close(in_fd); return 1; }
        if (r == 0) {
            fprintf(stderr, "unexpected EOF at %zd / %lld\n",
                    got, (long long)size);
            free(buf); close(in_fd); return 1;
        }
        got += r;
    }
    close(in_fd);

    qsort(buf, n, RECORD_SIZE, cmp_rec);

    /* Dedupe adjacent identical records (full 24-byte equality). */
    size_t w = 0;
    for (size_t r = 0; r < n; r++) {
        if (w == 0 || memcmp(buf + (w - 1) * RECORD_SIZE,
                             buf + r * RECORD_SIZE,
                             RECORD_SIZE) != 0) {
            if (w != r) memcpy(buf + w * RECORD_SIZE,
                               buf + r * RECORD_SIZE,
                               RECORD_SIZE);
            w++;
        }
    }
    size_t out_bytes = w * RECORD_SIZE;

    int out_fd = open(out_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (out_fd < 0) { perror(out_path); free(buf); return 1; }
    size_t wrote = 0;
    while (wrote < out_bytes) {
        ssize_t x = write(out_fd, buf + wrote, out_bytes - wrote);
        if (x <= 0) { perror("write"); free(buf); close(out_fd); return 1; }
        wrote += (size_t)x;
    }
    close(out_fd);
    free(buf);

    fprintf(stderr, "shard_sort: %zu -> %zu records\n", n, w);
    return 0;
}
