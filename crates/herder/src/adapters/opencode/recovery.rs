//! OpenCode v2 recovery with native synthetic-queue admission and exact readback.

use std::{
    collections::BTreeMap,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::{Method, StatusCode};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::time::{Instant, timeout_at};

use crate::domain::{
    adapter::{Admission, NativeReceipt, ReadError, RequestKey, SubmitError},
    address::SessionAddress,
    recovery::{RecoveryBoundary, RecoveryFailure, RecoveryPermit, RecoveryRoute},
};

use super::{
    MAX_MESSAGE_BYTES, MAX_REQUEST_KEY_BYTES, OpenCodeSessionControl, definitely_not_sent,
    outcome_unknown, valid_message_id,
};

const TIMEOUT: Duration = Duration::from_secs(10);
const READ_ID: &str = "herder-opencode-recovery-read";
const KEY_PREFIX: &str = "opencode-recovery:";
const ID_PREFIX: &str = "msg_herderauto";
const CONTINUATION: &str = "synthetic-queue-v1";
const DESCRIPTION: &str = "Agent Herder completion";
const RECENT_LIMIT: usize = 12;

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ActiveDrain {
    Running,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
struct ModelRef {
    #[serde(rename = "providerID")]
    provider: String,
    id: String,
    variant: Option<String>,
}

impl ModelRef {
    fn matches(&self, other: &Self) -> bool {
        self.provider == other.provider
            && self.id == other.id
            && self.variant.as_deref().unwrap_or("default")
                == other.variant.as_deref().unwrap_or("default")
    }
}

#[derive(Deserialize, Eq, PartialEq)]
struct SessionTime {
    created: u64,
    updated: u64,
    busy: Option<u64>,
    idle: Option<u64>,
    archived: Option<u64>,
}

#[derive(Deserialize, Eq, PartialEq)]
struct Location {
    directory: String,
}

#[derive(Deserialize, Eq, PartialEq)]
struct Session {
    id: String,
    #[serde(rename = "projectID")]
    project_id: String,
    #[serde(rename = "parentID")]
    parent_id: Option<String>,
    fork: Option<Value>,
    revert: Option<Value>,
    location: Location,
    model: Option<ModelRef>,
    outcome: Option<String>,
    time: SessionTime,
}

struct Observation {
    boundary: RecoveryBoundary,
    model: ModelRef,
    idle_at: Option<u64>,
    project_id: String,
}

impl OpenCodeSessionControl {
    pub async fn read_recovery_boundary(
        &self,
        target: &SessionAddress,
    ) -> Result<Option<RecoveryBoundary>, ReadError> {
        self.check_recovery_target(target)?;
        Ok(self
            .recovery_observation(target, None, self.recovery_deadline())
            .await?
            .map(|observed| observed.boundary))
    }

    pub async fn submit_recovery(
        &self,
        target: &SessionAddress,
        boundary: &RecoveryBoundary,
        route: &RecoveryRoute,
        permit: RecoveryPermit<'_>,
        message: &str,
        key: &RequestKey,
    ) -> Result<Admission, SubmitError> {
        self.check_recovery_target(target).map_err(read_refusal)?;
        let sid = target.native_session_id.as_str();
        let id = recovery_id(sid, &key.0)
            .ok_or_else(|| definitely_not_sent("invalid OpenCode recovery request key"))?;
        if message.trim().is_empty() || message.len() > MAX_MESSAGE_BYTES || permit.reserve > 100 {
            return Err(definitely_not_sent(
                "invalid OpenCode recovery input or reserve",
            ));
        }
        let model = route
            .model
            .as_deref()
            .filter(|model| valid_model_component(model))
            .ok_or_else(|| definitely_not_sent("OpenCode recovery requires an exact model"))?;
        if !valid_model_component(&route.provider) || !(permit.still_allowed)() {
            return Err(definitely_not_sent(
                "OpenCode recovery route or owner permit is invalid",
            ));
        }
        let deadline = self.recovery_deadline();
        let switch =
            route.provider != boundary.provider || Some(model) != boundary.model.as_deref();
        let needs_quota = switch || boundary.failure == RecoveryFailure::Quota;
        let before = self
            .recovery_observation(target, None, deadline)
            .await
            .map_err(read_refusal)?
            .filter(|value| value.boundary == *boundary)
            .ok_or_else(|| {
                definitely_not_sent("OpenCode recovery boundary is no longer current")
            })?;

        if !self
            .verify_recovery_quota(&permit, route, model, &boundary.cwd, needs_quota, deadline)
            .await
        {
            return Err(definitely_not_sent(
                "OpenCode recovery quota or credential is unconfirmed",
            ));
        }

        let previous = switch.then_some(&before.model);
        let base = session_path(sid);
        if switch {
            // Model selection and synthetic enqueue are separate native operations.
            // Screen for activity again before either operation and verify the audit
            // frame before using the changed selection.
            if self
                .recovery_observation(target, None, deadline)
                .await
                .map_err(read_refusal)?
                .is_none_or(|value| {
                    value.boundary != *boundary
                        || value.model != before.model
                        || value.project_id != before.project_id
                })
                || !(permit.still_allowed)()
                || !quota_still_available(&permit)
            {
                return Err(definitely_not_sent(
                    "OpenCode recovery changed before model selection",
                ));
            }
            let request = self
                .connection()
                .request(READ_ID, Method::POST, &format!("{base}/model"))
                .map_err(|_| definitely_not_sent("could not build OpenCode model selection"))?
                .json(&json!({"model": {"providerID": route.provider, "id": model}}));
            let switched = timeout_at(deadline, request.send()).await;
            if !matches!(switched, Ok(Ok(response)) if response.status() == StatusCode::NO_CONTENT)
            {
                return Err(outcome_unknown(
                    None,
                    "OpenCode model selection outcome is unknown",
                ));
            }
            if !self
                .verify_recovery_quota(&permit, route, model, &boundary.cwd, needs_quota, deadline)
                .await
            {
                return Err(definitely_not_sent(
                    "OpenCode quota binding changed after model selection",
                ));
            }
        }

        let ready = self
            .recovery_observation(target, previous, deadline)
            .await
            .map_err(read_refusal)?;
        if ready.is_none_or(|value| {
            value.boundary != *boundary
                || value.idle_at != before.idle_at
                || value.project_id != before.project_id
                || value.model.provider != route.provider
                || value.model.id != model
                || (!switch && value.model != before.model)
        }) || !(permit.still_allowed)()
            || !quota_still_available(&permit)
            || Instant::now() >= deadline
        {
            return Err(definitely_not_sent(
                "OpenCode recovery state changed before synthetic admission",
            ));
        }

        let request = self
            .connection()
            .request(READ_ID, Method::POST, &format!("{base}/synthetic"))
            .map_err(|_| definitely_not_sent("could not build OpenCode synthetic input"))?
            .json(&json!({
                "id": id,
                "text": message,
                "description": DESCRIPTION,
                "metadata": {
                    "agentHerderInputId": key.0,
                    "agentHerderSessionId": sid,
                    "agentHerderContinuation": CONTINUATION,
                },
                "delivery": "queue",
                "resume": true,
            }));
        let result = timeout_at(deadline, async {
            let response = request.send().await.ok()?;
            if response.status() != StatusCode::OK {
                return None;
            }
            response.json::<Envelope<Value>>().await.ok()
        })
        .await;
        match result {
            Ok(Some(wire)) if inbox_matches(&wire.data, sid, &id, &key.0, Some(message)) => {
                Ok(Admission {
                    receipt: native_receipt(target, id),
                })
            }
            _ => Err(outcome_unknown(
                None,
                "OpenCode synthetic admission is unconfirmed",
            )),
        }
    }

    /// Recover an ACK from the exact projected message or the durable pending inbox.
    pub async fn recover_recovery_admission(
        &self,
        target: &SessionAddress,
        key: &RequestKey,
    ) -> Result<Option<NativeReceipt>, ReadError> {
        self.check_recovery_target(target)?;
        let sid = target.native_session_id.as_str();
        let Some(id) = recovery_id(sid, &key.0) else {
            return Ok(None);
        };
        let deadline = self.recovery_deadline();
        if self.delivered_recovery(target, &id, deadline).await? {
            return Ok(Some(native_receipt(target, id)));
        }

        let inbox: Vec<Value> = self
            .recovery_get(&format!("{}/inbox", session_path(sid)), deadline)
            .await?;
        let mut items = inbox.iter().filter(|item| item["id"].as_str() == Some(&id));
        if let Some(item) = items.next() {
            if items.next().is_some() || !inbox_matches(item, sid, &id, &key.0, None) {
                return Err(ReadError(
                    "OpenCode pending synthetic receipt does not match".into(),
                ));
            }
        } else if !self.delivered_recovery(target, &id, deadline).await? {
            // The item can move from the inbox to history between the two reads.
            return Ok(None);
        }
        Ok(Some(native_receipt(target, id)))
    }

    /// True only after the exact synthetic input has materialized in the transcript.
    pub async fn reconcile_recovery_receipt(
        &self,
        receipt: &NativeReceipt,
    ) -> Result<bool, ReadError> {
        self.check_recovery_target(&receipt.target)?;
        if !valid_recovery_id(&receipt.native_id) {
            return Ok(false);
        }
        self.delivered_recovery(
            &receipt.target,
            &receipt.native_id,
            self.recovery_deadline(),
        )
        .await
    }

    async fn delivered_recovery(
        &self,
        target: &SessionAddress,
        id: &str,
        deadline: Instant,
    ) -> Result<bool, ReadError> {
        let sid = target.native_session_id.as_str();
        let path = format!("{}/message/{id}", session_path(sid));
        let request = self
            .connection()
            .request(READ_ID, Method::GET, &path)
            .map_err(|_| ReadError("could not build OpenCode recovery read".into()))?;
        timeout_at(deadline, async {
            let response = request.send().await.map_err(|_| read_unavailable())?;
            match response.status() {
                StatusCode::OK => {
                    let wire: Envelope<Value> =
                        response.json().await.map_err(|_| read_unavailable())?;
                    let row = wire.data;
                    let key = row["metadata"]["agentHerderInputId"].as_str();
                    if row["type"] == "synthetic"
                        && row["id"].as_str() == Some(id)
                        && valid_frame_time(&row).is_some()
                        && row["text"].as_str().is_some_and(|text| !text.is_empty())
                        && row["description"] == DESCRIPTION
                        && row
                            .get("sessionID")
                            .is_none_or(|actual| actual.as_str() == Some(sid))
                        && key.is_some_and(|key| scoped_metadata(&row["metadata"], sid, id, key))
                    {
                        Ok(true)
                    } else {
                        Err(ReadError(
                            "OpenCode delivered synthetic receipt does not match".into(),
                        ))
                    }
                }
                StatusCode::NOT_FOUND => {
                    let error: Value = response.json().await.map_err(|_| read_unavailable())?;
                    if error["_tag"] == "MessageNotFoundError"
                        && error["sessionID"].as_str() == Some(sid)
                        && error["messageID"].as_str() == Some(id)
                    {
                        Ok(false)
                    } else {
                        Err(read_unavailable())
                    }
                }
                _ => Err(read_unavailable()),
            }
        })
        .await
        .map_err(|_| read_unavailable())?
    }

    async fn recovery_observation(
        &self,
        target: &SessionAddress,
        switched_from: Option<&ModelRef>,
        deadline: Instant,
    ) -> Result<Option<Observation>, ReadError> {
        let sid = target.native_session_id.as_str();
        let base = session_path(sid);
        let active = "/api/session/active";
        let (session, drains): (Session, BTreeMap<String, ActiveDrain>) = tokio::try_join!(
            self.recovery_get(&base, deadline),
            self.recovery_get(active, deadline)
        )?;
        if session.id != sid {
            return Err(ReadError(
                "OpenCode recovery read returned a different session".into(),
            ));
        }
        if drains.contains_key(sid) {
            return Ok(None);
        }
        let inbox_path = format!("{base}/inbox");
        let form_path = format!("{base}/form");
        let permission_path = format!("{base}/permission");
        let history_path = format!("{base}/message?limit={RECENT_LIMIT}&order=desc");
        let (inbox, forms, permissions, recent): (Vec<Value>, Vec<Value>, Vec<Value>, Vec<Value>) =
            tokio::try_join!(
                self.recovery_get(&inbox_path, deadline),
                self.recovery_get(&form_path, deadline),
                self.recovery_get(&permission_path, deadline),
                self.recovery_get(&history_path, deadline),
            )?;
        if !inbox.is_empty() || !forms.is_empty() || !permissions.is_empty() {
            return Ok(None);
        }
        let (current, drains): (Session, BTreeMap<String, ActiveDrain>) = tokio::try_join!(
            self.recovery_get(&base, deadline),
            self.recovery_get(active, deadline)
        )?;
        if session != current || drains.contains_key(sid) {
            return Ok(None);
        }
        Ok(derive_observation(session, &recent, switched_from))
    }

    async fn recovery_get<T: DeserializeOwned>(
        &self,
        path: &str,
        deadline: Instant,
    ) -> Result<T, ReadError> {
        let request = self
            .connection()
            .request(READ_ID, Method::GET, path)
            .map_err(|_| ReadError("could not build OpenCode recovery read".into()))?;
        timeout_at(deadline, async {
            let response = request.send().await.map_err(|_| read_unavailable())?;
            if response.status() != StatusCode::OK {
                return Err(read_unavailable());
            }
            let wire: Envelope<T> = response.json().await.map_err(|_| read_unavailable())?;
            Ok(wire.data)
        })
        .await
        .map_err(|_| read_unavailable())?
    }

    async fn verify_recovery_quota(
        &self,
        permit: &RecoveryPermit<'_>,
        route: &RecoveryRoute,
        model: &str,
        cwd: &str,
        required: bool,
        deadline: Instant,
    ) -> bool {
        let Some(proof) = &permit.quota_proof else {
            return !required;
        };
        matches!(
            timeout_at(deadline, self.recovery_credential(&route.provider, model, cwd)).await,
            Ok(Some(ref binding)) if binding == proof.credential && (proof.still_available)()
        )
    }

    fn check_recovery_target(&self, target: &SessionAddress) -> Result<(), ReadError> {
        let sid = &target.native_session_id;
        if target.instance != *self.connection().instance()
            || sid.len() > MAX_REQUEST_KEY_BYTES
            || !sid.strip_prefix("ses_").is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
        {
            return Err(ReadError("invalid OpenCode recovery target".into()));
        }
        Ok(())
    }

    fn recovery_deadline(&self) -> Instant {
        Instant::now() + self.connection().request_timeout().min(TIMEOUT)
    }
}

fn derive_observation(
    session: Session,
    recent: &[Value],
    switched_from: Option<&ModelRef>,
) -> Option<Observation> {
    let busy = session.time.busy?;
    let model = session.model?;
    if session.project_id.is_empty()
        || session.parent_id.is_some()
        || session.fork.is_some()
        || session.revert.is_some()
        || session.time.archived.is_some()
        || !Path::new(&session.location.directory).is_absolute()
        || busy == 0
        || session.time.created > busy
        || session.time.updated < session.time.created
        || !valid_model_component(&model.id)
        || !valid_model_component(&model.provider)
        || recent.len() > RECENT_LIMIT
    {
        return None;
    }
    if !stable_history(recent, &session.id) {
        return None;
    }
    let source = switched_from.unwrap_or(&model);
    let recent = if let Some(old) = switched_from {
        let (audit, tail) = recent.split_first()?;
        if audit["type"] != "model-switched"
            || valid_frame_time(audit)? < busy
            || !read_model(&audit["previous"])?.matches(old)
            || !read_model(&audit["model"])?.matches(&model)
        {
            return None;
        }
        tail
    } else {
        recent
    };
    let (input, turn_id, failure) = if session.time.idle.is_none_or(|idle| idle < busy) {
        if session.time.idle.is_none() && session.outcome.is_some()
            || session.outcome.as_deref() == Some("interrupted")
        {
            return None;
        }
        let (aborted, recent) = match recent {
            [step, tail @ ..] if step["type"] == "assistant" => (Some(step), tail),
            _ => (None, recent),
        };
        let (input, history) = recent.split_first()?;
        let input_at = valid_frame_time(input)?;
        if !recovery_input(input, &session.id) || input_at < busy {
            return None;
        }
        // SIGTERM can record an aborted step before the backend writes an idle
        // outcome. A completed native interrupt has its own terminal outcome.
        if let Some(step) = aborted {
            let created = valid_frame_time(step)?;
            let completed = step["time"]["completed"].as_u64()?;
            if step["finish"] != "error"
                || step["error"]["type"] != "aborted"
                || !step["content"].as_array()?.is_empty()
                || !step["snapshot"].is_null()
                || !step["time"]["firstToken"].is_null()
                || !step["time"]["streamed"].is_null()
                || !source.matches(&read_model(&step["model"])?)
                || created <= input_at
                || !(created..=session.time.updated).contains(&completed)
            {
                return None;
            }
        }
        if let Some(anchor) = history.first() {
            let bound_model = match anchor["type"].as_str()? {
                "model-switched" if valid_frame_time(anchor)? <= busy => {
                    read_model(&anchor["model"])?
                }
                "idle" if Some(valid_frame_time(anchor)?) == session.time.idle => {
                    let assistant = history.get(1)?;
                    if anchor["outcome"].as_str() != session.outcome.as_deref()
                        || assistant["type"] != "assistant"
                        || assistant["time"]["completed"].as_u64()? > valid_frame_time(anchor)?
                    {
                        return None;
                    }
                    read_model(&assistant["model"])?
                }
                _ => return None,
            };
            if !source.matches(&bound_model) {
                return None;
            }
        } else if session.time.idle.is_some() {
            return None;
        }
        // A first turn can use the model persisted at session creation. That
        // selection has no model-switched frame and there is no earlier idle.
        // The delivered user item identifies the same interrupted turn even
        // when shutdown added an empty aborted step to its history.
        (input, input["id"].as_str()?, RecoveryFailure::Interrupted)
    } else {
        let [idle, assistant, input, ..] = recent else {
            return None;
        };
        let idle_at = valid_frame_time(idle)?;
        if session.outcome.as_deref() != Some("failed")
            || idle["type"] != "idle"
            || idle["outcome"] != "failed"
            || Some(idle_at) != session.time.idle
            || assistant["type"] != "assistant"
            || assistant["finish"] != "error"
            || !assistant["content"].as_array()?.is_empty()
            || !assistant["snapshot"].is_null()
            || !assistant["time"]["firstToken"].is_null()
            || !assistant["time"]["streamed"].is_null()
            || !source.matches(&read_model(&assistant["model"])?)
            || !recovery_input(input, &session.id)
            || valid_frame_time(input)? < busy
            || valid_frame_time(assistant)? <= valid_frame_time(input)?
            || !(valid_frame_time(assistant)?..=idle_at)
                .contains(&assistant["time"]["completed"].as_u64()?)
        {
            return None;
        }
        let error = &assistant["error"];
        let terminal_error = &idle["error"];
        let failure = typed_failure(error)?;
        if error["type"] != terminal_error["type"]
            || error["status"] != terminal_error["status"]
            || typed_failure(terminal_error)? != failure
        {
            return None;
        }
        if error["type"] == "provider.rate-limit" {
            let retry_after = error.get("retryAfterMs");
            if retry_after != terminal_error.get("retryAfterMs") {
                return None;
            }
            if let Some(delay) = retry_after {
                // The terminal idle timestamp records the failure.
                let retry_at = idle_at.checked_add(delay.as_u64()?)?;
                let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
                if now < Duration::from_millis(retry_at) {
                    return None;
                }
            }
        }
        (input, assistant["id"].as_str()?, failure)
    };
    let boundary = RecoveryBoundary {
        turn_id: turn_id.to_owned(),
        input_item_id: input["id"].as_str()?.to_owned(),
        cwd: session.location.directory,
        provider: source.provider.clone(),
        model: Some(source.id.clone()),
        started_at_ms: busy,
        failure,
        ancestors: Vec::new(),
    };
    Some(Observation {
        boundary,
        model,
        idle_at: session.time.idle,
        project_id: session.project_id,
    })
}

fn stable_history(recent: &[Value], sid: &str) -> bool {
    let mut last = u64::MAX;
    let mut ids = std::collections::BTreeSet::new();
    recent.iter().all(|row| {
        let Some(time) = valid_frame_time(row) else {
            return false;
        };
        let id = row["id"].as_str().unwrap_or_default();
        let ordered = time <= last;
        last = time;
        ordered
            && ids.insert(id)
            && row["type"].is_string()
            && row
                .get("sessionID")
                .is_none_or(|value| value.as_str() == Some(sid))
    })
}

fn pure_user(row: &Value) -> bool {
    row["type"] == "user"
        && row["text"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty())
        && ["files", "agents", "skills"]
            .iter()
            .all(|field| row[*field].is_null() || row[*field].as_array().is_some_and(Vec::is_empty))
}

// A delivered synthetic continuation is the input to its own failed turn.
// Only our session-bound, deterministic queue metadata can substitute for a user.
fn recovery_input(row: &Value, sid: &str) -> bool {
    if pure_user(row) {
        return true;
    }
    let Some(id) = row["id"].as_str() else {
        return false;
    };
    let Some(key) = row["metadata"]["agentHerderInputId"].as_str() else {
        return false;
    };
    row["type"] == "synthetic"
        && row["text"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty())
        && row["description"] == DESCRIPTION
        && row
            .get("sessionID")
            .is_none_or(|value| value.as_str() == Some(sid))
        && scoped_metadata(&row["metadata"], sid, id, key)
}

fn typed_failure(error: &Value) -> Option<RecoveryFailure> {
    match (error["type"].as_str()?, error["status"].as_u64()) {
        ("provider.quota", Some(402 | 429)) => Some(RecoveryFailure::Quota),
        ("provider.internal" | "provider.error" | "system.error", Some(500..=599))
        | ("provider.timeout", Some(408 | 504))
        | ("provider.rate-limit", Some(429)) => Some(RecoveryFailure::Retryable),
        _ => None,
    }
}

fn valid_frame_time(row: &Value) -> Option<u64> {
    let id = row["id"].as_str()?;
    if id.len() <= MAX_REQUEST_KEY_BYTES && valid_message_id(id) {
        row["time"]["created"].as_u64().filter(|time| *time != 0)
    } else {
        None
    }
}

fn read_model(value: &Value) -> Option<ModelRef> {
    serde_json::from_value(value.clone()).ok()
}

fn valid_model_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
}

fn recovery_id(sid: &str, key: &str) -> Option<String> {
    if key.len() > MAX_REQUEST_KEY_BYTES || key.strip_prefix(KEY_PREFIX)?.trim().is_empty() {
        return None;
    }
    let encoded = serde_json::to_vec(&["herder-opencode-synthetic-queue-v1", sid, key]).ok()?;
    let digest: String = Sha256::digest(encoded)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Some(format!("{ID_PREFIX}{digest}"))
}

fn valid_recovery_id(id: &str) -> bool {
    id.strip_prefix(ID_PREFIX).is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

fn scoped_metadata(metadata: &Value, sid: &str, id: &str, key: &str) -> bool {
    metadata["agentHerderInputId"].as_str() == Some(key)
        && metadata["agentHerderSessionId"].as_str() == Some(sid)
        && metadata["agentHerderContinuation"] == CONTINUATION
        && recovery_id(sid, key).as_deref() == Some(id)
}

fn inbox_matches(row: &Value, sid: &str, id: &str, key: &str, message: Option<&str>) -> bool {
    row["id"].as_str() == Some(id)
        && row["sessionID"].as_str() == Some(sid)
        && row["type"] == "synthetic"
        && row["delivery"] == "queue"
        && valid_frame_time(row).is_some()
        && row["payload"]["description"] == DESCRIPTION
        && row["payload"]["text"]
            .as_str()
            .is_some_and(|text| !text.is_empty() && message.is_none_or(|expected| text == expected))
        && scoped_metadata(&row["payload"]["metadata"], sid, id, key)
}

fn quota_still_available(permit: &RecoveryPermit<'_>) -> bool {
    permit
        .quota_proof
        .as_ref()
        .is_none_or(|proof| (proof.still_available)())
}

fn native_receipt(target: &SessionAddress, id: String) -> NativeReceipt {
    NativeReceipt {
        target: target.clone(),
        native_id: id,
    }
}

fn session_path(sid: &str) -> String {
    format!("/api/session/{sid}")
}

fn read_unavailable() -> ReadError {
    ReadError("OpenCode recovery read is unavailable or has an unexpected schema".into())
}

fn read_refusal(error: ReadError) -> SubmitError {
    definitely_not_sent(&error.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        adapters::opencode::connection::OpenCodeConnection,
        config::Profile,
        domain::address::{InstanceRef, NodeRef},
    };
    use std::sync::{Arc, Mutex};
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::{TcpListener, TcpStream},
    };

    const SESSION: &str = "ses_Test123";
    const KEY: &str = "opencode-recovery:job";
    const ID: &str =
        "msg_herderauto10ee6dd193ea8daeed2bc4d974093d17ec6a66c38f7b411c83297af74866ebd4";

    fn model() -> Value {
        json!({"providerID":"fixture","id":"main","variant":"default"})
    }

    fn session(idle: Option<u64>, outcome: Option<&str>) -> Session {
        serde_json::from_value(session_wire(idle, outcome)).unwrap()
    }

    fn session_wire(idle: Option<u64>, outcome: Option<&str>) -> Value {
        json!({
            "id":SESSION,"projectID":"project","model":model(),
            "location":{"directory":"/tmp/recovery-fixture"},
            "outcome": outcome, "time":{"created":100,"updated":1400,"busy":1000,"idle": idle}
        })
    }

    fn input() -> Value {
        json!({"id":"msg_User","type":"user","time":{"created":1010},"text":"fixture"})
    }

    fn model_switch() -> Value {
        json!({"id":"msg_Select","type":"model-switched","time":{"created":900},
               "model":{"providerID":"fixture","id":"main"}})
    }

    #[test]
    fn process_death_requires_dirty_clock_and_unfinished_native_user() {
        let mut recent = vec![input(), model_switch()];
        let observed = derive_observation(session(None, None), &recent, None).unwrap();
        assert_eq!(observed.boundary.failure, RecoveryFailure::Interrupted);
        assert_eq!(observed.boundary.turn_id, "msg_User");
        assert_eq!(observed.boundary.input_item_id, "msg_User");
        assert_eq!(observed.boundary.started_at_ms, 1000);
        let initial = derive_observation(session(None, None), &[input()], None).unwrap();
        assert_eq!(initial.boundary, observed.boundary);
        assert!(
            derive_observation(session(Some(900), Some("succeeded")), &[input()], None).is_none()
        );

        recent.insert(
            0,
            json!({
                "id":"msg_Started","type":"assistant","time":{"created":1020,"firstToken":1021},
                "model":model(),"content":[{"type":"text","text":""}]
            }),
        );
        assert!(derive_observation(session(None, None), &recent, None).is_none());
        assert!(
            derive_observation(session(Some(1040), Some("interrupted")), &recent, None).is_none()
        );
    }

    #[test]
    fn interrupted_backend_keeps_the_same_user_boundary_after_recording_an_aborted_step() {
        let aborted = json!({
            "id": "msg_Aborted", "type": "assistant", "finish": "error",
            "error": {"type": "aborted", "message": "Step interrupted"},
            "time": {"created": 1020, "completed": 1030},
            "model": model(), "content": []
        });
        let baseline =
            derive_observation(session(None, None), &[input(), model_switch()], None).unwrap();
        let mut recent = vec![aborted.clone(), input(), model_switch()];
        let observed = derive_observation(session(None, None), &recent, None).unwrap();
        assert_eq!(observed.boundary, baseline.boundary);
        assert!(
            derive_observation(session(Some(1040), Some("interrupted")), &recent, None).is_none()
        );

        for (field, value) in [
            (
                "content",
                json!([{"type": "text", "text": "already streamed"}]),
            ),
            ("snapshot", json!("recorded-action")),
            ("finish", json!("stop")),
            (
                "time",
                json!({"created": 1020, "completed": 1030, "firstToken": 1021}),
            ),
            ("model", json!({"providerID": "fixture", "id": "different"})),
        ] {
            recent[0] = aborted.clone();
            recent[0][field] = value;
            assert!(
                derive_observation(session(None, None), &recent, None).is_none(),
                "{field} must prevent recovery"
            );
        }
    }

    fn failed_history(error: Value) -> Vec<Value> {
        vec![
            json!({"id":"msg_Idle","type":"idle","time":{"created":1040},"outcome":"failed",
                   "error":error}),
            json!({"id":"msg_Failed","type":"assistant","time":{"created":1020,"completed":1035},
                   "finish":"error","model":model(),"error":error,"content":[]}),
            input(),
            model_switch(),
        ]
    }

    #[test]
    fn failed_scoped_synthetic_is_the_next_exact_input() {
        let key = format!("opencode-recovery:{}:primary", "a".repeat(64));
        let id = recovery_id(SESSION, &key).unwrap();
        let mut history = failed_history(json!({"type":"provider.internal","status":503}));
        history[2] = json!({"id":id,"sessionID":SESSION,"type":"synthetic",
            "time":{"created":1010},"text":"continue","description":DESCRIPTION,
            "metadata":{"agentHerderInputId":key,"agentHerderSessionId":SESSION,
                        "agentHerderContinuation":CONTINUATION}});
        let observed =
            derive_observation(session(Some(1040), Some("failed")), &history, None).unwrap();
        assert_eq!(observed.boundary.input_item_id, id);
        assert_eq!(observed.boundary.turn_id, "msg_Failed");
        history[2]["metadata"]["agentHerderSessionId"] = json!("ses_other");
        assert!(derive_observation(session(Some(1040), Some("failed")), &history, None).is_none());
        history[2]["metadata"]["agentHerderSessionId"] = json!(SESSION);
        history[2]["metadata"]["agentHerderContinuation"] = json!("other");
        assert!(derive_observation(session(Some(1040), Some("failed")), &history, None).is_none());
    }

    #[test]
    fn quota_requires_exact_failed_packet_and_matching_history_model() {
        let error = json!({"type":"provider.quota","status":429,"message":"fixture only"});
        let mut recent = failed_history(error);
        let observed =
            derive_observation(session(Some(1040), Some("failed")), &recent, None).unwrap();
        assert_eq!(observed.boundary.failure, RecoveryFailure::Quota);
        assert_eq!(observed.boundary.turn_id, "msg_Failed");
        recent[1]["model"]["id"] = json!("other");
        assert!(derive_observation(session(Some(1040), Some("failed")), &recent, None).is_none());
        recent[1]["model"] = model();
        recent[0]["error"]["type"] = json!("provider.rate-limit");
        assert!(derive_observation(session(Some(1040), Some("failed")), &recent, None).is_none());
    }

    #[test]
    fn paired_terminal_rate_limit_is_retryable_on_the_observed_model() {
        let observe = |recent: &[Value]| {
            derive_observation(session(Some(1040), Some("failed")), recent, None)
        };
        let error = json!({"type":"provider.rate-limit","status":429,"message":"fixture only"});
        let observed = observe(&failed_history(error)).expect("paired native terminal 429");
        assert_eq!(observed.boundary.failure, RecoveryFailure::Retryable);
        assert_eq!(observed.boundary.turn_id, "msg_Failed");
        assert_eq!(observed.boundary.input_item_id, "msg_User");
        assert_eq!(observed.boundary.provider, "fixture");
        assert_eq!(observed.boundary.model.as_deref(), Some("main"));

        for status in [json!(503), json!("429"), Value::Null] {
            let error = json!({"type":"provider.rate-limit","status":status});
            assert!(observe(&failed_history(error)).is_none());
        }
    }

    #[test]
    fn terminal_rate_limit_requires_an_elapsed_and_matching_native_retry_delay() {
        let observe = |recent: &[Value]| {
            derive_observation(session(Some(1040), Some("failed")), recent, None)
        };
        let history = |delay: Value| {
            failed_history(json!({
                "type":"provider.rate-limit","status":429,"retryAfterMs":delay
            }))
        };
        let mut recent = history(json!(1000));
        assert!(observe(&recent).is_some());
        recent[0]["error"]["retryAfterMs"] = json!(0);
        assert!(observe(&recent).is_none());

        let future_delay = u64::MAX - 1040;
        for delay in [
            json!(future_delay),
            json!(u64::MAX),
            json!("1000"),
            json!(-1),
        ] {
            assert!(observe(&history(delay)).is_none());
        }
    }

    #[test]
    fn only_a_matching_native_model_switch_audit_preserves_the_observed_boundary() {
        let mut selected = session(None, None);
        let before =
            derive_observation(session(None, None), &[input(), model_switch()], None).unwrap();
        let target = json!({"providerID":"fixture-two","id":"second"});
        selected.model = read_model(&target);
        let recent = [
            json!({"id":"msg_OwnSwitch","type":"model-switched","time":{"created":1100},
                   "model":target,"previous":model()}),
            input(),
            model_switch(),
        ];
        let after = derive_observation(selected, &recent, Some(&before.model)).unwrap();
        assert_eq!(before.boundary, after.boundary);
        assert_eq!(after.model.id, "second");
    }

    #[test]
    fn native_id_matches_the_legacy_formula_and_ack_is_bound_to_payload() {
        assert_eq!(recovery_id(SESSION, KEY).as_deref(), Some(ID));
        assert!(recovery_id(SESSION, "ordinary-request").is_none());
        let row = json!({
            "id":ID,"sessionID":SESSION,"time":{"created":1600},"type":"synthetic","delivery":"queue",
            "payload":{"text":"fixture","description":DESCRIPTION,
                       "metadata":{"agentHerderInputId":KEY,"agentHerderSessionId":SESSION,
                                   "agentHerderContinuation":CONTINUATION}}
        });
        assert!(inbox_matches(&row, SESSION, ID, KEY, Some("fixture")));
        assert!(!inbox_matches(&row, SESSION, ID, KEY, Some("changed")));
        assert!(!inbox_matches(&row, "ses_Foreign", ID, KEY, None));
    }

    #[derive(Clone, Copy)]
    enum Ack {
        Lost,
        Conflicting,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Projection {
        Pending,
        ForeignNotFound,
        PromoteOnInboxRead,
        Delivered,
    }

    struct RecoveryWire {
        ack: Ack,
        projection: Projection,
        submitted: Option<Value>,
        requests: Vec<(String, String)>,
    }

    impl RecoveryWire {
        fn respond(&mut self, method: &str, path: &str, body: Value) -> Option<(u16, Value)> {
            self.requests.push((method.to_owned(), path.to_owned()));
            if path == "/openapi.json" {
                return Some((
                    200,
                    json!({"openapi":"3.1.0","paths":{
                        "/api/session":{"get":{},"post":{}},"/api/event":{"get":{}}
                    }}),
                ));
            }
            if path == "/api/session/active" {
                return Some((200, json!({"data":{}})));
            }
            let base = session_path(SESSION);
            let payload = match (method, path.strip_prefix(&base)) {
                ("GET", Some("")) => session_wire(None, None),
                ("GET", Some("/form" | "/permission")) => json!([]),
                ("GET", Some(suffix)) if suffix.starts_with("/message?") => json!([input()]),
                ("GET", Some("/inbox")) => match self.projection {
                    Projection::PromoteOnInboxRead => {
                        self.projection = Projection::Delivered;
                        json!([])
                    }
                    Projection::Delivered => json!([]),
                    _ => self
                        .submitted
                        .as_ref()
                        .map_or(json!([]), |row| json!([row])),
                },
                ("GET", Some(suffix)) if suffix == format!("/message/{ID}") => {
                    if let Some(row) = self.submitted.as_ref()
                        && self.projection == Projection::Delivered
                    {
                        json!({"type":"synthetic","id":row["id"],"time":row["time"],
                            "text":row["payload"]["text"],"description":row["payload"]["description"],
                            "metadata":row["payload"]["metadata"]})
                    } else {
                        let session = if self.projection == Projection::ForeignNotFound {
                            "ses_Foreign"
                        } else {
                            SESSION
                        };
                        return Some((
                            404,
                            json!({"_tag":"MessageNotFoundError",
                            "sessionID":session,"messageID":ID}),
                        ));
                    }
                }
                ("POST", Some("/synthetic")) => {
                    assert_eq!(body["resume"], true);
                    let row = json!({
                        "id":body["id"],"sessionID":SESSION,"time":{"created":1600},
                        "type":"synthetic","delivery":body["delivery"],
                        "payload":{"text":body["text"],"description":body["description"],
                            "metadata":body["metadata"]}
                    });
                    assert!(
                        self.submitted.replace(row.clone()).is_none(),
                        "synthetic was replayed"
                    );
                    match self.ack {
                        Ack::Lost => return None,
                        Ack::Conflicting => {
                            let mut conflicting = row;
                            conflicting["payload"]["text"] = json!("different input");
                            conflicting
                        }
                    }
                }
                _ => panic!("unexpected recovery fixture request {method} {path}"),
            };
            Some((200, json!({"data":payload})))
        }
    }

    async fn serve_recovery_wire(stream: TcpStream, state: &Mutex<RecoveryWire>) {
        let mut stream = BufReader::new(stream);
        let mut line = String::new();
        stream.read_line(&mut line).await.unwrap();
        let mut request = line.split_whitespace();
        let (method, path) = (request.next().unwrap(), request.next().unwrap());
        let mut length = 0;
        loop {
            let mut header = String::new();
            stream.read_line(&mut header).await.unwrap();
            if header.trim().is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':')
                && name.eq_ignore_ascii_case("content-length")
            {
                length = value.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        stream.read_exact(&mut body).await.unwrap();
        let body = if body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&body).unwrap()
        };
        let reply = state.lock().unwrap().respond(method, path, body);
        if let Some((status, reply)) = reply {
            let reply = reply.to_string();
            let response = format!(
                "HTTP/1.1 {status} Fixture\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                reply.len()
            );
            stream
                .into_inner()
                .write_all(response.as_bytes())
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn unknown_synthetic_ack_is_reconciled_by_exact_reads_without_replay() {
        for ack in [Ack::Lost, Ack::Conflicting] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let state = Arc::new(Mutex::new(RecoveryWire {
                ack,
                projection: Projection::Pending,
                submitted: None,
                requests: Vec::new(),
            }));
            let server_state = state.clone();
            let server = tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    serve_recovery_wire(stream, &server_state).await;
                }
            });
            let target = SessionAddress {
                instance: InstanceRef {
                    node: NodeRef("loopback".into()),
                    instance_id: "open-code-test".into(),
                },
                native_session_id: SESSION.into(),
            };
            let connection = OpenCodeConnection::open(
                target.instance.clone(),
                &Profile {
                    endpoint: Some(endpoint),
                    runtime_cwd: "/tmp".into(),
                    worktree_root: "/tmp".into(),
                    secret_ref: None,
                },
                None,
            )
            .await
            .unwrap();
            let control = OpenCodeSessionControl::new(connection);
            let key = RequestKey(KEY.into());
            assert_eq!(
                control
                    .recover_recovery_admission(&target, &key)
                    .await
                    .unwrap(),
                None
            );

            let boundary = control
                .read_recovery_boundary(&target)
                .await
                .unwrap()
                .unwrap();
            let route = RecoveryRoute {
                provider: boundary.provider.clone(),
                model: boundary.model.clone(),
            };
            let permit = RecoveryPermit {
                reserve: 50,
                quota_proof: None,
                still_allowed: &|| true,
            };
            assert!(matches!(
                control
                    .submit_recovery(&target, &boundary, &route, permit, "fixture", &key)
                    .await,
                Err(SubmitError::OutcomeUnknown { receipt: None, .. })
            ));
            let exact = format!("{}/message/{ID}", session_path(SESSION));
            let inbox = format!("{}/inbox", session_path(SESSION));
            let query = |path: &str| ("GET".to_owned(), path.to_owned());

            let read_start = {
                let mut wire = state.lock().unwrap();
                wire.projection = Projection::ForeignNotFound;
                wire.requests.len()
            };
            assert!(
                control
                    .recover_recovery_admission(&target, &key)
                    .await
                    .is_err()
            );
            assert_eq!(
                state.lock().unwrap().requests[read_start..],
                [query(&exact)]
            );

            state.lock().unwrap().projection = Projection::Pending;
            let receipt = native_receipt(&target, ID.into());
            assert_eq!(
                control
                    .recover_recovery_admission(&target, &key)
                    .await
                    .unwrap(),
                Some(receipt.clone())
            );
            assert!(!control.reconcile_recovery_receipt(&receipt).await.unwrap());

            let read_start = {
                let mut wire = state.lock().unwrap();
                wire.projection = Projection::PromoteOnInboxRead;
                wire.requests.len()
            };
            assert_eq!(
                control
                    .recover_recovery_admission(&target, &key)
                    .await
                    .unwrap(),
                Some(receipt.clone())
            );
            assert_eq!(
                state.lock().unwrap().requests[read_start..],
                [query(&exact), query(&inbox), query(&exact)]
            );
            assert!(control.reconcile_recovery_receipt(&receipt).await.unwrap());
            let writes: Vec<_> = state
                .lock()
                .unwrap()
                .requests
                .iter()
                .filter(|(method, _)| method != "GET")
                .cloned()
                .collect();
            assert_eq!(
                writes,
                [(
                    "POST".into(),
                    format!("{}/synthetic", session_path(SESSION))
                )]
            );
            server.abort();
        }
    }
}
