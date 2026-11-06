"""WAL/FULLの保存とvolumeの単一owner。重要記録を自動削除しない。"""

import fcntl
import hashlib
import json
import os
import sqlite3
import uuid

import fastjsonschema
from pathlib import Path

from .observations import utc
from fleet_reference.configuration import digest, canonical


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
            if version not in (0, 1, 2, 3) or (existed and version == 0):
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
                self.db.execute("CREATE TABLE IF NOT EXISTS telemetry_outbox "
                                "(id INTEGER PRIMARY KEY, session TEXT, "
                                "sequence INTEGER, body TEXT)")
                self.db.execute("CREATE TABLE IF NOT EXISTS telemetry_loss "
                                "(id INTEGER PRIMARY KEY CHECK(id=1), count INTEGER NOT NULL)")
                self.db.execute("CREATE TABLE IF NOT EXISTS bridge_counters "
                                "(id INTEGER PRIMARY KEY CHECK(id=1), journal TEXT NOT NULL, "
                                "configuration TEXT, revision INTEGER, sequence INTEGER)")
                self.db.execute("INSERT OR IGNORE INTO bridge_counters VALUES (1,?,NULL,0,0)",
                                (str(uuid.uuid4()),))
                self.db.execute("CREATE TABLE IF NOT EXISTS bridge_outbox "
                                "(id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT UNIQUE, "
                                "hash TEXT, body TEXT)")
                self.db.execute("PRAGMA user_version=3")
            self.session = str(uuid.uuid4())
            self.sequence = 0
            contracts = Path("/workspace/contracts")
            self.validate_observation = fastjsonschema.compile(json.loads(
                (contracts / "ros-observation.schema.json").read_text()), use_default=False)
            self.validate_receipt = fastjsonschema.compile(json.loads(
                (contracts / "telemetry-receipt.schema.json").read_text()), use_default=False)
            self.validate_bridge = fastjsonschema.compile(json.loads(
                (contracts / "bridge-event.schema.json").read_text()), use_default=False)
            self.validate_bridge_receipt = fastjsonschema.compile(json.loads(
                (contracts / "bridge-receipt.schema.json").read_text()), use_default=False)
        except (OSError, sqlite3.Error, JournalError):
            self.close()
            raise JournalError("JOURNAL_UNAVAILABLE") from None

    def capacity(self, size):
        rows, total = self.db.execute(
            "SELECT (SELECT count(*) FROM inbox)+(SELECT count(*) FROM lifecycle)+"
            "(SELECT count(*) FROM bridge_outbox),"
            "coalesce((SELECT sum(length(body)) FROM inbox),0)+"
            "coalesce((SELECT sum(length(body)) FROM lifecycle),0)+"
            "coalesce((SELECT sum(length(CAST(body AS BLOB))) FROM bridge_outbox),0)"
        ).fetchone()
        if rows >= self.config.record_limit or total + size > self.config.byte_limit:
            raise JournalError("JOURNAL_FULL")

    def receive(self, topic, body):
        if topic == f"fleet/v1/devices/{self.config.device_id}/bridge-receipts":
            try:
                receipt = json.loads(body)
                self.validate_bridge_receipt(receipt)
                if receipt["deviceId"] != self.config.device_id:
                    return
            except (ValueError, fastjsonschema.JsonSchemaException):
                return
            with self.db:
                self.db.execute("DELETE FROM bridge_outbox WHERE event=? AND hash=?",
                                (receipt["eventId"], receipt["payloadHash"]))
            return
        if topic == f"fleet/v1/devices/{self.config.device_id}/telemetry-receipts":
            try:
                receipt = json.loads(body)
                self.validate_receipt(receipt)
                if receipt["deviceId"] != self.config.device_id:
                    return
            except (ValueError, fastjsonschema.JsonSchemaException):
                return
            with self.db:
                self.db.execute("DELETE FROM telemetry_outbox WHERE session=? AND sequence=?",
                                (receipt["sessionId"], receipt["sequence"]))
            return
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

    def observation(self, payload):
        message = {"schemaVersion": 3, "deviceId": self.config.device_id,
                   "sessionId": self.session, "sequence": self.sequence,
                   "timestamp": utc(), "payload": payload}
        self.validate_observation(message)
        body = json.dumps(message, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        size = len(body.encode())
        if size > min(32768, self.config.byte_limit):
            raise JournalError("TELEMETRY_PACKET_TOO_LARGE")
        with self.db:
            while True:
                count, total = self.db.execute(
                    "SELECT count(*), coalesce(sum(length(CAST(body AS BLOB))),0) "
                    "FROM telemetry_outbox").fetchone()
                if count < self.config.record_limit and total + size <= self.config.byte_limit:
                    break
                self.db.execute("DELETE FROM telemetry_outbox WHERE id="
                                "(SELECT min(id) FROM telemetry_outbox)")
                self.db.execute("INSERT INTO telemetry_loss VALUES (1,1) "
                                "ON CONFLICT(id) DO UPDATE SET count=count+1")
            self.db.execute("INSERT INTO telemetry_outbox(session,sequence,body) VALUES (?,?,?)",
                            (self.session, self.sequence, body))
        self.sequence += 1

    def pending_observations(self):
        return self.db.execute(
            "SELECT id,body FROM telemetry_outbox ORDER BY id LIMIT 100").fetchall()

    def configuration_report(self, configuration):
        configuration_id = digest(configuration)
        with self.db:
            journal, previous, revision, sequence = self.db.execute(
                "SELECT journal,configuration,revision,sequence FROM bridge_counters").fetchone()
            revision += int(previous != configuration_id)
            sequence += 1
            message = {"schemaVersion": 1, "deviceId": self.config.device_id,
                       "kind": "CONFIGURATION", "eventId": str(uuid.uuid4()),
                       "sessionId": self.session, "journalId": journal, "sequence": sequence,
                       "configurationId": configuration_id, "configurationRevision": revision,
                       "reportSequence": sequence, "configuration": configuration,
                       "timestamp": utc()}
            self.validate_bridge(message)
            body = canonical(message)
            size = len(body.encode())
            if size > 32768:
                raise JournalError("BRIDGE_PACKET_TOO_LARGE")
            self.capacity(size)
            self.db.execute("INSERT INTO bridge_outbox(event,hash,body) VALUES (?,?,?)",
                            (message["eventId"], digest(message), body))
            self.db.execute("UPDATE bridge_counters SET configuration=?,revision=?,sequence=?",
                            (configuration_id, revision, sequence))

    def pending_bridge_events(self):
        return self.db.execute("SELECT id,body FROM bridge_outbox ORDER BY id LIMIT 100").fetchall()

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None
