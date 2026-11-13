use super::{
    ExecutionStore, linux,
    storage::{lock, open_private},
    types::*,
    unix_millis,
};
use std::{
    io,
    os::unix::process::{CommandExt, ExitStatusExt},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

/// Hooks are implemented by Herder's resource/automation controller. The process
/// supervisor cannot acquire claims or deliver messages on its own.
pub trait ExecutionHooks {
    fn before_spawn(&mut self, _record: &ExecutionRecord) -> io::Result<()> {
        Ok(())
    }
    fn tick(&mut self, _record: &ExecutionRecord) -> io::Result<()> {
        Ok(())
    }
    /// The immutable completion receipt is already durable when this is called.
    /// This hook must be idempotent; failed finalization is persisted and retried.
    fn terminal(
        &mut self,
        _record: &ExecutionRecord,
        _receipt: &CompletionReceipt,
    ) -> io::Result<()> {
        Ok(())
    }
}
pub struct NoopHooks;
impl ExecutionHooks for NoopHooks {}

fn bounded_detail(value: impl ToString) -> String {
    value.to_string().chars().take(1200).collect()
}

pub fn run_worker(store: &ExecutionStore, execution_ref: &str) -> io::Result<WorkerOutcome> {
    run_worker_with_hooks(store, execution_ref, &mut NoopHooks)
}
pub fn run_worker_with_hooks(
    store: &ExecutionStore,
    execution_ref: &str,
    hooks: &mut dyn ExecutionHooks,
) -> io::Result<WorkerOutcome> {
    let directory = store.execution_directory(execution_ref)?;
    let Some(_worker_lock) = lock(&directory.join("worker.lock"), false)? else {
        return Ok(WorkerOutcome::AlreadyRunning);
    };
    let mut record = store.load_record(execution_ref)?;
    if record.receipt.is_some() {
        if record.finalization_pending {
            finalize_hooks(store, &mut record, hooks)?;
        }
        return Ok(WorkerOutcome::Completed);
    }
    if record.state != ExecutionState::Prepared {
        // Starting was recorded before any OS spawn. Absence of a process receipt
        // cannot prove that the command never ran, so this boundary never replays.
        record.state = ExecutionState::Unknown;
        record.observation_detail = Some(
            "previous supervisor interrupted; reconcile original execution instead of replay"
                .into(),
        );
        store.save_record(&record)?;
        return Ok(WorkerOutcome::NoReplayUnknown);
    }
    record.worker = Some(linux::capture_process(
        std::process::id(),
        store.node_ref(),
    )?);
    record.tree_scope = linux::capture_owned_scope(execution_ref)?;
    record.heartbeat_at_unix_ms = Some(unix_millis()?);
    record.state = ExecutionState::Starting;
    store.save_record(&record)?;
    if let Err(error) = hooks.before_spawn(&record) {
        let tree_complete = matches!(record.request, ExecutionRequest::Start(_));
        finish(
            store,
            &mut record,
            hooks,
            CompletionReason::LeaseLost,
            tree_complete,
            false,
            Some(bounded_detail(error)),
        )?;
        return Ok(WorkerOutcome::Completed);
    }
    match record.request.clone() {
        ExecutionRequest::Start(request) => supervise_command(store, record, request, hooks),
        ExecutionRequest::Attach(request) => watch_existing(store, record, request, hooks),
    }
}

fn finalize_hooks(
    store: &ExecutionStore,
    record: &mut ExecutionRecord,
    hooks: &mut dyn ExecutionHooks,
) -> io::Result<()> {
    let receipt = record
        .receipt
        .as_ref()
        .ok_or_else(|| io::Error::other("missing completion receipt"))?
        .clone();
    let result = hooks.terminal(record, &receipt);
    record.finalization_pending = result.is_err();
    record.finalization_error = result.as_ref().err().map(bounded_detail);
    store.save_record(record)?;
    result
}
fn finish(
    store: &ExecutionStore,
    record: &mut ExecutionRecord,
    hooks: &mut dyn ExecutionHooks,
    reason: CompletionReason,
    tree_complete: bool,
    descendant_failure: bool,
    detail: Option<String>,
) -> io::Result<()> {
    let directory = store.execution_directory(&record.execution_ref)?;
    let receipt = CompletionReceipt {
        execution_ref: record.execution_ref.clone(),
        node_ref: record.node_ref.clone(),
        reason,
        started_at_unix_ms: record.started_at_unix_ms,
        finished_at_unix_ms: unix_millis()?,
        exit_code: record.root_exit.as_ref().and_then(|v| v.exit_code),
        signal: record.root_exit.as_ref().and_then(|v| v.signal),
        descendant_failure,
        tree_complete,
        process_may_be_running: !tree_complete,
        evidence_source: if matches!(record.request, ExecutionRequest::Start(_)) {
            "herder_worker_waitpid_subreaper".into()
        } else {
            "herder_exact_process_identity_observer".into()
        },
        stdout_path: directory.join("stdout.log"),
        stderr_path: directory.join("stderr.log"),
        detail,
    };
    store.finish(record, receipt)?;
    finalize_hooks(store, record, hooks)
}

fn supervise_command(
    store: &ExecutionStore,
    mut record: ExecutionRecord,
    request: StartRequest,
    hooks: &mut dyn ExecutionHooks,
) -> io::Result<WorkerOutcome> {
    if store.cancellation_requested(&record.execution_ref)? {
        finish(
            store,
            &mut record,
            hooks,
            CompletionReason::Cancelled,
            true,
            false,
            Some("cancelled before command spawn".into()),
        )?;
        return Ok(WorkerOutcome::Completed);
    }
    if request
        .deadline_unix_ms
        .is_some_and(|v| unix_millis().is_ok_and(|now| now >= v))
    {
        finish(
            store,
            &mut record,
            hooks,
            CompletionReason::TimedOut,
            true,
            false,
            Some("absolute deadline reached before command spawn".into()),
        )?;
        return Ok(WorkerOutcome::Completed);
    }
    if let Err(error) = linux::become_subreaper() {
        finish(
            store,
            &mut record,
            hooks,
            CompletionReason::LaunchFailed,
            true,
            false,
            Some(bounded_detail(error)),
        )?;
        return Ok(WorkerOutcome::Completed);
    }
    let directory = store.execution_directory(&record.execution_ref)?;
    let spawn = (|| {
        let stdout = open_private(&directory.join("stdout.log"), true, true)?;
        let stderr = open_private(&directory.join("stderr.log"), true, true)?;
        let mut command = Command::new(&request.argv[0]);
        command
            .args(&request.argv[1..])
            .current_dir(&request.cwd)
            .env("HERDER_EXECUTION_REF", &record.execution_ref)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command.spawn()
    })();
    let mut child = match spawn {
        Ok(child) => child,
        Err(error) => {
            finish(
                store,
                &mut record,
                hooks,
                CompletionReason::LaunchFailed,
                true,
                false,
                Some(bounded_detail(error)),
            )?;
            return Ok(WorkerOutcome::Completed);
        }
    };
    record.started_at_unix_ms = Some(unix_millis()?);
    record.process = linux::capture_process(child.id(), store.node_ref()).ok();
    record.state = ExecutionState::Running;
    record.heartbeat_at_unix_ms = Some(unix_millis()?);
    store.save_record(&record)?;
    let mut descendant_failure = false;
    let mut stop: Option<(CompletionReason, u64, String)> = None;
    let mut last_saved = 0_u64;
    loop {
        let now = unix_millis()?;
        if record.root_exit.is_none() {
            if let Some(status) = child.try_wait()? {
                record.root_exit = Some(ProcessExit {
                    exit_code: status.code(),
                    signal: status.signal(),
                });
            }
        }
        let no_children_remaining = if record.root_exit.is_some() {
            let reaped = linux::reap_adopted()?;
            descendant_failure |= reaped.failed;
            reaped.none_remaining
        } else {
            false
        };
        let members = linux::descendants(std::process::id(), store.node_ref())?;
        record.observed_members = members.iter().take(256).cloned().collect();
        // ECHILD from the subreaper is the decisive tree-completion proof.
        // A single /proc snapshot may miss a grandchild being adopted while
        // its exiting parent disappears during enumeration.
        if no_children_remaining && members.is_empty() {
            let (reason, detail) = match &stop {
                Some((reason, _, detail)) => (*reason, Some(detail.clone())),
                None => (CompletionReason::Exited, None),
            };
            finish(
                store,
                &mut record,
                hooks,
                reason,
                true,
                descendant_failure,
                detail,
            )?;
            return Ok(WorkerOutcome::Completed);
        }
        record.heartbeat_at_unix_ms = Some(now);
        if now.saturating_sub(last_saved) >= 500 {
            store.save_record(&record)?;
            last_saved = now;
        }
        if stop.is_none() {
            if let Err(error) = hooks.tick(&record) {
                stop = Some((CompletionReason::LeaseLost, now, bounded_detail(error)));
            } else if store.cancellation_requested(&record.execution_ref)? {
                stop = Some((
                    CompletionReason::Cancelled,
                    now,
                    "execution cancellation requested".into(),
                ));
            } else if request.deadline_unix_ms.is_some_and(|v| now >= v) {
                stop = Some((
                    CompletionReason::TimedOut,
                    now,
                    "absolute execution deadline reached".into(),
                ));
            }
        }
        if let Some((reason, since, detail)) = &stop {
            record.observation_detail = Some(format!("{reason:?}: {detail}"));
            let signal = if now.saturating_sub(*since) >= request.stop_grace_ms {
                libc::SIGKILL
            } else {
                libc::SIGTERM
            };
            if let Err(error) = linux::signal_tree(std::process::id(), store.node_ref(), signal) {
                // Do not manufacture a stopped tree or grant permission to reuse it.
                record.observation_detail = Some(format!(
                    "{reason:?}; stop not confirmed: {}",
                    bounded_detail(error)
                ));
            }
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn watch_existing(
    store: &ExecutionStore,
    mut record: ExecutionRecord,
    request: AttachRequest,
    hooks: &mut dyn ExecutionHooks,
) -> io::Result<WorkerOutcome> {
    record.process = Some(request.process.clone());
    record.started_at_unix_ms = Some(unix_millis()?);
    record.state = ExecutionState::Running;
    record.observed_members = vec![request.process.clone()];
    loop {
        let now = unix_millis()?;
        let observation = linux::observe_process(&request.process);
        if observation != ProcessObservation::Alive {
            let detail = match observation {
                ProcessObservation::Gone => {
                    "attached process identity disappeared; no exit receipt was available and descendants are unproven"
                }
                _ => "attached process identity could not be observed",
            };
            finish(
                store,
                &mut record,
                hooks,
                CompletionReason::ObservationLost,
                false,
                false,
                Some(detail.into()),
            )?;
            return Ok(WorkerOutcome::Completed);
        }
        record.heartbeat_at_unix_ms = Some(now);
        store.save_record(&record)?;
        if let Err(error) = hooks.tick(&record) {
            finish(
                store,
                &mut record,
                hooks,
                CompletionReason::LeaseLost,
                false,
                false,
                Some(bounded_detail(error)),
            )?;
            return Ok(WorkerOutcome::Completed);
        }
        if request.deadline_unix_ms.is_some_and(|v| now >= v) {
            finish(
                store,
                &mut record,
                hooks,
                CompletionReason::TimedOut,
                false,
                false,
                Some("observer deadline reached; attached process was not killed".into()),
            )?;
            return Ok(WorkerOutcome::Completed);
        }
        thread::sleep(Duration::from_millis(250));
    }
}
