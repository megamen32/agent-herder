#!/usr/bin/env python3
"""Exact original-outcome preservation and canonical reconciliation boundaries."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
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


if __name__=='__main__':unittest.main()
