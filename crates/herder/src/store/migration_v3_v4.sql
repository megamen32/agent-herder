-- Candidate only: execute in a transaction on an isolated v3 store.
CREATE TEMP TABLE herder_v3_migration_guard (version INTEGER NOT NULL CHECK(version = 3)) STRICT;
INSERT INTO herder_v3_migration_guard SELECT user_version FROM pragma_user_version;
DROP TABLE herder_v3_migration_guard;
CREATE VIRTUAL TABLE session_search_fts USING fts5(session_ref UNINDEXED, content, tokenize='unicode61');
CREATE TABLE session_search_state (session_ref TEXT PRIMARY KEY NOT NULL, snapshot_id TEXT NOT NULL, content_truncated INTEGER NOT NULL CHECK(content_truncated IN (0,1))) STRICT;
CREATE TRIGGER v4_search_state_insert_fence BEFORE INSERT ON session_search_state WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v4_search_state_update_fence BEFORE UPDATE ON session_search_state WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v4_search_state_delete_fence BEFORE DELETE ON session_search_state WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
PRAGMA user_version = 4;
