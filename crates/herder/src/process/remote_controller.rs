use super::{remote::*, storage::{atomic_json, read_json}, *};
use serde::{Deserialize, Serialize};
use std::{io::{self, Read, Write}, path::Path, process::{Command, Stdio}, time::{Duration, Instant}};

const MAX_LIVE_PROOF_AGE: Duration = Duration::from_secs(2);

trait RemoteTransport {
    fn call(&mut self, executor: &RemoteExecutorConfig, request: &RemoteRequest) -> io::Result<RemoteResponse>;
}
struct FleetBridge;
impl RemoteTransport for FleetBridge {
    fn call(&mut self, executor: &RemoteExecutorConfig, request: &RemoteRequest) -> io::Result<RemoteResponse> {
        executor.verify_local_transport()?;
        let input = serde_json::to_vec(&serde_json::json!({"version":1,"transport":executor.transport,
            "worker":executor.worker,"endpoint_config":executor.endpoint_config,
            "endpoint_config_sha256":executor.endpoint_config_sha256,"request":request})).map_err(io::Error::other)?;
        if input.len() > 65_536 { return Err(invalid("remote_request_limit")); }
        let mut command=Command::new(&executor.transport.node_binary);
        command.arg(&executor.transport.bridge).env_clear();
        let bytes=bounded_bridge_io(command,&input,Duration::from_secs(20))?;
        serde_json::from_slice(&bytes).map_err(|_|invalid("remote_response_invalid"))
    }
}

/// Pipe EOF is not a completion requirement: an unexpected descendant may
/// retain the descriptor. All reads/writes are nonblocking and bounded; every
/// early error owns and terminates the original child without a blocking join.
fn bounded_bridge_io(mut command:Command,input:&[u8],timeout:Duration)->io::Result<Vec<u8>>{
    use std::os::fd::AsRawFd;
    struct OwnedChild(Option<std::process::Child>);
    impl Drop for OwnedChild{
        fn drop(&mut self){if let Some(mut child)=self.0.take(){
            if matches!(child.try_wait(),Ok(Some(_))){return}
            let _=child.kill();
            let _=std::thread::Builder::new().name("herder-remote-bridge-reaper".into())
                .spawn(move||{let _=child.wait();});
        }}
    }
    fn nonblocking(fd:i32)->io::Result<()>{
        let flags=unsafe{libc::fcntl(fd,libc::F_GETFL)};
        if flags<0 || unsafe{libc::fcntl(fd,libc::F_SETFL,flags|libc::O_NONBLOCK)}<0{
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    let mut child=OwnedChild(Some(command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?));
    let process=child.0.as_mut().expect("owned child");
    let mut stdin=process.stdin.take();
    let mut stdout=process.stdout.take().ok_or_else(||invalid("remote_transport_unavailable"))?;
    nonblocking(stdin.as_ref().ok_or_else(||invalid("remote_transport_unavailable"))?.as_raw_fd())?;
    nonblocking(stdout.as_raw_fd())?;
    let until=Instant::now()+timeout;let mut written=0;let mut output=Vec::new();
    loop{
        if let Some(stream)=stdin.as_mut(){
            match stream.write(&input[written..]){
                Ok(n)=>written+=n,
                Err(e)if matches!(e.kind(),io::ErrorKind::WouldBlock|io::ErrorKind::Interrupted)=>(),
                Err(_)=>return Err(invalid("remote_transport_unavailable")),
            }
            if written==input.len(){stdin=None;}
        }
        let mut buffer=[0u8;8192];
        loop{match stdout.read(&mut buffer){
            Ok(0)=>break,
            Ok(n)=>{output.extend_from_slice(&buffer[..n]);if output.len()>131_072{return Err(invalid("remote_response_limit"));}},
            Err(e)if e.kind()==io::ErrorKind::Interrupted=>continue,
            Err(e)if e.kind()==io::ErrorKind::WouldBlock=>break,
            Err(_)=>return Err(invalid("remote_transport_unavailable")),
        }}
        if let Some(status)=process.try_wait()?{
            if !status.success() || written!=input.len(){return Err(invalid("remote_transport_unavailable"));}
            // Drain bytes already available after exit, but do not wait for EOF.
            loop{match stdout.read(&mut buffer){
                Ok(0)=>break,
                Ok(n)=>{output.extend_from_slice(&buffer[..n]);if output.len()>131_072{return Err(invalid("remote_response_limit"));}},
                Err(e)if e.kind()==io::ErrorKind::Interrupted=>continue,
                Err(e)if e.kind()==io::ErrorKind::WouldBlock=>break,
                Err(_)=>return Err(invalid("remote_transport_unavailable")),
            }}
            return Ok(output);
        }
        if Instant::now()>=until{return Err(invalid("remote_transport_timeout"));}
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct VerifiedObservation {
    request: RemoteRequest,
    response: RemoteResponse,
    received_at_unix_ms: u64,
    request_started_at_unix_ms: u64,
    round_trip_ms: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlState {
    version: u8,
    controller_node_ref: String,
    execution_ref: String,
    controller_payload_hash: String,
    handle: Option<RemoteHandle>,
    /// Saved before the only start RPC. Reconnect can never reset this bit.
    start_dispatched: bool,
    start_permit: Option<StartPermit>,
    observation: Option<VerifiedObservation>,
    terminal_observed_at_unix_ms: Option<u64>,
}
fn load_state(store:&ExecutionStore,record:&ExecutionRecord)->io::Result<ControlState>{
    let state:ControlState=read_json(&store.execution_directory(&record.execution_ref)?.join("remote-control.json"))?;
    if state.version!=1 || state.controller_node_ref!=record.node_ref
        || state.execution_ref!=record.execution_ref || state.controller_payload_hash!=record.payload_hash
        || state.start_dispatched != state.start_permit.is_some() {
        return Err(invalid("remote_controller_identity_mismatch"));
    }
    if let Some(observed)=&state.observation {
        observed.response.verify(&observed.request,record,state.handle.as_ref())?;
    }
    Ok(state)
}
fn save_state(store:&ExecutionStore,record:&ExecutionRecord,state:&ControlState)->io::Result<()>{
    atomic_json(&store.execution_directory(&record.execution_ref)?.join("remote-control.json"),state)
}
fn request(record:&ExecutionRecord,operation:RemoteAction)->io::Result<RemoteRequest>{
    let ExecutionRequest::RemoteStart(spec)=&record.request else{return Err(invalid("remote_controller_request_mismatch"))};
    Ok(RemoteRequest {version:REMOTE_VERSION,request_id:random_id()?,controller_node_ref:record.node_ref.clone(),
        executor_node_ref:spec.executor.node_ref.clone(),executor_ref:spec.executor.executor_ref.clone(),operation})
}
fn observe(transport:&mut dyn RemoteTransport,store:&ExecutionStore,record:&ExecutionRecord,
    state:&mut ControlState,operation:RemoteAction)->io::Result<RemoteObservation>{
    let ExecutionRequest::RemoteStart(spec)=&record.request else{return Err(invalid("remote_controller_request_mismatch"))};
    let request=request(record,operation)?;
    let request_started_at_unix_ms=unix_millis()?;
    let sent=Instant::now();
    let response=transport.call(&spec.executor,&request)?;
    let elapsed=sent.elapsed();
    response.verify(&request,record,state.handle.as_ref())?;
    if response.observation.snapshot.confirmed_live && elapsed>MAX_LIVE_PROOF_AGE{
        return Err(invalid("remote_live_proof_too_old"));
    }
    if state.handle.is_none(){state.handle=Some(response.observation.handle.clone())}
    let observed=response.observation.clone();
    let now=unix_millis()?;
    state.observation=Some(VerifiedObservation{request,response,received_at_unix_ms:now,
        request_started_at_unix_ms,round_trip_ms:elapsed.as_millis().try_into().unwrap_or(u64::MAX)});
    if observed.snapshot.record.receipt.is_some() && state.terminal_observed_at_unix_ms.is_none(){
        state.terminal_observed_at_unix_ms=Some(now);
    }
    save_state(store,record,state)?;
    Ok(observed)
}

pub(crate) fn run(store:&ExecutionStore,mut record:ExecutionRecord,hooks:&mut dyn ExecutionHooks)->io::Result<WorkerOutcome>{
    let mut transport=FleetBridge;
    let can_start=record.state==ExecutionState::Prepared;
    let mut state=match load_state(store,&record){
        Ok(v)=>v,
        Err(e) if e.kind()==io::ErrorKind::NotFound && can_start=>ControlState{
            version:1,controller_node_ref:record.node_ref.clone(),execution_ref:record.execution_ref.clone(),
            controller_payload_hash:record.payload_hash.clone(),handle:None,start_dispatched:false,
            start_permit:None,observation:None,terminal_observed_at_unix_ms:None},
        Err(e)=>return Err(e),
    };
    save_state(store,&record,&state)?;
    record.worker=Some(capture_process(std::process::id(),store.node_ref())?);
    record.state=ExecutionState::Starting;
    record.heartbeat_at_unix_ms=None;
    // A remote PID is never placed into the controller's local process fields.
    record.process=None;record.tree_scope=None;record.observed_members.clear();
    store.save_record(&record)?;
    loop {
        match tick(store,&mut record,&mut state,hooks,&mut transport,can_start){
            Ok(true)=>return Ok(WorkerOutcome::Completed),
            Ok(false)=>(),
            Err(_)=>{
                // Network loss is neither termination nor permission to renew.
                record.state=ExecutionState::Unknown;record.heartbeat_at_unix_ms=None;
                record.observation_detail=Some("remote observation unavailable; no renewal or start replay; durable occupancy retained".into());
                store.save_record(&record)?;
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn tick(store:&ExecutionStore,record:&mut ExecutionRecord,state:&mut ControlState,hooks:&mut dyn ExecutionHooks,
    transport:&mut dyn RemoteTransport,can_start:bool)->io::Result<bool>{
    let ExecutionRequest::RemoteStart(spec)=record.request.clone() else{return Err(invalid("remote_controller_request_mismatch"))};
    let mut observed=if let Some(handle)=state.handle.clone(){
        observe(transport,store,record,state,RemoteAction::Reconcile{handle})?
    }else{
        // Repeating preparation only recovers a durable handle; it cannot run argv.
        observe(transport,store,record,state,RemoteAction::Prepare{
            controller_payload_hash:record.payload_hash.clone(),command:spec.command()})?
    };
    if let Some(receipt)=observed.snapshot.record.receipt.clone(){
        store.finish(record,receipt)?;
        super::worker::finalize_hooks(store,record,hooks)?;
        return Ok(true);
    }
    let handle=state.handle.clone().ok_or_else(||invalid("remote_handle_missing"))?;
    if store.cancellation_requested(&record.execution_ref)? || (!can_start && !state.start_dispatched){
        observed=observe(transport,store,record,state,RemoteAction::Cancel{handle})?;
    }else if !state.start_dispatched{
        if hooks.before_spawn(record).is_err(){
            store.cancel(&record.execution_ref)?;
            observed=observe(transport,store,record,state,RemoteAction::Cancel{handle})?;
            if let Some(receipt)=observed.snapshot.record.receipt{
                store.finish(record,receipt)?;
                super::worker::finalize_hooks(store,record,hooks)?;
                return Ok(true);
            }
            return Err(invalid("remote_start_authorization_unavailable"));
        }
        let valid_for=hooks.launch_valid_for_ms(record)?.min(MAX_PERMIT_MS);
        if valid_for==0 {return Err(invalid("remote_start_authorization_expired"))}
        let expires=observed.observed_boot_ms.saturating_add(valid_for).min(handle.deadline_boot_ms);
        let permit=StartPermit{boot_id:observed.observed_boot_id.clone(),observed_boot_ms:observed.observed_boot_ms,
            expires_boot_ms:expires};
        permit.validate(&handle.boot_id,observed.observed_boot_ms,handle.deadline_boot_ms)?;
        state.start_dispatched=true;state.start_permit=Some(permit.clone());
        save_state(store,record,state)?;
        // This is the only dispatch. A timeout leaves start_dispatched durable.
        observed=observe(transport,store,record,state,RemoteAction::Start{handle,permit})?;
    }else if observed.snapshot.confirmed_live{
        if hooks.tick(record).is_err(){
            // Exact remote handle cancellation is safe to retry. The immutable
            // remote deadline independently limits a network partition.
            store.cancel(&record.execution_ref)?;
            observed=observe(transport,store,record,state,RemoteAction::Cancel{handle})?;
        }
    }
    if let Some(receipt)=observed.snapshot.record.receipt.clone(){
        store.finish(record,receipt)?;
        super::worker::finalize_hooks(store,record,hooks)?;
        return Ok(true);
    }
    record.started_at_unix_ms=observed.snapshot.record.started_at_unix_ms;
    record.state=if observed.snapshot.confirmed_live{ExecutionState::Running}else{ExecutionState::Unknown};
    record.heartbeat_at_unix_ms=if observed.snapshot.confirmed_live{Some(unix_millis()?)}else{None};
    record.observation_detail=Some(if observed.snapshot.confirmed_live{
        "verified remote execution is live; controller and executor identities remain distinct"
    }else{"remote execution is not proven live; no command replay and no lease renewal"}.into());
    store.save_record(record)?;
    Ok(false)
}

pub(crate) fn confirmed_live(store:&ExecutionStore,record:&ExecutionRecord)->io::Result<bool>{
    let state=match load_state(store,record){Ok(s)=>s,Err(e)if e.kind()==io::ErrorKind::NotFound=>return Ok(false),Err(e)=>return Err(e)};
    Ok(state.observation.is_some_and(|o|o.response.observation.snapshot.confirmed_live
        && o.round_trip_ms<=MAX_LIVE_PROOF_AGE.as_millis() as u64
        && unix_millis().is_ok_and(|now|now>=o.request_started_at_unix_ms && now-o.request_started_at_unix_ms<=5_000)))
}
pub fn remote_terminal_observed_at(record:&ExecutionRecord,dir:&Path)->io::Result<Option<u64>>{
    if !matches!(record.request,ExecutionRequest::RemoteStart(_)){return Ok(None)}
    let state:ControlState=read_json(&dir.join("remote-control.json"))?;
    if state.controller_node_ref!=record.node_ref || state.controller_payload_hash!=record.payload_hash
        || state.execution_ref!=record.execution_ref{return Err(invalid("remote_controller_identity_mismatch"))}
    let observation=state.observation.ok_or_else(||invalid("remote_terminal_evidence_missing"))?;
    observation.response.verify(&observation.request,record,state.handle.as_ref())?;
    if observation.response.observation.snapshot.record.receipt!=record.receipt {
        return Err(invalid("remote_terminal_receipt_mismatch"));
    }
    state.terminal_observed_at_unix_ms.map(Some).ok_or_else(||invalid("remote_terminal_evidence_missing"))
}
pub fn remote_source_evidence(store:&ExecutionStore,record:&ExecutionRecord)->io::Result<Option<serde_json::Value>>{
    match load_state(store,record){
        Ok(state)=>Ok(state.observation.map(|o|serde_json::json!({
            "remote_handle":o.response.observation.handle,
            "controller_node":record.node_ref,"executor_node":record.executor_node_ref(),
            "remote_source":o.response.observation.source,
            "received_at_unix_ms":o.received_at_unix_ms}))),
        Err(e)if e.kind()==io::ErrorKind::NotFound=>Ok(None),Err(e)=>Err(e),
    }
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;
