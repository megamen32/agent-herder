/* Read-only, bounded physical FTS census. Emits one numeric summary, no paths.
 * Parent pins cwd, verifies root/release generations and enforces the 5s wall
 * deadline. No symlink traversal, hard-link deduplication, signal or mutation.
 */
#include <sys/stat.h>
#include <fts.h>
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint64_t positive(const char *s) {
    if (!*s || strlen(s) > 10 || strspn(s, "0123456789") != strlen(s)) return 0;
    return strtoull(s, NULL, 10);
}

int main(int argc, char **argv) {
    if (argc != 3) return 65;
    uint64_t limit = positive(argv[1]), max_entries = positive(argv[2]);
    if (!limit || limit > 512 * UINT64_C(1024) * 1024 || !max_entries || max_entries > 30001) return 65;
    char path[] = "."; char *paths[] = {path, NULL};
    FTS *tree = fts_open(paths, FTS_PHYSICAL | FTS_NOCHDIR, NULL);
    if (!tree) return 66;
    uint64_t bytes = 0, count = 0; int failure = 0;
    for (;;) {
        errno = 0; FTSENT *entry = fts_read(tree);
        if (!entry) { if (errno) failure = 66; break; }
        if (entry->fts_info == FTS_DP) continue;
        if (entry->fts_info != FTS_D && entry->fts_info != FTS_F &&
            entry->fts_info != FTS_SL && entry->fts_info != FTS_SLNONE && entry->fts_info != FTS_DEFAULT) {
            failure = 66; break;
        }
        if (!entry->fts_statp || entry->fts_statp->st_size < 0) { failure = 66; break; }
        if (++count > max_entries) { failure = 67; break; }
        /* Conservative apparent bytes: round each entry, including dirs and
         * symlinks, upward. Count every hard-link entry as the previous du -l.
         */
        uint64_t size = (uint64_t)entry->fts_statp->st_size;
        if (size > limit || size > UINT64_MAX - 1023) { failure = 68; break; }
        size = ((size + 1023) / 1024) * 1024;
        if (size > limit - bytes) { failure = 68; break; }
        bytes += size;
    }
    if (fts_close(tree) && !failure) failure = 66;
    if (failure || !count) return failure ? failure : 66;
    printf("BYTES %" PRIu64 " ENTRIES %" PRIu64 "\n", bytes, count);
    return 0;
}
