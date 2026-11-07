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
    database_device INTEGER NOT NULL, database_inode INTEGER NOT NULL,
    created_at TEXT NOT NULL
) STRICT;
CREATE TABLE humanstop_sessions (
    session_ref TEXT PRIMARY KEY REFERENCES session_bindings(session_ref),
    authority_generation TEXT NOT NULL REFERENCES humanstop_authority(generation) CHECK(length(authority_generation) > 0),
    scope_generation TEXT NOT NULL UNIQUE CHECK(length(scope_generation) > 0),
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
CREATE TABLE humanstop_interrupts (
    intent_id TEXT PRIMARY KEY REFERENCES intents(intent_id),
    session_ref TEXT NOT NULL REFERENCES humanstop_sessions(session_ref),
    native_turn_id TEXT NOT NULL CHECK(length(native_turn_id)>0),
    state TEXT NOT NULL CHECK(state IN ('dispatching','acknowledged','unknown')),
    updated_at TEXT NOT NULL,
    UNIQUE(session_ref, native_turn_id)
) STRICT;
-- Durable handoff fence: a crashed or timed-out writer cannot be replayed.
CREATE TABLE humanstop_dispatches (
    intent_id TEXT PRIMARY KEY REFERENCES intents(intent_id),
    scope_generation TEXT NOT NULL REFERENCES humanstop_sessions(scope_generation),
    phase TEXT NOT NULL CHECK(phase IN ('claimed','handing_off','finished','stopped')),
    updated_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER v3_authority_insert_fence BEFORE INSERT ON humanstop_authority WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_authority_no_replace BEFORE INSERT ON humanstop_authority WHEN EXISTS(SELECT 1 FROM humanstop_authority WHERE singleton=NEW.singleton OR generation=NEW.generation) BEGIN SELECT RAISE(ABORT, 'authority already exists'); END;
CREATE TRIGGER v3_authority_update_immutable BEFORE UPDATE ON humanstop_authority BEGIN SELECT RAISE(ABORT, 'authority is immutable'); END;
CREATE TRIGGER v3_authority_delete_immutable BEFORE DELETE ON humanstop_authority BEGIN SELECT RAISE(ABORT, 'authority is immutable'); END;
CREATE TRIGGER v3_session_insert_fence BEFORE INSERT ON humanstop_sessions WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_session_no_replace BEFORE INSERT ON humanstop_sessions WHEN EXISTS(SELECT 1 FROM humanstop_sessions WHERE session_ref=NEW.session_ref OR scope_generation=NEW.scope_generation) BEGIN SELECT RAISE(ABORT, 'session scope already exists'); END;
CREATE TRIGGER v3_session_scope_complete BEFORE INSERT ON humanstop_sessions WHEN NOT EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=NEW.session_ref AND scope_ref='global') OR NOT EXISTS(SELECT 1 FROM humanstop_scopes WHERE session_ref=NEW.session_ref AND scope_ref='session:' || NEW.session_ref) BEGIN SELECT RAISE(ABORT, 'required scopes missing'); END;
CREATE TRIGGER v3_session_update_immutable BEFORE UPDATE ON humanstop_sessions BEGIN SELECT RAISE(ABORT, 'session scope is immutable'); END;
CREATE TRIGGER v3_session_delete_immutable BEFORE DELETE ON humanstop_sessions BEGIN SELECT RAISE(ABORT, 'session scope is immutable'); END;
CREATE TRIGGER v3_scope_insert_fence BEFORE INSERT ON humanstop_scopes WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_scope_after_seal BEFORE INSERT ON humanstop_scopes WHEN EXISTS(SELECT 1 FROM humanstop_sessions WHERE session_ref=NEW.session_ref) BEGIN SELECT RAISE(ABORT, 'scope set is sealed'); END;
CREATE TRIGGER v3_scope_update_immutable BEFORE UPDATE ON humanstop_scopes BEGIN SELECT RAISE(ABORT, 'scope binding is immutable'); END;
CREATE TRIGGER v3_scope_delete_immutable BEFORE DELETE ON humanstop_scopes BEGIN SELECT RAISE(ABORT, 'scope binding is immutable'); END;
CREATE TRIGGER v3_hold_insert_fence BEFORE INSERT ON humanstop_holds WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_hold_update_fence BEFORE UPDATE ON humanstop_holds WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_hold_delete_fence BEFORE DELETE ON humanstop_holds WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_interrupt_insert_fence BEFORE INSERT ON humanstop_interrupts WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_interrupt_update_fence BEFORE UPDATE ON humanstop_interrupts WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_interrupt_delete_forbidden BEFORE DELETE ON humanstop_interrupts BEGIN SELECT RAISE(ABORT, 'interrupt evidence is retained'); END;
CREATE TRIGGER v3_interrupt_no_replace BEFORE INSERT ON humanstop_interrupts WHEN EXISTS(SELECT 1 FROM humanstop_interrupts WHERE intent_id=NEW.intent_id OR (session_ref=NEW.session_ref AND native_turn_id=NEW.native_turn_id)) BEGIN SELECT RAISE(ABORT, 'interrupt already recorded'); END;
CREATE TRIGGER v3_interrupt_monotonic BEFORE UPDATE ON humanstop_interrupts WHEN OLD.intent_id != NEW.intent_id OR OLD.session_ref != NEW.session_ref OR OLD.native_turn_id != NEW.native_turn_id OR OLD.state != 'dispatching' OR NEW.state NOT IN ('acknowledged','unknown') BEGIN SELECT RAISE(ABORT, 'invalid interrupt transition'); END;
CREATE TRIGGER v3_dispatch_insert_fence BEFORE INSERT ON humanstop_dispatches WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_dispatch_update_fence BEFORE UPDATE ON humanstop_dispatches WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version) BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v3_dispatch_delete_forbidden BEFORE DELETE ON humanstop_dispatches BEGIN SELECT RAISE(ABORT, 'dispatch evidence is retained'); END;
CREATE TRIGGER v3_dispatch_no_replace BEFORE INSERT ON humanstop_dispatches WHEN EXISTS(SELECT 1 FROM humanstop_dispatches WHERE intent_id=NEW.intent_id) BEGIN SELECT RAISE(ABORT, 'dispatch already recorded'); END;
CREATE TRIGGER v3_dispatch_monotonic BEFORE UPDATE ON humanstop_dispatches WHEN OLD.intent_id != NEW.intent_id OR OLD.scope_generation != NEW.scope_generation OR NOT ((OLD.phase='claimed' AND NEW.phase IN ('handing_off','stopped')) OR (OLD.phase='handing_off' AND NEW.phase='finished')) BEGIN SELECT RAISE(ABORT, 'invalid dispatch transition'); END;
PRAGMA user_version = 3;
