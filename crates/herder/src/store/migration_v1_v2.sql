-- Candidate only: caller MUST wrap this entire script in a transaction that
-- rolls back on error. Never auto-run from Writer::open_file.
CREATE TEMP TABLE herder_v1_migration_guard (version INTEGER NOT NULL CHECK(version = 1)) STRICT;
INSERT INTO herder_v1_migration_guard SELECT user_version FROM pragma_user_version;
DROP TABLE herder_v1_migration_guard;

CREATE TABLE session_bindings (
    session_ref TEXT PRIMARY KEY CHECK(length(session_ref) > 0),
    node_ref TEXT NOT NULL CHECK(length(node_ref) > 0),
    instance_id TEXT NOT NULL CHECK(length(instance_id) > 0),
    native_session_id TEXT NOT NULL CHECK(length(native_session_id) > 0),
    UNIQUE(node_ref, instance_id, native_session_id)
) STRICT;
CREATE TRIGGER v2_guard_session_bindings_insert BEFORE INSERT ON session_bindings
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
-- REPLACE can suppress DELETE triggers unless recursive_triggers is enabled.
CREATE TRIGGER v2_no_replace_session_bindings BEFORE INSERT ON session_bindings
WHEN EXISTS (SELECT 1 FROM session_bindings WHERE session_ref = NEW.session_ref)
  OR EXISTS (SELECT 1 FROM session_bindings WHERE node_ref = NEW.node_ref
             AND instance_id = NEW.instance_id AND native_session_id = NEW.native_session_id)
BEGIN SELECT RAISE(ABORT, 'session binding already exists'); END;
CREATE TRIGGER v2_immutable_session_bindings_update BEFORE UPDATE ON session_bindings
BEGIN SELECT RAISE(ABORT, 'session binding is immutable'); END;
CREATE TRIGGER v2_immutable_session_bindings_delete BEFORE DELETE ON session_bindings
BEGIN SELECT RAISE(ABORT, 'session binding is immutable'); END;
PRAGMA user_version = 2;
