-- V1 bootstrap. Run on a new database in one exclusive transaction; enable
-- foreign_keys on every connection. Never apply this over an existing database.
-- Every V1 write is fenced by user_version, including already-open connections.
-- Each writer connection registers herder_writer_version() to return its
-- compiled-in supported version. Keep these guards on every migrated table.
-- Missing function or mismatch fails closed, even for already-open writers.
CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY, principal TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT,
    result_json TEXT
) STRICT;
CREATE TABLE intents (
    intent_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
    principal TEXT NOT NULL, target TEXT NOT NULL, request_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN
      ('prepared','dispatching','admitted','confirmed','rejected','unknown')),
    native_receipt TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    retain_until TEXT NOT NULL,
    UNIQUE(principal, target, request_key)
) STRICT;
CREATE TABLE messages (
    message_id TEXT PRIMARY KEY, session_ref TEXT NOT NULL, direction TEXT NOT NULL,
    content_json TEXT NOT NULL, created_at TEXT NOT NULL, native_id TEXT,
    UNIQUE(session_ref, native_id)
) STRICT;
CREATE TABLE holds (
    session_ref TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL,
    released_at TEXT
) STRICT;
CREATE TABLE lineage (
    session_ref TEXT PRIMARY KEY, creator_ref TEXT, parent_ref TEXT,
    sender_ref TEXT, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE settings (
    scope TEXT NOT NULL, setting_key TEXT NOT NULL, value_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0), updated_at TEXT NOT NULL,
    PRIMARY KEY(scope, setting_key)
) STRICT;
-- Task and intent must be inserted and committed together before dispatch.
-- Intent retention is independent of task TTL; do not delete the task while
-- its intent is retained. Deduplication keys outlive client retries.
CREATE TRIGGER v1_guard_tasks_insert BEFORE INSERT ON tasks
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_tasks_update BEFORE UPDATE ON tasks
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_tasks_delete BEFORE DELETE ON tasks
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_intents_insert BEFORE INSERT ON intents
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_intents_update BEFORE UPDATE ON intents
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_intents_delete BEFORE DELETE ON intents
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_messages_insert BEFORE INSERT ON messages
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_messages_update BEFORE UPDATE ON messages
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_messages_delete BEFORE DELETE ON messages
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_holds_insert BEFORE INSERT ON holds
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_holds_update BEFORE UPDATE ON holds
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_holds_delete BEFORE DELETE ON holds
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_lineage_insert BEFORE INSERT ON lineage
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_lineage_update BEFORE UPDATE ON lineage
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_lineage_delete BEFORE DELETE ON lineage
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_settings_insert BEFORE INSERT ON settings
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_settings_update BEFORE UPDATE ON settings
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
CREATE TRIGGER v1_guard_settings_delete BEFORE DELETE ON settings
WHEN herder_writer_version() IS NOT (SELECT user_version FROM pragma_user_version)
BEGIN SELECT RAISE(ABORT, 'unsupported schema version for writer'); END;
PRAGMA user_version = 1;
