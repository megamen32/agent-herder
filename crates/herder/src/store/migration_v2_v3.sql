-- Candidate only: execute inside an explicit transaction on an isolated store.
-- This script is never applied by Writer::open_file.
CREATE TEMP TABLE herder_v2_migration_guard (version INTEGER NOT NULL CHECK(version = 2)) STRICT;
INSERT INTO herder_v2_migration_guard SELECT user_version FROM pragma_user_version;
DROP TABLE herder_v2_migration_guard;

-- A single permanently pinned gate serializes all scopes in this authority.
CREATE TABLE humanstop_authority (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    generation TEXT NOT NULL UNIQUE CHECK(length(generation) > 0),
    gate_device INTEGER NOT NULL, gate_inode INTEGER NOT NULL,
    created_at TEXT NOT NULL
) STRICT;
CREATE TABLE humanstop_sessions (
    session_ref TEXT PRIMARY KEY REFERENCES session_bindings(session_ref),
    generation TEXT NOT NULL REFERENCES humanstop_authority(generation) CHECK(length(generation) > 0),
    created_at TEXT NOT NULL
) STRICT;
CREATE TABLE humanstop_scopes (
    session_ref TEXT NOT NULL REFERENCES humanstop_sessions(session_ref) DEFERRABLE INITIALLY DEFERRED,
    scope_ref TEXT NOT NULL CHECK(length(scope_ref) > 0),
    PRIMARY KEY(session_ref, scope_ref)
) STRICT;
CREATE TABLE humanstop_holds (
    scope_ref TEXT PRIMARY KEY CHECK(length(scope_ref) > 0),
    reason TEXT NOT NULL, created_at TEXT NOT NULL, released_at TEXT
) STRICT;
CREATE TRIGGER v3_authority_insert_fence BEFORE INSERT ON humanstop_authority WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_authority_no_replace BEFORE INSERT ON humanstop_authority WHEN EXISTS(SELECT 1 FROM humanstop_authority WHERE singleton=NEW.singleton OR generation=NEW.generation) BEGIN SELECT RAISE(ABORT, 'authority already exists'); END;
CREATE TRIGGER v3_authority_update_immutable BEFORE UPDATE ON humanstop_authority BEGIN SELECT RAISE(ABORT, 'authority is immutable'); END;
CREATE TRIGGER v3_authority_delete_immutable BEFORE DELETE ON humanstop_authority BEGIN SELECT RAISE(ABORT, 'authority is immutable'); END;
CREATE TRIGGER v3_session_insert_fence BEFORE INSERT ON humanstop_sessions WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_session_no_replace BEFORE INSERT ON humanstop_sessions WHEN EXISTS(SELECT 1 FROM humanstop_sessions WHERE session_ref=NEW.session_ref) BEGIN SELECT RAISE(ABORT, 'session scope already exists'); END;
CREATE TRIGGER v3_session_update_immutable BEFORE UPDATE ON humanstop_sessions BEGIN SELECT RAISE(ABORT, 'session scope is immutable'); END;
CREATE TRIGGER v3_session_delete_immutable BEFORE DELETE ON humanstop_sessions BEGIN SELECT RAISE(ABORT, 'session scope is immutable'); END;
CREATE TRIGGER v3_scope_insert_fence BEFORE INSERT ON humanstop_scopes WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_scope_after_seal BEFORE INSERT ON humanstop_scopes WHEN EXISTS(SELECT 1 FROM humanstop_sessions WHERE session_ref=NEW.session_ref) BEGIN SELECT RAISE(ABORT, 'scope set is sealed'); END;
CREATE TRIGGER v3_scope_update_immutable BEFORE UPDATE ON humanstop_scopes BEGIN SELECT RAISE(ABORT, 'scope binding is immutable'); END;
CREATE TRIGGER v3_scope_delete_immutable BEFORE DELETE ON humanstop_scopes BEGIN SELECT RAISE(ABORT, 'scope binding is immutable'); END;
CREATE TRIGGER v3_hold_insert_fence BEFORE INSERT ON humanstop_holds WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_hold_update_fence BEFORE UPDATE ON humanstop_holds WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_hold_delete_fence BEFORE DELETE ON humanstop_holds WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
PRAGMA user_version = 3;
