use super::{remote::*, storage::{atomic_json, lock, read_json}, *};
use serde::{Deserialize, Serialize};
use std::{io, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RemoteOrigin {
    pub handle: RemoteHandle,
    pub config: RemoteEndpointConfig,
}

pub(crate) fn origin(store: &ExecutionStore, record: &ExecutionRecord) -> io::Result<Option<RemoteOrigin>> {
    let path = store.execution_directory(&record.execution_ref)?.join("remote-origin.json");
    let v: RemoteOrigin = match read_json(&path) {
        Ok(v) => v, Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None), Err(e) => return Err(e),
    };
    if v.handle.execution_ref != record.execution_ref || v.handle.command_hash != record.payload_hash
        || v.handle.worker_sha256 != v.config.worker_sha256
        || v.handle.executor_node_ref != record.node_ref || v.handle.executor_node_ref != v.config.node_ref
        || v.handle.controller_node_ref != v.config.controller_node_ref
        || v.handle.executor_ref != v.config.executor_ref
        || v.handle.root_device != v.config.root_device || v.handle.root_inode != v.config.root_inode
        || record.request.deadline() != Some(v.handle.deadline_unix_ms)
        || !matches!(record.request, ExecutionRequest::Start(_)) {
        return Err(invalid("remote_origin_identity_mismatch"));
    }
    Ok(Some(v))
}

/// Internal bounded endpoint. This creates/observes executions, never claims.
pub fn remote_endpoint(config_path: &Path, config_hash: &str, request_bytes: &[u8]) -> io::Result<RemoteResponse> {
    if request_bytes.len() > 65_536 { return Err(invalid("remote_request_limit")); }
    let config = RemoteEndpointConfig::load(config_path, config_hash)?;
    let request: RemoteRequest = serde_json::from_slice(request_bytes).map_err(|_| invalid("remote_request_invalid"))?;
    execute(&config, config_hash, &request)
}

fn execute(config: &RemoteEndpointConfig, config_hash: &str, request: &RemoteRequest) -> io::Result<RemoteResponse> {
    hash_string(&request.request_id)?;
    if request.version != REMOTE_VERSION || request.controller_node_ref != config.controller_node_ref
        || request.executor_node_ref != config.node_ref || request.executor_ref != config.executor_ref {
        return Err(invalid("remote_route_identity_mismatch"));
    }
    // Capability is proven on the executor, not inferred from its advertised OS.
    // This check has no process or resource side effects.
    if matches!(request.operation,RemoteAction::Prepare{..}|RemoteAction::Start{..}){
        super::remote_deadline::check_capability(config)?;
    }
    let store = ExecutionStore::from_existing_root(&config.execution_root)?;
    let handle = match &request.operation {
        RemoteAction::Prepare { controller_payload_hash, command } => {
            hash_string(controller_payload_hash)?;
            let deadline = command.deadline_unix_ms.ok_or_else(|| invalid("remote_deadline_required"))?;
            let execution_ref = execution_ref_for(&command.principal_ref, &command.session_ref, &command.request_key);
            let dir = store.execution_directory(&execution_ref)?;
            // prepare_start validates exact local cwd. A symlink alias would change
            // the agreed command hash and is rejected before start authorization.
            if command.cwd.canonicalize()? != command.cwd { return Err(invalid("remote_cwd_not_canonical")); }
            // Existing preparation is recoverable even after its deadline. A new
            // preparation cannot manufacture a fresh horizon with the same key.
            if !dir.join("record.json").exists() {
                let now = unix_millis()?;
                if deadline <= now || deadline - now > config.max_runtime_ms {
                    return Err(invalid("remote_deadline_outside_policy"));
                }
            }
            let record = store.prepare_start(command.clone())?;
            let _guard = lock(&dir.join("remote-control.lock"), true)?.expect("blocking lock");
            let path = dir.join("remote-origin.json");
            match origin(&store, &record)? {
                Some(v) => {
                    if v.handle.controller_payload_hash != *controller_payload_hash || v.config != *config
                        || v.handle.endpoint_config_sha256 != config_hash {
                        return Err(invalid("remote_prepare_idempotency_conflict"));
                    }
                    v.handle
                }
                None => {
                    if record.state != ExecutionState::Prepared || dir.join("launch.json").exists() {
                        return Err(invalid("remote_origin_missing_after_admission"));
                    }
                    let now = unix_millis()?;
                    if deadline <= now || deadline - now > config.max_runtime_ms {
                        return Err(invalid("remote_deadline_outside_policy"));
                    }
                    let handle = RemoteHandle {
                        version: REMOTE_VERSION, controller_node_ref: config.controller_node_ref.clone(),
                        executor_node_ref: config.node_ref.clone(), executor_ref: config.executor_ref.clone(),
                        execution_ref, controller_payload_hash: controller_payload_hash.clone(),
                        command_hash: record.payload_hash.clone(), nonce: random_id()?,
                        worker_sha256:config.worker_sha256.clone(),endpoint_config_sha256:config_hash.into(),
                        root_device: config.root_device, root_inode: config.root_inode,
                        boot_id: capture_process(std::process::id(), &config.node_ref)?.boot_id,
                        deadline_boot_ms: super::remote_deadline::boot_millis()?.checked_add(deadline-now)
                            .ok_or_else(|| invalid("remote_deadline_overflow"))?,
                        deadline_unix_ms: deadline,
                    };
                    atomic_json(&path, &RemoteOrigin { handle: handle.clone(), config: config.clone() })?;
                    crate::application::process_evidence::capture_source(&store, &record)?;
                    handle
                }
            }
        }
        RemoteAction::Start { handle, permit } => {
            let dir = store.execution_directory(&handle.execution_ref)?;
            let _gate = lock(&dir.join("remote-control.lock"), true)?.expect("blocking lock");
            verify_handle(&store, config, handle)?;
            let marker = dir.join("remote-start-permit.json");
            match read_json::<StartPermit>(&marker) {
                Ok(previous) => {
                    // A lost ACK never repeats launch, even if the first caller
                    // died after saving intent but before submitting the unit.
                    if previous != *permit { return Err(invalid("remote_start_already_attempted")); }
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    let boot = capture_process(std::process::id(), &config.node_ref)?.boot_id;
                    permit.validate(&boot, super::remote_deadline::boot_millis()?, handle.deadline_boot_ms)?;
                    if boot != handle.boot_id { return Err(invalid("remote_boot_changed")); }
                    atomic_json(&marker, permit)?;
                    store.launch_prepared_with_backend(&handle.execution_ref, &config.worker, WorkerBackend::SystemdUser)?;
                }
                Err(e) => return Err(e),
            }
            handle.clone()
        }
        RemoteAction::Status { handle } | RemoteAction::Reconcile { handle } | RemoteAction::Cancel { handle } => {
            verify_handle(&store, config, handle)?;
            if matches!(request.operation, RemoteAction::Cancel { .. }) {
                match store.try_cancel_unlaunched(&handle.execution_ref)? {
                    UnlaunchedCancellation::NotProven(_)=>{store.cancel(&handle.execution_ref)?;}
                    _=>(),
                }
            }
            handle.clone()
        }
    };
    let snapshot = if matches!(request.operation, RemoteAction::Reconcile { .. }) {
        // A saved start permit that expired before supervisor admission can
        // never authorize a later spawn. The normal launch gate proves absence.
        let permit_path=store.execution_directory(&handle.execution_ref)?.join("remote-start-permit.json");
        if let Ok(permit)=read_json::<StartPermit>(&permit_path) {
            let boot=capture_process(std::process::id(),&config.node_ref)?.boot_id;
            if permit.validate(&boot,super::remote_deadline::boot_millis()?,handle.deadline_boot_ms).is_err(){
                let _=store.try_cancel_unlaunched(&handle.execution_ref)?;
            }
        }
        store.reconcile(&handle.execution_ref)?
    } else { store.status(&handle.execution_ref)? };
    let source = crate::application::process_evidence::capture_source(&store, &snapshot.record)?;
    Ok(RemoteResponse {
        version: REMOTE_VERSION, request_id: request.request_id.clone(),
        controller_node_ref: config.controller_node_ref.clone(), executor_node_ref: config.node_ref.clone(),
        executor_ref: config.executor_ref.clone(), observation: RemoteObservation {
            handle, observed_boot_id: capture_process(std::process::id(), &config.node_ref)?.boot_id,
            observed_boot_ms: super::remote_deadline::boot_millis()?, snapshot, source,
        },
    })
}

fn verify_handle(store: &ExecutionStore, config: &RemoteEndpointConfig, handle: &RemoteHandle) -> io::Result<()> {
    let record = store.load_record(&handle.execution_ref)?;
    let saved = origin(store, &record)?.ok_or_else(|| invalid("remote_origin_missing"))?;
    if saved.handle != *handle || saved.config != *config { return Err(invalid("remote_handle_mismatch")); }
    Ok(())
}
