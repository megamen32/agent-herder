import copy,json,unittest,hashlib,tempfile,time
from unittest.mock import patch
from pathlib import Path
from test_remote_release_gate import FakeGate,LoopFrames,contract,request,hello
from remote_release_gate import Authority,ProtocolError,RemoteReleaseGate
from deployment_config import validate_node,descriptor_digest
from release_gate import ReleaseGate

class AuthorityContextTests(unittest.TestCase):
 def setup_authority(self):
  c=contract(Path('/tmp/test-fleet'))
  class Gate(FakeGate):
   def check(self,cleanup=False):
    super().check(cleanup);return {'fence':7,'owner':'private','tokenHash':'secret'}
  gate=Gate();draft={'candidateSha':c['candidateSha'],'report_sha256':'d'*64,'artifact_sha256':'e'*64,'full_artifact_sha256':'f'*64,'harnesses':['codex','fast-agent']}
  a=Authority(gate,c,candidate_ci_draft=draft,harness_policy=['codex','fast-agent']);a.handle(request(c,1,'hello',hello(c)));return a,c,gate,draft
 def test_authority_delivers_context_without_capabilities_and_fences_every_read(self):
  a,c,g,_=self.setup_authority();reply=a.handle(request(c,2,'ci-draft'))
  self.assertEqual(reply['context']['status'],'INCOMPLETE');self.assertEqual(reply['context']['fence'],7)
  self.assertEqual(reply['context']['required_harnesses'],['codex','fast-agent']);self.assertNotIn('secret',json.dumps(reply))
  g.foreign=True
  with self.assertRaises(RuntimeError):a.handle(request(c,3,'ci-draft'))
 def test_remote_receives_fenced_draft_and_refuses_changed_candidate(self):
  a,c,g,_=self.setup_authority();remote=RemoteReleaseGate(c,LoopFrames(a));remote.sequence=1
  result=remote.ci_draft();self.assertEqual(result['fence'],7);self.assertEqual(result['status'],'INCOMPLETE')
  class Forged:
   def write(self,r):self.r=r
   def read(self):return {'run':c['run'],'sequence':3,'ok':True,'context':{**result,'candidateSha':'0'*40}}
  remote.frames=Forged()
  with self.assertRaises(RuntimeError):remote.ci_draft()
 def test_real_lease_fence_expires_and_rejects_replaced_owner(self):
  with tempfile.TemporaryDirectory() as temp:
   root=Path(temp);c=contract(root/'fleet');owner={'sessionId':'synthetic'};token='synthetic-token';target=c['descriptor']['authorityTarget'];project='/synthetic/repo'
   proof={'project':project,'fence':7,'owner':owner,'token':token};lease={'fence':7,'owner':owner,'tokenHash':hashlib.sha256(token.encode()).hexdigest(),'expiresAt':10000,'deploymentTarget':target}
   (root/'proof').write_text(json.dumps(proof));state=root/'leases';state.write_text(json.dumps({'projects':{project:{'lease':lease}}}))
   gate=ReleaseGate(root/'proof',state_path=state,now=lambda:5000,target=target)
   draft={'candidateSha':c['candidateSha'],'report_sha256':'d'*64,'artifact_sha256':'e'*64,'full_artifact_sha256':'f'*64,'harnesses':['codex']}
   with gate,patch.object(gate,'candidate_descends_from',return_value=None):
    a=Authority(gate,c,candidate_ci_draft=draft,harness_policy=['codex']);a.handle(request(c,1,'hello',hello(c)))
    self.assertEqual(a.handle(request(c,2,'ci-draft'))['context']['fence'],7)
    lease['fence']=8;state.write_text(json.dumps({'projects':{project:{'lease':lease}}}))
    with self.assertRaisesRegex(RuntimeError,'not_owned_or_expired'):a.handle(request(c,3,'ci-draft'))
 def test_missing_spoofed_policy_or_target_cannot_create_context(self):
  a,c,g,d=self.setup_authority()
  with self.assertRaises(ProtocolError):a.handle(request(c,2,'ci-draft',{'full_artifact_sha256':'0'*64}))
  d['harnesses']=['codex'];other=Authority(g,c,candidate_ci_draft=d,harness_policy=['codex','fast-agent']);other.handle(request(c,1,'hello',hello(c)))
  with self.assertRaises(RuntimeError):other.handle(request(c,2,'ci-draft'))
  g.expired=True
  with self.assertRaises(RuntimeError):a.handle(request(c,2,'ci-draft'))
if __name__=='__main__':unittest.main()
