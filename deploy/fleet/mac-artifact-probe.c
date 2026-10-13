/* Read-only bounded census. Emits numeric summaries, no paths.
 * Artifact mode retains physical FTS; mutable mode uses fd-relative/no-follow
 * traversal. Parent pins cwd, verifies root generations and enforces its wall.
 * No symlink traversal, hard-link deduplication, signal or mutation.
 */
#include <sys/stat.h>
#include <dirent.h>
#include <fcntl.h>
#include <fts.h>
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static int decimal(const char *s, uint64_t *out) {
    if (!*s || strlen(s) > 20 || strspn(s, "0123456789") != strlen(s)) return 0;
    errno = 0; *out = strtoull(s, NULL, 10);
    return errno != ERANGE;
}

static double now(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value)) return -1;
    return (double)value.tv_sec + (double)value.tv_nsec / 1000000000.0;
}

static int identity(const struct stat *a, const struct stat *b) {
    return a->st_uid == b->st_uid && a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}

static int mutable(int argc, char **argv) {
    uint64_t limit, maximum, uid, dev, ino;
    if (argc != 7 || !decimal(argv[2], &limit) || !decimal(argv[3], &maximum) ||
        !decimal(argv[4], &uid) || !decimal(argv[5], &dev) || !decimal(argv[6], &ino) ||
        !limit || limit > 512 * UINT64_C(1024) * 1024 || !maximum || maximum > 30000)
        return 65;
    struct stat initial;
    if (lstat(".", &initial) || !S_ISDIR(initial.st_mode) || initial.st_uid != getuid() ||
        (uint64_t)initial.st_uid != uid || (uint64_t)initial.st_dev != dev ||
        (uint64_t)initial.st_ino != ino) return 69;
    double start = now();
    if (start < 0) return 71;
    double overall = start + 2.0;
    for (int attempt = 0; attempt < 2; ++attempt) {
        double began = now();
        if (began < 0) return 71;
        if (began >= overall) return 70;
        double deadline = began + 1.0;
        if (deadline > overall) deadline = overall;
        struct stat current;
        if (lstat(".", &current) || !identity(&initial, &current)) return 69;
        int root = open(".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        if (root < 0) return 71;
        if (fstat(root, &current) || !identity(&initial, &current)) { close(root); return 69; }
        DIR *stack[256]; size_t depth = 0;
        DIR *directory = fdopendir(root);
        if (!directory) { close(root); return 71; }
        stack[depth++] = directory;
        uint64_t bytes = 0, count = 0; int failure = 0;
        while (depth) {
            double tick = now();
            if (tick < 0) { failure = 71; break; }
            if (tick >= deadline) { failure = 70; break; }
            errno = 0; struct dirent *entry = readdir(stack[depth - 1]);
            if (!entry) {
                if (errno) { failure = 71; break; }
                if (closedir(stack[--depth])) { failure = 71; break; }
                continue;
            }
            if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
            if (++count > maximum) { failure = 67; break; }
            int parent = dirfd(stack[depth - 1]); struct stat info;
            if (fstatat(parent, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) || info.st_size < 0) {
                failure = 71; break;
            }
            if (S_ISDIR(info.st_mode)) {
                if (depth == 256) { failure = 71; break; }
                int child = openat(parent, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
                if (child < 0) { failure = 71; break; }
                struct stat opened;
                if (fstat(child, &opened) || !identity(&info, &opened)) {
                    close(child); failure = 69; break;
                }
                directory = fdopendir(child);
                if (!directory) { close(child); failure = 71; break; }
                stack[depth++] = directory;
            } else {
                uint64_t size = (uint64_t)info.st_size;
                if (size > limit - bytes) { failure = 68; break; }
                bytes += size;
            }
        }
        while (depth) if (closedir(stack[--depth])) failure = 71;
        if (lstat(".", &current) || !identity(&initial, &current)) return 69;
        double ended = now();
        if (ended < 0) return 71;
        if (!failure && ended >= deadline) failure = 70;
        if (!failure) { printf("BYTES %" PRIu64 "\n", bytes); return 0; }
        if (failure != 70 || attempt == 1 || ended >= overall) return failure;
        /* Fresh complete census only after a deadline; discard partial bytes
         * and descriptors. Hard file/byte limits never retry. */
    }
    return 70;
}

static uint64_t positive(const char *s) {
    if (!*s || strlen(s) > 10 || strspn(s, "0123456789") != strlen(s)) return 0;
    return strtoull(s, NULL, 10);
}

int main(int argc, char **argv) {
    if (argc > 1 && !strcmp(argv[1], "--mutable")) return mutable(argc, argv);
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
