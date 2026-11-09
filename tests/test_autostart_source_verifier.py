"""Offline source fixtures: no harness activation, HTTP, messages or launches."""
import importlib.util,json,sqlite3,sys,tempfile,unittest
from unittest.mock import patch
from pathlib import Path
SCRIPT=Path(__file__).resolve().parents[1]/'deploy/noticeplace/autostart_source_verifier.py'
spec=importlib.util.spec_from_file_location('autostart_source_verifier',SCRIPT)
adapter=importlib.util.module_from_spec(spec);sys.modules[spec.name]=adapter;spec.loader.exec_module(adapter)
SID='01a1a6c3-4b6c-7663-bcbd-8f80a2af10f4';CWD='/fixture/project';HOST='roomhacker-server-100'
RECORD={'harness':'codex','sessionId':SID,'cwd':CWD,'startedAt':'2026-11-08T14:00:00Z','notifiedAt':'2026-11-08T15:00:00Z','recoveryCause':'turn.failed','recoveryTurnId':'failed-turn','state':'exhausted'}
GROUP={'project':'agent-herder','source_id':'agent-herder-autostart','host_id':HOST,'signal_type':'unfinished-session-autostart-failed','problem_type':'unfinished-session-autostart-failed','correlation_id':f'unfinished-codex:{SID}:{CWD}-'+RECORD['startedAt']}
NOW=1794153600.0
class SourceTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.state=self.root/'herder';self.state.mkdir();self.codex=self.root/'codex';self.codex.mkdir();(self.codex/'sessions').mkdir()
  self.rollout=self.codex/'sessions/native.jsonl';self.stop=self.root/'human-stops.json'
  self.write(self.state/'unfinished-sessions.json',{'sessions':[RECORD]});self.write(self.state/'choices.json',{'requests':[]});self.write(self.state/'human-requests.json',{'requests':[]});self.write(self.stop,{'sessions':[]})
  c=sqlite3.connect(self.codex/'state_5.sqlite');c.execute('CREATE TABLE threads(id TEXT, cwd TEXT, rollout_path TEXT, archived INTEGER)');c.execute('INSERT INTO threads VALUES(?,?,?,0)',(SID,CWD,str(self.rollout)));c.commit();c.close()
  self.events=[{'type':'session_meta','payload':{'id':SID,'cwd':CWD}},self.event('task_started','2026-11-08T15:01:00Z'),self.event('task_complete','2026-11-08T15:02:00Z')];self.save()
 def write(self,p,v):p.write_text(json.dumps(v))
 def event(self,t,at,**extra):return {'type':'event_msg','timestamp':at,'payload':{'type':t,'turn_id':'continued-turn','root_turn_id':'failed-turn',**extra}}
 def save(self):self.rollout.write_text(''.join(json.dumps(x)+'\n' for x in self.events))
 def paths(self):return adapter.SourcePaths(self.state,self.stop,self.codex)
 def measure(self,group=None):return adapter.measure(group or GROUP,self.paths(),host_id=HOST,clock=lambda:NOW)
 def test_retained_failed_episode_survives_work_record_removal(self):
  self.write(self.state/'unfinished-sessions.json',{'sessions':[],'sourceBindings':[RECORD]});self.assertEqual(self.measure()['observed_state'],'healthy')
 def test_exact_native_continuation_is_healthy_and_readonly(self):
  before={str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()};result=self.measure()
  self.assertEqual(result['observed_state'],'healthy');self.assertEqual(result['observed_at'],NOW)
  self.assertEqual(before,{str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
 def test_executor_work_finished_and_idle_are_not_native_proof(self):
  self.events=self.events[:1];self.events.append({'type':'event_msg','payload':{'type':'agent_message','message':'work_finished'}});self.save();self.assertEqual(self.measure()['observed_state'],'unknown')
 def test_unrelated_new_turn_cannot_close_original_failure(self):
  self.events[-1]['payload']['root_turn_id']='different-input';self.save();self.assertEqual(self.measure()['observed_state'],'unknown')
 def test_completion_before_failure_is_unknown(self):
  self.events[1]['timestamp']='2026-11-08T14:01:00Z';self.events[2]['timestamp']='2026-11-08T14:02:00Z';self.save();self.assertEqual(self.measure()['observed_state'],'unknown')
 def test_stop_and_pending_question_fence_healthy(self):
  self.write(self.stop,{'sessions':[{'harness':'codex','id':SID,'active':True}]});self.assertEqual(self.measure()['observed_state'],'unknown')
  self.write(self.stop,{'sessions':[]});self.write(self.state/'human-requests.json',{'requests':[{'status':'pending','target':{'agent':'codex','sessionId':SID,'cwd':CWD}}]});self.assertEqual(self.measure()['observed_state'],'unknown')
 def test_archived_and_new_native_turn_are_unknown(self):
  self.events.append(self.event('task_started','2026-11-08T15:03:00Z',turn_id='new-turn'));self.save();self.assertEqual(self.measure()['observed_state'],'unknown')
  self.events.pop();self.save();c=sqlite3.connect(self.codex/'state_5.sqlite');c.execute('UPDATE threads SET archived=1');c.commit();c.close();self.assertEqual(self.measure()['observed_state'],'unknown')
 def test_foreign_group_and_missing_record_do_not_invent_health(self):
  for key,value in [('host_id','elsewhere'),('project','other'),('source_id','other'),('correlation_id','other')]:self.assertEqual(self.measure({**GROUP,key:value})['observed_state'],'unknown')
  self.write(self.state/'unfinished-sessions.json',{'sessions':[]});self.assertEqual(self.measure()['observed_state'],'unknown')
 def test_partial_tail_and_wrong_header_are_unknown(self):
  with self.rollout.open('a') as f:f.write('{partial')
  self.assertEqual(self.measure()['observed_state'],'unknown');self.events[0]['payload']['id']='foreign';self.save();self.assertEqual(self.measure()['observed_state'],'unknown')
 def test_deferral_class_is_answered_by_the_source(self):
  """A refusal that was never submitted is a deferral the source owns.

  The producer emits it under its own signal type. The source must answer
  for that class too, otherwise the incident can never be closed by the
  source and stays open forever.
  """
  group={**GROUP,'signal_type':'unfinished-session-quota-blocked','problem_type':'unfinished-session-quota-blocked'}
  self.assertEqual(self.measure(group)['observed_state'],'healthy')
  for signal in ('unfinished-session-quota-blocked','unfinished-session-not-submitted'):
   self.assertIn(signal,adapter.OWNED_SIGNALS)
   accepted=adapter.run_tick.__wrapped__ if hasattr(adapter.run_tick,'__wrapped__') else None
  # The own cycle must pick the deferral class up, not only the exhausted one.
  self.assertIn('unfinished-session-quota-blocked',adapter.OWNED_SIGNALS)
  self.assertIn('unfinished-session-not-submitted',adapter.OWNED_SIGNALS)
 def test_deferral_group_of_another_class_is_not_answered(self):
  for signal in ('unfinished-session-quota-blocked','unfinished-session-not-submitted'):
   group={**GROUP,'signal_type':signal,'problem_type':signal}
   self.assertEqual(self.measure(group)['observed_state'],'healthy')
  group={**GROUP,'signal_type':'unfinished-session-quota-blocked','problem_type':'unfinished-session-autostart-failed'}
  self.assertEqual(self.measure(group)['observed_state'],'unknown')
 def test_continuation_under_the_root_of_the_interrupted_turn_is_healthy(self):
  """The record names the interrupted TURN, not the root it belongs to.

  A continuation of that root is the same execution, so it proves the
  recovery. A turn of another root does not.
  """
  self.events=[{'type':'session_meta','payload':{'id':SID,'cwd':CWD}},
               self.event('task_started','2026-11-08T14:30:00Z',turn_id='interrupted-turn',root_turn_id='root-of-turn'),
               self.event('task_aborted' if False else 'task_failed','2026-11-08T14:40:00Z',turn_id='interrupted-turn',root_turn_id='root-of-turn'),
               self.event('task_started','2026-11-08T15:01:00Z',turn_id='continued-turn',root_turn_id='root-of-turn'),
               self.event('task_complete','2026-11-08T15:02:00Z',turn_id='continued-turn',root_turn_id='root-of-turn')]
  self.save()
  self.write(self.state/'unfinished-sessions.json',{'sessions':[{**RECORD,'recoveryTurnId':'interrupted-turn'}]})
  self.assertEqual(self.measure()['observed_state'],'healthy')
  # A completion of a DIFFERENT root is not the same execution.
  self.events[-1]['payload']['root_turn_id']='other-root';self.save()
  self.assertEqual(self.measure()['observed_state'],'unknown')
 def test_official_sdk_pull_then_fresh_native_read_and_unknown_no_replay(self):
  order=[];posts=[]
  def http(method,path,body=None,key=None):
   order.append(method)
   if method=='POST':posts.append(body);raise TimeoutError('fixture lost reply')
   if 'verification-requests' in path:return {'requests':[{'group':GROUP,'request_id':'request','generation':1,'incident_id':'inc_fixture'}]}
   return {'lifecycle':{}}
  real_measure=adapter.measure
  def probe(group,paths,**kwargs):order.append('READ_NATIVE');return real_measure(group,paths,host_id=HOST,clock=lambda:NOW)
  def tick():return adapter.run_tick(self.paths(),host_id=HOST,base_url='https://fixture.invalid',token='fixture',state_dir=self.root/'verifier',transport=http)
  with patch.object(adapter,'measure',side_effect=probe):
   with self.assertRaises(TimeoutError):tick()
   with self.assertRaises(RuntimeError):tick()
  self.assertEqual(order,['GET','READ_NATIVE','POST','GET']);self.assertEqual(len(posts),1);self.assertEqual(posts[0]['observed_state'],'healthy')
 def test_one_tick_answers_the_whole_queue_inside_its_budget(self):
  """A queue of due checks must not outlive the deadline of the server.

  The source answers every due check of one sweep in one tick: a request that
  waits behind the others would miss the deadline of the server, and the
  incident would be delivered to an executor again with the health of the
  source still unknown.
  """
  posts=[]
  requests=[{'group':GROUP,'request_id':f'request-{index}','generation':1,'incident_id':f'inc_{index}'} for index in range(6)]
  def http(method,path,body=None,key=None):
   if method=='POST':posts.append(body);return {'generation':1,'incident_id':body.get('incident_id'),'observed_state':body.get('observed_state'),'request_id':body.get('request_id')}
   if 'verification-requests' in path:return {'requests':requests}
   return {'lifecycle':{}}
  def probe(group,paths,**kwargs):return {'observed_state':'unknown','observed_at':NOW,'evidence_refs':['herder-autostart:native-not-completed']}
  with patch.object(adapter,'measure',side_effect=probe):
   receipts=adapter.run_tick(self.paths(),host_id=HOST,base_url='https://fixture.invalid',token='fixture',state_dir=self.root/'verifier',transport=http)
  self.assertEqual(len(posts),len(requests))
  self.assertEqual([post['request_id'] for post in posts],[request['request_id'] for request in requests])
 def test_one_tick_stays_inside_the_budget_of_the_owning_cycle(self):
  """The batch of one tick is bounded: the owning cycle gives it 30 seconds."""
  posts=[]
  requests=[{'group':GROUP,'request_id':f'request-{index}','generation':1,'incident_id':f'inc_{index}'} for index in range(200)]
  def http(method,path,body=None,key=None):
   if method=='POST':posts.append(body);return {'generation':1,'incident_id':body.get('incident_id'),'observed_state':body.get('observed_state'),'request_id':body.get('request_id')}
   if 'verification-requests' in path:return {'requests':requests}
   return {'lifecycle':{}}
  def probe(group,paths,**kwargs):return {'observed_state':'unknown','observed_at':NOW,'evidence_refs':['herder-autostart:native-not-completed']}
  with patch.object(adapter,'measure',side_effect=probe):
   adapter.run_tick(self.paths(),host_id=HOST,base_url='https://fixture.invalid',token='fixture',state_dir=self.root/'verifier',transport=http)
  self.assertLessEqual(len(posts),adapter.MAX_CHECKS_PER_TICK)
  self.assertLess(adapter.TICK_DEADLINE_SECONDS,30)
if __name__=='__main__':unittest.main()
