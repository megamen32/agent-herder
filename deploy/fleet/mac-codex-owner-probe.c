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
#include <unistd.h>
#include <time.h>
#include <ctype.h>
#if defined(__APPLE__) || defined(HERDER_DARWIN_FIXTURE)
#include <sys/sysctl.h>
#include <mach/mach_time.h>
#endif

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

#if defined(__APPLE__) || defined(HERDER_DARWIN_FIXTURE)
static int compare_pid(const void *a,const void *b) {
    int left=*(const int*)a,right=*(const int*)b;
    return (left>right)-(left<right);
}
static int group_pids(int pgid,int *pids) {
    int bytes=proc_listpids(PROC_PGRP_ONLY,(uint32_t)pgid,pids,17*(int)sizeof(int));
    if (bytes<0 || bytes>=17*(int)sizeof(int) || bytes%(int)sizeof(int)) return -1;
    int count=bytes/(int)sizeof(int);
    qsort(pids,(size_t)count,sizeof(int),compare_pid);
    for (int i=0;i<count;i++) if (pids[i]<=1 || (i && pids[i]==pids[i-1])) return -1;
    return count;
}
static int group_snapshot(int pgid) {
    int pids[17],after_pids[17],count=group_pids(pgid,pids);
    struct proc_bsdinfo bsd[16],after;
    struct proc_taskinfo task[16];
    mach_timebase_info_data_t scale;
    if (count<0 || mach_timebase_info(&scale) || !scale.numer || !scale.denom) return 0;
    for (int i=0;i<count;i++) {
        /* arg=1 includes zombies for BSD metadata only. A live task-info
         * failure is never silently treated as a zero-cost zombie.
         */
        if (proc_pidinfo(pids[i],PROC_PIDTBSDINFO,1,&bsd[i],sizeof(bsd[i]))!=(int)sizeof(bsd[i]) ||
            bsd[i].pbi_pid!=(uint32_t)pids[i] || bsd[i].pbi_pgid!=(uint32_t)pgid || bsd[i].pbi_uid!=getuid() ||
            bsd[i].pbi_status<1 || bsd[i].pbi_status>5 || bsd[i].pbi_start_tvusec>=1000000) return 0;
        memset(&task[i],0,sizeof(task[i]));
        if (bsd[i].pbi_status!=5 &&
            (proc_pidinfo(pids[i],PROC_PIDTASKINFO,0,&task[i],sizeof(task[i]))!=(int)sizeof(task[i]) || task[i].pti_threadnum<=0)) return 0;
        if (UINT64_MAX-task[i].pti_total_user<task[i].pti_total_system) return 0;
    }
    if (group_pids(pgid,after_pids)!=count || memcmp(pids,after_pids,(size_t)count*sizeof(int))) return 0;
    for (int i=0;i<count;i++) {
        if (proc_pidinfo(pids[i],PROC_PIDTBSDINFO,1,&after,sizeof(after))!=(int)sizeof(after) ||
            after.pbi_pid!=bsd[i].pbi_pid || after.pbi_pgid!=bsd[i].pbi_pgid || after.pbi_uid!=bsd[i].pbi_uid ||
            after.pbi_start_tvsec!=bsd[i].pbi_start_tvsec || after.pbi_start_tvusec!=bsd[i].pbi_start_tvusec ||
            (after.pbi_status==5)!=(bsd[i].pbi_status==5)) return 0;
    }
    /* Emit only a complete, same-group numeric frame after all fences pass. */
    printf("GROUP %d %u %u\n",count,scale.numer,scale.denom);
    for (int i=0;i<count;i++) printf("PROC %d %u %u %llu %llu %d %u %llu %llu\n",
        pids[i],bsd[i].pbi_uid,bsd[i].pbi_pgid,(unsigned long long)task[i].pti_resident_size,
        (unsigned long long)(task[i].pti_total_user+task[i].pti_total_system),task[i].pti_threadnum,
        bsd[i].pbi_status,(unsigned long long)bsd[i].pbi_start_tvsec,(unsigned long long)bsd[i].pbi_start_tvusec);
    return 1;
}
static int same_words(const char *a, const char *b) {
    while (*a || *b) {
        while (isspace((unsigned char)*a)) a++;
        while (isspace((unsigned char)*b)) b++;
        if (!*a || !*b) return !*a && !*b;
        while (*a && !isspace((unsigned char)*a)) {
            if (*a++ != *b++) return 0;
        }
        if (*b && !isspace((unsigned char)*b)) return 0;
    }
    return 1;
}
static int identity(int pid, const char *started, const char *socket_path, uint64_t *sec, uint64_t *usec) {
    struct proc_bsdinfo before, after;
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &before, sizeof(before)) != (int)sizeof(before) || before.pbi_uid != getuid()) return 0;
    time_t seconds = (time_t)before.pbi_start_tvsec; struct tm local; char rendered[64];
    if (!localtime_r(&seconds, &local) || !strftime(rendered, sizeof(rendered), "%a %b %e %T %Y", &local) || !same_words(started, rendered)) return 0;
    /* PROCARGS2 includes argv followed by env. Interpret only argc argument
     * strings; never inspect, print or persist the environment portion.
     */
    int mib[] = {CTL_KERN, KERN_PROCARGS2, pid}; char data[8192]; size_t required = 0;
    /* XNU may successfully return a truncated stack tail when the supplied
     * buffer is too small. Obtain the full size first; never parse that tail
     * as argv. A capacity-sized copy also refuses a growth race.
     */
    if (sysctl(mib, 3, NULL, &required, NULL, 0) || required < sizeof(int) || required > sizeof(data)) return 0;
    size_t bytes = sizeof(data);
    if (sysctl(mib, 3, data, &bytes, NULL, 0) || bytes < sizeof(int) || bytes >= sizeof(data)) return 0;
    int argc; memcpy(&argc, data, sizeof(argc)); if (argc < 2 || argc > 128) return 0;
    char *cursor = data + sizeof(argc), *end = data + bytes, *args[128];
    char *zero = memchr(cursor, 0, (size_t)(end-cursor)); if (!zero) return 0;
    cursor = zero+1; while (cursor<end && !*cursor) cursor++;
    for (int i=0;i<argc;i++) {
        if (cursor>=end || !(zero=memchr(cursor,0,(size_t)(end-cursor)))) return 0;
        args[i]=cursor; cursor=zero+1;
    }
    int i=1;
    while (i<argc && strcmp(args[i],"app-server")) {
        const char *a=args[i];
        if (!strcmp(a,"-c") || !strcmp(a,"--config") || !strcmp(a,"--enable") || !strcmp(a,"--disable")) { if (i+1>=argc) return 0; i+=2; }
        else if (!strncmp(a,"--config=",9) || !strncmp(a,"--enable=",9) || !strncmp(a,"--disable=",10)) i++;
        else return 0;
    }
    if (++i>=argc || args[i][0]!='-') return 0;
    int listens=0;
    for (;i<argc;i++) if (!strcmp(args[i],"--listen")) {
        if (++listens!=1 || i+1>=argc) return 0;
        const char *value=args[i+1];
        if (strcmp(value,"unix://") && (strncmp(value,"unix://",7) || strcmp(value+7,socket_path))) return 0;
    }
    if (listens!=1 || proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&after,sizeof(after))!=(int)sizeof(after)) return 0;
    if (before.pbi_uid!=after.pbi_uid || before.pbi_start_tvsec!=after.pbi_start_tvsec || before.pbi_start_tvusec!=after.pbi_start_tvusec) return 0;
    *sec=after.pbi_start_tvsec; *usec=after.pbi_start_tvusec; return 1;
}
#endif

int main(int argc, char **argv) {
#if defined(__APPLE__) || defined(HERDER_DARWIN_FIXTURE)
    if (argc==3 && !strcmp(argv[1],"--group")) {
        int pgid=number(argv[2],2);
        if (pgid<0) return 65;
        return group_snapshot(pgid)?0:66;
    }
#endif
    if (argc < 4) return 65;
    int pid = number(argv[2], 2);
    if (pid < 0) return 65;
#if defined(__APPLE__) || defined(HERDER_DARWIN_FIXTURE)
    if (!strcmp(argv[1], "--identity") && argc == 5) {
        uint64_t sec,usec;
        if (!identity(pid,argv[3],argv[4],&sec,&usec)) return 66;
        printf("IDENTITY %u %llu %llu\n",(unsigned)getuid(),(unsigned long long)sec,(unsigned long long)usec); return 0;
    }
#endif
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
