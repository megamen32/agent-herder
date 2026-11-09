//! Owner automation rules for one explicit child-to-parent completion wake.
use crate::{
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource},
    domain::{adapter::ReadError, address::{InstanceRef, SessionAddress, SessionRef}},
    mcp::{catalog, transport::{ApplicationFuture, ApplicationPort}},
    store::intents::{EventAdmission, SettingAdmission},
};
use rmcp::model::CallToolResult;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Read-only port: callers supply a turn identity, while this port proves its
/// current native terminal status for the exact bound child session.
pub trait CompletedTurnReader: Send + Sync + 'static {
    fn confirms_completed_turn(&self, target: &SessionAddress, event_id: &str) -> Result<bool, ReadError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompletionRule {
    version: u8,
    rule_ref: String,
    principal: String,
    parent_ref: String,
    child_ref: String,
    wake_message: String,
}

pub struct ScopedAutomationApplication<R> {
    authority: Arc<super::ScopedAuthority>,
    instance: InstanceRef,
    grants: Vec<Grant>,
    policy: Arc<dyn super::create_prompt::FreshSessionGrantPolicy + Send + Sync>,
    reader: Arc<R>,
    deliver: Arc<dyn ApplicationPort>,
    delivery_mode: catalog::DeliveryMode,
}

impl<R> ScopedAutomationApplication<R> {
    pub fn new(
        authority: Arc<super::ScopedAuthority>,
        instance: InstanceRef,
        grants: Vec<Grant>,
        policy: Arc<dyn super::create_prompt::FreshSessionGrantPolicy + Send + Sync>,
        reader: Arc<R>,
        deliver: Arc<dyn ApplicationPort>,
        delivery_mode: catalog::DeliveryMode,
    ) -> Self {
        Self { authority, instance, grants, policy, reader, deliver, delivery_mode }
    }

    fn effective_grants(&self, identity: &ConnectionIdentity, refs: &[&SessionRef]) -> Result<Vec<Grant>, &'static str> {
        let Caller::Principal(principal) = identity.caller() else { return Err("unauthorized") };
        let mut grants = self.grants.clone();
        for session in refs {
            for (action, grant) in [
                (Action::Read, self.policy.session_read_grant(&principal.id, &self.instance, session)),
                (Action::Write, self.policy.session_write_grant(&principal.id, &self.instance, session)),
            ] {
                let grant = grant.map_err(|_| "policy_unavailable")?;
                if let Some(grant) = grant {
                    if grant.principal != principal.id
                        || grant.action != action
                        || grant.resource != PrivateResource::Session((*session).clone())
                    { return Err("unauthorized") }
                    grants.push(grant);
                }
            }
            for action in [Action::Read, Action::Write] {
                identity.authorize(&grants, &PrivateResource::Session((*session).clone()), action)
                    .map_err(|_| "unauthorized")?;
            }
        }
        Ok(grants)
    }

    fn rule_scope(principal: &str) -> String { format!("automation:child-completion:{principal}") }
    fn rule_key(rule_ref: &str) -> String { format!("rule:{rule_ref}") }

    fn read_rule(&self, principal: &str, rule_ref: &str) -> Result<Option<CompletionRule>, &'static str> {
        let (_gate, writer) = self.authority.lock().map_err(|_| "scope_unavailable")?;
        let Some(raw) = writer.get_setting(&Self::rule_scope(principal), &Self::rule_key(rule_ref)).map_err(|_| "store_unavailable")? else { return Ok(None) };
        let rule: CompletionRule = serde_json::from_str(&raw).map_err(|_| "store_unavailable")?;
        if rule.version != 1 || rule.rule_ref != rule_ref || rule.principal != principal { return Err("store_unavailable") }
        Ok(Some(rule))
    }
}

impl<R: CompletedTurnReader> ApplicationPort for ScopedAutomationApplication<R> {
    fn call<'a>(&'a self, identity: &'a ConnectionIdentity, request: catalog::Request) -> ApplicationFuture<'a> {
        Box::pin(async move {
            let catalog::Request::Automation(action) = request else { return None };
            let Caller::Principal(principal) = identity.caller() else { return Some(error("unauthorized")) };
            match action {
                catalog::Automation::Create { session_ref, rule: catalog::AutomationRule::ChildCompletion { child_ref, wake_message }, request_key } => {
                    let parent = SessionRef(session_ref);
                    let child = SessionRef(child_ref);
                    if request_key.is_empty() || request_key.len() > 4096 || wake_message.trim().is_empty() || wake_message.len() > 32768 {
                        return Some(error("invalid_request"));
                    }
                    let grants = match self.effective_grants(identity, &[&parent, &child]) { Ok(g) => g, Err(code) => return Some(error(code)) };
                    let parent_address = match self.authority.resolve_session_read(identity, &grants, &parent, &self.instance) { Ok((a,_)) => a, Err(_) => return Some(error("parent_unavailable")) };
                    let child_address = match self.authority.resolve_session_read(identity, &grants, &child, &self.instance) { Ok((a,_)) => a, Err(_) => return Some(error("child_unavailable")) };
                    if parent_address.instance != child_address.instance { return Some(error("instance_mismatch")); }
                    // Rule identity is scoped to the owner and idempotency key;
                    // payload remains the stored value so key reuse with changed
                    // content is rejected by put_setting_once.
                    let identity = serde_json::to_vec(&(1u8, &principal.id.0, &request_key)).unwrap_or_default();
                    let rule_ref = format!("completion-rule:{}", hex(&Sha256::digest(identity)));
                    let rule = CompletionRule { version: 1, rule_ref: rule_ref.clone(), principal: principal.id.0.clone(), parent_ref: parent.0, child_ref: child.0, wake_message };
                    let raw = match serde_json::to_string(&rule) { Ok(v) => v, Err(_) => return Some(error("invalid_request")) };
                    let now = match super::mcp_deliver::utc_now() { Ok(v) => v, Err(_) => return Some(error("clock_unavailable")) };
                    let admitted = {
                        let (_gate, mut writer) = match self.authority.lock() { Ok(v) => v, Err(_) => return Some(error("scope_unavailable")) };
                        writer.put_setting_once(&Self::rule_scope(&principal.id.0), &Self::rule_key(&rule_ref), &raw, &now)
                    };
                    match admitted {
                        Ok(SettingAdmission::Stored | SettingAdmission::Existing) => Some(CallToolResult::structured(json!({"rule_ref":rule_ref,"status":"registered","parent_ref":rule.parent_ref,"child_ref":rule.child_ref}))),
                        Ok(SettingAdmission::Conflict) => Some(error("idempotency_conflict")),
                        Err(_) => Some(error("store_unavailable")),
                    }
                }
                catalog::Automation::List { session_ref, cursor } => {
                    if cursor.is_some() { return Some(error("unsupported_cursor")); }
                    let parent = session_ref.map(SessionRef);
                    let mut rules = Vec::new();
                    let (_gate, writer) = match self.authority.lock() { Ok(v) => v, Err(_) => return Some(error("scope_unavailable")) };
                    let scope = Self::rule_scope(&principal.id.0);
                    let rows = match writer.list_settings(&scope, "rule:") { Ok(rows) => rows, Err(_) => return Some(error("store_unavailable")) };
                    drop(writer);
                    drop(_gate);
                    for (_, raw) in rows {
                        let Ok(rule) = serde_json::from_str::<CompletionRule>(&raw) else { return Some(error("store_unavailable")) };
                        if parent.as_ref().is_some_and(|p| p.0 != rule.parent_ref) { continue; }
                        let parent_ref = SessionRef(rule.parent_ref.clone());
                        let Ok(grants) = self.effective_grants(identity, &[&parent_ref]) else { continue };
                        if self.authority.resolve_session_read(identity, &grants, &parent_ref, &self.instance).is_err() { continue; }
                        rules.push(json!({"rule_ref":rule.rule_ref,"kind":"child_completion","parent_ref":rule.parent_ref,"child_ref":rule.child_ref,"wake_message":rule.wake_message}));
                    }
                    Some(CallToolResult::structured(json!({"rules":rules,"complete":true,"source":"scoped_automation_rules"})))
                }
                catalog::Automation::Reconcile { rule_ref, child_ref, event_id } => {
                    if event_id.is_empty() || event_id.len() > 4096 { return Some(error("invalid_event")); }
                    let rule = match self.read_rule(&principal.id.0, &rule_ref) { Ok(Some(r)) => r, Ok(None) => return Some(error("rule_not_found")), Err(code) => return Some(error(code)) };
                    if rule.child_ref != child_ref { return Some(error("child_binding_mismatch")); }
                    let parent = SessionRef(rule.parent_ref.clone());
                    let child = SessionRef(rule.child_ref.clone());
                    let grants = match self.effective_grants(identity, &[&parent, &child]) { Ok(g) => g, Err(code) => return Some(error(code)) };
                    let parent_address = match self.authority.resolve_session(identity, &grants, &parent, &self.instance) { Ok((a,_)) => a, Err(_) => return Some(error("parent_unavailable")) };
                    let (child_address, _) = match self.authority.resolve_session_read(identity, &grants, &child, &self.instance) { Ok(v) => v, Err(_) => return Some(error("child_unavailable")) };
                    if parent_address.instance != child_address.instance { return Some(error("instance_mismatch")); }
                    // Hook event_id is the native turn ID, confirmed from a
                    // fresh exact-session native snapshot below.
                    match self.reader.confirms_completed_turn(&child_address, &event_id) {
                        Ok(true) => (),
                        Ok(false) => return Some(error("completion_unconfirmed")),
                        Err(_) => return Some(error("completion_source_unavailable")),
                    }
                    let request_key = format!("child-wake:{}", hex(&Sha256::digest(format!("{}\0{}", rule_ref, event_id).as_bytes())));
                    let message = format!("{}\n\nChild session {} completed native turn {}.", rule.wake_message, child.0, event_id);
                    let admission = {
                        let (_gate, mut writer) = match self.authority.lock() { Ok(v) => v, Err(_) => return Some(error("scope_unavailable")) };
                        let payload = hex(&Sha256::digest(serde_json::to_vec(&(&parent.0, &child.0, &event_id, &message)).unwrap_or_default()));
                        writer.admit_event_once(&format!("completion-wake:{}", principal.id.0), &format!("{}:{}", rule_ref, event_id), &payload, &match super::mcp_deliver::utc_now() { Ok(v) => v, Err(_) => return Some(error("clock_unavailable")) })
                    };
                    if matches!(admission, Err(_)) || matches!(admission, Ok(EventAdmission::Conflict)) { return Some(error("event_conflict")); }
                    if matches!(admission, Ok(EventAdmission::AlreadyAdmitted)) {
                        let request_key = format!("child-wake:{}", hex(&Sha256::digest(format!("{}\0{}", rule_ref, event_id).as_bytes())));
                        let raw = serde_json::to_vec(&("mcp-deliver-v1", &principal.id.0, &parent.0, &request_key)).unwrap_or_default();
                        let suffix = hex(&Sha256::digest(raw));
                        let task_id = format!("mcp-delivery-task:{suffix}");
                        return match self.authority.get_delivery_task(identity, &grants, &task_id) {
                            Ok(Some(task)) => Some(CallToolResult::structured(json!({"rule_ref":rule_ref,"child_ref":child.0,"parent_ref":parent.0,"event_id":event_id,"admission":"existing","delivery":serde_json::to_value(task).unwrap_or_default()}))),
                            // Admission survived but there is no durable delivery
                            // receipt: the effect may have been interrupted at the
                            // crash boundary. Never create a second native send.
                            Ok(None) | Err(_) => Some(CallToolResult::structured_error(json!({"code":"completion_effect_outcome_unknown","effect":"unknown","retry":"forbidden","event_id":event_id}))),
                        };
                    }
                    let deliver_request = catalog::Request::Deliver(catalog::Deliver::Session {
                        session_ref: parent.0.clone(), message, mode: self.delivery_mode.clone(), request_key,
                    });
                    let Some(delivery) = self.deliver.call(identity, deliver_request).await else { return Some(error("delivery_unavailable")); };
                    Some(CallToolResult::structured(json!({"rule_ref":rule_ref,"child_ref":child.0,"parent_ref":parent.0,"event_id":event_id,"admission":if matches!(admission, Ok(EventAdmission::Admitted)) {"admitted"} else {"existing"},"delivery":serde_json::to_value(delivery).unwrap_or_default()})))
                }
                _ => Some(error("unsupported")),
            }
        })
    }
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
fn error(code: &str) -> CallToolResult { CallToolResult::structured_error(json!({"code":code,"effect":"none"})) }
