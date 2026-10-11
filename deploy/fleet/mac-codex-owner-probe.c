/* Read-only libproc observer. Compile against the target Mac's SDK headers.
 * No native RPC, signal, socket connect, filesystem mutation or fallback.
 */
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

static int number(const char *s, int minimum) {
    char *end; long n = strtol(s, &end, 10);
    return *s && !*end && n >= minimum && n <= INT_MAX ? (int)n : -1;
}

static int listener(int pid, int fd, const char *path, uint64_t *handle) {
    struct socket_fdinfo info;
    memset(&info, 0, sizeof(info));
    if (proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, &info, sizeof(info)) != (int)sizeof(info)) return -1;
    const struct socket_info *s = &info.psi;
    if (s->soi_family != AF_UNIX || s->soi_kind != SOCKINFO_UN ||
        s->soi_type != SOCK_STREAM || !(s->soi_options & SO_ACCEPTCONN)) return 0;
    const struct sockaddr_un *address = &s->soi_proto.pri_un.unsi_addr.ua_sun;
    size_t header = offsetof(struct sockaddr_un, sun_path);
    if (address->sun_family != AF_UNIX || address->sun_len < header || address->sun_len > sizeof(*address)) return -1;
    size_t capacity = address->sun_len - header;
    size_t length = strnlen(address->sun_path, capacity);
    *handle = (uint64_t)s->soi_so;
    return length == strlen(path) && !memcmp(address->sun_path, path, length);
}

int main(int argc, char **argv) {
    if (argc < 4) return 65;
    int pid = number(argv[2], 2);
    if (pid < 0) return 65;
    if (!strcmp(argv[1], "--text") && argc == 4) {
        char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
        int bytes = proc_pidpath(pid, path, sizeof(path));
        if (bytes <= 0 || !memchr(path, 0, sizeof(path)) || strcmp(path, argv[3])) return 66;
        puts("OWNED"); return 0;
    }
    if (strcmp(argv[1], "--socket") || (argc != 4 && argc != 5) || argv[3][0] != '/') return 65;
    if (argc == 5) {
        int fd = number(argv[4], 0);
        uint64_t handle;
        if (fd < 0 || listener(pid, fd, argv[3], &handle) != 1) return 66;
        printf("FD %d\n", fd); return 0;
    }
    /* Admission pins a hint, never a cached pass. Every subsequent check reads
     * that FD anew; closure, reuse, wrong path or loss of listen state refuses.
     */
    struct proc_fdinfo fds[4096];
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, sizeof(fds));
    if (bytes <= 0 || bytes >= (int)sizeof(fds) || bytes % sizeof(fds[0])) return 66;
    int owner = -1; uint64_t owner_handle = 0;
    for (size_t i = 0; i < (size_t)bytes / sizeof(fds[0]); i++) {
        if (fds[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
        uint64_t handle;
        int match = listener(pid, fds[i].proc_fd, argv[3], &handle);
        if (match < 0) return 66;
        if (match) {
            if (owner >= 0 && handle != owner_handle) return 66;
            owner_handle = handle;
            if (owner < 0) owner = fds[i].proc_fd;
        }
    }
    if (owner < 0) return 66;
    printf("FD %d\n", owner); return 0;
}
