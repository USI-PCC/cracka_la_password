/*
 * md5fill_kv — read newline-separated password candidates from stdin,
 * compute MD5, and append a 24-byte record to the correct shard file
 * under the --output-dir directory.
 *
 * Record layout (24 B, fixed):
 *   [ 0..14] = MD5 bytes 1..15      (15 B — byte 0 is the shard index)
 *   [    15] = password length      (1 B, range 1..8)
 *   [16..23] = password, null-padded to 8 B
 *
 * Candidates longer than 8 bytes are silently skipped (see design §4.2).
 * Candidates of length 0 are skipped (defensive; hashcat --stdout should
 * never emit empty lines).
 *
 * Shard fds are opened with O_APPEND so multiple md5fill_kv processes
 * pointed at the same output-dir can run concurrently without corruption:
 * POSIX guarantees atomicity for writes <= PIPE_BUF (4096 B), and our
 * records are 24 B.
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

#define MAX_PW 8
#define RECORD_SIZE 24
#define N_SHARDS 256
#define LINE_BUF 256

static int shard_fds[N_SHARDS];

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
        shard_fds[i] = fd;
    }
}

static void write_record(const unsigned char md5[16],
                         const char *pw, size_t pw_len)
{
    unsigned char rec[RECORD_SIZE];
    memcpy(rec, md5 + 1, 15);          /* hash tail, 15 B */
    rec[15] = (unsigned char)pw_len;   /* length byte */
    memset(rec + 16, 0, 8);            /* zero padding */
    memcpy(rec + 16, pw, pw_len);      /* password bytes */

    int fd = shard_fds[md5[0]];
    ssize_t n = write(fd, rec, RECORD_SIZE);
    if (n != RECORD_SIZE) {
        fprintf(stderr, "write shard %02x: %s (n=%zd)\n",
                md5[0], strerror(errno), n);
        exit(1);
    }
}

int main(int argc, char **argv)
{
    const char *outdir = NULL;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--output-dir") == 0 && i + 1 < argc) {
            outdir = argv[++i];
        } else {
            fprintf(stderr, "usage: %s --output-dir <path>\n", argv[0]);
            return 2;
        }
    }
    if (!outdir) {
        fprintf(stderr, "usage: %s --output-dir <path>\n", argv[0]);
        return 2;
    }

    open_shards(outdir);

    /* Line-oriented input. hashcat --stdout emits one candidate per line. */
    char line[LINE_BUF];
    while (fgets(line, sizeof line, stdin)) {
        size_t len = strlen(line);
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) {
            line[--len] = '\0';
        }
        if (len == 0 || len > MAX_PW) continue;

        unsigned char md5[16];
        MD5((const unsigned char *)line, len, md5);
        write_record(md5, line, len);
    }

    /* fd close on exit is sufficient; kernel flushes O_APPEND buffers. */
    return 0;
}
