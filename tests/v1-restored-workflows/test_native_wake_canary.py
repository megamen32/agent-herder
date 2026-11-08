import contextlib, hashlib, importlib.util, io, json, os, pathlib, sqlite3, sys, tempfile, unittest
from unittest.mock import patch

PATH = pathlib.Path(__file__).with_name('native-wake-canary.py')
spec = importlib.util.spec_from_file_location('native_wake_canary', PATH)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class FakeMCP:
    def __init__(self, selector): self.sessions={};self.tasks={};self.calls=[];self.counter=0
    def close(self): pass
    def call(self,name,args):
        self.calls.append((name,args.copy()))
        if name=='discover': return {'instances':[{'node_ref':'server-44','instance_ref':'codex-44'}]}
        if name=='create':
            self.counter+=1; ref='session:'+str(self.counter);marker=args['prompt'].split()[-1];self.sessions[ref]=[{'role':'assistant','text':marker}]
            task='task-'+str(self.counter);self.tasks[task]={'create':{'session_ref':ref},'prompt':{'outcome':'confirmed','native_receipt_id':'turn-'+str(self.counter)}}
            return {'taskId':task,'resultType':'task'}
        if name=='compat_task': return {'status':'completed','result':{'structuredContent':self.tasks[args['task_ref']]}}
        if name=='automation': return {'rule_ref':'completion-rule:fake'}
        if name=='deliver':
            marker=args['message'].split()[-1];self.sessions[args['session_ref']].append({'role':'assistant','text':marker})
            run=marker.removeprefix('HERDER_WAKE_').removesuffix('_CHILD_FOLLOWUP')
            self.sessions['session:1'].append({'role':'assistant','text':'HERDER_WAKE_'+run+'_PARENT_WAKE'})
            self.tasks['task-deliver']={'outcome':'confirmed','native_receipt_id':'turn-followup'}
            return {'_herder_delivery_task':'task-deliver'}
        if name=='session' and args['action']=='messages':return {'messages':self.sessions[args['session_ref']]}
        if name=='session' and args['action']=='archive':return {'archived':True,'effect':'confirmed'}
        raise AssertionError((name,args))

class Workflow(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name)
        self.db=self.root/'state.db';con=sqlite3.connect(self.db);con.execute('create table session_bindings(session_ref,node_ref,instance_id,native_session_id)')
        for i in (1,2):con.execute('insert into session_bindings values (?,?,?,?)',('session:'+str(i),'server-44','codex-44','native-'+str(i)))
        con.commit();con.close()
        script=self.root/'wrapper';script.write_text('fixture');pathlib.Path(str(script)+'.json').write_text(json.dumps({'nodeRef':'server-44','kind':'codex','model':'gpt-6.1-terra','host':'192.168.2.5','user':'roomhacker','port':22}))
        self.profile=self.root/'profile.json';self.profile.write_text(json.dumps({'database':str(self.db),'owner':{'node':'server-44','instance':'codex-44','kind':'codex','ahap_script':str(script),'cwd':'/unused'}}))
        manifest=self.root/'manifest'; companion=pathlib.Path(str(script)+'.json');manifest.write_text(json.dumps({'remote_ahap_wrappers':[{'node':'server-44','instance':'codex-44','kind':'codex','script':str(script),'script_sha256':hashlib.sha256(script.read_bytes()).hexdigest(),'config_sha256':hashlib.sha256(companion.read_bytes()).hexdigest()}]}));self.selector=self.root/'selector';self.selector.write_text(json.dumps({'manifest':str(manifest),'manifest_sha256':hashlib.sha256(manifest.read_bytes()).hexdigest(),'profiles':[str(self.profile)]}))
        self.checkpoint=self.root/'receipt.json';self.mapping=self.root/'mapping.json';self.fake=FakeMCP(None)
        self.argv=['native-wake','--selector',str(self.selector),'--profile',str(self.profile),'--checkpoint',str(self.checkpoint),'--mapping',str(self.mapping),'--remote-hook-config','/home/roomhacker/.config/agent-herder/v1-completion-hook.json']
    def run_mode(self,mode,config=None):
        class P: stdout=json.dumps(config)
        with patch.object(sys,'argv',self.argv+[mode]),patch.object(m,'MCP',return_value=self.fake),patch.object(m,'remote_native_cwd',return_value='/actual/native'),patch.object(m.subprocess,'run',return_value=P()),contextlib.redirect_stdout(io.StringIO()):m.main()
    def test_prepare_finish_and_no_replay(self):
        self.run_mode('--prepare');state=json.loads(self.checkpoint.read_text());self.assertEqual(state['status'],'MAPPING_READY');mapping=json.loads(self.mapping.read_text());self.assertEqual(mapping['cwd'],'/actual/native');self.assertEqual(os.stat(self.mapping).st_mode&0o777,0o600)
        config={'endpoint':m.ENDPOINT,'bearer_file':'/private/ref','children':[mapping]}
        self.run_mode('--finish',config);state=json.loads(self.checkpoint.read_text());self.assertEqual(state['status'],'PASS')
        self.assertEqual(sum(name=='deliver' for name,args in self.fake.calls),1);self.assertFalse(any(name=='automation' and args.get('action')=='reconcile' for name,args in self.fake.calls))
        self.assertEqual(sum(name=='session' and args.get('action')=='archive' for name,args in self.fake.calls),2)
        with self.assertRaises(SystemExit):self.run_mode('--finish',config)
    def test_mapping_rejected_before_effect(self):
        self.run_mode('--prepare');mapping=json.loads(self.mapping.read_text());mapping['child_ref']='wrong'
        with self.assertRaisesRegex(RuntimeError,'mapping missing'):self.run_mode('--finish',{'endpoint':m.ENDPOINT,'bearer_file':'/private/ref','children':[mapping]})
        self.assertEqual(json.loads(self.checkpoint.read_text())['status'],'MAPPING_READY');self.assertFalse(any(n=='deliver' for n,_ in self.fake.calls))
    def test_unknown_never_reissued(self):
        self.run_mode('--prepare');mapping=json.loads(self.mapping.read_text());cfg={'endpoint':m.ENDPOINT,'bearer_file':'/private/ref','children':[mapping]}
        original=self.fake.call
        def fail(n,a):
            if n=='deliver':raise TimeoutError('unknown')
            return original(n,a)
        self.fake.call=fail
        with self.assertRaises(TimeoutError):self.run_mode('--finish',cfg)
        self.assertEqual(json.loads(self.checkpoint.read_text())['effects']['child_followup']['state'],'UNKNOWN')
        with self.assertRaises(SystemExit):self.run_mode('--finish',cfg)

if __name__=='__main__':unittest.main()
