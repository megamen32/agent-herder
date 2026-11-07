//! Session-scoped incremental SQLite full-text indexing.
//!
//! The caller supplies the complete searchable text and its `snapshot_id` for
//! one canonical session identity. The snapshot ID is a revision of the
//! complete searchable snapshot, not a native pagination cursor. Equal IDs
//! avoid rewriting an unchanged session; a changed ID replaces only that
//! session's FTS document and saved snapshot ID in the same transaction.

use crate::domain::address::SessionAddress;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use std::num::NonZeroUsize;

/// Result of applying one session's current source snapshot to the index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexOutcome {
    /// The saved snapshot ID already matched; no FTS or state row changed.
    Unchanged,
    /// Only the specified session's document and snapshot ID were replaced.
    Updated,
}

/// Completeness of the ACL-visible indexed corpus for a search page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchCoverage {
    Complete,
    Partial,
}

/// One authorized session match for a browser search feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchHit {
    pub session: SessionAddress,
    pub excerpt: String,
}

/// A bounded page whose hit count and pagination are scoped to the ACL allowlist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchPage {
    pub hits: Vec<SearchHit>,
    /// Exact for complete coverage; a lower bound when coverage is partial.
    pub total_hits: usize,
    pub next_offset: Option<usize>,
    pub coverage: SearchCoverage,
}

/// Replace one session's FTS document when its complete snapshot ID changes.
///
/// The store migration must provide an FTS5 table named `session_search_fts`
/// with `session_ref UNINDEXED, content` columns, and a table named
/// `session_search_state` with `session_ref PRIMARY KEY, snapshot_id, and
/// content_truncated INTEGER CHECK (content_truncated IN (0,1))` columns.
///
/// `address` is serialized as the complete node/instance/native session
/// identity. `snapshot_id` comes from the transcript snapshot and identifies
/// the complete searchable snapshot; it must not be a native pagination
/// cursor. The supplied `content` is the complete searchable text for that
/// snapshot. This function does not enumerate other sessions.
pub fn update_session(
    connection: &mut Connection,
    address: &SessionAddress,
    snapshot_id: &str,
    content: &str,
    content_truncated: bool,
) -> rusqlite::Result<IndexOutcome> {
    if address.instance.node.0.is_empty()
        || address.instance.instance_id.is_empty()
        || address.native_session_id.is_empty()
    {
        return Err(rusqlite::Error::InvalidParameterName(
            "session address must include node, instance, and native session id".into(),
        ));
    }
    if snapshot_id.is_empty() {
        return Err(rusqlite::Error::InvalidParameterName(
            "snapshot_id must not be empty".into(),
        ));
    }
    let session_ref = canonical_session_ref(address)?;

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let saved_state = transaction
        .query_row(
            "SELECT snapshot_id, content_truncated FROM session_search_state WHERE session_ref = ?1",
            [&session_ref],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()?;

    let document_exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_search_fts WHERE session_ref=?1)",
        [&session_ref],
        |row| row.get(0),
    )?;
    if document_exists
        && saved_state.as_ref().is_some_and(|(saved_id, truncated)| {
            saved_id == snapshot_id && *truncated == content_truncated
        })
    {
        transaction.commit()?;
        return Ok(IndexOutcome::Unchanged);
    }

    transaction.execute(
        "DELETE FROM session_search_fts WHERE session_ref = ?1",
        [&session_ref],
    )?;
    transaction.execute(
        "INSERT INTO session_search_fts (session_ref, content) VALUES (?1, ?2)",
        params![session_ref, content],
    )?;
    transaction.execute(
        "INSERT INTO session_search_state (session_ref, snapshot_id, content_truncated) \
         VALUES (?1, ?2, ?3) ON CONFLICT(session_ref) DO UPDATE SET \
         snapshot_id = excluded.snapshot_id, content_truncated = excluded.content_truncated",
        params![session_ref, snapshot_id, content_truncated],
    )?;
    transaction.commit()?;

    Ok(IndexOutcome::Updated)
}

/// Search only sessions already authorized by the caller's ACL decision.
///
/// The allowlist is applied in SQLite before both count and pagination. Source
/// coverage is supplied by the caller; any authorized transcript marked
/// truncated also makes the returned coverage partial.
pub fn search_page(
    connection: &Connection,
    query: &str,
    acl_allowed_sessions: &[SessionAddress],
    source_coverage_complete: bool,
    offset: usize,
    limit: NonZeroUsize,
) -> rusqlite::Result<SearchPage> {
    let allowed_refs = acl_allowed_sessions
        .iter()
        .map(canonical_session_ref)
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let coverage =
        if !source_coverage_complete || has_truncated_allowed_session(connection, &allowed_refs)? {
            SearchCoverage::Partial
        } else {
            SearchCoverage::Complete
        };

    if allowed_refs.is_empty() {
        return Ok(SearchPage {
            hits: Vec::new(),
            total_hits: 0,
            next_offset: None,
            coverage,
        });
    }

    let allowed_json = serde_json::to_string(&allowed_refs)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let total_hits: i64 = connection.query_row(
        "SELECT count(*) FROM session_search_fts \
         WHERE session_search_fts MATCH ?1 \
           AND session_ref IN (SELECT value FROM json_each(?2))",
        params![query, allowed_json],
        |row| row.get(0),
    )?;
    let total_hits = usize::try_from(total_hits).map_err(|_| {
        rusqlite::Error::InvalidParameterName("search hit count is out of range".into())
    })?;
    let sql_limit = i64::try_from(limit.get()).map_err(|_| {
        rusqlite::Error::InvalidParameterName("search limit is out of range".into())
    })?;
    let sql_offset = i64::try_from(offset).map_err(|_| {
        rusqlite::Error::InvalidParameterName("search offset is out of range".into())
    })?;

    let mut statement = connection.prepare(
        "SELECT session_ref, snippet(session_search_fts, 1, '‹', '›', '…', 24) \
         FROM session_search_fts \
         WHERE session_search_fts MATCH ?1 \
           AND session_ref IN (SELECT value FROM json_each(?2)) \
         ORDER BY bm25(session_search_fts), session_ref LIMIT ?3 OFFSET ?4",
    )?;
    let rows = statement.query_map(params![query, allowed_json, sql_limit, sql_offset], |row| {
        let session_ref: String = row.get(0)?;
        let session: SessionAddress = serde_json::from_str(&session_ref).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                session_ref.len(),
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        Ok(SearchHit {
            session,
            excerpt: row.get(1)?,
        })
    })?;
    let hits = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let next_offset = offset
        .checked_add(hits.len())
        .filter(|next| *next < total_hits);

    Ok(SearchPage {
        hits,
        total_hits,
        next_offset,
        coverage,
    })
}

fn canonical_session_ref(address: &SessionAddress) -> rusqlite::Result<String> {
    if address.instance.node.0.is_empty()
        || address.instance.instance_id.is_empty()
        || address.native_session_id.is_empty()
    {
        return Err(rusqlite::Error::InvalidParameterName(
            "session address must include node, instance, and native session id".into(),
        ));
    }
    serde_json::to_string(address)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn has_truncated_allowed_session(
    connection: &Connection,
    allowed_refs: &[String],
) -> rusqlite::Result<bool> {
    if allowed_refs.is_empty() {
        return Ok(false);
    }
    let allowed_json = serde_json::to_string(allowed_refs)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM json_each(?1) AS allowed \
         LEFT JOIN session_search_state AS state ON state.session_ref=allowed.value \
         WHERE state.session_ref IS NULL OR state.content_truncated = 1 \
            OR NOT EXISTS(SELECT 1 FROM session_search_fts AS f WHERE f.session_ref=allowed.value))",
        [allowed_json],
        |row| row.get(0),
    )
}

#[cfg(test)]
mod tests {
    use super::{IndexOutcome, update_session};
    use crate::domain::address::{InstanceRef, NodeRef, SessionAddress};
    use rusqlite::{Connection, OptionalExtension};
    use std::num::NonZeroUsize;

    #[test]
    fn missing_authorized_session_cannot_claim_complete_coverage() {
        let mut connection = connection();
        let missing = address("node", "profile", "not-indexed");
        let page = super::search_page(
            &connection,
            "hello",
            &[missing],
            true,
            0,
            NonZeroUsize::new(10).unwrap(),
        )
        .unwrap();
        assert_eq!(page.coverage, super::SearchCoverage::Partial);
        let indexed = address("node", "profile", "lost-document");
        update_session(&mut connection, &indexed, "v1", "hello", false).unwrap();
        connection
            .execute(
                "DELETE FROM session_search_fts WHERE session_ref=?1",
                [session_ref(&indexed)],
            )
            .unwrap();
        let page = super::search_page(
            &connection,
            "hello",
            &[indexed.clone()],
            true,
            0,
            NonZeroUsize::new(10).unwrap(),
        )
        .unwrap();
        assert_eq!(page.coverage, super::SearchCoverage::Partial);
        assert_eq!(
            update_session(&mut connection, &indexed, "v1", "hello", false).unwrap(),
            IndexOutcome::Updated
        );
        let page = super::search_page(
            &connection,
            "hello",
            &[indexed],
            true,
            0,
            NonZeroUsize::new(10).unwrap(),
        )
        .unwrap();
        assert_eq!(page.coverage, super::SearchCoverage::Complete);
    }

    fn address(node: &str, instance: &str, native: &str) -> SessionAddress {
        SessionAddress {
            instance: InstanceRef {
                node: NodeRef(node.into()),
                instance_id: instance.into(),
            },
            native_session_id: native.into(),
        }
    }

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE VIRTUAL TABLE session_search_fts USING fts5(\
                     session_ref UNINDEXED, content, tokenize='unicode61');\
                 CREATE TABLE session_search_state (\
                     session_ref TEXT PRIMARY KEY NOT NULL,\
                     snapshot_id TEXT NOT NULL,\
                     content_truncated INTEGER NOT NULL CHECK (content_truncated IN (0,1))) STRICT;",
            )
            .unwrap();
        connection
    }

    fn session_ref(address: &SessionAddress) -> String {
        serde_json::to_string(address).unwrap()
    }

    fn indexed_content(connection: &Connection, address: &SessionAddress) -> Option<String> {
        connection
            .query_row(
                "SELECT content FROM session_search_fts WHERE session_ref = ?1",
                [session_ref(address)],
                |row| row.get(0),
            )
            .optional()
            .unwrap()
    }

    fn saved_snapshot(connection: &Connection, address: &SessionAddress) -> Option<String> {
        connection
            .query_row(
                "SELECT snapshot_id FROM session_search_state WHERE session_ref = ?1",
                [session_ref(address)],
                |row| row.get(0),
            )
            .optional()
            .unwrap()
    }

    #[test]
    fn changed_snapshot_replaces_only_its_canonical_session() {
        let mut connection = connection();
        let first = address("node-a", "instance-1", "same-native-id");
        let second = address("node-b", "instance-1", "same-native-id");
        assert_eq!(
            update_session(&mut connection, &first, "snapshot-1", "alpha old", false).unwrap(),
            IndexOutcome::Updated
        );
        update_session(
            &mut connection,
            &second,
            "snapshot-a",
            "bravo retained",
            false,
        )
        .unwrap();

        assert_eq!(
            update_session(
                &mut connection,
                &first,
                "snapshot-2",
                "alpha refreshed",
                false
            )
            .unwrap(),
            IndexOutcome::Updated
        );

        assert_eq!(
            indexed_content(&connection, &first).as_deref(),
            Some("alpha refreshed")
        );
        assert_eq!(
            saved_snapshot(&connection, &first).as_deref(),
            Some("snapshot-2")
        );
        assert_eq!(
            indexed_content(&connection, &second).as_deref(),
            Some("bravo retained")
        );
        assert_eq!(
            saved_snapshot(&connection, &second).as_deref(),
            Some("snapshot-a")
        );
        let old_match: i64 = connection
            .query_row(
                "SELECT count(*) FROM session_search_fts WHERE session_search_fts MATCH 'old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_match, 0);
    }

    #[test]
    fn equal_snapshot_id_skips_reindex_even_if_caller_content_differs() {
        let mut connection = connection();
        let session = address("node-a", "profile-1", "native-1");
        update_session(
            &mut connection,
            &session,
            "snapshot-v1",
            "initial words",
            false,
        )
        .unwrap();

        assert_eq!(
            update_session(
                &mut connection,
                &session,
                "snapshot-v1",
                "different words",
                false
            )
            .unwrap(),
            IndexOutcome::Unchanged
        );
        assert_eq!(
            indexed_content(&connection, &session).as_deref(),
            Some("initial words")
        );
        assert_eq!(
            saved_snapshot(&connection, &session).as_deref(),
            Some("snapshot-v1")
        );
    }

    #[test]
    fn failed_snapshot_write_rolls_back_the_fts_replacement() {
        let mut connection = connection();
        let session = address("node-a", "profile-1", "native-1");
        update_session(
            &mut connection,
            &session,
            "snapshot-1",
            "before update",
            false,
        )
        .unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_search_snapshot BEFORE UPDATE ON session_search_state \
                 BEGIN SELECT RAISE(ABORT, 'snapshot write rejected'); END;",
            )
            .unwrap();

        assert!(
            update_session(
                &mut connection,
                &session,
                "snapshot-2",
                "after update",
                false
            )
            .is_err()
        );
        assert_eq!(
            indexed_content(&connection, &session).as_deref(),
            Some("before update")
        );
        assert_eq!(
            saved_snapshot(&connection, &session).as_deref(),
            Some("snapshot-1")
        );
    }

    #[test]
    fn rejects_incomplete_identity_or_empty_snapshot_before_writing() {
        let mut connection = connection();
        let mut incomplete = address("node-a", "profile-1", "native-1");
        incomplete.instance.instance_id.clear();
        assert!(
            update_session(&mut connection, &incomplete, "snapshot-v1", "text", false).is_err()
        );

        let session = address("node-a", "profile-2", "native-2");
        assert!(update_session(&mut connection, &session, "", "text", false).is_err());
        assert_eq!(indexed_content(&connection, &session), None);
        assert_eq!(saved_snapshot(&connection, &session), None);
    }

    #[test]
    fn search_applies_acl_before_count_limit_and_offset() {
        let mut connection = connection();
        let allowed_a = address("node-a", "instance-1", "session-a");
        let allowed_b = address("node-b", "instance-1", "session-b");
        let hidden = address("node-0-secret", "instance-secret", "hidden-session");
        update_session(&mut connection, &allowed_a, "snap-a", "needle alpha", false).unwrap();
        update_session(&mut connection, &allowed_b, "snap-b", "needle bravo", false).unwrap();
        update_session(
            &mut connection,
            &hidden,
            "snap-hidden",
            "needle needle needle needle needle private",
            false,
        )
        .unwrap();

        let first = super::search_page(
            &connection,
            "needle",
            &[allowed_a.clone(), allowed_b.clone()],
            true,
            0,
            NonZeroUsize::new(1).unwrap(),
        )
        .unwrap();
        assert_eq!(first.total_hits, 2);
        assert_eq!(first.hits.len(), 1);
        assert_eq!(first.next_offset, Some(1));
        assert!([&allowed_a, &allowed_b].contains(&&first.hits[0].session));
        assert_eq!(first.coverage, super::SearchCoverage::Complete);

        let second = super::search_page(
            &connection,
            "needle",
            &[allowed_a.clone(), allowed_b.clone()],
            true,
            1,
            NonZeroUsize::new(1).unwrap(),
        )
        .unwrap();
        assert_eq!(second.total_hits, 2);
        assert_eq!(second.hits.len(), 1);
        assert_eq!(second.next_offset, None);
        assert!([&allowed_a, &allowed_b].contains(&&second.hits[0].session));
        assert_ne!(first.hits[0].session, second.hits[0].session);
    }

    #[test]
    fn coverage_is_partial_for_incomplete_sources_or_truncated_allowed_transcripts() {
        let mut connection = connection();
        let truncated = address("node-a", "instance-1", "truncated-session");
        let complete = address("node-b", "instance-1", "complete-session");
        update_session(
            &mut connection,
            &truncated,
            "snap-truncated",
            "unrelated transcript",
            true,
        )
        .unwrap();
        update_session(
            &mut connection,
            &complete,
            "snap-complete",
            "needle complete",
            false,
        )
        .unwrap();

        let transcript_partial = super::search_page(
            &connection,
            "needle",
            &[truncated.clone(), complete.clone()],
            true,
            0,
            NonZeroUsize::new(5).unwrap(),
        )
        .unwrap();
        assert_eq!(transcript_partial.total_hits, 1);
        assert_eq!(transcript_partial.coverage, super::SearchCoverage::Partial);

        let source_partial = super::search_page(
            &connection,
            "needle",
            &[complete],
            false,
            0,
            NonZeroUsize::new(5).unwrap(),
        )
        .unwrap();
        assert_eq!(source_partial.total_hits, 1);
        assert_eq!(source_partial.coverage, super::SearchCoverage::Partial);
    }

    #[test]
    fn empty_acl_allowlist_returns_no_hits_or_count() {
        let mut connection = connection();
        let hidden = address("node-secret", "instance-secret", "hidden-session");
        update_session(
            &mut connection,
            &hidden,
            "snap-hidden",
            "needle private",
            false,
        )
        .unwrap();

        let page = super::search_page(
            &connection,
            "needle",
            &[],
            true,
            0,
            NonZeroUsize::new(10).unwrap(),
        )
        .unwrap();
        assert!(page.hits.is_empty());
        assert_eq!(page.total_hits, 0);
        assert_eq!(page.next_offset, None);
        assert_eq!(page.coverage, super::SearchCoverage::Complete);
    }
}
