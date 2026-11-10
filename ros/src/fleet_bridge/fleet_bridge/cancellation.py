"""中断要求の永続対応。受付・ROS応答を実行終端や停止と混同しない。"""

import base64
import hashlib
import json
from pathlib import Path
import time
import uuid

import fastjsonschema
from rclpy.serialization import serialize_message
from fleet_reference.configuration import canonical, digest

from .command_journal import instant
from .observations import utc


class Cancellation:
    def __init__(self, commands, ros, execution):
        self.commands, self.ros, self.execution = commands, ros, execution
        self.journal, self.db = commands.journal, commands.db
        self.validate = fastjsonschema.compile(json.loads(Path(
            "/workspace/contracts/bridge-cancel.schema.json").read_text()), use_default=False)
        self.pending = []
        for (cancel_id,) in self.db.execute(
                "SELECT id FROM cancel_requests WHERE state='SEND_INTENT'").fetchall():
            self.event(cancel_id, "UNCERTAIN", "BRIDGE_RESTART")
            request = self.get(cancel_id)["request"]
            self.reconcile(request)

    def get(self, cancel_id):
        row = self.db.execute("SELECT body,state,attempts,sent_at,last_event,response_event "
                              "FROM cancel_requests WHERE id=?", (cancel_id,)).fetchone()
        return {"request": json.loads(row[0]), "state": row[1], "attempts": row[2],
                "sentAt": row[3], "last": row[4], "response": row[5]} if row else None

    def replay(self, value):
        with self.db:
            for body in (value["last"], value["response"]):
                if body:
                    event = json.loads(body)
                    if not self.db.execute("SELECT 1 FROM bridge_outbox WHERE event=?",
                                           (event["eventId"],)).fetchone():
                        self.journal.capacity(len(body.encode()))
                        self.db.execute("INSERT INTO bridge_outbox(event,hash,body) VALUES (?,?,?)",
                                        (event["eventId"], digest(event), body))

    def receive(self, body, now):
        try:
            request = json.loads(body)
            self.validate(request)
            if (request["requestId"] != request["cancelId"]
                    or request["deviceId"] != self.journal.config.device_id
                    or instant(request["expiresAt"]) != instant(request["timestamp"]) + 10
                    or now < instant(request["timestamp"]) - 5):
                return False
        except (ValueError, fastjsonschema.JsonSchemaException):
            return False
        old = self.get(request["cancelId"])
        if old:
            if digest(old["request"]) != digest(request):
                return False
            self.replay(old)
            return True
        value = self.commands.get(request["commandId"])
        if (not value or value["goalId"] != request["goalId"]
                or value["command"]["expectedConfigurationId"] != request["configurationId"]
                or value["configuration"]["serverInstanceId"] != request["serverInstanceId"]
                or value["state"] in ("READY", "SEND_INTENT", "REJECTED")):
            return False
        # commandごとの要求予算は別cancelIdでもリセットしない。
        if self.db.execute("SELECT 1 FROM cancel_requests WHERE "
                           "json_extract(body,'$.commandId')=?",
                           (request["commandId"],)).fetchone():
            return False
        text = canonical(request)
        with self.db:
            self.journal.capacity(len(text.encode()))
            self.db.execute("INSERT INTO cancel_requests(id,hash,body,state) VALUES (?,?,?,?)",
                            (request["cancelId"], digest(request), text, "RECEIVED"))
            self.event(request["cancelId"], "UNCERTAIN" if now >= instant(request["expiresAt"])
                       else "RECEIVED", "EXPIRED" if now >= instant(request["expiresAt"])
                       else "RECEIVED")
        return True

    def event(self, cancel_id, phase, reason, response=None, late=False, attempt=None, raw=None):
        value = self.get(cancel_id)
        request = value["request"]
        with self.db:
            journal_id, sequence = self.db.execute(
                "SELECT journal,sequence FROM bridge_counters").fetchone()
            event = {key: request[key] for key in (
                "schemaVersion", "deviceId", "requestId", "cancelId", "commandId", "goalId",
                "configurationId", "serverInstanceId")}
            event.update(kind="CANCEL", phase=phase, reason=reason, timestamp=utc(),
                         sessionId=self.journal.session, journalId=journal_id,
                         eventId=str(uuid.uuid4()), sequence=sequence + 1,
                         attempt=value["attempts"] if attempt is None else attempt)
            if response:
                event["response"] = response
            if raw is not None:
                event["rawResponse"] = {"hash": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
                if len(raw) <= 6144:
                    event["rawResponse"]["cdr"] = base64.b64encode(raw).decode()
            self.journal.validate_bridge(event)
            body = canonical(event)
            self.journal.capacity(len(body.encode()) * 3)
            self.db.execute("INSERT INTO bridge_outbox(event,hash,body) VALUES (?,?,?)",
                            (event["eventId"], digest(event), body))
            self.db.execute("UPDATE bridge_counters SET sequence=?", (sequence + 1,))
            if not late:
                self.db.execute("UPDATE cancel_requests SET state=?,last_event=? WHERE id=?",
                                (phase, body, cancel_id))
            if response:
                self.db.execute("UPDATE cancel_requests SET response_event=? WHERE id=?",
                                (body, cancel_id))

    def reconcile(self, request):
        progress = self.commands.progress(request["commandId"])
        if progress and not progress["terminalEvent"]:
            self.execution.begin_recovery(request["commandId"])

    def tick(self):
        now = time.time()
        for pending in list(self.pending):
            cancel_id, future, attempt = pending
            value = self.get(cancel_id)
            request = value["request"]
            if future.done():
                self.pending.remove(pending)
                raw = None
                try:
                    response = future.result()
                    raw = bytes(serialize_message(response))
                    goals = [str(uuid.UUID(bytes=bytes(g.goal_id.uuid)))
                             for g in response.goals_canceling]
                    code = response.return_code
                    valid = ((code == 0 and goals == [request["goalId"]])
                             or (code in (0, 1, 2, 3) and not goals))
                    if not valid or len(raw) > 6144:
                        raise ValueError()
                    evidence = {"returnCode": code, "goalsCanceling": goals,
                                "cdr": base64.b64encode(raw).decode(),
                                "hash": hashlib.sha256(raw).hexdigest()}
                except Exception:
                    self.event(cancel_id, "UNCERTAIN", "RESULT_INVALID", raw=raw)
                else:
                    phase = "ACCEPTED" if code == 0 and goals else "REJECTED"
                    reason = ("NO_GOAL_CANCELING" if code == 0 and not goals else
                              ("CANCEL_ACCEPTED", "CANCEL_REJECTED", "UNKNOWN_GOAL",
                               "ALREADY_TERMINAL")[code])
                    self.event(cancel_id, phase, reason, evidence,
                               late=value["state"] in ("UNCERTAIN", "ACCEPTED", "REJECTED"),
                               attempt=attempt)
                self.reconcile(request)
            elif now >= instant(request["expiresAt"]) + 10:
                self.ros.abandon_cancel(future)
                self.pending.remove(pending)
        rows = self.db.execute("SELECT id FROM cancel_requests WHERE "
                               "state IN ('RECEIVED','SEND_INTENT')").fetchall()
        for (cancel_id,) in rows:
            value = self.get(cancel_id)
            request = value["request"]
            if now >= instant(request["expiresAt"]):
                self.event(cancel_id, "UNCERTAIN", "EXPIRED")
                self.reconcile(request)
                continue
            if value["sentAt"] is not None and now - value["sentAt"] < 2:
                continue
            if value["attempts"] >= 3:
                if not any(p[0] == cancel_id for p in self.pending):
                    self.event(cancel_id, "UNCERTAIN", "RESPONSE_TIMEOUT")
                continue
            runtime = self.ros.runtime_snapshot()
            command = self.commands.get(request["commandId"])
            if runtime is None:
                continue
            if runtime.server_instance_id != request["serverInstanceId"]:
                self.event(cancel_id, "UNCERTAIN", "SERVER_CHANGED")
                self.reconcile(request)
                continue
            if runtime.configuration_id != command["configuration"]["adapterConfigurationId"]:
                self.event(cancel_id, "UNCERTAIN", "SCOPE_MISMATCH")
                continue
            with self.db:
                self.db.execute("UPDATE cancel_requests SET attempts=attempts+1,sent_at=? "
                                "WHERE id=?", (now, cancel_id))
                self.event(cancel_id, "SEND_INTENT", "CANCEL_SENT")
            try:
                future = self.ros.cancel(request["goalId"])
            except Exception:
                # 送信した可能性を消さず、同一goalへの予算内の照会/中断だけ許可する。
                continue
            self.pending.append((cancel_id, future, value["attempts"] + 1))

    def close(self):
        for _, future, _ in self.pending:
            self.ros.abandon_cancel(future)
