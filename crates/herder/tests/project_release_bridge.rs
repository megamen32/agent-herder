#![cfg(target_os = "linux")]

use herder::{
    application::project_release_bridge::token_claim_id,
    domain::{
        address::{Authorization, NodeRef},
        resource::{ResourceClaim, ResourceDescriptor, ResourceKind, ResourceRef, ResourceScope},
    },
    ownership::{
        claim,
        manifest::{AuthorityRoute, ResourceMarker, StorageAuthority, StorageId, StorageMarker},
    },
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
fn binary() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_herder_resource_bridge"))
}
fn write_private(path: &Path, value: &impl Serialize) {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    serde_json::to_writer(&mut file, value).unwrap();
    file.write_all(b"\n").unwrap();
    file.sync_all().unwrap();
}
struct Fixture {
    root: PathBuf,
    executable: PathBuf,
    config: PathBuf,
    ledger: PathBuf,
    process_config: PathBuf,
    projects: [PathBuf; 2],
    fleet: PathBuf,
    authority: StorageAuthority,
    resource: ResourceRef,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "herder-release-bridge-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let executable = root.join("herder_resource_bridge");
        fs::copy(binary(), &executable).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let projects = [root.join("project-a.git"), root.join("project-b.git")];
        let fleet = root.join("fleet");
        for p in [&projects[0], &projects[1], &fleet] {
            fs::create_dir(p).unwrap();
            fs::set_permissions(p, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let authority = StorageAuthority {
            storage_id: StorageId("bridge-fixture".into()),
            authority_node: NodeRef("node-fixture".into()),
            root: root.join("resources-authority"),
            schema: "v1".into(),
            route: AuthorityRoute::Local,
        };
        let resource = ResourceRef("deployment-fixture".into());
        fs::create_dir_all(authority.root.join("resources").join(&resource.0)).unwrap();
        for p in [
            &authority.root,
            &authority.root.join("resources"),
            &authority.root.join("resources").join(&resource.0),
        ] {
            fs::set_permissions(p, fs::Permissions::from_mode(0o700)).unwrap();
        }
        write_private(
            &authority.root.join("storage.json"),
            &StorageMarker {
                schema: authority.schema.clone(),
                storage_id: authority.storage_id.clone(),
            },
        );
        let descriptor = ResourceDescriptor::new(
            resource.clone(),
            ResourceScope::Global,
            ResourceKind::Deployment,
            "fixture-only-deployment".into(),
            authority.storage_id.0.clone(),
            None,
            1,
        );
        write_private(
            &authority
                .root
                .join("resources")
                .join(&resource.0)
                .join("resource.json"),
            &ResourceMarker {
                schema: authority.schema.clone(),
                storage_id: authority.storage_id.clone(),
                resource_ref: resource.clone(),
                scope: ResourceScope::Global,
                descriptor: Some(descriptor),
            },
        );
        let process_config = root.join("process-config.json");
        write_private(
            &process_config,
            &json!({"version":1,"node_ref":"node-fixture","worker":executable,
            "execution_root":root.join("executions"),"resources":authority,"administrators":["bridge-admin"]}),
        );
        let config = root.join("bridge-config.json");
        let ledger = root.join("legacy-ledger.json");
        let f = Self {
            root,
            executable,
            config,
            ledger,
            process_config,
            projects,
            fleet,
            authority,
            resource,
        };
        f.write_config();
        f.write_ledger();
        f
    }
    fn write_config(&self) {
        write_private(
            &self.config,
            &json!({"version":1,"process_config":self.process_config,"ledger":self.ledger,
            "seal_id":"fixture-seal","principal_ref":"bridge-admin","mappings":[
                {"project":self.projects[0],"resource_ref":self.resource,"revision":1,"previous_fence":7,
                 "deployment_target":{"fleetDir":self.fleet,"unit":"fixture.service"}},
                {"project":self.projects[1],"resource_ref":self.resource,"revision":1,"previous_fence":41,
                 "deployment_target":{"fleetDir":self.fleet,"unit":"fixture.service"}}
            ]}),
        );
    }
    fn write_ledger(&self) {
        write_private(
            &self.ledger,
            &json!({"version":2,"canonical":{"version":1,"config":self.config,
            "bridge":self.executable.canonicalize().unwrap(),"seal_id":"fixture-seal"},"projects":{}}),
        );
    }
    fn owner() -> Value {
        json!({"hostId":"fixture-host","harness":"fixture-harness","nativeSessionId":"fixture-session"})
    }
    fn request(&self, action: &str, project: usize) -> Value {
        json!({"action":action,"project":self.projects[project]})
    }
    fn acquire_request(&self, project: usize, token: &str) -> Value {
        let mut r = self.request("acquire", project);
        r["owner"] = Self::owner();
        r["token"] = json!(token);
        r["ttlSeconds"] = json!(300);
        r
    }
    fn proof_request(&self, action: &str, project: usize, token: &str, fence: u64) -> Value {
        let mut r = self.request(action, project);
        r["owner"] = Self::owner();
        r["token"] = json!(token);
        r["fence"] = json!(fence);
        r
    }
    fn call(&self, request: Value) -> Value {
        call(&self.executable, &self.config, request)
    }
    fn resource_dir(&self) -> PathBuf {
        self.authority.root.join("resources").join(&self.resource.0)
    }
    fn force_expired(&self) {
        let path = self.resource_dir().join("owner.json");
        let mut owner: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        owner["claim"]["expires_at"] = json!("unix-seconds:1");
        write_private(&path, &owner);
    }
    fn guard(&self, token: &str, fence: u64) -> GuardProcess {
        let mut p = GuardProcess::start(&self.executable, &self.config);
        let result = p.send(self.proof_request("guard", 0, token, fence));
        assert_eq!(result["ok"], true, "guard failed: {result}");
        assert_eq!(result["result"]["guarded"], true);
        p
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn call(executable: &Path, config: &Path, request: Value) -> Value {
    let mut child = Command::new(executable)
        .args(["--config"])
        .arg(config)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    serde_json::to_writer(&mut stdin, &request).unwrap();
    stdin.write_all(b"\n").unwrap();
    drop(stdin);
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "bridge process failed: {:?}",
        result.status
    );
    assert!(
        result.stderr.is_empty(),
        "bridge must not echo proof into diagnostics"
    );
    serde_json::from_slice(&result.stdout).unwrap()
}
struct GuardProcess {
    child: Child,
    input: Option<ChildStdin>,
    output: BufReader<ChildStdout>,
}
impl GuardProcess {
    fn start(executable: &Path, config: &Path) -> Self {
        let mut child = Command::new(executable)
            .arg("--config")
            .arg(config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
        }
    }
    fn send(&mut self, request: Value) -> Value {
        let stdin = self.input.as_mut().unwrap();
        serde_json::to_writer(&mut *stdin, &request).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
        let mut line = String::new();
        assert!(
            self.output.read_line(&mut line).unwrap() > 0,
            "guard closed unexpectedly"
        );
        serde_json::from_str(&line).unwrap()
    }
    fn eof(&mut self) {
        self.input.take();
        assert!(self.child.wait().unwrap().success());
    }
    fn crash(&mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }
}
impl Drop for GuardProcess {
    fn drop(&mut self) {
        self.input.take();
        if self.child.try_wait().unwrap_or(None).is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[test]
fn aliases_share_counter_and_retry_recovers_original_claim_after_renewal() {
    let f = Fixture::new();
    let token = "a".repeat(64);
    assert_eq!(
        token_claim_id(&token).unwrap(),
        "ffe054fe-7ae0-5b6d-865c-3af9b61d5209"
    );
    let acquire = f.acquire_request(0, &token);
    let first = f.call(acquire.clone());
    assert_eq!(first["ok"], true);
    assert_eq!(first["result"]["lease"]["fence"], 42);
    assert_eq!(first["result"]["token"], token);
    assert_eq!(
        f.call(acquire.clone()),
        first,
        "lost ACK must not acquire a second generation"
    );
    let mut renewal = f.proof_request("renew", 1, &token, 42);
    renewal["ttlSeconds"] = json!(600);
    let renewed = f.call(renewal);
    assert_eq!(renewed["ok"], true);
    let replay = f.call(acquire);
    assert_eq!(
        replay["result"]["lease"]["expiresAt"],
        renewed["result"]["expiresAt"]
    );
    assert_eq!(replay["result"]["lease"]["fence"], 42);
    assert_eq!(
        f.call(f.acquire_request(1, &token))["error"],
        "idempotency_conflict"
    );
    let checked = f.call(f.proof_request("check", 1, &token, 42));
    assert_eq!(checked["result"]["project"], json!(f.projects[1]));
    assert_eq!(f.call(f.request("status", 1))["result"]["nextFence"], 43);
    assert_eq!(
        f.call(f.proof_request("release", 1, &token, 42))["result"]["released"],
        true
    );
    assert_eq!(
        f.call(f.acquire_request(1, &"b".repeat(64)))["result"]["lease"]["fence"],
        43
    );
    let owner = claim::read_current(&f.authority, &f.resource, Authorization::Authorized)
        .unwrap()
        .unwrap();
    assert_eq!(owner.claim_id, token_claim_id(&"b".repeat(64)).unwrap());
    let ledger: Value = serde_json::from_slice(&fs::read(&f.ledger).unwrap()).unwrap();
    assert!(
        ledger["projects"].as_object().unwrap().is_empty(),
        "legacy ledger cannot become a second owner"
    );
}
#[test]
fn mismatched_token_owner_target_and_fence_never_authorize_effects() {
    let f = Fixture::new();
    let token = "c".repeat(64);
    f.call(f.acquire_request(0, &token));
    let mut changes = Vec::new();
    let mut r = f.proof_request("check", 0, &"d".repeat(64), 42);
    changes.push(r.clone());
    r = f.proof_request("check", 0, &token, 43);
    changes.push(r.clone());
    r = f.proof_request("check", 0, &token, 42);
    r["owner"]["nativeSessionId"] = json!("other");
    changes.push(r.clone());
    r = f.proof_request("check", 0, &token, 42);
    r["deploymentTarget"] = json!({"fleetDir":f.fleet,"unit":"other.service"});
    changes.push(r);
    for request in changes {
        let response = f.call(request);
        assert_eq!(response, json!({"ok":false,"error":"proof_mismatch"}));
        assert!(!response.to_string().contains(&token));
    }
    let mut changed = f.acquire_request(0, &token);
    changed["ttlSeconds"] = json!(301);
    assert_eq!(f.call(changed)["error"], "idempotency_conflict");
}
#[test]
fn generic_resource_ownership_is_reported_as_canonical_busy() {
    let f = Fixture::new();
    let now = claim::now_seconds().unwrap();
    let current = ResourceClaim {
        resource_ref: f.resource.clone(),
        principal_ref: "generic-owner".into(),
        session_ref: None,
        claim_id: "12345678-1234-4234-8234-123456789abc".into(),
        purpose: "generic resource occupation".into(),
        acquired_at: format!("unix-seconds:{now}"),
        expires_at: Some(format!("unix-seconds:{}", now + 300)),
    };
    claim::claim(
        &f.authority,
        &f.resource,
        Authorization::Authorized,
        current.clone(),
    )
    .unwrap();
    let status = f.call(f.request("status", 0));
    assert_eq!(status["result"]["canonicalBusy"], true);
    assert!(status["result"]["lease"].is_null());
    assert_eq!(
        status["result"]["currentClaim"]["principalRef"],
        "generic-owner"
    );
    let busy = f.call(f.acquire_request(1, &"e".repeat(64)));
    assert_eq!(busy["result"]["acquired"], false);
    assert_eq!(busy["result"]["canonicalBusy"], true);
    assert_eq!(f.call(f.request("status", 0))["result"]["nextFence"], 42);
    assert_eq!(
        claim::read_current(&f.authority, &f.resource, Authorization::Authorized).unwrap(),
        Some(current)
    );
}
#[test]
fn seals_private_paths_and_advisory_ledger_fail_closed() {
    let f = Fixture::new();
    let mut ledger: Value = serde_json::from_slice(&fs::read(&f.ledger).unwrap()).unwrap();
    ledger["projects"] = json!({"old":{"nested":{"lease":null}}});
    write_private(&f.ledger, &ledger);
    assert_eq!(
        f.call(f.request("status", 0))["error"],
        "configuration_invalid"
    );
    f.write_ledger();
    ledger = serde_json::from_slice(&fs::read(&f.ledger).unwrap()).unwrap();
    ledger["canonical"]["seal_id"] = json!("wrong");
    write_private(&f.ledger, &ledger);
    assert_eq!(
        f.call(f.request("status", 0))["error"],
        "configuration_invalid"
    );
    f.write_ledger();
    fs::set_permissions(&f.config, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        f.call(f.request("status", 0))["error"],
        "configuration_invalid"
    );
    fs::set_permissions(&f.config, fs::Permissions::from_mode(0o600)).unwrap();
    let mut config: Value = serde_json::from_slice(&fs::read(&f.config).unwrap()).unwrap();
    config["principal_ref"] = json!("not-an-administrator");
    write_private(&f.config, &config);
    assert_eq!(f.call(f.request("status", 0))["error"], "permission_denied");
    f.write_config();
    config = serde_json::from_slice(&fs::read(&f.config).unwrap()).unwrap();
    config["mappings"][1]["deployment_target"]["unit"] = json!("other.service");
    write_private(&f.config, &config);
    assert_eq!(
        f.call(f.request("status", 0))["error"],
        "configuration_invalid"
    );
    assert!(!f.resource_dir().join("owner.json").exists());
}
#[test]
fn one_local_unit_cannot_split_across_fleet_directories_or_resources() {
    let f = Fixture::new();
    assert_eq!(f.call(f.request("status", 0))["ok"], true);
    let second = f.authority.root.join("resources").join("second-deployment");
    fs::create_dir(&second).unwrap();
    fs::set_permissions(&second, fs::Permissions::from_mode(0o700)).unwrap();
    let mut marker: Value =
        serde_json::from_slice(&fs::read(f.resource_dir().join("resource.json")).unwrap()).unwrap();
    marker["resource_ref"] = json!("second-deployment");
    marker["descriptor"]["resource_ref"] = json!("second-deployment");
    marker["descriptor"]["external_ref"] = json!("second-fixture-deployment");
    write_private(&second.join("resource.json"), &marker);
    let other_fleet = f.root.join("second-fleet");
    fs::create_dir(&other_fleet).unwrap();
    fs::set_permissions(&other_fleet, fs::Permissions::from_mode(0o700)).unwrap();
    let mut config: Value = serde_json::from_slice(&fs::read(&f.config).unwrap()).unwrap();
    config["mappings"][1]["resource_ref"] = json!("second-deployment");
    config["mappings"][1]["deployment_target"]["fleetDir"] = json!(other_fleet);
    write_private(&f.config, &config);
    assert_eq!(
        f.call(f.request("status", 0))["error"],
        "configuration_invalid"
    );
    assert!(!f.resource_dir().join("owner.json").exists());
    assert!(!second.join("owner.json").exists());
    config["mappings"][1]["deployment_target"]["unit"] = json!("different.service");
    write_private(&f.config, &config);
    assert_eq!(f.call(f.request("status", 0))["ok"], true);
}
#[test]
fn expired_proof_cannot_start_or_renew_a_guard() {
    let f = Fixture::new();
    let token = "f".repeat(64);
    f.call(f.acquire_request(0, &token));
    f.force_expired();
    for action in ["check", "renew", "guard"] {
        assert_eq!(
            f.call(f.proof_request(action, 0, &token, 42))["error"],
            "lease_expired"
        );
    }
    let mut cleanup = f.proof_request("guard", 0, &token, 42);
    cleanup["cleanup"] = json!(true);
    assert_eq!(f.call(cleanup)["error"], "invalid_request");
    assert_eq!(
        f.call(f.proof_request("release", 0, &token, 42))["result"]["released"],
        true
    );
    assert_eq!(
        f.call(f.acquire_request(0, &token))["error"],
        "proof_mismatch",
        "released nonce cannot reacquire"
    );
}
#[test]
fn held_guard_allows_expired_cleanup_and_releases_only_after_durable_receipt() {
    let f = Fixture::new();
    let token = "1".repeat(64);
    f.call(f.acquire_request(0, &token));
    let mut guard = f.guard(&token, 42);
    let binding =
        claim::read_execution_binding(&f.authority, &f.resource, Authorization::Authorized)
            .unwrap()
            .unwrap();
    assert!(binding.resolved_receipt.is_none());
    assert_eq!(
        f.call(f.request("status", 1))["result"]["deploymentInProgress"],
        true
    );
    assert_eq!(
        f.call(f.proof_request("release", 0, &token, 42))["error"],
        "resource_busy"
    );
    assert_eq!(
        f.call(f.proof_request("guard", 0, &token, 42))["error"],
        "resource_busy"
    );
    f.force_expired();
    assert_eq!(
        guard.send(json!({"action":"check"}))["error"],
        "lease_expired"
    );
    assert_eq!(
        guard.send(json!({"action":"check","cleanup":true}))["ok"],
        true
    );
    assert_eq!(
        f.call(f.acquire_request(1, &"2".repeat(64)))["result"]["acquired"],
        false
    );
    let finished = guard.send(json!({"action":"finished"}));
    assert_eq!(finished["result"]["finished"], true);
    guard.eof();
    let resolved =
        claim::read_execution_binding(&f.authority, &f.resource, Authorization::Authorized)
            .unwrap()
            .unwrap();
    assert!(resolved.resolved_receipt.is_some());
    let path = f.resource_dir().join("compat-guards").join(format!(
        "{}.receipt.json",
        finished["result"]["guardId"].as_str().unwrap()
    ));
    assert!(
        path.is_file(),
        "receipt must be durable before occupancy clears"
    );
    assert_eq!(
        f.call(f.proof_request("release", 1, &token, 42))["result"]["released"],
        true
    );
    assert_eq!(
        f.call(f.acquire_request(1, &"2".repeat(64)))["result"]["lease"]["fence"],
        43
    );
}
#[test]
fn eof_and_worker_kill_retain_unresolved_occupancy_after_expiry() {
    for kill in [false, true] {
        let f = Fixture::new();
        let token = "3".repeat(64);
        f.call(f.acquire_request(0, &token));
        let mut guard = f.guard(&token, 42);
        if kill {
            guard.crash()
        } else {
            guard.eof()
        }
        f.force_expired();
        let binding =
            claim::read_execution_binding(&f.authority, &f.resource, Authorization::Authorized)
                .unwrap()
                .unwrap();
        assert!(binding.resolved_receipt.is_none());
        let status = f.call(f.request("status", 0));
        assert_eq!(status["result"]["deploymentInProgress"], true);
        assert_eq!(status["result"]["lease"]["fence"], 42);
        assert_eq!(
            f.call(f.acquire_request(1, &"4".repeat(64)))["result"]["acquired"],
            false
        );
        assert_eq!(
            f.call(f.proof_request("release", 0, &token, 42))["error"],
            "resource_busy"
        );
        let receipts = fs::read_dir(f.resource_dir().join("compat-guards"))
            .unwrap()
            .filter_map(|v| v.ok())
            .filter(|v| v.file_name().to_string_lossy().ends_with(".receipt.json"))
            .count();
        assert_eq!(
            receipts, 0,
            "EOF and SIGKILL must never manufacture completion"
        );
    }
}
#[test]
fn concurrent_alias_acquisitions_have_one_owner_and_one_shared_counter() {
    let f = Fixture::new();
    let request_a = f.acquire_request(0, &"5".repeat(64));
    let request_b = f.acquire_request(1, &"6".repeat(64));
    let executable_a = f.executable.clone();
    let executable_b = f.executable.clone();
    let config_a = f.config.clone();
    let config_b = f.config.clone();
    let a = thread::spawn(move || call(&executable_a, &config_a, request_a));
    let b = thread::spawn(move || call(&executable_b, &config_b, request_b));
    let responses = [a.join().unwrap(), b.join().unwrap()];
    assert_eq!(
        responses
            .iter()
            .filter(|r| r["result"]["acquired"] == true)
            .count(),
        1
    );
    assert_eq!(
        responses
            .iter()
            .filter(|r| r["result"]["acquired"] == false)
            .count(),
        1
    );
    assert_eq!(f.call(f.request("status", 0))["result"]["nextFence"], 43);
}

#[test]
fn acquired_identity_survives_repository_move_without_authorizing_fresh_acquire() {
    let f = Fixture::new();
    let token = "7".repeat(64);
    assert_eq!(
        f.call(f.acquire_request(0, &token))["result"]["acquired"],
        true
    );
    fs::rename(&f.projects[0], f.root.join("project-a-moved.git")).unwrap();
    assert_eq!(f.call(f.proof_request("check", 0, &token, 42))["ok"], true);
    assert_eq!(
        f.call(f.acquire_request(0, &token))["result"]["lease"]["fence"],
        42
    );
    assert_eq!(
        f.call(f.proof_request("release", 0, &token, 42))["result"]["released"],
        true
    );
    assert_eq!(
        f.call(f.acquire_request(0, &"8".repeat(64)))["error"],
        "project_unavailable"
    );
    assert_eq!(
        f.call(f.acquire_request(1, &"8".repeat(64)))["result"]["lease"]["fence"],
        43
    );
}
