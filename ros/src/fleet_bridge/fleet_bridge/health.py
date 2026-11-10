"""通信・観測・未解決goalを別記録にする。再接続を停止証拠にしない。"""

import time
import uuid

from fleet_reference.configuration import canonical, digest
from .observations import utc
from .command_journal import instant
import json


class Health:
    def __init__(self, journal, commands, ros):
        self.journal, self.commands, self.ros = journal, commands, ros
        self.previous = None
        self.next_report = 0

    def tick(self, mqtt, ready):
        runtime = self.ros.runtime_snapshot()
        sample = self.ros.observations.execution_sample()
        values = self.commands.open_commands()
        pending = None
        if values:
            value = values[0]
            progress = self.commands.progress(value["commandId"])
            pending = {"commandId": value["commandId"], "goalId": value["goalId"],
                       "state": value["state"], "reason": value["reason"],
                       "queryCount": progress["queryCount"],
                       "resultDeadline": value["command"]["resultDeadline"],
                       "humanReviewRequired": bool(progress["terminalEvent"]) and (
                           value["state"] == "UNCERTAIN" or time.time() >= instant(
                               json.loads(progress["terminalEvent"])["timestamp"]) + 5)}
        reason = ("ROS_UNAVAILABLE" if runtime is None else
                  "OBSERVATIONS_STALE" if sample is None else
                  "GOAL_UNRESOLVED" if pending else
                  "MQTT_UNAVAILABLE" if not mqtt["mqtt_subscribed"] else
                  "READY" if ready else "ADAPTER_NOT_READY")
        loss = self.journal.db.execute("SELECT count FROM telemetry_loss").fetchone()
        state = {"serverInstanceId": runtime.server_instance_id if runtime else None,
                 "mqttConnected": mqtt["mqtt_connected"],
                 "mqttSubscribed": mqtt["mqtt_subscribed"], "rosAvailable": runtime is not None,
                 "observationsFresh": sample is not None, "ready": ready, "reason": reason,
                 "adapterReason": runtime.reason if runtime else None,
                 "pendingGoal": pending, "telemetryDropped": loss[0] if loss else 0,
                 "recordLimit": self.journal.config.record_limit,
                 "byteLimit": self.journal.config.byte_limit}
        identity, configuration, sequence = self.journal.db.execute(
            "SELECT journal,configuration,sequence FROM bridge_counters").fetchone()
        if not configuration or (state == self.previous and time.monotonic() < self.next_report):
            return
        event = {"schemaVersion": 1, "deviceId": self.journal.config.device_id,
                 "kind": "ROS_HEALTH", "eventId": str(uuid.uuid4()),
                 "sessionId": self.journal.session, "journalId": identity,
                 "configurationId": configuration, "sequence": sequence + 1,
                 "timestamp": utc(), **state}
        self.journal.validate_bridge(event)
        body = canonical(event)
        with self.journal.db:
            self.journal.capacity(len(body.encode()))
            self.journal.db.execute("INSERT INTO bridge_outbox(event,hash,body) VALUES (?,?,?)",
                                    (event["eventId"], digest(event), body))
            self.journal.db.execute("UPDATE bridge_counters SET sequence=?", (sequence + 1,))
        self.previous, self.next_report = state, time.monotonic() + 5
