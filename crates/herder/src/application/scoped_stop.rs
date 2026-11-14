//! Scoped HumanStop authority: one pinned gate shared by stop and handoff.
//! Never infer authority from a native snapshot or create a second registry.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
compile_error!("scoped HumanStop gate requires supported Unix inode semantics");

pub mod archive;
pub mod enroll;
pub mod mcp_stop;
pub mod mcp_task;
pub mod mcp_task_server;
pub mod task_reconcile;
pub mod task_grants;
pub mod mcp_deliver;
pub mod mcp_create;
pub mod create_recovery;
pub mod create_prompt;
pub mod create_task;
pub mod mcp_read;
pub mod registration;
pub mod automation;
pub mod process_automation;
pub mod automation_driver;
pub mod wait_automation;
mod wait_sources;

use crate::auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource};
use crate::domain::address::SessionRef;
use crate::{
    application::{
        reconcile::{
            DurableDispatch, ReceiptBinding, StoreReceipt, dispatch_payload_binding,
            store_native_receipt,
        },
        target_gate::{PinnedTargetGateGuard, acquire_pinned, acquire_pinned_wait},
    },
    domain::adapter::{Admission, DispatchPlan, RequestKey, SubmitError},
    store::Writer,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

/// Synchronous and bounded native write+admission. Returning guarantees that
/// this call has no surviving delegated writer. A timeout/disconnect after a
/// possible write is UNKNOWN; no retry. Only trusted adapters may implement it.
pub trait BoundedNativeHandoff {
    fn submit_bounded(
        &self,
        plan: DispatchPlan,
        message: &str,
        key: &RequestKey,
    ) -> Result<Admission, SubmitError>;
}

/// An exact, bounded interrupt for the known native turn. Failure, including a
/// timeout or lost reply, is UNKNOWN and never confirms cancellation.
pub trait BoundedNativeInterrupt {
    fn interrupt_exact(
        &self,
        target: &crate::domain::address::SessionAddress,
        native_turn_id: &str,
    ) -> InterruptAttempt;
}

#[derive(Debug, PartialEq, Eq)]
pub enum InterruptAttempt {
    Interrupted,
    DefinitelyNotSent,
    OutcomeUnknown,
}

impl BoundedNativeInterrupt for crate::adapters::codex::control::CodexControl {
    fn interrupt_exact(
        &self,
        target: &crate::domain::address::SessionAddress,
        native_turn_id: &str,
    ) -> InterruptAttempt {
        use crate::adapters::codex::control::InterruptOutcome;
        match crate::adapters::codex::control::CodexControl::interrupt_exact(
            self,
            target,
            native_turn_id,
        ) {
            InterruptOutcome::Interrupted => InterruptAttempt::Interrupted,
            InterruptOutcome::DefinitelyNotSent { .. } => InterruptAttempt::DefinitelyNotSent,
            InterruptOutcome::OutcomeUnknown { .. } => InterruptAttempt::OutcomeUnknown,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum InterruptDisposition {
    HeldBeforeHandoff,
    InterruptAcknowledged,
    InterruptNotSent,
    InterruptUnknown,
}

/// Only a trusted native adapter that can prove an isolated root creation may
/// implement this synchronous bounded seam. UNKNOWN must never be retried.
pub trait BoundedFreshRootCreate {
    /// Selected by the trusted adapter, never by an MCP request. Existing
    /// adapters retain Start; Queue must be explicitly supported by snapshot.
    fn initial_delivery_mode(&self) -> crate::domain::adapter::SendMode {
        crate::domain::adapter::SendMode::Start
    }
    fn instance(&self) -> &crate::domain::address::InstanceRef;
    fn create_root_bounded(
        &self,
        request_key: &str,
        specification: &str,
    ) -> Result<crate::domain::address::SessionAddress, SubmitError>;
}
/// Generation is issued by trusted server composition, not an MCP argument.
pub trait ScopeGenerationIssuer {
    fn issue(&self) -> Result<String, ()>;
}

#[derive(Debug, PartialEq, Eq)]
pub enum GateError {
    Unavailable,
    Busy,
    Invalid,
    Store,
}
#[derive(Debug, PartialEq, Eq)]
pub enum StopDisposition {
    HeldBeforeHandoff,
    InterruptOrReconcileRequired,
}

/// Both paths come only from trusted launcher configuration, never from MCP.
pub struct ScopedAuthority {
    db: PathBuf,
    gate: PathBuf,
    generation: String,
}
mod index_snapshot;
impl ScopedAuthority {
    pub fn new(db: PathBuf, gate: PathBuf, generation: String) -> Result<Self, GateError> {
        if !db.is_absolute()
            || !gate.is_absolute()
            || db.parent() != gate.parent()
            || generation.is_empty()
        {
            return Err(GateError::Invalid);
        }
        Ok(Self {
            db,
            gate,
            generation,
        })
    }
    fn lock(&self) -> Result<(PinnedTargetGateGuard, Writer), GateError> {
        self.lock_inner(false)
    }
    fn lock_wait(&self) -> Result<(PinnedTargetGateGuard, Writer), GateError> {
        self.lock_inner(true)
    }
    fn lock_inner(&self, wait: bool) -> Result<(PinnedTargetGateGuard, Writer), GateError> {
        let gm = std::fs::symlink_metadata(&self.gate).map_err(|_| GateError::Unavailable)?;
        let acquire = if wait {
            acquire_pinned_wait
        } else {
            acquire_pinned
        };
        let guard = acquire(&self.gate, gm.dev(), gm.ino()).map_err(|e| {
            if e.kind() == std::io::ErrorKind::WouldBlock {
                GateError::Busy
            } else {
                GateError::Unavailable
            }
        })?;
        let dm = std::fs::symlink_metadata(&self.db).map_err(|_| GateError::Unavailable)?;
        if !dm.is_file()
            || dm.nlink() != 1
            || dm.mode() & 0o077 != 0
            || dm.uid() != gm.uid()
            || self.db.canonicalize().ok().as_deref() != Some(Path::new(&self.db))
        {
            return Err(GateError::Unavailable);
        }
        let writer = Writer::open_file(&self.db).map_err(|_| GateError::Unavailable)?;
        let row: Option<(String,i64,i64,i64,i64)> = writer.connection().query_row("SELECT generation,gate_device,gate_inode,database_device,database_inode FROM humanstop_authority WHERE singleton=1", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(|_| GateError::Unavailable)?;
        let expected = (
            self.generation.clone(),
            i64::try_from(gm.dev()).map_err(|_| GateError::Unavailable)?,
            i64::try_from(gm.ino()).map_err(|_| GateError::Unavailable)?,
            i64::try_from(dm.dev()).map_err(|_| GateError::Unavailable)?,
            i64::try_from(dm.ino()).map_err(|_| GateError::Unavailable)?,
        );
        if row != Some(expected) {
            return Err(GateError::Unavailable);
        }
        Ok((guard, writer))
    }
    /// Hold the same canonical gate from before native creation until the
    /// immutable mapping, all root scopes and scope generation commit together.
    pub fn create_fresh_root<
        C: BoundedFreshRootCreate,
        I: crate::application::target::SessionRefIssuer,
        G: ScopeGenerationIssuer,
    >(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        control: &C,
        issuer: &I,
        generations: &G,
        request: crate::application::target::CreateRequest<'_>,
    ) -> Result<crate::application::target::CreateResult, GateError> {
        use crate::{
            application::target::CreateResult,
            store::{intents::PrepareResult, lineage::NewCreateLineageIntent},
        };
        use sha2::{Digest, Sha256};
        let instance = control.instance();
        let target = serde_json::to_string(instance).map_err(|_| GateError::Invalid)?;
        identity
            .authorize(
                grants,
                &PrivateResource::Resource(format!("instance:{target}")),
                Action::Write,
            )
            .map_err(|_| GateError::Invalid)?;
        let Caller::Principal(principal) = identity.caller() else {
            return Err(GateError::Invalid);
        };
        if request.request_key.is_empty() || request.specification.is_empty() {
            return Err(GateError::Invalid);
        }
        let (gate, mut writer) = self.lock()?;
        let held: bool = writer.connection().query_row("SELECT EXISTS(SELECT 1 FROM humanstop_holds WHERE scope_ref='global' AND released_at IS NULL) OR EXISTS(SELECT 1 FROM holds WHERE session_ref='global' AND released_at IS NULL)",[],|r|r.get(0)).map_err(|_|GateError::Store)?;
        if held {
            return Err(GateError::Invalid);
        }
        let bytes = serde_json::to_vec(&(1u8, instance, request.specification))
            .map_err(|_| GateError::Invalid)?;
        let payload = format!(
            "create-v1:{}",
            Sha256::digest(bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        let intent = NewCreateLineageIntent {
            intent_id: request.intent_id,
            task_id: request.task_id,
            creator_ref: &principal.id.0,
            target: &target,
            request_ref: request.request_key,
            payload_hash: &payload,
            now: request.now,
            retain_until: request.retain_until,
        };
        match writer
            .prepare_create_lineage_intent(&intent)
            .map_err(|_| GateError::Store)?
        {
            PrepareResult::Created { .. } => (),
            PrepareResult::Existing { .. } => return Ok(CreateResult::Existing),
            PrepareResult::Conflict { .. } => return Err(GateError::Invalid),
        }
        let session = issuer.issue().map_err(|_| GateError::Unavailable)?;
        let generation = generations.issue().map_err(|_| GateError::Unavailable)?;
        if session.0.is_empty()
            || generation.is_empty()
            || session.0.len() > 4096
            || generation.len() > 4096
            || session.0.chars().any(char::is_control)
            || generation.chars().any(char::is_control)
        {
            return Err(GateError::Invalid);
        }
        use crate::application::target::SessionRegistry;
        if writer
            .resolve(&session)
            .map_err(|_| GateError::Unavailable)?
            .is_some()
            || writer
                .connection()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM humanstop_sessions WHERE scope_generation=?1)",
                    [&generation],
                    |r| r.get::<_, bool>(0),
                )
                .map_err(|_| GateError::Store)?
        {
            return Err(GateError::Invalid);
        }
        if !writer
            .claim_create_exact(&intent)
            .map_err(|_| GateError::Store)?
        {
            return Ok(CreateResult::Existing);
        }
        let address = match control.create_root_bounded(request.request_key, request.specification)
        {
            Err(SubmitError::DefinitelyNotSent { reason }) => {
                writer
                    .mark_create_rejected(&intent, &reason)
                    .map_err(|_| GateError::Store)?;
                return Ok(CreateResult::DefinitelyNotSent);
            }
            Ok(a)
                if a.instance == *instance
                    && !a.native_session_id.is_empty()
                    && a.native_session_id.len() <= 4096
                    && !a.native_session_id.chars().any(char::is_control) =>
            {
                a
            }
            _ => {
                writer
                    .mark_create_unknown(&intent)
                    .map_err(|_| GateError::Store)?;
                return Ok(CreateResult::Unknown);
            }
        };
        let receipt=serde_json::json!({"version":1,"request_key":request.request_key,"instance":address.instance,"native_session_id":address.native_session_id,"session_ref":session.0,"parent_ref":null}).to_string();
        match writer.commit_created_scoped_root(
            &gate,
            &intent,
            &session.0,
            &address,
            None,
            &generation,
            &receipt,
        ) {
            Ok(true) => Ok(CreateResult::Created(session)),
            _ => {
                writer
                    .mark_create_unknown(&intent)
                    .map_err(|_| GateError::Store)?;
                Ok(CreateResult::Unknown)
            }
        }
    }

    /// Resolve only fresh, scope-provisioned sessions through this authority.
    pub fn resolve_session(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        session: &SessionRef,
        instance: &crate::domain::address::InstanceRef,
    ) -> Result<(crate::domain::address::SessionAddress, String), GateError> {
        self.resolve_session_for_action(identity, grants, session, instance, Action::Write)
    }

    /// Read authorization is independent of write authorization and still
    /// requires a verified scoped binding in the authoritative store.
    pub fn resolve_session_read(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        session: &SessionRef,
        instance: &crate::domain::address::InstanceRef,
    ) -> Result<(crate::domain::address::SessionAddress, String), GateError> {
        self.resolve_session_for_action(identity, grants, session, instance, Action::Read)
    }

    /// Read the authoritative HumanStop state for one exact authorized session.
    /// Native status is intentionally irrelevant: only the pinned store's
    /// global, inherited and session scopes determine `held`.
    pub fn human_stop_held(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        session: &SessionRef,
        instance: &crate::domain::address::InstanceRef,
    ) -> Result<bool, GateError> {
        identity.authorize(grants, &PrivateResource::Session(session.clone()), Action::Read)
            .map_err(|_| GateError::Invalid)?;
        let (_gate, writer) = self.lock()?;
        use crate::application::target::SessionRegistry;
        let address = writer.resolve(session).map_err(|_| GateError::Store)?
            .ok_or(GateError::Unavailable)?;
        if address.instance != *instance { return Err(GateError::Invalid); }
        let scope_generation: Option<String> = writer.connection().query_row(
            "SELECT scope_generation FROM humanstop_sessions WHERE session_ref=?1 AND authority_generation=?2",
            params![session.0, self.generation], |row| row.get(0),
        ).optional().map_err(|_| GateError::Store)?;
        let scope_generation = scope_generation.ok_or(GateError::Unavailable)?;
        let Caller::Principal(principal) = identity.caller() else { return Err(GateError::Invalid) };
        let principal_id = &principal.id.0;
        let binding = ReceiptBinding {
            intent_id: "human-stop-read",
            principal: principal_id,
            target_ref: &session.0,
            request_key: "human-stop-read",
            address: &address,
        };
        if !scope_identity_valid(writer.connection(), &binding, &scope_generation, &self.generation)? {
            return Err(GateError::Unavailable);
        }
        scope_held(writer.connection(), &binding)
    }

    fn resolve_session_for_action(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        session: &SessionRef,
        instance: &crate::domain::address::InstanceRef,
        action: Action,
    ) -> Result<(crate::domain::address::SessionAddress, String), GateError> {
        identity
            .authorize(
                grants,
                &PrivateResource::Session(session.clone()),
                action,
            )
            .map_err(|_| GateError::Invalid)?;
        let (_gate, writer) = self.lock()?;
        use crate::application::target::SessionRegistry;
        let address = writer
            .resolve(session)
            .map_err(|_| GateError::Unavailable)?
            .ok_or(GateError::Invalid)?;
        if &address.instance != instance {
            return Err(GateError::Invalid);
        }
        let scope: Option<String> = writer.connection().query_row("SELECT scope_generation FROM humanstop_sessions WHERE session_ref=?1 AND authority_generation=?2", params![session.0,self.generation], |r|r.get(0)).optional().map_err(|_|GateError::Store)?;
        Ok((address, scope.ok_or(GateError::Invalid)?))
    }

    /// Atomically prepare an intent only after exact scoped identity and hold
    /// checks. The subsequent claim and handoff each independently recheck.
    pub fn prepare(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        b: &ReceiptBinding<'_>,
        scope_generation: &str,
        plan: &DispatchPlan,
        message: &str,
        task_id: &str,
        now: &str,
        retain_until: &str,
    ) -> Result<Option<String>, GateError> {
        use crate::store::intents::{NewIntent, PrepareResult};
        authorize_session(identity, grants, b)?;
        let (_gate, mut writer) = self.lock()?;
        if plan.target != *b.address
            || !scope_allowed(writer.connection(), b, scope_generation, &self.generation)?
        {
            return Ok(None);
        }
        let payload = dispatch_payload_binding(plan, message);
        match writer
            .prepare_intent(&NewIntent {
                intent_id: b.intent_id,
                task_id,
                principal: b.principal,
                target: b.target_ref,
                request_key: b.request_key,
                payload_hash: &payload,
                now,
                retain_until,
            })
            .map_err(|_| GateError::Store)?
        {
            PrepareResult::Created { intent_id, .. }
            | PrepareResult::Existing { intent_id, .. } => Ok(Some(intent_id)),
            PrepareResult::Conflict { .. } => Err(GateError::Invalid),
        }
    }

    /// Claim and stop are serialized by SQLite; handoff takes the OS gate and
    /// rechecks every scope again after claim. The target comes from Writer.
    pub fn claim(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        b: &ReceiptBinding<'_>,
        generation: &str,
        plan: &DispatchPlan,
        message: &str,
        now: &str,
    ) -> Result<bool, GateError> {
        authorize_session(identity, grants, b)?;
        let (_gate, mut writer) = self.lock()?;
        let tx = writer
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| GateError::Store)?;
        if !scope_allowed(&tx, b, generation, &self.generation)? || plan.target != *b.address {
            return Ok(false);
        }
        let n = tx.execute("UPDATE intents SET state='dispatching',updated_at=?6 WHERE intent_id=?1 AND principal=?2 AND target=?3 AND request_key=?4 AND payload_hash=?5 AND state='prepared' AND native_receipt IS NULL", params![b.intent_id,b.principal,b.target_ref,b.request_key,dispatch_payload_binding(plan,message),now]).map_err(|_|GateError::Store)?;
        if n == 1 {
            tx.execute("INSERT INTO humanstop_dispatches(intent_id,scope_generation,phase,updated_at) VALUES (?1,?2,'claimed',?3)",params![b.intent_id,generation,now]).map_err(|_|GateError::Store)?;
        }
        tx.commit().map_err(|_| GateError::Store)?;
        Ok(n == 1)
    }
    /// Caller must already hold exact session-write ACL. No SQLite transaction
    /// remains open during the bounded native operation; the gate remains held.
    pub fn handoff<C: BoundedNativeHandoff>(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        b: &ReceiptBinding<'_>,
        generation: &str,
        plan: DispatchPlan,
        message: &str,
        now: &str,
        control: &C,
    ) -> Result<DurableDispatch, GateError> {
        authorize_session(identity, grants, b)?;
        let (_gate, mut writer) = self.lock()?;
        {
            let tx = writer
                .connection_mut()
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| GateError::Store)?;
            let valid_intent: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM intents WHERE intent_id=?1 AND principal=?2 AND target=?3 AND request_key=?4 AND payload_hash=?5 AND state='dispatching' AND native_receipt IS NULL)", params![b.intent_id,b.principal,b.target_ref,b.request_key,dispatch_payload_binding(&plan,message)], |r|r.get(0)).map_err(|_|GateError::Store)?;
            if !valid_intent || plan.target != *b.address {
                return Ok(DurableDispatch::NotClaimed);
            }
            let claimed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM humanstop_dispatches WHERE intent_id=?1 AND scope_generation=?2 AND phase='claimed')",params![b.intent_id,generation],|r|r.get(0)).map_err(|_|GateError::Store)?;
            if !claimed {
                return Ok(DurableDispatch::NotClaimed);
            }
            if !scope_identity_valid(&tx, b, generation, &self.generation)? {
                tx.execute("UPDATE intents SET state='unknown',updated_at=?2 WHERE intent_id=?1 AND state='dispatching'", params![b.intent_id,now]).map_err(|_|GateError::Store)?;
                tx.commit().map_err(|_| GateError::Store)?;
                return Ok(DurableDispatch::Unknown);
            }
            if scope_held(&tx, b)? {
                tx.execute("UPDATE intents SET state='rejected',updated_at=?2 WHERE intent_id=?1 AND state='dispatching'", params![b.intent_id,now]).map_err(|_|GateError::Store)?;
                tx.execute("UPDATE humanstop_dispatches SET phase='stopped',updated_at=?2 WHERE intent_id=?1 AND phase='claimed'",params![b.intent_id,now]).map_err(|_|GateError::Store)?;
                tx.execute("UPDATE tasks SET result_json=?2,updated_at=?3 WHERE task_id=(SELECT task_id FROM intents WHERE intent_id=?1)", params![b.intent_id,r#"{"outcome":"stopped_before_handoff","native_submit":"definitely_not_sent"}"#,now]).map_err(|_|GateError::Store)?;
                tx.commit().map_err(|_| GateError::Store)?;
                return Ok(DurableDispatch::StoppedBeforeHandoff);
            }
            if scope_unsettled(&tx, b)? {
                tx.execute("UPDATE intents SET state='unknown',updated_at=?2 WHERE intent_id=?1 AND state='dispatching'", params![b.intent_id,now]).map_err(|_|GateError::Store)?;
                tx.commit().map_err(|_| GateError::Store)?;
                return Ok(DurableDispatch::Unknown);
            }
            let begun = tx.execute("UPDATE humanstop_dispatches SET phase='handing_off',updated_at=?2 WHERE intent_id=?1 AND phase='claimed'",params![b.intent_id,now]).map_err(|_|GateError::Store)?;
            if begun != 1 {
                return Ok(DurableDispatch::NotClaimed);
            }
            tx.commit().map_err(|_| GateError::Store)?;
        }
        let outcome = control.submit_bounded(plan, message, &RequestKey(b.request_key.into()));
        if let Err(SubmitError::DefinitelyNotSent { reason }) = &outcome {
            let diagnostic = serde_json::json!({"outcome": "rejected", "native_submit": "definitely_not_sent", "reason": reason}).to_string();
            let tx = writer
                .connection_mut()
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| GateError::Store)?;
            let intent = tx.execute("UPDATE intents SET state='rejected',updated_at=?2 WHERE intent_id=?1 AND state='dispatching' AND native_receipt IS NULL", params![b.intent_id,now]).map_err(|_| GateError::Store)?;
            let phase = tx.execute("UPDATE humanstop_dispatches SET phase='finished',updated_at=?2 WHERE intent_id=?1 AND phase='handing_off'", params![b.intent_id,now]).map_err(|_| GateError::Store)?;
            let task = tx.execute("UPDATE tasks SET result_json=?2,updated_at=?3 WHERE task_id=(SELECT task_id FROM intents WHERE intent_id=?1)",params![b.intent_id,diagnostic,now]).map_err(|_| GateError::Store)?;
            if (intent, phase, task) != (1, 1, 1) {
                return Err(GateError::Store);
            }
            tx.commit().map_err(|_| GateError::Store)?;
            return Ok(DurableDispatch::DefinitelyNotSent);
        }
        if let Err(SubmitError::BrowserOutcomeUnknown(diagnostic)) = &outcome {
            let raw = serde_json::json!({"browser_diagnostic": diagnostic}).to_string();
            let tx = writer.connection_mut().transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| GateError::Store)?;
            let intent = tx.execute("UPDATE intents SET state='unknown',updated_at=?2 WHERE intent_id=?1 AND state='dispatching' AND native_receipt IS NULL", params![b.intent_id,now]).map_err(|_| GateError::Store)?;
            let phase = tx.execute("UPDATE humanstop_dispatches SET phase='finished',updated_at=?2 WHERE intent_id=?1 AND phase='handing_off'",params![b.intent_id,now]).map_err(|_| GateError::Store)?;
            let task = tx.execute("UPDATE tasks SET result_json=?2,updated_at=?3 WHERE task_id=(SELECT task_id FROM intents WHERE intent_id=?1) AND status<>'completed'",params![b.intent_id,raw,now]).map_err(|_| GateError::Store)?;
            if (intent, phase, task) != (1, 1, 1) {
                return Err(GateError::Store);
            }
            tx.commit().map_err(|_| GateError::Store)?;
            return Ok(DurableDispatch::BrowserOutcomeUnknown(*diagnostic));
        }
        let receipt = match outcome {
            Ok(admission)
                if admission.receipt.target == *b.address
                    && !admission.receipt.native_id.is_empty() =>
            {
                Some(admission.receipt)
            }
            _ => None,
        };
        if let Some(receipt) = receipt {
            let stored = store_native_receipt(writer.connection_mut(), b, &receipt, now)
                .map_err(|_| GateError::Store)?;
            if matches!(stored, StoreReceipt::Stored | StoreReceipt::AlreadyStored) {
                let n=writer.connection().execute("UPDATE intents SET state='admitted',updated_at=?2 WHERE intent_id=?1 AND state='dispatching' AND native_receipt IS NOT NULL", params![b.intent_id,now]).map_err(|_|GateError::Store)?;
                if n == 1 {
                    writer.connection().execute("UPDATE humanstop_dispatches SET phase='finished',updated_at=?2 WHERE intent_id=?1 AND phase='handing_off'",params![b.intent_id,now]).map_err(|_|GateError::Store)?;
                    return Ok(DurableDispatch::Admitted(receipt));
                }
            }
        }
        writer.connection().execute("UPDATE intents SET state='unknown',updated_at=?2 WHERE intent_id=?1 AND state='dispatching'", params![b.intent_id,now]).map_err(|_|GateError::Store)?;
        writer.connection().execute("UPDATE humanstop_dispatches SET phase='finished',updated_at=?2 WHERE intent_id=?1 AND phase='handing_off'",params![b.intent_id,now]).map_err(|_|GateError::Store)?;
        Ok(DurableDispatch::Unknown)
    }
    /// Stops any registered scope, including global or ancestor scopes. A stop
    /// after a possible handoff needs an exact native interrupt or reconciliation.
    pub fn stop(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        scope: &str,
        reason: &str,
        now: &str,
    ) -> Result<StopDisposition, GateError> {
        let resource = if scope == "global" {
            PrivateResource::Resource("humanstop:global".into())
        } else if let Some(reference) = scope.strip_prefix("session:") {
            if reference.is_empty() {
                return Err(GateError::Invalid);
            }
            PrivateResource::Session(SessionRef(reference.into()))
        } else {
            PrivateResource::Resource(format!("humanstop:scope:{scope}"))
        };
        identity
            .authorize(grants, &resource, Action::Write)
            .map_err(|_| GateError::Invalid)?;
        let (_gate, mut writer) = self.lock_wait()?;
        let tx = writer
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| GateError::Store)?;
        let valid: bool = tx
            .query_row(
                "SELECT ?1='global' OR EXISTS(SELECT 1 FROM humanstop_scopes WHERE scope_ref=?1)",
                [scope],
                |r| r.get(0),
            )
            .map_err(|_| GateError::Store)?;
        if !valid || reason.is_empty() || now.is_empty() {
            return Err(GateError::Invalid);
        }
        tx.execute("INSERT INTO humanstop_holds(scope_ref,reason,created_at,released_at) VALUES (?1,?2,?3,NULL) ON CONFLICT(scope_ref) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at,released_at=NULL",params![scope,reason,now]).map_err(|_|GateError::Store)?;
        process_automation::cancel_for_stop(&tx,scope,now)?;
        wait_automation::cancel_for_stop(&tx,scope,now)?;
        let possible: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM intents i JOIN humanstop_scopes s ON s.session_ref=i.target WHERE s.scope_ref=?1 AND i.state IN ('dispatching','admitted','unknown','confirmed'))", [scope], |r|r.get(0)).map_err(|_|GateError::Store)?;
        tx.commit().map_err(|_| GateError::Store)?;
        Ok(if possible {
            StopDisposition::InterruptOrReconcileRequired
        } else {
            StopDisposition::HeldBeforeHandoff
        })
    }

    /// Session-specific stop followed by an exact interrupt only when the
    /// authoritative store has the original bound native receipt. A missing
    /// receipt or lost interrupt reply is UNKNOWN and never a resend signal.
    pub fn stop_session_and_interrupt<C: BoundedNativeInterrupt>(
        &self,
        identity: &ConnectionIdentity,
        grants: &[Grant],
        b: &ReceiptBinding<'_>,
        reason: &str,
        now: &str,
        control: &C,
    ) -> Result<InterruptDisposition, GateError> {
        authorize_session(identity, grants, b)?;
        let scope = format!("session:{}", b.target_ref);
        let status = self.stop(identity, grants, &scope, reason, now)?;
        if status == StopDisposition::HeldBeforeHandoff {
            return Ok(InterruptDisposition::HeldBeforeHandoff);
        }
        let (_guard, mut writer) = self.lock_wait()?;
        let receipt = match writer
            .load_native_receipt(b)
            .map_err(|_| GateError::Store)?
        {
            crate::application::reconcile::StoredReceipt::Found(receipt) => receipt,
            crate::application::reconcile::StoredReceipt::Unknown => {
                return Ok(InterruptDisposition::InterruptUnknown);
            }
        };
        let tx = writer
            .connection_mut()
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| GateError::Store)?;
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT native_turn_id,state FROM humanstop_interrupts WHERE intent_id=?1 OR (session_ref=?2 AND native_turn_id=?3)",
                params![b.intent_id,b.target_ref,receipt.native_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| GateError::Store)?;
        if let Some((turn, state)) = existing {
            return Ok(match (turn == receipt.native_id, state.as_str()) {
                (true, "acknowledged") => InterruptDisposition::InterruptAcknowledged,
                (true, "not_sent") => InterruptDisposition::InterruptNotSent,
                _ => InterruptDisposition::InterruptUnknown,
            });
        }
        tx.execute("INSERT INTO humanstop_interrupts(intent_id,session_ref,native_turn_id,state,updated_at) VALUES (?1,?2,?3,'dispatching',?4)",params![b.intent_id,b.target_ref,receipt.native_id,now]).map_err(|_|GateError::Store)?;
        tx.commit().map_err(|_| GateError::Store)?;
        // The hold and the unique interrupt intent are durable before native IO.
        // There is no transaction during the bounded wait; the gate stays held.
        let (state, disposition) = match control
            .interrupt_exact(&receipt.target, &receipt.native_id)
        {
            InterruptAttempt::Interrupted => {
                ("acknowledged", InterruptDisposition::InterruptAcknowledged)
            }
            InterruptAttempt::DefinitelyNotSent => {
                ("not_sent", InterruptDisposition::InterruptNotSent)
            }
            InterruptAttempt::OutcomeUnknown => ("unknown", InterruptDisposition::InterruptUnknown),
        };
        writer.connection().execute("UPDATE humanstop_interrupts SET state=?2,updated_at=?3 WHERE intent_id=?1 AND state='dispatching'",params![b.intent_id,state,now]).map_err(|_|GateError::Store)?;
        Ok(disposition)
    }
}

fn authorize_session(
    identity: &ConnectionIdentity,
    grants: &[Grant],
    b: &ReceiptBinding<'_>,
) -> Result<(), GateError> {
    if !matches!(identity.caller(), Caller::Principal(p) if p.id.0 == b.principal) {
        return Err(GateError::Invalid);
    }
    identity
        .authorize(
            grants,
            &PrivateResource::Session(SessionRef(b.target_ref.into())),
            Action::Write,
        )
        .map_err(|_| GateError::Invalid)
}

fn scope_allowed(
    c: &rusqlite::Connection,
    b: &ReceiptBinding<'_>,
    scope_generation: &str,
    authority_generation: &str,
) -> Result<bool, GateError> {
    Ok(
        scope_identity_valid(c, b, scope_generation, authority_generation)?
            && !scope_held(c, b)?
            && !scope_unsettled(c, b)?,
    )
}

fn scope_unsettled(c: &rusqlite::Connection, b: &ReceiptBinding<'_>) -> Result<bool, GateError> {
    c.query_row("SELECT EXISTS(SELECT 1 FROM intents i LEFT JOIN humanstop_dispatches d ON d.intent_id=i.intent_id WHERE i.target=?1 AND (i.state='unknown' OR d.phase='handing_off' OR (d.phase='claimed' AND i.intent_id<>?2)))",params![b.target_ref,b.intent_id],|r|r.get(0)).map_err(|_|GateError::Store)
}
fn scope_identity_valid(
    c: &rusqlite::Connection,
    b: &ReceiptBinding<'_>,
    scope_generation: &str,
    authority_generation: &str,
) -> Result<bool, GateError> {
    c.query_row("SELECT EXISTS(SELECT 1 FROM humanstop_sessions s JOIN session_bindings b ON b.session_ref=s.session_ref WHERE s.session_ref=?1 AND s.authority_generation=?2 AND s.scope_generation=?3 AND b.node_ref=?4 AND b.instance_id=?5 AND b.native_session_id=?6 AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=s.session_ref AND scope_ref='global') AND EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=s.session_ref AND scope_ref='session:'||s.session_ref))",params![b.target_ref,authority_generation,scope_generation,b.address.instance.node.0,b.address.instance.instance_id,b.address.native_session_id],|r|r.get(0)).map_err(|_|GateError::Store)
}
fn scope_held(c: &rusqlite::Connection, b: &ReceiptBinding<'_>) -> Result<bool, GateError> {
    if process_automation::wake_cancelled(c,b.principal,b.target_ref,b.request_key)? {return Ok(true)}
    if wait_automation::wake_cancelled(c,b.principal,b.target_ref,b.request_key)? {return Ok(true)}
    c.query_row("SELECT EXISTS(SELECT 1 FROM humanstop_scopes s JOIN humanstop_holds h ON h.scope_ref=s.scope_ref WHERE s.session_ref=?1 AND h.released_at IS NULL) OR EXISTS(SELECT 1 FROM holds h WHERE h.released_at IS NULL AND (h.session_ref=?1 OR h.session_ref IN (SELECT scope_ref FROM humanstop_scopes WHERE session_ref=?1)))",[b.target_ref],|r|r.get(0)).map_err(|_|GateError::Store)
}
