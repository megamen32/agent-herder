//! Session-scoped incremental SQLite full-text indexing.
//!
//! The caller supplies the complete searchable text and its `snapshot_id` for
//! one canonical session identity. The snapshot ID is a revision of the
//! complete searchable snapshot, not a native pagination cursor. Equal IDs
//! avoid rewriting an unchanged session; a changed ID replaces only that
//! session's FTS document and saved snapshot ID in the same transaction.

use crate::domain::address::SessionAddress;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

/// Result of applying one session's current source snapshot to the index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexOutcome {
    /// The saved snapshot ID already matched; no FTS or state row changed.
    Unchanged,
    /// Only the specified session's document and snapshot ID were replaced.
    Updated,
}

/// Replace one session's FTS document when its complete snapshot ID changes.
///
/// The store migration must provide an FTS5 table named `session_search_fts`
/// with `session_ref UNINDEXED, content` columns, and a table named
/// `session_search_state` with `session_ref PRIMARY KEY, snapshot_id` columns.
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
    let session_ref = serde_json::to_string(address)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let saved_snapshot = transaction
        .query_row(
            "SELECT snapshot_id FROM session_search_state WHERE session_ref = ?1",
            [&session_ref],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    if saved_snapshot.as_deref() == Some(snapshot_id) {
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
        "INSERT INTO session_search_state (session_ref, snapshot_id) VALUES (?1, ?2) \
         ON CONFLICT(session_ref) DO UPDATE SET snapshot_id = excluded.snapshot_id",
        params![session_ref, snapshot_id],
    )?;
    transaction.commit()?;

    Ok(IndexOutcome::Updated)
}

#[cfg(test)]
mod tests {
    use super::{IndexOutcome, update_session};
    use crate::domain::address::{InstanceRef, NodeRef, SessionAddress};
    use rusqlite::{Connection, OptionalExtension};

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
                     snapshot_id TEXT NOT NULL) STRICT;",
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
            update_session(&mut connection, &first, "snapshot-1", "alpha old").unwrap(),
            IndexOutcome::Updated
        );
        update_session(&mut connection, &second, "snapshot-a", "bravo retained").unwrap();

        assert_eq!(
            update_session(&mut connection, &first, "snapshot-2", "alpha refreshed").unwrap(),
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
        update_session(&mut connection, &session, "snapshot-v1", "initial words").unwrap();

        assert_eq!(
            update_session(&mut connection, &session, "snapshot-v1", "different words").unwrap(),
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
        update_session(&mut connection, &session, "snapshot-1", "before update").unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_search_snapshot BEFORE UPDATE ON session_search_state \
                 BEGIN SELECT RAISE(ABORT, 'snapshot write rejected'); END;",
            )
            .unwrap();

        assert!(update_session(&mut connection, &session, "snapshot-2", "after update").is_err());
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
        assert!(update_session(&mut connection, &incomplete, "snapshot-v1", "text").is_err());

        let session = address("node-a", "profile-2", "native-2");
        assert!(update_session(&mut connection, &session, "", "text").is_err());
        assert_eq!(indexed_content(&connection, &session), None);
        assert_eq!(saved_snapshot(&connection, &session), None);
    }
}
