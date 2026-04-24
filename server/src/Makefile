CC      ?= gcc
CFLAGS  ?= -O2 -Wall -Wextra
LDLIBS  ?= -lcrypto

BINS = md5fill_kv shard_sort

.PHONY: all clean
all: $(BINS)

md5fill_kv: md5fill_kv.c
	$(CC) $(CFLAGS) -o $@ $< $(LDLIBS)

shard_sort: shard_sort.c
	$(CC) $(CFLAGS) -o $@ $<

clean:
	rm -f $(BINS)
