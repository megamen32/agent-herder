//! Authenticated create + prompt application, using only trusted composition.
use crate::{
    application::{
        scoped_stop::{
            BoundedFreshRootCreate, BoundedNativeHandoff, ScopeGenerationIssuer, ScopedAuthority,
            create_prompt::{FreshSessionGrantPolicy, create_with_prompt, delivery_identifiers},
        },
        target::{CreateRequest, SessionRefIssuer},
    },
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource},
    domain::adapter::NativeSessionReader,
    mcp::{
        catalog,
        transport::{ApplicationFuture, ApplicationPort},
    },
};
use rmcp::model::CallToolResult;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;

fn input_error(
    code: &'static str,
    field: &'static str,
    issue: &'static str,
    expected: &'static str,
    correction: &'static str,
) -> CallToolResult {
    let diagnostic = crate::error::Diagnostic {
        code,
        field: Some(field),
        received: Some(issue),
        expected: Some(vec![expected]),
        fix: None,
        effect: crate::error::Effect::None,
        retry: crate::error::Retry::SafeSameKey,
        receipt_ref: None,
        diagnostic_ref: None,
    };
    let mut value = serde_json::to_value(diagnostic).expect("static diagnostic");
    value["message"] = json!(issue);
    value["correction"] = json!(correction);
    CallToolResult::structured_error(value)
}

pub struct ScopedCreateApplication<C, I, G, R, D, P> {
    authority: Arc<ScopedAuthority>,
    instance_ref: String,
    grants: Vec<Grant>,
    creator: Arc<C>,
    issuer: Arc<I>,
    generations: Arc<G>,
    reader: Arc<R>,
    delivery: Arc<D>,
    policy: Arc<P>,
    retain_until: String,
}
impl<C, I, G, R, D, P> ScopedCreateApplication<C, I, G, R, D, P> {
    pub fn new(
        authority: Arc<ScopedAuthority>,
        instance_ref: String,
        grants: Vec<Grant>,
        creator: Arc<C>,
        issuer: Arc<I>,
        generations: Arc<G>,
        reader: Arc<R>,
        delivery: Arc<D>,
        policy: Arc<P>,
        retain_until: String,
    ) -> Result<Self, ()> {
        if instance_ref.is_empty() || retain_until.is_empty() {
            return Err(());
        }
        Ok(Self {
            authority,
            instance_ref,
            grants,
            creator,
            issuer,
            generations,
            reader,
            delivery,
            policy,
            retain_until,
        })
    }
}
impl<C, I, G, R, D, P> ApplicationPort for ScopedCreateApplication<C, I, G, R, D, P>
where
    C: BoundedFreshRootCreate + Send + Sync + 'static,
    I: SessionRefIssuer + Send + Sync + 'static,
    G: ScopeGenerationIssuer + Send + Sync + 'static,
    R: NativeSessionReader + Send + Sync + 'static,
    D: BoundedNativeHandoff + Send + Sync + 'static,
    P: FreshSessionGrantPolicy + Send + Sync + 'static,
{
    fn call<'a>(
        &'a self,
        identity: &'a ConnectionIdentity,
        request: catalog::Request,
    ) -> ApplicationFuture<'a> {
        Box::pin(async move {
            let catalog::Request::Create(catalog::Create::Create {
                instance_ref,
                project_ref,
                prompt,
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
            let instance = self.creator.instance().clone();
            let target = match serde_json::to_string(&instance) {
                Ok(v) => v,
                Err(_) => {
                    return Some(CallToolResult::structured_error(
                        json!({"code":"invalid_instance","effect":"none"}),
                    ));
                }
            };
            if identity
                .authorize(
                    &self.grants,
                    &PrivateResource::Resource(format!("instance:{target}")),
                    Action::Write,
                )
                .is_err()
            {
                return Some(CallToolResult::structured_error(
                    json!({"code":"unauthorized","effect":"none"}),
                ));
            }
            if instance_ref != self.instance_ref {
                return Some(input_error(
                    "instance_mismatch",
                    "instance_ref",
                    "instance reference is not the configured target",
                    "the configured instance reference",
                    "Select the authorized instance reference from discovery and retry.",
                ));
            }
            if project_ref.is_some() {
                return Some(input_error(
                    "project_unsupported",
                    "project_ref",
                    "project-scoped create is unsupported",
                    "omit project_ref for an isolated root",
                    "Omit project_ref and retry, or select an application that supports project-scoped creation.",
                ));
            }
            if prompt.is_empty() {
                return Some(input_error(
                    "prompt_required",
                    "prompt",
                    "prompt is empty",
                    "non-empty prompt text",
                    "Provide the intended prompt and retry.",
                ));
            }
            if request_key.is_empty()
                || request_key.len() > 4096
                || request_key.chars().any(char::is_control)
            {
                return Some(input_error(
                    "request_key_invalid",
                    "request_key",
                    "request key is empty, too long, or contains control characters",
                    "a non-empty key of at most 4096 bytes without control characters",
                    "Provide a valid request key and retry.",
                ));
            }
            let bytes = match serde_json::to_vec(&(
                "mcp-create-v1",
                &principal.id.0,
                &instance,
                &request_key,
            )) {
                Ok(v) => v,
                Err(_) => {
                    return Some(CallToolResult::structured_error(
                        json!({"code":"invalid_request","effect":"none"}),
                    ));
                }
            };
            let suffix = Sha256::digest(bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let intent = format!("mcp-create-intent:{suffix}");
            let task = format!("mcp-create-lineage:{suffix}");
            let child = match delivery_identifiers(&principal.id, &instance, &request_key) {
                Ok((_, _, v)) => v,
                Err(_) => {
                    return Some(CallToolResult::structured_error(
                        json!({"code":"invalid_request","effect":"none"}),
                    ));
                }
            };
            let now = match super::mcp_deliver::utc_now() {
                Ok(v) => v,
                Err(_) => {
                    return Some(CallToolResult::structured_error(
                        json!({"code":"clock_unavailable","effect":"none"}),
                    ));
                }
            };
            let authority = self.authority.clone();
            let grants = self.grants.clone();
            let creator = self.creator.clone();
            let issuer = self.issuer.clone();
            let generations = self.generations.clone();
            let reader = self.reader.clone();
            let delivery = self.delivery.clone();
            let policy = self.policy.clone();
            let retain = self.retain_until.clone();
            let identity = identity.clone();
            let run = tokio::task::spawn_blocking(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|_| ())?;
                let outcome = runtime
                    .block_on(create_with_prompt(
                        &authority,
                        &identity,
                        &grants,
                        creator.as_ref(),
                        issuer.as_ref(),
                        generations.as_ref(),
                        reader.as_ref(),
                        delivery.as_ref(),
                        policy.as_ref(),
                        CreateRequest {
                            intent_id: &intent,
                            task_id: &task,
                            request_key: &request_key,
                            specification: &prompt,
                            now: &now,
                            retain_until: &retain,
                        },
                    ))
                    .map_err(|_| ())?;
                authority
                    .record_create_task(&identity, &grants, &instance, &child, outcome)
                    .map_err(|_| ())
            })
            .await;
            match run {
                Ok(Ok(id)) => Some(CallToolResult::structured(
                    json!({"_herder_create_task":id}),
                )),
                _ => Some(CallToolResult::structured_error(
                    serde_json::to_value(crate::error::Diagnostic::outcome_unknown(None)).unwrap(),
                )),
            }
        })
    }
}
