"""Action送信前の不変対応。ROS呼出しとcommitの隙間を再送で埋めない。"""

import copy
import json
import uuid
from datetime import datetime
from pathlib import Path

import fastjsonschema
from fleet_reference.configuration import canonical, digest

from .journal import JournalError
from .observations import utc


def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


class CommandJournal:
    """Journalと同じowner thread、同じWAL/FULL接続でのみ使用する。"""

    def __init__(self, journal):
        self.journal = journal
        self.db = journal.db
        self.validate = fastjsonschema.compile(json.loads(Path(
            "/workspace/contracts/ros-command.schema.json").read_text()), use_default=False)

    def receive(self, body, now):
        """自機v3だけを受領commit。ACKNOWLEDGEDはActionの受付ではない。"""
        try:
            command = json.loads(body)
            self.validate(command)
            start = instant(command["timestamp"])
            expires = instant(command["expiresAt"])
            if (command["deviceId"] != self.journal.config.device_id
                    or expires != start + 30
                    or instant(command["resultDeadline"]) != start + 120
                    or now < start - 5):
                return False
        except (ValueError, fastjsonschema.JsonSchemaException):
            return False
        payload_hash = digest(command)
        with self.db:
            old = self.db.execute("SELECT hash FROM command_receipts WHERE command=?",
                                  (command["commandId"],)).fetchone()
            if old:
                if old[0] != payload_hash:
                    return False
                self.db.execute("UPDATE command_receipts SET pending=1 WHERE command=?",
                                (command["commandId"],))
                self.replay(command["commandId"])
                return True
            ack = canonical({"schemaVersion": 2, "deviceId": command["deviceId"],
                             "commandId": command["commandId"], "timestamp": utc(),
                             "status": "REJECTED_EXPIRED" if now >= expires else "ACKNOWLEDGED"})
            command_body = canonical(command)
            self.journal.capacity(len(command_body.encode()) + len(ack.encode()))
            self.db.execute("INSERT INTO command_receipts VALUES (?,?,?,?,1)",
                            (command["commandId"], payload_hash, command_body, ack))
        return True

    def pending_acknowledgements(self):
        return self.db.execute("SELECT command,ack FROM command_receipts "
                               "WHERE pending=1 ORDER BY rowid LIMIT 100").fetchall()

    def acknowledgement_sent(self, command_id, body):
        # ACK v2にはDB receiptがない。PUBACKでpendingだけを解除し正本は保持する。
        with self.db:
            self.db.execute("UPDATE command_receipts SET pending=0 WHERE command=? AND ack=?",
                            (command_id, body))

    def get(self, command_id):
        row = self.db.execute("SELECT command,hash,body,goal,snapshot,state,reason,result "
                              "FROM action_commands WHERE command=?", (command_id,)).fetchone()
        if row is None:
            return None
        value = dict(zip(("commandId", "payloadHash", "command", "goalId", "configuration",
                          "state", "reason", "result"), row))
        for key in ("command", "configuration", "result"):
            if value[key] is not None:
                value[key] = json.loads(value[key])
        return value

    def prepare(self, command, configuration, now):
        """検証済み構成を固定してcommit。重複は期限後でも元の対応を返す。"""
        self.validate(command)
        command = copy.deepcopy(command)
        body = canonical(command)
        previous = self.get(command["commandId"])
        if previous:
            if previous["payloadHash"] != digest(command):
                raise JournalError("COMMAND_CONFLICT")
            return previous
        receipt = self.db.execute("SELECT hash,ack FROM command_receipts WHERE command=?",
                                  (command["commandId"],)).fetchone()
        if receipt:
            if receipt[0] != digest(command):
                raise JournalError("COMMAND_CONFLICT")
            if json.loads(receipt[1])["status"] == "REJECTED_EXPIRED":
                raise JournalError("COMMAND_EXPIRED")
        start = instant(command["timestamp"])
        expires = instant(command["expiresAt"])
        deadline = instant(command["resultDeadline"])
        if expires != start + 30 or deadline != start + 120:
            raise JournalError("COMMAND_DEADLINE_INVALID")
        if now < start - 5 or now >= expires:
            raise JournalError("COMMAND_EXPIRED_OR_CLOCK_INVALID")
        if (command["deviceId"] != self.journal.config.device_id
                or configuration["deviceId"] != command["deviceId"]
                or configuration["namespace"] != self.journal.config.namespace
                or digest(configuration) != command["expectedConfigurationId"]):
            raise JournalError("CONFIGURATION_MISMATCH")
        for name in ("bridge", "adapter", "runtime", "operatingPolicy", "safetyConfig"):
            if configuration[name]["status"] != "KNOWN":
                raise JournalError("CAPABILITY_UNKNOWN")
        if (configuration["bridge"]["version"] != "0.3.0"
                or configuration["adapter"]["version"] != "0.3.0"
                or configuration["profile"]["definition"]["version"] != "1.1.0"):
            raise JournalError("CAPABILITY_UPGRADE_REQUIRED")
        expected = {"command": "RETURN_HOME",
                    "actionType": "fleet_bridge_interfaces/action/ReturnHome",
                    "actionName": "return_home"}
        if expected not in configuration["profile"]["definition"]["operations"]:
            raise JournalError("CAPABILITY_UNSUPPORTED")
        snapshot = canonical(configuration)
        with self.db:
            if self.db.execute("SELECT 1 FROM action_commands c LEFT JOIN action_progress p "
                               "ON p.command=c.command WHERE state != 'REJECTED' "
                               "AND coalesce(p.stop_confirmed,0)=0 LIMIT 1"
                               ).fetchone():
                # 成功resultも停止確認ではない。解除は後続の証拠検証でのみ行う。
                raise JournalError("GOAL_UNRESOLVED")
            self.journal.capacity(len(body.encode()) + len(snapshot.encode()))
            self.db.execute("INSERT INTO action_commands VALUES (?,?,?,?,?,'READY',NULL,NULL)",
                            (command["commandId"], digest(command), body,
                             str(uuid.uuid4()), snapshot))
            self.db.execute("INSERT INTO action_progress(command) VALUES (?)",
                            (command["commandId"],))
        return self.get(command["commandId"])

    def send_intent(self, command_id, now):
        """このcommitが成功した初回だけSendGoal可能。再起動後は再発行しない。"""
        with self.db:
            value = self.get(command_id)
            if value is None or value["state"] != "READY":
                raise JournalError("SEND_NOT_ALLOWED")
            receipt = self.db.execute("SELECT hash,ack FROM command_receipts WHERE command=?",
                                      (command_id,)).fetchone()
            if receipt:
                if receipt[0] != value["payloadHash"]:
                    raise JournalError("COMMAND_CONFLICT")
                if json.loads(receipt[1])["status"] == "REJECTED_EXPIRED":
                    raise JournalError("COMMAND_EXPIRED")
            if now < instant(value["command"]["timestamp"]) - 5:
                raise JournalError("CLOCK_INVALID")
            if now >= instant(value["command"]["expiresAt"]):
                raise JournalError("COMMAND_EXPIRED")
            self.db.execute("UPDATE action_commands SET state='SEND_INTENT' WHERE command=?",
                            (command_id,))
            self.db.execute("UPDATE action_progress SET send_at=? WHERE command=?",
                            (now, command_id))
        return self.get(command_id)

    def recovery(self):
        """SendGoalではなく保存UUIDのGetResult照会候補。世代不一致も再送しない。"""
        with self.db:
            self.db.execute("UPDATE action_commands SET state='UNCERTAIN',reason='BRIDGE_RESTART' "
                            "WHERE state IN ('SEND_INTENT','ACCEPTED','RUNNING')")
        return [self.get(row[0]) for row in self.db.execute(
            "SELECT command FROM action_commands WHERE state='UNCERTAIN' ORDER BY rowid")]

    def accepted(self, command_id):
        with self.db:
            updated = self.db.execute("UPDATE action_commands SET state='ACCEPTED' "
                                      "WHERE command=? AND state='SEND_INTENT'", (command_id,))
            if updated.rowcount != 1:
                raise JournalError("GOAL_STATE_CONFLICT")

    def rejected(self, command_id):
        with self.db:
            updated = self.db.execute(
                "UPDATE action_commands SET state='REJECTED',reason='GOAL_REJECTED' "
                "WHERE command=? AND state='SEND_INTENT'", (command_id,))
            if updated.rowcount != 1:
                raise JournalError("GOAL_STATE_CONFLICT")

    def progress(self, command_id):
        row = self.db.execute("SELECT send_at,query_count,query_started,terminal_event,stop_event,"
                              "last_event,stop_confirmed FROM action_progress WHERE command=?",
                              (command_id,)).fetchone()
        return dict(zip(("sendAt", "queryCount", "queryStarted", "terminalEvent", "stopEvent",
                         "lastEvent", "stopConfirmed"), row)) if row else None

    def replay(self, command_id):
        progress = self.progress(command_id)
        if not progress:
            return
        for field in ("terminalEvent", "lastEvent", "stopEvent"):
            body = progress[field]
            if body:
                event = json.loads(body)
                if not self.db.execute("SELECT 1 FROM bridge_outbox WHERE event=?",
                                       (event["eventId"],)).fetchone():
                    self.journal.capacity(len(body.encode()))
                    self.db.execute("INSERT INTO bridge_outbox(event,hash,body) VALUES (?,?,?)",
                                    (event["eventId"], digest(event), body))

    def event(self, command_id, kind, fields, state=None):
        value = self.get(command_id)
        with self.db:
            journal_id, sequence = self.db.execute(
                "SELECT journal,sequence FROM bridge_counters").fetchone()
            event = {"schemaVersion": 1, "deviceId": self.journal.config.device_id,
                     "timestamp": utc(), "eventId": str(uuid.uuid4()),
                     "sessionId": self.journal.session, "journalId": journal_id,
                     "sequence": sequence + 1, "configurationId": value["command"][
                         "expectedConfigurationId"], "commandId": command_id,
                     "goalId": value["goalId"],
                     "serverInstanceId": value["configuration"]["serverInstanceId"],
                     "kind": kind, **fields}
            self.journal.validate_bridge(event)
            body = canonical(event)
            if len(body.encode()) > 32768:
                raise JournalError("BRIDGE_PACKET_TOO_LARGE")
            if kind == "FEEDBACK":
                self.db.execute("DELETE FROM bridge_outbox WHERE json_extract(body,'$.kind')="
                                "'FEEDBACK' AND json_extract(body,'$.commandId')=?", (command_id,))
            # outboxと履歴の双方を見込む。満杯なら全てrollbackしheartbeatを止める。
            self.journal.capacity(len(body.encode()) * 4)
            self.db.execute("INSERT INTO bridge_outbox(event,hash,body) VALUES (?,?,?)",
                            (event["eventId"], digest(event), body))
            self.db.execute("UPDATE bridge_counters SET sequence=?", (sequence + 1,))
            if kind != "FEEDBACK":
                self.db.execute("UPDATE action_progress SET last_event=? WHERE command=?",
                                (body, command_id))
            if state:
                self.db.execute("UPDATE action_commands SET state=?,reason=?,result=? "
                                "WHERE command=?",
                                (state, event["reason"], body, command_id))
                if state in ("SUCCEEDED", "FAILED", "REJECTED", "CANCELLED", "UNCERTAIN"):
                    self.db.execute("UPDATE action_progress SET terminal_event=? WHERE command=?",
                                    (body, command_id))
            if kind == "STOP_OBSERVATION":
                self.db.execute("UPDATE action_progress SET stop_event=?,stop_confirmed=1 "
                                "WHERE command=?", (body, command_id))
        return event

    def query_attempt(self, command_id, now):
        with self.db:
            self.db.execute("UPDATE action_progress SET query_count=query_count+1, "
                            "query_started=coalesce(query_started,?) WHERE command=?",
                            (now, command_id))

    def commands(self):
        return [self.get(row[0]) for row in self.db.execute("SELECT command FROM action_commands")]

    def open_commands(self):
        return [self.get(row[0]) for row in self.db.execute(
            "SELECT c.command FROM action_commands c LEFT JOIN action_progress p "
            "ON p.command=c.command "
            "WHERE c.state!='REJECTED' AND coalesce(p.stop_confirmed,0)=0")]

    def by_goal(self, goal_id):
        row = self.db.execute("SELECT command FROM action_commands WHERE goal=?",
                              (goal_id,)).fetchone()
        return self.get(row[0]) if row else None

    def received_commands(self):
        # 隔離した汎用inboxは、今後も操作候補として読まない。
        return [json.loads(row[0]) for row in self.db.execute(
            "SELECT r.body FROM command_receipts r LEFT JOIN action_commands c "
            "ON c.command=r.command WHERE c.command IS NULL "
            "AND json_extract(r.ack,'$.status')='ACKNOWLEDGED' ORDER BY r.rowid")]
