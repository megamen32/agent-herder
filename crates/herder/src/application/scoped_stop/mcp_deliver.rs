//! Fenced delivery adapter for an authenticated NativeServer application.
use crate::{
    application::{
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
            policy: None,
        })
    }
    /// Policy is trusted server composition; it supplies exact grants only.
    pub fn with_policy(
        mut self,
        policy: Arc<dyn super::create_prompt::FreshSessionGrantPolicy + Send + Sync>,
    ) -> Self {
        self.policy = Some(policy);
        self
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
            if mode != SendMode::Start {
                return Some(CallToolResult::structured_error(
                    json!({"code":"unsupported_mode","effect":"none","expected":["start"]}),
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
            let task_lookup = task_id.clone();
            let lookup_inside = task_lookup.clone();
            let run = tokio::task::spawn_blocking(move || {
                use rusqlite::OptionalExtension;
                use crate::application::reconcile::dispatch_payload_binding;
                let (address,_) = authority.resolve_session(&identity,&grants,&session,&instance).map_err(|_|())?;
                let expected=dispatch_payload_binding(&crate::domain::adapter::DispatchPlan{target:address,mode:SendMode::Start,expected_turn:None},&message);
                let lookup = || -> Result<Option<String>,()> {
                    let (_guard,writer)=authority.lock().map_err(|_|())?;
                    writer.connection().query_row("SELECT payload_hash FROM intents WHERE task_id=?1 AND principal=?2 AND target=?3 AND request_key=?4",rusqlite::params![lookup_inside,principal_id,session.0,request_key],|r|r.get(0)).optional().map_err(|_|())
                };
                match lookup()? {
                    Some(hash) if hash!=expected => return Ok::<_,()>("conflict"),
                    Some(_) => return Ok(if authority.get_delivery_task(&identity,&grants,&lookup_inside).map_err(|_|())?.is_some(){"task"}else{"unknown"}),
                    None=>(),
                }
                let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_|())?;
                let result=runtime.block_on(deliver_scoped(&authority,&instance,&identity,&grants,reader.as_ref(),control.as_ref(),DeliverRequest{session:&session,intent_id:&intent_id,task_id:&task_id,request_key:&request_key,message:&message,command:SendCommand{mode},now:&now,retain_until:&retain}));
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
                _ => Some(CallToolResult::structured_error(
                    serde_json::to_value(crate::error::Diagnostic::outcome_unknown(None)).unwrap(),
                )),
            }
        })
    }
}
