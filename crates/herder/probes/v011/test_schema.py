#!/usr/bin/env python3
"""Isolated SQLite contract probe; no runtime database or network access."""
import sqlite3
import tempfile
import unittest
from pathlib import Path

SCHEMA = (Path(__file__).resolve().parents[2] / 'src/store/schema.sql').read_text()


def writer(path, version):
    db = sqlite3.connect(path, isolation_level=None)
    db.execute('PRAGMA foreign_keys = ON')
    if version is not None:
        db.create_function('herder_writer_version', 0, lambda: version, deterministic=True)
    return db


class Contract(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'isolated.sqlite'
        self.db = writer(self.path, 1)
        self.db.executescript('BEGIN EXCLUSIVE;\n' + SCHEMA + '\nCOMMIT;')

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def task(self, db, name='t'):
        db.execute("INSERT INTO tasks(task_id,principal,status,created_at,updated_at) VALUES(?, 'p','working','now','now')", (name,))

    def intent(self, db, name='i', task='t', key='key'):
        db.execute("INSERT INTO intents VALUES(?,?,'p','target',?,'hash','prepared',NULL,'now','now','later')", (name, task, key))

    def test_rollback_and_durable_dedup(self):
        self.db.execute('BEGIN IMMEDIATE')
        self.task(self.db)
        self.intent(self.db)
        # Simulate failure between preparing task/intent and the commit.
        with self.assertRaises(sqlite3.IntegrityError):
            self.intent(self.db, 'duplicate', 't', 'another-key')
        self.db.execute('ROLLBACK')
        self.assertEqual(self.db.execute('SELECT count(*) FROM tasks').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM intents').fetchone()[0], 0)
        self.db.execute('BEGIN IMMEDIATE')
        self.task(self.db)
        self.intent(self.db)
        self.db.execute('COMMIT')
        self.db.execute('BEGIN IMMEDIATE')
        self.task(self.db, 't2')
        with self.assertRaises(sqlite3.IntegrityError):
            self.intent(self.db, 'i2', 't2')
        self.db.execute('ROLLBACK')
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM tasks WHERE task_id='t'")
        self.assertEqual(self.db.execute('SELECT count(*) FROM intents').fetchone()[0], 1)

    def test_upgrade_fences_existing_and_new_old_writers(self):
        self.task(self.db)
        newer = writer(self.path, 2)
        try:
            newer.execute('BEGIN EXCLUSIVE')
            newer.execute('PRAGMA user_version = 2')
            newer.execute('COMMIT')
            for old in (self.db, writer(self.path, 1), writer(self.path, None)):
                try:
                    for statement in (
                        "UPDATE tasks SET status='broken' WHERE task_id='t'",
                        "DELETE FROM tasks WHERE task_id='t'",
                        "INSERT INTO tasks VALUES('bad','p','working','now','now',NULL,NULL)",
                    ):
                        with self.assertRaises(sqlite3.Error):
                            old.execute(statement)
                finally:
                    if old is not self.db:
                        old.close()
            self.assertEqual(newer.execute("SELECT status FROM tasks WHERE task_id='t'").fetchone()[0], 'working')
            newer.execute("UPDATE tasks SET status='done' WHERE task_id='t'")
            self.assertEqual(newer.execute("SELECT status FROM tasks WHERE task_id='t'").fetchone()[0], 'done')
        finally:
            newer.close()

    def test_aborted_migration_preserves_version_and_old_writer(self):
        self.db.execute('BEGIN EXCLUSIVE')
        self.db.execute('CREATE TABLE migration_partial (id INTEGER)')
        self.db.execute('PRAGMA user_version = 2')
        self.db.execute('ROLLBACK')
        self.assertIsNone(self.db.execute("SELECT name FROM sqlite_master WHERE name='migration_partial'").fetchone())
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0], 1)
        self.task(self.db)

if __name__ == '__main__':
    unittest.main(verbosity=2)
