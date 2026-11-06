"""WAL/FULLの保存とvolumeの単一owner。重要記録を自動削除しない。"""

import fcntl
import hashlib
import json
import os
import sqlite3


class JournalError(Exception):
    pass


class Journal:
    def __init__(self, config):
        self.config = config
        self.lock = None
        self.db = None
        try:
            config.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.lock = os.open(config.state_dir / "owner.lock",
                                os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            path = config.state_dir / "bridge.sqlite3"
            existed = path.exists()
            if path.is_symlink():
                raise JournalError()
            self.db = sqlite3.connect(path, timeout=1)
            os.chmod(path, 0o600)
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            if self.db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise JournalError()
            version = self.db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1) or (existed and version == 0):
                raise JournalError()
            with self.db:
                self.db.execute("CREATE TABLE IF NOT EXISTS identity (device TEXT NOT NULL)")
                row = self.db.execute("SELECT device FROM identity").fetchone()
                if row and row[0] != config.device_id:
                    raise JournalError()
                if not row:
                    self.db.execute("INSERT INTO identity VALUES (?)", (config.device_id,))
                self.db.execute("CREATE TABLE IF NOT EXISTS inbox "
                                "(hash TEXT PRIMARY KEY, topic TEXT, body BLOB, reason TEXT)")
                self.db.execute("CREATE TABLE IF NOT EXISTS lifecycle "
                                "(id INTEGER PRIMARY KEY, body TEXT)")
                self.db.execute("CREATE TABLE IF NOT EXISTS status_outbox "
                                "(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT)")
                self.db.execute("PRAGMA user_version=1")
        except (OSError, sqlite3.Error, JournalError):
            self.close()
            raise JournalError("JOURNAL_UNAVAILABLE") from None

    def capacity(self, size):
        rows, total = self.db.execute(
            "SELECT (SELECT count(*) FROM inbox)+(SELECT count(*) FROM lifecycle),"
            "coalesce((SELECT sum(length(body)) FROM inbox),0)+"
            "coalesce((SELECT sum(length(body)) FROM lifecycle),0)"
        ).fetchone()
        if rows >= self.config.record_limit or total + size > self.config.byte_limit:
            raise JournalError("JOURNAL_FULL")

    def receive(self, topic, body):
        digest = hashlib.sha256(topic.encode() + b"\0" + body).hexdigest()
        with self.db:
            if not self.db.execute("SELECT 1 FROM inbox WHERE hash=?", (digest,)).fetchone():
                self.capacity(len(body))
                self.db.execute("INSERT INTO inbox VALUES (?,?,?,?)",
                                (digest, topic, body, "OPERATIONS_NOT_IMPLEMENTED"))

    def record(self, state):
        body = json.dumps(state, sort_keys=True)
        with self.db:
            self.capacity(len(body.encode()))
            self.db.execute("INSERT INTO lifecycle(body) VALUES (?)", (body,))

    def status(self, message):
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO status_outbox VALUES (1,?)",
                            (json.dumps(message, separators=(",", ":")),))

    def pending_status(self):
        row = self.db.execute("SELECT body FROM status_outbox WHERE id=1").fetchone()
        return row[0] if row else None

    def status_sent(self, body):
        with self.db:
            self.db.execute("DELETE FROM status_outbox WHERE body=?", (body,))

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None
