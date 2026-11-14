//! Fenced delivery adapter for an authenticated NativeServer application.
use crate::{
    application::{
        delivery_keys::DeliveryKeyRegistry,
        scoped_stop::{BoundedNativeHandoff, ScopedAuthority},
        target::{DeliverRequest, deliver_scoped},
    },
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource},
    domain::{
        adapter::{NativeSessionReader, SendCommand, SendMode},
        address::{InstanceRef, SessionRef},
    },
    mcp::{
        catalog,
        transport::{ApplicationFuture, ApplicationPort},
    },
};
use rmcp::model::CallToolResult;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

/// All dependencies, the exact instance, grants and retention come from trusted
/// server composition, never from request metadata.
pub struct ScopedDeliverApplication<R, C> {
    authority: Arc<ScopedAuthority>,
    instance: InstanceRef,
    grants: Vec<Grant>,
    reader: Arc<R>,
    control: Arc<C>,
    retain_until: String,
    delivery_mode: SendMode,
    automatic_continuation: bool,
    delivery_keys: Option<Arc<DeliveryKeyRegistry>>,
    policy: Option<Arc<dyn super::create_prompt::FreshSessionGrantPolicy + Send + Sync>>,
}
impl<R, C> ScopedDeliverApplication<R, C> {
    pub fn new(
        authority: Arc<ScopedAuthority>,
        instance: InstanceRef,
        grants: Vec<Grant>,
        reader: Arc<R>,
        control: Arc<C>,
        retain_until: String,
    ) -> Result<Self, ()> {
        if retain_until.is_empty() {
            return Err(());
        }
        Ok(Self {
            authority,
            instance,
            grants,
            reader,
            control,
            retain_until,
            delivery_mode: SendMode::Start,
            automatic_continuation: true,
            delivery_keys: None,
            policy: None,
        })
    }
    /// Restrict this application to the mode selected by trusted composition.
    /// Queue is limited to an observed idle snapshot so the durable replay
    /// binding never has to infer an active turn identity.
    pub fn with_delivery_mode(mut self, mode: SendMode) -> Result<Self, ()> {
        if !matches!(mode, SendMode::Start | SendMode::Queue) {
            return Err(());
        }
        self.delivery_mode = mode;
        Ok(self)
    }
    /// Policy is trusted server composition; it supplies exact grants only.
    pub fn with_policy(
        mut self,
        policy: Arc<dyn super::create_prompt::FreshSessionGrantPolicy + Send + Sync>,
    ) -> Self {
        self.policy = Some(policy);
        self
    }

    /// Automatic continuation capability comes from the initialized native
    /// adapter. It does not disable explicit human delivery or receipt reads.
    pub fn with_automatic_continuation(mut self, allowed: bool) -> Self {
        self.automatic_continuation = allowed;
        self
    }

    pub fn with_delivery_keys(mut self, registry: Arc<DeliveryKeyRegistry>) -> Self {
        self.delivery_keys = Some(registry);
        self
    }

    /// Read one exact durable delivery without native I/O or task mutation.
    /// HumanStop blocks effects, not the caller's authorized receipt history.
    fn read_receipt(&self, identity: &ConnectionIdentity, session_ref: String,
        request_key: String) -> Result<serde_json::Value, &'static str> {
        use crate::application::reconcile::{ReceiptBinding, StoredReceipt, load_native_receipt};
        use rusqlite::{OptionalExtension, params};
        let Caller::Principal(principal) = identity.caller() else { return Err("unauthorized") };
        if session_ref.is_empty() || request_key.is_empty() || request_key.len() > 4096
            || request_key.chars().any(char::is_control) { return Err("invalid_request") }
        let session = SessionRef(session_ref);
        let mut grants = self.grants.clone();
        if let Some(policy) = &self.policy {
            if let Some(grant) = policy.session_read_grant(&principal.id, &self.instance, &session)
                .map_err(|_| "policy_unavailable")? {
                if grant.principal != principal.id || grant.action != Action::Read
                    || grant.resource != PrivateResource::Session(session.clone()) {
                    return Err("session_grant_required");
                }
                grants.push(grant);
            }
        }
        identity.authorize(&grants, &PrivateResource::Session(session.clone()), Action::Read)
            .map_err(|_| "session_grant_required")?;
        let (address, generation) = self.authority.resolve_session_read(identity, &grants, &session, &self.instance)
            .map_err(|_| "session_unavailable")?;
        let reserved = if DeliveryKeyRegistry::applies(&request_key) {
            self.delivery_keys.as_ref().ok_or("canonical_key_registry_unavailable")?
                .lookup(&principal.id.0, &session.0, &address, &request_key)
                .map_err(|e| if e.kind()==std::io::ErrorKind::AlreadyExists {"idempotency_conflict"}else{"canonical_key_registry_unavailable"})?
        } else { None };
        let raw = serde_json::to_vec(&("mcp-deliver-v1", &principal.id.0, &session.0, &request_key))
            .map_err(|_| "invalid_request")?;
        let suffix = Sha256::digest(raw).iter().map(|b| format!("{b:02x}")).collect::<String>();
        let task_ref = format!("mcp-delivery-task:{suffix}");
        let intent_ref = format!("mcp-delivery-intent:{suffix}");
        let (_gate, writer) = self.authority.lock().map_err(|_| "scope_unavailable")?;
        let current: bool = writer.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM session_bindings b JOIN humanstop_sessions s ON s.session_ref=b.session_ref WHERE b.session_ref=?1 AND b.node_ref=?2 AND b.instance_id=?3 AND b.native_session_id=?4 AND s.authority_generation=?5 AND s.scope_generation=?6)",
            params![session.0,address.instance.node.0,address.instance.instance_id,address.native_session_id,self.authority.generation,generation],
            |row|row.get(0)).map_err(|_|"store_unavailable")?;
        if !current { return Err("session_binding_changed") }
        let mode = match self.delivery_mode { SendMode::Queue => "queue", SendMode::Start => "start", _ => return Err("unsupported_mode") };
        let target = json!({"node_ref":address.instance.node.0,"instance_ref":address.instance.instance_id,
            "native_session_id":address.native_session_id});
        let row: Option<(String,String,String,Option<String>)> = writer.connection().query_row(
            "SELECT i.state,i.payload_hash,t.status,t.result_json FROM intents i JOIN tasks t ON t.task_id=i.task_id WHERE i.intent_id=?1 AND i.task_id=?2 AND i.principal=?3 AND t.principal=?3 AND i.target=?4 AND i.request_key=?5",
            params![intent_ref,task_ref,principal.id.0,session.0,request_key],
            |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)))
            .optional().map_err(|_|"store_unavailable")?;
        let Some((state,payload_hash,status,result)) = row else {
            return Ok(json!({"version":1,"complete":true,"found":false,"session_ref":session.0,
                "request_key":request_key,"task_ref":task_ref,"target":target,"delivery_mode":mode,
                "automatic_continuation":self.automatic_continuation,
                "reserved_payload_hash":reserved.as_ref().map(|v|&v.payload_hash)}));
        };
        if !matches!(state.as_str(),"prepared"|"dispatching"|"admitted"|"confirmed"|"rejected"|"unknown") {
            return Err("delivery_state_invalid");
        }
        if DeliveryKeyRegistry::applies(&request_key) && reserved.as_ref().is_none_or(|v|v.payload_hash!=payload_hash) {
            return Err("canonical_key_binding_unavailable");
        }
        let binding = ReceiptBinding { intent_id:&intent_ref,principal:&principal.id.0,
            target_ref:&session.0,request_key:&request_key,address:&address };
        let receipt = match load_native_receipt(writer.connection(), &binding).map_err(|_|"store_unavailable")? {
            StoredReceipt::Found(receipt) => Some(json!({"native_id":receipt.native_id,"target":receipt.target})),
            StoredReceipt::Unknown => None,
        };
        if state=="confirmed" && receipt.is_none() { return Err("delivery_receipt_unavailable") }
        let result = result.map(|raw|serde_json::from_str::<serde_json::Value>(&raw))
            .transpose().map_err(|_|"store_unavailable")?;
        Ok(json!({"version":1,"complete":true,"found":true,"session_ref":session.0,
            "request_key":request_key,"task_ref":task_ref,"target":target,"delivery_mode":mode,
            "automatic_continuation":self.automatic_continuation,
            "reserved_payload_hash":reserved.as_ref().map(|v|&v.payload_hash),
            "state":state,"payload_hash":payload_hash,"task_status":status,
            "native_receipt":receipt,"task_result":result}))
    }
}
pub(super) struct IdleQueueReader<'a, R> {
    pub(super) inner: &'a R,
    pub(super) mode: SendMode,
}

struct KeyBoundHandoff<'a,C> {
    inner:&'a C,
    registry:Option<&'a DeliveryKeyRegistry>,
    principal:&'a str,
    session:&'a str,
    request_key:&'a str,
}
impl<C:BoundedNativeHandoff> BoundedNativeHandoff for KeyBoundHandoff<'_,C> {
    fn submit_bounded(&self,plan:crate::domain::adapter::DispatchPlan,message:&str,
        key:&crate::domain::adapter::RequestKey)->Result<crate::domain::adapter::Admission,crate::domain::adapter::SubmitError> {
        use crate::{application::reconcile::dispatch_payload_binding,domain::adapter::SubmitError};
        if DeliveryKeyRegistry::applies(self.request_key) {
            let valid=key.0==self.request_key && self.registry.and_then(|registry|
                registry.lookup(self.principal,self.session,&plan.target,self.request_key).ok().flatten())
                .is_some_and(|binding|binding.payload_hash==dispatch_payload_binding(&plan,message));
            if !valid {return Err(SubmitError::DefinitelyNotSent{reason:"canonical delivery key binding changed before native admission".into()})}
        }
        self.inner.submit_bounded(plan,message,key)
    }
}
impl<R: NativeSessionReader> NativeSessionReader for IdleQueueReader<'_, R> {
    async fn snapshot(
        &self,
        target: &crate::domain::address::SessionAddress,
    ) -> Result<crate::domain::adapter::SessionSnapshot, crate::domain::adapter::ReadError> {
        let mut snapshot = self.inner.snapshot(target).await?;
        if self.mode == SendMode::Queue
            && !matches!(
                snapshot.activity,
                crate::domain::adapter::SessionActivity::Idle
                    | crate::domain::adapter::SessionActivity::ColdPreparable
            )
        {
            snapshot.activity = crate::domain::adapter::SessionActivity::Unknown;
        }
        Ok(snapshot)
    }
    async fn reconcile(
        &self,
        receipt: &crate::domain::adapter::NativeReceipt,
    ) -> Result<crate::domain::adapter::Observation, crate::domain::adapter::ReadError> {
        self.inner.reconcile(receipt).await
    }
}
pub(super) fn utc_now() -> Result<String, ()> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ())?
        .as_secs();
    let seconds: libc::time_t = seconds.try_into().map_err(|_| ())?;
    let mut tm = std::mem::MaybeUninit::<libc::tm>::uninit();
    if unsafe { libc::gmtime_r(&seconds, tm.as_mut_ptr()) }.is_null() {
        return Err(());
    }
    let tm = unsafe { tm.assume_init() };
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    ))
}
impl<R, C> ApplicationPort for ScopedDeliverApplication<R, C>
where
    R: NativeSessionReader + Send + Sync + 'static,
    C: BoundedNativeHandoff + Send + Sync + 'static,
{
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: catalog::Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            if let catalog::Request::Deliver(catalog::Deliver::Receipt {session_ref,request_key}) = &request {
                return Some(match self.read_receipt(identity,session_ref.clone(),request_key.clone()) {
                    Ok(value)=>CallToolResult::structured(value),
                    Err(code)=>CallToolResult::structured_error(json!({"code":code,"effect":"none"})),
                });
            }
            let catalog::Request::Deliver(catalog::Deliver::Session {
                session_ref,
                message,
                mode,
                request_key,
            }) = request
            else {
                return None;
            };
            let Caller::Principal(principal) = identity.caller() else {
                return Some(CallToolResult::structured_error(
                    json!({"code":"unauthorized","effect":"none"}),
                ));
            };
            let session = SessionRef(session_ref);
            let mut effective_grants = self.grants.clone();
            if let Some(policy) = &self.policy {
                for (action, grant) in [
                    (
                        Action::Write,
                        policy.session_write_grant(&principal.id, &self.instance, &session),
                    ),
                    (
                        Action::Read,
                        policy.session_read_grant(&principal.id, &self.instance, &session),
                    ),
                ] {
                    if let Ok(Some(grant)) = grant {
                        if grant.principal == principal.id
                            && grant.action == action
                            && grant.resource == PrivateResource::Session(session.clone())
                        {
                            effective_grants.push(grant);
                        }
                    }
                }
            }
            if [Action::Write, Action::Read].into_iter().any(|action| {
                identity
                    .authorize(
                        &effective_grants,
                        &PrivateResource::Session(session.clone()),
                        action,
                    )
                    .is_err()
            }) {
                return Some(CallToolResult::structured_error(
                    json!({"code":"session_grant_required","effect":"none"}),
                ));
            }
            if request_key.is_empty()
                || request_key.len() > 4096
                || request_key.chars().any(char::is_control)
                || message.is_empty()
            {
                return Some(CallToolResult::structured_error(
                    json!({"code":"invalid_request","effect":"none"}),
                ));
            }
            let mode = match mode {
                catalog::DeliveryMode::Current => SendMode::Current,
                catalog::DeliveryMode::Queue => SendMode::Queue,
                catalog::DeliveryMode::Start => SendMode::Start,
            };
            if mode != self.delivery_mode {
                let expected = if self.delivery_mode == SendMode::Queue {
                    "queue"
                } else {
                    "start"
                };
                return Some(CallToolResult::structured_error(
                    json!({"code":"unsupported_mode","effect":"none","expected":[expected]}),
                ));
            }
            let raw = match serde_json::to_vec(&(
                "mcp-deliver-v1",
                &principal.id.0,
                &session.0,
                &request_key,
            )) {
                Ok(v) => v,
                Err(_) => {
                    return Some(CallToolResult::structured_error(
                        json!({"code":"invalid_request","effect":"none"}),
                    ));
                }
            };
            let suffix = Sha256::digest(raw)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let intent_id = format!("mcp-delivery-intent:{suffix}");
            let task_id = format!("mcp-delivery-task:{suffix}");
            let now = match utc_now() {
                Ok(v) => v,
                Err(_) => {
                    return Some(CallToolResult::structured_error(
                        json!({"code":"clock_unavailable","effect":"none"}),
                    ));
                }
            };
            let principal_id = principal.id.0.clone();
            let authority = self.authority.clone();
            let instance = self.instance.clone();
            let grants = effective_grants;
            let reader = self.reader.clone();
            let control = self.control.clone();
            let retain = self.retain_until.clone();
            let identity = identity.clone();
            let delivery_keys = self.delivery_keys.clone();
            let task_lookup = task_id.clone();
            let lookup_inside = task_lookup.clone();
            let run = tokio::task::spawn_blocking(move || {
                use rusqlite::OptionalExtension;
                use crate::application::reconcile::dispatch_payload_binding;
                let (address,_) = authority.resolve_session(&identity,&grants,&session,&instance).map_err(|_|())?;
                let expected=dispatch_payload_binding(&crate::domain::adapter::DispatchPlan{target:address.clone(),mode,expected_turn:None},&message);
                if DeliveryKeyRegistry::applies(&request_key) {
                    let Some(registry)=delivery_keys.as_ref() else {return Ok::<_,()>("registry_unavailable")};
                    if let Err(error)=registry.reserve(&principal_id,&session.0,&address,&request_key,&expected) {
                        return Ok(if error.kind()==std::io::ErrorKind::AlreadyExists {"conflict"}else{"registry_unavailable"});
                    }
                }
                let lookup = || -> Result<Option<String>,()> {
                    let (_guard,writer)=authority.lock().map_err(|_|())?;
                    writer.connection().query_row("SELECT payload_hash FROM intents WHERE task_id=?1 AND principal=?2 AND target=?3 AND request_key=?4",rusqlite::params![lookup_inside,principal_id,session.0,request_key],|r|r.get(0)).optional().map_err(|_|())
                };
                match lookup()? {
                    Some(hash) if hash!=expected => return Ok::<_,()>("conflict"),
                    Some(_) => return Ok(if authority.get_delivery_task(&identity,&grants,&lookup_inside).map_err(|_|())?.is_some(){"task"}else{"unknown"}),
                    None=>(),
                }
                // Native reads/replays above remain available. Every fresh MCP
                // handoff is machine-originated, regardless of caller metadata.
                let migration = match authority.migration_decision(&instance,Some(&address.native_session_id),Some(&request_key)) {
                    Ok(value) => value,
                    Err(_) => return Ok("migration_unavailable"),
                };
                if migration.blocked { return Ok("migration_quarantined"); }
                let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_|())?;
                let restricted = IdleQueueReader { inner: reader.as_ref(), mode };
                let fenced=KeyBoundHandoff {inner:control.as_ref(),registry:delivery_keys.as_deref(),principal:&principal_id,session:&session.0,request_key:&request_key};
                let result=runtime.block_on(deliver_scoped(&authority,&instance,&identity,&grants,&restricted,&fenced,DeliverRequest{session:&session,intent_id:&intent_id,task_id:&task_id,request_key:&request_key,message:&message,command:SendCommand{mode},now:&now,retain_until:&retain}));
                match lookup()? {
                    Some(hash) if hash!=expected=>Ok("conflict"),
                    Some(_)=>Ok(if authority.get_delivery_task(&identity,&grants,&lookup_inside).map_err(|_|())?.is_some(){"task"}else{"unknown"}),
                    None=>Ok(match result {Ok(_)=>"blocked",Err(crate::application::target::TargetError::Store)=>"unknown",Err(_)=>"refused"}),
                }
            }).await;
            match run {
                Ok(Ok("task")) => Some(CallToolResult::structured(
                    json!({"_herder_delivery_task":task_lookup}),
                )),
                Ok(Ok("conflict")) => Some(CallToolResult::structured_error(
                    json!({"code":"idempotency_conflict","effect":"unknown","retry":"forbidden"}),
                )),
                Ok(Ok("blocked")) => Some(CallToolResult::structured_error(
                    json!({"code":"delivery_blocked","effect":"none"}),
                )),
                Ok(Ok("refused")) => Some(CallToolResult::structured_error(
                    json!({"code":"delivery_refused","effect":"none"}),
                )),
                Ok(Ok("migration_quarantined")) => Some(CallToolResult::structured_error(
                    json!({"code":"legacy_migration_quarantined","effect":"none"}),
                )),
                Ok(Ok("migration_unavailable")) => Some(CallToolResult::structured_error(
                    json!({"code":"legacy_migration_unavailable","effect":"none"}),
                )),
                Ok(Ok("registry_unavailable")) => Some(CallToolResult::structured_error(
                    json!({"code":"canonical_key_registry_unavailable","effect":"none"}),
                )),
                _ => Some(CallToolResult::structured_error(
                    serde_json::to_value(crate::error::Diagnostic::outcome_unknown(None)).unwrap(),
                )),
            }
        })
    }
}
