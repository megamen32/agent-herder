//! One-shot ZCode native session creation on an explicitly selected instance.
//!
//! A successful RPC is accepted only when its matching response contains the
//! exact native session ID. Once `createSession` may have been written, every
//! transport/protocol ambiguity is `Unknown`; this module never retries.

use std::{path::PathBuf, time::Duration};

use serde_json::{Value, json};

use crate::{
    adapters::zcode::connection::{ZcodeConnection, ZcodeConnectionError, ZcodeInstance},
    application::target::NativeCreateOutcome,
};

const CREATE_TIMEOUT: Duration = Duration::from_secs(5);

/// Narrow seam lets offline tests exercise the create admission boundary.
#[allow(async_fn_in_trait)]
pub trait ZcodeCreateTransport {
    async fn initialize(&mut self, workspace: &str) -> Result<(), ZcodeConnectionError>;
    async fn create_session(&mut self, args: Value) -> Result<Value, ZcodeConnectionError>;
}

impl ZcodeCreateTransport for ZcodeConnection {
    async fn initialize(&mut self, workspace: &str) -> Result<(), ZcodeConnectionError> {
        self.request(
            "zcode-agent",
            "initialize",
            json!([{
                "workspacePath": workspace,
                "workspaceIdentity": workspace,
                "workspaceKey": workspace,
            }]),
            CREATE_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    async fn create_session(&mut self, args: Value) -> Result<Value, ZcodeConnectionError> {
        Ok(self
            .request("zcode-agent", "createSession", json!([args]), CREATE_TIMEOUT)
            .await?
            .payload)
    }
}

/// Creates one empty deferred draft. `specification` is deliberately not sent
/// as a prompt; this API call creates a session and does not submit user input.
pub async fn create_once<T: ZcodeCreateTransport>(
    instance: &ZcodeInstance,
    workspace_path: &str,
    request_key: &str,
    specification: &str,
    transport: &mut T,
) -> NativeCreateOutcome {
    if request_key.trim().is_empty()
        || request_key.len() > 4096
        || request_key.chars().any(char::is_control)
        || workspace_path.trim().is_empty()
        || !PathBuf::from(workspace_path).is_absolute()
        || specification.len() > 16 * 1024
    {
        return NativeCreateOutcome::DefinitelyNotSent {
            reason: "invalid ZCode create request".into(),
        };
    }

    // Failure here is known to precede the createSession write.
    if transport.initialize(workspace_path).await.is_err() {
        return NativeCreateOutcome::DefinitelyNotSent {
            reason: "ZCode instance initialization failed before create".into(),
        };
    }

    let args = json!({
        "workspacePath": workspace_path,
        "workspaceIdentity": workspace_path,
        "workspaceKey": workspace_path,
        "mode": "build",
        "persistence": "deferred",
        "sessionTraceId": request_key,
    });
    let payload = match transport.create_session(args).await {
        Ok(payload) => payload,
        Err(_) => return NativeCreateOutcome::Unknown,
    };
    let Some(session_id) = payload
        .get("session")
        .and_then(|session| session.get("sessionId"))
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty() && id.len() <= 4096 && !id.chars().any(char::is_control))
    else {
        // A response without a valid ID may still follow a successful create.
        return NativeCreateOutcome::Unknown;
    };
    NativeCreateOutcome::Confirmed {
        request_key: request_key.to_owned(),
        instance: instance.reference.clone(),
        native_session_id: session_id.to_owned(),
        parent_ref: None,
    }
}

/// Open only the supervisor registered for this exact instance. No process is
/// started and no alternate profile is selected.
pub async fn create_on_instance(
    instance: ZcodeInstance,
    workspace_path: &str,
    request_key: &str,
    specification: &str,
) -> NativeCreateOutcome {
    if request_key.trim().is_empty()
        || request_key.len() > 4096
        || request_key.chars().any(char::is_control)
        || workspace_path.trim().is_empty()
        || !PathBuf::from(workspace_path).is_absolute()
        || specification.len() > 16 * 1024
    {
        return NativeCreateOutcome::DefinitelyNotSent {
            reason: "invalid ZCode create request".into(),
        };
    }
    let mut connection = match ZcodeConnection::open(instance.clone()).await {
        Ok(connection) => connection,
        Err(_) => {
            return NativeCreateOutcome::DefinitelyNotSent {
                reason: "selected ZCode instance unavailable before create".into(),
            };
        }
    };
    create_once(&instance, workspace_path, request_key, specification, &mut connection).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::address::{InstanceRef, NodeRef};
    use std::cell::Cell;

    struct FakeTransport {
        creates: Cell<usize>,
        create_result: Result<Value, ZcodeConnectionError>,
        init_result: Result<(), ZcodeConnectionError>,
        args: Option<Value>,
    }

    impl ZcodeCreateTransport for FakeTransport {
        async fn initialize(&mut self, _workspace: &str) -> Result<(), ZcodeConnectionError> {
            self.init_result.clone()
        }

        async fn create_session(&mut self, args: Value) -> Result<Value, ZcodeConnectionError> {
            self.creates.set(self.creates.get() + 1);
            self.args = Some(args);
            self.create_result.clone()
        }
    }

    fn instance() -> ZcodeInstance {
        ZcodeInstance::new(
            InstanceRef {
                node: NodeRef("test-node".into()),
                instance_id: "test-instance".into(),
            },
            PathBuf::from("/tmp/zcode-test-instance"),
        )
        .unwrap()
    }

    fn fake(result: Result<Value, ZcodeConnectionError>) -> FakeTransport {
        FakeTransport {
            creates: Cell::new(0),
            create_result: result,
            init_result: Ok(()),
            args: None,
        }
    }

    #[tokio::test]
    async fn one_matching_create_response_returns_exact_id_and_never_sends_specification() {
        let mut transport = fake(Ok(json!({"session":{"sessionId":"native-exact-42"}})));
        let outcome = create_once(&instance(), "/workspace/project", "request-42", "task text", &mut transport).await;
        assert!(matches!(outcome, NativeCreateOutcome::Confirmed { ref native_session_id, ref request_key, .. }
            if native_session_id == "native-exact-42" && request_key == "request-42"));
        assert_eq!(transport.creates.get(), 1);
        let args = transport.args.unwrap();
        assert_eq!(args["persistence"], "deferred");
        assert!(args.get("prompt").is_none());
        assert!(args.get("specification").is_none());
    }

    #[tokio::test]
    async fn invalid_request_is_definitely_not_sent_and_unknown_after_possible_write_is_not_retried() {
        let mut invalid = fake(Ok(json!({"session":{"sessionId":"must-not-exist"}})));
        assert!(matches!(create_once(&instance(), "relative", "key", "task", &mut invalid).await,
            NativeCreateOutcome::DefinitelyNotSent { .. }));
        assert_eq!(invalid.creates.get(), 0);

        let mut uncertain = fake(Err(ZcodeConnectionError::OutcomeUnknown));
        assert!(matches!(create_once(&instance(), "/workspace", "key", "task", &mut uncertain).await,
            NativeCreateOutcome::Unknown));
        assert_eq!(uncertain.creates.get(), 1);
    }

    #[tokio::test]
    async fn initialization_failure_is_definitely_not_sent() {
        let mut transport = fake(Ok(json!({"session":{"sessionId":"must-not-exist"}})));
        transport.init_result = Err(ZcodeConnectionError::ServerUnavailable);
        assert!(matches!(create_once(&instance(), "/workspace", "key", "task", &mut transport).await,
            NativeCreateOutcome::DefinitelyNotSent { .. }));
        assert_eq!(transport.creates.get(), 0);
    }
}
