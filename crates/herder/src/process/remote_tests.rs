use super::*;
use std::{fs, os::unix::fs::{MetadataExt, PermissionsExt}, path::PathBuf};

struct Fixture {
    root: PathBuf,
    store: ExecutionStore,
    remote: ExecutionStore,
    record: ExecutionRecord,
}
impl Fixture {
    fn new() -> Self {
        let root=std::env::temp_dir().join(format!("herder-remote-fixture-{}-{}",std::process::id(),random_id().unwrap()));
        fs::create_dir(&root).unwrap();fs::set_permissions(&root,fs::Permissions::from_mode(0o700)).unwrap();
        let store=ExecutionStore::open(root.join("controller"),"controller-node").unwrap();
        let remote=ExecutionStore::open(root.join("executor"),"executor-node").unwrap();
        let artifact=root.join("fixture-artifact");fs::write(&artifact,b"not executed by these tests").unwrap();
        fs::set_permissions(&artifact,fs::Permissions::from_mode(0o700)).unwrap();
        let digest=hash_bytes(&fs::read(&artifact).unwrap());
        let mesh=root.join("mesh.json");fs::write(&mesh,b"{}").unwrap();
        fs::set_permissions(&mesh,fs::Permissions::from_mode(0o600)).unwrap();
        let m=fs::metadata(remote.root()).unwrap();
        let executor=RemoteExecutorConfig{executor_ref:"fixture-executor".into(),node_ref:remote.node_ref().into(),
            transport:RemoteTransportConfig{node_binary:artifact.clone(),node_sha256:digest.clone(),bridge:artifact.clone(),
                bridge_sha256:digest.clone(),fleet_mesh_config:mesh,credential_pin:"a".repeat(64),target:"shell:fixture-executor".into()},
            worker:artifact.clone(),worker_sha256:digest,endpoint_config:root.join("endpoint.json"),
            endpoint_config_sha256:"c".repeat(64),execution_root:remote.root().into(),root_device:m.dev(),root_inode:m.ino(),
            max_runtime_ms:60_000,deadline_capability:RemoteDeadlineCapability::LinuxBootWatchdogV1};
        let record=store.prepare_remote_start(RemoteStartRequest{principal_ref:"principal".into(),session_ref:"session".into(),
            request_key:"request".into(),argv:vec!["/bin/true".into()],cwd:root.clone(),
            deadline_unix_ms:unix_millis().unwrap()+50_000,stop_grace_ms:500,executor}).unwrap();
        Self{root,store,remote,record}
    }
    fn state(&self)->ControlState{ControlState{version:1,controller_node_ref:self.record.node_ref.clone(),
        execution_ref:self.record.execution_ref.clone(),controller_payload_hash:self.record.payload_hash.clone(),
        handle:None,start_dispatched:false,start_permit:None,observation:None,terminal_observed_at_unix_ms:None}}
    fn transport(&self)->FakeRemote{
        let ExecutionRequest::RemoteStart(spec)=&self.record.request else{panic!()};
        let record=self.remote.prepare_start(spec.command()).unwrap();
        let boot=capture_process(std::process::id(),self.remote.node_ref()).unwrap().boot_id;
        FakeRemote{store:self.remote.clone(),record:record.clone(),handle:RemoteHandle{version:1,
            controller_node_ref:self.record.node_ref.clone(),executor_node_ref:record.node_ref.clone(),executor_ref:spec.executor.executor_ref.clone(),
            execution_ref:record.execution_ref.clone(),controller_payload_hash:self.record.payload_hash.clone(),command_hash:record.payload_hash.clone(),
            worker_sha256:spec.executor.worker_sha256.clone(),endpoint_config_sha256:spec.executor.endpoint_config_sha256.clone(),
            nonce:"b".repeat(64),root_device:spec.executor.root_device,root_inode:spec.executor.root_inode,
            boot_id:boot,deadline_boot_ms:100_000,deadline_unix_ms:spec.deadline_unix_ms},
            calls:vec![],starts:0,lose_start_ack:false,lose_prepare_ack:false,unavailable:false,changed_node:false,terminal:false,delay_ms:0}
    }
}
impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}

struct FakeRemote{
    store:ExecutionStore,record:ExecutionRecord,handle:RemoteHandle,calls:Vec<String>,starts:usize,
    lose_start_ack:bool,lose_prepare_ack:bool,unavailable:bool,changed_node:bool,terminal:bool,delay_ms:u64,
}
impl RemoteTransport for FakeRemote{
    fn call(&mut self,_:&RemoteExecutorConfig,request:&RemoteRequest)->io::Result<RemoteResponse>{
        let action=match request.operation{RemoteAction::Prepare{..}=>"prepare",RemoteAction::Start{..}=>"start",
            RemoteAction::Status{..}=>"status",RemoteAction::Reconcile{..}=>"reconcile",RemoteAction::Cancel{..}=>"cancel"};
        self.calls.push(action.into());
        std::thread::sleep(Duration::from_millis(self.delay_ms));
        if self.unavailable{return Err(invalid("fixture_network_lost"))}
        if action=="prepare" && self.lose_prepare_ack{self.lose_prepare_ack=false;return Err(invalid("fixture_prepare_ack_lost"))}
        if let RemoteAction::Start{handle,permit}=&request.operation{
            assert_eq!(*handle,self.handle);permit.validate(&self.handle.boot_id,1_000,self.handle.deadline_boot_ms)?;
            self.starts+=1;self.record.state=ExecutionState::Running;
            self.record.started_at_unix_ms=Some(unix_millis()?);
            let identity=capture_process(std::process::id(),self.store.node_ref())?;
            self.record.worker=Some(identity.clone());self.record.process=Some(identity);
            self.record.heartbeat_at_unix_ms=Some(unix_millis()?);
            if self.lose_start_ack{self.lose_start_ack=false;return Err(invalid("fixture_start_ack_lost"))}
        }
        if matches!(request.operation,RemoteAction::Cancel{..}){self.terminal=true}
        if self.terminal && self.record.receipt.is_none(){
            let receipt=CompletionReceipt{execution_ref:self.record.execution_ref.clone(),node_ref:self.store.node_ref().into(),
                reason:if action=="cancel"{CompletionReason::Cancelled}else{CompletionReason::Exited},
                started_at_unix_ms:self.record.started_at_unix_ms,finished_at_unix_ms:unix_millis()?,
                exit_code:Some(0),signal:None,descendant_failure:false,tree_complete:true,process_may_be_running:false,
                evidence_source:"fixture_exact_executor_receipt".into(),stdout_path:self.store.root().join("stdout.log"),
                stderr_path:self.store.root().join("stderr.log"),detail:None};
            self.record.receipt=Some(receipt);self.record.state=ExecutionState::Finished;
        }
        let live=self.record.state==ExecutionState::Running;
        let observation=RemoteObservation{handle:self.handle.clone(),observed_boot_id:self.handle.boot_id.clone(),observed_boot_ms:1_000,
            source:serde_json::json!({"execution_ref":self.record.execution_ref,"executor_node":self.record.node_ref,
                "request_digest":self.record.payload_hash,"source":null}),
            snapshot:ExecutionSnapshot{record:self.record.clone(),observation:if live{ExecutionObservation::ConfirmedLive}
                else if self.terminal{ExecutionObservation::Terminal}else{ExecutionObservation::Pending},confirmed_live:live,worker_lock_held:live}};
        Ok(RemoteResponse{version:1,request_id:request.request_id.clone(),controller_node_ref:request.controller_node_ref.clone(),
            executor_node_ref:if self.changed_node{"impostor".into()}else{request.executor_node_ref.clone()},
            executor_ref:request.executor_ref.clone(),observation})
    }
}
#[derive(Default)]
struct Hooks{before:usize,renew:usize,terminal:usize,deny:bool}
impl ExecutionHooks for Hooks{
    fn before_spawn(&mut self,_:&ExecutionRecord)->io::Result<()>{self.before+=1;if self.deny{Err(invalid("expired claim"))}else{Ok(())}}
    fn tick(&mut self,_:&ExecutionRecord)->io::Result<()>{self.renew+=1;if self.deny{Err(invalid("expired claim"))}else{Ok(())}}
    fn terminal(&mut self,_:&ExecutionRecord,_:&CompletionReceipt)->io::Result<()>{self.terminal+=1;Ok(())}
    fn launch_valid_for_ms(&mut self,_:&ExecutionRecord)->io::Result<u64>{Ok(2_000)}
}

#[test]
fn lost_start_ack_reconnects_exact_handle_without_second_start(){
    let f=Fixture::new();let mut t=f.transport();t.lose_start_ack=true;
    let mut record=f.record.clone();let mut state=f.state();let mut hooks=Hooks::default();
    assert!(tick(&f.store,&mut record,&mut state,&mut hooks,&mut t,true).is_err());
    assert_eq!(t.starts,1);assert!(load_state(&f.store,&record).unwrap().start_dispatched);
    // New controller instance, original remote command still running.
    let mut reloaded=load_state(&f.store,&record).unwrap();
    assert!(!tick(&f.store,&mut record,&mut reloaded,&mut hooks,&mut t,false).unwrap());
    assert_eq!(t.starts,1);assert_eq!(hooks.renew,1);assert!(record.process.is_none());
    t.terminal=true;
    assert!(tick(&f.store,&mut record,&mut reloaded,&mut hooks,&mut t,false).unwrap());
    assert_eq!(record.node_ref,"controller-node");assert_eq!(record.receipt.as_ref().unwrap().node_ref,"executor-node");
    assert_eq!(hooks.terminal,1);assert_eq!(t.starts,1);
    f.store.acknowledge_finalization(&record.execution_ref,record.receipt.as_ref().unwrap()).unwrap();
    assert!(remote_terminal_observed_at(&record,&f.store.execution_directory(&record.execution_ref).unwrap()).unwrap().is_some());
}

#[test]
fn partition_never_renews_or_repeats_start(){
    let f=Fixture::new();let mut t=f.transport();let mut record=f.record.clone();let mut state=f.state();let mut hooks=Hooks::default();
    assert!(!tick(&f.store,&mut record,&mut state,&mut hooks,&mut t,true).unwrap());
    t.unavailable=true;
    for _ in 0..3{assert!(tick(&f.store,&mut record,&mut state,&mut hooks,&mut t,false).is_err());}
    assert_eq!(t.starts,1);assert_eq!(hooks.renew,0);assert_eq!(hooks.before,1);
    assert!(record.receipt.is_none());assert!(state.start_dispatched);
}

#[test]
fn expired_claim_before_dispatch_cancels_preparation_without_effect(){
    let f=Fixture::new();let mut t=f.transport();let mut record=f.record.clone();let mut state=f.state();
    let mut hooks=Hooks{deny:true,..Hooks::default()};
    assert!(tick(&f.store,&mut record,&mut state,&mut hooks,&mut t,true).unwrap());
    assert_eq!(t.starts,0);assert!(!state.start_dispatched);assert_eq!(hooks.terminal,1);
    assert_eq!(record.receipt.unwrap().reason,CompletionReason::Cancelled);
}

#[test]
fn expired_claim_after_dispatch_requests_exact_cancel_without_resurrection(){
    let f=Fixture::new();let mut t=f.transport();let mut record=f.record.clone();let mut state=f.state();let mut hooks=Hooks::default();
    assert!(!tick(&f.store,&mut record,&mut state,&mut hooks,&mut t,true).unwrap());
    hooks.deny=true;
    assert!(tick(&f.store,&mut record,&mut state,&mut hooks,&mut t,false).unwrap());
    assert_eq!(t.starts,1);assert_eq!(hooks.before,1);assert_eq!(hooks.renew,1);
    assert!(f.store.cancellation_requested(&record.execution_ref).unwrap());
}

#[test]
fn resumed_controller_cannot_launch_an_unattempted_command(){
    let f=Fixture::new();let mut t=f.transport();let mut record=f.record.clone();let mut state=f.state();let mut hooks=Hooks::default();
    assert!(tick(&f.store,&mut record,&mut state,&mut hooks,&mut t,false).unwrap());
    assert_eq!(t.starts,0);assert_eq!(hooks.before,0);assert_eq!(t.calls,vec!["prepare","cancel"]);
}

#[test]
fn prepare_ack_loss_recovers_original_handle_without_admitting_a_command(){
    let f=Fixture::new();let mut t=f.transport();let expected=t.handle.clone();t.lose_prepare_ack=true;
    let mut record=f.record.clone();let mut state=f.state();let mut hooks=Hooks::default();
    save_state(&f.store,&record,&state).unwrap();
    assert!(tick(&f.store,&mut record,&mut state,&mut hooks,&mut t,true).is_err());
    let mut reloaded=load_state(&f.store,&record).unwrap();assert!(reloaded.handle.is_none());
    assert!(tick(&f.store,&mut record,&mut reloaded,&mut hooks,&mut t,false).unwrap());
    assert_eq!(reloaded.handle,Some(expected));assert_eq!(t.starts,0);assert_eq!(hooks.before,0);
    assert_eq!(t.calls,vec!["prepare","prepare","cancel"]);
}

#[test]
fn response_substitution_does_not_renew_or_overwrite_saved_handle(){
    let f=Fixture::new();let mut t=f.transport();let mut record=f.record.clone();let mut state=f.state();let mut hooks=Hooks::default();
    assert!(!tick(&f.store,&mut record,&mut state,&mut hooks,&mut t,true).unwrap());
    let path=f.store.execution_directory(&record.execution_ref).unwrap().join("remote-control.json");
    let before=fs::read(&path).unwrap();t.changed_node=true;
    assert!(tick(&f.store,&mut record,&mut state,&mut hooks,&mut t,false).is_err());
    assert_eq!(fs::read(path).unwrap(),before);assert_eq!(hooks.renew,0);assert_eq!(t.starts,1);
}

#[test]
fn response_requires_original_node_spec_nonce_root_and_deadline(){
    let f=Fixture::new();let mut t=f.transport();
    let req=request(&f.record,RemoteAction::Prepare{controller_payload_hash:f.record.payload_hash.clone(),
        command:match &f.record.request{ExecutionRequest::RemoteStart(s)=>s.command(),_=>panic!()}}).unwrap();
    let ExecutionRequest::RemoteStart(spec)=&f.record.request else{panic!()};
    let response=t.call(&spec.executor,&req).unwrap();
    response.verify(&req,&f.record,Some(&t.handle)).unwrap();
    for n in 0..8{
        let mut altered=response.clone();
        match n{
            0=>altered.request_id="0".repeat(64),
            1=>altered.observation.handle.nonce="e".repeat(64),
            2=>altered.observation.handle.root_inode+=1,
            3=>altered.observation.handle.deadline_boot_ms+=1,
            4=>altered.observation.handle.controller_payload_hash="f".repeat(64),
            5=>altered.observation.snapshot.record.node_ref="controller-node".into(),
            6=>altered.observation.snapshot.record.principal_ref="foreign-principal".into(),
            _=>altered.observation.snapshot.record.request=ExecutionRequest::Start(StartRequest{argv:vec!["/bin/false".into()],..spec.command()}),
        }
        assert!(altered.verify(&req,&f.record,Some(&t.handle)).is_err(),"case {n}");
    }
}

#[test]
fn immutable_permit_does_not_extend_with_retries_latency_or_boot_changes(){
    let p=StartPermit{boot_id:"boot-one".into(),observed_boot_ms:1000,expires_boot_ms:3000};
    assert!(p.validate("boot-one",2999,5000).is_ok());
    assert!(p.validate("boot-one",3000,5000).is_err());
    assert!(p.validate("boot-two",2000,5000).is_err());
    assert!(p.validate("boot-one",999,5000).is_err());
    assert!(p.validate("boot-one",2000,2500).is_err());
    assert!(StartPermit{expires_boot_ms:9000,..p}.validate("boot-one",2000,10000).is_err());
}

#[test]
fn unsupported_deadline_or_changed_pin_fails_before_execution_directory(){
    let f=Fixture::new();let ExecutionRequest::RemoteStart(mut spec)=f.record.request.clone()else{panic!()};
    spec.request_key="unsupported".into();spec.executor.deadline_capability=RemoteDeadlineCapability::Unsupported;
    let id=execution_ref_for(&spec.principal_ref,&spec.session_ref,&spec.request_key);
    assert_eq!(f.store.prepare_remote_start(spec.clone()).unwrap_err().kind(),io::ErrorKind::Unsupported);
    assert!(!f.store.execution_directory(&id).unwrap().exists());
    spec.executor.deadline_capability=RemoteDeadlineCapability::LinuxBootWatchdogV1;
    fs::write(&spec.executor.transport.bridge,b"changed binary").unwrap();
    assert!(f.store.prepare_remote_start(spec).is_err());assert!(!f.store.execution_directory(&id).unwrap().exists());
}

#[test]
fn controller_reboot_does_not_prove_remote_completion(){
    let f=Fixture::new();let mut record=f.record.clone();record.state=ExecutionState::Running;
    record.worker=Some(ProcessIdentity{node_ref:record.node_ref.clone(),boot_id:"old-controller-boot".into(),pid:1,start_ticks:1});
    f.store.save_record(&record).unwrap();
    let observed=f.store.reconcile(&record.execution_ref).unwrap();
    assert!(observed.record.receipt.is_none());assert!(!observed.confirmed_live);
    assert_eq!(observed.observation,ExecutionObservation::Unknown);
}

#[test]
fn delayed_live_response_does_not_renew_or_reset_freshness(){
    let f=Fixture::new();let mut t=f.transport();let mut record=f.record.clone();let mut state=f.state();let mut hooks=Hooks::default();
    assert!(!tick(&f.store,&mut record,&mut state,&mut hooks,&mut t,true).unwrap());
    let previous=state.observation.as_ref().unwrap().received_at_unix_ms;
    t.delay_ms=2_050;
    assert!(tick(&f.store,&mut record,&mut state,&mut hooks,&mut t,false).is_err());
    assert_eq!(hooks.renew,0);assert_eq!(state.observation.as_ref().unwrap().received_at_unix_ms,previous);
    assert_eq!(t.starts,1);
}

#[test]
fn a_bridge_that_never_reads_stdin_has_a_bounded_timeout(){
    let mut command=Command::new("/bin/sh");command.args(["-c","exec /bin/sleep 5"]);
    let started=Instant::now();
    assert!(bounded_bridge_io(command,&vec![b'x';65_536],Duration::from_millis(120)).is_err());
    assert!(started.elapsed()<Duration::from_secs(1));
}

#[test]
fn a_descendant_retaining_stdout_does_not_block_bridge_completion(){
    let f=Fixture::new();let pid_file=f.root.join("pipe-holder.pid");
    let mut command=Command::new("/bin/sh");
    command.args(["-c","/bin/sleep 2 & printf '%s' \"$!\" > \"$1\"; printf '{}'","fixture"])
        .arg(&pid_file);
    let started=Instant::now();
    assert_eq!(bounded_bridge_io(command,b"",Duration::from_millis(500)).unwrap(),b"{}");
    assert!(started.elapsed()<Duration::from_secs(1));
    // Observe the exact short-lived fixture child until gone. No PID-only kill
    // and no background fixture process is left behind when the test returns.
    let pid=fs::read_to_string(pid_file).unwrap().parse::<u32>().unwrap();
    let identity=capture_process(pid,"fixture-node").unwrap();
    while observe_process(&identity)==ProcessObservation::Alive && started.elapsed()<Duration::from_secs(4){
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(observe_process(&identity),ProcessObservation::Gone);
}
