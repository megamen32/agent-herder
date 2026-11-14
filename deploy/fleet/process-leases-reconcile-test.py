#!/usr/bin/env python3
"""Exact original-outcome preservation and canonical reconciliation boundaries."""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('reconcile', HERE / 'process-leases-reconcile.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
c = r.candidate


class Contracts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        os.chmod(self.root, 0o700)
        self.job = self.root / 'job'; self.job.mkdir(mode=0o700)
        self.output = self.root / 'reconciliation'; self.output.mkdir(mode=0o700)
        self.selector = self.root / 'selector.json'; c.create(self.selector, b'{}\n')
        self.launcher = self.root / 'launch.py'; c.create(self.launcher, b'# fixture\n')
        self.state = {'schema': 1, 'job_id': 'rollout-' + '1' * 32, 'job_dir': str(self.job),
            'phase': 'unknown', 'error_type': 'TimeoutError', 'updated_at_unix_ms': 12345,
            'deadline_unix_ms': 45678, 'challenge': 'a' * 64,
            'coordinator': {'pid': 234, 'boot_id': 'a' * 8 + '-aaaa-aaaa-aaaa-' + 'a' * 12, 'start_ticks': 123},
            'selector': str(self.selector), 'launcher': str(self.launcher),
            'selector_after_sha256': c.digest(self.selector), 'selector_before_sha256': 'f' * 64,
            'launcher_after_sha256': c.digest(self.launcher), 'launcher_before_sha256': 'e' * 64,
            'release_identity': {'fence': 122}, 'scheduler_identity': {'process': {'pid': 111}, 'runtime': {'source_commit': 'a'*40}, 'canonical': {}},
            'baseline_runtime': {'core': {'cwd': str(self.root)}}}
        c.create(self.job / 'state.json', c.encoded(self.state))
        self.pointer = {'schema': 1, 'job_id': self.state['job_id'], 'job_dir': str(self.job),
                        'selector': str(self.selector), 'phase': 'active'}
        c.create(r.rollout.occupancy_path(self.selector), c.encoded(self.pointer))
        self.guard = {'guard_id': 'guard-' + '2'*32, 'execution_ref': 'release-guard-' + '2'*32, 'fence': 122}
        self.guard_pin = r.publish(self.output / 'guard.intent.json', self.guard)
        self.original = r.publish(self.output / 'original-state.json', (self.job/'state.json').read_bytes(), raw=True)
        self.plan = {'version': 1, 'kind': r.KIND, 'outcome': 'candidate', 'job_id': self.state['job_id'],
            'job_dir': str(self.job), 'original_state_snapshot': self.original, 'state': r.pin(self.job/'state.json'),
            'successor_scheduler_identity': self.state['scheduler_identity'], 'challenge': 'b'*64,
            'bridge': {'guard_intent': self.guard_pin}}
        self.plan_pin = r.publish(self.output / 'plan.json', self.plan)
        self.paired = {'version': 1, 'kind': 'herder-paired-rollout-reconciliation-v1', 'outcome': 'candidate', 'complete': True,
            'job_id': self.state['job_id'], 'old_scheduler_identity': self.state['scheduler_identity'],
            'original_state_snapshot': self.original, 'plan': self.plan_pin}
        self.paired_pin = r.publish(self.output / 'paired-proof.json', self.paired)
        self.evidence = {'version':1,'kind':'herder-project-release-reconciliation-v1','outcome':'candidate',
            'job_id':self.state['job_id'],'job_dir':str(self.job),'state':self.plan['state'],
            'guard_intent':self.guard_pin,'paired_proof':self.paired_pin,'binding_sha256':'d'*64,
            'validated_at_unix_ms':12345}
        self.evidence_pin = r.publish(self.output / 'evidence.json', self.evidence)
        self.args = argparse.Namespace(plan=Path(self.plan_pin['path']),plan_sha256=self.plan_pin['sha256'],
            consumer_receipt=self.root/'unused-consumer',scheduler_proof=self.root/'unused-scheduler')
        self.native_calls, self.native_effects = 0, 0

    def native(self, plan, evidence_pin):
        self.native_calls += 1
        path = self.output / ('guard.reconciliation.json')
        existed = path.exists()
        receipt = {'version':1,'kind':'herder-project-release-reconciliation-receipt-v1','outcome':'candidate',
            'job_id':self.state['job_id'],'guard':self.guard,'evidence':evidence_pin,'paired_proof':self.paired_pin,
            'original_binding_sha256':self.evidence['binding_sha256']}
        value = r.publish(path, receipt)
        if not existed: self.native_effects += 1
        return {'finished':True,'reconciled':True,'jobId':self.state['job_id'],'guardId':self.guard['guard_id'],
            'receiptPath':value['path'],'receiptSha256':value['sha256'],'evidenceSha256':evidence_pin['sha256'],
            'receiptRef':self.guard['execution_ref']+':reconciled:'+value['sha256']}

    def apply_fixture(self):
        with patch.object(r,'load_plan',return_value=self.plan), patch.object(r,'verify_current',return_value=self.state), \
                patch.object(r.rollout,'validate_consumer',return_value={}), patch.object(r.readiness,'validate_receipt',return_value={}), \
                patch.object(r,'invoke_native',side_effect=self.native), patch.object(r.rollout,'identity_state',return_value='dead'):
            # Simulate a durable native receipt lost before the operator ACK.
            self.native(self.plan,self.evidence_pin)
            return r.apply(self.args)

    def test_receipt_resolves_occupancy_preserving_every_original_field(self):
        result = self.apply_fixture()
        state = r.rollout.read_state(self.job)
        self.assertEqual({k:v for k,v in state.items() if k!='canonical_reconciliation'},self.state)
        self.assertEqual(result['status'],'unknown')
        self.assertEqual(result['occupancy'],'resolved')
        self.assertFalse(result['requires_reconciliation'])
        self.assertTrue(r.rollout.canonical_reconciliation_valid(state))
        self.assertEqual(self.native_effects,1)

    def test_plain_unknown_cannot_resolve(self):
        with self.assertRaisesRegex(ValueError,'nonterminal'):
            r.rollout.resolve_occupancy(self.state)
        self.assertEqual(r.rollout.read_occupancy(self.selector)['phase'],'active')

    def test_original_restart_audit_refuses_same_pid_with_different_birth(self):
        state={**self.state,'awaiting_restart_at_unix_ms':1}
        restart={'schema':1,'kind':'restart','job_id':state['job_id'],'challenge':state['challenge'],
            'observed_at_unix_ms':10,'provider_operation_id':'fixture-original-restart',
            'target':r.rollout.CONTROLLER,'ref':r.rollout.CHILD,'method':'mcp_manage','action':'restart',
            'compat_pid':201,'core_pid':202}
        receipt=r.publish(self.output/'original-restart.json',restart)
        r.publish(self.job/'restart-ack.json',restart)
        provider=r.publish(self.output/'provider-result.json',{'taskId':'fixture-original-restart','status':'completed'})
        child=r.publish(self.output/'child-status.json',{'pid':201})
        pair={role:{'pid':pid,'boot_id':state['coordinator']['boot_id'],'start_ticks':pid*100,
                    'exe':'/fixture/'+role,'exe_sha256':'a'*64,'argv_sha256':'b'*64,
                    'configuration_sha256':'c'*64,'cwd':'/fixture','ppid':200 if role=='compat' else 201}
              for role,pid in [('compat',201),('core',202)]}
        binding={'version':1,'kind':'herder-native-receipt-source-binding','receipt':receipt,
            'state':{'path':str(self.job/'state.json'),'sha256':'e'*64},'provider_operation_id':'fixture-original-restart',
            'provider_result':provider,'child_status':child,'runtime_pair':pair,
            'native_calls':0,'service_calls':0,'selector_changes':0}
        binding_pin=r.publish(self.output/'restart-binding.json',binding)
        self.assertEqual(r.native_restart_binding(binding_pin,state,pair),binding)
        for field,newvalue in [('start_ticks',999999),('boot_id','b'*8+'-bbbb-bbbb-bbbb-'+'b'*12),('exe_sha256','d'*64)]:
            changed=copy.deepcopy(pair);changed['core'][field]=newvalue
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'exact original restart pair'):
                r.native_restart_binding(binding_pin,state,changed)
        wrong=copy.deepcopy(binding);wrong['provider_operation_id']='unrelated-operation'
        with self.assertRaisesRegex(ValueError,'original acknowledgement'):
            r.native_restart_binding(r.publish(self.output/'wrong-binding.json',wrong),state,pair)

    def test_existing_four_field_proof_uses_only_the_pinned_original_target(self):
        proof={'project':'/fixture/.git','owner':{'harness':'chatgpt','nativeSessionId':'fixture'},'fence':122,'token':'private-fixture'}
        target={'unit':'agent-herder.service','fleetDir':'/fixture/fleet'}
        state={'release_identity':{key:proof[key] for key in ('project','owner','fence')},'deployment_target':target}
        self.assertEqual(r.owner_proof(proof,state),{**proof,'deploymentTarget':target})
        self.assertNotIn('deploymentTarget',proof)
        self.assertEqual(r.owner_proof({**proof,'deploymentTarget':target},state)['deploymentTarget'],target)
        for wrong in (None,{'unit':'different.service','fleetDir':'/fixture/fleet'}):
            with self.subTest(target=wrong),self.assertRaisesRegex(ValueError,'project, target and fence'):
                r.owner_proof({**proof,'deploymentTarget':wrong},state)

    def test_observed_native_successor_requires_dead_original_and_unchanged_enrolled_config(self):
        original={role:{'pid':pid,'boot_id':self.state['coordinator']['boot_id'],'start_ticks':pid*100,
                    'exe':'/fixture/'+role,'exe_sha256':'a'*64,'argv_sha256':'b'*64,
                    'configuration_sha256':'c'*64,'cwd':str(self.root),'ppid':200 if role=='compat' else 201}
                  for role,pid in [('compat',201),('core',202)]}
        current=copy.deepcopy(original)
        current['compat'].update(pid=301,start_ticks=30100,ppid=300)
        current['core'].update(pid=302,start_ticks=30200,ppid=301)
        agent={'enabled':True,'ref':r.rollout.CHILD,'command':self.state['launcher'],'transport':'stdio',
               'user':'roomhacker','cwd':str(self.root),'env':{'HERDER_V1_ENTRY':self.state['selector']}}
        previous={'agent':agent,'status':{'pid':201}}
        status={'agent':copy.deepcopy(agent),'status':{'ref':r.rollout.CHILD,'running':True,'pid':301}}
        with patch.object(r.rollout,'identity_state',return_value='dead'),patch.object(r,'started_before_controller_observation'):
            r.validate_native_successor(self.state,original,current,status,previous,10000)
            for field in ['exe_sha256','argv_sha256','configuration_sha256','cwd']:
                wrong=copy.deepcopy(current);wrong['core'][field]='changed'
                with self.subTest(field=field),self.assertRaisesRegex(ValueError,'immutable artifact'):
                    r.validate_native_successor(self.state,original,wrong,status,previous,10000)
            changed_status=copy.deepcopy(status);changed_status['agent']['command']='/different-launcher'
            with self.assertRaisesRegex(ValueError,'enrolled controller child'):
                r.validate_native_successor(self.state,original,current,changed_status,previous,10000)
            changed_status=copy.deepcopy(status);changed_status['status']['pid']=999
            with self.assertRaisesRegex(ValueError,'enrolled controller child'):
                r.validate_native_successor(self.state,original,current,changed_status,previous,10000)
        with patch.object(r.rollout,'identity_state',return_value='live'):
            with self.assertRaisesRegex(ValueError,'proven dead'):
                r.validate_native_successor(self.state,original,current,status,previous,10000)

    def test_changed_native_pair_cannot_use_original_receipt_without_controller_evidence(self):
        original={'compat':{'pid':201},'core':{'pid':202}}
        current={'compat':{'pid':301},'core':{'pid':302}}
        with patch.object(r,'read_pin',return_value={'runtime_pair':original}),patch.object(r,'native_restart_binding'):
            self.assertEqual(r.native_provenance(self.state,original,{}),(original,None))
            with self.assertRaisesRegex(ValueError,'positive typed successor'):
                r.native_provenance(self.state,current,{})

    def test_controller_receipt_cannot_be_borrowed_by_later_pid_reuse(self):
        # The real running test process must not be accepted by an older receipt.
        current=r.rollout.identity(os.getpid())
        with self.assertRaisesRegex(ValueError,'not alive at the controller'):
            r.started_before_controller_observation(current,1)

    def test_changing_original_error_or_timestamp_invalidates_reconciliation(self):
        self.apply_fixture()
        good = r.rollout.read_state(self.job)
        for name,value in [('phase','completed'),('error_type','Success'),('updated_at_unix_ms',12346),('scheduler_identity',{})]:
            with self.subTest(field=name):
                changed=copy.deepcopy(good);changed[name]=value
                self.assertFalse(r.rollout.canonical_reconciliation_valid(changed))

    def test_native_receipt_conflict_cannot_settle_unknown(self):
        self.apply_fixture()
        state=r.rollout.read_state(self.job)
        receipt=r.read_pin(state['canonical_reconciliation']['receipt'])
        altered=copy.deepcopy(receipt);altered['native_acknowledgement']['evidenceSha256']='f'*64
        changed=copy.deepcopy(state)
        changed['canonical_reconciliation']['receipt']=r.publish(self.output/'bad-receipt.json',altered)
        self.assertFalse(r.rollout.canonical_reconciliation_valid(changed))

    def test_metadata_retry_after_annotation_does_not_call_native_again(self):
        self.apply_fixture()
        before=self.native_calls
        with patch.object(r,'load_plan',return_value=self.plan),patch.object(r,'invoke_native',side_effect=AssertionError('duplicate native call')), \
                patch.object(r.rollout,'identity_state',return_value='dead'):
            value=r.apply(self.args)
        self.assertEqual(value['occupancy'],'resolved')
        self.assertEqual(self.native_calls,before)
        self.assertEqual(self.native_effects,1)

    def test_atomic_publication_is_idempotent_and_never_replaces_other_bytes(self):
        p=self.output/'immutable.json';value={'v':1}
        first=r.publish(p,value); inode=p.stat().st_ino
        self.assertEqual(r.publish(p,value),first);self.assertEqual(p.stat().st_ino,inode)
        self.assertEqual(p.stat().st_nlink,1)
        with self.assertRaisesRegex(ValueError,'different bytes'):
            r.publish(p,{'v':2})
        self.assertEqual(json.loads(p.read_text()),value)

    def test_live_coordinator_is_rejected_before_occupancy(self):
        with patch.object(r.rollout,'identity_state',return_value='live'):
            with self.assertRaisesRegex(ValueError,'coordinator'):
                r.check_original(self.state)
        self.assertEqual(r.rollout.read_occupancy(self.selector)['phase'],'active')

    def test_service_delta_rejects_unreviewed_file_and_canonical_change(self):
        old={'unit':'agent-herder.service','canonical_environment_sha256':'a'*64,'exec_start_sha256':'b'*64,
             'files':[{'path':'/fixture/60-external-adapters.conf','sha256':'c'*64}]}
        new=copy.deepcopy(old);new['files'][0]['sha256']='d'*64
        with self.assertRaisesRegex(ValueError,'reviewed change'):r.service_delta(old,new,[])
        new=copy.deepcopy(old);new['canonical_environment_sha256']='d'*64
        with self.assertRaisesRegex(ValueError,'canonical systemd'):r.service_delta(old,new,[])
        new=copy.deepcopy(old);new['files'].append({'path':'/new','sha256':'e'*64})
        with self.assertRaisesRegex(ValueError,'inventory'):r.service_delta(old,new,[])

    def test_changed_dropin_cannot_smuggle_injection_or_restart_directive(self):
        home=self.root/'owner';folder=home/'.config/systemd/user/agent-herder.service.d';folder.mkdir(parents=True)
        p=folder/'60-external-adapters.conf'
        for text in ('[Service]\nEnvironment="NODE_OPTIONS=--require injected.js"\n',
                     '[Service]\nExecStart=/bad\n','[Service]\nEnvironment="AGENT_HERDER_EXTERNAL_ADAPTERS=[]"\nEnvironment="LD_PRELOAD=bad"\n'):
            with self.subTest(text=text),patch.object(Path,'home',return_value=home):
                p.write_text(text);os.chmod(p,0o600)
                after=c.digest(p)
                old={'unit':'agent-herder.service','canonical_environment_sha256':'a'*64,'exec_start_sha256':'b'*64,
                     'files':[{'path':str(p),'sha256':'c'*64}]}
                new=copy.deepcopy(old);new['files'][0]['sha256']=after
                approved=[{'path':str(p),'before_sha256':'c'*64,'after_sha256':after}]
                with self.assertRaises(ValueError):r.service_delta(old,new,approved)


class TSRepairContracts(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);os.chmod(self.root,0o700)
        self.output=self.root/'repair';self.output.mkdir(mode=0o700)
        self.job=self.root/'job';self.job.mkdir(mode=0o700)
        self.selector=self.root/'selector.json';c.create(self.selector,b'{}\n')
        self.boot='a'*8+'-aaaa-aaaa-aaaa-'+'a'*12
        self.old={'process':{'pid':328,'boot_id':self.boot,'start_ticks':'129720220','entry':'/fixture/dist/index.js',
                    'entry_sha256':'a'*64,'node_binary':'/fixture/node','node_sha256':'b'*64},
            'runtime':{'source_commit':'a'*40},'canonical':{'config':'/fixture/canonical.json'},'tree':{'sha':'c'*64},
            'service':{'unit':'agent-herder.service','files':[],'canonical_environment_sha256':'d'*64},'listener':{'port':18787}}
        self.pair={'compat':{'pid':401,'start_ticks':100},'core':{'pid':402,'start_ticks':101}}
        self.state={'job_id':'rollout-'+'1'*32,'job_dir':str(self.job),'phase':'unknown','error_type':'TimeoutError',
            'selector':str(self.selector),'selector_after_sha256':'a'*64,'launcher_after_sha256':'b'*64,
            'coordinator':{'pid':222,'boot_id':self.boot,'start_ticks':200},'deployment_target':{'unit':'agent-herder.service','fleetDir':'/fixture'},
            'release_identity':{'project':'/fixture/.git','owner':{'harness':'chatgpt','nativeSessionId':'fixture'},'fence':122}}
        self.state_pin=r.publish(self.job/'state.json',self.state)
        self.snapshot=r.publish(self.root/'original.json',self.state)
        self.proof=r.publish(self.root/'proof.json',{**self.state['release_identity'],'token':'private-fixture'})
        self.guard=r.publish(self.root/'guard.intent.json',{'guard_id':'guard-fixture','execution_ref':'release-guard-fixture'})
        self.base={'version':1,'kind':r.KIND,'outcome':'candidate','job_id':self.state['job_id'],'job_dir':str(self.job),
            'state':self.state_pin,'original_state_snapshot':self.snapshot,'proof':self.proof,
            'successor_scheduler_identity':self.old,'native_runtime':self.pair,'occupancy':{'path':'/fixture/occupancy','sha256':'e'*64},
            'bridge':{'guard_intent':self.guard,'binding':{'path':'/fixture/binding','sha256':'f'*64},
                'config':{'path':'/fixture/config','sha256':'a'*64},'ledger':{'path':'/fixture/ledger','sha256':'b'*64},
                'process_config':{'path':'/fixture/process','sha256':'c'*64},'sealed_bridge':{'path':'/fixture/bridge','sha256':'d'*64}}}
        self.base_pin=r.publish(self.root/'base-plan.json',self.base)
        self.operator=self.root/'native-repair';c.create(self.operator,b'fixture native operator\n',0o500)
        self.operator_pin=r.pin(self.operator,policy='unit')
        self.plan={'version':1,'kind':r.REPAIR_KIND,'operation':'restart_ts','request_key':'fixture-original-ts-repair',
            'job_id':self.state['job_id'],'job_dir':str(self.job),'original_plan':self.base_pin,
            'old_scheduler_identity':self.old,'native_runtime':self.pair,'systemctl':{'path':'/usr/bin/systemctl','sha256':'e'*64},
            'selector_sha256':'a'*64,'launcher_sha256':'b'*64,'native_operator':self.operator_pin,
            'validator_sources':[],'created_at_unix_ms':1}
        self.plan_pin=r.publish(self.output/'plan.json',self.plan)
        self.args=argparse.Namespace(plan=Path(self.plan_pin['path']),plan_sha256=self.plan_pin['sha256'])
        self.evidence={'version':1,'kind':r.REPAIR_EVIDENCE_KIND,'request_key':self.plan['request_key'],
            'job_id':self.state['job_id'],'job_dir':str(self.job),'state':self.state_pin,
            'repair_plan':self.plan_pin,'validated_at_unix_ms':1}
        self.intent_path=self.root/'guard.ts-repair.intent.json'

    def response(self,recorded=True):
        evidence=r.publish(self.output/'evidence.json',self.evidence)
        intent=r.publish(self.intent_path,{'version':1,'kind':'herder-project-release-ts-repair-intent-v1',
            'job_id':self.state['job_id'],'request_key':self.plan['request_key'],
            'evidence':evidence,'repair_id':'repair-fixture','repair_plan':self.plan_pin,
            'operator':self.operator_pin,'old_process':r.identity(self.old['process'])})
        response={'repairId':'repair-fixture','requestKey':self.plan['request_key'],'jobId':self.state['job_id'],
            'evidenceSha256':evidence['sha256'],'intentPath':intent['path'],'intentSha256':intent['sha256'],
            'status':'recorded' if recorded else 'unknown','restartAttempted':False,
            'bindingResolved':False,'requiresReconciliation':True}
        if recorded:
            receipt=r.publish(self.root/'guard.ts-repair.receipt.json',{'version':1,'kind':'herder-project-release-ts-repair-receipt-v1',
                'job_id':self.state['job_id'],'request_key':self.plan['request_key'],'repair_id':'repair-fixture','evidence':evidence,'intent':intent,
                'operator':self.operator_pin,'old_process':r.identity(self.old['process']),
                'systemctl':{'spawned':True,'exit_code':0,'signal':None,'timed_out':False,'stdout_sha256':'a'*64,'stderr_sha256':'b'*64},
                'started_at_unix_ms':1,'finished_at_unix_ms':2})
            response.update(receiptPath=receipt['path'],receiptSha256=receipt['sha256'])
        return evidence,response

    def test_prepare_requires_exact_current_state_without_http(self):
        out=self.root/'new-plan'
        args=argparse.Namespace(plan=Path(self.base_pin['path']),plan_sha256=self.base_pin['sha256'],
            repair_native_operator=self.operator,repair_native_operator_sha256=self.operator_pin['sha256'],
            request_key=self.plan['request_key'],output_directory=out)
        real_pin=r.pin
        def fixed_systemctl_pin(path,policy='private'):
            return self.plan['systemctl'] if str(path)=='/usr/bin/systemctl' else real_pin(path,policy)
        with patch.object(r,'load_plan',return_value=self.base),patch.object(r,'verify_current',return_value=self.state) as verify, \
                patch.object(r,'source_pins',return_value=[]),patch.object(r,'observe',side_effect=AssertionError('HTTP is unavailable')), \
                patch.object(r,'pin',side_effect=fixed_systemctl_pin), \
                patch.object(r.subprocess,'run',side_effect=AssertionError('preparation cannot run native/systemctl')):
            prepared=r.prepare_ts_repair(args)
        self.assertEqual(verify.call_count,2)
        value=r.read_pin(prepared['plan'])
        self.assertEqual(value['old_scheduler_identity'],self.old)
        self.assertEqual(value['native_runtime'],self.pair)
        self.assertEqual(value['request_key'],self.plan['request_key'])
        self.assertEqual(prepared['effects'],'private_evidence_only')
        self.assertEqual(r.read_pin(self.state_pin),self.state)

    def test_changed_current_identity_refuses_before_intent_or_native(self):
        for reason in ('TS birth changed','native pair changed','live original coordinator','service file changed'):
            with self.subTest(reason=reason),patch.object(r,'verify_current',side_effect=ValueError(reason)), \
                    patch.object(r,'invoke_ts_repair',side_effect=AssertionError('unadmitted effect')):
                with self.assertRaisesRegex(ValueError,reason):r.ts_repair_evidence(self.plan,self.base,self.args)
            self.assertFalse((self.output/'evidence.json').exists())

    def test_existing_intent_requires_original_evidence_without_restart(self):
        r.publish(self.intent_path,{'opaque_original':True})
        with patch.object(r,'verify_current',side_effect=AssertionError('may not readmit old intent')):
            with self.assertRaisesRegex(ValueError,'original evidence; never restart'):
                r.ts_repair_evidence(self.plan,self.base,self.args)

    def test_pending_intent_reuses_original_digest_without_requiring_old_ts_alive(self):
        evidence,response=self.response(recorded=False)
        with patch.object(r,'verify_ts_repair_unchanged',return_value=self.state) as guard, \
                patch.object(r,'verify_current',side_effect=AssertionError('old TS may already be dead')):
            self.assertEqual(r.ts_repair_evidence(self.plan,self.base,self.args),evidence)
        guard.assert_called_once_with(self.base)
        self.assertEqual(r.read_pin(evidence)['validated_at_unix_ms'],1)
        self.assertFalse(response['restartAttempted'])

    def test_native_invocation_is_fixed_typed_action_and_checks_actual_receipt(self):
        evidence,response=self.response()
        def invoke(argv,**kwargs):
            self.assertEqual(argv,[str(self.operator),'--config','/fixture/config'])
            request=json.loads(kwargs['input'])
            self.assertEqual(set(request),{'version','action','proof','evidence'})
            self.assertEqual(request['action'],'repair_ts')
            self.assertEqual(request['evidence'],evidence)
            self.assertEqual(request['proof']['deploymentTarget'],self.state['deployment_target'])
            self.assertNotIn('systemctl',argv)
            return subprocess.CompletedProcess(argv,0,json.dumps({'ok':True,'result':response}),'')
        with patch.object(r.subprocess,'run',side_effect=invoke) as call:
            self.assertEqual(r.invoke_ts_repair(self.plan,self.base,evidence),response)
        self.assertEqual(call.call_count,1)
        self.assertEqual(r.read_pin(self.state_pin)['phase'],'unknown')

    def test_ack_cannot_resolve_original_binding_or_borrow_another_request(self):
        evidence,response=self.response()
        for key,value in [('bindingResolved',True),('requiresReconciliation',False),('requestKey','another-request'),
                          ('jobId','other-job'),('evidenceSha256','0'*64)]:
            bad={**response,key:value}
            with self.subTest(key=key),patch.object(r.subprocess,'run',return_value=subprocess.CompletedProcess([],0,json.dumps({'ok':True,'result':bad}),'')):
                with self.assertRaisesRegex(ValueError,'original unresolved job'):
                    r.invoke_ts_repair(self.plan,self.base,evidence)

    def test_unknown_native_intent_stays_unknown_without_a_terminal_receipt(self):
        evidence,response=self.response(recorded=False)
        with patch.object(r.subprocess,'run',return_value=subprocess.CompletedProcess([],0,json.dumps({'ok':True,'result':response}),'')):
            result=r.invoke_ts_repair(self.plan,self.base,evidence)
        self.assertEqual(result['status'],'unknown');self.assertNotIn('receiptPath',result)
        self.assertFalse((self.root/'guard.ts-repair.receipt.json').exists())

    def test_native_refusal_is_archived_before_validation_without_capability_text(self):
        evidence=r.publish(self.output/'evidence.json',self.evidence)
        stdout='{"ok":false,"error":"repair_evidence_invalid"}'
        stderr='private-fixture '+'x'*70000
        with patch.object(r.subprocess,'run',return_value=subprocess.CompletedProcess([],1,stdout,stderr)) as call:
            with self.assertRaisesRegex(RuntimeError,'acknowledgement unavailable'):
                r.invoke_ts_repair(self.plan,self.base,evidence)
        self.assertEqual(call.call_count,1)
        files=list(self.output.glob('native-invocation-*.json'));self.assertEqual(len(files),1)
        value=json.loads(files[0].read_text())
        self.assertEqual(value['returncode'],1);self.assertFalse(value['timed_out'])
        self.assertEqual(value['stdout']['text'],stdout)
        self.assertEqual(value['stderr']['sha256'],hashlib.sha256(stderr.encode()).hexdigest())
        self.assertNotIn('private-fixture',value['stderr']['text'])
        self.assertIn('[redacted]',value['stderr']['text']);self.assertTrue(value['stderr']['truncated'])
        self.assertLessEqual(len(value['stderr']['text'].encode()),65536)
        self.assertEqual(value['evidence'],evidence)
        self.assertEqual(files[0].stat().st_mode & 0o777,0o400)

    def test_native_timeout_preserves_partial_output_without_a_second_invocation(self):
        evidence=r.publish(self.output/'evidence.json',self.evidence)
        error=subprocess.TimeoutExpired(['fixture'],180,output=b'{"partial":true}',stderr=b'private-fixture')
        with patch.object(r.subprocess,'run',side_effect=error) as call:
            with self.assertRaisesRegex(RuntimeError,'archived original invocation'):
                r.invoke_ts_repair(self.plan,self.base,evidence)
        self.assertEqual(call.call_count,1)
        value=json.loads(next(self.output.glob('native-invocation-*.json')).read_text())
        self.assertIsNone(value['returncode']);self.assertTrue(value['timed_out'])
        self.assertEqual(value['error_type'],'TimeoutExpired')
        self.assertEqual(value['stdout']['text'],'{"partial":true}')
        self.assertEqual(value['stderr']['sha256'],hashlib.sha256(b'private-fixture').hexdigest())
        self.assertEqual(value['stderr']['text'],'[redacted]')
        self.assertFalse(self.intent_path.exists())

    def test_successor_observation_requires_old_death_and_exact_service(self):
        new=copy.deepcopy(self.old);new['process'].update(pid=329,start_ticks='129720230')
        with patch.object(r.rollout,'identity_state',return_value='live'):
            with self.assertRaisesRegex(ValueError,'proven replacement'):r.observe_ts_repair_successor(self.plan)
        with patch.object(r.rollout,'identity_state',return_value='dead'), \
                patch.object(r.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'329\n','')), \
                patch.object(r.readiness,'birth',return_value={k:new['process'][k] for k in ('pid','boot_id','start_ticks')}), \
                patch.object(r.readiness,'observe',return_value=new):
            self.assertEqual(r.observe_ts_repair_successor(self.plan),new)
            changed=copy.deepcopy(new);changed['service']['files']=[{'path':'/unreviewed','sha256':'a'*64}]
            with patch.object(r.readiness,'observe',return_value=changed):
                with self.assertRaisesRegex(ValueError,'immutable service'):r.observe_ts_repair_successor(self.plan)

    def test_repair_observation_does_not_resolve_or_rewrite_original_unknown(self):
        evidence,response=self.response(recorded=False)
        new=copy.deepcopy(self.old);new['process'].update(pid=329,start_ticks='129720230')
        before=(self.job/'state.json').read_bytes()
        with patch.object(r,'load_ts_repair_plan',return_value=(self.plan,self.base)), \
                patch.object(r,'ts_repair_evidence',return_value=evidence), \
                patch.object(r,'invoke_ts_repair',return_value=response), \
                patch.object(r,'verify_ts_repair_unchanged',return_value=self.state), \
                patch.object(r,'observe_ts_repair_successor',return_value=new), \
                patch.object(r.rollout,'resolve_occupancy',side_effect=AssertionError('repair never resolves occupancy')):
            result,code=r.repair_ts(self.args)
        observation=r.read_pin(result['observation'])
        self.assertEqual(code,0);self.assertEqual(result['status'],'unknown')
        self.assertEqual(observation['original_outcome'],'unknown')
        self.assertFalse(observation['binding_resolved']);self.assertFalse(observation['operational_readiness'])
        self.assertTrue(observation['requires_reconciliation']);self.assertIsNone(observation['native_receipt'])
        self.assertEqual((self.job/'state.json').read_bytes(),before)


if __name__=='__main__':unittest.main()
