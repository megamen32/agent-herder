//! Reads OmniRoute's persisted Codex quota for a previously bound native route.

use chrono::{DateTime, TimeDelta, Utc};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::Value;
use std::{path::Path, time::Duration};

const MAX_AGE: TimeDelta = TimeDelta::minutes(5);
const STANDARD_WINDOWS: [&str; 2] = ["session", "weekly"];
const SPARK_WINDOWS: [&str; 2] = ["gpt_5_3_codex_spark_session", "gpt_5_3_codex_spark_weekly"];

// One SQLite snapshot covers the key policy, the route, and the cache row.
// Keep key-policy checks in the SELECT so duplicate key hashes remain ambiguous.
const QUOTA_SQL: &str = r#"
    SELECT k.is_active = 1 AND k.is_banned = 0 AND k.revoked_at IS NULL
        AND k.model_access_mode = 'restricted'
        AND k.auto_resolve = 0 AND k.forced_model IS NULL
        AND (k.allowed_quotas IS NULL OR
             (json_type(k.allowed_quotas) = 'array' AND json_array_length(k.allowed_quotas) = 0))
        AND (k.blocked_models IS NULL OR (
            json_type(k.blocked_models) = 'array' AND NOT EXISTS (
                SELECT 1 FROM json_each(k.blocked_models) AS blocked
                WHERE blocked.type <> 'text'
                   OR ?4 GLOB trim(blocked.value) OR ?5 GLOB trim(blocked.value)
            )
        ))
        AND NOT EXISTS (
            SELECT 1 FROM combos
            WHERE id = ?4 OR name = ?4 COLLATE NOCASE
        )
        AND NOT EXISTS (
            SELECT 1 FROM model_combo_mappings AS m JOIN combos AS combo ON combo.id = m.combo_id
            WHERE m.enabled = 1 AND ?4 GLOB lower(m.pattern)
        )
        AND NOT EXISTS (
            SELECT 1 FROM reasoning_routing_rules AS r
            WHERE r.enabled = 1 AND r.target_kind IN ('model', 'combo')
              AND (r.scope = 'global' OR r.api_key_id = k.id OR r.connection_id = p.id)
              AND (r.model_pattern IS NULL OR r.model_pattern = ''
                   OR ?4 GLOB lower(r.model_pattern) OR ?5 GLOB lower(r.model_pattern))
        )
        AND NOT EXISTS (
            SELECT 1 FROM key_value AS s
            WHERE s.namespace = 'settings' AND CASE s.key
                WHEN 'stripModelPrefix' THEN json_type(s.value) = 'true'
                WHEN 'taskRouting' THEN json_extract(json_extract(s.value, '$'), '$.enabled') = 1
                WHEN 'webSearchRouteModel' THEN length(trim(json_extract(s.value, '$'))) > 0
                ELSE 0
            END
        ),
        k.expires_at, k.allowed_connections, k.allowed_models, cache.value
    FROM api_keys AS k
    JOIN provider_connections AS p ON p.id = ?3 AND p.provider = ?2 AND p.is_active = 1
    JOIN key_value AS cache ON cache.namespace = 'providerLimitsCache' AND cache.key = p.id
    WHERE k.key_hash = ?1
"#;

/// True means every applicable observed window is above the reserve. False means
/// a verified quota blocks the route. Missing or inconclusive evidence yields None.
pub(super) fn available(
    database: &Path,
    credential_sha256: &str,
    provider: &str,
    connection_id: &str,
    model: &str,
    reserve: u8,
    now: DateTime<Utc>,
) -> Option<bool> {
    if provider != "codex"
        || connection_id.trim().is_empty()
        || reserve > 100
        || credential_sha256.len() != 64
        || !credential_sha256.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    let model_id = codex_model_id(model)?;
    // Codex OAuth serves the versioned GPT family. OmniRoute can reroute other
    // model families and fold reasoning suffixes into an upstream model ID.
    if !model_id
        .strip_prefix("gpt-")
        .and_then(|version| version.as_bytes().first())
        .is_some_and(u8::is_ascii_digit)
        || model_id.rsplit_once('-').is_some_and(|(_, suffix)| {
            matches!(
                suffix,
                "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
            )
        })
    {
        return None;
    }

    let db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    db.busy_timeout(Duration::ZERO).ok()?;
    let alias = format!("cx/{model_id}");
    let (direct, expires_at, accounts, models, cache) = db
        .query_one(
            QUOTA_SQL,
            params![credential_sha256, provider, connection_id, model, alias],
            |row| {
                Ok((
                    row.get::<_, bool>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .ok()?;
    if !direct {
        return None;
    }
    if let Some(expires_at) = expires_at
        && timestamp(&expires_at)? <= now
    {
        return None;
    }
    let accounts: Vec<String> = serde_json::from_str(&accounts).ok()?;
    let models: Vec<String> = serde_json::from_str(&models).ok()?;
    if accounts.as_slice() != [connection_id]
        || !models.iter().any(|allowed| allowed == model)
        || !models
            .iter()
            .all(|allowed| codex_model_id(allowed).is_some())
    {
        return None;
    }

    quota_decision(&serde_json::from_str(&cache).ok()?, model_id, reserve, now)
}

fn codex_model_id(model: &str) -> Option<&str> {
    let id = model.strip_prefix("codex/")?;
    (!id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b)))
    .then_some(id)
}

fn timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

fn quota_decision(cache: &Value, model_id: &str, reserve: u8, now: DateTime<Utc>) -> Option<bool> {
    let fetched_at = timestamp(cache["fetchedAt"].as_str()?)?;
    let source = &cache["source"];
    let model_quotas = &cache["modelQuotas"];
    let quota_groups = &cache["quotaGroups"];
    if fetched_at > now
        || now - fetched_at > MAX_AGE
        || !observed(cache)
        || !cache["rateLimitReachedType"].is_null()
        || !(source.is_null() || matches!(source.as_str(), Some("manual" | "scheduled")))
        || !(model_quotas.is_null() || model_quotas.as_object().is_some_and(|data| data.is_empty()))
        || !(quota_groups.is_null() || quota_groups.as_array().is_some_and(Vec::is_empty))
    {
        return None;
    }

    // OmniRoute maps Spark to a separate quota pool. Reserve and code-review
    // windows are excluded from normal Codex routing quota by the gateway.
    let (windows, limit_flag) = if model_id.contains("spark") || model_id.contains("bengalfox") {
        (SPARK_WINDOWS, "sparkLimitReached")
    } else {
        (STANDARD_WINDOWS, "limitReached")
    };
    let reached = match cache[limit_flag] {
        Value::Null => false,
        Value::Bool(reached) => reached,
        _ => return None,
    };
    let quotas = cache["quotas"].as_object()?;
    if quotas.keys().any(|name| {
        let name = name.as_str();
        !STANDARD_WINDOWS.contains(&name)
            && !SPARK_WINDOWS.contains(&name)
            && !matches!(
                name,
                "reserve_session" | "reserve_weekly" | "code_review" | "code_review_weekly"
            )
    }) {
        return None;
    }

    let mut remaining: Option<f64> = None;
    for window in windows.iter().filter_map(|name| quotas.get(*name)) {
        let percent = remaining_percent(window, now)?;
        remaining = Some(remaining.map_or(percent, |lowest| lowest.min(percent)));
    }
    Some(!reached && remaining? > f64::from(reserve))
}

fn observed(value: &Value) -> bool {
    value.is_object()
        && ["message", "error", "_staleSince"]
            .iter()
            .all(|key| value[*key].is_null())
        // The Codex cache binds accounts by the SQLite key and models by
        // fixed window names. Extra scope labels are outside that contract.
        && ["accountId", "connectionId", "model", "modelId", "modelIds", "scope"]
            .iter()
            .all(|key| value[*key].is_null())
        && ["estimated", "isEstimated", "stale", "_stale", "modelDependent"]
            .iter()
            .all(|key| matches!(value[*key], Value::Null | Value::Bool(false)))
}

fn remaining_percent(window: &Value, now: DateTime<Utc>) -> Option<f64> {
    if !observed(window)
        || !matches!(window["unlimited"], Value::Null | Value::Bool(false))
        || timestamp(window["resetAt"].as_str()?)? <= now
    {
        return None;
    }
    // The Codex usage cache records consumed percentages with a total of 100.
    let used = window["used"].as_f64()?;
    if window["total"].as_f64()? != 100.0 || !(0.0..=100.0).contains(&used) {
        return None;
    }
    let remaining = 100.0 - used;
    if let Some(reported) = window.get("remaining")
        && (reported.as_f64()? - remaining).abs() > 1e-12
    {
        return None;
    }
    Some(remaining)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    const KEY_HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ACCOUNT: &str = "selected-account";
    const FOREIGN: &str = "foreign-account";
    const MODEL: &str = "codex/gpt-5.6-luna";
    const SPARK: &str = "codex/gpt-5.3-codex-spark";
    const NOW: &str = "2026-11-20T10:00:00Z";

    struct Fixture {
        database: PathBuf,
        writer: Option<Connection>,
    }

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let directory = std::env::temp_dir().join(format!(
                "herder-omniroute-quota-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&directory).unwrap();
            let database = directory.join("storage.sqlite");
            let fixture = Self {
                writer: Some(Connection::open(&database).unwrap()),
                database,
            };
            let db = fixture.db();
            db.execute_batch(
                r#"
                PRAGMA journal_mode = WAL;
                CREATE TABLE api_keys (
                    id TEXT PRIMARY KEY, key_hash TEXT, expires_at TEXT, revoked_at TEXT,
                    is_active INTEGER DEFAULT 1, is_banned INTEGER DEFAULT 0, model_access_mode TEXT,
                    allowed_connections TEXT, allowed_models TEXT, blocked_models TEXT,
                    allowed_quotas TEXT, auto_resolve INTEGER DEFAULT 0, forced_model TEXT
                );
                CREATE TABLE provider_connections (id TEXT PRIMARY KEY, provider TEXT, is_active INTEGER);
                CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT, PRIMARY KEY (namespace, key));
                CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT);
                CREATE TABLE model_combo_mappings (combo_id TEXT, pattern TEXT, enabled INTEGER);
                CREATE TABLE reasoning_routing_rules (
                    scope TEXT, api_key_id TEXT, connection_id TEXT, model_pattern TEXT,
                    target_kind TEXT, enabled INTEGER
                );
                "#,
            )
            .unwrap();
            db.execute(
                "INSERT INTO api_keys (id, key_hash, model_access_mode, allowed_connections, allowed_models)
                 VALUES ('key', ?1, 'restricted', ?2, ?3)",
                params![KEY_HASH, json!([ACCOUNT]).to_string(), json!([MODEL, SPARK]).to_string()],
            )
            .unwrap();
            for account in [ACCOUNT, FOREIGN] {
                db.execute(
                    "INSERT INTO provider_connections VALUES (?1, 'codex', 1)",
                    [account],
                )
                .unwrap();
                fixture.store_cache(account, &fresh_cache());
            }
            fixture
        }

        fn db(&self) -> &Connection {
            self.writer.as_ref().unwrap()
        }

        fn store_cache(&self, account: &str, cache: &Value) {
            self.db()
                .execute(
                    "INSERT OR REPLACE INTO key_value VALUES ('providerLimitsCache', ?1, ?2)",
                    params![account, cache.to_string()],
                )
                .unwrap();
        }

        fn check(&self, account: &str, model: &str, reserve: u8) -> Option<bool> {
            available(
                &self.database,
                KEY_HASH,
                "codex",
                account,
                model,
                reserve,
                timestamp(NOW).unwrap(),
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            drop(self.writer.take());
            let _ = fs::remove_dir_all(self.database.parent().unwrap());
        }
    }

    fn window(used: f64) -> Value {
        json!({
            "used": used, "total": 100, "remaining": 100.0 - used,
            "unlimited": false, "resetAt": "2026-11-21T10:00:00Z"
        })
    }

    fn fresh_cache() -> Value {
        json!({
            "fetchedAt": "2026-11-20T09:55:00Z", "source": "manual", "message": null,
            "limitReached": false, "quotas": { "weekly": window(25.5) }
        })
    }

    #[test]
    fn fresh_weekly_cache_at_age_boundary_and_lowest_window() {
        let fixture = Fixture::new();
        assert_eq!(fixture.check(ACCOUNT, MODEL, 74), Some(true));
        assert_eq!(fixture.check(ACCOUNT, MODEL, 75), Some(false));
        let mut cache = fresh_cache();
        cache["quotas"]["session"] = window(50.0);
        fixture.store_cache(ACCOUNT, &cache);
        assert_eq!(fixture.check(ACCOUNT, MODEL, 50), Some(false));
        assert_eq!(fixture.check(ACCOUNT, MODEL, 49), Some(true));
        cache["limitReached"] = json!(true);
        fixture.store_cache(ACCOUNT, &cache);
        assert_eq!(fixture.check(ACCOUNT, MODEL, 49), Some(false));
    }

    #[test]
    fn foreign_cache_and_non_singleton_or_missing_account_allowlists_are_unknown() {
        let fixture = Fixture::new();
        assert_eq!(fixture.check(FOREIGN, MODEL, 50), None);
        for accounts in [
            None,
            Some(json!([])),
            Some(json!([FOREIGN])),
            Some(json!([ACCOUNT, FOREIGN])),
            Some(json!([ACCOUNT, ACCOUNT])),
        ] {
            fixture
                .db()
                .execute(
                    "UPDATE api_keys SET allowed_connections = ?1",
                    [accounts.map(|value| value.to_string())],
                )
                .unwrap();
            assert_eq!(fixture.check(ACCOUNT, MODEL, 50), None);
        }
        fixture
            .db()
            .execute(
                "UPDATE api_keys SET allowed_connections = ?1",
                [json!([ACCOUNT]).to_string()],
            )
            .unwrap();
        fixture
            .db()
            .execute("DELETE FROM key_value WHERE key = ?1", [ACCOUNT])
            .unwrap();
        assert_eq!(fixture.check(ACCOUNT, MODEL, 50), None);
    }

    #[test]
    fn inactive_or_wrong_provider_connection_and_ambiguous_key_are_unknown() {
        let fixture = Fixture::new();
        for (provider, active) in [("openai", 1), ("codex", 0)] {
            fixture
                .db()
                .execute(
                    "UPDATE provider_connections SET provider = ?1, is_active = ?2 WHERE id = ?3",
                    params![provider, active, ACCOUNT],
                )
                .unwrap();
            assert_eq!(fixture.check(ACCOUNT, MODEL, 50), None);
        }
        fixture
            .db()
            .execute(
                "UPDATE provider_connections SET is_active = 1 WHERE id = ?1",
                [ACCOUNT],
            )
            .unwrap();
        fixture
            .db()
            .execute(
                "INSERT INTO api_keys (id, key_hash, is_active) VALUES ('duplicate', ?1, 0)",
                [KEY_HASH],
            )
            .unwrap();
        assert_eq!(fixture.check(ACCOUNT, MODEL, 50), None);
    }

    #[test]
    fn key_must_be_usable_and_cover_the_literal_model() {
        let fixture = Fixture::new();
        for model in [
            "gpt-5.6-luna",
            "codex/gpt-5.6-terra",
            "cx/gpt-5.6-luna",
            "combo/gpt-5.6-luna",
        ] {
            assert_eq!(fixture.check(ACCOUNT, model, 50), None);
        }
        for model in [
            "codex/gpt-5.6-luna-high",
            "codex/deepseek-v4-pro",
            "codex/codex-auto-review",
        ] {
            fixture
                .db()
                .execute(
                    "UPDATE api_keys SET allowed_models = ?1",
                    [json!([model]).to_string()],
                )
                .unwrap();
            assert_eq!(fixture.check(ACCOUNT, model, 50), None);
        }
        fixture
            .db()
            .execute(
                "UPDATE api_keys SET allowed_models = ?1",
                [json!([MODEL, SPARK]).to_string()],
            )
            .unwrap();
        for (reject, restore) in [
            ("is_active = 0", "is_active = 1"),
            ("is_banned = 1", "is_banned = 0"),
            ("revoked_at = '2026-11-19T00:00:00Z'", "revoked_at = NULL"),
            ("expires_at = '2026-11-20T10:00:00Z'", "expires_at = NULL"),
            (
                "model_access_mode = 'all'",
                "model_access_mode = 'restricted'",
            ),
            ("auto_resolve = 1", "auto_resolve = 0"),
            (
                "forced_model = 'codex/gpt-5.6-terra'",
                "forced_model = NULL",
            ),
            (
                "allowed_quotas = '[\"another-bucket\"]'",
                "allowed_quotas = NULL",
            ),
            (
                r#"blocked_models = '["cx/gpt-5.6-*"]'"#,
                "blocked_models = NULL",
            ),
        ] {
            fixture
                .db()
                .execute(&format!("UPDATE api_keys SET {reject}"), [])
                .unwrap();
            assert_eq!(fixture.check(ACCOUNT, MODEL, 50), None, "{reject}");
            fixture
                .db()
                .execute(&format!("UPDATE api_keys SET {restore}"), [])
                .unwrap();
        }
        for models in [None, Some(json!([])), Some(json!([MODEL, "codex/*"]))] {
            fixture
                .db()
                .execute(
                    "UPDATE api_keys SET allowed_models = ?1",
                    [models.map(|value| value.to_string())],
                )
                .unwrap();
            assert_eq!(fixture.check(ACCOUNT, MODEL, 50), None);
        }
    }

    #[test]
    fn literal_combo_collision_and_routing_overrides_are_unknown() {
        let fixture = Fixture::new();
        for (setup, cleanup) in [
            (
                "INSERT INTO combos VALUES ('combo', 'CODEX/GPT-5.6-LUNA')",
                "DELETE FROM combos",
            ),
            (
                "INSERT INTO combos VALUES ('combo', 'other'); INSERT INTO model_combo_mappings VALUES ('combo', 'codex/gpt-5.6-?una', 1)",
                "DELETE FROM model_combo_mappings; DELETE FROM combos",
            ),
            (
                "INSERT INTO reasoning_routing_rules VALUES ('api_key', 'key', NULL, 'codex/*', 'model', 1)",
                "DELETE FROM reasoning_routing_rules",
            ),
            (
                "INSERT INTO key_value VALUES ('settings', 'stripModelPrefix', 'true')",
                "DELETE FROM key_value WHERE namespace = 'settings'",
            ),
        ] {
            fixture.db().execute_batch(setup).unwrap();
            assert_eq!(fixture.check(ACCOUNT, MODEL, 50), None);
            fixture.db().execute_batch(cleanup).unwrap();
        }
        assert_eq!(fixture.check(ACCOUNT, MODEL, 50), Some(true));
        fixture
            .db()
            .execute(
                "INSERT INTO key_value VALUES ('settings', 'taskRouting', ?1)",
                [json!(json!({"enabled": true}).to_string()).to_string()],
            )
            .unwrap();
        assert_eq!(fixture.check(ACCOUNT, MODEL, 50), None);
    }

    #[test]
    fn stale_error_estimated_or_model_dependent_cache_is_unknown() {
        let fixture = Fixture::new();
        for (field, value) in [
            ("fetchedAt", json!("2026-11-20T09:54:59.999Z")),
            ("fetchedAt", json!("2026-11-20T10:00:00.001Z")),
            ("fetchedAt", Value::Null),
            ("_stale", json!(true)),
            ("source", json!("estimated")),
            ("message", json!("request failed")),
            ("connectionId", json!(FOREIGN)),
            ("modelId", json!(SPARK)),
            (
                "modelQuotas",
                json!({"other-model": {"weekly": window(5.0)}}),
            ),
            ("quotaGroups", json!([{"model": "other-model"}])),
        ] {
            let mut cache = fresh_cache();
            cache[field] = value;
            fixture.store_cache(ACCOUNT, &cache);
            assert_eq!(fixture.check(ACCOUNT, MODEL, 50), None, "{field}");
        }
    }

    #[test]
    fn numeric_windows_must_be_observed_and_current() {
        let fixture = Fixture::new();
        for (field, value) in [
            ("used", json!("20")),
            ("total", json!(0)),
            ("remaining", json!(100)),
            ("unlimited", json!(true)),
            ("estimated", json!(true)),
            ("resetAt", json!(NOW)),
        ] {
            let mut cache = fresh_cache();
            cache["quotas"]["weekly"][field] = value;
            fixture.store_cache(ACCOUNT, &cache);
            assert_eq!(fixture.check(ACCOUNT, MODEL, 50), None, "{field}");
        }
    }

    #[test]
    fn spark_requires_its_own_window() {
        let fixture = Fixture::new();
        assert_eq!(fixture.check(ACCOUNT, SPARK, 50), None);
        let mut cache = fresh_cache();
        cache["quotas"][SPARK_WINDOWS[1]] = window(70.0);
        fixture.store_cache(ACCOUNT, &cache);
        assert_eq!(fixture.check(ACCOUNT, SPARK, 50), Some(false));
        assert_eq!(fixture.check(ACCOUNT, MODEL, 50), Some(true));
    }
}
