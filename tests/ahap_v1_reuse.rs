//! Contract tests for the generic Rust client of the existing TS AHAP port.
//! Included from ahap_opencode.rs so no separate Cargo target is required.
use super::*;
use crate::adapters::ahap::AhapConfig;
use crate::domain::{
    adapter::{DecisionError, SendCommand, decide_send},
    address::NodeRef,
};
use std::{
    fs,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
impl Fixture {
    fn trace(&self) -> Vec<Value> {
        fs::read_to_string(self.0.join("trace"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn sends(&self) -> Vec<Value> {
        self.trace()
            .into_iter()
            .filter(|v| v["method"] == "sendMessage")
            .collect()
    }
    fn status(&self, status: &str) {
        fs::write(self.0.join("status"), status).unwrap();
    }
}

const SCRIPT: &str = r#"
import json,os,sys
config=json.loads(os.environ['CONFIG'])
harness=os.environ['AHAP_HARNESS']
for line in sys.stdin:
 r=json.loads(line); m=r['method']; p=r.get('params',{})
 with open('trace','a') as f:f.write(json.dumps(r)+'\n')
 if m==config.get('error_method','createSession') and 'rpc_error' in config:
  if config.get('error_disconnect'):sys.exit(0)
  frame={'jsonrpc':'2.0','id':r['id']+1 if config.get('wrong_rpc_id') else r['id'],'error':config['rpc_error']}
  if config.get('ambiguous_error'):frame['result']=None
  if config.get('extra_error_frame'):frame['nativeInputMessageId']='contradictory'
  print(json.dumps(frame),flush=True);continue
 if m=='initialize':v={'harness':harness,'capabilities':config['capabilities']}
 elif m=='init':v=None
 elif m=='listSessions':v={'sessions':[{'id':'session:/β','harness':harness}],'exhaustive':False,'reason':'bounded'}
 elif m=='listProjects':v=[{'id':'project:/β','name':'legacy project'}]
 elif m=='getRawTranscript':
  assert p['id']=='session:/β'
  v={'bytes_base64':'AP9hCg==','complete':False,'source':{'kind':'observed-cli-output','location':'native:/β','format':'text'},'timestampCoverage':'none','limitations':['tail only']}
 elif m=='getSession':
  v={'id':'wrong' if config.get('wrong_identity') else p['id'],'harness':harness,'status':open('status').read(),'meta':config.get('meta',{})}
 elif m=='getCoordinationActiveTurnId':v=config.get('turn','turn:/β')
 elif m=='createSession':v={'id':'session:/β','harness':harness}
 elif m=='sendMessage':
  if config.get('disconnect'):sys.exit(0)
  v=config.get('receipt',{'ok':True,'admitted':True,'nativeInputMessageId':'native:/β','inputId':p['options']['inputId'],'sessionId':p['id']})
 elif m=='getSessionMessages':v=config.get('messages',[])
 else:raise Exception(m)
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':v}),flush=True)
"#;

fn fixture(harness: &str, mut config: Value) -> (Fixture, AhapOpenCode, SessionAddress) {
    let dir = std::env::temp_dir().join(format!(
        "herder-v1-reuse-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("adapter.py"), SCRIPT).unwrap();
    fs::write(
        dir.join("status"),
        config["status"].as_str().unwrap_or("idle"),
    )
    .unwrap();
    if config.get("capabilities").is_none() {
        config["capabilities"] = json!({
            "methods": ["init", "createSession", "sendMessage", "getSession", "getSessionMessages",
                "listSessions", "listProjects", "getRawTranscript", "getCoordinationActiveTurnId"],
            "deliveryModes": ["start", "queue", "current"],
            "controlCapabilities": {"steer":true,"terminate":false}
        });
    }
    let instance = InstanceRef {
        node: NodeRef("fixture-node".into()),
        instance_id: "legacy-profile".into(),
    };
    let client = AhapClient::open(AhapConfig {
        instance_id: instance.instance_id.clone(),
        harness: harness.into(),
        executable: fs::canonicalize("/usr/bin/python3").unwrap(),
        args: vec![dir.join("adapter.py").to_string_lossy().into_owned()],
        cwd: dir.clone(),
        env: vec![("CONFIG".into(), config.to_string())],
        timeout: Duration::from_secs(2),
    })
    .unwrap();
    let port = AhapOpenCode::new_with_policy(
        Arc::new(client),
        instance.clone(),
        dir.clone(),
        "fixture".into(),
        AhapPortPolicy {
            harness: harness.into(),
            initial_delivery_mode: SendMode::Start,
        },
    )
    .unwrap();
    let address = SessionAddress {
        instance,
        native_session_id: "session:/β".into(),
    };
    (Fixture(dir), port, address)
}

#[test]
fn read_only_all_harnesses_preserve_wire_and_advertised_methods() {
    for harness in ["opencode", "codex", "zcode", "chatgpt", "zai"] {
        let capabilities = json!({"methods":["listSessions","listProjects","getRawTranscript"],
            "deliveryModes":[],"controlCapabilities":{"steer":false},"vendor":{"exact":true}});
        let (f, port, address) = fixture(harness, json!({"capabilities":capabilities}));
        assert_eq!(port.capabilities(), &capabilities);
        assert_eq!(
            port.list_sessions(json!({"limit":7})).unwrap()["exhaustive"],
            false
        );
        assert_eq!(port.list_projects().unwrap()[0]["id"], "project:/β");
        let raw = port.raw_transcript(&address).unwrap();
        assert_eq!(
            raw,
            json!({"bytes_base64":"AP9hCg==","complete":false,
            "source":{"kind":"observed-cli-output","location":"native:/β","format":"text"},
            "timestampCoverage":"none","limitations":["tail only"]})
        );
        assert!(port.raw_call("getSessionMessages", json!({})).is_err());
        assert!(matches!(
            port.create_root_bounded("create-key", "hi"),
            Err(SubmitError::DefinitelyNotSent { .. })
        ));
        assert_eq!(
            f.trace()
                .iter()
                .map(|r| r["method"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "initialize",
                "listSessions",
                "listProjects",
                "getRawTranscript"
            ]
        );
        assert_eq!(f.trace()[1]["params"], json!({"options":{"limit":7}}));
    }
}

#[test]
fn unadvertised_raw_transcript_never_falls_back_to_message_tail() {
    let (f, port, address) = fixture(
        "opencode",
        json!({"capabilities":{"methods":["getSessionMessages"]}}),
    );
    assert!(port.raw_transcript(&address).is_err());
    assert_eq!(f.trace().len(), 1);
}

#[tokio::test]
async fn existing_session_send_uses_requested_mode_and_exact_request_key() {
    for harness in ["opencode", "codex", "zcode", "chatgpt", "zai"] {
        for mode in [SendMode::Start, SendMode::Queue, SendMode::Current] {
            let (f, port, address) = fixture(
                harness,
                json!({"status":if mode==SendMode::Current {"running"} else {"idle"}}),
            );
            let snapshot = port.snapshot(&address).await.unwrap();
            let plan = decide_send(&snapshot, &SendCommand { mode }).unwrap();
            let receipt = port
                .submit_bounded(plan, "second message", &RequestKey("stable:/β".into()))
                .unwrap();
            assert_eq!(receipt.receipt.target, address);
            assert!(
                matches!(ReceiptReference::decode(&receipt.receipt.native_id).unwrap(), ReceiptReference::Message(id) if id == "native:/β")
            );
            let sends = f.sends();
            assert_eq!(sends.len(), 1);
            let options = &sends[0]["params"]["options"];
            assert_eq!(sends[0]["params"]["id"], "session:/β");
            assert_eq!(options["inputId"], "stable:/β");
            assert_eq!(options["queue"], mode == SendMode::Queue);
            assert_eq!(
                options.get("start"),
                if mode == SendMode::Start {
                    Some(&Value::Bool(true))
                } else {
                    None
                }
            );
            assert_eq!(
                options.get("steer"),
                if mode == SendMode::Current {
                    Some(&Value::Bool(true))
                } else {
                    None
                }
            );
            if mode == SendMode::Current {
                assert_eq!(options["expectedTurnId"], "turn:/β");
            }
            assert!(!f.trace().iter().any(|r| r["method"] == "createSession"));
        }
    }
}

#[tokio::test]
async fn unknown_activity_and_stopped_guards_do_not_admit() {
    for status in ["unknown", "needs_input", "stopped", "error"] {
        let (f, port, address) = fixture("zcode", json!({"status":status}));
        let snapshot = port.snapshot(&address).await.unwrap();
        assert_eq!(snapshot.activity, SessionActivity::Unknown);
        assert_eq!(snapshot.human_stop, status == "stopped");
        assert!(
            decide_send(
                &snapshot,
                &SendCommand {
                    mode: SendMode::Start
                }
            )
            .is_err()
        );
        assert!(matches!(
            port.submit_bounded(
                DispatchPlan {
                    target: address,
                    mode: SendMode::Start,
                    expected_turn: None
                },
                "hi",
                &RequestKey("key".into())
            ),
            Err(SubmitError::DefinitelyNotSent { .. })
        ));
        assert!(f.sends().is_empty());
    }
}

#[tokio::test]
async fn stop_between_snapshot_and_handoff_prevents_send() {
    let (f, port, address) = fixture("codex", json!({}));
    let plan = decide_send(
        &port.snapshot(&address).await.unwrap(),
        &SendCommand {
            mode: SendMode::Start,
        },
    )
    .unwrap();
    f.status("stopped");
    assert!(matches!(
        port.submit_bounded(plan, "hi", &RequestKey("key".into())),
        Err(SubmitError::DefinitelyNotSent { .. })
    ));
    assert!(f.sends().is_empty());
}

#[tokio::test]
async fn missing_or_unsupported_modes_are_not_inferred_from_initial_policy() {
    for modes in [None, Some(json!(["queue"]))] {
        let mut caps = json!({"methods":["init","createSession","sendMessage","getSession","getSessionMessages"]});
        if let Some(modes) = modes {
            caps["deliveryModes"] = modes;
        }
        let (f, port, address) = fixture("opencode", json!({"capabilities":caps}));
        let s = port.snapshot(&address).await.unwrap();
        assert!(matches!(
            decide_send(
                &s,
                &SendCommand {
                    mode: SendMode::Start
                }
            ),
            Err(DecisionError::SupportUnknown(_)) | Err(DecisionError::UnsupportedMode(_))
        ));
        assert!(f.sends().is_empty());
    }
}

#[tokio::test]
async fn unknown_conflicting_and_uncorrelated_receipts_are_not_success_or_retried() {
    for receipt in [
        json!({"ok":true,"admitted":true}),
        json!({"admitted":true,"admissionUnknown":true,"nativeInputMessageId":"native:/β"}),
        json!({"admitted":true,"notSubmitted":true,"nativeInputMessageId":"native:/β"}),
        json!({"admitted":true,"nativeInputMessageId":"native:/β","inputId":"different"}),
        json!({"admitted":true,"nativeInputMessageId":"native:/β","sessionId":"different"}),
    ] {
        let (f, port, address) = fixture("opencode", json!({"receipt":receipt}));
        let plan = decide_send(
            &port.snapshot(&address).await.unwrap(),
            &SendCommand {
                mode: SendMode::Start,
            },
        )
        .unwrap();
        assert!(matches!(
            port.submit_bounded(plan, "hi", &RequestKey("key".into())),
            Err(SubmitError::OutcomeUnknown { .. })
        ));
        assert_eq!(f.sends().len(), 1);
    }
}

#[tokio::test]
async fn disconnect_after_send_is_unknown_with_one_wire_attempt() {
    let (f, port, address) = fixture("opencode", json!({"disconnect":true}));
    let plan = decide_send(
        &port.snapshot(&address).await.unwrap(),
        &SendCommand {
            mode: SendMode::Start,
        },
    )
    .unwrap();
    assert!(matches!(
        port.submit_bounded(plan, "hi", &RequestKey("key".into())),
        Err(SubmitError::OutcomeUnknown { .. })
    ));
    assert_eq!(f.sends().len(), 1);
}

#[tokio::test]
async fn reconcile_message_tail_never_infers_absence_or_completion() {
    let (f, port, address) = fixture("zai", json!({"messages":[{"id":"other","role":"user"}]}));
    let receipt = NativeReceipt {
        target: address,
        native_id: "native:/β".into(),
    };
    assert_eq!(
        port.reconcile(&receipt).await.unwrap(),
        Observation::Unknown { receipt }
    );
    assert!(f.sends().is_empty());
}

#[tokio::test]
async fn exact_identity_and_native_turn_are_not_guessed() {
    let (f, port, mut address) = fixture("codex", json!({"status":"running","turn":null}));
    assert_eq!(
        port.snapshot(&address).await.unwrap().activity,
        SessionActivity::Unknown
    );
    address.instance.node.0 = "other-node".into();
    assert!(port.raw_transcript(&address).is_err());
    assert!(port.snapshot(&address).await.is_err());
    assert!(f.sends().is_empty());
    let (_f, port, address) = fixture("codex", json!({"wrong_identity":true}));
    assert_eq!(
        port.snapshot(&address).await.unwrap_err().0,
        "AHAP session identity mismatch"
    );
}

#[tokio::test]
async fn legacy_sync_and_steer_map_explicitly_without_fresh_start_flag() {
    for (mode, status) in [(SendMode::Start, "idle"), (SendMode::Current, "running")] {
        let (f, port, address) = fixture(
            "codex",
            json!({"status":status,"capabilities":{
            "methods":["init","createSession","sendMessage","getSession","getSessionMessages","getCoordinationActiveTurnId"],
            "deliveryModes":["sync","queue","steer"]}}),
        );
        let plan = decide_send(
            &port.snapshot(&address).await.unwrap(),
            &SendCommand { mode },
        )
        .unwrap();
        port.submit_bounded(plan, "hi", &RequestKey("key".into()))
            .unwrap();
        let sends = f.sends();
        assert_eq!(sends.len(), 1);
        assert!(sends[0]["params"]["options"].get("start").is_none());
        assert_eq!(sends[0]["params"]["options"]["queue"], false);
        if mode == SendMode::Current {
            assert_eq!(sends[0]["params"]["options"]["expectedTurnId"], "turn:/β");
        }
    }
}

#[tokio::test]
async fn changed_turn_rejects_without_native_submission() {
    let (f, port, address) = fixture("codex", json!({"status":"running"}));
    let mut plan = decide_send(
        &port.snapshot(&address).await.unwrap(),
        &SendCommand {
            mode: SendMode::Current,
        },
    )
    .unwrap();
    plan.expected_turn = Some("old-turn".into());
    assert!(matches!(
        port.submit_bounded(plan, "hi", &RequestKey("key".into())),
        Err(SubmitError::DefinitelyNotSent { .. })
    ));
    assert!(f.sends().is_empty());
}

#[tokio::test]
async fn unknown_keeps_exact_receipt_for_reconcile_and_mismatched_rejection_is_unknown() {
    let (f, port, address) = fixture(
        "codex",
        json!({"receipt":{"admissionUnknown":true,"nativeInputMessageId":"native:/β"}}),
    );
    let plan = decide_send(
        &port.snapshot(&address).await.unwrap(),
        &SendCommand {
            mode: SendMode::Start,
        },
    )
    .unwrap();
    match port.submit_bounded(plan, "hi", &RequestKey("key".into())) {
        Err(SubmitError::OutcomeUnknown {
            receipt: Some(receipt),
            ..
        }) => {
            assert_eq!(receipt.target, address);
            assert!(
                matches!(ReceiptReference::decode(&receipt.native_id).unwrap(), ReceiptReference::Message(id) if id == "native:/β")
            );
            assert!(matches!(
                port.reconcile(&receipt).await.unwrap(),
                Observation::Unknown { .. }
            ));
        }
        other => panic!("expected unknown with native receipt, got {other:?}"),
    }
    assert_eq!(f.sends().len(), 1);
    let (f, port, address) = fixture(
        "codex",
        json!({"receipt":{"notSubmitted":true,"sessionId":"other"}}),
    );
    let plan = decide_send(
        &port.snapshot(&address).await.unwrap(),
        &SendCommand {
            mode: SendMode::Start,
        },
    )
    .unwrap();
    assert!(matches!(
        port.submit_bounded(plan, "hi", &RequestKey("key".into())),
        Err(SubmitError::OutcomeUnknown { receipt: None, .. })
    ));
    assert_eq!(f.sends().len(), 1);
}

#[tokio::test]
async fn admitted_turn_receipt_reconciles_only_exact_native_last_turn() {
    for last_turn in [Some("turn:/β"), Some("older-turn"), None] {
        let meta = match last_turn {
            Some(id) => json!({"nativeLastTurn":{"turnId":id,"status":"completed"}}),
            None => json!({}),
        };
        let (f, port, address) = fixture(
            "codex",
            json!({"meta":meta,"receipt":{"ok":true,"admitted":true,"turnId":"turn:/β","inputId":"key"}}),
        );
        let plan = decide_send(
            &port.snapshot(&address).await.unwrap(),
            &SendCommand {
                mode: SendMode::Start,
            },
        )
        .unwrap();
        let admission = port
            .submit_bounded(plan, "hi", &RequestKey("key".into()))
            .expect("exact admitted turn is a native receipt");
        assert_ne!(
            admission.receipt.native_id, "turn:/β",
            "turn must not masquerade as a user-message id"
        );
        let readback = port.reconcile(&admission.receipt).await.unwrap();
        assert_eq!(
            matches!(readback, Observation::Confirmed { .. }),
            last_turn == Some("turn:/β")
        );
        assert_eq!(f.sends().len(), 1);
        assert!(
            !f.trace()
                .iter()
                .any(|r| r["method"] == "getSessionMessages")
        );
    }
}

#[tokio::test]
async fn turn_without_admission_or_context_reservation_is_not_native_admission() {
    for receipt in [
        json!({"ok":true,"turnId":"turn:/β"}),
        json!({"ok":true,"admitted":true,"turnId":"turn:/β","admissionKind":"current_turn_context"}),
    ] {
        let (f, port, address) = fixture("codex", json!({"receipt":receipt}));
        let plan = decide_send(
            &port.snapshot(&address).await.unwrap(),
            &SendCommand {
                mode: SendMode::Start,
            },
        )
        .unwrap();
        assert!(matches!(
            port.submit_bounded(plan, "hi", &RequestKey("key".into())),
            Err(SubmitError::OutcomeUnknown { receipt: None, .. })
        ));
        assert_eq!(f.sends().len(), 1);
    }
}

#[tokio::test]
async fn receipt_prefix_inside_real_message_id_is_not_treated_as_a_turn() {
    let native_id = ReceiptReference::Turn("not-a-real-turn".into()).encode();
    let (f, port, address) = fixture(
        "chatgpt",
        json!({
        "receipt":{"admitted":true,"nativeInputMessageId":native_id},
        "messages":[{"id":native_id,"role":"user"}]}),
    );
    let plan = decide_send(
        &port.snapshot(&address).await.unwrap(),
        &SendCommand {
            mode: SendMode::Start,
        },
    )
    .unwrap();
    let admission = port
        .submit_bounded(plan, "hi", &RequestKey("key".into()))
        .unwrap();
    assert!(matches!(
        port.reconcile(&admission.receipt).await.unwrap(),
        Observation::Confirmed { .. }
    ));
    assert_eq!(f.sends().len(), 1);
    assert!(
        f.trace()
            .iter()
            .any(|r| r["method"] == "getSessionMessages")
    );
}

#[tokio::test]
async fn stale_native_state_and_structured_stop_are_never_idle_send_permission() {
    for meta in [
        json!({"nativeStateObserved":false}),
        json!({"automationStop":{"reason":"human_stop"}}),
    ] {
        let (f, port, address) = fixture("codex", json!({"meta":meta}));
        assert!(
            decide_send(
                &port.snapshot(&address).await.unwrap(),
                &SendCommand {
                    mode: SendMode::Start
                }
            )
            .is_err()
        );
        assert!(f.sends().is_empty());
    }
    let (_f, port, address) = fixture(
        "codex",
        json!({"meta":{"nativeStateObserved":false,"nativeLastTurn":{"turnId":"turn:/β"}}}),
    );
    let receipt = NativeReceipt {
        target: address,
        native_id: ReceiptReference::Turn("turn:/β".into()).encode(),
    };
    assert!(matches!(
        port.reconcile(&receipt).await.unwrap(),
        Observation::Unknown { .. }
    ));
}

fn quota_prewrite_error() -> Value {
    json!({"code":-32000,"message":"untrusted diagnostic never forwarded", "data":{
        "outcome":"not_submitted","admitted":false,"notSubmitted":true,"retryable":false,
        "code":"codex_quota_guard","method":"createSession","operation":"thread/start","reason":"below_reserve"}})
}

#[test]
fn fixq_exact_codex_create_prewrite_quota_is_definitely_not_sent() {
    for reason in [
        "provider_denied",
        "below_reserve",
        "quota_unknown",
        "quota_snapshot_expired",
        "quota_policy_unavailable",
    ] {
        let mut error = quota_prewrite_error();
        error["data"]["reason"] = json!(reason);
        let (f, port, _) = fixture("codex", json!({"rpc_error":error}));
        match port.create_root_bounded("quota-prewrite-fixture", "not sent") {
            Err(SubmitError::DefinitelyNotSent { reason }) => {
                assert_eq!(
                    reason,
                    "Codex quota guard rejected thread/start before native submission"
                );
            }
            other => panic!("expected proven prewrite refusal, got {other:?}"),
        }
        assert_eq!(
            f.trace()
                .iter()
                .filter(|r| r["method"] == "createSession")
                .count(),
            1
        );
        assert!(f.sends().is_empty());
    }
}

#[test]
fn fixq_incomplete_forged_and_transport_failures_stay_unknown() {
    let original = quota_prewrite_error();
    let keys: Vec<_> = original["data"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    let mut invalid = vec![];
    for key in keys {
        let mut missing = original.clone();
        missing["data"].as_object_mut().unwrap().remove(&key);
        invalid.push(missing);
        let mut malformed = original.clone();
        malformed["data"][&key] = Value::Null;
        invalid.push(malformed);
    }
    for (key, value) in [
        ("admitted", json!(true)),
        ("notSubmitted", json!(false)),
        ("retryable", json!(true)),
        ("outcome", json!("unknown")),
        ("code", json!("other_guard")),
        ("method", json!("sendMessage")),
        ("operation", json!("turn/start")),
        ("reason", json!("arbitrary secret")),
        ("nativeInputMessageId", json!("already-admitted")),
    ] {
        let mut forged = original.clone();
        forged["data"][key] = value;
        invalid.push(forged);
    }
    let mut wrong_code = original.clone();
    wrong_code["code"] = json!(-32001);
    invalid.push(wrong_code);
    for error in invalid {
        let (f, port, _) = fixture("codex", json!({"rpc_error":error}));
        assert!(matches!(
            port.create_root_bounded("fixture-key", "not sent"),
            Err(SubmitError::OutcomeUnknown { .. })
        ));
        assert_eq!(
            f.trace()
                .iter()
                .filter(|r| r["method"] == "createSession")
                .count(),
            1
        );
    }
    for flag in [
        "error_disconnect",
        "wrong_rpc_id",
        "ambiguous_error",
        "extra_error_frame",
    ] {
        let mut config = json!({"rpc_error":original});
        config[flag] = json!(true);
        let (f, port, _) = fixture("codex", config);
        assert!(matches!(
            port.create_root_bounded("fixture-key", "not sent"),
            Err(SubmitError::OutcomeUnknown { .. })
        ));
        assert_eq!(
            f.trace()
                .iter()
                .filter(|r| r["method"] == "createSession")
                .count(),
            1
        );
    }
}

#[test]
fn fixq_payload_cannot_override_actual_harness_or_called_method() {
    for (harness, method) in [
        ("opencode", "createSession"),
        ("zcode", "createSession"),
        ("codex", "sendMessage"),
        ("codex", "getSession"),
    ] {
        let (f, port, _) = fixture(
            harness,
            json!({"rpc_error":quota_prewrite_error(),"error_method":method}),
        );
        let error = port
            .client
            .call(method, json!({"id":"session:/β"}))
            .unwrap_err();
        assert!(matches!(
            transport_failure(error),
            SubmitError::OutcomeUnknown { .. }
        ));
        assert_eq!(
            f.trace().iter().filter(|r| r["method"] == method).count(),
            1
        );
    }
}
