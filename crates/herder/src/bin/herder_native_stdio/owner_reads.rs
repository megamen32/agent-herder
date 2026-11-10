//! Public read facade over the existing AHAP bridge. No native harness protocol,
//! discovery grants, schema migration, scheduler, or private test route lives here.
//!
//! V1 read contract:
//! - `sessions/list`: only registered principal+instance bindings, optionally
//!   enriched by matching native IDs. `project_ref` is the observed native cwd.
//! - `session/messages|recent`: bounded legacy message tail, `complete:false`;
//!   `session/context`: explicit targets use exact ACL; implicit self requires
//!   a verified binding. Native registrations never imply native root ancestry.
//! - `export/native`: exact `bytes_base64`, `source`, `complete`,
//!   `timestampCoverage`, `limitations`; indexing failure cannot lose the export.
//!   `export/common` explicitly returns `unsupported_format` in V1.
//! - `search`: refreshes up to four authorized raw snapshots through the guarded
//!   authority writer, then queries existing FTS with ACL before count/pagination.
//!   UTF-8/canonical JSON text is capped at 1 MiB with truthful truncation; SHA256
//!   identifies the raw bytes. Native binary bytes remain exportable, not searchable.
//! - `discover/projects`: native inventory restricted to projects observed in
//!   authorized sessions; observed session cwd is the fallback, never config lists.
//! Registry scan is bounded at 256, search results at 50; unsupported cursors are
//! rejected and incomplete coverage is explicit. Provisioner owns v4 migration.
//! Errors carry code, message, expected, correction, effect. Parent owns wiring.
use super::owner_policy::OwnerPolicy;
use base64::{Engine, engine::general_purpose::STANDARD};
use herder::{
    adapters::ahap_opencode::AhapOpenCode,
    application::scoped_stop::{ScopedAuthority, create_prompt::FreshSessionGrantPolicy, registration},
    auth::identity::{Action, Caller, ConnectionIdentity, Grant, PrivateResource},
    domain::{
        adapter::ReadError,
        address::{InstanceRef, SessionAddress, SessionRef},
    },
    mcp::catalog,
    search::index,
    store::Writer,
};
use rmcp::model::CallToolResult;
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, num::NonZeroUsize, os::unix::fs::MetadataExt, sync::Arc};

const CORPUS_LIMIT: usize = 256;
const PAGE_SIZE: usize = 50;
const REFRESH_LIMIT: usize = 4;
const SEARCH_TEXT_LIMIT: usize = 1024 * 1024;
type ReadResult<T> = Result<T, &'static str>;

/// Parent composition calls this before its other request handlers. `None`
/// means this facade does not own the request, never an authorization failure.
pub async fn call(
    identity: &ConnectionIdentity,
    request: &catalog::Request,
    adapter: &Arc<AhapOpenCode>,
    policy: &Arc<OwnerPolicy>,
    instance: &InstanceRef,
) -> Option<CallToolResult> {
    let mut result = handle(identity, request, policy, instance, &|method, params| {
        use herder::application::scoped_stop::BoundedFreshRootCreate;
        if adapter.instance() != instance {
            return Err(ReadError("AHAP instance mismatch".into()));
        }
        adapter.raw_call(method, params)
    });
    if matches!(request, catalog::Request::Session(catalog::Session::Context { .. }))
        && let Some(result) = result.as_mut()
        && result.is_error != Some(true)
        && let Some(value) = result.structured_content.as_mut()
    {
        value["harness"] = json!(registration::BoundedSessionProbe::harness(adapter.as_ref()));
        value["delivery_modes"] = adapter.capabilities().get("deliveryModes").cloned().unwrap_or(Value::Null);
    }
    result
}

fn error(code: &str) -> CallToolResult {
    let (message, expected, correction) = match code {
        "unauthorized" => (
            "Нет доступа к этой сессии или экземпляру.",
            "Проверенный principal и зарегистрированная привязка сессии.",
            "Выберите session_ref из разрешённого списка sessions; native ID не является session_ref.",
        ),
        "unsupported_format" => (
            "Нормализованный Common export пока не реализован.",
            "Для V1 поддержан format=native с исходными байтами и provenance.",
            "Повторите чтение с format=native; сырой transcript не является Common export.",
        ),
        "unsupported_cursor" => (
            "Курсор для этого чтения не поддержан.",
            "Запрос без cursor; полнота и ограничения указаны в результате.",
            "Уберите cursor. Для полного исходного transcript используйте export с format=native.",
        ),
        "invalid_instance" => (
            "Запрошен другой экземпляр.",
            "instance_ref текущего защищённого owner profile.",
            "Выберите точный instance_ref из discovery и подключитесь к его профилю.",
        ),
        "self_binding_required" => (
            "Текущая сессия не привязана к соединению.",
            "Проверенная self-binding от доверенного transport.",
            "Используйте session/messages с разрешённым session_ref или соединение с verified self-binding.",
        ),
        "search_index_unavailable" => (
            "Индекс поиска ещё не подготовлен.",
            "Индекс существующей схемы v4 под pinned authority.",
            "Владелец launcher должен выполнить штатную миграцию v4 под write guard; facade сам схему не меняет.",
        ),
        "index_write_unavailable" => (
            "Не удалось обновить поисковый снимок.",
            "Доступный pinned gate и fenced writer схемы v4 для разрешённой сессии.",
            "Проверьте authority и штатный bootstrap v4; native export остаётся доступен независимо от индекса.",
        ),
        "invalid_query" | "search_unavailable_or_invalid_query" => (
            "Поиск не смог выполнить запрос.",
            "Непустой запрос FTS5 до 4096 байт и доступный индекс.",
            "Проверьте синтаксис FTS5 и состояние индекса выбранного экземпляра.",
        ),
        "scope_unavailable" | "policy_unavailable" => (
            "Не удалось проверить права и привязку хранилища.",
            "Текущие authority generation, pinned gate и защищённый store.",
            "Восстановите штатный owner profile и authority store; не подменяйте session ID и не обходите проверку.",
        ),
        _ => (
            "Адаптер не вернул проверяемый результат чтения.",
            "Корректный ответ объявленного AHAP read method выбранного экземпляра.",
            "Проверьте capabilities и диагностику прежнего TypeScript adapter; отсутствующие данные не считаются полным результатом.",
        ),
    };
    CallToolResult::structured_error(json!({"code":code,"effect":"none","message":message,
        "expected":expected,"correction":correction}))
}

fn handle(
    identity: &ConnectionIdentity,
    request: &catalog::Request,
    policy: &OwnerPolicy,
    instance: &InstanceRef,
    native: &impl Fn(&str, Value) -> Result<Value, ReadError>,
) -> Option<CallToolResult> {
    use catalog::{Discover, Export, ExportFormat, Request, Search, Session, Sessions};
    if !matches!(
        request,
        Request::Sessions(_)
            | Request::Export(_)
            | Request::Search(_)
            | Request::Session(Session::Recent { .. } | Session::Context { .. } | Session::Messages { .. })
            | Request::Discover(Discover::Projects { .. })
    ) {
        return None;
    }
    let Caller::Principal(principal) = identity.caller() else {
        return Some(error("unauthorized"));
    };
    if principal.id != policy.principal || instance != &policy.instance {
        return Some(error("unauthorized"));
    }
    let result: ReadResult<Value> = (|| match request {
        Request::Export(Export::Export {
            session_ref,
            format,
        }) => {
            let address = authorize(identity, policy, instance, &SessionRef(session_ref.clone()))?;
            if *format == ExportFormat::Common {
                // A raw native blob is not a normalized, provenance-bearing transcript.
                return Err("unsupported_format");
            }
            let raw = native("getRawTranscript", json!({"id":address.native_session_id}))
                .map_err(|_| "source_unavailable")?;
            let mut exported = native_export(session_ref, raw.clone())?;
            exported["indexing"] = match ingest(
                identity,
                policy,
                instance,
                &SessionRef(session_ref.clone()),
                &raw,
            ) {
                Ok(truncated) => json!({"status":"indexed","content_truncated":truncated}),
                Err(code) => json!({"status":"not_indexed","code":code}),
            };
            Ok(exported)
        }
        Request::Session(
            Session::Messages {
                session_ref,
                cursor,
            }
            | Session::Recent {
                session_ref,
                cursor,
            },
        ) => {
            let address = authorize(identity, policy, instance, &SessionRef(session_ref.clone()))?;
            if cursor.is_some() {
                return Err("unsupported_cursor");
            }
            let messages = native(
                "getSessionMessages",
                json!({"id":address.native_session_id,"limit":200}),
            )
            .map_err(|_| "source_unavailable")?;
            if !messages.is_array() {
                return Err("invalid_source_response");
            }
            Ok(
                json!({"session_ref":session_ref,"page":{"messages":messages,"next_cursor":null,
                    "complete":false,"limitations":["Показаны последние сообщения. Прежний API не предоставляет курсор для проверки полноты истории."]}}),
            )
        }
        Request::Session(Session::Context { session_ref }) => {
            let session = match session_ref {
                Some(reference) => SessionRef(reference.clone()),
                None => identity.require_self(None).map_err(|_| "self_binding_required")?.clone(),
            };
            let address = authorize(identity, policy, instance, &session)?;
            let db = read_store(policy)?;
            let source = policy.membership_source(&db, &session)
                .map_err(|_| "scope_unavailable")?.ok_or("unauthorized")?;
            let workspace = registration::read_workspace(&db, &session).map_err(|_| "scope_unavailable")?;
            let is_self = identity.require_self(Some(&session)).is_ok();
            let grant = session_read_grant(identity, policy, instance, &session)?;
            let authority = ScopedAuthority::new(policy.db.clone(), policy.gate.clone(), policy.generation.clone())
                .map_err(|_| "scope_unavailable")?;
            let held = authority.human_stop_held(identity, &[grant], &session, instance)
                .map_err(|_| "scope_unavailable")?;
            Ok(json!({"session_ref":session.0,"address":address,
                "instance_ref":instance.instance_id,"node_ref":instance.node.0,
                "principal_ref":principal.id.0,"is_self":is_self,
                "identity_source":if is_self {"verified_connection_binding"} else {"authorized_explicit_session_ref"},
                "workspace":workspace.workspace,"workspace_revision":workspace.revision,
                "workspace_updated_at":workspace.updated_at,"workspace_source":"session_declaration",
                "human_stop":{"held":held},
                "message_target":{"tool":"deliver","action":"session","session_ref":session.0},
                "lineage":{"parent_ref":null,"source":source,
                    "native_ancestry_known":source=="verified_fresh_root_receipt",
                    "parent_verified":source=="verified_fresh_root_receipt"}}))
        }
        Request::Sessions(Sessions::List {
            project_ref,
            node_ref,
            instance_ref,
            cursor,
        }) => {
            if cursor.is_some() {
                return Err("unsupported_cursor");
            }
            if node_ref.as_ref().is_some_and(|v| v != &instance.node.0)
                || instance_ref
                    .as_ref()
                    .is_some_and(|v| v != &instance.instance_id)
            {
                return Err("invalid_instance");
            }
            let corpus = registered(identity, policy, instance)?;
            let observed = observe(&corpus, native)?;
            let authority = ScopedAuthority::new(policy.db.clone(), policy.gate.clone(), policy.generation.clone())
                .map_err(|_| "scope_unavailable")?;
            let db = read_store(policy)?;
            let mut sessions = Vec::with_capacity(corpus.sessions.len());
            for (reference, address) in &corpus.sessions {
                let metadata = observed.get(&address.native_session_id);
                let workspace = registration::read_workspace(&db, reference).map_err(|_| "scope_unavailable")?;
                if project_ref.as_deref().is_some_and(|p| metadata.and_then(project) != Some(p)
                    && !workspace.workspace.as_ref().is_some_and(|w| w.project_ref.as_deref() == Some(p) || w.path == p)) {
                    continue;
                }
                let grant = session_read_grant(identity, policy, instance, reference)?;
                let held = authority.human_stop_held(identity, &[grant], reference, instance)
                    .map_err(|_| "scope_unavailable")?;
                sessions.push(json!({"session_ref":reference.0,"address":address,"native":metadata,
                    "workspace":workspace.workspace,"workspace_revision":workspace.revision,
                    "workspace_updated_at":workspace.updated_at,"workspace_source":"session_declaration",
                    "human_stop":{"held":held},
                    "source":if metadata.is_some(){"registered_and_native"}else{"registered"}}));
            }
            let complete = !corpus.truncated
                && (project_ref.is_none() || observed.len() == corpus.sessions.len());
            Ok(
                json!({"sessions":sessions,"next_cursor":null,"complete":complete,
                "scope":"authorized_registered_sessions","native_coverage_complete":observed.len()==corpus.sessions.len(),
                "limitations":if complete {vec![]} else {vec!["Registry bound or missing native metadata limits coverage."]}}),
            )
        }
        Request::Search(Search::Search {
            query,
            project_ref,
            cursor,
        }) => {
            if query.trim().is_empty() || query.len() > 4096 {
                return Err("invalid_query");
            }
            // Offset-only cursors are not bound to an ACL/snapshot; do not accept them.
            if cursor.is_some() {
                return Err("unsupported_cursor");
            }
            let corpus = registered(identity, policy, instance)?;
            let observed = if project_ref.is_some() {
                observe(&corpus, native)?
            } else {
                BTreeMap::new()
            };
            let allowed_rows: Vec<_> = corpus
                .sessions
                .iter()
                .filter(|(_, a)| {
                    project_ref.as_deref().is_none_or(|p| {
                        observed.get(&a.native_session_id).and_then(project) == Some(p)
                    })
                })
                .collect();
            let db = read_store(policy)?;
            // No implicit migration or claim that the index is a fresh native snapshot.
            let version: i64 = db
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .map_err(|_| "scope_unavailable")?;
            if version != 4 {
                return Err("search_index_unavailable");
            }
            drop(db); // Never retain a read transaction across the guarded index write.
            let mut refreshed = 0usize;
            let mut partial_snapshot = false;
            let mut failures = Vec::new();
            for (session, address) in allowed_rows.iter().take(REFRESH_LIMIT) {
                // Recheck before each exact read, even though enumeration already
                // authorized this immutable binding. No discovery ID is granted.
                let outcome = (|| {
                    let current = authorize(identity, policy, instance, session)?;
                    if &current != address {
                        return Err("scope_unavailable");
                    }
                    let raw = native("getRawTranscript", json!({"id":address.native_session_id}))
                        .map_err(|_| "source_unavailable")?;
                    ingest(identity, policy, instance, session, &raw)
                })();
                match outcome {
                    Ok(truncated) => {
                        refreshed += 1;
                        partial_snapshot |= truncated;
                    }
                    Err(code) => failures.push(json!({"session_ref":session.0,"code":code})),
                }
            }
            let db = read_store(policy)?;
            // Refresh may outlive a membership revocation. Bind the final ACL
            // and exact addresses to THIS read transaction: search_page retains
            // it for both count and excerpts. A second policy/authority open
            // here would observe a different snapshot and restore the race.
            let mut allowed = Vec::new();
            for (session, address) in &allowed_rows {
                if !policy.is_member(&db, session)
                .map_err(|_| "scope_unavailable")?
                {
                    continue;
                }
                let exact: bool = db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM session_bindings WHERE session_ref=?1 AND node_ref=?2 AND instance_id=?3 AND native_session_id=?4)",
                    params![session.0, instance.node.0, instance.instance_id, address.native_session_id],
                    |r| r.get(0),
                ).map_err(|_| "scope_unavailable")?;
                if exact {
                    allowed.push(address.clone());
                }
            }
            let fresh_complete = !corpus.truncated
                && failures.is_empty()
                && refreshed == allowed.len()
                && !partial_snapshot;
            let page = index::search_page(
                &db,
                query,
                &allowed,
                fresh_complete,
                0,
                NonZeroUsize::new(PAGE_SIZE).unwrap(),
            )
            .map_err(|_| "search_unavailable_or_invalid_query")?;
            let hits: Vec<_> =
                page.hits
                    .iter()
                    .filter_map(|hit| {
                        corpus.sessions.iter().find(|(_, a)| a == &hit.session)
                    .map(|(reference, _)| json!({"session_ref":reference.0,"excerpt":hit.excerpt}))
                    })
                    .collect();
            Ok(
                json!({"hits":hits,"total_hits":page.total_hits,"coverage":page.coverage,
                "complete":page.coverage==index::SearchCoverage::Complete && page.next_offset.is_none(),
                "has_more":page.next_offset.is_some(),"next_cursor":null,"source":"existing_session_search_index",
                "authorized_sessions":allowed.len(),"registry_truncated":corpus.truncated,
                "refresh":{"indexed":refreshed,"limit":REFRESH_LIMIT,"failures":failures},
                "limitations":["At most four authorized raw snapshots are refreshed; failed, truncated or remaining snapshots make coverage partial.",
                    "Only the first 50 matches are returned; snapshot-bound pagination is not available."]}),
            )
        }
        Request::Discover(Discover::Projects { instance_ref }) => {
            if instance_ref
                .as_ref()
                .is_some_and(|v| v != &instance.instance_id)
            {
                return Err("invalid_instance");
            }
            let corpus = registered(identity, policy, instance)?;
            let observed = observe(&corpus, native)?;
            let paths: std::collections::BTreeSet<_> =
                observed.values().filter_map(project).collect();
            if paths.is_empty() {
                return Ok(
                    json!({"projects":[],"complete":false,"scope":"authorized_registered_sessions",
                    "limitations":["No native project observed for the authorized registered corpus."]}),
                );
            }
            let inventory = native("listProjects", json!({})).ok();
            let projects = observed_projects(&paths, inventory.as_ref());
            Ok(
                json!({"projects":projects,"complete":false,"scope":"authorized_registered_sessions",
                "limitations":["Only projects observed in authorized registered sessions are exposed; inventory is not globally exhaustive."]}),
            )
        }
        _ => unreachable!("request ownership checked above"),
    })();
    Some(match result {
        Ok(v) => CallToolResult::structured(v),
        Err(code) => error(code),
    })
}

fn authorize(
    identity: &ConnectionIdentity,
    policy: &OwnerPolicy,
    instance: &InstanceRef,
    session: &SessionRef,
) -> ReadResult<SessionAddress> {
    let grant = session_read_grant(identity, policy, instance, session)?;
    let authority = ScopedAuthority::new(
        policy.db.clone(),
        policy.gate.clone(),
        policy.generation.clone(),
    )
    .map_err(|_| "scope_unavailable")?;
    authority
        .resolve_session_read(identity, &[grant], session, instance)
        .map(|(address, _)| address)
        .map_err(|_| "scope_unavailable")
}

fn session_read_grant(
    identity: &ConnectionIdentity,
    policy: &OwnerPolicy,
    instance: &InstanceRef,
    session: &SessionRef,
) -> ReadResult<Grant> {
    let Caller::Principal(principal) = identity.caller() else { return Err("unauthorized") };
    let grant = policy.session_read_grant(&principal.id, instance, session)
        .map_err(|_| "policy_unavailable")?.ok_or("unauthorized")?;
    if grant.principal != principal.id || grant.action != Action::Read
        || grant.resource != PrivateResource::Session(session.clone()) {
        return Err("unauthorized");
    }
    Ok(grant)
}

/// Open a read snapshot only from the pinned, private authoritative store.
/// Its SQL rows are candidates, not grants; every returned binding is resolved
/// again by the existing policy and scoped authority before any native fetch.
fn read_store(policy: &OwnerPolicy) -> ReadResult<Connection> {
    let dm = std::fs::symlink_metadata(&policy.db).map_err(|_| "scope_unavailable")?;
    let gm = std::fs::symlink_metadata(&policy.gate).map_err(|_| "scope_unavailable")?;
    if !dm.is_file()
        || !gm.is_file()
        || dm.nlink() != 1
        || gm.nlink() != 1
        || dm.uid() != gm.uid()
        || dm.mode() & 0o077 != 0
        || gm.mode() & 0o077 != 0
        || policy.db.canonicalize().ok().as_deref() != Some(policy.db.as_path())
        || policy.gate.canonicalize().ok().as_deref() != Some(policy.gate.as_path())
    {
        return Err("scope_unavailable");
    }
    let db = Connection::open_with_flags(&policy.db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "scope_unavailable")?;
    db.execute_batch("BEGIN").map_err(|_| "scope_unavailable")?;
    Writer::validate_scoped_schema(&db).map_err(|_| "scope_unavailable")?;
    let bound: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM humanstop_authority WHERE singleton=1 AND generation=?1 AND gate_device=?2 AND gate_inode=?3 AND database_device=?4 AND database_inode=?5)",
        params![policy.generation, gm.dev() as i64, gm.ino() as i64, dm.dev() as i64, dm.ino() as i64], |r|r.get(0))
        .map_err(|_| "scope_unavailable")?;
    let dn = std::fs::symlink_metadata(&policy.db).map_err(|_| "scope_unavailable")?;
    let gn = std::fs::symlink_metadata(&policy.gate).map_err(|_| "scope_unavailable")?;
    if !bound
        || dn.dev() != dm.dev()
        || dn.ino() != dm.ino()
        || gn.dev() != gm.dev()
        || gn.ino() != gm.ino()
    {
        return Err("scope_unavailable");
    }
    Ok(db)
}

struct Corpus {
    sessions: Vec<(SessionRef, SessionAddress)>,
    truncated: bool,
}
fn registered(
    identity: &ConnectionIdentity,
    policy: &OwnerPolicy,
    instance: &InstanceRef,
) -> ReadResult<Corpus> {
    let db = read_store(policy)?;
    let mut stmt = db.prepare("SELECT b.session_ref,b.native_session_id FROM session_bindings b JOIN lineage l ON l.session_ref=b.session_ref JOIN humanstop_sessions h ON h.session_ref=b.session_ref WHERE l.creator_ref=?1 AND b.node_ref=?2 AND b.instance_id=?3 AND h.authority_generation=?4 ORDER BY b.session_ref LIMIT ?5")
        .map_err(|_| "scope_unavailable")?;
    let candidates = stmt
        .query_map(
            params![
                policy.principal.0,
                instance.node.0,
                instance.instance_id,
                policy.generation,
                (CORPUS_LIMIT + 1) as i64
            ],
            |r| Ok((SessionRef(r.get(0)?), r.get::<_, String>(1)?)),
        )
        .map_err(|_| "scope_unavailable")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "scope_unavailable")?;
    let truncated = candidates.len() > CORPUS_LIMIT;
    let mut sessions = Vec::new();
    for (session, native) in candidates.into_iter().take(CORPUS_LIMIT) {
        if !policy.is_member(&db, &session)
        .map_err(|_| "scope_unavailable")?
        {
            continue;
        }
        let address = authorize(identity, policy, instance, &session)?;
        if address.native_session_id != native {
            return Err("scope_unavailable");
        }
        sessions.push((session, address));
    }
    Ok(Corpus {
        sessions,
        truncated,
    })
}

fn observe(
    corpus: &Corpus,
    native: &impl Fn(&str, Value) -> Result<Value, ReadError>,
) -> ReadResult<BTreeMap<String, Value>> {
    if corpus.sessions.is_empty() {
        return Ok(BTreeMap::new());
    }
    let response = native("listSessions", json!({"options":{"limit":CORPUS_LIMIT}}))
        .map_err(|_| "source_unavailable")?;
    let rows = response.as_array().ok_or("invalid_source_response")?;
    let mut observed = BTreeMap::new();
    for row in rows {
        let Some(id) = row.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !corpus
            .sessions
            .iter()
            .any(|(_, a)| a.native_session_id == id)
        {
            continue;
        }
        if observed.insert(id.to_owned(), row.clone()).is_some() {
            return Err("ambiguous_native_identity");
        }
    }
    Ok(observed)
}

fn project(metadata: &Value) -> Option<&str> {
    metadata
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && !s.chars().any(char::is_control))
}

fn observed_projects(
    paths: &std::collections::BTreeSet<&str>,
    inventory: Option<&Value>,
) -> Vec<Value> {
    paths.iter().map(|path| {
        // Preserve only an exact native project match. The authorized session's
        // observed cwd remains useful when the adapter has no project inventory.
        let native = inventory.and_then(Value::as_array).and_then(|rows| rows.iter().find(|row|
            ["cwd", "path", "worktree"].iter().any(|key| row.get(*key).and_then(Value::as_str)==Some(*path))));
        json!({"project_ref":path,"source":if native.is_some(){"native_project_inventory"}else{"authorized_native_session"},"native":native})
    }).collect()
}

struct SearchSnapshot {
    id: String,
    content: String,
    truncated: bool,
}

/// Decode only adapter-owned bytes. A binary transcript remains exportable but
/// is not indexed as replacement characters or an invented normalized format.
fn search_snapshot(raw: &Value) -> ReadResult<SearchSnapshot> {
    native_export("validation", raw.clone())?;
    let bytes = STANDARD
        .decode(raw["bytes_base64"].as_str().unwrap())
        .map_err(|_| "invalid_source_response")?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "non_utf8_search_source")?;
    // Canonical serialization makes escaped JSON text searchable without
    // requiring a new per-harness transcript decoder. JSONL/plain text stays raw.
    let mut content = match serde_json::from_str::<Value>(text) {
        Ok(value) => serde_json::to_string(&value).map_err(|_| "invalid_source_response")?,
        Err(_) => text.to_owned(),
    };
    let mut truncated = raw["complete"] != true;
    if content.len() > SEARCH_TEXT_LIMIT {
        let mut boundary = SEARCH_TEXT_LIMIT;
        while !content.is_char_boundary(boundary) {
            boundary -= 1;
        }
        content.truncate(boundary);
        truncated = true;
    }
    let digest: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let id = format!("ahap-raw-sha256:{digest}");
    Ok(SearchSnapshot {
        id,
        content,
        truncated,
    })
}

fn ingest(
    identity: &ConnectionIdentity,
    policy: &OwnerPolicy,
    instance: &InstanceRef,
    session: &SessionRef,
    raw: &Value,
) -> ReadResult<bool> {
    let snapshot = search_snapshot(raw)?;
    let Caller::Principal(principal) = identity.caller() else {
        return Err("unauthorized");
    };
    let grant = policy
        .session_read_grant(&principal.id, instance, session)
        .map_err(|_| "policy_unavailable")?
        .ok_or("unauthorized")?;
    let authority = ScopedAuthority::new(
        policy.db.clone(),
        policy.gate.clone(),
        policy.generation.clone(),
    )
    .map_err(|_| "scope_unavailable")?;
    // Only the authority may open a fenced writer. It owns the pinned gate,
    // revalidates the exact binding and rejects v3; this facade never migrates.
    authority
        .index_transcript_snapshot(
            identity,
            &[grant],
            session,
            instance,
            &snapshot.id,
            &snapshot.content,
            snapshot.truncated,
        )
        .map_err(|_| "index_write_unavailable")?;
    Ok(snapshot.truncated)
}

fn native_export(session: &str, raw: Value) -> ReadResult<Value> {
    if raw.is_null() {
        return Err("source_unavailable");
    }
    let encoded = raw
        .get("bytes_base64")
        .and_then(Value::as_str)
        .ok_or("invalid_source_response")?;
    if !valid_base64(encoded)
        || !raw.get("complete").is_some_and(Value::is_boolean)
        || !raw.get("source").is_some_and(|s| {
            ["kind", "location", "format"]
                .iter()
                .all(|k| s.get(*k).is_some_and(Value::is_string))
        })
        || !matches!(
            raw.get("timestampCoverage").and_then(Value::as_str),
            Some("native" | "partial" | "none")
        )
        || raw
            .get("limitations")
            .is_some_and(|v| !v.as_array().is_some_and(|a| a.iter().all(Value::is_string)))
    {
        return Err("invalid_source_response");
    }
    Ok(
        json!({"session_ref":session,"format":"native","encoding":"base64",
        "bytes_base64":raw["bytes_base64"],"complete":raw["complete"],"source":raw["source"],
        "timestampCoverage":raw["timestampCoverage"],"limitations":raw.get("limitations").cloned().unwrap_or(json!([]))}),
    )
}

fn valid_base64(s: &str) -> bool {
    if s.len() % 4 != 0 {
        return false;
    }
    let bytes = s.as_bytes();
    let padding = bytes.iter().rev().take_while(|b| **b == b'=').count();
    if padding > 2 {
        return false;
    }
    let body = &bytes[..bytes.len() - padding];
    if !body
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/')
    {
        return false;
    }
    let value = |b: u8| match b {
        b'A'..=b'Z' => b - b'A',
        b'a'..=b'z' => b - b'a' + 26,
        b'0'..=b'9' => b - b'0' + 52,
        b'+' => 62,
        _ => 63,
    };
    match padding {
        2 => body.last().is_some_and(|b| value(*b) & 15 == 0),
        1 => body.last().is_some_and(|b| value(*b) & 3 == 0),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use herder::{
        application::{
            scoped_stop::{BoundedFreshRootCreate, ScopeGenerationIssuer},
            target::{CreateRequest, CreateResult, RegistryUnavailable, SessionRefIssuer},
            target_gate::acquire_pinned,
        },
        auth::identity::{
            Action, Grant, PrincipalId, PrivateResource, VerifiedPrincipal, VerifiedSelfBinding,
        },
        domain::{adapter::SubmitError, address::NodeRef},
    };
    use rusqlite::functions::FunctionFlags;
    use std::{
        cell::Cell,
        fs,
        os::unix::fs::{OpenOptionsExt, PermissionsExt},
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Fixture {
        root: PathBuf,
        policy: OwnerPolicy,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn identity(name: &str) -> ConnectionIdentity {
        ConnectionIdentity::new(
            Caller::Principal(VerifiedPrincipal {
                id: PrincipalId(name.into()),
            }),
            None,
        )
    }
    struct Creator(SessionAddress);
    impl BoundedFreshRootCreate for Creator {
        fn instance(&self) -> &InstanceRef {
            &self.0.instance
        }
        fn create_root_bounded(&self, _: &str, _: &str) -> Result<SessionAddress, SubmitError> {
            Ok(self.0.clone())
        }
    }
    struct Issuer(String);
    impl SessionRefIssuer for Issuer {
        fn issue(&self) -> Result<SessionRef, RegistryUnavailable> {
            Ok(SessionRef(self.0.clone()))
        }
    }
    impl ScopeGenerationIssuer for Issuer {
        fn issue(&self) -> Result<String, ()> {
            Ok(format!("scope-{}", self.0))
        }
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "herder-owner-reads-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let db = root.join("state.db");
            let gate = root.join("gate");
            drop(Writer::create_file(&db).unwrap());
            let c = Connection::open(&db).unwrap();
            c.create_scalar_function(
                "herder_writer_version",
                0,
                FunctionFlags::SQLITE_UTF8,
                |_| Ok(1),
            )
            .unwrap();
            c.execute_batch(include_str!("../../store/migration_v1_v2.sql"))
                .unwrap();
            c.execute_batch(include_str!("../../store/migration_v2_v3.sql"))
                .unwrap();
            drop(c);
            let file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&gate)
                .unwrap();
            let m = file.metadata().unwrap();
            let guard = acquire_pinned(&gate, m.dev(), m.ino()).unwrap();
            assert!(
                Writer::open_file(&db)
                    .unwrap()
                    .initialize_fresh_stop_authority(&guard, "generation", "now")
                    .unwrap()
            );
            drop(guard);
            Self {
                root,
                policy: OwnerPolicy {
                    existing_sessions: Vec::new(),
                    principal: PrincipalId("alice".into()),
                    harness: "opencode".into(),
                    instance: InstanceRef {
                        node: NodeRef("node".into()),
                        instance_id: "instance".into(),
                    },
                    generation: "generation".into(),
                    db,
                    gate,
                },
            }
        }
        fn create(
            &self,
            principal: &str,
            reference: &str,
            instance: &InstanceRef,
            native: &str,
        ) -> SessionAddress {
            let address = SessionAddress {
                instance: instance.clone(),
                native_session_id: native.into(),
            };
            let authority = ScopedAuthority::new(
                self.policy.db.clone(),
                self.policy.gate.clone(),
                self.policy.generation.clone(),
            )
            .unwrap();
            let grants = [Grant {
                principal: PrincipalId(principal.into()),
                action: Action::Write,
                resource: PrivateResource::Resource(format!(
                    "instance:{}",
                    serde_json::to_string(instance).unwrap()
                )),
            }];
            let issuer = Issuer(reference.into());
            assert_eq!(
                authority
                    .create_fresh_root(
                        &identity(principal),
                        &grants,
                        &Creator(address.clone()),
                        &issuer,
                        &issuer,
                        CreateRequest {
                            intent_id: reference,
                            task_id: reference,
                            request_key: reference,
                            specification: "isolated fixture",
                            now: "now",
                            retain_until: "later"
                        }
                    )
                    .unwrap(),
                CreateResult::Created(SessionRef(reference.into()))
            );
            address
        }
        fn own(&self) -> SessionAddress {
            self.create("alice", "owned", &self.policy.instance, "native-owned")
        }
        fn invoke(
            &self,
            request: catalog::Request,
            native: impl Fn(&str, Value) -> Result<Value, ReadError>,
        ) -> CallToolResult {
            handle(
                &identity("alice"),
                &request,
                &self.policy,
                &self.policy.instance,
                &native,
            )
            .unwrap()
        }
        fn index(&self, documents: &[(SessionAddress, &str)]) {
            let m = fs::metadata(&self.policy.gate).unwrap();
            let guard = acquire_pinned(&self.policy.gate, m.dev(), m.ino()).unwrap();
            Writer::open_file(&self.policy.db)
                .unwrap()
                .migrate_search_v4(&guard)
                .unwrap();
            drop(guard);
            let mut db = Connection::open(&self.policy.db).unwrap();
            db.create_scalar_function(
                "herder_writer_version",
                0,
                FunctionFlags::SQLITE_UTF8,
                |_| Ok(4),
            )
            .unwrap();
            for (address, content) in documents {
                index::update_session(&mut db, address, "snapshot", content, false).unwrap();
            }
        }
    }
    fn payload(result: CallToolResult) -> Value {
        result.structured_content.unwrap()
    }
    fn export(session: &str, format: catalog::ExportFormat) -> catalog::Request {
        catalog::Request::Export(catalog::Export::Export {
            session_ref: session.into(),
            format,
        })
    }
    fn sessions() -> catalog::Request {
        catalog::Request::Sessions(catalog::Sessions::List {
            project_ref: None,
            node_ref: None,
            instance_ref: None,
            cursor: None,
        })
    }
    fn raw() -> Value {
        json!({"bytes_base64":"/wAB","complete":false,
        "source":{"kind":"native-file","location":"opaque/native-source","format":"jsonl"},
        "timestampCoverage":"partial","limitations":["Native source only covers observed events."]})
    }
    fn raw_text(text: &str, complete: bool) -> Value {
        let mut value = raw();
        value["bytes_base64"] = json!(STANDARD.encode(text.as_bytes()));
        value["complete"] = json!(complete);
        value
    }
    fn search(query: &str) -> catalog::Request {
        catalog::Request::Search(catalog::Search::Search {
            query: query.into(),
            project_ref: None,
            cursor: None,
        })
    }
    fn never(_: &str, _: Value) -> Result<Value, ReadError> {
        panic!("native read before authorization")
    }

    #[test]
    fn unregistered_foreign_and_wrong_principal_never_fetch_native() {
        let f = Fixture::new();
        f.own();
        f.create("bob", "foreign", &f.policy.instance, "native-foreign");
        for session in ["native-owned", "arbitrary-native", "foreign"] {
            assert_eq!(
                payload(f.invoke(export(session, catalog::ExportFormat::Native), never))["code"],
                "unauthorized"
            );
        }
        for who in [
            identity("bob"),
            ConnectionIdentity::new(Caller::Unknown, None),
            ConnectionIdentity::new(Caller::NodeCredential, None),
        ] {
            assert_eq!(
                payload(handle(&who, &sessions(), &f.policy, &f.policy.instance, &never).unwrap())
                    ["code"],
                "unauthorized"
            );
        }
        let mut wrong = f.policy.instance.clone();
        wrong.instance_id = "elsewhere".into();
        assert_eq!(
            payload(handle(&identity("alice"), &sessions(), &f.policy, &wrong, &never).unwrap())["code"],
            "unauthorized"
        );
    }
    #[test]
    fn export_preserves_binary_payload_provenance_and_incompleteness() {
        let f = Fixture::new();
        f.own();
        let calls = Cell::new(0);
        let result = payload(f.invoke(
            export("owned", catalog::ExportFormat::Native),
            |method, params| {
                calls.set(calls.get() + 1);
                assert_eq!(method, "getRawTranscript");
                assert_eq!(params, json!({"id":"native-owned"}));
                Ok(raw())
            },
        ));
        assert_eq!(calls.get(), 1);
        for key in [
            "bytes_base64",
            "complete",
            "source",
            "timestampCoverage",
            "limitations",
        ] {
            assert_eq!(result[key], raw()[key]);
        }
        assert_eq!(result["format"], "native");
        assert_eq!(
            payload(f.invoke(export("owned", catalog::ExportFormat::Common), never))["code"],
            "unsupported_format"
        );
    }
    #[test]
    fn sessions_do_not_adopt_native_discovery_and_filter_instance_and_principal() {
        let f = Fixture::new();
        f.own();
        f.create("bob", "foreign", &f.policy.instance, "native-foreign");
        let mut other = f.policy.instance.clone();
        other.node.0 = "other-node".into();
        f.create("alice", "other-node", &other, "native-owned");
        let result = payload(f.invoke(sessions(),|method,_| {
            assert_eq!(method,"listSessions");
            Ok(json!([{"id":"native-owned","cwd":"/allowed","status":"stopped"},{"id":"native-foreign","cwd":"/secret"},{"id":"unregistered","cwd":"/secret"}]))
        }));
        assert_eq!(result["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(result["sessions"][0]["session_ref"], "owned");
        assert_eq!(result["sessions"][0]["human_stop"]["held"], false,
            "native stopped/idle display must not substitute for the durable HumanStop store");
        assert!(!result.to_string().contains("secret"));
        assert_eq!(result["complete"], true);
        assert_eq!(
            payload(f.invoke(export("unregistered", catalog::ExportFormat::Native), never))["code"],
            "unauthorized"
        );
    }

    #[test]
    fn sessions_list_reads_global_session_and_inherited_humanstop_fail_closed() {
        let f = Fixture::new();
        f.own();
        let id = identity("alice");
        let session = SessionRef("owned".into());
        let grant = session_read_grant(&id, &f.policy, &f.policy.instance, &session).unwrap();
        let authority = ScopedAuthority::new(f.policy.db.clone(), f.policy.gate.clone(), f.policy.generation.clone()).unwrap();
        assert!(!authority.human_stop_held(&id, &[grant.clone()], &session, &f.policy.instance).unwrap());

        // Legacy inherited holds are matched through the pinned session scope.
        let db = Connection::open(&f.policy.db).unwrap();
        db.create_scalar_function("herder_writer_version", 0, FunctionFlags::SQLITE_UTF8, |_| Ok(3)).unwrap();
        db.execute("INSERT INTO holds(session_ref,reason,created_at,released_at) VALUES('session:owned','inherited fixture','now',NULL)", []).unwrap();
        drop(db);
        assert!(authority.human_stop_held(&id, &[grant.clone()], &session, &f.policy.instance).unwrap());

        let session_only_address = f.create("alice", "session-only", &f.policy.instance, "native-session-only");
        let session_only = SessionRef("session-only".into());
        let session_only_grant = session_read_grant(&id, &f.policy, &f.policy.instance, &session_only).unwrap();
        let stop_grants = vec![grant.clone(), Grant {
            principal: PrincipalId("alice".into()), action: Action::Write,
            resource: PrivateResource::Resource("humanstop:global".into()),
        }, Grant {
            principal: PrincipalId("alice".into()), action: Action::Write,
            resource: PrivateResource::Session(session.clone()),
        }];
        let mut session_scope_grants = stop_grants.clone();
        session_scope_grants.push(Grant { principal: PrincipalId("alice".into()), action: Action::Write,
            resource: PrivateResource::Session(session_only.clone()) });
        assert_eq!(authority.stop(&id, &session_scope_grants, "session:session-only", "fixture", "now").unwrap(),
            herder::application::scoped_stop::StopDisposition::HeldBeforeHandoff);
        assert!(authority.human_stop_held(&id, &[session_only_grant], &session_only, &f.policy.instance).unwrap());
        assert_eq!(session_only_address.native_session_id, "native-session-only");

        f.create("alice", "global-only", &f.policy.instance, "native-global-only");
        assert_eq!(authority.stop(&id, &stop_grants, "global", "fixture", "now").unwrap(),
            herder::application::scoped_stop::StopDisposition::HeldBeforeHandoff);
        let held_row = payload(f.invoke(sessions(), |_, _| Ok(json!([{"id":"native-owned","status":"idle"}]))));
        assert_eq!(held_row["sessions"][0]["human_stop"]["held"], true);

        let bad_authority = ScopedAuthority::new(f.policy.db.clone(), f.policy.gate.clone(), "stale-generation".into()).unwrap();
        assert!(bad_authority.human_stop_held(&id, &[grant.clone()], &session, &f.policy.instance).is_err(),
            "stale authority must be UNKNOWN/error, never held=false");
        assert!(authority.human_stop_held(&id, &[], &session, &f.policy.instance).is_err(),
            "missing session authorization must fail closed");

    }
    #[test]
    fn stale_generation_and_replaced_gate_fail_closed() {
        let mut f = Fixture::new();
        f.own();
        f.policy.generation = "old-generation".into();
        assert_eq!(
            payload(f.invoke(sessions(), never))["code"],
            "scope_unavailable"
        );
        f.policy.generation = "generation".into();
        fs::rename(&f.policy.gate, f.root.join("old-gate")).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&f.policy.gate)
            .unwrap();
        assert_eq!(
            payload(f.invoke(export("owned", catalog::ExportFormat::Native), never))["code"],
            "unauthorized"
        );
    }
    #[test]
    fn search_filters_before_count_and_reports_partial_even_for_complete_index_rows() {
        let f = Fixture::new();
        let own = f.own();
        let foreign = f.create("bob", "foreign", &f.policy.instance, "native-foreign");
        f.index(&[(own, "needle public"), (foreign, "needle forbiddensecret")]);
        let result = payload(f.invoke(
            catalog::Request::Search(catalog::Search::Search {
                query: "needle".into(),
                project_ref: None,
                cursor: None,
            }),
            |method, params| {
                assert_eq!(method, "getRawTranscript");
                assert_eq!(params["id"], "native-owned");
                Ok(raw_text("needle public", false))
            },
        ));
        assert_eq!(result["total_hits"], 1);
        assert_eq!(result["coverage"], "partial");
        assert_eq!(result["hits"][0]["session_ref"], "owned");
        assert!(!result.to_string().contains("forbiddensecret"));
    }
    #[test]
    fn revoked_during_refresh_cannot_leak_cached_excerpt_or_count() {
        let f = Fixture::new();
        let own = f.own();
        f.index(&[(own, "revokedsecret cached private transcript")]);
        let result = payload(f.invoke(search("revokedsecret"), |method, params| {
            assert_eq!(method, "getRawTranscript");
            assert_eq!(params["id"], "native-owned");
            // Revocation occurs while the native read is in flight. Acquiring
            // the fixture's real gate also proves no gate spans native I/O.
            let m = fs::metadata(&f.policy.gate).unwrap();
            let _guard = acquire_pinned(&f.policy.gate, m.dev(), m.ino()).unwrap();
            let db = Connection::open(&f.policy.db).unwrap();
            db.create_scalar_function(
                "herder_writer_version",
                0,
                FunctionFlags::SQLITE_UTF8,
                |_| Ok(4),
            )
            .unwrap();
            assert_eq!(
                db.execute("DELETE FROM intents WHERE intent_id='owned'", [])
                    .unwrap(),
                1
            );
            Ok(raw_text("revokedsecret fresh private transcript", true))
        }));
        assert_eq!(result["refresh"]["failures"][0]["code"], "unauthorized");
        assert_eq!(
            result["total_hits"], 0,
            "revoked cached counts must not leak: {result}"
        );
        assert_eq!(result["hits"], json!([]));
        assert_eq!(result["authorized_sessions"], 0);
        assert!(!result.to_string().contains("revokedsecret"));
        // The secret still exists in the derived cache; only snapshot-bound
        // authorization may decide whether FTS can expose it.
        let db = read_store(&f.policy).unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM session_search_fts WHERE session_search_fts MATCH 'revokedsecret'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }
    #[test]
    fn search_ingests_fresh_authorized_marker_without_preseeded_index() {
        let f = Fixture::new();
        f.own();
        f.create("bob", "foreign", &f.policy.instance, "native-foreign");
        f.index(&[]);
        let calls = Cell::new(0);
        let result = payload(f.invoke(search("freshneedle"), |method, params| {
            calls.set(calls.get() + 1);
            assert_eq!(method, "getRawTranscript");
            assert_eq!(params["id"], "native-owned");
            Ok(raw_text(r#"{"messages":[{"text":"freshneedle"}]}"#, true))
        }));
        assert_eq!(calls.get(), 1);
        assert_eq!(result["total_hits"], 1);
        assert_eq!(result["hits"][0]["session_ref"], "owned");
        assert_eq!(result["coverage"], "complete");
        assert_eq!(result["refresh"]["indexed"], 1);
    }
    #[test]
    fn export_ingestion_survives_failed_refresh_and_preserves_truncation_in_store() {
        let f = Fixture::new();
        let own = f.own();
        f.index(&[]);
        let exported = payload(
            f.invoke(export("owned", catalog::ExportFormat::Native), |_, _| {
                Ok(raw_text("exportneedle", false))
            }),
        );
        assert_eq!(exported["complete"], false);
        assert_eq!(
            exported["indexing"],
            json!({"status":"indexed","content_truncated":true})
        );
        let db = read_store(&f.policy).unwrap();
        let (truncated,snapshot):(bool,String)=db.query_row("SELECT content_truncated,snapshot_id FROM session_search_state WHERE session_ref=?1",
            [serde_json::to_string(&own).unwrap()],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert!(truncated);
        assert!(snapshot.starts_with("ahap-raw-sha256:"));
        drop(db);
        let result = payload(f.invoke(search("exportneedle"), |_, _| {
            Err(ReadError("offline".into()))
        }));
        assert_eq!(result["total_hits"], 1);
        assert_eq!(result["coverage"], "partial");
        assert_eq!(
            result["refresh"]["failures"][0]["code"],
            "source_unavailable"
        );
    }
    #[test]
    fn wrong_principal_and_instance_neither_fetch_nor_write_index() {
        let f = Fixture::new();
        f.own();
        f.index(&[]);
        let request = export("owned", catalog::ExportFormat::Native);
        let mut wrong = f.policy.instance.clone();
        wrong.instance_id = "other".into();
        for (who, instance) in [
            (identity("bob"), f.policy.instance.clone()),
            (identity("alice"), wrong.clone()),
        ] {
            assert_eq!(
                payload(handle(&who, &request, &f.policy, &instance, &never).unwrap())["code"],
                "unauthorized"
            );
        }
        assert!(
            ingest(
                &identity("bob"),
                &f.policy,
                &f.policy.instance,
                &SessionRef("owned".into()),
                &raw_text("secret", true)
            )
            .is_err()
        );
        assert!(
            ingest(
                &identity("alice"),
                &f.policy,
                &wrong,
                &SessionRef("owned".into()),
                &raw_text("secret", true)
            )
            .is_err()
        );
        let db = read_store(&f.policy).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM session_search_state", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn snapshot_digest_is_stable_and_utf8_truncation_is_truthful() {
        let long = format!("{}é", "x".repeat(SEARCH_TEXT_LIMIT - 1));
        let a = search_snapshot(&raw_text(&long, true)).unwrap();
        assert!(a.truncated);
        assert_eq!(a.content.len(), SEARCH_TEXT_LIMIT - 1);
        assert_eq!(a.id, search_snapshot(&raw_text(&long, true)).unwrap().id);
        assert_ne!(
            a.id,
            search_snapshot(&raw_text("different", true)).unwrap().id
        );
        assert!(
            search_snapshot(&raw_text("observed", false))
                .unwrap()
                .truncated
        );
        assert_eq!(
            search_snapshot(&raw()).err(),
            Some("non_utf8_search_source")
        );
    }
    #[test]
    fn v3_is_not_migrated_by_read_or_export_and_errors_are_actionable() {
        let f = Fixture::new();
        f.own();
        let result = payload(f.invoke(search("marker"), never));
        assert_eq!(result["code"], "search_index_unavailable");
        for key in ["message", "expected", "correction"] {
            assert!(!result[key].as_str().unwrap().is_empty());
        }
        let exported = payload(
            f.invoke(export("owned", catalog::ExportFormat::Native), |_, _| {
                Ok(raw_text("marker", true))
            }),
        );
        assert_eq!(exported["bytes_base64"], STANDARD.encode("marker"));
        assert_eq!(exported["indexing"]["status"], "not_indexed");
        assert_eq!(
            read_store(&f.policy)
                .unwrap()
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
    }
    #[tokio::test]
    async fn public_facade_uses_real_ahap_bridge_and_rejects_mismatched_adapter_before_fetch() {
        use herder::adapters::ahap::{AhapClient, AhapConfig};
        let f = Fixture::new();
        f.own();
        f.index(&[]);
        let script = f.root.join("read_fixture.py");
        fs::write(&script,r#"import json,sys,os,base64
for line in sys.stdin:
 r=json.loads(line); method=r['method']; p=r.get('params',{})
 with open(os.environ['TRACE'],'a') as trace: trace.write(method+'\n')
 if method=='initialize': value={'harness':'opencode','capabilities':{'methods':['getRawTranscript','listSessions','listProjects','getSessionMessages']}}
 elif method=='getRawTranscript':
  assert p['id']=='native-owned'
  value={'bytes_base64':base64.b64encode(b'publicneedle').decode(),'complete':True,'source':{'kind':'native-api','location':'fixture','format':'text'},'timestampCoverage':'none'}
 elif method=='listSessions': value=[{'id':'native-owned','cwd':'/allowed'},{'id':'unregistered','cwd':'/secret'}]
 elif method=='listProjects': value=[{'path':'/allowed','id':'project'},{'path':'/secret','id':'secret'}]
 elif method=='getSessionMessages': value=[{'id':'message','role':'assistant','text':'publicneedle'}]
 else: raise RuntimeError('unexpected method')
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':value}),flush=True)
"#).unwrap();
        let make_adapter = |instance: InstanceRef| {
            let client = AhapClient::open(AhapConfig {
                instance_id: instance.instance_id.clone(),
                harness: "opencode".into(),
                executable: fs::canonicalize("/usr/bin/python3").unwrap(),
                args: vec![script.to_string_lossy().into_owned()],
                cwd: f.root.clone(),
                env: vec![(
                    "TRACE".into(),
                    f.root.join("trace").to_string_lossy().into_owned(),
                )],
                timeout: std::time::Duration::from_secs(3),
            })
            .unwrap();
            Arc::new(
                AhapOpenCode::new(
                    Arc::new(client),
                    instance,
                    f.root.clone(),
                    "read fixture".into(),
                )
                .unwrap(),
            )
        };
        let policy = Arc::new(OwnerPolicy {
            existing_sessions: Vec::new(),
            principal: f.policy.principal.clone(),
            harness: f.policy.harness.clone(),
            instance: f.policy.instance.clone(),
            generation: f.policy.generation.clone(),
            db: f.policy.db.clone(),
            gate: f.policy.gate.clone(),
        });
        let mut other = f.policy.instance.clone();
        other.instance_id = "wrong-adapter".into();
        let wrong = make_adapter(other);
        let result = payload(
            call(
                &identity("alice"),
                &export("owned", catalog::ExportFormat::Native),
                &wrong,
                &policy,
                &policy.instance,
            )
            .await
            .unwrap(),
        );
        assert_eq!(result["code"], "source_unavailable");
        drop(wrong);
        assert!(
            !fs::read_to_string(f.root.join("trace"))
                .unwrap()
                .contains("getRawTranscript")
        );
        assert_eq!(
            read_store(&policy)
                .unwrap()
                .query_row("SELECT count(*) FROM session_search_state", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let adapter = make_adapter(policy.instance.clone());
        let denied = payload(
            call(
                &identity("bob"),
                &export("owned", catalog::ExportFormat::Native),
                &adapter,
                &policy,
                &policy.instance,
            )
            .await
            .unwrap(),
        );
        assert_eq!(denied["code"], "unauthorized");
        let result = payload(
            call(
                &identity("alice"),
                &export("owned", catalog::ExportFormat::Native),
                &adapter,
                &policy,
                &policy.instance,
            )
            .await
            .unwrap(),
        );
        assert_eq!(result["bytes_base64"], STANDARD.encode("publicneedle"));
        assert_eq!(result["indexing"]["status"], "indexed");
        let result = payload(
            call(
                &identity("alice"),
                &search("publicneedle"),
                &adapter,
                &policy,
                &policy.instance,
            )
            .await
            .unwrap(),
        );
        assert_eq!(result["hits"][0]["session_ref"], "owned");
        assert_eq!(result["coverage"], "complete");
        let listed = payload(
            call(
                &identity("alice"),
                &sessions(),
                &adapter,
                &policy,
                &policy.instance,
            )
            .await
            .unwrap(),
        );
        assert_eq!(listed["sessions"].as_array().unwrap().len(), 1);
        let projects = payload(
            call(
                &identity("alice"),
                &catalog::Request::Discover(catalog::Discover::Projects { instance_ref: None }),
                &adapter,
                &policy,
                &policy.instance,
            )
            .await
            .unwrap(),
        );
        assert_eq!(projects["projects"][0]["project_ref"], "/allowed");
        assert!(!projects.to_string().contains("secret"));
        drop(adapter);
        assert_eq!(
            fs::read_to_string(f.root.join("trace"))
                .unwrap()
                .lines()
                .filter(|m| *m == "getRawTranscript")
                .count(),
            2
        );
    }
    #[test]
    fn projects_use_authorized_observation_and_not_config_or_foreign_inventory() {
        let f = Fixture::new();
        let request =
            catalog::Request::Discover(catalog::Discover::Projects { instance_ref: None });
        // Premutation discovery cannot attribute a project to an unregistered
        // session. Its empty receipt must not replace post-registration readback.
        let before = payload(f.invoke(request.clone(), never));
        assert_eq!(before["projects"], json!([]));
        assert_eq!(before["complete"], false);
        f.own();
        f.create("bob", "bob-owned", &f.policy.instance, "native-bob");
        let other_instance = InstanceRef {
            instance_id: "other-instance".into(),
            ..f.policy.instance.clone()
        };
        f.create("alice", "elsewhere", &other_instance, "native-elsewhere");
        for inventory_available in [true, false] {
            let result = payload(f.invoke(request.clone(), |method, params| match method {
                // The existing TS adapter maps OpenCode location.directory to
                // AgentSession.cwd before returning this AHAP response.
                "listSessions" => {
                    assert_eq!(params, json!({"options":{"limit":CORPUS_LIMIT}}));
                    Ok(json!([
                        {"id":"native-owned","harness":"opencode","cwd":"/allowed"},
                        {"id":"native-bob","cwd":"/secret-principal"},
                        {"id":"native-elsewhere","cwd":"/secret-instance"},
                        {"id":"unregistered","cwd":"/secret-unregistered"}
                    ]))
                }
                "listProjects" if inventory_available => Ok(json!([
                    {"worktree":"/allowed","id":"real-project"},
                    {"worktree":"/secret-unregistered","id":"secret-project"}
                ])),
                "listProjects" => Err(ReadError("inventory unavailable".into())),
                _ => panic!("unexpected native operation: {method}"),
            }));
            assert_eq!(result["projects"].as_array().unwrap().len(), 1);
            assert_eq!(result["projects"][0]["project_ref"], "/allowed");
            if inventory_available {
                assert_eq!(result["projects"][0]["source"], "native_project_inventory");
                assert_eq!(result["projects"][0]["native"]["id"], "real-project");
            } else {
                assert_eq!(result["projects"][0]["source"], "authorized_native_session");
                assert_eq!(result["projects"][0]["native"], Value::Null);
            }
            assert!(!result.to_string().contains("secret"));
            assert_eq!(result["complete"], false);
            assert_eq!(result["scope"], "authorized_registered_sessions");
            assert!(result["limitations"].as_array().unwrap().iter().any(|v| {
                v.as_str()
                    .is_some_and(|s| s.contains("not globally exhaustive"))
            }));
        }
    }
    #[test]
    fn context_requires_verified_self_and_only_claims_proven_root_lineage() {
        let f = Fixture::new();
        f.own();
        let request = catalog::Request::Session(catalog::Session::Context { session_ref: None });
        assert_eq!(
            payload(f.invoke(request.clone(), never))["code"],
            "self_binding_required"
        );
        let who = ConnectionIdentity::new(
            identity("alice").caller().clone(),
            Some(VerifiedSelfBinding {
                principal: PrincipalId("alice".into()),
                session: SessionRef("owned".into()),
            }),
        );
        let result =
            payload(handle(&who, &request, &f.policy, &f.policy.instance, &never).unwrap());
        assert_eq!(result["session_ref"], "owned");
        assert_eq!(result["lineage"]["parent_ref"], Value::Null);
    }
    #[test]
    fn incomplete_or_malformed_export_is_not_silently_repaired() {
        for s in ["", "AA==", "AAA=", "/wAB", "YWJj"] {
            assert!(valid_base64(s), "{s}");
        }
        for s in ["A", "A===", "AB==", "AAB=", "AA=A", "====", "éé", "AA\n="] {
            assert!(!valid_base64(s), "{s}");
        }
        let mut bad = raw();
        bad.as_object_mut().unwrap().remove("complete");
        assert_eq!(
            native_export("owned", bad).unwrap_err(),
            "invalid_source_response"
        );
        assert_eq!(
            native_export("owned", Value::Null).unwrap_err(),
            "source_unavailable"
        );
    }
    #[test]
    fn empty_registry_and_unsupported_cursor_never_fetch_native() {
        let f = Fixture::new();
        assert_eq!(payload(f.invoke(sessions(), never))["sessions"], json!([]));
        assert_eq!(
            payload(f.invoke(
                catalog::Request::Discover(catalog::Discover::Projects { instance_ref: None }),
                never
            ))["projects"],
            json!([])
        );
        f.own();
        let request = catalog::Request::Session(catalog::Session::Recent {
            session_ref: "owned".into(),
            cursor: Some("foreign-cursor".into()),
        });
        assert_eq!(
            payload(f.invoke(request, never))["code"],
            "unsupported_cursor"
        );
    }
}
