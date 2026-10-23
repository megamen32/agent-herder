"""Isolated PROTOTYPE checks; no production guarantee."""
import subprocess, tempfile, pathlib, hashlib, json, time
start=time.monotonic()
def git(root,*args):
    return subprocess.check_output(['git','-C',str(root),*args],stderr=subprocess.PIPE)
results={}
with tempfile.TemporaryDirectory(prefix='herder-recheck-') as d:
    root=pathlib.Path(d)/'repo';root.mkdir()
    git(root,'init','-q');git(root,'config','user.email','fixture@invalid');git(root,'config','user.name','Fixture')
    (root/'shared').write_text('base\n');git(root,'add','shared');git(root,'commit','-qm','base')
    (root/'shared').write_text('foreign staged\n');git(root,'add','shared')
    (root/'shared').write_text('foreign unstaged\n');(root/'untracked').write_bytes(b'foreign untracked\x00')
    def fingerprint():
        return [git(root,'diff','--binary'),git(root,'diff','--cached','--binary'),git(root,'status','--porcelain=v1'),(root/'shared').read_bytes(),(root/'untracked').read_bytes(),git(root,'ls-files','--stage')]
    before=fingerprint();wt=pathlib.Path(d)/'owned'
    git(root,'worktree','add','-q','-b','owned',str(wt),'HEAD')
    (wt/'shared').write_text('owned change\n');git(wt,'add','shared');git(wt,'commit','-qm','owned')
    assert before==fingerprint()
    results['git_worktree']={'foreign_tracked_staged_untracked_and_index_unchanged':True,'owned_commit':git(wt,'rev-parse','--short','HEAD').decode().strip()}
# Deterministic adversarial schedule: CAS protects activation but not subsequent GC.
artifacts={'A','B'};revision=0;current='A'
gc_selected='B' # read unreferenced, release lock
assert revision==0
current='B';revision+=1 # valid activation wins CAS
artifacts.remove(gc_selected) # stale GC selection unlinks newly referenced B
assert current not in artifacts
results['split_gc_counterexample']={'valid_CAS_then_dangling':True,'schedule':['GC selects unreferenced B','activate B at revision 0 succeeds','GC unlinks B outside shared commit']}
# Corrected model: tombstone under same guard; ref admission rejects tombstone.
artifacts={'A','B'};tombstones=set();revision=0;current='A'
tombstones.add('B')
activation_allowed='B' not in tombstones
assert not activation_allowed
artifacts.remove('B');tombstones.remove('B')
# Revision counter rejects A->B->A ABA, unlike hash-only comparison.
old=(revision,current);revision+=1;current='B';revision+=1;current='A'
assert old[1]==current and old[0]!=revision
results['corrected_model']={'tombstoned_candidate_rejected':True,'ABA_stale_revision_rejected':True}
# Separate config CAS allows a mixed result without spanning commit.
config_revision=4;required=4
assert config_revision==required
config_revision=5 # concurrent writer after precheck
activated=True
assert activated and config_revision!=required
results['config_counterexample']={'independent_precheck_does_not_protect_activation':True}
results['elapsed_ms']=round((time.monotonic()-start)*1000,2)
print(json.dumps(results,indent=2))
