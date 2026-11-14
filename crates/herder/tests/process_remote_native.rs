//! Opt-in infrastructure canary. This test is ignored by every ordinary suite.
//! A reviewed private config must pin both installed endpoints and the existing
//! Fleet credential generation. It never opens or resumes a native agent.
#![cfg(target_os = "linux")]
use herder::{
    application::process_bindings::{ProcessRuntimeConfig, write_delegation},
    domain::{address::{Authorization, SessionRef}, resource::{ResourceClaim, ResourceDescriptor, ResourceKind, ResourceRef, ResourceScope}},
    mcp::catalog::{ProcessLeaseBinding, ProcessLeaseExit},
    ownership::{claim, resource},
    process::{self, ExecutionStore, remote::RemoteStartRequest},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, os::unix::fs::{MetadataExt, OpenOptionsExt}, path::{Path, PathBuf}, time::{Duration, Instant}};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    version:u8,
    runtime:ProcessRuntimeConfig,
    controller_worker_sha256:String,
    principal:String,
    session_ref:String,
    request_key:String,
    resource_ref:String,
    claim_id:String,
    executor_ref:String,
    argv:Vec<String>,
    cwd:PathBuf,
    deadline_unix_ms:u64,
    ttl_seconds:u64,
    timeout_seconds:u64,
}
fn hash(bytes:&[u8])->String{Sha256::digest(bytes).iter().map(|b|format!("{b:02x}")).collect()}
fn private(path:&Path,directory:bool){
    assert!(path.is_absolute());assert_eq!(path.canonicalize().unwrap(),path);
    let m=fs::symlink_metadata(path).unwrap();
    assert_eq!(m.uid(),unsafe{libc::geteuid()});assert_eq!(m.mode()&0o077,0);
    assert_eq!(m.is_dir(),directory);if !directory{assert!(m.is_file());assert_eq!(m.nlink(),1);}
}
fn write_summary(path:&Path,value:&serde_json::Value){
    let mut file=fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path).unwrap();
    file.write_all(&serde_json::to_vec_pretty(value).unwrap()).unwrap();file.write_all(b"\n").unwrap();
    file.sync_all().unwrap();fs::File::open(path.parent().unwrap()).unwrap().sync_all().unwrap();
}

#[test]
#[ignore = "requires reviewed HERDER_REMOTE_CANARY_CONFIG and real pinned remote executor"]
fn remote_owned_job_native_canary(){
    let path=PathBuf::from(std::env::var_os("HERDER_REMOTE_CANARY_CONFIG")
        .expect("set the reviewed absolute private HERDER_REMOTE_CANARY_CONFIG"));
    private(&path,false);
    let config_bytes=fs::read(&path).unwrap();let config:Config=serde_json::from_slice(&config_bytes).unwrap();
    assert_eq!(config.version,1);config.runtime.validate().unwrap();
    assert!(config.runtime.administrators.contains(&config.principal));
    assert!(config.resource_ref.starts_with("remote-canary-"));
    assert!(config.request_key.starts_with("remote-canary-"));
    assert!((10..=60).contains(&config.ttl_seconds));
    assert!((40..=180).contains(&config.timeout_seconds));
    let now_ms=process::unix_millis().unwrap();
    assert!(config.deadline_unix_ms>now_ms+(config.ttl_seconds+5)*1000);
    assert!(config.deadline_unix_ms<=now_ms+config.timeout_seconds*1000);
    private(&config.runtime.resources.root,true);
    let worker=&config.runtime.worker;
    assert_eq!(worker.canonicalize().unwrap(),*worker);
    let mode=fs::symlink_metadata(worker).unwrap();assert!(mode.is_file());assert_eq!(mode.mode()&0o022,0);
    assert!(mode.uid()==unsafe{libc::geteuid()} || mode.uid()==0);
    assert_eq!(hash(&fs::read(worker).unwrap()),config.controller_worker_sha256);
    let executor=config.runtime.remote_executors.iter().find(|e|e.executor_ref==config.executor_ref).unwrap().clone();
    executor.verify_local_transport().unwrap();
    assert_ne!(config.runtime.node_ref,executor.node_ref);
    // Standing staging exclusion: this canary has no fleet-wide discovery or
    // fallback route. The reviewed exact target is the only remote destination.
    assert!(!executor.transport.target.to_ascii_lowercase().contains("airlock"));
    let store=ExecutionStore::open(&config.runtime.execution_root,&config.runtime.node_ref).unwrap();
    let execution_ref=process::execution_ref_for(&config.principal,&config.session_ref,&config.request_key);
    let dir=store.execution_directory(&execution_ref).unwrap();
    assert!(!dir.exists(),"existing canary must be reconciled, never rerun with this driver");
    let reference=ResourceRef(config.resource_ref.clone());
    let descriptor=resource::register_or_update(&config.runtime.resources,ResourceDescriptor::new(
        reference.clone(),ResourceScope::Global,ResourceKind::Other("remote-build-canary".into()),
        format!("herder-remote-canary:{}",config.resource_ref),config.runtime.resources.storage_id.0.clone(),None,0),
        Authorization::Authorized,None).unwrap();
    let acquired=claim::now_seconds().unwrap();let original_expiry=acquired+config.ttl_seconds;
    assert_eq!(claim::claim(&config.runtime.resources,&reference,Authorization::Authorized,ResourceClaim{
        resource_ref:reference.clone(),principal_ref:config.principal.clone(),session_ref:Some(SessionRef(config.session_ref.clone())),
        claim_id:config.claim_id.clone(),purpose:"isolated remote process infrastructure canary".into(),
        acquired_at:format!("unix-seconds:{acquired}"),expires_at:Some(format!("unix-seconds:{original_expiry}")),
    }).unwrap(),claim::ClaimOutcome::Acquired);
    let record=store.prepare_remote_start(RemoteStartRequest{
        principal_ref:config.principal.clone(),session_ref:config.session_ref.clone(),request_key:config.request_key.clone(),
        argv:config.argv.clone(),cwd:config.cwd.clone(),deadline_unix_ms:config.deadline_unix_ms,stop_grace_ms:1_000,
        executor:executor.clone(),
    }).unwrap();
    write_delegation(&store,&record.execution_ref,&config.principal,&config.runtime.resources,vec![ProcessLeaseBinding{
        resource_ref:reference.clone(),claim_id:config.claim_id.clone(),revision:descriptor.revision,
        ttl_seconds:config.ttl_seconds,on_exit:ProcessLeaseExit::Release,handback_seconds:None,
    }]).unwrap();
    store.launch_prepared(&record.execution_ref,worker).unwrap();
    println!("{}",serde_json::json!({"event":"remote_canary_registered","execution_ref":record.execution_ref,
        "controller_node":config.runtime.node_ref,"executor_node":executor.node_ref,"config_sha256":hash(&config_bytes)}));
    let begin=Instant::now();let mut survived_original_expiry=false;
    let completed=loop{
        let snapshot=store.reconcile(&record.execution_ref).unwrap();
        if snapshot.record.receipt.is_some() && !snapshot.record.finalization_pending{break snapshot.record}
        if !snapshot.worker_lock_held && (snapshot.record.receipt.is_none() || snapshot.record.finalization_pending){
            // Same recovery seam as the automation owner: only an observer is
            // restarted, and durable start_dispatched prevents another command.
            store.launch_prepared(&record.execution_ref,worker).unwrap();
        }
        if snapshot.confirmed_live && claim::now_seconds().unwrap()>original_expiry{
            let current=claim::read_live_by_claim_id(&config.runtime.resources,&reference,Authorization::Authorized,
                &config.claim_id).unwrap().expect("canonical claim expired while remote command was live");
            assert_eq!(current.principal_ref,config.principal);
            assert!(claim::parse_expiry_seconds(current.expires_at.as_ref().unwrap()).unwrap()>original_expiry);
            survived_original_expiry=true;
        }
        if begin.elapsed()>Duration::from_secs(config.timeout_seconds){
            let _=store.cancel(&record.execution_ref);
            write_summary(&dir.join("canary-timeout.json"),&serde_json::json!({"version":1,
                "execution_ref":record.execution_ref,"outcome":"unknown","occupancy":"retained_until_exact_terminal_proof"}));
            panic!("remote canary timeout; exact execution cancelled if reachable, evidence retained");
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    let receipt=completed.receipt.as_ref().unwrap();
    let control:serde_json::Value=serde_json::from_slice(&fs::read(dir.join("remote-control.json")).unwrap()).unwrap();
    assert_eq!(completed.node_ref,config.runtime.node_ref);assert_eq!(receipt.node_ref,executor.node_ref);
    assert!(completed.process.is_none());assert!(completed.observed_members.is_empty());
    assert!(claim::read_current(&config.runtime.resources,&reference,Authorization::Authorized).unwrap().is_none(),
        "canonical claim must be released only after whole-tree finalization");
    let summary=serde_json::json!({"version":1,"execution_ref":record.execution_ref,
        "controller_node":completed.node_ref,"executor_node":receipt.node_ref,"receipt":receipt,
        "canonical_claim_released":true,"claim_survived_original_expiry":survived_original_expiry,
        "start_dispatched":control["start_dispatched"],"handle":control["handle"],
        "config_sha256":hash(&config_bytes),"controller_worker_sha256":config.controller_worker_sha256,
        "marker_count_verification":"required_by_read_only_executor_check","model_wake":"not_used"});
    write_summary(&dir.join("canary-summary.json"),&summary);
    println!("{}",serde_json::json!({"event":"remote_canary_terminal","execution_ref":record.execution_ref,
        "reason":receipt.reason,"tree_complete":receipt.tree_complete,"claim_survived_original_expiry":survived_original_expiry,
        "canonical_claim_released":true,"summary":dir.join("canary-summary.json")}));
    assert!(receipt.succeeded(),"remote command did not succeed; inspect retained exact receipt, do not rerun");
    assert!(survived_original_expiry,"canary command ended before renewal past its original TTL was observed");
    assert_eq!(control["start_dispatched"],true);
}
