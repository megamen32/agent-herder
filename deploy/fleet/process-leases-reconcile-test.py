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


class FailedReconciliationContracts(unittest.TestCase):
    def setUp(self):
        self.fixture=Contracts();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.root,self.output,self.job=self.fixture.root,self.fixture.output,self.fixture.job
        self.state,self.original=self.fixture.state,self.fixture.original
        self.plan=copy.deepcopy(self.fixture.plan);self.plan['created_at_unix_ms']=40000
        self.plan['old_scheduler_identity']=self.state['scheduler_identity']
        self.plan_pin=r.publish(self.output/'negative-base-plan.json',self.plan)
        self.now=100000
        request={'endpoint':r.readiness.ENDPOINT,'challenge':self.plan['challenge'],
                 'probe':{'harness':'zcode','native_session_id':'fixture-private-session','node_ref':'fixture-node'}}
        before=self.plan['successor_scheduler_identity']
        self.request=r.publish(self.output/'http-request.json',{'version':1,'kind':'herder-reconciliation-http-request',
            'plan':self.plan_pin,'request':request,'before':before,'created_at_unix_ms':97000,'provider_operation_id':None})
        self.body=r.publish(self.output/'response.body',b'{"error":"canonical_runtime_unavailable"}',raw=True)
        self.observation={'version':1,'kind':'herder-canonical-http-observation','stage':'consumer','request':request,
            'request_receipt':self.request,'before':before,'after':copy.deepcopy(before),'response':{'error':'canonical_runtime_unavailable'},
            'body':self.body,'http_status':503,'http_body_complete':True,'http_body_sha256':self.body['sha256'],
            'error':'observation_failed_ValueError','started_at_unix_ms':98000,'observed_at_unix_ms':99000,
            'reconciliation_plan':self.plan_pin,'rollout':{'job_id':self.plan['job_id'],'challenge':self.plan['challenge']},
            'provider_operation_id':None}
        self.observation_pin=r.publish(self.output/'http-observation.json',self.observation)
        self.provider_pin=r.publish(self.output/'http-provider.json',{'taskId':'fixture-actual-http','status':'completed'})
        self.provider_output={'observation':self.observation_pin,'http_status':503,'observation_complete':False,'provider_operation_id':None}

    def provider(self,plan,value):
        self.assertEqual(value,self.provider_pin)
        return 'fixture-actual-http',{'returncode':1,'stdout':json.dumps(self.provider_output),'stderr':''},value,99500

    def failure(self,observation_pin=None):
        with patch.object(r,'completed_provider',side_effect=self.provider),patch.object(r.readiness,'now_ms',return_value=self.now):
            return r.failure_from_observation(self.plan,self.plan_pin,observation_pin or self.observation_pin,self.provider_pin)

    def test_complete_authenticated_503_retains_actual_failed_provider_and_false_health(self):
        failure=self.failure()
        self.assertEqual(failure['http_status'],503)
        self.assertEqual(failure['provider_operation_id'],'fixture-actual-http')
        self.assertEqual(failure['outcome'],'failed');self.assertFalse(failure['operational_readiness'])
        self.assertEqual(r.read_pin(failure['body'],json_value=False),b'{"error":"canonical_runtime_unavailable"}')
        self.assertEqual(failure['before'],failure['after'])
        self.assertNotIn('migration_ready',failure)

    def test_timeout_auth_refusal_truncation_identity_drift_and_other_503_are_not_terminal_proofs(self):
        cases=[('http_status',None),('http_status',401),('http_status',403),('http_body_complete',False),
               ('after',{}),('response',{'error':'different_failure'}),('error','observation_failed_TimeoutError')]
        for i,(field,value) in enumerate(cases):
            changed=copy.deepcopy(self.observation);changed[field]=value
            item=r.publish(self.output/('wrong-http-'+str(i)+'.json'),changed)
            with self.subTest(field=field,value=value),self.assertRaises(ValueError):
                self.failure(item)

    def test_negative_observation_cannot_borrow_another_provider_or_restamp_stale_http(self):
        self.provider_output['observation']={'path':'/another/observation.json','sha256':'a'*64}
        with self.assertRaisesRegex(ValueError,'actual provider'):self.failure()
        self.provider_output['observation']=self.observation_pin
        self.now=160001
        with self.assertRaisesRegex(ValueError,'stale'):self.failure()

    def test_actual_reaped_subprocess_wrapper_preserves_both_exit_codes(self):
        wrapped={'returncode':1,'stdout':json.dumps(self.provider_output),'stderr':''}
        outer={'returncode':1,'stdout':json.dumps(wrapped),'stderr':''}
        self.assertEqual(r.provider_stdout(outer,1),self.provider_output)
        wrapped['returncode']=0;outer['stdout']=json.dumps(wrapped)
        with self.assertRaisesRegex(ValueError,'contradictory'):r.provider_stdout(outer,1)

    def test_missing_terminal_repair_receipt_refuses_without_a_native_invocation(self):
        stem=self.plan['bridge']['guard_intent']['path'].removesuffix('.intent.json')
        r.publish(Path(stem+'.ts-repair.intent.json'),{'job_id':self.plan['job_id']})
        with patch.object(r,'invoke_failed_native',side_effect=AssertionError('must not resolve an uncertain repair')):
            with self.assertRaisesRegex(ValueError,'definitive terminal'):
                r.terminal_repair(self.plan,None)

    def test_terminal_effects_accept_reaped_local_install_without_inventing_a_provider(self):
        state=copy.deepcopy(self.state)
        state.update(created_at_unix_ms=60000,awaiting_restart_at_unix_ms=65000,
            deployment_target={'unit':'agent-herder.service','fleetDir':str(self.root)})
        old=state['scheduler_identity'];old['process'].update(start_ticks='123',entry='/fixture/dist/index.js',node_binary='/fixture/node')
        plan=copy.deepcopy(self.plan);plan['original_state_snapshot']=r.publish(self.output/'effects-original.json',state)
        plan['state']=plan['original_state_snapshot'];plan['original_native_runtime']={'compat':{'pid':201},'core':{'pid':202}}
        journal=self.output/'install-journal';journal.mkdir(mode=0o700)
        install_plan=r.publish(self.output/'install-plan.json',{'version':1,'kind':'herder-canonical-ts-install',
            'source_commit':old['runtime']['source_commit'],'runtime':old['runtime'],'canonical':old['canonical']})
        installed=r.publish(journal/'result.json',{'version':1,'kind':'canonical-ts-installed','state':'started_pending_paired_readiness',
            'plan_sha256':install_plan['sha256'],'source_commit':old['runtime']['source_commit'],'pid':111,'start_ticks':'123',
            'entry':old['process']['entry'],'node_binary':old['process']['node_binary'],'at_unix_ms':300})
        plan.update(install_plan=install_plan,install_receipt=installed)
        listener=r.publish(self.output/'original-listener.json',{'actual_original_listener':True})
        driver={'returncode':0,'stdout':json.dumps({'status':'installed_listener_ready','pid':111,'start_ticks':'123',
            'source_commit':old['runtime']['source_commit'],'listener_receipt':listener}),'stderr':'','at_unix_ms':400}
        recipe=r.publish(self.output/'install-recipe.json',{'version':1,'kind':'prepared_ts_install_recipe',
            'source_commit':old['runtime']['source_commit'],'plan':install_plan['path'],'plan_sha256':install_plan['sha256'],'journal':str(journal)})
        install={'receipt':installed,'plan':install_plan,'recipe':recipe,'driver':r.publish(self.output/'install-driver.json',driver),
            'driver_source':r.publish(self.output/'install-driver.py',b'# exact reviewed fixture driver\n',raw=True),
            'intent':r.publish(journal/'intent.json',{'version':1,'kind':'canonical-ts-install-intent','plan':install_plan['path'],
                'plan_sha256':install_plan['sha256'],'source_commit':old['runtime']['source_commit'],
                'target':state['deployment_target'],'created_at_unix_ms':100}),
            'start_intent':r.publish(journal/'start-intent.json',{'version':1,'unit':r.readiness.UNIT,
                'source_commit':old['runtime']['source_commit'],'at_unix_ms':200})}
        restart_provider=r.publish(self.output/'original-native-provider.json',{'taskId':'fixture-restart','status':'completed'})
        restart_ack=r.publish(self.output/'restart-ack.json',{'provider_operation_id':'fixture-restart','observed_at_unix_ms':70000,'action':'restart'})
        binding={'provider_result':restart_provider,'receipt':restart_ack}
        restart_binding=r.publish(self.output/'original-native-binding.json',binding);plan['native_restart_binding']=restart_binding
        coordinator_provider=r.publish(self.output/'coordinator-provider.json',{'taskId':'fixture-coordinator','status':'completed'})
        log=r.publish(self.output/'original-coordinator.log',b'original timeout\n',raw=True)
        coordinator_driver={'returncode':1,'phase':'unknown','state':plan['state']['path'],'state_sha256':plan['state']['sha256'],
            'log':log['path'],'log_sha256':log['sha256'],'at_unix_ms':90000}
        inputs={'install':install,'native_restart':{'binding':restart_binding,'provider_result':restart_provider},
            'coordinator':{'provider_result':coordinator_provider,'driver':r.publish(self.output/'coordinator-driver.json',coordinator_driver),
                'provider_operation_id':'fixture-coordinator'},'repair':None}
        def provider(plan,pin):
            if pin==restart_provider:
                return 'fixture-restart',{'ref':r.rollout.CHILD,'action':'restart'},pin,70000
            self.assertEqual(pin,coordinator_provider)
            return 'fixture-coordinator',{'returncode':1,'stdout':json.dumps(coordinator_driver),'stderr':''},pin,90001
        with patch.object(r,'native_restart_binding',return_value=binding), \
                patch.object(r,'completed_provider',side_effect=provider),patch.object(r.rollout,'identity_state',return_value='dead'):
            value=r.validate_effect_completion(plan,inputs)
            self.assertTrue(value['complete']);self.assertEqual(value['install']['driver'],install['driver'])
            self.assertNotIn('provider_operation_id',value['install'])
            bad=copy.deepcopy(inputs);bad_driver={**driver,'returncode':1}
            bad['install']['driver']=r.publish(self.output/'failed-install-driver.json',bad_driver)
            with self.assertRaisesRegex(ValueError,'definitive completed'):r.validate_effect_completion(plan,bad)
            bad=copy.deepcopy(inputs)
            bad_output=json.loads(driver['stdout']);bad_output['pid']=999
            bad['install']['driver']=r.publish(self.output/'other-install-driver.json',{**driver,'stdout':json.dumps(bad_output)})
            with self.assertRaisesRegex(ValueError,'exact original'):r.validate_effect_completion(plan,bad)

    def build_receipt_chain(self):
        failure_pin=r.publish(self.output/'failure.json',self.failure())
        opaque=r.publish(self.output/'retained-original.json',{'actual_fixture_receipt':True})
        driver_source=r.publish(self.output/'driver.py',b'# retained fixture driver\n',raw=True)
        effects={'version':1,'kind':r.EFFECTS_KIND,'complete':True,'job_id':self.plan['job_id'],
            'original_state_snapshot':self.original,
            'install':{key:opaque for key in ('receipt','plan','recipe','driver','intent','start_intent')},
            'native_restart':{'binding':opaque,'provider_result':opaque},
            'coordinator':{'provider_result':opaque,'driver':opaque,'provider_operation_id':'fixture-coordinator'},'repair':None}
        effects['install']['driver_source']=driver_source
        effects_pin=r.publish(self.output/'effects.json',effects)
        tools=[{'name':'automation','inputSchema':{'enum':['process_completion','reconcile_process','cancel_execution','timer','session_completion','wait_status']}},
               {'name':'resource','inputSchema':{'const':'bind'}},{'name':'session','inputSchema':{'const':'resolve'}},
               {'name':'deliver','inputSchema':{'const':'receipt'}}]
        consumer={'schema':1,'kind':'consumer','job_id':self.plan['job_id'],'challenge':self.plan['challenge'],
            'target':r.rollout.CONTROLLER,'ref':r.rollout.CHILD,'method':'mcp_tools','observed_at_unix_ms':99500,
            'provider_operation_id':'fixture-actual-native','tools':tools,'schema_sha256':r.rollout.json_hash(tools)}
        consumer_pin=r.publish(self.output/'failed-native-consumer.json',consumer)
        operator=self.output/'failed-operator';c.create(operator,b'fixture native failed settlement\n',0o500)
        self.operator=r.pin(operator,policy='unit')
        self.prepared={'version':1,'kind':r.FAILED_PLAN_KIND,'outcome':'failed','original_plan':self.plan_pin,
            'job_id':self.plan['job_id'],'native_operator':self.operator,'effect_completion':effects_pin,'validator_sources':[]}
        self.prepared_pin=r.publish(self.output/'failed-plan.json',self.prepared)
        paired={'version':1,'kind':r.FAILED_PAIRED_KIND,'outcome':'failed','complete':True,'operational_readiness':False,
            'job_id':self.plan['job_id'],'old_scheduler_identity':self.state['scheduler_identity'],
            'successor_scheduler_identity':self.plan['successor_scheduler_identity'],'original_state_snapshot':self.original,
            'plan':self.plan_pin,'failed_plan':self.prepared_pin,'native_operator':self.operator,
            'scheduler_failure':failure_pin,'effect_completion':effects_pin,'native_consumer':consumer_pin,
            'native_provider_result':opaque,'validated_at_unix_ms':100000}
        paired_pin=r.publish(self.output/'failed-paired-proof.json',paired)
        evidence={**self.fixture.evidence,'outcome':'failed','paired_proof':paired_pin,'validated_at_unix_ms':100000}
        self.evidence_pin=r.publish(self.output/'failed-evidence.json',evidence)
        native={'version':1,'kind':'herder-project-release-failed-reconciliation-receipt-v1','outcome':'failed',
            'job_id':self.plan['job_id'],'guard':self.fixture.guard,'evidence':self.evidence_pin,'paired_proof':paired_pin,
            'original_binding_sha256':evidence['binding_sha256']}
        native_path=Path(self.fixture.guard_pin['path'].removesuffix('.intent.json')+'.failed-reconciliation.json')
        native_pin=r.publish(native_path,native)
        self.response={'finished':True,'reconciled':True,'outcome':'failed','operationalReadiness':False,
            'jobId':self.plan['job_id'],'guardId':self.fixture.guard['guard_id'],'receiptPath':native_pin['path'],
            'receiptSha256':native_pin['sha256'],'evidenceSha256':self.evidence_pin['sha256'],
            'receiptRef':self.fixture.guard['execution_ref']+':failed-reconciled:'+native_pin['sha256']}
        receipt={'version':1,'kind':'herder-paired-rollout-reconciled-v1','outcome':'failed','complete':True,
            'operational_readiness':False,'job_id':self.plan['job_id'],'original_state':self.original,
            'evidence':self.evidence_pin,'native_receipt':native_pin,'native_acknowledgement':self.response,
            'validated_at_unix_ms':100000}
        receipt_pin=r.publish(self.output/'expected-failed-receipt.json',receipt)
        self.annotated={**self.state,'canonical_reconciliation':{'version':1,'outcome':'failed',
            'receipt':receipt_pin,'original_state':self.original}}
        return self.annotated

    def test_failed_receipt_resolves_only_occupancy_and_keeps_every_original_unknown_field(self):
        state=self.build_receipt_chain()
        self.assertTrue(r.rollout.canonical_reconciliation_valid(state))
        c.replace(self.job/'state.json',c.encoded(state),c.digest(self.job/'state.json'),0o600)
        r.rollout.resolve_occupancy(state)
        with patch.object(r.rollout,'identity_state',return_value='dead'):
            result=r.rollout.status(argparse.Namespace(job_dir=self.job))
        self.assertEqual(result['status'],'unknown');self.assertEqual(result['occupancy'],'resolved')
        self.assertFalse(result['requires_reconciliation'])
        self.assertEqual({k:v for k,v in state.items() if k!='canonical_reconciliation'},self.state)
        self.assertNotIn('failed',r.rollout.TERMINAL)

    def test_failed_receipt_cannot_masquerade_as_positive_or_assert_operational_readiness(self):
        good=self.build_receipt_chain()
        changed=copy.deepcopy(good);changed['canonical_reconciliation']['outcome']='candidate'
        self.assertFalse(r.rollout.canonical_reconciliation_valid(changed))
        receipt=r.read_pin(good['canonical_reconciliation']['receipt'])
        for i,key in enumerate(('operational_readiness','complete')):
            wrong=copy.deepcopy(receipt);wrong[key]=not wrong[key]
            altered=copy.deepcopy(good)
            altered['canonical_reconciliation']['receipt']=r.publish(self.output/('wrong-negative-receipt-'+str(i)+'.json'),wrong)
            self.assertFalse(r.rollout.canonical_reconciliation_valid(altered))

    def test_same_digest_ack_repair_and_metadata_retry_never_repeat_deployment_or_decision(self):
        self.build_receipt_chain()
        args=argparse.Namespace(plan=Path(self.prepared_pin['path']),plan_sha256=self.prepared_pin['sha256'])
        with patch.object(r,'load_failed_plan',return_value=(self.prepared,self.plan)), \
                patch.object(r,'verify_current',side_effect=AssertionError('durable ACK repair uses original decision')), \
                patch.object(r,'invoke_failed_native',return_value=self.response) as native, \
                patch.object(r.rollout,'identity_state',return_value='dead'):
            first=r.apply_failed(args)
            self.assertEqual(native.call_count,1)
            second=r.apply_failed(args)
            self.assertEqual(native.call_count,1)
        self.assertEqual(first['status'],'unknown');self.assertFalse(first['operational_readiness'])
        self.assertEqual(second['occupancy'],'resolved')
        self.assertEqual({k:v for k,v in r.rollout.read_state(self.job).items() if k!='canonical_reconciliation'},self.state)


if __name__=='__main__':unittest.main()
