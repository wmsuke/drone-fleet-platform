"""Action送信前の不変対応。ROS呼出しとcommitの隙間を再送で埋めない。"""

import copy
import json
import uuid
from datetime import datetime
from pathlib import Path

import fastjsonschema
from fleet_reference.configuration import canonical, digest

from .journal import JournalError


def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


class CommandJournal:
    """Journalと同じowner thread、同じWAL/FULL接続でのみ使用する。"""

    def __init__(self, journal):
        self.journal = journal
        self.db = journal.db
        self.validate = fastjsonschema.compile(json.loads(Path(
            "/workspace/contracts/ros-command.schema.json").read_text()), use_default=False)

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
        expected = {"command": "RETURN_HOME",
                    "actionType": "fleet_bridge_interfaces/action/ReturnHome",
                    "actionName": "return_home"}
        if expected not in configuration["profile"]["definition"]["operations"]:
            raise JournalError("CAPABILITY_UNSUPPORTED")
        snapshot = canonical(configuration)
        with self.db:
            if self.db.execute("SELECT 1 FROM action_commands WHERE state != 'REJECTED' LIMIT 1"
                               ).fetchone():
                # 成功resultも停止確認ではない。解除は後続の証拠検証でのみ行う。
                raise JournalError("GOAL_UNRESOLVED")
            self.journal.capacity(len(body.encode()) + len(snapshot.encode()))
            self.db.execute("INSERT INTO action_commands VALUES (?,?,?,?,?,'READY',NULL,NULL)",
                            (command["commandId"], digest(command), body,
                             str(uuid.uuid4()), snapshot))
        return self.get(command["commandId"])

    def send_intent(self, command_id, now):
        """このcommitが成功した初回だけSendGoal可能。再起動後は再発行しない。"""
        with self.db:
            value = self.get(command_id)
            if value is None or value["state"] != "READY":
                raise JournalError("SEND_NOT_ALLOWED")
            if now < instant(value["command"]["timestamp"]) - 5:
                raise JournalError("CLOCK_INVALID")
            if now >= instant(value["command"]["expiresAt"]):
                raise JournalError("COMMAND_EXPIRED")
            self.db.execute("UPDATE action_commands SET state='SEND_INTENT' WHERE command=?",
                            (command_id,))
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
