use herder::{
    adapters::{ahap::AhapConfig, ahap_opencode::{AhapOpenCode, AhapPortPolicy}},
    domain::{
        adapter::{NativeSessionReader, RequestKey, SendMode},
        address::{InstanceRef, NodeRef, SessionAddress},
    },
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Fixture(PathBuf);

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(session_field: &str) -> (Fixture, AhapOpenCode, SessionAddress) {
    let dir = std::env::temp_dir().join(format!(
        "herder-ahap-opencode-identity-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&dir).unwrap();
    let script = dir.join("fake-native.py");
    fs::write(
        &script,
        r#"import json,os,sys
session = os.environ["SESSION_ID"]
field = os.environ["SESSION_FIELD"]
for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    params = request.get("params", {})
    with open(os.environ["TRACE"], "a") as trace:
        trace.write(method + "\n")
    if method == "initialize":
        value = {"harness":"opencode", "capabilities":{"methods":["init","getSession","getSessionMessages"],"deliveryModes":["start"]}}
    elif method == "init":
        value = None
    elif method == "getSession":
        value = {"id":session, "harness":"opencode", "status":"idle"}
    elif method == "getSessionMessages":
        row = {"id":"msg_native", "nativeMessageId":"msg_native", "role":"user", "inputId":"request-key"}
        if field == "missing":
            pass
        else:
            row["sessionId"] = field
        value = [row]
    else:
        raise RuntimeError(method)
    print(json.dumps({"jsonrpc":"2.0", "id":request["id"], "result":value}), flush=True)
"#,
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();

    let instance = InstanceRef {
        node: NodeRef("fake-node".into()),
        instance_id: "fake-profile".into(),
    };
    let client = AhapConfig {
        instance_id: instance.instance_id.clone(),
        harness: "opencode".into(),
        executable: fs::canonicalize("/usr/bin/python3").unwrap(),
        args: vec![script.to_string_lossy().into_owned()],
        cwd: dir.clone(),
        env: vec![
            ("SESSION_ID".into(), "session-exact".into()),
            ("SESSION_FIELD".into(), session_field.into()),
            ("TRACE".into(), dir.join("trace").to_string_lossy().into_owned()),
        ],
        timeout: Duration::from_secs(2),
    };
    let adapter = AhapOpenCode::new_with_policy(
        Arc::new(herder::adapters::ahap::AhapClient::open(client).unwrap()),
        instance.clone(),
        dir.clone(),
        "fixture".into(),
        AhapPortPolicy {
            harness: "opencode".into(),
            initial_delivery_mode: SendMode::Start,
        },
    )
    .unwrap();
    let address = SessionAddress {
        instance,
        native_session_id: "session-exact".into(),
    };
    (Fixture(dir), adapter, address)
}

#[tokio::test]
async fn opencode_recovery_requires_native_session_identity_and_never_replays() {
    for session_field in ["missing", "session-other"] {
        let (fixture, adapter, address) = fixture(session_field);
        let recovered = adapter
            .recover_admission(&address, &RequestKey("request-key".into()))
            .await
            .unwrap();
        assert!(recovered.is_none(), "unbound native row must remain UNKNOWN");

        let recovered_again = adapter
            .recover_admission(&address, &RequestKey("request-key".into()))
            .await
            .unwrap();
        assert!(recovered_again.is_none(), "UNKNOWN recovery must not authorize replay");
        let trace = fs::read_to_string(fixture.0.join("trace")).unwrap();
        assert_eq!(trace.lines().filter(|method| *method == "getSessionMessages").count(), 2);
        assert!(!trace.lines().any(|method| method == "sendMessage"));
    }
}
