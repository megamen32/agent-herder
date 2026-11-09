//! Local-only enrollment entrypoint. The request key selects an exact approval
//! from the protected owner profile; native identifiers are never CLI/MCP input.
use super::{owner_launch::Ids, owner_opencode, scoped_profile::OpenedOwner};
use herder::{
    application::scoped_stop::enroll::EnrollmentReceipt,
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrincipalId, PrivateResource, VerifiedPrincipal},
    domain::address::{InstanceRef, NodeRef},
};
use serde_json::{Value, json};

fn verify_native(native: &str, call: impl Fn(&str, Value) -> Result<Value, ()>) -> Result<(), ()> {
    if native.starts_with("draft:") { return Err(()) }
    let listed = call("listSessions", json!({"options":{"limit":256}}))?;
    let matches = listed.as_array().ok_or(())?.iter()
        .filter(|row| row.get("id").and_then(Value::as_str) == Some(native)).collect::<Vec<_>>();
    if matches.len() != 1 || matches[0].get("harness").and_then(Value::as_str) != Some("chatgpt") {
        return Err(());
    }
    let exact = call("getSession", json!({"id":native}))?;
    if exact.get("id").and_then(Value::as_str) != Some(native)
        || exact.get("harness").and_then(Value::as_str) != Some("chatgpt")
        || exact.get("needsPermission") == Some(&Value::Bool(true)) {
        return Err(());
    }
    Ok(())
}

/// Preserve the single-key entrypoint and its exact per-entry verification.
pub fn run(opened: OpenedOwner, request_key: &str) -> Result<EnrollmentReceipt, Box<dyn std::error::Error>> {
    let mut receipt = None;
    run_selected(opened, &[request_key.to_string()], |confirmed| {
        receipt = Some(confirmed);
        Ok(())
    })?;
    receipt.ok_or_else(|| "existing-session enrollment produced no receipt".into())
}

/// Local-only selection of the already protected allowlist. Each successful
/// enrollment is committed and flushed before the next entry is attempted.
pub fn run_all(
    opened: OpenedOwner,
    output: &mut impl std::io::Write,
) -> Result<(), Box<dyn std::error::Error>> {
    let keys = opened.owner.existing_sessions.iter()
        .map(|approval| approval.request_key.clone()).collect::<Vec<_>>();
    if keys.is_empty() {
        return Err("protected owner profile has no approved existing sessions".into());
    }
    run_selected(opened, &keys, |receipt| {
        serde_json::to_writer(&mut *output, &receipt)?;
        output.write_all(b"\n")?;
        output.flush()?;
        Ok(())
    })
}

fn run_selected(
    opened: OpenedOwner,
    request_keys: &[String],
    mut confirmed: impl FnMut(EnrollmentReceipt) -> Result<(), Box<dyn std::error::Error>>,
) -> Result<(), Box<dyn std::error::Error>> {
    if opened.owner.kind != "chatgpt" {
        return Err("existing-session enrollment requires a ChatGPT owner profile".into());
    }
    let approvals = request_keys.iter().map(|key| {
        opened.owner.existing_sessions.iter().find(|entry| &entry.request_key == key)
            .ok_or("request key is not approved in this protected owner profile")
    }).collect::<Result<Vec<_>, _>>()?;
    for approval in &approvals {
        if !approval.valid()
            || opened.owner.ahap_env.get("AHAP_BROWSER_ACCOUNT_SCOPE") != Some(&approval.account_scope) {
            return Err("existing-session account approval does not match the pinned adapter".into());
        }
    }
    let instance = InstanceRef { node: NodeRef(opened.owner.node.clone()), instance_id: opened.owner.instance.clone() };
    let principal = PrincipalId(opened.owner.principal.clone());
    let identity = ConnectionIdentity::new(Caller::Principal(VerifiedPrincipal { id: principal.clone() }), None);
    let grants = vec![Grant { principal, resource: PrivateResource::Resource(format!("instance:{}", serde_json::to_string(&instance)?)), action: Action::Write }];
    // One pinned native client for this CLI invocation. Do not hold a shared
    // authority gate across the loop or reuse a list snapshot between entries.
    let (adapter, _) = owner_opencode::open_adapter(&opened.owner, &instance)?;
    for approval in approvals {
        let receipt = opened.authority.enroll_existing_session(
            &identity, &grants, &instance, approval, &Ids, &Ids,
            || verify_native(&approval.native_session_id,
                |method, params| adapter.raw_call(method, params).map_err(|_| ())),
        ).map_err(|error| format!(
            "existing-session enrollment refused ({error:?}); no native create or send was attempted"
        ))?;
        // An output/flush failure stops the batch too. The confirmed entry is
        // already durable and exact-key replay returns its existing receipt.
        confirmed(receipt)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn reads_exact_canonical_session_without_writes() {
        let calls=RefCell::new(Vec::new());
        verify_native("dot~conversation", |method, params| {
            calls.borrow_mut().push(method.to_string());
            Ok(match method {
                "listSessions" => json!([{"id":"dot~conversation","harness":"chatgpt"}]),
                "getSession" if params["id"] == "dot~conversation" => json!({"id":"dot~conversation","harness":"chatgpt","needsPermission":false}),
                _ => panic!("enrollment must not create, send, or use aliases"),
            })
        }).unwrap();
        assert_eq!(*calls.borrow(), ["listSessions", "getSession"]);
    }
    #[test]
    fn ambiguous_or_unlisted_or_foreign_ids_fail_before_get() {
        for listed in [
            json!([]),
            json!([{"id":"native","harness":"zai"}]),
            json!([{"id":"native","harness":"chatgpt"},{"id":"native","harness":"chatgpt"}]),
        ] {
            let calls=RefCell::new(0);
            assert!(verify_native("native", |method,_| { assert_eq!(method,"listSessions");*calls.borrow_mut()+=1;Ok(listed.clone()) }).is_err());
            assert_eq!(*calls.borrow(),1);
        }
        assert!(verify_native("draft:alias", |_,_| panic!("draft aliases are not native identities")).is_err());
    }
    #[test]
    fn get_must_match_canonical_list_identity_and_access() {
        for exact in [json!(null),json!({"id":"other","harness":"chatgpt"}),json!({"id":"native","harness":"zai"}),json!({"id":"native","harness":"chatgpt","needsPermission":true})] {
            assert!(verify_native("native", |method,_| Ok(if method=="listSessions" {json!([{"id":"native","harness":"chatgpt"}])} else {exact.clone()})).is_err());
        }
    }
}
