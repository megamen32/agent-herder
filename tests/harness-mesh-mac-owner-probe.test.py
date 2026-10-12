"""Fast unit: C observer contract, expected2s/max20s including one tiny compile.
Uses fake libproc headers/calls, no Darwin daemon, native actor or credentials.
The real SDK ABI and positive kernel proof require the separate Mac receipt.
"""
from pathlib import Path
import os, subprocess, tempfile, unittest

ROOT=Path(__file__).resolve().parents[1]
class OwnerProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();root=Path(cls.temp.name)
        (root/'sys').mkdir()
        (root/'sys/socket.h').write_text('#define AF_UNIX 1\n#define SOCK_STREAM 1\n#define SO_ACCEPTCONN 2\n')
        (root/'sys/un.h').write_text('#ifndef FIXTURE_UN_H\n#define FIXTURE_UN_H\nstruct sockaddr_un { unsigned char sun_len, sun_family; char sun_path[104]; };\n#endif\n')
        (root/'sys/sysctl.h').write_text('#include <stddef.h>\n#define CTL_KERN 1\n#define KERN_PROCARGS2 2\nint sysctl(const int*,unsigned,void*,size_t*,const void*,size_t);\n')
        (root/'sys/proc_info.h').write_text('''#include <stdint.h>
#include <sys/un.h>
#define SOCKINFO_UN 3
#define PROX_FDTYPE_SOCKET 2
#define PROC_PIDTBSDINFO 3
struct proc_bsdinfo { unsigned pbi_uid; uint64_t pbi_start_tvsec,pbi_start_tvusec; };
#define PROC_PIDLISTFDS 1
#define PROC_PIDFDSOCKETINFO 2
#define PROC_PIDPATHINFO_MAXSIZE 4096
struct proc_fdinfo { int proc_fd; unsigned proc_fdtype; };
struct socket_info { int soi_family,soi_kind,soi_type,soi_options; uint64_t soi_so;
 union {struct {union {struct sockaddr_un ua_sun;} unsi_addr,unsi_caddr;} pri_un;} soi_proto; };
struct socket_fdinfo { struct socket_info psi; };
''')
        (root/'libproc.h').write_text('int proc_pidinfo(int,int,unsigned long,void*,int);\nint proc_pidfdinfo(int,int,int,void*,int);\nint proc_pidpath(int,void*,unsigned);\n')
        stub=root/'stub.c';stub.write_text('''#include <sys/proc_info.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <stddef.h>
#include <unistd.h>
#include <sys/socket.h>
static int is(const char *s){return getenv("CASE")&&!strcmp(getenv("CASE"),s);}
int proc_pidpath(int pid,void *out,unsigned size){if(pid!=42)return 0;return snprintf(out,size,"/native/codex");}
int proc_pidinfo(int pid,int flavor,unsigned long arg,void *out,int size){
 if(pid!=42||is("absent"))return 0;
 if(flavor==PROC_PIDTBSDINFO){if(is("partial_bsd"))return size-1;struct proc_bsdinfo *b=out;b->pbi_uid=getuid()+(is("foreign_uid")?1:0);b->pbi_start_tvsec=is("new_generation")?101:100;b->pbi_start_tvusec=0;return sizeof(*b);}
 if(is("partial_list"))return 1;if(is("full_list"))return size;
 struct proc_fdinfo *f=out;f[0]=(struct proc_fdinfo){6,2};f[1]=(struct proc_fdinfo){7,2};return 2*sizeof(*f);
}
int proc_pidfdinfo(int pid,int fd,int flavor,void *out,int size){
 if(pid!=42||is("closed"))return 0;if(is("partial_record"))return size-1;
 struct socket_info *s=&((struct socket_fdinfo*)out)->psi;memset(out,0,size);
 s->soi_family=fd==6||is("dup")||is("different")?AF_UNIX:0;s->soi_kind=SOCKINFO_UN;s->soi_type=SOCK_STREAM;s->soi_options=is("client")?0:SO_ACCEPTCONN;s->soi_so=is("different")?fd:100;
 struct sockaddr_un *a=&s->soi_proto.pri_un.unsi_addr.ua_sun;
 a->sun_family=AF_UNIX;strcpy(a->sun_path,is("wrong_path")||is("peer_only")?"/wrong":"/native/socket");
 a->sun_len=offsetof(struct sockaddr_un,sun_path)+strlen(a->sun_path)+(is("no_nul")?0:1);
 if(is("padded"))a->sun_len=sizeof(*a);if(is("short_address"))a->sun_len=1;
 strcpy(s->soi_proto.pri_un.unsi_caddr.ua_sun.sun_path,"/native/socket");return size;
}
int sysctl(const int *mib,unsigned n,void *out,size_t *size,const void *newp,size_t newlen){
 if(mib[2]!=42||is("args_failed"))return -1;
 if(!out){*size=is("oversized_args")?9000:256;return 0;}
 if(is("capacity_race")){*size=8192;return 0;}
 int argc=6;char *p=out;memcpy(p,&argc,sizeof(argc));p+=sizeof(argc);
 const char *args[]={"/native/codex","", "codex","-c","opaque=value",is("wrong_command")?"other":"app-server","--listen",is("wrong_listen")?"unix:///wrong":"unix://"};
 for(unsigned i=0;i<sizeof(args)/sizeof(args[0]);i++){size_t len=strlen(args[i])+1;memcpy(p,args[i],len);p+=len;}
 memcpy(p,"PRIVATE_ENV=not-output",22);p+=22;*size=p-(char*)out;return 0;
}

''')
        cls.exe=root/'probe'
        subprocess.run(['cc','-std=c11','-D_POSIX_C_SOURCE=200809L','-DHERDER_DARWIN_FIXTURE','-I',str(root),str(ROOT/'deploy/fleet/mac-codex-owner-probe.c'),str(stub),'-o',str(cls.exe)],check=True,timeout=10,capture_output=True)
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()
    def probe(self,*args,case=''):
        return subprocess.run([str(self.exe),*args],env={**os.environ,'CASE':case,'TZ':'UTC'},capture_output=True,text=True,timeout=2)
    def test_fresh_kernel_uid_start_and_native_argv(self):
        args=('--identity','42','Thu Jan  1 00:01:40 1970','/native/socket')
        self.assertEqual(self.probe(*args).stdout,f'IDENTITY {os.getuid()} 100 0\n')
        for case in ('absent','partial_bsd','foreign_uid','new_generation','args_failed','wrong_command','wrong_listen','oversized_args','capacity_race'):
            with self.subTest(case=case):
                r=self.probe(*args,case=case);self.assertNotEqual(r.returncode,0);self.assertEqual(r.stdout,'');self.assertEqual(r.stderr,'')
    def test_exact_kernel_executable(self):
        self.assertEqual(self.probe('--text','42','/native/codex').stdout,'OWNED\n')
        self.assertNotEqual(self.probe('--text','42','/native/proxy').returncode,0)
        self.assertNotEqual(self.probe('--text','43','/native/codex').returncode,0)
    def test_fresh_listener_and_descriptor_hint(self):
        for case in ('','dup','no_nul','padded'):
            with self.subTest(case=case):
                self.assertEqual(self.probe('--socket','42','/native/socket',case=case).stdout,'FD 6\n')
                self.assertEqual(self.probe('--socket','42','/native/socket','6',case=case).stdout,'FD 6\n')
    def test_refusals_have_no_paths_or_raw_kernel_data(self):
        for case in ('absent','partial_list','full_list','closed','partial_record','client','wrong_path','peer_only','short_address','different'):
            with self.subTest(case=case):
                result=self.probe('--socket','42','/native/socket',case=case)
                self.assertNotEqual(result.returncode,0);self.assertEqual(result.stdout,'');self.assertEqual(result.stderr,'')
    def test_known_fd_must_still_be_a_listener(self):
        for args in (('--socket','42','/native/socket','7'),('--socket','43','/native/socket','6'),('--socket','42','/other','6'),('--socket','42','/native/socket','2147483648')):
            self.assertNotEqual(self.probe(*args).returncode,0)

if __name__=='__main__':unittest.main()
