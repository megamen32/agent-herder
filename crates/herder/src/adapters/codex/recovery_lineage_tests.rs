use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};

use super::*;
use crate::{adapters::codex::connection::CodexInstance, domain::address::NodeRef};

const CHILD: &str = "codex-child";
const PARENT: &str = "codex-parent";
const ROOT: &str = "codex-root";
const BEARER: &str = "synthetic-child-test-bearer";
const ENDPOINT: &str = "http://127.0.0.1:19101/v1";

const FIXTURE: &str = r#"
import json, os, pathlib, sys
home = pathlib.Path(os.environ["CODEX_HOME"])
case = (home / "case").read_text()
root, parent, child = "codex-root", "codex-parent", "codex-child"
resumed = False

def thread(id):
    row = {"id": id, "sessionId": root, "source": "appServer", "ephemeral": False,
           "cwd": str(home / id), "modelProvider": "pinned", "model": "saved-model"}
    if id != root:
        direct = parent if id == child else root
        if case == "cycle" and id == parent:
            direct = child
        row.update(parentThreadId=direct, source={"subAgent": {"thread_spawn": {
            "parent_thread_id": direct, "depth": 2 if id == child else 1}}})
    if id == child:
        row["status"] = {"type": "idle" if resumed else "notLoaded"}
        row["canAcceptDirectInput"] = (case != "no-input") if resumed else None
        if case == "fork":
            row["forkedFromId"] = "other-thread"
        if case == "attached":
            row["attachedToThreadId"] = parent
        if case == "contradictory-parent":
            row["parentThreadId"] = root
        if case == "review":
            row["source"] = {"subAgent": "review"}
    elif case == "parent-idle" and id == parent:
        row["status"] = {"type": "idle"}
    else:
        flags = ["waitingOnUserInput"] if case == "root-waiting" and id == root else []
        row["status"] = {"type": "active", "activeFlags": flags}
    return row

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method, params = request["method"], request.get("params", {})
    target = params.get("threadId")
    with (home / "calls").open("a") as calls:
        print(method, target or "-", file=calls)
    if method == "initialize":
        result = {"codexHome": str(home)}
    elif method == "thread/read":
        assert params["includeTurns"] is False and target in (child, parent, root)
        result = {"thread": thread(target)}
    elif method == "thread/list":
        (id,) = [id for id in (child, parent, root) if str(home / id) == params["cwd"]]
        assert params["archived"] is False and params["useStateDbOnly"] is True
        row = thread(id)
        if id != root:
            assert params["sourceKinds"] == ["subAgentThreadSpawn"]
            assert params["parentThreadId"] == row["parentThreadId"]
        result = {"data": [] if case == "archived-parent" and id == parent else [row],
                  "nextCursor": None}
    elif method == "thread/turns/list":
        assert params["limit"] == 1 and params["sortDirection"] == "desc"
        if target == child:
            assert params["itemsView"] == "summary"
            turn = {"id": "child-failed-turn", "status": "failed",
                    "rootTurnId": None if case == "unknown-work-root" else "root-turn",
                    "itemsView": "summary", "startedAt": 100, "completedAt": 101,
                    "items": [{"type": "userMessage", "id": "child-input"}],
                    "error": {"codexErrorInfo": "usageLimitExceeded"}}
            if (home / "started").exists():
                turn.update(id="child-continuation", status="completed", error=None)
            elif resumed and case == "child-turn-replaced":
                turn.update(id="different-child-turn")
        else:
            assert params["itemsView"] == "notLoaded"
            tid = "root-turn" if target == root else "parent-turn"
            work_root = "root-turn"
            if target == parent and case == "unrelated-parent-turn":
                work_root = "different-root-turn"
            if target == parent and resumed and case == "parent-turn-replaced":
                tid = "different-parent-turn"
            turn = {"id": tid, "status": "inProgress", "rootTurnId": work_root,
                    "completedAt": None, "itemsView": "notLoaded", "items": []}
        result = {"data": [turn], "nextCursor": None}
    elif method == "thread/items/list":
        assert target == child and params["turnId"] in ("child-failed-turn", "different-child-turn")
        assert params["sortDirection"] == "desc" and params["limit"] == 32
        assert params["deferOutput"] == {"commandExecution": True, "mcpToolCall": True}
        result = {"data": [{"turnId": params["turnId"],
                            "item": {"type": "userMessage", "id": "child-input"}}], "nextCursor": None}
    elif method == "thread/goal/get":
        assert target in (child, parent, root)
        goal = None
        if target == parent:
            status = "paused" if case == "parent-paused-goal" or (case == "parent-goal-changed" and resumed) else "active"
            goal = {"threadId": target, "status": status}
        if target == root and case == "root-blocked-goal":
            goal = {"threadId": target, "status": "blocked"}
        if target == root and case == "root-foreign-goal":
            goal = {"threadId": parent, "status": "active"}
        result = {} if target == root and case == "root-unknown-goal" else {"goal": goal}
    elif method == "thread/queue/list":
        assert target == child
        result = {"data": []}
    elif method == "config/read":
        result = {"config": {"model_providers": {
            "pinned": {"wire_api": "responses", "base_url": "http://127.0.0.1:19101/v1",
                       "experimental_bearer_token": "synthetic-child-test-bearer"}
        }}}
    elif method == "thread/resume":
        assert target == child
        resumed = True
        result = {"thread": thread(child), "cwd": str(home / child),
                  "model": "saved-model", "modelProvider": "pinned"}
    elif method == "turn/start":
        assert target == child and resumed
        assert params["parentTurnId"] == "parent-turn" and params["rootTurnId"] == "root-turn"
        assert params["clientUserMessageId"] == "child-recovery-original"
        (home / "started").touch()
        result = {"turn": {"id": "child-continuation", "status": "inProgress",
                           "rootTurnId": "other-work" if case == "unproved-ack" else "root-turn"}}
    else:
        raise RuntimeError("unexpected fixture method: " + method)
    print(json.dumps({"id": request["id"], "result": result}), flush=True)
"#;

struct Stand {
    home: PathBuf,
    target: SessionAddress,
}

impl Stand {
    fn new(case: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
        let home = std::env::temp_dir().join(format!(
            "herder-codex-child-recovery-{}-{stamp}-{sequence}",
            std::process::id(),
        ));
        fs::create_dir(&home).unwrap();
        let stand = Self {
            home: home.canonicalize().unwrap(),
            target: SessionAddress {
                instance: InstanceRef {
                    node: NodeRef("fixture-node".into()),
                    instance_id: "fixture-instance".into(),
                },
                native_session_id: CHILD.into(),
            },
        };
        fs::write(stand.home.join("case"), case).unwrap();
        fs::write(stand.home.join("app-server"), FIXTURE).unwrap();
        stand
    }

    fn open(&self) -> CodexControl {
        CodexControl::open(
            CodexInstance {
                instance_id: self.target.instance.instance_id.clone(),
                executable: PathBuf::from("/usr/bin/python3"),
                code_home: self.home.clone(),
                cwd: self.home.clone(),
                socket_path: None,
            },
            self.target.instance.clone(),
            Duration::from_secs(4),
        )
        .unwrap()
    }

    fn mutation_calls(&self) -> Vec<String> {
        fs::read_to_string(self.home.join("calls"))
            .unwrap()
            .lines()
            .filter(|line| line.starts_with("thread/resume ") || line.starts_with("turn/start "))
            .map(str::to_owned)
            .collect()
    }
}

impl Drop for Stand {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn submit(
    control: &dyn RecoveryControl,
    target: &SessionAddress,
    boundary: &RecoveryBoundary,
    allowed: &(dyn Fn() -> bool + Sync),
) -> Result<Admission, SubmitError> {
    let credential = static_responses_route(
        &json!({"wire_api":"responses","base_url":ENDPOINT,"experimental_bearer_token":BEARER}),
        "pinned",
    )
    .unwrap()
    .credential;
    control.submit(
        target,
        boundary,
        &RecoveryRoute {
            provider: "pinned".into(),
            model: Some("saved-model".into()),
        },
        RecoveryPermit {
            reserve: 20,
            quota_proof: Some(RecoveryQuotaProof {
                credential: &credential,
                still_available: &|| true,
            }),
            still_allowed: allowed,
        },
        "Continue only the interrupted child work",
        &RequestKey("child-recovery-original".into()),
    )
}

#[test]
fn original_child_recovery_is_bound_to_its_own_turn_and_exact_ancestors() {
    let stand = Stand::new("eligible");
    let control = stand.open();
    let boundary = control.read_boundary(&stand.target).unwrap().unwrap();
    assert_eq!(boundary.turn_id, "child-failed-turn");
    assert_eq!(boundary.input_item_id, "child-input");
    assert_eq!(boundary.failure, RecoveryFailure::Quota);
    let proof: Vec<_> = boundary
        .ancestors
        .iter()
        .map(|ancestor| {
            assert_eq!(ancestor.address.instance, stand.target.instance);
            assert_eq!(
                Path::new(&ancestor.cwd),
                stand.home.join(&ancestor.address.native_session_id)
            );
            (
                ancestor.address.native_session_id.as_str(),
                ancestor.turn_id.as_str(),
            )
        })
        .collect();
    assert_eq!(proof, [(PARENT, "parent-turn"), (ROOT, "root-turn")]);
    let mut incomplete = boundary.clone();
    incomplete.ancestors.pop();
    assert!(matches!(
        submit(&control, &stand.target, &incomplete, &|| true),
        Err(SubmitError::DefinitelyNotSent { .. })
    ));
    assert!(stand.mutation_calls().is_empty());

    let checks = AtomicUsize::new(0);
    let allowed = || {
        checks.fetch_add(1, Ordering::Relaxed);
        true
    };
    let receipt = submit(&control, &stand.target, &boundary, &allowed)
        .unwrap()
        .receipt;
    assert_eq!(receipt.target, stand.target);
    assert_eq!(receipt.native_id, "child-continuation");
    assert_eq!(checks.load(Ordering::Relaxed), 2);

    drop(control);
    let reopened = stand.open();
    assert!(matches!(
        submit(&reopened, &stand.target, &boundary, &allowed),
        Err(SubmitError::DefinitelyNotSent { .. })
    ));
    assert_eq!(
        stand.mutation_calls(),
        ["thread/resume codex-child", "turn/start codex-child"]
    );
}

#[test]
fn child_recovery_rejects_unproved_lineage_and_ineligible_ancestors() {
    for case in [
        "fork",
        "attached",
        "review",
        "contradictory-parent",
        "cycle",
        "parent-idle",
        "root-waiting",
        "archived-parent",
        "unrelated-parent-turn",
        "unknown-work-root",
        "parent-paused-goal",
        "root-blocked-goal",
        "root-foreign-goal",
        "root-unknown-goal",
    ] {
        let stand = Stand::new(case);
        let control = stand.open();
        assert!(
            control.read_boundary(&stand.target).unwrap().is_none(),
            "{case}"
        );
        assert!(stand.mutation_calls().is_empty(), "{case}");
    }
}

#[test]
fn child_recovery_respects_ancestor_holds_at_both_admission_boundaries() {
    for (denied_at, mutations) in [(0, vec![]), (1, vec!["thread/resume codex-child"])] {
        let stand = Stand::new("eligible");
        let control = stand.open();
        let boundary = control.read_boundary(&stand.target).unwrap().unwrap();
        let calls = AtomicUsize::new(0);
        let allowed = || calls.fetch_add(1, Ordering::Relaxed) != denied_at;
        assert!(matches!(
            submit(&control, &stand.target, &boundary, &allowed),
            Err(SubmitError::DefinitelyNotSent { .. })
        ));
        assert_eq!(calls.load(Ordering::Relaxed), denied_at + 1);
        assert_eq!(stand.mutation_calls(), mutations);
    }
}

#[test]
fn child_recovery_refuses_changed_native_work_or_unavailable_direct_input() {
    for case in [
        "child-turn-replaced",
        "parent-turn-replaced",
        "parent-goal-changed",
        "no-input",
    ] {
        let stand = Stand::new(case);
        let control = stand.open();
        let boundary = control.read_boundary(&stand.target).unwrap().unwrap();
        assert!(
            matches!(
                submit(&control, &stand.target, &boundary, &|| true),
                Err(SubmitError::DefinitelyNotSent { .. })
            ),
            "{case}"
        );
        assert_eq!(
            stand.mutation_calls(),
            ["thread/resume codex-child"],
            "{case}"
        );
    }
}

#[test]
fn child_recovery_retains_unknown_admission_when_turn_ack_names_different_work() {
    let stand = Stand::new("unproved-ack");
    let control = stand.open();
    let boundary = control.read_boundary(&stand.target).unwrap().unwrap();
    assert!(matches!(
        submit(&control, &stand.target, &boundary, &|| true),
        Err(SubmitError::OutcomeUnknown { .. })
    ));
    assert_eq!(
        stand.mutation_calls(),
        ["thread/resume codex-child", "turn/start codex-child"]
    );
}
