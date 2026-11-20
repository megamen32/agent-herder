//! Read and submit one recovery continuation through the bound Codex app-server.
//!
//! Alternate recovery uses a cold resume with the saved custom provider ID.
//! A warm reattach can silently ignore the config. Require a cold observation
//! and confirm the selected, distinct model on the exact thread after resume.
//! Codex exposes neither an atomic cold-only resume nor a thread endpoint readback.

use std::{
    collections::HashSet,
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value, json};

use super::{CodexConnection, CodexControl, RpcError, map_rpc_error};
#[path = "recovery_lineage.rs"]
mod lineage;
use lineage::{ThreadLineage, is_unarchived, read_ancestors, read_thread, thread_lineage};

use crate::domain::{
    adapter::{Admission, NativeReceipt, ReadError, RequestKey, SendMode, SubmitError},
    address::{InstanceRef, SessionAddress},
    recovery::{
        RecoveryBoundary, RecoveryControl, RecoveryCredential, RecoveryFailure, RecoveryPermit,
        RecoveryQuotaProof, RecoveryRoute, SameRouteRetry,
    },
};

const THREAD_PAGE_SIZE: usize = 100;
const THREAD_PAGE_LIMIT: usize = 16;
const RECOVERY_ITEM_PAGE_SIZE: usize = 32;
const PROVIDER_ID_LIMIT: usize = 256;
const MODEL_ID_LIMIT: usize = 256;
const RETRY_429_COOLDOWN: Duration = Duration::from_secs(30);

struct StaticResponsesRoute {
    credential: RecoveryCredential,
    bearer: String,
}

impl StaticResponsesRoute {
    fn overrides(self, saved_provider: &str) -> Value {
        let prefix = format!("model_providers.{saved_provider}");
        let fields = [
            ("name", json!("Codex recovery route")),
            ("base_url", json!(self.credential.endpoint)),
            ("wire_api", json!("responses")),
            ("experimental_bearer_token", json!(self.bearer)),
            ("requires_openai_auth", json!(false)),
            ("supports_websockets", json!(false)),
            ("request_max_retries", json!(0)),
            ("stream_max_retries", json!(0)),
        ];
        Value::Object(
            fields
                .into_iter()
                .map(|(field, value)| (format!("{prefix}.{field}"), value))
                .collect::<Map<_, _>>(),
        )
    }
}

struct RecoveryObservation {
    boundary: RecoveryBoundary,
    root_turn_id: Option<String>,
    unloaded: bool,
}

impl RecoveryObservation {
    fn same_work(&self, other: &Self) -> bool {
        self.boundary == other.boundary && self.root_turn_id == other.root_turn_id
    }

    fn matches_thread(&self, thread: &Value, thread_id: &str) -> bool {
        let lineage = thread_lineage(thread, thread_id);
        let ancestors = &self.boundary.ancestors;
        match (lineage, ancestors.first(), ancestors.last()) {
            (Some(ThreadLineage::Root), None, None) => true,
            (
                Some(ThreadLineage::Spawned {
                    parent,
                    session,
                    depth,
                }),
                Some(direct),
                Some(root),
            ) => {
                parent == direct.address.native_session_id
                    && depth == ancestors.len() as u64
                    && (session == thread_id || session == root.address.native_session_id)
            }
            _ => false,
        }
    }
}

fn recheck_same_route_retry(
    connection: &mut CodexConnection,
    target: &SessionAddress,
    boundary: &RecoveryBoundary,
    deadline: Instant,
) -> SameRouteRetry {
    let Ok(page) = read_rpc(
        connection,
        "thread/turns/list",
        json!({"threadId": target.native_session_id, "limit": 1, "sortDirection": "desc", "itemsView": "summary"}),
        deadline,
    ) else {
        return SameRouteRetry::Hold;
    };
    let Some([turn]) = page["data"].as_array().map(Vec::as_slice) else {
        return SameRouteRetry::Hold;
    };
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return SameRouteRetry::Hold;
    };
    retry_after_throttle(turn, boundary, now.as_secs())
}

fn retry_after_throttle(turn: &Value, boundary: &RecoveryBoundary, now: u64) -> SameRouteRetry {
    if turn["id"] != boundary.turn_id
        || turn["startedAt"].as_u64().and_then(|s| s.checked_mul(1000))
            != Some(boundary.started_at_ms)
        || recovery_failure(turn) != Some(RecoveryFailure::Throttled)
    {
        return SameRouteRetry::Hold;
    }
    let info = &turn["error"]["codexErrorInfo"];
    if info == "serverOverloaded" {
        return SameRouteRetry::UseQuotaPolicy;
    }
    let age = turn["completedAt"].as_u64().and_then(|end| now.checked_sub(end));
    if is_retry_limit(info)
        && boundary.model.as_deref().is_some_and(bounded_model_id)
        && age.is_some_and(|age| age >= RETRY_429_COOLDOWN.as_secs())
    {
        SameRouteRetry::Ready
    } else {
        SameRouteRetry::Hold
    }
}

fn is_retry_limit(info: &Value) -> bool {
    info.get("responseTooManyFailedAttempts").is_some()
        || info.get("response_too_many_failed_attempts").is_some()
}

fn sole_user_item(turn: &Value) -> Option<&Value> {
    let mut users = turn["items"].as_array()?.iter().filter(|item| item["type"] == "userMessage");
    let item = users.next()?;
    required_string(item, "id")?;
    users.next().is_none().then_some(item)
}

// thread/read returns turns in native history order. Correlate the admitted
// input in its own failed turn before considering the last turn's input.
fn superseding_user_turn<'a>(thread: &'a Value, receipt: &NativeReceipt, key: &str) -> Option<&'a str> {
    let (latest, prior) = thread["turns"].as_array()?.split_last()?;
    let latest_id = required_string(latest, "id")?;
    let mut matches = prior.iter().filter(|turn| turn["id"] == receipt.native_id);
    let old = matches.next()?;
    if thread["id"] != receipt.target.native_session_id
        || matches.next().is_some() || latest_id == receipt.native_id
        || prior.iter().any(|turn| turn["id"] == latest_id)
        || (!latest["rootTurnId"].is_null() && latest["rootTurnId"] != latest_id)
        || ![old, latest].iter().all(|turn| {
            recovery_failure(turn) == Some(RecoveryFailure::Throttled)
                && is_retry_limit(&turn["error"]["codexErrorInfo"])
        })
        || old["completedAt"].as_u64()? > latest["startedAt"].as_u64()?
    {
        return None;
    }
    let admitted = sole_user_item(old)?;
    let followup = sole_user_item(latest)?;
    (admitted["clientId"] == key && admitted["id"] != followup["id"]
        && (followup["clientId"].is_null() || required_string(followup, "clientId")
            .is_some_and(|id| !id.starts_with("codex-recovery:"))))
        .then_some(latest_id)
}

impl CodexControl {
    /// Confirm admission of the old recovery when a subsequent composer turn
    /// independently exhausted its 429 retries in this same native thread.
    pub fn confirms_superseded_429(&self, thread: &Value, receipt: &NativeReceipt, key: &str) -> bool {
        receipt.target.instance == self.instance
            && superseding_user_turn(thread, receipt, key).is_some_and(|latest| {
                native_turn_trigger(&self.process.code_home, thread, latest).as_deref() == Some("composer")
            })
    }
}

impl RecoveryControl for CodexControl {
    fn harness(&self) -> &'static str {
        "codex"
    }

    fn instance(&self) -> &InstanceRef {
        self.instance()
    }

    fn mode(&self) -> SendMode {
        SendMode::Start
    }

    fn read_boundary(
        &self,
        target: &SessionAddress,
    ) -> Result<Option<RecoveryBoundary>, ReadError> {
        if target.instance != self.instance || !valid_id(&target.native_session_id) {
            return Err(ReadError("invalid Codex recovery target".into()));
        }
        let deadline = recovery_deadline(self.timeout)?;
        let mut state = self
            .state
            .try_lock()
            .map_err(|_| ReadError("Codex control connection is busy or unavailable".into()))?;
        if self.process.socket_path.is_some() && state.connection.unavailable() {
            // Reopen only before a later read. No failed write is repeated.
            state.connection =
                Self::connect(&self.process, remaining_time(deadline)?).map_err(|_| {
                    ReadError("Codex recovery could not reopen the shared app-server".into())
                })?;
        }
        Ok(read_observation(&mut state.connection, target, deadline)?.map(|item| item.boundary))
    }

    /// Read quota from this control's native ChatGPT-backed OpenAI account.
    fn quota(&self, provider: &str, cwd: &str, reserve: u8) -> Option<bool> {
        if provider != "openai" || !Path::new(cwd).is_absolute() || reserve > 100 {
            return None;
        }
        let deadline = recovery_deadline(self.timeout).ok()?;
        let mut state = self.state.try_lock().ok()?;
        read_openai_quota(&mut state.connection, reserve, Some(cwd), deadline)
    }

    fn credential(&self, provider: &str, _model: &str, cwd: &str) -> Option<RecoveryCredential> {
        let deadline = recovery_deadline(self.timeout).ok()?;
        let mut state = self.state.try_lock().ok()?;
        let providers = read_recovery_providers(&mut state.connection, cwd, deadline)?;
        Some(static_responses_route(&providers[provider], provider)?.credential)
    }

    fn same_route_retry(
        &self,
        target: &SessionAddress,
        boundary: &RecoveryBoundary,
    ) -> SameRouteRetry {
        if target.instance != self.instance
            || boundary.provider != "opencodex"
            || boundary.failure != RecoveryFailure::Throttled
        {
            return SameRouteRetry::Hold;
        }
        let (Ok(deadline), Ok(mut state)) =
            (recovery_deadline(self.timeout), self.state.try_lock()) else {
            return SameRouteRetry::Hold;
        };
        recheck_same_route_retry(&mut state.connection, target, boundary, deadline)
    }

    fn supports_alternate(
        &self,
        target: &SessionAddress,
        boundary: &RecoveryBoundary,
        route: &RecoveryRoute,
    ) -> bool {
        if validate_alternate_route(boundary, route).is_err() || target.instance != self.instance {
            return false;
        }
        let (Ok(deadline), Ok(mut state)) =
            (recovery_deadline(self.timeout), self.state.try_lock())
        else {
            return false;
        };
        let connection = &mut state.connection;
        read_thread(connection, &target.native_session_id, deadline).is_ok_and(|thread| {
            thread["status"]["type"] == "notLoaded" && thread["modelProvider"] == boundary.provider
        }) && read_recovery_providers(connection, &boundary.cwd, deadline)
            .is_some_and(|providers| plain_responses_provider(&providers[&boundary.provider]))
            && provider_can_be_overridden(connection, &boundary.provider, deadline)
    }

    /// Start a single recovery turn. The caller owns the durable request key
    /// and must reconcile an uncertain result through read-only receipt lookup.
    fn submit(
        &self,
        target: &SessionAddress,
        boundary: &RecoveryBoundary,
        route: &RecoveryRoute,
        permit: RecoveryPermit<'_>,
        message: &str,
        key: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        let RecoveryPermit {
            reserve,
            quota_proof,
            still_allowed,
        } = permit;
        if target.instance != self.instance
            || reserve > 100
            || !valid_id(&target.native_session_id)
            || !valid_id(&key.0)
            || message.trim().is_empty()
            || !Path::new(&boundary.cwd).is_absolute()
            || !valid_id(&route.provider)
            || route.model.as_deref().is_some_and(|model| !valid_id(model))
        {
            return Err(not_sent("invalid Codex recovery target, route, or input"));
        }
        let alternate = route.provider != boundary.provider;
        let expected_model = match (
            !alternate,
            boundary.model.as_deref(),
            route.model.as_deref(),
        ) {
            (true, Some(saved), Some(selected)) if saved != selected => {
                return Err(not_sent(
                    "same-provider recovery requires the saved Codex model",
                ));
            }
            (false, _, None) => {
                return Err(not_sent(
                    "alternate Codex recovery requires an explicit model",
                ));
            }
            (true, Some(saved), _) => Some(saved),
            (_, _, selected) => selected,
        };
        if alternate {
            validate_alternate_route(boundary, route)?;
        }
        let deadline = recovery_deadline(self.timeout).map_err(read_refusal)?;
        let mut state = self
            .state
            .try_lock()
            .map_err(|_| not_sent("Codex control connection is busy or unavailable"))?;
        let connection = &mut state.connection;

        // Switching routes or retrying explicit exhaustion requires fresh
        // positive native quota for the configured route and workspace.
        if !alternate && boundary.failure == RecoveryFailure::Quota {
            let available = if route.provider == "openai" {
                read_openai_quota(connection, reserve, Some(&boundary.cwd), deadline) == Some(true)
            } else {
                confirmed_static_route(
                    connection,
                    &route.provider,
                    &boundary.cwd,
                    None,
                    quota_proof.as_ref(),
                    deadline,
                )
                .is_some()
            };
            if !available {
                return Err(not_sent(
                    "available quota for the selected Codex route is unconfirmed",
                ));
            }
        }

        let child = !boundary.ancestors.is_empty();
        let Some(mut before) =
            read_observation(connection, target, deadline).map_err(read_refusal)?
        else {
            return Err(not_sent(
                "Codex recovery boundary is unavailable before resume",
            ));
        };
        if before.boundary != *boundary {
            return Err(not_sent("Codex recovery boundary changed before resume"));
        }

        let mut params = json!({
            "threadId": target.native_session_id,
            "excludeTurns": true,
        });
        if alternate {
            if !before.unloaded {
                return Err(not_sent(
                    "Codex alternate recovery requires a verified unloaded thread",
                ));
            }
            // Use the provider identity already saved by Codex. Replacing its
            // endpoint and bearer in this resume does not write the profile.
            let selected = confirmed_static_route(
                connection,
                &route.provider,
                &boundary.cwd,
                Some(&boundary.provider),
                quota_proof.as_ref(),
                deadline,
            )
            .ok_or_else(|| not_sent("Codex alternate route or available quota is unconfirmed"))?;
            require_cold_thread(connection, target, &before, deadline).map_err(read_refusal)?;
            if child {
                let fresh = read_observation(connection, target, deadline).map_err(read_refusal)?;
                if !fresh.is_some_and(|fresh| fresh.unloaded && before.same_work(&fresh)) {
                    return Err(not_sent("Codex child recovery changed before cold resume"));
                }
            }
            params["modelProvider"] = json!(boundary.provider);
            params["model"] = json!(expected_model);
            params["config"] = selected.overrides(&boundary.provider);
        } else if before.unloaded
            && boundary.provider == "opencodex"
            && boundary.failure == RecoveryFailure::Throttled
            && let Some(model) = expected_model
        {
            // On cold resume Codex can select today's default instead of the
            // model saved on this thread. Keep its original provider binding.
            params["model"] = json!(model);
        }
        if !still_allowed() {
            return Err(not_sent("Codex recovery is held before resume"));
        }
        let remaining = remaining_time(deadline).map_err(read_refusal)?;
        // An uncertain resume must stop the sequence. Its error remains UNKNOWN
        // because the native load or route change may have taken effect.
        let resumed = connection
            .request("thread/resume", params, remaining)
            .map_err(if alternate {
                map_override_error
            } else {
                map_rpc_error
            })?;
        let resumed_thread = &resumed["thread"];
        let Some(resumed_model) = required_string(&resumed, "model") else {
            return Err(not_sent("Codex resume did not confirm its model"));
        };
        if resumed_thread["id"].as_str() != Some(target.native_session_id.as_str())
            || resumed_thread["cwd"].as_str() != Some(boundary.cwd.as_str())
            || resumed["cwd"].as_str() != Some(boundary.cwd.as_str())
            || resumed_thread["modelProvider"].as_str() != Some(boundary.provider.as_str())
            || resumed["modelProvider"].as_str() != Some(boundary.provider.as_str())
            || !before.matches_thread(resumed_thread, &target.native_session_id)
            || !is_quiescent(resumed_thread)
            || (alternate && resumed_thread["status"]["type"] != "idle")
            || (child && !accepts_child_input(resumed_thread))
            || expected_model.is_some_and(|model| resumed_model != model)
            || (!absent_or_null(resumed_thread, "model")
                && resumed_thread["model"] != resumed_model)
        {
            return Err(not_sent(
                "Codex resume did not confirm the exact thread and route",
            ));
        }

        if (alternate || quota_proof.is_some())
            && confirmed_static_route(
                connection,
                &route.provider,
                &boundary.cwd,
                alternate.then_some(boundary.provider.as_str()),
                quota_proof.as_ref(),
                deadline,
            )
            .is_none()
        {
            return Err(not_sent(
                "Codex recovery credential or quota became unconfirmed after resume",
            ));
        }
        if route.provider == "openai"
            && boundary.failure == RecoveryFailure::Quota
            && read_openai_quota(connection, reserve, Some(&boundary.cwd), deadline) != Some(true)
        {
            return Err(not_sent("Codex account quota changed after resume"));
        }

        // Confirm the child's own boundary and current native ancestors after
        // external quota reads, immediately before the owner's last check.
        let Some(after) = read_observation(connection, target, deadline).map_err(read_refusal)?
        else {
            return Err(not_sent(
                "Codex recovery boundary is unavailable after resume",
            ));
        };
        // A formerly unknown model can become visible when the thread is loaded.
        if alternate || boundary.model.is_some() || after.boundary.model.is_some() {
            before.boundary.model = Some(resumed_model.to_owned());
        }
        if !after.same_work(&before) || ((alternate || child) && after.unloaded) {
            return Err(not_sent("Codex recovery boundary changed after resume"));
        }
        if !alternate
            && boundary.provider == "opencodex"
            && boundary.failure == RecoveryFailure::Throttled
            && matches!(
                recheck_same_route_retry(connection, target, &after.boundary, deadline),
                SameRouteRetry::Hold
            )
        {
            return Err(not_sent("Codex same-route retry is not ready after resume"));
        }
        if !still_allowed() {
            return Err(not_sent("Codex recovery is held before turn start"));
        }

        let remaining = remaining_time(deadline).map_err(read_refusal)?;
        let mut params = json!({
            "threadId": target.native_session_id,
            "input": [{"type": "text", "text": message}],
            "clientUserMessageId": key.0,
        });
        if let Some(parent) = after.boundary.ancestors.first() {
            params["parentTurnId"] = json!(parent.turn_id);
            params["rootTurnId"] = json!(after.root_turn_id);
        }
        let started = connection
            .request("turn/start", params, remaining)
            .map_err(map_rpc_error)?;
        let turn = &started["turn"];
        let native_id = required_string(turn, "id").filter(|id| {
            *id != boundary.turn_id
                && after
                    .boundary
                    .ancestors
                    .iter()
                    .all(|parent| parent.turn_id != *id)
                && (!child
                    || (turn["rootTurnId"].as_str() == after.root_turn_id.as_deref()
                        && Some(*id) != after.root_turn_id.as_deref()))
        });
        if let Some(native_id) = native_id.filter(|_| turn["status"] == "inProgress") {
            return Ok(Admission {
                receipt: NativeReceipt {
                    target: target.clone(),
                    native_id: native_id.to_owned(),
                },
            });
        }
        Err(SubmitError::OutcomeUnknown {
            receipt: None,
            reason: "Codex turn/start did not confirm a new native recovery turn".into(),
        })
    }
}

fn validate_alternate_route(
    boundary: &RecoveryBoundary,
    route: &RecoveryRoute,
) -> Result<(), SubmitError> {
    if !custom_provider_id(&boundary.provider) || !custom_provider_id(&route.provider) {
        return Err(not_sent(
            "Codex alternate recovery requires two custom provider IDs",
        ));
    }
    let saved = boundary
        .model
        .as_deref()
        .filter(|model| bounded_model_id(model));
    let selected = route
        .model
        .as_deref()
        .filter(|model| bounded_model_id(model));
    // A warm reattach can succeed while ignoring the override. A different
    // observed model is necessary to detect a reattach to the original route.
    if saved.is_none() || selected.is_none() || saved == selected {
        return Err(not_sent(
            "Codex alternate recovery requires a known, different model",
        ));
    }
    Ok(())
}

fn bounded_model_id(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= MODEL_ID_LIMIT
        && model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-/:$".contains(&byte))
}

fn custom_provider_id(provider: &str) -> bool {
    !provider.is_empty()
        && provider.len() <= PROVIDER_ID_LIMIT
        && provider
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        && !matches!(
            provider,
            "openai"
                | "amazon-bedrock"
                | "amazon-bedrock-runtime"
                | "gcp"
                | "ollama"
                | "ollama-chat"
                | "lmstudio"
        )
}

fn confirmed_static_route(
    connection: &mut CodexConnection,
    provider: &str,
    cwd: &str,
    saved_provider: Option<&str>,
    proof: Option<&RecoveryQuotaProof<'_>>,
    deadline: Instant,
) -> Option<StaticResponsesRoute> {
    let proof = proof?;
    let providers = read_recovery_providers(connection, cwd, deadline)?;
    if let Some(saved_provider) = saved_provider {
        // Config layers can merge provider fields. Refuse definitions that
        // could retain a different auth mechanism, extra headers or transport.
        if !plain_responses_provider(&providers[saved_provider])
            || !provider_can_be_overridden(connection, saved_provider, deadline)
        {
            return None;
        }
    }
    let selected = static_responses_route(&providers[provider], provider)?;
    (&selected.credential == proof.credential && (proof.still_available)()).then_some(selected)
}

fn read_recovery_providers(
    connection: &mut CodexConnection,
    cwd: &str,
    deadline: Instant,
) -> Option<Value> {
    if !Path::new(cwd).is_absolute() {
        return None;
    }
    let mut response = read_rpc(
        connection,
        "config/read",
        json!({"cwd":cwd,"includeLayers":false}),
        deadline,
    )
    .ok()?;
    let providers = response
        .get_mut("config")?
        .get_mut("model_providers")?
        .take();
    providers.is_object().then_some(providers)
}

fn plain_responses_provider(config: &Value) -> bool {
    config["wire_api"] == "responses"
        && [
            "auth",
            "env_key",
            "gateway_oauth",
            "aws",
            "model_catalog_url",
            "project_id",
            "location",
            "credential_file",
            "capabilities",
        ]
        .into_iter()
        .all(|key| absent_or_null(config, key))
        && ["http_headers", "env_http_headers", "query_params"]
            .into_iter()
            .all(|key| {
                absent_or_null(config, key) || config[key].as_object().is_some_and(Map::is_empty)
            })
        && [
            "requires_openai_auth",
            "supports_websockets",
            "supports_standalone_web_search",
        ]
        .into_iter()
        .all(|key| {
            matches!(
                config.get(key),
                None | Some(Value::Null | Value::Bool(false))
            )
        })
}

fn static_responses_route(config: &Value, provider: &str) -> Option<StaticResponsesRoute> {
    use sha2::{Digest, Sha256};
    if !custom_provider_id(provider) || !plain_responses_provider(config) {
        return None;
    }
    let endpoint = required_string(config, "base_url")?;
    let url = reqwest::Url::parse(endpoint).ok()?;
    // Require a literal loopback Responses endpoint with an explicit port.
    let port = url.port().filter(|port| *port != 0)?;
    if endpoint != format!("http://127.0.0.1:{port}/v1") {
        return None;
    }
    let key = required_string(config, "experimental_bearer_token")?;
    if key.len() < 20 || !key.bytes().all(|byte| byte.is_ascii_graphic()) {
        return None;
    }
    let sha256 = Sha256::digest(key.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Some(StaticResponsesRoute {
        credential: RecoveryCredential {
            endpoint: endpoint.to_owned(),
            sha256,
        },
        bearer: key.to_owned(),
    })
}

fn provider_can_be_overridden(
    connection: &mut CodexConnection,
    saved_provider: &str,
    deadline: Instant,
) -> bool {
    // Managed definitions win over request config. An effective profile read
    // on its own does not show whether our session override can take priority.
    let Ok(response) = read_rpc(connection, "configRequirements/read", json!({}), deadline) else {
        return false;
    };
    match response.get("requirements") {
        Some(Value::Null) => true,
        Some(Value::Object(requirements)) => match requirements.get("modelProviders") {
            None | Some(Value::Null) => true,
            Some(Value::Object(providers)) => !providers.contains_key(saved_provider),
            _ => false,
        },
        _ => false,
    }
}

fn require_cold_thread(
    connection: &mut CodexConnection,
    target: &SessionAddress,
    observation: &RecoveryObservation,
    deadline: Instant,
) -> Result<(), ReadError> {
    let boundary = &observation.boundary;
    let refusal =
        || ReadError("Codex alternate recovery requires a verified unloaded thread".into());
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    for _ in 0..THREAD_PAGE_LIMIT {
        let page = read_rpc(
            connection,
            "thread/loaded/list",
            json!({"cursor": cursor, "limit": THREAD_PAGE_SIZE}),
            deadline,
        )?;
        let loaded = page["data"]
            .as_array()
            .filter(|loaded| loaded.len() <= THREAD_PAGE_SIZE)
            .ok_or_else(refusal)?;
        if loaded.iter().any(|id| {
            id.as_str()
                .is_none_or(|id| !valid_id(id) || id == target.native_session_id)
        }) {
            return Err(refusal());
        }
        if absent_or_null(&page, "nextCursor") {
            let reply = read_rpc(
                connection,
                "thread/read",
                json!({"threadId": target.native_session_id, "includeTurns": false}),
                deadline,
            )?;
            let thread = &reply["thread"];
            if thread["id"] == target.native_session_id
                && thread["cwd"] == boundary.cwd
                && thread["modelProvider"] == boundary.provider
                && thread["model"].as_str() == boundary.model.as_deref()
                && thread["status"]["type"] == "notLoaded"
                && observation.matches_thread(thread, &target.native_session_id)
                && is_quiescent(thread)
            {
                return Ok(());
            }
            return Err(refusal());
        }
        let next = required_string(&page, "nextCursor")
            .filter(|next| seen_cursors.insert((*next).to_owned()))
            .ok_or_else(refusal)?;
        cursor = Some(next.to_owned());
    }
    Err(refusal())
}

fn map_override_error(error: RpcError) -> SubmitError {
    // A native rejection can include input configuration. Keep the bearer
    // out of task diagnostics while preserving the existing outcome semantics.
    match map_rpc_error(error) {
        SubmitError::DefinitelyNotSent { .. } => {
            not_sent("Codex rejected the cold recovery override")
        }
        _ => SubmitError::OutcomeUnknown {
            receipt: None,
            reason: "Codex cold recovery resume outcome is unknown".into(),
        },
    }
}

fn read_observation(
    connection: &mut CodexConnection,
    target: &SessionAddress,
    deadline: Instant,
) -> Result<Option<RecoveryObservation>, ReadError> {
    let thread_id = target.native_session_id.as_str();
    let thread = read_thread(connection, thread_id, deadline)?;
    let Some(lineage) = thread_lineage(&thread, thread_id) else {
        return Ok(None);
    };
    let child = lineage != ThreadLineage::Root;
    let unloaded = thread["status"]["type"] == "notLoaded";
    if !is_quiescent(&thread) || (child && !unloaded && !accepts_child_input(&thread)) {
        return Ok(None);
    }
    let cwd = required_string(&thread, "cwd")
        .filter(|cwd| Path::new(cwd).is_absolute())
        .ok_or_else(|| ReadError("Codex recovery thread cwd is unavailable".into()))?;
    let provider = required_string(&thread, "modelProvider")
        .ok_or_else(|| ReadError("Codex recovery thread provider is unavailable".into()))?;
    let model = match thread.get("model") {
        None | Some(Value::Null) => None,
        Some(_) => Some(
            required_string(&thread, "model")
                .ok_or_else(|| ReadError("Codex recovery thread model is invalid".into()))?,
        ),
    };

    // thread/read also returns archived threads. Prove membership in the
    // non-archived native index by exact ID, independently of the profile default provider.
    if !is_unarchived(
        connection,
        thread_id,
        cwd,
        lineage,
        deadline,
        index_is_quiescent,
    )? {
        return Ok(None);
    }
    // The summary contains the original input. Inspect the tail of this turn
    // separately, since the summary can omit work after an async question.
    let response = read_rpc(
        connection,
        "thread/turns/list",
        json!({"threadId": thread_id, "limit": 1, "sortDirection": "desc", "itemsView": "summary"}),
        deadline,
    )?;
    let turns = response["data"]
        .as_array()
        .ok_or_else(|| ReadError("Codex recovery latest turn page is invalid".into()))?;
    let [turn] = turns.as_slice() else {
        return Ok(None);
    };
    let (Some(turn_id), Some(started_at_ms), Some(failure)) = (
        required_string(turn, "id"),
        turn["startedAt"]
            .as_u64()
            .filter(|ts| *ts > 0)
            .and_then(|ts| ts.checked_mul(1000)),
        recovery_failure(turn),
    ) else {
        return Ok(None);
    };
    let root_turn_id = match turn.get("rootTurnId") {
        None | Some(Value::Null) => None,
        Some(_) => {
            let Some(id) = required_string(turn, "rootTurnId") else {
                return Ok(None);
            };
            Some(id)
        }
    };
    // A native goal tick can fail before Codex creates a user item. Codex
    // can also mark that goal blocked when the provider retries run out.
    let native_goal = !child
        && matches!(failure, RecoveryFailure::Throttled | RecoveryFailure::Retryable)
        && native_turn_trigger(connection.code_home(), &thread, turn_id).as_deref() == Some("goal");
    let failed_goal_at = native_goal.then(|| turn["completedAt"].as_u64()).flatten();
    if !goal_allows_recovery(connection, thread_id, failed_goal_at, deadline)? {
        return Ok(None);
    }
    let queue = read_rpc(
        connection,
        "thread/queue/list",
        json!({"threadId": thread_id, "limit": 1}),
        deadline,
    )?;
    let queued = queue["data"]
        .as_array()
        .ok_or_else(|| ReadError("Codex recovery native queue is unavailable".into()))?;
    if !queued.is_empty() || !absent_or_null(&queue, "nextCursor") {
        return Ok(None);
    }
    let input_item_id = match read_input_item(
        connection,
        thread_id,
        turn_id,
        turn,
        TurnInput::source(native_goal, root_turn_id, turn_id),
        deadline,
    )? {
        Some(id) => id,
        None if !child
            && turn["status"] == "failed"
            && turn["items"].as_array().is_some_and(Vec::is_empty) =>
        {
            let Some(id) = prior_retry_input(connection, &thread, turn, &response, deadline)?
            else {
                return Ok(None);
            };
            id
        }
        None => return Ok(None),
    };
    let Some(ancestors) =
        read_ancestors(connection, target, lineage, turn_id, root_turn_id, deadline)?
    else {
        return Ok(None);
    };
    Ok(Some(RecoveryObservation {
        boundary: RecoveryBoundary {
            turn_id: turn_id.to_owned(),
            input_item_id,
            cwd: cwd.to_owned(),
            provider: provider.to_owned(),
            model: model.map(str::to_owned),
            started_at_ms,
            failure,
            ancestors,
        },
        root_turn_id: root_turn_id.map(str::to_owned),
        unloaded,
    }))
}

fn accepts_child_input(thread: &Value) -> bool {
    matches!(
        thread["status"]["type"].as_str(),
        Some("idle" | "systemError")
    ) && thread["canAcceptDirectInput"] == true
}

fn is_quiescent(thread: &Value) -> bool {
    index_is_quiescent(thread)
        && (thread["status"]["type"] != "systemError" || thread["canAcceptDirectInput"] == true)
}

// The state-DB-only list omits canAcceptDirectInput on root threads.
// thread/read above supplies the live permission for a failed session.
fn index_is_quiescent(thread: &Value) -> bool {
    let status = &thread["status"];
    matches!(
        status["type"].as_str(),
        Some("notLoaded" | "idle" | "systemError")
    ) && status
        .get("activeFlags")
        .is_none_or(|flags| flags.as_array().is_some_and(Vec::is_empty))
        && absent_or_null(thread, "activeTurnId")
        && matches!(
            thread.get("canAcceptDirectInput"),
            None | Some(Value::Null | Value::Bool(true))
        )
}

fn goal_allows_recovery(
    connection: &mut CodexConnection,
    thread_id: &str,
    failed_goal_at: Option<u64>,
    deadline: Instant,
) -> Result<bool, ReadError> {
    let reply = read_rpc(
        connection,
        "thread/goal/get",
        json!({"threadId":thread_id}),
        deadline,
    )?;
    Ok(match reply.get("goal") {
        Some(Value::Null) => failed_goal_at.is_none(),
        Some(goal) if goal["threadId"] == thread_id => {
            goal["status"] == "active"
                || (goal["status"] == "blocked"
                    && failed_goal_at.is_some_and(|at| goal["updatedAt"].as_u64() == Some(at)))
        }
        Some(_) => false,
        None => false,
    })
}

// The RPC summary omits the trigger. Read the indexed native task_started
// event for this exact thread and turn without loading the transcript.
fn native_turn_trigger(home: &Path, thread: &Value, turn: &str) -> Option<String> {
    use rusqlite::{Connection, OpenFlags, params};
    use std::{
        fs::File,
        io::{BufRead, BufReader, Read, Seek, SeekFrom},
    };
    let id = required_string(thread, "id")?;
    let path = Path::new(thread["path"].as_str()?).canonicalize().ok()?;
    if !path.starts_with(home.join("sessions").canonicalize().ok()?)
        || !path
            .file_name()?
            .to_str()?
            .ends_with(&format!("-{id}.jsonl"))
    {
        return None;
    }
    let db = Connection::open_with_flags(
        home.join("thread_history_1.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .ok()?;
    db.busy_timeout(Duration::from_millis(50)).ok()?;
    let offset: u64 = db.query_row(
        "SELECT rollout_byte_offset FROM thread_turns WHERE thread_id=?1 AND turn_id=?2 AND status='failed'",
        params![id,turn], |row| row.get(0),
    ).ok()?;
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut line = Vec::new();
    BufReader::new(file.take(16 * 1024))
        .read_until(b'\n', &mut line)
        .ok()?;
    let event: Value = serde_json::from_slice(&line).ok()?;
    let payload = &event["payload"];
    let attribution = &payload["turn_attribution"];
    if event["type"] != "event_msg" || payload["type"] != "task_started"
        || payload["turn_id"] != turn || attribution["turn_id"] != turn
    {
        return None;
    }
    required_string(attribution, "turn_trigger").map(str::to_owned)
}

fn prior_retry_input(
    connection: &mut CodexConnection,
    thread: &Value,
    turn: &Value,
    page: &Value,
    deadline: Instant,
) -> Result<Option<String>, ReadError> {
    let Some(thread_id) = required_string(thread, "id") else {
        return Ok(None);
    };
    let mut current = turn.clone();
    let mut cursor = page["nextCursor"].clone();
    let mut seen = HashSet::new();
    loop {
        let Some(id) = required_string(&current, "id") else {
            return Ok(None);
        };
        if !current["items"].as_array().is_some_and(Vec::is_empty)
            || native_turn_trigger(connection.code_home(), thread, id).as_deref()
                != Some("resume_interrupted_task")
            || !cursor.as_str().is_some_and(|s| seen.insert(s.to_owned()))
        {
            return Ok(None);
        }
        let tail = read_rpc(
            connection,
            "thread/items/list",
            json!({"threadId":thread_id,"turnId":id,"sortDirection":"desc","limit":1}),
            deadline,
        )?;
        if !tail["data"].as_array().is_some_and(Vec::is_empty)
            || tail.get("nextCursor") != Some(&Value::Null)
        {
            return Ok(None);
        }
        let previous = read_rpc(
            connection,
            "thread/turns/list",
            json!({"threadId":thread_id,"limit":1,
            "sortDirection":"desc","cursor":cursor,"itemsView":"summary"}),
            deadline,
        )?;
        let Some([prior]) = previous["data"].as_array().map(Vec::as_slice) else {
            return Ok(None);
        };
        let Some(prior_id) = required_string(prior, "id") else {
            return Ok(None);
        };
        if prior_id == id
            || prior["status"] != "failed"
            || recovery_failure(prior).is_none()
            || !prior["completedAt"]
                .as_u64()
                .zip(current["startedAt"].as_u64())
                .is_some_and(|(a, b)| a <= b)
        {
            return Ok(None);
        }
        if let Some(anchor) = read_input_item(
            connection,
            thread_id,
            prior_id,
            prior,
            TurnInput::source(false, required_string(prior, "rootTurnId"), prior_id),
            deadline,
        )? {
            return Ok(Some(anchor));
        }
        current = prior.clone();
        cursor = previous["nextCursor"].clone();
    }
}

enum RecoveryTail<'a> {
    Earlier,
    Hold,
    Continue(&'a str),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TurnInput {
    User,
    Continuation,
    Goal,
}

impl TurnInput {
    fn source(native_goal: bool, root: Option<&str>, turn: &str) -> Self {
        if native_goal {
            Self::Goal
        } else if root.is_some_and(|id| id != turn) {
            Self::Continuation
        } else {
            Self::User
        }
    }
}

fn tail_item<'a>(item: &'a Value, user: Option<&'a str>, continuation: bool) -> RecoveryTail<'a> {
    let (Some(kind), Some(id)) = (required_string(item, "type"), required_string(item, "id"))
    else {
        return RecoveryTail::Hold;
    };
    if kind == "userMessage" {
        return if user == Some(id) {
            RecoveryTail::Continue(id)
        } else {
            RecoveryTail::Hold
        };
    }
    if kind != "agentMessage" {
        return RecoveryTail::Earlier;
    }
    if !absent_or_null(item, "questions")
        && !item["questions"].as_array().is_some_and(Vec::is_empty)
    {
        return RecoveryTail::Hold;
    }
    match item["phase"].as_str() {
        Some("final_answer") if item["delivery"] == "async" => RecoveryTail::Earlier,
        Some("commentary" | "partial_answer") => {
            if item["text"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty())
                && let Some(anchor) = user.or(continuation.then_some(id))
            {
                return RecoveryTail::Continue(anchor);
            }
            RecoveryTail::Earlier
        }
        _ => RecoveryTail::Hold,
    }
}

fn read_input_item(
    connection: &mut CodexConnection,
    thread_id: &str,
    turn_id: &str,
    turn: &Value,
    source: TurnInput,
    deadline: Instant,
) -> Result<Option<String>, ReadError> {
    let Some(items) = turn["items"]
        .as_array()
        .filter(|_| turn["itemsView"] == "summary")
    else {
        return Ok(None);
    };
    // An inline final answer is terminal. Desktop also renders asynchronous
    // notices as final answers while the same turn is still running.
    if items.iter().any(|item| {
        item["type"] == "agentMessage"
            && item["phase"] == "final_answer"
            && item["delivery"] != "async"
    }) {
        return Ok(None);
    }
    let mut users = items.iter().filter(|item| item["type"] == "userMessage");
    let user = users.next().and_then(|item| required_string(item, "id"));
    if users.next().is_some() || (user.is_none() && source == TurnInput::User) {
        return Ok(None);
    }
    // With no user item, the native goal invocation itself identifies the
    // work. Still inspect the tail for a final answer or an open question.
    let goal_anchor = (source == TurnInput::Goal && user.is_none()).then_some(turn_id);
    let mut cursor = None::<String>;
    let mut seen = HashSet::new();
    loop {
        let page = read_rpc(
            connection,
            "thread/items/list",
            json!({
                "threadId":thread_id, "turnId":turn_id, "cursor":cursor, "sortDirection":"desc",
                "limit":RECOVERY_ITEM_PAGE_SIZE, "deferOutput":{"commandExecution":true,"mcpToolCall":true},
            }),
            deadline,
        )?;
        let rows = page["data"]
            .as_array()
            .filter(|rows| rows.len() <= RECOVERY_ITEM_PAGE_SIZE)
            .ok_or_else(|| ReadError("Codex recovery item page is invalid".into()))?;
        for row in rows {
            if row["turnId"] != turn_id {
                return Ok(None);
            }
            match tail_item(&row["item"], user.or(goal_anchor), source == TurnInput::Continuation) {
                RecoveryTail::Hold => return Ok(None),
                RecoveryTail::Continue(id) => return Ok(Some(id.to_owned())),
                RecoveryTail::Earlier => {}
            }
        }
        if page.get("nextCursor") == Some(&Value::Null) {
            return Ok(goal_anchor.map(str::to_owned));
        }
        let next = required_string(&page, "nextCursor")
            .filter(|next| !rows.is_empty() && seen.insert((*next).to_owned()))
            .ok_or_else(|| ReadError("Codex recovery item cursor is invalid".into()))?;
        cursor = Some(next.to_owned());
    }
}

fn recovery_failure(turn: &Value) -> Option<RecoveryFailure> {
    if ["abortReason", "stopReason", "interruptReason", "reason"]
        .into_iter()
        .any(|field| !absent_or_null(turn, field))
    {
        return None;
    }
    match turn["status"].as_str()? {
        // Native projects a stale in-progress turn as interrupted. An explicit
        // abort records terminal timing, and older history can lack timing entirely.
        "interrupted"
            if turn.get("completedAt") == Some(&Value::Null)
                && absent_or_null(turn, "durationMs")
                && absent_or_null(turn, "error") =>
        {
            Some(RecoveryFailure::Interrupted)
        }
        "failed" => {
            let completed_at = turn["completedAt"].as_u64()?;
            if completed_at < turn["startedAt"].as_u64()?
                || !absent_or_null(&turn["error"], "misalignment")
            {
                return None;
            }
            typed_failure(&turn["error"]["codexErrorInfo"])
        }
        _ => None,
    }
}

fn typed_failure(error: &Value) -> Option<RecoveryFailure> {
    match error.as_str() {
        Some("usageLimitExceeded" | "rateLimitExceeded") => {
            return Some(RecoveryFailure::Quota);
        }
        Some("serverOverloaded") => return Some(RecoveryFailure::Throttled),
        Some("internalServerError" | "flexUnavailable") => {
            return Some(RecoveryFailure::Retryable);
        }
        _ => {}
    }
    let info = error.as_object().filter(|info| info.len() == 1)?;
    let (variant, details) = info.iter().next()?;
    let details = details.as_object()?;
    let http = details
        .get("httpStatusCode")
        .or_else(|| details.get("http_status_code"));
    match (variant.as_str(), http.and_then(Value::as_u64)) {
        ("responseTooManyFailedAttempts" | "response_too_many_failed_attempts", Some(429)) => {
            Some(RecoveryFailure::Throttled)
        }
        (
            "httpConnectionFailed"
            | "responseStreamConnectionFailed"
            | "responseStreamDisconnected"
            | "responseTooManyFailedAttempts",
            Some(408 | 500 | 502..=504),
        ) => Some(RecoveryFailure::Retryable),
        ("responseStreamDisconnected", Some(200)) => Some(RecoveryFailure::Retryable),
        (
            "httpConnectionFailed"
            | "responseStreamConnectionFailed"
            | "responseStreamDisconnected",
            None,
        ) if http.is_none_or(Value::is_null) => Some(RecoveryFailure::Retryable),
        _ => None,
    }
}

fn read_openai_quota(
    connection: &mut CodexConnection,
    reserve: u8,
    cwd: Option<&str>,
    deadline: Instant,
) -> Option<bool> {
    // Account rate limits use the app-server's backend. Check both its
    // default transport and the target workspace's transport when available.
    for cwd in [None].into_iter().chain(cwd.map(Some)) {
        let reply = read_rpc(
            connection,
            "config/read",
            json!({"cwd": cwd, "includeLayers": false}),
            deadline,
        )
        .ok()?;
        let config = reply["config"].as_object()?;
        if config
            .get("model_provider")
            .is_some_and(|value| !value.is_null() && value != "openai")
            || config
                .get("openai_base_url")
                .is_some_and(|value| !value.is_null())
            || config.get("chatgpt_base_url").is_some_and(|value| {
                !value.is_null()
                    && !matches!(
                        value.as_str(),
                        Some(
                            "https://chatgpt.com/backend-api" | "https://chatgpt.com/backend-api/"
                        )
                    )
            })
        {
            return None;
        }
    }
    let account = read_rpc(
        connection,
        "account/read",
        json!({"refreshToken": false}),
        deadline,
    )
    .ok()?;
    if account["account"]["type"] != "chatgpt" || account["requiresOpenaiAuth"] != true {
        return None;
    }
    let snapshot = read_rpc(connection, "account/rateLimits/read", json!({}), deadline).ok()?;
    let now_seconds = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    quota_decision(&snapshot, reserve, now_seconds)
}

fn quota_decision(snapshot: &Value, reserve: u8, now_seconds: u64) -> Option<bool> {
    let bucket = match snapshot.get("rateLimitsByLimitId") {
        None | Some(Value::Null) => &snapshot["rateLimits"],
        Some(Value::Object(buckets)) if buckets.is_empty() => &snapshot["rateLimits"],
        Some(Value::Object(buckets)) => buckets.get("codex")?,
        _ => return None,
    };
    if !bucket.is_object() || (!absent_or_null(bucket, "limitId") && bucket["limitId"] != "codex") {
        return None;
    }
    if bucket["spendControlReached"] == true
        || matches!(
            bucket["rateLimitReachedType"].as_str(),
            Some(
                "rate_limit_reached"
                    | "workspace_owner_credits_depleted"
                    | "workspace_member_credits_depleted"
                    | "workspace_owner_usage_limit_reached"
                    | "workspace_member_usage_limit_reached"
            )
        )
    {
        return Some(false);
    }
    let mut has_window = false;
    let mut unknown = !absent_or_null(bucket, "rateLimitReachedType")
        || !matches!(
            bucket.get("spendControlReached"),
            None | Some(Value::Null | Value::Bool(false))
        );
    for field in ["primary", "secondary", "individualLimit"] {
        if absent_or_null(bucket, field) {
            continue;
        }
        let window = &bucket[field];
        let remaining = if field == "individualLimit" {
            window["remainingPercent"]
                .as_u64()
                .filter(|pct| *pct <= 100)
        } else {
            window["usedPercent"]
                .as_u64()
                .filter(|pct| *pct <= 100)
                .map(|pct| 100 - pct)
        };
        let fresh = absent_or_null(window, "resetsAt")
            || window["resetsAt"]
                .as_u64()
                .is_some_and(|reset| reset > now_seconds);
        match remaining.filter(|_| fresh) {
            Some(remaining) if remaining <= u64::from(reserve) => return Some(false),
            Some(_) => has_window |= field != "individualLimit",
            None => unknown = true,
        }
    }
    (has_window && !unknown).then_some(true)
}

fn absent_or_null(object: &Value, field: &str) -> bool {
    object.get(field).is_none_or(Value::is_null)
}

fn required_string<'a>(object: &'a Value, field: &str) -> Option<&'a str> {
    object[field].as_str().filter(|value| valid_id(value))
}

fn valid_id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096
}

fn recovery_deadline(timeout: Duration) -> Result<Instant, ReadError> {
    Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| ReadError("Codex recovery timeout is invalid".into()))
}

fn remaining_time(deadline: Instant) -> Result<Duration, ReadError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err(ReadError("Codex recovery deadline elapsed".into()))
    } else {
        Ok(remaining)
    }
}

fn read_rpc(
    connection: &mut CodexConnection,
    method: &str,
    params: Value,
    deadline: Instant,
) -> Result<Value, ReadError> {
    connection
        .request(method, params, remaining_time(deadline)?)
        .map_err(|error| ReadError(error.to_string()))
}

fn not_sent(reason: &str) -> SubmitError {
    SubmitError::DefinitelyNotSent {
        reason: reason.into(),
    }
}

fn read_refusal(error: ReadError) -> SubmitError {
    SubmitError::DefinitelyNotSent { reason: error.0 }
}

#[cfg(test)]
#[path = "recovery_lineage_tests.rs"]
mod lineage_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{adapters::codex::connection::CodexInstance, domain::address::NodeRef};
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn followup_requires_the_receipted_input_and_a_distinct_latest_user_429() {
        let key = "codex-recovery:original";
        let receipt = NativeReceipt {
            target: SessionAddress {
                instance: InstanceRef { node: NodeRef("node".into()), instance_id: "codex".into() },
                native_session_id: "thread".into(),
            },
            native_id: "recovery".into(),
        };
        let turn = |id: &str, input: &str, client: Option<&str>, start: u64| json!({
            "id":id, "rootTurnId":id, "status":"failed", "startedAt":start, "completedAt":start+1,
            "error":{"codexErrorInfo":{"responseTooManyFailedAttempts":{"httpStatusCode":429}}},
            "items":[{"type":"userMessage", "id":input, "clientId":client}]
        });
        let old = turn("recovery", "admitted-input", Some(key), 1);
        let new = turn("manual", "new-input", None, 2);
        let thread = json!({"id":"thread", "turns":[old, new]});
        assert_eq!(superseding_user_turn(&thread, &receipt, key), Some("manual"));
        for (path, value) in [
            ("/id", json!("other-thread")),
            ("/turns/0/id", json!("different-recovery")),
            ("/turns/0/items/0/clientId", json!("other-request")),
            ("/turns/0/status", json!("inProgress")),
            ("/turns/0/completedAt", json!(3)),
            ("/turns/1/id", json!("recovery")),
            ("/turns/1/rootTurnId", json!("recovery")),
            ("/turns/1/items", json!([])),
            ("/turns/1/items/0/id", json!("admitted-input")),
            ("/turns/1/items/0/clientId", json!("codex-recovery:another")),
            ("/turns/1/error/codexErrorInfo", json!("usageLimitExceeded")),
            ("/turns", json!([old, old, new])),
            ("/turns", json!([old, new, {"id":"later","status":"completed"}])),
        ] {
            let mut changed = thread.clone();
            *changed.pointer_mut(path).unwrap() = value;
            assert_eq!(superseding_user_turn(&changed, &receipt, key), None, "{path}");
        }
    }

    #[test]
    fn retry_429_requires_the_same_terminal_failure_and_cooldown_from_completion() {
        let boundary = RecoveryBoundary {
            turn_id: "failed".into(), input_item_id: "input".into(), cwd: "/project".into(),
            provider: "opencodex".into(), model: Some("saved".into()), started_at_ms: 1000,
            failure: RecoveryFailure::Throttled, ancestors: vec![],
        };
        let mut turn = json!({"id": "failed", "status": "failed", "startedAt": 1, "completedAt": 100,
            "error": {"message": "exceeded retry limit, last status: 429 Too Many Requests",
                      "codexErrorInfo": {"responseTooManyFailedAttempts": {"httpStatusCode": 429}}}});
        let ready = |turn: &Value, now| matches!(retry_after_throttle(turn, &boundary, now), SameRouteRetry::Ready);
        assert!(!ready(&turn, 99));
        assert!(!ready(&turn, 129));
        assert!(ready(&turn, 130));
        turn["stopReason"] = json!("user");
        assert!(!ready(&turn, 130));
        turn["stopReason"] = Value::Null;
        turn["id"] = json!("later-turn");
        assert!(!ready(&turn, 130));
        turn["id"] = json!("failed");
        for info in [json!("usageLimitExceeded"), json!("rateLimitExceeded"), json!("other"), Value::Null] {
            turn["error"]["codexErrorInfo"] = info;
            assert!(matches!(retry_after_throttle(&turn, &boundary, 130), SameRouteRetry::Hold));
        }
        turn["error"]["codexErrorInfo"] = json!("serverOverloaded");
        assert!(matches!(retry_after_throttle(&turn, &boundary, 130), SameRouteRetry::UseQuotaPolicy));
    }

    const BASE_URL: &str = "http://127.0.0.1:19090/v1";
    const BEARER: &str = "synthetic-bearer-for-fixture";

    #[test]
    fn recovery_distinguishes_async_progress_from_an_unanswered_question() {
        let mut items = vec![json!({"type":"userMessage","id":"original"})];
        // The reported thread had 504 items in its fully hydrated latest turn.
        for i in 0..500 {
            items.push(json!({"type":"reasoning","id":format!("reasoning-{i}")}));
        }
        let question = json!({"type":"agentMessage","id":"ask","phase":"final_answer",
            "delivery":"async","questions":[{"title":"Sign in?"}]});
        items.push(question);
        let check = |items: &[Value]| {
            items
                .iter()
                .rev()
                .find_map(|item| match tail_item(item, Some("original"), false) {
                    RecoveryTail::Earlier => None,
                    RecoveryTail::Continue(id) => Some(Some(id.to_owned())),
                    RecoveryTail::Hold => Some(None),
                })
                .flatten()
        };
        assert_eq!(check(&items), None);
        items.push(json!({"type":"reasoning","id":"tail"}));
        assert_eq!(check(&items), None);
        items.push(
            json!({"type":"agentMessage","id":"progress","phase":"commentary",
            "text":"Continuing the independent work","questions":null}),
        );
        assert_eq!(check(&items).as_deref(), Some("original"));

        items.push(
            json!({"type":"agentMessage","id":"done","phase":"final_answer",
            "text":"Finished","delivery":null}),
        );
        assert_eq!(check(&items), None);
    }
    const RPC_FIXTURE: &str = r#"
import json, os, sys
from pathlib import Path

home = Path(os.environ["CODEX_HOME"])
case = (home / "case").read_text()
loaded = case == "already-loaded"
model = "old-model"
resumed = False
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method, params = request["method"], request["params"]
    with (home / "calls").open("a") as calls:
        print(method, file=calls)
    thread = {"id": "saved-thread", "source": "appServer", "cwd": str(home),
              "modelProvider": "pinned", "model": model,
              "status": {"type": "idle" if loaded else "notLoaded"}}
    if case == "root-held":
        thread.update(status={"type":"systemError"}, canAcceptDirectInput=True)
    if case.startswith("goal-"):
        thread.update(path=str(home / "sessions" / "rollout-saved-thread.jsonl"),
                      status={"type":"idle"}, canAcceptDirectInput=True)
    if method == "initialize":
        result = {"codexHome": str(home)}
    elif method == "thread/read":
        result = {"thread": thread}
    elif method == "thread/list":
        result = {"data": [{k:v for k,v in thread.items() if k != "canAcceptDirectInput"}], "nextCursor": None}
    elif method == "thread/loaded/list":
        result = {"data": ["saved-thread"] if loaded else [], "nextCursor": None}
    elif method == "thread/turns/list":
        assert params["itemsView"] == "summary" and params["limit"] == 1
        result = {"data": [{"id": "old-turn", "status": "failed", "startedAt": 100,
                            "completedAt": 101, "itemsView": "summary",
                            "error": {"codexErrorInfo": "serverOverloaded" if case == "root-held" else "usageLimitExceeded"},
                            "items": [{"type": "userMessage", "id": "user-item"}]}]}
        if case.startswith("goal-"):
            result["data"][0].update(rootTurnId="old-turn", items=[], error={
                "codexErrorInfo": {"responseTooManyFailedAttempts": {"httpStatusCode": 429}}})
    elif method == "thread/goal/get":
        result = {"goal": None}
        if case.startswith("goal-") and case != "goal-cleared":
            status = {"goal-active": "active", "goal-paused": "paused", "goal-complete": "complete"}.get(case, "blocked")
            result["goal"] = {"threadId":"saved-thread", "status": status,
                              "updatedAt": 105 if case == "goal-blocked-later" else 101}
    elif method == "thread/items/list":
        assert params["turnId"] == "old-turn" and params["sortDirection"] == "desc"
        result = {"data":[{"turnId":"old-turn","item":{"id":"user-item","type":"userMessage"}}],"nextCursor":None}
        if case.startswith("goal-"):
            result = {"data": [{"turnId":"old-turn","item":{"id":"work","type":"commandExecution"}}],
                      "nextCursor":None}
            if case == "goal-question":
                result["data"].insert(0, {"turnId":"old-turn", "item":{"id":"question","type":"agentMessage",
                    "phase":"final_answer","delivery":"async","questions":[{"title":"Approve?"}]}})
    elif method == "thread/queue/list":
        result = {"data": []}
    elif method == "config/read":
        bearer = "another-synthetic-fixture-bearer" if resumed and case == "rotated" else "synthetic-bearer-for-fixture"
        result = {"config": {"model_providers": {"pinned": {"wire_api": "responses"},
            "alternate": {"wire_api": "responses", "base_url": "http://127.0.0.1:19090/v1",
                          "experimental_bearer_token": bearer}}}}
    elif method == "configRequirements/read":
        result = {"requirements": {"modelProviders": {"pinned": {}}} if case == "managed" else None}
    elif method == "thread/resume":
        assert params["threadId"] == "saved-thread" and params["modelProvider"] == "pinned"
        assert params["config"]["model_providers.pinned.base_url"] == "http://127.0.0.1:19090/v1"
        assert params["config"]["model_providers.pinned.experimental_bearer_token"] == "synthetic-bearer-for-fixture"
        if case in ("rejected", "uncertain"):
            code = -32600 if case == "rejected" else -32000
            print(json.dumps({"id": request["id"], "error": {"code": code,
                "message": "native error echo: synthetic-bearer-for-fixture"}}), flush=True)
            continue
        resumed = loaded = True
        model = model if case == "ignored" else params["model"]
        result = {"thread": dict(thread, model=model, status={"type": "idle"}),
                  "model": model, "modelProvider": "pinned", "cwd": str(home)}
    elif method == "turn/start":
        assert params["threadId"] == "saved-thread"
        assert params["clientUserMessageId"] == "exact-request"
        result = {"turn": {"id": "new-turn", "status": "inProgress"}}
    else:
        raise RuntimeError("unexpected fixture method")
    print(json.dumps({"id": request["id"], "result": result}), flush=True)
"#;

    #[test]
    fn failed_native_goal_turn_can_resume_after_provider_429() {
        for (case, trigger, expected) in [
            ("goal-provider-failure", "goal", true),
            ("goal-active", "goal", true),
            ("goal-cleared", "goal", false),
            ("goal-complete", "goal", false),
            ("goal-paused", "goal", false),
            ("goal-blocked-later", "goal", false),
            ("goal-question", "goal", false),
            ("goal-unrelated-turn", "composer", false),
        ] {
            let dir = std::env::temp_dir().join(format!("herder-goal-{}-{case}", std::process::id()));
            fs::create_dir(&dir).unwrap();
            let home = dir.canonicalize().unwrap();
            fs::create_dir(home.join("sessions")).unwrap();
            fs::write(home.join("app-server"), RPC_FIXTURE).unwrap();
            fs::write(home.join("case"), case).unwrap();
            let event = json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"old-turn",
                "root_turn_id":"old-turn","turn_attribution":{"turn_id":"old-turn","root_turn_id":"old-turn",
                "turn_trigger":trigger,"parent_turn_id":null,"initiating_agent_path":null}}});
            fs::write(home.join("sessions/rollout-saved-thread.jsonl"), format!("{event}\n")).unwrap();
            let db = rusqlite::Connection::open(home.join("thread_history_1.sqlite")).unwrap();
            db.execute_batch("CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, status TEXT, rollout_byte_offset INTEGER);
                INSERT INTO thread_turns VALUES ('saved-thread','old-turn','failed',0);").unwrap();
            drop(db);
            let target = SessionAddress {
                instance: InstanceRef { node: NodeRef("local".into()), instance_id: "test".into() },
                native_session_id: "saved-thread".into(),
            };
            let control = CodexControl::open(CodexInstance {
                instance_id: "test".into(), executable: PathBuf::from("/usr/bin/python3"),
                code_home: home.clone(), cwd: home.clone(), socket_path: None,
            }, target.instance.clone(), Duration::from_secs(3)).unwrap();
            let observed = control.read_boundary(&target).unwrap();
            drop(control);
            fs::remove_dir_all(home).unwrap();
            assert_eq!(observed.is_some(), expected, "{case}");
            if let Some(boundary) = observed {
                assert_eq!(boundary.turn_id, "old-turn");
                assert_eq!(boundary.provider, "pinned");
                assert_eq!(boundary.model.as_deref(), Some("old-model"));
            }
        }
    }

    #[test]
    fn recovery_checks_owner_hold_and_alternate_route_before_submit() {
        for (case, resumes, starts, quota_checks) in [
            ("cold", 1, 1, 2),
            ("already-loaded", 0, 0, 0),
            ("root-held", 0, 0, 0),
            ("ignored", 1, 0, 1),
            ("rotated", 1, 0, 1),
            ("lost-quota", 1, 0, 2),
            ("managed", 0, 0, 0),
            ("rejected", 1, 0, 1),
            ("uncertain", 1, 0, 1),
        ] {
            let root = std::env::temp_dir().join(format!(
                "herder-codex-recovery-{}-{case}",
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
            let root = root.canonicalize().unwrap();
            fs::write(root.join("app-server"), RPC_FIXTURE).unwrap();
            fs::write(root.join("case"), case).unwrap();
            let target = SessionAddress {
                instance: InstanceRef {
                    node: NodeRef("fixture-node".into()),
                    instance_id: "fixture-instance".into(),
                },
                native_session_id: "saved-thread".into(),
            };
            let control = CodexControl::open(
                CodexInstance {
                    instance_id: target.instance.instance_id.clone(),
                    executable: PathBuf::from("/usr/bin/python3"),
                    code_home: root.clone(),
                    cwd: root.clone(),
                    socket_path: None,
                },
                target.instance.clone(),
                Duration::from_secs(3),
            )
            .unwrap();
            let boundary = control.read_boundary(&target).unwrap().unwrap();
            let route = if case == "root-held" {
                RecoveryRoute {
                    provider: boundary.provider.clone(),
                    model: boundary.model.clone(),
                }
            } else {
                RecoveryRoute {
                    provider: "alternate".into(),
                    model: Some("codex/gpt-5.6-luna".into()),
                }
            };
            let credential = static_responses_route(
                &json!({"wire_api":"responses","base_url":BASE_URL,"experimental_bearer_token":BEARER}),
                &route.provider,
            )
            .unwrap()
            .credential;
            let checks = AtomicUsize::new(0);
            let still_available =
                || checks.fetch_add(1, Ordering::Relaxed) == 0 || case != "lost-quota";
            let result = control.submit(
                &target,
                &boundary,
                &route,
                RecoveryPermit {
                    reserve: 20,
                    quota_proof: Some(RecoveryQuotaProof {
                        credential: &credential,
                        still_available: &still_available,
                    }),
                    still_allowed: &|| case != "root-held",
                },
                "continue fixture",
                &RequestKey("exact-request".into()),
            );
            if starts == 1 {
                let receipt = result.unwrap().receipt;
                assert_eq!(receipt.target, target);
                assert_eq!(receipt.native_id, "new-turn");
            } else if case == "uncertain" {
                assert!(
                    matches!(result, Err(SubmitError::OutcomeUnknown { .. })),
                    "{result:?}"
                );
                assert!(!format!("{result:?}").contains(BEARER));
            } else {
                assert!(
                    matches!(result, Err(SubmitError::DefinitelyNotSent { .. })),
                    "{case}: {result:?}"
                );
                assert!(!format!("{result:?}").contains(BEARER));
            }
            assert_eq!(checks.load(Ordering::Relaxed), quota_checks, "{case}");
            let calls = fs::read_to_string(root.join("calls")).unwrap();
            assert_eq!(
                calls.lines().filter(|m| *m == "thread/resume").count(),
                resumes,
                "{case}"
            );
            assert_eq!(
                calls.lines().filter(|m| *m == "turn/start").count(),
                starts,
                "{case}"
            );
            drop(control);
            fs::remove_dir_all(root).unwrap();
        }
    }
}
